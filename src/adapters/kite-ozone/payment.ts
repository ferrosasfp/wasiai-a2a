import { randomBytes } from 'node:crypto';
import { createWalletClient, http, parseUnits } from 'viem';
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
import { getKiteChain, getKiteNetwork } from './chain.js';

const KITE_SCHEME = 'exact' as const;
// Network tag x402 (formato eip155:<chainId>) — runtime depending on KITE_NETWORK.
const KITE_TESTNET_NETWORK = 'eip155:2368' as const;
const KITE_MAINNET_NETWORK = 'eip155:2366' as const;
type KiteNetworkTag = typeof KITE_TESTNET_NETWORK | typeof KITE_MAINNET_NETWORK;

function getKiteNetworkTag(): KiteNetworkTag {
  return getKiteNetwork() === 'mainnet'
    ? KITE_MAINNET_NETWORK
    : KITE_TESTNET_NETWORK;
}

const KITE_MAX_TIMEOUT_SECONDS = 300 as const;
const KITE_FACILITATOR_DEFAULT_URL = 'https://facilitator.pieverse.io';
const DEFAULT_KITE_FACILITATOR_ADDRESS =
  '0x12343e649e6b2b2b77649DFAb88f103c02F3C78b' as `0x${string}`;

// WasiAI self-hosted facilitator (x402 canonical — fallback when Pieverse is
// unavailable or the tournament requires the spec-compliant path).
const WASIAI_FACILITATOR_DEFAULT_URL =
  'https://wasiai-facilitator-production.up.railway.app';

/**
 * Which facilitator protocol to use when talking to the external settler.
 *   'pieverse' — Pieverse custom scheme (default; current production path).
 *                Signs `primaryType: 'Authorization'` against the Pieverse
 *                facilitator contract; posts to `/verify` and `/settle`
 *                with the `{paymentPayload, paymentRequirements}` envelope.
 *   'x402'     — x402 canonical spec (EIP-3009). Signs `TransferWithAuthorization`
 *                against the PYUSD token contract directly; posts to `/verify`
 *                and `/settle` with `{x402Version, resource, accepted, payload}`.
 *                Compatible with the WasiAI self-hosted facilitator.
 *
 * Toggle via `KITE_FACILITATOR_MODE=x402`. Any other value (or absent)
 * defaults to `pieverse` to preserve current production behavior.
 */
type FacilitatorMode = 'pieverse' | 'x402';

function getFacilitatorMode(): FacilitatorMode {
  return process.env.KITE_FACILITATOR_MODE === 'x402' ? 'x402' : 'pieverse';
}

/**
 * Resolve the facilitator base URL. Explicit env always wins.
 * If unset, picks a sensible default for the selected mode.
 */
function getFacilitatorUrl(): string {
  const explicit = process.env.KITE_FACILITATOR_URL;
  if (explicit) return explicit;
  return getFacilitatorMode() === 'x402'
    ? WASIAI_FACILITATOR_DEFAULT_URL
    : KITE_FACILITATOR_DEFAULT_URL;
}

// El facilitator propio (wasiai-facilitator) EXIGE `Authorization: Bearer <key>`
// en /verify y /settle (requireFacilitatorKey). Espejo de base/avalanche
// (WKH-106/107): KITE_ override → FACILITATOR_API_KEY genérico → sin header
// (degradación segura para el facilitator de Pieverse, que no lo pide).
function getFacilitatorApiKey(): string | undefined {
  return (
    process.env.KITE_FACILITATOR_API_KEY?.trim() ||
    process.env.FACILITATOR_API_KEY?.trim() ||
    undefined
  );
}

// ── Defaults for env-driven configuration (CD-1: no hardcoded addresses in logic) ──
//
// Testnet defaults (chainId 2368): PYUSD — el path histórico WKH-29.
// Mainnet defaults (chainId 2366): USDC.e — Kite mainnet stablecoin canonical.
//   * PYUSD NO existe en Kite mainnet (es testnet-only).
//   * USDC.e address verificado 2026-04-28: 0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e
//
// Activación mainnet: setear `KITE_NETWORK=mainnet` + opcionalmente
// `X402_PAYMENT_TOKEN`/`X402_EIP712_DOMAIN_NAME`/`X402_TOKEN_SYMBOL` para
// override. Sin overrides, los defaults mainnet aplican.
const DEFAULT_PAYMENT_TOKEN_TESTNET =
  '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9' as `0x${string}`; // PYUSD testnet
