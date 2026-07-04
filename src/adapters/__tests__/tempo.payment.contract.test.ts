/**
 * Contract tests for the Tempo rail (WKH-090 / HU-090).
 *
 * Mirror de `payment.contract.test.ts` / `base.test.ts`. Verifica que
 * `TempoPaymentAdapter` implementa `PaymentAdapter` reusando el contrato x402
 * compartido (CD-3 / DT-1) — sin tipo de proof paralelo — más el attestation
 * stub (Receipt) y el gasless stub deshabilitado (DT-7).
 *
 * Todos los tests mockean `fetch` + `viem.createWalletClient` + `getLogger`, así
 * que NO dependen de valores on-chain reales de Tempo ([VERIFY-AT-IMPL]).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Structured logger mock ─────────────────────────────────
const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../../lib/logger.js', () => ({
  getLogger: () => logSpy,
}));

// Mock viem wallet client (sign path).
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

import { GaslessNotSupportedError } from '../errors.js';
import { TempoAttestationAdapter } from '../tempo/attestation.js';
import { TempoGaslessAdapter } from '../tempo/gasless.js';
import { _resetWalletClient, TempoPaymentAdapter } from '../tempo/payment.js';
import type { PaymentAdapter } from '../types.js';

const TEMPO_CHAIN_ID = 42429;
const ALPHAUSD_DEFAULT = '0x20c0000000000000000000000000000000000001';

describe('TempoPaymentAdapter — contract (WKH-090)', () => {
  let adapter: PaymentAdapter;

  beforeEach(() => {
    adapter = new TempoPaymentAdapter({ network: 'testnet' });
    _resetWalletClient();
    vi.clearAllMocks();
    process.env.OPERATOR_PRIVATE_KEY =
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
    process.env.TEMPO_TESTNET_USD_ADDRESS = ALPHAUSD_DEFAULT;
  });

  afterEach(() => {
    delete process.env.OPERATOR_PRIVATE_KEY;
    delete process.env.TEMPO_TESTNET_USD_ADDRESS;
    delete process.env.TEMPO_TESTNET_USD_EIP712_NAME;
    delete process.env.TEMPO_TESTNET_USD_EIP712_VERSION;
    delete process.env.WASIAI_MERCHANT_NAME;
    delete process.env.TEMPO_FACILITATOR_URL;
    delete process.env.WASIAI_FACILITATOR_URL;
  });

  it('implements PaymentAdapter with name "tempo"', () => {
    expect(adapter.name).toBe('tempo');
  });

  it(`has chainId ${TEMPO_CHAIN_ID}`, () => {
    expect(adapter.chainId).toBe(TEMPO_CHAIN_ID);
  });

  it('getScheme() returns "exact"', () => {
    expect(adapter.getScheme()).toBe('exact');
  });

  it(`getNetwork() → "eip155:${TEMPO_CHAIN_ID}"`, () => {
    expect(adapter.getNetwork()).toBe(`eip155:${TEMPO_CHAIN_ID}`);
  });

  it('supportedTokens[0] → AlphaUSD, 6 decimals, default address', () => {
    expect(adapter.supportedTokens).toHaveLength(1);
    expect(adapter.supportedTokens[0]!.symbol).toBe('AlphaUSD');
    expect(adapter.supportedTokens[0]!.decimals).toBe(6);
    expect(adapter.supportedTokens[0]!.address.toLowerCase()).toBe(
      ALPHAUSD_DEFAULT.toLowerCase(),
    );
  });

  it('getToken() respects TEMPO_TESTNET_USD_ADDRESS env override', () => {
    const customToken = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    process.env.TEMPO_TESTNET_USD_ADDRESS = customToken;
    expect(adapter.getToken().toLowerCase()).toBe(customToken.toLowerCase());
  });

  it('getMaxTimeoutSeconds() returns 60', () => {
    expect(adapter.getMaxTimeoutSeconds()).toBe(60);
  });

  // ── AC-3 (Credential → settle): X402Proof puebla SettleRequest sin tipo paralelo ──
  it('settle() maps the Credential to SettleRequest and returns { txHash, success:true }', async () => {
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
      network: `eip155:${TEMPO_CHAIN_ID}`,
    });
    expect(result.txHash).toBe('0xDEADBEEF');
    expect(result.success).toBe(true);

    // Confirm the canonical x402 v2 envelope (Credential → payload).
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toMatch(/\/settle$/);
    const body = JSON.parse((init as { body: string }).body);
    expect(body.x402Version).toBe(2);
    expect(body.accepted.scheme).toBe('exact');
    expect(body.accepted.network).toBe(`eip155:${TEMPO_CHAIN_ID}`);
    expect(body.accepted.extra.assetTransferMethod).toBe('eip3009');
    expect(body.payload.signature).toBe('0xSIG');
  });

  // ── AC-3 (verify) ──
  it('verify() returns VerifyResult { valid:true } on facilitator OK', async () => {
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
      network: `eip155:${TEMPO_CHAIN_ID}`,
    });
    expect(result.valid).toBe(true);
    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toMatch(/\/verify$/);
  });

  // ── AC-3 (Challenge → quote): honra el USD real (money-path MNR-1) ──
  it('quote(1) → 1e6 atomic (1 AlphaUSD, 6 decimals) — NOT a hardcode', async () => {
    const result = await adapter.quote(1);
    expect(result.amountWei).toBe('1000000');
    expect(result.token.symbol).toBe('AlphaUSD');
    expect(result.token.address.toLowerCase()).toBe(
      ALPHAUSD_DEFAULT.toLowerCase(),
    );
  });

  it('quote(0.001) → 1e3 atomic, distinto de quote(1)', async () => {
    const small = await adapter.quote(0.001);
    const one = await adapter.quote(1);
    expect(small.amountWei).toBe('1000');
    expect(small.amountWei).not.toBe(one.amountWei);
  });

  // ── AC-3 (Challenge → sign) ──
  it('sign() returns { xPaymentHeader, paymentRequest } with authorization + signature', async () => {
    const result = await adapter.sign({
      to: '0x000000000000000000000000000000000000dEaD' as `0x${string}`,
      value: '1000000',
    });
    expect(typeof result.xPaymentHeader).toBe('string');
    expect(result.paymentRequest).toHaveProperty('authorization');
    expect(result.paymentRequest).toHaveProperty('signature');
    expect(result.paymentRequest.network).toBe(`eip155:${TEMPO_CHAIN_ID}`);
    expect(result.paymentRequest.authorization.value).toBe('1000000');
  });

  it('sign() EIP-712 domain uses chainId + AlphaUSD verifyingContract', async () => {
    await adapter.sign({
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
      domain: { name: string; chainId: number; verifyingContract: string };
    };
    expect(callArgs.domain.chainId).toBe(TEMPO_CHAIN_ID);
    expect(callArgs.domain.verifyingContract.toLowerCase()).toBe(
      ALPHAUSD_DEFAULT.toLowerCase(),
    );
  });
});

// ── AC-3 (Receipt → attest) ──
describe('TempoAttestationAdapter — stub (WKH-090)', () => {
  it('attest() maps the MPP Receipt → { txHash, proofUrl }', async () => {
    const att = new TempoAttestationAdapter(TEMPO_CHAIN_ID);
    const result = await att.attest({ type: 'settle', payload: {} });
    expect(result).toHaveProperty('txHash');
    expect(result).toHaveProperty('proofUrl');
  });

  it('name is "tempo" and chainId is wired', () => {
    const att = new TempoAttestationAdapter(TEMPO_CHAIN_ID);
    expect(att.name).toBe('tempo');
    expect(att.chainId).toBe(TEMPO_CHAIN_ID);
  });
});

// ── Gasless stub (DT-7) ──
describe('TempoGaslessAdapter — disabled stub (DT-7)', () => {
  it('transfer() rejects with GaslessNotSupportedError', async () => {
    const g = new TempoGaslessAdapter(TEMPO_CHAIN_ID);
    await expect(
      g.transfer({
        to: '0x000000000000000000000000000000000000dEaD' as `0x${string}`,
        value: 1n,
      }),
    ).rejects.toBeInstanceOf(GaslessNotSupportedError);
  });

  it('status() → enabled:false / funding_state:disabled / null token+operator', async () => {
    const g = new TempoGaslessAdapter(TEMPO_CHAIN_ID);
    const status = await g.status();
    expect(status.enabled).toBe(false);
    expect(status.funding_state).toBe('disabled');
    expect(status.supportedToken).toBeNull();
    expect(status.operatorAddress).toBeNull();
    expect(status.network).toBe('tempo-testnet');
    expect(status.chain_id).toBe(TEMPO_CHAIN_ID);
  });
});
