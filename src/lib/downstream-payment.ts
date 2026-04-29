/**
 * Downstream x402 Payment — Avalanche Fuji USDC (WKH-55)
 *
 * Isolated from the Kite adapter (CD-NEW-SDD-1). NEVER throws (CD-NEW-SDD-6).
 * Returns null on any skip or failure — the caller logs and continues.
 */
import { randomBytes } from 'node:crypto';
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  type Hex,
  http,
  type PublicClient,
  parseUnits,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { avalanche, avalancheFuji } from 'viem/chains';
import type { Agent, DownstreamLogger } from '../types/index.js';

// Re-export for backward-compat: callers historically import
// `DownstreamLogger` from this module (e.g. compose.ts). The canonical
// definition now lives in `types/index.ts` (TD-WKH-55-4 / CR-MNR-3).
export type { DownstreamLogger };

// ─── Network selection (068) — env-gated, default fuji ─────────────
/**
 * Selección de chain target para el downstream pago.
 *   - `fuji` (default): chainId 43113, USDC fuji (Circle test).
 *   - `avalanche-mainnet`: chainId 43114, USDC native (Circle prod).
 *
 * Activación mainnet requiere setear `WASIAI_DOWNSTREAM_NETWORK=avalanche-mainnet`
 * Y haber fundeado el operator wallet con USDC en la chain correspondiente.
 * Sin balance suficiente, el path falla con `INSUFFICIENT_BALANCE` (ya
 * cubierto por la pre-flight check existente, AC-10).
 */
type DownstreamNetwork = 'fuji' | 'avalanche-mainnet';

function getDownstreamNetwork(): DownstreamNetwork {
  return process.env.WASIAI_DOWNSTREAM_NETWORK === 'avalanche-mainnet'
    ? 'avalanche-mainnet'
    : 'fuji';
}

// USDC contract addresses canonical Circle (verificados 2026-04-28):
//   - Fuji testnet: 0x5425890298aed601595a70AB815c96711a31Bc65
//   - Avalanche C-Chain mainnet: 0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E
const DEFAULT_FUJI_USDC =
  '0x5425890298aed601595a70AB815c96711a31Bc65' as `0x${string}`;
const DEFAULT_AVALANCHE_USDC =
  '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E' as `0x${string}`;

// Chain IDs y network tags x402 (formato eip155:<chainId>).
const FUJI_CHAIN_ID = 43113 as const;
const AVALANCHE_CHAIN_ID = 43114 as const;
const FUJI_NETWORK = 'eip155:43113' as const;
const AVALANCHE_NETWORK = 'eip155:43114' as const;

// USDC decimals + EIP-712 domain — idénticos en ambas chains (mismo Circle ABI).
const USDC_DECIMALS = 6 as const; // CD-NEW-SDD-5
const USDC_EIP712_NAME = 'USD Coin' as const;
const USDC_EIP712_VERSION_DEFAULT = '2' as const;

const VALID_BEFORE_SECONDS = 300 as const;
const X402_SCHEME = 'exact' as const;
const MAX_TIMEOUT_SECONDS = 60 as const;

// CD-NEW-SDD-3: read the flag ONCE at module load
const DOWNSTREAM_FLAG = process.env.WASIAI_DOWNSTREAM_X402 === 'true';

// Warn-once flag (pattern inherited from payment.ts:78-101)
let warnedDefaultUsdc = false;

// ─── Public types ───────────────────────────────────────────────────
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
    network: typeof FUJI_NETWORK | typeof AVALANCHE_NETWORK;
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

// ─── Internal helpers ───────────────────────────────────────────────

/**
 * Resolves the USDC contract address for the active downstream network.
 *
 *   - `fuji` → reads `FUJI_USDC_ADDRESS`; falls back to canonical Circle Fuji.
 *   - `avalanche-mainnet` → reads `AVALANCHE_USDC_ADDRESS`; falls back to canonical
 *     Circle USDC on Avalanche C-Chain.
 *
 * Warn-once per process when the env-var is absent (preserves WKH-55 behavior).
 */
