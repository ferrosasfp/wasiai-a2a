/**
 * Reconciliation Service — WKH-191c · Motor de reconciliación (Wave 0 del EPIC 191).
 *
 * Resuelve, por-intent y tras RE-VERIFICAR on-chain la realidad del hop 1 (evento
 * `Debited`), EXACTAMENTE UN LADO — nunca ambos, nunca ninguno — de forma idempotente:
 *
 *   - `Debited` confirmed → reintenta el hop 2 al seller (seam `settlePaymentIntentOnChain`
 *     DIRECTO, DT-R2) → `resolved_settled`. NO reembolsa el budget.
 *   - `Debited` not_confirmed → refund BUDGET-ONLY (`refund_a2a_key_spend` DENTRO del RPC
 *     `record_reconciliation_resolution`, sin transfer on-chain, sin tocar escrowBalance) →
 *     `resolved_refunded`. PROHIBIDO cualquier transfer operador→buyer (DT-R4/NC-1).
 *   - `Debited` indeterminate → abort: no mueve dinero, queda pending (CD-3).
 *
 * Idempotencia (CD-2): el estado terminal + el refund del budget se persisten ATÓMICAMENTE
 * dentro del RPC status-gated → un retry ve `resolved_*` → no-op. La idempotencia NO se
 * apoya en el nonce EIP-3009 (aleatorio) sino en el state-machine DB (`resolving_*`→`resolved_*`).
 *
 * Además: detección de drift (SOLO reporte, CD-4) entre `budget` off-chain y `escrowBalance`
 * on-chain. NUNCA sobrescribe el budget.
 *
 * Exemplar: payment-intent.ts (seam / error class) + arbiter.ts (service shape).
 */

import { formatUnits } from 'viem';
import { isEscrowSettleEnabled } from '../adapters/escrow/debit-capture.js';
import {
  readEscrowBalanceAtomic,
  reverifyDebitedByTxHash,
} from '../adapters/escrow/reconciler-onchain.js';
import { resolveEscrowContract } from '../adapters/escrow-verifier.js';
import { getAdaptersBundle, getDefaultChainKey } from '../adapters/registry.js';
import { verifyDefaultChainSettle } from '../adapters/settle-verifier.js';
import { getLogger } from '../lib/logger.js';
import { supabase } from '../lib/supabase.js';
import { settlePaymentIntentOnChain } from './payment-intent.js';

const log = getLogger('reconciliation');

// Estados del ciclo de vida que la reconciliación puede tocar (surface del GET).
const PENDING_STATUSES = [
  'hop1_confirmed',
  'reconciliation_pending',
  'resolving_settle',
  'resolving_refund',
] as const;

// Estados contabilizados en el drift (débito off-chain vigente, no reembolsado).
//
// HU-198: se agrega `resolving_settle`. El criterio de esta lista es "el débito del
// hop 1 ESTÁ VIGENTE y no fue reembolsado", y en `resolving_settle` lo está: los
// fondos del buyer ya salieron del escrow (hop 1 confirmado) y no hay refund. Desde
// esta HU ese estado además es DURADERO — `settleEscrowAware` lo usa para el hop 2 de
// resultado desconocido, no sólo como marca transitoria de un run del reconciliador —
// así que omitirlo hacía que el reporte de drift SUB-DECLARARA el débito acumulado
// justamente en los casos que hay que mirar. Un reporte de drift que se calla un caso
// afirma algo falso.
//
// EXCLUSIONES, LAS TRES (AR MNR-2: la versión anterior decía que `resolving_refund` era
// "la única exclusión", y era una afirmación FALSA de completitud — justo el tipo de
// afirmación que este comentario existe para evitar):
//   · `resolving_refund`  — el débito está en curso de ser REVERTIDO (el crédito vive
//     dentro de `record_reconciliation_resolution`), así que contarlo como vigente
//     sería la sub/sobre-declaración simétrica.
//   · `resolved_refunded` — el débito YA se revirtió. Excluido por el mismo criterio.
//   · `resolved_settled`  — el hop 2 se resolvió y el débito quedó consumido; el
//     `settled` de la lista ya cubre el consumo por la vía normal. Se excluye por
//     coherencia con el par `resolving_settle`→`resolved_settled` (contar los dos
//     duplicaría el mismo débito en la suma).
//
// ⚠️ REGRESIÓN DEL ROLLBACK (AR MNR-2, 2ª mitad): el `_down` de la migración
// 20260728000000 NO revierte esta lista (es código, no SQL), pero SÍ deja de escribirse
// `resolving_settle`, así que las filas que quedaron en ese estado siguen contándose
// mientras el código nuevo esté deployado y dejan de aparecer si se revierte el código.
// O sea: revertir el CÓDIGO de HU-198 devuelve el drift a su sub-declaración anterior
// para esas filas. Está anotado en el `_down`; si se revierte, inventariarlas con la
// query que ese archivo trae.
const DRIFT_ACCOUNTED_STATUSES = [
  'hop1_confirmed',
  'settled',
  'reconciliation_pending',
  'resolving_settle',
] as const;

export type ReconciliationErrorCode =
  | 'INTENT_NOT_FOUND'
  | 'NOT_PENDING'
  | 'FLAG_OFF'
  | 'INDETERMINATE'
  | 'SETTLE_FAILED'
  | 'INTERNAL';

