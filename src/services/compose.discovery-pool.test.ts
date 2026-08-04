/**
 * AR BLQ-BAJO-1 — el pool de agentes que `/compose` usa para hidratar
 * `payment.chain` NO puede ser un ranking top-N.
 *
 * ─── El bug ──────────────────────────────────────────────────────────────
 * `compose.resolveAgent` pedía `discover({ limit: 50 })` para dos cosas del
 * money-path: (a) hidratar el `payment.chain` REAL (WKH-113/BASE-08 — `getAgent`
 * de v2 hardcodea `chain=avalanche`) y (b) resolver un step por slug. Ese pool es
 * el TOP-50 RANKEADO (verified-first → reputación desc → precio asc).
 *
 * El fix del hallazgo 1 (over-fetch) hizo que el ranking se calcule sobre ≤200
 * filas por registry en vez de ≤50: MISMOS 50 SLOTS, 4× CANDIDATOS ⇒ la membresía
 * del top-50 cambia y un agente que antes entraba puede quedar afuera. Si el que
 * queda afuera es un agente non-EVM resuelto vía `agentEndpoint`, pierde la
 * hidratación → `payment.chain` se queda en el default de `getAgent`
 * (`avalanche`) → el leg downstream se saltea o apunta al rail equivocado:
 * **el agente no se cobra, en silencio**.
 *
 * ─── Por qué este test NO mockea `discoveryService` ──────────────────────
 * El bug vive en la INTERACCIÓN entre el page size que pide `compose` y el
 * over-fetch que `queryRegistry` manda upstream. Un mock de `discover()` (como en
 * `compose.chain-flow.test.ts`) fabrica el pool y por construcción no puede
 * observarlo. Acá se mockea sólo el borde de red (undici) y el resto del pipeline
 * de discovery es el real, igual que en `discovery.limit.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegistryConfig } from '../types/index.js';

// WKH-318 corte B: el factory anterior devolvía un objeto NUEVO por llamada, así
// que el `vi.fn()` que `discovery.ts:63` capturó era inalcanzable desde el test.
// Patrón hoisted, exemplar `compose.test.ts:17-23`.
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
  SYSTEM_OWNER_REF: 'system',
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
    getBySlugAsAgent: vi.fn().mockResolvedValue(null),
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

// ── Mocks para el path COMPLETO de `compose()` (T-POOL-7) ────────────────
// El resto de los tests sólo ejercita `resolveAgent`, que no los toca.
vi.mock('./budget.js', () => ({
  budgetService: {
    debit: vi.fn(),
    getBalance: vi.fn(),
    registerDeposit: vi.fn(),
    recordSolanaSettleReceipt: vi.fn(),
  },
}));
vi.mock('./event.js', () => ({
  eventService: { track: vi.fn().mockResolvedValue({}) },
}));
vi.mock('../adapters/registry.js', () => ({
  getPaymentAdapter: () => ({ sign: vi.fn(), settle: vi.fn() }),
}));
vi.mock('./llm/transform.js', () => ({
  maybeTransform: vi.fn().mockResolvedValue({
    transformedOutput: null,
    cacheHit: 'SKIPPED',
    bridgeType: 'SKIPPED',
    latencyMs: 0,
  }),
}));
vi.mock('../lib/downstream-payment.js', () => ({
  signAndSettleDownstream: vi.fn().mockResolvedValue(null),
}));

import { signAndSettleDownstream } from '../lib/downstream-payment.js';
import type { Agent } from '../types/index.js';
import { composeService } from './compose.js';
import { registryService } from './registry.js';

const mockDownstream = vi.mocked(signAndSettleDownstream);

/** Mint USDC de devnet — payTo Solana válido (base58, no 0x). */
const SOLANA_PAY_TO = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const BASE_PAY_TO = '0x000000000000000000000000000000000000aBcD';
const TARGET = 'remit-solana';

/**
 * Registry con `limitParam` (así están los dos registries reales del repo) y con
 * `agentEndpoint`, para que `getAgent` resuelva por su cuenta como en prod.
 */
function makeRegistry(o: Partial<RegistryConfig> = {}): RegistryConfig {
  return {
    id: 'reg-1',
    name: 'test-registry',
    discoveryEndpoint: 'https://example.com/agents',
    agentEndpoint: 'https://example.com/agent/{slug}',
    invokeEndpoint: 'https://example.com/invoke/{slug}',
    schema: { discovery: { limitParam: 'limit' }, invoke: { method: 'POST' } },
    enabled: true,
    createdAt: new Date(),
    ownerRef: 'system',
    ...o,
  };
}

