/**
 * `/tasks` — HU-193: no cobrar antes de validar.
 *
 * EL BUG: los CINCO endpoints (`POST /`, `GET /`, `GET /:id`, `PATCH /:id/status`,
 * `PATCH /:id`) pasan por `requirePaymentOrA2AKey`, que cobra $1
 * (`PLACEHOLDER_FEE_USD`) ANTES del handler. Todos los rechazos del handler
 * llegaban con el cobro hecho:
 *
 *   • riel PREPAGO: $1 debitado y nunca devuelto por un UUID mal escrito, un
 *     `status` fuera del enum o un append sin nada que appendear;
 *   • riel x402: PEOR que en `/registries`. Un caller x402 pagaba on-chain y
 *     recibía **500**, porque `getOwnerRef` lanza cuando no hay `a2aKeyRow` (el
 *     middleware x402 nunca lo setea: no aporta identidad de tenant). Cobro real,
 *     gas nuestro, y un error de servidor como respuesta.
 *
 * EL FIX: `chargedRoute` con `requireA2AKeyPresence` + los checks de forma, todo
 * ANTES del cobro. El residuo (404 de ownership, 409 de estado terminal) se
 * reembolsa en el riel prepago con `refundStep0Debit`.
 *
 * CÓMO SE MIDE EL DINERO ACÁ: prepago → balance en memoria antes/después; x402 →
 * `settle` del adapter (la tx on-chain ES el cobro, así que "settle NO fue
 * llamado" es la aserción de dinero). Corre el middleware de pago REAL.
 *
 * Naming: T-NCT-01..T-NCT-20.
 */

import crypto from 'node:crypto';
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
import type {
  A2AAgentKeyRow,
  DelegationRow,
  KeySessionRow,
} from '../types/index.js';

// ── Structured logger ────────────────────────────────────────
const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({ getLogger: () => logSpy }));

// ── Chain registry + payment adapter (a2a-key y x402) ────────
const settleSpy = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ txHash: '0xdeadbeef', success: true }),
);
const verifySpy = vi.hoisted(() => vi.fn().mockResolvedValue({ valid: true }));
const paymentAdapter = vi.hoisted(() => ({
  verify: (...a: unknown[]) => verifySpy(...a),
  settle: (...a: unknown[]) => settleSpy(...a),
  getToken: () => '0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e',
  getNetwork: () => 'eip155:2368',
  getScheme: () => 'exact',
  getMerchantName: () => 'wasiai-a2a-test',
  getMaxTimeoutSeconds: () => 60,
  quote: async () => ({
    amountWei: '1000000',
    token: { symbol: 'USDC', address: '0xtoken', decimals: 6 },
    facilitatorUrl: 'http://mock',
  }),
}));
vi.mock('../adapters/chain-resolver.js', () => ({
  resolveChainKey: () => 'kite',
}));
vi.mock('../adapters/registry.js', () => ({
  getDefaultChainKey: () => 'kite',
  getInitializedChainKeys: () => ['kite'],
  getAdaptersBundle: () => ({
    chainConfig: { chainId: 2368 },
    payment: { supportedTokens: [{ symbol: 'USDC' }] },
  }),
  getPaymentAdapter: () => paymentAdapter,
}));

// x402 anti-replay: registra el nonce vía supabase antes de settle.
vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: vi.fn(() => ({
      insert: vi.fn().mockResolvedValue({ data: null, error: null }),
    })),
    rpc: vi.fn(),
  },
}));

// ── identityService: master key activa con $10 en la chain 2368 ──
const fundedKey = vi.hoisted(
  (): A2AAgentKeyRow => ({
    id: 'k1',
    owner_ref: 'o1',
    key_hash: 'hash',
    display_name: null,
    budget: { '2368': '10.00' },
    daily_limit_usd: null,
    daily_spent_usd: '0',
    daily_reset_at: new Date(Date.now() + 86_400_000).toISOString(),
    allowed_registries: null,
    allowed_agent_slugs: null,
    allowed_categories: null,
    max_spend_per_call_usd: null,
    is_active: true,
    last_used_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    erc8004_identity: null,
    kite_passport: null,
    agentkit_wallet: null,
    funding_wallet: null,
    metadata: {},
    require_signature: false,
  }),
);
vi.mock('../services/identity.js', () => ({
  isIdentityVerified: () => false,
  identityService: { lookupByHash: vi.fn().mockResolvedValue(fundedKey) },
}));

