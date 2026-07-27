/**
 * `/registries` — HU-193: no cobrar antes de validar.
 *
 * EL BUG: los 3 endpoints de mutación (POST/PATCH/DELETE) pasan por
 * `requirePaymentOrA2AKey`, que cobra ANTES de invocar el handler. Todo rechazo
 * del handler (400 de campos faltantes, 422 de SSRF, 403 `A2A_KEY_REQUIRED`, 404
 * de ownership, 403 de registry de sistema) llegaba con el cobro ya hecho:
 *
 *   • riel PREPAGO: $1 debitado del budget y nunca devuelto;
 *   • riel x402: un settle ON-CHAIN irreversible, cuyo GAS pagó nuestra wallet de
 *     operador — y encima para un rechazo GARANTIZADO, porque el path x402
 *     anónimo nunca puede mutar registries (WKH-63: sin identidad de tenant).
 *
 * EL FIX: `chargedRoute` (`middleware/charged-route.ts`) pone las validaciones de
 * FORMA antes del cobro. Lo que NO se puede adelantar (necesita I/O o el
 * `owner_ref` del caller) queda como residuo y, en el riel prepago, se reembolsa
 * con `refundStep0Debit`.
 *
 * CÓMO SE MIDE EL DINERO ACÁ (un test que sólo mira el status no prueba nada):
 *   • prepago → balance en memoria ANTES y DESPUÉS de cada request;
 *   • x402 → `settle` del adapter. Ahí no hay saldo interno que observar: la
 *     transacción on-chain ES el cobro, así que "settle NO fue llamado" es la
 *     aserción de dinero. Pre-fix, estos mismos requests lo llamaban.
 *
 * Corre el middleware de pago REAL (a diferencia de los otros archivos de
 * `/registries`, que lo moquean con un pass-through que nunca cobra).
 *
 * Naming: T-NCR-01..T-NCR-18.
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

// ── registryService: mockeado (esta suite mide dinero, no persistencia) ──
vi.mock('../services/registry.js', async (orig) => {
  const actual = await orig<typeof import('../services/registry.js')>();
  return {
    ...actual,
    registryService: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(undefined),
      register: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  };
});

// ── url-validator: real, salvo `validateRegistryUrl` (SSRF determinista) ──
const SSRF_HOST = 'http://blocked.internal/discovery';
vi.mock('../lib/url-validator.js', async (orig) => {
  const actual = await orig<typeof import('../lib/url-validator.js')>();
  return {
    ...actual,
    validateRegistryUrl: vi.fn(async (url: string) => {
      if (url === SSRF_HOST) {
        // (reason, category) — ver el constructor real.
        throw new actual.SSRFViolationError('blocked.internal', 'private-ip');
      }
    }),
  };
});

import { buildEoaPaymentHeader } from '../__tests__/fixtures/passport-shape.js';
import {
  registryService,
  SystemRegistryImmutableError,
} from '../services/registry.js';
import { OwnershipMismatchError } from '../services/security/errors.js';
// NOTA: `requirePaymentOrA2AKey` NO está mockeado — corre el middleware real.
import registriesRoutes from './registries.js';

const mockRegister = vi.mocked(registryService.register);
const mockUpdate = vi.mocked(registryService.update);
const mockDelete = vi.mocked(registryService.delete);

const KEY_HEADER = { 'x-a2a-key': 'wasi_a2a_master_key' };
const SERVER_WALLET = '0x000000000000000000000000000000000000dEaD';
const DELEGATION_TOKEN = `wasi_a2a_session_${'b'.repeat(96)}`;
const SESSION_TOKEN = `wasi_a2a_sess_${'c'.repeat(96)}`;
const sha256 = (s: string): string =>
  crypto.createHash('sha256').update(s).digest('hex');

/** Header de pago x402 válido (bindea payTo + monto exacto del challenge). */
function paymentHeaders(): Record<string, string> {
  return buildEoaPaymentHeader({ to: SERVER_WALLET, value: '1000000' }).headers;
}

