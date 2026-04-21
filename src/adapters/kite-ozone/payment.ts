import { randomBytes } from 'node:crypto';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type {
  PieverseSettleRequest,
  PieverseSettleResult,
  PieverseVerifyRequest,
  PieverseVerifyResponse,
  X402PaymentRequest,
} from '../../types/index.js';
import type {
  PaymentAdapter,
  QuoteResult,
  SettleRequest,
  SettleResult,
  SignRequest,
  SignResult,
  TokenSpec,
  VerifyResult,
  X402Proof,
} from '../types.js';
import { kiteTestnet } from './chain.js';

const KITE_SCHEME = 'exact' as const;
const KITE_NETWORK = 'eip155:2368' as const;
const KITE_MAX_TIMEOUT_SECONDS = 300 as const;
const KITE_FACILITATOR_DEFAULT_URL = 'https://facilitator.pieverse.io';
const KITE_FACILITATOR_ADDRESS =
  '0x12343e649e6b2b2b77649DFAb88f103c02F3C78b' as `0x${string}`;

// ── Defaults for env-driven configuration (CD-1: no hardcoded addresses in logic) ──
const DEFAULT_PAYMENT_TOKEN =
  '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9' as `0x${string}`;
const DEFAULT_EIP712_DOMAIN_NAME = 'PYUSD';
const DEFAULT_EIP712_DOMAIN_VERSION = '1';
const DEFAULT_TOKEN_SYMBOL = 'PYUSD';

// ── Lazy env-var readers (DT-2: read at call time, not module load) ──

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
let _warnedDefaultToken = false;

function getPaymentToken(): `0x${string}` {
  const token = process.env.X402_PAYMENT_TOKEN;
  if (!token) {
    if (!_warnedDefaultToken) {
      console.warn(
        `X402_PAYMENT_TOKEN not set — defaulting to PYUSD (${DEFAULT_PAYMENT_TOKEN})`,
      );
      _warnedDefaultToken = true;
    }
    return DEFAULT_PAYMENT_TOKEN;
  }
  if (!ADDRESS_RE.test(token)) {
    if (!_warnedDefaultToken) {
      console.warn(
        `X402_PAYMENT_TOKEN has invalid format "${token}" — defaulting to PYUSD (${DEFAULT_PAYMENT_TOKEN})`,
      );
      _warnedDefaultToken = true;
    }
    return DEFAULT_PAYMENT_TOKEN;
  }
  return token as `0x${string}`;
}

function getEip712Domain() {
  return {
    name:
      process.env.X402_EIP712_DOMAIN_NAME ?? DEFAULT_EIP712_DOMAIN_NAME,
    version:
      process.env.X402_EIP712_DOMAIN_VERSION ?? DEFAULT_EIP712_DOMAIN_VERSION,
    chainId: kiteTestnet.id,
    verifyingContract: KITE_FACILITATOR_ADDRESS,
  } as const;
}

function getTokenSymbol(): string {
  return process.env.X402_TOKEN_SYMBOL ?? DEFAULT_TOKEN_SYMBOL;
}

