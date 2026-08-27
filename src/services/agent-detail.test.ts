/**
 * Tests del resolver de la vista de DETALLE — WKH-369.
 *
 * CD-7: `discoveryService` NO se mockea. `mapAgent` corre de verdad en los DOS
 * caminos (lista y detalle) porque el doble está en el `fetch` y responde SEGÚN
 * LA URL: el `discoveryEndpoint` devuelve el payload de lista (con `tags`) y el
 * `agentEndpoint` devuelve el de detalle (SIN `tags`). Ésa es la divergencia
 * medida en producción, y es la razón de que este bug haya sobrevivido: los
 * tests de ruta mockeaban el service entero, así que el mapper nunca corría.
 *
 * CD-1: el fixture tiene un agente federado con CUATRO capacidades no vacías.
 * Un fixture vacío pasa con el bug puesto.
 *
 * CD-6: todo valor esperado está escrito literal, a mano. Ninguno se deriva
 * llamando a `mapAgent`, a `discover()` ni al propio resolver.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, RegistryConfig } from '../types/index.js';
import { SELF_PUBLISHED_REGISTRY_ID } from '../types/index.js';

const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({ getLogger: () => logSpy }));

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

// Exemplar C: LAS DOS son obligatorias. `ssrfFetch` usa el `fetch` PROPIO de
// undici, no el global; doblar uno solo deja el otro camino sin interceptar.
const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.stubGlobal('fetch', mockFetch);
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: mockFetch };
});

// Sin filas de identidad: `attachIdentities` / `getAgent` corren de verdad y
// no agregan `identity` a ningún agente.
vi.mock('../lib/supabase.js', () => {
  const builder = {
    select: vi.fn(() => builder),
    not: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    // biome-ignore lint/suspicious/noThenProperty: mock mirrors PostgREST thenable
    then: (resolve: (v: { data: unknown; error: unknown }) => void): void => {
      resolve({ data: [], error: null });
    },
  };
  return { supabase: { from: vi.fn(() => builder) } };
});

vi.mock('./reputation.js', () => ({
  reputationService: {
    computeReputationBatch: async () => new Map(),
    computeStandingBatch: async () => ({
      degraded: false,
      standings: new Map(),
    }),
    computeReputationForAgent: vi.fn(),
  },
}));

// Exemplar C (extra 1): `discovery.ts` consume `publishedAgentService` en los
// dos caminos. Sin doble, el supabase falso lo resuelve de forma no
// determinista.
const { mockListAsAgents, mockGetBySlugAsAgent } = vi.hoisted(() => ({
  mockListAsAgents: vi.fn(),
  mockGetBySlugAsAgent: vi.fn(),
}));
vi.mock('./agent.js', () => ({
  publishedAgentService: {
    listAsAgents: mockListAsAgents,
    getBySlugAsAgent: mockGetBySlugAsAgent,
    listPublisherAnchors: vi.fn(async () => ({ degraded: true })),
  },
}));

import { resolveAgentForDetailView } from './agent-detail.js';
import { discoveryService } from './discovery.js';
import { registryService } from './registry.js';

// ─── Fixture (§7.1) — la forma MEDIDA en producción, no inventada ──────────

const REGISTRY_ID = 'wasiai';
const REGISTRY_NAME = 'WasiAI'; // ⚠️ id !== name: es la mitad del valor del fixture (CD-10)
const CAPS_FED = ['remittance', 'remit', 'kyc', 'compliance'];

function makeRegistry(): RegistryConfig {
  return {
    id: REGISTRY_ID,
    name: REGISTRY_NAME,
    discoveryEndpoint: 'https://example.com/agents',
    invokeEndpoint: 'https://example.com/invoke/{slug}',
    agentEndpoint: 'https://example.com/agent/{slug}',
    schema: {
      discovery: {
        agentMapping: {
          capabilities: 'tags',
          price: 'price_per_call_usdc',
          reputation: 'erc8004.reputation_score',
        },
      },
      invoke: { method: 'POST' },
    },
    enabled: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ownerRef: 'system',
  };
}

/** Payloads de LISTA: lo que devuelve el `discoveryEndpoint`. */
function listPayload(): Record<string, unknown>[] {
  return [
    {
      id: 'a-fed-1',
      name: 'Fed Con Caps',
      slug: 'fed-con-caps',
      description: 'Agente federado con capacidades',
      tags: [...CAPS_FED],
      price_per_call_usdc: 0.001,
      erc8004: { reputation_score: 7 },
      status: 'active',
    },
    {
      id: 'a-fed-2',
      name: 'Fed Sin Caps',
      slug: 'fed-sin-caps',
      description: 'Agente federado sin capacidades',
      tags: [],
      price_per_call_usdc: 0.002,
      status: 'active',
    },
  ];
}