const VALID_BODY = {
  name: 'my-registry',
  discoveryEndpoint: 'https://example.com/discover',
  invokeEndpoint: 'https://example.com/invoke',
  schema: 'wasiai-v1',
};

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

describe('/registries — no cobrar antes de validar (HU-193)', () => {
  let app: ReturnType<typeof Fastify>;
  const ORIGINAL_WALLET = process.env.KITE_WALLET_ADDRESS;

  beforeAll(async () => {
    app = Fastify();
    await app.register(registriesRoutes, { prefix: '/registries' });
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
  // (A) RIEL x402 — el cobro es una tx on-chain: `settle` NO debe correr
  // ══════════════════════════════════════════════════════════

  it('T-NCR-01: POST con pago x402 válido y sin a2a-key → 403 y NO se settlea on-chain', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/registries',
      headers: paymentHeaders(),
      payload: VALID_BODY,
    });

    // LA ASERCIÓN DE DINERO PRIMERO. Pre-fix: verify+settle corrían, el caller
    // pagaba USDC on-chain (con gas de NUESTRA wallet de operador) y recibía este
    // mismo 403 — un rechazo garantizado, porque el riel x402 no puede mutar
    // registries (WKH-63). No hay saldo interno para devolvérselo.
    expect(settleSpy).not.toHaveBeenCalled();
    expect(verifySpy).not.toHaveBeenCalled();

    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('A2A_KEY_REQUIRED');
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('T-NCR-02: PATCH con pago x402 válido → 403 y NO se settlea on-chain', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/registries/some-id',
      headers: paymentHeaders(),
      payload: { enabled: false },
    });

    expect(settleSpy).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('A2A_KEY_REQUIRED');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('T-NCR-03: DELETE con pago x402 válido → 403 y NO se settlea on-chain', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/registries/some-id',
      headers: paymentHeaders(),
    });

    expect(settleSpy).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('A2A_KEY_REQUIRED');
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('T-NCR-04 (efecto colateral declarado): sin credencial y sin pago → 403, ya NO 402 challenge', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/registries',
      payload: VALID_BODY,
    });

    // Antes salía un 402 con `accepts[]` que invitaba a pagar por algo que iba a
    // ser rechazado igual. Ahora se rechaza gratis. Es un cambio de contrato
    // documentado en doc/INTEGRATION.md.
    expect(res.statusCode).toBe(403);
    expect(res.json().accepts).toBeUndefined();
    expect(settleSpy).not.toHaveBeenCalled();
  });

  // ══════════════════════════════════════════════════════════
  // (B) RIEL PREPAGO — validación adelantada: el balance NO se mueve
  // ══════════════════════════════════════════════════════════

  it('T-NCR-05: POST sin campos requeridos → 400 y el balance NO se mueve (antes cobraba $1)', async () => {
    const before = budgetState.balance;

    const res = await app.inject({
      method: 'POST',
      url: '/registries',
      headers: KEY_HEADER,
      payload: { name: 'solo-el-nombre' },
    });

    expect(budgetState.balance).toBe(before);
    expect(debitMock).not.toHaveBeenCalled();
    expect(creditMock).not.toHaveBeenCalled(); // no hay nada que reembolsar

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(
      'Missing required fields: name, discoveryEndpoint, invokeEndpoint, schema',
    );
    expect(mockRegister).not.toHaveBeenCalled();
  });

  // ══════════════════════════════════════════════════════════
  // (C) RESIDUO PREPAGO — no adelantable, pero reembolsado
  // ══════════════════════════════════════════════════════════

  it('T-NCR-06: POST con URL SSRF → 422 y el balance queda igual (débito + credit-back)', async () => {
    const before = budgetState.balance;

    const res = await app.inject({
      method: 'POST',
      url: '/registries',
      headers: KEY_HEADER,
      payload: { ...VALID_BODY, discoveryEndpoint: SSRF_HOST },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('SSRF_BLOCKED');
    // El 422 necesita resolución DNS → no es adelantable (un `PreChargeCheck` es
    // síncrono a propósito). Se cobra y se devuelve: neto cero.
    expect(debitMock).toHaveBeenCalledTimes(1);
    expect(creditMock).toHaveBeenCalledTimes(1);
    expect(budgetState.balance).toBe(before);
    // Ownership guard (CLAUDE.md): el credit va con el owner_ref del caller
    // autenticado, y por el monto exacto del débito ($1), nunca más.
    expect(creditMock).toHaveBeenCalledWith('k1', 2368, 1, 'o1');
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('T-NCR-07: POST cuando el service falla → 400 y el balance queda igual', async () => {
    const before = budgetState.balance;
    mockRegister.mockRejectedValueOnce(
      new Error("Registry 'my-registry' already exists"),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/registries',
      headers: KEY_HEADER,
      payload: VALID_BODY,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Failed to register registry');
    expect(creditMock).toHaveBeenCalledTimes(1);
    expect(creditMock).toHaveBeenCalledWith('k1', 2368, 1, 'o1');
    expect(budgetState.balance).toBe(before);
  });

  it('T-NCR-08: PATCH de un registry ajeno/inexistente → 404 y el balance queda igual', async () => {
    const before = budgetState.balance;
    mockUpdate.mockRejectedValueOnce(new OwnershipMismatchError());

    const res = await app.inject({
      method: 'PATCH',
      url: '/registries/other-tenant-registry',
      headers: KEY_HEADER,
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(404);
    expect(creditMock).toHaveBeenCalledWith('k1', 2368, 1, 'o1');
    expect(budgetState.balance).toBe(before);
  });

  it('T-NCR-09: PATCH de un registry de sistema → 403 y el balance queda igual', async () => {
    const before = budgetState.balance;
    mockUpdate.mockRejectedValueOnce(new SystemRegistryImmutableError());

    const res = await app.inject({
      method: 'PATCH',
      url: '/registries/wasiai',
      headers: KEY_HEADER,
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('System registry is immutable');
    expect(creditMock).toHaveBeenCalledTimes(1);
    expect(budgetState.balance).toBe(before);
  });

  it('T-NCR-10: PATCH con URL SSRF → 422 y el balance queda igual', async () => {
    const before = budgetState.balance;

    const res = await app.inject({
      method: 'PATCH',
      url: '/registries/mine',
      headers: KEY_HEADER,
      payload: { discoveryEndpoint: SSRF_HOST },
    });

    expect(res.statusCode).toBe(422);
    expect(creditMock).toHaveBeenCalledTimes(1);
    expect(budgetState.balance).toBe(before);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('T-NCR-11: PATCH que falla en la DB → 400 y el balance queda igual', async () => {
    const before = budgetState.balance;
    mockUpdate.mockRejectedValueOnce(new Error('PGRST timeout'));

    const res = await app.inject({
      method: 'PATCH',
      url: '/registries/mine',
      headers: KEY_HEADER,
      payload: { enabled: true },
    });

    expect(res.statusCode).toBe(400);
    expect(creditMock).toHaveBeenCalledTimes(1);
    expect(budgetState.balance).toBe(before);
  });

  it('T-NCR-12: DELETE de un registry ajeno/inexistente → 404 y el balance queda igual', async () => {
    const before = budgetState.balance;
    mockDelete.mockRejectedValueOnce(new OwnershipMismatchError());

    const res = await app.inject({
      method: 'DELETE',
      url: '/registries/other-tenant-registry',
      headers: KEY_HEADER,
    });

    expect(res.statusCode).toBe(404);
    expect(creditMock).toHaveBeenCalledWith('k1', 2368, 1, 'o1');
    expect(budgetState.balance).toBe(before);
  });

  it('T-NCR-13: DELETE que no borró nada (race) → 404 y el balance queda igual', async () => {
    const before = budgetState.balance;
    mockDelete.mockResolvedValueOnce(false);

    const res = await app.inject({
      method: 'DELETE',
      url: '/registries/vanished',
      headers: KEY_HEADER,
    });

    expect(res.statusCode).toBe(404);
    expect(creditMock).toHaveBeenCalledTimes(1);
    expect(budgetState.balance).toBe(before);
  });

  it('T-NCR-14: DELETE que falla en la DB → 400 y el balance queda igual', async () => {
    const before = budgetState.balance;
    mockDelete.mockRejectedValueOnce(new Error('PGRST timeout'));

    const res = await app.inject({
      method: 'DELETE',
      url: '/registries/mine',
      headers: KEY_HEADER,
    });

    expect(res.statusCode).toBe(400);
    expect(creditMock).toHaveBeenCalledTimes(1);
    expect(budgetState.balance).toBe(before);
  });

  // ── Residuo bajo delegación / key-session: refund DUAL-LEDGER ──

  it('T-NCR-15: residuo bajo DELEGACIÓN → credit dual-ledger (no `credit` a secas)', async () => {
    const before = budgetState.balance;
    delegationLookupMock.mockResolvedValueOnce(makeDelegationRow());
    delegationParentMock.mockResolvedValueOnce(fundedKey);
    mockUpdate.mockRejectedValueOnce(new OwnershipMismatchError());

    const res = await app.inject({
      method: 'PATCH',
      url: '/registries/other-tenant-registry',
      headers: { 'x-a2a-key': DELEGATION_TOKEN },
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(404);
    // El débito de la delegación es DUAL (ledger de la delegación + parent), así
    // que el refund tiene que ser simétrico: `credit` a secas dejaría
    // `total_spent` inflado (self-DoS de la credencial).
    expect(creditDelegationMock).toHaveBeenCalledTimes(1);
    expect(creditMock).not.toHaveBeenCalled();
    // Ownership guard: ownerRef del parent, mismo ledger que debitó.
    expect(creditDelegationMock).toHaveBeenCalledWith(
      'd1',
      'o1',
      'k1',
      2368,
      1,
    );
    expect(budgetState.balance).toBe(before);
  });

  it('T-NCR-16: residuo bajo KEY-SESSION → credit dual-ledger de sesión', async () => {
    const before = budgetState.balance;
    sessionLookupMock.mockResolvedValueOnce(makeKeySessionRow());
    sessionParentMock.mockResolvedValueOnce(fundedKey);
    mockDelete.mockRejectedValueOnce(new OwnershipMismatchError());

    const res = await app.inject({
      method: 'DELETE',
      url: '/registries/other-tenant-registry',
      headers: { 'x-a2a-key': SESSION_TOKEN },
    });

    expect(res.statusCode).toBe(404);
    expect(creditSessionMock).toHaveBeenCalledTimes(1);
    expect(creditMock).not.toHaveBeenCalled();
    expect(creditSessionMock).toHaveBeenCalledWith('s1', 'o1', 'k1', 2368, 1);
    expect(budgetState.balance).toBe(before);
  });

  // ══════════════════════════════════════════════════════════
  // (D) INVARIANTE — un pedido VÁLIDO cuesta exactamente lo mismo que antes
  // ══════════════════════════════════════════════════════════

  it('T-NCR-17 (invariante): POST válido → 201, cobra $1 y NO reembolsa', async () => {
    const before = budgetState.balance;
    mockRegister.mockResolvedValueOnce({
      id: 'my-registry',
      name: 'my-registry',
    } as never);

    const res = await app.inject({
      method: 'POST',
      url: '/registries',
      headers: KEY_HEADER,
      payload: VALID_BODY,
    });

    expect(res.statusCode).toBe(201);
    expect(debitMock).toHaveBeenCalledTimes(1);
    expect(creditMock).not.toHaveBeenCalled();
    expect(creditDelegationMock).not.toHaveBeenCalled();
    expect(creditSessionMock).not.toHaveBeenCalled();
    expect(budgetState.balance).toBe(before - 1);
  });

  it('T-NCR-18 (invariante): PATCH válido → 200, cobra $1 y NO reembolsa', async () => {
    const before = budgetState.balance;
    mockUpdate.mockResolvedValueOnce({ id: 'mine', enabled: false } as never);

    const res = await app.inject({
      method: 'PATCH',
      url: '/registries/mine',
      headers: KEY_HEADER,
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(200);
    expect(debitMock).toHaveBeenCalledTimes(1);
    expect(creditMock).not.toHaveBeenCalled();
    expect(budgetState.balance).toBe(before - 1);
  });
});
