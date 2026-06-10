/**
 * Auth Routes Integration Tests — WKH-34
 * Tests: AC-13 (agent-signup), AC-14 (deposit), AC-15 (me), AC-16 (bind)
 */

import crypto from 'node:crypto';
import Fastify from 'fastify';
import { privateKeyToAccount } from 'viem/accounts';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { A2AAgentKeyRow } from '../types/index.js';
import authRoutes from './auth.js';

// ── Mock services ───────────────────────────────────────────

vi.mock('../services/identity.js', () => ({
  identityService: {
    createKey: vi.fn(),
    lookupByHash: vi.fn(),
    deactivate: vi.fn(),
    bindFundingWallet: vi.fn(),
    bindErc8004Identity: vi.fn(),
    bindPassport: vi.fn(),
    resolveIdentityForAgent: vi.fn(),
  },
  // WKH-100: auth.ts now imports this derived helper (AC-6/DT-17).
  isIdentityVerified: (row: { erc8004_identity?: unknown } | null) =>
    row?.erc8004_identity != null,
}));

vi.mock('../services/budget.js', () => ({
  budgetService: {
    getBalance: vi.fn(),
    debit: vi.fn(),
    registerDeposit: vi.fn(),
  },
}));

// WKH-101 (CD-AB-1): auth.ts now imports delegationService → mock all exports.
vi.mock('../services/delegation.js', () => ({
  delegationService: {
    verifyTypedData: vi.fn(),
    create: vi.fn(),
    lookupByTokenHash: vi.fn(),
    getParentKey: vi.fn(),
    list: vi.fn(),
    revoke: vi.fn(),
    debitDelegationAndParent: vi.fn(),
  },
  exceedsPerTxLimit: vi.fn(),
}));

// CD-8: el mock del verifier exporta `verifyDeposit` completo.
// WKH-DEPOSIT-INFO: los resolvers (treasury/min_confirmations/family) se usan
// REALES en /deposit-info, así que se reexportan vía importActual (no mock).
vi.mock('../adapters/deposit-verifier.js', async () => {
  const actual = await vi.importActual<
    typeof import('../adapters/deposit-verifier.js')
  >('../adapters/deposit-verifier.js');
  return {
    ...actual,
    verifyDeposit: vi.fn(),
  };
});

vi.mock('../adapters/registry.js', () => ({
  getAdaptersBundle: vi.fn(),
  getInitializedChainKeys: vi.fn(() => []),
}));

import { verifyDeposit } from '../adapters/deposit-verifier.js';
import {
  getAdaptersBundle,
  getInitializedChainKeys,
} from '../adapters/registry.js';
import type { AdaptersBundle } from '../adapters/types.js';
import { budgetService } from '../services/budget.js';
import { identityService } from '../services/identity.js';
import {
  DepositAlreadyCreditedError,
  FundingWalletAlreadyBoundError,
  OwnershipMismatchError,
} from '../services/security/errors.js';

const mockCreateKey = vi.mocked(identityService.createKey);
const mockLookupByHash = vi.mocked(identityService.lookupByHash);
const mockBindFundingWallet = vi.mocked(identityService.bindFundingWallet);
const mockBindPassport = vi.mocked(identityService.bindPassport);
const mockVerifyDeposit = vi.mocked(verifyDeposit);
const mockGetAdaptersBundle = vi.mocked(getAdaptersBundle);
const mockGetInitializedChainKeys = vi.mocked(getInitializedChainKeys);
const mockRegisterDeposit = vi.mocked(budgetService.registerDeposit);

// WKH-35 FIX-1: bound funding wallet + matching depositor (Transfer.from).
const FUNDING_WALLET = '0x1111111111111111111111111111111111111111';
const DEPOSITOR = FUNDING_WALLET as `0x${string}`;
const OTHER_WALLET =
  '0x2222222222222222222222222222222222222222' as `0x${string}`;
// WKH-117: dirección de Kite Agent Passport para los tests de /bind-passport.
const PASSPORT_ADDR = '0x3333333333333333333333333333333333333333';

