/**
 * Compose HTTP e2e flow — audit 2026-06-24 (P0)
 *
 * Closes the e2e gap: there was no HTTP happy-path that drives the REAL
 * composeService through the route over the wire. This file mounts the real
 * `composeRoutes` + real `composeService` and mocks only the leaf I/O:
 *   - a2a-key middleware (pass-through; injects a2aKeyRow + price fields, like
 *     the AUDIT A1 pattern in routes/compose.test.ts),
 *   - agent-price resolvers (so the price preHandler resolves),
 *   - discovery.getAgent / discovery.discover (resolve the per-step agents),
 *   - budget.debit / credit / creditWithDest (per-step debit + step-0 refund),
 *   - registryService.getEnabled, the payment adapter, fee-charge, receipt,
 *     event, the LLM bridge + downstream payment, and global fetch
 *     (the agent HTTP call).
 *
 * Scenarios:
 *   P0-1  2-step happy path → 200, success, both step outputs, totalCostUsdc.
 *   P0-2  2-step where step-2's agent returns 500 → 4xx, success=false, and the
 *         route's step-0 refund is attempted (creditWithDest).
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { Agent } from '../../types/index.js';

// ── Mock auth middleware (pass-through, injects price/debit fields) ──
let nextKeyRow: { id: string; owner_ref: string } | undefined;
let nextEstimatedCostUsd: number | undefined;
let nextResolvedChainId: number | undefined;
let nextInjectedDestination: string | undefined;
vi.mock('../../middleware/a2a-key.js', () => ({
  // C2 (audit 2026-07-01): routes/compose.ts imports extractRawKey.
  extractRawKey: (request: FastifyRequest) => {
    const headerKey = request.headers['x-a2a-key'];
    if (typeof headerKey === 'string') return headerKey;
    const auth = request.headers.authorization;
    if (typeof auth === 'string') {
      const m = /^bearer\s+(.+)$/i.exec(auth);
      if (m?.[1]?.startsWith('wasi_a2a_')) return m[1];
    }
    return undefined;
  },
  // WKH-225: `routes/compose.ts` registra además `POST /compose/resume`, cuya
  // cadena de preHandlers usa `requireA2AKey` (autentica SIN debitar: el
  // step-0 del run original ya se cobró). Este doble tiene que exportarlo o el
  // plugin no registra y la suite entera se cae al arrancar. Mismo
  // pass-through que el de arriba: no afirma nada nuevo.
  requireA2AKey: () => [
    async (request: FastifyRequest, _reply: FastifyReply) => {
      (request as unknown as { a2aKeyRow: unknown }).a2aKeyRow = nextKeyRow;
    },
  ],
  requirePaymentOrA2AKey: () => [
    async (request: FastifyRequest, _reply: FastifyReply) => {
      (request as unknown as { a2aKeyRow: unknown }).a2aKeyRow = nextKeyRow;
      if (nextEstimatedCostUsd !== undefined) {
        (
          request as unknown as { composeEstimatedCostUsd?: number }
        ).composeEstimatedCostUsd = nextEstimatedCostUsd;
      }
      if (nextResolvedChainId !== undefined) {
        (request as unknown as { resolvedChainId?: number }).resolvedChainId =
          nextResolvedChainId;
      }
      if (nextInjectedDestination !== undefined) {
        (
          request as unknown as { composeDestination?: string }
        ).composeDestination = nextInjectedDestination;
      }
    },
  ],
}));

vi.mock('../../middleware/timeout.js', () => ({
  createTimeoutHandler:
    () => async (_request: FastifyRequest, _reply: FastifyReply) => {
      /* no-op */
    },
}));

vi.mock('../../middleware/forward-key.js', () => ({
  requireForwardKey: () => [],
}));

vi.mock('../../middleware/rate-limit.js', () => ({
  orchestrateRateLimit: () => false,
}));

// ── agent-price resolvers (price preHandler) ────────────────
vi.mock('../../services/agent-price.js', () => ({
  resolveAgentPriceUsdc: vi.fn(),
  resolveAgentDestination: vi.fn(),
}));

// ── budget (per-step debit + step-0 refund) ─────────────────
vi.mock('../../services/budget.js', () => ({
  budgetService: {
    debit: vi.fn().mockResolvedValue({ success: true }),
    credit: vi.fn().mockResolvedValue({ success: true }),
    creditWithDest: vi.fn().mockResolvedValue({ success: true }),
  },
}));

