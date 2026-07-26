/**
 * Discovery Service — `minReputation` (fix-pack P1, hallazgo 2).
 *
 * El bug: el parámetro se aceptaba en GET y POST /discover, viajaba en el
 * `DiscoveryQuery` y NUNCA se leía en el service. Un caller creía estar pidiendo
 * agentes con reputación mínima y recibía cualquiera.
 *
 * Decisión: IMPLEMENTARLO (hay fuente real y ya cableada: el score off-chain
 * 0-100 de `reputationService.computeReputationBatch`, adjuntado pre-limit por
 * `attachReputations`).
 *
 * Sub-decisión clave: filtra SÓLO `computedReputation.score`, NO el
 * `agent.reputation` auto-reportado por el registry. Un filtro de calidad cuyo
 * valor lo controla la parte que se está filtrando no filtra nada.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentReputation, RegistryConfig } from '../types/index.js';

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

const mockComputeBatch = vi.fn();
vi.mock('./reputation.js', () => ({
  reputationService: {
    computeReputationBatch: (slugs: string[]) => mockComputeBatch(slugs),
    computeReputationForAgent: vi.fn(),
  },
}));

vi.mock('./identity.js', () => ({
  identityService: { resolveIdentityForAgent: vi.fn().mockResolvedValue(null) },
}));

import { discoveryService } from './discovery.js';
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
    ownerRef: 'system',
    ...o,
  };
}

function rep(score: number): AgentReputation {
  return {
    score,
    tasks_settled: 10,
    success_rate: 1,
    total_volume_usdc: 10,
    source: 'off-chain',
  };
}

/** raw agent; `reputation` es el valor AUTO-REPORTADO por el registry. */
function raw(slug: string, reputation = 0): Record<string, unknown> {
  return {
    id: slug,
    slug,
    name: slug,
    description: 'desc',
    capabilities: ['x'],
    price: 0,
    reputation,
    status: 'active',
  };
}

function serve(rows: Record<string, unknown>[]): void {
  mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(rows) });
}

describe('discover(): minReputation filtra de verdad (hallazgo P1-2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(registryService.getEnabled).mockResolvedValue([makeRegistry()]);
    mockComputeBatch.mockResolvedValue(new Map());
  });

  it('T-1: sin minReputation devuelve todo (no hay regresión)', async () => {
    serve([raw('low'), raw('high')]);
    mockComputeBatch.mockResolvedValue(
      new Map([
        ['low', rep(10)],
        ['high', rep(90)],
      ]),
    );

    const result = await discoveryService.discover({});

    expect(result.agents.map((a) => a.slug).sort()).toEqual(['high', 'low']);
    expect(result.total).toBe(2);
  });

  it('T-2: minReputation=50 excluye los que están por debajo', async () => {
    serve([raw('low'), raw('mid'), raw('high')]);
    mockComputeBatch.mockResolvedValue(
      new Map([
        ['low', rep(10)],
        ['mid', rep(50)],
        ['high', rep(90)],
      ]),
    );

    const result = await discoveryService.discover({ minReputation: 50 });

    // >= es inclusivo: `mid` con score exactamente 50 pasa.
    expect(result.agents.map((a) => a.slug)).toEqual(['high', 'mid']);
    expect(result.total).toBe(2);
  });

  it('T-3 (FAIL-SAFE): agente SIN reputación computada cuenta como 0 y queda excluido', async () => {
    // 0 tasks liquidadas → el slug no aparece en el Map del batch. Un agente sin
    // historial NO puede colarse por un filtro de calidad.
    serve([raw('sin-historial'), raw('con-historial')]);
    mockComputeBatch.mockResolvedValue(new Map([['con-historial', rep(80)]]));

    const result = await discoveryService.discover({ minReputation: 1 });

    expect(result.agents.map((a) => a.slug)).toEqual(['con-historial']);
    expect(result.total).toBe(1);
  });

  it('T-4: minReputation=0 no excluye a nadie (ni a los sin historial)', async () => {
    serve([raw('sin-historial'), raw('con-historial')]);
    mockComputeBatch.mockResolvedValue(new Map([['con-historial', rep(80)]]));

    const result = await discoveryService.discover({ minReputation: 0 });

    expect(result.agents).toHaveLength(2);
  });

  it('T-5 (INTEGRIDAD): NO se cuela por el `reputation` auto-reportado por el registry', async () => {
    // `impostor` declara reputation: 100 en su card pero no tiene score computado.
    // Si el filtro usara el fallback del sort (computedReputation ?? reputation),
    // pasaría — y el filtro no serviría para nada, porque el valor lo controla
    // exactamente la parte que se está filtrando.
    serve([raw('impostor', 100), raw('honesto', 0)]);
    mockComputeBatch.mockResolvedValue(new Map([['honesto', rep(70)]]));

    const result = await discoveryService.discover({ minReputation: 60 });

    expect(result.agents.map((a) => a.slug)).toEqual(['honesto']);
    expect(result.total).toBe(1);
  });

  it('T-6: el filtro corre PRE-limit → la página se llena con los que pasan', async () => {
    serve([raw('a'), raw('b'), raw('c'), raw('d')]);
    mockComputeBatch.mockResolvedValue(
      new Map([
        ['a', rep(90)],
        ['b', rep(5)],
        ['c', rep(80)],
        ['d', rep(70)],
      ]),
    );

    const result = await discoveryService.discover({
      minReputation: 50,
      limit: 2,
    });

    // 3 matchean (a, c, d); la página son los 2 de mayor score.
    expect(result.agents.map((a) => a.slug)).toEqual(['a', 'c']);
    expect(result.total).toBe(3);
  });

  it('T-7: el batch de reputación se sigue llamando UNA sola vez (no N+1)', async () => {
    serve([raw('a'), raw('b')]);
    mockComputeBatch.mockResolvedValue(
      new Map([
        ['a', rep(90)],
        ['b', rep(10)],
      ]),
    );

    await discoveryService.discover({ minReputation: 50 });

    expect(mockComputeBatch).toHaveBeenCalledTimes(1);
  });

  it('T-8 (DEGRADACIÓN): si el batch de reputación falla, minReputation NO deja pasar a nadie', async () => {
    // El batch degradado devuelve Map vacío (services/reputation.ts:242-253).
    // Fail-safe: sin dato de reputación, un filtro de calidad NO puede aprobar.
    serve([raw('a', 100), raw('b', 100)]);
    mockComputeBatch.mockResolvedValue(new Map());

    const result = await discoveryService.discover({ minReputation: 50 });

    expect(result.agents).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('T-9: minReputation combina en AND con los otros filtros', async () => {
    serve([
      { ...raw('caro'), price: 10 },
      { ...raw('barato'), price: 0.01 },
    ]);
    mockComputeBatch.mockResolvedValue(
      new Map([
        ['caro', rep(90)],
        ['barato', rep(90)],
      ]),
    );

    const result = await discoveryService.discover({
      minReputation: 50,
      maxPrice: 1,
    });

    expect(result.agents.map((a) => a.slug)).toEqual(['barato']);
  });
});
