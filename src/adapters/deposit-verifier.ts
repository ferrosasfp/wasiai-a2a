/**
 * Deposit verifier (WKH-35).
 *
 * Reads an on-chain transaction receipt with a per-chain viem `publicClient`
 * and verifies a confirmed ERC-20 deposit to the expected treasury BEFORE any
 * budget is credited (CD-4: verify-before-credit). No state is mutated here.
 *
 * Multi-chain: one lazy-cached `publicClient` per `ChainKey`. RPC URL, treasury
 * and minimum confirmations come from env (CD-3: no hardcodes). The credited
 * `chainId` is the bundle's chainId, never the caller's (CD-5).
 */
import type { Chain, PublicClient } from 'viem';
import {
  createPublicClient,
  http,
  formatUnits,
  parseUnits,
  decodeEventLog,
  parseAbiItem,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ChainKey, AdaptersBundle } from './types.js';
import { getKiteChain } from './kite-ozone/chain.js';
import { getBaseChain } from './base/chain.js';
import { getAvalancheChain } from './avalanche/chain.js';

export type DepositVerificationReason =
  | 'TX_NOT_FOUND'
  | 'TX_REVERTED'
  | 'INSUFFICIENT_CONFIRMATIONS'
  | 'RECIPIENT_MISMATCH'
  | 'TOKEN_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'CHAIN_MISMATCH'
  | 'RPC_UNAVAILABLE';

export interface DepositVerification {
  ok: boolean;
  reason?: DepositVerificationReason; // poblado solo si ok=false (AC-2)
  amountAtomic?: bigint; // monto transferido en unidades atómicas
  amountUsd?: string; // amountAtomic formateado vía decimals del token (DT-6)
  token?: `0x${string}`; // token contract verificado
  tokenSymbol?: string; // símbolo (supportedTokens[0].symbol) — auditoría/registerDeposit
  recipient?: `0x${string}`; // recipient verificado (== treasury esperado)
  from?: `0x${string}`; // depositor (Transfer.from) — FIX-1: gate funding_wallet
  confirmations?: number;
}

export interface VerifyDepositArgs {
  chainKey: ChainKey;
  bundle: AdaptersBundle;
  txHash: `0x${string}`;
  expectedAmountUsd?: string; // body.amount declarado (opcional; → AMOUNT_MISMATCH)
}

// ── Constants / helpers (no hardcodes — CD-3) ───────────────

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// viem deriva el topic0 del ABI — NO hardcodear el hash del evento Transfer (CD-3).
const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

type ChainFamily = 'KITE' | 'AVALANCHE' | 'BASE';

function resolveChainFamilyEnvSuffix(chainKey: ChainKey): ChainFamily {
  switch (chainKey) {
    case 'kite-ozone-testnet':
    case 'kite-mainnet':
      return 'KITE';
    case 'avalanche-fuji':
    case 'avalanche-mainnet':
      return 'AVALANCHE';
    case 'base-sepolia':
    case 'base-mainnet':
      return 'BASE';
  }
}

/**
 * Minimum confirmations before crediting (DT-3). Per-chain override
 * `A2A_DEPOSIT_MIN_CONFIRMATIONS_<FAMILY>` → global `A2A_DEPOSIT_MIN_CONFIRMATIONS`
 * → fallback 1. Validated `>= 1` (CD-11: afirmar, no asumir defaults silenciosos).
 */
function resolveMinConfirmations(chainKey: ChainKey): number {
  const family = resolveChainFamilyEnvSuffix(chainKey);
  const perChain = process.env[`A2A_DEPOSIT_MIN_CONFIRMATIONS_${family}`];
  const global = process.env.A2A_DEPOSIT_MIN_CONFIRMATIONS;
  const raw = perChain ?? global;
  if (raw === undefined || raw === '') return 1;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return parsed;
}

