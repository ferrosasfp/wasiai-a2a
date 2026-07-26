/**
 * HU-192 — POST /gasless/transfer NO puede cobrar sin transferir.
 *
 * El bug: `requirePaymentOrA2AKey` debita el valor REAL del transfer en el
 * preHandler (sin `skipMiddlewareDebit`), y los caminos de fallo del handler
 * (503 `gasless_not_operational`, 500 `gasless transfer failed`, y el `status()`
 * que tiraba fuera de todo try) devolvían el error SIN reembolsar. El caller
 * quedaba cobrado el monto completo del transfer y no recibía NADA.
 *
 * Estos tests NO miran sólo el status: cada uno asierta el BALANCE del caller
 * antes y después del request contra un ledger stateful (debit/credit reales
 * sobre un objeto en memoria). Un test que sólo mira el status no prueba nada
 * de esto — el status ya era correcto antes del fix.
 *
 * Casos:
 *   T-192-1  503 not-operational (master)      → balance vuelve, credit 1 vez
 *   T-192-2  500 transfer 'not-moved' (master) → balance vuelve
 *   T-192-3  500 transfer 'unknown'            → NO refund (tx pudo aterrizar)
 *   T-192-4  status() tira                     → balance vuelve, sigue 500
 *   T-192-5  happy path                        → cobra EXACTAMENTE lo de siempre
 *   T-192-6  error no clasificado              → NO refund (fail-safe)
 *   T-192-7  delegación                        → refund DUAL-LEDGER (no al padre solo)
 *   T-192-8  key-session                       → refund DUAL-LEDGER
 *   T-192-9  credit success:false              → 503 igual + outbox con señal
 *   T-192-10 credit tira                       → 503 igual + outbox con señal
 */

import crypto from 'node:crypto';
import Fastify, { type FastifyRequest } from 'fastify';
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

// ── Ledger stateful (el corazón de estos tests) ─────────────
// `debit`/`credit*` operan sobre ESTE objeto, así que el balance del caller es
// observable antes y después de cada request. El guard de ownership vive acá
// también: un credit con el owner_ref equivocado NO mueve el ledger (espeja el
// `p_owner_ref` de las RPC), así que "el balance volvió" prueba que el refund
// se hizo con el owner correcto.
const OWNER_REF = 'user-1';
const START_BALANCE = 100;

const ledger = {
  master: START_BALANCE,
  /** `a2a_delegations.total_spent` — pata dual-ledger de la delegación. */
  delegationSpent: 0,
  /** `a2a_key_sessions.spent_usd` — pata dual-ledger de la sesión. */
  sessionSpent: 0,
};

function resetLedger(): void {
  ledger.master = START_BALANCE;
  ledger.delegationSpent = 0;
  ledger.sessionSpent = 0;
}

const { budgetMock, delegationDebitMock, sessionDebitMock, enqueueRefundMock } =
  vi.hoisted(() => ({
    budgetMock: {
      getBalance: vi.fn(),
      debit: vi.fn(),
      registerDeposit: vi.fn(),
      credit: vi.fn(),
      creditWithDest: vi.fn(),
      creditDelegation: vi.fn(),
      creditSession: vi.fn(),
    },
    delegationDebitMock: vi.fn(),
    sessionDebitMock: vi.fn(),
    enqueueRefundMock: vi.fn(),
  }));

vi.mock('../services/budget.js', () => ({ budgetService: budgetMock }));

