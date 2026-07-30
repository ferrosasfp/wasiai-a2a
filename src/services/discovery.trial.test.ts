/**
 * WKH-313 — El CARRIL DE ESTRENO, medido donde importa: quién queda en `agents`
 * y EN QUÉ ORDEN.
 *
 * Contexto medido en vivo el 2026-07-29:
 * `GET /discover?capabilities=remittance-payout&minReputation=2` devuelve 0
 * agentes. El único agente que sirve esa capacidad nunca trabajó, así que no tiene
 * score, y el fail-safe del filtro lo cuenta 0. El leg que entrega la plata no
 * resuelve.
 *
 * Lo que este archivo canda:
 *   · el admitido conserva su puntaje REAL y por eso ordena ÚLTIMO (T-06/CD-6);
 *   · sin opt-in NADA cambia, ni el resultado ni el costo de I/O (T-09/T-13/CD-9);
 *   · "no pude preguntar" NO admite a nadie (T-10/T-21/CD-7) ← la más importante;
 *   · las tres formas de agotamiento y el cupo (T-04/T-05/T-11/T-12).
 *
 * Andamiaje copiado de `discovery.minreputation.test.ts` (el exemplar), más los
 * dos dobles nuevos: `computeStandingBatch` y `listPublisherAnchors`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Agent,
  AgentReputation,
  AgentStandingCounters,
  RegistryConfig,
} from '../types/index.js';
import {
  SELF_PUBLISHED_REGISTRY_ID,
  SELF_PUBLISHED_REGISTRY_NAME,
} from '../types/index.js';

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

// El lector del ancla de publicación (cupo M). Si este doble no existiera, el
// lector quedaría `undefined` y los tests fallarían por el motivo EQUIVOCADO.
const { mockListAnchors, mockListAsAgents } = vi.hoisted(() => ({
  mockListAnchors: vi.fn(),
  mockListAsAgents: vi.fn(),
}));
vi.mock('./agent.js', () => ({
  publishedAgentService: {
    listAsAgents: (...args: unknown[]) => mockListAsAgents(...args),
    getBySlugAsAgent: vi.fn(),
    listPublisherAnchors: (slugs: string[]) => mockListAnchors(slugs),
  },
}));

const { mockStandingBatch } = vi.hoisted(() => ({
  mockStandingBatch: vi.fn(),
}));
vi.mock('./reputation.js', () => ({
  reputationService: {
    computeStandingBatch: (slugs: string[]) => mockStandingBatch(slugs),
    computeReputationBatch: vi.fn(),
    computeReputationForAgent: vi.fn(),
  },
}));

vi.mock('./identity.js', () => ({
  identityService: { resolveIdentityForAgent: vi.fn().mockResolvedValue(null) },
}));

import { discoveryService } from './discovery.js';
import { registryService } from './registry.js';

// ── Helpers ─────────────────────────────────────────────────────────────

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

function rep(score: number, tasksSettled = 10): AgentReputation {
  return {
    score,
    tasks_settled: tasksSettled,
    success_rate: 1,
    total_volume_usdc: 10,
    source: 'off-chain',
  };
}

/** raw agent de registry; `reputation` es el valor AUTO-REPORTADO por el card. */
function raw(
  slug: string,
  o: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: slug,
    slug,
    name: slug,
    description: 'desc',
    capabilities: ['x'],
    price: 0,
    reputation: 0,
    status: 'active',
    ...o,
  };
}

/** Agente SELF-PUBLISHED ya mapeado (los que tienen ancla `owner_ref`). */
function local(slug: string): Agent {
  return {
    id: slug,
    name: slug,
    slug,
    description: 'desc',
    capabilities: ['x'],
    priceUsdc: 0,
    registry: SELF_PUBLISHED_REGISTRY_NAME,
    registry_id: SELF_PUBLISHED_REGISTRY_ID,
    invokeUrl: `https://x.test/${slug}`,
    invocationNote: '',
    verified: false,
    status: 'active',
    metadata: {},
  };
}

function serve(rows: Record<string, unknown>[]): void {
  mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(rows) });
}

