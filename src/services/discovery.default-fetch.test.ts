/**
 * HU-323 — la llamada POR DEFECTO de `/discover` deja de recortar el catálogo, y
 * `total` deja de presentar el conteo recortado como si fuera el total.
 *
 * ─── Lo medido en producción el 2026-08-04 ──────────────────────────────────
 *   GET /discover            → total 23 | devueltos 23 | catalogStatus truncated
 *   GET /discover?limit=100  → total 25 | devueltos 25 | catalogStatus complete
 *   afuera quedaban: `avalanche-ecosystem-pulse`, `sentiment-analyzer`
 *
 * Son DOS defectos distintos, y este archivo los separa:
 *
 *   (1) EL RECORTE ERA INNECESARIO. El gate de `queryRegistry` era
 *       `query.limit && schema.limitParam`: sin `limit` del caller no se mandaba
 *       `limitParam`, y entonces el tamaño de la página lo decidía la paginación
 *       default DEL REGISTRO (20 filas de 22, en producción). El gate existía
 *       para "no esconder agentes" y escondía dos en la llamada más común.
 *
 *   (2) BAJO TRUNCAMIENTO, `total` ERA EL CONTEO RECORTADO. Con
 *       `catalogStatus: 'truncated'` al lado eso no es una mentira, pero es
 *       ambiguo: quien lee sólo `total` se lleva 23 como si fuera el total. Se
 *       aplica la doctrina de `/health` (`strandedExposureBreached: 'unknown'`,
 *       commit bfe9a55): un dato que no se sabe se DECLARA desconocido, y se lo
 *       declara con un valor TRUTHY para que no se lea como "no hay problema".
 *
 * ⚠️ QUÉ NO SE TOCA: el guard de honestidad de WKH-318. `catalogStatus` sigue
 * saliendo de `buildCatalogStatus` y sigue diciendo `truncated` cuando hay
 * evidencia de recorte. Los tests de acá lo ASSERTAN en las dos direcciones
 * justamente para que un fix del recorte no se lleve puesto el aviso.
 *
 * ⚠️ EL TECHO SIGUE EXISTIENDO, y por eso el caso "por encima del techo" se
 * ejercita de verdad (con un catálogo simulado MÁS GRANDE que el over-fetch), no
 * sólo el caso que entra. Subir un número mueve el techo, no lo elimina: el día
 * que el catálogo lo pase, lo que tiene que pasar es que `catalogStatus` avise Y
 * que `total` diga que no sabe.
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

/** Registro con `limitParam`, como los dos registros reales del repo. */
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

function catalog(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `a${i}`,
    slug: `agent-${i}`,
    name: `Agent ${i}`,
    description: 'desc',
    capabilities: ['x'],
    price: 0,
    reputation: 10,
    status: 'active',
  }));
}

/**
 * Registro que HONRA `?limit=N` (devuelve sus primeras N filas) y que, SIN
 * `?limit`, pagina por su cuenta de a `defaultPage`.
 *
 * Ese `defaultPage` es el corazón del bug (1): es el número que el registro
 * elige cuando nosotros no elegimos ninguno. En producción vale 20.
 */
function serveWithDefaultPage(
  rows: Record<string, unknown>[],
  defaultPage: number,
): { upstreamLimits: (string | null)[] } {
  const upstreamLimits: (string | null)[] = [];
  mockFetch.mockImplementation((url: string) => {
    const lim = new URL(url).searchParams.get('limit');
    upstreamLimits.push(lim);
    const take = lim ? Number(lim) : defaultPage;
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(rows.slice(0, take)),
    });
  });
  return { upstreamLimits };
}

