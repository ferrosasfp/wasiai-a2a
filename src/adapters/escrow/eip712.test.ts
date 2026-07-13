/**
 * EIP-712 DebitAuthorization helper tests — WKH-126b (W4).
 *
 * Covers AC-4 (firma válida → recovered === signer.address → presentable) y
 * AC-5/CD-12 (verifyingContract ausente/cero → NO firma). Firma con una cuenta
 * viem real derivada de una PK fija (no toca red ni DB — CD-7). Aserciones sobre
 * el objeto de retorno (no substrings).
 */

import { keccak256, recoverTypedDataAddress, stringToBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildDebitAuthorization,
  buildDebitDomain,
  DEBIT_AUTHORIZATION_TYPES,
  hashDebitAuthorization,
  recoverDebitAuthorization,
} from './eip712.js';

const SIGNER_PK = `0x${'1'.repeat(64)}` as `0x${string}`;
const VERIFYING_CONTRACT =
  '0x1111111111111111111111111111111111111111' as `0x${string}`;
const ZERO_CONTRACT =
  '0x0000000000000000000000000000000000000000' as `0x${string}`;
const CHAIN_ID = 2368;

const KEY_ID = keccak256(stringToBytes('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));

const ORIGINAL_ENV = { ...process.env };

describe('buildDebitAuthorization', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.ESCROW_EIP712_NAME;
    delete process.env.ESCROW_EIP712_VERSION;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  // ── AC-4 — firma válida, recover sanity OK ──
  it('produces a signature whose recovered === signer.address → presentable (AC-4)', async () => {
    const signer = privateKeyToAccount(SIGNER_PK);
    const res = await buildDebitAuthorization({
      keyId: KEY_ID,
      amount: 1_000_000n,
      deadline: 9_999_999_999n,
      nonce: 1n,
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT,
      signer,
    });

    expect(res.presentable).toBe(true);
    expect(res.recovered.toLowerCase()).toBe(signer.address.toLowerCase());

    // Recompute recover independently against the same typed-data.
    const recovered = await recoverTypedDataAddress({
      domain: buildDebitDomain(CHAIN_ID, VERIFYING_CONTRACT),
      types: DEBIT_AUTHORIZATION_TYPES,
      primaryType: 'DebitAuthorization',
      message: {
        keyId: KEY_ID,
        amount: 1_000_000n,
        deadline: 9_999_999_999n,
        nonce: 1n,
      },
      signature: res.signature,
    });
    expect(recovered.toLowerCase()).toBe(signer.address.toLowerCase());
  });

  // ── AC-5 / CD-12 — verifyingContract zero → NO firma ──
  it('verifyingContract zero → does NOT sign, presentable:false (AC-5/CD-12)', async () => {
    const signer = privateKeyToAccount(SIGNER_PK);
    const res = await buildDebitAuthorization({
      keyId: KEY_ID,
      amount: 1_000_000n,
      deadline: 9_999_999_999n,
      nonce: 1n,
      chainId: CHAIN_ID,
      verifyingContract: ZERO_CONTRACT,
      signer,
    });
    expect(res.presentable).toBe(false);
    expect(res.signature).toBe('0x');
  });

  it('verifyingContract malformed → does NOT sign, presentable:false (CD-12)', async () => {
    const signer = privateKeyToAccount(SIGNER_PK);
    const res = await buildDebitAuthorization({
      keyId: KEY_ID,
      amount: 1_000_000n,
      deadline: 9_999_999_999n,
      nonce: 1n,
      chainId: CHAIN_ID,
      verifyingContract: '0xnotanaddress' as `0x${string}`,
      signer,
    });
    expect(res.presentable).toBe(false);
  });

  // ── domain incluye verifyingContract (CD-12) ──
  it('domain includes verifyingContract + env-driven name/version (CD-12)', () => {
    const domain = buildDebitDomain(CHAIN_ID, VERIFYING_CONTRACT);
    expect(domain.verifyingContract).toBe(VERIFYING_CONTRACT);
    expect(domain.name).toBe('WasiAIEscrow');
    expect(domain.version).toBe('1');
    expect(domain.chainId).toBe(CHAIN_ID);

    process.env.ESCROW_EIP712_NAME = 'CustomEscrow';
    process.env.ESCROW_EIP712_VERSION = '2';
    const custom = buildDebitDomain(CHAIN_ID, VERIFYING_CONTRACT);
    expect(custom.name).toBe('CustomEscrow');
    expect(custom.version).toBe('2');
  });

  // ── hashDebitAuthorization deriva typehash por viem (CD-3) ──
  it('hashDebitAuthorization is deterministic and 32-byte hex (CD-3)', () => {
    const h1 = hashDebitAuthorization({
      keyId: KEY_ID,
      amount: 1_000_000n,
      deadline: 9_999_999_999n,
      nonce: 1n,
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT,
    });
    const h2 = hashDebitAuthorization({
      keyId: KEY_ID,
      amount: 1_000_000n,
      deadline: 9_999_999_999n,
      nonce: 1n,
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT,
    });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^0x[0-9a-f]{64}$/);
    // distinto nonce → distinto hash (anti-replay del débito).
    const h3 = hashDebitAuthorization({
      keyId: KEY_ID,
      amount: 1_000_000n,
      deadline: 9_999_999_999n,
      nonce: 2n,
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT,
    });
    expect(h3).not.toBe(h1);
  });
});

// ── T-10 (§3 convergencia): recoverDebitAuthorization ──
describe('recoverDebitAuthorization (WKH-191a captura)', () => {
  it('recupera exactamente signer.address sobre una firma DebitAuthorization válida', async () => {
    const signer = privateKeyToAccount(SIGNER_PK);
    const domain = buildDebitDomain(CHAIN_ID, VERIFYING_CONTRACT);
    const message = {
      keyId: KEY_ID,
      amount: 1_500_000n,
      deadline: 9_999_999_999n,
      nonce: 7n,
    };
    const signature = await signer.signTypedData({
      domain,
      types: DEBIT_AUTHORIZATION_TYPES,
      primaryType: 'DebitAuthorization',
      message,
    });

    const recovered = await recoverDebitAuthorization({
      message,
      domain,
      signature,
    });
    expect(recovered).not.toBeNull();
    expect(recovered?.toLowerCase()).toBe(signer.address.toLowerCase());
  });

  it('firma malformada → null (no lanza)', async () => {
    const domain = buildDebitDomain(CHAIN_ID, VERIFYING_CONTRACT);
    const recovered = await recoverDebitAuthorization({
      message: {
        keyId: KEY_ID,
        amount: 1_000_000n,
        deadline: 9_999_999_999n,
        nonce: 1n,
      },
      domain,
      signature: '0xdeadbeef',
    });
    expect(recovered).toBeNull();
  });
});
