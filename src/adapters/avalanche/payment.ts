import { randomBytes } from 'node:crypto';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { X402PaymentRequest } from '../../types/index.js';
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
import { type AvalancheNetwork, getAvalancheChain } from './chain.js';

/**
 * Avalanche x402 payment adapter (WKH-MULTICHAIN / 086 W1).
 *
 * MIRROR EXACTO of `KiteOzonePaymentAdapter` restricted to **canonical x402**
 * mode only (CD-15: NO Pieverse mode). Signs EIP-3009 `TransferWithAuthorization`
 * against Circle USDC (Fuji or Avalanche C-Chain) and POSTs canonical x402 v2
 * envelopes to the WasiAI self-hosted facilitator.
 *
 * Network is fixed per-instance (constructor argument) — unlike the kite
 * adapter which reads `KITE_NETWORK` from env at runtime, here the factory
 * passes `network` explicitly to keep the instance immutable (DT-I rationale).
 */

const AVALANCHE_SCHEME = 'exact' as const;
const FUJI_CHAIN_ID = 43113 as const;
const AVALANCHE_CHAIN_ID = 43114 as const;
const FUJI_NETWORK_TAG = 'eip155:43113' as const;
const AVALANCHE_NETWORK_TAG = 'eip155:43114' as const;
type AvalancheNetworkTag =
  | typeof FUJI_NETWORK_TAG
  | typeof AVALANCHE_NETWORK_TAG;

const AVALANCHE_MAX_TIMEOUT_SECONDS = 60 as const;

// USDC contract addresses canonical Circle (mirror of downstream-payment.ts:46-52).
const DEFAULT_FUJI_USDC =
  '0x5425890298aed601595a70AB815c96711a31Bc65' as `0x${string}`;
const DEFAULT_AVALANCHE_USDC =
  '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E' as `0x${string}`;

// USDC EIP-712 domain — Circle USDC ABI identical on Fuji y Avalanche C-Chain.
const USDC_DECIMALS = 6 as const;
const USDC_EIP712_NAME = 'USD Coin' as const;
const USDC_EIP712_VERSION_DEFAULT = '2' as const;
const USDC_SYMBOL = 'USDC' as const;

// Facilitator URL fallback chain (DT-F):
//   AVALANCHE_FACILITATOR_URL > WASIAI_FACILITATOR_URL > hardcoded default.
const WASIAI_FACILITATOR_DEFAULT_URL =
  'https://wasiai-facilitator-production.up.railway.app';

// SEC-AR-2026-04-28 MNR-8: bound facilitator hangs.
const FACILITATOR_TIMEOUT_MS = 10_000;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

// ─── Module-level lazy state (per-process, not per-instance) ──────────
// One walletClient cached per network — mirrors kite-ozone/payment.ts pattern.
let _walletClientFuji: ReturnType<typeof createWalletClient> | null = null;
let _walletClientMainnet: ReturnType<typeof createWalletClient> | null = null;
let _warnedDefaultTokenFuji = false;
let _warnedDefaultTokenMainnet = false;

function getDefaultUsdcAddress(network: AvalancheNetwork): `0x${string}` {
  return network === 'mainnet' ? DEFAULT_AVALANCHE_USDC : DEFAULT_FUJI_USDC;
}

function getUsdcAddress(network: AvalancheNetwork): `0x${string}` {
  const fallback = getDefaultUsdcAddress(network);
  const env =
    network === 'mainnet'
      ? process.env.AVALANCHE_USDC_ADDRESS
      : process.env.FUJI_USDC_ADDRESS;
  if (!env) {
    if (network === 'mainnet') {
      if (!_warnedDefaultTokenMainnet) {
        _warnedDefaultTokenMainnet = true;
        console.warn(
          `[avalanche] AVALANCHE_USDC_ADDRESS not set — defaulting to USDC (${fallback})`,
        );
      }
    } else {
      if (!_warnedDefaultTokenFuji) {
        _warnedDefaultTokenFuji = true;
        console.warn(
          `[avalanche] FUJI_USDC_ADDRESS not set — defaulting to USDC (${fallback})`,
        );
      }
    }
    return fallback;
  }
  if (!ADDRESS_RE.test(env)) {
    if (network === 'mainnet') {
      if (!_warnedDefaultTokenMainnet) {
        _warnedDefaultTokenMainnet = true;
        console.warn(
          `[avalanche] AVALANCHE_USDC_ADDRESS has invalid format "${env}" — defaulting to USDC (${fallback})`,
        );
      }
    } else {
      if (!_warnedDefaultTokenFuji) {
        _warnedDefaultTokenFuji = true;
        console.warn(
          `[avalanche] FUJI_USDC_ADDRESS has invalid format "${env}" — defaulting to USDC (${fallback})`,
        );
      }
    }
    return fallback;
  }
  return env as `0x${string}`;
}

