/**
 * Tests for agent-price service — WKH-59 (real-price-debit) Wave W1.
 *
 * CD-14: NO usar `failNext`. Usar `mockResolvedValueOnce` chained.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./discovery.js', () => ({
  discoveryService: {
    getAgent: vi.fn(),
  },
}));

import {
  _resetAgentPriceCache,
  resolveAgentDestination,
  resolveAgentPriceUsdc,
} from './agent-price.js';
import { discoveryService } from './discovery.js';

const mockGetAgent = vi.mocked(discoveryService.getAgent);

function makeAgent(slug: string, priceUsdc: number) {
  return {
    id: `id-${slug}`,
    name: `Agent ${slug}`,
    slug,
    description: 'test',
    capabilities: [],
    priceUsdc,
    registry: 'reg-test',
    registry_id: 'reg-test',
    invokeUrl: 'https://example.com/invoke',
    invocationNote: 'gateway-only',
    verified: true,
    status: 'active' as const,
  };
}

describe('resolveAgentPriceUsdc', () => {
  beforeEach(() => {
    _resetAgentPriceCache();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('T-PRICE-1 should fetch from discoveryService on cache miss', async () => {
    mockGetAgent.mockResolvedValueOnce(makeAgent('kyc', 0.001));

    const price = await resolveAgentPriceUsdc('kyc');

    expect(price).toBe(0.001);
    expect(mockGetAgent).toHaveBeenCalledTimes(1);
    expect(mockGetAgent).toHaveBeenCalledWith('kyc', undefined);
  });

  it('T-PRICE-2 should hit cache on second call within TTL', async () => {
    mockGetAgent.mockResolvedValueOnce(makeAgent('kyc', 0.001));

    const first = await resolveAgentPriceUsdc('kyc');
    const second = await resolveAgentPriceUsdc('kyc');

    expect(first).toBe(0.001);
    expect(second).toBe(0.001);
    expect(mockGetAgent).toHaveBeenCalledTimes(1);
  });

  it('T-PRICE-3 should re-fetch when TTL expires', async () => {
    vi.useFakeTimers();
    mockGetAgent.mockResolvedValueOnce(makeAgent('kyc', 0.001));
    mockGetAgent.mockResolvedValueOnce(makeAgent('kyc', 0.002));

    const first = await resolveAgentPriceUsdc('kyc');
    vi.advanceTimersByTime(61_000);
    const second = await resolveAgentPriceUsdc('kyc');

    expect(first).toBe(0.001);
    expect(second).toBe(0.002);
    expect(mockGetAgent).toHaveBeenCalledTimes(2);
  });

  it('T-PRICE-4 should return null when agent not found and NOT cache it (DT-G)', async () => {
    mockGetAgent.mockResolvedValueOnce(null);
    mockGetAgent.mockResolvedValueOnce(null);

    const first = await resolveAgentPriceUsdc('missing');
    const second = await resolveAgentPriceUsdc('missing');

    expect(first).toBeNull();
    expect(second).toBeNull();
    // DT-G: no negative caching → re-fetch every call
    expect(mockGetAgent).toHaveBeenCalledTimes(2);
  });

  it('T-PRICE-5 should propagate DB error from discoveryService', async () => {
    mockGetAgent.mockRejectedValueOnce(new Error('DB down'));

    await expect(resolveAgentPriceUsdc('kyc')).rejects.toThrow('DB down');
  });

  it('T-PRICE-6 should return 0 when priceUsdc is 0 (caller decides fallback)', async () => {
    mockGetAgent.mockResolvedValueOnce(makeAgent('free-agent', 0));

    const price = await resolveAgentPriceUsdc('free-agent');

    expect(price).toBe(0);
    // Fallback $1 está en el preHandler, no en este service (DT-C)
  });

  it('T-PRICE-7 should scope cache by slug', async () => {
    mockGetAgent.mockResolvedValueOnce(makeAgent('kyc', 0.001));
    mockGetAgent.mockResolvedValueOnce(makeAgent('corridor', 0.05));

    const a = await resolveAgentPriceUsdc('kyc');
    const b = await resolveAgentPriceUsdc('corridor');
    // Second-call cache hits for each slug
    const a2 = await resolveAgentPriceUsdc('kyc');
    const b2 = await resolveAgentPriceUsdc('corridor');

    expect(a).toBe(0.001);
    expect(b).toBe(0.05);
    expect(a2).toBe(0.001);
    expect(b2).toBe(0.05);
    expect(mockGetAgent).toHaveBeenCalledTimes(2);
  });

  it('T-PRICE-8 should scope cache by registryName for same slug', async () => {
    mockGetAgent.mockResolvedValueOnce(makeAgent('kyc', 0.001));
    mockGetAgent.mockResolvedValueOnce(makeAgent('kyc', 0.002));

    const a = await resolveAgentPriceUsdc('kyc', 'reg-a');
    const b = await resolveAgentPriceUsdc('kyc', 'reg-b');

    expect(a).toBe(0.001);
    expect(b).toBe(0.002);
    expect(mockGetAgent).toHaveBeenCalledTimes(2);
    expect(mockGetAgent).toHaveBeenNthCalledWith(1, 'kyc', 'reg-a');
    expect(mockGetAgent).toHaveBeenNthCalledWith(2, 'kyc', 'reg-b');
  });
});

// WKH-125 BLQ-ALTO-1 (fix-pack): resolveAgentDestination devuelve el
// registry/slug CANÓNICO del agente resuelto por discovery (no del body crudo).
// Es lo que el step-0 usa para keyear el cap por destino → debe coincidir con
// el per-step. Espeja el orden de resolución de `compose.resolveAgent`.
describe('resolveAgentDestination', () => {
  beforeEach(() => {
    _resetAgentPriceCache();
    vi.clearAllMocks();
  });

  function makeAgentWithRegistry(slug: string, registry: string) {
    return {
      id: `id-${slug}`,
      name: `Agent ${slug}`,
      slug,
      description: 'test',
      capabilities: [],
      priceUsdc: 0.001,
      registry,
      registry_id: registry,
      invokeUrl: 'https://example.com/invoke',
      invocationNote: 'gateway-only',
      verified: true,
      status: 'active' as const,
    };
  }

  it('T-DEST-1 returns canonical {registry, slug} from the resolved agent', async () => {
    // Body slug "myagent", registry hint "wasiai" → discovery devuelve canónico.
    mockGetAgent.mockResolvedValueOnce(
      makeAgentWithRegistry('myagent', 'wasiai'),
    );

    const dest = await resolveAgentDestination('myagent', 'wasiai');

    expect(dest).toEqual({ registry: 'wasiai', slug: 'myagent' });
    expect(mockGetAgent).toHaveBeenCalledWith('myagent', 'wasiai');
  });

  it('T-DEST-2 (BLQ-ALTO-1): caller omits registry → canonical registry still resolved', async () => {
    // Caller pasó registry=undefined; discovery resuelve igual el agente y su
    // registry canónico "wasiai" → el destino NO degrada a slug-solo.
    mockGetAgent.mockResolvedValueOnce(
      makeAgentWithRegistry('myagent', 'wasiai'),
    );

    const dest = await resolveAgentDestination('myagent', undefined);

    expect(dest).toEqual({ registry: 'wasiai', slug: 'myagent' });
    expect(mockGetAgent).toHaveBeenNthCalledWith(1, 'myagent', undefined);
  });

  it('T-DEST-3 falls back to getAgent without registry when hint misses', async () => {
    // 1er intento (con hint) → null; fallback sin hint → resuelve.
    mockGetAgent.mockResolvedValueOnce(null);
    mockGetAgent.mockResolvedValueOnce(
      makeAgentWithRegistry('myagent', 'wasiai'),
    );

    const dest = await resolveAgentDestination('myagent', 'wrong-hint');

    expect(dest).toEqual({ registry: 'wasiai', slug: 'myagent' });
    expect(mockGetAgent).toHaveBeenNthCalledWith(1, 'myagent', 'wrong-hint');
    // Fallback espeja compose.resolveAgent: getAgent(slug) sin 2º arg.
    expect(mockGetAgent).toHaveBeenNthCalledWith(2, 'myagent');
  });

  it('T-DEST-4 returns null when the agent does not resolve at all', async () => {
    mockGetAgent.mockResolvedValue(null);

    const dest = await resolveAgentDestination('ghost', undefined);

    expect(dest).toBeNull();
  });
});