// ── budgetService: balance en memoria. `debit` resta, los `credit*` SUMAN ──
// Los credits tienen que mover el balance de verdad: si sólo devolvieran
// `{success:true}`, un test de "cobró y reembolsó" sería indistinguible de uno de
// "cobró y se lo quedó".
const budgetState = vi.hoisted(() => ({ balance: 10 }));
const debitMock = vi.hoisted(() =>
  vi.fn(
    async (
      _keyId: string,
      _chainId: number,
      amountUsd: number,
    ): Promise<{ success: boolean; error?: string }> => {
      budgetState.balance -= amountUsd;
      return { success: true };
    },
  ),
);
const creditMock = vi.hoisted(() =>
  vi.fn(
    async (
      _keyId: string,
      _chainId: number,
      amountUsd: number,
      // 4º arg = ownerRef (ownership guard obligatorio, CLAUDE.md). Tipado para
      // poder asertarlo: una violación acá equivale a un IDOR.
      _ownerRef: string,
    ): Promise<{ success: boolean; reverted?: boolean }> => {
      budgetState.balance += amountUsd;
      return { success: true, reverted: true };
    },
  ),
);
const creditDelegationMock = vi.hoisted(() =>
  vi.fn(
    async (
      _delegationId: string,
      _ownerRef: string,
      _keyId: string,
      _chainId: number,
      amountUsd: number,
    ): Promise<{ success: boolean; reverted?: boolean }> => {
      budgetState.balance += amountUsd;
      return { success: true, reverted: true };
    },
  ),
);
const creditSessionMock = vi.hoisted(() =>
  vi.fn(
    async (
      _sessionId: string,
      _ownerRef: string,
      _keyId: string,
      _chainId: number,
      amountUsd: number,
    ): Promise<{ success: boolean; reverted?: boolean }> => {
      budgetState.balance += amountUsd;
      return { success: true, reverted: true };
    },
  ),
);
vi.mock('../services/budget.js', () => ({
  budgetService: {
    debit: debitMock,
    getBalance: vi.fn(async () => budgetState.balance.toFixed(2)),
    credit: creditMock,
    creditWithDest: vi
      .fn()
      .mockResolvedValue({ success: true, reverted: true }),
    creditDelegation: creditDelegationMock,
    creditSession: creditSessionMock,
  },
}));

// ── delegación / key-session (branches dual-ledger del middleware) ──
const delegationLookupMock = vi.hoisted(() =>
  vi.fn(async (_hash: string): Promise<DelegationRow | null> => null),
);
const delegationParentMock = vi.hoisted(() =>
  vi.fn(async (_keyId: string): Promise<A2AAgentKeyRow | null> => null),
);
const delegationDebitMock = vi.hoisted(() =>
  vi.fn(
    async (
      _delegationId: string,
      _ownerRef: string,
      _keyId: string,
      _chainId: number,
      amountUsd: number,
    ): Promise<string> => {
      budgetState.balance -= amountUsd;
      return budgetState.balance.toFixed(2);
    },
  ),
);
vi.mock('../services/delegation.js', async (orig) => {
  const actual = await orig<typeof import('../services/delegation.js')>();
  return {
    ...actual,
    delegationService: {
      ...actual.delegationService,
      lookupByTokenHash: delegationLookupMock,
      getParentKey: delegationParentMock,
      debitDelegationAndParent: delegationDebitMock,
    },
  };
});

