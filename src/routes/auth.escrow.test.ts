/**
 * POST /auth/deposit — escrow routing integration tests — WKH-126b (W4).
 *
 * Covers AC-3, AC-6, AC-7, AC-8, AC-9, AC-11 + CD-10/CD-11. Mocks ambos verifiers
 * (`verifyDeposit` treasury + `verifyEscrowDeposit` escrow), `budgetService`,
 * `receiptService` y la registry. El flag `ESCROW_MODE_ENABLED` se setea por test
 * (CD-11 estricto). Aserciones sobre status/body y sobre los mocks llamados.
 */

import crypto from 'node:crypto';
import Fastify from 'fastify';
import { keccak256, stringToBytes } from 'viem';
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

vi.mock('../services/receipt.js', () => ({
  receiptService: {
    emit: vi.fn(),
  },
}));

vi.mock('../adapters/deposit-verifier.js', async () => {
  const actual = await vi.importActual<
    typeof import('../adapters/deposit-verifier.js')
  >('../adapters/deposit-verifier.js');
  return {
    ...actual,
    verifyDeposit: vi.fn(),
  };
});

vi.mock('../adapters/escrow-verifier.js', () => ({
  verifyEscrowDeposit: vi.fn(),
  resolveEscrowContract: vi.fn(),
}));

vi.mock('../adapters/registry.js', () => ({
  getAdaptersBundle: vi.fn(),
  getInitializedChainKeys: vi.fn(() => []),
}));

import { verifyDeposit } from '../adapters/deposit-verifier.js';
import {
  resolveEscrowContract,
  verifyEscrowDeposit,
} from '../adapters/escrow-verifier.js';
import { getAdaptersBundle } from '../adapters/registry.js';
import type { AdaptersBundle } from '../adapters/types.js';
import { budgetService } from '../services/budget.js';
import { identityService } from '../services/identity.js';
import { receiptService } from '../services/receipt.js';
import {
  DepositAlreadyCreditedError,
  DepositAmountInvalidError,
  DepositBelowMinimumError,
  DepositMinimumNotConfiguredError,
  OwnershipMismatchError,
} from '../services/security/errors.js';

const mockLookupByHash = vi.mocked(identityService.lookupByHash);
const mockVerifyDeposit = vi.mocked(verifyDeposit);
const mockVerifyEscrowDeposit = vi.mocked(verifyEscrowDeposit);
const mockResolveEscrowContract = vi.mocked(resolveEscrowContract);
const ESCROW_CONTRACT_ADDR =
  '0x3333333333333333333333333333333333333333' as `0x${string}`;
const mockGetAdaptersBundle = vi.mocked(getAdaptersBundle);
const mockRegisterDeposit = vi.mocked(budgetService.registerDeposit);
const mockEmit = vi.mocked(receiptService.emit);

const FUNDING_WALLET = '0x1111111111111111111111111111111111111111';
const DEPOSITOR = FUNDING_WALLET as `0x${string}`;
const OTHER_WALLET =
  '0x2222222222222222222222222222222222222222' as `0x${string}`;

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
const TEST_KEY = `wasi_a2a_${'a'.repeat(64)}`;
const TEST_KEY_HASH = crypto
  .createHash('sha256')
  .update(TEST_KEY)
  .digest('hex');
const TEST_KEY_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const EXPECTED_KEY_ID_HASH = keccak256(stringToBytes(TEST_KEY_ID));

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
    require_signature: false,
    ...overrides,
  };
}

const ORIGINAL_ENV = { ...process.env };

function depositPayload(overrides: Record<string, unknown> = {}) {
  return {
    key_id: TEST_KEY_ID,
    chain_id: 2368,
    token: 'PYUSD',
    amount: '10.00',
    tx_hash: VALID_TX,
    ...overrides,
  };
}

