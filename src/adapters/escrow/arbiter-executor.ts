/**
 * Arbiter executor — WKH-191g · camino on-chain del árbitro sobre el escrow.
 *
 * Espejo directo de `debit-executor.ts` (hop 1), pero para el rol `arbiter` del
 * contrato `WasiAIEscrow`: mueve fondos escrow-custodiados SIN firma del buyer vía
 * `lockForDispute` / `resolveDispute` / `releaseDispute` (todas `onlyArbiter` +
 * gateadas por `arbitrationConsent(keyId)`), y re-verifica el evento on-chain ANTES
 * de reportar `confirmed` (CD-4). Los 3 executors NUNCA lanzan.
 *
 * Money-safety (CD-4/CD-5/CD-6):
 *   - Sin `ARBITER_PRIVATE_KEY` / RPC → `not_moved` (jamás lanza).
 *   - `writeContract` lanza (pre-broadcast) → `not_moved` (`WRITE_FAILED`).
 *   - Receipt timeout/RPC → `ambiguous` (`RECEIPT_TIMEOUT`; la tx PUDO minarse).
 *   - `receipt.status !== 'success'` → `not_moved` (`REVERTED`, p.ej. NonceAlreadyUsed).
 *   - Receipt success SIN evento matcheado → `ambiguous` (contradicción; NUNCA asumir).
 *
 * Wallet DEDICADA (CD-5): cache propio leyendo `ARBITER_PRIVATE_KEY` — NUNCA reusa el
 * `OPERATOR_PRIVATE_KEY` de `debit-executor.ts`. `deriveArbiterNonce` reserva el bit
 * 255 (rango disjunto del cliente honesto de `debit`) → exactly-once determinista (CD-3).
 */

import {
  BaseError,
  type Chain,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodePacked,
  keccak256,
  parseAbiItem,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getLogger } from '../../lib/logger.js';
import { buildRpcTransport } from '../../lib/rpc-transport.js';
import {
  resolveChainObject,
  resolveMinConfirmations,
  resolveRpcFallbackEnv,
  resolveRpcUrl,
} from '../deposit-verifier.js';
import type { ChainKey } from '../types.js';
import { ESCROW_ABI } from './abi.js';
import { getEscrowReceiptTimeoutMs } from './debit-executor.js';

const log = getLogger('arbiter-executor');

/**
 * viem deriva el topic0 del ABI — NUNCA hardcodear el hash del evento (CD-4).
 * Convergen byte-a-byte con `ESCROW_ABI` / `IWasiAIEscrow.sol:24-28`.
 */
const DISPUTE_LOCKED_EVENT = parseAbiItem(
  'event DisputeLocked(bytes32 indexed keyId, address indexed arbiter, uint256 amount, uint256 totalLocked)',
);
const DISPUTE_RESOLVED_EVENT = parseAbiItem(
  'event DisputeResolved(bytes32 indexed keyId, address indexed arbiter, address indexed seller, uint256 sellerAmount, uint256 nonce)',
);
const DISPUTE_RELEASED_EVENT = parseAbiItem(
  'event DisputeReleased(bytes32 indexed keyId, address indexed arbiter, uint256 releasedAmount)',
);

// ── deriveArbiterNonce — nonce disjunto del cliente honesto de debit (CD-3, §7) ──

/** FLAG bit 255 reservado al árbitro; el cliente de debit usa [0, 2^255). */
const ARBITER_NONCE_FLAG = 1n << 255n;
const ARBITER_NONCE_LOW_MASK = (1n << 255n) - 1n;

/**
 * Nonce del `resolveDispute` del árbitro. Bit 255 SIEMPRE seteado → rango
 * `[2^255, 2^256)`, disjunto del nonce de `debit()`. WKH-194: incorpora el
 * `secret` server-side al digest → el nonce deja de ser re-derivable por el buyer
 * (anti-griefing MNR-1/R-3). Pura dado el secreto: mismo secreto+inputs → mismo
 * nonce; secreto distinto → nonce distinto. Bit-255 intacto (byte-compat con el
 * contrato). El secret NO reemplaza los inputs públicos, se AGREGA.
 */