function getUsdcAddress(): `0x${string}` {
  const network = getDownstreamNetwork();
  if (network === 'avalanche-mainnet') {
    const env = process.env.AVALANCHE_USDC_ADDRESS;
    if (!env) {
      if (!warnedDefaultUsdc) {
        warnedDefaultUsdc = true;
        console.warn(
          `[downstream] AVALANCHE_USDC_ADDRESS not set, using default ${DEFAULT_AVALANCHE_USDC}`,
        );
      }
      return DEFAULT_AVALANCHE_USDC;
    }
    return env as `0x${string}`;
  }
  // Default: fuji
  const env = process.env.FUJI_USDC_ADDRESS;
  if (!env) {
    if (!warnedDefaultUsdc) {
      warnedDefaultUsdc = true;
      console.warn(
        `[WKH-55] FUJI_USDC_ADDRESS not set, using default ${DEFAULT_FUJI_USDC}`,
      );
    }
    return DEFAULT_FUJI_USDC;
  }
  return env as `0x${string}`;
}

function getUsdcEip712Version(): string {
  // Misma versión '2' aplica a Circle USDC en ambas chains.
  // Override permitido vía FUJI_USDC_EIP712_VERSION (legacy) o
  // AVALANCHE_USDC_EIP712_VERSION (nuevo).
  const network = getDownstreamNetwork();
  if (network === 'avalanche-mainnet') {
    return (
      process.env.AVALANCHE_USDC_EIP712_VERSION ?? USDC_EIP712_VERSION_DEFAULT
    );
  }
  return process.env.FUJI_USDC_EIP712_VERSION ?? USDC_EIP712_VERSION_DEFAULT;
}

function getFacilitatorUrl(): string {
  return (
    process.env.WASIAI_FACILITATOR_URL ??
    'https://wasiai-facilitator-production.up.railway.app'
  );
}

/**
 * Validates payTo format and rejects the zero-address (R-1 mitigation).
 * Returns { ok: true, addr } or { ok: false, code }.
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
 * Computes the atomic value in Fuji USDC (6 decimals).
 * CD-NEW-SDD-5: uses parseUnits, NOT BigInt(Math.round(x*1e6)).
 */
function computeAtomicValue(priceUsdc: number): bigint {
  return parseUnits(priceUsdc.toString(), USDC_DECIMALS);
}

/**
 * Reads the operator's USDC balance on Fuji (DT-H, AC-10).
 * Throws on RPC failure — the caller catches and returns null.
 *
 * AR-WKH-55-MNR-2 — Known race condition (intentional V1 limitation):
 * The pre-flight balance check and the EIP-3009 signing/settlement happen at
 * different points in time. Between this read and the facilitator's on-chain
 * `transferWithAuthorization` execution, the operator balance can drift (e.g.
 * a parallel downstream invoke on the same hot path consumes the same USDC).
 * The result is a `SETTLE_FAILED` from the facilitator, surfaced to the caller
 * (compose) via `null` and logged with `facilitatorErrorBody` for diagnosis.
 *
 * Mitigation in V2 (planned): wasiai-facilitator will accept an idempotency
 * key + nonce-pinning on the Fuji RPC layer (optimistic locking on the
 * authorization nonce) so concurrent settles deterministically fail one of
 * them at the chain level instead of racing on balance.
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
 * Lazy-init wallet/public clients (pattern inherited from payment.ts:131-145).
 * NOT cached at module level because tests need to reset them via vi.mock.
 */
function buildClients(): {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: ReturnType<typeof privateKeyToAccount>;
  chainId: number;
  network: typeof FUJI_NETWORK | typeof AVALANCHE_NETWORK;
} | null {
  const pk = process.env.OPERATOR_PRIVATE_KEY;
  if (!pk?.startsWith('0x')) return null;
  const network = getDownstreamNetwork();
  const account = privateKeyToAccount(pk as `0x${string}`);
  if (network === 'avalanche-mainnet') {
    const rpc = process.env.AVALANCHE_RPC_URL;
    if (!rpc) return null;
    const publicClient = createPublicClient({
      chain: avalanche,
      transport: http(rpc),
    });
    const walletClient = createWalletClient({
      account,
      chain: avalanche,
      transport: http(rpc),
    });
    return {
      publicClient,
      walletClient,
      account,
      chainId: AVALANCHE_CHAIN_ID,
      network: AVALANCHE_NETWORK,
    };
  }
  // Default: fuji
  const rpc = process.env.FUJI_RPC_URL;
  if (!rpc) return null;
  const publicClient = createPublicClient({
    chain: avalancheFuji,
    transport: http(rpc),
  });
  const walletClient = createWalletClient({
    account,
    chain: avalancheFuji,
    transport: http(rpc),
  });
  return {
    publicClient,
    walletClient,
    account,
    chainId: FUJI_CHAIN_ID,
    network: FUJI_NETWORK,
  };
}

