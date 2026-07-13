/**
 * Debit signature capture — WKH-191a unit tests.
 *
 * Cubre: T-1 (valid + campos derivados), T-2 (AMOUNT_MISMATCH), T-2b
 * (SIGNER_MISMATCH), T-3b (escrow no config → cero persistencia), T-4 (inerte:
 * cero on-chain), T-5 (anti-replay: propaga NONCE_ALREADY_USED del RPC), T-6
 * (DEADLINE_EXPIRED), T-6b (DEADLINE_TOO_FAR), T-7 (ownership best-effort no-throw),
 * T-9 (decimals=6, atómico exacto). recoverDebitAuthorization/buildDebitDomain
 * reales (viem); registry/escrow-verifier/supabase mockeados. Sin red ni DB.
 */

import { keccak256, stringToBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../../lib/logger.js', () => ({ getLogger: () => logSpy }));

const mockGetDefaultChainKey = vi.hoisted(() => vi.fn());
const mockGetAdaptersBundle = vi.hoisted(() => vi.fn());
vi.mock('../registry.js', () => ({
  getDefaultChainKey: () => mockGetDefaultChainKey(),
  getAdaptersBundle: () => mockGetAdaptersBundle(),
}));

const mockResolveEscrowContract = vi.hoisted(() => vi.fn());
vi.mock('../escrow-verifier.js', () => ({
  resolveEscrowContract: () => mockResolveEscrowContract(),
}));

vi.mock('../../lib/supabase.js', () => ({
  supabase: { rpc: vi.fn(), from: vi.fn() },
}));

import { supabase } from '../../lib/supabase.js';
import {
  captureDebitSignature,
  captureDebitSignatureBestEffort,
} from './debit-capture.js';
import { buildDebitDomain, DEBIT_AUTHORIZATION_TYPES } from './eip712.js';

const mockRpc = vi.mocked(supabase.rpc);
const mockFrom = vi.mocked(supabase.from);

const SIGNER_PK = `0x${'1'.repeat(64)}` as `0x${string}`;
const OTHER_PK = `0x${'2'.repeat(64)}` as `0x${string}`;
const VERIFYING_CONTRACT =
  '0x1111111111111111111111111111111111111111' as `0x${string}`;
const CHAIN_ID = 84532;
const KEY_ID_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const KEY_ID_HASH = keccak256(stringToBytes(KEY_ID_UUID));
const OWNER = 'tenant-A';
const INTENT_ID = 'intent-1';

const ORIGINAL_ENV = { ...process.env };

/** Bundle con USDC 6d (Base Sepolia). Spies on-chain para T-4. */
const settleSpy = vi.fn();
const signSpy = vi.fn();
function stubBundle(decimals = 6): void {
  mockGetAdaptersBundle.mockReturnValue({
    payment: {
      supportedTokens: [{ decimals, symbol: 'USDC' }],
      settle: settleSpy,
      sign: signSpy,
    },
  });
}

function stubBuyerWallet(wallet: string | null): void {
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: () =>
      Promise.resolve({
        data: wallet === null ? null : { buyer_wallet: wallet },
        error: null,
      }),
  };
  // biome-ignore lint/suspicious/noExplicitAny: supabase builder test double
  mockFrom.mockReturnValue(builder as any);
}

function stubRpc(status = 'valid', reason: string | null = null): void {
  mockRpc.mockResolvedValue({
    data: [{ persisted_status: status, persisted_reason: reason }],
    error: null,
    // biome-ignore lint/suspicious/noExplicitAny: supabase rpc test double
  } as any);
}

async function signAuth(
  pk: `0x${string}`,
  amount: bigint,
  deadline: bigint,
  nonce: bigint,
): Promise<string> {
  const signer = privateKeyToAccount(pk);
  return signer.signTypedData({
    domain: buildDebitDomain(CHAIN_ID, VERIFYING_CONTRACT),
    types: DEBIT_AUTHORIZATION_TYPES,
    primaryType: 'DebitAuthorization',
    message: { keyId: KEY_ID_HASH, amount, deadline, nonce },
  });
}

