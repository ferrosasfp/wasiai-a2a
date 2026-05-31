/**
 * Discovery Service — Runtime SSRF Guard Tests (WKH-62 W1).
 *
 * Verifies that `discoveryService.queryRegistry` and `discoveryService.discover`
 * reject SSRF attempts BEFORE invoking `fetch()`. Replicates the test scaffold
 * of `src/services/discovery.test.ts` (CD-A2: vi.mock for node:dns,
 * registry.js, circuit-breaker.js + vi.stubGlobal for fetch).
 *
 * Coverage matrix (T-DISC-01..T-DISC-06):
 *   01  queryRegistry rejects 169.254.169.254 → SSRFViolationError, no fetch
 *   02  queryRegistry positive: public host  → fetch called, agents returned
 *   03  discover() resilience: SSRF in one registry → other registry still
 *       returns its agents (catch in discover absorbs the throw)
 *   04  queryRegistry rejects file:// scheme  → SSRFViolationError, no fetch
 *   05  queryRegistry rejects ::ffff:169.254.169.254 (DT-B vector) → no fetch
 *   06  DISCOVERY_SSRF_ALLOWLIST allows internal host → fetch IS called
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegistryConfig } from '../types/index.js';

// ── Mocks (must be set BEFORE importing the module under test) ─────

const mockLookup = vi.fn();
vi.mock('node:dns', () => ({
  promises: {
    lookup: (...args: unknown[]) => mockLookup(...args),
  },
}));

vi.mock('./registry.js', () => ({
  registryService: {
    getEnabled: vi.fn(),
    get: vi.fn(),
  },
}));

// WKH-100: discover()/getAgent() now reverse-lookup ERC-8004 identity. Mock it
// so the SSRF tests don't hit supabase (which would trigger an extra fetch).
vi.mock('./identity.js', () => ({
  identityService: {
    resolveIdentityForSlug: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../lib/circuit-breaker.js', () => ({
  getRegistryCircuitBreaker: () => ({
    execute: (fn: () => Promise<Response>) => fn(),
  }),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { SSRFViolationError } from '../lib/url-validator.js';
import { discoveryService } from './discovery.js';
import { registryService } from './registry.js';

const ORIGINAL_ENV = { ...process.env };

function makeRegistry(o: Partial<RegistryConfig> = {}): RegistryConfig {
  return {
    id: 'reg-1',
    name: 'test-registry',
    discoveryEndpoint: 'https://example.com/agents',
    invokeEndpoint: 'https://example.com/invoke/{slug}',
    schema: { discovery: {}, invoke: { method: 'POST' } },
    enabled: true,
    createdAt: new Date(),
    ownerRef: 'system',
    ...o,
  };
}

beforeEach(() => {
  mockLookup.mockReset();
  mockFetch.mockReset();
  vi.clearAllMocks();
  delete process.env.DISCOVERY_SSRF_ALLOWLIST;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('discoveryService — runtime SSRF guard (WKH-62 W1)', () => {
  it('T-DISC-01: queryRegistry rejects discoveryEndpoint resolving to 169.254.169.254', async () => {
    const registry = makeRegistry({
      discoveryEndpoint: 'http://metadata.attacker.example/agents',
    });
    mockLookup.mockResolvedValueOnce([
      { address: '169.254.169.254', family: 4 },
    ]);

    let caught: unknown;
    try {
      await discoveryService.queryRegistry(registry, {});
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SSRFViolationError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('T-DISC-02: queryRegistry positive — public host triggers fetch and returns agents', async () => {
    const registry = makeRegistry({
      discoveryEndpoint: 'https://example.com/agents',
    });
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          {
            id: 'a1',
            slug: 'a1',
            name: 'Agent 1',
            description: 'd',
            capabilities: [],
            price: 0,
            status: 'active',
          },
        ]),
    });

    const agents = await discoveryService.queryRegistry(registry, {});

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(agents).toHaveLength(1);
    expect(agents[0].slug).toBe('a1');
  });

  it('T-DISC-03: discover() — SSRF registry is dropped, sibling public registry still returns', async () => {
    const ssrfReg = makeRegistry({
      id: 'ssrf-reg',
      name: 'ssrf-reg',
      discoveryEndpoint: 'http://internal.attacker.example/agents',
    });
    const goodReg = makeRegistry({
      id: 'good-reg',
      name: 'good-reg',
      discoveryEndpoint: 'https://good.example/agents',
    });
    vi.mocked(registryService.getEnabled).mockResolvedValue([ssrfReg, goodReg]);

    // ssrf registry → 10.0.0.1 (private), good registry → public
    mockLookup
      .mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }])
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          {
            id: 'g1',
            slug: 'g1',
            name: 'Good Agent',
            description: 'd',
            capabilities: [],
            price: 0,
            status: 'active',
          },
        ]),
    });

    const result = await discoveryService.discover({});

    // The SSRF registry's queryRegistry throws; discover() catches in L70.
    // Only the good registry's agent surfaces.
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].slug).toBe('g1');
    // Only one fetch happened (for good registry).
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('T-DISC-04: queryRegistry rejects file:// discoveryEndpoint', async () => {
    const registry = makeRegistry({
      discoveryEndpoint: 'file:///etc/passwd',
    });

    let caught: unknown;
    try {
      await discoveryService.queryRegistry(registry, {});
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SSRFViolationError);
    if (caught instanceof SSRFViolationError) {
      expect(caught.category).toBe('invalid-protocol');
    }
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('T-DISC-05: queryRegistry rejects DNS resolving to ::ffff:169.254.169.254 (DT-B IPv6-mapped)', async () => {
    const registry = makeRegistry({
      discoveryEndpoint: 'https://bypass.example/agents',
    });
    mockLookup.mockResolvedValueOnce([
      { address: '::ffff:169.254.169.254', family: 6 },
    ]);

    let caught: unknown;
    try {
      await discoveryService.queryRegistry(registry, {});
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SSRFViolationError);
    if (caught instanceof SSRFViolationError) {
      expect(caught.category).toBe('private-ip');
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('T-DISC-06: DISCOVERY_SSRF_ALLOWLIST whitelists internal host — fetch IS called', async () => {
    process.env.DISCOVERY_SSRF_ALLOWLIST = 'internal.test';
    const registry = makeRegistry({
      discoveryEndpoint: 'https://internal.test/agents',
    });

    // Even though DNS would resolve to private IP, allowlist bypasses
    // the rule 5 check (AC-4). lookup is not actually invoked because
    // validateOutboundUrl short-circuits when host is allowlisted.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });

    const agents = await discoveryService.queryRegistry(registry, {});

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(agents).toEqual([]);
  });
});