function counters(o: Partial<AgentStandingCounters> = {}): AgentStandingCounters {
  return {
    tasksSettled: 0,
    successCount: 0,
    failedCount: 0,
    reputation: null,
    ...o,
  };
}

/** Standing NO degradado. Los slugs ausentes son newcomers legítimos. */
function standings(
  entries: Array<[string, AgentStandingCounters]> = [],
): void {
  mockStandingBatch.mockResolvedValue({
    degraded: false,
    standings: new Map(entries),
  });
}

/** La lectura de standing FALLÓ: "no pude preguntar", no "no tiene historial". */
function standingDegraded(): void {
  mockStandingBatch.mockResolvedValue({
    degraded: true,
    standings: new Map(),
  });
}

function anchors(
  entries: Array<[string, { ownerRef: string; createdAt: string }]> = [],
): void {
  mockListAnchors.mockResolvedValue({
    degraded: false,
    anchors: new Map(entries),
  });
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.TRIAL_MAX_SETTLED_TASKS;
  delete process.env.TRIAL_MAX_MIN_REPUTATION;
  delete process.env.TRIAL_MAX_AGENTS_PER_PUBLISHER;
  vi.mocked(registryService.getEnabled).mockResolvedValue([makeRegistry()]);
  mockListAsAgents.mockResolvedValue([]);
  standings();
  anchors();
});

// ── T-02 (AC-2) · el badge, y NADA de score fabricado ───────────────────
describe('T-02 (AC-2) · el admitido viene MARCADO y sin score fabricado', () => {
  it('con `allowTrial` el newcomer entra con `trial.granted` y SIN computedReputation', async () => {
    serve([raw('recien-llegado')]);

    const result = await discoveryService.discover({
      minReputation: 2,
      allowTrial: true,
    });

    expect(result.agents.map((a) => a.slug)).toEqual(['recien-llegado']);
    const admitted = result.agents[0];
    expect(admitted?.trial).toEqual({
      granted: true,
      under_min_reputation: 2,
      tasks_settled: 0,
      remaining_settled_tasks: 3,
    });
    // CD-6/AC-7: el score NO se fabrica. Ni `computedReputation` ni `reputation`.
    expect(admitted?.computedReputation).toBeUndefined();
    expect(admitted?.reputation).toBe(0);
  });

  it('el que pasa POR MÉRITO no lleva badge (el badge no es decoración)', async () => {
    serve([raw('veterano')]);
    standings([['veterano', counters({ tasksSettled: 10, reputation: rep(20) })]]);

    const result = await discoveryService.discover({
      minReputation: 2,
      allowTrial: true,
    });

    expect(result.agents.map((a) => a.slug)).toEqual(['veterano']);
    expect(result.agents[0]?.trial).toBeUndefined();
  });

  it('`remaining_settled_tasks` refleja lo que le queda del carril (N - liquidadas)', async () => {
    serve([raw('arranco')]);
    // 1 liquidada, 0 fallos → sigue en el carril (N=3) y su score real es bajo.
    standings([
      ['arranco', counters({ tasksSettled: 1, successCount: 1, reputation: rep(2, 1) })],
    ]);

    const result = await discoveryService.discover({
      minReputation: 50,
      allowTrial: true,
    });

    expect(result.agents[0]?.trial).toEqual({
      granted: true,
      under_min_reputation: 50,
      tasks_settled: 1,
      remaining_settled_tasks: 2,
    });
    // Y conserva su score REAL, que es el que tenía: 2, no 50.
    expect(result.agents[0]?.computedReputation?.score).toBe(2);
  });
});

