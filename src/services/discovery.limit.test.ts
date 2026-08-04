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

// WKH-318 corte B: el factory anterior (`() => ({ warn: vi.fn(), ... })`) creaba
// un objeto NUEVO en cada llamada, así que el test no podía alcanzar el `vi.fn()`
// que `discovery.ts:68` capturó al importar. Patrón hoisted, exemplar
// `compose.test.ts:17-23`. `vi.clearAllMocks()` del beforeEach lo limpia.
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
    // WKH-313: el consumidor real de `attachReputations`. Sin standings y SIN
    // degradación: nadie tiene historial, la lectura funcionó.
    computeStandingBatch: vi
      .fn()
      .mockResolvedValue({ degraded: false, standings: new Map() }),
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

  // ─── WKH-318 corte B: el clamp al techo declarado por el registry ──────────
  //
  // ⚠️ CD-7. Todas las aserciones de límite de acá abajo comparan contra el
  // número LITERAL entre comillas, leído de la query string que salió. Escribir
  // `String(Math.min(resolveUpstreamFetchLimit(500), 100))` haría que el test
  // recalcule la fórmula que vigila: invertir `Math.min` por `Math.max` en
  // producción Y en el test dejaría el test verde (el mutante M3 sobreviviría).

  /**
   * `maxLimit` entra como `unknown` a propósito: la columna es `jsonb` y el
   * write-path de `POST /registries` la guarda sin validar, así que en runtime
   * puede llegar cualquier cosa. El cast reproduce exactamente ese agujero.
   */
  function registryWithMaxLimit(declared: unknown): RegistryConfig {
    return makeRegistry({
      schema: {
        discovery: { limitParam: 'limit', maxLimit: declared as number },
        invoke: { method: 'POST' },
      },
    });
  }

  it('T-CLAMP-01: maxLimit declarado recorta el over-fetch (AC-1, CD-9a)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([
      registryWithMaxLimit(100),
    ]);
    const { upstreamLimits } = serveHonoringLimit(catalog(10));

    await discoveryService.discover({ limit: 500 });

    // Sin clamp saldría '500' (el caller gana al over-fetch, T-6).
    expect(upstreamLimits).toEqual(['100']);
    // Hubo clamp (100 < 500) pero 100 NO cae bajo el piso del pool: el warn del
    // piso NO se emite. Mata al mutante MA2 (borrar la mitad
    // `isBelowComposePoolFloor(sentLimit)` del guard de `discovery.ts:1106`),
    // que sin esto sobrevive con la suite completa en verde.
    expect(logSpy.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({
        error_code: 'REGISTRY_MAX_LIMIT_BELOW_COMPOSE_POOL',
      }),
      expect.anything(),
    );
  });

  it('T-CLAMP-02: SIN maxLimit el número enviado es byte-idéntico al de hoy, y no hay warn (AC-2, CD-9b)', async () => {
    // Los tres sub-casos replican T-4, T-6 y T-5 contra el MISMO registry sin
    // `maxLimit`: si el clamp dejara de ser aditivo, alguno cambiaría.
    const a = serveHonoringLimit(catalog(10, 3));
    await discoveryService.discover({ limit: 5 });
    expect(a.upstreamLimits).toEqual(['200']);

    const b = serveHonoringLimit(catalog(10));
    await discoveryService.discover({ limit: 500 });
    expect(b.upstreamLimits).toEqual(['500']);

    process.env.DISCOVERY_UPSTREAM_FETCH_LIMIT = '300';
    const c = serveHonoringLimit(catalog(10));
    await discoveryService.discover({ limit: 5 });
    expect(c.upstreamLimits).toEqual(['300']);

    // 4º sub-caso: el operador baja el over-fetch por env POR DEBAJO del piso
    // del pool, SIN `maxLimit` declarado. El número enviado (10) cae bajo 50 y
    // aun así NO warnea: el warn es del clamp, no del env. Mata al mutante MA1
    // (borrar la mitad `sentLimit < unclamped` del guard de `discovery.ts:1106`),
    // que sin esto sobrevive con la suite completa en verde.
    process.env.DISCOVERY_UPSTREAM_FETCH_LIMIT = '10';
    const d = serveHonoringLimit(catalog(10));
    await discoveryService.discover({ limit: 5 });
    expect(d.upstreamLimits).toEqual(['10']);

    // Ausencia de declaración NO es declaración inválida: `undefined` no warnea.
    // Ninguno de los dos códigos: el registry de este test nunca declaró techo,
    // así que ni el warn de techo basura ni el del piso tienen de dónde salir.
    expect(logSpy.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ error_code: 'REGISTRY_MAX_LIMIT_INVALID' }),
      expect.anything(),
    );
    expect(logSpy.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({
        error_code: 'REGISTRY_MAX_LIMIT_BELOW_COMPOSE_POOL',
      }),
      expect.anything(),
    );
  });

  it('T-CLAMP-02b: SIN limit del caller no se manda limitParam, aunque haya maxLimit (AC-2, CD-2, CD-9d)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([
      registryWithMaxLimit(100),
    ]);
    const { upstreamLimits } = serveHonoringLimit(catalog(10, 3));

    await discoveryService.discover({});

    // El clamp vive DENTRO del gate: imponer un cap donde antes no había
    // ninguno reintroduciría el bug de clase "esconder agentes".
    expect(upstreamLimits).toEqual([null]);
  });

  it('T-CLAMP-02c: registry SIN limitParam nunca recibe el parámetro, aunque declare maxLimit (AC-2, CD-9e)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([
      makeRegistry({
        schema: { discovery: { maxLimit: 100 }, invoke: { method: 'POST' } },
      }),
    ]);
    const { upstreamLimits } = serveHonoringLimit(catalog(10, 3));

    await discoveryService.discover({ limit: 500 });

    expect(upstreamLimits).toEqual([null]);
  });

  it('T-CLAMP-06: el schema parseado del MISMO literal jsonb que escribe la migración clampea sin código extra (AC-6)', async () => {
    // La fuente del 100 es el texto de
    // `supabase/migrations/20260804000000_wkh318b_registry_max_limit.sql`, no
    // una constante nuestra: si la migración escribiera otra clave o el lector
    // mirara otro path, este test se cae.
    const discoveryFromJsonb = JSON.parse(
      '{"limitParam":"limit","nextCursorPath":"next_cursor","maxLimit":100}',
    ) as RegistryConfig['schema']['discovery'];
    vi.mocked(registryService.getEnabled).mockResolvedValue([
      makeRegistry({
        schema: { discovery: discoveryFromJsonb, invoke: { method: 'POST' } },
      }),
    ]);
    const { upstreamLimits } = serveHonoringLimit(catalog(10));

    await discoveryService.discover({ limit: 500 });

    expect(upstreamLimits).toEqual(['100']);
  });

  it('T-CLAMP-08: un maxLimit inválido NO clampea y avisa — nunca falla cerrado (CD-13, CD-9c)', async () => {
    // CD-13: con `maxLimit: 0`, degradar a `?limit=0` dejaría el catálogo casi
    // vacío EN SILENCIO. Ignorar el techo deja que el registry conteste; si su
    // techo real es menor, contesta 400, que es visible.
    const invalidos: unknown[] = ['100', 'abc', 0, -5, 1.5, null, {}];

    for (const declared of invalidos) {
      logSpy.warn.mockClear();
      vi.mocked(registryService.getEnabled).mockResolvedValue([
        registryWithMaxLimit(declared),
      ]);
      const { upstreamLimits } = serveHonoringLimit(catalog(10));

      await discoveryService.discover({ limit: 5 });

      // Ni 'NaN' (que es lo que devuelve `Math.min(200, "abc")`), ni '0', ni '1'.
      expect(upstreamLimits).toEqual(['200']);
      expect(logSpy.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error_code: 'REGISTRY_MAX_LIMIT_INVALID' }),
        expect.anything(),
      );
    }
  });
});
