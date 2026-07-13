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
import { keccak256, parseUnits, stringToBytes } from 'viem';
import {
  deriveArbiterNonce,
  executeLockForDispute,
  executeReleaseDispute,
  executeResolveDispute,
} from '../adapters/escrow/arbiter-executor.js';
import {
  readArbitrationConsent,
  resolveEscrowContract,
} from '../adapters/escrow-verifier.js';
import { getAdaptersBundle, getDefaultChainKey } from '../adapters/registry.js';
import { getLogger } from '../lib/logger.js';
import { supabase } from '../lib/supabase.js';
import {
  type ArbiterDecision,
  ArbiterError,
  type ArbiterMethod,
  type ArbiterOutcome,
  type DisputeEvidence,
} from '../types/arbiter.js';
import type { SettleOutcome } from '../types/index.js';
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

/**
 * Gate del wire on-chain del árbitro (WKH-191g, CD-1). Default OFF: sólo `'true'`
 * exacto activa el camino escrow (`resolveDispute`/`lockForDispute`/`releaseDispute`).
 * OFF → el árbitro settlea EXACTAMENTE como hoy (settlePaymentIntentOnChain).
 */
export function isEscrowArbiterEnabled(): boolean {
  return process.env.ESCROW_ARBITER_ENABLED === 'true';
}

/**
 * Seam del settle release/split del árbitro (WKH-191g). Espejo de `settleEscrowAware`
 * (payment-intent.ts:500): triple gate en cascada (CD-1) → `resolveDispute` on-chain
 * escrow-custodial; faltando cualquier condición o ante CUALQUIER throw →
 * `settlePaymentIntentOnChain(base)` BYTE-IDÉNTICO al path operator-custodial de hoy
 * (CD-2/CD-7). Devuelve `SettleOutcome`, la MISMA forma que consume
 * `executeArbitration` → las ramas settled/unequivocal/ambiguous no cambian.
 */
export async function settleArbitrationOnChain(params: {
  intentId: string;
  ownerRef: string;
  payTo: string;
  finalAmountUsd: number;
  chainId: number;
  keyId: string;
}): Promise<SettleOutcome> {
  const { intentId, ownerRef, payTo, finalAmountUsd, chainId, keyId } = params;
  const base = { intentId, ownerRef, payTo, finalAmountUsd, chainId };
  try {
    // 0. Flag OFF (default) → fast-path byte-idéntico (AC-1), cero on-chain.
    if (!isEscrowArbiterEnabled()) return settlePaymentIntentOnChain(base);

    // 1. Escrow configurado en la default chain (AC-1). Sin chain/escrow → seam.
    const chainKey = getDefaultChainKey();
    if (!chainKey) return settlePaymentIntentOnChain(base);
    const escrowContract = resolveEscrowContract(chainKey);
    if (!escrowContract) return settlePaymentIntentOnChain(base);

    // 2. Consentimiento on-chain del depositor (AC-2/CD-7). false → seam silencioso.
    const keyIdHash = keccak256(stringToBytes(keyId));
    if (!(await readArbitrationConsent(chainKey, keyIdHash))) {
      return settlePaymentIntentOnChain(base);
    }

    // 3. Monto atómico + nonce disjunto determinista (CD-3). Sin decimals → seam.
    const decimals =
      getAdaptersBundle(chainKey)?.payment.supportedTokens[0]?.decimals;
    if (decimals == null) return settlePaymentIntentOnChain(base);
    const sellerAmount = parseUnits(finalAmountUsd.toString(), decimals);
    const nonce = deriveArbiterNonce(keyIdHash, intentId);

    // 4. resolveDispute escrow-custodial: libera sellerAmount al seller (AC-4/AC-6).
    const o = await executeResolveDispute({
      chainKey,
      escrowContract,
      keyIdHash,
      seller: payTo,
      sellerAmount,
      nonce,
    });
    if (o.kind === 'confirmed') {
      return { status: 'settled', txHash: o.txHash, finalAmountUsd };
    }
    if (o.kind === 'not_moved') {
      return {
        status: 'failed',
        txHash: null,
        finalAmountUsd,
        error: o.reason,
        failureKind: 'unequivocal',
      };
    }
    // ambiguous: el transfer PUDO ocurrir → NO asumir movido (AC-6).
    return {
      status: 'failed',
      txHash: null,
      finalAmountUsd,
      error: o.reason,
      failureKind: 'ambiguous',
    };
  } catch {
    // CD-7: el wire jamás rompe el flujo del árbitro → fallback operator-custodial.
    return settlePaymentIntentOnChain(base);
  }
}