function card(
  slug: string,
  verified: boolean,
  payment?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: slug,
    slug,
    name: slug,
    description: 'desc',
    capabilities: ['x'],
    price: 0,
    reputation: 10,
    verified,
    status: 'active',
    ...(payment ? { payment } : {}),
  };
}

/**
 * Catálogo de `total` agentes activos con el target en la posición `pos` del
 * registry y NO verificado, mientras los fillers SÍ lo están: el sort de discovery
 * es verified-first, así que el target queda ÚLTIMO del ranking — o sea el primero
 * en caerse de un pool top-N, que es el disparo del bug. El target declara una
 * `chain` non-EVM; los fillers no declaran payment.
 *
 * (Se rankea por `verified` y no por precio para poder dejar todos los precios en
 * 0: así `compose()` no entra en el path de cobro al caller, que no es lo que este
 * test mide.)
 */
function catalogWithTarget(
  total: number,
  pos: number,
  chain: string,
  contract: string,
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < total; i++) {
    if (i === pos) {
      rows.push(
        card(TARGET, false, { method: 'x402', chain, contract, asset: 'USDC' }),
      );
    } else {
      rows.push(card(`filler-${i}`, true));
    }
  }
  return rows;
}

/**
 * Registry que HONRA `?limit=N` (devuelve sus primeras N filas) para el discovery,
 * y sirve el `agentEndpoint` con el payment HARDCODEADO a avalanche — que es
 * exactamente lo que hace el `getAgent` de v2 (WKH-113/H14) y la razón por la que
 * la hidratación desde discover existe.
 */
function serveRegistry(rows: Record<string, unknown>[]): {
  upstreamLimits: (string | null)[];
} {
  const upstreamLimits: (string | null)[] = [];
  mockFetch.mockImplementation((rawUrl: string) => {
    const url = new URL(rawUrl);
    if (url.pathname.startsWith('/agent/')) {
      const slug = url.pathname.replace('/agent/', '');
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            card(slug, false, {
              method: 'x402',
              chain: 'avalanche',
              contract: BASE_PAY_TO,
            }),
          ),
      });
    }
    if (url.pathname.startsWith('/invoke/')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ result: 'ok' }),
      });
    }
    const lim = url.searchParams.get('limit');
    upstreamLimits.push(lim);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(lim ? rows.slice(0, Number(lim)) : rows),
    });
  });
  return { upstreamLimits };
}

