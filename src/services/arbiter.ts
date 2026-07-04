/**
 * Arbiter Service — WKH-139 v2 · Agente-árbitro autónomo de disputas (W2.1)
 *
 * Resuelve una disputa sobre un payment-intent `session` (WKH-135) y la ejecuta
 * reusando los primitivos de settle/refund YA probados (CD-6):
 *   settlePaymentIntentOnChain + los RPCs record_settle_outcome/finalize_payment_intent
 *   (invocados directamente, mismo patrón que las wrappers privadas de payment-intent.ts).
 *
 * Flujo (openDispute): open_dispute (gate anti-race) → testnet guard (fail-closed)
 * → readEvidence (on-chain/DB) → classify (rules) → si ambiguo, classifyAmbiguous
 * (LLM acotado, nunca mueve fondos) → cap gate → execute o HOLD. Sobre el tope
 * (ARBITER_AUTO_CAP_USD) o ante ambigüedad irresoluble → arb_hold, CERO movimiento.
 *
 * INVARIANTES money-path: exactly-once (finalize idempotente status-gated),
 * fail-closed, el árbitro NUNCA settlea > deposit (clamp en el RPC), el LLM NUNCA
 * ejecuta fondos, Ownership Guard owner_ref en todo.
 *
 * Exemplar: closeSession de src/services/payment-intent.ts.
 */

import { createHash } from 'node:crypto';
import { getLogger } from '../lib/logger.js';
import { supabase } from '../lib/supabase.js';
import {
  type ArbiterDecision,
  ArbiterError,
  type ArbiterMethod,
  type ArbiterOutcome,
  type DisputeEvidence,
} from '../types/arbiter.js';
import type { ReceiptType } from '../types/receipt.js';
import { readEvidence } from './arbiter/evidence.js';
import { classifyAmbiguous } from './arbiter/llm-classifier.js';
import { classify } from './arbiter/rules.js';
import { settlePaymentIntentOnChain } from './payment-intent.js';
import { receiptService } from './receipt.js';

const log = getLogger('arbiter');

const DEFAULT_ARBITER_AUTO_CAP_USD = 25;

// CD-5/AC-5: allowlist testnet (permitir SÓLO estos; rechazar todo lo demás
// fail-closed). kite-ozone 2368, avalanche-fuji 43113, base-sepolia 84532.
const TESTNET_CHAIN_IDS: ReadonlySet<number> = new Set([2368, 43113, 84532]);

// ── Config (env, nunca-throw; patrón resolveTtlSeconds/models.ts) ──

/** Tope de auto-ejecución en USD. Default 25. Inválido → fallback + warn. */
export function getArbiterAutoCapUsd(): number {
  const raw = process.env.ARBITER_AUTO_CAP_USD;
  if (raw === undefined || raw.trim() === '')
    return DEFAULT_ARBITER_AUTO_CAP_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    log.warn(
      { raw, fallback: DEFAULT_ARBITER_AUTO_CAP_USD },
      'Invalid ARBITER_AUTO_CAP_USD; falling back to default',
    );
    return DEFAULT_ARBITER_AUTO_CAP_USD;
  }
  return n;
}

/** Flag maestro. Default OFF: sólo `'true'` exacto activa el arbitraje (CD-11). */
export function isArbiterEnabled(): boolean {
  return process.env.ARBITER_ENABLED === 'true';
}

// ── Helpers money-path (replicados de payment-intent.ts, CD-6) ──

type SettleVerdict = 'settled' | 'failed_unequivocal' | 'failed_ambiguous';

function numericToMicro(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? Math.round(n * 1_000_000) : 0;
}

/** NULL/desconocido → 'failed_ambiguous' (money-safe): jamás default a 'settled'. */
function normalizeVerdict(raw: string | null | undefined): SettleVerdict {
  return raw === 'settled' ||
    raw === 'failed_unequivocal' ||
    raw === 'failed_ambiguous'
    ? raw
    : 'failed_ambiguous';
}

interface PgError {
  code?: string;
  message?: string;
}

