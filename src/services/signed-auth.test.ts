/**
 * Signed Auth Service Unit Tests — WKH-123
 *
 * Cubre: EIP-712 round-trip (privateKeyToAccount + signTypedData), HMAC
 * válido/inválido (key=sha256(secret)), checkTimestamp (ventana ±skew),
 * checkAndRecordNonce (23505 → replay), fail-safe clockSkew/nonceTtl, y el
 * orquestador verifySignedAuth (orden timestamp → firma → nonce).
 */

import crypto from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────

vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
  },
}));

import { supabase } from '../lib/supabase.js';
import {
  checkAndRecordNonce,
  checkTimestamp,
  clockSkewSeconds,
  nonceTtlSeconds,
  verifyEip712RequestSignature,
  verifyHmacRequestSignature,
  verifySignedAuth,
} from './signed-auth.js';

const mockFrom = vi.mocked(supabase.from);

// ── Helpers ────────────────────────────────────────────────

/** chainable mock cuyo `insert` resuelve `{ error }`. */
function insertMock(error: { code?: string; message?: string } | null) {
  const chain = {
    insert: vi.fn().mockResolvedValue({ data: null, error }),
  };
  return chain;
}

// Fixed test key/account (NUNCA un secret real).
const TEST_PK =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const account = privateKeyToAccount(TEST_PK);

const TOKEN_HASH_HEX = crypto
  .createHash('sha256')
  .update('wasi_a2a_token')
  .digest('hex');
const NONCE_BYTES32 = `0x${'a'.repeat(64)}`;
const METHOD = 'POST';
const PATH = '/api/v1/compose';

const REQUEST_TYPES = {
  Request: [
    { name: 'token_hash', type: 'bytes32' },
    { name: 'method', type: 'string' },
    { name: 'path', type: 'string' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'timestamp', type: 'uint64' },
  ],
} as const;

async function signEip712(timestamp: string): Promise<string> {
  return account.signTypedData({
    domain: {
      name: process.env.REQUEST_EIP712_NAME ?? 'WasiAI-a2a Request',
      version: process.env.REQUEST_EIP712_VERSION ?? '1',
      chainId: Number(process.env.KITE_CHAIN_ID),
    },
    types: REQUEST_TYPES,
    primaryType: 'Request',
    message: {
      token_hash: `0x${TOKEN_HASH_HEX}` as `0x${string}`,
      method: METHOD,
      path: PATH,
      nonce: NONCE_BYTES32 as `0x${string}`,
      timestamp: BigInt(Number(timestamp)),
    },
  });
}

function hmacSecret(): { secret: string; hash: string } {
  const secret = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(secret).digest('hex');
  return { secret, hash };
}

function signHmac(hash: string, nonce: string, timestamp: string): string {
  const canonical = `${TOKEN_HASH_HEX}\n${METHOD}\n${PATH}\n${nonce}\n${timestamp}`;
  const key = Buffer.from(hash, 'hex');
  return crypto.createHmac('sha256', key).update(canonical).digest('hex');
}

function nowTs(): string {
  return String(Math.floor(Date.now() / 1000));
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.REQUEST_EIP712_NAME = 'WasiAI-a2a Request';
  process.env.REQUEST_EIP712_VERSION = '1';
  process.env.KITE_CHAIN_ID = '2368';
  delete process.env.SIGNED_AUTH_CLOCK_SKEW_SECONDS;
  delete process.env.SIGNED_AUTH_NONCE_TTL_SECONDS;
});

// ── checkTimestamp ─────────────────────────────────────────

describe('checkTimestamp', () => {
  it('accepts now', () => {
    expect(checkTimestamp(nowTs())).toBe(true);
  });

  it('rejects now - (skew + 1)', () => {
    const ts = String(Math.floor(Date.now() / 1000) - (clockSkewSeconds() + 1));
    expect(checkTimestamp(ts)).toBe(false);
  });

  it('rejects now + (skew + 1)', () => {
    const ts = String(Math.floor(Date.now() / 1000) + clockSkewSeconds() + 1);
    expect(checkTimestamp(ts)).toBe(false);
  });

  it('rejects NaN / non-integer', () => {
    expect(checkTimestamp('not-a-number')).toBe(false);
    expect(checkTimestamp('123.5')).toBe(false);
  });
});

