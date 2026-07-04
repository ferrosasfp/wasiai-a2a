/**
 * Base adapter tests (WKH-104 / BASE-01).
 *
 * Covers:
 *   - Factory shape — testnet default + mainnet wiring + BASE_NETWORK env.
 *   - PaymentAdapter contract — chainId, scheme, network tag, USDC, decimals.
 *   - Env override for USDC address (BASE_SEPOLIA_USDC_ADDRESS / BASE_MAINNET_USDC_ADDRESS).
 *   - EIP-712 domain name per-network (Sepolia="USDC" vs Mainnet="USD Coin" — verified onchain).
 *   - Facilitator URL fallback chain (BASE > CDP > WASIAI > default).
 *   - Gasless status — disabled stub.
 *   - Attestation stub — warn + zero txHash.
 *   - Identity binding — null.
 *   - CD-11 — warn-once on invalid BASE_NETWORK.
 *   - CD-12 — chainId consistency across bundle members.
 *
 * Mocks viem walletClient + global fetch.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Structured logger mock ─────────────────────────────────
// base/chain.ts + base/payment.ts + base/attestation.ts log env fallbacks /
// the attestation stub via getLogger('base'). Mock it so tests assert log
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
// (preserves `parseSignature`, `WaitForTransactionReceiptTimeoutError`, etc).
// The `mock`-prefixed hoisted fns drive the WKH-138 gasless transfer/status.
const mockWriteContract = vi.fn();
const mockWaitForReceipt = vi.fn();
const mockReadContract = vi.fn();
// Valid 65-byte EIP-3009 signature (parseSignature-compatible, v=0x1b=27).
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
import { _resetBaseChain } from '../base/chain.js';
import { _resetBaseGasless, BaseGaslessAdapter } from '../base/gasless.js';
import { createBaseAdapters } from '../base/index.js';
import { _resetWalletClient, BasePaymentAdapter } from '../base/payment.js';
import { GaslessTransferError } from '../errors.js';

const BASE_SEPOLIA_USDC_DEFAULT = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const BASE_MAINNET_USDC_DEFAULT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// Valid EIP-3009 signature the mocked signTypedData resolves to.
const VALID_SIG = `0x${'11'.repeat(32)}${'22'.repeat(32)}1b`;
// hardhat account #0 pubkey — NOT a secret; only used to configure the signer.
const TEST_PK =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
// The mocked createWalletClient always returns this operator address.
const MOCK_OPERATOR = '0x1234567890123456789012345678901234567890';

describe('Base adapter — factory shape', () => {
  beforeEach(() => {
    _resetWalletClient();
    _resetBaseChain();
    vi.clearAllMocks();
    delete process.env.BASE_NETWORK;
    delete process.env.BASE_SEPOLIA_USDC_ADDRESS;
    delete process.env.BASE_MAINNET_USDC_ADDRESS;
  });

  it('default network → testnet bundle (chainId 84532)', async () => {
    const bundle = await createBaseAdapters();
    expect(bundle.chainConfig.chainId).toBe(84532);
    expect(bundle.chainConfig.name).toBe('Base Sepolia');
    expect(bundle.chainConfig.explorerUrl).toBe('https://sepolia.basescan.org');
  });

  it('explicit testnet → chainId 84532 + CD-12 consistency', async () => {
    const bundle = await createBaseAdapters({ network: 'testnet' });
    expect(bundle.chainConfig.chainId).toBe(84532);
    expect(bundle.payment.chainId).toBe(84532);
    expect(bundle.attestation.chainId).toBe(84532);
    expect(bundle.gasless.chainId).toBe(84532);
  });

  it('explicit mainnet → chainId 8453 + name "Base" + CD-12 consistency', async () => {
    const bundle = await createBaseAdapters({ network: 'mainnet' });
    expect(bundle.chainConfig.chainId).toBe(8453);
    expect(bundle.chainConfig.name).toBe('Base');
    expect(bundle.chainConfig.explorerUrl).toBe('https://basescan.org');
    expect(bundle.payment.chainId).toBe(8453);
    expect(bundle.attestation.chainId).toBe(8453);
    expect(bundle.gasless.chainId).toBe(8453);
  });

  it('identity is null (no identity binding in Base MVP)', async () => {
    const bundle = await createBaseAdapters({ network: 'testnet' });
    expect(bundle.identity).toBeNull();
  });

  it('BASE_NETWORK env=mainnet picks mainnet when opts.network absent (AC-4)', async () => {
    process.env.BASE_NETWORK = 'mainnet';
    const bundle = await createBaseAdapters();
    expect(bundle.chainConfig.chainId).toBe(8453);
  });

  it('BASE_NETWORK absent → testnet bundle (chainId 84532) (AC-5a)', async () => {
    delete process.env.BASE_NETWORK;
    const bundle = await createBaseAdapters();
    expect(bundle.chainConfig.chainId).toBe(84532);
  });

  it("CD-11 — BASE_NETWORK='devnet' → testnet + console.warn called once (AC-5b)", async () => {
    const warnSpy = logSpy.warn;
    warnSpy.mockClear();
    process.env.BASE_NETWORK = 'devnet';

    const b1 = await createBaseAdapters();
    expect(b1.chainConfig.chainId).toBe(84532);

    // Second call should NOT re-warn (warn-once semantics)
    const b2 = await createBaseAdapters();
    expect(b2.chainConfig.chainId).toBe(84532);

    // object-first / message-second: the human message (arg[1]) mentions
    // BASE_NETWORK; the offending value lives in the structured ctx (arg[0]).
    const baseWarns = warnSpy.mock.calls.filter((args) =>
      String(args[1]).includes('BASE_NETWORK'),
    );
    expect(baseWarns.length).toBe(1);
    expect(baseWarns[0]![0]).toEqual(
      expect.objectContaining({ env: 'devnet' }),
    );
  });
});

describe('Base payment adapter — contract', () => {
  let adapter: BasePaymentAdapter;

  beforeEach(() => {
    _resetWalletClient();
    _resetBaseChain();
    vi.clearAllMocks();
    delete process.env.BASE_SEPOLIA_USDC_ADDRESS;
    delete process.env.BASE_MAINNET_USDC_ADDRESS;
    process.env.OPERATOR_PRIVATE_KEY =
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
    adapter = new BasePaymentAdapter({ network: 'testnet' });
  });

  afterEach(() => {
    delete process.env.OPERATOR_PRIVATE_KEY;
    delete process.env.WASIAI_MERCHANT_NAME;
    delete process.env.BASE_FACILITATOR_URL;
    delete process.env.CDP_FACILITATOR_URL;
    delete process.env.WASIAI_FACILITATOR_URL;
  });

  it('name is "base"', () => {
    expect(adapter.name).toBe('base');
  });

  it('testnet adapter → chainId 84532', () => {
    expect(adapter.chainId).toBe(84532);
  });

  it('mainnet adapter → chainId 8453', () => {
    const m = new BasePaymentAdapter({ network: 'mainnet' });
    expect(m.chainId).toBe(8453);
  });

  it('getScheme() returns "exact"', () => {
    expect(adapter.getScheme()).toBe('exact');
  });

  it('getNetwork() testnet → "eip155:84532"', () => {
    expect(adapter.getNetwork()).toBe('eip155:84532');
  });

  it('getNetwork() mainnet → "eip155:8453"', () => {
    const m = new BasePaymentAdapter({ network: 'mainnet' });
    expect(m.getNetwork()).toBe('eip155:8453');
  });

  it('supportedTokens[0] → USDC, 6 decimals, Base Sepolia default address', () => {
    expect(adapter.supportedTokens).toHaveLength(1);
    expect(adapter.supportedTokens[0]!.symbol).toBe('USDC');
    expect(adapter.supportedTokens[0]!.decimals).toBe(6);
    expect(adapter.supportedTokens[0]!.address.toLowerCase()).toBe(
      BASE_SEPOLIA_USDC_DEFAULT.toLowerCase(),
    );
  });

  it('supportedTokens mainnet → Base Mainnet USDC default', () => {
    const m = new BasePaymentAdapter({ network: 'mainnet' });
    expect(m.supportedTokens[0]!.address.toLowerCase()).toBe(
      BASE_MAINNET_USDC_DEFAULT.toLowerCase(),
    );
  });

  it('getToken() respects BASE_SEPOLIA_USDC_ADDRESS env override', () => {
    const customToken = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    process.env.BASE_SEPOLIA_USDC_ADDRESS = customToken;
    expect(adapter.getToken().toLowerCase()).toBe(customToken.toLowerCase());
  });

  it('getToken() respects BASE_MAINNET_USDC_ADDRESS env override (mainnet)', () => {
    const customToken = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    process.env.BASE_MAINNET_USDC_ADDRESS = customToken;
    const m = new BasePaymentAdapter({ network: 'mainnet' });
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

  it('sign() — AC-3 — EIP-712 domain uses chainId 84532 + verifyingContract = USDC Sepolia default', async () => {
    const result = await adapter.sign({
      to: '0x000000000000000000000000000000000000dEaD' as `0x${string}`,
      value: '1000000',
    });
    expect(result).toHaveProperty('xPaymentHeader');
    expect(result).toHaveProperty('paymentRequest');
    expect(result.paymentRequest.network).toBe('eip155:84532');
    expect(result.paymentRequest.authorization.to).toBe(
      '0x000000000000000000000000000000000000dEaD',
    );
    expect(result.paymentRequest.authorization.value).toBe('1000000');

    // Inspect the mocked signTypedData call to assert domain shape.
    const viem = await import('viem');
    const cwc = viem.createWalletClient as ReturnType<typeof vi.fn>;
    const clientInstance = cwc.mock.results[0]?.value as {
      signTypedData: ReturnType<typeof vi.fn>;
    };
    const callArgs = clientInstance.signTypedData.mock.calls[0]?.[0] as {
      domain: {
        name: string;
        version: string;
        chainId: number;
        verifyingContract: string;
      };
    };
    expect(callArgs.domain.chainId).toBe(84532);
    expect(callArgs.domain.name).toBe('USDC'); // Base Sepolia uses 'USDC', NOT 'USD Coin' (§2.3)
    expect(callArgs.domain.version).toBe('2');
    expect(callArgs.domain.verifyingContract.toLowerCase()).toBe(
      BASE_SEPOLIA_USDC_DEFAULT.toLowerCase(),
    );
  });

  it('sign() mainnet uses EIP-712 name "USD Coin" (Base Mainnet)', async () => {
    const m = new BasePaymentAdapter({ network: 'mainnet' });
    await m.sign({
      to: '0x000000000000000000000000000000000000dEaD' as `0x${string}`,
      value: '1000000',
    });
    const viem = await import('viem');
    const cwc = viem.createWalletClient as ReturnType<typeof vi.fn>;
    const callArgs = (
      cwc.mock.results.at(-1)?.value as {
        signTypedData: ReturnType<typeof vi.fn>;
      }
    ).signTypedData.mock.calls.at(-1)?.[0] as {
      domain: { name: string; chainId: number };
    };
    expect(callArgs.domain.name).toBe('USD Coin'); // Base Mainnet
    expect(callArgs.domain.chainId).toBe(8453);
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
      network: 'eip155:84532',
    });
    expect(result.valid).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toMatch(/\/verify$/);
    expect((init as { method: string }).method).toBe('POST');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.x402Version).toBe(2);
    expect(body.accepted.scheme).toBe('exact');
    expect(body.accepted.network).toBe('eip155:84532');
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
      network: 'eip155:84532',
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
      network: 'eip155:84532',
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
      network: 'eip155:84532',
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
      network: 'eip155:84532',
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('no balance');
  });

  it('uses BASE_FACILITATOR_URL when set (priority 1)', async () => {
    process.env.BASE_FACILITATOR_URL = 'https://base-facilitator.test';
    process.env.CDP_FACILITATOR_URL = 'https://cdp.test';
    process.env.WASIAI_FACILITATOR_URL = 'https://wasiai.test';
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
      network: 'eip155:84532',
    });
    expect(mockFetch.mock.calls[0]![0]).toBe(
      'https://base-facilitator.test/verify',
    );
  });

  it('falls back to CDP_FACILITATOR_URL when BASE_FACILITATOR_URL absent (priority 2)', async () => {
    delete process.env.BASE_FACILITATOR_URL;
    process.env.CDP_FACILITATOR_URL = 'https://cdp-facilitator.test';
    process.env.WASIAI_FACILITATOR_URL = 'https://wasiai.test';
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
      network: 'eip155:84532',
    });
    expect(mockFetch.mock.calls[0]![0]).toBe(
      'https://cdp-facilitator.test/verify',
    );
  });

  it('falls back to WASIAI_FACILITATOR_URL when BASE+CDP absent (priority 3)', async () => {
    delete process.env.BASE_FACILITATOR_URL;
    delete process.env.CDP_FACILITATOR_URL;
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
      network: 'eip155:84532',
    });
    expect(mockFetch.mock.calls[0]![0]).toBe(
      'https://shared-facilitator.test/verify',
    );
  });

  it('quote() returns QuoteResult with USDC token (6 decimals)', async () => {
    const result = await adapter.quote(1.0);
    expect(result.token.symbol).toBe('USDC');
    expect(result.token.decimals).toBe(6);
    expect(result.token.address.toLowerCase()).toBe(
      BASE_SEPOLIA_USDC_DEFAULT.toLowerCase(),
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
    // 1e-7 USDC is below the 6-decimal grid → floors to 0 atomic (no crash).
    expect(result?.amountWei).toBe('0');
  });

  it('quote(0.0000012) → 1 atomic (>=1, no throw)', async () => {
    const result = await adapter.quote(0.0000012);
    expect(result.amountWei).toBe('1');
  });
});

describe('Base gasless adapter — EIP-3009 operator-relayed (WKH-138)', () => {
  const TO = '0x000000000000000000000000000000000000dEaD' as `0x${string}`;
  const TX_HASH = `0x${'ab'.repeat(32)}` as `0x${string}`;

  beforeEach(() => {
    _resetWalletClient();
    _resetBaseChain();
    _resetBaseGasless();
    mockWriteContract.mockReset();
    mockWaitForReceipt.mockReset();
    mockReadContract.mockReset();
    mockSignTypedData.mockReset();
    mockSignTypedData.mockResolvedValue(VALID_SIG);
    delete process.env.GASLESS_ENABLED;
    delete process.env.USDC_USD_RATE;
    delete process.env.GASLESS_DEFAULT_CAP_USD;
    delete process.env.BASE_SEPOLIA_USDC_ADDRESS;
    delete process.env.BASE_MAINNET_USDC_ADDRESS;
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

    const adapter = new BaseGaslessAdapter(84532);
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

  // ── T-SIGN: EIP-712 name differs per network (Sepolia "USDC") ─────────────
  it('T-AC1: sign domain uses network-specific EIP-712 name (Sepolia = "USDC")', async () => {
    mockWriteContract.mockResolvedValue(TX_HASH);
    mockWaitForReceipt.mockResolvedValue({ status: 'success' });
    const adapter = new BaseGaslessAdapter(84532);
    await adapter.transfer({ to: TO, value: 1_000_000n });
    expect(mockSignTypedData.mock.calls[0]![0].domain.name).toBe('USDC');
  });

  it('T-AC1: sign domain uses network-specific EIP-712 name (Mainnet = "USD Coin")', async () => {
    mockWriteContract.mockResolvedValue(TX_HASH);
    mockWaitForReceipt.mockResolvedValue({ status: 'success' });
    const adapter = new BaseGaslessAdapter(8453);
    await adapter.transfer({ to: TO, value: 1_000_000n });
    expect(mockSignTypedData.mock.calls[0]![0].domain.name).toBe('USD Coin');
  });

  // ── T-DRAIN-CAP (adapter-level, CD-5): value > cap → throw BEFORE submit ──
  it('T-DRAIN-CAP: value over per-call cap throws before writeContract', async () => {
    process.env.GASLESS_DEFAULT_CAP_USD = '10';
    const adapter = new BaseGaslessAdapter(84532);
    await expect(
      adapter.transfer({ to: TO, value: 50_000_000n }), // $50 > $10
    ).rejects.toBeInstanceOf(GaslessTransferError);
    expect(mockWriteContract).not.toHaveBeenCalled();
    expect(mockSignTypedData).not.toHaveBeenCalled();
  });

  it('T-DRAIN-CAP: overflow value (fail-closed +Infinity) throws before submit', async () => {
    const adapter = new BaseGaslessAdapter(84532);
    await expect(
      adapter.transfer({ to: TO, value: 2n ** 60n }),
    ).rejects.toBeInstanceOf(GaslessTransferError);
    expect(mockWriteContract).not.toHaveBeenCalled();
  });

  // ── T-SIGN-INVALID (CD-8): writeContract reject / revert / timeout ────────
  it('T-SIGN-INVALID: writeContract reject → GaslessTransferError, no txHash fabricated', async () => {
    mockWriteContract.mockRejectedValue(new Error('nonce already used'));
    const adapter = new BaseGaslessAdapter(84532);
    await expect(
      adapter.transfer({ to: TO, value: 1_000_000n }),
    ).rejects.toBeInstanceOf(GaslessTransferError);
    expect(mockWaitForReceipt).not.toHaveBeenCalled();
  });

  it('T-SIGN-INVALID: receipt status reverted → GaslessTransferError', async () => {
    mockWriteContract.mockResolvedValue(TX_HASH);
    mockWaitForReceipt.mockResolvedValue({ status: 'reverted' });
    const adapter = new BaseGaslessAdapter(84532);
    await expect(
      adapter.transfer({ to: TO, value: 1_000_000n }),
    ).rejects.toThrow(/reverted/);
  });

  it('T-SIGN-INVALID: receipt timeout (WaitForTransactionReceiptTimeoutError) → GaslessTransferError', async () => {
    mockWriteContract.mockResolvedValue(TX_HASH);
    mockWaitForReceipt.mockRejectedValue(
      new WaitForTransactionReceiptTimeoutError({ hash: TX_HASH }),
    );
    const adapter = new BaseGaslessAdapter(84532);
    await expect(
      adapter.transfer({ to: TO, value: 1_000_000n }),
    ).rejects.toThrow(/timeout/);
  });

  // ── T-AC3: status() funding_state per enabled/pk/balance ──────────────────
  it('T-AC3: status() → disabled when GASLESS_ENABLED != true', async () => {
    const adapter = new BaseGaslessAdapter(84532);
    const status = await adapter.status();
    expect(status.enabled).toBe(false);
    expect(status.funding_state).toBe('disabled');
    expect(status.network).toBe('base-sepolia');
    expect(status.chain_id).toBe(84532);
    expect(status.supportedToken).toBeNull();
    expect(status.operatorAddress).toBeNull();
  });

  it('T-AC3: status() → unconfigured when enabled but no OPERATOR_PRIVATE_KEY', async () => {
    process.env.GASLESS_ENABLED = 'true';
    delete process.env.OPERATOR_PRIVATE_KEY;
    const adapter = new BaseGaslessAdapter(84532);
    const status = await adapter.status();
    expect(status.enabled).toBe(true);
    expect(status.operatorAddress).toBeNull();
    expect(status.funding_state).toBe('unconfigured');
  });

  it('T-AC3: status() → unfunded when balance 0n', async () => {
    process.env.GASLESS_ENABLED = 'true';
    mockReadContract.mockResolvedValue(0n);
    const adapter = new BaseGaslessAdapter(84532);
    const status = await adapter.status();
    expect(status.funding_state).toBe('unfunded');
    expect(status.operatorAddress).not.toBeNull();
  });

  it('T-AC3: status() → unfunded when balanceOf RPC fails (fail-closed)', async () => {
    process.env.GASLESS_ENABLED = 'true';
    mockReadContract.mockRejectedValue(new Error('RPC down'));
    const adapter = new BaseGaslessAdapter(84532);
    const status = await adapter.status();
    expect(status.funding_state).toBe('unfunded');
  });

  it('T-AC3: status() → ready when balance > 0', async () => {
    process.env.GASLESS_ENABLED = 'true';
    mockReadContract.mockResolvedValue(5_000_000n);
    const adapter = new BaseGaslessAdapter(84532);
    const status = await adapter.status();
    expect(status.funding_state).toBe('ready');
  });

  // ── T-AC4: status() reports real USDC supportedToken ──────────────────────
  it('T-AC4: status() reports USDC supportedToken (6 decimals, real address)', async () => {
    process.env.GASLESS_ENABLED = 'true';
    mockReadContract.mockResolvedValue(5_000_000n);
    const adapter = new BaseGaslessAdapter(84532);
    const status = await adapter.status();
    expect(status.supportedToken).not.toBeNull();
    expect(status.supportedToken!.symbol).toBe('USDC');
    expect(status.supportedToken!.decimals).toBe(6);
    expect(status.supportedToken!.eip712Name).toBe('USDC'); // Sepolia
  });

  // ── T-DEC (CD-2): gasless token == payment adapter token, same network ────
  it('T-DEC: gasless supportedToken address/decimals == payment adapter (sepolia)', async () => {
    process.env.GASLESS_ENABLED = 'true';
    mockReadContract.mockResolvedValue(1n);
    const gasless = new BaseGaslessAdapter(84532);
    const payment = new BasePaymentAdapter({ network: 'testnet' });
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
    const gasless = new BaseGaslessAdapter(8453);
    const payment = new BasePaymentAdapter({ network: 'mainnet' });
    const status = await gasless.status();
    expect(status.network).toBe('base-mainnet');
    expect(status.supportedToken!.address.toLowerCase()).toBe(
      payment.getToken().toLowerCase(),
    );
    expect(status.supportedToken!.decimals).toBe(6);
  });
});

describe('Base attestation adapter — stub', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('attest() returns stub txHash + proofUrl and warns', async () => {
    const warnSpy = logSpy.warn;
    warnSpy.mockClear();
    const bundle = await createBaseAdapters({ network: 'testnet' });
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
    const bundle = await createBaseAdapters({ network: 'testnet' });
    expect(await bundle.attestation.verify({ txHash: '0xDEADBEEF' })).toBe(
      true,
    );
  });
});

describe('Base payment adapter — facilitator bearer auth (BASE-02)', () => {
  let adapter: BasePaymentAdapter;

  const AUTHORIZATION = {
    from: '0x1111111111111111111111111111111111111111',
    to: '0x2222222222222222222222222222222222222222',
    value: '1000000',
    validAfter: '0',
    validBefore: '9999999999',
    nonce: `0x${'a'.repeat(64)}`,
  } as const;

  beforeEach(() => {
    _resetWalletClient();
    _resetBaseChain();
    logSpy.warn.mockClear();
    mockFetch.mockReset();
    delete process.env.BASE_FACILITATOR_API_KEY;
    delete process.env.FACILITATOR_API_KEY;
    process.env.OPERATOR_PRIVATE_KEY =
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
    adapter = new BasePaymentAdapter({ network: 'testnet' });
  });

  afterEach(() => {
    delete process.env.BASE_FACILITATOR_API_KEY;
    delete process.env.FACILITATOR_API_KEY;
    delete process.env.OPERATOR_PRIVATE_KEY;
  });

  // T-AC1 — verify with BASE_FACILITATOR_API_KEY → bearer header (AC-1, AC-3, AC-6)
  it('verify() sends Authorization: Bearer when BASE_FACILITATOR_API_KEY set', async () => {
    process.env.BASE_FACILITATOR_API_KEY = 'test-facilitator-key';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ verified: true }),
    });
    await adapter.verify({
      authorization: AUTHORIZATION,
      signature: '0xSIG',
      network: 'eip155:84532',
    });
    const [, init] = mockFetch.mock.calls[0]!;
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('Bearer test-facilitator-key');
    expect(headers['Content-Type']).toBe('application/json');
  });

  // T-AC2 — settle with BASE_FACILITATOR_API_KEY → bearer header (AC-2, AC-3, AC-6)
  it('settle() sends Authorization: Bearer when BASE_FACILITATOR_API_KEY set', async () => {
    process.env.BASE_FACILITATOR_API_KEY = 'test-facilitator-key';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        settled: true,
        transactionHash: '0xDEADBEEF',
        blockNumber: 12345,
      }),
    });
    await adapter.settle({
      authorization: AUTHORIZATION,
      signature: '0xSIG',
      network: 'eip155:84532',
    });
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toMatch(/\/settle$/);
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('Bearer test-facilitator-key');
    expect(headers['Content-Type']).toBe('application/json');
  });

  // T-AC3a — fallback: only FACILITATOR_API_KEY set (AC-3)
  it('uses FACILITATOR_API_KEY when BASE_FACILITATOR_API_KEY absent', async () => {
    process.env.FACILITATOR_API_KEY = 'shared-key';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ verified: true }),
    });
    await adapter.verify({
      authorization: AUTHORIZATION,
      signature: '0xSIG',
      network: 'eip155:84532',
    });
    const [, init] = mockFetch.mock.calls[0]!;
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('Bearer shared-key');
  });

  // T-AC3b — precedence: both set → BASE_* wins (AC-3)
  it('prefers BASE_FACILITATOR_API_KEY over FACILITATOR_API_KEY when both set', async () => {
    process.env.BASE_FACILITATOR_API_KEY = 'base-key';
    process.env.FACILITATOR_API_KEY = 'shared-key';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ verified: true }),
    });
    await adapter.verify({
      authorization: AUTHORIZATION,
      signature: '0xSIG',
      network: 'eip155:84532',
    });
    const [, init] = mockFetch.mock.calls[0]!;
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('Bearer base-key');
  });

  // T-AC4 — no key → header absent, verify + settle complete without throw (AC-4)
  it('omits Authorization header when no key set (verify + settle complete)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ verified: true }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ settled: true, transactionHash: '0xABC' }),
    });
    const verifyResult = await adapter.verify({
      authorization: AUTHORIZATION,
      signature: '0xSIG',
      network: 'eip155:84532',
    });
    const settleResult = await adapter.settle({
      authorization: AUTHORIZATION,
      signature: '0xSIG',
      network: 'eip155:84532',
    });
    expect(verifyResult.valid).toBe(true);
    expect(settleResult.success).toBe(true);
    const verifyHeaders = (
      mockFetch.mock.calls[0]![1] as { headers: Record<string, string> }
    ).headers;
    const settleHeaders = (
      mockFetch.mock.calls[1]![1] as { headers: Record<string, string> }
    ).headers;
    expect(verifyHeaders.Authorization).toBeUndefined();
    expect(settleHeaders.Authorization).toBeUndefined();
  });

  // T-AC4-empty — empty-string key → header omitted (no `Bearer `) (AC-4, DT-6)
  it('omits Authorization header when key is empty string', async () => {
    process.env.BASE_FACILITATOR_API_KEY = '';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ verified: true }),
    });
    await adapter.verify({
      authorization: AUTHORIZATION,
      signature: '0xSIG',
      network: 'eip155:84532',
    });
    const [, init] = mockFetch.mock.calls[0]!;
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBeUndefined();
  });

  // T-AC5 — key never leaks into body nor error (AC-5, CD-2)
  it('never includes the key in the serialized body nor in error messages', async () => {
    process.env.BASE_FACILITATOR_API_KEY = 'test-facilitator-key';
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({
        error: { code: 'INTERNAL', message: 'boom', http: 500 },
      }),
    });
    const result = await adapter.verify({
      authorization: AUTHORIZATION,
      signature: '0xSIG',
      network: 'eip155:84532',
    });
    const [, init] = mockFetch.mock.calls[0]!;
    const rawBody = (init as { body: string }).body;
    expect(rawBody).not.toContain('test-facilitator-key');
    expect(result.error ?? '').not.toContain('test-facilitator-key');
  });

  // T-AC7 — adapter source no longer carries the stale BASE-01 caveat (AC-7)
  it('adapter source no longer contains the stale BASE-01 caveat', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../base/payment.ts', import.meta.url)),
      'utf-8',
    );
    expect(src).not.toContain('NO soporta Base RPC');
    expect(src).not.toContain('DT-11');
  });
});
