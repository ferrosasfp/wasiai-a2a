/**
 * Downstream x402 Payment — Avalanche Fuji USDC (WKH-55)
 *
 * Aislado del adapter Kite (CD-NEW-SDD-1). NUNCA throw (CD-NEW-SDD-6).
 * Returns null en cualquier skip o failure — el caller logea y continúa.
 */
import { randomBytes } from 'node:crypto';
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  type Hex,
  http,
  parseUnits,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { avalancheFuji } from 'viem/chains';
import type { Agent } from '../types/index.js';

// ─── Constantes (DT-N) — env override + warn-once ───────────────────
const DEFAULT_FUJI_USDC =
  '0x5425890298aed601595a70AB815c96711a31Bc65' as `0x${string}`;
const FUJI_CHAIN_ID = 43113 as const;
const FUJI_NETWORK = 'eip155:43113' as const;
const FUJI_USDC_DECIMALS = 6 as const; // CD-NEW-SDD-5
const FUJI_USDC_EIP712_NAME = 'USD Coin' as const;
const FUJI_USDC_EIP712_VERSION_DEFAULT = '2' as const;
const VALID_BEFORE_SECONDS = 300 as const;
const X402_SCHEME = 'exact' as const;
const MAX_TIMEOUT_SECONDS = 60 as const;

// CD-NEW-SDD-3: lectura del flag UNA sola vez al module load
const DOWNSTREAM_FLAG = process.env.WASIAI_DOWNSTREAM_X402 === 'true';

// Warn-once flag (patron heredado de payment.ts:78-101)
let _warnedDefaultUsdc = false;

// ─── Tipos publicos ─────────────────────────────────────────────────
export interface DownstreamResult {
  txHash: `0x${string}`;
  blockNumber: number;
  settledAmount: string; // atomic units (string, 6-dec USDC)
}

export type DownstreamSkipCode =
  | 'FLAG_OFF'
  | 'NO_PAYMENT_FIELD'
  | 'METHOD_NOT_SUPPORTED'
  | 'CHAIN_NOT_SUPPORTED'
  | 'INVALID_PAY_TO_FORMAT'
  | 'ZERO_PAY_TO'
  | 'INVALID_PRICE'
  | 'INSUFFICIENT_BALANCE'
  | 'BALANCE_READ_FAILED'
  | 'SIGNING_FAILED'
  | 'VERIFY_FAILED'
  | 'SETTLE_FAILED'
  | 'NETWORK_ERROR'
  | 'CONFIG_MISSING';

export interface DownstreamLogger {
  warn: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
}

// ─── x402 wire types (CR-MNR-4: concrete shapes for facilitator I/O) ─
export interface X402Authorization {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
}

export interface X402CanonicalBody {
  x402Version: 2;
  resource: { url: string };
  accepted: {
    scheme: typeof X402_SCHEME;
    network: typeof FUJI_NETWORK;
    amount: string;
    asset: `0x${string}`;
    payTo: `0x${string}`;
    maxTimeoutSeconds: typeof MAX_TIMEOUT_SECONDS;
    extra: { assetTransferMethod: 'eip3009' };
  };
  payload: { signature: string; authorization: X402Authorization };
}

export interface X402VerifyResponse {
  verified?: boolean;
}

export interface X402SettleResponse {
  settled?: boolean;
  transactionHash?: string;
  blockNumber?: number;
  amount?: string;
}

// ─── Helpers internos ───────────────────────────────────────────────

/**
 * Resuelve la dirección USDC Fuji desde env, con warn-once si está ausente.
 * Retorna el default canonical Circle USDC en Fuji.
 */
function getFujiUsdcAddress(): `0x${string}` {
  const env = process.env.FUJI_USDC_ADDRESS;
  if (!env) {
    if (!_warnedDefaultUsdc) {
      _warnedDefaultUsdc = true;
      console.warn(
        `[WKH-55] FUJI_USDC_ADDRESS not set, using default ${DEFAULT_FUJI_USDC}`,
      );
    }
    return DEFAULT_FUJI_USDC;
  }
  return env as `0x${string}`;
}

function getFujiUsdcEip712Version(): string {
  return (
    process.env.FUJI_USDC_EIP712_VERSION ?? FUJI_USDC_EIP712_VERSION_DEFAULT
  );
}

