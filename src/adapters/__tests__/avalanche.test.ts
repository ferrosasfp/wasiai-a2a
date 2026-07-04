/**
 * Avalanche adapter tests (WKH-MULTICHAIN / 086 W1).
 *
 * Covers:
 *   - Factory shape — fuji default + mainnet wiring.
 *   - PaymentAdapter contract — chainId, scheme, network tag, USDC, decimals.
 *   - Env override for USDC address (FUJI_USDC_ADDRESS / AVALANCHE_USDC_ADDRESS).
 *   - Gasless status — disabled stub.
 *   - Attestation stub — warn + zero txHash.
 *   - Identity binding — null.
 *
 * Mocks viem walletClient (so `sign()` does not require a real RPC) and global
 * fetch (so `verify()`/`settle()` do not hit a real facilitator).
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Structured logger mock ─────────────────────────────────
// avalanche/payment.ts + avalanche/attestation.ts log env fallbacks / the
// attestation stub via getLogger('avalanche'). Mock it so tests assert log
// emission (object-first / message-second) instead of spying on console.
const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../../lib/logger.js', () => ({
  getLogger: () => logSpy,
}));

// ─── Mocks ───────────────────────────────────────────────────────────────
// `viem` partial mock — replaces `createWalletClient` + `createPublicClient`
// (preserves real exports like `http`, `parseUnits`, `parseSignature`,
// `WaitForTransactionReceiptTimeoutError`, etc). The `mock`-prefixed hoisted
// fns let the WKH-138 gasless tests drive writeContract/receipt/balanceOf.
const mockWriteContract = vi.fn();
const mockWaitForReceipt = vi.fn();
const mockReadContract = vi.fn();
// Valid 65-byte EIP-3009 signature (parseSignature-compatible, v=0x1b=27).
// The old `0x${'ab'.repeat(65)}` throws "Invalid yParityOrV" in parseSignature,
// which the gasless transfer() path exercises (payment sign() does not).
const mockSignTypedData = vi
  .fn()
  .mockResolvedValue(`0x${'11'.repeat(32)}${'22'.repeat(32)}1b`);

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createWalletClient: vi.fn(() => ({
      account: { address: '0x1234567890123456789012345678901234567890' },
      signTypedData: mockSignTypedData,
      writeContract: mockWriteContract,
    })),
    createPublicClient: vi.fn(() => ({
      waitForTransactionReceipt: mockWaitForReceipt,
      readContract: mockReadContract,
    })),
  };
});

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { WaitForTransactionReceiptTimeoutError } from 'viem';
import {
  _resetAvalancheGasless,
  AvalancheGaslessAdapter,
} from '../avalanche/gasless.js';
import { createAvalancheAdapters } from '../avalanche/index.js';
import {
  _resetWalletClient,
  AvalanchePaymentAdapter,
} from '../avalanche/payment.js';
import { GaslessTransferError } from '../errors.js';

// Valid EIP-3009 signature the mocked signTypedData resolves to.
const VALID_SIG = `0x${'11'.repeat(32)}${'22'.repeat(32)}1b`;
// hardhat account #0 pubkey — NOT a secret; only used to configure the signer.
const TEST_PK =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
// The mocked createWalletClient always returns this operator address.
const MOCK_OPERATOR = '0x1234567890123456789012345678901234567890';

const FUJI_USDC_DEFAULT = '0x5425890298aed601595a70AB815c96711a31Bc65';
const AVALANCHE_USDC_DEFAULT = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E';

describe('Avalanche adapter — factory shape', () => {
  beforeEach(() => {
    _resetWalletClient();
    vi.clearAllMocks();
    delete process.env.AVALANCHE_NETWORK;
    delete process.env.FUJI_USDC_ADDRESS;
    delete process.env.AVALANCHE_USDC_ADDRESS;
  });

  it('default network → fuji bundle (chainId 43113)', async () => {
    const bundle = await createAvalancheAdapters();
    expect(bundle.chainConfig.chainId).toBe(43113);
    expect(bundle.chainConfig.name).toBe('Avalanche Fuji');
    expect(bundle.chainConfig.explorerUrl).toBe('https://testnet.snowtrace.io');
  });

  it('explicit fuji → chainId 43113', async () => {
    const bundle = await createAvalancheAdapters({ network: 'fuji' });
    expect(bundle.chainConfig.chainId).toBe(43113);
    expect(bundle.payment.chainId).toBe(43113);
    expect(bundle.attestation.chainId).toBe(43113);
    expect(bundle.gasless.chainId).toBe(43113);
  });

  it('explicit mainnet → chainId 43114 + name "Avalanche"', async () => {
    const bundle = await createAvalancheAdapters({ network: 'mainnet' });
    expect(bundle.chainConfig.chainId).toBe(43114);
    expect(bundle.chainConfig.name).toBe('Avalanche');
    expect(bundle.chainConfig.explorerUrl).toBe('https://snowtrace.io');
    expect(bundle.payment.chainId).toBe(43114);
    expect(bundle.attestation.chainId).toBe(43114);
    expect(bundle.gasless.chainId).toBe(43114);
  });

  it('identity is null (no identity binding in Avalanche MVP)', async () => {
    const bundle = await createAvalancheAdapters({ network: 'fuji' });
    expect(bundle.identity).toBeNull();
  });

  it('AVALANCHE_NETWORK env=mainnet picks mainnet when opts.network absent', async () => {
    process.env.AVALANCHE_NETWORK = 'mainnet';
    const bundle = await createAvalancheAdapters();
    expect(bundle.chainConfig.chainId).toBe(43114);
  });
});

describe('Avalanche payment adapter — contract', () => {
  let adapter: AvalanchePaymentAdapter;

  beforeEach(() => {
    _resetWalletClient();
    vi.clearAllMocks();
    delete process.env.FUJI_USDC_ADDRESS;
    delete process.env.AVALANCHE_USDC_ADDRESS;
    process.env.OPERATOR_PRIVATE_KEY =
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
    adapter = new AvalanchePaymentAdapter({ network: 'fuji' });
  });

  afterEach(() => {
    delete process.env.OPERATOR_PRIVATE_KEY;
    delete process.env.WASIAI_MERCHANT_NAME;
    delete process.env.AVALANCHE_FACILITATOR_URL;
    delete process.env.WASIAI_FACILITATOR_URL;
  });

  it('name is "avalanche"', () => {
    expect(adapter.name).toBe('avalanche');
  });

  it('fuji adapter → chainId 43113', () => {
    expect(adapter.chainId).toBe(43113);
  });

  it('mainnet adapter → chainId 43114', () => {
    const m = new AvalanchePaymentAdapter({ network: 'mainnet' });
    expect(m.chainId).toBe(43114);
  });

  it('getScheme() returns "exact"', () => {
    expect(adapter.getScheme()).toBe('exact');
  });

  it('getNetwork() fuji → "eip155:43113"', () => {
    expect(adapter.getNetwork()).toBe('eip155:43113');
  });

  it('getNetwork() mainnet → "eip155:43114"', () => {
    const m = new AvalanchePaymentAdapter({ network: 'mainnet' });
    expect(m.getNetwork()).toBe('eip155:43114');
  });

  it('supportedTokens[0] → USDC, 6 decimals, Fuji default address', () => {
    expect(adapter.supportedTokens).toHaveLength(1);
    expect(adapter.supportedTokens[0]!.symbol).toBe('USDC');
    expect(adapter.supportedTokens[0]!.decimals).toBe(6);
    expect(adapter.supportedTokens[0]!.address.toLowerCase()).toBe(
      FUJI_USDC_DEFAULT.toLowerCase(),
    );
  });

  it('supportedTokens mainnet → Avalanche C-Chain USDC default', () => {
    const m = new AvalanchePaymentAdapter({ network: 'mainnet' });
    expect(m.supportedTokens[0]!.address.toLowerCase()).toBe(
      AVALANCHE_USDC_DEFAULT.toLowerCase(),
    );
  });

  it('getToken() respects FUJI_USDC_ADDRESS env override', () => {
    const customToken = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    process.env.FUJI_USDC_ADDRESS = customToken;
    expect(adapter.getToken().toLowerCase()).toBe(customToken.toLowerCase());
  });

  it('getToken() respects AVALANCHE_USDC_ADDRESS env override (mainnet)', () => {
    const customToken = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    process.env.AVALANCHE_USDC_ADDRESS = customToken;
    const m = new AvalanchePaymentAdapter({ network: 'mainnet' });
    expect(m.getToken().toLowerCase()).toBe(customToken.toLowerCase());
  });

  it('getMaxTimeoutSeconds() returns 60', () => {
    expect(adapter.getMaxTimeoutSeconds()).toBe(60);
  });

  it('getMerchantName() default "WasiAI"', () => {
    delete process.env.WASIAI_MERCHANT_NAME;
    expect(adapter.getMerchantName()).toBe('WasiAI');
  });

  it('getMerchantName() reads WASIAI_MERCHANT_NAME env', () => {
    process.env.WASIAI_MERCHANT_NAME = 'CustomAcme';
    expect(adapter.getMerchantName()).toBe('CustomAcme');
  });

  it('sign() returns SignResult shape (xPaymentHeader + paymentRequest)', async () => {
    const result = await adapter.sign({
      to: '0x000000000000000000000000000000000000dEaD' as `0x${string}`,
      value: '1000000', // 1 USDC atomic
    });
    expect(result).toHaveProperty('xPaymentHeader');
    expect(result).toHaveProperty('paymentRequest');
    expect(typeof result.xPaymentHeader).toBe('string');
    expect(result.paymentRequest.network).toBe('eip155:43113');
    expect(result.paymentRequest.authorization.to).toBe(
      '0x000000000000000000000000000000000000dEaD',
    );
    expect(result.paymentRequest.authorization.value).toBe('1000000');
  });

  it('verify() POSTs canonical x402 body and returns valid=true on facilitator OK', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ verified: true }),
    });
    const result = await adapter.verify({
      authorization: {
        from: '0x1111111111111111111111111111111111111111',
        to: '0x2222222222222222222222222222222222222222',
        value: '1000000',
        validAfter: '0',
        validBefore: '9999999999',
        nonce: `0x${'a'.repeat(64)}`,
      },
      signature: '0xSIG',
      network: 'eip155:43113',
    });
    expect(result.valid).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toMatch(/\/verify$/);
    expect((init as { method: string }).method).toBe('POST');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.x402Version).toBe(2);
    expect(body.accepted.scheme).toBe('exact');
    expect(body.accepted.network).toBe('eip155:43113');
    expect(body.accepted.maxTimeoutSeconds).toBe(60);
    expect(body.accepted.extra.assetTransferMethod).toBe('eip3009');
  });

  it('AC-4: verify() body uses server paymentRequirements, not caller authorization', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ verified: true }),
    });
    await adapter.verify({
      authorization: {
        from: '0x1111111111111111111111111111111111111111',
        to: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        value: '1',
        validAfter: '0',
        validBefore: '9999999999',
        nonce: `0x${'a'.repeat(64)}`,
      },
      signature: '0xSIG',
      network: 'eip155:43113',
      paymentRequirements: {
        payTo: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        maxAmountRequired: '1000000',
      },
    });
    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse((init as { body: string }).body);
    expect(body.accepted.payTo).toBe(
      '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    );
    expect(body.accepted.amount).toBe('1000000');
  });

  it('verify() returns valid=false on facilitator HTTP 5xx', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({
        error: { code: 'INTERNAL', message: 'boom', http: 500 },
      }),
    });
    const result = await adapter.verify({
      authorization: {
        from: '0x1111111111111111111111111111111111111111',
        to: '0x2222222222222222222222222222222222222222',
        value: '1000000',
        validAfter: '0',
        validBefore: '9999999999',
        nonce: `0x${'a'.repeat(64)}`,
      },
      signature: '0xSIG',
      network: 'eip155:43113',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toBe('boom');
  });

  it('settle() returns txHash on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        settled: true,
        transactionHash: '0xDEADBEEF',
        blockNumber: 12345,
      }),
    });
    const result = await adapter.settle({
      authorization: {
        from: '0x1111111111111111111111111111111111111111',
        to: '0x2222222222222222222222222222222222222222',
        value: '1000000',
        validAfter: '0',
        validBefore: '9999999999',
        nonce: `0x${'a'.repeat(64)}`,
      },
      signature: '0xSIG',
      network: 'eip155:43113',
    });
    expect(result.success).toBe(true);
    expect(result.txHash).toBe('0xDEADBEEF');
    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toMatch(/\/settle$/);
  });

  it('settle() returns success=false when facilitator reports settled=false', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        settled: false,
        error: {
          code: 'INSUFFICIENT_BALANCE',
          message: 'no balance',
          http: 400,
        },
      }),
    });
    const result = await adapter.settle({
      authorization: {
        from: '0x1111111111111111111111111111111111111111',
        to: '0x2222222222222222222222222222222222222222',
        value: '1000000',
        validAfter: '0',
        validBefore: '9999999999',
        nonce: `0x${'a'.repeat(64)}`,
      },
      signature: '0xSIG',
      network: 'eip155:43113',
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('no balance');
  });

  it('uses AVALANCHE_FACILITATOR_URL when set', async () => {
    process.env.AVALANCHE_FACILITATOR_URL = 'https://custom-facilitator.test';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ verified: true }),
    });
    await adapter.verify({
      authorization: {
        from: '0x1111111111111111111111111111111111111111',
        to: '0x2222222222222222222222222222222222222222',
        value: '1000000',
        validAfter: '0',
        validBefore: '9999999999',
        nonce: `0x${'a'.repeat(64)}`,
      },
      signature: '0xSIG',
      network: 'eip155:43113',
    });
    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://custom-facilitator.test/verify');
  });

  it('falls back to WASIAI_FACILITATOR_URL when AVALANCHE_FACILITATOR_URL absent', async () => {
    delete process.env.AVALANCHE_FACILITATOR_URL;
    process.env.WASIAI_FACILITATOR_URL = 'https://shared-facilitator.test';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ verified: true }),
    });
    await adapter.verify({
      authorization: {
        from: '0x1111111111111111111111111111111111111111',
        to: '0x2222222222222222222222222222222222222222',
        value: '1000000',
        validAfter: '0',
        validBefore: '9999999999',
        nonce: `0x${'a'.repeat(64)}`,
      },
      signature: '0xSIG',
      network: 'eip155:43113',
    });
    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://shared-facilitator.test/verify');
  });

  it('quote() returns QuoteResult with USDC token (6 decimals)', async () => {
    const result = await adapter.quote(1.0);
    expect(result.token.symbol).toBe('USDC');
    expect(result.token.decimals).toBe(6);
    expect(result.token.address.toLowerCase()).toBe(
      FUJI_USDC_DEFAULT.toLowerCase(),
    );
    expect(typeof result.amountWei).toBe('string');
    expect(typeof result.facilitatorUrl).toBe('string');
  });

  // WKH money-path fix: quote() must HONOR its argument (6-dec USDC), not the
  // old flat '1000000' hardcode.
  it('quote(1) → 1000000 atomic (1 USDC, 6 decimals)', async () => {
    expect((await adapter.quote(1)).amountWei).toBe('1000000');
  });

  it('quote(0.001) → 1000 atomic, NOT the old 1000000 hardcode', async () => {
    const result = await adapter.quote(0.001);
    expect(result.amountWei).toBe('1000');
    expect(result.amountWei).not.toBe('1000000');
  });

  // MNR-1 fix: a tiny amount in scientific notation (String(1e-7) === '1e-7')
  // used to throw inside parseUnits. toFixed(decimals) normalizes it to a plain
  // decimal string first, so quote() never throws and floors to the 6-dec grid.
  it('quote(1e-7) does NOT throw (was scientific-notation parseUnits crash)', async () => {
    let result: Awaited<ReturnType<typeof adapter.quote>> | undefined;
    await expect(
      (async () => {
        result = await adapter.quote(1e-7);
      })(),
    ).resolves.not.toThrow();
    expect(result?.amountWei).toBe('0');
  });

  it('quote(0.0000012) → 1 atomic (>=1, no throw)', async () => {
    const result = await adapter.quote(0.0000012);
    expect(result.amountWei).toBe('1');
  });
});

describe('Avalanche gasless adapter — EIP-3009 operator-relayed (WKH-138)', () => {
  const TO = '0x000000000000000000000000000000000000dEaD' as `0x${string}`;
  const TX_HASH = `0x${'ab'.repeat(32)}` as `0x${string}`;

  beforeEach(() => {
    _resetWalletClient();
    _resetAvalancheGasless();
    mockWriteContract.mockReset();
    mockWaitForReceipt.mockReset();
    mockReadContract.mockReset();
    mockSignTypedData.mockReset();
    mockSignTypedData.mockResolvedValue(VALID_SIG);
    delete process.env.GASLESS_ENABLED;
    delete process.env.USDC_USD_RATE;
    delete process.env.GASLESS_DEFAULT_CAP_USD;
    delete process.env.FUJI_USDC_ADDRESS;
    delete process.env.AVALANCHE_USDC_ADDRESS;
    process.env.OPERATOR_PRIVATE_KEY = TEST_PK;
  });

  afterEach(() => {
    delete process.env.OPERATOR_PRIVATE_KEY;
    delete process.env.GASLESS_ENABLED;
    delete process.env.USDC_USD_RATE;
    delete process.env.GASLESS_DEFAULT_CAP_USD;
  });

  // ── T-AC1: sign + writeContract + receipt success → { txHash } ────────────
  it('T-AC1: transfer() signs, submits via writeContract and returns { txHash }', async () => {
    mockWriteContract.mockResolvedValue(TX_HASH);
    mockWaitForReceipt.mockResolvedValue({ status: 'success' });

    const adapter = new AvalancheGaslessAdapter(43113);
    const result = await adapter.transfer({ to: TO, value: 1_000_000n }); // $1 < cap $10

    expect(result).toEqual({ txHash: TX_HASH });
    expect(mockWriteContract).toHaveBeenCalledTimes(1);
    // CD-6: from == operator address (the caller never controls `from`).
    const args = mockWriteContract.mock.calls[0]![0].args;
    expect(args[0]).toBe(MOCK_OPERATOR); // from
    expect(args[1]).toBe(TO); // to
    expect(args[2]).toBe(1_000_000n); // value
    expect(mockWriteContract.mock.calls[0]![0].functionName).toBe(
      'transferWithAuthorization',
    );
  });

  // ── T-DRAIN-CAP (adapter-level, CD-5): value > cap → throw BEFORE submit ──
  it('T-DRAIN-CAP: value over per-call cap throws before writeContract', async () => {
    process.env.GASLESS_DEFAULT_CAP_USD = '10';
    const adapter = new AvalancheGaslessAdapter(43113);
    await expect(
      adapter.transfer({ to: TO, value: 50_000_000n }), // $50 > $10
    ).rejects.toBeInstanceOf(GaslessTransferError);
    expect(mockWriteContract).not.toHaveBeenCalled();
    expect(mockSignTypedData).not.toHaveBeenCalled();
  });

  it('T-DRAIN-CAP: overflow value (fail-closed +Infinity) throws before submit', async () => {
    const adapter = new AvalancheGaslessAdapter(43113);
    await expect(
      adapter.transfer({ to: TO, value: 2n ** 60n }),
    ).rejects.toBeInstanceOf(GaslessTransferError);
    expect(mockWriteContract).not.toHaveBeenCalled();
  });

  // ── T-SIGN-INVALID (CD-8): writeContract reject / revert / timeout ────────
  it('T-SIGN-INVALID: writeContract reject → GaslessTransferError, no txHash fabricated', async () => {
    mockWriteContract.mockRejectedValue(new Error('nonce already used'));
    const adapter = new AvalancheGaslessAdapter(43113);
    await expect(
      adapter.transfer({ to: TO, value: 1_000_000n }),
    ).rejects.toBeInstanceOf(GaslessTransferError);
    expect(mockWaitForReceipt).not.toHaveBeenCalled();
  });

  it('T-SIGN-INVALID: receipt status reverted → GaslessTransferError', async () => {
    mockWriteContract.mockResolvedValue(TX_HASH);
    mockWaitForReceipt.mockResolvedValue({ status: 'reverted' });
    const adapter = new AvalancheGaslessAdapter(43113);
    await expect(
      adapter.transfer({ to: TO, value: 1_000_000n }),
    ).rejects.toThrow(/reverted/);
  });

  it('T-SIGN-INVALID: receipt timeout (WaitForTransactionReceiptTimeoutError) → GaslessTransferError', async () => {
    mockWriteContract.mockResolvedValue(TX_HASH);
    mockWaitForReceipt.mockRejectedValue(
      new WaitForTransactionReceiptTimeoutError({ hash: TX_HASH }),
    );
    const adapter = new AvalancheGaslessAdapter(43113);
    await expect(
      adapter.transfer({ to: TO, value: 1_000_000n }),
    ).rejects.toThrow(/timeout/);
  });

  // ── T-AC3: status() funding_state per enabled/pk/balance ──────────────────
  it('T-AC3: status() → disabled when GASLESS_ENABLED != true', async () => {
    const adapter = new AvalancheGaslessAdapter(43113);
    const status = await adapter.status();
    expect(status.enabled).toBe(false);
    expect(status.funding_state).toBe('disabled');
    expect(status.network).toBe('avalanche-fuji');
    expect(status.chain_id).toBe(43113);
    expect(status.supportedToken).toBeNull();
    expect(status.operatorAddress).toBeNull();
  });

  it('T-AC3: status() → unconfigured when enabled but no OPERATOR_PRIVATE_KEY', async () => {
    process.env.GASLESS_ENABLED = 'true';
    delete process.env.OPERATOR_PRIVATE_KEY;
    const adapter = new AvalancheGaslessAdapter(43113);
    const status = await adapter.status();
    expect(status.enabled).toBe(true);
    expect(status.operatorAddress).toBeNull();
    expect(status.funding_state).toBe('unconfigured');
  });

  it('T-AC3: status() → unfunded when balance 0n', async () => {
    process.env.GASLESS_ENABLED = 'true';
    mockReadContract.mockResolvedValue(0n);
    const adapter = new AvalancheGaslessAdapter(43113);
    const status = await adapter.status();
    expect(status.funding_state).toBe('unfunded');
    expect(status.operatorAddress).not.toBeNull();
  });

  it('T-AC3: status() → unfunded when balanceOf RPC fails (fail-closed)', async () => {
    process.env.GASLESS_ENABLED = 'true';
    mockReadContract.mockRejectedValue(new Error('RPC down'));
    const adapter = new AvalancheGaslessAdapter(43113);
    const status = await adapter.status();
    expect(status.funding_state).toBe('unfunded');
  });

  it('T-AC3: status() → ready when balance > 0', async () => {
    process.env.GASLESS_ENABLED = 'true';
    mockReadContract.mockResolvedValue(5_000_000n);
    const adapter = new AvalancheGaslessAdapter(43113);
    const status = await adapter.status();
    expect(status.funding_state).toBe('ready');
  });

  // ── T-AC4: status() reports real USDC supportedToken ──────────────────────
  it('T-AC4: status() reports USDC supportedToken (6 decimals, real address)', async () => {
    process.env.GASLESS_ENABLED = 'true';
    mockReadContract.mockResolvedValue(5_000_000n);
    const adapter = new AvalancheGaslessAdapter(43113);
    const status = await adapter.status();
    expect(status.supportedToken).not.toBeNull();
    expect(status.supportedToken!.symbol).toBe('USDC');
    expect(status.supportedToken!.decimals).toBe(6);
    expect(status.supportedToken!.eip712Name).toBe('USD Coin');
  });

  // ── T-DEC (CD-2): gasless token == payment adapter token, same network ────
  it('T-DEC: gasless supportedToken address/decimals == payment adapter (fuji)', async () => {
    process.env.GASLESS_ENABLED = 'true';
    mockReadContract.mockResolvedValue(1n);
    const gasless = new AvalancheGaslessAdapter(43113);
    const payment = new AvalanchePaymentAdapter({ network: 'fuji' });
    const status = await gasless.status();
    expect(status.supportedToken!.address.toLowerCase()).toBe(
      payment.getToken().toLowerCase(),
    );
    expect(status.supportedToken!.decimals).toBe(
      payment.supportedTokens[0]!.decimals,
    );
  });

  it('T-DEC: gasless supportedToken address/decimals == payment adapter (mainnet)', async () => {
    process.env.GASLESS_ENABLED = 'true';
    mockReadContract.mockResolvedValue(1n);
    const gasless = new AvalancheGaslessAdapter(43114);
    const payment = new AvalanchePaymentAdapter({ network: 'mainnet' });
    const status = await gasless.status();
    expect(status.network).toBe('avalanche-mainnet');
    expect(status.supportedToken!.address.toLowerCase()).toBe(
      payment.getToken().toLowerCase(),
    );
    expect(status.supportedToken!.decimals).toBe(6);
  });
});

describe('Avalanche attestation adapter — stub', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('attest() returns stub txHash + proofUrl and warns', async () => {
    const warnSpy = logSpy.warn;
    warnSpy.mockClear();
    const bundle = await createAvalancheAdapters({ network: 'fuji' });
    const result = await bundle.attestation.attest({
      type: 'unit-test',
      payload: { foo: 'bar' },
    });
    expect(result.txHash).toBe('0x0');
    expect(result.proofUrl).toBe('');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('attestation stub'),
    );
  });

  it('verify() returns true (stub)', async () => {
    const bundle = await createAvalancheAdapters({ network: 'fuji' });
    expect(await bundle.attestation.verify({ txHash: '0xDEADBEEF' })).toBe(
      true,
    );
  });
});

describe('Avalanche payment adapter — facilitator bearer auth (AVAX-BEARER)', () => {
  let adapter: AvalanchePaymentAdapter;

  const proofInput = {
    authorization: {
      from: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
      value: '1000000',
      validAfter: '0',
      validBefore: '9999999999',
      nonce: `0x${'a'.repeat(64)}`,
    },
    signature: '0xSIG',
    network: 'eip155:43113' as const,
  };

  beforeEach(() => {
    _resetWalletClient();
    vi.clearAllMocks();
    delete process.env.AVALANCHE_FACILITATOR_API_KEY;
    delete process.env.FACILITATOR_API_KEY;
    process.env.OPERATOR_PRIVATE_KEY =
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
    adapter = new AvalanchePaymentAdapter({ network: 'fuji' });
  });

  afterEach(() => {
    delete process.env.AVALANCHE_FACILITATOR_API_KEY;
    delete process.env.FACILITATOR_API_KEY;
    delete process.env.OPERATOR_PRIVATE_KEY;
    delete process.env.AVALANCHE_FACILITATOR_URL;
    delete process.env.WASIAI_FACILITATOR_URL;
  });

  // T-AC1 — verify con AVALANCHE_FACILITATOR_API_KEY → bearer en /verify
  it('verify() sends Authorization: Bearer when AVALANCHE_FACILITATOR_API_KEY is set', async () => {
    process.env.AVALANCHE_FACILITATOR_API_KEY = 'test-facilitator-key';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ verified: true }),
    });
    await adapter.verify(proofInput);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toMatch(/\/verify$/);
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('Bearer test-facilitator-key');
    expect(headers['Content-Type']).toBe('application/json');
  });

  // T-AC2 — settle con AVALANCHE_FACILITATOR_API_KEY → bearer en /settle
  it('settle() sends Authorization: Bearer when AVALANCHE_FACILITATOR_API_KEY is set', async () => {
    process.env.AVALANCHE_FACILITATOR_API_KEY = 'test-facilitator-key';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ settled: true, transactionHash: '0xDEADBEEF' }),
    });
    await adapter.settle(proofInput);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toMatch(/\/settle$/);
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('Bearer test-facilitator-key');
    expect(headers['Content-Type']).toBe('application/json');
  });

  // T-AC3a — fallback: solo FACILITATOR_API_KEY seteada
  it('verify() falls back to FACILITATOR_API_KEY when AVALANCHE_FACILITATOR_API_KEY is unset', async () => {
    process.env.FACILITATOR_API_KEY = 'shared-key';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ verified: true }),
    });
    await adapter.verify(proofInput);
    const [, init] = mockFetch.mock.calls[0]!;
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('Bearer shared-key');
  });

  // T-AC3b — precedencia: ambas seteadas → gana AVALANCHE_*
  it('verify() prefers AVALANCHE_FACILITATOR_API_KEY over FACILITATOR_API_KEY when both set', async () => {
    process.env.AVALANCHE_FACILITATOR_API_KEY = 'avax-key';
    process.env.FACILITATOR_API_KEY = 'shared-key';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ verified: true }),
    });
    await adapter.verify(proofInput);
    const [, init] = mockFetch.mock.calls[0]!;
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('Bearer avax-key');
  });

  // T-AC4 — sin key → header ausente, fetch completa (verify y settle)
  it('omits Authorization header and completes when no key is set (verify and settle)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ verified: true }),
    });
    const verifyResult = await adapter.verify(proofInput);
    expect(verifyResult.valid).toBe(true);
    const [, verifyInit] = mockFetch.mock.calls[0]!;
    expect(
      (verifyInit as { headers: Record<string, string> }).headers.Authorization,
    ).toBeUndefined();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ settled: true, transactionHash: '0xDEADBEEF' }),
    });
    const settleResult = await adapter.settle(proofInput);
    expect(settleResult.success).toBe(true);
    const [, settleInit] = mockFetch.mock.calls[1]!;
    expect(
      (settleInit as { headers: Record<string, string> }).headers.Authorization,
    ).toBeUndefined();
  });

  // T-AC4-empty — key = whitespace → header omitido (no `Bearer `)
  it('omits Authorization header when key is whitespace-only', async () => {
    process.env.AVALANCHE_FACILITATOR_API_KEY = '   ';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ verified: true }),
    });
    await adapter.verify(proofInput);
    const [, init] = mockFetch.mock.calls[0]!;
    expect(
      (init as { headers: Record<string, string> }).headers.Authorization,
    ).toBeUndefined();
  });

  // T-AC5 — la key NO aparece en body ni en result.error (path 5xx)
  it('never leaks the key into the request body or the error result on 5xx', async () => {
    process.env.AVALANCHE_FACILITATOR_API_KEY = 'test-facilitator-key';
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({
        error: { code: 'INTERNAL', message: 'boom', http: 500 },
      }),
    });
    const result = await adapter.verify(proofInput);
    const [, init] = mockFetch.mock.calls[0]!;
    const rawBody = (init as { body: string }).body;
    expect(rawBody).not.toContain('test-facilitator-key');
    expect(result.valid).toBe(false);
    expect(result.error ?? '').not.toContain('test-facilitator-key');
  });

  // T-AC7 — .env.example documenta AVALANCHE_FACILITATOR_API_KEY
  it('.env.example documents AVALANCHE_FACILITATOR_API_KEY with fallback and no-logs note', () => {
    const src = readFileSync(
      new URL('../../../.env.example', import.meta.url),
      'utf8',
    );
    expect(src).toContain('AVALANCHE_FACILITATOR_API_KEY');
    expect(src).toContain('FACILITATOR_API_KEY');
    expect(src).toMatch(/logs/i);
  });
});