/** Mapea el error crudo de un RPC a un ArbiterError estable (disclosure-safe). */
function mapArbPgError(error: PgError, ctx: string): never {
  const msg = error.message ?? '';
  if (msg.includes('OWNERSHIP_MISMATCH')) {
    throw new ArbiterError('OWNERSHIP_MISMATCH');
  }
  if (msg.includes('INTENT_NOT_FOUND')) {
    throw new ArbiterError('INTENT_NOT_FOUND');
  }
  if (msg.includes('INTENT_NOT_OPEN')) {
    throw new ArbiterError('INTENT_NOT_OPEN');
  }
  log.error({ ctx, detail: msg }, 'arbiter RPC error');
  throw new ArbiterError('INTERNAL');
}

async function recordSettleOutcome(
  intentId: string,
  ownerRef: string,
  outcome: SettleVerdict,
  txHash: string | null,
  residual: number | null,
  errorMessage: string | null,
): Promise<void> {
  try {
    const { error } = await supabase.rpc('record_settle_outcome', {
      p_intent_id: intentId,
      p_owner_ref: ownerRef,
      p_outcome: outcome,
      p_tx_hash: txHash,
      p_residual: residual,
      p_error: errorMessage,
    });
    if (error) {
      log.error(
        { intentId, detail: error.message },
        'record_settle_outcome failed (finalize re-afirmará el veredicto)',
      );
    }
  } catch (err) {
    log.error(
      { intentId, detail: err instanceof Error ? err.message : String(err) },
      'record_settle_outcome threw',
    );
  }
}

async function finalizePaymentIntent(
  intentId: string,
  ownerRef: string,
  txHash: string | null,
  finalAmount: number,
  residual: number | null,
  outcome: SettleVerdict,
  errorMessage: string | null,
): Promise<boolean> {
  try {
    const { error } = await supabase.rpc('finalize_payment_intent', {
      p_intent_id: intentId,
      p_owner_ref: ownerRef,
      p_tx_hash: txHash,
      p_final_amount: finalAmount,
      p_residual: residual,
      p_outcome: outcome,
      p_error: errorMessage,
    });
    if (error) {
      log.error({ intentId, detail: error.message }, 'finalize failed');
      return false;
    }
    return true;
  } catch (err) {
    log.error(
      { intentId, detail: err instanceof Error ? err.message : String(err) },
      'finalize threw',
    );
    return false;
  }
}

function receiptTypeFor(decision: ArbiterDecision): ReceiptType {
  if (decision === 'release') return 'arbitration_release';
  if (decision === 'refund') return 'arbitration_refund';
  if (decision === 'split') return 'arbitration_split';
  return 'arbitration_hold';
}

