/**
 * orchestrate Tool Tests — AC-9, AC-10.
 */

import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, OrchestrateResult } from '../../types/index.js';
import type { ToolContext } from '../types.js';

const mockOrchestrate = vi.fn();
vi.mock('../../services/orchestrate.js', () => ({
  orchestrateService: {
    orchestrate: (...args: unknown[]) => mockOrchestrate(...args),
  },
}));

import { orchestrate as orchestrateTool } from './orchestrate.js';

const ctx: ToolContext = {
  requestId: 'req-1',
  tokenPrefix: 'abcd1234',
  log: pino({ level: 'silent' }),
};

function makeAgent(slug: string): Agent {
  return {
    id: `${slug}-id`,
    name: slug,
    slug,
    description: '',
    capabilities: [],
    priceUsdc: 1,
    registry: 'reg',
    invokeUrl: 'https://x',
    invocationNote: '',
    verified: true,
    status: 'active',
  };
}

beforeEach(() => {
  mockOrchestrate.mockReset();
});

describe('orchestrate tool', () => {
  it('AC-9: happy path returns orchestrationId + steps + result + reasoning + protocolFeeUsdc', async () => {
    const result: OrchestrateResult = {
      orchestrationId: 'service-id-ignored',
      answer: { summary: 'done' },
      reasoning: 'selected agents A+B',
      pipeline: {
        success: true,
        output: { summary: 'done' },
        steps: [
          {
            agent: makeAgent('a'),
            output: 'x',
            costUsdc: 1,
            latencyMs: 50,
          },
          {
            agent: makeAgent('b'),
            output: 'y',
            costUsdc: 1,
            latencyMs: 60,
          },
        ],
        totalCostUsdc: 2,
        totalLatencyMs: 110,
      },
      consideredAgents: [],
      protocolFeeUsdc: 0.02,
      attestationTxHash: '0xatt',
    };
    mockOrchestrate.mockResolvedValueOnce(result);

    const out = await orchestrateTool({ goal: 'make pizza', budget: 10 }, ctx);

    // Tool generates its own orchestrationId; we don't care about the exact
    // value, just that it is a string.
    expect(typeof out.orchestrationId).toBe('string');
    expect(out.orchestrationId.length).toBeGreaterThan(0);
    expect(out.steps).toHaveLength(2);
    // BLQ-3: each step carries the full per-step payload from the pipeline,
    // not an empty `ComposeStep`.
    expect(out.steps[0]).toEqual({
      agent: 'a',
      registry: 'reg',
      output: 'x',
      costUsdc: 1,
      latencyMs: 50,
      txHash: undefined,
    });
    expect(out.steps[1]).toEqual({
      agent: 'b',
      registry: 'reg',
      output: 'y',
      costUsdc: 1,
      latencyMs: 60,
      txHash: undefined,
    });
    expect(out.result).toEqual({ summary: 'done' });
    expect(out.kiteTxHash).toBe('0xatt');
    expect(out.reasoning).toBe('selected agents A+B');
    expect(out.protocolFeeUsdc).toBe(0.02);
  });

  it('BLQ-3: step txHash is propagated when present in the pipeline step', async () => {
    const result: OrchestrateResult = {
      orchestrationId: 'x',
      answer: null,
      reasoning: '',
      pipeline: {
        success: true,
        output: null,
        steps: [
          {
            agent: makeAgent('paid'),
            output: 'ok',
            costUsdc: 2,
            latencyMs: 100,
            txHash: '0xdeadbeef',
          },
        ],
        totalCostUsdc: 2,
        totalLatencyMs: 100,
      },
      consideredAgents: [],
      protocolFeeUsdc: 0,
    };
    mockOrchestrate.mockResolvedValueOnce(result);

    const out = await orchestrateTool({ goal: 'g', budget: 5 }, ctx);
    expect(out.steps[0].txHash).toBe('0xdeadbeef');
    expect(out.steps[0].costUsdc).toBe(2);
    expect(out.steps[0].latencyMs).toBe(100);
    expect(out.steps[0].output).toBe('ok');
  });

  it('AC-10: a2aKey is propagated to orchestrateService.orchestrate', async () => {
    const result: OrchestrateResult = {
      orchestrationId: 'x',
      answer: null,
      reasoning: '',
      pipeline: {
        success: true,
        output: null,
        steps: [],
        totalCostUsdc: 0,
        totalLatencyMs: 0,
      },
      consideredAgents: [],
      protocolFeeUsdc: 0,
    };
    mockOrchestrate.mockResolvedValueOnce(result);

    await orchestrateTool(
      {
        goal: 'g',
        budget: 5,
        a2aKey: 'wasi_a2a_test_key_value',
      },
      ctx,
    );

    expect(mockOrchestrate).toHaveBeenCalledWith(
      expect.objectContaining({
        goal: 'g',
        budget: 5,
        a2aKey: 'wasi_a2a_test_key_value',
      }),
      expect.any(String),
    );
  });
});