export function deriveArbiterNonce(
  keyIdHash: string,
  intentId: string,
  secret: string,
): bigint {
  const digest = keccak256(
    encodePacked(
      ['string', 'bytes32', 'string', 'string'],
      [
        'WasiAIEscrow.arbiter-dispute.v1',
        keyIdHash as `0x${string}`,
        intentId,
        secret,
      ],
    ),
  );
  return ARBITER_NONCE_FLAG | (BigInt(digest) & ARBITER_NONCE_LOW_MASK);
}

const ARBITER_NONCE_SECRET_MIN_LEN = 32;
/**
 * Mínimo de caracteres ÚNICOS exigido (WKH-194 · AR MNR-1). La fuerza del secreto
 * depende de su ENTROPÍA, no sólo del largo: el `nonce` se vuelve PÚBLICO al viajar
 * como arg on-chain de `resolveDispute`, así que un secreto ≥32 chars pero de baja
 * entropía (p. ej. `'a'*32`, `'12'*16`) es crackeable offline desde un nonce observado
 * → reabre el griefing R-3. Umbral 16: un `openssl rand -hex 32` (64 hex chars) usa
 * el alfabeto [0-9a-f] (16 símbolos) → con altísima probabilidad exhibe los 16 →
 * PASA; los patrones triviales (todos iguales, secuencia repetida corta) NO llegan a 16.
 */
const ARBITER_NONCE_SECRET_MIN_UNIQUE = 16;

/**
 * Lee `ARBITER_NONCE_SECRET` (WKH-194). Fail-closed (AC-3 / AR MNR-1): devuelve
 * null (→ el caller cae al path operator-custodial en vez de usar una fórmula
 * adivinable) si el secreto es undefined/''/whitespace, o < 32 chars, o de BAJA
 * ENTROPÍA (< 16 caracteres únicos). El chequeo de entropía es imprescindible porque
 * el nonce derivado se publica on-chain: un secreto largo pero trivial es brute-forceable.
 * Nunca lanza. NUNCA loguea el valor del secreto (CD-2): sólo flags booleanos
 * present/weak (jamás el largo real ni el conteo de únicos, para no filtrar entropía).
 */
export function getArbiterNonceSecret(): string | null {
  const raw = process.env.ARBITER_NONCE_SECRET;
  if (raw === undefined || raw.trim() === '') {
    log.warn(
      { present: false },
      'ARBITER_NONCE_SECRET ausente; arbiter cae a operator-custodial',
    );
    return null;
  }
  const secret = raw.trim();
  if (secret.length < ARBITER_NONCE_SECRET_MIN_LEN) {
    log.warn(
      { present: true, weak: true },
      'ARBITER_NONCE_SECRET débil (<32 chars); fallback fail-closed',
    );
    return null;
  }
  // Entropía (AR MNR-1): rechazar secretos de baja entropía aunque cumplan el largo.
  // Heurística defendible: exigir ≥16 caracteres únicos. Descarta patrones triviales
  // ('a'*32 → 1 único; '12'*16 → 2 únicos) sin rechazar CSPRNG hex ('openssl rand -hex 32').
  const uniqueChars = new Set(secret).size;
  if (uniqueChars < ARBITER_NONCE_SECRET_MIN_UNIQUE) {
    log.warn(
      { present: true, weak: true },
      'ARBITER_NONCE_SECRET de baja entropía; fallback fail-closed (usar `openssl rand -hex 32`)',
    );
    return null;
  }
  return secret;
}

/** Razón canónica de colisión de nonce (comparación sin magic-string en arbiter.ts). */
export const ARBITER_NONCE_COLLISION_REASON = 'NONCE_ALREADY_USED';

// ── Outcome (misma forma que Hop1Outcome — debit-executor.ts:57-60) ──

export type ArbiterOnChainOutcome =
  | { kind: 'confirmed'; txHash: `0x${string}`; blockNumber: bigint }
  | { kind: 'not_moved'; reason: string; txHash?: `0x${string}` }
  | { kind: 'ambiguous'; reason: string; txHash?: `0x${string}` };

// ── Lazy client cache per ChainKey (propio; CD-5, NO reusar debit-executor) ──