function getFacilitatorUrl(): string {
  return (
    process.env.WASIAI_FACILITATOR_URL ??
    'https://wasiai-facilitator-production.up.railway.app'
  );
}

/**
 * Valida formato y zero-address del payTo (R-1 mitigacion).
 * Retorna { ok: true, addr } o { ok: false, code }.
 */
function validatePayTo(
  contract: string,
):
  | { ok: true; addr: `0x${string}` }
  | { ok: false; code: 'INVALID_PAY_TO_FORMAT' | 'ZERO_PAY_TO' } {
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) {
    return { ok: false, code: 'INVALID_PAY_TO_FORMAT' };
  }
  if (contract.toLowerCase() === '0x0000000000000000000000000000000000000000') {
    return { ok: false, code: 'ZERO_PAY_TO' };
  }
  return { ok: true, addr: contract as `0x${string}` };
}

/**
 * Computa atomic value en USDC Fuji (6 decimales).
 * CD-NEW-SDD-5: usa parseUnits, NO BigInt(Math.round(x*1e6)).
 */
function computeAtomicValue(priceUsdc: number): bigint {
  return parseUnits(priceUsdc.toString(), FUJI_USDC_DECIMALS);
}

/**
 * Lee balance USDC del operator on Fuji (DT-H, AC-10).
 * Throw on RPC failure — el caller lo captura y devuelve null.
 */
async function readOperatorBalance(
  publicClient: PublicClient,
  usdcAddress: `0x${string}`,
  operator: `0x${string}`,
): Promise<bigint> {
  const balance = (await publicClient.readContract({
    address: usdcAddress,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [operator],
  })) as bigint;
  return balance;
}

/**
 * Lazy-init wallet/public clients (patron heredado de payment.ts:131-145).
 * NO se cachean en module-level porque tests necesitan resetearlos via vi.mock.
 */
function buildClients(): {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: ReturnType<typeof privateKeyToAccount>;
} | null {
  const pk = process.env.OPERATOR_PRIVATE_KEY;
  if (!pk || !pk.startsWith('0x')) return null;
  const rpc = process.env.FUJI_RPC_URL;
  if (!rpc) return null;
  const account = privateKeyToAccount(pk as `0x${string}`);
  const publicClient = createPublicClient({
    chain: avalancheFuji,
    transport: http(rpc),
  });
  const walletClient = createWalletClient({
    account,
    chain: avalancheFuji,
    transport: http(rpc),
  });
  return { publicClient, walletClient, account };
}

/**
 * Construye el body canonical x402 v2 (mismo shape que kite-ozone:373-394).
 * NO se importa nada de kite-ozone (CD-NEW-SDD-1) — body construido inline.
 */
function buildCanonicalBody(args: {
  authorization: X402Authorization;
  signature: string;
  asset: `0x${string}`;
}): X402CanonicalBody {
  return {
    x402Version: 2,
    resource: { url: 'https://wasiai.ai/downstream' },
    accepted: {
      scheme: X402_SCHEME,
      network: FUJI_NETWORK,
      amount: args.authorization.value,
      asset: args.asset,
      payTo: args.authorization.to,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      extra: { assetTransferMethod: 'eip3009' },
    },
    payload: { signature: args.signature, authorization: args.authorization },
  };
}

/**
 * POST al facilitator. Retorna un descriptor estructurado en lugar de `null`
 * crudo, para que el caller pueda distinguir verify/settle failures por su
 * cuerpo raw (AR-MNR-2: race condition observability).
 *
 * AR-WKH-55-MNR-1 fix: el fetch lleva un AbortSignal.timeout(10s). Sin esto,
 * un facilitator colgado (TCP accept + no response) bloquearía el invoke
 * upstream durante el default de Node (~30-120s). Misma defensa que
 * `discovery.ts` aplica en sus fetches.
 */
const FACILITATOR_TIMEOUT_MS = 10_000;

interface FacilitatorOk<T> {
  ok: true;
  data: T;
}
interface FacilitatorErr {
  ok: false;
  status: number | null; // null = network/timeout (no HTTP response)
  body: string | null;
}
type FacilitatorResponse<T> = FacilitatorOk<T> | FacilitatorErr;