/** Error disclosure-safe (patrón `PaymentIntentError`). El route mapea `code`→HTTP. */
export class ReconciliationError extends Error {
  readonly code: ReconciliationErrorCode;
  constructor(code: ReconciliationErrorCode) {
    super(code);
    this.name = 'ReconciliationError';
    this.code = code;
  }
}

export interface PendingRow {
  intent_id: string;
  key_id: string;
  nonce: string;
  debit_hop1_tx_hash: string | null;
  finalAmountUsd: string;
  owner_ref: string;
  debit_settle_status: string;
}

export type ResolveStatus =
  | 'flag_off'
  | 'indeterminate'
  | 'already_resolved'
  /**
   * AR BLQ-BAJO-1 — HU-198 volvió `resolving_settle` un estado DURABLE, y eso rompió
   * el significado de `already_resolved` para la única herramienta que el humano
   * tiene. El diseño delega en "que una persona lo resuelva", pero
   * `POST /dashboard/api/reconciliation/:id/resolve` contestaba
   * `200 {"status":"already_resolved"}` para una fila que NO está resuelta y que
   * contiene plata posiblemente duplicada: el claim devuelve `claimed=false` (por
   * diseño, para no re-enviar el hop 2 a ciegas) y ese `false` se traducía al mismo
   * "ya está" que una fila terminal.
   *
   * Este estado distingue el caso: el intent está ESPERANDO EVIDENCIA del hop 2
   * (`resolving_settle` + `debit_resolution_tx_hash IS NULL`). No hay nada que el
   * reconciliador automático pueda hacer con él — hay que ir a la cadena, encontrar
   * si el hop 2 pagó, y resolverlo con esa evidencia.
   */
  | 'awaiting_manual_settle_evidence'
  | 'settle_failed'
  | 'settled'
  | 'refunded';

export interface ResolveOutcome {
  status: ResolveStatus;
  side?: 'settle' | 'refund';
  txHash?: string | null;
}

export interface DriftRow {
  key_id: string;
  sumDebitedAtomic: string;
  escrowBalanceAtomic: string | null;
  budgetUsd: string | null;
  deltaAtomic: string | null;
  exceedsThreshold: boolean;
}

/**
 * HU-201 (AR BLQ-MEDIO-2) — una fila `failed_ambiguous` del camino NO-ESCROW.
 *
 * POR QUÉ EXISTE ESTE TIPO: HU-201 mandó los HTTP non-2xx del facilitator a
 * `ambiguous` ⟹ `failed_ambiguous` ⟹ **el deposit del buyer NO se reembolsa**. Esa
 * decisión es correcta (un 502 puede llegar después del broadcast) pero tenía un
 * costo que el AR encontró y que invalidaba el fix: en el camino no-escrow —que es el
 * DEFAULT, porque `ESCROW_SETTLE_ENABLED` exige `=== 'true'`— esas filas eran
 * INVISIBLES.
 *
 *   · `listPending()` lee `a2a_payment_intent_debit_signatures`, y sin escrow esa fila
 *     NO EXISTE.
 *   · `resolveIntent()` arranca con `if (!isEscrowSettleEnabled()) return flag_off`.
 *   · Único rastro: `error_message` en texto libre y un `log.warn`.
 *
 * O sea que el fix cambiaba "reembolso indebido RUIDOSO" por "retención SILENCIOSA".
 * Y el modo de falla no es hipotético: ya ocurrió en este repo (el facilitator
 * exigiendo un Bearer que el adapter no mandaba ⟹ 401 en el 100% de los settles).
 * Antes era ruidoso pero AUTO-SANANTE: todos los buyers recuperaban su deposit. Con
 * HU-201 sería el 100% de los deposits retenidos y nadie mirando.
 *
 * ESTA LISTA ES SÓLO LECTURA. No resuelve nada: no hay resolución automática posible
 * sin poder responder "¿el broadcast aterrizó?", y eso se contesta on-chain
 * (`authorizationState(from, nonce)` del token es un `view` público), no por HTTP. Ese
 * lector NO existe hoy en el repo y es una HU propia (TD-201-01). Hasta entonces, la
 * acción es humana y esta lista es el lugar donde se ve.
 */
export interface AmbiguousIntentRow {
  intent_id: string;
  owner_ref: string;
  key_id: string;
  intent_type: string;
  status: string;
  chain_id: number;
  pay_to: string;
  authorizedUsd: string;
  consumedUsd: string;
  settle_outcome: string;
  /**
   * Texto libre — pero es DONDE VIVE EL HASH. Cuando el facilitator contestó
   * `success:false` CON un txHash, `settlePaymentIntentOnChain` lo mete en el mensaje
   * (`settle failed WITH a broadcast hash (0x…)`) porque no hay columna para él. Es la
   * pista con la que un humano cruza contra la cadena. Ver TD-201-02.
   */
  error_message: string | null;
  updated_at: string;
}

/**
 * Resultado de `listAmbiguous`. Trae `total` A PROPÓSITO: la query está acotada por
 * `limit`, y una lista truncada EN SILENCIO sobre plata retenida sería la misma
 * afirmación falsa de completitud que este archivo ya documenta para el drift. Si
 * `total > rows.length`, el consumidor lo ve.
 */
