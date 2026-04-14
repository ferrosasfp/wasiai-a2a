/**
 * discover_agents Tests — AC-7, AC-8.
 *
 * Mock of discoveryService.discover MUST return a complete `DiscoveryResult`
 * including `registries: string[]` (CD-9 / AB-035 #1).
 */

import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveryResult } from '../../types/index.js';
import { MCPToolError, type ToolContext } from '../types.js';

const mockDiscover = vi.fn();
vi.mock('../../services/discovery.js', () => ({
  discoveryService: {
    discover: (...args: unknown[]) => mockDiscover(...args),
    getAgent: vi.fn(),
  },
}));

import { discoverAgents } from './discover-agents.js';

const ctx: ToolContext = {
  requestId: 'req-1',
  tokenPrefix: 'abcd1234',
  log: pino({ level: 'silent' }),
};

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  mockDiscover.mockReset();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('discoverAgents', () => {
  it('AC-7: forwards query/capabilities/maxPrice/limit=20 to discoveryService and returns DiscoveryResult', async () => {
    const fullResult: DiscoveryResult = {
      agents: [],
      total: 0,
      registries: [], // CD-9: always include registries (even empty)
    };
    mockDiscover.mockResolvedValueOnce(fullResult);

    const out = await discoverAgents(
      { query: 'weather', maxPrice: 5, capabilities: ['forecast'] },
      ctx,
    );

    expect(mockDiscover).toHaveBeenCalledWith({
      query: 'weather',
      capabilities: ['forecast'],
      maxPrice: 5,
      limit: 20,
    });
    expect(out).toBe(fullResult);
    expect(out.registries).toBeDefined();
  });

  it('AC-7: respects user-supplied limit when provided', async () => {
    mockDiscover.mockResolvedValueOnce({
      agents: [],
      total: 0,
      registries: [],
    });
    await discoverAgents({ limit: 7 }, ctx);
    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 7 }),
    );
  });

  it('AC-8: discoveryService that never resolves triggers timeout via TIMEOUT_ORCHESTRATE_MS', async () => {
    process.env.TIMEOUT_ORCHESTRATE_MS = '50';
    // Never resolve — only the timeout can win the race.
    mockDiscover.mockImplementationOnce(() => new Promise(() => undefined));

    const start = Date.now();
    let caught: unknown;
    try {
      await discoverAgents({ query: 'x' }, ctx);
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - start;
    expect(caught).toBeInstanceOf(MCPToolError);
    const err = caught as MCPToolError;
    expect(err.code).toBe(-32001);
    expect(err.message).toMatch(/timeout/i);
    expect(elapsed).toBeLessThan(500);
  });
});
