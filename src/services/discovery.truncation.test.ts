/**
 * WKH-318 (W2) — el truncamiento se DETECTA, no se pagina (TD-318-2).
 *
 * Sin esto, el corte A cambiaría una mentira por otra: `catalogStatus:'complete'`
 * sobre una página que dejó filas afuera. Medido por el architect: la tabla
 * `agents` de wasiai-v2 tiene 22 activos y el camino sin `limit` devuelve 20 con
 * `next_cursor` seteado.
 *
 * `ok` NO es el default: se GANA con evidencia positiva de completitud (AR
 * BLQ-1). Hay cuatro evidencias posibles, dos para cada lado, y el orden importa:
 *
 *   TRUNCAMIENTO
 *   1. `cursor`    — EXACTA. El registro declara `nextCursorPath` y llega CON
 *                    valor. Gana sobre la heurística.
 *   2. `page_full` — HEURÍSTICA. Llegaron tantas filas como se pidieron. Sólo
 *                    puede equivocarse sobre-declarando, que es el lado seguro.
 *
 *   COMPLETITUD
 *   3. cursor vacío (`null`/`''`/`0`/`false`) — el registro DECLARA que no hay
 *      más. Es una declaración, no una ausencia: por eso prueba completitud,
 *      mientras que la clave AUSENTE no prueba nada (`T-TRUNC-02`).
 *   4. página que no se llenó — llegaron menos filas que el límite enviado, así
 *      que no quedó nada afuera.
 *
 * Sin NINGUNA de las cuatro no hay evidencia para ningún lado, y el estado es
 * `unverified` — no `ok` (`T-TRUNC-05`). Antes del fix de BLQ-1 este mismo
 * docstring decía "⇒ `ok`", y era el caso de producción: declarar completitud
 * por descarte es una afirmación disfrazada de ausencia.
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

/** Registro que declara dónde vive su cursor (lo que hace la migración de W2). */
function withCursorPath(path = 'next_cursor'): RegistryConfig {
  return makeRegistry({
    schema: {
      discovery: {
        limitParam: 'limit',
        agentsPath: 'agents',
        nextCursorPath: path,
      },
      invoke: { method: 'POST' },
    },
  });
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
 * Sirve un payload fijo y captura los `limit` que se enviaron upstream.
 * Copiado de `discovery.limit.test.ts:96-110`.
 */
function serve(payload: unknown): { upstreamLimits: (string | null)[] } {
  const upstreamLimits: (string | null)[] = [];
  mockFetch.mockImplementation((url: string) => {
    upstreamLimits.push(new URL(url).searchParams.get('limit'));
    return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
  });
  return { upstreamLimits };
}

describe('WKH-318 — detección de truncamiento', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DISCOVERY_UPSTREAM_FETCH_LIMIT;
    vi.mocked(registryService.getEnabled).mockResolvedValue([makeRegistry()]);
  });

  it('T-TRUNC-01: cursor declarado y no-nulo ⇒ truncated / evidencia `cursor` / catálogo truncated', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([withCursorPath()]);
    serve({ agents: catalog(20), next_cursor: 'abc' });

    const result = await discoveryService.discover({});

    expect(result.sources[0]).toEqual({
      name: 'test-registry',
      state: 'truncated',
      rows: 20,
      truncationEvidence: 'cursor',
    });
    expect(result.catalogStatus).toBe('truncated');
    // Truncada NO es caída: sus filas cuentan, así que sigue contribuyendo.
    expect(result.registries).toEqual(['test-registry']);
  });

  it('T-TRUNC-02: un cursor vacío es la DECLARACIÓN de "no hay más" (prueba completitud); la clave AUSENTE no declara nada', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([withCursorPath()]);

    // (a) la clave existe con valor nulo — es exactamente cómo un registro dice
    // "no hay más". Eso es EVIDENCIA de completitud, no ausencia de evidencia.
    serve({ agents: catalog(3), next_cursor: null });
    const withNull = await discoveryService.discover({});
    expect(withNull.sources[0]?.state).toBe('ok');
    expect(withNull.sources[0]?.truncationEvidence).toBeUndefined();
    expect(withNull.catalogStatus).toBe('complete');

    // (b) la clave declarada NO viene. AUSENTE no es NULO: el registro no dijo
    // nada, así que no hay nada que probar la completitud ⇒ `unverified`.
    // Leerlo como "no hay más" sería inventarle una declaración que no hizo.
    serve({ agents: catalog(3) });
    const missing = await discoveryService.discover({});
    expect(missing.sources[0]?.state).toBe('unverified');
    expect(missing.catalogStatus).toBe('unverified');

    // (c) cadena vacía: centinela de "no hay más", igual que null.
    serve({ agents: catalog(3), next_cursor: '' });
    const empty = await discoveryService.discover({});
    expect(empty.sources[0]?.state).toBe('ok');
    expect(empty.catalogStatus).toBe('complete');
  });

  it('T-TRUNC-02b (AR MNR-G): `0` y `false` son centinelas de "no hay más", NO cursores', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([withCursorPath()]);

    // Con el `cursor !== null` de antes, un `0` o un `false` forzaban
    // `truncated`. Son valores plausibles para "no hay más página".
    serve({ agents: catalog(3), next_cursor: 0 });
    const zero = await discoveryService.discover({});
    expect(zero.sources[0]?.state).toBe('ok');

    serve({ agents: catalog(3), next_cursor: false });
    const no = await discoveryService.discover({});
    expect(no.sources[0]?.state).toBe('ok');
  });

  it('T-TRUNC-03: sin cursor declarado, una página LLENA (rows === sentLimit) ⇒ truncated / `page_full`', async () => {
    // over-fetch default = 200; el registro devuelve exactamente 200 filas.
    serve(catalog(200));

    const result = await discoveryService.discover({ limit: 5 });

    expect(result.sources[0]?.state).toBe('truncated');
    expect(result.sources[0]?.truncationEvidence).toBe('page_full');
    expect(result.sources[0]?.rows).toBe(200);
    expect(result.catalogStatus).toBe('truncated');
  });

  it('T-TRUNC-04: rows < sentLimit ⇒ ok. Sin falso positivo por debajo del cap', async () => {
    serve(catalog(199));

    const result = await discoveryService.discover({ limit: 5 });

    expect(result.sources[0]?.state).toBe('ok');
    expect(result.sources[0]?.truncationEvidence).toBeUndefined();
    expect(result.catalogStatus).toBe('complete');
  });

  it('T-TRUNC-05 (AC-7 / CD-5 / CD-8): SIN `limit` del caller no se envía NINGÚN parámetro nuevo upstream, y sin cursor declarado el estado es ok', async () => {
    const { upstreamLimits } = serve(catalog(200));

    const result = await discoveryService.discover({});

    // El assert que importa es sobre lo ENVIADO, no sobre el resultado: el
    // camino sin `limit` tiene que quedar byte-idéntico al de antes de la HU.
    expect(upstreamLimits).toEqual([null]);
    // 200 filas, ningún límite enviado y ningún cursor declarado ⇒ no hay
    // evidencia PARA NINGÚN LADO. Marcar `truncated` sería inventar una certeza;
    // marcar `ok` sería inventar la contraria, que es lo que hacía antes del
    // BLQ-1. `unverified` es lo único que se puede afirmar.
    expect(result.sources[0]?.state).toBe('unverified');
    expect(result.sources[0]?.truncationEvidence).toBeUndefined();
    expect(result.catalogStatus).toBe('unverified');
  });

  it('T-TRUNC-08: la declaración EXACTA le gana a la heurística — cursor vacío con la página llena es `ok`, no `page_full`', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([withCursorPath()]);
    // 200 filas con over-fetch 200 (página llena) PERO el registro declara que
    // no hay más. Le creemos al que sabe: la coincidencia de tamaño no es
    // evidencia frente a una declaración explícita.
    serve({ agents: catalog(200), next_cursor: null });

    const result = await discoveryService.discover({ limit: 5 });

    expect(result.sources[0]?.state).toBe('ok');
    expect(result.sources[0]?.truncationEvidence).toBeUndefined();
    expect(result.catalogStatus).toBe('complete');
  });

  it('T-TRUNC-06: precedencia — con cursor no-nulo Y página llena gana la evidencia EXACTA (`cursor`)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([withCursorPath()]);
    serve({ agents: catalog(200), next_cursor: 'abc' });

    const result = await discoveryService.discover({ limit: 5 });

    expect(result.sources[0]?.state).toBe('truncated');
    expect(result.sources[0]?.truncationEvidence).toBe('cursor');
  });

  it('T-TRUNC-07: el cursor se lee por dot-notation, igual que `agentsPath`', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([
      withCursorPath('pagination.next'),
    ]);
    serve({ agents: catalog(2), pagination: { next: 'tok-2' } });

    const result = await discoveryService.discover({});

    expect(result.sources[0]?.truncationEvidence).toBe('cursor');
    expect(result.sources[0]?.state).toBe('truncated');
  });
});