/**
 * Congela el deposit total del keyId bajo el rol arbiter al transicionar a
 * `disputed` (WKH-191g, W2.2). Best-effort (CD-6): triple gate CD-1; un throw NUNCA
 * aborta la resolución. `amount` = deposit TOTAL (`authorized_usd`), no `settleUsd`.
 */
async function bestEffortLockForDispute(
  intentId: string,
  keyId: string,
  authorizedUsd: number,
): Promise<void> {
  try {
    if (!isEscrowArbiterEnabled()) return;
    const chainKey = getDefaultChainKey();
    if (!chainKey) return;
    const escrowContract = resolveEscrowContract(chainKey);
    if (!escrowContract) return;
    const keyIdHash = keccak256(stringToBytes(keyId));
    if (!(await readArbitrationConsent(chainKey, keyIdHash))) return;
    const decimals =
      getAdaptersBundle(chainKey)?.payment.supportedTokens[0]?.decimals;
    if (decimals == null) return;
    const amount = parseUnits(authorizedUsd.toString(), decimals);
    const o = await executeLockForDispute({
      chainKey,
      escrowContract,
      keyIdHash,
      amount,
    });
    log.info(
      { intentId, kind: o.kind, reason: 'reason' in o ? o.reason : undefined },
      'arbiter lockForDispute outcome',
    );
  } catch (err) {
    log.warn(
      { intentId, detail: err instanceof Error ? err.message : String(err) },
      'arbiter lockForDispute threw (best-effort, ignored)',
    );
  }
}

/**
 * Libera el lock del keyId en la rama refund del árbitro (WKH-191g, W2.3).
 * Best-effort (CD-6): mismo triple gate; un fallo se loguea y NO altera el refund
 * off-chain de hoy.
 */
async function bestEffortReleaseDispute(
  intentId: string,
  keyId: string,
): Promise<void> {
  try {
    if (!isEscrowArbiterEnabled()) return;
    const chainKey = getDefaultChainKey();
    if (!chainKey) return;
    const escrowContract = resolveEscrowContract(chainKey);
    if (!escrowContract) return;
    const keyIdHash = keccak256(stringToBytes(keyId));
    if (!(await readArbitrationConsent(chainKey, keyIdHash))) return;
    const o = await executeReleaseDispute({
      chainKey,
      escrowContract,
      keyIdHash,
    });
    log.info(
      { intentId, kind: o.kind, reason: 'reason' in o ? o.reason : undefined },
      'arbiter releaseDispute outcome',
    );
  } catch (err) {
    log.warn(
      { intentId, detail: err instanceof Error ? err.message : String(err) },
      'arbiter releaseDispute threw (best-effort, ignored)',
    );
  }
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
  resolvedBy: string | null; // WKH-189
  resolvedAt: string | null; // WKH-189 (ISO)
  resolutionNote: string | null; // WKH-189
}

/**
 * Item de un hold pendiente de revisión humana (WKH-189). Se expone al panel admin
 * vía `listHolds` (cross-tenant deliberado, CD-5).
 */
export interface AdminHoldItem {
  intentId: string;
  chainId: number;
  atStakeUsd: number;
  decision: string | null;
  method: string | null;
  ambiguityReason: string | null;
  createdAt: string;
}

/** Fila cruda del embed PostgREST de a2a_arbitrations en listHolds. */
interface HoldArbEmbed {
  decision: string | null;
  method: string | null;
  ambiguity_reason: string | null;
  at_stake_usd: number | null;
  created_at: string | null;
}
interface HoldIntentRow {
  id: string;
  chain_id: number;
  authorized_usd: number;
  created_at: string;
  a2a_arbitrations: HoldArbEmbed[] | null;
}

/**
 * Aplana el embed a2a_arbitrations (PostgREST devuelve array 0-1 por el FK
 * intent_id → a2a_payment_intents(id)). Embed vacío (upsert falló, R-4) → defaults
 * desde el intent.
 */