// ── fail-safe env getters ──────────────────────────────────

describe('clockSkewSeconds / nonceTtlSeconds fail-safe', () => {
  it('default 300 when absent', () => {
    expect(clockSkewSeconds()).toBe(300);
    expect(nonceTtlSeconds()).toBe(300);
  });

  it('default 300 when NaN', () => {
    process.env.SIGNED_AUTH_CLOCK_SKEW_SECONDS = 'abc';
    process.env.SIGNED_AUTH_NONCE_TTL_SECONDS = 'abc';
    expect(clockSkewSeconds()).toBe(300);
    expect(nonceTtlSeconds()).toBe(300);
  });

  it('default 300 when <= 0', () => {
    process.env.SIGNED_AUTH_CLOCK_SKEW_SECONDS = '0';
    process.env.SIGNED_AUTH_NONCE_TTL_SECONDS = '-5';
    expect(clockSkewSeconds()).toBe(300);
    expect(nonceTtlSeconds()).toBe(300);
  });

  it('nonceTtl = max(ttl, skew)', () => {
    process.env.SIGNED_AUTH_CLOCK_SKEW_SECONDS = '600';
    process.env.SIGNED_AUTH_NONCE_TTL_SECONDS = '120';
    expect(nonceTtlSeconds()).toBe(600);
  });

  it('nonceTtl honors explicit value when greater than skew', () => {
    process.env.SIGNED_AUTH_CLOCK_SKEW_SECONDS = '100';
    process.env.SIGNED_AUTH_NONCE_TTL_SECONDS = '900';
    expect(nonceTtlSeconds()).toBe(900);
  });
});

// ── EIP-712 round-trip (master) ────────────────────────────

describe('verifyEip712RequestSignature', () => {
  it('valid signature recovers funding_wallet → true', async () => {
    const ts = nowTs();
    const signature = await signEip712(ts);
    const ok = await verifyEip712RequestSignature({
      tokenHashHex: TOKEN_HASH_HEX,
      method: METHOD,
      path: PATH,
      nonce: NONCE_BYTES32,
      timestamp: ts,
      signature,
      fundingWallet: account.address,
    });
    expect(ok).toBe(true);
  });

  it('signer != funding_wallet → false', async () => {
    const ts = nowTs();
    const signature = await signEip712(ts);
    const ok = await verifyEip712RequestSignature({
      tokenHashHex: TOKEN_HASH_HEX,
      method: METHOD,
      path: PATH,
      nonce: NONCE_BYTES32,
      timestamp: ts,
      signature,
      fundingWallet: '0x0000000000000000000000000000000000000001',
    });
    expect(ok).toBe(false);
  });

  it('malformed signature → false (no throw)', async () => {
    const ok = await verifyEip712RequestSignature({
      tokenHashHex: TOKEN_HASH_HEX,
      method: METHOD,
      path: PATH,
      nonce: NONCE_BYTES32,
      timestamp: nowTs(),
      signature: '0xdeadbeef',
      fundingWallet: account.address,
    });
    expect(ok).toBe(false);
  });

  it('nonce not bytes32 → false', async () => {
    const ts = nowTs();
    const signature = await signEip712(ts);
    const ok = await verifyEip712RequestSignature({
      tokenHashHex: TOKEN_HASH_HEX,
      method: METHOD,
      path: PATH,
      nonce: 'not-bytes32',
      timestamp: ts,
      signature,
      fundingWallet: account.address,
    });
    expect(ok).toBe(false);
  });
});

// ── HMAC (session) ─────────────────────────────────────────

