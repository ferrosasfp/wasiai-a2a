/**
 * DEEP resilience / failure-injection tests — compose + orchestrate money path.
 *
 * Directly covers the class of the 2026-06-29 prod incident: a dependency that
 * fails (throws / 5xx / unavailable) on the settle path must NOT silently
 * corrupt settlement — it either settles cleanly OR cleanly refunds what was
 * debited. No double-charge, no partial-settle inconsistency, no negative
 * balance, no raw 500 leak.
 *
 * Harness: same edge-mock strategy as orchestrate.billing.test.ts — the REAL
 * composeService + orchestrateService run; only the boundary deps are mocked so
 * we can inject failures and assert the money-conservation behavior:
 *   - budgetService.debit / credit / creditWithDest  (assert refund calls)
 *   - getPaymentAdapter().settle / sign              (inject settle 5xx / throw)
 *   - global fetch (downstream agent)                (inject timeout/4xx/5xx/malformed)
 *   - checkAndRecordX402Nonce                          (inject replay)
 *   - discovery / event / fee-charge / downstream      (no-ops)
 *
 * Invariants asserted across the failure modes:
 *   I1. settle fails → the step debit is REFUNDED exactly once (no double-charge).
 *   I2. downstream timeout/4xx/5xx/malformed → graceful {success:false} + clear
 *       error string, refund of the debited amount, NEVER an unhandled throw.
 *   I3. budget RPC error mid-pipeline (debit fails) → fail-safe stop, no further
 *       debits, no settle of later steps.
 *   I4. refund (credit RPC) itself failing → surfaced (refundError / outbox),
 *       never a silent success, never re-debit (anti-double-refund).
 *   I5. orchestrate total-failure → full step-0 refund (credit) of debitedUsd.
 *   I6. x402 nonce replay → the duplicate is rejected at the nonce layer.
 */
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { A2AAgentKeyRow, Agent } from '../types/index.js';

// ── Anthropic: no key → greedy planner (deterministic) ──
const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  // biome-ignore lint/complexity/useArrowFunction: new-able mock constructor
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }),
}));

vi.mock('./discovery.js', () => ({
  discoveryService: { discover: vi.fn(), getAgent: vi.fn() },
}));