function toAdminHoldItem(row: HoldIntentRow): AdminHoldItem {
  const arb = row.a2a_arbitrations?.[0] ?? null;
  return {
    intentId: row.id,
    chainId: row.chain_id,
    atStakeUsd: arb
      ? (arb.at_stake_usd ?? row.authorized_usd)
      : row.authorized_usd,
    decision: arb ? arb.decision : null,
    method: arb ? arb.method : null,
    ambiguityReason: arb ? arb.ambiguity_reason : null,
    createdAt: row.created_at,
  };
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
        resolved_by: meta.resolvedBy,
        resolved_at: meta.resolvedAt,
        resolution_note: meta.resolutionNote,
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
   * Abre una disputa y la resuelve autónomamente. Pre-check chain/ownership
   * (fail-closed, ANTES de transicionar) → gate anti-race (open_dispute) →
   * rules→llm→cap → execute/hold, con rollback disputed→open si algo tira antes
   * de arb_closing/arb_hold.
   */
  async openDispute(
    intentId: string,
    ownerRef: string,
  ): Promise<ArbiterOutcome> {
    // 0. BLQ-BAJO-1 (fix primario): validar chain + ownership ANTES de transicionar.
    //    Un intent mainnet (o inexistente / de otro owner) se rechaza SIN tocar el
    //    status → jamás queda bricked en 'disputed' (el settlement normal sigue
    //    disponible). Read money-free; el gate anti-race real sigue siendo open_dispute
    //    (SELECT ... FOR UPDATE) abajo. Owner-check en app (no owner-guarded SELECT)
    //    para preservar OWNERSHIP_MISMATCH vs INTENT_NOT_FOUND — espejo del RPC.
    const pre = await supabase
      .from('a2a_payment_intents')
      .select('owner_ref, chain_id')
      .eq('id', intentId)
      .maybeSingle();
    if (pre.error) {
      log.error(
        { intentId, detail: pre.error.message },
        'dispute pre-check query failed',
      );
      throw new ArbiterError('INTERNAL');
    }
    if (!pre.data) throw new ArbiterError('INTENT_NOT_FOUND');
    if (pre.data.owner_ref !== ownerRef) {
      throw new ArbiterError('OWNERSHIP_MISMATCH');
    }
    // Testnet guard (AC-5/CD-5, fail-closed) ANTES de la transición (BLQ-BAJO-1).
    if (!TESTNET_CHAIN_IDS.has(pre.data.chain_id)) {
      throw new ArbiterError('CHAIN_NOT_SUPPORTED');
    }

    // 1. Transición atómica open→disputed (gate anti-race, AC-4).
    const { data, error } = await supabase.rpc('open_dispute', {
      p_intent_id: intentId,
      p_owner_ref: ownerRef,
    });
    if (error) mapArbPgError(error, 'open-dispute');
    const row = (data as OpenDisputeRow[] | null)?.[0];
    if (!row) throw new ArbiterError('INTENT_NOT_FOUND');

    // BLQ-BAJO-1 (robustez): a partir de acá el intent está 'disputed'. Si CUALQUIER
    // paso tira ANTES de transicionar a arb_closing/arb_hold, revertir disputed→open
    // (best-effort, money-free) para no dejarlo bricked. Una transición YA aplicada a
    // arb_closing (recuperable) / arb_hold (terminal held) NO se revierte: el revert
    // es status-gated en 'disputed'.
    try {
      return await this.resolveDispute(intentId, ownerRef, row);
    } catch (err) {
      await this.revertDisputeToOpen(intentId, ownerRef);
      throw err;
    }
  },

  /**
   * Resuelve la disputa sobre un intent YA transicionado a 'disputed': evidencia →
   * rules-first → LLM acotado si ambiguo → cap gate → execute/HOLD. Separado de
   * openDispute para que el rollback disputed→open (BLQ-BAJO-1) envuelva SÓLO los
   * pasos post-transición.
   */
  async resolveDispute(
    intentId: string,
    ownerRef: string,
    row: OpenDisputeRow,
  ): Promise<ArbiterOutcome> {
    const depositUsd = numericToMicro(row.authorized_usd) / 1_000_000;

    // WKH-191g (W2.2): best-effort lockForDispute por el deposit TOTAL en la
    // transición a 'disputed'. Único funnel post-transición para auto-resolve Y
    // arb_hold. Triple-gated CD-1; un fallo NUNCA aborta la resolución (CD-6).
    await bestEffortLockForDispute(intentId, row.key_id, row.authorized_usd);

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
          resolvedBy: null,
          resolvedAt: null,
          resolutionNote: null,
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
      resolvedBy: null,
      resolvedAt: null,
      resolutionNote: null,
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
      // WKH-191g (W2.3): best-effort releaseDispute (libera el lock del keyId).
      // Triple-gated CD-1; un fallo se loguea y NO altera el refund off-chain (CD-6).
      await bestEffortReleaseDispute(intentId, row.key_id);
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
    // WKH-191g: triple-gated escrow resolveDispute; flag OFF / sin consent → seam
    // operator-custodial byte-idéntico. MISMO SettleOutcome → ramas de abajo intactas.
    const settle = await settleArbitrationOnChain({
      intentId,
      ownerRef,
      payTo: row.pay_to,
      finalAmountUsd: arbUsd,
      chainId: row.chain_id,
      keyId: row.key_id,
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
      resolvedBy: null,
      resolvedAt: null,
      resolutionNote: null,
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
   * BLQ-BAJO-1: revierte disputed→open (best-effort, owner+status-guarded, money-free)
   * para desbrickear un intent si algo tiró tras open_dispute pero ANTES de
   * arb_closing/arb_hold. El guard `status='disputed'` garantiza que NO toca una
   * transición ya aplicada (arb_closing recuperable, arb_hold terminal held) ni mueve
   * fondos. Usado por openDispute (rollback) y expireStale (barrido defensivo).
   */
  async revertDisputeToOpen(intentId: string, ownerRef: string): Promise<void> {
    try {
      const { error } = await supabase
        .from('a2a_payment_intents')
        .update({ status: 'open' })
        .eq('id', intentId)
        .eq('owner_ref', ownerRef)
        .eq('status', 'disputed');
      if (error) {
        log.error(
          { intentId, detail: error.message },
          'dispute rollback disputed→open failed (lo barrerá expireStale)',
        );
      }
    } catch (err) {
      log.error(
        { intentId, detail: err instanceof Error ? err.message : String(err) },
        'dispute rollback threw',
      );
    }
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

  /**
   * WKH-189 · Lista los intents en `arb_hold` con su evidencia para la revisión
   * humana admin.
   *
   * CD-5: cross-tenant DELIBERADO — devuelve holds de TODOS los owners, SIN filtro
   * `owner_ref`. Es una excepción consciente al Ownership Guard estándar, superficie
   * de ALTO PRIVILEGIO gateada SÓLO por `requireAdminToken` en la ruta. NO reutilizar
   * fuera del panel admin.
   */
  async listHolds(): Promise<AdminHoldItem[]> {
    const { data, error } = await supabase
      .from('a2a_payment_intents')
      .select(
        'id, chain_id, authorized_usd, created_at, ' +
          'a2a_arbitrations(decision, method, ambiguity_reason, at_stake_usd, created_at)',
      )
      .eq('status', 'arb_hold')
      .order('created_at', { ascending: true });
    if (error) {
      log.error({ detail: error.message }, 'listHolds query failed');
      throw new ArbiterError('INTERNAL');
    }
    return ((data as unknown as HoldIntentRow[] | null) ?? []).map(
      toAdminHoldItem,
    );
  },

  /**
   * WKH-189 · Override humano admin-gated de un intent en `arb_hold`. Reusa el ÚNICO
   * choke-point de settle/refund del árbitro (`executeArbitration`, CD-1) — NO clona
   * money-path. Sin cap (CD-9): el humano ya está en el loop, el único límite es el
   * clamp [0, deposit]. Exactly-once vía el status-gate DB del RPC (CD-3): no hace
   * ningún UPDATE de status en la app.
   */
  async resolveHold(
    intentId: string,
    opts: {
      decision: 'release' | 'refund' | 'split';
      splitPct?: number;
      resolvedBy: string | null;
      note: string | null;
    },
  ): Promise<ArbiterOutcome> {
    // a. Validar input (autoritativo en el servicio).
    if (
      opts.decision !== 'release' &&
      opts.decision !== 'refund' &&
      opts.decision !== 'split'
    ) {
      throw new ArbiterError('INVALID_INPUT');
    }
    // T-7/AC-7 (§6.4): para 'split', splitPct DEBE ser finito y estar en [0,100]
    // inclusive. Fuera de rango (o no-numérico) → INVALID_INPUT: un splitPct=500 por
    // typo de admin (via API directa) NO debe liberar el depósito completo en silencio.
    // El clamp [0, deposit] de settleUsd (abajo) queda como SEGUNDA baranda / defensa en
    // profundidad, NO como validación primaria. CD-9 gobierna el auto-cap, no este rango.
    if (
      opts.decision === 'split' &&
      (opts.splitPct === undefined ||
        !Number.isFinite(opts.splitPct) ||
        opts.splitPct < 0 ||
        opts.splitPct > 100)
    ) {
      throw new ArbiterError('INVALID_INPUT');
    }

    // b. Leer el row REAL del intent (owner_ref/chain autoritativos, CD-4). El
    //    status-check es ADVISORY/fail-fast; el gate autoritativo es el RPC bajo
    //    FOR UPDATE (CD-3). NO se hace UPDATE de status acá.
    const { data, error } = await supabase
      .from('a2a_payment_intents')
      .select('owner_ref, chain_id, status, authorized_usd, seller_ref')
      .eq('id', intentId)
      .maybeSingle();
    if (error) {
      log.error({ intentId, detail: error.message }, 'resolveHold read failed');
      throw new ArbiterError('INTERNAL');
    }
    if (!data) throw new ArbiterError('INTENT_NOT_FOUND');
    const intentRow = data as {
      owner_ref: string;
      chain_id: number;
      status: string;
      authorized_usd: number;
      seller_ref: string;
    };
    if (intentRow.status !== 'arb_hold') {
      throw new ArbiterError('INTENT_NOT_OPEN');
    }

    // c. Testnet guard fail-closed (AC-6) — replica arbiter.ts openDispute.
    if (!TESTNET_CHAIN_IDS.has(intentRow.chain_id)) {
      throw new ArbiterError('CHAIN_NOT_SUPPORTED');
    }

    const ownerRef = intentRow.owner_ref;
    const depositUsd = numericToMicro(intentRow.authorized_usd) / 1_000_000;

    // d. Leer la fila a2a_arbitrations original (best-effort) para preservar la
    //    evidencia del hold (ambiguity_reason / llm_reasoning). Fallo/no-existe → null.
    let ambiguityReason: string | null = null;
    let llmReasoning: string | null = null;
    const arbRes = await supabase
      .from('a2a_arbitrations')
      .select('ambiguity_reason, llm_reasoning')
      .eq('intent_id', intentId)
      .maybeSingle();
    if (!arbRes.error && arbRes.data) {
      const arb = arbRes.data as {
        ambiguity_reason: string | null;
        llm_reasoning: string | null;
      };
      ambiguityReason = arb.ambiguity_reason;
      llmReasoning = arb.llm_reasoning;
    }

    // e. Computar settleUsd SIN cap (CD-9), clamp [0, deposit].
    const rawUsd =
      opts.decision === 'release'
        ? depositUsd
        : opts.decision === 'refund'
          ? 0
          : (depositUsd * (opts.splitPct ?? 0)) / 100;
    const settleUsd = Math.min(Math.max(0, rawUsd), depositUsd);

    // f. ArbMeta del override humano (method='admin_override', WKH-189).
    const meta: ArbMeta = {
      decision: opts.decision,
      method: 'admin_override',
      atStakeUsd: depositUsd,
      ambiguityReason,
      llmReasoning,
      evidenceDigest: null,
      sellerRef: intentRow.seller_ref,
      resolvedBy: opts.resolvedBy,
      resolvedAt: new Date().toISOString(),
      resolutionNote: opts.note,
    };

    // g. Reusar el seam (CD-1). ownerRef del row real (CD-4). allowStaleRecovery
    //    queda en false por default (CD-10, NO pasar el 5º arg).
    return this.executeArbitration(intentId, ownerRef, settleUsd, meta);
  },
};
