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
const DRIFT_ACCOUNTED_STATUSES = [
  'hop1_confirmed',
  'settled',
  'reconciliation_pending',
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
          'debit_hop1_tx_hash, debit_settle_status, owner_ref, ' +
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
