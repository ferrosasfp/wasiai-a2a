/**
 * Ejecutor del hop 1 del two-hop settle — WKH-191b.
 *
 * `executeDebitHop1` invoca `escrow.debit(keyId, amount, deadline, nonce,
 * signature)` con la firma `DebitAuthorization` cruda que 191a persistió (CD-7:
 * NO re-firma nada), mueve fondos del BUYER del escrow al operador, y re-verifica
 * el evento `Debited` on-chain ANTES de reportar `confirmed`. El operador reenvía
 * al seller en el hop 2 (el seam WKH-136, fuera de este módulo).
 *
 * Money-safety (§6 del SDD):
 *   - Sin PK/RPC → `not_moved` (jamás lanza).
 *   - `writeContract` lanza (pre-broadcast) → `not_moved` (AC-3, cero fondos).
 *   - Receipt timeout/RPC → `ambiguous` (la tx PUDO minarse → NO asumir, NO hop 2).
 *   - `receipt.status !== 'success'` → `not_moved` (revert, p.ej. NonceAlreadyUsed).
 *   - Receipt success SIN evento `Debited` matcheado → `ambiguous` (contradicción;
 *     NUNCA asumir confirmado).
 *   - `Debited(keyId, nonce)` matcheado → `confirmed`.
 *
 * Cache de clients per-`ChainKey` (espejo `gasless.ts`/`escrow-verifier.ts`);
 * `waitForTransactionReceipt` con `confirmations: resolveMinConfirmations()` (CD-8).
 */

import {
  type Chain,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  parseAbiItem,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getLogger } from '../../lib/logger.js';
import { buildRpcTransport } from '../../lib/rpc-transport.js';
import { supabase } from '../../lib/supabase.js';
import {
  resolveChainObject,
  resolveMinConfirmations,
  resolveRpcFallbackEnv,
  resolveRpcUrl,
} from '../deposit-verifier.js';
import type { ChainKey } from '../types.js';
import { ESCROW_ABI } from './abi.js';

const log = getLogger('debit-executor');

// Timeout del receipt on-chain (ms). CD-8: el timeout THROWS (→ ambiguous), no se
// refleja en el receipt. Env override no bloqueante (patrón gasless.ts:229-232).
const RECEIPT_TIMEOUT_MS_DEFAULT = 60_000;

/**
 * viem deriva el topic0 del ABI — NUNCA hardcodear el hash del evento `Debited`
 * (Exemplar 2). Converge byte-a-byte con `ESCROW_ABI.Debited` / `WasiAIEscrow.sol:62`.
 */
const DEBITED_EVENT = parseAbiItem(
  'event Debited(bytes32 indexed keyId, address indexed operator, uint256 amount, uint256 nonce)',
);

export type Hop1Outcome =
  | { kind: 'confirmed'; txHash: `0x${string}`; blockNumber: bigint }
  | { kind: 'not_moved'; reason: string; txHash?: `0x${string}` }
  | { kind: 'ambiguous'; reason: string; txHash?: `0x${string}` };

// ── Lazy client cache per ChainKey (propio; espejo escrow-verifier.ts) ──────

type EscrowWalletClient = ReturnType<typeof createWalletClient>;
type EscrowPublicClient = ReturnType<typeof createPublicClient>;

const _walletClients = new Map<ChainKey, EscrowWalletClient>();
const _publicClients = new Map<ChainKey, EscrowPublicClient>();

/**
 * Wallet client del operador para la `ChainKey`. Sin `OPERATOR_PRIVATE_KEY` o sin
 * RPC → `null` (el executor lo traduce a `not_moved`, NUNCA lanza).
 */
function getEscrowWalletClient(chainKey: ChainKey): EscrowWalletClient | null {
  const cached = _walletClients.get(chainKey);
  if (cached) return cached;
  const pk = process.env.OPERATOR_PRIVATE_KEY;
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
  _walletClients.set(chainKey, client);
  return client;
}

/** Public client para `waitForTransactionReceipt`, cacheado per-ChainKey. */
function getEscrowPublicClient(chainKey: ChainKey): EscrowPublicClient | null {
  const cached = _publicClients.get(chainKey);
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
  _publicClients.set(chainKey, client);
  return client;
}

/** Timeout del receipt (ms). Env `ESCROW_DEBIT_RECEIPT_TIMEOUT_MS`, default 60_000. */
export function getEscrowReceiptTimeoutMs(): number {
  const raw = process.env.ESCROW_DEBIT_RECEIPT_TIMEOUT_MS;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : RECEIPT_TIMEOUT_MS_DEFAULT;
}

