/**
 * WKH-318 (W1) — `/discover` deja de afirmar que consultó un registro que no
 * contestó.
 *
 * El bug medido en producción el 2026-07-30: el registro federado `WasiAI`
 * respondía HTTP 400 al over-fetch, el fanout se lo tragaba con `.catch(() => [])`
 * y la respuesta seguía diciendo `registries: ["WasiAI","self-published"]`. El
 * caller leía "consulté las dos fuentes" sobre 3 de 23 agentes.
 *
 * Lo que se fija acá:
 *   · `registries` = las fuentes que APORTARON FILAS, no las configuradas.
 *   · `sources[]`  = estado por fuente, con `rows: null` ≠ `rows: 0`.
 *   · `catalogStatus` = roll-up, precedencia partial > truncated > unverified >
 *     complete.
 *   · (AR BLQ-1) `ok` exige EVIDENCIA de completitud; sin evidencia obtenible el
 *     estado es `unverified`, no `ok`.
 *   · (AR BLQ-2) la fuente local declara su propio fallo en vez de desaparecer.
 *
 * Los mocks son los de `discovery.limit.test.ts:20-62` (el exemplar), con dos
 * agregados: el breaker puede abrirse a pedido (para `circuit_open`) y el
 * `fetch` despacha por hostname (para probar varias fuentes a la vez).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegistryConfig } from '../types/index.js';

vi.mock('../lib/logger.js', () => ({
  getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

// Mismo scaffold que `discovery.ssrf.test.ts:24-30`: sin esto, un host de
// fantasía como `healthy.example.org` no resuelve y el guard SSRF lo tumba
// ANTES del fetch — la fuente "sana" del test aparecería caída y el test
// probaría lo contrario de lo que dice. Los IPs literales privados
// (`127.0.0.1`) se siguen rechazando sin DNS, así que el caso `ssrf_blocked`
// de abajo no depende de este mock.
const mockLookup = vi.fn();
vi.mock('node:dns', () => ({
  promises: { lookup: (...args: unknown[]) => mockLookup(...args) },
}));

vi.mock('./registry.js', () => ({
  registryService: {
    getEnabled: vi.fn(),
    get: vi.fn(),
    getWithSecrets: vi.fn(),
  },
}));

// El breaker real (para que `CircuitOpenError` sea la clase de verdad y su
// `name` sea el que `classifyFetchFailure` lee), con un interruptor de test.
const { breakerState } = vi.hoisted(() => ({
  breakerState: { open: false },
}));
vi.mock('../lib/circuit-breaker.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../lib/circuit-breaker.js')>();
  return {
    ...actual,
    getRegistryCircuitBreaker: (name: string) => ({
      execute: (fn: () => Promise<Response>) =>
        breakerState.open
          ? Promise.reject(new actual.CircuitOpenError(name))
          : fn(),
    }),
  };
});

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

import { publishedAgentService } from './agent.js';
import { discoveryService } from './discovery.js';
import { registryService } from './registry.js';

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

function catalog(n: number, prefix = 'agent'): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${i}`,
    slug: `${prefix}-${i}`,
    name: `Agent ${i}`,
    description: 'desc',
    capabilities: ['x'],
    price: 0,
    reputation: 10,
    status: 'active',
  }));
}

/** Respuesta OK con un payload arbitrario. */
function okResponse(payload: unknown): Promise<unknown> {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
}

/**
 * Despacha el fetch por hostname, para poder tener una fuente sana y una rota
 * en la misma corrida.
 */
function serveByHost(routes: Record<string, () => Promise<unknown>>): void {
  mockFetch.mockImplementation((url: string) => {
    const host = new URL(url).hostname;
    const route = routes[host];
    if (!route) throw new Error(`test: host no ruteado: ${host}`);
    return route();
  });
}