function makeBundle(chainId: number): AdaptersBundle {
  return {
    payment: {} as unknown as AdaptersBundle['payment'],
    attestation: {} as unknown as AdaptersBundle['attestation'],
    gasless: {} as unknown as AdaptersBundle['gasless'],
    identity: null,
    chainConfig: { name: 'test', chainId, explorerUrl: 'https://x.test' },
  };
}

const VALID_TX = `0x${'a'.repeat(64)}`;

// ── Helpers ─────────────────────────────────────────────────

const TEST_KEY = `wasi_a2a_${'a'.repeat(64)}`;
const TEST_KEY_HASH = crypto
  .createHash('sha256')
  .update(TEST_KEY)
  .digest('hex');
const TEST_KEY_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeKeyRow(overrides: Partial<A2AAgentKeyRow> = {}): A2AAgentKeyRow {
  return {
    id: TEST_KEY_ID,
    owner_ref: 'user-1',
    key_hash: TEST_KEY_HASH,
    display_name: 'Test Key',
    budget: { '2368': '10.000000' },
    daily_limit_usd: '100.000000',
    daily_spent_usd: '5.000000',
    daily_reset_at: '2026-04-07T00:00:00.000Z',
    allowed_registries: ['kite'],
    allowed_agent_slugs: null,
    allowed_categories: null,
    max_spend_per_call_usd: '10.000000',
    is_active: true,
    last_used_at: null,
    created_at: '2026-04-06T12:00:00.000Z',
    updated_at: '2026-04-06T12:00:00.000Z',
    erc8004_identity: null,
    kite_passport: null,
    agentkit_wallet: null,
    funding_wallet: FUNDING_WALLET,
    metadata: {},
    ...overrides,
  };
}

// ── Setup ───────────────────────────────────────────────────