vi.mock('../services/refund-outbox.js', () => ({
  refundOutbox: {
    enqueueRefund: enqueueRefundMock,
    processRefundOutbox: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../services/identity.js', () => ({
  identityService: {
    createKey: vi.fn(),
    lookupByHash: vi.fn(),
    deactivate: vi.fn(),
  },
  isIdentityVerified: (row: { erc8004_identity?: unknown } | null) =>
    row?.erc8004_identity != null,
}));

vi.mock('../services/delegation.js', () => ({
  delegationService: {
    lookupByTokenHash: vi.fn(),
    getParentKey: vi.fn(),
    debitDelegationAndParent: delegationDebitMock,
  },
  exceedsPerTxLimit: vi.fn(() => false),
}));

vi.mock('../services/key-session.js', () => ({
  keySessionService: {
    lookupByTokenHash: vi.fn(),
    getParentKey: vi.fn(),
    debitSessionAndParent: sessionDebitMock,
  },
}));

vi.mock('../services/signed-auth.js', () => ({ verifySignedAuth: vi.fn() }));

// El débito master emite un recibo fire-and-forget: mockeado para que ningún
// test toque supabase.
vi.mock('../services/receipt.js', () => ({
  receiptService: { emit: vi.fn().mockResolvedValue(undefined) },
}));

const mockGaslessTransfer = vi.fn();
const mockGaslessStatus = vi.fn();

vi.mock('../adapters/registry.js', () => {
  const bundles: Record<
    string,
    {
      chainConfig: { name: string; chainId: number; explorerUrl: string };
      payment: {
        supportedTokens: {
          symbol: string;
          address: `0x${string}`;
          decimals: number;
        }[];
      };
    }
  > = {
    'kite-ozone-testnet': {
      chainConfig: {
        name: 'eip155:2368',
        chainId: 2368,
        explorerUrl: 'https://explorer.test',
      },
      payment: {
        supportedTokens: [
          {
            symbol: 'PYUSD',
            address:
              '0x0000000000000000000000000000000000000000' as `0x${string}`,
            decimals: 6,
          },
        ],
      },
    },
  };
  return {
    getGaslessAdapter: vi.fn(() => ({
      status: mockGaslessStatus,
      transfer: mockGaslessTransfer,
    })),
    getPaymentAdapter: vi.fn(() => ({
      name: 'mock',
      chainId: 2368,
      supportedTokens: [],
      getScheme: () => 'exact',
      getNetwork: () => 'eip155:2368',
      getToken: () => '0x0000000000000000000000000000000000000000' as const,
      getMaxTimeoutSeconds: () => 60,
      getMerchantName: () => 'WasiAI Test',
      settle: vi.fn(),
      verify: vi.fn(),
      quote: vi.fn(),
      sign: vi.fn(),
    })),
    getChainConfig: vi.fn(() => ({
      name: 'eip155:2368',
      chainId: 2368,
      explorerUrl: 'https://explorer.test',
    })),
    getAttestationAdapter: vi.fn(),
    getIdentityBindingAdapter: vi.fn(),
    initAdapters: vi.fn(),
    _resetRegistry: vi.fn(),
    getAdaptersBundle: vi.fn(
      (key?: string) => bundles[key ?? 'kite-ozone-testnet'],
    ),
    getInitializedChainKeys: vi.fn(() => Object.keys(bundles)),
    getDefaultChainKey: vi.fn(() => 'kite-ozone-testnet'),
  };
});

import { GaslessTransferError } from '../adapters/errors.js';
import { budgetService } from '../services/budget.js';
import { delegationService } from '../services/delegation.js';
import { identityService } from '../services/identity.js';
import { keySessionService } from '../services/key-session.js';
import gaslessRoutes from './gasless.js';

const mockLookupByHash = vi.mocked(identityService.lookupByHash);
const mockCredit = vi.mocked(budgetService.credit);
const mockCreditDelegation = vi.mocked(budgetService.creditDelegation);
const mockCreditSession = vi.mocked(budgetService.creditSession);
const mockDelegationLookup = vi.mocked(delegationService.lookupByTokenHash);
const mockDelegationParent = vi.mocked(delegationService.getParentKey);
const mockSessionLookup = vi.mocked(keySessionService.lookupByTokenHash);
const mockSessionParent = vi.mocked(keySessionService.getParentKey);

// ── Fixtures ───────────────────────────────────────────────

const TEST_KEY = `wasi_a2a_${'a'.repeat(64)}`;
const TEST_KEY_HASH = crypto
  .createHash('sha256')
  .update(TEST_KEY)
  .digest('hex');
const TEST_KEY_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TEST_TO = '0x1234567890123456789012345678901234567890';
const CHAIN_ID = 2368;

/** $5 en unidades de 6 decimales — el monto que se debita y se reembolsa. */
const VALUE_WEI = '5000000';
const VALUE_USD = 5;

const DELEGATION_TOKEN = `wasi_a2a_session_${'b'.repeat(96)}`;
const DELEGATION_HASH = crypto
  .createHash('sha256')
  .update(DELEGATION_TOKEN)
  .digest('hex');
const SESSION_TOKEN = `wasi_a2a_sess_${'c'.repeat(96)}`;
const SESSION_HASH = crypto
  .createHash('sha256')
  .update(SESSION_TOKEN)
  .digest('hex');

function makeKeyRow(overrides: Partial<A2AAgentKeyRow> = {}): A2AAgentKeyRow {
  return {
    id: TEST_KEY_ID,
    owner_ref: OWNER_REF,
    key_hash: TEST_KEY_HASH,
    display_name: 'Test Key',
    budget: { '2368': '100.000000' },
    daily_limit_usd: null,
    daily_spent_usd: '0.000000',
    daily_reset_at: new Date(Date.now() + 86400000).toISOString(),
    allowed_registries: null,
    allowed_agent_slugs: null,
    allowed_categories: null,
    max_spend_per_call_usd: null,
    is_active: true,
    last_used_at: null,
    created_at: '2026-04-06T12:00:00.000Z',
    updated_at: '2026-04-06T12:00:00.000Z',
    erc8004_identity: null,
    kite_passport: null,
    agentkit_wallet: null,
    funding_wallet: null,
    metadata: {},
    require_signature: false,
    ...overrides,
  };
}

function makeDelegationRow(): DelegationRow {
  return {
    id: 'del-1',
    key_id: TEST_KEY_ID,
    owner_ref: OWNER_REF,
    session_key_address: '0xdef0000000000000000000000000000000000002',
    session_token_hash: DELEGATION_HASH,
    policy: {
      max_amount_per_tx: '50.00',
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
    id: 'sess-1',
    key_id: TEST_KEY_ID,
    owner_ref: OWNER_REF,
    session_token_hash: SESSION_HASH,
    ttl_seconds: 3600,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    max_budget_usd: '50.00',
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

/** Balance del caller tal como lo vería `GET /auth/me` (el ledger real). */
function balance(): number {
  return ledger.master;
}

// ── Suite ──────────────────────────────────────────────────

describe('POST /gasless/transfer — refund on failure (HU-192)', () => {
  let app: ReturnType<typeof Fastify>;
  let originalCap: string | undefined;
  let originalRate: string | undefined;

  beforeAll(async () => {
    originalCap = process.env.GASLESS_DEFAULT_CAP_USD;
    originalRate = process.env.PYUSD_USD_RATE;
    process.env.GASLESS_DEFAULT_CAP_USD = '10';
    process.env.PYUSD_USD_RATE = '1.0';

    app = Fastify();
    await app.register(gaslessRoutes, { prefix: '/gasless' });
    await app.ready();
  });

  afterAll(async () => {
    if (originalCap === undefined) delete process.env.GASLESS_DEFAULT_CAP_USD;
    else process.env.GASLESS_DEFAULT_CAP_USD = originalCap;
    if (originalRate === undefined) delete process.env.PYUSD_USD_RATE;
    else process.env.PYUSD_USD_RATE = originalRate;
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetLedger();

    mockGaslessStatus.mockResolvedValue({ funding_state: 'ready' });
    mockGaslessTransfer.mockResolvedValue({ txHash: '0xabc123' });
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    enqueueRefundMock.mockResolvedValue(undefined);

    // ── Ledger: débito master (7 args, ver a2a-key.ts:1196) ──
    budgetMock.debit.mockImplementation(
      async (
        _keyId: string,
        _chainId: number,
        amountUsd: number,
        _a?: unknown,
        _b?: unknown,
        _dest?: unknown,
        ownerRef?: string,
      ) => {
        if (ownerRef !== OWNER_REF) {
          return { success: false, error: 'OWNERSHIP_MISMATCH' };
        }
        if (ledger.master < amountUsd) {
          return { success: false, error: 'Insufficient budget' };
        }
        ledger.master -= amountUsd;
        return { success: true };
      },
    );

    // ── Ledger: credit master (ownership guard incluido) ──
    budgetMock.credit.mockImplementation(
      async (
        _keyId: string,
        _chainId: number,
        amountUsd: number,
        ownerRef: string,
      ) => {
        if (ownerRef !== OWNER_REF) {
          return { success: false, error: 'OWNERSHIP_MISMATCH' };
        }
        ledger.master += amountUsd;
        return { success: true, reverted: true };
      },
    );

    // ── Ledger: débito/credit DUAL de delegación ──
    delegationDebitMock.mockImplementation(
      async (
        _delegationId: string,
        ownerRef: string,
        _keyId: string,
        _chainId: number,
        amountUsd: number,
      ) => {
        if (ownerRef !== OWNER_REF) throw new Error('OWNERSHIP_MISMATCH');
        ledger.master -= amountUsd;
        ledger.delegationSpent += amountUsd;
        return String(ledger.master);
      },
    );
    budgetMock.creditDelegation.mockImplementation(
      async (
        _delegationId: string,
        ownerRef: string,
        _keyId: string,
        _chainId: number,
        amountUsd: number,
      ) => {
        if (ownerRef !== OWNER_REF) {
          return { success: false, error: 'OWNERSHIP_MISMATCH' };
        }
        ledger.master += amountUsd;
        ledger.delegationSpent -= amountUsd;
        return { success: true, reverted: true };
      },
    );

    // ── Ledger: débito/credit DUAL de key-session ──
    sessionDebitMock.mockImplementation(
      async (
        _sessionId: string,
        ownerRef: string,
        _keyId: string,
        _chainId: number,
        amountUsd: number,
      ) => {
        if (ownerRef !== OWNER_REF) throw new Error('OWNERSHIP_MISMATCH');
        ledger.master -= amountUsd;
        ledger.sessionSpent += amountUsd;
        return String(ledger.master);
      },
    );
    budgetMock.creditSession.mockImplementation(
      async (
        _sessionId: string,
        ownerRef: string,
        _keyId: string,
        _chainId: number,
        amountUsd: number,
      ) => {
        if (ownerRef !== OWNER_REF) {
          return { success: false, error: 'OWNERSHIP_MISMATCH' };
        }
        ledger.master += amountUsd;
        ledger.sessionSpent -= amountUsd;
        return { success: true, reverted: true };
      },
    );

    budgetMock.getBalance.mockImplementation(async () => String(ledger.master));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function post(headers: Record<string, string>) {
    return app.inject({
      method: 'POST',
      url: '/gasless/transfer',
      headers,
      payload: { to: TEST_TO, value: VALUE_WEI },
    });
  }

  // ── T-192-1: 503 gasless_not_operational ──────────────────
  it('T-192-1: 503 gasless_not_operational → el balance del caller vuelve intacto', async () => {
    mockGaslessStatus.mockResolvedValue({ funding_state: 'unfunded' });

    const before = balance();
    expect(before).toBe(100);

    const res = await post({ 'x-a2a-key': TEST_KEY });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('gasless_not_operational');
    // El transfer NUNCA se intentó: cero ambigüedad sobre el valor.
    expect(mockGaslessTransfer).not.toHaveBeenCalled();
    // El débito SÍ ocurrió (el bug era que se quedaba aplicado).
    expect(budgetMock.debit).toHaveBeenCalledTimes(1);
    // AC: balance después === balance antes.
    expect(balance()).toBe(before);
    // Ownership guard: el credit lleva el owner_ref del caller autenticado.
    expect(mockCredit).toHaveBeenCalledWith(
      TEST_KEY_ID,
      CHAIN_ID,
      VALUE_USD,
      OWNER_REF,
    );
    // Anti-doble-refund: exactamente UNA vez, y el balance NO quedó inflado.
    expect(mockCredit).toHaveBeenCalledTimes(1);
    expect(balance()).not.toBeGreaterThan(START_BALANCE);
    // Sin refund dual-ledger en el path master.
    expect(mockCreditDelegation).not.toHaveBeenCalled();
    expect(mockCreditSession).not.toHaveBeenCalled();
  });

  // ── T-192-2: 500 con el valor probadamente quieto ──────────
  it("T-192-2: 500 transfer failed con valueDisposition 'not-moved' → el balance vuelve", async () => {
    mockGaslessTransfer.mockRejectedValue(
      new GaslessTransferError(
        'kite-testnet',
        'sign failed: no operator key',
        'not-moved',
      ),
    );

    const before = balance();
    const res = await post({ 'x-a2a-key': TEST_KEY });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('gasless transfer failed');
    expect(balance()).toBe(before);
    expect(mockCredit).toHaveBeenCalledWith(
      TEST_KEY_ID,
      CHAIN_ID,
      VALUE_USD,
      OWNER_REF,
    );
    expect(mockCredit).toHaveBeenCalledTimes(1);
  });

  // ── T-192-3: 500 con la tx ya en la red (NO refund) ────────
  it("T-192-3: 500 con valueDisposition 'unknown' → NO reembolsa (la tx pudo aterrizar)", async () => {
    mockGaslessTransfer.mockRejectedValue(
      new GaslessTransferError(
        'kite-testnet',
        'receipt timeout (tx 0xfeed)',
        'unknown',
      ),
    );
    const logSpy = vi.spyOn(app.log, 'error');

    const res = await post({ 'x-a2a-key': TEST_KEY });

    expect(res.statusCode).toBe(500);
    // El cobro QUEDA: reembolsar acá regalaría el transfer y el budget.
    expect(balance()).toBe(START_BALANCE - VALUE_USD);
    expect(mockCredit).not.toHaveBeenCalled();
    expect(mockCreditDelegation).not.toHaveBeenCalled();
    expect(mockCreditSession).not.toHaveBeenCalled();
    expect(enqueueRefundMock).not.toHaveBeenCalled();
    // Pero queda señal loud para reconciliar contra la cadena.
    expect(
      logSpy.mock.calls.some(
        (call) => call[1] === 'gasless.refund-skipped.settlement-unknown',
      ),
    ).toBe(true);
  });

  // ── T-192-4: status() tira (antes: 500 silencioso ya cobrado) ──
  it('T-192-4: status() tira → sigue siendo 500 pero el balance vuelve', async () => {
    mockGaslessStatus.mockRejectedValue(new Error('rpc down'));

    const before = balance();
    const res = await post({ 'x-a2a-key': TEST_KEY });

    expect(res.statusCode).toBe(500);
    expect(mockGaslessTransfer).not.toHaveBeenCalled();
    expect(balance()).toBe(before);
    expect(mockCredit).toHaveBeenCalledWith(
      TEST_KEY_ID,
      CHAIN_ID,
      VALUE_USD,
      OWNER_REF,
    );
  });

  // ── T-192-5: invariante del happy path ────────────────────
  it('T-192-5: happy path → cobra EXACTAMENTE lo mismo que antes del fix, sin refund', async () => {
    const res = await post({ 'x-a2a-key': TEST_KEY });

    expect(res.statusCode).toBe(200);
    expect(res.json().txHash).toBe('0xabc123');
    expect(balance()).toBe(START_BALANCE - VALUE_USD);
    expect(mockCredit).not.toHaveBeenCalled();
    expect(mockCreditDelegation).not.toHaveBeenCalled();
    expect(mockCreditSession).not.toHaveBeenCalled();
    expect(enqueueRefundMock).not.toHaveBeenCalled();
  });

  // ── T-192-6: error no clasificado → fail-safe ─────────────
  it('T-192-6: error NO clasificado (Error crudo) → NO reembolsa (fail-safe, nunca infla)', async () => {
    mockGaslessTransfer.mockRejectedValue(new Error('boom'));

    const res = await post({ 'x-a2a-key': TEST_KEY });

    expect(res.statusCode).toBe(500);
    expect(balance()).toBe(START_BALANCE - VALUE_USD);
    expect(mockCredit).not.toHaveBeenCalled();
  });

  // ── T-192-7: delegación → refund DUAL-LEDGER ──────────────
  it('T-192-7: bajo delegación el refund es DUAL-LEDGER (padre + total_spent), no sólo el padre', async () => {
    mockGaslessStatus.mockResolvedValue({ funding_state: 'unfunded' });
    mockDelegationLookup.mockResolvedValue(makeDelegationRow());
    mockDelegationParent.mockResolvedValue(makeKeyRow());

    const before = balance();
    const res = await post({ authorization: `Bearer ${DELEGATION_TOKEN}` });

    expect(res.statusCode).toBe(503);
    expect(delegationDebitMock).toHaveBeenCalledTimes(1);
    // Las DOS patas del débito vuelven (sin esto la credencial se auto-DoSea).
    expect(balance()).toBe(before);
    expect(ledger.delegationSpent).toBe(0);
    expect(mockCreditDelegation).toHaveBeenCalledWith(
      'del-1',
      OWNER_REF,
      TEST_KEY_ID,
      CHAIN_ID,
      VALUE_USD,
    );
    // NO se reembolsa por el ledger del padre solamente.
    expect(mockCredit).not.toHaveBeenCalled();
  });

  // ── T-192-8: key-session → refund DUAL-LEDGER ─────────────
  it('T-192-8: bajo key-session el refund es DUAL-LEDGER (padre + spent_usd)', async () => {
    mockGaslessStatus.mockResolvedValue({ funding_state: 'unfunded' });
    mockSessionLookup.mockResolvedValue(makeKeySessionRow());
    mockSessionParent.mockResolvedValue(makeKeyRow());

    const before = balance();
    const res = await post({ authorization: `Bearer ${SESSION_TOKEN}` });

    expect(res.statusCode).toBe(503);
    expect(sessionDebitMock).toHaveBeenCalledTimes(1);
    expect(balance()).toBe(before);
    expect(ledger.sessionSpent).toBe(0);
    expect(mockCreditSession).toHaveBeenCalledWith(
      'sess-1',
      OWNER_REF,
      TEST_KEY_ID,
      CHAIN_ID,
      VALUE_USD,
    );
    expect(mockCredit).not.toHaveBeenCalled();
  });

  // ── T-192-9: el credit no revierte nada → señal, no silencio ──
  it('T-192-9: credit success:false → 503 igual + entry en el outbox (nunca silencio)', async () => {
    mockGaslessStatus.mockResolvedValue({ funding_state: 'unfunded' });
    budgetMock.credit.mockResolvedValue({
      success: false,
      error: 'REFUND_NOT_REVERTED',
      reverted: false,
    });

    const res = await post({ 'x-a2a-key': TEST_KEY });

    expect(res.statusCode).toBe(503);
    // Nada se revirtió → el balance sigue debitado y el outbox lo va a reintentar.
    expect(balance()).toBe(START_BALANCE - VALUE_USD);
    expect(enqueueRefundMock).toHaveBeenCalledWith({
      keyId: TEST_KEY_ID,
      chainId: CHAIN_ID,
      amountUsd: VALUE_USD,
      ownerRef: OWNER_REF,
      destination: null,
      reason: 'gasless-route.refund-failed:not-operational',
    });
    // Un solo intento de credit: el outbox NO se encola además del credit OK.
    expect(mockCredit).toHaveBeenCalledTimes(1);
    expect(enqueueRefundMock).toHaveBeenCalledTimes(1);
  });

  // ── T-192-10: el credit tira → señal, y el response no se rompe ──
  it('T-192-10: credit tira → 503 igual (best-effort) + entry en el outbox', async () => {
    mockGaslessStatus.mockResolvedValue({ funding_state: 'unfunded' });
    budgetMock.credit.mockRejectedValue(new Error('pg down'));

    const res = await post({ 'x-a2a-key': TEST_KEY });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('gasless_not_operational');
    expect(balance()).toBe(START_BALANCE - VALUE_USD);
    expect(enqueueRefundMock).toHaveBeenCalledWith({
      keyId: TEST_KEY_ID,
      chainId: CHAIN_ID,
      amountUsd: VALUE_USD,
      ownerRef: OWNER_REF,
      destination: null,
      reason: 'gasless-route.refund-threw:not-operational',
    });
  });

  // ── T-192-11: credit tira Y el outbox tira → el response NO se rompe ──
  it('T-192-11: credit tira y el outbox también → 503 igual, el fallo del refund nunca rompe el response', async () => {
    mockGaslessStatus.mockResolvedValue({ funding_state: 'unfunded' });
    budgetMock.credit.mockRejectedValue(new Error('pg down'));
    enqueueRefundMock.mockRejectedValue(new Error('outbox table missing'));
    const logSpy = vi.spyOn(app.log, 'error');

    const res = await post({ 'x-a2a-key': TEST_KEY });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('gasless_not_operational');
    expect(
      logSpy.mock.calls.some(
        (call) => call[1] === '[gasless.refund-outbox-threw]',
      ),
    ).toBe(true);
  });
});

// ── Invariante anti-refund-fantasma ────────────────────────
// Si el middleware NO debitó (rutas que marcan `skipMiddlewareDebit`, hoy
// `/orchestrate*`), el handler NO puede acreditar nada: sería inflar el budget
// del caller inventando un débito que nunca ocurrió. El hook de instancia corre
// ANTES de los preHandlers de la ruta, así que reproduce exactamente ese orden.
describe('POST /gasless/transfer — sin débito no hay refund (HU-192)', () => {
  let app: ReturnType<typeof Fastify>;
  let originalCap: string | undefined;
  let originalRate: string | undefined;

  beforeAll(async () => {
    originalCap = process.env.GASLESS_DEFAULT_CAP_USD;
    originalRate = process.env.PYUSD_USD_RATE;
    process.env.GASLESS_DEFAULT_CAP_USD = '10';
    process.env.PYUSD_USD_RATE = '1.0';

    app = Fastify();
    app.addHook('preHandler', async (req: FastifyRequest) => {
      req.skipMiddlewareDebit = true;
    });
    await app.register(gaslessRoutes, { prefix: '/gasless' });
    await app.ready();
  });

  afterAll(async () => {
    if (originalCap === undefined) delete process.env.GASLESS_DEFAULT_CAP_USD;
    else process.env.GASLESS_DEFAULT_CAP_USD = originalCap;
    if (originalRate === undefined) delete process.env.PYUSD_USD_RATE;
    else process.env.PYUSD_USD_RATE = originalRate;
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetLedger();
    mockGaslessStatus.mockResolvedValue({ funding_state: 'unfunded' });
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    budgetMock.getBalance.mockImplementation(async () => String(ledger.master));
  });

  it('T-192-12: skipMiddlewareDebit → 503 sin débito y SIN credit (no infla el budget)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/gasless/transfer',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: { to: TEST_TO, value: VALUE_WEI },
    });

    expect(res.statusCode).toBe(503);
    expect(budgetMock.debit).not.toHaveBeenCalled();
    expect(budgetMock.credit).not.toHaveBeenCalled();
    expect(budgetMock.creditDelegation).not.toHaveBeenCalled();
    expect(budgetMock.creditSession).not.toHaveBeenCalled();
    expect(enqueueRefundMock).not.toHaveBeenCalled();
    expect(balance()).toBe(START_BALANCE);
  });
});