describe('verifyHmacRequestSignature', () => {
  it('valid HMAC (key = sha256(secret)) → true', () => {
    const { hash } = hmacSecret();
    const ts = nowTs();
    const signature = signHmac(hash, NONCE_BYTES32, ts);
    const ok = verifyHmacRequestSignature({
      tokenHashHex: TOKEN_HASH_HEX,
      method: METHOD,
      path: PATH,
      nonce: NONCE_BYTES32,
      timestamp: ts,
      signature,
      signingSecretHash: hash,
    });
    expect(ok).toBe(true);
  });

  it('wrong key → false', () => {
    const { hash } = hmacSecret();
    const other = hmacSecret();
    const ts = nowTs();
    const signature = signHmac(other.hash, NONCE_BYTES32, ts);
    const ok = verifyHmacRequestSignature({
      tokenHashHex: TOKEN_HASH_HEX,
      method: METHOD,
      path: PATH,
      nonce: NONCE_BYTES32,
      timestamp: ts,
      signature,
      signingSecretHash: hash,
    });
    expect(ok).toBe(false);
  });

  it('malformed signature (not 64-hex) → false', () => {
    const { hash } = hmacSecret();
    const ok = verifyHmacRequestSignature({
      tokenHashHex: TOKEN_HASH_HEX,
      method: METHOD,
      path: PATH,
      nonce: NONCE_BYTES32,
      timestamp: nowTs(),
      signature: 'zz',
      signingSecretHash: hash,
    });
    expect(ok).toBe(false);
  });
});

// ── checkAndRecordNonce ────────────────────────────────────

describe('checkAndRecordNonce', () => {
  it('no error → true (recorded)', async () => {
    const chain = insertMock(null);
    mockFrom.mockReturnValue(
      chain as unknown as ReturnType<typeof supabase.from>,
    );
    await expect(
      checkAndRecordNonce(TOKEN_HASH_HEX, NONCE_BYTES32),
    ).resolves.toBe(true);
  });

  it('23505 → false (replay)', async () => {
    const chain = insertMock({ code: '23505', message: 'dup' });
    mockFrom.mockReturnValue(
      chain as unknown as ReturnType<typeof supabase.from>,
    );
    await expect(
      checkAndRecordNonce(TOKEN_HASH_HEX, NONCE_BYTES32),
    ).resolves.toBe(false);
  });

  it('other DB error → throws (→ 503)', async () => {
    const chain = insertMock({ code: '500', message: 'boom' });
    mockFrom.mockReturnValue(
      chain as unknown as ReturnType<typeof supabase.from>,
    );
    await expect(
      checkAndRecordNonce(TOKEN_HASH_HEX, NONCE_BYTES32),
    ).rejects.toThrow();
  });
});

// ── verifySignedAuth orchestrator ──────────────────────────