const DEFAULT_PAYMENT_TOKEN_MAINNET =
  '0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e' as `0x${string}`; // USDC.e mainnet
const DEFAULT_EIP712_DOMAIN_NAME_TESTNET = 'PYUSD';
const DEFAULT_EIP712_DOMAIN_NAME_MAINNET = 'USDC';
const DEFAULT_EIP712_DOMAIN_VERSION = '1';
const DEFAULT_TOKEN_SYMBOL_TESTNET = 'PYUSD';
const DEFAULT_TOKEN_SYMBOL_MAINNET = 'USDC.e';

function getDefaultPaymentToken(): `0x${string}` {
  return getKiteNetwork() === 'mainnet'
    ? DEFAULT_PAYMENT_TOKEN_MAINNET
    : DEFAULT_PAYMENT_TOKEN_TESTNET;
}
function getDefaultEip712DomainName(): string {
  return getKiteNetwork() === 'mainnet'
    ? DEFAULT_EIP712_DOMAIN_NAME_MAINNET
    : DEFAULT_EIP712_DOMAIN_NAME_TESTNET;
}
function getDefaultTokenSymbol(): string {
  return getKiteNetwork() === 'mainnet'
    ? DEFAULT_TOKEN_SYMBOL_MAINNET
    : DEFAULT_TOKEN_SYMBOL_TESTNET;
}

// ── Lazy env-var readers (DT-2: read at call time, not module load) ──

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
let _warnedDefaultToken = false;
let _warnedDefaultFacilitatorAddress = false;

// Pieverse facilitator contract used as EIP-712 `verifyingContract` in
// pieverse mode. Env override (KITE_FACILITATOR_ADDRESS) wins; falls back to
// the documented default with the same address-format validation as the
// payment token (CD-1: no hardcoded addresses in logic).
function getFacilitatorAddress(): `0x${string}` {
  const addr = process.env.KITE_FACILITATOR_ADDRESS;
  const fallback = DEFAULT_KITE_FACILITATOR_ADDRESS;
  if (!addr) return fallback;
  if (!ADDRESS_RE.test(addr)) {
    if (!_warnedDefaultFacilitatorAddress) {
      console.warn(
        `KITE_FACILITATOR_ADDRESS has invalid format "${addr}" — defaulting to ${fallback}`,
      );
      _warnedDefaultFacilitatorAddress = true;
    }
    return fallback;
  }
  return addr as `0x${string}`;
}

function getPaymentToken(): `0x${string}` {
  const token = process.env.X402_PAYMENT_TOKEN;
  const fallback = getDefaultPaymentToken();
  if (!token) {
    if (!_warnedDefaultToken) {
      console.warn(
        `X402_PAYMENT_TOKEN not set — defaulting to ${getDefaultTokenSymbol()} (${fallback})`,
      );
      _warnedDefaultToken = true;
    }
    return fallback;
  }
  if (!ADDRESS_RE.test(token)) {
    if (!_warnedDefaultToken) {
      console.warn(
        `X402_PAYMENT_TOKEN has invalid format "${token}" — defaulting to ${getDefaultTokenSymbol()} (${fallback})`,
      );
      _warnedDefaultToken = true;
    }
    return fallback;
  }
  return token as `0x${string}`;
}

function getEip712Domain() {
  // Pieverse mode firma contra el contrato del facilitator. Cuando se active
  // mainnet en producción, este address debería rotar al deployment mainnet
  // del facilitator Pieverse (TBD). Hoy default es testnet; el path mainnet
  // recomendado es `KITE_FACILITATOR_MODE=x402` que firma contra el token
  // contract directamente y NO depende de KITE_FACILITATOR_ADDRESS.
  return {
    name: process.env.X402_EIP712_DOMAIN_NAME ?? getDefaultEip712DomainName(),
    version:
      process.env.X402_EIP712_DOMAIN_VERSION ?? DEFAULT_EIP712_DOMAIN_VERSION,
    chainId: getKiteChain().id,
    verifyingContract: getFacilitatorAddress(),
  } as const;
}

function getTokenSymbol(): string {
  return process.env.X402_TOKEN_SYMBOL ?? getDefaultTokenSymbol();
}

