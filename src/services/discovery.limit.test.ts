/**
 * Discovery Service — contrato de `limit` / `total` (fix-pack P1, hallazgo 1).
 *
 * El bug: `queryRegistry` reenviaba el `limit` DEL CALLER al registry upstream
 * (`schema.discovery.limitParam`), truncando el candidate-set ANTES de que
 * corrieran los filtros locales (status/verified/caps/free-text/maxPrice) y el
 * sort. Todo agente descartado por un filtro local era un slot de la página que
 * ya no se podía rellenar → la página salía CORTA y `total` subestimaba los
 * matches reales.
 *
 * Contrato fijado acá:
 *   · `agents`  = hasta `limit` matches (page).
 *   · `total`   = matches TOTALES pre-`limit` (denominador de paginación).
 *   · `total >= agents.length`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegistryConfig } from '../types/index.js';

vi.mock('../lib/logger.js', () => ({
  getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

vi.mock('./registry.js', () => ({
  registryService: {
    getEnabled: vi.fn(),
    get: vi.fn(),
    getWithSecrets: vi.fn(),
  },
}));

vi.mock('../lib/circuit-breaker.js', () => ({
  getRegistryCircuitBreaker: () => ({
    execute: (fn: () => Promise<Response>) => fn(),
  }),
}));

// undici-8 (#124): ssrfFetch usa el `fetch` de undici, no el global.
const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.stubGlobal('fetch', mockFetch);
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: mockFetch };
});

vi.mock('./agent.js', () => ({
  publishedAgentService: {
    listAsAgents: vi.fn().mockResolvedValue([]),
    getBySlugAsAgent: vi.fn(),
  },
}));

vi.mock('./reputation.js', () => ({
  reputationService: {
    computeReputationBatch: vi.fn().mockResolvedValue(new Map()),
    computeReputationForAgent: vi.fn(),
  },
}));

vi.mock('./identity.js', () => ({
  identityService: { resolveIdentityForAgent: vi.fn().mockResolvedValue(null) },
}));

import { discoveryService } from './discovery.js';
import { registryService } from './registry.js';

/** Registry con `limitParam`, como los dos registries reales del repo. */
function makeRegistry(o: Partial<RegistryConfig> = {}): RegistryConfig {
  return {
    id: 'reg-1',
    name: 'test-registry',
    discoveryEndpoint: 'https://example.com/agents',
    invokeEndpoint: 'https://example.com/invoke/{slug}',
    schema: { discovery: { limitParam: 'limit' }, invoke: { method: 'POST' } },
    enabled: true,
    createdAt: new Date(),
    ownerRef: 'system',
    ...o,
  };
}

/** Catálogo de `n` agentes; los primeros `inactive` con status inactive. */
function catalog(n: number, inactive = 0): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `a${i}`,
    slug: `agent-${i}`,
    name: `Agent ${i}`,
    description: 'desc',
    capabilities: ['x'],
    price: 0,
    reputation: 10,
    status: i < inactive ? 'inactive' : 'active',
  }));
}

/** Registry que HONRA `?limit=N` devolviendo sus primeras N filas. */
function serveHonoringLimit(rows: Record<string, unknown>[]): {
  upstreamLimits: (string | null)[];
} {
  const upstreamLimits: (string | null)[] = [];
  mockFetch.mockImplementation((url: string) => {
    const lim = new URL(url).searchParams.get('limit');
    upstreamLimits.push(lim);
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(lim ? rows.slice(0, Number(lim)) : rows),
    });
  });
  return { upstreamLimits };
}

describe('discover(): contrato de limit / total (hallazgo P1-1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DISCOVERY_UPSTREAM_FETCH_LIMIT;
    vi.mocked(registryService.getEnabled).mockResolvedValue([makeRegistry()]);
  });

  it('T-1: limit=N con MÁS de N candidatos devuelve exactamente N (el filtro local ya no roba slots)', async () => {
    // 10 agentes upstream, 3 inactive → 7 matchean. limit=5 debe dar 5.
    // PRE-FIX: el registry recibía ?limit=5, devolvía sus 5 primeras filas
    // (3 inactive entre ellas) → 2 agentes. Regresión medida: 2 en vez de 5.
    serveHonoringLimit(catalog(10, 3));

    const result = await discoveryService.discover({ limit: 5 });

    expect(result.agents).toHaveLength(5);
    // ...y ninguno inactive (el filtro sigue aplicando).
    expect(result.agents.every((a) => a.status === 'active')).toBe(true);
  });

  it('T-2: total = matches pre-limit (>= agents.length), no el tamaño de la página', async () => {
    serveHonoringLimit(catalog(10, 3));

    const result = await discoveryService.discover({ limit: 5 });

    // 7 activos matchean; la página son 5.
    expect(result.total).toBe(7);
    expect(result.agents).toHaveLength(5);
    expect(result.total).toBeGreaterThanOrEqual(result.agents.length);
  });

  it('T-3: catálogo por DEBAJO del limit → devuelve todo y total === agents.length', async () => {
    serveHonoringLimit(catalog(3));

    const result = await discoveryService.discover({ limit: 50 });

    expect(result.agents).toHaveLength(3);
    expect(result.total).toBe(3);
    expect(result.total).toBe(result.agents.length);
  });

  it('T-4: el limit del caller NO viaja upstream — viaja el over-fetch', async () => {
    const { upstreamLimits } = serveHonoringLimit(catalog(10, 3));

    await discoveryService.discover({ limit: 5 });

    // El default de over-fetch (200), no el 5 del caller.
    expect(upstreamLimits).toEqual(['200']);
  });

  it('T-5: over-fetch configurable por env', async () => {
    process.env.DISCOVERY_UPSTREAM_FETCH_LIMIT = '25';
    const { upstreamLimits } = serveHonoringLimit(catalog(10, 3));

    await discoveryService.discover({ limit: 5 });

    expect(upstreamLimits).toEqual(['25']);
  });

  it('T-6: limit del caller MAYOR que el over-fetch gana (monotonía: no se under-fetchea)', async () => {
    process.env.DISCOVERY_UPSTREAM_FETCH_LIMIT = '25';
    const { upstreamLimits } = serveHonoringLimit(catalog(10));

    await discoveryService.discover({ limit: 500 });

    expect(upstreamLimits).toEqual(['500']);
  });

  it('T-7: env inválida → cae al default 200 (no NaN upstream)', async () => {
    process.env.DISCOVERY_UPSTREAM_FETCH_LIMIT = 'abc';
    const { upstreamLimits } = serveHonoringLimit(catalog(10));

    await discoveryService.discover({ limit: 5 });

    expect(upstreamLimits).toEqual(['200']);
  });

  it('T-8: SIN limit del caller no se manda limitParam (comportamiento de hoy preservado)', async () => {
    const { upstreamLimits } = serveHonoringLimit(catalog(10, 3));

    const result = await discoveryService.discover({});

    expect(upstreamLimits).toEqual([null]);
    expect(result.agents).toHaveLength(7);
    expect(result.total).toBe(7);
  });

  it('T-9: registry SIN limitParam en su schema nunca recibe el parámetro', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([
      makeRegistry({ schema: { discovery: {}, invoke: { method: 'POST' } } }),
    ]);
    const { upstreamLimits } = serveHonoringLimit(catalog(10, 3));

    const result = await discoveryService.discover({ limit: 5 });

    expect(upstreamLimits).toEqual([null]);
    expect(result.agents).toHaveLength(5);
    expect(result.total).toBe(7);
  });
});