type ArbiterWalletClient = ReturnType<typeof createWalletClient>;
type ArbiterPublicClient = ReturnType<typeof createPublicClient>;

const _arbiterWalletClients = new Map<ChainKey, ArbiterWalletClient>();
const _arbiterPublicClients = new Map<ChainKey, ArbiterPublicClient>();

/**
 * Wallet client del ÁRBITRO para la `ChainKey`. Sin `ARBITER_PRIVATE_KEY` o sin RPC
 * → `null` (el executor lo traduce a `not_moved`, NUNCA lanza). CD-5: PROHIBIDO
 * reusar `OPERATOR_PRIVATE_KEY`.
 */
function getArbiterWalletClient(
  chainKey: ChainKey,
): ArbiterWalletClient | null {
  const cached = _arbiterWalletClients.get(chainKey);
  if (cached) return cached;
  const pk = process.env.ARBITER_PRIVATE_KEY;
  if (!pk) return null;
  const rpcUrl = resolveRpcUrl(chainKey);
  if (!rpcUrl) return null;
  let account: ReturnType<typeof privateKeyToAccount>;
  try {
    account = privateKeyToAccount(pk as `0x${string}`);
  } catch {
    return null;
  }
  const chain = resolveChainObject(chainKey);
  const client = createWalletClient({
    account,
    chain,
    transport: buildRpcTransport({
      primary: rpcUrl,
      fallbackEnv: resolveRpcFallbackEnv(chainKey),
      chainId: chain.id,
    }),
  });
  _arbiterWalletClients.set(chainKey, client);
  return client;
}

/** Public client para `waitForTransactionReceipt`, cacheado per-ChainKey (propio). */
function getArbiterPublicClient(
  chainKey: ChainKey,
): ArbiterPublicClient | null {
  const cached = _arbiterPublicClients.get(chainKey);
  if (cached) return cached;
  const rpcUrl = resolveRpcUrl(chainKey);
  if (!rpcUrl) return null;
  const chain = resolveChainObject(chainKey) as Chain;
  const client = createPublicClient({
    chain,
    transport: buildRpcTransport({
      primary: rpcUrl,
      fallbackEnv: resolveRpcFallbackEnv(chainKey),
      chainId: chain.id,
    }),
  });
  _arbiterPublicClients.set(chainKey, client);
  return client;
}

/** TEST-ONLY — limpia ambos caches (patrón `_resetDebitExecutor`). */
export function _resetArbiterExecutor(): void {
  _arbiterWalletClients.clear();
  _arbiterPublicClients.clear();
}

/**
 * `lockForDispute(keyId, amount)` — best-effort. Congela `amount` del deposit del
 * keyId bajo el rol arbiter. Verifica `DisputeLocked(keyId, ...)`. Nunca lanza.
 */
export async function executeLockForDispute(args: {
  chainKey: ChainKey;
  escrowContract: `0x${string}`;
  keyIdHash: string;
  amount: bigint;
}): Promise<ArbiterOnChainOutcome> {
  const { chainKey, escrowContract, keyIdHash, amount } = args;

  const wallet = getArbiterWalletClient(chainKey);
  const publicClient = getArbiterPublicClient(chainKey);
  if (!wallet || !publicClient) {
    return { kind: 'not_moved', reason: 'ARBITER_KEY_OR_RPC_UNSET' };
  }

  let txHash: `0x${string}`;
  try {
    txHash = await wallet.writeContract({
      address: escrowContract,
      abi: ESCROW_ABI,
      functionName: 'lockForDispute',
      args: [keyIdHash as `0x${string}`, amount],
      chain: resolveChainObject(chainKey) as Chain,
      account: wallet.account ?? null,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn(
      { chainKey, detail },
      'escrow.lockForDispute writeContract failed (pre-broadcast)',
    );
    return { kind: 'not_moved', reason: 'WRITE_FAILED' };
  }

  let receipt: Awaited<
    ReturnType<ArbiterPublicClient['waitForTransactionReceipt']>
  >;
  try {
    receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: getEscrowReceiptTimeoutMs(),
      confirmations: resolveMinConfirmations(chainKey),
    });
  } catch {
    return { kind: 'ambiguous', reason: 'RECEIPT_TIMEOUT', txHash };
  }

  if (receipt.status !== 'success') {
    return { kind: 'not_moved', reason: 'REVERTED', txHash };
  }

  const escrowLc = escrowContract.toLowerCase();
  let matched = false;
  for (const logEntry of receipt.logs) {
    if (logEntry.address.toLowerCase() !== escrowLc) continue;
    let decoded: ReturnType<
      typeof decodeEventLog<
        readonly [typeof DISPUTE_LOCKED_EVENT],
        'DisputeLocked'
      >
    >;
    try {
      decoded = decodeEventLog({
        abi: [DISPUTE_LOCKED_EVENT],
        eventName: 'DisputeLocked',
        data: logEntry.data,
        topics: logEntry.topics,
      });
    } catch {
      continue;
    }
    if (decoded.args.keyId.toLowerCase() === keyIdHash.toLowerCase()) {
      matched = true;
      break;
    }
  }
  if (!matched) {
    return { kind: 'ambiguous', reason: 'DISPUTE_LOCKED_NOT_FOUND', txHash };
  }

  return { kind: 'confirmed', txHash, blockNumber: receipt.blockNumber };
}