function getUsdcEip712Version(network: AvalancheNetwork): string {
  return network === 'mainnet'
    ? (process.env.AVALANCHE_USDC_EIP712_VERSION ?? USDC_EIP712_VERSION_DEFAULT)
    : (process.env.FUJI_USDC_EIP712_VERSION ?? USDC_EIP712_VERSION_DEFAULT);
}

function getRpcUrl(network: AvalancheNetwork): string | undefined {
  return network === 'mainnet'
    ? process.env.AVALANCHE_RPC_URL
    : process.env.FUJI_RPC_URL;
}

function getFacilitatorUrl(): string {
  return (
    process.env.AVALANCHE_FACILITATOR_URL ??
    process.env.WASIAI_FACILITATOR_URL ??
    WASIAI_FACILITATOR_DEFAULT_URL
  );
}

function getFacilitatorApiKey(): string | undefined {
  return (
    process.env.AVALANCHE_FACILITATOR_API_KEY?.trim() ||
    process.env.FACILITATOR_API_KEY?.trim() ||
    undefined
  );
}

function getWalletClient(network: AvalancheNetwork) {
  if (network === 'mainnet' && _walletClientMainnet)
    return _walletClientMainnet;
  if (network === 'fuji' && _walletClientFuji) return _walletClientFuji;
  const pk = process.env.OPERATOR_PRIVATE_KEY;
  if (!pk) {
    throw new Error(
      'OPERATOR_PRIVATE_KEY not set — avalanche x402 client signing disabled',
    );
  }
  const account = privateKeyToAccount(pk as `0x${string}`);
  const client = createWalletClient({
    account,
    chain: getAvalancheChain(network),
    transport: http(getRpcUrl(network)),
  });
  if (network === 'mainnet') {
    _walletClientMainnet = client;
  } else {
    _walletClientFuji = client;
  }
  return client;
}

// ─── x402 canonical body + facilitator helpers ──────────────────────────

interface X402VerifyResponse {
  verified?: boolean;
  client?: string;
  amount?: string;
  asset?: string;
  network?: string;
  payTo?: string;
  expiresAt?: number;
  error?: { code: string; message: string; http: number };
}

interface X402SettleResponse {
  settled?: boolean;
  transactionHash?: string;
  blockNumber?: number;
  amount?: string;
  from?: string;
  to?: string;
  asset?: string;
  error?: { code: string; message: string; http: number };
}

function getNetworkTag(network: AvalancheNetwork): AvalancheNetworkTag {
  return network === 'mainnet' ? AVALANCHE_NETWORK_TAG : FUJI_NETWORK_TAG;
}

function buildX402CanonicalBody(
  authorization: X402PaymentRequest['authorization'],
  signature: string,
  network: AvalancheNetwork,
): unknown {
  return {
    x402Version: 2,
    resource: {
      url: process.env.X402_RESOURCE_URL ?? 'https://wasiai.ai/pay',
    },
    accepted: {
      scheme: AVALANCHE_SCHEME,
      network: getNetworkTag(network),
      amount: authorization.value,
      asset: getUsdcAddress(network),
      payTo: authorization.to,
      maxTimeoutSeconds: AVALANCHE_MAX_TIMEOUT_SECONDS,
      extra: { assetTransferMethod: 'eip3009' },
    },
    payload: { signature, authorization },
  };
}