describe('WKH-318 — honestidad de `registries` / `sources` / `catalogStatus`', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    breakerState.open = false;
    // Se replica la semántica REAL de `dns.lookup`: un IP literal se devuelve
    // tal cual (`url-validator.ts:293`), un nombre resuelve a un IP público.
    // Devolver un IP público para TODO haría que `127.0.0.1` pasara el guard y
    // el caso `ssrf_blocked` probaría lo contrario de lo que dice.
    mockLookup.mockImplementation((host: string) =>
      Promise.resolve([
        /^\d+\.\d+\.\d+\.\d+$/.test(host)
          ? { address: host, family: 4 }
          : { address: '93.184.216.34', family: 4 },
      ]),
    );
    delete process.env.DISCOVERY_UPSTREAM_FETCH_LIMIT;
    vi.mocked(publishedAgentService.listAsAgents).mockResolvedValue([]);
    vi.mocked(registryService.getEnabled).mockResolvedValue([makeRegistry()]);
  });

  it('T-SRC-01: una fuente que responde 500 se declara failed/rows:null/http_error, NO aparece en `registries`, y el catálogo es partial', async () => {
    serveByHost({
      'example.com': () => Promise.resolve({ ok: false, status: 500 }),
    });

    const result = await discoveryService.discover({});

    // 2 fuentes: la federada caída y la local (consultada, sin agentes).
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0]).toEqual({
      name: 'test-registry',
      state: 'failed',
      // CD-14: `null`, NUNCA 0. "No pude preguntarle" no es "no tiene".
      rows: null,
      failure: 'http_error',
    });
    expect(result.sources[0]?.rows).not.toBe(0);
    // LA MENTIRA QUE ESTA HU MATA: antes, acá decía ['test-registry'].
    expect(result.registries).toEqual([]);
    expect(result.catalogStatus).toBe('partial');
  });

  it('T-SRC-02: una fuente que responde 200 con [] es ok/rows:0 (no null), el catálogo es complete, y aun así no figura en `registries`', async () => {
    serveByHost({ 'example.com': () => okResponse([]) });

    // Con `limit` se envía `limitParam`, y 0 filas < 200 pedidas es EVIDENCIA de
    // que no quedó nada afuera. Sin evidencia el estado sería `unverified`
    // (T-SRC-08), y este test dejaría de hablar de lo que quiere hablar: la
    // diferencia entre `rows: 0` y `rows: null`.
    const result = await discoveryService.discover({ limit: 5 });

    expect(result.sources).toHaveLength(2);
    expect(result.sources[0]).toEqual({
      name: 'test-registry',
      state: 'ok',
      // La otra mitad de la distinción: le preguntamos y NO TIENE. Eso es 0.
      rows: 0,
    });
    expect(result.sources[0]?.rows).toBe(0);
    expect(result.sources[0]?.failure).toBeUndefined();
    // No aportó filas ⇒ no contribuyó. Su estado sigue siendo legible en
    // `sources`, que es donde vive la diferencia con el caso 500.
    expect(result.registries).toEqual([]);
    expect(result.catalogStatus).toBe('complete');
  });

  it('T-SRC-03: con dos fuentes y una caída, los agentes de la sana se devuelven igual y discover() RESUELVE (CD-4)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([
      makeRegistry({ id: 'r-down', name: 'down-registry' }),
      makeRegistry({
        id: 'r-up',
        name: 'up-registry',
        discoveryEndpoint: 'https://healthy.example.org/agents',
        invokeEndpoint: 'https://healthy.example.org/invoke/{slug}',
      }),
    ]);
    serveByHost({
      'example.com': () => Promise.resolve({ ok: false, status: 503 }),
      'healthy.example.org': () => okResponse(catalog(4, 'healthy')),
    });

    // No rechaza: un registro caído no tumba /discover.
    const result = await discoveryService.discover({});

    expect(result.agents).toHaveLength(4);
    expect(result.agents.every((a) => a.slug.startsWith('healthy'))).toBe(true);
    expect(result.registries).toEqual(['up-registry']);
    expect(result.catalogStatus).toBe('partial');
  });

  describe('T-SRC-04: clasificación del motivo por el que no se pudo consultar', () => {
    it('http_error — el registro contestó 500', async () => {
      serveByHost({
        'example.com': () => Promise.resolve({ ok: false, status: 500 }),
      });
      const r = await discoveryService.discover({});
      expect(r.sources[0]?.failure).toBe('http_error');
      expect(r.sources[0]?.state).toBe('failed');
    });

    it('bad_payload — 200 con algo que no es un array (antes era un "éxito vacío")', async () => {
      serveByHost({ 'example.com': () => okResponse({ oops: true }) });
      const r = await discoveryService.discover({});
      expect(r.sources[0]?.failure).toBe('bad_payload');
      expect(r.sources[0]?.state).toBe('failed');
      expect(r.sources[0]?.rows).toBeNull();
      expect(r.catalogStatus).toBe('partial');
    });

    it('timeout — el fetch aborta', async () => {
      const abort = new Error('The operation was aborted');
      abort.name = 'AbortError';
      serveByHost({ 'example.com': () => Promise.reject(abort) });
      const r = await discoveryService.discover({});
      expect(r.sources[0]?.failure).toBe('timeout');
      expect(r.sources[0]?.rows).toBeNull();
    });

    it('ssrf_blocked — el endpoint del registro apunta a loopback', async () => {
      vi.mocked(registryService.getEnabled).mockResolvedValue([
        makeRegistry({
          discoveryEndpoint: 'http://127.0.0.1:9999/agents',
          invokeEndpoint: 'http://127.0.0.1:9999/invoke/{slug}',
        }),
      ]);
      const r = await discoveryService.discover({});
      expect(r.sources[0]?.failure).toBe('ssrf_blocked');
      expect(r.sources[0]?.state).toBe('failed');
      expect(r.registries).toEqual([]);
    });

    it('circuit_open — el breaker está abierto', async () => {
      breakerState.open = true;
      serveByHost({ 'example.com': () => okResponse(catalog(3)) });
      const r = await discoveryService.discover({});
      expect(r.sources[0]?.failure).toBe('circuit_open');
      expect(r.sources[0]?.rows).toBeNull();
      expect(r.catalogStatus).toBe('partial');
    });
  });

  it('T-SRC-05: camino sano — `registries` byte-idéntico al de antes de esta HU y catalogStatus complete', async () => {
    serveByHost({ 'example.com': () => okResponse(catalog(3)) });

    // `limit` ⇒ se envían 200 y llegan 3: la página no se llenó, así que la
    // completitud está PROBADA y el estado es `ok` (no `unverified`).
    const result = await discoveryService.discover({ limit: 5 });

    // El contrato público NO cambia de forma ni de valor cuando todo anda bien.
    expect(result.registries).toEqual(['test-registry']);
    expect(result.catalogStatus).toBe('complete');
    expect(result.sources).toEqual([
      { name: 'test-registry', state: 'ok', rows: 3 },
      // La fuente local se consultó y no tenía nada. Se DECLARA (rows: 0), que
      // es lo que la distingue de un SELECT caído (T-SRC-09).
      { name: 'self-published', state: 'ok', rows: 0 },
    ]);
    expect(result.agents).toHaveLength(3);
    expect(result.total).toBe(3);
  });

  it('T-SRC-05b: los self-published entran por el mismo pipeline y aportan su propia fila de `sources` (CD-6)', async () => {
    serveByHost({ 'example.com': () => okResponse(catalog(2)) });
    vi.mocked(publishedAgentService.listAsAgents).mockResolvedValue([
      {
        id: 'local-1',
        slug: 'remit-kyc-validator',
        name: 'Local',
        description: 'd',
        capabilities: ['kyc'],
        priceUsdc: 0,
        registry: 'self-published',
        registry_id: 'self-published',
        invokeUrl: 'https://local.example.com/invoke',
        invocationNote: '',
        verified: false,
        status: 'active',
        metadata: {},
      },
    ]);

    const result = await discoveryService.discover({ limit: 5 });

    expect(result.registries).toEqual(['test-registry', 'self-published']);
    expect(result.sources).toEqual([
      { name: 'test-registry', state: 'ok', rows: 2 },
      { name: 'self-published', state: 'ok', rows: 1 },
    ]);
    expect(result.catalogStatus).toBe('complete');
  });

  it('T-SRC-07 (CD-7): el guard NO se compara consigo mismo — 2 fuentes configuradas, 1 caída ⇒ sources.length 2 pero registries.length 1', async () => {
    // El assert que importa es `registries.length === 1` CONTRA
    // `sources.length === 2`: son dos cantidades de ORIGEN DISTINTO. Si el
    // cálculo de `registries` volviera a salir de la lista de CONFIGURADOS
    // (el código de antes de esta HU), serían 2 y 2, y el test se cae.
    vi.mocked(registryService.getEnabled).mockResolvedValue([
      makeRegistry({ id: 'r-down', name: 'down-registry' }),
      makeRegistry({
        id: 'r-up',
        name: 'up-registry',
        discoveryEndpoint: 'https://healthy.example.org/agents',
        invokeEndpoint: 'https://healthy.example.org/invoke/{slug}',
      }),
    ]);
    serveByHost({
      'example.com': () => Promise.resolve({ ok: false, status: 400 }),
      'healthy.example.org': () => okResponse(catalog(5, 'healthy')),
    });

    const result = await discoveryService.discover({});

    // 2 federadas + la local = 3 fuentes consultadas; UNA sola contribuyó.
    const federated = result.sources.filter((s) => s.name !== 'self-published');
    expect(federated).toHaveLength(2);
    expect(result.sources.filter((s) => s.state === 'failed')).toHaveLength(1);
    expect(result.registries).toHaveLength(1);
    expect(result.registries).toEqual(['up-registry']);
    expect(result.catalogStatus).toBe('partial');
  });

  // ── AR BLQ-1: `ok` exige evidencia; sin evidencia obtenible es `unverified` ──

  it('T-SRC-08 (BLQ-1): una fuente que contesta SIN evidencia obtenible es `unverified`, y el catálogo NO se declara complete', async () => {
    // El caso REAL de producción: el registro `wasiai` se siembra sin
    // `nextCursorPath` y `/capabilities` llama a `discover({})` sin `limit`, así
    // que tampoco se manda `limitParam`. No hay forma de saber si trajo todo.
    serveByHost({ 'example.com': () => okResponse(catalog(20)) });

    const result = await discoveryService.discover({});

    expect(result.sources[0]).toEqual({
      name: 'test-registry',
      state: 'unverified',
      // Hay número: contestó y esas filas entraron. Lo que no se sabe es si
      // eran todas. Por eso NO es `rows: null` — eso es "no pude preguntarle".
      rows: 20,
    });
    expect(result.catalogStatus).toBe('unverified');
    // Sigue contribuyendo: aportó filas. `unverified` no es una caída.
    expect(result.registries).toContain('test-registry');
    expect(result.agents).toHaveLength(20);
  });

  it('T-SRC-08b (BLQ-1): el repro exacto del AR — 20 filas CON next_cursor pero sin `nextCursorPath` declarado no puede dar complete', async () => {
    // Antes del fix esto devolvía {state:'ok', rows:20, catalogStatus:'complete'}
    // sobre 20 de 22 agentes: cambiaba una mentira por otra, que es textualmente
    // lo que el corte A se comprometió a NO hacer.
    serveByHost({
      'example.com': () =>
        okResponse({ agents: catalog(20), next_cursor: 'hay-mas' }),
    });
    vi.mocked(registryService.getEnabled).mockResolvedValue([
      makeRegistry({
        schema: {
          discovery: { limitParam: 'limit', agentsPath: 'agents' },
          invoke: { method: 'POST' },
        },
      }),
    ]);

    const result = await discoveryService.discover({});

    expect(result.catalogStatus).not.toBe('complete');
    expect(result.catalogStatus).toBe('unverified');
    expect(result.sources[0]?.state).toBe('unverified');
  });

  // ── AR BLQ-2: la fuente local también rinde cuentas ────────────────────

  it('T-SRC-09 (BLQ-2): si el SELECT local falla, la fuente self-published se declara failed/rows:null y el catálogo es partial', async () => {
    // Es la fuente que carga los 3 agentes del money-path de Chaski. Antes, un
    // SELECT caído era indistinguible de "no hay agentes locales" y el catálogo
    // se publicaba `complete` sin ellos.
    serveByHost({ 'example.com': () => okResponse(catalog(2)) });
    vi.mocked(publishedAgentService.listAsAgents).mockRejectedValue(
      new Error('supabase down'),
    );

    const result = await discoveryService.discover({ limit: 5 });

    const local = result.sources.find((s) => s.name === 'self-published');
    expect(local).toEqual({
      name: 'self-published',
      state: 'failed',
      rows: null,
      failure: 'unknown',
    });
    expect(result.catalogStatus).toBe('partial');
    // CD-4/CD-9: sigue degradando — los federados se devuelven igual.
    expect(result.agents).toHaveLength(2);
    expect(result.registries).toEqual(['test-registry']);
  });

  it('T-SRC-10 (BLQ-2): un SELECT local que devuelve 0 agentes es `ok`/rows:0 — distinguible del que falló', async () => {
    serveByHost({ 'example.com': () => okResponse(catalog(2)) });
    vi.mocked(publishedAgentService.listAsAgents).mockResolvedValue([]);

    const result = await discoveryService.discover({ limit: 5 });

    const local = result.sources.find((s) => s.name === 'self-published');
    expect(local).toEqual({
      name: 'self-published',
      state: 'ok',
      rows: 0,
    });
    expect(local?.rows).not.toBeNull();
    expect(result.catalogStatus).toBe('complete');
  });

  it('T-SRC-11 (BLQ-2): si el caller filtró a otro registry, la fuente local NO se consultó y NO figura en `sources`', async () => {
    vi.mocked(registryService.getWithSecrets).mockResolvedValue(makeRegistry());
    serveByHost({ 'example.com': () => okResponse(catalog(2)) });

    const result = await discoveryService.discover({
      registry: 'test-registry',
      limit: 5,
    });

    // No aparece: no se la consultó. Eso es distinto de haberla consultado y que
    // no tuviera nada (T-SRC-10) y de no haber podido (T-SRC-09).
    expect(
      result.sources.find((s) => s.name === 'self-published'),
    ).toBeUndefined();
    expect(result.catalogStatus).toBe('complete');
  });

  it('T-SRC-12 (BLQ-2 + MNR-A): sin registries habilitados y con el SELECT local caído, el early-return declara partial — no complete', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    vi.mocked(publishedAgentService.listAsAgents).mockRejectedValue(
      new Error('supabase down'),
    );

    const result = await discoveryService.discover({});

    expect(result.agents).toEqual([]);
    expect(result.sources).toEqual([
      {
        name: 'self-published',
        state: 'failed',
        rows: null,
        failure: 'unknown',
      },
    ]);
    // El early-return calcula el roll-up con `buildCatalogStatus`, no con un
    // literal: por eso esta rama no puede quedarse en `complete` (CR MNR-A).
    expect(result.catalogStatus).toBe('partial');
  });

  it('T-SRC-13: sin NINGUNA fuente consultada, el catálogo es complete — el conjunto de lo que pudo fallar está vacío', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    vi.mocked(registryService.getWithSecrets).mockResolvedValue(undefined);

    const result = await discoveryService.discover({
      registry: 'no-existe-pero-no-es-self-published',
    });

    expect(result.sources).toEqual([]);
    expect(result.catalogStatus).toBe('complete');
  });

  // ─── WKH-318 corte B: el 400 medido del registro real, y su control ────────
  //
  // ⚠️ `serveByHost` NO sirve acá: rutea por hostname y su función de ruta no
  // recibe la URL, así que no puede decidir según el `?limit=`. Helper local
  // nuevo, sobre `mockFetch.mockImplementation((url) => ...)`. NO se toca
  // `serveByHost`: lo usan T-SRC-01..13.

  /**
   * Imita el contrato MEDIDO de `wasiai-v2` el 2026-08-04:
   * `?limit<=100` ⇒ 200 + catálogo; `?limit>100` ⇒ 400.
   *
   * El 400 va pelado a propósito: `discovery.ts:1162-1164` lanza
   * `RegistryHttpError` ANTES del `await response.json()` de `:1166`, así que el
   * body de la respuesta de error nunca se lee ni llega a `sources[]`.
   */
  function serveWithCeilingOf100(rows: Record<string, unknown>[]): {
    upstreamLimits: (string | null)[];
  } {
    const upstreamLimits: (string | null)[] = [];
    mockFetch.mockImplementation((url: string) => {
      const lim = new URL(url).searchParams.get('limit');
      upstreamLimits.push(lim);
      if (lim !== null && Number(lim) > 100) {
        return Promise.resolve({ ok: false, status: 400 });
      }
      return okResponse(lim ? rows.slice(0, Number(lim)) : rows);
    });
    return { upstreamLimits };
  }

  it('T-CLAMP-04: contra el techo real de 100, un registry que DECLARA maxLimit sobrevive (AC-4)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([
      makeRegistry({
        schema: {
          discovery: { limitParam: 'limit', maxLimit: 100 },
          invoke: { method: 'POST' },
        },
      }),
    ]);
    const { upstreamLimits } = serveWithCeilingOf100(catalog(23));

    const result = await discoveryService.discover({ limit: 200 });

    expect(upstreamLimits).toEqual(['100']);
    expect(result.sources[0]?.state).not.toBe('failed');
    expect(result.sources[0]?.failure).toBeUndefined();
    expect(result.sources[0]?.rows).toBe(23);
    expect(result.catalogStatus).not.toBe('partial');
    expect(result.registries).toEqual(['test-registry']);
  });

  it('T-CLAMP-04b: el MISMO registro sin declarar maxLimit sigue cayendo entero (AC-4, control negativo)', async () => {
    // El control es lo que le da valor a T-CLAMP-04: sin él, ese test pasaría
    // igual con un mimic que nunca devuelve 400. Y es la prueba de que no hay
    // default de 100 escondido en el código.
    const { upstreamLimits } = serveWithCeilingOf100(catalog(23));

    const result = await discoveryService.discover({ limit: 200 });

    expect(upstreamLimits).toEqual(['200']);
    expect(result.sources[0]?.state).toBe('failed');
    expect(result.sources[0]?.failure).toBe('http_error');
    expect(result.sources[0]?.rows).toBeNull();
    expect(result.catalogStatus).toBe('partial');
    expect(result.registries).toEqual([]);
  });
});