export interface AmbiguousReport {
  rows: AmbiguousIntentRow[];
  total: number;
  truncated: boolean;
}

/** Techo de filas del reporte ambiguo (el `total` exacto viaja igual). */
const AMBIGUOUS_LIST_LIMIT = 500;

// ── Row shapes de las queries (subset tipado a mano) ──────────────

interface IntentEmbed {
  pay_to: string;
  chain_id: number;
  owner_ref: string;
}

/** Fila del SELECT de `resolveIntent` (con el hash de key y el embed del intent). */
interface SigWithIntentRow {
  intent_id: string;
  key_id: string;
  debit_key_id_hash: string;
  debit_nonce: string;
  debit_amount_atomic: string;
  debit_hop1_tx_hash: string | null;
  debit_settle_status: string;
  /**
   * AR BLQ-BAJO-1: se agrega al SELECT porque el `claimed=false` necesita distinguir
   * "ya resuelto" de "esperando evidencia del hop 2" (`resolving_settle` SIN tx). El
   * tipo refleja exactamente las columnas pedidas (misma regla que `PendingSelectRow`),
   * así que agregar el campo acá OBLIGA a agregarlo al select — tsc lo cazó.
   */
  debit_resolution_tx_hash: string | null;
  owner_ref: string;
  a2a_payment_intents: IntentEmbed | IntentEmbed[] | null;
}

/**
 * Fila del SELECT de `listPending` (subset REAL seleccionado — CR MNR-2). NO trae
 * `debit_key_id_hash` ni el join `a2a_payment_intents`; el tipo refleja exactamente las
 * columnas pedidas para no prometer campos ausentes en runtime.
 */
interface PendingSelectRow {
  intent_id: string;
  key_id: string;
  debit_nonce: string;
  debit_amount_atomic: string;
  debit_hop1_tx_hash: string | null;
  debit_settle_status: string;
  owner_ref: string;
}

/**
 * Fila del SELECT de `listAmbiguous` (subset REAL, misma regla que `PendingSelectRow`).
 * Los NUMERIC vienen con `::text` — convención del repo desde WKH-196: PostgREST los
 * entrega como número JSON y `JSON.parse` redondea, así que el cast es obligatorio en
 * cualquier columna NUMERIC de un money-path.
 */
interface AmbiguousSelectRow {
  id: string;
  owner_ref: string;
  key_id: string;
  intent_type: string;
  status: string;
  chain_id: number;
  pay_to: string;
  authorized_usd: string;
  consumed_usd: string;
  settle_outcome: string;
  error_message: string | null;
  updated_at: string;
}

interface DriftSigRow {
  key_id: string;
  debit_key_id_hash: string;
  debit_amount_atomic: string;
  owner_ref: string;
  a2a_payment_intents: { chain_id: number } | { chain_id: number }[] | null;
}

/** Normaliza el embed PostgREST (to-one puede llegar como objeto o array 0-1). */
function firstEmbed<T>(embed: T | T[] | null): T | null {
  if (embed === null) return null;
  return Array.isArray(embed) ? (embed[0] ?? null) : embed;
}

/** Umbral atomic del drift (env; default 0 → reporta cualquier delta ≠ 0). */
function getDriftThresholdAtomic(): bigint {
  const raw = process.env.RECONCILE_DRIFT_ALERT_THRESHOLD_ATOMIC;
  if (!raw || raw.trim() === '') return 0n;
  try {
    const n = BigInt(raw.trim());
    return n < 0n ? -n : n;
  } catch {
    return 0n;
  }
}

function absBig(v: bigint): bigint {
  return v < 0n ? -v : v;
}