async function verifyX402(
  proof: X402Proof,
  network: AvalancheNetwork,
): Promise<VerifyResult> {
  const facilitatorUrl = getFacilitatorUrl();
  const body = buildX402CanonicalBody(
    proof.authorization,
    proof.signature,
    network,
  );
  const apiKey = getFacilitatorApiKey();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  let response: Response;
  try {
    response = await fetch(`${facilitatorUrl}/verify`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FACILITATOR_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      `Facilitator network error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = (await response
    .json()
    .catch(() => null)) as X402VerifyResponse | null;
  if (result === null) {
    throw new Error(
      `Facilitator returned HTTP ${response.status} on /verify (no JSON body)`,
    );
  }
  if (!response.ok) {
    return {
      valid: false,
      error: result.error?.message ?? `HTTP ${response.status}`,
    };
  }
  return { valid: result.verified === true, error: result.error?.message };
}

async function settleX402(
  req: SettleRequest,
  network: AvalancheNetwork,
): Promise<SettleResult> {
  const facilitatorUrl = getFacilitatorUrl();
  const body = buildX402CanonicalBody(
    req.authorization,
    req.signature,
    network,
  );
  const apiKey = getFacilitatorApiKey();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  let response: Response;
  try {
    response = await fetch(`${facilitatorUrl}/settle`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FACILITATOR_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      `Facilitator network error on settle: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = (await response
    .json()
    .catch(() => null)) as X402SettleResponse | null;
  if (result === null) {
    throw new Error(
      `Facilitator returned HTTP ${response.status} on /settle (no JSON body)`,
    );
  }
  if (!response.ok || result.settled !== true) {
    return {
      txHash: result?.transactionHash ?? '',
      success: false,
      error: result?.error?.message ?? `HTTP ${response.status}`,
    };
  }
  return {
    txHash: result.transactionHash ?? '',
    success: true,
  };
}

// ─── Adapter class ──────────────────────────────────────────────────────

export class AvalanchePaymentAdapter implements PaymentAdapter {
  readonly name = 'avalanche';
  readonly chainId: number;
  private readonly network: AvalancheNetwork;

  constructor(opts: { network: AvalancheNetwork }) {
    this.network = opts.network;
    this.chainId =
      opts.network === 'mainnet' ? AVALANCHE_CHAIN_ID : FUJI_CHAIN_ID;
  }

  get supportedTokens(): TokenSpec[] {
    return [
      {
        symbol: USDC_SYMBOL,
        address: getUsdcAddress(this.network),
        decimals: USDC_DECIMALS,
      },
    ];
  }

  getScheme(): string {
    return AVALANCHE_SCHEME;
  }

  getNetwork(): string {
    return getNetworkTag(this.network);
  }

  getToken(): `0x${string}` {
    return getUsdcAddress(this.network);
  }

  getMaxTimeoutSeconds(): number {
    return AVALANCHE_MAX_TIMEOUT_SECONDS;
  }

  getMerchantName(): string {
    return process.env.WASIAI_MERCHANT_NAME ?? 'WasiAI';
  }

  async verify(proof: X402Proof): Promise<VerifyResult> {
    return verifyX402(proof, this.network);
  }

  async settle(req: SettleRequest): Promise<SettleResult> {
    return settleX402(req, this.network);
  }

  async quote(_amountUsd: number): Promise<QuoteResult> {
    const token = getUsdcAddress(this.network);
    return {
      // 1 USDC = 1_000_000 atomic (6 decimals). String for safety.
      amountWei: '1000000',
      token: {
        symbol: USDC_SYMBOL,
        address: token,
        decimals: USDC_DECIMALS,
      },
      facilitatorUrl: getFacilitatorUrl(),
    };
  }

  async sign(opts: SignRequest): Promise<SignResult> {
    const client = getWalletClient(this.network);
    if (!client.account) throw new Error('Wallet client has no account');
    const account = client.account;
    const now = Math.floor(Date.now() / 1000);
    const nonce = `0x${randomBytes(32).toString('hex')}` as `0x${string}`;
    const authorization = {
      from: account.address,
      to: opts.to,
      value: opts.value,
      validAfter: '0',
      validBefore: String(
        now + (opts.timeoutSeconds ?? AVALANCHE_MAX_TIMEOUT_SECONDS),
      ),
      nonce,
    };

    // Mirror of downstream-payment.ts:564-584 — sign EIP-3009 against the USDC
    // token contract directly (verifyingContract = USDC address). Circle USDC
    // EIP-712 domain (`USD Coin` / version 2) is identical on Fuji y mainnet,
    // sólo varía chainId + verifyingContract.
    const token = getUsdcAddress(this.network);
    const signature = await client.signTypedData({
      account,
      domain: {
        name: USDC_EIP712_NAME,
        version: getUsdcEip712Version(this.network),
        chainId: this.chainId,
        verifyingContract: token,
      },
      types: EIP3009_TYPES,
      primaryType: 'TransferWithAuthorization',
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
      network: getNetworkTag(this.network),
    };
    const xPaymentHeader = Buffer.from(JSON.stringify(paymentRequest)).toString(
      'base64',
    );
    return { xPaymentHeader, paymentRequest };
  }
}

/**
 * TEST-ONLY — clears cached wallet clients + warn-once flags so each test
 * can rebuild deterministically (CD-17).
 */
export function _resetWalletClient(): void {
  _walletClientFuji = null;
  _walletClientMainnet = null;
  _warnedDefaultTokenFuji = false;
  _warnedDefaultTokenMainnet = false;
}