function nowSec(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

function baseArgs(
  signature: string,
  overrides: Partial<{
    nonce: string;
    deadline: number;
    amount: string;
    finalAmountUsd: number;
  }> = {},
) {
  return {
    intentId: INTENT_ID,
    ownerRef: OWNER,
    keyId: KEY_ID_UUID,
    chainId: CHAIN_ID,
    finalAmountUsd: overrides.finalAmountUsd ?? 1.5,
    capture: {
      signature,
      nonce: overrides.nonce ?? '1',
      deadline: overrides.deadline ?? Number(nowSec() + 1800n),
      amount: overrides.amount ?? '1500000',
    },
  };
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.clearAllMocks();
  mockGetDefaultChainKey.mockReturnValue('base');
  mockResolveEscrowContract.mockReturnValue(VERIFYING_CONTRACT);
  stubBundle(6);
  stubRpc('valid', null);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

// ── T-1: firma válida + campos derivados correctos ──
describe('T-1 firma válida (AC-1)', () => {
  it('persist con p_status=valid y los 4 campos derivados exactos', async () => {
    const signer = privateKeyToAccount(SIGNER_PK);
    stubBuyerWallet(signer.address);
    const deadline = Number(nowSec() + 1800n);
    const sig = await signAuth(SIGNER_PK, 1_500_000n, BigInt(deadline), 1n);

    await captureDebitSignature(baseArgs(sig, { deadline }));

    expect(mockRpc).toHaveBeenCalledTimes(1);
    const [name, args] = mockRpc.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(name).toBe('capture_debit_signature');
    expect(args.p_status).toBe('valid');
    expect(args.p_reason).toBeNull();
    expect(args.p_key_id_hash).toBe(KEY_ID_HASH);
    expect(args.p_amount_atomic).toBe('1500000');
    expect(args.p_deadline).toBe(deadline);
    expect(args.p_nonce).toBe('1');
    expect((args.p_recovered as string).toLowerCase()).toBe(
      signer.address.toLowerCase(),
    );
    expect(args.p_owner_ref).toBe(OWNER);
  });
});

// ── T-2: AMOUNT_MISMATCH ──
describe('T-2 AMOUNT_MISMATCH (AC-2)', () => {
  it('clientAmount != serverAmount → invalid/AMOUNT_MISMATCH', async () => {
    const signer = privateKeyToAccount(SIGNER_PK);
    stubBuyerWallet(signer.address);
    const deadline = Number(nowSec() + 1800n);
    // firma sobre 1_000_000 → recover matchea el buyer (no SIGNER_MISMATCH),
    // pero serverAmount de finalAmountUsd=1.5 = 1_500_000 → mismatch.
    const sig = await signAuth(SIGNER_PK, 1_000_000n, BigInt(deadline), 1n);

    await captureDebitSignature(
      baseArgs(sig, { deadline, amount: '1000000', finalAmountUsd: 1.5 }),
    );

    const args = mockRpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args.p_status).toBe('invalid');
    expect(args.p_reason).toBe('AMOUNT_MISMATCH');
  });
});

// ── T-2b: SIGNER_MISMATCH ──
describe('T-2b SIGNER_MISMATCH (AC-2)', () => {
  it('firma de PK != buyer_wallet (amount correcto) → invalid/SIGNER_MISMATCH', async () => {
    const buyer = privateKeyToAccount(SIGNER_PK);
    stubBuyerWallet(buyer.address);
    const deadline = Number(nowSec() + 1800n);
    // firma con OTHER_PK: recovered != buyer.address.
    const sig = await signAuth(OTHER_PK, 1_500_000n, BigInt(deadline), 1n);

    await captureDebitSignature(baseArgs(sig, { deadline }));

    const args = mockRpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args.p_status).toBe('invalid');
    expect(args.p_reason).toBe('SIGNER_MISMATCH');
  });
});