// ── discovery (resolveAgent) ────────────────────────────────
vi.mock('../../services/discovery.js', () => ({
  discoveryService: { getAgent: vi.fn(), discover: vi.fn() },
}));

// ── registry (invokeAgent → getEnabled) ─────────────────────
vi.mock('../../services/registry.js', () => ({
  registryService: { getEnabled: vi.fn().mockResolvedValue([]) },
  SYSTEM_OWNER_REF: 'system',
}));

// ── payment adapter (sign is unused on a2a-key path) ────────
// G-03 (audit 2026-06-30): the compose route now resolves the step-0 gas
// overhead via getDefaultChainKey + getAdaptersBundle (testnet chainId 2368 →
// overhead 0). Provide them so the price preHandler does not 503.
vi.mock('../../adapters/registry.js', () => ({
  getPaymentAdapter: () => ({ sign: vi.fn(), settle: vi.fn() }),
  getDefaultChainKey: () => 'kite-ozone-testnet',
  getAdaptersBundle: () => ({ chainConfig: { chainId: 2368 } }),
}));

// ── fee-charge (best-effort; skip so it's a no-op) ──────────
vi.mock('../../services/fee-charge.js', () => ({
  chargeProtocolFee: vi
    .fn()
    .mockResolvedValue({ status: 'skipped', feeUsdc: 0 }),
  getProtocolFeeRate: vi.fn().mockReturnValue(0.01),
}));

vi.mock('../../services/receipt.js', () => ({
  receiptService: { emit: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../services/event.js', () => ({
  eventService: { track: vi.fn().mockResolvedValue(undefined) },
}));

// ── LLM bridge + downstream payment (leaf I/O) ──────────────
vi.mock('../../services/llm/transform.js', () => ({
  maybeTransform: vi.fn().mockResolvedValue({
    transformedOutput: null,
    cacheHit: 'SKIPPED',
    bridgeType: 'SKIPPED',
    latencyMs: 0,
  }),
}));
vi.mock('../../services/llm/input-retry.js', () => ({
  regenerateInputFromErrors: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../lib/downstream-payment.js', () => ({
  signAndSettleDownstream: vi.fn().mockResolvedValue(null),
}));

// ── WKH-225 (fix-pack AR/BLQ-ALTO-2): el estado del run suspendido ──
// Es la ÚNICA pieza de la reanudación que se dobla. `composeService` entra
// REAL: el punto entero del escenario P0-3 es que el bucle del pipeline corra
// de verdad, porque el agujero vivía justo ahí (el guard `i > 0` saltea el
// índice 0, y en la reanudación no hay middleware que lo haya cobrado).
vi.mock('../../services/suspended-run.js', () => ({
  suspendedRunService: {
    claim: vi.fn(),
    settle: vi.fn().mockResolvedValue({ ok: true }),
    open: vi.fn(),
  },
}));
vi.mock('../../services/refund-outbox.js', () => ({
  refundOutbox: { enqueueRefund: vi.fn().mockResolvedValue(undefined) },
}));

// undici-8 migration (#124): `ssrfFetch` calls undici's OWN `fetch` (not
// the Node global) so the undici-8 Agent and the fetch implementation share a
// version. Route BOTH the global stub and undici's `fetch` to the same
// `mockFetch` so the outbound-call assertions still intercept while the real
// undici `Agent` (connect-time SSRF lookup) stays intact.
const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.stubGlobal('fetch', mockFetch);
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: mockFetch };
});

import * as resumeToken from '../../lib/resume-token.js';
import composeRoutes from '../../routes/compose.js';
import {
  resolveAgentDestination,
  resolveAgentPriceUsdc,
} from '../../services/agent-price.js';
import { budgetService } from '../../services/budget.js';
import { discoveryService } from '../../services/discovery.js';
import { suspendedRunService } from '../../services/suspended-run.js';

const mockResolvePrice = vi.mocked(resolveAgentPriceUsdc);
const mockResolveDest = vi.mocked(resolveAgentDestination);
const mockGetAgent = vi.mocked(discoveryService.getAgent);
const mockDiscoverSvc = vi.mocked(discoveryService.discover);
const mockDebit = vi.mocked(budgetService.debit);
const mockCreditWithDest = vi.mocked(budgetService.creditWithDest);
const mockClaim = vi.mocked(suspendedRunService.claim);
const mockSettleRun = vi.mocked(suspendedRunService.settle);