/** TEST-ONLY — limpia ambos caches (patrón `_resetEscrowVerifier`). */
export function _resetDebitExecutor(): void {
  _walletClients.clear();
  _publicClients.clear();
}

/**
 * Hop 1: mueve fondos del buyer del escrow al operador vía `escrow.debit(...)` con
 * la firma cruda persistida por 191a. Devuelve `Hop1Outcome` (nunca lanza).
 */
export async function executeDebitHop1(args: {
  chainKey: ChainKey;
  escrowContract: `0x${string}`;
  keyIdHash: string;
  amount: bigint;
  deadline: bigint;
  nonce: bigint;
  signature: string;
}): Promise<Hop1Outcome> {
  const { chainKey, escrowContract, keyIdHash, amount, deadline, nonce } = args;

  // 1. Clients — sin PK/RPC → not_moved (NO lanzar; AC-3, cero evidencia).
  const wallet = getEscrowWalletClient(chainKey);
  const publicClient = getEscrowPublicClient(chainKey);
  if (!wallet || !publicClient) {
    return { kind: 'not_moved', reason: 'OPERATOR_KEY_OR_RPC_UNSET' };
  }

  // 2. Submit `debit` — catch = pre-broadcast → not_moved (AC-3, fondos intactos).
  let txHash: `0x${string}`;
  try {
    txHash = await wallet.writeContract({
      address: escrowContract,
      abi: ESCROW_ABI,
      functionName: 'debit',
      args: [
        keyIdHash as `0x${string}`,
        amount,
        deadline,
        nonce,
        args.signature as `0x${string}`,
      ],
      chain: resolveChainObject(chainKey) as Chain,
      account: wallet.account ?? null,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn(
      { chainKey, detail },
      'escrow.debit writeContract failed (pre-broadcast)',
    );
    return { kind: 'not_moved', reason: 'WRITE_FAILED' };
  }

  // 3. Receipt — timeout/RPC THROWS (CD-8) → ambiguous (la tx PUDO minarse).
  let receipt: Awaited<
    ReturnType<EscrowPublicClient['waitForTransactionReceipt']>
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

  // 4. Status — revert (p.ej. NonceAlreadyUsed) → not_moved (R-2, money-safe).
  if (receipt.status !== 'success') {
    return { kind: 'not_moved', reason: 'REVERTED', txHash };
  }

  // 5. Re-verify `Debited(keyId, nonce)` en los logs del escrow (Exemplar 2).
  const escrowLc = escrowContract.toLowerCase();
  let matched = false;
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
      matched = true;
      break;
    }
  }

  // Receipt success SIN evento matcheado = contradicción → NUNCA asumir confirmado.
  if (!matched) {
    return { kind: 'ambiguous', reason: 'DEBITED_EVENT_NOT_FOUND', txHash };
  }

  // 6. Confirmado: fondos del buyer movidos al operador on-chain.
  return { kind: 'confirmed', txHash, blockNumber: receipt.blockNumber };
}

// ── Wrappers de los RPC owner-guarded (191b) ────────────────────────────────

/**
 * Persiste el tx hash de hop 1 ANTES de hop 2 (BLQ-DR/CD-3). Idempotente por
 * COALESCE en el RPC: devuelve el hash EFECTIVO de la fila (la 1ª escritura gana).
 */
export async function recordDebitHop1(args: {
  intentId: string;
  ownerRef: string;
  keyId: string;
  nonce: string;
  txHash: string;
}): Promise<string | null> {
  const { data } = await supabase.rpc('record_debit_hop1', {
    p_intent_id: args.intentId,
    p_owner_ref: args.ownerRef,
    p_key_id: args.keyId,
    p_nonce: args.nonce,
    p_tx_hash: args.txHash,
  });
  return data?.[0]?.persisted_tx_hash ?? null;
}

/**
 * Flip del ciclo de vida del consumo.
 *
 * `settled` / `reconciliation_pending` son los terminales de siempre. HU-198 agrega
 * `resolving_settle` para el hop 2 de resultado DESCONOCIDO: es el estado que el
 * `claim_reconciliation` NO reclama sin tx previa, así que el reconciliador no
 * re-envía a ciegas un pago que pudo haberse hecho (ver `settleEscrowAware`).
 */