/**
 * Builds the canonical x402 v2 body (same shape as kite-ozone:373-394).
 * Nothing is imported from kite-ozone (CD-NEW-SDD-1) — body built inline.
 */
function buildCanonicalBody(args: {
  authorization: X402Authorization;
  signature: string;
  asset: `0x${string}`;
  network: typeof FUJI_NETWORK | typeof AVALANCHE_NETWORK;
}): X402CanonicalBody {
  return {
    x402Version: 2,
    resource: { url: 'https://wasiai.ai/downstream' },
    accepted: {
      scheme: X402_SCHEME,
      network: args.network,
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
 * POSTs to the facilitator. Returns a structured descriptor instead of a raw
 * `null` so the caller can distinguish verify/settle failures by their raw
 * body (AR-MNR-2: race condition observability).
 *
 * AR-WKH-55-MNR-1 fix: the fetch carries an AbortSignal.timeout(10s). Without
 * it, a hung facilitator (TCP accept + no response) would block the upstream
 * invoke during Node's default (~30-120s). Same defense `discovery.ts`
 * applies to its fetches.
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
    // CR-MNR-5: the body is materialized in-memory via JSON.stringify before
    // fetch sends it. For the canonical x402 v2 body the size stays well
    // under 2 KB, so the cost of "build JS object → serialize string → write
    // to socket" is < 1 ms and not worth optimizing today. If this ever
    // grows (e.g. multi-payload batch settles), a future hardening could
    // switch to a streaming JSON encoder (e.g. fast-json-stringify or a
    // ReadableStream) to avoid the intermediate string allocation.
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

// ─── EIP-712 types (reference: payment.ts EIP712_TYPES.Authorization) ────
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

// ─── Public API (SINGLE functional export) ──────────────────────────

/**
 * Sign EIP-3009 + POST /verify + POST /settle. NEVER throws (CD-NEW-SDD-6).
 *
 * Returns `null` in any of these cases:
 *  - flag `WASIAI_DOWNSTREAM_X402` is not 'true'
 *  - agent.payment absent / malformed
 *  - method !== 'x402' or chain !== 'avalanche'
 *  - payTo invalid or zero
 *  - priceUsdc is not a finite positive number
 *  - insufficient balance
 *  - balance read RPC failure
 *  - signing failure
 *  - facilitator /verify returns verified=false
 *  - facilitator /settle returns settled=false / network error / 5xx
 *  - config missing (OPERATOR_PRIVATE_KEY or FUJI_RPC_URL absent)
 *
 * Returns `DownstreamResult` ONLY when the facilitator confirmed `settled: true`
 * with `transactionHash` and `blockNumber` populated.
 */
export async function signAndSettleDownstream(
  agent: Agent,
  logger: DownstreamLogger,
): Promise<DownstreamResult | null> {
  // 1. Flag check (CD-NEW-SDD-7 — zero overhead when off)
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
      '[Downstream] OPERATOR_PRIVATE_KEY or RPC URL missing for active network',
    );
    return null;
  }
  const { publicClient, walletClient, account, chainId, network } = clients;

  // 7a. priceUsdc guard (CR-MNR-7: explicit edge-case for non-finite / non-positive
  // price). Without this, values like NaN, Infinity, -1, 0 or sub-atomic ones such
  // as 5e-7 would slip into `parseUnits` and produce 0n or a generic throw.
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
  const usdcAddress = getUsdcAddress();
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
    to: payToCheck.addr, // CD-8: agent.payment.contract validated
    value: value.toString(),
    validAfter: '0',
    validBefore: String(now + VALID_BEFORE_SECONDS),
    nonce,
  };

  // 10. Sign EIP-712 (CD-8: exact USDC domain — Circle USDC ABI is identical
  // on Fuji y Avalanche C-Chain; sólo varía chainId + verifyingContract).
  let signature: Hex;
  try {
    signature = await walletClient.signTypedData({
      account,
      domain: {
        name: USDC_EIP712_NAME,
        version: getUsdcEip712Version(),
        chainId,
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
    network,
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
    // AR-MNR-2: include the facilitator's raw body to distinguish race
    // conditions (e.g. "nonce already used", "balance changed mid-flight")
    // from other errors (5xx, malformed response, network).
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
