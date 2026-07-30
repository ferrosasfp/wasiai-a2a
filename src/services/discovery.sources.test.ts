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
 *   · `catalogStatus` = roll-up, precedencia partial > truncated > complete.
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

    expect(result.sources).toHaveLength(1);
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

    const result = await discoveryService.discover({});

    expect(result.sources).toHaveLength(1);
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

    const result = await discoveryService.discover({});

    // El contrato público NO cambia de forma ni de valor cuando todo anda bien.
    expect(result.registries).toEqual(['test-registry']);
    expect(result.catalogStatus).toBe('complete');
    expect(result.sources).toEqual([
      { name: 'test-registry', state: 'ok', rows: 3 },
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

    const result = await discoveryService.discover({});

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

    expect(result.sources).toHaveLength(2);
    expect(result.sources.filter((s) => s.state === 'failed')).toHaveLength(1);
    expect(result.registries).toHaveLength(1);
    expect(result.registries).toEqual(['up-registry']);
    expect(result.catalogStatus).toBe('partial');
  });
});