export const reconciliationService = {
  /**
   * AC-1: lista los intents con hop 1 movido/ambiguo pero settle no resuelto (surface
   * read-only del panel admin). Cross-tenant DELIBERADO (patrón `listHolds`): sin filtro
   * `owner_ref`, superficie de ALTO PRIVILEGIO gateada por `requireAdminToken` en la ruta.
   */
  async listPending(): Promise<PendingRow[]> {
    const chainKey = getDefaultChainKey();
    const bundle = chainKey ? getAdaptersBundle(chainKey) : undefined;
    const decimals = bundle?.payment.supportedTokens[0]?.decimals ?? 6;

    const { data, error } = await supabase
      .from('a2a_payment_intent_debit_signatures')
      .select(
        'intent_id, key_id, debit_nonce::text, debit_amount_atomic::text, debit_hop1_tx_hash, ' +
          'debit_settle_status, owner_ref',
      )
      .eq('debit_validation_status', 'valid')
      .in('debit_settle_status', [...PENDING_STATUSES]);
    if (error) {
      log.error({ detail: error.message }, 'listPending query failed');
      throw new ReconciliationError('INTERNAL');
    }
    const rows = (data as unknown as PendingSelectRow[] | null) ?? [];
    return rows.map((r) => ({
      intent_id: r.intent_id,
      key_id: r.key_id,
      nonce: r.debit_nonce,
      debit_hop1_tx_hash: r.debit_hop1_tx_hash,
      finalAmountUsd: formatUnits(BigInt(r.debit_amount_atomic), decimals),
      owner_ref: r.owner_ref,
      debit_settle_status: r.debit_settle_status,
    }));
  },

  /**
   * HU-201 (AR BLQ-MEDIO-2): los intents con veredicto `failed_ambiguous` — el buyer
   * NO fue reembolsado y el resultado del settle es DESCONOCIDO. Ver
   * `AmbiguousIntentRow` para el por qué.
   *
   * NO gateada por `isEscrowSettleEnabled()` A PROPÓSITO, y ése es todo el punto: el
   * camino que produce estas filas es el NO-escrow, o sea justo el que corre con el
   * flag OFF. Gatearla la volvería a dejar vacía exactamente cuando importa.
   *
   * Cross-tenant DELIBERADO (mismo patrón y misma justificación que `listPending`):
   * sin filtro `owner_ref`, superficie de ALTO PRIVILEGIO gateada por
   * `requireAdminToken` en la ruta.
   */
  async listAmbiguous(): Promise<AmbiguousReport> {
    const { data, error, count } = await supabase
      .from('a2a_payment_intents')
      .select(
        'id, owner_ref, key_id, intent_type, status, chain_id, pay_to, ' +
          'authorized_usd::text, consumed_usd::text, settle_outcome, ' +
          'error_message, updated_at',
        { count: 'exact' },
      )
      .eq('settle_outcome', 'failed_ambiguous')
      .order('updated_at', { ascending: false })
      .limit(AMBIGUOUS_LIST_LIMIT);
    if (error) {
      log.error({ detail: error.message }, 'listAmbiguous query failed');
      throw new ReconciliationError('INTERNAL');
    }
    const rows = (data as unknown as AmbiguousSelectRow[] | null) ?? [];
    const total = count ?? rows.length;
    return {
      rows: rows.map((r) => ({
        intent_id: r.id,
        owner_ref: r.owner_ref,
        key_id: r.key_id,
        intent_type: r.intent_type,
        status: r.status,
        chain_id: r.chain_id,
        pay_to: r.pay_to,
        authorizedUsd: r.authorized_usd,
        consumedUsd: r.consumed_usd,
        settle_outcome: r.settle_outcome,
        error_message: r.error_message,
        updated_at: r.updated_at,
      })),
      total,
      truncated: total > rows.length,
    };
  },

  /**
   * AC-2..AC-6: resuelve exactly-one-side un intent pending. El gate del flag vive
   * ACÁ (AC-8/CD-6): con `ESCROW_SETTLE_ENABLED` OFF → `flag_off`, cero lectura de dinero.
   */
  async resolveIntent(intentId: string): Promise<ResolveOutcome> {
    // 1. Gate flag (AC-8/CD-6). Cero side-effect ni lectura de dinero.
    if (!isEscrowSettleEnabled()) return { status: 'flag_off' };

    // 2. Leer la fila (firma valid en estado pending + campos del intent).
    const chainKey = getDefaultChainKey();
    const bundle = chainKey ? getAdaptersBundle(chainKey) : undefined;
    const decimals = bundle?.payment.supportedTokens[0]?.decimals ?? 6;
    const escrowContract = chainKey ? resolveEscrowContract(chainKey) : null;

    const { data, error } = await supabase
      .from('a2a_payment_intent_debit_signatures')
      .select(
        'intent_id, key_id, debit_key_id_hash, debit_nonce::text, debit_amount_atomic::text, ' +
          // AR BLQ-BAJO-1: `debit_resolution_tx_hash` es lo que separa "esperando
          // evidencia del hop 2" de "ya resuelto" cuando el claim devuelve false.
          'debit_hop1_tx_hash, debit_resolution_tx_hash, debit_settle_status, owner_ref, ' +
          'a2a_payment_intents!inner(pay_to, chain_id, owner_ref)',
      )
      .eq('intent_id', intentId)
      .eq('debit_validation_status', 'valid')
      .in('debit_settle_status', [...PENDING_STATUSES])
      .maybeSingle();
    if (error) {
      log.error(
        { intentId, detail: error.message },
        'resolveIntent read failed',
      );
      throw new ReconciliationError('INTERNAL');
    }
    const row = data as unknown as SigWithIntentRow | null;
    if (!row) throw new ReconciliationError('NOT_PENDING');
    const intent = firstEmbed(row.a2a_payment_intents);
    if (!intent) throw new ReconciliationError('NOT_PENDING');

    // owner_ref REAL leído del intent (CD-8, nunca asumido por el caller admin).
    const ownerRef = intent.owner_ref;
    const keyId = row.key_id;
    const nonce = row.debit_nonce;
    const payTo = intent.pay_to;
    const chainId = intent.chain_id;
    const finalAmountUsd = Number(
      formatUnits(BigInt(row.debit_amount_atomic), decimals),
    );

    // 3. Re-verificar on-chain ANTES de decidir (CD-3). Sin chainKey/escrow →
    //    no se puede re-verificar → abort money-safe (indeterminate).
    if (!chainKey || !escrowContract) {
      log.warn({ intentId }, 'reconcile: chainKey/escrow no resoluble → abort');
      return { status: 'indeterminate' };
    }
    const verdict = await reverifyDebitedByTxHash({
      chainKey,
      escrowContract,
      txHash: row.debit_hop1_tx_hash,
      keyIdHash: row.debit_key_id_hash,
      nonce: BigInt(nonce),
    });
    if (verdict === 'indeterminate') return { status: 'indeterminate' };
    const side: 'settle' | 'refund' =
      verdict === 'confirmed' ? 'settle' : 'refund';

    // 4. CLAIM atómico gana-uno (transición pending → resolving_*).
    const claimRes = await supabase.rpc('claim_reconciliation', {
      p_intent_id: intentId,
      p_owner_ref: ownerRef,
      p_key_id: keyId,
      p_nonce: nonce,
      p_side: side,
    });
    if (claimRes.error) this.mapRpcError(claimRes.error, intentId, 'claim');
    const claimRow = (
      claimRes.data as
        | {
            claimed: boolean;
            resolution_tx_hash: string | null;
            amount_atomic: string | null;
          }[]
        | null
    )?.[0];
    if (!claimRow || claimRow.claimed === false) {
      // AR BLQ-BAJO-1: `claimed=false` ya NO significa una sola cosa. Desde HU-198 hay
      // filas que el claim rechaza A PROPÓSITO y que NO están resueltas: el hop 2 quedó
      // de resultado desconocido (`resolving_settle` sin tx) y el reconciliador se
      // niega a re-enviarlo a ciegas. Contestarle `already_resolved` al humano sobre
      // una fila con plata posiblemente duplicada es la peor respuesta posible: lo
      // manda a otra cosa. Se lee el estado REAL de la fila para distinguirlo.
      if (
        row.debit_settle_status === 'resolving_settle' &&
        !row.debit_resolution_tx_hash
      ) {
        log.warn(
          { intentId, keyId, nonce },
          'reconcile: intent awaiting MANUAL hop2 evidence (resolving_settle without tx). The reconciler will NOT resend hop2 blind: check the chain for a hop2 disbursement to the seller before resolving.',
        );
        return { status: 'awaiting_manual_settle_evidence' };
      }
      // Otro run ganó / ya terminal → no-op idempotente (AC-5).
      return { status: 'already_resolved' };
    }

    // Terminal + evidencia a persistir.
    let terminal: 'resolved_settled' | 'resolved_refunded';
    let txHash: string | null;
    let refundAmount: number | null;

    if (side === 'settle') {
      // 5. Crash-recovery: si el claim trae un tx del hop2 previo, re-verificar
      //    ANTES de re-enviar (CD-2, evita double-move).
      let skipResend = false;
      if (claimRow.resolution_tx_hash) {
        const requiredAtomic = BigInt(
          claimRow.amount_atomic ?? row.debit_amount_atomic,
        );
        const verified = await verifyDefaultChainSettle({
          txHash: claimRow.resolution_tx_hash,
          payTo,
          requiredAmountAtomic: requiredAtomic,
        });
        if (verified.warn) {
          // RPC no disponible → NO re-enviar a ciegas → abort (queda resolving_settle).
          log.warn(
            { intentId, reason: verified.reason },
            'reconcile crash-recovery: verify unavailable → abort',
          );
          return { status: 'indeterminate' };
        }
        if (verified.ok) skipResend = true; // la tx previa SÍ movió → flip terminal.
      }

      if (!skipResend) {
        // ⚠️ AGUJERO CONOCIDO Y ACOTADO — RE-ENVÍO SIN EVIDENCIA (HU-198, TD-198-01).
        //
        // Acá se re-envía el hop 2 sin ninguna prueba de que no se pagó ya. Eso es
        // CORRECTO para las dos entradas legítimas (y es para lo que existe el lado
        // settle del reconciliador):
        //   (A) el proceso murió DESPUÉS del hop 1 y ANTES de intentar el hop 2 ⟹ el
        //       seller no cobró y nadie más lo va a pagar.
        //   (D) el hop 2 falló de forma INEQUÍVOCA (`failureKind:'unequivocal'`), que
        //       desde HU-201 es exactamente DOS cosas:
        //         · `adapter.sign()` TIRÓ ⟹ pre-broadcast POR CONSTRUCCIÓN: firmar es
        //           local (`signTypedData`), no hay ningún request al facilitator ni
        //           ninguna tx que pueda existir. Esto sí es una PRUEBA.
        //         · el facilitator contestó 2xx con `settled/success` falso y SIN
        //           txHash. ⚠️ ESTO NO ES UNA PRUEBA, y el comentario anterior lo
        //           afirmaba como tal ("probado que no se ejecutó"). Es una INFERENCIA
        //           sobre la semántica de un TERCERO: leemos su `success:false` como "no
        //           settleé". Se sostiene por tres razones, no porque sea demostrable:
        //             1. es la MISMA respuesta y el MISMO campo cuyo `success:true` ya
        //                tratamos como autoritativo para marcar plata como pagada
        //                (desconfiar sólo de un lado sería incoherente);
        //             2. viene sin txHash — en el momento en que hay hash, HU-201 lo
        //                manda a `ambiguous` y NUNCA llega acá;
        //             3. es la entrada que mantiene vivo el re-envío legítimo; exigir
        //                prueba dura acá dejaría al seller sin cobrar automáticamente en
        //                el rechazo normal del facilitator.
        //           Si un facilitator empezara a contestar `success:false` DESPUÉS de
        //           broadcastear y sin devolver el hash, este re-envío paga dos veces y
        //           el gateway no tiene forma de saberlo.
        // En ninguna de las dos existe un tx del hop 2 que verificar, así que exigir
        // evidencia del hop 2 como precondición dura NO es la solución: dejaría al
        // seller sin cobrar automáticamente justo en el caso (A), que es el normal.
        //
        // HU-198 cerró la entrada (E) — hop 2 de resultado DESCONOCIDO — mandándola a
        // `resolving_settle`, que el claim no reclama sin tx (ver `settleEscrowAware`).
        // QUEDAN ABIERTAS CUATRO entradas que llegan acá como `hop1_confirmed` y son
        // INDISTINGUIBLES de (A) con lo que hoy se persiste:
        //   (B) el proceso murió DURANTE el hop 2, después de que el request salió.
        //   (C) el hop 2 SETTLEÓ pero el flip a 'settled' falló ⟹ el txHash se perdió
        //       sin persistirse (`settleEscrowAware` no tiene el "lease" de evidencia
        //       que sí tiene este mismo archivo unas líneas más abajo).
        //   (F) NADIE MURIÓ (AR — la enumeración original estaba mal encuadrada en
        //       "el proceso murió", y por eso no lo vio): `record_debit_hop1` escribe
        //       `hop1_confirmed` ANTES de que el hop 2 se intente, así que la fila queda
        //       AUTO-RECLAMABLE durante TODA la ventana del hop 2, con el proceso vivo y
        //       sano. Un click en el dashboard —o un barrido concurrente— mientras un
        //       settle lento está en vuelo re-envía y paga dos veces. No hace falta
        //       ningún crash: alcanza con que el hop 2 tarde.
        //   (G) CERRADA POR HU-201. Era: el veredicto del hop 2 llegaba como
        //       `success:false` sin ser prueba de que no se ejecutó ⟹ `unequivocal` ⟹
        //       caía en (D) y se re-enviaba. Las dos formas y sus fixes:
        //         · pieverse (el modo DEFAULT) devuelve el `txHash` del facilitator
        //           verbatim, así que un `200 {success:false, txHash:"0x…"}` nos deja un
        //           hash de broadcast en la mano ⟹ ahora `hasBroadcastEvidence`
        //           (`payment-intent.ts`) lo clasifica `ambiguous`.
        //         · un HTTP 502 se aplanaba a `success:false` en los 4 settle x402
        //           (base/avalanche/tempo/kite-x402) y salía como `Error` pelado en
        //           kite-pieverse ⟹ ahora los 5 tiran `FacilitatorSettleError` con
        //           `valueDisposition:'unknown'`, que el seam de `payment-intent.ts`
        //           captura como `ambiguous`.
        //       En los dos casos el destino pasa a ser `resolving_settle` ⟹ NO llega acá.
        // En (B), (C) y (F) este re-envío PAGA DOS VECES al seller.
        //
        // POR QUÉ NO SE ARREGLA ACÁ: falta un HECHO PERSISTIDO ("el hop 2 se intentó"),
        // y agregarlo es una decisión de diseño con costo propio. Las dos candidatas:
        //
        //   1. Nonce DETERMINÍSTICO para el hop 2 (derivado del intentId) en vez de
        //      `randomBytes(32)`. La idea era volver el doble pago imposible on-chain
        //      (el token rechaza el segundo uso), misma doctrina que el `idem_key` de
        //      HU-194 pero con la clave viajando al contrato. ⚠️ EL AR LE ENCONTRÓ DOS
        //      AGUJEROS y hoy NO es la recomendación:
        //        (a) NO ES EIP-3009 EN EL CAMINO VIVO. En modo `pieverse` —el DEFAULT—
        //            la firma es un `Authorization` custom contra
        //            `KITE_FACILITATOR_ADDRESS`, no un `TransferWithAuthorization`
        //            contra el token. "El token rechaza el segundo uso" sólo vale para
        //            el modo `x402`, que no es el default. En pieverse la unicidad la
        //            tendría que garantizar el facilitator, que es un TERCERO.
        //        (b) LE FALTABA EL CAMBIO COMPAÑERO — YA HECHO (HU-201). Con nonce
        //            determinístico, el rechazo del segundo envío llega como
        //            `success:false`; ANTES eso era `unequivocal` ⟹ el buyer se
        //            reembolsaba CON EL SELLER YA PAGADO. Ese prerrequisito está
        //            cumplido SÓLO en la medida en que el rechazo traiga txHash o un
        //            non-2xx: si el facilitator/token rechaza con un 2xx `success:false`
        //            PELADO, sigue siendo `unequivocal`. O sea que el nonce
        //            determinístico todavía necesita que el rechazo del replay sea
        //            distinguible de un rechazo normal.
        //
        //   2. Lease pre-hop2: persistir "intento en curso" ANTES de mandar el hop 2
        //      (p.ej. escribir `resolving_settle` antes, y bajarlo a
        //      `reconciliation_pending` sólo con un veredicto `unequivocal`). Cierra (B),
        //      (C) y (F) —incluida la ventana del proceso vivo, que ninguna otra opción
        //      toca— a cambio de convertir (A) en revisión manual y de un round-trip a
        //      DB antes de cada pago.
        //
        // RECOMENDACIÓN ACTUAL: la 2 (lease). Con los dos agujeros de la 1 al
        // descubierto, el lease es la única que cierra (F) sin depender de un tercero ni
        // de arreglar antes la clasificación de `success:false`. La 1 queda como destino
        // deseable DESPUÉS del BLQ-ALTO, y sólo si se resuelve la unicidad en pieverse.
        //
        // ⚠️ HU-201 NO CIERRA (B), (C) NI (F). Cerró (G) —la clasificación— y nada más.
        // El re-envío de abajo sigue saliendo sin evidencia persistida de que el hop 2 se
        // intentó, así que el lease sigue pendiente.
        //
        // ── DEUDA ABIERTA QUE HU-201 DEJA ANOTADA (fix-pack AR) ──
        //
        // TD-201-01 — LECTOR DE `authorizationState(from, nonce)`. La pregunta que hoy
        //   NO se puede contestar —"¿el broadcast aterrizó?"— tiene respuesta ON-CHAIN,
        //   no por HTTP: en EIP-3009 el token expone `authorizationState(authorizer,
        //   nonce)` como `view` público, y ese bit dice si la autorización se consumió.
        //   Con eso, un `ambiguous` deja de ser terminal-manual: se resuelve solo. HOY
        //   NO EXISTE ningún lector de eso en el repo. Es una HU propia, no un fix-pack,
        //   y ⚠️ NO sirve tal cual en el modo `pieverse` (el DEFAULT), donde la firma es
        //   un `Authorization` custom contra `KITE_FACILITATOR_ADDRESS` y no un
        //   `TransferWithAuthorization` contra el token — ver el agujero (a) de la
        //   opción 1 más arriba, es el mismo.
        //
        // TD-201-02 — COLUMNA PARA EL HASH DE EVIDENCIA. Cuando el facilitator contesta
        //   `success:false` CON txHash, ese hash es la única pista para cruzar contra la
        //   cadena y hoy sobrevive sólo como PROSA dentro de `error_message` (y como
        //   campo del log). No es filtrable por SQL. Arreglarlo es una columna nueva en
        //   `a2a_payment_intents` ⟹ migración ⟹ decisión del founder.
        //
        // TD-201-03 — ¿PIEVERSE MANDA HASH EN SUS RECHAZOS NORMALES? Incógnita abierta
        //   que decide si `ambiguous` es un caso raro o el 100% de los rechazos. Ver el
        //   docstring de `hasBroadcastEvidence` (`adapters/errors.ts`) por las dos
        //   direcciones y por cómo se cierra (mirando `listAmbiguous()` con tráfico real).
        //
        // Ninguna es un fix-pack. NO borrar este bloque sin cerrar (B), (C), (F) y (G).
        //
        // 6. hop 2 DIRECTO (seam WKH-136; NO settleEscrowAware, DT-R2).
        const settle = await settlePaymentIntentOnChain({
          intentId,
          ownerRef,
          payTo,
          finalAmountUsd,
          chainId,
        });
        if (settle.status !== 'settled') {
          // abort money-safe: deja resolving_settle, NO flip, NO refund. Sin tx previa
          // persistida (lease), un retry NO re-claima este resolving_settle (el claim
          // exige tx) → NO re-envía a ciegas (MNR-2/AR); queda para revisión en el GET.
          log.warn(
            { intentId, status: settle.status },
            'reconcile settle hop2 no confirmado → settle_failed',
          );
          return { status: 'settle_failed' };
        }
        txHash = settle.txHash;
        // Lease de evidencia (BLQ-ALTO-1/AR): persistir la tx del hop2 en la fila
        // resolving_settle ANTES del flip terminal. Si el proceso muere entre este envío
        // y el `record` de abajo, un retry re-claima ESTA fila (el claim settle exige tx
        // previa) y RE-VERIFICA on-chain ANTES de re-enviar → nunca double-paga.
        if (txHash) {
          const lease = await supabase
            .from('a2a_payment_intent_debit_signatures')
            .update({ debit_resolution_tx_hash: txHash })
            .eq('key_id', keyId)
            .eq('debit_nonce', nonce)
            .eq('debit_settle_status', 'resolving_settle');
          if (lease.error) {
            // No es fatal: el flip terminal de abajo persiste la tx igual (COALESCE). El
            // riesgo residual es el crash en esta ventana mínima (R-3 documentado).
            log.warn(
              { intentId, detail: lease.error.message },
              'reconcile lease persist failed (recovery evidence best-effort)',
            );
          }
        }
      } else {
        txHash = claimRow.resolution_tx_hash;
      }
      terminal = 'resolved_settled';
      refundAmount = null;
    } else {
      // REFUND budget-only: NINGÚN seam on-chain (money-safety crítico, DT-R4/NC-1).
      // El budget se acredita DENTRO del RPC (status-gated, una vez).
      terminal = 'resolved_refunded';
      txHash = null;
      refundAmount = finalAmountUsd;
    }

    // 7. Flip terminal + money-atomic (el refund vive DENTRO del RPC, una vez, CD-2).
    const recRes = await supabase.rpc('record_reconciliation_resolution', {
      p_intent_id: intentId,
      p_owner_ref: ownerRef,
      p_key_id: keyId,
      p_nonce: nonce,
      p_terminal_status: terminal,
      p_tx_hash: txHash,
      p_chain_id: chainId,
      p_refund_amount_usd: refundAmount,
    });
    if (recRes.error) this.mapRpcError(recRes.error, intentId, 'record');
    // applied===false (ya terminal) → no-op idempotente; igual reportamos el terminal.

    return {
      status: terminal === 'resolved_settled' ? 'settled' : 'refunded',
      side,
      txHash,
    };
  },

  /**
   * AC-7/CD-4: reporta el drift entre el débito off-chain acumulado y el `escrowBalance`
   * on-chain, por key. SOLO reporte — NUNCA corrige el budget agregado.
   */
  async driftCheck(): Promise<DriftRow[]> {
    const chainKey = getDefaultChainKey();
    const escrowContract = chainKey ? resolveEscrowContract(chainKey) : null;

    const { data, error } = await supabase
      .from('a2a_payment_intent_debit_signatures')
      .select(
        'key_id, debit_key_id_hash, debit_amount_atomic::text, owner_ref, ' +
          'a2a_payment_intents!inner(chain_id)',
      )
      .eq('debit_validation_status', 'valid')
      .in('debit_settle_status', [...DRIFT_ACCOUNTED_STATUSES]);
    if (error) {
      log.error({ detail: error.message }, 'driftCheck query failed');
      throw new ReconciliationError('INTERNAL');
    }
    const rows = (data as unknown as DriftSigRow[] | null) ?? [];

    // Agrupar por key_id (suma atomic del débito vigente).
    interface Group {
      keyId: string;
      keyIdHash: string;
      ownerRef: string;
      chainId: number;
      sum: bigint;
    }
    const groups = new Map<string, Group>();
    for (const r of rows) {
      const intent = firstEmbed(r.a2a_payment_intents);
      const chainId = intent?.chain_id ?? 0;
      const g = groups.get(r.key_id);
      const amount = BigInt(r.debit_amount_atomic);
      if (g) {
        g.sum += amount;
      } else {
        groups.set(r.key_id, {
          keyId: r.key_id,
          keyIdHash: r.debit_key_id_hash,
          ownerRef: r.owner_ref,
          chainId,
          sum: amount,
        });
      }
    }

    const threshold = getDriftThresholdAtomic();
    const out: DriftRow[] = [];
    for (const g of groups.values()) {
      const escrowBalanceAtomic =
        escrowContract && chainKey
          ? await readEscrowBalanceAtomic({
              chainKey,
              escrowContract,
              keyIdHash: g.keyIdHash as `0x${string}`,
            })
          : null;

      // Budget off-chain (SOLO reporte). Owner-guarded (WKH-53): owner_ref REAL del row.
      const budgetUsd = await this.readBudgetUsd(
        g.keyId,
        g.ownerRef,
        g.chainId,
      );

      const deltaAtomic =
        escrowBalanceAtomic !== null ? escrowBalanceAtomic - g.sum : null;
      const exceedsThreshold =
        deltaAtomic !== null && absBig(deltaAtomic) > threshold;
      if (exceedsThreshold) {
        log.warn(
          {
            keyId: g.keyId,
            sumDebitedAtomic: g.sum.toString(),
            escrowBalanceAtomic: escrowBalanceAtomic?.toString() ?? null,
            deltaAtomic: deltaAtomic?.toString() ?? null,
          },
          'reconcile drift exceeds threshold (report-only, no auto-correct)',
        );
      }
      out.push({
        key_id: g.keyId,
        sumDebitedAtomic: g.sum.toString(),
        escrowBalanceAtomic: escrowBalanceAtomic?.toString() ?? null,
        budgetUsd,
        deltaAtomic: deltaAtomic?.toString() ?? null,
        exceedsThreshold,
      });
    }
    return out;
  },

  /**
   * Lee el budget off-chain de una key para la chain (SOLO reporte del drift). Owner-guarded
   * (WKH-53): filtra por el `owner_ref` REAL de la fila. Fallo/no-existe → null.
   */
  async readBudgetUsd(
    keyId: string,
    ownerRef: string,
    chainId: number,
  ): Promise<string | null> {
    const { data, error } = await supabase
      .from('a2a_agent_keys')
      .select('budget')
      .eq('id', keyId)
      .eq('owner_ref', ownerRef)
      .maybeSingle();
    if (error || !data) return null;
    const budget = (data as { budget: Record<string, string> | null }).budget;
    if (!budget) return null;
    return budget[String(chainId)] ?? null;
  },

  /** Mapea el error crudo de un RPC a un ReconciliationError estable (disclosure-safe). */
  mapRpcError(
    error: { message?: string },
    intentId: string,
    ctx: string,
  ): never {
    const msg = error.message ?? '';
    if (msg.includes('INTENT_NOT_FOUND')) {
      throw new ReconciliationError('INTENT_NOT_FOUND');
    }
    log.error({ intentId, ctx, detail: msg }, 'reconciliation RPC error');
    throw new ReconciliationError('INTERNAL');
  },
};
