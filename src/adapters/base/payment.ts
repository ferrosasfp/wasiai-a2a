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
import { type BaseNetwork, getBaseChain } from './chain.js';

/**
 * Base x402 payment adapter (WKH-104 / BASE-01).
 *
 * MIRROR EXACTO of `AvalanchePaymentAdapter` restricted to canonical x402
 * mode (CD-15 inherited from WKH-MULTICHAIN). Signs EIP-3009
 * `TransferWithAuthorization` against Circle USDC on Base (mainnet 8453 +
 * Sepolia testnet 84532) and POSTs canonical x402 v2 envelopes to the
 * facilitator.
 *
 * IMPORTANTE — BASE-01 caveat (DT-11): el facilitator actual (WasiAI o CDP)
 * NO soporta Base RPC en esta fase. WKH-105 (BASE-02) wirea el facilitator
 * real. Los tests de este archivo mockean `fetch`. Smoke real es WKH-107
 * (BASE-04). En BASE-01, una respuesta 4xx del facilitator es esperada y
 * NO falla el build.
 *
 * EIP-712 domain `name` difiere por network — verified onchain por WKH-105
 * (Sepolia="USDC", Mainnet="USD Coin"). Ver `w0-audit.md`.
 */

const BASE_SCHEME = 'exact' as const;
const BASE_SEPOLIA_CHAIN_ID = 84532 as const;
const BASE_MAINNET_CHAIN_ID = 8453 as const;
const BASE_SEPOLIA_NETWORK_TAG = 'eip155:84532' as const;
const BASE_MAINNET_NETWORK_TAG = 'eip155:8453' as const;
type BaseNetworkTag =
  | typeof BASE_SEPOLIA_NETWORK_TAG
  | typeof BASE_MAINNET_NETWORK_TAG;

const BASE_MAX_TIMEOUT_SECONDS = 60 as const;

// USDC contract addresses canonical Circle on Base (verified onchain by WKH-105).
const DEFAULT_BASE_SEPOLIA_USDC =
  '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as `0x${string}`;
