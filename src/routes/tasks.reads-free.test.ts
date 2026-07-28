/**
 * `/tasks` — HU-197: consultar el estado de una tarea es GRATIS.
 *
 * EL PROBLEMA: los cinco endpoints de `/tasks` cobraban $1 por LLAMADA, lecturas
 * incluidas (y en Fastify un `HEAD` hermano hereda la cadena de preHandlers del
 * `GET`, así que también cobraba). El ciclo de vida A2A que publicamos pide hacer
 * polling del estado: a $1 la lectura, un poll cada 5 segundos son 720 USD/hora.
 * El precio peleaba contra nuestras propias instrucciones de integración.
 *
 * LA DECISIÓN: se cobra por CREAR y por MUTAR; PREGUNTAR es gratis.
 *
 * QUÉ MIDE ESTA SUITE (y con qué corre): el middleware de pago/auth es el REAL
 * (no está mockeado). El dinero se mide por los TRES canales por los que podría
 * moverse, y ninguno se cree por su valor de retorno:
 *
 *   1. riel PREPAGO → balance en memoria antes/después + `debit` no llamado. Los
 *      mocks de credit SUMAN de verdad al balance: si sólo devolvieran
 *      `{success:true}`, "cobró y devolvió" sería indistinguible de "cobró y se lo
 *      quedó" (y acá hace falta distinguir un tercer caso: "no cobró nada");
 *   2. riel x402 → `settle` del adapter (la tx on-chain ES el cobro);
 *   3. CHALLENGE → `quote` del adapter. Es la aserción del "cero ceremonia": un
 *      402 con `maxAmountRequired: 0` sólo puede existir si alguien cotizó $0. Si
 *      `quote` no se llama, no hay challenge ni con precio cero ni con ninguno.
 *
 * Naming: T-FREE-01..T-FREE-16.
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
/**
 * `quote` es lo que convierte un precio USD en el `maxAmountRequired` del
 * challenge x402 (`middleware/x402.ts` → `resolvePaymentRequirements`). Espiarlo
 * hace OBSERVABLE la ausencia de challenge: sin `quote` no hay 402 posible.
 */
