/**
 * Tests for Orchestrate Service — LLM Planning + Fallback
 *
 * 10 tests: T-1 through T-10
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, ComposeResult, DiscoveryResult } from '../types/index.js';

// ─── Structured logger mock ─────────────────────────────────
// orchestrate.ts logs server-side via getLogger('orchestrate'). Mock it so
// tests assert log emission (object-first / message-second) instead of spying
// on console. hoisted so the factory can reference it.
const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({
  getLogger: () => logSpy,
}));

// ─── Shared mock for Anthropic ───────────────────────────────

const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  return {
    // biome-ignore lint/complexity/useArrowFunction: must use function() for new-able mock constructor
    default: vi.fn().mockImplementation(function () {
      return { messages: { create: mockCreate } };
    }),
  };
});

// R-3 / OP-10: control the Anthropic circuit breaker so a test can force an
// OPEN breaker (CircuitOpenError) while preserving the REAL `CircuitOpenError`
// class (orchestrate uses `instanceof`). Default: passthrough (run the fn).
const mockBreakerExecute = vi.hoisted(() => vi.fn((fn: () => unknown) => fn()));
vi.mock('../lib/circuit-breaker.js', async () => {
  const actual = await vi.importActual<
    typeof import('../lib/circuit-breaker.js')
  >('../lib/circuit-breaker.js');
  return {
    ...actual,
    anthropicCircuitBreaker: { execute: mockBreakerExecute },
  };
});

vi.mock('./discovery.js', () => ({
  discoveryService: {
    discover: vi.fn(),
    // WKH-131: planOrchestration ahora resuelve costPerStep/maxQuotedCostUsdc
    // server-side vía resolveAgentPriceUsdc → discoveryService.getAgent. Mockeado
    // acá para que el path atómico (que NO usa esos campos en sus aserciones)
    // resuelva sin pegarle a la DB real.
    getAgent: vi.fn(),
  },
}));

vi.mock('./compose.js', () => ({
  composeService: {
    compose: vi.fn(),
  },
}));

vi.mock('./event.js', () => ({
  eventService: {
    track: vi.fn().mockResolvedValue({}),
  },
}));

// WKH-124: orchestrate emits a protocol_fee receipt fire-and-forget when the fee
// is charged. Mock the service so we can assert AC-1 without touching the payment
// contract, and verify a rejecting emit never breaks the orchestrate result.
vi.mock('./receipt.js', () => ({
  receiptService: {
    emit: vi.fn().mockResolvedValue(undefined),
  },
}));

// WKH-127: mock del budget service para espiar débito/refund/balance del
// path master post-plan. Defaults: budget alto, débito y credit OK.
vi.mock('./budget.js', () => ({
  budgetService: {
    debit: vi.fn().mockResolvedValue({ success: true }),
    credit: vi.fn().mockResolvedValue({ success: true }),
    // H1 (audit 2026-07-01): dual-ledger credit-back for delegation/session
    // step-0 refunds. Defaults to a real reversion (success + reverted).
    creditDelegation: vi
      .fn()
      .mockResolvedValue({ success: true, reverted: true }),
    creditSession: vi.fn().mockResolvedValue({ success: true, reverted: true }),
    getBalance: vi.fn().mockResolvedValue('100'),
  },
}));

// WKH-44: mock fee-charge. Preservamos `ProtocolFeeError` (es una clase
// real que el SUT usa en `instanceof`) y reemplazamos las funciones.
vi.mock('./fee-charge.js', async () => {
  const actual =
    await vi.importActual<typeof import('./fee-charge.js')>('./fee-charge.js');
  return {
    ...actual,
    chargeProtocolFee: vi.fn().mockResolvedValue({
      status: 'skipped',
      feeUsdc: 0,
      reason: 'WALLET_UNSET',
    }),
    getProtocolFeeRate: vi.fn().mockReturnValue(0.01),
  };
});

// ─── Imports (after mocks) ───────────────────────────────────

import { _resetAgentPriceCache } from './agent-price.js';
import { budgetService } from './budget.js';
import { composeService } from './compose.js';
import { discoveryService } from './discovery.js';
import { eventService } from './event.js';
import { chargeProtocolFee, getProtocolFeeRate } from './fee-charge.js';
import { getPlannerMaxTokens, getPlannerModel } from './llm/models.js';
import { orchestrateService, textOverlapsGoal } from './orchestrate.js';
import { receiptService } from './receipt.js';

// ─── Fixtures ────────────────────────────────────────────────

const mockAgents: Agent[] = [
  {
    id: 'agent-1',
    name: 'Summarizer',
    slug: 'summarizer-v1',
    description: 'Summarizes text documents',
    capabilities: ['summarization', 'text-analysis'],
    priceUsdc: 0.5,
    reputation: 90,
    registry: 'wasiai',
    registry_id: 'wasiai',
    invokeUrl: 'https://example.com/invoke/summarizer-v1',
    invocationNote: 'Use POST /compose or POST /orchestrate on the gateway.',
    verified: false,
    status: 'active',
  },
  {
    id: 'agent-2',
    name: 'Translator',
    slug: 'translator-v1',
    description: 'Translates text between languages',
    capabilities: ['translation', 'nlp'],
    priceUsdc: 0.3,
    reputation: 85,
    registry: 'wasiai',
    registry_id: 'wasiai',
    invokeUrl: 'https://example.com/invoke/translator-v1',
    invocationNote: 'Use POST /compose or POST /orchestrate on the gateway.',
    verified: false,
    status: 'active',
  },
];

const mockDiscoveryResult: DiscoveryResult = {
  agents: mockAgents,
  total: 2,
  registries: ['wasiai'],
};

const mockComposeResult: ComposeResult = {
  success: true,
  output: 'Final summarized output',
  steps: [
    {
      agent: mockAgents[0]!,
      output: 'Summarized text',
      costUsdc: 0.5,
      latencyMs: 1200,
      txHash: '0xabc123',
    },
  ],
  totalCostUsdc: 0.5,
  totalLatencyMs: 1200,
};

function setLlmResponse(content: string) {
  mockCreate.mockResolvedValue({
    content: [{ type: 'text', text: content }],
  });
}

function setLlmError(error: Error) {
  mockCreate.mockRejectedValue(error);
}

// ─── Tests ───────────────────────────────────────────────────

describe('orchestrateService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // WKH-131: el cache de resolveAgentPriceUsdc es module-level → reset para
    // que cada test resuelva precios con el mock recién configurado (no bleed).
    _resetAgentPriceCache();
    process.env.ANTHROPIC_API_KEY = 'test-key';
    vi.mocked(discoveryService.discover).mockResolvedValue(mockDiscoveryResult);
    // WKH-131: getAgent por slug contra el set de discovery activo, para que
    // resolveAgentPriceUsdc devuelva el precio real del step (costPerStep /
    // maxQuotedCostUsdc). Default: busca en mockAgents; null si no matchea.
    vi.mocked(discoveryService.getAgent).mockImplementation(async (slug) => {
      return mockAgents.find((a) => a.slug === slug) ?? null;
    });
    vi.mocked(composeService.compose).mockResolvedValue(mockComposeResult);
    // WKH-127: re-aplicar defaults del budget mock (clearAllMocks los borra).
    vi.mocked(budgetService.debit).mockResolvedValue({ success: true });
    vi.mocked(budgetService.credit).mockResolvedValue({ success: true });
    // H1 (audit 2026-07-01): re-apply dual-ledger credit defaults (clearAllMocks).
    vi.mocked(budgetService.creditDelegation).mockResolvedValue({
      success: true,
      reverted: true,
    });
    vi.mocked(budgetService.creditSession).mockResolvedValue({
      success: true,
      reverted: true,
    });
    vi.mocked(budgetService.getBalance).mockResolvedValue('100');
    // R-3 / OP-10: default breaker passthrough (clearAllMocks wiped it).
    mockBreakerExecute.mockImplementation((fn: () => unknown) => fn());
  });

  // T-1: LLM happy path — inputs dinamicos
  it('T-1: uses LLM to plan pipeline with dynamic inputs', async () => {
    setLlmResponse(
      JSON.stringify({
        selectedAgents: [
          {
            slug: 'summarizer-v1',
            registry: 'wasiai',
            input: {
              query: 'Summarize the research paper on quantum computing',
            },
            reasoning: 'Best match for summarization goal',
          },
        ],
        reasoning: 'Selected summarizer for text analysis task',
      }),
    );

    const result = await orchestrateService.orchestrate(
      { goal: 'Summarize a paper on quantum computing', budget: 5.0 },
      'test-orch-id-1',
    );

    expect(result.reasoning).toContain('summarizer');
    expect(result.answer).toBeDefined();

    // Verify compose was called with dynamic input from LLM
    const composeCall = vi.mocked(composeService.compose).mock.calls[0]![0]!;
    expect(composeCall.steps[0]!.input).toHaveProperty('query');
  });

  // T-2: Response includes orchestrationId + protocolFeeUsdc
  it('T-2: response includes orchestrationId and protocolFeeUsdc', async () => {
    setLlmResponse(
      JSON.stringify({
        selectedAgents: [
          {
            slug: 'summarizer-v1',
            registry: 'wasiai',
            input: { query: 'test' },
            reasoning: 'ok',
          },
        ],
        reasoning: 'Test plan',
      }),
    );

    const result = await orchestrateService.orchestrate(
      { goal: 'test', budget: 5.0 },
      'orch-id-abc',
    );

    expect(result.orchestrationId).toBe('orch-id-abc');
    // WKH-132: fee COST-BASED. El atómico reporta rate sobre el costo REAL del
    // pipeline (mockComposeResult.totalCostUsdc=0.5), NO sobre el budget (5.0).
    // 0.5 * 0.01 = 0.005 (antes budget-based daba 0.05).
    expect(result.protocolFeeUsdc).toBeCloseTo(0.5 * 0.01, 6);
  });

  // T-3: No agents found returns answer:null
  it('T-3: no agents found returns answer null with reasoning', async () => {
    vi.mocked(discoveryService.discover).mockResolvedValue({
      agents: [],
      total: 0,
      registries: [],
    });

    const result = await orchestrateService.orchestrate(
      { goal: 'find quantum agents', budget: 5.0 },
      'orch-no-agents',
    );

    expect(result.answer).toBeNull();
    expect(result.reasoning).toContain('No agents found');
    expect(result.pipeline.steps).toHaveLength(0);
  });

  // T-4: LLM fails -> fallback greedy with warning
  it('T-4: LLM failure falls back to greedy with warning', async () => {
    setLlmError(new Error('API timeout'));

    const result = await orchestrateService.orchestrate(
      // goal shares the token "text" with the mock agents so the fallback
      // relevance guard (WKH: money-path) does NOT force no_relevant_agent —
      // this test asserts the greedy fallback mechanics, not relevance.
      { goal: 'summarize the text fallback', budget: 5.0 },
      'orch-fallback',
    );

    expect(result.reasoning).toContain('[FALLBACK]');
    expect(result.answer).toBeDefined();
  });

  // R-3 / OP-10: an OPEN planner circuit must degrade to greedy, NOT 503.
  it('R-3/OP-10: CircuitOpenError → greedy fallback (no re-throw / no 503)', async () => {
    const { CircuitOpenError } = await vi.importActual<
      typeof import('../lib/circuit-breaker.js')
    >('../lib/circuit-breaker.js');
    // Force the breaker OPEN: execute() rejects with the real CircuitOpenError.
    mockBreakerExecute.mockRejectedValue(new CircuitOpenError('anthropic'));

    // Should NOT throw (would map to 503 at the boundary) — degrades to greedy.
    const result = await orchestrateService.orchestrate(
      // "text" overlaps the mock agents → relevance guard stays inert; this
      // asserts the OPEN-breaker → greedy degradation, not relevance.
      { goal: 'summarize text on circuit open', budget: 5.0 },
      'orch-circuit-open',
    );

    expect(result.reasoning).toContain('[FALLBACK]');
    expect(result.answer).toBeDefined();
    // A greedy plan was produced and executed via compose (degraded-but-up).
    expect(vi.mocked(composeService.compose)).toHaveBeenCalled();
  });

  // T-5: LLM returns invalid slug -> discard, keep valid
  it('T-5: LLM invalid slugs are discarded, valid ones kept', async () => {
    setLlmResponse(
      JSON.stringify({
        selectedAgents: [
          {
            slug: 'non-existent-agent',
            registry: 'wasiai',
            input: { q: 'x' },
            reasoning: 'bad',
          },
          {
            slug: 'summarizer-v1',
            registry: 'wasiai',
            input: { query: 'real' },
            reasoning: 'good',
          },
        ],
        reasoning: 'Mixed plan',
      }),
    );

    const _result = await orchestrateService.orchestrate(
      { goal: 'test slug validation', budget: 5.0 },
      'orch-slug-check',
    );

    // Should only have 1 step (the valid one)
    const composeCall = vi.mocked(composeService.compose).mock.calls[0]![0]!;
    expect(composeCall.steps).toHaveLength(1);
    expect(composeCall.steps[0]!.agent).toBe('summarizer-v1');
  });

  // T-6: Event tracking called with orchestrate_goal
  it('T-6: tracks orchestrate_goal event', async () => {
    setLlmResponse(
      JSON.stringify({
        selectedAgents: [
          {
            slug: 'summarizer-v1',
            registry: 'wasiai',
            input: { q: 'x' },
            reasoning: 'ok',
          },
        ],
        reasoning: 'Plan ok',
      }),
    );

    await orchestrateService.orchestrate(
      { goal: 'track this goal', budget: 5.0 },
      'orch-track',
    );

    // Give fire-and-forget a tick
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(vi.mocked(eventService.track)).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'orchestrate_goal',
        goal: 'track this goal',
        metadata: expect.objectContaining({ orchestrationId: 'orch-track' }),
      }),
    );
  });

  // T-7: protocolFeeUsdc = pipeline.totalCostUsdc * 0.01 (WKH-132 cost-based).
  // WKH-132: revertido a cost-based — el fee reportado escala con el costo REAL
  // ejecutado (customCompose.totalCostUsdc=10), NO con el budget declarado (20).
  it('T-7: protocolFeeUsdc is 1% of pipeline cost', async () => {
    const customCompose: ComposeResult = {
      ...mockComposeResult,
      totalCostUsdc: 10.0,
    };
    vi.mocked(composeService.compose).mockResolvedValue(customCompose);

    setLlmResponse(
      JSON.stringify({
        selectedAgents: [
          {
            slug: 'summarizer-v1',
            registry: 'wasiai',
            input: { q: 'x' },
            reasoning: 'ok',
          },
        ],
        reasoning: 'ok',
      }),
    );

    const result = await orchestrateService.orchestrate(
      { goal: 'fee test', budget: 20.0 },
      'orch-fee',
    );

    // WKH-132: pipeline cost 10 * 0.01 = 0.1 (cost-based, NO budget 20 * 0.01).
    expect(result.protocolFeeUsdc).toBeCloseTo(0.1, 6);
  });
  // T-8: LLM returns malformed JSON -> fallback (AR fix M-1)
  it('T-8: LLM malformed JSON triggers fallback', async () => {
    setLlmResponse('Sure! Here is the plan:\n\n```json\n{"bad"}\n```');

    const result = await orchestrateService.orchestrate(
      // "text" overlaps the mock agents → relevance guard inert (asserts
      // malformed-JSON → fallback mechanics).
      { goal: 'summarize text malformed', budget: 5.0 },
      'orch-malformed',
    );

    expect(result.reasoning).toContain('[FALLBACK]');
    expect(result.answer).toBeDefined();
  });

  // T-9: All LLM slugs invalid -> full fallback (AR fix M-4)
  it('T-9: all LLM slugs invalid triggers full fallback', async () => {
    setLlmResponse(
      JSON.stringify({
        selectedAgents: [
          {
            slug: 'ghost-agent-1',
            registry: 'wasiai',
            input: { q: 'x' },
            reasoning: 'bad',
          },
          {
            slug: 'ghost-agent-2',
            registry: 'wasiai',
            input: { q: 'y' },
            reasoning: 'bad',
          },
        ],
        reasoning: 'All ghosts',
      }),
    );

    const result = await orchestrateService.orchestrate(
      // "text" overlaps the mock agents → relevance guard inert (asserts the
      // all-invalid-slugs → full greedy fallback branch).
      { goal: 'summarize text invalid slugs', budget: 5.0 },
      'orch-all-invalid',
    );

    expect(result.reasoning).toContain('[FALLBACK]');
    expect(result.reasoning).toContain('not found in discovery');
    expect(result.answer).toBeDefined();
  });

  // T-10: Missing ANTHROPIC_API_KEY -> fallback (AR fix M-7)
  it('T-10: missing API key triggers fallback', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const result = await orchestrateService.orchestrate(
      // "text" overlaps the mock agents → relevance guard inert (asserts the
      // missing-API-key → fallback branch).
      { goal: 'summarize text no key', budget: 5.0 },
      'orch-no-key',
    );

    expect(result.reasoning).toContain('[FALLBACK]');
    expect(result.answer).toBeDefined();
    // LLM should NOT have been called
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // ─── WKH-44 ─ Protocol Fee Real Charge ──────────────────

  function setLlmOneAgent(): void {
    setLlmResponse(
      JSON.stringify({
        selectedAgents: [
          {
            slug: 'summarizer-v1',
            registry: 'wasiai',
            input: { q: 'x' },
            reasoning: 'ok',
          },
        ],
        reasoning: 'ok',
      }),
    );
  }

  // T-11 (AC-1): compose receives maxBudget = budget - feeUsdc
  it('T-11: compose receives maxBudget = budget - feeUsdc', async () => {
    vi.mocked(getProtocolFeeRate).mockReturnValue(0.01);
    setLlmOneAgent();

    await orchestrateService.orchestrate(
      { goal: 'maxBudget test', budget: 1.0 },
      'orch-maxbudget',
    );

    const composeCall = vi.mocked(composeService.compose).mock.calls[0]![0]!;
    // WKH-132: maxBudget = budget − feeUsdc (WKH-44 invariante conservada), pero
    // feeUsdc ahora es COST-BASED (residual del quote): summarizer-v1 (0.5) →
    // maxQuoted 0.505 − total 0.5 = 0.005. maxBudget = 1.0 − 0.005 = 0.995.
    expect(composeCall.maxBudget).toBeCloseTo(0.995, 6);
  });

  // T-12 (AC-2): chargeProtocolFee invoked when pipeline.success=true
  it('T-12: chargeProtocolFee invoked when pipeline.success=true', async () => {
    vi.mocked(getProtocolFeeRate).mockReturnValue(0.01);
    vi.mocked(chargeProtocolFee).mockResolvedValueOnce({
      status: 'charged',
      feeUsdc: 0.01,
      txHash: '0xFEE',
    });
    setLlmOneAgent();

    const result = await orchestrateService.orchestrate(
      { goal: 'happy path', budget: 1.0 },
      'orch-12',
    );

    expect(vi.mocked(chargeProtocolFee)).toHaveBeenCalledTimes(1);
    // WKH-132 (AC-3): la base del charge es pipeline.totalCostUsdc (0.5), NO el
    // budget (1.0). Espejo de compose.ts:539.
    expect(vi.mocked(chargeProtocolFee)).toHaveBeenCalledWith({
      orchestrationId: 'orch-12',
      feeBaseUsdc: 0.5,
      feeRate: 0.01,
    });
    expect(result.feeChargeTxHash).toBe('0xFEE');
    expect(result.feeChargeError).toBeUndefined();
  });

  // T-13 (AC-2): chargeProtocolFee NOT invoked when pipeline.success=false
  it('T-13: chargeProtocolFee NOT invoked when pipeline.success=false', async () => {
    vi.mocked(getProtocolFeeRate).mockReturnValue(0.01);
    vi.mocked(composeService.compose).mockResolvedValueOnce({
      ...mockComposeResult,
      success: false,
    });
    setLlmOneAgent();

    const result = await orchestrateService.orchestrate(
      { goal: 'compose failed', budget: 1.0 },
      'orch-13',
    );

    expect(vi.mocked(chargeProtocolFee)).not.toHaveBeenCalled();
    expect(result.feeChargeError).toBeUndefined();
    expect(result.feeChargeTxHash).toBeUndefined();
  });

  // T-14 (AC-5): wallet unset → skipped → no feeChargeError/feeChargeTxHash
  it('T-14: skipped status leaves feeChargeError/TxHash undefined', async () => {
    vi.mocked(getProtocolFeeRate).mockReturnValue(0.01);
    vi.mocked(chargeProtocolFee).mockResolvedValueOnce({
      status: 'skipped',
      feeUsdc: 0.01,
      reason: 'WALLET_UNSET',
    });
    setLlmOneAgent();

    const result = await orchestrateService.orchestrate(
      { goal: 'wallet unset', budget: 1.0 },
      'orch-14',
    );

    expect(result.feeChargeError).toBeUndefined();
    expect(result.feeChargeTxHash).toBeUndefined();
    // WKH-132: reportado cost-based (pipeline 0.5 * 0.01 = 0.005), NO budget-based.
    expect(result.protocolFeeUsdc).toBeCloseTo(0.005, 6);
  });

  // T-15 (AC-6): fee charge fails → feeChargeError set, HTTP 200 (no throw)
  it('T-15: feeChargeError present + no throw when fee charge fails', async () => {
    vi.mocked(getProtocolFeeRate).mockReturnValue(0.01);
    vi.mocked(chargeProtocolFee).mockResolvedValueOnce({
      status: 'failed',
      feeUsdc: 0.01,
      error: 'net',
    });
    setLlmOneAgent();

    const result = await orchestrateService.orchestrate(
      { goal: 'fee fails', budget: 1.0 },
      'orch-15',
    );

    expect(result.feeChargeError).toBe('net');
    expect(result.feeChargeTxHash).toBeUndefined();
    // answer still defined (HTTP 200 semantically)
    expect(result.answer).toBeDefined();
  });

  // T-16 (AC-4, WKH-132): el guard pre-planning `feeUsdc > budget` fue ELIMINADO
  // (era inalcanzable: getProtocolFeeRate clampa a [0,0.10]). Con un rate en rango
  // NO hay throw pre-planning y el planning corre normal. El safety guard real
  // (cost-vs-cost) sobrevive en chargeProtocolFee (ver fee-charge.test.ts).
  it('T-16: no ProtocolFeeError pre-planning with in-range rate — planning runs', async () => {
    vi.mocked(getProtocolFeeRate).mockReturnValue(0.05);
    setLlmOneAgent();

    const result = await orchestrateService.orchestrate(
      { goal: 'in-range rate', budget: 1.0 },
      'orch-16',
    );

    // Sin throw: discovery corrió y el pipeline se ejecutó.
    expect(vi.mocked(discoveryService.discover)).toHaveBeenCalled();
    expect(result.answer).toBeDefined();
    // Fee reportado cost-based (pipeline 0.5 * 0.05 = 0.025), nunca budget*rate.
    expect(result.protocolFeeUsdc).toBeCloseTo(0.5 * 0.05, 6);
  });

  // T-17 (AC-8): second call with same orchestrationId returns already-charged
  it('T-17: already-charged second call populates feeChargeTxHash', async () => {
    vi.mocked(getProtocolFeeRate).mockReturnValue(0.01);
    vi.mocked(chargeProtocolFee)
      .mockResolvedValueOnce({
        status: 'charged',
        feeUsdc: 0.01,
        txHash: '0xFIRST',
      })
      .mockResolvedValueOnce({
        status: 'already-charged',
        feeUsdc: 0.01,
        txHash: '0xFIRST',
      });
    setLlmOneAgent();

    const r1 = await orchestrateService.orchestrate(
      { goal: 'first', budget: 1.0 },
      'same-id',
    );
    setLlmOneAgent();
    const r2 = await orchestrateService.orchestrate(
      { goal: 'second', budget: 1.0 },
      'same-id',
    );

    expect(r1.feeChargeTxHash).toBe('0xFIRST');
    expect(r2.feeChargeTxHash).toBe('0xFIRST');
    expect(vi.mocked(chargeProtocolFee)).toHaveBeenCalledTimes(2);
  });

  // T-18 (AC-10): rate change reflected in next orchestrate call (no cache).
  // WKH-132: fee cost-based → pipeline 0.5 * rate. Cambiar el rate cambia el fee
  // en la llamada siguiente (sin cache).
  it('T-18: PROTOCOL_FEE_RATE change reflected in next call', async () => {
    vi.mocked(getProtocolFeeRate).mockReturnValue(0.01);
    setLlmOneAgent();
    const r1 = await orchestrateService.orchestrate(
      { goal: 'first rate', budget: 1.0 },
      'orch-18a',
    );
    expect(r1.protocolFeeUsdc).toBeCloseTo(0.5 * 0.01, 6);

    vi.mocked(getProtocolFeeRate).mockReturnValue(0.02);
    setLlmOneAgent();
    const r2 = await orchestrateService.orchestrate(
      { goal: 'second rate', budget: 1.0 },
      'orch-18b',
    );
    expect(r2.protocolFeeUsdc).toBeCloseTo(0.5 * 0.02, 6);
  });

  // T-19 (AC-9): fee calculated with default 0.01 when env unset
  it('T-19: fee uses default 0.01 when rate unset', async () => {
    vi.mocked(getProtocolFeeRate).mockReturnValue(0.01); // sim default
    setLlmOneAgent();

    const result = await orchestrateService.orchestrate(
      { goal: 'default rate', budget: 10.0 },
      'orch-19',
    );

    // WKH-132: cost-based (pipeline 0.5 * 0.01 = 0.005), NO budget 10 * 0.01.
    expect(result.protocolFeeUsdc).toBeCloseTo(0.005, 6);
  });

  // T-20 (CD-D): early-return no-agents keeps protocolFeeUsdc=0
  it('T-20: early-return no-agents returns protocolFeeUsdc=0', async () => {
    vi.mocked(getProtocolFeeRate).mockReturnValue(0.01);
    vi.mocked(discoveryService.discover).mockResolvedValueOnce({
      agents: [],
      total: 0,
      registries: [],
    });

    const result = await orchestrateService.orchestrate(
      { goal: 'no agents', budget: 1.0 },
      'orch-20',
    );

    expect(result.answer).toBeNull();
    expect(result.protocolFeeUsdc).toBe(0);
    // chargeProtocolFee NOT called (early return before compose).
    expect(vi.mocked(chargeProtocolFee)).not.toHaveBeenCalled();
  });

  // ─── WKH-102 ─ chainId propagation to compose (DT-3 asserts) ───────────
  // El bug: orchestrate.ts:416 pasaba `chainId: undefined` para master keys
  // (sin delegationContext) → compose.ts:130 saltaba el débito de steps 1..N.
  // El fix: propagar `request.chainId` SIEMPRE. Estos asserts verifican la
  // propagación explícitamente (compose es mock acá; el conteo real de
  // débitos se prueba en el bloque de integración con compose real más abajo).

  function setLlmTwoAgents(): void {
    setLlmResponse(
      JSON.stringify({
        selectedAgents: [
          {
            slug: 'summarizer-v1',
            registry: 'wasiai',
            input: { query: 'step0' },
            reasoning: 'first',
          },
          {
            slug: 'translator-v1',
            registry: 'wasiai',
            input: { query: 'step1' },
            reasoning: 'second',
          },
        ],
        reasoning: 'Two-step plan',
      }),
    );
  }

  // T-21 (WKH-102 AC-1): master path (no delegationContext) propaga chainId a
  // compose. ANTES del fix esto era `undefined`.
  it('T-21: master path propagates resolved chainId to compose', async () => {
    setLlmTwoAgents();

    await orchestrateService.orchestrate(
      { goal: 'master multi-step', budget: 5.0, chainId: 2368 },
      'orch-21',
    );

    const composeCall = vi.mocked(composeService.compose).mock.calls[0]![0]!;
    expect(composeCall.chainId).toBe(2368);
    // master path → no delegationContext propagated.
    expect(composeCall.delegationContext).toBeUndefined();
  });

  // T-22 (WKH-102 AC-1): el chainId pasado es exactamente request.chainId, no
  // un hardcode ni derivado (CD-2). Un valor distinto se propaga tal cual.
  it('T-22: compose receives exactly request.chainId (no hardcode)', async () => {
    setLlmTwoAgents();

    await orchestrateService.orchestrate(
      { goal: 'chain echo', budget: 5.0, chainId: 8453 },
      'orch-22',
    );

    const composeCall = vi.mocked(composeService.compose).mock.calls[0]![0]!;
    expect(composeCall.chainId).toBe(8453);
  });

  // T-23 (WKH-102 AC-5): path de delegación sin regresión — sigue propagando
  // chainId Y delegationContext (rama que ya funcionaba antes del fix).
  it('T-23: delegation path still propagates chainId and delegationContext', async () => {
    setLlmTwoAgents();
    const delegationContext = {
      delegationId: 'del-1',
      ownerRef: 'user-1',
      keyId: 'k1',
      maxAmountPerTx: '5.00',
    };

    await orchestrateService.orchestrate(
      {
        goal: 'delegated multi-step',
        budget: 5.0,
        chainId: 2368,
        delegationContext,
      },
      'orch-23',
    );

    const composeCall = vi.mocked(composeService.compose).mock.calls[0]![0]!;
    expect(composeCall.chainId).toBe(2368);
    expect(composeCall.delegationContext).toEqual(delegationContext);
  });

  // T-24 (WKH-102): x402 path (no chainId resuelto) → compose recibe undefined,
  // el skip defensivo per-step se mantiene (no regresión del caso x402).
  it('T-24: x402 path (no chainId) propagates undefined to compose', async () => {
    setLlmTwoAgents();

    await orchestrateService.orchestrate(
      { goal: 'x402 no chain', budget: 5.0 },
      'orch-24',
    );

    const composeCall = vi.mocked(composeService.compose).mock.calls[0]![0]!;
    expect(composeCall.chainId).toBeUndefined();
  });

  // ─── WKH-124 ─ protocol_fee receipt emission (AC-1 / AC-6) ──────────────

  function makeScopingKeyRow() {
    // Minimal A2AAgentKeyRow lineage source available at the orchestrate
    // call-site (request.scopingKeyRow). Only owner_ref + id are read by the
    // receipt emission; the rest is unused here (cast to the type for the call).
    return {
      id: 'scoping-key-1',
      owner_ref: 'owner-1',
    } as unknown as import('../types/index.js').A2AAgentKeyRow;
  }

  // T-25 (WKH-124 AC-1): fee charged → emit protocol_fee with fee wallet counterparty.
  it('T-25: charged fee emits protocol_fee receipt from scopingKeyRow lineage', async () => {
    process.env.WASIAI_PROTOCOL_FEE_WALLET = '0xFEEWALLET';
    vi.mocked(getProtocolFeeRate).mockReturnValue(0.01);
    vi.mocked(receiptService.emit).mockResolvedValue(undefined);
    vi.mocked(chargeProtocolFee).mockResolvedValueOnce({
      status: 'charged',
      feeUsdc: 0.01,
      txHash: '0xFEE',
    });
    setLlmOneAgent();

    await orchestrateService.orchestrate(
      {
        goal: 'fee receipt',
        budget: 1.0,
        chainId: 2368,
        scopingKeyRow: makeScopingKeyRow(),
      },
      'orch-25',
    );

    expect(vi.mocked(receiptService.emit)).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerRef: 'owner-1',
        agentKeyId: 'scoping-key-1',
        receiptType: 'protocol_fee',
        chainId: 2368,
        txHash: '0xFEE',
        counterparty: '0xFEEWALLET',
        orchestrationId: 'orch-25',
      }),
    );
    delete process.env.WASIAI_PROTOCOL_FEE_WALLET;
  });

  // T-26 (WKH-124 AC-6): a rejecting emit NEVER breaks the orchestrate result.
  it('T-26: rejecting receipt emit does not interrupt the orchestrate return', async () => {
    vi.mocked(getProtocolFeeRate).mockReturnValue(0.01);
    vi.mocked(receiptService.emit).mockRejectedValue(new Error('receipt down'));
    vi.mocked(chargeProtocolFee).mockResolvedValueOnce({
      status: 'charged',
      feeUsdc: 0.01,
      txHash: '0xFEE',
    });
    setLlmOneAgent();

    const result = await orchestrateService.orchestrate(
      {
        goal: 'fee receipt fails',
        budget: 1.0,
        chainId: 2368,
        scopingKeyRow: makeScopingKeyRow(),
      },
      'orch-26',
    );

    expect(result.feeChargeTxHash).toBe('0xFEE');
    expect(result.answer).toBeDefined();
  });

  // T-27 (WKH-124 CD-D): without scopingKeyRow → no emit (no owner lineage).
  it('T-27: no scopingKeyRow → protocol_fee receipt NOT emitted', async () => {
    vi.mocked(getProtocolFeeRate).mockReturnValue(0.01);
    vi.mocked(receiptService.emit).mockResolvedValue(undefined);
    vi.mocked(chargeProtocolFee).mockResolvedValueOnce({
      status: 'charged',
      feeUsdc: 0.01,
      txHash: '0xFEE',
    });
    setLlmOneAgent();

    await orchestrateService.orchestrate(
      { goal: 'no scoping key', budget: 1.0, chainId: 2368 },
      'orch-27',
    );

    expect(vi.mocked(receiptService.emit)).not.toHaveBeenCalled();
  });

  // ─── WKH-127 ─ Orchestrate billing (real price + refund) ───────────────

  // Two agents priced 0.30 + 0.20. WKH-127 (BLQ-ALTO-1): el service debita SOLO
  // el step-0 (0.30); el step 1 (0.20) lo debita compose (acá mockeado). El plan
  // real cuesta 0.50, pero la base del débito step-0 del service es 0.30.
  const wkh127Agents: Agent[] = [
    { ...mockAgents[0]!, slug: 'summarizer-v1', priceUsdc: 0.3 },
    { ...mockAgents[1]!, slug: 'translator-v1', priceUsdc: 0.2 },
  ];
  const wkh127Discovery: DiscoveryResult = {
    agents: wkh127Agents,
    total: 2,
    registries: ['wasiai'],
  };

  function masterKeyRow() {
    return {
      id: 'master-key-1',
      owner_ref: 'owner-127',
    } as unknown as import('../types/index.js').A2AAgentKeyRow;
  }

  // T-AC1 (AC-1, BLQ-ALTO-1): plan 0.30+0.20 → el débito step-0 del service es
  // el precio del step-0 (0.30), NO la suma del plan (0.50) ni el placeholder $1.
  // Sumar el plan duplicaría el step 1 (0.20) que compose ya cobra → double-charge.
  it('T-AC1: debits the step-0 price (0.30), not the plan sum or $1 placeholder', async () => {
    vi.mocked(discoveryService.discover).mockResolvedValue(wkh127Discovery);
    // P1 (audit 2026-07-01): step-0 pricing now flows through
    // resolveAgentPriceUsdc → discoveryService.getAgent; keep getAgent
    // consistent with THIS test's discover result so the step-0 price matches.
    vi.mocked(discoveryService.getAgent).mockImplementation(
      async (slug) => wkh127Agents.find((a) => a.slug === slug) ?? null,
    );
    setLlmTwoAgents();

    await orchestrateService.orchestrate(
      {
        goal: 'real price',
        budget: 5.0,
        chainId: 2368,
        scopingKeyRow: masterKeyRow(),
      },
      'orch-ac1',
    );

    expect(vi.mocked(budgetService.debit)).toHaveBeenCalledTimes(1);
    const debitCall = vi.mocked(budgetService.debit).mock.calls[0]!;
    expect(debitCall[2]).toBeCloseTo(0.3, 6);
    expect(debitCall[2]).not.toBe(1);
    // No es la suma del plan (eso sería el double-charge del BLQ-ALTO-1).
    expect(debitCall[2]).not.toBeCloseTo(0.5, 6);
  });

  // AUDIT A3 (ALTA): un budget JSONB corrupto (no-numérico) hacía que
  // `Number(bal) <= 0` evaluara `NaN <= 0 === false` → el early-fail "sin
  // fondos" NO disparaba (un balance corrupto se trataba como con fondos). El
  // guard `!Number.isFinite(n) || n <= 0` lo trata como saldo insuficiente.
  it('T-A3: corrupt non-numeric balance early-fails (NaN treated as insufficient)', async () => {
    vi.mocked(discoveryService.discover).mockResolvedValue(wkh127Discovery);
    // P1 (audit 2026-07-01): step-0 pricing now flows through
    // resolveAgentPriceUsdc → discoveryService.getAgent; keep getAgent
    // consistent with THIS test's discover result so the step-0 price matches.
    vi.mocked(discoveryService.getAgent).mockImplementation(
      async (slug) => wkh127Agents.find((a) => a.slug === slug) ?? null,
    );
    setLlmTwoAgents();
    // getBalance devuelve un valor no-numérico (budget JSONB corrupto).
    vi.mocked(budgetService.getBalance).mockResolvedValueOnce('not-a-number');

    const result = await orchestrateService.orchestrate(
      {
        goal: 'corrupt balance',
        budget: 5.0,
        chainId: 2368,
        scopingKeyRow: masterKeyRow(),
      },
      'orch-a3',
    );

    // Early-fail: no se debita, el pipeline no corre, reasoning de fondos.
    expect(result.pipeline.success).toBe(false);
    expect(result.reasoning).toBe('Insufficient budget for orchestration');
    expect(vi.mocked(budgetService.debit)).not.toHaveBeenCalled();
    expect(vi.mocked(composeService.compose)).not.toHaveBeenCalled();
  });

  // T-AC2 (AC-2): steps.length===0 (all over budget) → debit 0 calls.
  it('T-AC2: zero steps (all over budget) → no debit', async () => {
    vi.mocked(discoveryService.discover).mockResolvedValue(wkh127Discovery);
    // P1 (audit 2026-07-01): step-0 pricing now flows through
    // resolveAgentPriceUsdc → discoveryService.getAgent; keep getAgent
    // consistent with THIS test's discover result so the step-0 price matches.
    vi.mocked(discoveryService.getAgent).mockImplementation(
      async (slug) => wkh127Agents.find((a) => a.slug === slug) ?? null,
    );
    setLlmTwoAgents();

    await orchestrateService.orchestrate(
      {
        goal: 'tiny budget',
        budget: 0.05,
        chainId: 2368,
        scopingKeyRow: masterKeyRow(),
      },
      'orch-ac2',
    );

    expect(vi.mocked(budgetService.debit)).not.toHaveBeenCalled();
  });

  // T-AC3 (AC-3, BLQ-ALTO-1): el débito step-0 del service == precio del step-0
  // (primer agente del plan = summarizer-v1 @ 0.30), NO la suma del plan ni un
  // placeholder. Los steps 1..N los cobra compose por separado (sin duplicar).
  it('T-AC3: debited amount equals the step-0 price (not the plan sum)', async () => {
    vi.mocked(discoveryService.discover).mockResolvedValue(wkh127Discovery);
    // P1 (audit 2026-07-01): step-0 pricing now flows through
    // resolveAgentPriceUsdc → discoveryService.getAgent; keep getAgent
    // consistent with THIS test's discover result so the step-0 price matches.
    vi.mocked(discoveryService.getAgent).mockImplementation(
      async (slug) => wkh127Agents.find((a) => a.slug === slug) ?? null,
    );
    setLlmTwoAgents();

    await orchestrateService.orchestrate(
      {
        goal: 'sum cost',
        budget: 5.0,
        chainId: 2368,
        scopingKeyRow: masterKeyRow(),
      },
      'orch-ac3',
    );

    const debitCall = vi.mocked(budgetService.debit).mock.calls[0]!;
    // precio del step-0 (summarizer-v1) = 0.30
    expect(debitCall[2]).toBeCloseTo(0.3, 6);
  });

  // T-AC4 (AC-4): plan all priceUsdc===0 → debit with 1.0 + debitFallback flag + warn.
  it('T-AC4: zero-cost plan applies $1 fallback and sets debitFallback', async () => {
    const zeroPriceDiscovery: DiscoveryResult = {
      agents: [
        { ...mockAgents[0]!, slug: 'summarizer-v1', priceUsdc: 0 },
        { ...mockAgents[1]!, slug: 'translator-v1', priceUsdc: 0 },
      ],
      total: 2,
      registries: ['wasiai'],
    };
    vi.mocked(discoveryService.discover).mockResolvedValue(zeroPriceDiscovery);
    // P1 (audit 2026-07-01): keep getAgent consistent with the zero-price
    // discovery so resolveAgentPriceUsdc resolves 0 → the $1 fallback triggers.
    vi.mocked(discoveryService.getAgent).mockImplementation(
      async (slug) =>
        zeroPriceDiscovery.agents.find((a) => a.slug === slug) ?? null,
    );
    setLlmTwoAgents();

    const result = await orchestrateService.orchestrate(
      {
        goal: 'zero cost plan',
        budget: 5.0,
        chainId: 2368,
        scopingKeyRow: masterKeyRow(),
      },
      'orch-ac4',
    );

    const debitCall = vi.mocked(budgetService.debit).mock.calls[0]!;
    expect(debitCall[2]).toBe(1.0);
    expect(result.debitFallback).toBe(true);
    expect(logSpy.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'registry-miss' }),
      '[orchestrate.price.fallback]',
    );
  });

  // T-AC5 (AC-5): total failure (totalCostUsdc:0) → credit called with debitedUsd.
  it('T-AC5: total pipeline failure refunds the full debited amount', async () => {
    vi.mocked(discoveryService.discover).mockResolvedValue(wkh127Discovery);
    // P1 (audit 2026-07-01): step-0 pricing now flows through
    // resolveAgentPriceUsdc → discoveryService.getAgent; keep getAgent
    // consistent with THIS test's discover result so the step-0 price matches.
    vi.mocked(discoveryService.getAgent).mockImplementation(
      async (slug) => wkh127Agents.find((a) => a.slug === slug) ?? null,
    );
    vi.mocked(composeService.compose).mockResolvedValue({
      ...mockComposeResult,
      success: false,
      totalCostUsdc: 0,
    });
    setLlmTwoAgents();

    await orchestrateService.orchestrate(
      {
        goal: 'total fail refund',
        budget: 5.0,
        chainId: 2368,
        scopingKeyRow: masterKeyRow(),
      },
      'orch-ac5',
    );

    expect(vi.mocked(budgetService.credit)).toHaveBeenCalledTimes(1);
    const creditCall = vi.mocked(budgetService.credit).mock.calls[0]!;
    // BLQ-ALTO-1: debitedUsd = precio del step-0 = 0.30. Fallo total (totalCost
    // 0 → el step-0 ni settleó) → se reembolsa el step-0 entero (incidente original).
    expect(creditCall[2]).toBeCloseTo(0.3, 6);
    expect(creditCall[3]).toBe('owner-127');
  });

  // T-AC6 (AC-6): partial failure → credit with (debited - consumed); >=debited → no credit.
  it('T-AC6a: partial failure refunds the unconsumed remainder', async () => {
    vi.mocked(discoveryService.discover).mockResolvedValue(wkh127Discovery);
    // P1 (audit 2026-07-01): step-0 pricing now flows through
    // resolveAgentPriceUsdc → discoveryService.getAgent; keep getAgent
    // consistent with THIS test's discover result so the step-0 price matches.
    vi.mocked(discoveryService.getAgent).mockImplementation(
      async (slug) => wkh127Agents.find((a) => a.slug === slug) ?? null,
    );
    vi.mocked(composeService.compose).mockResolvedValue({
      ...mockComposeResult,
      success: false,
      totalCostUsdc: 0.2,
    });
    setLlmTwoAgents();

    await orchestrateService.orchestrate(
      {
        goal: 'partial fail refund',
        budget: 5.0,
        chainId: 2368,
        scopingKeyRow: masterKeyRow(),
      },
      'orch-ac6a',
    );

    expect(vi.mocked(budgetService.credit)).toHaveBeenCalledTimes(1);
    const creditCall = vi.mocked(budgetService.credit).mock.calls[0]!;
    // BLQ-ALTO-1: debitedUsd = step-0 = 0.30. Fórmula AC-6 parcial:
    // max(0, debited 0.30 - consumed 0.20) = 0.10.
    expect(creditCall[2]).toBeCloseTo(0.1, 6);
  });

  it('T-AC6b: consumed >= debited → no refund', async () => {
    vi.mocked(discoveryService.discover).mockResolvedValue(wkh127Discovery);
    // P1 (audit 2026-07-01): step-0 pricing now flows through
    // resolveAgentPriceUsdc → discoveryService.getAgent; keep getAgent
    // consistent with THIS test's discover result so the step-0 price matches.
    vi.mocked(discoveryService.getAgent).mockImplementation(
      async (slug) => wkh127Agents.find((a) => a.slug === slug) ?? null,
    );
    vi.mocked(composeService.compose).mockResolvedValue({
      ...mockComposeResult,
      success: false,
      totalCostUsdc: 0.5,
    });
    setLlmTwoAgents();

    await orchestrateService.orchestrate(
      {
        goal: 'consumed equals debited',
        budget: 5.0,
        chainId: 2368,
        scopingKeyRow: masterKeyRow(),
      },
      'orch-ac6b',
    );

    expect(vi.mocked(budgetService.credit)).not.toHaveBeenCalled();
  });

  // T-AC8 (AC-8): credit fails → console.error structured + refundError flag, no PG msg.
  it('T-AC8: refund failure sets refundError and logs structured error', async () => {
    vi.mocked(discoveryService.discover).mockResolvedValue(wkh127Discovery);
    // P1 (audit 2026-07-01): step-0 pricing now flows through
    // resolveAgentPriceUsdc → discoveryService.getAgent; keep getAgent
    // consistent with THIS test's discover result so the step-0 price matches.
    vi.mocked(discoveryService.getAgent).mockImplementation(
      async (slug) => wkh127Agents.find((a) => a.slug === slug) ?? null,
    );
    vi.mocked(composeService.compose).mockResolvedValue({
      ...mockComposeResult,
      success: false,
      totalCostUsdc: 0,
    });
    vi.mocked(budgetService.credit).mockResolvedValue({
      success: false,
      error: 'REFUND_FAILED',
    });
    setLlmTwoAgents();

    const result = await orchestrateService.orchestrate(
      {
        goal: 'refund fails',
        budget: 5.0,
        chainId: 2368,
        scopingKeyRow: masterKeyRow(),
      },
      'orch-ac8',
    );

    expect(result.refundError).toBe(true);
    expect(logSpy.error).toHaveBeenCalledWith(
      expect.objectContaining({
        keyId: 'master-key-1',
        chainId: 2368,
        // BLQ-ALTO-1: refund = debitedUsd = precio del step-0 = 0.30.
        amountUsd: 0.3,
        orchestrationId: 'orch-ac8',
      }),
      '[orchestrate.refund-failed]',
    );
  });

  // T-AC9 (AC-9): x402 (no scopingKeyRow) → debit and credit 0 calls.
  it('T-AC9: x402 path (no scopingKeyRow) → no debit, no credit', async () => {
    vi.mocked(discoveryService.discover).mockResolvedValue(wkh127Discovery);
    // P1 (audit 2026-07-01): step-0 pricing now flows through
    // resolveAgentPriceUsdc → discoveryService.getAgent; keep getAgent
    // consistent with THIS test's discover result so the step-0 price matches.
    vi.mocked(discoveryService.getAgent).mockImplementation(
      async (slug) => wkh127Agents.find((a) => a.slug === slug) ?? null,
    );
    vi.mocked(composeService.compose).mockResolvedValue({
      ...mockComposeResult,
      success: false,
      totalCostUsdc: 0,
    });
    setLlmTwoAgents();

    await orchestrateService.orchestrate(
      { goal: 'x402 no key', budget: 5.0, chainId: 2368 },
      'orch-ac9',
    );

    expect(vi.mocked(budgetService.debit)).not.toHaveBeenCalled();
    expect(vi.mocked(budgetService.credit)).not.toHaveBeenCalled();
  });

  // T-AC11 (AC-11): success with totalCostUsdc>0 → credit 0 calls (CD-2).
  it('T-AC11: successful pipeline never refunds (CD-2)', async () => {
    vi.mocked(discoveryService.discover).mockResolvedValue(wkh127Discovery);
    // P1 (audit 2026-07-01): step-0 pricing now flows through
    // resolveAgentPriceUsdc → discoveryService.getAgent; keep getAgent
    // consistent with THIS test's discover result so the step-0 price matches.
    vi.mocked(discoveryService.getAgent).mockImplementation(
      async (slug) => wkh127Agents.find((a) => a.slug === slug) ?? null,
    );
    vi.mocked(composeService.compose).mockResolvedValue({
      ...mockComposeResult,
      success: true,
      totalCostUsdc: 0.5,
    });
    setLlmTwoAgents();

    await orchestrateService.orchestrate(
      {
        goal: 'success no refund',
        budget: 5.0,
        chainId: 2368,
        scopingKeyRow: masterKeyRow(),
      },
      'orch-ac11',
    );

    expect(vi.mocked(budgetService.credit)).not.toHaveBeenCalled();
    // fee applied on success path.
    expect(vi.mocked(chargeProtocolFee)).toHaveBeenCalledTimes(1);
  });

  // ─── H1 (audit 2026-07-01) ─ delegation/session step-0 billed post-plan ──
  //
  // Regression guard for the BLQ-MED-1 under-charge: a delegation/session caller
  // orchestrating a single-step pipeline must NOT ride for free. The middleware
  // skips the step-0 debit under `skipMiddlewareDebit`; the service now bills it
  // post-plan through the DUAL-LEDGER RPC (parent budget + total_spent/spent_usd)
  // with a symmetric credit-back on failure — mirroring the master path.

  /** Parent (effective) key row a delegation/session caller presents as
   *  request.scopingKeyRow. id/owner_ref match the debit context (production
   *  middleware sets both from parentKey — a2a-key.ts:512/753). */
  function delegationParentRow() {
    return {
      id: 'k1',
      owner_ref: 'user-1',
    } as unknown as import('../types/index.js').A2AAgentKeyRow;
  }

  const wkh127DelegationContext = {
    delegationId: 'del-1',
    ownerRef: 'user-1',
    keyId: 'k1',
    maxAmountPerTx: '5.00',
  };
  const wkh127SessionContext = {
    sessionId: 'sess-1',
    ownerRef: 'user-1',
    keyId: 'k1',
  };

  // T-H1a: delegation single-step orchestration is BILLED (not $0). The step-0
  // debit routes through the delegation context (dual-ledger RPC) at the REAL
  // step-0 price (0.30) — not $1 flat, not $0.
  it('T-H1a: delegation step-0 is debited at the real price (not free)', async () => {
    vi.mocked(discoveryService.discover).mockResolvedValue(wkh127Discovery);
    vi.mocked(discoveryService.getAgent).mockImplementation(
      async (slug) => wkh127Agents.find((a) => a.slug === slug) ?? null,
    );
    setLlmTwoAgents();

    await orchestrateService.orchestrate(
      {
        goal: 'delegated single pipeline',
        budget: 5.0,
        chainId: 2368,
        scopingKeyRow: delegationParentRow(),
        delegationContext: wkh127DelegationContext,
      },
      'orch-h1a',
    );

    // Step-0 debited exactly once, at the real step-0 price, WITH the delegation
    // context (arg 3) → the dual-ledger RPC path (parent budget + total_spent).
    expect(vi.mocked(budgetService.debit)).toHaveBeenCalledTimes(1);
    const debitCall = vi.mocked(budgetService.debit).mock.calls[0]!;
    expect(debitCall[0]).toBe('k1'); // parent key id
    expect(debitCall[2]).toBeCloseTo(0.3, 6); // real step-0 price (NOT $1, NOT $0)
    expect(debitCall[2]).not.toBe(1);
    expect(debitCall[3]).toEqual(wkh127DelegationContext); // routes dual-ledger
    expect(debitCall[6]).toBe('user-1'); // owner_ref of the parent
    // Successful pipeline → NO refund on any ledger.
    expect(vi.mocked(budgetService.creditDelegation)).not.toHaveBeenCalled();
    expect(vi.mocked(budgetService.credit)).not.toHaveBeenCalled();
  });

  // T-H1b: on total pipeline failure the delegation step-0 is refunded via the
  // DUAL-LEDGER credit (creditDelegation) — NOT the master credit(). Symmetric to
  // master's AC-5 refund; reverts parent budget + delegation.total_spent.
  it('T-H1b: delegation total failure refunds via dual-ledger creditDelegation', async () => {
    vi.mocked(discoveryService.discover).mockResolvedValue(wkh127Discovery);
    vi.mocked(discoveryService.getAgent).mockImplementation(
      async (slug) => wkh127Agents.find((a) => a.slug === slug) ?? null,
    );
    vi.mocked(composeService.compose).mockResolvedValue({
      ...mockComposeResult,
      success: false,
      totalCostUsdc: 0,
    });
    setLlmTwoAgents();

    await orchestrateService.orchestrate(
      {
        goal: 'delegated pipeline fails',
        budget: 5.0,
        chainId: 2368,
        scopingKeyRow: delegationParentRow(),
        delegationContext: wkh127DelegationContext,
      },
      'orch-h1b',
    );

    // Refund via the DUAL ledger (parent + total_spent), not the master credit().
    expect(vi.mocked(budgetService.creditDelegation)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(budgetService.credit)).not.toHaveBeenCalled();
    const creditCall = vi.mocked(budgetService.creditDelegation).mock.calls[0]!;
    expect(creditCall[0]).toBe('del-1'); // delegationId
    expect(creditCall[1]).toBe('user-1'); // ownerRef
    expect(creditCall[2]).toBe('k1'); // keyId (parent)
    expect(creditCall[3]).toBe(2368); // chainId
    expect(creditCall[4]).toBeCloseTo(0.3, 6); // full step-0 (debitedUsd)
  });

  // T-H1c: key-session single-step orchestration is BILLED (not $0) and routes
  // the step-0 debit through the session context (dual-ledger RPC).
  it('T-H1c: key-session step-0 is debited at the real price (not free)', async () => {
    vi.mocked(discoveryService.discover).mockResolvedValue(wkh127Discovery);
    vi.mocked(discoveryService.getAgent).mockImplementation(
      async (slug) => wkh127Agents.find((a) => a.slug === slug) ?? null,
    );
    setLlmTwoAgents();

    await orchestrateService.orchestrate(
      {
        goal: 'session single pipeline',
        budget: 5.0,
        chainId: 2368,
        scopingKeyRow: delegationParentRow(),
        keySessionContext: wkh127SessionContext,
      },
      'orch-h1c',
    );

    expect(vi.mocked(budgetService.debit)).toHaveBeenCalledTimes(1);
    const debitCall = vi.mocked(budgetService.debit).mock.calls[0]!;
    expect(debitCall[2]).toBeCloseTo(0.3, 6); // real step-0 price (NOT $1, NOT $0)
    expect(debitCall[4]).toEqual(wkh127SessionContext); // routes dual-ledger session
    expect(vi.mocked(budgetService.creditSession)).not.toHaveBeenCalled();
  });

  // T-H1d: on total failure the session step-0 is refunded via creditSession
  // (dual-ledger), NOT the master credit().
  it('T-H1d: key-session total failure refunds via dual-ledger creditSession', async () => {
    vi.mocked(discoveryService.discover).mockResolvedValue(wkh127Discovery);
    vi.mocked(discoveryService.getAgent).mockImplementation(
      async (slug) => wkh127Agents.find((a) => a.slug === slug) ?? null,
    );
    vi.mocked(composeService.compose).mockResolvedValue({
      ...mockComposeResult,
      success: false,
      totalCostUsdc: 0,
    });
    setLlmTwoAgents();

    await orchestrateService.orchestrate(
      {
        goal: 'session pipeline fails',
        budget: 5.0,
        chainId: 2368,
        scopingKeyRow: delegationParentRow(),
        keySessionContext: wkh127SessionContext,
      },
      'orch-h1d',
    );

    expect(vi.mocked(budgetService.creditSession)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(budgetService.credit)).not.toHaveBeenCalled();
    const creditCall = vi.mocked(budgetService.creditSession).mock.calls[0]!;
    expect(creditCall[0]).toBe('sess-1'); // sessionId
    expect(creditCall[4]).toBeCloseTo(0.3, 6); // full step-0 (debitedUsd)
  });

  // T-H1e (CR MNR-1): registry-collision vector at the orchestrate step-0 debit.
  // Two registries expose the SAME slug (`summarizer-v1`): the real one (`wasiai`
  // @0.30, LLM-selected) and a decoy (`decoy` @0.000001) that a slug-only lookup
  // (price-ascending) would win. The step-0 debit must be priced off the
  // (slug, registry) PAIR the plan selected — i.e. 0.30, never the 0.000001 decoy.
  it('T-H1e: step-0 debit uses the (slug, registry) pair price, not a same-slug decoy', async () => {
    const collisionAgents: Agent[] = [
      {
        ...wkh127Agents[0]!,
        slug: 'summarizer-v1',
        registry: 'wasiai',
        priceUsdc: 0.3,
      },
      {
        ...wkh127Agents[0]!,
        id: 'decoy-agent',
        slug: 'summarizer-v1',
        registry: 'decoy',
        priceUsdc: 0.000001,
      },
      {
        ...wkh127Agents[1]!,
        slug: 'translator-v1',
        registry: 'wasiai',
        priceUsdc: 0.2,
      },
    ];
    vi.mocked(discoveryService.discover).mockResolvedValue({
      agents: collisionAgents,
      total: collisionAgents.length,
      registries: ['wasiai', 'decoy'],
    });
    // getAgent honors the registry hint: (slug, registry) → exact pair; a
    // slug-only lookup falls to the cheapest match (the decoy) — the bug shape.
    vi.mocked(discoveryService.getAgent).mockImplementation(
      async (slug, registryId) => {
        const matches = collisionAgents.filter((a) => a.slug === slug);
        if (registryId) {
          return matches.find((a) => a.registry === registryId) ?? null;
        }
        return (
          [...matches].sort((a, b) => a.priceUsdc - b.priceUsdc)[0] ?? null
        );
      },
    );
    // LLM selects the REAL (wasiai) pair for step-0.
    setLlmTwoAgents();

    await orchestrateService.orchestrate(
      {
        goal: 'collision vector',
        budget: 5.0,
        chainId: 2368,
        scopingKeyRow: masterKeyRow(),
      },
      'orch-h1e',
    );

    const debitCall = vi.mocked(budgetService.debit).mock.calls[0]!;
    // The (summarizer-v1, wasiai) price is 0.30 — NOT the 0.000001 decoy.
    expect(debitCall[2]).toBeCloseTo(0.3, 6);
    expect(debitCall[2]).not.toBeCloseTo(0.000001, 6);
  });

  // ─── WKH-128 ─ Planner candidate window + no-relevant-agent guard ───────

  /** Build N demo echo agents to flood the discovery sort (verified-first). */
  function makeDemoAgents(): Agent[] {
    const slugs = ['base-demo', 'avax-demo', 'kite-demo'];
    return slugs.map((slug, i) => ({
      ...mockAgents[0]!,
      id: `demo-${i}`,
      name: `Demo ${slug}`,
      slug,
      description: 'Trivial echo agent',
      priceUsdc: 0.01,
      verified: true,
    }));
  }

  /** Extract the JSON agent list the planner actually showed the LLM. */
  function plannerPromptText(): string {
    const call = mockCreate.mock.calls[0]![0]! as {
      messages: { content: string }[];
    };
    return call.messages[0]!.content;
  }

  /** Extract the systemPrompt (planning rules) sent to the LLM. */
  function plannerSystemPrompt(): string {
    const call = mockCreate.mock.calls[0]![0]! as { system: string };
    return call.system;
  }

  // T-ORDER-1 (precondition-gate ordering rule): the systemPrompt MUST instruct
  // the LLM to place verification/eligibility/compliance/authorization "gate"
  // agents EARLY in the pipeline, even without a direct data dependency. This is
  // a prompt-CONTENT assertion — the rule is generic (no domain/slug hardcode)
  // and cannot be behaviorally tested without a real Anthropic call. The existing
  // data-dependency rule must survive alongside it (additive, not a replacement).
  it('T-ORDER-1: systemPrompt tells the LLM to place precondition-gate agents early', async () => {
    setLlmResponse(
      JSON.stringify({
        selectedAgents: [
          {
            slug: 'summarizer-v1',
            registry: 'wasiai',
            input: { query: 'x' },
            reasoning: 'ok',
          },
        ],
        reasoning: 'ok',
      }),
    );

    await orchestrateService.orchestrate(
      { goal: 'order rule check', budget: 5.0 },
      'orch-order-1',
    );

    const system = plannerSystemPrompt();
    // The new precondition-gate ordering rule is present, generic (no slug/domain).
    expect(system).toContain('precondition gate');
    expect(system).toContain('verification, eligibility, compliance');
    expect(system).toContain('placing it EARLY');
    // The pre-existing data-dependency ordering rule still coexists (additive).
    expect(system).toContain('place the producer first');
  });

  // ─── WKH-153 ─ Planner input derived from per-agent input_schema ────────

  // T-INPUT-1 (AC-1/AC-3): the userPrompt output example MUST NOT hardcode the
  // biased `"input": { "query": "specific input" }` as the single shape, AND
  // MUST instruct the LLM to derive `input` from each agent's own input_schema.
  // Prompt-CONTENT assertion — the real LLM behavior is not testable in CI
  // (non-deterministic); we assert the string that primes it.
  it('T-INPUT-1: userPrompt drops the biased {query} example and points at input_schema', async () => {
    setLlmResponse(
      JSON.stringify({
        selectedAgents: [
          {
            slug: 'summarizer-v1',
            registry: 'wasiai',
            input: { query: 'x' },
            reasoning: 'ok',
          },
        ],
        reasoning: 'ok',
      }),
    );

    await orchestrateService.orchestrate(
      { goal: 'input schema check', budget: 5.0 },
      'orch-input-1',
    );

    const prompt = plannerPromptText();
    // AC-3: the old single biased example is gone from the format block.
    expect(prompt).not.toContain('"input": { "query": "specific input" }');
    // AC-1: the prompt now flags the example as a placeholder and points the
    // LLM at each agent's own input_schema.
    expect(prompt).toContain('PLACEHOLDER');
    expect(prompt).toContain('input_schema');
    expect(prompt).toContain('example_input');
    // Anchor exclusively to the NOTE text (these phrases cannot appear in the
    // agentList JSON), so the assertions can't pass on incidental token matches.
    expect(prompt).toContain('is a PLACEHOLDER, not a fixed shape');
    // AR MNR-1: the note explicitly forbids emitting the literal placeholder tokens.
    expect(prompt).toContain('Never output the literal placeholder');
    // The systemPrompt reinforces per-agent derivation (no cross-agent reuse).
    const system = plannerSystemPrompt();
    expect(system).toContain('OWN input_schema');
    expect(system).toContain('never reuse');
  });

  // T-INPUT-2 (AC-4): when the LLM returns a STRUCTURED input (not {query}) for
  // an agent whose schema defines it, llmPlan/planOrchestration propagates it
  // intact to the step — no mutation, no forcing to {query}. Read-only /plan
  // path so no compose/debit noise.
  it('T-INPUT-2: structured input from the LLM propagates intact to the step', async () => {
    const structured = {
      amountUSD: 400,
      receiverCountry: 'PE',
      senderName: 'Ada',
    };
    setLlmResponse(
      JSON.stringify({
        selectedAgents: [
          {
            slug: 'summarizer-v1',
            registry: 'wasiai',
            input: structured,
            reasoning: 'remittance shape',
          },
        ],
        reasoning: 'ok',
      }),
    );

    const plan = await orchestrateService.planOrchestration(
      { goal: 'send 400 USD to Peru', budget: 5.0 },
      'plan-input-2',
    );

    expect(plan.steps.length).toBe(1);
    // Propagated verbatim — not coerced to { query: ... } anywhere downstream.
    expect(plan.steps[0]!.input).toEqual(structured);
    expect(plan.steps[0]!.input).not.toHaveProperty('query');
  });

  // T-INPUT-3 (AC-2/CD-3): agents whose input IS { query } are NOT broken. The
  // LLM returns a {query} input (valid for a free-form / schema-less agent) and
  // it must still flow through unchanged.
  it('T-INPUT-3: {query} input stays valid for free-form / schema-less agents', async () => {
    const queryInput = { query: 'summarize this' };
    setLlmResponse(
      JSON.stringify({
        selectedAgents: [
          {
            slug: 'summarizer-v1',
            registry: 'wasiai',
            input: queryInput,
            reasoning: 'free-form agent',
          },
        ],
        reasoning: 'ok',
      }),
    );

    const plan = await orchestrateService.planOrchestration(
      { goal: 'summarize a doc', budget: 5.0 },
      'plan-input-3',
    );

    expect(plan.steps.length).toBe(1);
    expect(plan.steps[0]!.input).toEqual(queryInput);
  });

  // T-W1 (WKH-128 change 1+2): demos are deprioritized so a genuinely relevant
  // agent reaches the planner window AND is the one selected/settled — not the
  // cheap demo. Discovery returns demos FIRST (mirrors prod verified-first sort),
  // the orchestrate candidate reorder must push them to the back.
  it('T-W1: relevant agent reaches the planner window over demo echo agents', async () => {
    const realAgent: Agent = {
      ...mockAgents[0]!,
      id: 'real-1',
      name: 'DeFi Sentiment',
      slug: 'wasi-defi-sentiment',
      description: 'Analyzes DeFi market sentiment',
      priceUsdc: 0.5,
      verified: false,
    };
    // Demos first (as prod sort would place them), real agent last.
    vi.mocked(discoveryService.discover).mockResolvedValue({
      agents: [...makeDemoAgents(), realAgent],
      total: 4,
      registries: ['wasiai'],
    });
    setLlmResponse(
      JSON.stringify({
        selectedAgents: [
          {
            slug: 'wasi-defi-sentiment',
            registry: 'wasiai',
            input: { query: 'sentiment' },
            reasoning: 'real match',
          },
        ],
        reasoning: 'Picked the relevant agent',
      }),
    );

    await orchestrateService.orchestrate(
      { goal: 'Analyze DeFi sentiment', budget: 5.0 },
      'orch-w1',
    );

    // The relevant agent is visible to the LLM in the prompt.
    expect(plannerPromptText()).toContain('wasi-defi-sentiment');
    // And it is what compose actually executes (not a demo).
    const composeCall = vi.mocked(composeService.compose).mock.calls[0]![0]!;
    expect(composeCall.steps[0]!.agent).toBe('wasi-defi-sentiment');
  });

  // T-W2 (WKH-128 change 3): only demo agents available + LLM returns no usable
  // plan → no-relevant-agent path. MUST NOT debit, MUST NOT call compose, returns
  // pipeline.success:false with a no_relevant_agent reason. Money math is balanced
  // by construction: nothing was debited so nothing needs refunding.
  it('T-W2: only-demo candidates with no plan → no settle, no charge, no_relevant_agent', async () => {
    vi.mocked(discoveryService.discover).mockResolvedValue({
      agents: makeDemoAgents(),
      total: 3,
      registries: ['wasiai'],
    });
    // LLM returns nothing usable → triggers greedy over demos only.
    setLlmError(new Error('API timeout'));

    const result = await orchestrateService.orchestrate(
      {
        goal: 'Build me a quantum trading bot',
        budget: 5.0,
        chainId: 2368,
        scopingKeyRow: masterKeyRow(),
      },
      'orch-w2',
    );

    expect(result.pipeline.success).toBe(false);
    expect(result.reasoning).toContain('no_relevant_agent');
    expect(result.pipeline.steps).toHaveLength(0);
    expect(result.protocolFeeUsdc).toBe(0);
    // No money moved: no debit, no refund, no settlement.
    expect(vi.mocked(budgetService.debit)).not.toHaveBeenCalled();
    expect(vi.mocked(budgetService.credit)).not.toHaveBeenCalled();
    expect(vi.mocked(composeService.compose)).not.toHaveBeenCalled();
    expect(vi.mocked(chargeProtocolFee)).not.toHaveBeenCalled();
  });

  // T-W3 (WKH-128 change 3): the guard does NOT fire when a real agent exists.
  // Demos present but a relevant agent is available → normal path settles.
  it('T-W3: demos present but real agent available → normal settlement', async () => {
    const realAgent: Agent = {
      ...mockAgents[0]!,
      id: 'real-2',
      name: 'Chainlink Price',
      slug: 'wasi-chainlink-price',
      priceUsdc: 0.4,
      verified: false,
    };
    vi.mocked(discoveryService.discover).mockResolvedValue({
      agents: [...makeDemoAgents(), realAgent],
      total: 4,
      registries: ['wasiai'],
    });
    setLlmResponse(
      JSON.stringify({
        selectedAgents: [
          {
            slug: 'wasi-chainlink-price',
            registry: 'wasiai',
            input: { query: 'price' },
            reasoning: 'real',
          },
        ],
        reasoning: 'ok',
      }),
    );

    const result = await orchestrateService.orchestrate(
      {
        goal: 'Get the ETH price',
        budget: 5.0,
        chainId: 2368,
        scopingKeyRow: masterKeyRow(),
      },
      'orch-w3',
    );

    expect(result.reasoning).not.toContain('no_relevant_agent');
    expect(vi.mocked(composeService.compose)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(budgetService.debit)).toHaveBeenCalledTimes(1);
  });

  // T-W4 (WKH-128 change 3, MNR-1): MIXED case — a real agent IS available but the
  // planner picks ONLY a demo echo. The guard must key on the SELECTED PLAN, not the
  // candidate set: even though hasRealCandidate is true, an all-demo plan returns
  // no_relevant_agent BEFORE any debit. No settle, no charge. This is the exact bug
  // AR reproduced (real agent available + LLM selects a demo → demo settles, caller
  // charged for an irrelevant echo).
  it('T-W4: real agent available but planner selects ONLY a demo → no_relevant_agent, no charge', async () => {
    const realAgent: Agent = {
      ...mockAgents[0]!,
      id: 'real-3',
      name: 'DeFi Sentiment',
      slug: 'wasi-defi-sentiment',
      description: 'Analyzes DeFi market sentiment',
      priceUsdc: 0.5,
      verified: false,
    };
    vi.mocked(discoveryService.discover).mockResolvedValue({
      agents: [...makeDemoAgents(), realAgent],
      total: 4,
      registries: ['wasiai'],
    });
    // The LLM ignores the real agent and selects only a demo echo.
    setLlmResponse(
      JSON.stringify({
        selectedAgents: [
          {
            slug: 'base-demo',
            registry: 'wasiai',
            input: { message: 'ping' },
            reasoning: 'picked the cheap echo',
          },
        ],
        reasoning: 'Selected base-demo',
      }),
    );

    const result = await orchestrateService.orchestrate(
      {
        goal: 'Analyze DeFi sentiment',
        budget: 5.0,
        chainId: 2368,
        scopingKeyRow: masterKeyRow(),
      },
      'orch-w4',
    );

    // Guard fires on the all-demo PLAN despite a real candidate being present.
    expect(result.pipeline.success).toBe(false);
    expect(result.reasoning).toContain('no_relevant_agent');
    expect(result.pipeline.steps).toHaveLength(0);
    expect(result.protocolFeeUsdc).toBe(0);
    // No money moved and no demo settled: nothing to refund by construction.
    expect(vi.mocked(budgetService.debit)).not.toHaveBeenCalled();
    expect(vi.mocked(budgetService.credit)).not.toHaveBeenCalled();
    expect(vi.mocked(composeService.compose)).not.toHaveBeenCalled();
    expect(vi.mocked(chargeProtocolFee)).not.toHaveBeenCalled();
  });

  // T-W5 (money-path fallback relevance guard): a NONSENSE goal that forces the
  // greedy fallback (LLM failed) must NOT yield a chargeable 'ready' plan of
  // budget-fit-but-irrelevant REAL agents. With zero token overlap between the
  // goal and any greedy-selected agent, the guard forces no_relevant_agent BEFORE
  // any debit/settle — nothing is charged.
  it('T-W5: nonsense goal + greedy fallback → no_relevant_agent, no charge', async () => {
    // Real (non-demo) agents fit the budget but share NO token with the goal.
    setLlmError(new Error('API timeout'));

    const result = await orchestrateService.orchestrate(
      {
        goal: 'asdfqwerty12345',
        budget: 5.0,
        chainId: 2368,
        scopingKeyRow: masterKeyRow(),
      },
      'orch-w5',
    );

    expect(result.pipeline.success).toBe(false);
    expect(result.reasoning).toContain('no_relevant_agent');
    expect(result.reasoning).toContain('emergency fallback');
    expect(result.pipeline.steps).toHaveLength(0);
    expect(result.protocolFeeUsdc).toBe(0);
    // No money moved and no agent settled: nothing to refund by construction.
    expect(vi.mocked(budgetService.debit)).not.toHaveBeenCalled();
    expect(vi.mocked(budgetService.credit)).not.toHaveBeenCalled();
    expect(vi.mocked(composeService.compose)).not.toHaveBeenCalled();
    expect(vi.mocked(chargeProtocolFee)).not.toHaveBeenCalled();
  });

  // T-W5b (money-path fallback relevance guard — short-circuit bug): a goal with
  // ZERO evaluable tokens (nothing ≥3 chars after tokenizing, e.g. "a") that forces
  // the greedy fallback must be treated as the CLEAREST case of "no relevance", NOT
  // exempted from the guard. Before the fix, `goalTokens.size > 0 && !steps.some(...)`
  // short-circuited to false for an empty token set, letting a chargeable 'ready'
  // plan of irrelevant agents through. Now `goalTokens.size === 0` FORCES
  // no_relevant_agent BEFORE any debit/settle — nothing is charged.
  it('T-W5b: zero-token goal + greedy fallback → no_relevant_agent, no charge', async () => {
    setLlmError(new Error('API timeout'));

    const result = await orchestrateService.orchestrate(
      {
        goal: 'a',
        budget: 5.0,
        chainId: 2368,
        scopingKeyRow: masterKeyRow(),
      },
      'orch-w5b',
    );

    expect(result.pipeline.success).toBe(false);
    expect(result.reasoning).toContain('no_relevant_agent');
    expect(result.reasoning).toContain('emergency fallback');
    expect(result.pipeline.steps).toHaveLength(0);
    expect(result.protocolFeeUsdc).toBe(0);
    // No money moved and no agent settled: nothing to refund by construction.
    expect(vi.mocked(budgetService.debit)).not.toHaveBeenCalled();
    expect(vi.mocked(budgetService.credit)).not.toHaveBeenCalled();
    expect(vi.mocked(composeService.compose)).not.toHaveBeenCalled();
    expect(vi.mocked(chargeProtocolFee)).not.toHaveBeenCalled();
  });

  // T-W5c (regression): the zero-token fix must NOT over-fire. A goal with mostly
  // short tokens but AT LEAST ONE evaluable token ≥3 chars that overlaps a real
  // agent (here "text" ↔ Summarizer/Translator) still yields a legit greedy plan →
  // planStatus 'ready', agent executed, normally charged. The size===0 branch only
  // fires when there is NO signal at all.
  it('T-W5c: short-but-relevant goal + greedy fallback → ready, agent executed', async () => {
    setLlmError(new Error('API timeout'));

    const result = await orchestrateService.orchestrate(
      { goal: 'do a text', budget: 5.0 },
      'orch-w5c',
    );

    expect(result.reasoning).toContain('[FALLBACK]');
    expect(result.reasoning).not.toContain('no_relevant_agent');
    expect(result.answer).toBeDefined();
    expect(vi.mocked(composeService.compose)).toHaveBeenCalledTimes(1);
    const composeCall = vi.mocked(composeService.compose).mock.calls[0]![0]!;
    expect(composeCall.steps.length).toBeGreaterThan(0);
  });

  // T-W6 (regression): the fallback relevance guard must NOT break a legitimate
  // greedy fallback. When the LLM fails but the goal DOES share a token with a
  // real agent (here "text" ↔ Summarizer/Translator descriptions), the greedy
  // plan is still valid → planStatus 'ready', agent executed, normally charged.
  it('T-W6: relevant goal + greedy fallback → ready, agent executed (not blocked)', async () => {
    setLlmError(new Error('API timeout'));

    const result = await orchestrateService.orchestrate(
      { goal: 'summarize this text document', budget: 5.0 },
      'orch-w6',
    );

    expect(result.reasoning).toContain('[FALLBACK]');
    expect(result.reasoning).not.toContain('no_relevant_agent');
    expect(result.answer).toBeDefined();
    expect(vi.mocked(composeService.compose)).toHaveBeenCalledTimes(1);
    const composeCall = vi.mocked(composeService.compose).mock.calls[0]![0]!;
    expect(composeCall.steps.length).toBeGreaterThan(0);
  });

  // ─── WKH-152 ─ Planner LLM per-step relevance backstop (money-path) ─────

  // A relevant agent (shares tokens with the goal) + a REAL, non-demo agent that
  // is lexically disjoint from the goal in name/description/capabilities AND input.
  const wkh152Agents: Agent[] = [
    {
      ...mockAgents[0]!,
      id: 'wkh152-weather',
      name: 'Weather Oracle',
      slug: 'weather-v1',
      description: 'Provides weather forecasts',
      capabilities: ['weather', 'forecast'],
      priceUsdc: 0.4,
      registry: 'wasiai',
      verified: false,
    },
    {
      ...mockAgents[0]!,
      id: 'wkh152-defi',
      name: 'DeFi Sentiment',
      slug: 'defi-sentiment-v1',
      description: 'Analyzes DeFi market sentiment',
      capabilities: ['defi', 'sentiment'],
      priceUsdc: 0.7,
      registry: 'wasiai',
      verified: false,
    },
  ];
  const wkh152Discovery: DiscoveryResult = {
    agents: wkh152Agents,
    total: 2,
    registries: ['wasiai'],
  };

  /** Keep getAgent consistent with the wkh152 discover set (step-0 recompute). */
  function wkh152GetAgent(): void {
    vi.mocked(discoveryService.getAgent).mockImplementation(
      async (slug) => wkh152Agents.find((a) => a.slug === slug) ?? null,
    );
  }

  // T-152-1 (AC-1, CD-2/CD-6): mixed LLM plan (relevant + real-irrelevant) →
  // the irrelevant agent is dropped BEFORE debit/compose; the relevant one runs.
  it('T-152-1: mixed plan drops the irrelevant agent, charges only the relevant', async () => {
    vi.mocked(discoveryService.discover).mockResolvedValue(wkh152Discovery);
    wkh152GetAgent();
    // LLM selects BOTH; the irrelevant agent gets a disjoint tailored input.
    setLlmResponse(
      JSON.stringify({
        selectedAgents: [
          {
            slug: 'weather-v1',
            registry: 'wasiai',
            input: { location: 'lima' },
            reasoning: 'weather match',
          },
          {
            slug: 'defi-sentiment-v1',
            registry: 'wasiai',
            input: { topic: 'ethereum liquidity' },
            reasoning: 'off-topic',
          },
        ],
        reasoning: 'Two-agent plan',
      }),
    );

    const result = await orchestrateService.orchestrate(
      {
        goal: 'What is the weather forecast today',
        budget: 5.0,
        chainId: 2368,
        scopingKeyRow: masterKeyRow(),
      },
      'orch-152-1',
    );

    expect(vi.mocked(composeService.compose)).toHaveBeenCalledTimes(1);
    const composeCall = vi.mocked(composeService.compose).mock.calls[0]![0]!;
    const composedSlugs = composeCall.steps.map((s) => s.agent);
    expect(composedSlugs).toContain('weather-v1');
    expect(composedSlugs).not.toContain('defi-sentiment-v1');
    expect(vi.mocked(budgetService.debit)).toHaveBeenCalledTimes(1);
    expect(result.reasoning).toContain('dropped');
  });

  // T-152-2 (AC-2, DT-7/CD-15): MIXED-PLAN-ONLY — an LLM plan where EVERY step is
  // lexically disjoint from the goal must be CONSERVED IN FULL (no-op), NOT routed to
  // no_relevant_agent. The filter never empties a plan; with zero matches the most
  // likely cause is cross-vocabulary (multilingual), not irrelevance. Billing must be
  // byte-identical to the no-filter run (steps intact, original order, step-0 debit
  // unchanged, no 'dropped', no 'no_relevant_agent').
  it('T-152-2: all-disjoint LLM plan → conserve ALL (no drop, no no_relevant_agent)', async () => {
    vi.mocked(discoveryService.discover).mockResolvedValue(wkh152Discovery);
    wkh152GetAgent();
    // Goal disjoint from BOTH agents (weather-v1, defi-sentiment-v1). LLM selects both
    // real (non-demo) agents; the filter would drop both → relevantSteps.length === 0
    // → applyDrop === false → conserve all.
    setLlmResponse(
      JSON.stringify({
        selectedAgents: [
          {
            slug: 'weather-v1',
            registry: 'wasiai',
            input: { location: 'lima' },
            reasoning: 'step one',
          },
          {
            slug: 'defi-sentiment-v1',
            registry: 'wasiai',
            input: { topic: 'ethereum liquidity' },
            reasoning: 'step two',
          },
        ],
        reasoning: 'Two-agent plan',
      }),
    );

    const result = await orchestrateService.orchestrate(
      {
        goal: 'translate this document into french',
        budget: 5.0,
        chainId: 2368,
        scopingKeyRow: masterKeyRow(),
      },
      'orch-152-2',
    );

    // Conserve ALL: no rejection, steps = original complete plan in original order.
    expect(result.reasoning).not.toContain('no_relevant_agent');
    expect(result.reasoning).not.toContain('dropped');
    expect(vi.mocked(composeService.compose)).toHaveBeenCalledTimes(1);
    const composeCall = vi.mocked(composeService.compose).mock.calls[0]![0]!;
    expect(composeCall.steps.map((s) => s.agent)).toEqual([
      'weather-v1',
      'defi-sentiment-v1',
    ]);
    // Billing byte-identical to sin-filtro: step-0 debit = original head price (0.4),
    // debit/compose/fee all fired as they would without the filter.
    expect(vi.mocked(budgetService.debit)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(budgetService.debit).mock.calls[0]![2]).toBeCloseTo(
      0.4,
      6,
    );
    expect(vi.mocked(chargeProtocolFee)).toHaveBeenCalled();
  });

  // T-152-2b (AC-2, DT-7/CD-15): MULTILINGUAL false-negative lock. A Spanish goal +
  // RELEVANT agents described in English share ZERO lexical tokens → the filter would
  // drop every step. MIXED-PLAN-ONLY conserves ALL (no drop, no no_relevant_agent),
  // billing byte-identical. This is the exact case that motivated the amendment and
  // broke 35 money-path tests under the original (all-disjoint ⇒ no_relevant_agent).
  it('T-152-2b: multilingual all-disjoint plan → conserve ALL (no false-negative)', async () => {
    const mlWeather: Agent = {
      ...mockAgents[0]!,
      id: 'wkh152-ml-weather',
      name: 'Weather Forecast',
      slug: 'weather-en-v1',
      description: 'weather forecast service',
      capabilities: ['weather', 'forecast'],
      priceUsdc: 0.4,
      registry: 'wasiai',
      verified: false,
    };
    const mlFx: Agent = {
      ...mockAgents[0]!,
      id: 'wkh152-ml-fx',
      name: 'FX Rate Quote',
      slug: 'fx-en-v1',
      description: 'fx rate quote for currency conversion',
      capabilities: ['fx', 'rate'],
      priceUsdc: 0.5,
      registry: 'wasiai',
      verified: false,
    };
    const mlAgents = [mlWeather, mlFx];
    vi.mocked(discoveryService.discover).mockResolvedValue({
      agents: mlAgents,
      total: 2,
      registries: ['wasiai'],
    });
    vi.mocked(discoveryService.getAgent).mockImplementation(
      async (slug) => mlAgents.find((a) => a.slug === slug) ?? null,
    );
    setLlmResponse(
      JSON.stringify({
        selectedAgents: [
          {
            slug: 'weather-en-v1',
            registry: 'wasiai',
            input: { location: 'lima' },
            reasoning: 'weather step',
          },
          {
            slug: 'fx-en-v1',
            registry: 'wasiai',
            input: { pair: 'usd' },
            reasoning: 'fx step',
          },
        ],
        reasoning: 'Weather + FX plan',
      }),
    );

    const result = await orchestrateService.orchestrate(
      {
        // Spanish goal — 0 lexical overlap with the English agent corpora.
        goal: 'cotiza el clima y el precio del dolar',
        budget: 5.0,
        chainId: 2368,
        scopingKeyRow: masterKeyRow(),
      },
      'orch-152-2b',
    );

    // Filter would drop both (0 overlap) → conserve ALL, NO false-negative.
    expect(result.reasoning).not.toContain('no_relevant_agent');
    expect(result.reasoning).not.toContain('dropped');
    expect(vi.mocked(composeService.compose)).toHaveBeenCalledTimes(1);
    const composeCall = vi.mocked(composeService.compose).mock.calls[0]![0]!;
    expect(composeCall.steps.map((s) => s.agent)).toEqual([
      'weather-en-v1',
      'fx-en-v1',
    ]);
    // Billing byte-identical: step-0 debit = original head price (0.4), unchanged.
    expect(vi.mocked(budgetService.debit)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(budgetService.debit).mock.calls[0]![2]).toBeCloseTo(
      0.4,
      6,
    );
    expect(vi.mocked(chargeProtocolFee)).toHaveBeenCalled();
  });

  // T-152-3 (AC-3, CD-3): 100%-relevant LLM plan → executes/charges IDENTICAL to
  // today. No 'dropped', no 'no_relevant_agent', both steps in original order.
  it('T-152-3: all-relevant plan → zero regression, no drop', async () => {
    vi.mocked(discoveryService.discover).mockResolvedValue(mockDiscoveryResult);
    setLlmTwoAgents();

    const result = await orchestrateService.orchestrate(
      {
        goal: 'summarize and translate this text',
        budget: 5.0,
        chainId: 2368,
        scopingKeyRow: masterKeyRow(),
      },
      'orch-152-3',
    );

    expect(vi.mocked(composeService.compose)).toHaveBeenCalledTimes(1);
    const composeCall = vi.mocked(composeService.compose).mock.calls[0]![0]!;
    expect(composeCall.steps.map((s) => s.agent)).toEqual([
      'summarizer-v1',
      'translator-v1',
    ]);
    expect(result.reasoning).not.toContain('dropped');
    expect(result.reasoning).not.toContain('no_relevant_agent');
  });

  // T-152-4 (AC-4, CD-5/CD-8): step-0 original = irrelevant; the SURVIVING 2nd step
  // (different price) must reprice the step-0 debit and become the new head.
  it('T-152-4: dropped step-0 → debit repriced to the surviving head', async () => {
    vi.mocked(discoveryService.discover).mockResolvedValue(wkh152Discovery);
    wkh152GetAgent();
    // Irrelevant agent FIRST (step-0), relevant agent SECOND — with distinct price.
    setLlmResponse(
      JSON.stringify({
        selectedAgents: [
          {
            slug: 'defi-sentiment-v1',
            registry: 'wasiai',
            input: { topic: 'ethereum liquidity' },
            reasoning: 'off-topic head',
          },
          {
            slug: 'weather-v1',
            registry: 'wasiai',
            input: { location: 'lima' },
            reasoning: 'weather match',
          },
        ],
        reasoning: 'Two-agent plan',
      }),
    );

    await orchestrateService.orchestrate(
      {
        goal: 'What is the weather forecast today',
        budget: 5.0,
        chainId: 2368,
        scopingKeyRow: masterKeyRow(),
      },
      'orch-152-4',
    );

    // Debit repriced to the survivor (0.4), NOT the dropped head (0.7).
    expect(vi.mocked(budgetService.debit)).toHaveBeenCalledTimes(1);
    const debitAmount = vi.mocked(budgetService.debit).mock.calls[0]![2];
    expect(debitAmount).toBeCloseTo(0.4, 6);
    const composeCall = vi.mocked(composeService.compose).mock.calls[0]![0]!;
    expect(composeCall.steps[0]!.agent).toBe('weather-v1');
    expect(composeCall.steps[0]!.passOutput).toBe(false);
  });

  // T-152-5 (FALSE-NEGATIVE, DT-1): a genuinely relevant agent whose name/desc are
  // disjoint from the goal but whose tailored INPUT overlaps ≥1 token must NOT be
  // dropped. Adding `input` to the corpus is strictly conservative.
  it('T-152-5: relevance from input tokens alone → step NOT dropped', async () => {
    const opaqueAgent: Agent = {
      ...mockAgents[0]!,
      id: 'wkh152-opaque',
      name: 'Zeta Bot',
      slug: 'zeta-v1',
      description: 'multipurpose helper',
      capabilities: ['general'],
      priceUsdc: 0.3,
      registry: 'wasiai',
      verified: false,
    };
    vi.mocked(discoveryService.discover).mockResolvedValue({
      agents: [opaqueAgent],
      total: 1,
      registries: ['wasiai'],
    });
    vi.mocked(discoveryService.getAgent).mockImplementation(async (slug) =>
      slug === 'zeta-v1' ? opaqueAgent : null,
    );
    // name/desc/caps share NOTHING with the goal; only the input does ("weather").
    setLlmResponse(
      JSON.stringify({
        selectedAgents: [
          {
            slug: 'zeta-v1',
            registry: 'wasiai',
            input: { query: 'weather in lima' },
            reasoning: 'handles it',
          },
        ],
        reasoning: 'Opaque agent plan',
      }),
    );

    const result = await orchestrateService.orchestrate(
      {
        goal: 'weather forecast lima',
        budget: 5.0,
        chainId: 2368,
        scopingKeyRow: masterKeyRow(),
      },
      'orch-152-5',
    );

    expect(vi.mocked(composeService.compose)).toHaveBeenCalledTimes(1);
    const composeCall = vi.mocked(composeService.compose).mock.calls[0]![0]!;
    expect(composeCall.steps.map((s) => s.agent)).toContain('zeta-v1');
    expect(result.reasoning).not.toContain('dropped');
    expect(result.reasoning).not.toContain('no_relevant_agent');
  });

  // T-152-5b (CD-14): a goal with ZERO evaluable tokens (all <3 chars) in the LLM
  // path ⇒ the filter is SKIPPED entirely, every step conserved (never empty a LLM
  // plan on a goal without lexical signal).
  it('T-152-5b: zero-token goal (LLM path) → filter skipped, step conserved', async () => {
    setLlmResponse(
      JSON.stringify({
        selectedAgents: [
          {
            slug: 'summarizer-v1',
            registry: 'wasiai',
            input: { query: 'do it' },
            reasoning: 'ok',
          },
        ],
        reasoning: 'Single-agent plan',
      }),
    );

    const result = await orchestrateService.orchestrate(
      {
        goal: 'a b c',
        budget: 5.0,
        chainId: 2368,
        scopingKeyRow: masterKeyRow(),
      },
      'orch-152-5b',
    );

    expect(result.reasoning).not.toContain('no_relevant_agent');
    expect(vi.mocked(composeService.compose)).toHaveBeenCalledTimes(1);
    const composeCall = vi.mocked(composeService.compose).mock.calls[0]![0]!;
    expect(composeCall.steps.map((s) => s.agent)).toContain('summarizer-v1');
  });

  // T-152-6 (AC-6, CD-7): an all-demo LLM plan still returns no_relevant_agent via
  // the `allStepsAreDemos` branch — the new per-step filter does NOT run redundant.
  it('T-152-6: all-demo LLM plan → no_relevant_agent (unchanged), no charge', async () => {
    const realAgent: Agent = {
      ...mockAgents[0]!,
      id: 'real-152-6',
      name: 'DeFi Sentiment',
      slug: 'wasi-defi-sentiment',
      description: 'Analyzes DeFi market sentiment',
      priceUsdc: 0.5,
      verified: false,
    };
    vi.mocked(discoveryService.discover).mockResolvedValue({
      agents: [...makeDemoAgents(), realAgent],
      total: 4,
      registries: ['wasiai'],
    });
    setLlmResponse(
      JSON.stringify({
        selectedAgents: [
          {
            slug: 'base-demo',
            registry: 'wasiai',
            input: { message: 'ping' },
            reasoning: 'picked the cheap echo',
          },
        ],
        reasoning: 'Selected base-demo',
      }),
    );

    const result = await orchestrateService.orchestrate(
      {
        goal: 'Analyze DeFi sentiment',
        budget: 5.0,
        chainId: 2368,
        scopingKeyRow: masterKeyRow(),
      },
      'orch-152-6',
    );

    expect(result.reasoning).toContain('no_relevant_agent');
    expect(result.reasoning).not.toContain('dropped');
    expect(result.pipeline.steps).toHaveLength(0);
    expect(vi.mocked(budgetService.debit)).not.toHaveBeenCalled();
    expect(vi.mocked(composeService.compose)).not.toHaveBeenCalled();
  });

  // T-152-8 (DT-2): pure helper. overlap ⇒ true; no overlap ⇒ false; empty
  // goalTokens ⇒ false; case-insensitive; tokens <3 chars ignored.
  it('T-152-8: textOverlapsGoal pure semantics', () => {
    const goalTokens = new Set(['weather', 'forecast']);
    expect(textOverlapsGoal('daily WEATHER report', goalTokens)).toBe(true);
    expect(textOverlapsGoal('defi market sentiment', goalTokens)).toBe(false);
    // empty goalTokens ⇒ false (caller handles the empty case, CD-14).
    expect(textOverlapsGoal('weather forecast', new Set())).toBe(false);
    // tokens <3 chars are ignored by the tokenizer.
    expect(textOverlapsGoal('to be at', new Set(['to', 'be']))).toBe(false);
  });

  // T-AC-DOUBLE (CD-11/§4.4): single orchestrate on total failure → credit exactly once.
  it('T-AC-DOUBLE: total failure refunds exactly once (no double refund)', async () => {
    vi.mocked(discoveryService.discover).mockResolvedValue(wkh127Discovery);
    // P1 (audit 2026-07-01): step-0 pricing now flows through
    // resolveAgentPriceUsdc → discoveryService.getAgent; keep getAgent
    // consistent with THIS test's discover result so the step-0 price matches.
    vi.mocked(discoveryService.getAgent).mockImplementation(
      async (slug) => wkh127Agents.find((a) => a.slug === slug) ?? null,
    );
    vi.mocked(composeService.compose).mockResolvedValue({
      ...mockComposeResult,
      success: false,
      totalCostUsdc: 0,
    });
    setLlmTwoAgents();

    await orchestrateService.orchestrate(
      {
        goal: 'single refund',
        budget: 5.0,
        chainId: 2368,
        scopingKeyRow: masterKeyRow(),
      },
      'orch-double',
    );

    expect(vi.mocked(budgetService.credit)).toHaveBeenCalledTimes(1);
  });

  // ─── WKH-131 (HU-128): /orchestrate/plan + /orchestrate/execute ────────

  function setLlmSummarizer(): void {
    setLlmResponse(
      JSON.stringify({
        selectedAgents: [
          {
            slug: 'summarizer-v1',
            registry: 'wasiai',
            input: { query: 'plan it' },
            reasoning: 'best match',
          },
        ],
        reasoning: 'plan reasoning',
      }),
    );
  }

  // T-PLAN-1 (AC-1/AC-13): /plan happy → planStatus 'ready' + campos completos,
  // CERO budgetService.debit (read-only path).
  it('T-PLAN-1: planOrchestration ready → full plan + zero debit', async () => {
    setLlmSummarizer();

    const plan = await orchestrateService.planOrchestration(
      { goal: 'plan a summary', budget: 5.0 },
      'plan-1',
    );

    expect(plan.planStatus).toBe('ready');
    expect(plan.orchestrationId).toBe('plan-1');
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.costPerStep.length).toBe(plan.steps.length);
    expect(plan.maxQuotedCostUsdc).toBeGreaterThan(0);
    // WKH-132 (BLQ-MED-1): fee real cost-based = totalCostUsdc * rate, NO residual.
    // summarizer-v1 (0.5) precio real → fee 0.5 * 0.01 = 0.005; maxQuoted 0.505 es el
    // techo (== total + fee acá porque el precio se resolvió, sin placeholder).
    expect(plan.protocolFeeUsdc).toBeCloseTo(
      plan.totalCostUsdc * getProtocolFeeRate(),
      6,
    );
    expect(plan.protocolFeeUsdc).toBeCloseTo(0.005, 6);
    // Invariante del quote: techo ≥ total + fee.
    expect(plan.maxQuotedCostUsdc).toBeGreaterThanOrEqual(
      plan.totalCostUsdc + plan.protocolFeeUsdc - 1e-9,
    );
    expect(plan.consideredAgents.length).toBeGreaterThan(0);
    // CD-1/AC-13: plan NUNCA debita ni ejecuta compose.
    expect(vi.mocked(budgetService.debit)).not.toHaveBeenCalled();
    expect(vi.mocked(composeService.compose)).not.toHaveBeenCalled();
  });

  // T-PLAN-2 (AC-2): maxQuotedCostUsdc == sum(resolveAgentPriceUsdc)*(1+rate),
  // mismo número que augmentX402ChallengeAmount produciría para los mismos steps.
  it('T-PLAN-2: maxQuotedCostUsdc mirrors augmentX402ChallengeAmount math', async () => {
    setLlmSummarizer();

    const plan = await orchestrateService.planOrchestration(
      { goal: 'quote it', budget: 5.0 },
      'plan-2',
    );

    // summarizer-v1 priceUsdc=0.5; un solo step. rate por defecto 0.01.
    const rate = getProtocolFeeRate();
    const expected = Number((0.5 * (1 + rate)).toFixed(6));
    expect(plan.maxQuotedCostUsdc).toBeCloseTo(expected, 6);

    // Y el espejo directo via quoteMaxCostUsdc sobre los mismos steps.
    const quoted = await orchestrateService.quoteMaxCostUsdc(plan.steps, false);
    expect(quoted).toBeCloseTo(expected, 6);
  });

  // T-PLAN-2b (registry-price-resolution fix): reproduce el bug live de WKH-131.
  // El planner emite `step.registry` como DISPLAY-name ("WasiAI"), pero
  // `getAgent(slug, registryId)` espera el ID ("wasiai"). Con el mock que
  // devuelve null para el display-name y el agente real sin registry (= el
  // comportamiento real de discovery), el quote resolvía costPerStep=[0] y
  // maxQuotedCostUsdc=placeholder ($1). Con el fallback registry-agnóstico,
  // resuelve el precio real (0.5). FALLA en el código viejo, PASA en el fix.
  it('T-PLAN-2b: display-name registry hint → quote resolves REAL price (not placeholder)', async () => {
    // getAgent(slug, "WasiAI") → null (display-name != registry id "wasiai");
    // getAgent(slug) sin registry → resuelve el agente real (como discovery).
    vi.mocked(discoveryService.getAgent).mockImplementation(
      async (slug, registryId) => {
        if (registryId !== undefined) return null; // hint por display-name miss
        return mockAgents.find((a) => a.slug === slug) ?? null;
      },
    );
    // El planner selecciona summarizer-v1 con registry DISPLAY-name "WasiAI".
    setLlmResponse(
      JSON.stringify({
        selectedAgents: [
          {
            slug: 'summarizer-v1',
            registry: 'WasiAI',
            input: { query: 'plan it' },
            reasoning: 'best match',
          },
        ],
        reasoning: 'plan reasoning',
      }),
    );

    const plan = await orchestrateService.planOrchestration(
      { goal: 'quote with display-name registry', budget: 5.0 },
      'plan-2b',
    );

    const rate = getProtocolFeeRate();
    const expected = Number((0.5 * (1 + rate)).toFixed(6));
    // Precio real resuelto vía fallback, NO placeholder.
    expect(plan.costPerStep).toEqual([0.5]);
    expect(plan.maxQuotedCostUsdc).toBeCloseTo(expected, 6);
  });

  // ─── WKH-132 ─ Fee cost-based (proporcional al costo REAL del pipeline) ─────
  //
  // AC-1/AC-2/AC-9 (BLQ-MED-1 fix): el protocolFeeUsdc del plan 'ready' es el fee
  // REAL cost-based = round(totalCostUsdc × getProtocolFeeRate()), independiente del
  // budget declarado y del techo (maxQuotedCostUsdc). Reconcilia con feeRatePercent.
  // getAgent se mockea POR SLUG (CD-13) para que cada step resuelva su precio real;
  // _resetAgentPriceCache ya corre en beforeEach (CD-14).

  /** Agente resoluble por slug con un precio arbitrario (sin non-null — CD-15). */
  function priceAgent(slug: string, priceUsdc: number): Agent {
    return {
      id: `id-${slug}`,
      name: slug,
      slug,
      description: `agent ${slug}`,
      capabilities: ['test'],
      priceUsdc,
      reputation: 80,
      registry: 'wasiai',
      registry_id: 'wasiai',
      invokeUrl: `https://example.com/invoke/${slug}`,
      invocationNote: 'Use POST /compose or POST /orchestrate on the gateway.',
      verified: false,
      status: 'active',
    };
  }

  /** discovery + getAgent(slug) + LLM que selecciona TODOS los agentes dados. */
  function setPipeline(agents: Agent[]): void {
    vi.mocked(discoveryService.discover).mockResolvedValue({
      agents,
      total: agents.length,
      registries: ['wasiai'],
    });
    vi.mocked(discoveryService.getAgent).mockImplementation(async (slug) => {
      return agents.find((a) => a.slug === slug) ?? null;
    });
    setLlmResponse(
      JSON.stringify({
        selectedAgents: agents.map((a, i) => ({
          slug: a.slug,
          registry: 'wasiai',
          input: { q: i },
          reasoning: 'r',
        })),
        reasoning: 'multi-step plan',
      }),
    );
  }

  // AC-1: plan ready → protocolFeeUsdc = fee cost-based sobre el costo REAL.
  it('AC-1: plan ready → protocolFeeUsdc derives from real pipeline cost', async () => {
    // Pipeline de 3 steps totalizando 0.061.
    setPipeline([
      priceAgent('p1', 0.02),
      priceAgent('p2', 0.02),
      priceAgent('p3', 0.021),
    ]);

    const plan = await orchestrateService.planOrchestration(
      { goal: 'multi-step cost', budget: 1.0 },
      'ac1',
    );

    expect(plan.planStatus).toBe('ready');
    expect(plan.totalCostUsdc).toBeCloseTo(0.061, 6);
    // fee == round(totalCostUsdc × rate), NUNCA budget * rate ni el residual del techo.
    const rate = getProtocolFeeRate();
    const expectedFee = Number((plan.totalCostUsdc * rate).toFixed(6));
    expect(plan.protocolFeeUsdc).toBe(expectedFee);
    expect(plan.protocolFeeUsdc).toBeCloseTo(0.00061, 6);
    // El código viejo (budget * rate = 1.0 * 0.01 = 0.01) quedaría muy por encima.
    expect(plan.protocolFeeUsdc).not.toBeCloseTo(1.0 * 0.01, 4);
    // Techo ≥ total + fee (acá == porque todos los precios se resolvieron).
    expect(plan.maxQuotedCostUsdc).toBeGreaterThanOrEqual(
      plan.totalCostUsdc + plan.protocolFeeUsdc - 1e-9,
    );
  });

  // AC-2 (BLQ-MED-1): invariante del quote maxQuoted ≥ total + fee (ya NO ==,
  // porque el techo puede exceder por PLACEHOLDER_FEE_USD en steps sin precio).
  // En todos los casos el fee == round(total × rate) y reconcilia con feeRatePercent.
  it('AC-2: maxQuoted ≥ total + fee across pipelines (incl. placeholder)', async () => {
    const rate = getProtocolFeeRate();

    // Caso A: 1 step 0.02 (precio real → techo == total + fee).
    setPipeline([priceAgent('a1', 0.02)]);
    const pA = await orchestrateService.planOrchestration(
      { goal: 'g', budget: 1.0 },
      'ac2-a',
    );
    expect(pA.planStatus).toBe('ready');
    expect(pA.protocolFeeUsdc).toBe(
      Number((pA.totalCostUsdc * rate).toFixed(6)),
    );
    expect(pA.maxQuotedCostUsdc).toBeGreaterThanOrEqual(
      pA.totalCostUsdc + pA.protocolFeeUsdc - 1e-9,
    );

    // Caso B: 3 steps 0.061 (precios reales → techo == total + fee).
    setPipeline([
      priceAgent('b1', 0.02),
      priceAgent('b2', 0.02),
      priceAgent('b3', 0.021),
    ]);
    const pB = await orchestrateService.planOrchestration(
      { goal: 'g', budget: 1.0 },
      'ac2-b',
    );
    expect(pB.planStatus).toBe('ready');
    expect(pB.protocolFeeUsdc).toBe(
      Number((pB.totalCostUsdc * rate).toFixed(6)),
    );
    expect(pB.maxQuotedCostUsdc).toBeGreaterThanOrEqual(
      pB.totalCostUsdc + pB.protocolFeeUsdc - 1e-9,
    );

    // Caso C (MNR-1): step precio 0 → PLACEHOLDER_FEE_USD headroom en el techo,
    // total 0 ⇒ fee cost-based 0. El techo EXCEDE estrictamente total + fee: es
    // justo el caso que el residual inflaba (~1.01) y donde el invariante pasa de
    // == a ≥. protocolFeeUsdc == round(0 × rate) == 0, reconcilia con feeRatePercent.
    setPipeline([priceAgent('c1', 0)]);
    const pC = await orchestrateService.planOrchestration(
      { goal: 'g', budget: 5.0 },
      'ac2-c',
    );
    expect(pC.planStatus).toBe('ready');
    expect(pC.totalCostUsdc).toBe(0);
    expect(pC.protocolFeeUsdc).toBe(0);
    // Techo con placeholder headroom > total + fee (0) → ≥ estricto.
    expect(pC.maxQuotedCostUsdc).toBeGreaterThan(
      pC.totalCostUsdc + pC.protocolFeeUsdc,
    );
    expect(pC.maxQuotedCostUsdc).toBeGreaterThanOrEqual(
      pC.totalCostUsdc + pC.protocolFeeUsdc,
    );
  });

  // MNR-1 (BLQ-MED-1 real-calc): pipeline MIXTO — un step con precio real (0.04) y
  // un step precio 0/placeholder. Ejercita el cálculo REAL (sin mock del service):
  // protocolFeeUsdc == round(totalCostUsdc × rate), reconcilia con feeRatePercent
  // (== total × feeRatePercent/100), y maxQuotedCostUsdc ≥ total + fee (el techo
  // suma el placeholder del step sin precio).
  it('MNR-1: mixed real+placeholder pipeline → fee cost-based, techo ≥ total+fee', async () => {
    setPipeline([priceAgent('m1', 0.04), priceAgent('m2', 0)]);

    const plan = await orchestrateService.planOrchestration(
      { goal: 'mixed', budget: 5.0 },
      'mnr-1',
    );

    expect(plan.planStatus).toBe('ready');
    // total = 0.04 + 0 = 0.04 (el step precio 0 no aporta costo real).
    expect(plan.totalCostUsdc).toBeCloseTo(0.04, 6);

    const rate = getProtocolFeeRate();
    // Fee real cost-based (NO el residual del techo, que incluye el placeholder).
    expect(plan.protocolFeeUsdc).toBe(
      Number((plan.totalCostUsdc * rate).toFixed(6)),
    );
    // Reconcilia con feeRatePercent (= rate*100): fee == total × feeRatePercent/100.
    const feeRatePercent = Number((rate * 100).toFixed(6));
    expect(plan.protocolFeeUsdc).toBeCloseTo(
      plan.totalCostUsdc * (feeRatePercent / 100),
      6,
    );
    // Techo INCLUYE el placeholder del step sin precio → excede estrictamente total+fee.
    expect(plan.maxQuotedCostUsdc).toBeGreaterThan(
      plan.totalCostUsdc + plan.protocolFeeUsdc,
    );
    // Reserva interna de maxBudget == fee cost-based (no el techo inflado).
    expect(plan.feeUsdc).toBe(plan.protocolFeeUsdc);
  });

  // AC-9 (TEST CLAVE): mismo pipeline, budget 1.0 vs 5.0 → mismo protocolFeeUsdc.
  it('AC-9: same pipeline (0.061), budget 1.0 vs 5.0 → identical fee', async () => {
    setPipeline([
      priceAgent('s1', 0.02),
      priceAgent('s2', 0.02),
      priceAgent('s3', 0.021),
    ]);

    const p1 = await orchestrateService.planOrchestration(
      { goal: 'g', budget: 1.0 },
      'ac9-a',
    );
    const p2 = await orchestrateService.planOrchestration(
      { goal: 'g', budget: 5.0 },
      'ac9-b',
    );

    expect(p1.planStatus).toBe('ready');
    expect(p2.planStatus).toBe('ready');
    // Mismo pipeline ⇒ mismo fee, independiente del budget (~0.00061).
    expect(p1.protocolFeeUsdc).toBeCloseTo(p2.protocolFeeUsdc, 6);
    expect(p1.protocolFeeUsdc).toBeCloseTo(0.00061, 6);
    // El código viejo (budget-based) habría dado 0.01 y 0.05 respectivamente.
    expect(p1.protocolFeeUsdc).not.toBeCloseTo(1.0 * 0.01, 4);
    expect(p2.protocolFeeUsdc).not.toBeCloseTo(5.0 * 0.01, 4);
  });

  // BLQ-BAJO-1 (regresión de disponibilidad): la reserva INTERNA de maxBudget
  // (plan.feeUsdc) DEBE ser cost-based (totalCostUsdc * feeRate), NO el techo del
  // quote. Con un agente priceUsdc=0 el TECHO (maxQuotedCostUsdc) se infla a ~1.01
  // (placeholder PLACEHOLDER_FEE_USD) mientras el costo real es 0 → si la reserva
  // usara el techo, maxBudget = budget − 1.01 sería NEGATIVO → compose "Budget
  // exceeded" y una orquestación atómica que antes funcionaba falla. Con el fix
  // BLQ-MED-1 tanto la reserva (feeUsdc) como el fee REPORTADO (protocolFeeUsdc) son
  // cost-based (0 acá), desacoplados del techo. Nota: compose está mockeado en esta
  // suite, por lo que se asertan directamente los campos del plan que alimentan
  // maxBudget. maxQuotedCostUsdc conserva el placeholder headroom (invariante ≥).
  it('BLQ-BAJO-1: free agent (price 0) → feeUsdc + protocolFeeUsdc cost-based (0), techo con headroom', async () => {
    setPipeline([priceAgent('free1', 0)]);

    const plan = await orchestrateService.planOrchestration(
      { goal: 'free agent', budget: 1.0 },
      'blq-bajo-1',
    );

    expect(plan.planStatus).toBe('ready');
    expect(plan.totalCostUsdc).toBe(0);
    // Reserva INTERNA cost-based: totalCostUsdc (0) * feeRate = 0. Con feeUsdc == 0
    // maxBudget = budget − 0 = 1.0 → compose OK (elimina la asimetría con /execute).
    expect(plan.feeUsdc).toBe(0);
    // Fee REPORTADO cost-based (0), NO el techo inflado. Reconcilia con feeRatePercent.
    expect(plan.protocolFeeUsdc).toBe(0);
    // El TECHO conserva el placeholder headroom (~1.01) → invariante ≥ estricto.
    expect(plan.maxQuotedCostUsdc).toBeCloseTo(1.01, 6);
    expect(plan.maxQuotedCostUsdc).toBeGreaterThan(
      plan.totalCostUsdc + plan.protocolFeeUsdc,
    );
    // Regresión: la reserva NO debe seguir al techo inflado.
    expect(plan.feeUsdc).not.toBeCloseTo(plan.maxQuotedCostUsdc, 4);
  });

  // T-PLAN-3 (AC-6): no-funds → planStatus 'insufficient_funds' + track disparado.
  it('T-PLAN-3: no-funds → insufficient_funds + track', async () => {
    vi.mocked(budgetService.getBalance).mockResolvedValue('0');

    const plan = await orchestrateService.planOrchestration(
      {
        goal: 'broke',
        budget: 5.0,
        chainId: 2368,
        scopingKeyRow: masterKeyRow(),
      },
      'plan-3',
    );

    expect(plan.planStatus).toBe('insufficient_funds');
    expect(plan.remainingBudgetUsd).toBe('0');
    expect(vi.mocked(eventService.track)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(eventService.track)).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
  });

  // T-PLAN-4 (AC-6): no-agents → planStatus 'no_agents' + track.
  it('T-PLAN-4: no-agents → no_agents + track', async () => {
    vi.mocked(discoveryService.discover).mockResolvedValue({
      agents: [],
      total: 0,
      registries: [],
    });

    const plan = await orchestrateService.planOrchestration(
      { goal: 'nothing', budget: 5.0 },
      'plan-4',
    );

    expect(plan.planStatus).toBe('no_agents');
    expect(vi.mocked(eventService.track)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(eventService.track)).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'success' }),
    );
  });

  // T-PLAN-5 (AC-6): no-budget-fit → planStatus 'budget_exhausted' + track.
  it('T-PLAN-5: no-budget-fit → budget_exhausted + track', async () => {
    // Agentes que no caben: precio > budget/maxAgents. discover ya filtra por
    // maxPrice=budget/maxAgents, así que un budget chico deja el plan vacío.
    vi.mocked(discoveryService.discover).mockResolvedValue({
      agents: [{ ...mockAgents[0]!, priceUsdc: 0.5 }],
      total: 1,
      registries: ['wasiai'],
    });
    // LLM elige el agente pero el budget-fit lo trunca (budget < precio).
    setLlmResponse(
      JSON.stringify({
        selectedAgents: [
          {
            slug: 'summarizer-v1',
            registry: 'wasiai',
            input: { query: 'x' },
            reasoning: 'r',
          },
        ],
        reasoning: 'r',
      }),
    );

    const plan = await orchestrateService.planOrchestration(
      { goal: 'too pricey', budget: 0.1 },
      'plan-5',
    );

    expect(plan.planStatus).toBe('budget_exhausted');
    expect(vi.mocked(eventService.track)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(eventService.track)).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'success' }),
    );
  });

  // T-PLAN-6 (AC-6): all-demos → planStatus 'no_relevant_agent' + track con
  // metadata reason/hasRealCandidate.
  it('T-PLAN-6: all-demos → no_relevant_agent + track metadata', async () => {
    const demoAgent: Agent = {
      ...mockAgents[0]!,
      slug: 'base-demo',
      name: 'Base Demo',
      priceUsdc: 0.01,
    };
    vi.mocked(discoveryService.discover).mockResolvedValue({
      agents: [demoAgent],
      total: 1,
      registries: ['wasiai'],
    });
    setLlmResponse(
      JSON.stringify({
        selectedAgents: [
          {
            slug: 'base-demo',
            registry: 'wasiai',
            input: { query: 'x' },
            reasoning: 'r',
          },
        ],
        reasoning: 'r',
      }),
    );

    const plan = await orchestrateService.planOrchestration(
      { goal: 'only demos', budget: 5.0 },
      'plan-6',
    );

    expect(plan.planStatus).toBe('no_relevant_agent');
    expect(vi.mocked(eventService.track)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(eventService.track)).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        metadata: expect.objectContaining({
          reason: 'no_relevant_agent',
          hasRealCandidate: false,
        }),
      }),
    );
  });

  // T-PLAN-7 (CD-5): conteo total de call-sites de eventService.track == atómico.
  // Cada early-return dispara su track exactamente UNA vez (ni perdido ni duplicado).
  it('T-PLAN-7: each plan early-return fires exactly one track', async () => {
    // no-agents path: exactamente 1 track en plan, 0 en el atómico extra.
    vi.mocked(discoveryService.discover).mockResolvedValue({
      agents: [],
      total: 0,
      registries: [],
    });
    await orchestrateService.orchestrate({ goal: 'x', budget: 5.0 }, 'plan-7a');
    // orchestrate() → planOrchestration (track) + mapPlanEarlyReturn (NO track).
    expect(vi.mocked(eventService.track)).toHaveBeenCalledTimes(1);
  });

  // ─── WKH-151 ─ Discovery broaden-retry (fix plan vacío intermitente) ────────
  //
  // Cuando el caller manda `preferCapabilities` que no matchean el nombre exacto
  // de las capabilities publicadas, el primer discovery da 0 agentes. Un ÚNICO
  // retry sin el filtro de capabilities (mismo maxPrice/limit — CD-2) repuebla el
  // candidate set para que el LLM planner haga el matching de relevancia real.

  // T-WKH151-1 (AC-1/AC-2): 1er discover (con caps) vacío → retry sin caps trae
  // agentes → discover se llamó 2x, el 2º SIN capabilities y con el MISMO maxPrice
  // (CD-2), y el flujo sigue al planner (planStatus 'ready', NO early-return).
  it('T-WKH151-1: caps-empty first pass → retry without caps, 2 discover calls, flow reaches planner', async () => {
    setLlmSummarizer();
    // 1er call (con caps) → vacío; 2º call (sin caps) → los agentes reales.
    vi.mocked(discoveryService.discover)
      .mockResolvedValueOnce({ agents: [], total: 0, registries: [] })
      .mockResolvedValueOnce(mockDiscoveryResult);

    const plan = await orchestrateService.planOrchestration(
      {
        goal: 'send remittance',
        budget: 5.0,
        preferCapabilities: ['remit.corridor-discovery'],
      },
      'wkh151-1',
    );

    // El retry ocurrió: exactamente 2 llamadas a discover.
    expect(vi.mocked(discoveryService.discover)).toHaveBeenCalledTimes(2);
    const firstArg = vi.mocked(discoveryService.discover).mock.calls[0]![0];
    const secondArg = vi.mocked(discoveryService.discover).mock.calls[1]![0];
    // 1er intento: CON el filtro de capabilities.
    expect(firstArg.capabilities).toEqual(['remit.corridor-discovery']);
    // 2º intento (retry): SIN capabilities.
    expect(secondArg.capabilities).toBeUndefined();
    // CD-2: maxPrice NO se relaja — idéntico (budget/maxAgents = 5.0/5 = 1.0) y
    // limit se mantiene (50) en el retry.
    expect(firstArg.maxPrice).toBe(1.0);
    expect(secondArg.maxPrice).toBe(1.0);
    expect(secondArg.limit).toBe(50);
    // AC-2: el flujo siguió al planner con los agentes del retry (no early-return).
    expect(plan.planStatus).toBe('ready');
    expect(plan.steps.length).toBeGreaterThan(0);
    // WKH-151 (telemetría additive): el plan lleva los marcadores del broaden-retry
    // (viajan a executeApprovedPlan → evento `orchestrate_goal` de éxito en bdwv).
    expect(plan.broadenRetryUsed).toBe(true);
    expect(plan.retryAgentCount).toBe(mockDiscoveryResult.agents.length);
    // AC-6: log estructurado del retry, sin secrets.
    expect(vi.mocked(logSpy.info)).toHaveBeenCalledWith(
      expect.objectContaining({
        orchestrationId: 'wkh151-1',
        retriedWithoutCaps: true,
        firstPassCaps: 1,
        retryAgentCount: mockDiscoveryResult.agents.length,
      }),
      expect.stringContaining('discovery retry without capability filter'),
    );
  });

  // T-WKH151-2 (AC-3/CD-5): el primer discovery YA trae agentes → NO retry.
  // discover se llama 1 sola vez (cero overhead en el happy path).
  it('T-WKH151-2: first discovery has agents → no retry (1 discover call)', async () => {
    setLlmSummarizer();
    // beforeEach ya deja discover → mockDiscoveryResult (2 agentes) por default.

    const plan = await orchestrateService.planOrchestration(
      {
        goal: 'send remittance',
        budget: 5.0,
        preferCapabilities: ['remit.corridor-discovery'],
      },
      'wkh151-2',
    );

    expect(vi.mocked(discoveryService.discover)).toHaveBeenCalledTimes(1);
    expect(plan.planStatus).toBe('ready');
    // WKH-151: sin retry ⇒ marcadores en falso/null (happy path, cero overhead).
    expect(plan.broadenRetryUsed).toBe(false);
    expect(plan.retryAgentCount).toBeNull();
    // Sin retry ⇒ sin log de broaden-retry.
    expect(vi.mocked(logSpy.info)).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('discovery retry without capability filter'),
    );
  });

  // T-WKH151-3 (AC-7): preferCapabilities vacío/undefined + 1er discover vacío →
  // NO retry (el retry sería idéntico al primero) → no_agents directo, 1 discover.
  it('T-WKH151-3: no preferCapabilities + empty discovery → no retry, no_agents', async () => {
    vi.mocked(discoveryService.discover).mockResolvedValue({
      agents: [],
      total: 0,
      registries: [],
    });

    const plan = await orchestrateService.planOrchestration(
      { goal: 'nothing', budget: 5.0 },
      'wkh151-3',
    );

    // AC-7: sin caps que remover ⇒ sin retry ⇒ una sola llamada a discover.
    expect(vi.mocked(discoveryService.discover)).toHaveBeenCalledTimes(1);
    expect(plan.planStatus).toBe('no_agents');
    expect(vi.mocked(logSpy.info)).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('discovery retry without capability filter'),
    );
  });

  // T-WKH151-3b (AC-7): preferCapabilities === [] (array vacío) → tampoco reintenta
  // (`preferCapabilities?.length` es falsy) → no_agents con una sola llamada.
  it('T-WKH151-3b: empty-array preferCapabilities + empty discovery → no retry', async () => {
    vi.mocked(discoveryService.discover).mockResolvedValue({
      agents: [],
      total: 0,
      registries: [],
    });

    const plan = await orchestrateService.planOrchestration(
      { goal: 'nothing', budget: 5.0, preferCapabilities: [] },
      'wkh151-3b',
    );

    expect(vi.mocked(discoveryService.discover)).toHaveBeenCalledTimes(1);
    expect(plan.planStatus).toBe('no_agents');
  });

  // T-WKH151-4 (AC-4): 1er discover (con caps) vacío Y el retry sin caps TAMBIÉN
  // vacío → no_agents genuino (como hoy), tras exactamente 2 discover calls, sin
  // loop (CD-3).
  it('T-WKH151-4: both passes empty → genuine no_agents (2 discover calls, no loop)', async () => {
    vi.mocked(discoveryService.discover)
      .mockResolvedValueOnce({ agents: [], total: 0, registries: [] })
      .mockResolvedValueOnce({ agents: [], total: 0, registries: [] });

    const plan = await orchestrateService.planOrchestration(
      {
        goal: 'send remittance',
        budget: 5.0,
        preferCapabilities: ['remit.corridor-discovery'],
      },
      'wkh151-4',
    );

    expect(vi.mocked(discoveryService.discover)).toHaveBeenCalledTimes(2);
    expect(plan.planStatus).toBe('no_agents');
    expect(vi.mocked(eventService.track)).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'success' }),
    );
  });

  // T-WKH151-5 (AC-5/CD-4): con el fix activo (1er discover vacío → retry trae un
  // agente demo), un plan 100% demo SIGUE devolviendo no_relevant_agent sin débito.
  // El guard `allStepsAreDemos` corre igual sobre el candidate-set AMPLIADO.
  it('T-WKH151-5: broadened candidate-set all-demos → still no_relevant_agent, no debit', async () => {
    const demoAgent: Agent = {
      ...mockAgents[0]!,
      slug: 'base-demo',
      name: 'Base Demo',
      priceUsdc: 0.01,
    };
    // 1er discover (con caps) vacío → retry sin caps trae SOLO un demo.
    vi.mocked(discoveryService.discover)
      .mockResolvedValueOnce({ agents: [], total: 0, registries: [] })
      .mockResolvedValueOnce({
        agents: [demoAgent],
        total: 1,
        registries: ['wasiai'],
      });
    setLlmResponse(
      JSON.stringify({
        selectedAgents: [
          {
            slug: 'base-demo',
            registry: 'wasiai',
            input: { query: 'x' },
            reasoning: 'r',
          },
        ],
        reasoning: 'r',
      }),
    );

    const plan = await orchestrateService.planOrchestration(
      {
        goal: 'only demos after broaden',
        budget: 5.0,
        preferCapabilities: ['x'],
      },
      'wkh151-5',
    );

    // El retry ocurrió (2 calls) pero el guard demo-only siguió bloqueando.
    expect(vi.mocked(discoveryService.discover)).toHaveBeenCalledTimes(2);
    expect(plan.planStatus).toBe('no_relevant_agent');
    // planOrchestration es read-only: nunca debita (guard intacto, sin billing).
    expect(vi.mocked(budgetService.debit)).not.toHaveBeenCalled();
    // WKH-151 (telemetría additive): el evento `orchestrate_goal` del early-return
    // lleva los marcadores del retry (retry disparó y trajo 1 demo) — mide el
    // residual de MNR-1 (retry corrió pero sólo había demos).
    expect(vi.mocked(eventService.track)).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'orchestrate_goal',
        metadata: expect.objectContaining({
          reason: 'no_relevant_agent',
          broadenRetryUsed: true,
          retryAgentCount: 1,
        }),
      }),
    );
  });

  // T-EXEC-2 (AC-3/AC-5, mock side): currentCostUsdc > maxQuotedCostUsdc →
  // __quoteStale, CERO debit/compose.
  it('T-EXEC-2: cap breach → __quoteStale, zero debit/compose', async () => {
    const plan: import('../types/index.js').OrchestratePlanResult = {
      orchestrationId: 'exec-2',
      planStatus: 'ready',
      steps: [{ agent: 'summarizer-v1', registry: 'wasiai', input: { q: 1 } }],
      costPerStep: [0.5],
      totalCostUsdc: 0.5,
      protocolFeeUsdc: 0.05,
      maxQuotedCostUsdc: 0.505,
      reasoning: 'r',
      consideredAgents: [],
      plannedCostUsd: 0.5,
      feeUsdc: 0.05,
      usedFallback: false,
      debitFallback: false,
      billingKeyRow: masterKeyRow(),
      discoveredAgents: [],
    };

    // El cap aprobado por el cliente es absurdamente bajo → drift detectado.
    const res = await orchestrateService.executeApprovedPlan(
      {
        goal: '',
        budget: 5.0,
        chainId: 2368,
        scopingKeyRow: masterKeyRow(),
        maxQuotedCostUsdc: 0.0001,
      },
      plan,
      'exec-2',
    );

    expect('__quoteStale' in res).toBe(true);
    if ('__quoteStale' in res) {
      expect(res.maxQuotedCostUsdc).toBe(0.0001);
      expect(res.currentCostUsdc).toBeGreaterThan(0.0001);
    }
    // CD-NEW-3: gate corre ANTES de cualquier débito o compose.
    expect(vi.mocked(budgetService.debit)).not.toHaveBeenCalled();
    expect(vi.mocked(composeService.compose)).not.toHaveBeenCalled();
  });

  // ─── WKH-114: plan-time acceptance criteria (AC-1/AC-7, CD-2/CD-3) ────

  // Test 15 (AC-1): el planner LLM adjunta AC no-vacíos por step.
  it('WKH-114: llmPlan attaches non-empty acceptanceCriteria per step (AC-1)', async () => {
    setLlmResponse(
      JSON.stringify({
        selectedAgents: [
          {
            slug: 'summarizer-v1',
            registry: 'wasiai',
            input: { q: 'x' },
            acceptanceCriteria: [
              'output contains a summary',
              'non-empty summary field',
            ],
            reasoning: 'ok',
          },
        ],
        reasoning: 'ok',
      }),
    );

    await orchestrateService.orchestrate(
      { goal: 'summarize text', budget: 5.0 },
      'orch-114-15',
    );

    const composeCall = vi.mocked(composeService.compose).mock.calls[0]![0]!;
    const step = composeCall.steps[0]!;
    expect(step.acceptanceCriteria).toBeDefined();
    expect(step.acceptanceCriteria!.length).toBeGreaterThan(0);
    expect(step.acceptanceCriteria).toContain('output contains a summary');
  });

  // Test 16 (AC-1): el greedy fallback (sin LLM) adjunta AC genéricos no-vacíos.
  it('WKH-114: greedy fallback attaches generic acceptanceCriteria (AC-1)', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    await orchestrateService.orchestrate(
      { goal: 'summarize text no key', budget: 5.0 },
      'orch-114-16',
    );

    const composeCall = vi.mocked(composeService.compose).mock.calls[0]![0]!;
    expect(composeCall.steps.length).toBeGreaterThan(0);
    for (const step of composeCall.steps) {
      expect(step.acceptanceCriteria).toBeDefined();
      expect(step.acceptanceCriteria!.length).toBeGreaterThan(0);
    }
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // Test 17 (AC-4/AC-6/CD-3): additive-only — el exact-match del fee y el shape
  // de pipeline.success NO cambian (regresión :557).
  it('WKH-114: chargeProtocolFee exact-match params unchanged (CD-3 regression)', async () => {
    vi.mocked(getProtocolFeeRate).mockReturnValue(0.01);
    vi.mocked(chargeProtocolFee).mockResolvedValueOnce({
      status: 'charged',
      feeUsdc: 0.01,
      txHash: '0xFEE',
    });
    setLlmOneAgent();

    const result = await orchestrateService.orchestrate(
      { goal: 'happy path', budget: 1.0 },
      'orch-114-17',
    );

    expect(vi.mocked(chargeProtocolFee)).toHaveBeenCalledWith({
      orchestrationId: 'orch-114-17',
      feeBaseUsdc: 0.5,
      feeRate: 0.01,
    });
    expect(result.answer).toBeDefined();
  });

  // Test 18 (AC-7/CD-2): los AC viajan en el ÚNICO call del planner, con
  // model/max_tokens de los getters centralizados (cero hardcode, cero LLM extra).
  it('WKH-114: AC ride the existing planner call via centralized model getters (AC-7/CD-2)', async () => {
    setLlmOneAgent();

    await orchestrateService.orchestrate(
      { goal: 'summarize text', budget: 5.0 },
      'orch-114-18',
    );

    expect(mockCreate).toHaveBeenCalledTimes(1); // cero LLM extra por los AC
    const callArgs = mockCreate.mock.calls[0]![0] as {
      model: string;
      max_tokens: number;
      system: string;
    };
    expect(callArgs.model).toBe(getPlannerModel());
    expect(callArgs.max_tokens).toBe(getPlannerMaxTokens());
    expect(callArgs.system).toContain('acceptanceCriteria');
  });
});