// ── Fixtures ────────────────────────────────────────────────
function makeAgent(o: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    slug: 'test-agent',
    description: 'A test agent',
    capabilities: ['test'],
    priceUsdc: 0.05,
    registry: 'wasiai',
    registry_id: 'wasiai',
    invokeUrl: 'https://example.com/invoke',
    invocationNote: 'use /compose',
    verified: false,
    status: 'active',
    metadata: {},
    ...o,
  };
}

function okFetch(body: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('compose HTTP e2e flow (P0)', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(composeRoutes, { prefix: '/compose' });
    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    vi.clearAllMocks();
    nextKeyRow = { id: 'k1', owner_ref: 'o1' };
    nextEstimatedCostUsd = undefined;
    nextResolvedChainId = undefined;
    nextInjectedDestination = undefined;
    mockResolvePrice.mockResolvedValue(0.05);
    // WKH-360: `invokeUrl` con host AJENO. Es el default de TODA esta suite e2e,
    // así que un host propio haría que el guard anti-bucle del step-0 cortara cada
    // caso del camino feliz.
    mockResolveDest.mockResolvedValue({
      registry: 'wasiai',
      slug: 'kyc',
      invokeUrl: 'https://agente-ajeno.example/run',
    });
    mockDebit.mockResolvedValue({ success: true });
    mockCreditWithDest.mockResolvedValue({ success: true });
    mockSettleRun.mockResolvedValue({ ok: true });
    // discover fallback (resolveAgent hydration path) returns nothing useful.
    mockDiscoverSvc.mockResolvedValue({
      agents: [],
      total: 0,
      totalAtLeast: 0,
      registries: [],
      sources: [],
      catalogStatus: 'complete',
    });
  });

  // ── P0-1: 2-step happy path ────────────────────────────────
  it('P0-1: 2-step pipeline with a valid a2a key → 200, success, both outputs, totalCostUsdc', async () => {
    nextEstimatedCostUsd = 0.05; // middleware debited step-0
    nextResolvedChainId = 2368;
    nextInjectedDestination = 'wasiai/kyc';

    const kyc = makeAgent({
      id: 'kyc-id',
      slug: 'kyc',
      name: 'KYC',
      priceUsdc: 0.05,
      invokeUrl: 'https://example.com/kyc',
    });
    const corridor = makeAgent({
      id: 'corridor-id',
      slug: 'corridor',
      name: 'Corridor',
      priceUsdc: 0.1,
      invokeUrl: 'https://example.com/corridor',
    });

    // resolveAgent calls getAgent(slug, registry) then getAgent(slug).
    mockGetAgent.mockImplementation(async (slug: string) => {
      if (slug === 'kyc') return kyc;
      if (slug === 'corridor') return corridor;
      return null;
    });

    // Two agent invocations → two distinct outputs.
    mockFetch
      .mockResolvedValueOnce(okFetch({ result: { verified: true } }))
      .mockResolvedValueOnce(okFetch({ result: { corridor: 'US-MX' } }));

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: {
        steps: [
          { agent: 'kyc', input: { user: 'alice' } },
          { agent: 'corridor', input: { amount: 100 } },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    // Both steps executed and produced output.
    expect(body.steps).toHaveLength(2);
    expect(body.steps[0].output).toEqual({ verified: true });
    expect(body.steps[1].output).toEqual({ corridor: 'US-MX' });
    // Final output is the last step's output.
    expect(body.output).toEqual({ corridor: 'US-MX' });
    // totalCostUsdc = sum of per-step prices (0.05 + 0.10).
    expect(body.totalCostUsdc).toBeCloseTo(0.15, 6);
    // Step-2 (i=1) was debited per-step; step-0 was debited by the middleware.
    expect(mockDebit).toHaveBeenCalledTimes(1);
    expect(mockDebit).toHaveBeenCalledWith(
      'k1',
      2368,
      0.1,
      undefined,
      undefined,
      'wasiai/corridor',
      'o1', // F-04 (audit): threaded caller owner_ref
    );
    // Happy path → no refund.
    expect(mockCreditWithDest).not.toHaveBeenCalled();
  });

  // ── P0-2: step-2 agent returns 500 → failure + step-0 refund ──
  it('P0-2: step-2 agent returns 500 → 4xx, success=false, step-2 debit refunded + step-0 refunded', async () => {
    nextEstimatedCostUsd = 0.05; // step-0 pre-debit by middleware
    nextResolvedChainId = 2368;
    nextInjectedDestination = 'wasiai/kyc';

    const kyc = makeAgent({
      id: 'kyc-id',
      slug: 'kyc',
      name: 'KYC',
      priceUsdc: 0.05,
      invokeUrl: 'https://example.com/kyc',
    });
    const corridor = makeAgent({
      id: 'corridor-id',
      slug: 'corridor',
      name: 'Corridor',
      priceUsdc: 0.1,
      invokeUrl: 'https://example.com/corridor',
    });
    mockGetAgent.mockImplementation(async (slug: string) => {
      if (slug === 'kyc') return kyc;
      if (slug === 'corridor') return corridor;
      return null;
    });

    // Step 1 (kyc) succeeds; step 2 (corridor) HTTP 500.
    mockFetch
      .mockResolvedValueOnce(okFetch({ result: { verified: true } }))
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: 'boom' }),
        text: async () => 'internal agent error',
      });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: {
        steps: [
          { agent: 'kyc', input: { user: 'alice' } },
          { agent: 'corridor', input: { amount: 100 } },
        ],
      },
    });

    // Mid-pipeline failure (no SCOPE_DENIED / DEST_CAP) → default 400.
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('Step 1');

    // The service refunds the step-2 per-step debit (WKH-128) via creditWithDest
    // with the corridor destination.
    const corridorRefund = mockCreditWithDest.mock.calls.find(
      (c) => c[4] === 'wasiai/corridor',
    );
    expect(corridorRefund).toBeDefined();
    expect(corridorRefund?.[0]).toBe('k1');
    expect(corridorRefund?.[1]).toBe(2368);
    expect(corridorRefund?.[2]).toBeCloseTo(0.1, 6);
  });

  // ── Single-step happy path (sanity for the simplest HTTP path) ──
  it('P0-1b: single-step pipeline → 200 success with one output', async () => {
    nextEstimatedCostUsd = 0.05;
    nextResolvedChainId = 2368;
    nextInjectedDestination = 'wasiai/kyc';

    const kyc = makeAgent({
      id: 'kyc-id',
      slug: 'kyc',
      priceUsdc: 0.05,
      invokeUrl: 'https://example.com/kyc',
    });
    mockGetAgent.mockResolvedValue(kyc);
    mockFetch.mockResolvedValueOnce(okFetch({ result: { ok: 1 } }));

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { steps: [{ agent: 'kyc', input: {} }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(res.json().steps).toHaveLength(1);
    // Only step-0 → no per-step debit (i=0 guard).
    expect(mockDebit).not.toHaveBeenCalled();
  });

  // ── P0-3 · WKH-225 fix-pack AR/BLQ-ALTO-2 ─────────────────────────────
  //
  // 🔴 EL ÚNICO TEST DE TODO EL REPO QUE CORRE EL BUCLE DEL PIPELINE POR LA
  // RUTA DE REANUDACIÓN. `compose.resume.test.ts` moquea `composeService`
  // ENTERO, así que mide lo que el route DECIDE y no puede ver un centavo de
  // lo que el pipeline hace: por eso el agujero vivió ahí sin que nada lo
  // cazara. Los dos extremos del cable estaban medidos y el tramo del medio no
  // existía.
  //
  // Lo que se afirma es CONSERVACIÓN, no "se llamó al spy": para N steps
  // ejecutados en el tramo reanudado tiene que haber N débitos, y su suma tiene
  // que ser el costo de ese tramo. Con el código anterior el índice 0 del tramo
  // se ejecutaba, `signAndSettleDownstream` le pagaba al agente desde el wallet
  // del operador, `totalCost` lo sumaba y el fee se cobraba sobre esa base — y
  // `budgetService.debit` se llamaba UNA vez para DOS steps.
  describe('P0-3: /compose/resume conserva la plata (fix-pack AR/BLQ-ALTO-2)', () => {
    const RUN_ID = '11111111-1111-1111-1111-111111111111';
    const KEY_ID = 'k1';
    const OWNER = 'o1';
    const SECRETO = 'secreto-e2e-de-test';

    /** Los dos steps que quedaron por correr, con precios DISTINTOS. */
    const PRECIO_A = 0.07;
    const PRECIO_B = 0.11;

    function claimado(over: Record<string, unknown> = {}) {
      return {
        id: RUN_ID,
        owner_ref: OWNER,
        key_id: KEY_ID,
        caller_kind: 'key' as const,
        caller_id: KEY_ID,
        compose_run_id: '22222222-2222-2222-2222-222222222222',
        step_index: 0,
        steps_json: [
          {
            agent: { slug: 'kyc', registry: 'wasiai' },
            output: {},
            costUsdc: 0.05,
            latencyMs: 10,
          },
        ],
        last_output: null,
        remaining_steps: [
          { agent: 'corridor', input: {} },
          { agent: 'payout', input: {} },
        ],
        frozen_step_prices: null,
        total_cost_usdc: '0.05000000',
        max_budget_usdc: null,
        total_latency_ms: 10,
        contracting_chain: [],
        contracting_depth: 0,
        self_host_hint: null,
        chain_id: 2368,
        ...over,
      };
    }

    function tokenDe(): string {
      const { signResumeToken } = resumeToken;
      const firmado = signResumeToken({
        runId: RUN_ID,
        caller: { kind: 'key', id: KEY_ID },
        ttlSeconds: 3600,
      });
      return (firmado as { token: string }).token;
    }

    let secretoPrevio: string | undefined;
    beforeEach(() => {
      secretoPrevio = process.env[resumeToken.RESUME_ENV_VAR];
      process.env[resumeToken.RESUME_ENV_VAR] = SECRETO;
      const corridor = makeAgent({
        id: 'corridor-id',
        slug: 'corridor',
        name: 'Corridor',
        priceUsdc: PRECIO_A,
        // `example.com` y no `*.example`: el guard SSRF resuelve DNS de verdad
        // y un TLD reservado lo hace fallar antes de llegar al fetch dobleado.
        invokeUrl: 'https://example.com/corridor',
      });
      const payout = makeAgent({
        id: 'payout-id',
        slug: 'payout',
        name: 'Payout',
        priceUsdc: PRECIO_B,
        invokeUrl: 'https://example.com/payout',
      });
      mockGetAgent.mockImplementation(async (slug: string) => {
        if (slug === 'corridor') return corridor;
        if (slug === 'payout') return payout;
        return null;
      });
      // Lo que la RUTA cotiza para su propio "step 0" del tramo. Es el mismo
      // par que usa el preHandler de precio de `/compose`.
      mockResolvePrice.mockImplementation(async (slug: string) =>
        slug === 'corridor' ? PRECIO_A : PRECIO_B,
      );
      mockResolveDest.mockImplementation(async (slug: string) => ({
        registry: 'wasiai',
        slug,
        invokeUrl: `https://example.com/${slug}`,
      }));
      mockClaim.mockResolvedValue({ ok: true, run: claimado() as never });
    });

    afterEach(() => {
      if (secretoPrevio === undefined) {
        delete process.env[resumeToken.RESUME_ENV_VAR];
      } else {
        process.env[resumeToken.RESUME_ENV_VAR] = secretoPrevio;
      }
    });

    function reanudar(token: string) {
      return app.inject({
        method: 'POST',
        url: '/compose/resume',
        headers: { 'x-a2a-key': 'wasi_a2a_test' },
        payload: { token },
      });
    }

    it('P0-3a: DOS steps ejecutados ⇒ DOS débitos, y su suma es el costo del tramo', async () => {
      mockFetch
        .mockResolvedValueOnce(okFetch({ result: { corridor: 'US-MX' } }))
        .mockResolvedValueOnce(okFetch({ result: { paid: true } }));

      const res = await reanudar(tokenDe());

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      // Los dos steps del tramo corrieron de verdad.
      expect(body.steps).toHaveLength(3); // 1 previo + 2 del tramo
      // 🔴 LA AFIRMACIÓN DE CONSERVACIÓN. Con el código anterior esto era 1:
      // el índice 0 del tramo se ejecutaba y se le pagaba al agente, pero
      // `budgetService.debit` NO se llamaba por él.
      expect(mockDebit).toHaveBeenCalledTimes(2);
      const montos = mockDebit.mock.calls.map((c) => c[2]);
      expect(montos).toEqual([PRECIO_A, PRECIO_B]);
      // Y cada débito fue al DESTINO canónico de su propio step: un refund
      // posterior tiene que liberar el cap del destino correcto.
      const destinos = mockDebit.mock.calls.map((c) => c[5]);
      expect(destinos).toEqual(['wasiai/corridor', 'wasiai/payout']);
      // Ownership Guard: el owner_ref del caller AUTENTICADO, en los dos.
      expect(mockDebit.mock.calls.map((c) => c[6])).toEqual([OWNER, OWNER]);
      // La suma de lo debitado es el costo del tramo, y el total reportado
      // suma la mitad anterior. Sin esto, "dos débitos" podría cumplirse con
      // dos débitos del monto equivocado.
      const sumaDebitada = montos.reduce((a, b) => a + (b as number), 0);
      expect(sumaDebitada).toBeCloseTo(PRECIO_A + PRECIO_B, 6);
      expect(body.totalCostUsdc).toBeCloseTo(0.05 + sumaDebitada, 6);
      expect(mockSettleRun).toHaveBeenCalledWith(
        RUN_ID,
        OWNER,
        'resumed',
        null,
      );
    });

    it('P0-3b: si el tramo FALLA después del débito, el step 0 del tramo se reembolsa', async () => {
      mockFetch
        .mockResolvedValueOnce(okFetch({ result: { corridor: 'US-MX' } }))
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          json: async () => ({ error: 'boom' }),
          text: async () => 'boom',
        });

      const res = await reanudar(tokenDe());

      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.json().success).toBe(false);
      // Se debitó el step 0 del tramo (la ruta) y el step 1 (el bucle).
      expect(mockDebit).toHaveBeenCalledTimes(2);
      // El que se devuelve es el del step que NO entregó. El del step 0 del
      // tramo queda CLAMPEADO a 0 porque ese step sí entregó y su precio ya
      // está en `totalCostUsdc` — `max(0, debitado - lo ya settleado)`. Es la
      // misma aritmética que `/compose`, y devolver de más sería el bug con el
      // signo cambiado.
      expect(mockCreditWithDest).toHaveBeenCalledTimes(1);
      expect(mockCreditWithDest.mock.calls[0]?.[4]).toBe('wasiai/payout');
      expect(mockSettleRun.mock.calls[0]?.[2]).toBe('failed');
    });

    it('P0-3b2: si el PRIMER step del tramo falla, su débito se devuelve al destino correcto', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: 'boom' }),
        text: async () => 'boom',
      });

      const res = await reanudar(tokenDe());

      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.json().success).toBe(false);
      // Un solo débito: el de la ruta. El bucle murió en su índice 0.
      expect(mockDebit).toHaveBeenCalledTimes(1);
      // 🔴 Y se devuelve ENTERO, al MISMO destino canónico con el que se
      // debitó: si el refund entrara por otro destino, el cap de este nunca se
      // liberaría (cap leak). Con el código anterior no había ni débito ni
      // refund: el caller no pagaba, y el operador sí.
      expect(mockCreditWithDest).toHaveBeenCalledTimes(1);
      expect(mockCreditWithDest.mock.calls[0]?.[2]).toBeCloseTo(PRECIO_A, 6);
      expect(mockCreditWithDest.mock.calls[0]?.[4]).toBe('wasiai/corridor');
      expect(mockDebit.mock.calls[0]?.[5]).toBe(
        mockCreditWithDest.mock.calls[0]?.[4],
      );
    });

    it('P0-3c: un débito RECHAZADO no ejecuta NI UN step y cierra el run', async () => {
      mockDebit.mockResolvedValue({
        success: false,
        error: 'insufficient budget',
      });

      const res = await reanudar(tokenDe());

      expect(res.statusCode).toBe(400);
      expect(res.json().success).toBe(false);
      // 🔴 Cero invocaciones: el guard corta ANTES del primer `invokeAgent`,
      // así que ningún agente cobra por un tramo que el caller no puede pagar.
      expect(mockFetch).not.toHaveBeenCalled();
      // Y nada que reembolsar: el débito no aplicó nada.
      expect(mockCreditWithDest).not.toHaveBeenCalled();
      expect(mockSettleRun.mock.calls[0]?.[2]).toBe('failed');
    });

    it('P0-3d (BLQ-MED-1): el techo del caller vale UNA vez por RUN, no por mitad', async () => {
      // El caller declaró 0.20 y el run YA gastó 0.05. El tramo restante cuesta
      // 0.07 + 0.11 = 0.18, así que 0.05 + 0.18 = 0.23 > 0.20 y el segundo step
      // NO puede correr. Con el techo reiniciado (lo de antes), 0.18 < 0.20 y
      // los dos corrían: el caller pagaba 0.23 habiendo declarado 0.20.
      mockClaim.mockResolvedValue({
        ok: true,
        run: claimado({ max_budget_usdc: '0.20000000' }) as never,
      });
      mockFetch.mockResolvedValueOnce(okFetch({ result: { corridor: 'ok' } }));

      const res = await reanudar(tokenDe());

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.success).toBe(false);
      expect(String(body.error)).toContain('Budget exceeded');
      // El primer step del tramo sí corrió y se pagó; el segundo, no.
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockDebit).toHaveBeenCalledTimes(1);
    });
  });
});