const sessionLookupMock = vi.hoisted(() =>
  vi.fn(async (_hash: string): Promise<KeySessionRow | null> => null),
);
const sessionParentMock = vi.hoisted(() =>
  vi.fn(async (_keyId: string): Promise<A2AAgentKeyRow | null> => null),
);
const sessionDebitMock = vi.hoisted(() =>
  vi.fn(
    async (
      _sessionId: string,
      _ownerRef: string,
      _keyId: string,
      _chainId: number,
      amountUsd: number,
    ): Promise<string> => {
      budgetState.balance -= amountUsd;
      return budgetState.balance.toFixed(2);
    },
  ),
);
vi.mock('../services/key-session.js', async (orig) => {
  const actual = await orig<typeof import('../services/key-session.js')>();
  return {
    ...actual,
    keySessionService: {
      ...actual.keySessionService,
      lookupByTokenHash: sessionLookupMock,
      getParentKey: sessionParentMock,
      debitSessionAndParent: sessionDebitMock,
    },
  };
});

vi.mock('../services/receipt.js', () => ({
  receiptService: { emit: vi.fn().mockResolvedValue(undefined) },
}));
const enqueueRefundMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
vi.mock('../services/refund-outbox.js', () => ({
  refundOutbox: { enqueueRefund: enqueueRefundMock },
}));

// ── taskService: mockeado (esta suite mide dinero, no persistencia) ──
vi.mock('../services/task.js', async (orig) => {
  const actual = await orig<typeof import('../services/task.js')>();
  return {
    ...actual,
    taskService: {
      create: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      updateStatus: vi.fn(),
      append: vi.fn(),
    },
  };
});

import { buildEoaPaymentHeader } from '../__tests__/fixtures/passport-shape.js';
import {
  TaskNotFoundError,
  TerminalStateError,
  taskService,
} from '../services/task.js';
// NOTA: `requirePaymentOrA2AKey` NO está mockeado — corre el middleware real.
import tasksRoutes from './tasks.js';

const mockCreate = vi.mocked(taskService.create);
const mockGet = vi.mocked(taskService.get);
const mockList = vi.mocked(taskService.list);
const mockUpdateStatus = vi.mocked(taskService.updateStatus);
const mockAppend = vi.mocked(taskService.append);

const KEY_HEADER = { 'x-a2a-key': 'wasi_a2a_master_key' };
const SERVER_WALLET = '0x000000000000000000000000000000000000dEaD';
const DELEGATION_TOKEN = `wasi_a2a_session_${'b'.repeat(96)}`;
const SESSION_TOKEN = `wasi_a2a_sess_${'c'.repeat(96)}`;
const UUID = '11111111-2222-4333-8444-555555555555';
const sha256 = (s: string): string =>
  crypto.createHash('sha256').update(s).digest('hex');

/** Header de pago x402 válido (bindea payTo + monto exacto del challenge). */
function paymentHeaders(): Record<string, string> {
  return buildEoaPaymentHeader({ to: SERVER_WALLET, value: '1000000' }).headers;
}

function makeDelegationRow(): DelegationRow {
  return {
    id: 'd1',
    key_id: 'k1',
    owner_ref: 'o1',
    session_key_address: '0xdef0000000000000000000000000000000000002',
    session_token_hash: sha256(DELEGATION_TOKEN),
    policy: {
      max_amount_per_tx: '5.00',
      max_total_amount: '100.00',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      allowed_chains: [],
      allowed_agent_slugs: [],
      allowed_registries: [],
    },
    total_spent: '0',
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    revoked_at: null,
    typed_data_raw: {} as DelegationRow['typed_data_raw'],
    nonce: `0x${'00'.repeat(32)}`,
    created_at: new Date().toISOString(),
  };
}

function makeKeySessionRow(): KeySessionRow {
  return {
    id: 's1',
    key_id: 'k1',
    owner_ref: 'o1',
    session_token_hash: sha256(SESSION_TOKEN),
    ttl_seconds: 3600,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    max_budget_usd: '10.00',
    spent_usd: '0',
    allowed_registries: null,
    allowed_agent_slugs: null,
    allowed_categories: null,
    derivation_mode: 'server',
    revoked_at: null,
    created_at: new Date().toISOString(),
    require_signature: false,
    signing_secret_hash: null,
  };
}

const task = { id: UUID, status: 'submitted' };

