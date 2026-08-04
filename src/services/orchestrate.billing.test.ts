/**
 * WKH-102 — Integration billing tests for /orchestrate (master path).
 *
 * A diferencia de `orchestrate.test.ts` (que mockea `composeService.compose`
 * por completo), este archivo ejecuta el COMPOSE REAL para probar el número
 * EXACTO de débitos que produce el pipeline. Solo se mockea la capa de borde:
 *   - budgetService.debit  (assert call-count)
 *   - discoveryService     (planning + resolveAgent)
 *   - event / fee-charge / registry / downstream / fetch  (no-ops)
 *
 * Esto valida el fix del revenue leak TD-WKH-101-ORCH: el path master ahora
 * propaga `chainId` a compose, así el guard `i>0 && chainId!==undefined`
 * (compose.ts:130, CD-1 — INTACTO) debita los steps 1..N.
 *
 * AC-1: master multi-step (3 steps) → 2 débitos (steps 1 y 2; el 0 lo debita
 *       el middleware aparte). Antes del fix: 0 débitos (revenue leak).
 * AC-2: el step 0 NO se debita en el service (guard i>0).
 * AC-3: budget insuficiente en step intermedio → corta el pipeline ahí.
 * AC-4: master 1 step → 0 débitos en el service (no-op del fix; el step 0 ya
 *       lo cobró el middleware).
 */
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { A2AAgentKeyRow, Agent } from '../types/index.js';

// ── Anthropic mock (devuelve null client → fallback greedy planner) ──
// No seteamos ANTHROPIC_API_KEY → llmPlan retorna null → greedyPlan ordena
// los agentes descubiertos en pipeline determinístico (passOutput i>0).
const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  // biome-ignore lint/complexity/useArrowFunction: new-able mock constructor
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }),
}));

// ── discovery: usado por orchestrate (planning) Y por compose (resolveAgent) ──
vi.mock('./discovery.js', () => ({
  discoveryService: {
    discover: vi.fn(),
    getAgent: vi.fn(),
  },
}));