// ── T-06 (CD-6) · EL ORDEN DORADO ───────────────────────────────────────
describe('T-06 (CD-6) · el admitido ordena ÚLTIMO y el ranking de los demás no se mueve', () => {
  const scored = [raw('alto'), raw('bajo'), raw('estreno')];
  const scoredStandings: Array<[string, AgentStandingCounters]> = [
    ['alto', counters({ tasksSettled: 45, reputation: rep(90) })],
    ['bajo', counters({ tasksSettled: 5, reputation: rep(10) })],
  ];

  it('[scored 90, scored 10, trial] → el trial ÚLTIMO', async () => {
    serve(scored);
    standings(scoredStandings);

    const result = await discoveryService.discover({
      minReputation: 5,
      allowTrial: true,
    });

    expect(result.agents.map((a) => a.slug)).toEqual(['alto', 'bajo', 'estreno']);
    expect(result.agents[2]?.trial?.granted).toBe(true);
  });

  it('el orden de los dos scored es IDÉNTICO con y sin la feature', async () => {
    // Mismo assert, dos veces: una con el carril encendido y otra apagado. Si el
    // badge o la admisión tocaran el sort, estos dos no coincidirían.
    serve(scored);
    standings(scoredStandings);
    const withTrial = await discoveryService.discover({
      minReputation: 5,
      allowTrial: true,
    });

    serve(scored);
    standings(scoredStandings);
    const withoutTrial = await discoveryService.discover({ minReputation: 5 });

    expect(withoutTrial.agents.map((a) => a.slug)).toEqual(['alto', 'bajo']);
    expect(
      withTrial.agents.filter((a) => !a.trial).map((a) => a.slug),
    ).toEqual(withoutTrial.agents.map((a) => a.slug));
  });

  it('el admitido NUNCA le gana a alguien que pasa por mérito, ni siendo más barato', async () => {
    // El precio es el TERCER criterio del sort: si el estreno recibiera un score
    // sintético igual al piso, empataría en reputación y su precio 0 lo pondría
    // PRIMERO. Con su score real (0) eso no puede pasar.
    serve([raw('barato-sin-historial', { price: 0 }), raw('caro-probado', { price: 9 })]);
    standings([['caro-probado', counters({ tasksSettled: 5, reputation: rep(10) })]]);

    const result = await discoveryService.discover({
      minReputation: 10,
      allowTrial: true,
    });

    expect(result.agents.map((a) => a.slug)).toEqual([
      'caro-probado',
      'barato-sin-historial',
    ]);
  });
});

// ── T-04 (AC-4) · frontera de N ─────────────────────────────────────────
describe('T-04 (AC-4) · el carril se agota POR ÉXITO en N liquidadas', () => {
  it('FRONTERA: `N-1` liquidadas admite, `N` ya NO (queda sujeto a su score real)', async () => {
    serve([raw('casi')]);
    standings([
      ['casi', counters({ tasksSettled: 2, successCount: 2, reputation: rep(4, 2) })],
    ]);
    const dentro = await discoveryService.discover({
      minReputation: 8,
      allowTrial: true,
    });
    expect(dentro.agents.map((a) => a.slug)).toEqual(['casi']);
    expect(dentro.agents[0]?.trial?.granted).toBe(true);

    serve([raw('casi')]);
    standings([
      ['casi', counters({ tasksSettled: 3, successCount: 3, reputation: rep(6, 3) })],
    ]);
    const fuera = await discoveryService.discover({
      minReputation: 8,
      allowTrial: true,
    });
    // Salió del carril: su score real (6) no alcanza el piso 8, así que se excluye.
    expect(fuera.agents).toHaveLength(0);
    expect(fuera.excluded?.reputation).toBe(1);
  });

  it('el que salió del carril SÍ pasa por mérito si su score alcanza (sin badge)', async () => {
    serve([raw('salio')]);
    standings([
      ['salio', counters({ tasksSettled: 3, successCount: 3, reputation: rep(6, 3) })],
    ]);

    const result = await discoveryService.discover({
      minReputation: 2,
      allowTrial: true,
    });

    expect(result.agents.map((a) => a.slug)).toEqual(['salio']);
    expect(result.agents[0]?.trial).toBeUndefined();
  });
});

// ── T-05 (AC-5 / CD-14) · el primer fallo ANULA ─────────────────────────
describe('T-05 (AC-5/CD-14) · el primer `failed` ANULA el carril, no lo decrementa', () => {
  it('1 fallo con 0 liquidadas → NO se admite ni con `allowTrial`', async () => {
    serve([raw('fallo-de-entrada')]);
    standings([['fallo-de-entrada', counters({ failedCount: 1 })]]);

    const result = await discoveryService.discover({
      minReputation: 2,
      allowTrial: true,
    });

    expect(result.agents).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.excluded?.trialAvailable).toBe(0);
  });

  it('2 liquidadas + 1 fallo tampoco: es ANULACIÓN, no "le quedan N-1"', async () => {
    serve([raw('arranco-y-fallo')]);
    standings([
      [
        'arranco-y-fallo',
        counters({
          tasksSettled: 2,
          successCount: 2,
          failedCount: 1,
          reputation: rep(3, 2),
        }),
      ],
    ]);

    const result = await discoveryService.discover({
      minReputation: 50,
      allowTrial: true,
    });

    expect(result.agents).toHaveLength(0);
  });
});