/** Digest determinístico de la evidencia consultada (auditable, sin secretos). */
function evidenceDigest(ev: DisputeEvidence): string {
  const canonical = JSON.stringify({
    a: ev.authorizedUsd,
    c: ev.consumedUsd,
    vc: ev.voucherCount,
    vt: ev.vouchersTotalUsd,
    pc: ev.proofChainOk,
    r: ev.receiptSettleTotalUsd,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

interface ArbMeta {
  decision: ArbiterDecision;
  method: ArbiterMethod;
  atStakeUsd: number;
  ambiguityReason: string | null;
  llmReasoning: string | null;
  evidenceDigest: string | null;
  sellerRef: string;
}

/**
 * Persiste la fila a2a_arbitrations (auditoría, CD-4). Best-effort: un fallo NO
 * aborta el money-path (el veredicto ya está aplicado). Upsert por intent_id
 * (1 arbitraje activo por intent).
 */
async function upsertArbitrationRow(
  intentId: string,
  ownerRef: string,
  meta: ArbMeta,
  settleUsd: number,
  status: 'executed' | 'held',
): Promise<void> {
  try {
    const { error } = await supabase.from('a2a_arbitrations').upsert(
      {
        intent_id: intentId,
        owner_ref: ownerRef,
        decision: meta.decision,
        method: meta.method,
        at_stake_usd: meta.atStakeUsd,
        settle_usd: settleUsd,
        ambiguity_reason: meta.ambiguityReason,
        llm_reasoning: meta.llmReasoning,
        evidence_digest: meta.evidenceDigest,
        status,
      },
      { onConflict: 'intent_id' },
    );
    if (error) {
      log.warn(
        { intentId, detail: error.message },
        'a2a_arbitrations upsert failed (audit best-effort)',
      );
    }
  } catch (err) {
    log.warn(
      { intentId, detail: err instanceof Error ? err.message : String(err) },
      'a2a_arbitrations upsert threw',
    );
  }
}

// ── Row shapes de los RPCs (subset consumido) ──
interface OpenDisputeRow {
  intent_type: string;
  key_id: string;
  chain_id: number;
  pay_to: string;
  seller_ref: string;
  authorized_usd: number;
  consumed_usd: number;
  expires_at: string;
}
interface ArbCloseRow {
  final_amount: number;
  prev_status: string;
  intent_type: string;
  key_id: string;
  chain_id: number;
  pay_to: string;
  authorized_usd: number;
  consumed_usd: number;
  settle_tx_hash: string | null;
  settle_outcome: string | null;
}

export const arbiterService = {
  /**
   * Abre una disputa y la resuelve autónomamente. Gate anti-race (open_dispute)
   * + testnet guard (fail-closed) + rules→llm→cap → execute/hold.
   */
  async openDispute(
    intentId: string,
    ownerRef: string,
  ): Promise<ArbiterOutcome> {
    // 1. Transición atómica open→disputed (gate anti-race, AC-4).
    const { data, error } = await supabase.rpc('open_dispute', {
      p_intent_id: intentId,
      p_owner_ref: ownerRef,
    });
    if (error) mapArbPgError(error, 'open-dispute');
    const row = (data as OpenDisputeRow[] | null)?.[0];
    if (!row) throw new ArbiterError('INTENT_NOT_FOUND');

    // 2. Testnet guard (AC-5/CD-5, fail-closed) ANTES de tocar fondos.
    if (!TESTNET_CHAIN_IDS.has(row.chain_id)) {
      throw new ArbiterError('CHAIN_NOT_SUPPORTED');
    }

    const depositUsd = numericToMicro(row.authorized_usd) / 1_000_000;

    // 3. Evidencia determinística on-chain/DB.
    const evidence = await readEvidence(intentId, ownerRef);
    const digest = evidenceDigest(evidence);

    // 4. Decisión: rules-first; sólo ante ambigüedad genuina → LLM acotado.
    let decision: ArbiterDecision;
    let method: ArbiterMethod;
    let settleUsd: number;
    let ambiguityReason: string | null = null;
    let llmReasoning: string | null = null;

    const ruled = classify(evidence);
    if ('ambiguous' in ruled) {
      ambiguityReason = ruled.reason;
      const llm = await classifyAmbiguous({
        authorizedUsd: evidence.authorizedUsd,
        consumedUsd: evidence.consumedUsd,
        voucherCount: evidence.voucherCount,
        vouchersTotalUsd: evidence.vouchersTotalUsd,
        proofChainOk: evidence.proofChainOk,
        receiptSettleTotalUsd: evidence.receiptSettleTotalUsd,
        ambiguityReason: ruled.reason,
      });
      if (llm === null) {
        // CD-10 (fail-closed): LLM no disponible/ inválido → HOLD, cero fondos.
        return this.holdArbitration(intentId, ownerRef, {
          decision: 'hold',
          method: 'hold',
          atStakeUsd: depositUsd,
          ambiguityReason: ruled.reason,
          llmReasoning: null,
          evidenceDigest: digest,
          sellerRef: row.seller_ref,
        });
      }
      method = 'llm';
      llmReasoning = llm.reasoning;
      decision = llm.decision;
      const rawUsd =
        llm.decision === 'split'
          ? (depositUsd * (llm.splitPct ?? 0)) / 100
          : llm.decision === 'release'
            ? depositUsd
            : 0;
      // clamp [0, deposit]: el LLM jamás excede el hold.
      settleUsd = Math.min(Math.max(0, rawUsd), depositUsd);
    } else {
      method = 'rules';
      decision = ruled.decision;
      settleUsd = Math.min(Math.max(0, ruled.settleUsd), depositUsd);
    }

    // 5. Cap gate (AC-6/CD-7, ANTES de ejecutar, para rules Y llm).
    const atStakeUsd = depositUsd;
    const meta: ArbMeta = {
      decision,
      method,
      atStakeUsd,
      ambiguityReason,
      llmReasoning,
      evidenceDigest: digest,
      sellerRef: row.seller_ref,
    };
    if (atStakeUsd > getArbiterAutoCapUsd()) {
      // Sobre el tope → HOLD (aún con decisión rules inequívoca).
      return this.holdArbitration(intentId, ownerRef, {
        ...meta,
        decision: 'hold',
        method: 'hold',
      });
    }

    // 6. Ejecutar el desenlace (monto forzado por el árbitro).
    return this.executeArbitration(intentId, ownerRef, settleUsd, meta);
  },

  /**
   * Ejecuta el settle forzado (release/split) o el refund total (refund), reusando
   * los primitivos probados. Idempotente: en 'arb_closing' recupera el veredicto
   * persistido (exactly-once vía finalize status-gated).
   */
  async executeArbitration(
    intentId: string,
    ownerRef: string,
    settleUsd: number,
    meta: ArbMeta,
    allowStaleRecovery = false,
  ): Promise<ArbiterOutcome> {
    const { data, error } = await supabase.rpc(
      'close_payment_intent_for_arbitration',
      { p_intent_id: intentId, p_owner_ref: ownerRef, p_arb_amount: settleUsd },
    );
    if (error) mapArbPgError(error, 'close-arbitration');
    const row = (data as ArbCloseRow[] | null)?.[0];
    if (!row) throw new ArbiterError('INTENT_NOT_FOUND');

    const depositMicro = numericToMicro(row.authorized_usd);
    // El monto REALMENTE forzado (clamp persistido en consumed_usd por el RPC).
    const arbMicro = numericToMicro(row.consumed_usd);
    const residualMicro = Math.max(0, depositMicro - arbMicro);
    const arbUsd = arbMicro / 1_000_000;
    const residualUsd = residualMicro / 1_000_000;

    // Recovery: intent ya en 'arb_closing' (finalize blipeó). Re-aplica el
    // veredicto PERSISTIDO — el refund vive dentro de finalize (status-gated) ⇒
    // exactamente una vez. NUNCA asume éxito (CD-12/CD-13).
    if (row.prev_status === 'arb_closing') {
      return this.applyRecovery(
        intentId,
        ownerRef,
        row,
        arbUsd,
        residualUsd,
        meta,
        allowStaleRecovery,
      );
    }

    // ── refund total (arbAmount <= 0): sin tx on-chain, refund al Buyer ──
    if (arbMicro <= 0) {
      await recordSettleOutcome(
        intentId,
        ownerRef,
        'settled',
        null,
        residualUsd,
        null,
      );
      await finalizePaymentIntent(
        intentId,
        ownerRef,
        null,
        0,
        residualUsd,
        'settled',
        null,
      );
      await this.emitAndRecord(intentId, ownerRef, meta, arbUsd, null, row);
      return this.outcome(meta, 0, residualUsd, 'executed', null);
    }

    // ── release/split (arbAmount > 0): settle forzado on-chain al Seller ──
    const settle = await settlePaymentIntentOnChain({
      intentId,
      ownerRef,
      payTo: row.pay_to,
      finalAmountUsd: arbUsd,
      chainId: row.chain_id,
    });

    if (settle.status === 'settled') {
      await recordSettleOutcome(
        intentId,
        ownerRef,
        'settled',
        settle.txHash,
        residualUsd,
        null,
      );
      await finalizePaymentIntent(
        intentId,
        ownerRef,
        settle.txHash,
        arbUsd,
        residualUsd,
        'settled',
        null,
      );
      await this.emitAndRecord(
        intentId,
        ownerRef,
        meta,
        arbUsd,
        settle.txHash,
        row,
      );
      return this.outcome(meta, arbUsd, residualUsd, 'executed', settle.txHash);
    }

    // Settle falló. INEQUÍVOCO → refund del deposit COMPLETO (herencia BLQ-ALTO-1).
    if (settle.failureKind === 'unequivocal') {
      const errMsg = settle.error ?? 'settle failed';
      await recordSettleOutcome(
        intentId,
        ownerRef,
        'failed_unequivocal',
        null,
        null,
        errMsg,
      );
      const ok = await finalizePaymentIntent(
        intentId,
        ownerRef,
        null,
        arbUsd,
        null,
        'failed_unequivocal',
        errMsg,
      );
      if (!ok) throw new ArbiterError('INTERNAL');
      await this.emitAndRecord(intentId, ownerRef, meta, arbUsd, null, row);
      // Buyer recupera el deposit COMPLETO (residual = deposit).
      return this.outcome(
        meta,
        arbUsd,
        depositMicro / 1_000_000,
        'executed',
        null,
      );
    }

    // AMBIGUO: el transfer PUDO ocurrir → NO refundar. RECONCILE + warn.
    log.warn(
      { intentId, detail: settle.error },
      'arbitration settle ambiguo: deposit NO reembolsado, requiere reconciliación manual',
    );
    const ambiguousErr = `RECONCILE: ${settle.error ?? 'settle ambiguous'}`;
    await recordSettleOutcome(
      intentId,
      ownerRef,
      'failed_ambiguous',
      null,
      null,
      ambiguousErr,
    );
    const okAmb = await finalizePaymentIntent(
      intentId,
      ownerRef,
      null,
      arbUsd,
      null,
      'failed_ambiguous',
      ambiguousErr,
    );
    if (!okAmb) throw new ArbiterError('INTERNAL');
    await this.emitAndRecord(intentId, ownerRef, meta, arbUsd, null, row);
    return this.outcome(meta, arbUsd, 0, 'executed', null);
  },

  /**
   * Recovery de un intent huérfano en 'arb_closing' (finalize blipeó tras conocerse
   * el veredicto). Re-aplica el veredicto persistido vía finalize idempotente. Usado
   * por executeArbitration (retry) y por expireStale (barrido).
   */
  async applyRecovery(
    intentId: string,
    ownerRef: string,
    row: ArbCloseRow,
    arbUsd: number,
    residualUsd: number,
    meta: ArbMeta,
    allowStaleRecovery: boolean,
  ): Promise<ArbiterOutcome> {
    const depositUsd = numericToMicro(row.authorized_usd) / 1_000_000;

    // BLQ-MED-1: un 'arb_closing' FRESCO con settle_outcome=NULL = settle in-flight,
    // NO huérfano. NO finalizar ni mover dinero → held/in-flight; lo completa el
    // caller in-flight (o expireStale con allowStaleRecovery=true).
    if (!row.settle_outcome && !allowStaleRecovery) {
      log.warn(
        { intentId, txHash: row.settle_tx_hash },
        'arbitration recovery sobre arb_closing sin veredicto (in-flight): no-op',
      );
      return this.outcome(meta, arbUsd, 0, 'executed', row.settle_tx_hash);
    }

    const verdict = normalizeVerdict(row.settle_outcome);
    log.warn(
      { intentId, txHash: row.settle_tx_hash, verdict },
      'recuperando arbitración en arb_closing con el veredicto persistido',
    );
    const ok = await finalizePaymentIntent(
      intentId,
      ownerRef,
      verdict === 'settled' ? row.settle_tx_hash : null,
      arbUsd,
      verdict === 'settled' ? residualUsd : null,
      verdict,
      verdict === 'failed_ambiguous' && !row.settle_outcome
        ? 'RECONCILE: arb_closing sin veredicto persistido'
        : null,
    );
    if (!ok) throw new ArbiterError('INTERNAL');

    if (verdict === 'settled') {
      return this.outcome(
        meta,
        arbUsd,
        residualUsd,
        'executed',
        row.settle_tx_hash,
      );
    }
    // unequívoco → deposit COMPLETO reembolsado; ambiguo → 0.
    return this.outcome(
      meta,
      arbUsd,
      verdict === 'failed_unequivocal' ? depositUsd : 0,
      'executed',
      null,
    );
  },

  /**
   * Barrido de sistema (expireStale): recupera un 'arb_closing' huérfano. El owner
   * guard usa el owner_ref de la propia fila (NO es IDOR — mismo patrón que
   * paymentIntentService.expireStale).
   */
  async recoverArbClosing(
    intentId: string,
    ownerRef: string,
    allowStaleRecovery = true,
  ): Promise<void> {
    const { data, error } = await supabase.rpc(
      'close_payment_intent_for_arbitration',
      { p_intent_id: intentId, p_owner_ref: ownerRef, p_arb_amount: 0 },
    );
    if (error) {
      // El intent ya es terminal (settled/refunded/failed): el RPC lanza
      // INTENT_NOT_OPEN. Para un barrido eso es un no-op benigno (ya resuelto),
      // NO un error → no re-aplicamos nada. Cualquier otro error sí escala.
      if ((error.message ?? '').includes('INTENT_NOT_OPEN')) return;
      mapArbPgError(error, 'recover-arb-closing');
    }
    const row = (data as ArbCloseRow[] | null)?.[0];
    if (!row) throw new ArbiterError('INTENT_NOT_FOUND');
    if (row.prev_status !== 'arb_closing') return; // ya terminal / no aplica

    const depositMicro = numericToMicro(row.authorized_usd);
    const arbMicro = numericToMicro(row.consumed_usd);
    const arbUsd = arbMicro / 1_000_000;
    const residualUsd = Math.max(0, depositMicro - arbMicro) / 1_000_000;

    const recoveryMeta: ArbMeta = {
      decision: arbMicro > 0 ? 'split' : 'refund',
      method: 'rules',
      atStakeUsd: depositMicro / 1_000_000,
      ambiguityReason: null,
      llmReasoning: null,
      evidenceDigest: null,
      sellerRef: '',
    };
    await this.applyRecovery(
      intentId,
      ownerRef,
      row,
      arbUsd,
      residualUsd,
      recoveryMeta,
      allowStaleRecovery,
    );
  },

  /**
   * HOLD (AC-6/CD-10): congela el intent (disputed→arb_hold, owner-guarded update),
   * emite recibo arbitration_hold y persiste la fila. CERO movimiento de fondos.
   */
  async holdArbitration(
    intentId: string,
    ownerRef: string,
    meta: ArbMeta,
  ): Promise<ArbiterOutcome> {
    // Update directo owner-guarded (NO mueve dinero). Sólo desde 'disputed'.
    const { error } = await supabase
      .from('a2a_payment_intents')
      .update({ status: 'arb_hold' })
      .eq('id', intentId)
      .eq('owner_ref', ownerRef)
      .eq('status', 'disputed');
    if (error) {
      log.error({ intentId, detail: error.message }, 'arb_hold update failed');
      throw new ArbiterError('INTERNAL');
    }
    await receiptService.emit({
      ownerRef,
      agentKeyId: null,
      sessionId: intentId,
      delegationId: null,
      receiptType: 'arbitration_hold',
      amountUsd: 0,
      chainId: 0,
      txHash: null,
      counterparty: meta.sellerRef || null,
      orchestrationId: null,
    });
    await upsertArbitrationRow(intentId, ownerRef, meta, 0, 'held');
    return this.outcome(meta, 0, 0, 'held', null);
  },

  // ── privados internos (emisión de recibo + fila; construcción de outcome) ──

  async emitAndRecord(
    intentId: string,
    ownerRef: string,
    meta: ArbMeta,
    settleUsd: number,
    txHash: string | null,
    row: ArbCloseRow,
  ): Promise<void> {
    await receiptService.emit({
      ownerRef,
      agentKeyId: row.key_id,
      sessionId: intentId,
      delegationId: null,
      receiptType: receiptTypeFor(meta.decision),
      amountUsd: settleUsd,
      chainId: row.chain_id,
      txHash,
      counterparty: meta.sellerRef || null,
      orchestrationId: null,
    });
    await upsertArbitrationRow(intentId, ownerRef, meta, settleUsd, 'executed');
  },

  outcome(
    meta: ArbMeta,
    settleUsd: number,
    residualUsd: number,
    status: 'executed' | 'held',
    txHash: string | null,
  ): ArbiterOutcome {
    return {
      decision: meta.decision,
      method: meta.method,
      settleUsd,
      residualUsd,
      atStakeUsd: meta.atStakeUsd,
      status,
      txHash,
      ambiguityReason: meta.ambiguityReason,
      llmReasoning: meta.llmReasoning,
    };
  },
};