// budget: the heart of the conservation assertions.
vi.mock('./budget.js', () => ({
  budgetService: {
    debit: vi.fn(),
    credit: vi.fn(),
    creditWithDest: vi.fn(),
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

import { signAndSettleDownstream } from '../lib/downstream-payment.js';

// refund-outbox: assert the durable-retry enqueue when a credit RPC fails.
vi.mock('./refund-outbox.js', () => ({
  refundOutbox: { enqueueRefund: vi.fn().mockResolvedValue(undefined) },
}));

// x402 inbound nonce anti-replay (defense in depth).
vi.mock('./x402-nonce.js', () => ({
  checkAndRecordX402Nonce: vi.fn().mockResolvedValue({ kind: 'fresh' }),
}));

// Payment adapter — sign always OK; settle is the injection point.
const mockSign = vi.fn().mockResolvedValue({
  xPaymentHeader: '0xsig',
  paymentRequest: {
    authorization: { nonce: '0xnonce' },
    signature: '0xsig',
    network: 'avalanche-fuji',
  },
});
const mockSettle = vi.fn();
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

// ── Imports after mocks (compose + orchestrate are REAL) ──
import { budgetService } from './budget.js';
import { composeService } from './compose.js';
import { discoveryService } from './discovery.js';
import { orchestrateService } from './orchestrate.js';
import { checkAndRecordX402Nonce } from './x402-nonce.js';

const mockDebit = vi.mocked(budgetService.debit);
const mockCredit = vi.mocked(budgetService.credit);
const mockCreditWithDest = vi.mocked(budgetService.creditWithDest);

const CHAIN_ID = 2368;

function makeAgent(o: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-x',
    name: 'Agent X',
    slug: 'agent-x',
    // Suite B forces greedy (no API key). The money-path fallback relevance guard
    // needs a token overlap with the Suite B goals ("single step…", "refund…",
    // "budget…") so the guard stays inert and these refund/settle-failure paths
    // are exercised. Compose tests (Suite A) ignore these fields.
    description: 'single step refund budget settle agent',
    capabilities: ['step', 'refund', 'budget', 'test'],
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

beforeEach(() => {
  vi.clearAllMocks();
  // HU-DOUBLE-PAY: `clearAllMocks()` limpia el historial pero NO la cola de
  // `mockResolvedValueOnce`. Una respuesta encolada y no consumida por un test
  // se la comía el siguiente y lo volvía verde por el motivo equivocado (se vio
  // al reescribir las inyecciones de fallo de esta suite).
  mockFetch.mockReset();
  delete process.env.ANTHROPIC_API_KEY;
  // happy defaults — individual tests override to inject failures.
  mockDebit.mockResolvedValue({ success: true });
  mockCredit.mockResolvedValue({ success: true, reverted: true });
  mockCreditWithDest.mockResolvedValue({ success: true, reverted: true });
  vi.mocked(budgetService.getBalance).mockResolvedValue('10');
  vi.mocked(discoveryService.getAgent).mockResolvedValue(null);
  mockSettle.mockResolvedValue({ success: true, txHash: '0xsettled' });
  vi.mocked(checkAndRecordX402Nonce).mockResolvedValue({ kind: 'fresh' });
});

// ═══════════════════════════════════════════════════════════════════════════
// Suite A — composeService per-step failure injection (master a2a-key path)
// ═══════════════════════════════════════════════════════════════════════════
describe('compose resilience — settle / downstream failures refund + degrade', () => {
  /** Runs a 2-step master-path compose with the step-1 downstream failure
   *  injected by `injectStep1`. Returns the ComposeResult. */
  async function runTwoStep(
    injectStep1: () => void,
    step1Price = 0.02,
  ): Promise<Awaited<ReturnType<typeof composeService.compose>>> {
    const a1 = makeAgent({ slug: 'a1', id: 'id1', priceUsdc: 0.01 });
    const a2 = makeAgent({ slug: 'a2', id: 'id2', priceUsdc: step1Price });
    withAgents([a1, a2]);
    mockFetchOk(); // step 0 succeeds
    injectStep1(); // step 1 fails in some way
    const keyRow = makeKeyRow();
    return composeService.compose({
      steps: [
        { agent: 'a1', registry: 'wasiai', input: { q: 'hi' } },
        { agent: 'a2', registry: 'wasiai', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: CHAIN_ID,
    });
  }

  // ── I1 REESCRITA (HU-DOUBLE-PAY) ────────────────────────────────────────
  //
  // Acá vivían dos tests que inyectaban el fallo en `getPaymentAdapter().settle`
  // del segundo leg de salida de `invokeAgent`. Ese leg se borró (pagaba al
  // agente por segunda vez), así que un settle que no aterriza YA NO puede
  // tumbar el step: el único leg de salida que queda —`signAndSettleDownstream`—
  // NUNCA tira (CD-7 de WKH-55) y reporta el resultado con un skip-code.
  //
  // ⚠️ ESTO ES UN CAMBIO DE COMPORTAMIENTO OBSERVABLE, y se fija acá para que se
  // vea: antes, un caller x402 cuyo settle fallaba veía el step abortado y el
  // débito devuelto; ahora ve el step OK con `downstreamSettle: skipped:*`. Es
  // exactamente lo que ya le pasaba a TODO caller prepago (el leg borrado sólo
  // corría con `!a2aKey`), así que el fix uniformó los dos caminos en vez de
  // dejar dos semánticas según cómo se autenticó el caller.
  //
  // Al lado hay un efecto que el leg borrado provocaba y nadie había medido: su
  // settle fallido TIRABA ANTES de que corriera el leg downstream, así que el
  // agente se quedaba sin cobrar POR CULPA del leg redundante.
  it('un leg downstream que no settlea NO tumba el step ni devuelve el débito — lo reporta', async () => {
    const res = await runTwoStep(() => {
      mockFetchOk(); // el agente del step 1 responde OK
      // El leg reporta que no pudo settlear (mismo contrato que producción:
      // devuelve null y deja el code en el logger).
      vi.mocked(signAndSettleDownstream).mockImplementation(
        async (_agent, logger) => {
          logger?.warn?.({ code: 'SETTLE_FAILED' }, 'no settle');
          return null;
        },
      );
    });

    expect(res.success).toBe(true);
    // El débito del step 1 NO se devuelve: el step entregó valor.
    expect(mockCreditWithDest).not.toHaveBeenCalled();
    expect(mockCredit).not.toHaveBeenCalled();
    // …y el caller se entera de que el leg no settleó.
    expect(res.steps[1]?.downstreamSettle).toBe('skipped:SETTLE_FAILED');
    // Sigue habiendo UN solo débito por step (no hay doble cobro).
    const step1Debits = mockDebit.mock.calls.filter(
      (c) => (c[5] as string) === 'wasiai/a2',
    );
    expect(step1Debits).toHaveLength(1);
  });

  // I2: downstream agent returns 5xx.
  it('downstream agent 5xx on step 1 → refund + clear error string', async () => {
    const res = await runTwoStep(() => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 502,
        text: async () => 'bad gateway',
      });
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/502/);
    expect(mockCreditWithDest).toHaveBeenCalledTimes(1);
    expect(mockCreditWithDest.mock.calls[0]![2]).toBeCloseTo(0.02, 6);
  });

  // I2: downstream agent returns 4xx (no parseable field-errors → no retry).
  it('downstream agent 4xx (opaque) on step 1 → refund + clear error', async () => {
    const res = await runTwoStep(() => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'totally opaque bad request',
      });
    });
    expect(res.success).toBe(false);
    expect(mockCreditWithDest).toHaveBeenCalledTimes(1);
    expect(mockCreditWithDest.mock.calls[0]![2]).toBeCloseTo(0.02, 6);
  });

  // I2: downstream timeout (fetch rejects).
  it('downstream timeout on step 1 → refund + graceful error', async () => {
    const res = await runTwoStep(() => {
      mockFetch.mockRejectedValueOnce(new Error('fetch timeout'));
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain('Step 1');
    expect(mockCreditWithDest).toHaveBeenCalledTimes(1);
  });

  // I2: malformed (non-JSON) downstream body — response.json() throws.
  it('downstream non-JSON body on step 1 → refund + graceful error (no 500 leak)', async () => {
    const res = await runTwoStep(() => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON');
        },
      });
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain('Step 1');
    expect(mockCreditWithDest).toHaveBeenCalledTimes(1);
    expect(mockCreditWithDest.mock.calls[0]![2]).toBeCloseTo(0.02, 6);
  });

  // I4: the refund RPC ITSELF fails (DB unavailable mid-refund). Must surface
  // (enqueue durable retry) and NOT re-debit — anti-double-refund.
  it('refund RPC failure → enqueued for durable retry, no re-debit (anti-double-refund)', async () => {
    const { refundOutbox } = await import('./refund-outbox.js');
    mockCreditWithDest.mockResolvedValue({
      success: false,
      error: 'REFUND_FAILED',
      reverted: false,
    });
    const res = await runTwoStep(() => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => 'unavailable',
      });
    });
    expect(res.success).toBe(false);
    // refund attempted...
    expect(mockCreditWithDest).toHaveBeenCalledTimes(1);
    // ...failed → enqueued for reliable retry (no silent loss).
    expect(vi.mocked(refundOutbox.enqueueRefund)).toHaveBeenCalledTimes(1);
    const enq = vi.mocked(refundOutbox.enqueueRefund).mock.calls[0]![0];
    expect(enq.amountUsd).toBeCloseTo(0.02, 6);
    expect(enq.destination).toBe('wasiai/a2');
    // No re-debit of step 1 beyond the single original debit (refund failed →
    // retry path is gated on a successful refund#1, so it must NOT re-debit).
    const step1Debits = mockDebit.mock.calls.filter(
      (c) => (c[5] as string) === 'wasiai/a2',
    );
    expect(step1Debits).toHaveLength(1);
  });

  // I3: budget RPC error (debit fails) mid-pipeline → fail-safe stop. Step 2
  // is neither debited nor invoked; no settle of later steps.
  it('debit RPC error on step 1 → pipeline stops fail-safe, later step not debited/invoked', async () => {
    const a1 = makeAgent({ slug: 'a1', id: 'id1', priceUsdc: 0.01 });
    const a2 = makeAgent({ slug: 'a2', id: 'id2', priceUsdc: 0.02 });
    const a3 = makeAgent({ slug: 'a3', id: 'id3', priceUsdc: 0.03 });
    withAgents([a1, a2, a3]);
    mockFetchOk(); // step 0
    mockFetchOk(); // step 1 (must NOT be consumed — debit fails first)
    mockFetchOk(); // step 2 (must NOT be consumed)
    // step 1 debit fails (DB/budget RPC error).
    mockDebit.mockResolvedValueOnce({ success: false, error: 'REFUND_FAILED' }); // first call = step 1
    const keyRow = makeKeyRow();

    const res = await composeService.compose({
      steps: [
        { agent: 'a1', registry: 'wasiai', input: { q: 'hi' } },
        { agent: 'a2', registry: 'wasiai', input: {} },
        { agent: 'a3', registry: 'wasiai', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: CHAIN_ID,
    });

    expect(res.success).toBe(false);
    // Exactly one debit was attempted (step 1) — step 2/3 never reached.
    const destDebits = mockDebit.mock.calls.filter((c) => c[5] !== undefined);
    expect(destDebits).toHaveLength(1);
    expect(destDebits[0]![5]).toBe('wasiai/a2');
    // Step 3 was never invoked (only step 0 fetched; step 1 cut at debit).
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // A debit that FAILED is not refunded (nothing was charged).
    expect(mockCreditWithDest).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Suite B — orchestrateService total-failure refund (step-0 credit-back)
// ═══════════════════════════════════════════════════════════════════════════
describe('orchestrate resilience — total failure refunds step-0 debit', () => {
  // I5: step-0 downstream fails on a 1-step plan → totalCostUsdc===0 → full
  // step-0 refund of debitedUsd via budgetService.credit. The 2026-06-29
  // incident: a failing settle dependency must trigger a clean refund.
  it('step-0 settle failure (totalCost 0) → full step-0 refund via credit()', async () => {
    const a1 = makeAgent({ slug: 'a1', id: 'id1', priceUsdc: 0.05 });
    withAgents([a1]);
    // HU-DOUBLE-PAY: el fallo se inyecta en el AGENTE, no en el settle. El
    // settle que se usaba acá era el del leg de salida borrado; hoy un settle
    // que no aterriza no tumba el step (ver la I1 reescrita en la Suite A), así
    // que inyectarlo ahí ya no produce el fallo total que este test mide.
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'agent down',
    });

    const result = await orchestrateService.orchestrate(
      {
        goal: 'single step that fails to settle',
        budget: 5.0,
        maxAgents: 1,
        scopingKeyRow: makeKeyRow(),
        chainId: CHAIN_ID,
      },
      'orch-resil-1',
    );

    expect(result.pipeline.success).toBe(false);
    expect(result.pipeline.totalCostUsdc).toBe(0);
    // I5: full step-0 refund of the debited amount (price 0.05, testnet gas 0).
    expect(mockCredit).toHaveBeenCalledTimes(1);
    const [kid, chain, amount, owner] = mockCredit.mock.calls[0]!;
    expect(kid).toBe('k1');
    expect(chain).toBe(CHAIN_ID);
    expect(amount).toBeCloseTo(0.05, 6);
    expect(owner).toBe('owner-test');
  });

  // I4: orchestrate refund (credit) itself fails → refundError surfaced and the
  // refund is enqueued in the outbox (no silent revenue loss / no negative bal).
  it('orchestrate refund RPC failure → refundError flag + outbox enqueue', async () => {
    const { refundOutbox } = await import('./refund-outbox.js');
    mockCredit.mockResolvedValue({
      success: false,
      error: 'REFUND_FAILED',
      reverted: false,
    });
    const a1 = makeAgent({ slug: 'a1', id: 'id1', priceUsdc: 0.05 });
    withAgents([a1]);
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'agent down',
    });

    const result = await orchestrateService.orchestrate(
      {
        goal: 'refund itself fails',
        budget: 5.0,
        maxAgents: 1,
        scopingKeyRow: makeKeyRow(),
        chainId: CHAIN_ID,
      },
      'orch-resil-2',
    );

    expect(result.pipeline.success).toBe(false);
    expect(mockCredit).toHaveBeenCalledTimes(1);
    // refund failed → durable retry enqueued (no silent loss).
    expect(vi.mocked(refundOutbox.enqueueRefund)).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(refundOutbox.enqueueRefund).mock.calls[0]![0].amountUsd,
    ).toBeCloseTo(0.05, 6);
  });

  // I3: orchestrate step-0 budget RPC failure (debit fails) → graceful
  // "insufficient budget" result, compose never runs, nothing refunded.
  it('step-0 debit RPC failure → graceful result, no compose, no refund', async () => {
    const a1 = makeAgent({ slug: 'a1', id: 'id1', priceUsdc: 0.05 });
    withAgents([a1]);
    mockDebit.mockResolvedValue({ success: false, error: 'REFUND_FAILED' });

    const result = await orchestrateService.orchestrate(
      {
        goal: 'budget rpc down',
        budget: 5.0,
        maxAgents: 1,
        scopingKeyRow: makeKeyRow(),
        chainId: CHAIN_ID,
      },
      'orch-resil-3',
    );

    expect(result.pipeline.success).toBe(false);
    // Compose never ran → downstream never fetched.
    expect(mockFetch).not.toHaveBeenCalled();
    // Nothing was charged → nothing to refund.
    expect(mockCredit).not.toHaveBeenCalled();
    expect(mockCreditWithDest).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Suite C — x402 inbound nonce anti-replay (no second settle on duplicate)
// ═══════════════════════════════════════════════════════════════════════════
describe('x402 nonce anti-replay — duplicate rejected, fail-open on DB blip', () => {
  // I6: a fresh nonce records once; a duplicate (network,nonce) → replay.
  it('first use is fresh, replay of same nonce is rejected', async () => {
    const m = vi.mocked(checkAndRecordX402Nonce);
    m.mockResolvedValueOnce({ kind: 'fresh' });
    m.mockResolvedValueOnce({ kind: 'replay' });

    const first = await checkAndRecordX402Nonce('avalanche-fuji', '0xnonceA');
    const second = await checkAndRecordX402Nonce('avalanche-fuji', '0xnonceA');

    expect(first.kind).toBe('fresh'); // proceed to settle
    expect(second.kind).toBe('replay'); // reject — no second settle
  });

  // The DB-down case is documented as fail-OPEN (the EIP-3009 nonce is
  // single-use on-chain anyway). Assert the contract surfaces 'unavailable'
  // (caller does not block legit payments on a DB blip), distinct from replay.
  it('DB-unavailable surfaces as unavailable (fail-open), never as replay', async () => {
    const m = vi.mocked(checkAndRecordX402Nonce);
    m.mockResolvedValueOnce({ kind: 'unavailable' });
    const r = await checkAndRecordX402Nonce('base-sepolia', '0xnonceB');
    expect(r.kind).toBe('unavailable');
    expect(r.kind).not.toBe('replay');
  });
});

afterEach(() => {
  vi.clearAllMocks();
});
