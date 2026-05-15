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

import { discoveryService } from './discovery.js';
import { _resetAgentPriceCache, resolveAgentPriceUsdc } from './agent-price.js';

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
