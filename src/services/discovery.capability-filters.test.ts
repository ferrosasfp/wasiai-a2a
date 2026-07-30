/**
 * HU-208 — el filtro de CANDIDATURA (`scope`) dentro del pipeline de discovery,
 * la propiedad que lo justifica ahí y no en `/compose`, y el desempate aleatorio
 * del comparador.
 *
 * LA PROPIEDAD (la razón de todo el diseño): `runDiscoveryPipeline` corre
 * filtros → sort → `slice(0, limit)`. Como el recorte va DESPUÉS del sort, sobre
 * una lista ya ordenada sólo puede sacar elementos de la COLA, así que
 *
 *     sorted.slice(0, N)[0] === sorted[0]   para todo N >= 1
 *
 * y el recorte NUNCA puede cambiar quién gana. Eso es lo que deja el residual
 * TD-189-1 fuera del camino de la resolución por capacidad. Si estos filtros se
 * movieran aguas abajo del recorte, la precondición de ese residual pasaría a
 * estar encima del camino del dinero. T-DISCFILT-06 es el test que lo ancla.
 *
 * Naming: T-DISCFILT-04..T-DISCFILT-07 (01..03 eran el filtro por `chain`, que
 * se evaluó y se RECHAZÓ: forzar el rail es hacerle trampa al ranking).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { A2AAgentKeyRow, Agent } from '../types/index.js';

vi.mock('../lib/logger.js', () => ({
  getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

// Sin registries externos: todos los candidatos entran por la vía
// self-published, que atraviesa EXACTAMENTE el mismo pipeline común
// (status → verified → caps → price → rep → chain → scope → sort → slice).
vi.mock('./registry.js', () => ({
  registryService: {
    getEnabled: vi.fn().mockResolvedValue([]),
    getWithSecrets: vi.fn().mockResolvedValue(null),
  },
  SYSTEM_OWNER_REF: 'system',
}));

const listAsAgents = vi.hoisted(() => vi.fn());
vi.mock('./agent.js', () => ({
  publishedAgentService: { listAsAgents, getBySlugAsAgent: vi.fn() },
}));

// Reputación: se inyecta por test para poder construir un ranking donde el mejor
// NO sea el primero del arreglo.
const reputationMap = vi.hoisted(() => ({ value: new Map<string, unknown>() }));
vi.mock('./reputation.js', () => ({
  reputationService: {
    computeReputationBatch: vi.fn(async () => reputationMap.value),
    // WKH-313: el consumidor real de `attachReputations`; se DERIVA del mismo
    // `reputationMap` que ya inyectaban estos tests (misma fuente, sin degradación).
    computeStandingBatch: vi.fn(async () => {
      const standings = new Map();
      for (const [slug, reputation] of reputationMap.value as Map<
        string,
        { tasks_settled: number }
      >) {
        standings.set(slug, {
          tasksSettled: reputation.tasks_settled,
          successCount: reputation.tasks_settled,
          failedCount: 0,
          reputation,
        });
      }
      return { degraded: false, standings };
    }),
  },
}));

vi.mock('./identity.js', () => ({
  identityService: { resolveIdentityForAgent: vi.fn().mockResolvedValue(null) },
}));

import {
  _resetTiebreakRandomSource,
  _setTiebreakRandomSource,
} from '../lib/ranking-tiebreak.js';
import { discoveryService } from './discovery.js';

function makeAgent(over: Partial<Agent> & { slug: string }): Agent {
  return {
    id: over.slug,
    name: over.slug,
    description: 'agent',
    capabilities: ['fx-quote'],
    priceUsdc: 1,
    registry: 'self-published',
    registry_id: 'self-published',
    invokeUrl: `https://example.test/${over.slug}`,
    invocationNote: '',
    verified: false,
    status: 'active',
    metadata: {},
    ...over,
  };
}

function makeKeyRow(over: Partial<A2AAgentKeyRow>): A2AAgentKeyRow {
  return {
    id: 'k1',
    owner_ref: 'o1',
    key_hash: 'h',
    display_name: null,
    budget: {},
    daily_limit_usd: null,
    daily_spent_usd: '0',
    daily_reset_at: new Date().toISOString(),
    allowed_registries: null,
    allowed_agent_slugs: null,
    allowed_categories: null,
    max_spend_per_call_usd: null,
    is_active: true,
    last_used_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    erc8004_identity: null,
    kite_passport: null,
    agentkit_wallet: null,
    funding_wallet: null,
    metadata: {},
    require_signature: false,
    ...over,
  } as A2AAgentKeyRow;
}

beforeEach(() => {
  vi.clearAllMocks();
  reputationMap.value = new Map();
  // Determinismo por defecto: sin fijar la fuente, el desempate aleatorio
  // volvería flake a cualquier test con candidatos empatados. Los tests del
  // desempate la fijan a propósito.
  _setTiebreakRandomSource(() => 0.5);
});
afterEach(() => _resetTiebreakRandomSource());

describe('HU-208 · filtro `scope` (alcance de la credencial, WAS-187 AC-7)', () => {
  it('T-DISCFILT-04: un agente fuera del alcance de la key NO es candidato', async () => {
    listAsAgents.mockResolvedValue([
      makeAgent({ slug: 'permitido' }),
      makeAgent({ slug: 'prohibido' }),
    ]);

    const res = await discoveryService.discover({
      capabilities: ['fx-quote'],
      scope: makeKeyRow({ allowed_agent_slugs: ['permitido'] }),
    });

    expect(res.agents.map((a) => a.slug)).toEqual(['permitido']);
    expect(res.excluded?.scope).toBe(1);
  });

  it('T-DISCFILT-05: el filtro usa `category` del MISMO lector que el ejecutor', async () => {
    // Si el selector y `composeService` leyeran `category` distinto, el selector
    // elegiría agentes que el ejecutor rechaza con 403 — sobre un agente que el
    // llamador nunca nombró. Por eso ambos usan `lib/agent-category.ts`.
    listAsAgents.mockResolvedValue([
      makeAgent({ slug: 'de-finanzas', metadata: { category: 'finance' } }),
      makeAgent({ slug: 'de-otra-cosa', metadata: { category: 'gaming' } }),
      makeAgent({ slug: 'sin-categoria', metadata: {} }),
    ]);

    const res = await discoveryService.discover({
      capabilities: ['fx-quote'],
      scope: makeKeyRow({ allowed_categories: ['finance'] }),
    });

    expect(res.agents.map((a) => a.slug)).toEqual(['de-finanzas']);
    expect(res.excluded?.scope).toBe(2);
  });
});

describe('HU-208 · el recorte NO puede cambiar el ganador (por qué TD-189-1 no aplica)', () => {
  it('T-DISCFILT-06: con el mejor ÚLTIMO en el arreglo y `limit: 1`, igual gana', async () => {
    // Construido para que NO pueda pasar por casualidad: el mejor candidato es
    // el ÚLTIMO del arreglo de entrada, y el `limit` es 1 (el recorte más
    // agresivo posible). Si el filtro/sort corrieran DESPUÉS del recorte, el
    // resultado sería 'primero-malo'.
    listAsAgents.mockResolvedValue([
      makeAgent({ slug: 'primero-malo', verified: false, priceUsdc: 9 }),
      makeAgent({ slug: 'segundo-malo', verified: false, priceUsdc: 8 }),
      makeAgent({ slug: 'tercero-malo', verified: false, priceUsdc: 7 }),
      makeAgent({ slug: 'ultimo-mejor', verified: true, priceUsdc: 99 }),
    ]);

    const res = await discoveryService.discover({
      capabilities: ['fx-quote'],
      limit: 1,
    });

    // verified-first gana sobre el precio: el más caro pero verificado es el
    // mejor por el criterio DEFINIDO, y sigue siéndolo con la ventana en 1.
    expect(res.agents[0]?.slug).toBe('ultimo-mejor');
    // `total` es pre-slice: los 4 matchearon, la página devuelve 1.
    expect(res.total).toBe(4);
  });

  it('T-DISCFILT-07: el ganador es el MISMO con limit 1 y sin limit (invariante al recorte)', async () => {
    listAsAgents.mockResolvedValue([
      makeAgent({ slug: 'a', verified: false, priceUsdc: 1 }),
      makeAgent({ slug: 'b', verified: false, priceUsdc: 2 }),
      makeAgent({ slug: 'mejor', verified: true, priceUsdc: 50 }),
    ]);

    const recortado = await discoveryService.discover({
      capabilities: ['fx-quote'],
      limit: 1,
    });
    const completo = await discoveryService.discover({
      capabilities: ['fx-quote'],
    });

    expect(recortado.agents[0]?.slug).toBe(completo.agents[0]?.slug);
    expect(recortado.agents[0]?.slug).toBe('mejor');
  });
});

describe('HU-208 · desempate ALEATORIO cuando los tres criterios empatan', () => {
  /** Dos agentes IDÉNTICOS en identidad, reputación y precio: sólo el azar los separa. */
  const empatados = () => [
    makeAgent({ slug: 'gemelo-a', verified: false, priceUsdc: 1 }),
    makeAgent({ slug: 'gemelo-b', verified: false, priceUsdc: 1 }),
  ];

  it('T-DISCFILT-08: con muchas corridas, el ganador SE REPARTE', async () => {
    // EL test del desempate: si siempre gana el mismo, el desempate no existe.
    //
    // Se usa un PRNG SEMBRADO (LCG) en vez de `Math.random`: da una secuencia
    // genuinamente repartida —así el test prueba distribución de verdad, no sólo
    // "el desempate se lee"— pero REPRODUCIBLE, así que no puede volverse un
    // flake. Con el sesgo posicional viejo, 'gemelo-a' ganaría 100 de 100.
    let seed = 42;
    _setTiebreakRandomSource(() => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    });

    const wins: Record<string, number> = { 'gemelo-a': 0, 'gemelo-b': 0 };
    for (let i = 0; i < 100; i++) {
      listAsAgents.mockResolvedValue(empatados());
      const res = await discoveryService.discover({
        capabilities: ['fx-quote'],
      });
      const winner = res.agents[0]?.slug as string;
      wins[winner] = (wins[winner] ?? 0) + 1;
    }

    // Los dos ganan una porción sustancial: el reparto existe.
    expect(wins['gemelo-a']).toBeGreaterThan(30);
    expect(wins['gemelo-b']).toBeGreaterThan(30);
    expect((wins['gemelo-a'] ?? 0) + (wins['gemelo-b'] ?? 0)).toBe(100);
  });

  it('T-DISCFILT-09: el azar NO puede pasar por encima de los tres criterios', async () => {
    // El desempate es el ÚLTIMO criterio, no un cuarto competidor: un agente
    // verificado le gana a uno sin verificar aunque el azar favorezca al segundo.
    listAsAgents.mockResolvedValue([
      makeAgent({ slug: 'sin-verificar', verified: false, priceUsdc: 1 }),
      makeAgent({ slug: 'verificado', verified: true, priceUsdc: 1 }),
    ]);
    // Valor bajo (gana el desempate) para el PRIMERO, alto para el verificado.
    const seq = [0.01, 0.99];
    let i = 0;
    _setTiebreakRandomSource(() => seq[i++ % seq.length] as number);

    const res = await discoveryService.discover({ capabilities: ['fx-quote'] });

    expect(res.agents[0]?.slug).toBe('verificado');
  });

  it('T-DISCFILT-10: el orden es TOTAL y estable dentro de una misma request', async () => {
    // El valor se asigna UNA vez por agente antes de ordenar. Si el aleatorio se
    // llamara dentro del comparador, el sort quedaría indefinido por
    // especificación y el arreglo podría salir incompleto o con duplicados.
    listAsAgents.mockResolvedValue([
      makeAgent({ slug: 'a', priceUsdc: 1 }),
      makeAgent({ slug: 'b', priceUsdc: 1 }),
      makeAgent({ slug: 'c', priceUsdc: 1 }),
      makeAgent({ slug: 'd', priceUsdc: 1 }),
    ]);
    _resetTiebreakRandomSource(); // Math.random real: el peor caso para el sort

    const res = await discoveryService.discover({ capabilities: ['fx-quote'] });

    const slugs = res.agents.map((a) => a.slug).sort();
    expect(slugs).toEqual(['a', 'b', 'c', 'd']); // ni pérdidas ni duplicados
    expect(new Set(slugs).size).toBe(4);
  });
});
