/**
 * WKH-303 — tests de DINERO del quote freeze (archivo #10, 7 tests).
 *
 * Harness clonado de `orchestrate.billing.test.ts`: corre el COMPOSE REAL y el
 * ORCHESTRATE REAL, y solo mockea el borde (budget, discovery, adapters, fetch...).
 * Encima agrega un LEDGER CON ESTADO: el doble de `budgetService.debit` descuenta de
 * `balanceUsd` y `getBalance` la lee. Cada test mide el saldo ANTES y DESPUÉS.
 *
 * Por qué el saldo y no el status code (CD-13): un test que solo mira
 * `res.statusCode === 409` pasa igual si el código debitó antes de responder. Eso ya
 * pasó tres veces en este repo. Acá todo camino de rechazo afirma
 * `saldoAntes === saldoDespués` **y** que `debit` nunca fue llamado.
 *
 * CD-14: el doble de `debit` captura TODOS sus argumentos (monto, key, chain, contexto,
 * destino, owner) y se tipa con el retorno real de la función; el de
 * `resolveAgentPriceUsdc` también. Un doble que descarta argumentos hace vacuo el test.
 *
 *  - T-Q-B1 congelado 0.05, vivo SUBE a 0.09      → se debita 0.05
 *  - T-Q-B2 3 steps congelados, vivos más caros   → 0.18, cada uno con SU precio
 *  - T-Q-B3 congelado 0.05, vivo BAJA a 0.01      → se debita 0.05 (simétrico)
 *  - T-Q-B4 quote expirado, en los 3 contextos    → saldo idéntico, 0 débitos
 *  - T-Q-B5 agente congelado que ya no resuelve   → saldo idéntico, 0 débitos
 *  - T-Q-B6 SIN quote, vivo 0.09                  → se debita 0.09 (camino de hoy)
 *  - T-Q-B7 quote con un precio 0                 → 400 y saldo idéntico
 */
import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { A2AAgentKeyRow, Agent } from '../types/index.js';

// ── Anthropic: sin API key → planner greedy determinístico ──
const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  // biome-ignore lint/complexity/useArrowFunction: new-able mock constructor
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }),
}));

// ── Middlewares: pass-through, igual que orchestrate.test.ts ──
let nextKeyRow: Partial<A2AAgentKeyRow> | undefined;
let nextDelegationContext: { delegationId: string } | undefined;
let nextKeySessionContext: { sessionId: string } | undefined;
// HU-DOUBLE-PAY: factory con `importOriginal` — `routes/orchestrate.ts` importa
// `extractRawKey` de ESTE módulo para derivar la credencial del caller. Una
// factory sin `importOriginal` lo dejaba `undefined` y el route reventaba en 500
// (el modo de fallo que documenta doc/sdd/189-.../auto-blindaje.md). Se usa la
// función REAL a propósito: re-implementarla en el mock la volvería un doble que
// no puede detectar una divergencia con la extracción del middleware.
vi.mock('../middleware/a2a-key.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../middleware/a2a-key.js')>()),
  requirePaymentOrA2AKey: () => [
    async (request: FastifyRequest, _reply: FastifyReply) => {
      (request as unknown as { a2aKeyRow: unknown }).a2aKeyRow = nextKeyRow;
      (request as unknown as { delegationContext: unknown }).delegationContext =
        nextDelegationContext;
      (request as unknown as { keySessionContext: unknown }).keySessionContext =
        nextKeySessionContext;
      (request as unknown as { resolvedChainId: unknown }).resolvedChainId =
        2368;
    },
  ],
}));
vi.mock('../middleware/forward-key.js', () => ({
  requireForwardKey: () => [],
}));
vi.mock('../middleware/timeout.js', () => ({
  createTimeoutHandler: () => async () => {
    /* no-op */
  },
}));
vi.mock('../middleware/rate-limit.js', () => ({
  orchestrateRateLimit: () => false,
}));
vi.mock('../middleware/backpressure.js', () => ({
  createBackpressureHandler: () => async () => {
    /* no-op */
  },
}));

