/**
 * Reconciler on-chain reader — WKH-191c.
 *
 * Re-verifica la REALIDAD on-chain del hop 1 (`escrow.debit`) ANTES de que el motor
 * de reconciliación decida el lado (settle-retry XOR refund). NUNCA muta estado y
 * NUNCA lanza (defensivo): la incertidumbre (RPC caído / hash null / receipt no
 * encontrado) se traduce a `'indeterminate'` → el service aborta (CD-3: nunca decidir
 * sobre incertidumbre).
 *
 *   - `reverifyDebitedByTxHash` → `'confirmed' | 'not_confirmed' | 'indeterminate'`:
 *       la fuente de verdad del hop 1 es el evento `Debited(keyId, nonce)` en el
 *       receipt de la tx del hop 1, NUNCA el `debit_settle_status` persistido (puede
 *       ser tentativo).
 *   - `readEscrowBalanceAtomic` → `bigint | null`: el saldo escrow on-chain de la key
 *       (fuente de verdad del drift, CD-4); `null` cuando no se pudo computar.
 *
 * Cache de public-client per-`ChainKey` (Map propio; espejo `_clients` de
 * `escrow-verifier.ts`). `parseAbiItem`/`decodeEventLog`/`ESCROW_ABI` derivan el
 * topic0 por viem — NUNCA literal (CD-3).
 */

import type { PublicClient } from 'viem';
import { createPublicClient, decodeEventLog, http, parseAbiItem } from 'viem';
import { resolveChainObject, resolveRpcUrl } from '../deposit-verifier.js';
import type { ChainKey } from '../types.js';
import { ESCROW_ABI } from './abi.js';

/**
 * viem deriva el topic0 del ABI — NUNCA hardcodear el hash del evento `Debited`
 * (CD-3). Converge byte-a-byte con `debit-executor.ts:53-55` / `ESCROW_ABI.Debited`.
 */
const DEBITED_EVENT = parseAbiItem(
  'event Debited(bytes32 indexed keyId, address indexed operator, uint256 amount, uint256 nonce)',
);

export type DebitReverifyResult =
  | 'confirmed'
  | 'not_confirmed'
  | 'indeterminate';

// ── Lazy public-client cache per ChainKey (propio; espejo escrow-verifier.ts) ──

const _clients = new Map<ChainKey, PublicClient>();

function getReconcilerClient(chainKey: ChainKey): PublicClient | null {
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

/** TEST-ONLY — limpia el cache (patrón `_resetEscrowVerifier`). */
export function _resetReconcilerOnchain(): void {
  _clients.clear();
}

/**
 * Re-verifica el hop 1 on-chain por su tx hash (CD-3). La decisión del lado se apoya
 * SOLO en este resultado, nunca en el `debit_settle_status` persistido.
 *
 *   - `txHash` null / sin prefijo `0x` → `'indeterminate'` (huérfano sin hash: NO
 *     asumir not_confirmed; surface para revisión — evita refund erróneo).
 *   - RPC ausente / `getTransactionReceipt` throw / no encontrado → `'indeterminate'`.
 *   - `receipt.status !== 'success'` (revert) → `'not_confirmed'` (el debit no ocurrió).
 *   - receipt success con `Debited` matcheado (keyId + nonce) → `'confirmed'`.
 *   - receipt success SIN match → `'not_confirmed'`.
 */
export async function reverifyDebitedByTxHash(args: {
  chainKey: ChainKey;
  escrowContract: `0x${string}`;
  txHash: string | null;
  keyIdHash: string;
  nonce: bigint;
}): Promise<DebitReverifyResult> {
  const { chainKey, escrowContract, txHash, keyIdHash, nonce } = args;

  // Huérfano sin hash: NO decidir (evita refund erróneo sobre un débito real).
  if (!txHash?.startsWith('0x')) return 'indeterminate';

  const client = getReconcilerClient(chainKey);
  if (!client) return 'indeterminate';

  let receipt: Awaited<ReturnType<PublicClient['getTransactionReceipt']>>;
  try {
    receipt = await client.getTransactionReceipt({
      hash: txHash as `0x${string}`,
    });
  } catch {
    // CD-3: RPC caído / tx no encontrada → nunca decidir sobre incertidumbre.
    return 'indeterminate';
  }

  // Revert → el débito NO ocurrió (money-safe: el escrow del buyer sigue intacto).
  if (receipt.status !== 'success') return 'not_confirmed';

  // Scan de los logs del CONTRATO ESCROW por el evento `Debited(keyId, nonce)`.
  const escrowLc = escrowContract.toLowerCase();
  for (const logEntry of receipt.logs) {
    if (logEntry.address.toLowerCase() !== escrowLc) continue;
    let decoded: ReturnType<
      typeof decodeEventLog<readonly [typeof DEBITED_EVENT], 'Debited'>
    >;
    try {
      decoded = decodeEventLog({
        abi: [DEBITED_EVENT],
        eventName: 'Debited',
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
      return 'confirmed';
    }
  }

  // Success SIN evento matcheado → el débito no se ejecutó para esta key/nonce.
  return 'not_confirmed';
}

/**
 * Saldo escrow on-chain (atomic, 6-dec) de la key — fuente de verdad del drift
 * (CD-4). Error / RPC caído → `null` (drift no-computable para esa key → se reporta
 * como tal, NUNCA se asume 0).
 */
export async function readEscrowBalanceAtomic(args: {
  chainKey: ChainKey;
  escrowContract: `0x${string}`;
  keyIdHash: `0x${string}`;
}): Promise<bigint | null> {
  const { chainKey, escrowContract, keyIdHash } = args;
  const client = getReconcilerClient(chainKey);
  if (!client) return null;
  try {
    const balance = await client.readContract({
      address: escrowContract,
      abi: ESCROW_ABI,
      functionName: 'escrowBalance',
      args: [keyIdHash],
    });
    return balance as bigint;
  } catch {
    return null;
  }
}
