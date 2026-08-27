/**
 * Testigos del BORDE HTTP y de AC-7 — WKH-369.
 *
 * CD-7: ⛔ `../services/discovery.js` NO se mockea. El patrón de
 * `discover.test.ts` (que dobla `discoveryService` entero) es la razón MEDIDA de
 * que este bug haya sobrevivido: con `getAgent` doblado, `mapAgent` nunca corre
 * en la ruta de detalle y ninguna cantidad de tests de esa ruta puede cazarlo.
 * Acá el doble está en el `fetch` y responde SEGÚN LA URL.
 *
 * CD-6: el literal de T-07a está escrito a mano leyendo `mapAgent`, no copiado
 * de una corrida.
 */
import Fastify from 'fastify';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { registerErrorBoundary } from '../middleware/error-boundary.js';
import { registerRateLimit } from '../middleware/rate-limit.js';
import type { RegistryConfig } from '../types/index.js';

const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({ getLogger: () => logSpy }));

vi.mock('../services/registry.js', () => ({
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

vi.mock('../services/reputation.js', () => ({
  reputationService: {
    computeReputationBatch: async () => new Map(),
    computeStandingBatch: async () => ({
      degraded: false,
      standings: new Map(),
    }),
    computeReputationForAgent: async () => null,
  },
}));

const { mockListAsAgents, mockGetBySlugAsAgent } = vi.hoisted(() => ({
  mockListAsAgents: vi.fn(),
  mockGetBySlugAsAgent: vi.fn(),
}));
vi.mock('../services/agent.js', () => ({
  publishedAgentService: {
    listAsAgents: mockListAsAgents,
    getBySlugAsAgent: mockGetBySlugAsAgent,
    listPublisherAnchors: vi.fn(async () => ({ degraded: true })),
  },
}));

import { discoveryService } from '../services/discovery.js';
import { registryService } from '../services/registry.js';
import agentCardRoutes from './agent-card.js';
import discoverRoutes from './discover.js';

const CAPS_FED = ['remittance', 'remit', 'kyc', 'compliance'];
const CAPS_DETALLE_RICO = ['payments', 'kyc'];
const CAPS_INACTIVO = ['telemetry'];

function makeRegistry(): RegistryConfig {
  return {
    id: 'wasiai',
    name: 'WasiAI',
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

/**
 * LISTA: trae `tags`. DETALLE: no los trae. Ésa es la divergencia medida.
 *
 * ⚠️ CR MNR-3: estas dos funciones son una COPIA de las de
 * `../services/agent-detail.test.ts`, y ya habían divergido una vez — las dos
 * decían ser «la forma medida en producción» y no eran la misma
 * (`price_per_call` presente en una y ausente en la otra). Dos copias de un
 * contrato que no coinciden es el defecto que esta HU arregla, movido al arnés.
 * **Si tocás una, tocá la otra.** Unificarlas en un helper compartido exige un
 * archivo fuera del Scope IN de la HU: queda declarado como `TD-369-7`.
 */
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
    {
      id: 'a-fed-4',
      name: 'Fed Inactivo',
      slug: 'fed-inactivo',
      description: 'Agente federado inactivo',
      tags: [...CAPS_INACTIVO],
      price_per_call_usdc: 0.003,
      status: 'inactive',
    },
  ];
}

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
  if (slug === 'fed-detalle-rico') {
    return {
      id: 'a-fed-5',
      name: 'Fed Detalle Rico',
      slug: 'fed-detalle-rico',
      description: 'Agente federado cuyo detalle sí publica capacidades',
      category: 'compliance',
      tags: [...CAPS_DETALLE_RICO],
      price_per_call: 0.001,
      reputation: { score: null, count: 0 },
      status: 'active',
    };
  }
  if (slug === 'fed-inactivo') {
    return {
      id: 'a-fed-4',
      name: 'Fed Inactivo',
      slug: 'fed-inactivo',
      description: 'Agente federado inactivo',
      category: 'compliance',
      price_per_call: 0.003,
      reputation: { score: null, count: 0 },
      status: 'inactive',
    };
  }
  return null;
}

/** `listOnly` deja UN solo agente en la lista para que el literal de T-07a sea legible. */
function routeFetchByUrl(listOnly?: string): void {
  mockFetch.mockImplementation(async (input: unknown) => {
    const url = String(input);
    if (url.startsWith('https://example.com/agents')) {
      const rows = listOnly
        ? listPayload().filter((r) => r.slug === listOnly)
        : listPayload();
      return { ok: true, json: () => Promise.resolve(rows) };
    }
    const m = url.match(/^https:\/\/example\.com\/agent\/(.+)$/);
    const raw = m?.[1] ? detailPayload(m[1]) : null;
    if (!raw)
      return { ok: false, status: 404, json: () => Promise.resolve({}) };
    return { ok: true, json: () => Promise.resolve(raw) };
  });
}

async function buildApp(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify();
  await app.register(discoverRoutes, { prefix: '/discover' });
  await app.register(agentCardRoutes, { prefix: '/agents' });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  routeFetchByUrl();
  vi.mocked(registryService.getEnabled).mockResolvedValue([makeRegistry()]);
  vi.mocked(registryService.getWithSecrets).mockImplementation(async (id) =>
    id === 'wasiai' ? makeRegistry() : undefined,
  );
  mockListAsAgents.mockImplementation(async () => []);
  mockGetBySlugAsAgent.mockImplementation(async () => null);
});

describe('WKH-369 · borde HTTP del detalle federado', () => {
  it('T-08 (AC-1): GET /discover/:slug devuelve 200 con las 4 capacidades', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/discover/fed-con-caps',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.capabilities).toHaveLength(4);
      expect(body.capabilities).toEqual([
        'remittance',
        'remit',
        'kyc',
        'compliance',
      ]);
      expect(body.capabilitiesState).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('T-05 (AC-5): GET /agents/:slug/agent-card deriva las 4 skills', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/agents/fed-con-caps/agent-card',
      });

      expect(res.statusCode).toBe(200);
      const card = res.json();
      expect(card.skills).toHaveLength(4);
      expect(card.skills.map((s: { id: string }) => s.id)).toEqual([
        'remittance',
        'remit',
        'kyc',
        'compliance',
      ]);
    } finally {
      await app.close();
    }
  });
});