export async function recordDebitSettleStatus(args: {
  intentId: string;
  ownerRef: string;
  keyId: string;
  nonce: string;
  status: 'settled' | 'reconciliation_pending' | 'resolving_settle';
}): Promise<boolean> {
  const { data, error } = await supabase.rpc('record_debit_settle_status', {
    p_intent_id: args.intentId,
    p_owner_ref: args.ownerRef,
    p_key_id: args.keyId,
    p_nonce: args.nonce,
    p_status: args.status,
  });
  // HU-198: antes el error se DESCARTABA en silencio, y eso hacía invisible el peor
  // modo de fallo: si la migración de esta HU no está aplicada, el RPC responde
  // `INVALID_SETTLE_STATUS` al escribir `resolving_settle`, la fila se queda en
  // `hop1_confirmed` — que SÍ es auto-reclamable — y el reconciliador vuelve a poder
  // re-enviar el hop 2 a ciegas. Sin este log eso pasaba sin dejar rastro. Se loguea
  // y NO se tira: el contrato de la función (nunca rechazar) no cambia, porque el
  // caller está en un camino de money-safety donde un throw perdería el veredicto.
  if (error) {
    log.error(
      {
        intentId: args.intentId,
        status: args.status,
        detail: error.message,
      },
      'record_debit_settle_status failed — the lifecycle row was NOT updated (if the status is resolving_settle, check that the HU-198 migration is applied: an un-updated row stays auto-claimable and the reconciler could resend hop2 blind)',
    );
    return false;
  }
  // AR BLQ-MEDIO-2: el `error` NO era el único modo de fallo. El guard de transición
  // (migración 20260728000000) hace que un UPDATE de 0 filas sea un resultado NORMAL,
  // así que con el `RETURNS void` original el caller no podía distinguir "quedó
  // escrito" de "el guard lo rechazó". Desde 20260728010000 el RPC devuelve `applied`,
  // y ACÁ se consume: sin esto, el candado de toda la HU colgaba de un write incapaz de
  // reportar su propio fracaso.
  //
  // `undefined` (RPC viejo todavía deployado, o forma inesperada) se trata como NO
  // confirmado a propósito: preferimos un warn de más a creer que el candado cerró.
  // Doble cast a través de `unknown`: con el RPC VIEJO todavía deployado la respuesta
  // real es `null`, no la fila (el tipo generado ya declara la forma nueva). El
  // `?.[0]?.applied` cubre las dos, y `undefined` cae al camino de "no confirmado".
  const row = (
    data as unknown as
      | { applied?: boolean; current_status?: string | null }[]
      | null
  )?.[0];
  const applied = row?.applied;
  // AR#2 BLQ-BAJO-1: el estado REAL de la fila (migración 20260728020000). Es lo que
  // reemplaza a la consecuencia inventada del mensaje anterior.
  const currentStatus = row?.current_status ?? null;
  if (applied !== true) {
    log.error(
      {
        intentId: args.intentId,
        keyId: args.keyId,
        nonce: args.nonce,
        status: args.status,
        applied: applied ?? null,
        currentStatus,
      },
      // ⚠️ AR#2 BLQ-BAJO-1 — ESTE MENSAJE DICE LO QUE SE SABE, NO UNA CONSECUENCIA.
      //
      // La versión anterior afirmaba "the row REMAINS auto-claimable and the reconciler
      // could resend hop2 blind", y era FALSO en todos sus casos alcanzables:
      // `applied=false` sólo ocurre cuando el guard rechazó, o sea desde un status que
      // NO está en (NULL, 'hop1_confirmed', 'reconciliation_pending') — y ninguno de
      // esos es reclamable para mandar un hop 2 ('settled'/'resolved_*' no los reclama
      // nadie; 'resolving_*' sólo el lado refund, que no manda hop 2).
      //
      // Peor: el escenario donde esta alerta más importa es el caso F (ver TD-198-01 en
      // `services/reconciliation.ts`), donde la verdad es que el seller YA COBRÓ DOS
      // VECES. Mandar al operador a "revisar si se puede re-enviar" lo manda a mirar lo
      // que no es. Ahora se reporta el HECHO (el guard rechazó, la fila quedó en tal
      // estado) y se le pide LEER antes de concluir.
      applied === false
        ? `record_debit_settle_status applied=false — the transition guard REJECTED this write: the lifecycle row was NOT set to '${args.status}' and it KEEPS its current status (${currentStatus ?? 'unreadable'}). This is a state-machine disagreement, NOT a diagnosis: do not assume what happened to the money from this line. Read debit_settle_status and debit_resolution_tx_hash for this intent, and check the chain for a hop2 disbursement to the seller, before concluding anything.`
        : 'record_debit_settle_status returned no `applied` flag — cannot confirm the lifecycle row was updated (are migrations 20260728010000/20260728020000 applied? a PostgREST schema-cache reload may be pending). Treated as NOT confirmed.',
    );
    return false;
  }
  return true;
}