// ── T-12 (AC-10) · techo T ──────────────────────────────────────────────
describe('T-12 (AC-10) · techo de piso `T`: el carril no simula historial multi-cliente', () => {
  it('FRONTERA: `min = T` admite, `min = T+1` NO', async () => {
    serve([raw('nuevo')]);
    const enTecho = await discoveryService.discover({
      minReputation: 10,
      allowTrial: true,
    });
    expect(enTecho.agents.map((a) => a.slug)).toEqual(['nuevo']);

    serve([raw('nuevo')]);
    const sobreTecho = await discoveryService.discover({
      minReputation: 11,
      allowTrial: true,
    });
    expect(sobreTecho.agents).toHaveLength(0);
    expect(sobreTecho.excluded?.trialAvailable).toBe(0);
  });

  it('el techo sale de la env (`TRIAL_MAX_MIN_REPUTATION`), no de un 10 hardcodeado', async () => {
    process.env.TRIAL_MAX_MIN_REPUTATION = '3';
    serve([raw('nuevo')]);

    const result = await discoveryService.discover({
      minReputation: 4,
      allowTrial: true,
    });

    expect(result.agents).toHaveLength(0);
  });
});

// ── T-09 (AC-8) · default OFF ───────────────────────────────────────────
describe('T-09 (AC-8) · sin `allowTrial` el resultado es el de HOY, byte por byte', () => {
  it('newcomer presente + minReputation=1 y sin opt-in → 0 agentes, total 0', async () => {
    serve([raw('recien-llegado')]);

    const result = await discoveryService.discover({ minReputation: 1 });

    expect(result.agents).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.excluded?.reputation).toBe(1);
  });

  it('`allowTrial: false` es exactamente lo mismo que no mandarlo', async () => {
    serve([raw('recien-llegado')]);

    const result = await discoveryService.discover({
      minReputation: 1,
      allowTrial: false,
    });

    expect(result.agents).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('T-01 (AC-1): SIN `minReputation` nadie se excluye por reputación, con o sin opt-in', async () => {
    // El gateway no impone un piso que nadie pidió. Y la simetría honesta: sin piso
    // no hay nada que relajar, así que tampoco hay carril ni badge.
    serve([raw('a'), raw('b')]);

    const conOptIn = await discoveryService.discover({ allowTrial: true });
    expect(conOptIn.agents).toHaveLength(2);
    expect(conOptIn.excluded?.reputation).toBe(0);
    expect(conOptIn.excluded?.trialAvailable).toBe(0);
    expect(conOptIn.agents.every((a) => a.trial === undefined)).toBe(true);

    serve([raw('a'), raw('b')]);
    const sinOptIn = await discoveryService.discover({});
    expect(sinOptIn.agents).toHaveLength(2);
    expect(sinOptIn.excluded?.reputation).toBe(0);
  });
});

// ── T-10 (AC-9) · FAIL-CLOSED: "no pude preguntar" ≠ "no tiene historial" ──
describe('T-10 (AC-9/CD-7) · con la lectura de standing DEGRADADA no entra NADIE', () => {
  it('`degraded: true` + `allowTrial: true` → cero admitidos', async () => {
    // La mutación más importante del set. Si `degraded` se leyera como "no tiene
    // historial", un fallo de DB admitiría a CUALQUIERA bajo el piso del caller.
    serve([raw('desconocido'), raw('otro')]);
    standingDegraded();

    const result = await discoveryService.discover({
      minReputation: 2,
      allowTrial: true,
    });

    expect(result.agents).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.excluded?.reputation).toBe(2);
    expect(result.excluded?.trialAvailable).toBe(0);
  });

  it('`degraded: true` no lee ni siquiera las anclas: no hay a quién contarle el cupo', async () => {
    serve([raw('desconocido')]);
    standingDegraded();

    await discoveryService.discover({ minReputation: 2, allowTrial: true });

    expect(mockListAnchors).not.toHaveBeenCalled();
  });

  it('un THROW del batch se traduce a degradado (el `catch {}` ya no se traga el fallo)', async () => {
    serve([raw('desconocido')]);
    mockStandingBatch.mockRejectedValue(new Error('db down'));

    const result = await discoveryService.discover({
      minReputation: 2,
      allowTrial: true,
    });

    expect(result.agents).toHaveLength(0);
    expect(mockListAnchors).not.toHaveBeenCalled();
  });

  it('AUSENCIA del slug con `degraded: false` SÍ es newcomer legítimo (el contraste)', async () => {
    // El mismo Map vacío que arriba no admitía a nadie. Acá sí, y la única
    // diferencia es `degraded`. Eso es exactamente lo que el tercer valor compra.
    serve([raw('desconocido')]);
    standings([]);

    const result = await discoveryService.discover({
      minReputation: 2,
      allowTrial: true,
    });

    expect(result.agents.map((a) => a.slug)).toEqual(['desconocido']);
  });
});

