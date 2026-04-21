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

import { composeService } from './compose.js';
import { discoveryService } from './discovery.js';
import { eventService } from './event.js';
import {
  chargeProtocolFee,
  getProtocolFeeRate,
  ProtocolFeeError,
} from './fee-charge.js';
import { orchestrateService } from './orchestrate.js';

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
});