async function postFacilitator<T>(
  path: '/verify' | '/settle',
  body: X402CanonicalBody,
): Promise<FacilitatorResponse<T>> {
  const url = `${getFacilitatorUrl()}${path}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FACILITATOR_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Capture raw body for AR-MNR-2 (best-effort, never throw)
      let raw: string | null = null;
      try {
        raw = await res.text();
      } catch {
        raw = null;
      }
      return { ok: false, status: res.status, body: raw };
    }
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch {
    return { ok: false, status: null, body: null };
  }
}

// ─── EIP-712 types (referencia: payment.ts EIP712_TYPES.Authorization) ────
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

// ─── API pública (ÚNICA exportación funcional) ──────────────────────

/**
 * Sign EIP-3009 + POST /verify + POST /settle. NEVER throws (CD-NEW-SDD-6).
 *
 * Retorna `null` en cualquiera de estos casos:
 *  - flag `WASIAI_DOWNSTREAM_X402` no es 'true'
 *  - agent.payment ausente / malformado
 *  - method !== 'x402' o chain !== 'avalanche'
 *  - payTo inválido o zero
 *  - priceUsdc no es un número finito positivo
 *  - balance insuficiente
 *  - balance read RPC failure
 *  - signing failure
 *  - facilitator /verify devuelve verified=false
 *  - facilitator /settle devuelve settled=false / network error / 5xx
 *  - config missing (OPERATOR_PRIVATE_KEY o FUJI_RPC_URL ausentes)
 *
 * Retorna `DownstreamResult` SOLO cuando facilitator confirmó `settled: true`
 * con `transactionHash` y `blockNumber` poblados.
 */
export async function signAndSettleDownstream(
  agent: Agent,
  logger: DownstreamLogger,
): Promise<DownstreamResult | null> {
  // 1. Flag check (CD-NEW-SDD-7 — zero overhead cuando off)
  if (!DOWNSTREAM_FLAG) {
    return null;
  }

  // 2. agent.payment presence + shape
  if (!agent.payment) {
    logger.info(
      { agentSlug: agent.slug, code: 'NO_PAYMENT_FIELD' },
      '[Downstream] agent.payment absent — skipped',
    );
    return null;
  }

  // 3. method check (AC-5)
  if (agent.payment.method !== 'x402') {
    logger.info(
      {
        agentSlug: agent.slug,
        method: agent.payment.method,
        code: 'METHOD_NOT_SUPPORTED',
      },
      `[Downstream] method=${agent.payment.method} not supported — skipped`,
    );
    return null;
  }

  // 4. chain check (AC-6)
  if (agent.payment.chain !== 'avalanche') {
    logger.info(
      {
        agentSlug: agent.slug,
        chain: agent.payment.chain,
        code: 'CHAIN_NOT_SUPPORTED',
      },
      `[Downstream] chain=${agent.payment.chain} not yet supported — skipped`,
    );
    return null;
  }

  // 5. payTo validation (R-1)
  const payToCheck = validatePayTo(agent.payment.contract);
  if (!payToCheck.ok) {
    logger.warn(
      {
        agentSlug: agent.slug,
        contract: agent.payment.contract,
        code: payToCheck.code,
      },
      '[Downstream] payTo validation failed',
    );
    return null;
  }

  // 6. Build clients (config check)
  const clients = buildClients();
  if (!clients) {
    logger.warn(
      { agentSlug: agent.slug, code: 'CONFIG_MISSING' },
      '[Downstream] OPERATOR_PRIVATE_KEY or FUJI_RPC_URL missing',
    );
    return null;
  }
  const { publicClient, walletClient, account } = clients;

  // 7a. priceUsdc guard (CR-MNR-7: explicit edge-case for non-finite / non-positive
  // price). Sin esto, valores como NaN, Infinity, -1, 0 o sub-atómicos como 5e-7
  // se filtran al `parseUnits` y ahí pueden producir 0n o un throw genérico.
  if (!Number.isFinite(agent.priceUsdc) || agent.priceUsdc <= 0) {
    logger.warn(
      {
        agentSlug: agent.slug,
        code: 'INVALID_PRICE',
        priceUsdc: agent.priceUsdc,
      },
      '[Downstream] priceUsdc must be a finite positive number',
    );
    return null;
  }

  // 7b. Compute atomic value (CD-NEW-SDD-5, AC-9)
  let value: bigint;
  try {
    value = computeAtomicValue(agent.priceUsdc);
  } catch (e) {
    logger.warn(
      { agentSlug: agent.slug, code: 'CONFIG_MISSING', detail: String(e) },
      '[Downstream] computeAtomicValue failed',
    );
    return null;
  }

  // 8. Pre-flight balance (DT-H, AC-10)
  const usdcAddress = getFujiUsdcAddress();
  let balance: bigint;
  try {
    balance = await readOperatorBalance(
      publicClient,
      usdcAddress,
      account.address,
    );
  } catch (e) {
    logger.warn(
      { agentSlug: agent.slug, code: 'BALANCE_READ_FAILED', detail: String(e) },
      '[Downstream] balance read RPC failed',
    );
    return null;
  }
  if (balance < value) {
    logger.warn(
      {
        agentSlug: agent.slug,
        code: 'INSUFFICIENT_BALANCE',
        balance: balance.toString(),
        required: value.toString(),
      },
      '[Downstream] insufficient USDC balance',
    );
    return null;
  }

  // 9. Build authorization (DT-I, DT-J, AC-2, AC-8)
  const now = Math.floor(Date.now() / 1000);
  const nonce = `0x${randomBytes(32).toString('hex')}` as `0x${string}`;
  const authorization = {
    from: account.address,
    to: payToCheck.addr, // CD-8: agent.payment.contract validado
    value: value.toString(),
    validAfter: '0',
    validBefore: String(now + VALID_BEFORE_SECONDS),
    nonce,
  };

  // 10. Sign EIP-712 (CD-8: domain exacto USDC Fuji)
  let signature: Hex;
  try {
    signature = await walletClient.signTypedData({
      account,
      domain: {
        name: FUJI_USDC_EIP712_NAME,
        version: getFujiUsdcEip712Version(),
        chainId: FUJI_CHAIN_ID,
        verifyingContract: usdcAddress,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: authorization.from,
        to: authorization.to,
        value,
        validAfter: 0n,
        validBefore: BigInt(authorization.validBefore),
        nonce,
      },
    });
  } catch (e) {
    logger.warn(
      { agentSlug: agent.slug, code: 'SIGNING_FAILED', detail: String(e) },
      '[Downstream] signTypedData failed',
    );
    return null;
  }

  // 11. POST /verify
  const body = buildCanonicalBody({
    authorization,
    signature,
    asset: usdcAddress,
  });
  const verifyRes = await postFacilitator<X402VerifyResponse>('/verify', body);
  if (!verifyRes.ok || verifyRes.data.verified !== true) {
    logger.warn(
      {
        agentSlug: agent.slug,
        code: 'VERIFY_FAILED',
        ...(verifyRes.ok
          ? {}
          : {
              facilitatorStatus: verifyRes.status,
              facilitatorErrorBody: verifyRes.body,
            }),
      },
      '[Downstream] facilitator /verify failed or returned verified=false',
    );
    return null;
  }

  // 12. POST /settle
  const settleRes = await postFacilitator<X402SettleResponse>('/settle', body);
  if (
    !settleRes.ok ||
    settleRes.data.settled !== true ||
    !settleRes.data.transactionHash ||
    typeof settleRes.data.blockNumber !== 'number'
  ) {
    // AR-MNR-2: incluir el body raw del facilitator para distinguir race
    // condition (ej: "nonce already used", "balance changed mid-flight") vs
    // otros errores (5xx, malformed response, network).
    logger.warn(
      {
        agentSlug: agent.slug,
        code: 'SETTLE_FAILED',
        ...(settleRes.ok
          ? { facilitatorBody: settleRes.data }
          : {
              facilitatorStatus: settleRes.status,
              facilitatorErrorBody: settleRes.body,
            }),
      },
      '[Downstream] facilitator /settle failed or settled=false',
    );
    return null;
  }

  // 13. Success
  return {
    txHash: settleRes.data.transactionHash as `0x${string}`,
    blockNumber: settleRes.data.blockNumber,
    settledAmount: settleRes.data.amount ?? value.toString(),
  };
}