// ── Bordes (idénticos al exemplar de billing) ──
vi.mock('./discovery.js', () => ({
  discoveryService: { discover: vi.fn(), getAgent: vi.fn() },
}));
vi.mock('./budget.js', () => ({
  budgetService: {
    debit: vi.fn(),
    credit: vi.fn(),
    getBalance: vi.fn(),
    registerDeposit: vi.fn(),
  },
}));
vi.mock('./event.js', () => ({
  eventService: { track: vi.fn().mockResolvedValue({}) },
}));
vi.mock('./fee-charge.js', async () => {
  const actual =
    await vi.importActual<typeof import('./fee-charge.js')>('./fee-charge.js');
  return {
    ...actual,
    chargeProtocolFee: vi.fn().mockResolvedValue({
      status: 'skipped',
      feeUsdc: 0,
      reason: 'WALLET_UNSET',
    }),
    getProtocolFeeRate: vi.fn().mockReturnValue(0.01),
  };
});
vi.mock('./registry.js', () => ({
  registryService: { getEnabled: vi.fn().mockResolvedValue([]) },
  SYSTEM_OWNER_REF: 'system',
}));
vi.mock('../lib/downstream-payment.js', () => ({
  signAndSettleDownstream: vi.fn().mockResolvedValue(null),
}));
const mockSign = vi.fn().mockResolvedValue({
  xPaymentHeader: '0xsig',
  paymentRequest: {
    authorization: {},
    signature: '0xsig',
    network: 'avalanche-fuji',
  },
});
const mockSettle = vi
  .fn()
  .mockResolvedValue({ success: true, txHash: '0xsettled' });
vi.mock('../adapters/registry.js', () => ({
  getPaymentAdapter: () => ({ sign: mockSign, settle: mockSettle }),
}));
vi.mock('./llm/transform.js', () => ({
  maybeTransform: vi.fn().mockResolvedValue({
    transformedOutput: null,
    cacheHit: 'SKIPPED',
    bridgeType: 'SKIPPED',
    latencyMs: 0,
  }),
}));
// `resolveAgentPriceUsdc` es el precio VIVO que la ruta re-resuelve. Se mockea para
// poder moverlo por encima y por debajo del congelado.
vi.mock('./agent-price.js', () => ({ resolveAgentPriceUsdc: vi.fn() }));

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.stubGlobal('fetch', mockFetch);
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: mockFetch };
});

// ── Imports después de los mocks (compose.js y orchestrate.js NO mockeados) ──
import orchestrateRoutes from '../routes/orchestrate.js';
import { resolveAgentPriceUsdc } from './agent-price.js';
import { budgetService } from './budget.js';
import { discoveryService } from './discovery.js';
import { signQuote } from './orchestrate-quote.js';

const mockDebit = vi.mocked(budgetService.debit);
const mockPrice = vi.mocked(resolveAgentPriceUsdc);
const CHAIN_ID = 2368;
const QUOTE_KEY = 'd'.repeat(64);

/** Argumentos capturados de cada débito (CD-14: se capturan TODOS). */
interface DebitCall {
  keyId: string;
  chainId: number;
  amountUsd: number;
  delegationContext: unknown;
  keySessionContext: unknown;
  destination: string | undefined;
  ownerRef: string;
}

let balanceUsd = 0;
let debitCalls: DebitCall[] = [];

function makeAgent(o: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-x',
    name: 'Agent X',
    slug: 'agent-x',
    description: 'multi-step pipeline agent',
    capabilities: ['step', 'pipeline', 'test'],
    priceUsdc: 0.05,
    reputation: 80,
    registry: 'wasiai',
    registry_id: 'wasiai',
    invokeUrl: 'https://example.com/invoke/agent-x',
    invocationNote: 'Use POST /compose or POST /orchestrate on the gateway.',
    verified: false,
    status: 'active',
    metadata: { payTo: '0x000000000000000000000000000000000000dEaD' },
    ...o,
  };
}

function makeKeyRow(overrides: Partial<A2AAgentKeyRow> = {}): A2AAgentKeyRow {
  return {
    id: 'k1',
    owner_ref: 'owner-test',
    key_hash: crypto.createHash('sha256').update('test').digest('hex'),
    display_name: null,
    budget: { '2368': '10.000000' },
    daily_limit_usd: null,
    daily_spent_usd: '0.000000',
    daily_reset_at: new Date(Date.now() + 86400000).toISOString(),
    allowed_registries: null,
    allowed_agent_slugs: null,
    allowed_categories: null,
    max_spend_per_call_usd: null,
    is_active: true,
    last_used_at: null,
    created_at: '2026-04-27T00:00:00.000Z',
    updated_at: '2026-04-27T00:00:00.000Z',
    erc8004_identity: null,
    kite_passport: null,
    agentkit_wallet: null,
    funding_wallet: null,
    metadata: {},
    require_signature: false,
    ...overrides,
  };
}