/** Resolves the active RPC URL for the selected Kite network. */
function getKiteRpcUrl(): string | undefined {
  if (getKiteNetwork() === 'mainnet') {
    return process.env.KITE_MAINNET_RPC_URL ?? process.env.KITE_RPC_URL;
  }
  return process.env.KITE_RPC_URL;
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
    chain: getKiteChain(),
    transport: http(getKiteRpcUrl()),
  });
  return _walletClient;
}

export class KiteOzonePaymentAdapter implements PaymentAdapter {
  readonly name = 'kite-ozone';

  /**
   * `chainId` reportado por el adapter. Es DINÁMICO según `KITE_NETWORK`:
   *   - `testnet` (default) → 2368
   *   - `mainnet` → 2366
   *
   * Se evalúa en el getter (no en el constructor) para que un cambio del
   * env-var entre tests / restarts se refleje sin recargar el módulo.
   */
  get chainId(): number {
    return getKiteChain().id;
  }

  get supportedTokens(): TokenSpec[] {
    const token = getPaymentToken();
    return [{ symbol: getTokenSymbol(), address: token, decimals: 18 }];
  }

  getScheme(): string {
    return KITE_SCHEME;
  }
  getNetwork(): string {
    return getKiteNetworkTag();
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
    if (getFacilitatorMode() === 'x402') {
      return verifyX402(proof);
    }
    const facilitatorUrl = getFacilitatorUrl();
    const token = getPaymentToken();
    const network = getKiteNetworkTag();
    const body: PieverseVerifyRequest = {
      paymentPayload: {
        x402Version: 2,
        scheme: KITE_SCHEME,
        network,
        payload: {
          authorization: proof.authorization,
          signature: proof.signature,
        },
      },
      paymentRequirements: {
        x402Version: 2,
        scheme: KITE_SCHEME,
        network,
        maxAmountRequired:
          proof.paymentRequirements?.maxAmountRequired ??
          proof.authorization.value,
        payTo: proof.paymentRequirements?.payTo ?? proof.authorization.to,
        asset: token,
        extra: null,
      },
    };
    let response: Response;
    try {
      response = await fetch(`${facilitatorUrl}/verify`, {
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
        `Facilitator returned HTTP ${response.status} on /verify`,
      );
    const result = (await response.json()) as PieverseVerifyResponse;
    return { valid: result.valid, error: result.error };
  }

  async settle(req: SettleRequest): Promise<SettleResult> {
    if (getFacilitatorMode() === 'x402') {
      return settleX402(req);
    }
    const facilitatorUrl = getFacilitatorUrl();
    const token = getPaymentToken();
    const network = getKiteNetworkTag();
    const body: PieverseSettleRequest = {
      paymentPayload: {
        x402Version: 2,
        scheme: KITE_SCHEME,
        network,
        payload: { authorization: req.authorization, signature: req.signature },
      },
      paymentRequirements: {
        x402Version: 2,
        scheme: KITE_SCHEME,
        network,
        maxAmountRequired:
          req.paymentRequirements?.maxAmountRequired ?? req.authorization.value,
        payTo: req.paymentRequirements?.payTo ?? req.authorization.to,
        asset: token,
        extra: null,
      },
    };
    let response: Response;
    try {
      response = await fetch(`${facilitatorUrl}/settle`, {
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
        `Facilitator returned HTTP ${response.status} on /settle`,
      );
    const result = (await response.json()) as PieverseSettleResult;
    return {
      txHash: result.txHash,
      success: result.success,
      error: result.error,
    };
  }

  async quote(amountUsd: number): Promise<QuoteResult> {
    const token = getPaymentToken();
    // WKH money-path fix: HONOR the requested USD amount instead of a flat
    // 1 token hardcode (mirror of base/avalanche). The Kite token (PYUSD) uses
    // 18 decimals; parseUnits scales the USD figure to atomic units exactly.
    // MNR-1 fix: normalize via toFixed(decimals) BEFORE parseUnits so a tiny
    // amount in scientific notation (e.g. 1e-7 → "1e-7") can never reach
    // parseUnits (which throws on non-decimal strings). toFixed always emits a
    // plain decimal string. NB: JS Number.toFixed caps at 100 fractional
    // digits; 18 is well within range.
    return {
      amountWei: parseUnits(amountUsd.toFixed(18), 18).toString(),
      token: { symbol: getTokenSymbol(), address: token, decimals: 18 },
      facilitatorUrl: getFacilitatorUrl(),
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
    const mode = getFacilitatorMode();
    let signature: string;
    if (mode === 'x402') {
      // x402 canonical — sign EIP-3009 TransferWithAuthorization directly
      // against the token contract (verifyingContract = token address).
      // Domain name / version se resuelven via env override; los defaults
      // varían por chain (PYUSD on testnet, USDC on mainnet).
      const token = getPaymentToken();
      signature = await client.signTypedData({
        account,
        domain: {
          name:
            process.env.X402_EIP712_DOMAIN_NAME ?? getDefaultEip712DomainName(),
          version:
            process.env.X402_EIP712_DOMAIN_VERSION ??
            DEFAULT_EIP712_DOMAIN_VERSION,
          chainId: getKiteChain().id,
          verifyingContract: token,
        },
        types: {
          TransferWithAuthorization: EIP712_TYPES.Authorization,
        },
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
    } else {
      // Pieverse — sign custom Authorization against Pieverse facilitator contract.
      signature = await client.signTypedData({
        account,
        domain: getEip712Domain(),
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
    }
    const paymentRequest: X402PaymentRequest = {
      authorization,
      signature,
      network: getKiteNetworkTag(),
    };
    const xPaymentHeader = Buffer.from(JSON.stringify(paymentRequest)).toString(
      'base64',
    );
    return { xPaymentHeader, paymentRequest };
  }
}

// ─── x402 canonical helpers (KITE_FACILITATOR_MODE=x402) ─────────────────────
// Uses the wasiai-facilitator self-hosted service. Sends the canonical x402
// v2 request body and parses the canonical response shape.

interface X402VerifyResponse {
  verified: boolean;
  client?: string;
  amount?: string;
  asset?: string;
  network?: string;
  payTo?: string;
  expiresAt?: number;
  error?: { code: string; message: string; http: number };
}

interface X402SettleResponse {
  settled: boolean;
  transactionHash?: string;
  blockNumber?: number;
  amount?: string;
  from?: string;
  to?: string;
  asset?: string;
  error?: { code: string; message: string; http: number };
}

function buildX402CanonicalBody(
  authorization: X402PaymentRequest['authorization'],
  signature: string,
  requirements?: { payTo: string; maxAmountRequired: string },
): unknown {
  const token = getPaymentToken();
  return {
    x402Version: 2,
    resource: {
      url: process.env.X402_RESOURCE_URL ?? 'https://wasiai.ai/pay',
    },
    accepted: {
      scheme: KITE_SCHEME,
      network: getKiteNetworkTag(),
      amount: requirements?.maxAmountRequired ?? authorization.value,
      asset: token,
      payTo: requirements?.payTo ?? authorization.to,
      maxTimeoutSeconds: KITE_MAX_TIMEOUT_SECONDS,
      extra: { assetTransferMethod: 'eip3009' },
    },
    payload: { signature, authorization },
  };
}

// SEC-AR-2026-04-28 MNR-8: bound facilitator hangs symmetric to downstream-payment.ts
const X402_FACILITATOR_TIMEOUT_MS = 10_000;

async function verifyX402(proof: X402Proof): Promise<VerifyResult> {
  const facilitatorUrl = getFacilitatorUrl();
  const body = buildX402CanonicalBody(
    proof.authorization,
    proof.signature,
    proof.paymentRequirements,
  );
  const verifyHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const verifyApiKey = getFacilitatorApiKey();
  if (verifyApiKey) verifyHeaders.Authorization = `Bearer ${verifyApiKey}`;
  let response: Response;
  try {
    response = await fetch(`${facilitatorUrl}/verify`, {
      method: 'POST',
      headers: verifyHeaders,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(X402_FACILITATOR_TIMEOUT_MS),
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

async function settleX402(req: SettleRequest): Promise<SettleResult> {
  const facilitatorUrl = getFacilitatorUrl();
  const body = buildX402CanonicalBody(
    req.authorization,
    req.signature,
    req.paymentRequirements,
  );
  const settleHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const settleApiKey = getFacilitatorApiKey();
  if (settleApiKey) settleHeaders.Authorization = `Bearer ${settleApiKey}`;
  let response: Response;
  try {
    response = await fetch(`${facilitatorUrl}/settle`, {
      method: 'POST',
      headers: settleHeaders,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(X402_FACILITATOR_TIMEOUT_MS),
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
  if (!response.ok || !result.settled) {
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

export function _resetWalletClient(): void {
  _walletClient = null;
  _warnedDefaultToken = false;
  _warnedDefaultFacilitatorAddress = false;
}
