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
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

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
    description: 'desc',
    capabilities: ['test'],
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
    registries: ['wasiai'],
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
    // AC-1 + AC-2: exactamente 2 débitos (steps 1 y 2); el step 0 NO.
    expect(mockDebit).toHaveBeenCalledTimes(2);
    expect(mockDebit).toHaveBeenNthCalledWith(
      1,
      'k1',
      CHAIN_ID,
      0.02,
      undefined,
    );
    expect(mockDebit).toHaveBeenNthCalledWith(
      2,
      'k1',
      CHAIN_ID,
      0.03,
      undefined,
    );
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

    // Solo 1 débito (step 1). El precio del step 0 (0.07) NUNCA aparece.
    expect(mockDebit).toHaveBeenCalledTimes(1);
    expect(mockDebit).toHaveBeenCalledWith('k1', CHAIN_ID, 0.02, undefined);
    expect(mockDebit).not.toHaveBeenCalledWith('k1', CHAIN_ID, 0.07, undefined);
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

    // step 1 debit falla con insufficient budget.
    mockDebit.mockReset();
    mockDebit.mockResolvedValueOnce({
      success: false,
      error: 'insufficient budget',
    });

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
    // Solo se intentó 1 débito (step 1); step 2 NO se debitó ni ejecutó.
    expect(mockDebit).toHaveBeenCalledTimes(1);
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
    expect(mockDebit).not.toHaveBeenCalled();
  });
});