describe('/tasks — no cobrar antes de validar (HU-193)', () => {
  let app: ReturnType<typeof Fastify>;
  const ORIGINAL_WALLET = process.env.KITE_WALLET_ADDRESS;

  beforeAll(async () => {
    app = Fastify();
    await app.register(tasksRoutes, { prefix: '/tasks' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    budgetState.balance = 10;
    process.env.KITE_WALLET_ADDRESS = SERVER_WALLET;
    settleSpy.mockResolvedValue({ txHash: '0xdeadbeef', success: true });
    verifySpy.mockResolvedValue({ valid: true });
    delegationLookupMock.mockResolvedValue(null);
    sessionLookupMock.mockResolvedValue(null);
  });

  afterEach(() => {
    if (ORIGINAL_WALLET === undefined) delete process.env.KITE_WALLET_ADDRESS;
    else process.env.KITE_WALLET_ADDRESS = ORIGINAL_WALLET;
  });

  // ══════════════════════════════════════════════════════════
  // (A) RIEL x402 — los 5 endpoints: `settle` NO debe correr
  // ══════════════════════════════════════════════════════════
  // Pre-fix cada uno de estos settleaba una tx on-chain (plata del caller, gas
  // nuestro) y devolvía 500 por el throw de `getOwnerRef`.

  const x402Cases: Array<{
    name: string;
    method: 'POST' | 'GET' | 'PATCH';
    url: string;
    payload?: Record<string, unknown>;
  }> = [
    {
      name: 'T-NCT-01: POST /tasks',
      method: 'POST',
      url: '/tasks',
      payload: {},
    },
    { name: 'T-NCT-02: GET /tasks', method: 'GET', url: '/tasks' },
    { name: 'T-NCT-03: GET /tasks/:id', method: 'GET', url: `/tasks/${UUID}` },
    {
      name: 'T-NCT-04: PATCH /tasks/:id/status',
      method: 'PATCH',
      url: `/tasks/${UUID}/status`,
      payload: { status: 'working' },
    },
    {
      name: 'T-NCT-05: PATCH /tasks/:id',
      method: 'PATCH',
      url: `/tasks/${UUID}`,
      payload: { messages: [{ role: 'user' }] },
    },
  ];

  for (const c of x402Cases) {
    it(`${c.name} con pago x402 válido → 403 y NO se settlea on-chain (antes: cobro + 500)`, async () => {
      const res = await app.inject({
        method: c.method,
        url: c.url,
        headers: paymentHeaders(),
        ...(c.payload ? { payload: c.payload } : {}),
      });

      // LA ASERCIÓN DE DINERO PRIMERO.
      expect(settleSpy).not.toHaveBeenCalled();
      expect(verifySpy).not.toHaveBeenCalled();

      expect(res.statusCode).toBe(403);
      expect(res.json().error_code).toBe('A2A_KEY_REQUIRED');
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockList).not.toHaveBeenCalled();
      expect(mockGet).not.toHaveBeenCalled();
      expect(mockUpdateStatus).not.toHaveBeenCalled();
      expect(mockAppend).not.toHaveBeenCalled();
    });
  }

  // ══════════════════════════════════════════════════════════
  // (B) RIEL PREPAGO — validación de forma adelantada: balance intacto
  // ══════════════════════════════════════════════════════════

  it('T-NCT-06: POST con body no-objeto → 400 y el balance NO se mueve', async () => {
    const before = budgetState.balance;

    const res = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { ...KEY_HEADER, 'content-type': 'application/json' },
      payload: '"soy-un-string"',
    });

    expect(budgetState.balance).toBe(before);
    expect(debitMock).not.toHaveBeenCalled();
    expect(creditMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Invalid request body');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('T-NCT-07: GET /tasks con `status` fuera del enum → 400 y el balance NO se mueve', async () => {
    const before = budgetState.balance;

    const res = await app.inject({
      method: 'GET',
      url: '/tasks?status=no-existe',
      headers: KEY_HEADER,
    });

    expect(budgetState.balance).toBe(before);
    expect(debitMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Invalid status: no-existe');
    expect(mockList).not.toHaveBeenCalled();
  });

  it('T-NCT-08: GET /tasks/:id con UUID inválido → 400 y el balance NO se mueve', async () => {
    const before = budgetState.balance;

    const res = await app.inject({
      method: 'GET',
      url: '/tasks/no-soy-un-uuid',
      headers: KEY_HEADER,
    });

    expect(budgetState.balance).toBe(before);
    expect(debitMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Invalid UUID format');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('T-NCT-09: PATCH /:id/status con UUID inválido → 400 y el balance NO se mueve', async () => {
    const before = budgetState.balance;

    const res = await app.inject({
      method: 'PATCH',
      url: '/tasks/nope/status',
      headers: KEY_HEADER,
      payload: { status: 'working' },
    });

    expect(budgetState.balance).toBe(before);
    expect(debitMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Invalid UUID format');
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  it('T-NCT-10: PATCH /:id/status con `status` inválido → 400 y el balance NO se mueve', async () => {
    const before = budgetState.balance;

    const res = await app.inject({
      method: 'PATCH',
      url: `/tasks/${UUID}/status`,
      headers: KEY_HEADER,
      payload: { status: 'inventado' },
    });

    expect(budgetState.balance).toBe(before);
    expect(debitMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Invalid status: inventado');
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  it('T-NCT-11: PATCH /:id sin messages ni artifacts → 400 y el balance NO se mueve', async () => {
    const before = budgetState.balance;

    const res = await app.inject({
      method: 'PATCH',
      url: `/tasks/${UUID}`,
      headers: KEY_HEADER,
      payload: {},
    });

    expect(budgetState.balance).toBe(before);
    expect(debitMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(
      'Must provide messages or artifacts to append',
    );
    expect(mockAppend).not.toHaveBeenCalled();
  });

  // ══════════════════════════════════════════════════════════
  // (C) RESIDUO PREPAGO — no adelantable, pero reembolsado
  // ══════════════════════════════════════════════════════════

  it('T-NCT-12: GET /tasks/:id de una task ajena/inexistente → 404 y el balance queda igual', async () => {
    const before = budgetState.balance;
    mockGet.mockResolvedValueOnce(undefined);

    const res = await app.inject({
      method: 'GET',
      url: `/tasks/${UUID}`,
      headers: KEY_HEADER,
    });

    expect(res.statusCode).toBe(404);
    // "No existe" y "no es tuya" son indistinguibles a propósito y ambas
    // necesitan un read con el owner_ref del caller → no adelantable.
    expect(debitMock).toHaveBeenCalledTimes(1);
    expect(creditMock).toHaveBeenCalledTimes(1);
    expect(creditMock).toHaveBeenCalledWith('k1', 2368, 1, 'o1');
    expect(budgetState.balance).toBe(before);
  });

  it('T-NCT-13: PATCH /:id/status de una task inexistente → 404 y el balance queda igual', async () => {
    const before = budgetState.balance;
    mockUpdateStatus.mockRejectedValueOnce(new TaskNotFoundError(UUID));

    const res = await app.inject({
      method: 'PATCH',
      url: `/tasks/${UUID}/status`,
      headers: KEY_HEADER,
      payload: { status: 'working' },
    });

    expect(res.statusCode).toBe(404);
    expect(creditMock).toHaveBeenCalledWith('k1', 2368, 1, 'o1');
    expect(budgetState.balance).toBe(before);
  });

  it('T-NCT-14: PATCH /:id/status sobre estado terminal → 409 y el balance queda igual', async () => {
    const before = budgetState.balance;
    mockUpdateStatus.mockRejectedValueOnce(
      new TerminalStateError(UUID, 'completed'),
    );

    const res = await app.inject({
      method: 'PATCH',
      url: `/tasks/${UUID}/status`,
      headers: KEY_HEADER,
      payload: { status: 'working' },
    });

    expect(res.statusCode).toBe(409);
    expect(creditMock).toHaveBeenCalledTimes(1);
    expect(budgetState.balance).toBe(before);
  });

  it('T-NCT-15: PATCH /:id (append) de una task inexistente → 404 y el balance queda igual', async () => {
    const before = budgetState.balance;
    mockAppend.mockRejectedValueOnce(new TaskNotFoundError(UUID));

    const res = await app.inject({
      method: 'PATCH',
      url: `/tasks/${UUID}`,
      headers: KEY_HEADER,
      payload: { messages: [{ role: 'user' }] },
    });

    expect(res.statusCode).toBe(404);
    expect(creditMock).toHaveBeenCalledWith('k1', 2368, 1, 'o1');
    expect(budgetState.balance).toBe(before);
  });

  it('T-NCT-16: PATCH /:id (append) sobre estado terminal → 409 y el balance queda igual', async () => {
    const before = budgetState.balance;
    mockAppend.mockRejectedValueOnce(new TerminalStateError(UUID, 'canceled'));

    const res = await app.inject({
      method: 'PATCH',
      url: `/tasks/${UUID}`,
      headers: KEY_HEADER,
      payload: { artifacts: [{ name: 'a' }] },
    });

    expect(res.statusCode).toBe(409);
    expect(creditMock).toHaveBeenCalledTimes(1);
    expect(budgetState.balance).toBe(before);
  });

  it('T-NCT-17: residuo bajo DELEGACIÓN → credit dual-ledger (no `credit` a secas)', async () => {
    const before = budgetState.balance;
    delegationLookupMock.mockResolvedValueOnce(makeDelegationRow());
    delegationParentMock.mockResolvedValueOnce(fundedKey);
    mockGet.mockResolvedValueOnce(undefined);

    const res = await app.inject({
      method: 'GET',
      url: `/tasks/${UUID}`,
      headers: { 'x-a2a-key': DELEGATION_TOKEN },
    });

    expect(res.statusCode).toBe(404);
    expect(creditDelegationMock).toHaveBeenCalledWith(
      'd1',
      'o1',
      'k1',
      2368,
      1,
    );
    expect(creditMock).not.toHaveBeenCalled();
    expect(budgetState.balance).toBe(before);
  });

  it('T-NCT-18: residuo bajo KEY-SESSION → credit dual-ledger de sesión', async () => {
    const before = budgetState.balance;
    sessionLookupMock.mockResolvedValueOnce(makeKeySessionRow());
    sessionParentMock.mockResolvedValueOnce(fundedKey);
    mockAppend.mockRejectedValueOnce(new TerminalStateError(UUID, 'completed'));

    const res = await app.inject({
      method: 'PATCH',
      url: `/tasks/${UUID}`,
      headers: { 'x-a2a-key': SESSION_TOKEN },
      payload: { messages: [{ role: 'user' }] },
    });

    expect(res.statusCode).toBe(409);
    expect(creditSessionMock).toHaveBeenCalledWith('s1', 'o1', 'k1', 2368, 1);
    expect(creditMock).not.toHaveBeenCalled();
    expect(budgetState.balance).toBe(before);
  });

  // ══════════════════════════════════════════════════════════
  // (D) INVARIANTES — el happy path cuesta exactamente lo mismo que antes
  // ══════════════════════════════════════════════════════════

  it('T-NCT-19 (invariante): POST válido → 201, cobra $1 y NO reembolsa', async () => {
    const before = budgetState.balance;
    mockCreate.mockResolvedValueOnce(task as never);

    const res = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: KEY_HEADER,
      payload: { messages: [{ role: 'user' }] },
    });

    expect(res.statusCode).toBe(201);
    expect(debitMock).toHaveBeenCalledTimes(1);
    expect(creditMock).not.toHaveBeenCalled();
    expect(budgetState.balance).toBe(before - 1);
  });

  it('T-NCT-20 (invariante): `?status=` vacío sigue NO siendo 400 y cobra igual que antes', async () => {
    // Contrato preservado: el guard histórico era `if (status && ...)`, así que un
    // `status` vacío nunca fue un 400. Si el check pre-cobro lo rechazara, sería
    // un cambio de comportamiento encubierto.
    const before = budgetState.balance;
    mockList.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/tasks?status=',
      headers: KEY_HEADER,
    });

    expect(res.statusCode).toBe(200);
    expect(debitMock).toHaveBeenCalledTimes(1);
    expect(creditMock).not.toHaveBeenCalled();
    expect(budgetState.balance).toBe(before - 1);
  });
});