/**
 * `resolveDispute(keyId, seller, sellerAmount, nonce)` — camino money del árbitro.
 * Libera `sellerAmount` al seller (release/split). Verifica
 * `DisputeResolved(keyId, ..., nonce)` (match por keyId Y nonce). Nunca lanza.
 */
export async function executeResolveDispute(args: {
  chainKey: ChainKey;
  escrowContract: `0x${string}`;
  keyIdHash: string;
  seller: string;
  sellerAmount: bigint;
  nonce: bigint;
}): Promise<ArbiterOnChainOutcome> {
  const { chainKey, escrowContract, keyIdHash, seller, sellerAmount, nonce } =
    args;

  const wallet = getArbiterWalletClient(chainKey);
  const publicClient = getArbiterPublicClient(chainKey);
  if (!wallet || !publicClient) {
    return { kind: 'not_moved', reason: 'ARBITER_KEY_OR_RPC_UNSET' };
  }

  let txHash: `0x${string}`;
  try {
    txHash = await wallet.writeContract({
      address: escrowContract,
      abi: ESCROW_ABI,
      functionName: 'resolveDispute',
      args: [
        keyIdHash as `0x${string}`,
        seller as `0x${string}`,
        sellerAmount,
        nonce,
      ],
      chain: resolveChainObject(chainKey) as Chain,
      account: wallet.account ?? null,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn(
      { chainKey, detail },
      'escrow.resolveDispute writeContract failed (pre-broadcast)',
    );
    return { kind: 'not_moved', reason: 'WRITE_FAILED' };
  }

  let receipt: Awaited<
    ReturnType<ArbiterPublicClient['waitForTransactionReceipt']>
  >;
  try {
    receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: getEscrowReceiptTimeoutMs(),
      confirmations: resolveMinConfirmations(chainKey),
    });
  } catch {
    return { kind: 'ambiguous', reason: 'RECEIPT_TIMEOUT', txHash };
  }

  if (receipt.status !== 'success') {
    // WKH-194: best-effort — ¿el revert fue por colisión de nonce (pre-consumo/griefing)?
    // El simulate corre a estado 'latest' donde el nonce YA está consumido → reproduce
    // NonceAlreadyUsed. Cualquier fallo del simulate / otra causa → 'REVERTED' (conservador,
    // comportamiento de hoy). Nunca lanza.
    try {
      await publicClient.simulateContract({
        address: escrowContract,
        abi: ESCROW_ABI,
        functionName: 'resolveDispute',
        args: [
          keyIdHash as `0x${string}`,
          seller as `0x${string}`,
          sellerAmount,
          nonce,
        ],
        account: wallet.account ?? undefined,
      });
    } catch (simErr) {
      if (
        simErr instanceof BaseError &&
        simErr.walk(
          (e) => e instanceof ContractFunctionRevertedError,
        ) instanceof ContractFunctionRevertedError
      ) {
        const revert = simErr.walk(
          (e) => e instanceof ContractFunctionRevertedError,
        ) as ContractFunctionRevertedError;
        if (revert.data?.errorName === 'NonceAlreadyUsed') {
          return {
            kind: 'not_moved',
            reason: ARBITER_NONCE_COLLISION_REASON,
            txHash,
          };
        }
      }
    }
    return { kind: 'not_moved', reason: 'REVERTED', txHash };
  }

  const escrowLc = escrowContract.toLowerCase();
  let matched = false;
  for (const logEntry of receipt.logs) {
    if (logEntry.address.toLowerCase() !== escrowLc) continue;
    let decoded: ReturnType<
      typeof decodeEventLog<
        readonly [typeof DISPUTE_RESOLVED_EVENT],
        'DisputeResolved'
      >
    >;
    try {
      decoded = decodeEventLog({
        abi: [DISPUTE_RESOLVED_EVENT],
        eventName: 'DisputeResolved',
        data: logEntry.data,
        topics: logEntry.topics,
      });
    } catch {
      continue;
    }
    if (
      decoded.args.keyId.toLowerCase() === keyIdHash.toLowerCase() &&
      decoded.args.nonce === nonce
    ) {
      matched = true;
      break;
    }
  }
  if (!matched) {
    return { kind: 'ambiguous', reason: 'DISPUTE_RESOLVED_NOT_FOUND', txHash };
  }

  return { kind: 'confirmed', txHash, blockNumber: receipt.blockNumber };
}