// ── T-21 (CD-7) · el ancla también es fail-closed ───────────────────────
describe('T-21 (CD-7) · si la lectura del ANCLA falla, no se admite a nadie', () => {
  it('`{ degraded: true }` del lector de anclas → cero admitidos', async () => {
    serve([raw('elegible-1'), raw('elegible-2')]);
    mockListAnchors.mockResolvedValue({ degraded: true });

    const result = await discoveryService.discover({
      minReputation: 2,
      allowTrial: true,
    });

    // "No pude leer las anclas" NO es "estos agentes no tienen publicador".
    expect(result.agents).toHaveLength(0);
    expect(result.excluded?.trialAvailable).toBe(0);
  });

  it('un THROW del lector de anclas tampoco admite', async () => {
    serve([raw('elegible-1')]);
    mockListAnchors.mockRejectedValue(new Error('db down'));

    const result = await discoveryService.discover({
      minReputation: 2,
      allowTrial: true,
    });

    expect(result.agents).toHaveLength(0);
  });

  it('un self-published SIN fila de ancla no es candidato (no se le puede contar el cupo)', async () => {
    serve([]);
    mockListAsAgents.mockResolvedValue([local('sin-ancla')]);
    anchors([]); // la lectura funcionó, pero este slug no volvió

    const result = await discoveryService.discover({
      minReputation: 2,
      allowTrial: true,
    });

    expect(result.agents).toHaveLength(0);
  });
});

