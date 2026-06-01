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

// ─── Mocks ───────────────────────────────────────────────────────────────
// `viem` partial mock — only `createWalletClient` is replaced (preserves
// real exports like `http`, `parseUnits`, etc).
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

import { createAvalancheAdapters } from '../avalanche/index.js';
import {
  _resetWalletClient,
  AvalanchePaymentAdapter,
} from '../avalanche/payment.js';

const FUJI_USDC_DEFAULT = '0x5425890298aed601595a70AB815c96711a31Bc65';
const AVALANCHE_USDC_DEFAULT = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E';

describe('Avalanche adapter — factory shape', () => {
  beforeEach(() => {
    _resetWalletClient();
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    expect(adapter.supportedTokens[0].symbol).toBe('USDC');
    expect(adapter.supportedTokens[0].decimals).toBe(6);
    expect(adapter.supportedTokens[0].address.toLowerCase()).toBe(
      FUJI_USDC_DEFAULT.toLowerCase(),
    );
  });

  it('supportedTokens mainnet → Avalanche C-Chain USDC default', () => {
    const m = new AvalanchePaymentAdapter({ network: 'mainnet' });
    expect(m.supportedTokens[0].address.toLowerCase()).toBe(
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
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toMatch(/\/verify$/);
    expect((init as { method: string }).method).toBe('POST');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.x402Version).toBe(2);
    expect(body.accepted.scheme).toBe('exact');
    expect(body.accepted.network).toBe('eip155:43113');
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
    const [url] = mockFetch.mock.calls[0];
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
    const [url] = mockFetch.mock.calls[0];
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
});

describe('Avalanche gasless adapter — stub', () => {
  beforeEach(() => {
    _resetWalletClient();
    vi.clearAllMocks();
  });

  it('status() returns disabled on fuji', async () => {
    const bundle = await createAvalancheAdapters({ network: 'fuji' });
    const status = await bundle.gasless.status();
    expect(status.enabled).toBe(false);
    expect(status.funding_state).toBe('disabled');
    expect(status.network).toBe('avalanche-fuji');
    expect(status.chain_id).toBe(43113);
    expect(status.supportedToken).toBeNull();
    expect(status.operatorAddress).toBeNull();
  });

  it('status() returns disabled on mainnet', async () => {
    const bundle = await createAvalancheAdapters({ network: 'mainnet' });
    const status = await bundle.gasless.status();
    expect(status.enabled).toBe(false);
    expect(status.network).toBe('avalanche-mainnet');
    expect(status.chain_id).toBe(43114);
  });

  it('transfer() throws (not implemented)', async () => {
    const bundle = await createAvalancheAdapters({ network: 'fuji' });
    await expect(
      bundle.gasless.transfer({
        to: '0x000000000000000000000000000000000000dEaD' as `0x${string}`,
        value: 1000000n,
      }),
    ).rejects.toThrow('Avalanche gasless not implemented');
  });
});

describe('Avalanche attestation adapter — stub', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('attest() returns stub txHash + proofUrl and warns', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    warnSpy.mockRestore();
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
    vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    const [url, init] = mockFetch.mock.calls[0];
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
    const [url, init] = mockFetch.mock.calls[0];
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
    const [, init] = mockFetch.mock.calls[0];
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
    const [, init] = mockFetch.mock.calls[0];
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
    const [, verifyInit] = mockFetch.mock.calls[0];
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
    const [, settleInit] = mockFetch.mock.calls[1];
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
    const [, init] = mockFetch.mock.calls[0];
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
    const [, init] = mockFetch.mock.calls[0];
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