describe('verifySignedAuth', () => {
  it('master happy path → ok:true (nonce recorded)', async () => {
    const chain = insertMock(null);
    mockFrom.mockReturnValue(
      chain as unknown as ReturnType<typeof supabase.from>,
    );
    const ts = nowTs();
    const signature = await signEip712(ts);
    const res = await verifySignedAuth({
      tokenHashHex: TOKEN_HASH_HEX,
      method: METHOD,
      path: PATH,
      headers: { signature, nonce: NONCE_BYTES32, timestamp: ts },
      scheme: { kind: 'eip712', fundingWallet: account.address },
    });
    expect(res).toEqual({ ok: true });
  });

  it('master no funding_wallet → FUNDING_WALLET_NOT_BOUND', async () => {
    const res = await verifySignedAuth({
      tokenHashHex: TOKEN_HASH_HEX,
      method: METHOD,
      path: PATH,
      headers: { signature: '0xabc', nonce: NONCE_BYTES32, timestamp: nowTs() },
      scheme: { kind: 'eip712', fundingWallet: null },
    });
    expect(res).toEqual({ ok: false, code: 'FUNDING_WALLET_NOT_BOUND' });
  });

  it('missing signature → SIGNATURE_REQUIRED', async () => {
    const res = await verifySignedAuth({
      tokenHashHex: TOKEN_HASH_HEX,
      method: METHOD,
      path: PATH,
      headers: { nonce: NONCE_BYTES32, timestamp: nowTs() },
      scheme: { kind: 'eip712', fundingWallet: account.address },
    });
    expect(res).toEqual({ ok: false, code: 'SIGNATURE_REQUIRED' });
  });

  it('timestamp out of window → TIMESTAMP_EXPIRED (before signature check)', async () => {
    const ts = String(
      Math.floor(Date.now() / 1000) - (clockSkewSeconds() + 10),
    );
    const res = await verifySignedAuth({
      tokenHashHex: TOKEN_HASH_HEX,
      method: METHOD,
      path: PATH,
      headers: { signature: '0xabc', nonce: NONCE_BYTES32, timestamp: ts },
      scheme: { kind: 'eip712', fundingWallet: account.address },
    });
    expect(res).toEqual({ ok: false, code: 'TIMESTAMP_EXPIRED' });
  });

  it('invalid signature → SIGNATURE_INVALID', async () => {
    const ts = nowTs();
    const signature = await signEip712(ts);
    const res = await verifySignedAuth({
      tokenHashHex: TOKEN_HASH_HEX,
      method: METHOD,
      path: PATH,
      headers: { signature, nonce: NONCE_BYTES32, timestamp: ts },
      scheme: {
        kind: 'eip712',
        fundingWallet: '0x0000000000000000000000000000000000000002',
      },
    });
    expect(res).toEqual({ ok: false, code: 'SIGNATURE_INVALID' });
  });

  it('valid signature but replayed nonce → NONCE_REPLAY', async () => {
    const chain = insertMock({ code: '23505', message: 'dup' });
    mockFrom.mockReturnValue(
      chain as unknown as ReturnType<typeof supabase.from>,
    );
    const ts = nowTs();
    const signature = await signEip712(ts);
    const res = await verifySignedAuth({
      tokenHashHex: TOKEN_HASH_HEX,
      method: METHOD,
      path: PATH,
      headers: { signature, nonce: NONCE_BYTES32, timestamp: ts },
      scheme: { kind: 'eip712', fundingWallet: account.address },
    });
    expect(res).toEqual({ ok: false, code: 'NONCE_REPLAY' });
  });

  it('session HMAC happy path → ok:true', async () => {
    const chain = insertMock(null);
    mockFrom.mockReturnValue(
      chain as unknown as ReturnType<typeof supabase.from>,
    );
    const { hash } = hmacSecret();
    const ts = nowTs();
    const signature = signHmac(hash, NONCE_BYTES32, ts);
    const res = await verifySignedAuth({
      tokenHashHex: TOKEN_HASH_HEX,
      method: METHOD,
      path: PATH,
      headers: { signature, nonce: NONCE_BYTES32, timestamp: ts },
      scheme: { kind: 'hmac', signingSecretHash: hash },
    });
    expect(res).toEqual({ ok: true });
  });

  it('session HMAC wrong key → SIGNATURE_INVALID', async () => {
    const { hash } = hmacSecret();
    const other = hmacSecret();
    const ts = nowTs();
    const signature = signHmac(other.hash, NONCE_BYTES32, ts);
    const res = await verifySignedAuth({
      tokenHashHex: TOKEN_HASH_HEX,
      method: METHOD,
      path: PATH,
      headers: { signature, nonce: NONCE_BYTES32, timestamp: ts },
      scheme: { kind: 'hmac', signingSecretHash: hash },
    });
    expect(res).toEqual({ ok: false, code: 'SIGNATURE_INVALID' });
  });

  it('session require_signature but no secret hash → SIGNATURE_INVALID', async () => {
    const res = await verifySignedAuth({
      tokenHashHex: TOKEN_HASH_HEX,
      method: METHOD,
      path: PATH,
      headers: {
        signature: 'a'.repeat(64),
        nonce: NONCE_BYTES32,
        timestamp: nowTs(),
      },
      scheme: { kind: 'hmac', signingSecretHash: null },
    });
    expect(res).toEqual({ ok: false, code: 'SIGNATURE_INVALID' });
  });
});
