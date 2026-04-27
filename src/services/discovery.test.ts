/**
 * Tests for Discovery Service — verified + status filters (WKH-DISCOVER-VERIFIED)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegistryConfig } from '../types/index.js';

// Mock registry service
vi.mock('./registry.js', () => ({
  registryService: {
    getEnabled: vi.fn(),
    get: vi.fn(),
  },
}));

// Mock circuit breaker
vi.mock('../lib/circuit-breaker.js', () => ({
  getRegistryCircuitBreaker: () => ({
    execute: (fn: () => Promise<Response>) => fn(),
  }),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { discoveryService, parsePriceSafe } from './discovery.js';
import { registryService } from './registry.js';

function makeRegistry(o: Partial<RegistryConfig> = {}): RegistryConfig {
  return {
    id: 'reg-1',
    name: 'test-registry',
    discoveryEndpoint: 'https://example.com/agents',
    invokeEndpoint: 'https://example.com/invoke/{slug}',
    schema: { discovery: {}, invoke: { method: 'POST' } },
    enabled: true,
    createdAt: new Date(),
    ...o,
  };
}

function makeRawAgent(
  o: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    slug: 'test-agent',
    description: 'A test agent',
    capabilities: ['test'],
    price: 0,
    reputation: 80,
    ...o,
  };
}

function setupRegistryResponse(rawAgents: Record<string, unknown>[]) {
  vi.mocked(registryService.getEnabled).mockResolvedValue([makeRegistry()]);
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(rawAgents),
  });
}

describe('discoveryService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('AC-10: default status=active filter', () => {
    it('returns only active agents by default', async () => {
      setupRegistryResponse([
        makeRawAgent({ id: 'a1', slug: 'active-1', status: 'active' }),
        makeRawAgent({ id: 'a2', slug: 'inactive-1', status: 'inactive' }),
        makeRawAgent({
          id: 'a3',
          slug: 'unreachable-1',
          status: 'unreachable',
        }),
      ]);

      const result = await discoveryService.discover({});

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].slug).toBe('active-1');
      expect(result.agents[0].status).toBe('active');
    });
  });

  describe('AC-2: includeInactive bypasses status filter', () => {
    it('returns all agents when includeInactive=true', async () => {
      setupRegistryResponse([
        makeRawAgent({ id: 'a1', slug: 'active-1', status: 'active' }),
        makeRawAgent({ id: 'a2', slug: 'inactive-1', status: 'inactive' }),
      ]);

      const result = await discoveryService.discover({ includeInactive: true });

      expect(result.agents).toHaveLength(2);
    });
  });

  describe('AC-3: verified filter', () => {
    it('returns only verified agents when verified=true', async () => {
      setupRegistryResponse([
        makeRawAgent({ id: 'a1', slug: 'verified-1', verified: true }),
        makeRawAgent({ id: 'a2', slug: 'unverified-1', verified: false }),
      ]);

      const result = await discoveryService.discover({ verified: true });

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].slug).toBe('verified-1');
      expect(result.agents[0].verified).toBe(true);
    });
  });

  describe('AC-5 + AC-6: mapAgent defaults', () => {
    it('defaults verified to false and status to active when absent', async () => {
      setupRegistryResponse([makeRawAgent({ id: 'a1', slug: 'bare-agent' })]);

      const result = await discoveryService.discover({});

      expect(result.agents[0].verified).toBe(false);
      expect(result.agents[0].status).toBe('active');
    });
  });

  describe('AC-7: verified-first sort tiebreaker', () => {
    it('ranks verified agents above non-verified with same reputation', async () => {
      setupRegistryResponse([
        makeRawAgent({
          id: 'a1',
          slug: 'unverified',
          verified: false,
          reputation: 90,
        }),
        makeRawAgent({
          id: 'a2',
          slug: 'verified',
          verified: true,
          reputation: 90,
        }),
      ]);

      const result = await discoveryService.discover({});

      expect(result.agents[0].slug).toBe('verified');
      expect(result.agents[1].slug).toBe('unverified');
    });
  });

  describe('WKH-55 AC-7: mapAgent propagates raw.payment to agent.payment', () => {
    it('mapAgent maps raw.payment to agent.payment when present and valid', () => {
      const registry = makeRegistry();
      const raw = {
        id: '1',
        slug: 'agent-1',
        name: 'A1',
        description: 'd',
        capabilities: ['x'],
        price: 0.5,
        status: 'active',
        payment: {
          method: 'x402',
          asset: 'USDC',
          chain: 'avalanche',
          contract: '0x000000000000000000000000000000000000aBcD',
        },
      };
      const agent = discoveryService.mapAgent(registry, raw);
      expect(agent.payment).toEqual({
        method: 'x402',
        asset: 'USDC',
        chain: 'avalanche',
        contract: '0x000000000000000000000000000000000000aBcD',
      });
    });

    it('mapAgent leaves agent.payment undefined when raw.payment is absent', () => {
      const registry = makeRegistry();
      const raw = {
        id: '1',
        slug: 'agent-1',
        name: 'A1',
        description: 'd',
        capabilities: ['x'],
        price: 0.5,
        status: 'active',
      };
      const agent = discoveryService.mapAgent(registry, raw);
      expect(agent.payment).toBeUndefined();
    });
  });

  describe('AC-9: verified + includeInactive combine with AND logic', () => {
    it('returns only verified agents of all statuses', async () => {
      setupRegistryResponse([
        makeRawAgent({
          id: 'a1',
          slug: 'active-verified',
          status: 'active',
          verified: true,
        }),
        makeRawAgent({
          id: 'a2',
          slug: 'inactive-verified',
          status: 'inactive',
          verified: true,
        }),
        makeRawAgent({
          id: 'a3',
          slug: 'active-unverified',
          status: 'active',
          verified: false,
        }),
        makeRawAgent({
          id: 'a4',
          slug: 'inactive-unverified',
          status: 'inactive',
          verified: false,
        }),
      ]);

      const result = await discoveryService.discover({
        verified: true,
        includeInactive: true,
      });

      expect(result.agents).toHaveLength(2);
      expect(result.agents.every((a) => a.verified)).toBe(true);
      expect(result.agents.map((a) => a.slug).sort()).toEqual([
        'active-verified',
        'inactive-verified',
      ]);
    });
  });
});

describe('parsePriceSafe (W0 — WAS-V2-3-CLIENT helper)', () => {
  it('T-PARSE-1: number passthrough returns finite positive', () => {
    expect(parsePriceSafe(0.05)).toBe(0.05);
  });
  it('T-PARSE-2: parseable string returns parsed number', () => {
    expect(parsePriceSafe('0.05')).toBe(0.05);
  });
  it('T-PARSE-3: non-parseable string returns 0', () => {
    expect(parsePriceSafe('free')).toBe(0);
    expect(parsePriceSafe('N/A')).toBe(0);
  });
  it('T-PARSE-4: null/undefined return 0', () => {
    expect(parsePriceSafe(null)).toBe(0);
    expect(parsePriceSafe(undefined)).toBe(0);
  });
  it('T-PARSE-5: negative/NaN/Infinity return 0 (CD-7 safe floor)', () => {
    expect(parsePriceSafe(-1.0)).toBe(0);
    expect(parsePriceSafe(Number.NaN)).toBe(0);
    expect(parsePriceSafe(Number.POSITIVE_INFINITY)).toBe(0);
    expect(parsePriceSafe(Number.NEGATIVE_INFINITY)).toBe(0);
  });
  it('T-PARSE-6: empty string returns 0 (AB-WKH-53-#3 edge)', () => {
    expect(parsePriceSafe('')).toBe(0);
  });
});