describe('auth routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();
    await app.register(authRoutes, { prefix: '/auth' });
    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── POST /auth/agent-signup (AC-13) ───────────────────────

  it('POST /auth/agent-signup with valid body returns 201 + key + key_id', async () => {
    mockCreateKey.mockResolvedValue({
      key: TEST_KEY,
      key_id: TEST_KEY_ID,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/agent-signup',
      payload: { owner_ref: 'user-1', display_name: 'My Agent' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.key).toBe(TEST_KEY);
    expect(body.key_id).toBe(TEST_KEY_ID);
  });

  it('POST /auth/agent-signup missing owner_ref returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/agent-signup',
      payload: { display_name: 'No Owner' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('owner_ref');
  });

  it('POST /auth/agent-signup empty owner_ref returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/agent-signup',
      payload: { owner_ref: '  ' },
    });

    expect(res.statusCode).toBe(400);
  });

  // ── POST /auth/deposit (AC-14, WKH-35 — real on-chain verified deposit) ──

  // T13 — happy path → 200 + { balance, chain_id }. AC-1.
  it('POST /auth/deposit happy path returns 200 + {balance, chain_id} (AC-1)', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockGetAdaptersBundle.mockReturnValue(makeBundle(2368));
    mockVerifyDeposit.mockResolvedValue({
      ok: true,
      amountUsd: '10',
      tokenSymbol: 'PYUSD',
      from: DEPOSITOR,
    });
    mockRegisterDeposit.mockResolvedValue('10.000000');

    const res = await app.inject({
      method: 'POST',
      url: '/auth/deposit',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {
        key_id: TEST_KEY_ID,
        chain_id: 2368,
        token: 'PYUSD',
        amount: '10.00',
        tx_hash: VALID_TX,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.balance).toBe('10.000000');
    expect(body.chain_id).toBe(2368);
    // CD-4/CD-5: credits the bundle chainId + on-chain amountUsd, not body.amount.
    expect(mockRegisterDeposit).toHaveBeenCalledWith(
      TEST_KEY_ID,
      2368,
      '10',
      'user-1',
      VALID_TX,
      'PYUSD',
    );
  });

  // T14 — verify fail → 4xx + registerDeposit NOT called (CD-4). AC-2.
  it('POST /auth/deposit verify fail → 400 and registerDeposit NOT called (AC-2, CD-4)', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockGetAdaptersBundle.mockReturnValue(makeBundle(2368));
    mockVerifyDeposit.mockResolvedValue({ ok: false, reason: 'TX_REVERTED' });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/deposit',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {
        key_id: TEST_KEY_ID,
        chain_id: 2368,
        token: 'PYUSD',
        amount: '10.00',
        tx_hash: VALID_TX,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('TX_REVERTED');
    expect(mockRegisterDeposit).not.toHaveBeenCalled();
  });

  it('POST /auth/deposit RPC down → 503 RPC_UNAVAILABLE (AC-2)', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockGetAdaptersBundle.mockReturnValue(makeBundle(2368));
    mockVerifyDeposit.mockResolvedValue({
      ok: false,
      reason: 'RPC_UNAVAILABLE',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/deposit',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {
        key_id: TEST_KEY_ID,
        chain_id: 2368,
        token: 'PYUSD',
        amount: '10.00',
        tx_hash: VALID_TX,
      },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error_code).toBe('RPC_UNAVAILABLE');
    expect(mockRegisterDeposit).not.toHaveBeenCalled();
  });

  // T15 — replay → 409 DEPOSIT_ALREADY_CREDITED. AC-3.
  it('POST /auth/deposit replay → 409 DEPOSIT_ALREADY_CREDITED (AC-3)', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockGetAdaptersBundle.mockReturnValue(makeBundle(2368));
    mockVerifyDeposit.mockResolvedValue({
      ok: true,
      amountUsd: '10',
      tokenSymbol: 'PYUSD',
      from: DEPOSITOR,
    });
    mockRegisterDeposit.mockRejectedValue(new DepositAlreadyCreditedError());

    const res = await app.inject({
      method: 'POST',
      url: '/auth/deposit',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {
        key_id: TEST_KEY_ID,
        chain_id: 2368,
        token: 'PYUSD',
        amount: '10.00',
        tx_hash: VALID_TX,
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error_code).toBe('DEPOSIT_ALREADY_CREDITED');
  });

  // T16 — body.chain_id != bundle.chainId → 400 CHAIN_MISMATCH. AC-4.
  it('POST /auth/deposit body.chain_id != bundle.chainId → 400 CHAIN_MISMATCH (AC-4)', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    // header forces base-sepolia chainKey; bundle reports chainId 84532,
    // but body.chain_id is 43113 → mismatch.
    mockGetAdaptersBundle.mockReturnValue(makeBundle(84532));

    const res = await app.inject({
      method: 'POST',
      url: '/auth/deposit',
      headers: { 'x-a2a-key': TEST_KEY, 'x-payment-chain': 'base-sepolia' },
      payload: {
        key_id: TEST_KEY_ID,
        chain_id: 43113,
        token: 'USDC',
        amount: '10.00',
        tx_hash: VALID_TX,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('CHAIN_MISMATCH');
    expect(mockVerifyDeposit).not.toHaveBeenCalled();
  });

  // T17 — key of another owner → 403 ownership. AC-5.
  it('POST /auth/deposit body.key_id != callerKey.id → 403 OWNERSHIP_MISMATCH (pre-check, AC-5)', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());

    const res = await app.inject({
      method: 'POST',
      url: '/auth/deposit',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {
        key_id: 'ffffffff-0000-0000-0000-000000000000',
        chain_id: 2368,
        token: 'PYUSD',
        amount: '10.00',
        tx_hash: VALID_TX,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('OWNERSHIP_MISMATCH');
    expect(mockVerifyDeposit).not.toHaveBeenCalled();
  });

  it('POST /auth/deposit DB-level ownership mismatch → 403 OWNERSHIP_MISMATCH (AC-5)', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockGetAdaptersBundle.mockReturnValue(makeBundle(2368));
    mockVerifyDeposit.mockResolvedValue({
      ok: true,
      amountUsd: '10',
      tokenSymbol: 'PYUSD',
      from: DEPOSITOR,
    });
    mockRegisterDeposit.mockRejectedValue(new OwnershipMismatchError());

    const res = await app.inject({
      method: 'POST',
      url: '/auth/deposit',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {
        key_id: TEST_KEY_ID,
        chain_id: 2368,
        token: 'PYUSD',
        amount: '10.00',
        tx_hash: VALID_TX,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('OWNERSHIP_MISMATCH');
  });

  // T18 — chain not initialized → 400 CHAIN_NOT_SUPPORTED. AC-6.
  it('POST /auth/deposit uninitialized chain → 400 CHAIN_NOT_SUPPORTED (AC-6)', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockGetAdaptersBundle.mockReturnValue(undefined);

    const res = await app.inject({
      method: 'POST',
      url: '/auth/deposit',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {
        key_id: TEST_KEY_ID,
        chain_id: 2368,
        token: 'PYUSD',
        amount: '10.00',
        tx_hash: VALID_TX,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('CHAIN_NOT_SUPPORTED');
    expect(mockVerifyDeposit).not.toHaveBeenCalled();
  });

  it('POST /auth/deposit invalid input → 400 INVALID_INPUT', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());

    const res = await app.inject({
      method: 'POST',
      url: '/auth/deposit',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {
        key_id: TEST_KEY_ID,
        chain_id: 2368,
        token: 'PYUSD',
        amount: '10.00',
        tx_hash: '0xbad',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('INVALID_INPUT');
  });

  // T19 — no auth → 403. AC-1.
  it('POST /auth/deposit without auth → 403 (AC-1)', async () => {
    mockLookupByHash.mockResolvedValue(null);

    const res = await app.inject({
      method: 'POST',
      url: '/auth/deposit',
      payload: {
        key_id: TEST_KEY_ID,
        chain_id: 2368,
        token: 'PYUSD',
        amount: '10.00',
        tx_hash: VALID_TX,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(mockVerifyDeposit).not.toHaveBeenCalled();
  });

  // ── POST /auth/funding-wallet (WKH-35 FIX-1 — bind with proof of control) ──

  // Account that signs the canonical bind message. Its address is the wallet.
  const BIND_PK = `0x${'1'.repeat(64)}` as `0x${string}`;
  const bindAccount = privateKeyToAccount(BIND_PK);
  const BIND_WALLET = bindAccount.address;

  async function signBind(keyId: string): Promise<`0x${string}`> {
    return bindAccount.signMessage({
      message: `WASIAI_BIND_FUNDING_WALLET:${keyId}`,
    });
  }

  it('POST /auth/funding-wallet valid signature → 200 + {funding_wallet}', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockBindFundingWallet.mockResolvedValue(BIND_WALLET.toLowerCase());
    const signature = await signBind(TEST_KEY_ID);

    const res = await app.inject({
      method: 'POST',
      url: '/auth/funding-wallet',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: { wallet: BIND_WALLET, signature },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().funding_wallet).toBe(BIND_WALLET.toLowerCase());
    // Ownership Guard: bind con id + owner_ref del caller autenticado.
    expect(mockBindFundingWallet).toHaveBeenCalledWith(
      TEST_KEY_ID,
      'user-1',
      BIND_WALLET,
    );
  });

  it('POST /auth/funding-wallet signature of another wallet → 403 PROOF_INVALID', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    // Firma válida del wallet del BIND_PK, pero el body declara OTRO wallet.
    const signature = await signBind(TEST_KEY_ID);

    const res = await app.inject({
      method: 'POST',
      url: '/auth/funding-wallet',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: { wallet: OTHER_WALLET, signature },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('FUNDING_WALLET_PROOF_INVALID');
    expect(mockBindFundingWallet).not.toHaveBeenCalled();
  });

  it('POST /auth/funding-wallet signature over wrong key_id → 403 PROOF_INVALID', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    // Firma para OTRO key_id: el mensaje canónico no coincide con el del caller.
    const signature = await signBind('ffffffff-0000-0000-0000-000000000000');

    const res = await app.inject({
      method: 'POST',
      url: '/auth/funding-wallet',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: { wallet: BIND_WALLET, signature },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('FUNDING_WALLET_PROOF_INVALID');
    expect(mockBindFundingWallet).not.toHaveBeenCalled();
  });

  it('POST /auth/funding-wallet without auth → 403', async () => {
    mockLookupByHash.mockResolvedValue(null);
    const signature = await signBind(TEST_KEY_ID);

    const res = await app.inject({
      method: 'POST',
      url: '/auth/funding-wallet',
      payload: { wallet: BIND_WALLET, signature },
    });

    expect(res.statusCode).toBe(403);
    expect(mockBindFundingWallet).not.toHaveBeenCalled();
  });

  it('POST /auth/funding-wallet wallet already bound → 409 ALREADY_BOUND', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockBindFundingWallet.mockRejectedValue(
      new FundingWalletAlreadyBoundError(),
    );
    const signature = await signBind(TEST_KEY_ID);

    const res = await app.inject({
      method: 'POST',
      url: '/auth/funding-wallet',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: { wallet: BIND_WALLET, signature },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error_code).toBe('FUNDING_WALLET_ALREADY_BOUND');
  });

  it('POST /auth/funding-wallet DB-level ownership mismatch → 403 OWNERSHIP_MISMATCH', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockBindFundingWallet.mockRejectedValue(new OwnershipMismatchError());
    const signature = await signBind(TEST_KEY_ID);

    const res = await app.inject({
      method: 'POST',
      url: '/auth/funding-wallet',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: { wallet: BIND_WALLET, signature },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('OWNERSHIP_MISMATCH');
  });

  it('POST /auth/funding-wallet invalid input (bad wallet) → 400 INVALID_INPUT', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());

    const res = await app.inject({
      method: 'POST',
      url: '/auth/funding-wallet',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: { wallet: '0xnotanaddress', signature: '0xabc' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('INVALID_INPUT');
    expect(mockBindFundingWallet).not.toHaveBeenCalled();
  });

  // ── POST /auth/deposit funding-wallet gate (WKH-35 FIX-1 — hijack closed) ──

  it('POST /auth/deposit key without funding_wallet → 403 FUNDING_WALLET_NOT_BOUND (FIX-1)', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow({ funding_wallet: null }));
    mockGetAdaptersBundle.mockReturnValue(makeBundle(2368));
    mockVerifyDeposit.mockResolvedValue({
      ok: true,
      amountUsd: '10',
      tokenSymbol: 'PYUSD',
      from: DEPOSITOR,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/deposit',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {
        key_id: TEST_KEY_ID,
        chain_id: 2368,
        token: 'PYUSD',
        amount: '10.00',
        tx_hash: VALID_TX,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('FUNDING_WALLET_NOT_BOUND');
    expect(mockRegisterDeposit).not.toHaveBeenCalled();
  });

  it('POST /auth/deposit Transfer.from != funding_wallet → 403 FUNDING_WALLET_MISMATCH (FIX-1 hijack)', async () => {
    // funding_wallet bound = FUNDING_WALLET; depositor on-chain = OTHER_WALLET.
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockGetAdaptersBundle.mockReturnValue(makeBundle(2368));
    mockVerifyDeposit.mockResolvedValue({
      ok: true,
      amountUsd: '10',
      tokenSymbol: 'PYUSD',
      from: OTHER_WALLET,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/deposit',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {
        key_id: TEST_KEY_ID,
        chain_id: 2368,
        token: 'PYUSD',
        amount: '10.00',
        tx_hash: VALID_TX,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('FUNDING_WALLET_MISMATCH');
    expect(mockRegisterDeposit).not.toHaveBeenCalled();
  });

  it('POST /auth/deposit Transfer.from == funding_wallet → 200 credits (FIX-1)', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockGetAdaptersBundle.mockReturnValue(makeBundle(2368));
    mockVerifyDeposit.mockResolvedValue({
      ok: true,
      amountUsd: '10',
      tokenSymbol: 'PYUSD',
      from: DEPOSITOR,
    });
    mockRegisterDeposit.mockResolvedValue('10.000000');

    const res = await app.inject({
      method: 'POST',
      url: '/auth/deposit',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {
        key_id: TEST_KEY_ID,
        chain_id: 2368,
        token: 'PYUSD',
        amount: '10.00',
        tx_hash: VALID_TX,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().balance).toBe('10.000000');
    expect(mockRegisterDeposit).toHaveBeenCalled();
  });

  // FIX-4 — deposit without body.amount → 200, credits on-chain amount.
  it('POST /auth/deposit without body.amount → 200 credits on-chain amount (FIX-4)', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockGetAdaptersBundle.mockReturnValue(makeBundle(2368));
    mockVerifyDeposit.mockResolvedValue({
      ok: true,
      amountUsd: '7.5',
      tokenSymbol: 'PYUSD',
      from: DEPOSITOR,
    });
    mockRegisterDeposit.mockResolvedValue('7.500000');

    const res = await app.inject({
      method: 'POST',
      url: '/auth/deposit',
      headers: { 'x-a2a-key': TEST_KEY },
      // body.amount OMITIDO: el on-chain es la fuente de verdad; `amount` es opcional.
      payload: {
        key_id: TEST_KEY_ID,
        chain_id: 2368,
        token: 'PYUSD',
        tx_hash: VALID_TX,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().balance).toBe('7.500000');
    // El crédito usa el amountUsd derivado on-chain (7.5), no body.amount.
    expect(mockRegisterDeposit).toHaveBeenCalledWith(
      TEST_KEY_ID,
      2368,
      '7.5',
      'user-1',
      VALID_TX,
      'PYUSD',
    );
  });

  // ── GET /auth/me (AC-15) ──────────────────────────────────

  it('GET /auth/me with valid key returns 200 + full status object', async () => {
    const keyRow = makeKeyRow();
    mockLookupByHash.mockResolvedValue(keyRow);

    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { 'x-a2a-key': TEST_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.key_id).toBe(TEST_KEY_ID);
    expect(body.display_name).toBe('Test Key');
    expect(body.budget).toEqual({ '2368': '10.000000' });
    expect(body.daily_limit_usd).toBe('100.000000');
    expect(body.daily_spent_usd).toBe('5.000000');
    expect(body.scoping.allowed_registries).toEqual(['kite']);
    expect(body.scoping.max_spend_per_call_usd).toBe('10.000000');
    expect(body.is_active).toBe(true);
    expect(body.bindings).toEqual({
      erc8004_identity: null,
      kite_passport: null,
      agentkit_wallet: null,
    });
    expect(body.created_at).toBe('2026-04-06T12:00:00.000Z');
  });

  it('GET /auth/me with invalid key returns 403', async () => {
    mockLookupByHash.mockResolvedValue(null);

    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { 'x-a2a-key': 'wasi_a2a_bad' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('GET /auth/me with inactive key returns 403', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow({ is_active: false }));

    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { 'x-a2a-key': TEST_KEY },
    });

    expect(res.statusCode).toBe(403);
  });

  // ── GET /auth/me with Bearer auth (WKH-BEARER-FIX AC-4, AC-5) ──

  it('GET /auth/me with Authorization: Bearer wasi_a2a_* returns 200 (AC-4)', async () => {
    const keyRow = makeKeyRow();
    mockLookupByHash.mockResolvedValue(keyRow);

    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.key_id).toBe(TEST_KEY_ID);
  });

  it('GET /auth/me with Authorization: Bearer non_wasi_token returns 403 (AC-5)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: 'Bearer non_wasi_token_abc123' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('GET /auth/me with both x-a2a-key and Bearer prefers x-a2a-key (AC-2)', async () => {
    const keyRow = makeKeyRow();
    mockLookupByHash.mockResolvedValue(keyRow);

    const otherKey = `wasi_a2a_${'b'.repeat(64)}`;

    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: {
        'x-a2a-key': TEST_KEY,
        authorization: `Bearer ${otherKey}`,
      },
    });

    expect(res.statusCode).toBe(200);
    // Verify lookupByHash was called with the hash of TEST_KEY (x-a2a-key), not otherKey
    expect(mockLookupByHash).toHaveBeenCalledWith(TEST_KEY_HASH);
  });

  // ── GET /auth/deposit-info (WKH-DEPOSIT-INFO) ─────────────

  // Bundle for avalanche-fuji with a single USDC token (decimals 6).
  function makeDepositInfoBundle(): AdaptersBundle {
    const bundle = makeBundle(43113);
    return {
      ...bundle,
      payment: {
        supportedTokens: [
          {
            symbol: 'USDC',
            address: '0x5425890298aed601595a70AB815c96711a31Bc65',
            decimals: 6,
          },
        ],
      } as unknown as AdaptersBundle['payment'],
    };
  }

  const FUJI_TREASURY = '0x9999999999999999999999999999999999999999';

  it('GET /auth/deposit-info → 200 with one entry per initialized chain (AC-1, AC-2)', async () => {
    process.env.A2A_DEPOSIT_TREASURY_AVALANCHE = FUJI_TREASURY;
    process.env.A2A_DEPOSIT_MIN_CONFIRMATIONS_AVALANCHE = '3';
    mockGetInitializedChainKeys.mockReturnValue(['avalanche-fuji']);
    mockGetAdaptersBundle.mockReturnValue(makeDepositInfoBundle());

    const res = await app.inject({ method: 'GET', url: '/auth/deposit-info' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.networks)).toBe(true);
    expect(body.networks).toHaveLength(1);
    const entry = body.networks[0];
    expect(entry.chain_id).toBe(43113);
    expect(entry.slug).toBe('avalanche-fuji');
    expect(entry.family).toBe('AVALANCHE');
    expect(entry.treasury).toBe(FUJI_TREASURY);
    expect(entry.token).toEqual({
      symbol: 'USDC',
      address: '0x5425890298aed601595a70AB815c96711a31Bc65',
      decimals: 6,
    });
    expect(entry.min_confirmations).toBe(3);

    delete process.env.A2A_DEPOSIT_TREASURY_AVALANCHE;
    delete process.env.A2A_DEPOSIT_MIN_CONFIRMATIONS_AVALANCHE;
  });

  it('GET /auth/deposit-info with zero initialized chains → 200 { networks: [] } (AC-3)', async () => {
    mockGetInitializedChainKeys.mockReturnValue([]);

    const res = await app.inject({ method: 'GET', url: '/auth/deposit-info' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ networks: [] });
  });

  it('GET /auth/deposit-info treasury unresolvable → entry with treasury: null (AC-4)', async () => {
    delete process.env.A2A_DEPOSIT_TREASURY_AVALANCHE;
    delete process.env.OPERATOR_PRIVATE_KEY;
    mockGetInitializedChainKeys.mockReturnValue(['avalanche-fuji']);
    mockGetAdaptersBundle.mockReturnValue(makeDepositInfoBundle());

    const res = await app.inject({ method: 'GET', url: '/auth/deposit-info' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.networks).toHaveLength(1);
    expect(body.networks[0].treasury).toBeNull();
  });

  it('GET /auth/deposit-info NEVER exposes secrets (AC-5)', async () => {
    process.env.OPERATOR_PRIVATE_KEY = `0x${'1'.repeat(64)}`;
    process.env.A2A_DEPOSIT_TREASURY_AVALANCHE = FUJI_TREASURY;
    mockGetInitializedChainKeys.mockReturnValue(['avalanche-fuji']);
    mockGetAdaptersBundle.mockReturnValue(makeDepositInfoBundle());

    const res = await app.inject({ method: 'GET', url: '/auth/deposit-info' });

    expect(res.statusCode).toBe(200);
    const raw = res.body; // raw response string
    expect(raw).not.toContain('1'.repeat(64)); // private key material
    expect(raw).not.toContain('OPERATOR_PRIVATE_KEY');
    expect(raw).not.toMatch(/SUPABASE/i);
    expect(raw).not.toMatch(/SECRET/i);
    // "symbol" is allowed (token field); no other KEY-like leak.
    expect(raw).not.toMatch(/private[_-]?key/i);

    delete process.env.OPERATOR_PRIVATE_KEY;
    delete process.env.A2A_DEPOSIT_TREASURY_AVALANCHE;
  });

  it('GET /auth/deposit-info requires NO auth header → 200 (public)', async () => {
    mockGetInitializedChainKeys.mockReturnValue([]);

    const res = await app.inject({ method: 'GET', url: '/auth/deposit-info' });

    expect(res.statusCode).toBe(200);
    expect(mockLookupByHash).not.toHaveBeenCalled();
  });

  // ── POST /auth/bind-passport (WKH-117 AC-8 — gate-at-mount) ──

  // PASSPORT_BINDING_ENABLED ausente en el app principal (beforeAll): la ruta
  // NO se monta → 404 (gate-at-mount, DT-8). No exposed surface.
  it('POST /auth/bind-passport when flag absent → 404 (gate-at-mount)', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());

    const res = await app.inject({
      method: 'POST',
      url: '/auth/bind-passport',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: { passportAddress: PASSPORT_ADDR },
    });

    expect(res.statusCode).toBe(404);
    expect(mockBindPassport).not.toHaveBeenCalled();
  });

  // App SEPARADO montado con PASSPORT_BINDING_ENABLED='true' para que la ruta
  // exista (gate-at-mount se evalúa al registrar el plugin).
  describe('with PASSPORT_BINDING_ENABLED=true', () => {
    let passportApp: ReturnType<typeof Fastify>;
    const prevFlag = process.env.PASSPORT_BINDING_ENABLED;

    beforeAll(async () => {
      process.env.PASSPORT_BINDING_ENABLED = 'true';
      passportApp = Fastify();
      await passportApp.register(authRoutes, { prefix: '/auth' });
      await passportApp.ready();
    });

    afterAll(async () => {
      await passportApp.close();
      if (prevFlag === undefined) {
        delete process.env.PASSPORT_BINDING_ENABLED;
      } else {
        process.env.PASSPORT_BINDING_ENABLED = prevFlag;
      }
    });

    it('POST /auth/bind-passport owner caller → 200 + {kite_passport}', async () => {
      mockLookupByHash.mockResolvedValue(makeKeyRow());
      const boundAt = '2026-06-10T00:00:00.000Z';
      mockBindPassport.mockResolvedValue({
        address: PASSPORT_ADDR.toLowerCase(),
        bound_at: boundAt,
      });

      const res = await passportApp.inject({
        method: 'POST',
        url: '/auth/bind-passport',
        headers: { 'x-a2a-key': TEST_KEY },
        payload: { passportAddress: PASSPORT_ADDR },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().kite_passport).toEqual({
        address: PASSPORT_ADDR.toLowerCase(),
        bound_at: boundAt,
      });
      // Ownership Guard: id + owner_ref del caller, NUNCA del body (CD-3).
      expect(mockBindPassport).toHaveBeenCalledWith(
        TEST_KEY_ID,
        'user-1',
        PASSPORT_ADDR,
      );
    });

    it('POST /auth/bind-passport body.keyId != callerKey.id → 403 (defense-in-depth)', async () => {
      mockLookupByHash.mockResolvedValue(makeKeyRow());

      const res = await passportApp.inject({
        method: 'POST',
        url: '/auth/bind-passport',
        headers: { 'x-a2a-key': TEST_KEY },
        payload: {
          passportAddress: PASSPORT_ADDR,
          keyId: 'ffffffff-0000-0000-0000-000000000000',
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error_code).toBe('OWNERSHIP_MISMATCH');
      expect(mockBindPassport).not.toHaveBeenCalled();
    });
  });

  // ── POST /auth/bind/:chain (AC-16) ────────────────────────

  it('POST /auth/bind/:chain returns 501 with not_implemented', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/bind/kite',
    });

    expect(res.statusCode).toBe(501);
    const body = res.json();
    expect(body.status).toBe('not_implemented');
    expect(body.message).toContain('Fase 2');
  });
});