function mockFetchOk(data: unknown = { result: 'ok' }): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => data,
  });
}

function withAgents(agents: Agent[]): void {
  vi.mocked(discoveryService.discover).mockResolvedValue({
    agents,
    total: agents.length,
    totalAtLeast: agents.length,
    registries: ['wasiai'],
    sources: [],
    catalogStatus: 'complete',
  });
}

let app: ReturnType<typeof Fastify>;
let quoteEnvSnapshot: string | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  delete process.env.ANTHROPIC_API_KEY;
  // CD-16: se restaura en afterEach, nunca al final del cuerpo del test.
  quoteEnvSnapshot = process.env.ORCHESTRATE_QUOTE_HMAC_KEY;
  process.env.ORCHESTRATE_QUOTE_HMAC_KEY = QUOTE_KEY;

  nextKeyRow = makeKeyRow();
  nextDelegationContext = undefined;
  nextKeySessionContext = undefined;

  // ── Ledger con estado ──
  balanceUsd = 10;
  debitCalls = [];
  mockDebit.mockImplementation(
    async (
      keyId: string,
      chainId: number,
      amountUsd: number,
      delegationContext: unknown,
      keySessionContext: unknown,
      destination: string | undefined,
      ownerRef: string,
    ): Promise<{ success: boolean; error?: string }> => {
      debitCalls.push({
        keyId,
        chainId,
        amountUsd,
        delegationContext,
        keySessionContext,
        destination,
        ownerRef,
      });
      balanceUsd = Number((balanceUsd - amountUsd).toFixed(8));
      return { success: true };
    },
  );
  vi.mocked(budgetService.getBalance).mockImplementation(async () =>
    String(balanceUsd),
  );
  vi.mocked(budgetService.credit).mockImplementation(
    async (
      _keyId: string,
      _chainId: number,
      amountUsd: number,
    ): Promise<{ success: boolean; error?: string }> => {
      balanceUsd = Number((balanceUsd + amountUsd).toFixed(8));
      return { success: true };
    },
  );
  vi.mocked(discoveryService.getAgent).mockResolvedValue(null);

  app = Fastify();
  await app.register(orchestrateRoutes, { prefix: '/orchestrate' });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  if (quoteEnvSnapshot === undefined) {
    delete process.env.ORCHESTRATE_QUOTE_HMAC_KEY;
  } else {
    process.env.ORCHESTRATE_QUOTE_HMAC_KEY = quoteEnvSnapshot;
  }
});

/** Emite un quote real con el módulo de producción. */
function issueQuote(
  steps: { agent: string; registry: string | null; priceUsdc: number }[],
  over: {
    caller?: Parameters<typeof signQuote>[0]['caller'];
    nowMs?: number;
  } = {},
): string {
  const signed = signQuote({
    orchestrationId: 'plan-b',
    caller: over.caller ?? { kind: 'key', id: 'k1' },
    steps,
    ...(over.nowMs !== undefined && { nowMs: over.nowMs }),
  });
  if (signed === null) throw new Error('signQuote devolvió null en el arrange');
  return signed.token;
}

function execute(payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/orchestrate/execute',
    headers: { 'x-a2a-key': 'wasi_a2a_test' },
    payload,
  });
}