const DEFAULT_BASE_MAINNET_USDC =
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}`;

// USDC EIP-712 domain — `name` differs per network on Base.
// Verified onchain by WKH-105 sibling Dev, 2026-05-19 (see w0-audit.md):
//   Base Sepolia name="USDC" v2
//   Base Mainnet name="USD Coin" v2
const USDC_DECIMALS = 6 as const;
const USDC_EIP712_NAME_SEPOLIA = 'USDC' as const;
const USDC_EIP712_NAME_MAINNET = 'USD Coin' as const;
const USDC_EIP712_VERSION_DEFAULT = '2' as const;
const USDC_SYMBOL = 'USDC' as const;

function getUsdcEip712Name(network: BaseNetwork): string {
  return network === 'mainnet'
    ? USDC_EIP712_NAME_MAINNET
    : USDC_EIP712_NAME_SEPOLIA;
}

// Facilitator URL fallback chain (DT-3):
//   BASE_FACILITATOR_URL > CDP_FACILITATOR_URL > WASIAI_FACILITATOR_URL > default.
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
// One walletClient cached per network — mirrors avalanche/payment.ts pattern.
let _walletClientSepolia: ReturnType<typeof createWalletClient> | null = null;
let _walletClientMainnet: ReturnType<typeof createWalletClient> | null = null;
let _warnedDefaultTokenSepolia = false;
let _warnedDefaultTokenMainnet = false;

function getDefaultUsdcAddress(network: BaseNetwork): `0x${string}` {
  return network === 'mainnet'
    ? DEFAULT_BASE_MAINNET_USDC
    : DEFAULT_BASE_SEPOLIA_USDC;
}

function getUsdcAddress(network: BaseNetwork): `0x${string}` {
  const fallback = getDefaultUsdcAddress(network);
  const env =
    network === 'mainnet'
      ? process.env.BASE_MAINNET_USDC_ADDRESS
      : process.env.BASE_SEPOLIA_USDC_ADDRESS;
  if (!env) {
    if (network === 'mainnet') {
      if (!_warnedDefaultTokenMainnet) {
        _warnedDefaultTokenMainnet = true;
        console.warn(
          `[base] BASE_MAINNET_USDC_ADDRESS not set — defaulting to USDC (${fallback})`,
        );
      }
    } else {
      if (!_warnedDefaultTokenSepolia) {
        _warnedDefaultTokenSepolia = true;
        console.warn(
          `[base] BASE_SEPOLIA_USDC_ADDRESS not set — defaulting to USDC (${fallback})`,
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
          `[base] BASE_MAINNET_USDC_ADDRESS has invalid format "${env}" — defaulting to USDC (${fallback})`,
        );
      }
    } else {
      if (!_warnedDefaultTokenSepolia) {
        _warnedDefaultTokenSepolia = true;
        console.warn(
          `[base] BASE_SEPOLIA_USDC_ADDRESS has invalid format "${env}" — defaulting to USDC (${fallback})`,
        );
      }
    }
    return fallback;
  }
  return env as `0x${string}`;
}

function getUsdcEip712Version(network: BaseNetwork): string {
  return network === 'mainnet'
    ? (process.env.BASE_MAINNET_USDC_EIP712_VERSION ??
        USDC_EIP712_VERSION_DEFAULT)
    : (process.env.BASE_SEPOLIA_USDC_EIP712_VERSION ??
        USDC_EIP712_VERSION_DEFAULT);
}

function getRpcUrl(network: BaseNetwork): string | undefined {
  return network === 'mainnet'
    ? process.env.BASE_MAINNET_RPC_URL
    : process.env.BASE_TESTNET_RPC_URL;
}

function getFacilitatorUrl(): string {
  return (
    process.env.BASE_FACILITATOR_URL ??
    process.env.CDP_FACILITATOR_URL ??
    process.env.WASIAI_FACILITATOR_URL ??
    WASIAI_FACILITATOR_DEFAULT_URL
  );
}

function getWalletClient(network: BaseNetwork) {
  if (network === 'mainnet' && _walletClientMainnet)
    return _walletClientMainnet;
  if (network === 'testnet' && _walletClientSepolia)
    return _walletClientSepolia;
  const pk = process.env.OPERATOR_PRIVATE_KEY;
  if (!pk) {
    throw new Error(
      'OPERATOR_PRIVATE_KEY not set — base x402 client signing disabled',
    );
  }
  const account = privateKeyToAccount(pk as `0x${string}`);
  const client = createWalletClient({
    account,
    chain: getBaseChain(network),
    transport: http(getRpcUrl(network)),
  });
  if (network === 'mainnet') {
    _walletClientMainnet = client;
  } else {
    _walletClientSepolia = client;
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

function getNetworkTag(network: BaseNetwork): BaseNetworkTag {
  return network === 'mainnet'
    ? BASE_MAINNET_NETWORK_TAG
    : BASE_SEPOLIA_NETWORK_TAG;
}

function buildX402CanonicalBody(
  authorization: X402PaymentRequest['authorization'],
  signature: string,
  network: BaseNetwork,
): unknown {
  return {
    x402Version: 2,
    resource: {
      url: process.env.X402_RESOURCE_URL ?? 'https://wasiai.ai/pay',
    },
    accepted: {
      scheme: BASE_SCHEME,
      network: getNetworkTag(network),
      amount: authorization.value,
      asset: getUsdcAddress(network),
      payTo: authorization.to,
      maxTimeoutSeconds: BASE_MAX_TIMEOUT_SECONDS,
      extra: { assetTransferMethod: 'eip3009' },
    },
    payload: { signature, authorization },
  };
}

async function verifyX402(
  proof: X402Proof,
  network: BaseNetwork,
): Promise<VerifyResult> {
  const facilitatorUrl = getFacilitatorUrl();
  const body = buildX402CanonicalBody(
    proof.authorization,
    proof.signature,
    network,
  );
  let response: Response;
  try {
    response = await fetch(`${facilitatorUrl}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
  network: BaseNetwork,
): Promise<SettleResult> {
  const facilitatorUrl = getFacilitatorUrl();
  const body = buildX402CanonicalBody(
    req.authorization,
    req.signature,
    network,
  );
  let response: Response;
  try {
    response = await fetch(`${facilitatorUrl}/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

export class BasePaymentAdapter implements PaymentAdapter {
  readonly name = 'base';
  readonly chainId: number;
  private readonly network: BaseNetwork;

  constructor(opts: { network: BaseNetwork }) {
    this.network = opts.network;
    this.chainId =
      opts.network === 'mainnet'
        ? BASE_MAINNET_CHAIN_ID
        : BASE_SEPOLIA_CHAIN_ID;
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
    return BASE_SCHEME;
  }

  getNetwork(): string {
    return getNetworkTag(this.network);
  }

  getToken(): `0x${string}` {
    return getUsdcAddress(this.network);
  }

  getMaxTimeoutSeconds(): number {
    return BASE_MAX_TIMEOUT_SECONDS;
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
        now + (opts.timeoutSeconds ?? BASE_MAX_TIMEOUT_SECONDS),
      ),
      nonce,
    };

    // Sign EIP-3009 against the USDC token contract directly (verifyingContract
    // = USDC address). Circle USDC EIP-712 domain differs per-network on Base:
    // Sepolia uses `name='USDC'`, Mainnet uses `name='USD Coin'` (verified
    // onchain by WKH-105 — see Story File §2.3 + w0-audit.md).
    const token = getUsdcAddress(this.network);
    const signature = await client.signTypedData({
      account,
      domain: {
        name: getUsdcEip712Name(this.network),
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
  _walletClientSepolia = null;
  _walletClientMainnet = null;
  _warnedDefaultTokenSepolia = false;
  _warnedDefaultTokenMainnet = false;
}
