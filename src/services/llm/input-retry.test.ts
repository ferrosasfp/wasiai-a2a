/**
 * Tests for regenerateInputFromErrors — WKH-130 (W2).
 * Anthropic SDK + circuit-breaker mocked. Covers T-LLM-1..4.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  // biome-ignore lint/complexity/useArrowFunction: must use function() for new-able mock constructor
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }),
}));

// Pass-through circuit breaker by default; tests override execute() to simulate
// CircuitOpenError without depending on the real breaker's internal state.
// `vi.hoisted` keeps these defined before the hoisted vi.mock factory runs.
const { mockExecute, CircuitOpenError } = vi.hoisted(() => {
  class CircuitOpenError extends Error {
    readonly code = 'CIRCUIT_OPEN' as const;
    constructor(name: string) {
      super(`Circuit breaker "${name}" is open`);
      this.name = 'CircuitOpenError';
    }
  }
  const mockExecute = vi.fn(
    async (fn: () => Promise<unknown>): Promise<unknown> => fn(),
  );
  return { mockExecute, CircuitOpenError };
});
vi.mock('../../lib/circuit-breaker.js', () => ({
  anthropicCircuitBreaker: { execute: mockExecute },
  CircuitOpenError,
}));

import { regenerateInputFromErrors } from './input-retry.js';

function setLLMText(text: string) {
  mockCreate.mockResolvedValueOnce({
    content: [{ type: 'text', text }],
  });
}

const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  mockExecute.mockImplementation(
    async (fn: () => Promise<unknown>): Promise<unknown> => fn(),
  );
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
});

describe('regenerateInputFromErrors', () => {
  // T-LLM-1: valid 2xx JSON object → returns the corrected Record.
  it('T-LLM-1: returns corrected object with the missing fields', async () => {
    setLLMText(
      JSON.stringify({ query: 'hi', senderName: 'Ana', amountUSD: 100 }),
    );
    const result = await regenerateInputFromErrors(
      { query: 'hi' },
      ['senderName', 'amountUSD'],
      'agentshop-remit',
      'remittance agent',
    );
    expect(result).toEqual({ query: 'hi', senderName: 'Ana', amountUSD: 100 });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    // Haiku hardcoded.
    expect(mockCreate.mock.calls[0][0].model).toBe('claude-haiku-4-5-20251001');
  });

  // T-LLM-2: non-object responses → null.
  describe('T-LLM-2: non-object JSON → null', () => {
    it('non-JSON text → null', async () => {
      setLLMText('not json at all');
      const result = await regenerateInputFromErrors({ a: 1 }, ['b'], 'foo');
      expect(result).toBeNull();
    });

    it('JSON array → null', async () => {
      setLLMText('[1,2,3]');
      const result = await regenerateInputFromErrors({ a: 1 }, ['b'], 'foo');
      expect(result).toBeNull();
    });

    it('JSON primitive → null', async () => {
      setLLMText('42');
      const result = await regenerateInputFromErrors({ a: 1 }, ['b'], 'foo');
      expect(result).toBeNull();
    });

    it('empty text → null', async () => {
      setLLMText('');
      const result = await regenerateInputFromErrors({ a: 1 }, ['b'], 'foo');
      expect(result).toBeNull();
    });
  });

  // T-LLM-3: no API key OR empty missingFields → null, 0 SDK calls.
  it('T-LLM-3: missing ANTHROPIC_API_KEY → null, 0 SDK calls', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await regenerateInputFromErrors({ a: 1 }, ['b'], 'foo');
    expect(result).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('T-LLM-3b: empty missingFields → null, 0 SDK calls', async () => {
    const result = await regenerateInputFromErrors({ a: 1 }, [], 'foo');
    expect(result).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // T-LLM-4: circuit open / timeout / API error → null, no throw.
  describe('T-LLM-4: breaker/timeout/API error → null, no throw', () => {
    it('CircuitOpenError → null', async () => {
      mockExecute.mockRejectedValueOnce(new CircuitOpenError('anthropic'));
      const result = await regenerateInputFromErrors({ a: 1 }, ['b'], 'foo');
      expect(result).toBeNull();
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('API error → null', async () => {
      mockCreate.mockRejectedValueOnce(new Error('API rate limit exceeded'));
      const result = await regenerateInputFromErrors({ a: 1 }, ['b'], 'foo');
      expect(result).toBeNull();
    });
  });
});