describe('WKH-303 — el saldo se mueve EXACTAMENTE por el precio congelado', () => {
  // T-Q-B1 — AC-2
  it('T-Q-B1: congelado 0.05 y el precio vivo SUBE a 0.09 ⇒ se debita 0.05', async () => {
    const a1 = makeAgent({ slug: 'a1', id: 'id1', priceUsdc: 0.09 });
    withAgents([a1]);
    mockPrice.mockResolvedValue(0.09); // el vivo, más caro
    mockFetchOk();
    const quote = issueQuote([
      { agent: 'a1', registry: 'wasiai', priceUsdc: 0.05 },
    ]);

    const antes = balanceUsd;
    const res = await execute({
      orchestrationId: 'plan-b',
      steps: [{ agent: 'a1', registry: 'wasiai', input: { q: 0 } }],
      maxQuotedCostUsdc: 1.0,
      budget: 5.0,
      quote,
    });
    const despues = balanceUsd;

    expect(res.statusCode).toBe(200);
    expect(Number((antes - despues).toFixed(8))).toBe(0.05);
    expect(debitCalls).toHaveLength(1);
    const call = debitCalls[0]!;
    expect(call.amountUsd).toBeCloseTo(0.05, 8);
    expect(call.keyId).toBe('k1');
    expect(call.chainId).toBe(CHAIN_ID);
    expect(call.ownerRef).toBe('owner-test');
    // El gateway absorbe la diferencia: NUNCA se cobró el vivo.
    expect(call.amountUsd).not.toBeCloseTo(0.09, 6);
  });

  // T-Q-B2 — AC-2
  it('T-Q-B2: 3 steps congelados [0.05, 0.06, 0.07] ⇒ 0.18 en total, cada uno con SU precio', async () => {
    const a1 = makeAgent({ slug: 'a1', id: 'id1', priceUsdc: 0.09 });
    const a2 = makeAgent({ slug: 'a2', id: 'id2', priceUsdc: 0.11 });
    const a3 = makeAgent({ slug: 'a3', id: 'id3', priceUsdc: 0.13 });
    withAgents([a1, a2, a3]);
    mockPrice.mockImplementation(async (slug: string) => {
      const live: Record<string, number> = { a1: 0.09, a2: 0.11, a3: 0.13 };
      return live[slug] ?? null;
    });
    mockFetchOk();
    mockFetchOk();
    mockFetchOk();
    const quote = issueQuote([
      { agent: 'a1', registry: 'wasiai', priceUsdc: 0.05 },
      { agent: 'a2', registry: 'wasiai', priceUsdc: 0.06 },
      { agent: 'a3', registry: 'wasiai', priceUsdc: 0.07 },
    ]);

    const antes = balanceUsd;
    const res = await execute({
      orchestrationId: 'plan-b',
      steps: [
        { agent: 'a1', registry: 'wasiai', input: { q: 0 } },
        { agent: 'a2', registry: 'wasiai', input: { q: 1 } },
        { agent: 'a3', registry: 'wasiai', input: { q: 2 } },
      ],
      maxQuotedCostUsdc: 1.0,
      budget: 5.0,
      quote,
    });
    const despues = balanceUsd;

    expect(res.statusCode).toBe(200);
    expect(Number((antes - despues).toFixed(8))).toBe(0.18);
    // Uno a uno: cada débito lleva el congelado de SU índice, no el del vecino
    // ni el vivo. El step-0 lo debita el service; los 1..N, compose.
    expect(debitCalls).toHaveLength(3);
    expect(debitCalls[0]!.amountUsd).toBeCloseTo(0.05, 8);
    expect(debitCalls[1]!.amountUsd).toBeCloseTo(0.06, 8);
    expect(debitCalls[2]!.amountUsd).toBeCloseTo(0.07, 8);
    // El destino canónico viaja en los débitos per-step de compose.
    expect(debitCalls[1]!.destination).toBe('wasiai/a2');
    expect(debitCalls[2]!.destination).toBe('wasiai/a3');
    for (const call of debitCalls) {
      expect(call.keyId).toBe('k1');
      expect(call.chainId).toBe(CHAIN_ID);
      expect(call.ownerRef).toBe('owner-test');
    }
  });

  // T-Q-B3 — AC-2 (§3.4: simétrico, NO Math.min)
  it('T-Q-B3: congelado 0.05 y el precio vivo BAJA a 0.01 ⇒ se debita 0.05, no lo más barato', async () => {
    const a1 = makeAgent({ slug: 'a1', id: 'id1', priceUsdc: 0.01 });
    withAgents([a1]);
    mockPrice.mockResolvedValue(0.01); // el vivo, más barato
    mockFetchOk();
    const quote = issueQuote([
      { agent: 'a1', registry: 'wasiai', priceUsdc: 0.05 },
    ]);

    const antes = balanceUsd;
    const res = await execute({
      orchestrationId: 'plan-b',
      steps: [{ agent: 'a1', registry: 'wasiai', input: { q: 0 } }],
      maxQuotedCostUsdc: 1.0,
      budget: 5.0,
      quote,
    });
    const despues = balanceUsd;

    expect(res.statusCode).toBe(200);
    // Cobrar el precio nuevo, aunque sea más barato, seguiría siendo cobrar un
    // precio que el caller no aprobó.
    expect(Number((antes - despues).toFixed(8))).toBe(0.05);
    expect(debitCalls).toHaveLength(1);
    expect(debitCalls[0]!.amountUsd).toBeCloseTo(0.05, 8);
    expect(debitCalls[0]!.amountUsd).not.toBeCloseTo(0.01, 6);
  });

  // T-Q-B3b — AC-2 (§3.4). El caso que le faltaba a T-Q-B3: la simetría del freeze en
  // los steps 1..N, que es OTRO camino de código (el `debitAmount` de compose; el
  // step-0 lo debita el service). Con un solo step ese camino ni se ejecuta, y con
  // precios vivos MÁS CAROS un `Math.min(congelado, vivo)` devolvería el congelado
  // igual. Hace falta multi-step CON el vivo más barato para que la diferencia
  // aparezca en el saldo.
  it('T-Q-B3b: en los steps 1..N el vivo más BARATO tampoco se cobra: manda el congelado', async () => {
    // Los agentes cotizan barato AHORA; el quote congeló precios más altos.
    const a1 = makeAgent({ slug: 'a1', id: 'id1', priceUsdc: 0.01 });
    const a2 = makeAgent({ slug: 'a2', id: 'id2', priceUsdc: 0.02 });
    withAgents([a1, a2]);
    mockPrice.mockImplementation(async (slug: string) => {
      const live: Record<string, number> = { a1: 0.01, a2: 0.02 };
      return live[slug] ?? null;
    });
    mockFetchOk();
    mockFetchOk();
    const quote = issueQuote([
      { agent: 'a1', registry: 'wasiai', priceUsdc: 0.05 },
      { agent: 'a2', registry: 'wasiai', priceUsdc: 0.06 },
    ]);

    const antes = balanceUsd;
    const res = await execute({
      orchestrationId: 'plan-b',
      steps: [
        { agent: 'a1', registry: 'wasiai', input: { q: 0 } },
        { agent: 'a2', registry: 'wasiai', input: { q: 1 } },
      ],
      maxQuotedCostUsdc: 1.0,
      budget: 5.0,
      quote,
    });
    const despues = balanceUsd;

    expect(res.statusCode).toBe(200);
    // 0.05 (step-0, service) + 0.06 (step-1, compose) — NO 0.05 + 0.02.
    expect(Number((antes - despues).toFixed(8))).toBe(0.11);
    expect(debitCalls).toHaveLength(2);
    expect(debitCalls[0]!.amountUsd).toBeCloseTo(0.05, 8);
    expect(debitCalls[1]!.amountUsd).toBeCloseTo(0.06, 8);
    // Lo que mataría un `Math.min(congelado, vivo)`: jamás el precio vivo.
    expect(debitCalls[1]!.amountUsd).not.toBeCloseTo(0.02, 6);
  });

  // T-Q-B4 — AC-3, en los 3 contextos de débito
  it('T-Q-B4: quote expirado en master, delegación y sesión ⇒ saldo idéntico y CERO débitos', async () => {
    const a1 = makeAgent({ slug: 'a1', id: 'id1', priceUsdc: 0.05 });
    const contexts: { label: string; apply: () => void }[] = [
      {
        label: 'master',
        apply: () => {
          nextDelegationContext = undefined;
          nextKeySessionContext = undefined;
        },
      },
      {
        label: 'delegación',
        apply: () => {
          nextDelegationContext = { delegationId: 'deleg-1' };
          nextKeySessionContext = undefined;
        },
      },
      {
        label: 'sesión',
        apply: () => {
          nextDelegationContext = undefined;
          nextKeySessionContext = { sessionId: 'sess-1' };
        },
      },
    ];

    for (const ctx of contexts) {
      withAgents([a1]);
      mockPrice.mockResolvedValue(0.05);
      ctx.apply();
      // El quote se emite para el caller de ESE contexto, así que el rechazo es
      // por expiración y no por binding.
      const caller =
        nextDelegationContext !== undefined
          ? ({ kind: 'delegation', id: 'deleg-1' } as const)
          : nextKeySessionContext !== undefined
            ? ({ kind: 'session', id: 'sess-1' } as const)
            : ({ kind: 'key', id: 'k1' } as const);
      const quote = issueQuote(
        [{ agent: 'a1', registry: 'wasiai', priceUsdc: 0.05 }],
        { caller, nowMs: Date.now() - 601_000 },
      );

      const antes = balanceUsd;
      const res = await execute({
        orchestrationId: 'plan-b',
        steps: [{ agent: 'a1', registry: 'wasiai', input: { q: 0 } }],
        maxQuotedCostUsdc: 1.0,
        budget: 5.0,
        quote,
      });
      const despues = balanceUsd;

      expect(res.statusCode).toBe(409);
      expect(res.json().error_code).toBe('QUOTE_EXPIRED');
      expect(despues).toBe(antes);
      expect(debitCalls).toHaveLength(0);
      expect(mockDebit).not.toHaveBeenCalled();
    }
  });

  // T-Q-B5 — AC-5
  it('T-Q-B5: agente congelado que ya no resuelve ⇒ saldo idéntico y CERO débitos', async () => {
    withAgents([]);
    mockPrice.mockResolvedValue(null); // ya no resuelve en ningún registry
    const quote = issueQuote([
      { agent: 'a1', registry: 'wasiai', priceUsdc: 0.05 },
    ]);

    const antes = balanceUsd;
    const res = await execute({
      orchestrationId: 'plan-b',
      steps: [{ agent: 'a1', registry: 'wasiai', input: { q: 0 } }],
      maxQuotedCostUsdc: 1.0,
      budget: 5.0,
      quote,
    });
    const despues = balanceUsd;

    expect(res.statusCode).toBe(409);
    expect(res.json().error_code).toBe('QUOTE_AGENT_UNAVAILABLE');
    expect(despues).toBe(antes);
    // Ni el congelado ni el vivo: nada.
    expect(mockDebit).not.toHaveBeenCalled();
  });

  // T-Q-B6 — AC-6 (regresión del camino de hoy)
  it('T-Q-B6: SIN quote, el precio vivo 0.09 se sigue cobrando en vivo', async () => {
    const a1 = makeAgent({ slug: 'a1', id: 'id1', priceUsdc: 0.09 });
    withAgents([a1]);
    mockPrice.mockResolvedValue(0.09);
    mockFetchOk();

    const antes = balanceUsd;
    const res = await execute({
      orchestrationId: 'plan-b',
      steps: [{ agent: 'a1', registry: 'wasiai', input: { q: 0 } }],
      maxQuotedCostUsdc: 1.0,
      budget: 5.0,
    });
    const despues = balanceUsd;

    expect(res.statusCode).toBe(200);
    expect(Number((antes - despues).toFixed(8))).toBe(0.09);
    expect(debitCalls).toHaveLength(1);
    expect(debitCalls[0]!.amountUsd).toBeCloseTo(0.09, 8);
  });

  // T-Q-B7 — AC-3
  it('T-Q-B7: un quote con un precio 0 ⇒ 400 QUOTE_INVALID y saldo idéntico (jamás un débito de $0)', async () => {
    const a1 = makeAgent({ slug: 'a1', id: 'id1', priceUsdc: 0.05 });
    withAgents([a1]);
    mockPrice.mockResolvedValue(0.05);

    // `signQuote` se niega a firmar un precio 0, así que el token con un 0 se
    // fabrica re-firmando el payload con la clave real: la firma VERIFICA y aun
    // así el guard de precio lo rechaza.
    const base = issueQuote([
      { agent: 'a1', registry: 'wasiai', priceUsdc: 0.05 },
    ]);
    const [version, encoded] = base.split('.') as [string, string];
    const payload = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as { steps: { a: string; p: string; r: string | null }[] };
    const firstStep = payload.steps[0];
    if (firstStep !== undefined) firstStep.p = '0.00000000';
    const reencoded = Buffer.from(JSON.stringify(payload), 'utf8').toString(
      'base64url',
    );
    const sig = crypto
      .createHmac('sha256', QUOTE_KEY)
      .update(`${version}.${reencoded}`, 'utf8')
      .digest('hex');
    const zeroQuote = `${version}.${reencoded}.${sig}`;

    const antes = balanceUsd;
    const res = await execute({
      orchestrationId: 'plan-b',
      steps: [{ agent: 'a1', registry: 'wasiai', input: { q: 0 } }],
      maxQuotedCostUsdc: 1.0,
      budget: 5.0,
      quote: zeroQuote,
    });
    const despues = balanceUsd;

    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('QUOTE_INVALID');
    expect(despues).toBe(antes);
    expect(mockDebit).not.toHaveBeenCalled();
  });
});