/**
 * Payloads de DETALLE: lo que devuelve el `agentEndpoint`. NO traen `tags`,
 * ni `erc8004`, ni `price_per_call_usdc` — ésa es la divergencia medida.
 */
function detailPayload(slug: string): Record<string, unknown> | null {
  if (slug === 'fed-con-caps' || slug === 'fed-fuera-del-listado') {
    return {
      id: slug === 'fed-con-caps' ? 'a-fed-1' : 'a-fed-3',
      name: slug === 'fed-con-caps' ? 'Fed Con Caps' : 'Fed Fuera Del Listado',
      slug,
      description: 'Agente federado con capacidades',
      category: 'compliance',
      price_per_call: 0.001,
      reputation: { score: null, count: 0 },
      status: 'active',
    };
  }
  if (slug === 'fed-sin-caps') {
    // Sin `price_per_call`: fija el residual de precio de T-06b(b).
    return {
      id: 'a-fed-2',
      name: 'Fed Sin Caps',
      slug: 'fed-sin-caps',
      description: 'Agente federado sin capacidades',
      category: 'compliance',
      reputation: { score: null, count: 0 },
      status: 'active',
    };
  }
  return null;
}

function makeSelfAgent(): Agent {
  return {
    id: 'self-1',
    name: 'Self Agent',
    slug: 'self-agent',
    description: 'Agente self-published',
    capabilities: ['weather', 'geo'],
    priceUsdc: 0.005,
    reputation: 0,
    registry: 'self-published',
    registry_id: SELF_PUBLISHED_REGISTRY_ID,
    invokeUrl: 'https://example.com/invoke/self-agent',
    invocationNote: 'note',
    verified: false,
    status: 'active',
  };
}