const EIP712_TYPES = {
  Authorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

let _walletClient: ReturnType<typeof createWalletClient> | null = null;

function getWalletClient() {
  if (_walletClient) return _walletClient;
  const pk = process.env.OPERATOR_PRIVATE_KEY;
  if (!pk)
    throw new Error(
      'OPERATOR_PRIVATE_KEY not set — x402 client signing disabled',
    );
  const account = privateKeyToAccount(pk as `0x${string}`);
  _walletClient = createWalletClient({
    account,
    chain: kiteTestnet,
    transport: http(process.env.KITE_RPC_URL),
  });
  return _walletClient;
}

export class KiteOzonePaymentAdapter implements PaymentAdapter {
  readonly name = 'kite-ozone';
  readonly chainId = 2368;

  get supportedTokens(): TokenSpec[] {
    const token = getPaymentToken();
    return [
      { symbol: getTokenSymbol(), address: token, decimals: 18 },
    ];
  }

  getScheme(): string {
    return KITE_SCHEME;
  }
  getNetwork(): string {
    return KITE_NETWORK;
  }
  getToken(): `0x${string}` {
    return getPaymentToken();
  }
  getMaxTimeoutSeconds(): number {
    return KITE_MAX_TIMEOUT_SECONDS;
  }
  getMerchantName(): string {
    return process.env.KITE_MERCHANT_NAME ?? 'WasiAI';
  }

  async verify(proof: X402Proof): Promise<VerifyResult> {
    const facilitatorUrl =
      process.env.KITE_FACILITATOR_URL ?? KITE_FACILITATOR_DEFAULT_URL;
    const token = getPaymentToken();
    const body: PieverseVerifyRequest = {
      paymentPayload: {
        x402Version: 2,
        scheme: KITE_SCHEME,
        network: KITE_NETWORK,
        payload: {
          authorization: proof.authorization,
          signature: proof.signature,
        },
      },
      paymentRequirements: {
        x402Version: 2,
        scheme: KITE_SCHEME,
        network: KITE_NETWORK,
        maxAmountRequired: proof.authorization.value,
        payTo: proof.authorization.to,
        asset: token,
        extra: null,
      },
    };
    let response: Response;
    try {
      response = await fetch(`${facilitatorUrl}/v2/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(
        `Facilitator network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!response.ok)
      throw new Error(
        `Facilitator returned HTTP ${response.status} on /v2/verify`,
      );
    const result = (await response.json()) as PieverseVerifyResponse;
    return { valid: result.valid, error: result.error };
  }

  async settle(req: SettleRequest): Promise<SettleResult> {
    const facilitatorUrl =
      process.env.KITE_FACILITATOR_URL ?? KITE_FACILITATOR_DEFAULT_URL;
    const token = getPaymentToken();
    const body: PieverseSettleRequest = {
      paymentPayload: {
        x402Version: 2,
        scheme: KITE_SCHEME,
        network: KITE_NETWORK,
        payload: { authorization: req.authorization, signature: req.signature },
      },
      paymentRequirements: {
        x402Version: 2,
        scheme: KITE_SCHEME,
        network: KITE_NETWORK,
        maxAmountRequired: req.authorization.value,
        payTo: req.authorization.to,
        asset: token,
        extra: null,
      },
    };
    let response: Response;
    try {
      response = await fetch(`${facilitatorUrl}/v2/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(
        `Facilitator network error on settle: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!response.ok)
      throw new Error(
        `Facilitator returned HTTP ${response.status} on /v2/settle`,
      );
    const result = (await response.json()) as PieverseSettleResult;
    return {
      txHash: result.txHash,
      success: result.success,
      error: result.error,
    };
  }

  async quote(_amountUsd: number): Promise<QuoteResult> {
    const token = getPaymentToken();
    return {
      amountWei: '1000000000000000000',
      token: { symbol: getTokenSymbol(), address: token, decimals: 18 },
      facilitatorUrl:
        process.env.KITE_FACILITATOR_URL ?? KITE_FACILITATOR_DEFAULT_URL,
    };
  }

  async sign(opts: SignRequest): Promise<SignResult> {
    const client = getWalletClient();
    if (!client.account) throw new Error('Wallet client has no account');
    const account = client.account;
    const now = Math.floor(Date.now() / 1000);
    const nonce = `0x${randomBytes(32).toString('hex')}` as `0x${string}`;
    const authorization = {
      from: account.address,
      to: opts.to,
      value: opts.value,
      validAfter: '0',
      validBefore: String(now + (opts.timeoutSeconds ?? 300)),
      nonce,
    };
    const domain = getEip712Domain();
    const signature = await client.signTypedData({
      account,
      domain,
      types: EIP712_TYPES,
      primaryType: 'Authorization',
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce as `0x${string}`,
      },
    });
    const paymentRequest: X402PaymentRequest = {
      authorization,
      signature,
      network: KITE_NETWORK,
    };
    const xPaymentHeader = Buffer.from(JSON.stringify(paymentRequest)).toString(
      'base64',
    );
    return { xPaymentHeader, paymentRequest };
  }
}

export function _resetWalletClient(): void {
  _walletClient = null;
  _warnedDefaultToken = false;
}
