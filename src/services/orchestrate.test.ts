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
import { orchestrateService } from './orchestrate.js';
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
      { goal: 'test fallback', budget: 5.0 },
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
      { goal: 'test circuit open', budget: 5.0 },
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
      { goal: 'malformed test', budget: 5.0 },
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
      { goal: 'all invalid slugs', budget: 5.0 },
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
      { goal: 'no key test', budget: 5.0 },
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
      budgetUsdc: 0.5,
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

  // T-AC-DOUBLE (CD-11/§4.4): single orchestrate on total failure → credit exactly once.
  it('T-AC-DOUBLE: total failure refunds exactly once (no double refund)', async () => {
    vi.mocked(discoveryService.discover).mockResolvedValue(wkh127Discovery);
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
    // WKH-132: fee residual = maxQuoted − total (cost-based), NO budget * rate.
    // summarizer-v1 (0.5) → maxQuoted 0.505 − total 0.5 = 0.005.
    expect(plan.protocolFeeUsdc).toBeCloseTo(
      plan.maxQuotedCostUsdc - plan.totalCostUsdc,
      6,
    );
    expect(plan.protocolFeeUsdc).toBeCloseTo(0.005, 6);
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
  // AC-1/AC-2/AC-9: el protocolFeeUsdc del plan 'ready' es el RESIDUAL del quote
  // sobre el costo real (maxQuotedCostUsdc − totalCostUsdc), independiente del
  // budget declarado. getAgent se mockea POR SLUG (CD-13) para que cada step
  // resuelva su precio real; _resetAgentPriceCache ya corre en beforeEach (CD-14).

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

  // AC-1: plan ready → protocolFeeUsdc = residual del quote sobre el costo REAL.
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
    // fee == residual (maxQuoted − total), NUNCA budget * rate.
    const residual = Number(
      Math.max(0, plan.maxQuotedCostUsdc - plan.totalCostUsdc).toFixed(6),
    );
    expect(plan.protocolFeeUsdc).toBeCloseTo(residual, 6);
    expect(plan.protocolFeeUsdc).toBeCloseTo(0.00061, 6);
    // El código viejo (budget * rate = 1.0 * 0.01 = 0.01) quedaría muy por encima.
    expect(plan.protocolFeeUsdc).not.toBeCloseTo(1.0 * 0.01, 4);
  });

  // AC-2: maxQuoted == total + fee por construcción (varios pipelines).
  it('AC-2: maxQuoted == total + fee across pipelines (incl. placeholder)', async () => {
    // Caso A: 1 step 0.02.
    setPipeline([priceAgent('a1', 0.02)]);
    const pA = await orchestrateService.planOrchestration(
      { goal: 'g', budget: 1.0 },
      'ac2-a',
    );
    expect(pA.planStatus).toBe('ready');
    expect(
      Math.abs(pA.maxQuotedCostUsdc - (pA.totalCostUsdc + pA.protocolFeeUsdc)),
    ).toBeLessThanOrEqual(1e-6);

    // Caso B: 3 steps 0.061.
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
    expect(
      Math.abs(pB.maxQuotedCostUsdc - (pB.totalCostUsdc + pB.protocolFeeUsdc)),
    ).toBeLessThanOrEqual(1e-6);

    // Caso C: step precio 0 → placeholder en el quote, total 0. Invariante igual.
    setPipeline([priceAgent('c1', 0)]);
    const pC = await orchestrateService.planOrchestration(
      { goal: 'g', budget: 5.0 },
      'ac2-c',
    );
    expect(pC.planStatus).toBe('ready');
    expect(pC.totalCostUsdc).toBe(0);
    expect(
      Math.abs(pC.maxQuotedCostUsdc - (pC.totalCostUsdc + pC.protocolFeeUsdc)),
    ).toBeLessThanOrEqual(1e-6);
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
  // (plan.feeUsdc) DEBE ser cost-based (totalCostUsdc * feeRate), NO el residual
  // del quote. Con un agente priceUsdc=0 el residual se infla a ~1.01 (placeholder
  // PLACEHOLDER_FEE_USD) mientras el costo real es 0 → si feeUsdc == residual,
  // maxBudget = budget − 1.01 puede ser NEGATIVO → compose "Budget exceeded" y una
  // orquestación atómica que antes funcionaba falla. El fix desacopla la reserva
  // (feeUsdc, cost-based, == /execute routes/orchestrate.ts:355) del valor REPORTADO
  // (protocolFeeUsdc, residual, CD-8/CD-9). Nota: compose está mockeado en esta
  // suite, por lo que se asertan directamente los campos del plan que alimentan
  // maxBudget — la causa raíz (feeUsdc == residual) se pinnea sin des-mockear compose.
  it('BLQ-BAJO-1: free agent (price 0) → feeUsdc reserve is cost-based (0), NOT residual', async () => {
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
    // El valor REPORTADO sigue siendo el residual (~1.01: placeholder * (1+rate)),
    // inmutable (CD-8, caller-favorable). El desacople queda pinneado.
    expect(plan.protocolFeeUsdc).toBeCloseTo(1.01, 6);
    // Regresión: si feeUsdc quedara igual al residual, maxBudget = 1.0 − 1.01 < 0.
    expect(plan.feeUsdc).not.toBeCloseTo(plan.protocolFeeUsdc, 4);
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
});