/** Enruta el doble por URL: sin esto `mapAgent` no corre en los dos caminos. */
function routeFetchByUrl(): void {
  mockFetch.mockImplementation(async (input: unknown) => {
    const url = String(input);
    if (url.startsWith('https://example.com/agents')) {
      return { ok: true, json: () => Promise.resolve(listPayload()) };
    }
    const m = url.match(/^https:\/\/example\.com\/agent\/(.+)$/);
    const raw = m?.[1] ? detailPayload(m[1]) : null;
    if (!raw)
      return { ok: false, status: 404, json: () => Promise.resolve({}) };
    return { ok: true, json: () => Promise.resolve(raw) };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  routeFetchByUrl();
  vi.mocked(registryService.getEnabled).mockResolvedValue([makeRegistry()]);
  vi.mocked(registryService.getWithSecrets).mockImplementation(async (id) =>
    id === REGISTRY_ID ? makeRegistry() : undefined,
  );
  // Copia nueva por llamada: si lista y detalle compartieran instancia, la
  // comparación de paridad se leería a sí misma (CD-6).
  mockListAsAgents.mockImplementation(async () => [makeSelfAgent()]);
  mockGetBySlugAsAgent.mockImplementation(async (slug: string) =>
    slug === 'self-agent' ? makeSelfAgent() : null,
  );
});

afterEach(() => {
  mockFetch.mockReset();
});

// ─── Clasificador de paridad (AC-3) ───────────────────────────────────────

type Bucket = 'difiere' | 'coincideConContenido' | 'coincideEnVacio';

function clasificar(lista: string[], detalle: string[]): Bucket {
  const iguales =
    lista.length === detalle.length && lista.every((c, i) => c === detalle[i]);
  if (!iguales) return 'difiere';
  return detalle.length > 0 ? 'coincideConContenido' : 'coincideEnVacio';
}

const SLUGS_MEDIDOS = [
  'fed-con-caps',
  'fed-sin-caps',
  'fed-fuera-del-listado',
  'self-agent',
] as const;

async function medirParidad(
  detalleDe: (slug: string) => Promise<Agent | null>,
): Promise<Record<Bucket, number>> {
  const listado = await discoveryService.discover({ includeInactive: true });
  const conteo: Record<Bucket, number> = {
    difiere: 0,
    coincideConContenido: 0,
    coincideEnVacio: 0,
  };
  for (const slug of SLUGS_MEDIDOS) {
    const enLista = listado.agents.find((a) => a.slug === slug);
    const detalle = await detalleDe(slug);
    conteo[
      clasificar(enLista?.capabilities ?? [], detalle?.capabilities ?? [])
    ]++;
  }
  return conteo;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('WKH-369 · resolveAgentForDetailView', () => {
  it('T-01 (AC-1): el detalle federado publica las capacidades de la LISTA', async () => {
    const agent = await resolveAgentForDetailView('fed-con-caps');

    expect(agent?.capabilities).toEqual([
      'remittance',
      'remit',
      'kyc',
      'compliance',
    ]);
  });

  it('T-02a (AC-2): fuera del listado ⇒ `unresolved`, y `capabilities` sigue vacío', async () => {
    const agent = await resolveAgentForDetailView('fed-fuera-del-listado');

    expect(agent?.capabilitiesState).toBe('unresolved');
    expect(agent?.capabilities).toEqual([]);
  });

  it('T-02b (AC-2): resuelto y vacío ⇒ la clave `capabilitiesState` está AUSENTE', async () => {
    const agent = await resolveAgentForDetailView('fed-sin-caps');

    expect(agent?.capabilities).toEqual([]);
    expect('capabilitiesState' in (agent as object)).toBe(false);
  });

  it('T-02c (AC-2): si `discover()` rechaza, se degrada a `unresolved` sin propagar', async () => {
    // El rechazo se inyecta en la dependencia REAL de `discover()`
    // (`getWithSecrets`), no doblando `discoveryService` (CD-7). `getAgent`
    // usa `getEnabled()`, así que el detalle sigue resolviendo.
    vi.mocked(registryService.getWithSecrets).mockRejectedValue(
      new Error('registry down'),
    );

    const agent = await resolveAgentForDetailView('fed-con-caps');

    expect(agent?.capabilitiesState).toBe('unresolved');
    expect(agent?.capabilities).toEqual([]);
  });

  it('T-03 (AC-3/AC-4/CD-1): partición de TRES estados, sin ninguna divergencia', async () => {
    const conteo = await medirParidad((slug) =>
      resolveAgentForDetailView(slug),
    );

    expect(conteo.difiere).toBe(0);
    // CD-1 mecanizada: con un fixture de capacidades vacías esto es imposible.
    expect(conteo.coincideConContenido).toBeGreaterThanOrEqual(1);
    expect(conteo.coincideEnVacio).toBeGreaterThanOrEqual(1);
  });

  it('T-04 (AC-4): la tasa se calcula sobre la población que PUEDE exhibir el defecto', async () => {
    // Se mide el camino CON el defecto (`getAgent` pelado) a propósito: con el
    // camino arreglado el numerador es 0 y `0/2 === 0/4`, así que la elección
    // del denominador sería inobservable.
    const conteo = await medirParidad((slug) =>
      discoveryService.getAgent(slug),
    );

    expect(conteo.difiere).toBe(1);
    expect(conteo.coincideConContenido).toBe(1);
    expect(conteo.coincideEnVacio).toBe(2);

    const poblacion = conteo.difiere + conteo.coincideConContenido;
    const tasa = Math.round((100 * conteo.difiere) / poblacion);

    expect(tasa).toBe(50);
  });

  it('T-06a (AC-6): `reputation` sale de la lista (7), no del detalle (NaN)', async () => {
    const agent = await resolveAgentForDetailView('fed-con-caps');

    expect(agent?.reputation).toBe(7);
  });

  it('T-06b (AC-6/TD-369-4): el precio del detalle depende del fallback, no de un detalle sano', async () => {
    // (a) el detalle trae `price_per_call` ⇒ lo salva `V2_PRICE_FALLBACK_FIELD`.
    const conCaps = await resolveAgentForDetailView('fed-con-caps');
    expect(conCaps?.priceUsdc).toBe(0.001);

    // (b) el detalle NO trae `price_per_call` ⇒ 0, y DIVERGE de la lista.
    const sinCaps = await resolveAgentForDetailView('fed-sin-caps');
    expect(sinCaps?.priceUsdc).toBe(0);

    const listado = await discoveryService.discover({ includeInactive: true });
    const enLista = listado.agents.find((a) => a.slug === 'fed-sin-caps');
    expect(enLista?.priceUsdc).toBe(0.002);
  });

  it('T-09: un self-published no paga I/O de catálogo', async () => {
    const discoverSpy = vi.spyOn(discoveryService, 'discover');
    const antes = mockFetch.mock.calls.length;

    const agent = await resolveAgentForDetailView('self-agent');

    expect(agent?.capabilities).toEqual(['weather', 'geo']);
    expect(mockFetch.mock.calls.length - antes).toBe(0);
    // Segunda aserción, y NO es redundante: con `registry_id` =
    // 'self-published', `discover()` resuelve por el merge LOCAL y no emite
    // ningún fetch, así que el contador solo no mata el mutante.
    expect(discoverSpy).not.toHaveBeenCalled();
  });

  it('T-10 (CD-10): el catálogo se pide por registry_id, NUNCA por nombre', async () => {
    // `?registry=WasiAI` (el nombre) devuelve 0 agentes y se anuncia
    // `complete`: no da error, da un catálogo vacío que parece completo.
    const discoverSpy = vi.spyOn(discoveryService, 'discover');

    await resolveAgentForDetailView('fed-con-caps');

    expect(discoverSpy).toHaveBeenCalledWith({
      registry: 'wasiai',
      includeInactive: true,
    });
  });
});