describe('compose.resolveAgent — pool de hidratación de payment (AR BLQ-BAJO-1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DISCOVERY_UPSTREAM_FETCH_LIMIT;
    vi.mocked(registryService.getEnabled).mockResolvedValue([makeRegistry()]);
    vi.mocked(registryService.getWithSecrets).mockResolvedValue(makeRegistry());
    mockDownstream.mockResolvedValue(null);
  });

  it('T-POOL-1 (BLOQUEANTE): con 150 candidatos, un agente SOLANA fuera del top-50 SIGUE hidratando payment.chain', async () => {
    // 150 activos; el target en la posición 5 del registry y el más caro de todos
    // ⇒ último por `price asc` ⇒ el primero que se cae de un pool top-50.
    // Con `discover({limit:50})`: pool=50, el target NO está, `payment.chain`
    // queda en 'avalanche' (el hardcode de getAgent) → leg al rail equivocado.
    serveRegistry(catalogWithTarget(150, 5, 'solana-devnet', SOLANA_PAY_TO));

    const agent = await composeService.resolveAgent({
      agent: TARGET,
      input: {},
    });

    expect(agent).not.toBeNull();
    expect(agent?.payment?.chain).toBe('solana-devnet');
    expect(agent?.payment?.contract).toBe(SOLANA_PAY_TO);
  });

  it('T-POOL-2 (BLOQUEANTE): idem con un agente BASE (el caso original de WKH-113)', async () => {
    serveRegistry(catalogWithTarget(150, 5, 'base-sepolia', BASE_PAY_TO));

    const agent = await composeService.resolveAgent({
      agent: TARGET,
      input: {},
    });

    expect(agent?.payment?.chain).toBe('base-sepolia');
  });

  it('T-POOL-3: el page size del pool es IGUAL al over-fetch que se le pide al registry', async () => {
    // Lo que acota la clase de bug: con el page size del pool igual al fetch
    // pedido, el `slice` no descarta candidatos traídos — PRECONDICIÓN: una sola
    // fuente contribuyente (el `slice` es global y el fetch por registry; con la
    // unión de N fuentes por encima de la ventana la propiedad se cae, ver
    // `lib/discovery-fetch-limit.ts` y TD-189-1). Este test corre justo con esa
    // precondición: un único registry.
    const { upstreamLimits } = serveRegistry(
      catalogWithTarget(150, 5, 'solana-devnet', SOLANA_PAY_TO),
    );

    await composeService.resolveAgent({ agent: TARGET, input: {} });

    expect(upstreamLimits.length).toBeGreaterThan(0);
    expect(new Set(upstreamLimits)).toEqual(new Set(['200']));
  });

  it('T-POOL-4: el pool sigue a DISCOVERY_UPSTREAM_FETCH_LIMIT (un solo knob, sin desalinearse)', async () => {
    process.env.DISCOVERY_UPSTREAM_FETCH_LIMIT = '300';
    const { upstreamLimits } = serveRegistry(
      catalogWithTarget(280, 200, 'solana-devnet', SOLANA_PAY_TO),
    );

    const agent = await composeService.resolveAgent({
      agent: TARGET,
      input: {},
    });

    expect(new Set(upstreamLimits)).toEqual(new Set(['300']));
    // 280 candidatos, target en la posición 200 y el más caro: entra porque el
    // pool es 300.
    expect(agent?.payment?.chain).toBe('solana-devnet');
  });

  it('T-POOL-5: el piso de 50 se preserva si el operador baja el over-fetch', async () => {
    process.env.DISCOVERY_UPSTREAM_FETCH_LIMIT = '10';
    const { upstreamLimits } = serveRegistry(
      catalogWithTarget(40, 30, 'solana-devnet', SOLANA_PAY_TO),
    );

    const agent = await composeService.resolveAgent({
      agent: TARGET,
      input: {},
    });

    // `resolveUpstreamFetchLimit(50)` = max(50, 10) = 50 → el pool NO baja de 50
    // (y el fetch tampoco: sigue alineado).
    expect(new Set(upstreamLimits)).toEqual(new Set(['50']));
    expect(agent?.payment?.chain).toBe('solana-devnet');
  });

  it('T-POOL-6 (fallback por slug): un agente sin agentEndpoint resoluble se resuelve del MISMO pool', async () => {
    // `getAgent` falla (404) → `resolveAgent` cae al fallback por slug sobre el
    // pool. Mismo pool, misma membresía: el agente caro tiene que aparecer.
    const rows = catalogWithTarget(150, 5, 'solana-devnet', SOLANA_PAY_TO);
    mockFetch.mockImplementation((rawUrl: string) => {
      const url = new URL(rawUrl);
      if (url.pathname.startsWith('/agent/')) {
        return Promise.resolve({ ok: false, status: 404, json: () => null });
      }
      const lim = url.searchParams.get('limit');
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(lim ? rows.slice(0, Number(lim)) : rows),
      });
    });

    const agent = await composeService.resolveAgent({
      agent: TARGET,
      input: {},
    });

    expect(agent).not.toBeNull();
    expect(agent?.slug).toBe(TARGET);
    expect(agent?.payment?.chain).toBe('solana-devnet');
  });

  it('T-POOL-7 (borde del settle, path REAL de /compose): la chain solana llega a signAndSettleDownstream con 150 candidatos', async () => {
    // Éste es el path que corre en prod: `compose()` crea el `DiscoverCache`, así
    // que el pool sale de `createDiscoverCache`, NO del fallback de `resolveAgent`.
    // Si los dos productores del pool se desalinean, este test lo caza.
    serveRegistry(catalogWithTarget(150, 5, 'solana-devnet', SOLANA_PAY_TO));

    const result = await composeService.compose({
      steps: [{ agent: TARGET, input: { q: 'x' } }],
    });

    expect(result.success).toBe(true);
    expect(mockDownstream).toHaveBeenCalledTimes(1);
    const agentAtSettle = mockDownstream.mock.calls[0]?.[0] as Agent;
    expect(agentAtSettle.payment?.chain).toBe('solana-devnet');
    expect(agentAtSettle.payment?.contract).toBe(SOLANA_PAY_TO);
  });

  // ─── WKH-318 corte B: el clamp visto desde el money-path ───────────────────

  /** Registro que declara el techo que la migración de W2 le pone a `wasiai`. */
  function registryWithMaxLimit(max: number): RegistryConfig {
    return makeRegistry({
      schema: {
        discovery: { limitParam: 'limit', maxLimit: max },
        invoke: { method: 'POST' },
      },
    });
  }

  /**
   * `serveRegistry` + el techo MEDIDO del registro real: `?limit>100` ⇒ 400.
   * Sin clamp, el pool de `/compose` (200) choca contra ese 400 y la fuente cae
   * entera, así que el agente no existe para `resolveAgent`.
   */
  function serveRegistryWithCeilingOf100(rows: Record<string, unknown>[]): {
    upstreamLimits: (string | null)[];
  } {
    const upstreamLimits: (string | null)[] = [];
    mockFetch.mockImplementation((rawUrl: string) => {
      const url = new URL(rawUrl);
      if (url.pathname.startsWith('/agent/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve(
              card(url.pathname.replace('/agent/', ''), false, {
                method: 'x402',
                chain: 'avalanche',
                contract: BASE_PAY_TO,
              }),
            ),
        });
      }
      if (url.pathname.startsWith('/invoke/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ result: 'ok' }),
        });
      }
      const lim = url.searchParams.get('limit');
      upstreamLimits.push(lim);
      if (lim !== null && Number(lim) > 100) {
        return Promise.resolve({ ok: false, status: 400 });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(lim ? rows.slice(0, Number(lim)) : rows),
      });
    });
    return { upstreamLimits };
  }

  it('T-CLAMP-05 (borde del settle): con el techo declarado, la chain solana llega a signAndSettleDownstream contra un registro que rechaza limit>100 (AC-5)', async () => {
    // Path REAL de `/compose` (patrón T-POOL-7): el pool sale de
    // `createDiscoverCache`, no del fallback de `resolveAgent`.
    vi.mocked(registryService.getEnabled).mockResolvedValue([
      registryWithMaxLimit(100),
    ]);
    vi.mocked(registryService.getWithSecrets).mockResolvedValue(
      registryWithMaxLimit(100),
    );
    // 100 activos; el target NO verificado ⇒ último del ranking ⇒ fuera del
    // top-50, o sea que sólo lo alcanza un pool grande.
    const { upstreamLimits } = serveRegistryWithCeilingOf100(
      catalogWithTarget(100, 5, 'solana-devnet', SOLANA_PAY_TO),
    );

    const result = await composeService.compose({
      steps: [{ agent: TARGET, input: { q: 'x' } }],
    });

    expect(new Set(upstreamLimits)).toEqual(new Set(['100']));
    expect(result.success).toBe(true);
    expect(mockDownstream).toHaveBeenCalledTimes(1);
    const agentAtSettle = mockDownstream.mock.calls[0]?.[0] as Agent;
    expect(agentAtSettle.payment?.chain).toBe('solana-devnet');
    expect(agentAtSettle.payment?.contract).toBe(SOLANA_PAY_TO);
  });

  it('T-CLAMP-07: un techo POR ENCIMA del piso histórico no rompe la hidratación (AC-7)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([
      registryWithMaxLimit(100),
    ]);
    vi.mocked(registryService.getWithSecrets).mockResolvedValue(
      registryWithMaxLimit(100),
    );
    // 150 en el registro, se traen las primeras 100 (el target entre ellas) y el
    // page size del pool NO se recorta: el target, último del ranking por no
    // estar verificado, sigue dentro.
    serveRegistry(catalogWithTarget(150, 5, 'solana-devnet', SOLANA_PAY_TO));

    const agent = await composeService.resolveAgent({
      agent: TARGET,
      input: {},
    });

    expect(agent?.payment?.chain).toBe('solana-devnet');
    expect(agent?.payment?.contract).toBe(SOLANA_PAY_TO);
  });

  it('T-CLAMP-07b (residual honesto): un techo POR DEBAJO del piso hunde el pool, avisa y NO se le pone piso (AC-7, TD-318B-2)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([
      registryWithMaxLimit(10),
    ]);
    vi.mocked(registryService.getWithSecrets).mockResolvedValue(
      registryWithMaxLimit(10),
    );
    const { upstreamLimits } = serveRegistry(
      catalogWithTarget(200, 5, 'solana-devnet', SOLANA_PAY_TO),
    );
    await composeService.resolveAgent({ agent: TARGET, input: {} });

    // Se manda 10, NO 50: poner un piso le mandaría a un registro que declaró 10
    // un número que rechaza, y perderíamos la fuente entera en vez de sus 10 filas.
    expect(new Set(upstreamLimits)).toEqual(new Set(['10']));
    expect(logSpy.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        error_code: 'REGISTRY_MAX_LIMIT_BELOW_COMPOSE_POOL',
      }),
      expect.anything(),
    );
  });
});
