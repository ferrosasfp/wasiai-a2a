/**
 * Tests for Orchestrate Service — LLM Planning + Fallback
 *
 * 10 tests: T-1 through T-10
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, ComposeResult, DiscoveryResult } from '../types/index.js';

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

vi.mock('./discovery.js', () => ({
  discoveryService: {
    discover: vi.fn(),
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

import { budgetService } from './budget.js';
import { composeService } from './compose.js';
import { discoveryService } from './discovery.js';
import { eventService } from './event.js';
import {
  chargeProtocolFee,
  getProtocolFeeRate,
  ProtocolFeeError,
} from './fee-charge.js';
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
      agent: mockAgents[0],
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
    process.env.ANTHROPIC_API_KEY = 'test-key';
    vi.mocked(discoveryService.discover).mockResolvedValue(mockDiscoveryResult);
    vi.mocked(composeService.compose).mockResolvedValue(mockComposeResult);
    // WKH-127: re-aplicar defaults del budget mock (clearAllMocks los borra).
    vi.mocked(budgetService.debit).mockResolvedValue({ success: true });
    vi.mocked(budgetService.credit).mockResolvedValue({ success: true });
    vi.mocked(budgetService.getBalance).mockResolvedValue('100');
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
    const composeCall = vi.mocked(composeService.compose).mock.calls[0][0];
    expect(composeCall.steps[0].input).toHaveProperty('query');
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
    // WKH-44: fee ahora se calcula sobre el budget (5.0), no sobre el
    // totalCostUsdc del pipeline. Budget 5.0 * 0.01 = 0.05.
    expect(result.protocolFeeUsdc).toBeCloseTo(5.0 * 0.01, 6);
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
    const composeCall = vi.mocked(composeService.compose).mock.calls[0][0];
    expect(composeCall.steps).toHaveLength(1);
    expect(composeCall.steps[0].agent).toBe('summarizer-v1');
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

  // T-7: protocolFeeUsdc = budget * 0.01
  // WKH-44: semántica cambiada — antes era totalCostUsdc * 0.01, ahora
  // es budget * rate (el fee se calcula UP-FRONT sobre el budget).
  it('T-7: protocolFeeUsdc is 1% of budget', async () => {
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

    // WKH-44: budget 20 * 0.01 = 0.2 (antes era 0.1 sobre totalCost=10)
    expect(result.protocolFeeUsdc).toBeCloseTo(0.2, 6);
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

    const composeCall = vi.mocked(composeService.compose).mock.calls[0][0];
    // budget 1.0 - fee 0.01 = 0.99
    expect(composeCall.maxBudget).toBeCloseTo(0.99, 6);
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
    expect(vi.mocked(chargeProtocolFee)).toHaveBeenCalledWith({
      orchestrationId: 'orch-12',
      budgetUsdc: 1.0,
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
    expect(result.protocolFeeUsdc).toBeCloseTo(0.01, 6);
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

  // T-16 (AC-7): throws ProtocolFeeError when feeUsdc > budget (before discovery)
  it('T-16: throws ProtocolFeeError 400 when feeUsdc > budget', async () => {
    vi.mocked(getProtocolFeeRate).mockReturnValue(1.5); // corrupt rate

    await expect(
      orchestrateService.orchestrate(
        { goal: 'broken rate', budget: 1.0 },
        'orch-16',
      ),
    ).rejects.toBeInstanceOf(ProtocolFeeError);

    // Discovery NOT called — safety guard aborts early.
    expect(vi.mocked(discoveryService.discover)).not.toHaveBeenCalled();
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

  // T-18 (AC-10): rate change reflected in next orchestrate call (no cache)
  it('T-18: PROTOCOL_FEE_RATE change reflected in next call', async () => {
    vi.mocked(getProtocolFeeRate).mockReturnValueOnce(0.01);
    setLlmOneAgent();
    const r1 = await orchestrateService.orchestrate(
      { goal: 'first rate', budget: 1.0 },
      'orch-18a',
    );
    expect(r1.protocolFeeUsdc).toBeCloseTo(0.01, 6);

    vi.mocked(getProtocolFeeRate).mockReturnValueOnce(0.02);
    setLlmOneAgent();
    const r2 = await orchestrateService.orchestrate(
      { goal: 'second rate', budget: 1.0 },
      'orch-18b',
    );
    expect(r2.protocolFeeUsdc).toBeCloseTo(0.02, 6);
  });

  // T-19 (AC-9): fee calculated with default 0.01 when env unset
  it('T-19: fee uses default 0.01 when rate unset', async () => {
    vi.mocked(getProtocolFeeRate).mockReturnValue(0.01); // sim default
    setLlmOneAgent();

    const result = await orchestrateService.orchestrate(
      { goal: 'default rate', budget: 10.0 },
      'orch-19',
    );

    expect(result.protocolFeeUsdc).toBeCloseTo(0.1, 6);
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

    const composeCall = vi.mocked(composeService.compose).mock.calls[0][0];
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

    const composeCall = vi.mocked(composeService.compose).mock.calls[0][0];
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

    const composeCall = vi.mocked(composeService.compose).mock.calls[0][0];
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

    const composeCall = vi.mocked(composeService.compose).mock.calls[0][0];
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
    { ...mockAgents[0], slug: 'summarizer-v1', priceUsdc: 0.3 },
    { ...mockAgents[1], slug: 'translator-v1', priceUsdc: 0.2 },
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
    const debitCall = vi.mocked(budgetService.debit).mock.calls[0];
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

    const debitCall = vi.mocked(budgetService.debit).mock.calls[0];
    // precio del step-0 (summarizer-v1) = 0.30
    expect(debitCall[2]).toBeCloseTo(0.3, 6);
  });

  // T-AC4 (AC-4): plan all priceUsdc===0 → debit with 1.0 + debitFallback flag + warn.
  it('T-AC4: zero-cost plan applies $1 fallback and sets debitFallback', async () => {
    const zeroPriceDiscovery: DiscoveryResult = {
      agents: [
        { ...mockAgents[0], slug: 'summarizer-v1', priceUsdc: 0 },
        { ...mockAgents[1], slug: 'translator-v1', priceUsdc: 0 },
      ],
      total: 2,
      registries: ['wasiai'],
    };
    vi.mocked(discoveryService.discover).mockResolvedValue(zeroPriceDiscovery);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
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

    const debitCall = vi.mocked(budgetService.debit).mock.calls[0];
    expect(debitCall[2]).toBe(1.0);
    expect(result.debitFallback).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      '[orchestrate.price.fallback]',
      expect.objectContaining({ reason: 'registry-miss' }),
    );
    warnSpy.mockRestore();
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
    const creditCall = vi.mocked(budgetService.credit).mock.calls[0];
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
    const creditCall = vi.mocked(budgetService.credit).mock.calls[0];
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
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
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
    expect(errorSpy).toHaveBeenCalledWith(
      '[orchestrate.refund-failed]',
      expect.objectContaining({
        keyId: 'master-key-1',
        chainId: 2368,
        // BLQ-ALTO-1: refund = debitedUsd = precio del step-0 = 0.30.
        amountUsd: 0.3,
        orchestrationId: 'orch-ac8',
      }),
    );
    errorSpy.mockRestore();
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
});
