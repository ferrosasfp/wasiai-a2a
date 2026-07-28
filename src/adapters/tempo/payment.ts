import { randomBytes } from 'node:crypto';
import { createWalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { usdToAtomicUnits } from '../../lib/atomic-amount.js';
import { getLogger } from '../../lib/logger.js';
import { buildRpcTransport } from '../../lib/rpc-transport.js';
import type { X402PaymentRequest } from '../../types/index.js';
import { FacilitatorSettleError } from '../errors.js';
import type {
  EvmPaymentAdapter,
  QuoteResult,
  SettleRequest,
  SettleResult,
  SignRequest,
  SignResult,
  TokenSpec,
  VerifyResult,
  X402Proof,
} from '../types.js';
import { getTempoChain, type TempoNetwork } from './chain.js';

/**
 * Tempo x402 payment adapter (WKH-090 / HU-090).
 *
 * MIRROR RESTRINGIDO of `BasePaymentAdapter` (canonical x402 v2 mode only).
 * Tempo's "Machine Payments Protocol" (MPP, Stripe + Paradigm) EVM path has
 * "x402 exact compatibility", so this adapter REUSES the shared x402/EIP-3009
 * contract (`SettleRequest`/`X402Proof`/`VerifyResult`/`QuoteResult`) instead of
 * inventing a parallel proof type (CD-3 / DT-1).
 *
 * MPP → contrato existente (DT-1):
 *   - Challenge  (WWW-Authenticate 402) → quote() + sign()
 *   - Credential (Authorization)        → settle()/verify() (X402Proof:
 *                                          authorization + signature + network)
 *   - Receipt    (Payment-Receipt)      → AttestationAdapter.attest() (stub v1)
 *
 * Rail ship OFF por flag (`TEMPO_ADAPTER_ENABLED`, gate en registry.ts). Los
 * tests mockean `fetch`, así que los valores on-chain [VERIFY-AT-IMPL] no
 * bloquean el DONE.
 */

const TEMPO_SCHEME = 'exact' as const;
// V1 — chainId de Tempo testnet "Moderato" (verificado vía web).
const TEMPO_CHAIN_ID = 42429 as const;
const TEMPO_NETWORK_TAG = `eip155:${TEMPO_CHAIN_ID}` as const;
const TEMPO_MAX_TIMEOUT_SECONDS = 60 as const;

// V3 — token USD de testnet. `AlphaUSD` es la stablecoin CONFIRMADA en Tempo
// testnet (dirección "system" 0x20c0…0001). Se usa como el token USD del
// adapter v1. La `pathUSD` exacta de MPP no está confirmada on-chain
// [VERIFY-AT-IMPL: V3] → se puede overridear por env `TEMPO_TESTNET_USD_ADDRESS`.
// Decimales asumidos 6 (mirror USDC) — VERIFICAR en el explorer.
const DEFAULT_TEMPO_USD_ADDRESS =
  '0x20c0000000000000000000000000000000000001' as `0x${string}`;
const TEMPO_USD_DECIMALS = 6 as const; // [VERIFY-AT-IMPL: V3]
// V4 — EIP-712 domain name/version del contrato del token. Placeholder plausible
// (mirror USDC v2). Como el rail ship OFF y los tests mockean signTypedData,
// no bloquea; overrideable por env. [VERIFY-AT-IMPL: V4]
const TEMPO_USD_EIP712_NAME_DEFAULT = 'AlphaUSD' as const; // [VERIFY-AT-IMPL: V4]
const TEMPO_USD_EIP712_VERSION_DEFAULT = '1' as const; // [VERIFY-AT-IMPL: V4]
const TEMPO_USD_SYMBOL = 'AlphaUSD' as const;

// Facilitator URL fallback chain (mirror base/payment.ts DT-3):
//   TEMPO_FACILITATOR_URL > WASIAI_FACILITATOR_URL > default.
// V7 — que el wasiai-facilitator settlee realmente la red de Tempo es una
// dependencia operativa post-DONE [VERIFY-AT-IMPL: V7]; los tests mockean fetch.
const WASIAI_FACILITATOR_DEFAULT_URL =
  'https://wasiai-facilitator-production.up.railway.app';

// SEC-AR-2026-04-28 MNR-8: bound facilitator hangs.
// 30s (not 10s): match the on-chain settle window the gateway authorizes without
// aborting a legit settle that waits for confirmation. See avalanche/payment.ts.
const FACILITATOR_TIMEOUT_MS = 30_000;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const log = getLogger('tempo');

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
let _walletClient: ReturnType<typeof createWalletClient> | null = null;
let _warnedDefaultToken = false;

function getTempoUsdAddress(): `0x${string}` {
  const env = process.env.TEMPO_TESTNET_USD_ADDRESS;
  if (!env) {
    if (!_warnedDefaultToken) {
      _warnedDefaultToken = true;
      log.warn(
        { fallback: DEFAULT_TEMPO_USD_ADDRESS },
        'TEMPO_TESTNET_USD_ADDRESS not set — defaulting to AlphaUSD',
      );
    }
    return DEFAULT_TEMPO_USD_ADDRESS;
  }
  if (!ADDRESS_RE.test(env)) {
    if (!_warnedDefaultToken) {
      _warnedDefaultToken = true;
      log.warn(
        { env, fallback: DEFAULT_TEMPO_USD_ADDRESS },
        'TEMPO_TESTNET_USD_ADDRESS has invalid format — defaulting to AlphaUSD',
      );
    }
    return DEFAULT_TEMPO_USD_ADDRESS;
  }
  return env as `0x${string}`;
}

function getTempoUsdEip712Name(): string {
  return (
    process.env.TEMPO_TESTNET_USD_EIP712_NAME ?? TEMPO_USD_EIP712_NAME_DEFAULT
  );
}

function getTempoUsdEip712Version(): string {
  return (
    process.env.TEMPO_TESTNET_USD_EIP712_VERSION ??
    TEMPO_USD_EIP712_VERSION_DEFAULT
  );
}

function getFacilitatorUrl(): string {
  return (
    process.env.TEMPO_FACILITATOR_URL ??
    process.env.WASIAI_FACILITATOR_URL ??
    WASIAI_FACILITATOR_DEFAULT_URL
  );
}

function getFacilitatorApiKey(): string | undefined {
  return (
    process.env.TEMPO_FACILITATOR_API_KEY?.trim() ||
    process.env.FACILITATOR_API_KEY?.trim() ||
    undefined
  );
}

function getWalletClient(network: TempoNetwork) {
  if (_walletClient) return _walletClient;
  const pk = process.env.OPERATOR_PRIVATE_KEY;
  if (!pk) {
    throw new Error(
      'OPERATOR_PRIVATE_KEY not set — tempo x402 client signing disabled',
    );
  }
  const account = privateKeyToAccount(pk as `0x${string}`);
  const tempoChain = getTempoChain(network);
  const client = createWalletClient({
    account,
    chain: tempoChain,
    // RPC fallback: primary env > *_RPC_URL_FALLBACK > public default
    // (mirror base/payment.ts OP-04). V2 RPC = rpc.testnet.tempo.xyz.
    transport: buildRpcTransport({
      primary: process.env.TEMPO_TESTNET_RPC_URL,
      fallbackEnv: 'TEMPO_TESTNET_RPC_URL_FALLBACK',
      chainId: tempoChain.id,
    }),
  });
  _walletClient = client;
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

function buildX402CanonicalBody(
  authorization: X402PaymentRequest['authorization'],
  signature: string,
  requirements?: { payTo: string; maxAmountRequired: string },
): unknown {
  // Credential → x402 v2 envelope canónico (DT-1). Mismo shape que base:
  // el facilitator resuelve el settle EIP-3009 contra el token en Tempo.
  return {
    x402Version: 2,
    resource: {
      url: process.env.X402_RESOURCE_URL ?? 'https://wasiai.ai/pay',
    },
    accepted: {
      scheme: TEMPO_SCHEME,
      network: TEMPO_NETWORK_TAG,
      amount: requirements?.maxAmountRequired ?? authorization.value,
      asset: getTempoUsdAddress(),
      payTo: requirements?.payTo ?? authorization.to,
      maxTimeoutSeconds: TEMPO_MAX_TIMEOUT_SECONDS,
      extra: { assetTransferMethod: 'eip3009' },
    },
    payload: { signature, authorization },
  };
}

async function verifyX402(proof: X402Proof): Promise<VerifyResult> {
  const facilitatorUrl = getFacilitatorUrl();
  const body = buildX402CanonicalBody(
    proof.authorization,
    proof.signature,
    proof.paymentRequirements,
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

async function settleX402(req: SettleRequest): Promise<SettleResult> {
  const facilitatorUrl = getFacilitatorUrl();
  const body = buildX402CanonicalBody(
    req.authorization,
    req.signature,
    req.paymentRequirements,
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
    // HU-201: el body no parsea ⟹ no sabemos qué contestó el facilitator ⟹ no
    // sabemos si broadcasteó. Mismo mensaje de siempre, pero TIPADO `'unknown'`.
    throw new FacilitatorSettleError(
      `Facilitator returned HTTP ${response.status} on /settle (no JSON body)`,
      'unknown',
    );
  }
  // HU-201 (AR BLQ-ALTO) — UN HTTP NON-2XX **NO** ES `success:false`.
  //
  // Espejo byte-a-byte del guard de `base/payment.ts` (mismo bug, mismo fix). Un
  // 502/504 —un proxy que corta DESPUÉS de que el facilitator mandó la tx— se aplanaba
  // a `{ success:false }`, y aguas abajo (`services/payment-intent.ts`) eso significa
  // "el facilitator confirmó que no se ejecutó" ⟹ refund al buyer y/o re-envío del hop
  // 2 al seller. Nunca lo confirmó: no contestó bien. Va por el canal de la incógnita.
  //
  // `success:false` queda RESERVADO para un 2xx cuyo cuerpo canónico dice
  // `settled !== true` — el veredicto del facilitator sobre su propio trabajo.
  if (!response.ok) {
    throw new FacilitatorSettleError(
      `Facilitator returned HTTP ${response.status} on /settle: ${result.error?.message ?? 'no error message in body'}`,
      'unknown',
    );
  }
  if (result.settled !== true) {
    return {
      txHash: result.transactionHash ?? '',
      success: false,
      error: result.error?.message ?? `HTTP ${response.status}`,
    };
  }
  return {
    txHash: result.transactionHash ?? '',
    success: true,
  };
}

// ─── Adapter class ──────────────────────────────────────────────────────

export class TempoPaymentAdapter implements EvmPaymentAdapter {
  readonly vmFamily = 'evm' as const;
  readonly name = 'tempo';
  readonly chainId: number = TEMPO_CHAIN_ID;
  private readonly network: TempoNetwork;

  constructor(opts?: { network?: TempoNetwork }) {
    this.network = opts?.network ?? 'testnet';
  }

  get supportedTokens(): TokenSpec[] {
    return [
      {
        symbol: TEMPO_USD_SYMBOL,
        address: getTempoUsdAddress(),
        decimals: TEMPO_USD_DECIMALS,
      },
    ];
  }

  getScheme(): string {
    return TEMPO_SCHEME;
  }

  getNetwork(): string {
    return TEMPO_NETWORK_TAG;
  }

  getToken(): `0x${string}` {
    return getTempoUsdAddress();
  }

  getMaxTimeoutSeconds(): number {
    return TEMPO_MAX_TIMEOUT_SECONDS;
  }

  getMerchantName(): string {
    return process.env.WASIAI_MERCHANT_NAME ?? 'WasiAI';
  }

  // Credential → verify() (X402Proof: authorization + signature + network).
  async verify(proof: X402Proof): Promise<VerifyResult> {
    return verifyX402(proof);
  }

  // Credential → settle() (X402Proof: authorization + signature + network).
  async settle(req: SettleRequest): Promise<SettleResult> {
    return settleX402(req);
  }

  // Challenge → quote(): honra el USD real (money-path MNR-1). NO hardcodear.
  async quote(amountUsd: number): Promise<QuoteResult> {
    const token = getTempoUsdAddress();
    // Fix-pack P1 (hallazgo 3): `toFixed(decimals)` no emite el decimal que el
    // double representa sino su EXPANSIÓN BINARIA, así que a > 6 decimales metía
    // un artefacto de float en el monto del challenge 402. `usdToAtomicUnits`
    // normaliza por la representación decimal más corta con round-trip y sigue
    // garantizando salida decimal plana (`parseUnits` LANZA con notación
    // científica, que era el motivo del `toFixed`). Para 6 dec (USDC) el
    // resultado es IDÉNTICO al camino anterior — verificado con 200k floats.
    return {
      amountWei: usdToAtomicUnits(amountUsd, TEMPO_USD_DECIMALS),
      token: {
        symbol: TEMPO_USD_SYMBOL,
        address: token,
        decimals: TEMPO_USD_DECIMALS,
      },
      facilitatorUrl: getFacilitatorUrl(),
    };
  }

  // Challenge → sign(): firma EIP-3009 TransferWithAuthorization contra el token.
  async sign(opts: SignRequest): Promise<SignResult> {
    const client = getWalletClient(this.network);
    // CD-8 (viem type-safety, WKH-133/138): `account` es opcional en el tipo
    // genérico → guard explícito en vez de `!` (prohibido por biome).
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
        now + (opts.timeoutSeconds ?? TEMPO_MAX_TIMEOUT_SECONDS),
      ),
      nonce,
    };

    const token = getTempoUsdAddress();
    const signature = await client.signTypedData({
      account,
      domain: {
        name: getTempoUsdEip712Name(),
        version: getTempoUsdEip712Version(),
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
      network: TEMPO_NETWORK_TAG,
    };
    const xPaymentHeader = Buffer.from(JSON.stringify(paymentRequest)).toString(
      'base64',
    );
    return { xPaymentHeader, paymentRequest };
  }
}

/**
 * TEST-ONLY — clears cached wallet client + warn-once flags so each test can
 * rebuild deterministically (CD-17).
 */
export function _resetWalletClient(): void {
  _walletClient = null;
  _warnedDefaultToken = false;
}