// ── T-3b: escrow no configurado → cero persistencia ──
describe('T-3b escrow no config (AC-3)', () => {
  it('resolveEscrowContract=null → RPC nunca llamado', async () => {
    mockResolveEscrowContract.mockReturnValue(null);
    const signer = privateKeyToAccount(SIGNER_PK);
    stubBuyerWallet(signer.address);
    const deadline = Number(nowSec() + 1800n);
    const sig = await signAuth(SIGNER_PK, 1_500_000n, BigInt(deadline), 1n);

    await captureDebitSignature(baseArgs(sig, { deadline }));

    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('getDefaultChainKey=null → RPC nunca llamado', async () => {
    mockGetDefaultChainKey.mockReturnValue(null);
    const signer = privateKeyToAccount(SIGNER_PK);
    stubBuyerWallet(signer.address);
    const deadline = Number(nowSec() + 1800n);
    const sig = await signAuth(SIGNER_PK, 1_500_000n, BigInt(deadline), 1n);

    await captureDebitSignature(baseArgs(sig, { deadline }));

    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// ── T-4: firma inerte — cero on-chain ──
describe('T-4 firma inerte (AC-4/CD-3)', () => {
  it('tras persistir valid, ningún adaptador on-chain / settle / sign fue invocado', async () => {
    const signer = privateKeyToAccount(SIGNER_PK);
    stubBuyerWallet(signer.address);
    const deadline = Number(nowSec() + 1800n);
    const sig = await signAuth(SIGNER_PK, 1_500_000n, BigInt(deadline), 1n);

    await captureDebitSignature(baseArgs(sig, { deadline }));

    const args = mockRpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args.p_status).toBe('valid');
    // cero movimiento de fondos: ni settle ni sign del payment adapter.
    expect(settleSpy).not.toHaveBeenCalled();
    expect(signSpy).not.toHaveBeenCalled();
  });
});

// ── T-5: anti-replay — el helper propaga NONCE_ALREADY_USED del RPC ──
describe('T-5 anti-replay (AC-5)', () => {
  it('la 2ª captura del mismo (key_id, nonce) degrada a NONCE_ALREADY_USED', async () => {
    const signer = privateKeyToAccount(SIGNER_PK);
    stubBuyerWallet(signer.address);
    const deadline = Number(nowSec() + 1800n);
    const sig = await signAuth(SIGNER_PK, 1_500_000n, BigInt(deadline), 1n);

    // 1ª → RPC persiste valid; 2ª → RPC devuelve la degradación DB.
    mockRpc
      .mockResolvedValueOnce({
        data: [{ persisted_status: 'valid', persisted_reason: null }],
        error: null,
        // biome-ignore lint/suspicious/noExplicitAny: rpc double
      } as any)
      .mockResolvedValueOnce({
        data: [
          {
            persisted_status: 'invalid',
            persisted_reason: 'NONCE_ALREADY_USED',
          },
        ],
        error: null,
        // biome-ignore lint/suspicious/noExplicitAny: rpc double
      } as any);

    await captureDebitSignature(baseArgs(sig, { deadline }));
    await captureDebitSignature(baseArgs(sig, { deadline }));

    // La 2ª el helper computó 'valid' pero el RPC devolvió la degradación →
    // se registra la telemetría de veredicto degradado.
    expect(logSpy.info).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'invalid',
        reason: 'NONCE_ALREADY_USED',
      }),
      expect.any(String),
    );
  });
});

// ── T-6: DEADLINE_EXPIRED ──
describe('T-6 DEADLINE_EXPIRED (AC-6)', () => {
  it('deadline en el pasado → invalid/DEADLINE_EXPIRED (no valid)', async () => {
    const signer = privateKeyToAccount(SIGNER_PK);
    stubBuyerWallet(signer.address);
    const deadline = Number(nowSec() - 100n);
    const sig = await signAuth(SIGNER_PK, 1_500_000n, BigInt(deadline), 1n);

    await captureDebitSignature(baseArgs(sig, { deadline }));

    const args = mockRpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args.p_status).toBe('invalid');
    expect(args.p_reason).toBe('DEADLINE_EXPIRED');
  });
});

// ── T-6b: DEADLINE_TOO_FAR ──
describe('T-6b DEADLINE_TOO_FAR (R-2)', () => {
  it('deadline > now + 3600 → invalid/DEADLINE_TOO_FAR', async () => {
    const signer = privateKeyToAccount(SIGNER_PK);
    stubBuyerWallet(signer.address);
    const deadline = Number(nowSec() + 7200n);
    const sig = await signAuth(SIGNER_PK, 1_500_000n, BigInt(deadline), 1n);

    await captureDebitSignature(baseArgs(sig, { deadline }));

    const args = mockRpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args.p_status).toBe('invalid');
    expect(args.p_reason).toBe('DEADLINE_TOO_FAR');
  });
});

// ── T-7: Ownership Guard — best-effort no-throw ──
describe('T-7 Ownership Guard (CD-6)', () => {
  it('RPC rechaza OWNERSHIP_MISMATCH → best-effort lo atrapa, no re-lanza', async () => {
    process.env.ESCROW_DEBIT_CAPTURE_ENABLED = 'true';
    const signer = privateKeyToAccount(SIGNER_PK);
    stubBuyerWallet(signer.address);
    const deadline = Number(nowSec() + 1800n);
    const sig = await signAuth(SIGNER_PK, 1_500_000n, BigInt(deadline), 1n);
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'OWNERSHIP_MISMATCH: intent not owned by caller' },
      // biome-ignore lint/suspicious/noExplicitAny: rpc double
    } as any);

    await expect(
      captureDebitSignatureBestEffort(baseArgs(sig, { deadline })),
    ).resolves.toBeUndefined();

    // se pasó el owner_ref correcto al RPC (guard real vive en el RPC).
    const args = mockRpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args.p_owner_ref).toBe(OWNER);
    expect(logSpy.warn).toHaveBeenCalled();
  });
});

// ── T-9: decimals=6 → atómico exacto (no 1.5e18) ──
describe('T-9 decimals Base Sepolia (DT-2/MI-1)', () => {
  it('finalAmountUsd=1.5 con decimals=6 → p_amount_atomic === "1500000"', async () => {
    const signer = privateKeyToAccount(SIGNER_PK);
    stubBuyerWallet(signer.address);
    const deadline = Number(nowSec() + 1800n);
    const sig = await signAuth(SIGNER_PK, 1_500_000n, BigInt(deadline), 1n);

    await captureDebitSignature(
      baseArgs(sig, { deadline, amount: '1500000', finalAmountUsd: 1.5 }),
    );

    const args = mockRpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args.p_amount_atomic).toBe('1500000');
    expect(args.p_amount_atomic).not.toBe('1500000000000000000');
  });
});