// ── budget: el assert principal de estos tests ──
vi.mock('./budget.js', () => ({
  budgetService: {
    debit: vi.fn(),
    // WKH-127: el service hace credit-back si el pipeline falla (master path).
    credit: vi.fn().mockResolvedValue({ success: true }),
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

// Payment adapter: el path master de orchestrate NO pasa `a2aKey` a compose
// (routes/orchestrate.ts solo propaga scopingKeyRow), por lo que invokeAgent
// firma x402 inbound para agentes con priceUsdc>0. Mockeamos sign/settle para
// que el invoke resuelva y la lógica de débito per-step (lo que probamos) corra.
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

// ── Imports after mocks (compose.js NO está mockeado → real) ──
import { budgetService } from './budget.js';
import { discoveryService } from './discovery.js';
import { orchestrateService } from './orchestrate.js';

const mockDebit = vi.mocked(budgetService.debit);

function makeAgent(o: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-x',
    name: 'Agent X',
    slug: 'agent-x',
    // "step"/"pipeline" give the greedy fallback relevance guard (money-path) a
    // token to overlap with these billing goals (all "…step…"/"…pipeline…").
    // These tests force greedy (no API key) and assert billing mechanics, not
    // relevance — the fixture just needs a shared token so the guard stays inert.
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

function mockFetchOk(data: unknown = { result: 'ok' }) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => data,
  });
}

const CHAIN_ID = 2368;

beforeEach(() => {
  vi.clearAllMocks();
  // No API key → llmPlan() returns null → greedy fallback (deterministic order).
  delete process.env.ANTHROPIC_API_KEY;
  mockDebit.mockResolvedValue({ success: true });
  // WKH-127: el service ahora hace pre-check de balance + débito step-0 master +
  // re-lectura del saldo (remaining). getBalance debe devolver un saldo > 0 para
  // que el pre-check pase y el flujo llegue a compose (per-step debits).
  vi.mocked(budgetService.getBalance).mockResolvedValue('10');
  vi.mocked(budgetService.credit).mockResolvedValue({ success: true });
  // resolveAgent fallback path: discover({limit:50}) inside compose returns the
  // same agent set so getAgent-miss is recovered by slug.
  vi.mocked(discoveryService.getAgent).mockResolvedValue(null);
});

/** Configura discover() para que devuelva `agents` tanto al planner como a
 *  resolveAgent (compose llama discover internamente). */
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

describe('orchestrateService — WKH-102 master-path billing (real compose)', () => {
  // T-BILL-1 (AC-1): master 3-step pipeline → 2 débitos reales (steps 1 y 2).
  // ANTES del fix: 0 débitos (chainId=undefined hacía saltar el guard).
  it('T-BILL-1: master 3-step pipeline debits steps 1 and 2 (not step 0)', async () => {
    const a1 = makeAgent({ slug: 'a1', id: 'id1', priceUsdc: 0.01 });
    const a2 = makeAgent({ slug: 'a2', id: 'id2', priceUsdc: 0.02 });
    const a3 = makeAgent({ slug: 'a3', id: 'id3', priceUsdc: 0.03 });
    withAgents([a1, a2, a3]);
    mockFetchOk(); // step 0
    mockFetchOk(); // step 1
    mockFetchOk(); // step 2

    const result = await orchestrateService.orchestrate(
      {
        goal: 'master multi-step',
        budget: 5.0,
        maxAgents: 3,
        scopingKeyRow: makeKeyRow(),
        chainId: CHAIN_ID,
      },
      'orch-bill-1',
    );

    expect(result.pipeline.success).toBe(true);
    // WKH-127 (BLQ-ALTO-1): 3 débitos. El primero es el step-0 del SERVICE (3-arg,
    // SOLO el precio del step-0 = 0.01, NO la suma del plan). Luego compose debita
    // steps 1 y 2 (6-arg con destino). El step-0 ya NO lo debita el middleware.
    expect(mockDebit).toHaveBeenCalledTimes(3);
    // Débito step-0 del service: 3-arg, sin destino, = precio del step-0 (0.01).
    const step0Call = mockDebit.mock.calls[0]!;
    expect(step0Call[0]).toBe('k1');
    expect(step0Call[1]).toBe(CHAIN_ID);
    expect(step0Call[2]).toBeCloseTo(0.01, 6);
    expect(step0Call[5]).toBeUndefined();
    // Débitos per-step de compose (steps 1 y 2).
    expect(mockDebit).toHaveBeenNthCalledWith(
      2,
      'k1',
      CHAIN_ID,
      0.02,
      undefined,
      undefined,
      'wasiai/a2',
      'owner-test', // F-04 (audit): threaded caller owner_ref
    );
    expect(mockDebit).toHaveBeenNthCalledWith(
      3,
      'k1',
      CHAIN_ID,
      0.03,
      undefined,
      undefined,
      'wasiai/a3',
      'owner-test', // F-04 (audit): threaded caller owner_ref
    );
    // BLQ-ALTO-1 (REGRESIÓN): invariante anti-double-charge. La suma de TODOS
    // los débitos (service step-0 + compose steps 1..N) == costo real del plan
    // (0.01+0.02+0.03 = 0.06), con cada step cobrado UNA sola vez. Si plannedCost
    // volviera a ser la suma del plan, este total sería 0.06+0.02+0.03 = 0.11.
    const totalDebited = mockDebit.mock.calls.reduce(
      (sum, c) => sum + (c[2] as number),
      0,
    );
    expect(totalDebited).toBeCloseTo(0.06, 6);
  });

  // T-BILL-2 (AC-2): el step 0 nunca se debita en el service (guard i>0, CD-1).
  // Aunque haya 3 steps, el primer débito jamás corresponde al precio del step0.
  it('T-BILL-2: step 0 is never debited by the service (anti-double-charge)', async () => {
    const a1 = makeAgent({ slug: 'a1', id: 'id1', priceUsdc: 0.07 });
    const a2 = makeAgent({ slug: 'a2', id: 'id2', priceUsdc: 0.02 });
    withAgents([a1, a2]);
    mockFetchOk();
    mockFetchOk();

    await orchestrateService.orchestrate(
      {
        goal: 'two-step',
        budget: 5.0,
        maxAgents: 2,
        scopingKeyRow: makeKeyRow(),
        chainId: CHAIN_ID,
      },
      'orch-bill-2',
    );

    // WKH-127 (BLQ-ALTO-1): 2 débitos. El step-0 del service (3-arg, = precio del
    // step-0 = 0.07, NO la suma 0.09) y el per-step de compose (step 1, 6-arg).
    // El precio del step 0 NUNCA aparece como débito per-step con destino
    // (guard i>0 de compose, CD-1).
    expect(mockDebit).toHaveBeenCalledTimes(2);
    // Débito step-0 del service: 3-arg, sin destino, = precio del step-0 (0.07).
    const step0Call = mockDebit.mock.calls[0]!;
    expect(step0Call[0]).toBe('k1');
    expect(step0Call[1]).toBe(CHAIN_ID);
    expect(step0Call[2]).toBeCloseTo(0.07, 6);
    expect(step0Call[5]).toBeUndefined();
    // Per-step (step 1) de compose: con destino + owner_ref (F-04).
    expect(mockDebit).toHaveBeenCalledWith(
      'k1',
      CHAIN_ID,
      0.02,
      undefined,
      undefined,
      'wasiai/a2',
      'owner-test', // F-04 (audit): threaded caller owner_ref
    );
    // El step-0 (0.07) NO se debita per-step con destino (guard i>0).
    expect(mockDebit).not.toHaveBeenCalledWith(
      'k1',
      CHAIN_ID,
      0.07,
      undefined,
      undefined,
      'wasiai/a1',
    );
    // BLQ-ALTO-1 (REGRESIÓN): total debitado == costo real del plan (0.07+0.02
    // = 0.09), cada step UNA vez. Con el bug de la suma sería 0.09+0.02 = 0.11.
    const totalDebited = mockDebit.mock.calls.reduce(
      (sum, c) => sum + (c[2] as number),
      0,
    );
    expect(totalDebited).toBeCloseTo(0.09, 6);
  });

  // T-BILL-3 (AC-3): budget insuficiente en step intermedio → corta el pipeline.
  it('T-BILL-3: insufficient budget on intermediate step cuts the pipeline', async () => {
    const a1 = makeAgent({ slug: 'a1', id: 'id1', priceUsdc: 0.01 });
    const a2 = makeAgent({ slug: 'a2', id: 'id2', priceUsdc: 0.02 });
    const a3 = makeAgent({ slug: 'a3', id: 'id3', priceUsdc: 0.03 });
    withAgents([a1, a2, a3]);
    mockFetchOk(); // step 0
    mockFetchOk(); // step 1 (debit fails before this is consumed)
    mockFetchOk(); // step 2 — must NOT be consumed

    // WKH-127: el primer débito ahora es el step-0 del service → debe pasar para
    // que el flujo llegue a compose; el SEGUNDO débito (step 1 de compose) falla.
    mockDebit.mockReset();
    mockDebit.mockResolvedValueOnce({ success: true }); // step-0 service OK
    mockDebit.mockResolvedValueOnce({
      success: false,
      error: 'insufficient budget',
    }); // step 1 compose falla

    const result = await orchestrateService.orchestrate(
      {
        goal: 'cut mid-pipeline',
        budget: 5.0,
        maxAgents: 3,
        scopingKeyRow: makeKeyRow(),
        chainId: CHAIN_ID,
      },
      'orch-bill-3',
    );

    expect(result.pipeline.success).toBe(false);
    expect(result.pipeline.error).toContain('insufficient budget');
    // 2 débitos intentados: step-0 service (OK) + step 1 compose (falla). step 2
    // NO se debitó ni ejecutó.
    expect(mockDebit).toHaveBeenCalledTimes(2);
    // step 0 fetch + step 1 fetch attempt: step 1 cut BEFORE invoke → 1 fetch.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // T-BILL-4 (AC-4): master 1-step → 0 débitos en el service (no-op del fix).
  it('T-BILL-4: master single-step pipeline produces zero service debits', async () => {
    const a1 = makeAgent({ slug: 'a1', id: 'id1', priceUsdc: 0.05 });
    withAgents([a1]);
    mockFetchOk();

    const result = await orchestrateService.orchestrate(
      {
        goal: 'single step',
        budget: 5.0,
        maxAgents: 1,
        scopingKeyRow: makeKeyRow(),
        chainId: CHAIN_ID,
      },
      'orch-bill-4',
    );

    expect(result.pipeline.success).toBe(true);
    // WKH-127 (BLQ-ALTO-1): EXACTAMENTE 1 débito: el step-0 del service (3-arg,
    // = precio del step-0 = 0.05; con 1 solo step la suma del plan coincide con
    // el step-0). Compose NO debita (guard i>0 → 1 solo step). El step-0 ya no lo
    // cobra el middleware (skipMiddlewareDebit).
    expect(mockDebit).toHaveBeenCalledTimes(1);
    const step0Call = mockDebit.mock.calls[0]!;
    expect(step0Call[0]).toBe('k1');
    expect(step0Call[1]).toBe(CHAIN_ID);
    expect(step0Call[2]).toBeCloseTo(0.05, 6);
    expect(step0Call[5]).toBeUndefined();
    // BLQ-ALTO-1 (REGRESIÓN): total debitado == costo real del plan (0.05).
    const totalDebited = mockDebit.mock.calls.reduce(
      (sum, c) => sum + (c[2] as number),
      0,
    );
    expect(totalDebited).toBeCloseTo(0.05, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Gas pass-through (audit 2026-06-25): orchestrate's step-0 debit must add the
// per-step gas overhead ON MAINNET (consistent with compose's steps 1..N), and
// must stay UNTOUCHED on testnet (the rest of this file already proves testnet
// at CHAIN_ID=2368 with overhead disabled).
// ─────────────────────────────────────────────────────────────────────
describe('orchestrateService — gas overhead pass-through (step-0)', () => {
  const BASE_MAINNET = 8453;
  let savedFlat: string | undefined;

  beforeEach(() => {
    savedFlat = process.env.STEP_GAS_OVERHEAD_USD;
    delete process.env.STEP_GAS_OVERHEAD_USD;
  });
  afterEach(() => {
    if (savedFlat === undefined) delete process.env.STEP_GAS_OVERHEAD_USD;
    else process.env.STEP_GAS_OVERHEAD_USD = savedFlat;
  });

  it('mainnet + env → step-0 debit = priceUsdc + overhead', async () => {
    process.env.STEP_GAS_OVERHEAD_USD = '0.02';
    const a1 = makeAgent({
      slug: 'a1',
      id: 'id1',
      priceUsdc: 0.05,
      registry: 'wasiai',
    });
    withAgents([a1]);
    mockFetchOk();

    const result = await orchestrateService.orchestrate(
      {
        goal: 'single step mainnet',
        budget: 5.0,
        maxAgents: 1,
        scopingKeyRow: makeKeyRow(),
        chainId: BASE_MAINNET,
      },
      'orch-gas-1',
    );

    expect(result.pipeline.success).toBe(true);
    expect(mockDebit).toHaveBeenCalledTimes(1);
    const step0Call = mockDebit.mock.calls[0]!;
    expect(step0Call[1]).toBe(BASE_MAINNET);
    // step-0 debit = price (0.05) + overhead (0.02) = 0.07.
    expect(step0Call[2] as number).toBeCloseTo(0.07, 6);
  });

  it('mainnet without env → step-0 debit = priceUsdc only (default 0)', async () => {
    const a1 = makeAgent({
      slug: 'a1',
      id: 'id1',
      priceUsdc: 0.05,
      registry: 'wasiai',
    });
    withAgents([a1]);
    mockFetchOk();

    const result = await orchestrateService.orchestrate(
      {
        goal: 'single step mainnet no env',
        budget: 5.0,
        maxAgents: 1,
        scopingKeyRow: makeKeyRow(),
        chainId: BASE_MAINNET,
      },
      'orch-gas-2',
    );

    expect(result.pipeline.success).toBe(true);
    expect(mockDebit).toHaveBeenCalledTimes(1);
    expect(mockDebit.mock.calls[0]![2] as number).toBeCloseTo(0.05, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────
// WKH-131 (HU-128): executeApprovedPlan — /execute path (compose REAL).
// Valida el money-path disjunto + cap gate + credit-back + fee con compose real.
// ─────────────────────────────────────────────────────────────────────
import type {
  OrchestratePlanResult,
  ResolvedComposeStep,
} from '../types/index.js';

describe('orchestrateService — WKH-131 executeApprovedPlan (real compose)', () => {
  /** Construye un OrchestratePlanResult "aprobado" re-derivando plannedCostUsd
   *  SERVER-SIDE (resolveAgentPriceUsdc del step-0 vía getAgent), igual que el
   *  route de /execute (CD-NEW-6). */
  function approvedPlan(
    steps: ResolvedComposeStep[],
    plannedCostUsd: number,
    overrides: Partial<OrchestratePlanResult> = {},
  ): OrchestratePlanResult {
    return {
      orchestrationId: 'exec-plan',
      planStatus: 'ready',
      steps,
      costPerStep: steps.map(() => plannedCostUsd),
      totalCostUsdc: plannedCostUsd,
      protocolFeeUsdc: 0.05,
      maxQuotedCostUsdc: 100,
      reasoning: 'execute re-derived',
      consideredAgents: [],
      plannedCostUsd,
      feeUsdc: 0.05,
      usedFallback: false,
      debitFallback: false,
      billingKeyRow: makeKeyRow(),
      discoveredAgents: [],
      ...overrides,
    };
  }

  /** getAgent resuelto por slug contra un set (server-side resolution real). */
  function getAgentBySlug(agents: Agent[]): void {
    vi.mocked(discoveryService.getAgent).mockImplementation(async (slug) => {
      return agents.find((a) => a.slug === slug) ?? null;
    });
  }

  // T-EXEC-1 (AC-3 pass / AC-7): /execute happy → debit step-0 + compose, 200.
  it('T-EXEC-1: execute happy path debits step-0 + compose steps', async () => {
    const a1 = makeAgent({ slug: 'a1', id: 'id1', priceUsdc: 0.01 });
    const a2 = makeAgent({ slug: 'a2', id: 'id2', priceUsdc: 0.02 });
    withAgents([a1, a2]);
    getAgentBySlug([a1, a2]); // server-side resolve por slug
    mockFetchOk();
    mockFetchOk();

    const steps: ResolvedComposeStep[] = [
      { agent: 'a1', registry: 'wasiai', input: { q: 0 }, passOutput: false },
      { agent: 'a2', registry: 'wasiai', input: { q: 1 }, passOutput: true },
    ];

    const res = await orchestrateService.executeApprovedPlan(
      {
        goal: '',
        budget: 5.0,
        scopingKeyRow: makeKeyRow(),
        chainId: CHAIN_ID,
        maxQuotedCostUsdc: 100, // cap holgado → gate pasa
      },
      approvedPlan(steps, 0.01),
      'orch-exec-1',
    );

    expect('__quoteStale' in res).toBe(false);
    if ('__quoteStale' in res) throw new Error('unexpected stale');
    expect(res.pipeline.success).toBe(true);
    // step-0 del service (0.01) + step 1 de compose (0.02).
    expect(mockDebit).toHaveBeenCalledTimes(2);
    expect(mockDebit.mock.calls[0]![2]).toBeCloseTo(0.01, 6);
  });

  // T-EXEC-3 (AC-4): precios del cliente IGNORADOS — el cobro usa plannedCostUsd
  // re-derivado server-side, no el costo (falso) que mandó el cliente.
  it('T-EXEC-3: client prices ignored — debit uses server-side plannedCostUsd', async () => {
    const a1 = makeAgent({ slug: 'a1', id: 'id1', priceUsdc: 0.07 });
    withAgents([a1]);
    vi.mocked(discoveryService.getAgent).mockResolvedValue(a1);
    mockFetchOk();

    const steps: ResolvedComposeStep[] = [
      { agent: 'a1', registry: 'wasiai', input: { q: 0 }, passOutput: false },
    ];
    // El cliente "mandó" un costo falso (0.000001) en costPerStep/totalCostUsdc,
    // pero plannedCostUsd se re-derivó server-side al precio REAL (0.07).
    const plan = approvedPlan(steps, 0.07, {
      costPerStep: [0.000001],
      totalCostUsdc: 0.000001,
    });

    await orchestrateService.executeApprovedPlan(
      {
        goal: '',
        budget: 5.0,
        scopingKeyRow: makeKeyRow(),
        chainId: CHAIN_ID,
        maxQuotedCostUsdc: 100,
      },
      plan,
      'orch-exec-3',
    );

    // El débito step-0 == precio real server-side (0.07), NO el costo falso del cliente.
    expect(mockDebit).toHaveBeenCalledTimes(1);
    expect(mockDebit.mock.calls[0]![2]).toBeCloseTo(0.07, 6);
    expect(mockDebit.mock.calls[0]![2]).not.toBeCloseTo(0.000001, 6);
  });

  // T-EXEC-4 (AC-7/CD-NEW-2): invariante total — Σ(service step-0 + compose 1..N)
  // == costo real, cada step UNA vez.
  it('T-EXEC-4: disjoint debits sum to real cost, each step once', async () => {
    const a1 = makeAgent({ slug: 'a1', id: 'id1', priceUsdc: 0.01 });
    const a2 = makeAgent({ slug: 'a2', id: 'id2', priceUsdc: 0.02 });
    const a3 = makeAgent({ slug: 'a3', id: 'id3', priceUsdc: 0.03 });
    withAgents([a1, a2, a3]);
    getAgentBySlug([a1, a2, a3]);
    mockFetchOk();
    mockFetchOk();
    mockFetchOk();

    const steps: ResolvedComposeStep[] = [
      { agent: 'a1', registry: 'wasiai', input: { q: 0 }, passOutput: false },
      { agent: 'a2', registry: 'wasiai', input: { q: 1 }, passOutput: true },
      { agent: 'a3', registry: 'wasiai', input: { q: 2 }, passOutput: true },
    ];

    await orchestrateService.executeApprovedPlan(
      {
        goal: '',
        budget: 5.0,
        scopingKeyRow: makeKeyRow(),
        chainId: CHAIN_ID,
        maxQuotedCostUsdc: 100,
      },
      approvedPlan(steps, 0.01),
      'orch-exec-4',
    );

    expect(mockDebit).toHaveBeenCalledTimes(3);
    const total = mockDebit.mock.calls.reduce(
      (sum, c) => sum + (c[2] as number),
      0,
    );
    expect(total).toBeCloseTo(0.06, 6); // 0.01 + 0.02 + 0.03, cada step una vez
  });

  // T-EXEC-5 (AC-8): pipeline.success===false → credit-back. Fallo total
  // (totalCostUsdc===0) → reembolso del step-0 entero.
  it('T-EXEC-5: failed pipeline → credit-back of step-0', async () => {
    // invokeUrl loopback → el SSRF guard de compose bloquea el step-0 ANTES de
    // settlear (throw → pipeline.success false, totalCostUsdc 0). step-0 (i=0) no
    // tiene débito per-step (guard i>0) → sin retry/refund de compose; el
    // credit-back del step-0 lo hace la capa orchestrate (lo que probamos).
    const a1 = makeAgent({
      slug: 'a1',
      id: 'id1',
      priceUsdc: 0.05,
      invokeUrl: 'http://127.0.0.1:9/invoke/a1',
    });
    withAgents([a1]);
    vi.mocked(discoveryService.getAgent).mockResolvedValue(a1);

    const steps: ResolvedComposeStep[] = [
      { agent: 'a1', registry: 'wasiai', input: { q: 0 }, passOutput: false },
    ];

    const res = await orchestrateService.executeApprovedPlan(
      {
        goal: '',
        budget: 5.0,
        scopingKeyRow: makeKeyRow(),
        chainId: CHAIN_ID,
        maxQuotedCostUsdc: 100,
      },
      approvedPlan(steps, 0.05),
      'orch-exec-5',
    );

    if ('__quoteStale' in res) throw new Error('unexpected stale');
    expect(res.pipeline.success).toBe(false);
    // credit-back del step-0 (0.05).
    expect(vi.mocked(budgetService.credit)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(budgetService.credit).mock.calls[0]![2]).toBeCloseTo(
      0.05,
      6,
    );
  });

  // T-EXEC-6 (AC-9): pipeline.success===true → chargeProtocolFee + protocolFeeUsdc.
  it('T-EXEC-6: success → chargeProtocolFee called + protocolFeeUsdc set', async () => {
    const { chargeProtocolFee } = await import('./fee-charge.js');
    const a1 = makeAgent({ slug: 'a1', id: 'id1', priceUsdc: 0.05 });
    withAgents([a1]);
    vi.mocked(discoveryService.getAgent).mockResolvedValue(a1);
    mockFetchOk();

    const steps: ResolvedComposeStep[] = [
      { agent: 'a1', registry: 'wasiai', input: { q: 0 }, passOutput: false },
    ];

    const res = await orchestrateService.executeApprovedPlan(
      {
        goal: '',
        budget: 5.0,
        scopingKeyRow: makeKeyRow(),
        chainId: CHAIN_ID,
        maxQuotedCostUsdc: 100,
      },
      approvedPlan(steps, 0.05, { feeUsdc: 0.05 }),
      'orch-exec-6',
    );

    if ('__quoteStale' in res) throw new Error('unexpected stale');
    expect(res.pipeline.success).toBe(true);
    // WKH-132 (AC-3): la base del charge = pipeline.totalCostUsdc (0.05, costo real
    // ejecutado), NO el budget (5.0). Espejo de compose.ts:539.
    expect(vi.mocked(chargeProtocolFee)).toHaveBeenCalledWith(
      expect.objectContaining({
        orchestrationId: 'orch-exec-6',
        feeBaseUsdc: res.pipeline.totalCostUsdc,
      }),
    );
    expect(res.pipeline.totalCostUsdc).toBeCloseTo(0.05, 6);
    // WKH-132: protocolFeeUsdc reportado = cost-based (0.05 * 0.01 = 0.0005),
    // NO el feeUsdc budget-based del plan (0.05).
    expect(res.protocolFeeUsdc).toBeCloseTo(0.0005, 6);
  });

  // T-EXEC-7 (AC-11): debit step-0 incluye getStepGasOverheadUsd(chainId).
  it('T-EXEC-7: step-0 debit includes gas overhead on mainnet', async () => {
    const saved = process.env.STEP_GAS_OVERHEAD_USD;
    process.env.STEP_GAS_OVERHEAD_USD = '0.02';
    try {
      const a1 = makeAgent({ slug: 'a1', id: 'id1', priceUsdc: 0.05 });
      withAgents([a1]);
      vi.mocked(discoveryService.getAgent).mockResolvedValue(a1);
      mockFetchOk();

      const steps: ResolvedComposeStep[] = [
        { agent: 'a1', registry: 'wasiai', input: { q: 0 }, passOutput: false },
      ];

      await orchestrateService.executeApprovedPlan(
        {
          goal: '',
          budget: 5.0,
          scopingKeyRow: makeKeyRow(),
          chainId: 8453, // mainnet
          maxQuotedCostUsdc: 100,
        },
        approvedPlan(steps, 0.05),
        'orch-exec-7',
      );

      // step-0 debit = price (0.05) + overhead (0.02) = 0.07.
      expect(mockDebit.mock.calls[0]![2]).toBeCloseTo(0.07, 6);
    } finally {
      if (saved === undefined) delete process.env.STEP_GAS_OVERHEAD_USD;
      else process.env.STEP_GAS_OVERHEAD_USD = saved;
    }
  });

  // T-EXEC-2 (AC-3/AC-5, real side): cap breach → __quoteStale, cero debit.
  it('T-EXEC-2: cap breach → __quoteStale before any debit/compose', async () => {
    const a1 = makeAgent({ slug: 'a1', id: 'id1', priceUsdc: 0.5 });
    withAgents([a1]);
    vi.mocked(discoveryService.getAgent).mockResolvedValue(a1);

    const steps: ResolvedComposeStep[] = [
      { agent: 'a1', registry: 'wasiai', input: { q: 0 }, passOutput: false },
    ];

    const res = await orchestrateService.executeApprovedPlan(
      {
        goal: '',
        budget: 5.0,
        scopingKeyRow: makeKeyRow(),
        chainId: CHAIN_ID,
        maxQuotedCostUsdc: 0.0001, // cap absurdamente bajo → drift
      },
      approvedPlan(steps, 0.5),
      'orch-exec-2',
    );

    expect('__quoteStale' in res).toBe(true);
    expect(mockDebit).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