const quoteSpy = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    amountWei: '1000000',
    token: { symbol: 'USDC', address: '0xtoken', decimals: 6 },
    facilitatorUrl: 'http://mock',
  }),
);
const paymentAdapter = vi.hoisted(() => ({
  verify: (...a: unknown[]) => verifySpy(...a),
  settle: (...a: unknown[]) => settleSpy(...a),
  getToken: () => '0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e',
  getNetwork: () => 'eip155:2368',
  getScheme: () => 'exact',
  getMerchantName: () => 'wasiai-a2a-test',
  getMaxTimeoutSeconds: () => 60,
  quote: (...a: unknown[]) => quoteSpy(...a),
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
const lookupByHashMock = vi.hoisted(() =>
  vi.fn(async (_hash: string): Promise<A2AAgentKeyRow | null> => null),
);
vi.mock('../services/identity.js', () => ({
  isIdentityVerified: () => false,
  identityService: { lookupByHash: lookupByHashMock },
}));

// ── budgetService: balance en memoria. `debit` resta, los `credit*` SUMAN ──
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
const getBalanceMock = vi.hoisted(() =>
  vi.fn(async (): Promise<string> => '0'),
);
vi.mock('../services/budget.js', () => ({
  budgetService: {
    debit: debitMock,
    getBalance: getBalanceMock,
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

/**
 * El recibo `budget_debit` es el RASTRO CONTABLE del cobro: el path master lo
 * emite justo después de un débito exitoso. "No se emitió ningún recibo" es una
 * cuarta evidencia independiente de que la lectura no cobró.
 */
const receiptEmitMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../services/receipt.js', () => ({
  receiptService: { emit: receiptEmitMock },
}));
const enqueueRefundMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
vi.mock('../services/refund-outbox.js', () => ({
  refundOutbox: { enqueueRefund: enqueueRefundMock },
}));

// ── taskService mockeado (esta suite mide dinero, no persistencia) ──
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
import { taskService } from '../services/task.js';
// NOTA: ni `requirePaymentOrA2AKey` ni `requireA2AKey` están mockeados — corre el
// middleware REAL, que es el que decide si se cobra.
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

const task = { id: UUID, status: 'working' };

/** Ningún canal de cobro se movió: prepago, x402 y el rastro contable. */
function expectNothingCharged(balanceBefore: number): void {
  expect(debitMock).not.toHaveBeenCalled();
  expect(delegationDebitMock).not.toHaveBeenCalled();
  expect(sessionDebitMock).not.toHaveBeenCalled();
  expect(settleSpy).not.toHaveBeenCalled();
  expect(verifySpy).not.toHaveBeenCalled();
  expect(receiptEmitMock).not.toHaveBeenCalled();
  // Un credit sin débito INFLA el budget: es tan grave como cobrar de más.
  expect(creditMock).not.toHaveBeenCalled();
  expect(creditDelegationMock).not.toHaveBeenCalled();
  expect(creditSessionMock).not.toHaveBeenCalled();
  expect(enqueueRefundMock).not.toHaveBeenCalled();
  expect(budgetState.balance).toBe(balanceBefore);
}

describe('/tasks — leer es gratis, crear y mutar se cobra (HU-197)', () => {
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
    lookupByHashMock.mockResolvedValue(fundedKey);
    getBalanceMock.mockResolvedValue(budgetState.balance.toFixed(2));
    settleSpy.mockResolvedValue({ txHash: '0xdeadbeef', success: true });
    verifySpy.mockResolvedValue({ valid: true });
    quoteSpy.mockResolvedValue({
      amountWei: '1000000',
      token: { symbol: 'USDC', address: '0xtoken', decimals: 6 },
      facilitatorUrl: 'http://mock',
    });
    delegationLookupMock.mockResolvedValue(null);
    sessionLookupMock.mockResolvedValue(null);
  });

  afterEach(() => {
    if (ORIGINAL_WALLET === undefined) delete process.env.KITE_WALLET_ADDRESS;
    else process.env.KITE_WALLET_ADDRESS = ORIGINAL_WALLET;
  });

  // ══════════════════════════════════════════════════════════
  // (A) LAS LECTURAS NO COBRAN — una por ruta, incluidos los HEAD
  // ══════════════════════════════════════════════════════════

  it('T-FREE-01: GET /tasks (listado) → 200 y el balance NO se mueve', async () => {
    const before = budgetState.balance;
    mockList.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/tasks',
      headers: KEY_HEADER,
    });

    expectNothingCharged(before);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tasks: [], total: 0 });
    // La lectura SÍ ocurrió, y scopeada al owner del caller (gratis ≠ público).
    expect(mockList).toHaveBeenCalledWith('o1', expect.anything());
  });

  it('T-FREE-02: GET /tasks/:id (el endpoint del polling) → 200 y el balance NO se mueve', async () => {
    const before = budgetState.balance;
    mockGet.mockResolvedValueOnce(task as never);

    const res = await app.inject({
      method: 'GET',
      url: `/tasks/${UUID}`,
      headers: KEY_HEADER,
    });

    expectNothingCharged(before);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(task);
    expect(mockGet).toHaveBeenCalledWith('o1', UUID);
  });

  it('T-FREE-03: HEAD /tasks → 200 y el balance NO se mueve', async () => {
    // Fastify registra el `HEAD` como hermano del `GET` (`exposeHeadRoutes`) con
    // la MISMA cadena de preHandlers: cuando el `GET` cobraba, el `HEAD` cobraba
    // también, sin estar declarado en ninguna parte. Por eso tiene su propio test.
    const before = budgetState.balance;
    mockList.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'HEAD',
      url: '/tasks',
      headers: KEY_HEADER,
    });

    expectNothingCharged(before);
    expect(res.statusCode).toBe(200);
  });

  it('T-FREE-04: HEAD /tasks/:id → 200 y el balance NO se mueve', async () => {
    const before = budgetState.balance;
    mockGet.mockResolvedValueOnce(task as never);

    const res = await app.inject({
      method: 'HEAD',
      url: `/tasks/${UUID}`,
      headers: KEY_HEADER,
    });

    expectNothingCharged(before);
    expect(res.statusCode).toBe(200);
  });

  it('T-FREE-05: el polling del ciclo de vida A2A cuesta 0 (12 lecturas seguidas)', async () => {
    // La razón de ser de la HU: 12 polls = 1 minuto a 5s de intervalo. Antes eran
    // $12 (720 USD/hora siguiendo nuestras propias instrucciones); ahora $0.
    const before = budgetState.balance;
    mockGet.mockResolvedValue(task as never);

    for (let i = 0; i < 12; i++) {
      const res = await app.inject({
        method: 'GET',
        url: `/tasks/${UUID}`,
        headers: KEY_HEADER,
      });
      expect(res.statusCode).toBe(200);
    }

    expectNothingCharged(before);
    expect(mockGet).toHaveBeenCalledTimes(12);
  });

  // ══════════════════════════════════════════════════════════
  // (B) SIN COBRO, SIN CHALLENGE — la ceremonia vacía no existe
  // ══════════════════════════════════════════════════════════

  it('T-FREE-06: lectura SIN credencial → 403 A2A_KEY_REQUIRED, nunca un 402, y NADIE cotiza el challenge', async () => {
    const before = budgetState.balance;

    const res = await app.inject({ method: 'GET', url: `/tasks/${UUID}` });

    expect(res.statusCode).toBe(403);
    expect(res.statusCode).not.toBe(402);
    expect(res.json().error_code).toBe('A2A_KEY_REQUIRED');
    // Un challenge x402 se reconoce por `accepts[]` (con `maxAmountRequired`).
    // Que no exista es el punto: una lectura gratis no pide pago.
    expect(res.json().accepts).toBeUndefined();
    // Y la evidencia estructural: `quote()` es lo ÚNICO que puede producir el
    // `maxAmountRequired` de un challenge. Sin llamada a `quote` no hay 402
    // posible — ni de $1 ni el de $0 que un "precio cero" habría emitido.
    expect(quoteSpy).not.toHaveBeenCalled();
    expectNothingCharged(before);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('T-FREE-07: lectura de LISTADO sin credencial → 403 sin challenge (mismo criterio)', async () => {
    const before = budgetState.balance;

    const res = await app.inject({ method: 'GET', url: '/tasks' });

    expect(res.statusCode).toBe(403);
    expect(res.json().accepts).toBeUndefined();
    expect(quoteSpy).not.toHaveBeenCalled();
    expectNothingCharged(before);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('T-FREE-08: lectura con pago x402 válido → 403 y NO se settlea nada on-chain', async () => {
    // El riel x402 anónimo no aporta identidad de tenant (WKH-63), así que no
    // puede leer recursos con dueño. Antes de HU-193 esto cobraba on-chain y
    // devolvía 500; hoy la ruta ni siquiera monta el middleware de pago.
    const before = budgetState.balance;

    const res = await app.inject({
      method: 'GET',
      url: `/tasks/${UUID}`,
      headers: paymentHeaders(),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('A2A_KEY_REQUIRED');
    expectNothingCharged(before);
  });

  it('T-FREE-09: el 403 de una lectura habla de LEER, no de publicar', async () => {
    // `requireA2AKey` traía clavado el mensaje de las rutas de publicación
    // ("Publishing requires…"). En una lectura de `/tasks` eso sería falso.
    const res = await app.inject({ method: 'GET', url: '/tasks' });

    expect(res.json().message).toContain('Task management');
    expect(res.json().message).not.toContain('Publishing');
  });

  // ══════════════════════════════════════════════════════════
  // (C) GRATIS ≠ SIN CONTROLES — la lectura sigue autenticada y scopeada
  // ══════════════════════════════════════════════════════════

  it('T-FREE-10: key INACTIVA → 403 KEY_INACTIVE (la lectura sigue autenticada)', async () => {
    const before = budgetState.balance;
    lookupByHashMock.mockResolvedValueOnce({ ...fundedKey, is_active: false });

    const res = await app.inject({
      method: 'GET',
      url: `/tasks/${UUID}`,
      headers: KEY_HEADER,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('KEY_INACTIVE');
    expectNothingCharged(before);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('T-FREE-11: key SIN SALDO y con el límite diario agotado → igual puede leer (200)', async () => {
    // CAMBIO DE COMPORTAMIENTO BUSCADO: antes esta lectura moría con
    // 403 DAILY_LIMIT (o INSUFFICIENT_BUDGET). Si preguntar es gratis, quedarse
    // sin saldo no puede dejarte ciego sobre tus propias tareas — que es justo
    // cuando más necesitás consultar el estado de lo que ya pagaste.
    const before = budgetState.balance;
    lookupByHashMock.mockResolvedValueOnce({
      ...fundedKey,
      budget: { '2368': '0' },
      daily_limit_usd: '5.00',
      daily_spent_usd: '5.00',
    });
    mockGet.mockResolvedValueOnce(task as never);

    const res = await app.inject({
      method: 'GET',
      url: `/tasks/${UUID}`,
      headers: KEY_HEADER,
    });

    expect(res.statusCode).toBe(200);
    expectNothingCharged(before);
  });

  it('T-FREE-12: lectura bajo DELEGACIÓN → 200 y ni el ledger de la delegación ni el de la parent key se mueven', async () => {
    const before = budgetState.balance;
    delegationLookupMock.mockResolvedValueOnce(makeDelegationRow());
    delegationParentMock.mockResolvedValueOnce(fundedKey);
    mockGet.mockResolvedValueOnce(task as never);

    const res = await app.inject({
      method: 'GET',
      url: `/tasks/${UUID}`,
      headers: { 'x-a2a-key': DELEGATION_TOKEN },
    });

    expect(res.statusCode).toBe(200);
    expectNothingCharged(before);
    // El scoping por tenant sale de la PARENT key, igual que en el path pago.
    expect(mockGet).toHaveBeenCalledWith('o1', UUID);
  });

  it('T-FREE-13: lectura bajo KEY-SESSION → 200 y el ledger de la sesión no se mueve', async () => {
    const before = budgetState.balance;
    sessionLookupMock.mockResolvedValueOnce(makeKeySessionRow());
    sessionParentMock.mockResolvedValueOnce(fundedKey);
    mockList.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/tasks',
      headers: { 'x-a2a-key': SESSION_TOKEN },
    });

    expect(res.statusCode).toBe(200);
    expectNothingCharged(before);
    expect(mockList).toHaveBeenCalledWith('o1', expect.anything());
  });

  it('T-FREE-14 (efecto declarado): la lectura ya no devuelve el header de saldo', async () => {
    // `x-a2a-remaining-budget` lo escribe el middleware de PAGO después de
    // debitar. Sin cobro no hay lectura de saldo (ni la query que la produce):
    // el header desaparece de las dos lecturas. Queda declarado en el contrato
    // público y en el header de `routes/tasks.ts`.
    mockList.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/tasks',
      headers: KEY_HEADER,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-a2a-remaining-budget']).toBeUndefined();
    expect(getBalanceMock).not.toHaveBeenCalled();
  });

  // ══════════════════════════════════════════════════════════
  // (D) LO QUE NO CAMBIÓ — crear y mutar siguen costando $1
  // ══════════════════════════════════════════════════════════
  // Sin estos tres, "las lecturas son gratis" sería indistinguible de "se rompió
  // el cobro de `/tasks`", que es un agujero de ingresos, no una mejora de UX.

  it('T-FREE-15: POST /tasks (crear) sigue cobrando $1', async () => {
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
    expect(debitMock.mock.calls[0]?.[2]).toBe(1);
    expect(creditMock).not.toHaveBeenCalled();
    expect(budgetState.balance).toBe(before - 1);
  });

  it('T-FREE-16: los dos PATCH (mutar) siguen cobrando $1 cada uno', async () => {
    mockUpdateStatus.mockResolvedValueOnce(task as never);
    const beforeStatus = budgetState.balance;

    const resStatus = await app.inject({
      method: 'PATCH',
      url: `/tasks/${UUID}/status`,
      headers: KEY_HEADER,
      payload: { status: 'working' },
    });

    expect(resStatus.statusCode).toBe(200);
    expect(debitMock).toHaveBeenCalledTimes(1);
    expect(budgetState.balance).toBe(beforeStatus - 1);

    mockAppend.mockResolvedValueOnce(task as never);
    const beforeAppend = budgetState.balance;

    const resAppend = await app.inject({
      method: 'PATCH',
      url: `/tasks/${UUID}`,
      headers: KEY_HEADER,
      payload: { messages: [{ role: 'user' }] },
    });

    expect(resAppend.statusCode).toBe(200);
    expect(debitMock).toHaveBeenCalledTimes(2);
    expect(budgetState.balance).toBe(beforeAppend - 1);
  });
});