// ── T-11 (AC-10) · cupo M por publicador ────────────────────────────────
describe('T-11 (AC-10/CD-15) · cupo `M` por publicador, determinista', () => {
  it('5 newcomers del MISMO owner_ref con M=2 → entran los 2 de `created_at` más antiguo', async () => {
    serve([]);
    // El arreglo va en orden DISTINTO al de `created_at`, para que el orden del
    // arreglo no sea por casualidad la respuesta correcta.
    mockListAsAgents.mockResolvedValue([
      local('quinto'),
      local('tercero'),
      local('primero'),
      local('cuarto'),
      local('segundo'),
    ]);
    anchors([
      ['primero', { ownerRef: 'owner-1', createdAt: '2026-01-01T00:00:00Z' }],
      ['segundo', { ownerRef: 'owner-1', createdAt: '2026-02-02T00:00:00Z' }],
      ['tercero', { ownerRef: 'owner-1', createdAt: '2026-03-03T00:00:00Z' }],
      ['cuarto', { ownerRef: 'owner-1', createdAt: '2026-04-04T00:00:00Z' }],
      ['quinto', { ownerRef: 'owner-1', createdAt: '2026-05-05T00:00:00Z' }],
    ]);

    const result = await discoveryService.discover({
      minReputation: 2,
      allowTrial: true,
    });

    expect(result.agents.map((a) => a.slug).sort()).toEqual([
      'primero',
      'segundo',
    ]);
    expect(result.total).toBe(2);
    // Publicar 5 agentes de la misma cuenta compra 2 estrenos, no 5.
    expect(result.excluded?.reputation).toBe(3);
    expect(result.excluded?.trialAvailable).toBe(2);
  });

  it('el cupo es POR PUBLICADOR: dos owners distintos tienen M cada uno', async () => {
    serve([]);
    mockListAsAgents.mockResolvedValue([
      local('o1-a'),
      local('o1-b'),
      local('o2-a'),
      local('o2-b'),
    ]);
    anchors([
      ['o1-a', { ownerRef: 'owner-1', createdAt: '2026-01-01T00:00:00Z' }],
      ['o1-b', { ownerRef: 'owner-1', createdAt: '2026-02-02T00:00:00Z' }],
      ['o2-a', { ownerRef: 'owner-2', createdAt: '2026-01-01T00:00:00Z' }],
      ['o2-b', { ownerRef: 'owner-2', createdAt: '2026-02-02T00:00:00Z' }],
    ]);
    process.env.TRIAL_MAX_AGENTS_PER_PUBLISHER = '1';

    const result = await discoveryService.discover({
      minReputation: 2,
      allowTrial: true,
    });

    expect(result.agents.map((a) => a.slug).sort()).toEqual(['o1-a', 'o2-a']);
  });

  it('M sale de la env (`TRIAL_MAX_AGENTS_PER_PUBLISHER`), no de un 2 hardcodeado', async () => {
    serve([]);
    mockListAsAgents.mockResolvedValue([local('a'), local('b'), local('c')]);
    anchors([
      ['a', { ownerRef: 'owner-1', createdAt: '2026-01-01T00:00:00Z' }],
      ['b', { ownerRef: 'owner-1', createdAt: '2026-02-02T00:00:00Z' }],
      ['c', { ownerRef: 'owner-1', createdAt: '2026-03-03T00:00:00Z' }],
    ]);
    process.env.TRIAL_MAX_AGENTS_PER_PUBLISHER = '3';

    const result = await discoveryService.discover({
      minReputation: 2,
      allowTrial: true,
    });

    expect(result.agents.map((a) => a.slug).sort()).toEqual(['a', 'b', 'c']);
  });
});

// ── T-17 (CD-8) · una sola expresión del predicado ──────────────────────
describe('T-17 (CD-8) · k admitidos ⟺ k badges ⟺ `trialAvailable === k`', () => {
  it('el contador, el filtro y el badge coinciden en el MISMO escenario', async () => {
    serve([]);
    mockListAsAgents.mockResolvedValue([
      local('nuevo-1'),
      local('nuevo-2'),
      local('nuevo-3'),
      local('penalizado'),
    ]);
    anchors([
      ['nuevo-1', { ownerRef: 'o1', createdAt: '2026-01-01T00:00:00Z' }],
      ['nuevo-2', { ownerRef: 'o2', createdAt: '2026-01-01T00:00:00Z' }],
      ['nuevo-3', { ownerRef: 'o3', createdAt: '2026-01-01T00:00:00Z' }],
      ['penalizado', { ownerRef: 'o4', createdAt: '2026-01-01T00:00:00Z' }],
    ]);
    standings([['penalizado', counters({ failedCount: 1 })]]);

    const result = await discoveryService.discover({
      minReputation: 2,
      allowTrial: true,
    });

    const badges = result.agents.filter((a) => a.trial?.granted === true);
    expect(badges).toHaveLength(3);
    expect(result.excluded?.trialAvailable).toBe(3);
    expect(result.agents).toHaveLength(3);
  });

  it('sin opt-in `trialAvailable` es una COTA SUPERIOR (pre-cupo) y hay CERO badges', async () => {
    // Documentado en el tipo: sin `allowTrial` no se pueden leer las anclas (CD-9),
    // así que el cupo M no se puede aplicar y el número queda por encima del real.
    serve([]);
    mockListAsAgents.mockResolvedValue([
      local('nuevo-1'),
      local('nuevo-2'),
      local('nuevo-3'),
    ]);

    const result = await discoveryService.discover({ minReputation: 2 });

    expect(result.excluded?.trialAvailable).toBe(3);
    expect(result.agents).toHaveLength(0);
    expect(mockListAnchors).not.toHaveBeenCalled();
  });
});