/**
 * `releaseDispute(keyId)` — best-effort. Libera el lock del keyId (refund: los
 * fondos quedan reclamables por el buyer). Verifica `DisputeReleased(keyId, ...)`.
 * Nunca lanza.
 */
export async function executeReleaseDispute(args: {
  chainKey: ChainKey;
  escrowContract: `0x${string}`;
  keyIdHash: string;
}): Promise<ArbiterOnChainOutcome> {
  const { chainKey, escrowContract, keyIdHash } = args;

  const wallet = getArbiterWalletClient(chainKey);
  const publicClient = getArbiterPublicClient(chainKey);
  if (!wallet || !publicClient) {
    return { kind: 'not_moved', reason: 'ARBITER_KEY_OR_RPC_UNSET' };
  }

  let txHash: `0x${string}`;
  try {
    txHash = await wallet.writeContract({
      address: escrowContract,
      abi: ESCROW_ABI,
      functionName: 'releaseDispute',
      args: [keyIdHash as `0x${string}`],
      chain: resolveChainObject(chainKey) as Chain,
      account: wallet.account ?? null,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn(
      { chainKey, detail },
      'escrow.releaseDispute writeContract failed (pre-broadcast)',
    );
    return { kind: 'not_moved', reason: 'WRITE_FAILED' };
  }

  let receipt: Awaited<
    ReturnType<ArbiterPublicClient['waitForTransactionReceipt']>
  >;
  try {
    receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: getEscrowReceiptTimeoutMs(),
      confirmations: resolveMinConfirmations(chainKey),
    });
  } catch {
    return { kind: 'ambiguous', reason: 'RECEIPT_TIMEOUT', txHash };
  }

  if (receipt.status !== 'success') {
    return { kind: 'not_moved', reason: 'REVERTED', txHash };
  }

  const escrowLc = escrowContract.toLowerCase();
  let matched = false;
  for (const logEntry of receipt.logs) {
    if (logEntry.address.toLowerCase() !== escrowLc) continue;
    let decoded: ReturnType<
      typeof decodeEventLog<
        readonly [typeof DISPUTE_RELEASED_EVENT],
        'DisputeReleased'
      >
    >;
    try {
      decoded = decodeEventLog({
        abi: [DISPUTE_RELEASED_EVENT],
        eventName: 'DisputeReleased',
        data: logEntry.data,
        topics: logEntry.topics,
      });
    } catch {
      continue;
    }
    if (decoded.args.keyId.toLowerCase() === keyIdHash.toLowerCase()) {
      matched = true;
      break;
    }
  }
  if (!matched) {
    return { kind: 'ambiguous', reason: 'DISPUTE_RELEASED_NOT_FOUND', txHash };
  }

  return { kind: 'confirmed', txHash, blockNumber: receipt.blockNumber };
}
