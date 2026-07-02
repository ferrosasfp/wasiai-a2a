/**
 * Compose Service — Runtime SSRF Guard Tests (WKH-SEC-04).
 *
 * Verifies that `composeService.invokeAgent` revalidates `agent.invokeUrl`
 * with `validateRegistryUrl` BEFORE the outbound fetch (AC-3 / CD-2 / DT-2),
 * mirroring the established pattern in `discovery.ts:529`. On a private/
 * link-local target the step is aborted (error thrown) and NO fetch happens,
 * so auth headers (`x-a2a-key`, `PAYMENT-SIGNATURE`) never reach the blocked
 * host.
 *
 * Follows the scaffold of `src/services/discovery.ssrf.test.ts` (CD-3):
 *   mock node:dns + vi.stubGlobal('fetch') + assert fetch NOT called.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, RegistryConfig } from '../types/index.js';

// ── Mocks (must be set BEFORE importing the module under test) ─────

const mockLookup = vi.fn();
vi.mock('node:dns', () => ({
  promises: {
    lookup: (...args: unknown[]) => mockLookup(...args),
  },
}));

vi.mock('./registry.js', () => ({
  registryService: { getEnabled: vi.fn() },
  SYSTEM_OWNER_REF: 'system',
}));

vi.mock('../adapters/registry.js', () => ({
  getPaymentAdapter: () => ({ sign: vi.fn(), settle: vi.fn() }),
}));

vi.mock('./discovery.js', () => ({
  discoveryService: { getAgent: vi.fn(), discover: vi.fn() },
}));

vi.mock('./event.js', () => ({
  eventService: { track: vi.fn().mockResolvedValue({}) },
}));

vi.mock('../lib/downstream-payment.js', () => ({
  signAndSettleDownstream: vi.fn().mockResolvedValue(null),
}));

// undici-8 migration (#124): `ssrfFetch` calls undici's OWN `fetch` (not the
// Node global) so the undici-8 Agent and the fetch implementation share a
// version. We route BOTH the global stub and undici's `fetch` to the same
// `mockFetch` so positive-path assertions ("fetch IS called") hold while the
// real undici `Agent` (and its connect-time SSRF lookup) stays intact.
const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.stubGlobal('fetch', mockFetch);
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: mockFetch };
});

import { SSRFViolationError } from '../lib/url-validator.js';
import { composeService } from './compose.js';
import { registryService } from './registry.js';

const ORIGINAL_ENV = { ...process.env };

function makeAgent(o: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    slug: 'test-agent',
    description: 'A test agent',
    capabilities: ['test'],
    priceUsdc: 0,
    registry: 'test-registry',
    registry_id: 'test-registry',
    invokeUrl: 'https://example.com/invoke',
    invocationNote: 'POST /compose',
    verified: false,
    status: 'active',
    metadata: {},
    ...o,
  };
}

function makeRegistry(o: Partial<RegistryConfig> = {}): RegistryConfig {
  return {
    id: 'reg-1',
    name: 'test-registry',
    discoveryEndpoint: 'https://example.com/discover',
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
  vi.mocked(registryService.getEnabled).mockResolvedValue([makeRegistry()]);
  delete process.env.DISCOVERY_SSRF_ALLOWLIST;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('composeService.invokeAgent — runtime SSRF guard (WKH-SEC-04)', () => {
  it('AC-3: invokeUrl resolving to a private IP (169.254.169.254) → throws, no fetch, no header leak', async () => {
    const agent = makeAgent({
      invokeUrl: 'http://metadata.attacker.example/invoke',
    });
    mockLookup.mockResolvedValueOnce([
      { address: '169.254.169.254', family: 4 },
    ]);

    let caught: unknown;
    try {
      // a2aKey provided → would set x-a2a-key header; must NOT reach fetch.
      await composeService.invokeAgent(agent, { q: 'hi' }, 'secret-a2a-key');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('SSRF guard');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('AC-3: file:// invokeUrl → SSRFViolationError category → throws, no fetch', async () => {
    const agent = makeAgent({ invokeUrl: 'file:///etc/passwd' });

    let caught: unknown;
    try {
      await composeService.invokeAgent(agent, { q: 'hi' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('SSRF guard');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('AC-4: invokeUrl on a public host is NOT broken — fetch IS called', async () => {
    const agent = makeAgent({ invokeUrl: 'https://public.example/invoke' });
    // H-1 (audit 2026-06-29): the public host is now resolved TWICE — once by the
    // pre-fetch `validateRegistryUrl` (compose.ts) and once by `ssrfFetch`'s
    // per-hop `validateOutboundUrl`. Use a persistent mock so both see a public IP.
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ result: 'ok' }),
    });

    const result = await composeService.invokeAgent(agent, { q: 'hi' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://public.example/invoke',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.output).toBe('ok');
  });

  it('AC-4: DISCOVERY_SSRF_ALLOWLIST whitelists internal host → fetch IS called', async () => {
    process.env.DISCOVERY_SSRF_ALLOWLIST = 'internal.test';
    const agent = makeAgent({ invokeUrl: 'https://internal.test/invoke' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ result: 'ok' }),
    });

    const result = await composeService.invokeAgent(agent, { q: 'hi' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.output).toBe('ok');
  });

  it('sanity: validateRegistryUrl throws SSRFViolationError for private IPs', async () => {
    // Guards CD-2 wiring: the underlying validator the guard relies on.
    const { validateRegistryUrl } = await import('../lib/url-validator.js');
    mockLookup.mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);
    await expect(
      validateRegistryUrl('http://private.example/x'),
    ).rejects.toBeInstanceOf(SSRFViolationError);
  });
});