/**
 * Expected recipient (treasury) for the deposit (DT-2). Per-chain
 * `A2A_DEPOSIT_TREASURY_<FAMILY>` → fallback operator address derived from
 * `OPERATOR_PRIVATE_KEY`. Returns `null` if neither is available/valid
 * (fail-loud → RECIPIENT_MISMATCH, cero crédito).
 */
function resolveTreasury(chainKey: ChainKey): `0x${string}` | null {
  const family = resolveChainFamilyEnvSuffix(chainKey);
  const envTreasury = process.env[`A2A_DEPOSIT_TREASURY_${family}`];
  if (envTreasury && ADDRESS_RE.test(envTreasury)) {
    return envTreasury as `0x${string}`;
  }
  const pk = process.env.OPERATOR_PRIVATE_KEY;
  if (pk) {
    try {
      return privateKeyToAccount(pk as `0x${string}`).address;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * RPC URL per `ChainKey`, from the SAME env-resolution used by each adapter
 * (Story File §2). Returns `undefined` if not set → RPC_UNAVAILABLE.
 */
function resolveRpcUrl(chainKey: ChainKey): string | undefined {
  switch (chainKey) {
    case 'kite-ozone-testnet':
      return process.env.KITE_RPC_URL;
    case 'kite-mainnet':
      return process.env.KITE_MAINNET_RPC_URL ?? process.env.KITE_RPC_URL;
    case 'avalanche-mainnet':
      return process.env.AVALANCHE_RPC_URL;
    case 'avalanche-fuji':
      return process.env.FUJI_RPC_URL;
    case 'base-mainnet':
      return process.env.BASE_MAINNET_RPC_URL;
    case 'base-sepolia':
      return process.env.BASE_TESTNET_RPC_URL;
  }
}

/**
 * viem `chain` object per `ChainKey` (TBD-2 resuelto). Reusa los helpers de
 * cada adapter — NO importa `viem/chains` directo para Kite (usa defineChain).
 */
function resolveChainObject(chainKey: ChainKey): Chain {
  switch (chainKey) {
    case 'kite-ozone-testnet':
    case 'kite-mainnet':
      return getKiteChain();
    case 'avalanche-mainnet':
      return getAvalancheChain('mainnet');
    case 'avalanche-fuji':
      return getAvalancheChain('fuji');
    case 'base-mainnet':
      return getBaseChain('mainnet');
    case 'base-sepolia':
      return getBaseChain('testnet');
  }
}

// ── Lazy publicClient cache per ChainKey ────────────────────

const _clients = new Map<ChainKey, PublicClient>();

function getVerifierClient(chainKey: ChainKey): PublicClient | null {
  const cached = _clients.get(chainKey);
  if (cached) return cached;
  const rpcUrl = resolveRpcUrl(chainKey);
  if (!rpcUrl) return null;
  const client = createPublicClient({
    chain: resolveChainObject(chainKey),
    transport: http(rpcUrl),
  }) as PublicClient;
  _clients.set(chainKey, client);
  return client;
}

/** TEST-ONLY — clears the publicClient cache (patrón _resetClient). */
export function _resetVerifier(): void {
  _clients.clear();
}

// ── Public API ──────────────────────────────────────────────

export async function verifyDeposit(
  args: VerifyDepositArgs,
): Promise<DepositVerification> {
  const { chainKey, bundle, txHash, expectedAmountUsd } = args;

  // 1. publicClient — RPC URL ausente → fail-loud, cero crédito (CD-4).
  const client = getVerifierClient(chainKey);
  if (!client) {
    return { ok: false, reason: 'RPC_UNAVAILABLE' };
  }

  // 2. Receipt — si throw / no encontrado → TX_NOT_FOUND.
  let receipt: Awaited<ReturnType<PublicClient['getTransactionReceipt']>>;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch {
    return { ok: false, reason: 'TX_NOT_FOUND' };
  }

  // 3. Status (AC-2).
  if (receipt.status !== 'success') {
    return { ok: false, reason: 'TX_REVERTED' };
  }

  // 4. chainId match (AC-4 / CD-5).
  let onchainChainId: number;
  try {
    onchainChainId = await client.getChainId();
  } catch {
    return { ok: false, reason: 'RPC_UNAVAILABLE' };
  }
  if (onchainChainId !== bundle.chainConfig.chainId) {
    return { ok: false, reason: 'CHAIN_MISMATCH' };
  }

  // 5. Confirmaciones (DT-3 / CD-11).
  let latest: bigint;
  try {
    latest = await client.getBlockNumber();
  } catch {
    return { ok: false, reason: 'RPC_UNAVAILABLE' };
  }
  const confirmations = Number(latest - receipt.blockNumber) + 1;
  const min = resolveMinConfirmations(chainKey);
  if (confirmations < min) {
    return { ok: false, reason: 'INSUFFICIENT_CONFIRMATIONS', confirmations };
  }

  // 6. token + recipient + amount (AC-1).
  const token = bundle.payment.supportedTokens[0];
  const expectedTokenAddr = token.address.toLowerCase();
  const expectedTreasury = resolveTreasury(chainKey);
  if (!expectedTreasury) {
    return { ok: false, reason: 'RECIPIENT_MISMATCH', confirmations };
  }
  const expectedTreasuryLc = expectedTreasury.toLowerCase();

  let tokenLogSeen = false;
  let amountAtomic: bigint | undefined;
  let depositor: `0x${string}` | undefined;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== expectedTokenAddr) continue;
    let decoded: ReturnType<
      typeof decodeEventLog<readonly [typeof TRANSFER_EVENT], 'Transfer'>
    >;
    try {
      decoded = decodeEventLog({
        abi: [TRANSFER_EVENT],
        eventName: 'Transfer',
        data: log.data,
        topics: log.topics,
      });
    } catch {
      // log del token que no es un Transfer decodificable — ignorar.
      continue;
    }
    tokenLogSeen = true;
    const { from, to, value } = decoded.args;
    if (to.toLowerCase() === expectedTreasuryLc) {
      amountAtomic = value;
      // FIX-1 (BLQ-MED-1): el depositor (Transfer.from) se devuelve para que
      // el handler exija `from == key.funding_wallet`. El treasury es
      // compartido → validar solo `to` permitiría front-run de txHash ajeno.
      depositor = from;
      break;
    }
  }

  if (!tokenLogSeen) {
    return { ok: false, reason: 'TOKEN_MISMATCH', confirmations };
  }
  if (amountAtomic === undefined || depositor === undefined) {
    return { ok: false, reason: 'RECIPIENT_MISMATCH', confirmations };
  }

  // 7. amount → USD (DT-6 / CD-10): decimals del token, NUNCA literal.
  const amountUsd = formatUnits(amountAtomic, token.decimals);
  if (expectedAmountUsd !== undefined) {
    // FIX-3 (MNR): comparación sin pérdida de precisión. `Number(...)` colapsa
    // 1.000000000000000001 a 1 (float64). En su lugar reparseamos el monto
    // declarado a unidades atómicas con los MISMOS decimals del token y
    // comparamos BigInt contra BigInt. parseUnits lanza si el string es
    // inválido o tiene más decimales que el token → AMOUNT_MISMATCH.
    let expectedAtomic: bigint | undefined;
    try {
      expectedAtomic = parseUnits(expectedAmountUsd, token.decimals);
    } catch {
      expectedAtomic = undefined;
    }
    if (expectedAtomic === undefined || expectedAtomic !== amountAtomic) {
      return { ok: false, reason: 'AMOUNT_MISMATCH', confirmations };
    }
  }

  // 8. Éxito.
  return {
    ok: true,
    amountAtomic,
    amountUsd,
    token: token.address,
    tokenSymbol: token.symbol,
    recipient: expectedTreasury,
    from: depositor,
    confirmations,
  };
}