describe('POST /auth/deposit — escrow routing (WKH-126b)', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();
    await app.register(authRoutes, { prefix: '/auth' });
    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.ESCROW_MODE_ENABLED;
    // Default: contrato configurado para la cadena (preserva el routing escrow
    // de los casos WKH-126b cuyo flag está on). Casos WKH-126c que prueban el
    // fallback per-chain sobrescriben este mock con `null`.
    mockResolveEscrowContract.mockReturnValue(ESCROW_CONTRACT_ADDR);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  // ── AC-8 — flag off → treasury path; escrow verifier NOT called ──
  it('ESCROW_MODE_ENABLED unset → uses verifyDeposit (treasury), escrow NOT called (AC-8)', async () => {
    delete process.env.ESCROW_MODE_ENABLED;
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
      payload: depositPayload(),
    });

    expect(res.statusCode).toBe(200);
    expect(mockVerifyDeposit).toHaveBeenCalledTimes(1);
    expect(mockVerifyEscrowDeposit).not.toHaveBeenCalled();
  });

  // ── AC-9 — flag on → escrow path; same response shape/RPC ──
  it("ESCROW_MODE_ENABLED='true' → uses verifyEscrowDeposit, same {balance, chain_id} (AC-9)", async () => {
    process.env.ESCROW_MODE_ENABLED = 'true';
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockGetAdaptersBundle.mockReturnValue(makeBundle(2368));
    mockVerifyEscrowDeposit.mockResolvedValue({
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
      payload: depositPayload(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.balance).toBe('10.000000');
    expect(body.chain_id).toBe(2368);
    expect(mockVerifyEscrowDeposit).toHaveBeenCalledTimes(1);
    expect(mockVerifyDeposit).not.toHaveBeenCalled();
    // CD-8: el handler pasa keyIdHash = keccak256(stringToBytes(callerKey.id)).
    expect(mockVerifyEscrowDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ keyIdHash: EXPECTED_KEY_ID_HASH }),
    );
  });

  // ── AC-3 — replay in escrow mode → 409 ──
  it('escrow mode + DepositAlreadyCreditedError → 409 (AC-3)', async () => {
    process.env.ESCROW_MODE_ENABLED = 'true';
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockGetAdaptersBundle.mockReturnValue(makeBundle(2368));
    mockVerifyEscrowDeposit.mockResolvedValue({
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
      payload: depositPayload(),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error_code).toBe('DEPOSIT_ALREADY_CREDITED');
  });

  // ── AC-6 — escrow from != funding_wallet → 403 ──
  it('escrow mode + from != callerKey.funding_wallet → 403 FUNDING_WALLET_MISMATCH (AC-6)', async () => {
    process.env.ESCROW_MODE_ENABLED = 'true';
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockGetAdaptersBundle.mockReturnValue(makeBundle(2368));
    mockVerifyEscrowDeposit.mockResolvedValue({
      ok: true,
      amountUsd: '10',
      tokenSymbol: 'PYUSD',
      from: OTHER_WALLET,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/deposit',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: depositPayload(),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('FUNDING_WALLET_MISMATCH');
    expect(mockRegisterDeposit).not.toHaveBeenCalled();
  });

  // ── AC-7 — registerDeposit called with owner_ref; OwnershipMismatch → 403 ──
  it('escrow mode → registerDeposit gets callerKey.owner_ref as 4th arg (AC-7/CD-4)', async () => {
    process.env.ESCROW_MODE_ENABLED = 'true';
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockGetAdaptersBundle.mockReturnValue(makeBundle(2368));
    mockVerifyEscrowDeposit.mockResolvedValue({
      ok: true,
      amountUsd: '10',
      tokenSymbol: 'PYUSD',
      from: DEPOSITOR,
    });
    mockRegisterDeposit.mockResolvedValue('10.000000');

    await app.inject({
      method: 'POST',
      url: '/auth/deposit',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: depositPayload(),
    });

    expect(mockRegisterDeposit).toHaveBeenCalledWith(
      TEST_KEY_ID,
      2368,
      '10',
      'user-1', // callerKey.owner_ref (4th arg)
      VALID_TX,
      'PYUSD',
    );
  });

  it('escrow mode + OwnershipMismatchError → 403 OWNERSHIP_MISMATCH (AC-7)', async () => {
    process.env.ESCROW_MODE_ENABLED = 'true';
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockGetAdaptersBundle.mockReturnValue(makeBundle(2368));
    mockVerifyEscrowDeposit.mockResolvedValue({
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
      payload: depositPayload(),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('OWNERSHIP_MISMATCH');
  });

  // ── Minimo de deposito, superficie HTTP de la rama EVM ────────────────────
  //
  // El guard vive en `budgetService.registerDeposit` (unico acreditador). Aca se
  // prueba SOLO que su error llega al caller con un codigo PROPIO y no colapsado
  // dentro del 500 `DEPOSIT_FAILED` generico. La familia Solana tiene el mismo par
  // de casos en `auth.solana-deposit.test.ts`.
  it('EVM: por debajo del minimo → 400 DEPOSIT_BELOW_MINIMUM + minimum_usdc, NO 500 DEPOSIT_FAILED', async () => {
    delete process.env.ESCROW_MODE_ENABLED;
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockGetAdaptersBundle.mockReturnValue(makeBundle(2368));
    mockVerifyDeposit.mockResolvedValue({
      ok: true,
      amountUsd: '0.000001',
      tokenSymbol: 'PYUSD',
      from: DEPOSITOR,
    });
    mockRegisterDeposit.mockRejectedValue(new DepositBelowMinimumError('1'));

    const res = await app.inject({
      method: 'POST',
      url: '/auth/deposit',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: depositPayload({ amount: '0.000001' }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error_code: 'DEPOSIT_BELOW_MINIMUM',
      minimum_usdc: '1',
    });
    // El mensaje lleva el minimo y NADA mas: ni saldo, ni datos del depositante.
    expect(JSON.stringify(res.json())).not.toContain(DEPOSITOR);
    expect(JSON.stringify(res.json())).not.toContain('balance');
  });

  it('EVM: minimo sin configurar → 503 DEPOSIT_MINIMUM_NOT_CONFIGURED (no 400, no DEPOSIT_FAILED)', async () => {
    delete process.env.ESCROW_MODE_ENABLED;
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockGetAdaptersBundle.mockReturnValue(makeBundle(2368));
    mockVerifyDeposit.mockResolvedValue({
      ok: true,
      amountUsd: '10',
      tokenSymbol: 'PYUSD',
      from: DEPOSITOR,
    });
    mockRegisterDeposit.mockRejectedValue(
      new DepositMinimumNotConfiguredError(),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/auth/deposit',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: depositPayload(),
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error_code).toBe('DEPOSIT_MINIMUM_NOT_CONFIGURED');
  });

  it('EVM: monto verificado ilegible → 500 DEPOSIT_AMOUNT_INVALID, distinguible del DEPOSIT_FAILED generico', async () => {
    delete process.env.ESCROW_MODE_ENABLED;
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockGetAdaptersBundle.mockReturnValue(makeBundle(2368));
    mockVerifyDeposit.mockResolvedValue({
      ok: true,
      amountUsd: '10',
      tokenSymbol: 'PYUSD',
      from: DEPOSITOR,
    });
    mockRegisterDeposit.mockRejectedValue(new DepositAmountInvalidError());

    const res = await app.inject({
      method: 'POST',
      url: '/auth/deposit',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: depositPayload(),
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error_code).toBe('DEPOSIT_AMOUNT_INVALID');
    expect(res.json().error_code).not.toBe('DEPOSIT_FAILED');
  });

  // ── AC-11 — receipt deposit_verified emitted; emit throw doesn't break 200 ──
  it("escrow success → receiptService.emit('deposit_verified', txHash) (AC-11)", async () => {
    process.env.ESCROW_MODE_ENABLED = 'true';
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockGetAdaptersBundle.mockReturnValue(makeBundle(2368));
    mockVerifyEscrowDeposit.mockResolvedValue({
      ok: true,
      amountUsd: '10',
      tokenSymbol: 'PYUSD',
      from: DEPOSITOR,
    });
    mockRegisterDeposit.mockResolvedValue('10.000000');
    mockEmit.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'POST',
      url: '/auth/deposit',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: depositPayload(),
    });

    expect(res.statusCode).toBe(200);
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        receiptType: 'deposit_verified',
        txHash: VALID_TX,
        agentKeyId: TEST_KEY_ID,
        ownerRef: 'user-1',
        amountUsd: '10',
        chainId: 2368,
      }),
    );
  });

  it('emit throwing does NOT break the 200 response (AC-11, best-effort)', async () => {
    process.env.ESCROW_MODE_ENABLED = 'true';
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockGetAdaptersBundle.mockReturnValue(makeBundle(2368));
    mockVerifyEscrowDeposit.mockResolvedValue({
      ok: true,
      amountUsd: '10',
      tokenSymbol: 'PYUSD',
      from: DEPOSITOR,
    });
    mockRegisterDeposit.mockResolvedValue('10.000000');
    mockEmit.mockRejectedValue(new Error('receipt boom'));

    const res = await app.inject({
      method: 'POST',
      url: '/auth/deposit',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: depositPayload(),
    });

    expect(res.statusCode).toBe(200);
  });

  // ── CD-10 — escrow contract not configured → 503 ──
  it('escrow mode + ESCROW_CONTRACT_NOT_CONFIGURED → 503 (CD-10)', async () => {
    process.env.ESCROW_MODE_ENABLED = 'true';
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockGetAdaptersBundle.mockReturnValue(makeBundle(2368));
    mockVerifyEscrowDeposit.mockResolvedValue({
      ok: false,
      reason: 'ESCROW_CONTRACT_NOT_CONFIGURED',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/deposit',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: depositPayload(),
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error_code).toBe('ESCROW_CONTRACT_NOT_CONFIGURED');
    expect(mockRegisterDeposit).not.toHaveBeenCalled();
  });

  it('escrow mode + KEY_ID_MISMATCH → 400 (CD-10)', async () => {
    process.env.ESCROW_MODE_ENABLED = 'true';
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockGetAdaptersBundle.mockReturnValue(makeBundle(2368));
    mockVerifyEscrowDeposit.mockResolvedValue({
      ok: false,
      reason: 'KEY_ID_MISMATCH',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/deposit',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: depositPayload(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('KEY_ID_MISMATCH');
  });

  // ── CD-11 — flag strictness ──
  it.each([
    ['1'],
    ['TRUE'],
    ['True'],
    ['yes'],
    [''],
  ])("ESCROW_MODE_ENABLED=%j (not exact 'true') → treasury path (CD-11)", async (flag) => {
    process.env.ESCROW_MODE_ENABLED = flag;
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
      payload: depositPayload(),
    });

    expect(res.statusCode).toBe(200);
    expect(mockVerifyDeposit).toHaveBeenCalledTimes(1);
    expect(mockVerifyEscrowDeposit).not.toHaveBeenCalled();
  });

  it("ESCROW_MODE_ENABLED='true' exact → escrow path (CD-11)", async () => {
    process.env.ESCROW_MODE_ENABLED = 'true';
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockGetAdaptersBundle.mockReturnValue(makeBundle(2368));
    mockVerifyEscrowDeposit.mockResolvedValue({
      ok: true,
      amountUsd: '10',
      tokenSymbol: 'PYUSD',
      from: DEPOSITOR,
    });
    mockRegisterDeposit.mockResolvedValue('10.000000');

    await app.inject({
      method: 'POST',
      url: '/auth/deposit',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: depositPayload(),
    });

    expect(mockVerifyEscrowDeposit).toHaveBeenCalledTimes(1);
    expect(mockVerifyDeposit).not.toHaveBeenCalled();
  });

  // ── WKH-126c — routing escrow POR-CADENA (fallback a treasury) ──

  // AC-1 — cadena CON contrato + flag on → escrow.
  it('flag on + contrato configurado para la cadena → verifyEscrowDeposit (AC-1)', async () => {
    process.env.ESCROW_MODE_ENABLED = 'true';
    mockResolveEscrowContract.mockReturnValue(ESCROW_CONTRACT_ADDR);
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockGetAdaptersBundle.mockReturnValue(makeBundle(2368));
    mockVerifyEscrowDeposit.mockResolvedValue({
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
      payload: depositPayload(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().balance).toBe('10.000000');
    expect(mockVerifyEscrowDeposit).toHaveBeenCalledTimes(1);
    expect(mockVerifyDeposit).not.toHaveBeenCalled();
  });

  // AC-2 — cadena SIN contrato + flag on → treasury, NO 503.
  it('flag on + contrato NO configurado para la cadena → verifyDeposit (treasury), no 503 (AC-2)', async () => {
    process.env.ESCROW_MODE_ENABLED = 'true';
    mockResolveEscrowContract.mockReturnValue(null);
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
      payload: depositPayload(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().error_code).toBeUndefined();
    expect(mockVerifyDeposit).toHaveBeenCalledTimes(1);
    expect(mockVerifyEscrowDeposit).not.toHaveBeenCalled();
  });

  // AC-3 — flag off + contrato configurado → treasury (CD-2).
  it('flag off + contrato configurado para la cadena → verifyDeposit (treasury) (AC-3/CD-2)', async () => {
    delete process.env.ESCROW_MODE_ENABLED;
    mockResolveEscrowContract.mockReturnValue(ESCROW_CONTRACT_ADDR);
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
      payload: depositPayload(),
    });

    expect(res.statusCode).toBe(200);
    expect(mockVerifyDeposit).toHaveBeenCalledTimes(1);
    expect(mockVerifyEscrowDeposit).not.toHaveBeenCalled();
  });
});