describe('WKH-369 · AC-7 — la LISTA sale byte-idéntica', () => {
  it('T-07a: `discover({})` produce EXACTAMENTE el literal escrito a mano', async () => {
    routeFetchByUrl('fed-con-caps');

    const result = await discoveryService.discover({});

    // Literal derivado LEYENDO `mapAgent`, campo por campo y en su orden de
    // inserción. `payment` sale `undefined` (el crudo no declara `payment`) y
    // `JSON.stringify` omite las claves `undefined`; `computedReputation` e
    // `identity` no se asignan porque sus fuentes vienen vacías.
    const esperado =
      '{"id":"a-fed-1",' +
      '"name":"Fed Con Caps",' +
      '"slug":"fed-con-caps",' +
      '"description":"Agente federado con capacidades",' +
      '"capabilities":["remittance","remit","kyc","compliance"],' +
      '"priceUsdc":0.001,' +
      '"reputation":7,' +
      '"verified":false,' +
      '"status":"active",' +
      '"registry":"WasiAI",' +
      '"registry_id":"wasiai",' +
      '"invokeUrl":"https://example.com/invoke/fed-con-caps",' +
      '"invocationNote":"The invokeUrl is an internal reference. To invoke this agent, use POST /compose or POST /orchestrate on the WasiAI A2A gateway.",' +
      '"metadata":{"id":"a-fed-1","name":"Fed Con Caps","slug":"fed-con-caps",' +
      '"description":"Agente federado con capacidades",' +
      '"tags":["remittance","remit","kyc","compliance"],' +
      '"price_per_call_usdc":0.001,' +
      '"erc8004":{"reputation_score":7},' +
      '"status":"active"}}';

    expect(JSON.stringify(result.agents[0])).toBe(esperado);
  });

  it('T-07b: ningún agente de la LISTA publica la clave `capabilitiesState`', async () => {
    const result = await discoveryService.discover({});

    // Cubre también al federado con `tags: []`, que es el que un marcador
    // puesto "cuando está vacío" contaminaría primero.
    expect(result.agents.length).toBeGreaterThanOrEqual(2);
    for (const agent of result.agents) {
      expect(Object.keys(agent)).not.toContain('capabilitiesState');
    }
  });
});