// ── T-03 (AC-3) · el vacío deja de ser mudo ─────────────────────────────
describe('T-03 (AC-3) · `excluded.reputation` cuenta los que descartó el PISO', () => {
  it('minReputation=50 con 3 descartados → `excluded.reputation === 3`', async () => {
    serve([raw('a'), raw('b'), raw('c'), raw('pasa')]);
    standings([
      ['a', counters({ tasksSettled: 5, reputation: rep(10) })],
      ['b', counters({ tasksSettled: 5, reputation: rep(20) })],
      ['c', counters({ tasksSettled: 5, reputation: rep(30) })],
      ['pasa', counters({ tasksSettled: 40, reputation: rep(80) })],
    ]);

    const result = await discoveryService.discover({ minReputation: 50 });

    expect(result.excluded?.reputation).toBe(3);
    expect(result.agents.map((a) => a.slug)).toEqual(['pasa']);
  });

  it('el contador es PRE-`slice`: la página no lo cambia', async () => {
    serve([raw('a'), raw('b'), raw('c'), raw('d')]);
    standings([
      ['a', counters({ tasksSettled: 40, reputation: rep(90) })],
      ['b', counters({ tasksSettled: 40, reputation: rep(80) })],
    ]);

    const result = await discoveryService.discover({
      minReputation: 50,
      limit: 1,
    });

    // 2 descartados por el piso (c y d, sin score), y eso NO depende de `limit`.
    expect(result.excluded?.reputation).toBe(2);
    expect(result.agents).toHaveLength(1);
    expect(result.total).toBe(2);
  });

  it('el ADMITIDO no se cuenta como excluido: pasó el filtro', async () => {
    serve([raw('admitido'), raw('penalizado')]);
    standings([['penalizado', counters({ failedCount: 1 })]]);

    const result = await discoveryService.discover({
      minReputation: 2,
      allowTrial: true,
    });

    expect(result.agents.map((a) => a.slug)).toEqual(['admitido']);
    expect(result.excluded?.reputation).toBe(1);
    expect(result.excluded?.trialAvailable).toBe(1);
  });

  it('R-5: `total` SUBE con `allowTrial` — cambio observable para quien pagina', async () => {
    serve([raw('nuevo')]);
    const sin = await discoveryService.discover({ minReputation: 2 });
    expect(sin.total).toBe(0);

    serve([raw('nuevo')]);
    const con = await discoveryService.discover({
      minReputation: 2,
      allowTrial: true,
    });
    expect(con.total).toBe(1);
  });
});

// ── T-13 (CD-9) · COSTO DE I/O, asertado por LLAMADAS ───────────────────
describe('T-13 (CD-9) · el camino por defecto no gasta ni una query nueva', () => {
  it('sin `allowTrial`: standing 1 llamada, ancla 0', async () => {
    serve([raw('nuevo')]);

    await discoveryService.discover({ minReputation: 2 });

    expect(mockStandingBatch).toHaveBeenCalledTimes(1);
    expect(mockListAnchors).toHaveBeenCalledTimes(0);
  });

  it('con `allowTrial` y un elegible: standing 1, ancla 1', async () => {
    serve([raw('nuevo')]);

    await discoveryService.discover({ minReputation: 2, allowTrial: true });

    expect(mockStandingBatch).toHaveBeenCalledTimes(1);
    expect(mockListAnchors).toHaveBeenCalledTimes(1);
  });

  it('con `allowTrial` y `minReputation` AUSENTE: ancla 0 (no hay piso que relajar)', async () => {
    serve([raw('nuevo')]);

    await discoveryService.discover({ allowTrial: true });

    expect(mockStandingBatch).toHaveBeenCalledTimes(1);
    expect(mockListAnchors).toHaveBeenCalledTimes(0);
  });

  it('con `allowTrial` y CERO elegibles: ancla 0 (no se pregunta al vacío)', async () => {
    serve([raw('penalizado')]);
    standings([['penalizado', counters({ failedCount: 1 })]]);

    await discoveryService.discover({ minReputation: 2, allowTrial: true });

    expect(mockListAnchors).toHaveBeenCalledTimes(0);
  });
});
