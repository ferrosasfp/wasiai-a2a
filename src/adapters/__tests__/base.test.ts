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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createWalletClient: vi.fn(() => ({
      account: { address: '0x1234567890123456789012345678901234567890' },
      signTypedData: vi.fn().mockResolvedValue(`0x${'ab'.repeat(65)}`),
    })),
  };
});

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { _resetBaseChain } from '../base/chain.js';
import { createBaseAdapters } from '../base/index.js';
import { _resetWalletClient, BasePaymentAdapter } from '../base/payment.js';

const BASE_SEPOLIA_USDC_DEFAULT = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const BASE_MAINNET_USDC_DEFAULT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

describe('Base adapter — factory shape', () => {
  beforeEach(() => {
    _resetWalletClient();
    _resetBaseChain();
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.BASE_NETWORK = 'devnet';

    const b1 = await createBaseAdapters();
    expect(b1.chainConfig.chainId).toBe(84532);

    // Second call should NOT re-warn (warn-once semantics)
    const b2 = await createBaseAdapters();
    expect(b2.chainConfig.chainId).toBe(84532);

    const baseWarns = warnSpy.mock.calls.filter((args) =>
      String(args[0]).includes('BASE_NETWORK'),
    );
    expect(baseWarns.length).toBe(1);
    expect(String(baseWarns[0][0])).toContain('devnet');
  });
});

describe('Base payment adapter — contract', () => {
  let adapter: BasePaymentAdapter;

  beforeEach(() => {
    _resetWalletClient();
    _resetBaseChain();
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    expect(adapter.supportedTokens[0].symbol).toBe('USDC');
    expect(adapter.supportedTokens[0].decimals).toBe(6);
    expect(adapter.supportedTokens[0].address.toLowerCase()).toBe(
      BASE_SEPOLIA_USDC_DEFAULT.toLowerCase(),
    );
  });

  it('supportedTokens mainnet → Base Mainnet USDC default', () => {
    const m = new BasePaymentAdapter({ network: 'mainnet' });
    expect(m.supportedTokens[0].address.toLowerCase()).toBe(
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
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toMatch(/\/verify$/);
    expect((init as { method: string }).method).toBe('POST');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.x402Version).toBe(2);
    expect(body.accepted.scheme).toBe('exact');
    expect(body.accepted.network).toBe('eip155:84532');
    expect(body.accepted.maxTimeoutSeconds).toBe(60);
    expect(body.accepted.extra.assetTransferMethod).toBe('eip3009');
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
    const [url] = mockFetch.mock.calls[0];
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
    expect(mockFetch.mock.calls[0][0]).toBe(
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
    expect(mockFetch.mock.calls[0][0]).toBe(
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
    expect(mockFetch.mock.calls[0][0]).toBe(
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
});

describe('Base gasless adapter — stub', () => {
  beforeEach(() => {
    _resetWalletClient();
    _resetBaseChain();
    vi.clearAllMocks();
  });

  it('status() returns disabled on testnet', async () => {
    const bundle = await createBaseAdapters({ network: 'testnet' });
    const status = await bundle.gasless.status();
    expect(status.enabled).toBe(false);
    expect(status.funding_state).toBe('disabled');
    expect(status.network).toBe('base-sepolia');
    expect(status.chain_id).toBe(84532);
    expect(status.supportedToken).toBeNull();
    expect(status.operatorAddress).toBeNull();
  });

  it('status() returns disabled on mainnet', async () => {
    const bundle = await createBaseAdapters({ network: 'mainnet' });
    const status = await bundle.gasless.status();
    expect(status.enabled).toBe(false);
    expect(status.network).toBe('base-mainnet');
    expect(status.chain_id).toBe(8453);
  });

  it('transfer() throws (not implemented — pending CDP)', async () => {
    const bundle = await createBaseAdapters({ network: 'testnet' });
    await expect(
      bundle.gasless.transfer({
        to: '0x000000000000000000000000000000000000dEaD' as `0x${string}`,
        value: 1000000n,
      }),
    ).rejects.toThrow('Base gasless not implemented');
  });
});

describe('Base attestation adapter — stub', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('attest() returns stub txHash + proofUrl and warns', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    warnSpy.mockRestore();
  });

  it('verify() returns true (stub)', async () => {
    const bundle = await createBaseAdapters({ network: 'testnet' });
    expect(await bundle.attestation.verify({ txHash: '0xDEADBEEF' })).toBe(
      true,
    );
  });
});