// ─── Fix-pack del AR/CR ─────────────────────────────────────────────────────

describe('WKH-369 · TD-369-6 — el marcador NO llega al Agent Card (deuda declarada)', () => {
  it('T-14 (CR BLQ-BAJO-1): /discover/:slug marca `unresolved`; el agent-card publica `skills: []` sin marcador', async () => {
    const app = await buildApp();
    try {
      // El mismo agente, por los DOS caminos de detalle que AC-5 inscribe.
      const detalle = await app.inject({
        method: 'GET',
        url: '/discover/fed-fuera-del-listado',
      });
      const card = await app.inject({
        method: 'GET',
        url: '/agents/fed-fuera-del-listado/agent-card',
      });

      expect(detalle.statusCode).toBe(200);
      expect(detalle.json().capabilities).toEqual([]);
      expect(detalle.json().capabilitiesState).toBe('unresolved');

      // 🔴 TD-369-6, PINEADO en vez de silenciado. `services/agent-card.ts:124`
      // construye la card campo por campo (no hay `...agent`), así que
      // `capabilitiesState` se pierde y `skills: []` vuelve a ser
      // indistinguible de «no tiene ninguna» — la misma ambigüedad que esta HU
      // mata en la otra ruta. NO se arregla acá: `services/agent-card.ts` está
      // fuera del Scope IN, y el `AgentCard` es un artefacto de protocolo A2A
      // cuyo campo aditivo tiene su propio costo para todo consumidor A2A.
      // No hay regresión: hoy TODAS las cards federadas salían vacías.
      // Cuando se cierre TD-369-6, este test se pone rojo. Es el punto.
      expect(card.statusCode).toBe(200);
      expect(card.json().skills).toEqual([]);
      expect(card.json().capabilitiesState).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

describe('WKH-369 · AR BLQ-BAJO-3 — /discover/:slug ya NO está exento de rate limit', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    // El límite se lee en `registerRateLimit`, así que la env va ANTES.
    process.env.RATE_LIMIT_MAX = '2';
    process.env.RATE_LIMIT_WINDOW_MS = '60000';

    app = Fastify();
    // CD-10 de WKH-AUDIT-A2A: el error-boundary se registra ANTES que el
    // rate-limit, que THROWS en vez de responder.
    registerErrorBoundary(app);
    await registerRateLimit(app);
    await app.register(discoverRoutes, { prefix: '/discover' });
    await app.ready();
  });

  afterAll(async () => {
    delete process.env.RATE_LIMIT_MAX;
    delete process.env.RATE_LIMIT_WINDOW_MS;
    await app.close();
  });

  it('T-15: la request N+1 al detalle federado devuelve 429 con `RATE_LIMIT_EXCEEDED`', async () => {
    // La exención venía de `bd7ea69`, concedida sobre la premisa «read-only and
    // cheap to serve». Esta HU la invalidó: cada detalle federado dispara ahora
    // un `discover()` completo (over-fetch de hasta 200 filas + una query de
    // identidad por fila que declare token). El testigo es de COMPORTAMIENTO, no
    // de la forma del objeto de config: un `{ config: {} }` vacío también
    // "no declara `rateLimit: false`" y no probaría nada.
    for (let i = 0; i < 2; i++) {
      const ok = await app.inject({
        method: 'GET',
        url: '/discover/fed-con-caps',
      });
      expect(ok.statusCode).toBe(200);
    }

    const limited = await app.inject({
      method: 'GET',
      url: '/discover/fed-con-caps',
    });

    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe('RATE_LIMIT_EXCEEDED');
  });
});