describe('HU-323 — la llamada por defecto y la honestidad de `total`', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DISCOVERY_UPSTREAM_FETCH_LIMIT;
    vi.mocked(registryService.getEnabled).mockResolvedValue([makeRegistry()]);
  });

  // ── (1) el recorte del default ───────────────────────────────────────────

  it('T-323-01: la llamada POR DEFECTO alcanza el catálogo COMPLETO cuando cabe bajo el techo', async () => {
    // El repro de producción, con sus números: 25 agentes y un registro que
    // pagina de a 20 cuando no le mandamos nada.
    const { upstreamLimits } = serveWithDefaultPage(catalog(25), 20);

    const result = await discoveryService.discover({});

    // Se mandó el over-fetch aunque el caller no pidió page size.
    expect(upstreamLimits).toEqual(['200']);
    // Antes de HU-323 esto era 20 (+ locales): el registro elegía por nosotros.
    expect(result.agents).toHaveLength(25);
    expect(result.total).toBe(25);
    expect(result.totalAtLeast).toBe(25);
    // Y el guard de honestidad puede afirmar completitud porque AHORA es cierta.
    expect(result.catalogStatus).toBe('complete');
    expect(result.sources[0]?.state).toBe('ok');
  });

  it('T-323-02: los agentes que el default escondía son EXACTAMENTE los que devuelve un `limit` explícito', async () => {
    // La forma del hallazgo: `?limit=100` traía dos agentes que `/discover`
    // pelado no traía. Después del fix, los dos conjuntos coinciden.
    serveWithDefaultPage(catalog(25), 20);
    const byDefault = await discoveryService.discover({});

    serveWithDefaultPage(catalog(25), 20);
    const explicit = await discoveryService.discover({ limit: 100 });

    const slugs = (r: { agents: { slug: string }[] }) =>
      r.agents.map((a) => a.slug).sort();
    expect(slugs(byDefault)).toEqual(slugs(explicit));
    expect(byDefault.total).toBe(explicit.total);
  });

  // ── (2) el techo, EJERCITADO ─────────────────────────────────────────────

  it('T-323-03: con el catálogo POR ENCIMA del techo, `catalogStatus` avisa y `total` NO es el conteo recortado', async () => {
    // El techo real por defecto es el over-fetch (200). El catálogo simulado es
    // MÁS GRANDE, así que esta es la rama que importa: la que ocurre el día que
    // el catálogo pase el número nuevo.
    serveWithDefaultPage(catalog(250), 20);

    const result = await discoveryService.discover({});

    // El recorte ocurrió: entraron 200 de 250.
    expect(result.agents).toHaveLength(200);
    expect(result.sources[0]?.rows).toBe(200);
    // (a) el aviso de WKH-318 sigue funcionando — esto es lo que NO se rompe.
    expect(result.sources[0]?.state).toBe('truncated');
    expect(result.sources[0]?.truncationEvidence).toBe('page_full');
    expect(result.catalogStatus).toBe('truncated');
    // (b) y `total` deja de presentar el recorte como total. ESTE es el assert
    //     que mata la mutación "que `total` vuelva a ser el conteo recortado".
    expect(result.total).toBe('unknown');
    expect(result.total).not.toBe(200);
    expect(typeof result.total).not.toBe('number');
    // (c) el número no se pierde: sigue disponible como COTA INFERIOR.
    expect(result.totalAtLeast).toBe(200);
  });

  it('T-323-04: `total: "unknown"` es TRUTHY — un consumidor no lo puede leer como 0 ni como "no hay problema"', async () => {
    // La razón por la que NO es `null` ni un campo ausente, y es la misma que
    // dio `/health` para `strandedExposureBreached`: un valor falsy se lee como
    // "todo bien". `total ?? 0` sobre `null` daría 0 — una afirmación MÁS falsa
    // que el 200 que se está sacando.
    serveWithDefaultPage(catalog(250), 20);

    const result = await discoveryService.discover({});

    expect(Boolean(result.total)).toBe(true);
    expect(result.total).not.toBeNull();
    expect(result.total ?? 0).not.toBe(0);
    expect(result.total || 0).not.toBe(0);
  });

  it('T-323-05: el techo es una env NUESTRA — bajarlo trunca, y el truncamiento se declara igual', async () => {
    // Prueba que el techo ejercitado en T-323-03 es el over-fetch y no un
    // accidente del tamaño del catálogo: con el mismo catálogo de 25 que en
    // T-323-01 daba `complete`, un techo de 10 lo vuelve `truncated`.
    process.env.DISCOVERY_UPSTREAM_FETCH_LIMIT = '10';
    const { upstreamLimits } = serveWithDefaultPage(catalog(25), 20);

    const result = await discoveryService.discover({});

    expect(upstreamLimits).toEqual(['10']);
    expect(result.agents).toHaveLength(10);
    expect(result.catalogStatus).toBe('truncated');
    expect(result.total).toBe('unknown');
    expect(result.totalAtLeast).toBe(10);
  });

  it('T-323-06: el techo del REGISTRO también se respeta en el camino por defecto (no se le pide más de lo que acepta)', async () => {
    // `wasiai-v2` contesta 400 a `?limit=101` y declara `maxLimit: 100`. Si el
    // camino por defecto ignorara el clamp, la llamada más común de todas sería
    // la única que pierde la fuente ENTERA por un 400.
    vi.mocked(registryService.getEnabled).mockResolvedValue([
      makeRegistry({
        schema: {
          discovery: { limitParam: 'limit', maxLimit: 100 },
          invoke: { method: 'POST' },
        },
      }),
    ]);
    const { upstreamLimits } = serveWithDefaultPage(catalog(250), 20);

    const result = await discoveryService.discover({});

    expect(upstreamLimits).toEqual(['100']);
    // Y con 100 filas contra 100 pedidas el recorte se declara igual: el techo
    // del registro no es una excusa para afirmar completitud.
    expect(result.agents).toHaveLength(100);
    expect(result.catalogStatus).toBe('truncated');
    expect(result.total).toBe('unknown');
    expect(result.totalAtLeast).toBe(100);
  });

  // ── (3) lo que NO cambia ─────────────────────────────────────────────────

  it('T-323-07: `?limit=N` explícito se comporta igual que antes de la HU', async () => {
    serveWithDefaultPage(catalog(25), 20);

    const result = await discoveryService.discover({ limit: 5 });

    // El page size sigue siendo el del caller...
    expect(result.agents).toHaveLength(5);
    // ...y `total` sigue siendo el denominador de paginación PRE-`limit`, un
    // número, porque el catálogo entró completo. `limit` no es truncamiento.
    expect(result.total).toBe(25);
    expect(result.totalAtLeast).toBe(25);
    expect(result.catalogStatus).toBe('complete');
  });

  it('T-323-08: un `limit` MAYOR que el over-fetch sigue ganando (nunca under-fetch)', async () => {
    const { upstreamLimits } = serveWithDefaultPage(catalog(400), 20);

    const result = await discoveryService.discover({ limit: 300 });

    // `resolveUpstreamFetchLimit` es `max(pageLimit, 200)`: el caller pidió más
    // que el over-fetch, así que gana el caller. HU-323 no lo tocó.
    expect(upstreamLimits).toEqual(['300']);
    expect(result.agents).toHaveLength(300);
    expect(result.catalogStatus).toBe('truncated');
    expect(result.total).toBe('unknown');
  });

  it('T-323-09: un registro SIN `limitParam` sigue sin recibir el parámetro, y su catálogo queda `unverified` con `total` numérico', async () => {
    // El gate nuevo es `schema.limitParam` a secas: si el registro no declara
    // dónde poner el número, no se inventa un parámetro. Y `unverified` NO
    // vuelve `total` desconocido: es "no pude probar que no falta", no "sé que
    // falta" (ver `resolveReportedTotal`).
    vi.mocked(registryService.getEnabled).mockResolvedValue([
      makeRegistry({ schema: { discovery: {}, invoke: { method: 'POST' } } }),
    ]);
    const { upstreamLimits } = serveWithDefaultPage(catalog(25), 20);

    const result = await discoveryService.discover({});

    expect(upstreamLimits).toEqual([null]);
    expect(result.agents).toHaveLength(20);
    expect(result.catalogStatus).toBe('unverified');
    expect(result.total).toBe(20);
    expect(result.totalAtLeast).toBe(20);
  });

  // ── (4) el otro estado que sabe que le falta algo ────────────────────────

  it('T-323-10: con una fuente CAÍDA (`partial`) el total tampoco se sabe', async () => {
    // Es el mismo defecto con otro productor: si una fuente no contestó, sus
    // matches no están contados y nadie sabe cuántos eran. Publicar el conteo de
    // las que sí contestaron, con nombre de `total`, es rellenar el hueco con lo
    // que hay a mano — exactamente lo que la HU prohíbe.
    vi.mocked(registryService.getEnabled).mockResolvedValue([
      makeRegistry({ id: 'r-up', name: 'up-registry' }),
      makeRegistry({
        id: 'r-down',
        name: 'down-registry',
        discoveryEndpoint: 'https://down.example.com/agents',
      }),
    ]);
    mockFetch.mockImplementation((url: string) => {
      if (new URL(url).hostname === 'down.example.com') {
        return Promise.resolve({ ok: false, status: 500 });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(catalog(7)),
      });
    });

    const result = await discoveryService.discover({});

    expect(result.catalogStatus).toBe('partial');
    expect(result.agents).toHaveLength(7);
    expect(result.total).toBe('unknown');
    expect(result.totalAtLeast).toBe(7);
  });
});
