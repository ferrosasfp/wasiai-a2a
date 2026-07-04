/**
 * Fee Split Service — WKH-136 · Splits atómicos del protocol fee (bps)
 *
 * Subdivide el protocol fee único (WKH-44/132) en N legs configurables en basis
 * points ruteados a plataforma / creador / referral. El total NO cambia
 * (invariante WKH-132) — los splits SUBDIVIDEN, no suman un cobro nuevo (CD-P4).
 *
 * Piezas:
 *   - `computeSplits()`   : reparto micro-USD entero (sin float64 lossy), dust →
 *                           plataforma. Σ legs == fee exacto (CD-5).
 *   - `resolveRecipients()`: resolución SERVER-SIDE (env / a2a_agents), fallback
 *                           recipient inválido → plataforma (SG-6, AC-6). NUNCA
 *                           del body del caller (CD-6).
 *   - `planSplits()`      : resolve + compute → recipients con amount + skipped.
 *   - `settleFeeSplits()` : N legs idempotentes sobre `a2a_fee_splits`. Cada leg
 *                           reusa EXACTAMENTE `sign()/settle()/verifyDefaultChainSettle`
 *                           + `feeUsdcToWei` (CD-3). Nunca rechaza (CD-B).
 *   - `reverseFeeSplits()`: ledger-only (SG-7). Itera TODOS los legs `charged`
 *                           (CD-4) → `reversed`, bajo Ownership Guard (CD-2).
 *
 * Idempotencia por recipient: `UNIQUE(orchestration_id, recipient_role)` +
 * captura `23505` (CD-2/CD-9). Ownership Guard `owner_ref` en toda query (CD-2).
 */

import { getPaymentAdapter } from '../adapters/registry.js';
import { verifyDefaultChainSettle } from '../adapters/settle-verifier.js';
import type { SignResult } from '../adapters/types.js';
import type { SplitConfig } from '../config/split-config.js';
import { getLogger } from '../lib/logger.js';
import { supabase } from '../lib/supabase.js';
import { feeUsdcToWei } from './fee-charge.js';

const log = getLogger('fee-split');

const SPLITS_TABLE = 'a2a_fee_splits';
const PG_UNIQUE_VIOLATION = '23505';
const TOTAL_BPS = 10000;

// Sentinel address regex (mirror settle-verifier.ts:82 ADDRESS_RE): un recipient
// con wallet fuera de este formato se trata como inválido (AC-6).
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// ─── Tipos públicos ─────────────────────────────────────────

export type SplitRecipientRole = 'platform' | 'creator' | 'referral';

export type SplitLegStatus =
  | 'charged'
  | 'already-charged'
  | 'failed'
  | 'skipped'
  | 'reversed'
  | 'in-progress';

/**
 * Resultado por-recipient de un settlement de splits (AC-3). Se adjunta aditivo
 * en `FeeChargeResult.splits` (CD-8: construir con asignación condicional).
 */
export interface SplitLeg {
  role: SplitRecipientRole;
  wallet: string;
  ownerRef: string;
  bps: number;
  amountUsdc: number;
  status: SplitLegStatus;
  txHash?: string;
  error?: string;
}

/** Row mínimo de `a2a_fee_splits` que este módulo lee (CD-1 — nada de any). */
export interface FeeSplitRow {
  id: string;
  orchestration_id: string;
  recipient_role: SplitRecipientRole;
  recipient_wallet: string;
  owner_ref: string;
  bps: number;
  amount_usdc: number;
  status: 'pending' | 'charged' | 'failed' | 'skipped' | 'reversed';
  tx_hash: string | null;
  error_message: string | null;
}

/** Referencia server-side de una parte (creador / referral). */
export interface SplitPartyRef {
  wallet: string | null;
  ownerRef: string | null;
}

/**
 * Contexto de resolución SERVER-SIDE (CD-6). `platformWallet` viene de
 * `WASIAI_PROTOCOL_FEE_WALLET`; `creator`/`referral` del agente primario
 * (a2a_agents / registry). NUNCA del body del caller.
 */
export interface SplitContext {
  platformWallet: string;
  creator?: SplitPartyRef | null;
  referral?: SplitPartyRef | null;
}

/** Recipient resuelto con wallet válida — `bps` es el EFECTIVO (platform absorbe re-rutas). */
export interface ResolvedRecipient {
  role: SplitRecipientRole;
  wallet: string;
  ownerRef: string;
  bps: number;
}

/** Recipient salteado (wallet inválida/ausente) — su bps se re-rutó a plataforma (SG-6). */
export interface SkippedRecipient {
  role: SplitRecipientRole;
  bps: number;
  ownerRef: string;
  reason: string;
}

export interface RecipientResolution {
  recipients: ResolvedRecipient[];
  skipped: SkippedRecipient[];
  effectiveBps: Record<SplitRecipientRole, number>;
}

export interface SplitAmounts {
  platform: number;
  creator: number;
  referral: number;
}

/** Recipient listo para settle (resuelto + monto ya calculado). */
export interface RecipientWithAmount extends ResolvedRecipient {
  amountUsdc: number;
}

export interface SplitPlan {
  recipients: RecipientWithAmount[];
  skipped: SkippedRecipient[];
  totalUsdc: number;
}

export interface FeeSplitSettlement {
  legs: SplitLeg[];
  status: 'charged' | 'already-charged' | 'failed';
  txHash?: string;
  error?: string;
  inProgress?: boolean;
}

export type ReverseResult =
  | { status: 'reversed'; reversedCount: number; legs: SplitLeg[] }
  | { status: 'noop'; reversedCount: 0 }
  | { status: 'ownership_mismatch' };

interface SupabaseError {
  code?: string;
  message?: string;
}

// ─── Helpers ────────────────────────────────────────────────

function truncateError(msg: string): string {
  return msg.length > 180 ? `${msg.slice(0, 177)}...` : msg;
}

function isValidWallet(wallet: string | null | undefined): wallet is string {
  return typeof wallet === 'string' && ADDRESS_RE.test(wallet);
}

// ─── computeSplits (Exemplar 3 — micro-USD entero, dust → platform) ─────────

/**
 * Reparte `feeUsdc` según `bps` en micro-USD ENTERO (sin `parseFloat` lossy).
 * El dust (residuo del `Math.floor`) se absorbe SIEMPRE en plataforma ⇒
 * `Σ legMicro == totalMicro` ⇒ ni se pierde ni se crea USD (CD-5).
 */
export function computeSplits(
  feeUsdc: number,
  bps: { platform: number; creator: number; referral: number },
): SplitAmounts {
  const totalMicro = Math.round(feeUsdc * 1e6);

  const platformMicro = Math.floor((totalMicro * bps.platform) / TOTAL_BPS);
  const creatorMicro = Math.floor((totalMicro * bps.creator) / TOTAL_BPS);
  const referralMicro = Math.floor((totalMicro * bps.referral) / TOTAL_BPS);

  // dust >= 0 por floor → plataforma lo absorbe (invariante Σ == totalMicro).
  const dust = totalMicro - (platformMicro + creatorMicro + referralMicro);

  return {
    platform: (platformMicro + dust) / 1e6,
    creator: creatorMicro / 1e6,
    referral: referralMicro / 1e6,
  };
}

// ─── resolveRecipients (Exemplar 6 — server-side, fallback → platform) ──────

/**
 * Resuelve las wallets de cada recipient SERVER-SIDE (CD-6). Un recipient con
 * `bps > 0` cuya wallet es inválida/ausente se saltea (fila `skipped`) y su bps
 * se RE-RUTA a plataforma (SG-6, AC-6). El `bps` de cada `ResolvedRecipient` es
 * el EFECTIVO (plataforma acumula las re-rutas).
 */
export function resolveRecipients(
  config: SplitConfig,
  ctx: SplitContext,
): RecipientResolution {
  const recipients: ResolvedRecipient[] = [];
  const skipped: SkippedRecipient[] = [];
  let platformBps = config.platformBps;

  const resolveParty = (
    role: 'creator' | 'referral',
    bps: number,
    party: SplitPartyRef | null | undefined,
  ): void => {
    if (bps <= 0) return; // bps 0 → ni recipient ni skipped (no leg nulo).
    if (party && isValidWallet(party.wallet)) {
      recipients.push({
        role,
        wallet: party.wallet,
        ownerRef: party.ownerRef ?? role,
        bps,
      });
      return;
    }
    // SG-6: wallet inválida/ausente → skip + re-ruta bps a plataforma.
    skipped.push({
      role,
      bps,
      ownerRef: 'platform',
      reason: 'RECIPIENT_UNRESOLVED',
    });
    platformBps += bps;
  };

  resolveParty('creator', config.creatorBps, ctx.creator);
  resolveParty('referral', config.referralBps, ctx.referral);

  // Plataforma: SIEMPRE (wallet garantizada non-empty por el caller). owner_ref
  // = 'platform' (Exemplar 6). bps EFECTIVO incluye las re-rutas.
  recipients.unshift({
    role: 'platform',
    wallet: ctx.platformWallet,
    ownerRef: 'platform',
    bps: platformBps,
  });

  const creatorEff = recipients.find((r) => r.role === 'creator')?.bps ?? 0;
  const referralEff = recipients.find((r) => r.role === 'referral')?.bps ?? 0;

  return {
    recipients,
    skipped,
    effectiveBps: {
      platform: platformBps,
      creator: creatorEff,
      referral: referralEff,
    },
  };
}

/**
 * resolve + compute: recipients con `amountUsdc` (legs con monto 0 se descartan —
 * no transfer nulo, Exemplar 3) + skipped. `totalUsdc == feeUsdc` (CD-5).
 */
export function planSplits(
  feeUsdc: number,
  config: SplitConfig,
  ctx: SplitContext,
): SplitPlan {
  const resolution = resolveRecipients(config, ctx);
  const amounts = computeSplits(feeUsdc, resolution.effectiveBps);

  const recipients: RecipientWithAmount[] = [];
  for (const r of resolution.recipients) {
    const amountUsdc = amounts[r.role];
    if (amountUsdc > 0) recipients.push({ ...r, amountUsdc });
  }
  const totalUsdc = recipients.reduce((sum, r) => sum + r.amountUsdc, 0);

  return { recipients, skipped: resolution.skipped, totalUsdc };
}

// ─── settleFeeSplits (Exemplar 1 — N legs idempotentes por recipient) ───────

/**
 * Ejecuta N legs idempotentes sobre `a2a_fee_splits`. Cada leg reusa EXACTAMENTE
 * el primitivo `sign()/settle()/verifyDefaultChainSettle` + `feeUsdcToWei`
 * (CD-3) con idempotencia `UNIQUE(orchestration_id, recipient_role)` (CD-2).
 * NUNCA rechaza la promise (CD-B) — todo error va al status del leg. El agregado
 * NUNCA es `charged` si un leg falló (AC-3).
 */
export async function settleFeeSplits(params: {
  orchestrationId: string;
  recipients: RecipientWithAmount[];
  skipped?: SkippedRecipient[];
}): Promise<FeeSplitSettlement> {
  const { orchestrationId, recipients, skipped = [] } = params;

  const legs: SplitLeg[] = [];

  // Filas `skipped` (audit AC-6): amount 0, wallet vacía. Idempotentes.
  for (const s of skipped) {
    await recordSkipped(orchestrationId, s);
    legs.push({
      role: s.role,
      wallet: '',
      ownerRef: s.ownerRef,
      bps: s.bps,
      amountUsdc: 0,
      status: 'skipped',
    });
  }

  // Legs con transfer real.
  for (const r of recipients) {
    legs.push(await chargeLeg(orchestrationId, r));
  }

  // Agregado (AC-3): cualquier leg cobrable `failed` → parent `failed`.
  const chargeable = legs.filter((l) => l.status !== 'skipped');
  const failed = chargeable.find((l) => l.status === 'failed');
  if (failed) {
    const settlement: FeeSplitSettlement = { legs, status: 'failed' };
    if (failed.error !== undefined) settlement.error = failed.error;
    return settlement;
  }

  const inProgress = chargeable.some((l) => l.status === 'in-progress');
  const freshCharged = chargeable.find((l) => l.status === 'charged');

  if (freshCharged) {
    const settlement: FeeSplitSettlement = { legs, status: 'charged' };
    if (freshCharged.txHash !== undefined)
      settlement.txHash = freshCharged.txHash;
    return settlement;
  }

  // Sin cobros frescos: todo already-charged / in-progress / sin cobrables.
  const settlement: FeeSplitSettlement = { legs, status: 'already-charged' };
  if (inProgress) settlement.inProgress = true;
  const priorTx = chargeable.find((l) => l.txHash !== undefined)?.txHash;
  if (priorTx !== undefined) settlement.txHash = priorTx;
  return settlement;
}

/**
 * Cobra UN leg de forma idempotente y best-effort (Exemplar 1). Nunca rechaza.
 */
async function chargeLeg(
  orchestrationId: string,
  recipient: RecipientWithAmount,
): Promise<SplitLeg> {
  const { role, wallet, ownerRef, bps, amountUsdc } = recipient;
  const base: SplitLeg = {
    role,
    wallet,
    ownerRef,
    bps,
    amountUsdc,
    status: 'failed',
  };

  try {
    // Idempotency SELECT por (orch, role) — Ownership Guard owner_ref (CD-2).
    const { data: existing, error: selectErr } = (await supabase
      .from(SPLITS_TABLE)
      .select('status, tx_hash')
      .eq('orchestration_id', orchestrationId)
      .eq('recipient_role', role)
      .eq('owner_ref', ownerRef)
      .maybeSingle()) as {
      data: { status: FeeSplitRow['status']; tx_hash: string | null } | null;
      error: SupabaseError | null;
    };

    if (selectErr) {
      log.error(
        { orchestrationId, role, detail: selectErr.message },
        'split leg DB select error',
      );
      return { ...base, error: `DB_ERROR: ${selectErr.message ?? 'unknown'}` };
    }

    if (existing) {
      if (existing.status === 'charged') {
        const leg: SplitLeg = { ...base, status: 'already-charged' };
        if (existing.tx_hash) leg.txHash = existing.tx_hash;
        return leg;
      }
      if (existing.status === 'pending') {
        return { ...base, status: 'in-progress' };
      }
      // failed / skipped / reversed → el INSERT chocará 23505 (idempotente).
    }

    const wei = feeUsdcToWei(amountUsdc);

    const { error: insertErr } = (await supabase.from(SPLITS_TABLE).insert({
      orchestration_id: orchestrationId,
      recipient_role: role,
      recipient_wallet: wallet,
      owner_ref: ownerRef,
      bps,
      amount_usdc: amountUsdc,
      status: 'pending',
    })) as { error: SupabaseError | null };

    if (insertErr) {
      if (insertErr.code === PG_UNIQUE_VIOLATION) {
        // Race / retry — otro worker tiene el leg en curso (CD-9).
        return { ...base, status: 'in-progress' };
      }
      log.error(
        { orchestrationId, role, detail: insertErr.message },
        'split leg DB insert error',
      );
      return { ...base, error: `DB_ERROR: ${insertErr.message ?? 'unknown'}` };
    }

    // sign (CD-F: let tipado antes de try).
    let signResult: SignResult;
    try {
      signResult = await getPaymentAdapter().sign({
        to: wallet as `0x${string}`,
        value: wei,
      });
    } catch (signErr) {
      const msg = signErr instanceof Error ? signErr.message : String(signErr);
      log.error(
        { orchestrationId, role, detail: msg },
        'split leg sign() failed',
      );
      await markLegFailed(orchestrationId, role, ownerRef, msg);
      return { ...base, error: msg };
    }

    const { paymentRequest } = signResult;
    const settleResult = await getPaymentAdapter().settle({
      authorization: paymentRequest.authorization,
      signature: paymentRequest.signature,
      network: paymentRequest.network ?? '',
    });

    if (!settleResult.success) {
      const errMsg = `settle failed: ${settleResult.error ?? 'unknown'}`;
      log.error(
        { orchestrationId, role, detail: errMsg },
        'split leg settle failed',
      );
      await markLegFailed(orchestrationId, role, ownerRef, errMsg);
      return { ...base, error: errMsg };
    }

    // Re-verify on-chain ANTES de `charged` (CD-5 / TB-01). RPC_UNAVAILABLE →
    // fail-OPEN + warn; contradicción definitiva → fail-CLOSED (leg failed).
    const reVerified = await verifyDefaultChainSettle({
      txHash: settleResult.txHash,
      payTo: wallet,
      requiredAmountAtomic: BigInt(wei),
    });
    if (reVerified.warn) {
      log.warn(
        { orchestrationId, role, reason: reVerified.reason },
        'split leg settle re-verify unavailable, trusting facilitator',
      );
    }
    if (!reVerified.ok) {
      const errMsg = `settle on-chain re-verification failed: ${reVerified.reason ?? 'unknown'}`;
      log.error(
        { orchestrationId, role, detail: errMsg },
        'split leg re-verify failed',
      );
      await markLegFailed(orchestrationId, role, ownerRef, errMsg);
      return { ...base, error: errMsg };
    }

    // UPDATE charged (Ownership Guard owner_ref, CD-2).
    const txHash = settleResult.txHash;
    const { error: updateErr } = (await supabase
      .from(SPLITS_TABLE)
      .update({ status: 'charged', tx_hash: txHash })
      .eq('orchestration_id', orchestrationId)
      .eq('recipient_role', role)
      .eq('owner_ref', ownerRef)) as { error: SupabaseError | null };

    if (updateErr) {
      // El transfer salió OK pero la DB no se actualizó — el leg se cobró; el
      // row queda 'pending' (auditable). Reportamos charged igual.
      log.error(
        { orchestrationId, role, detail: updateErr.message },
        'split leg DB update-charged error',
      );
    }

    return { ...base, status: 'charged', txHash };
  } catch (err) {
    // CD-B: jamás rechazar. Cualquier excepción → leg failed.
    const msg = err instanceof Error ? err.message : String(err);
    log.error(
      { orchestrationId, role, detail: msg },
      'split leg unexpected error',
    );
    await markLegFailed(orchestrationId, role, ownerRef, msg);
    return { ...base, error: `DB_ERROR: ${msg}` };
  }
}

/**
 * Inserta (idempotente) una fila `skipped` para audit (AC-6). Best-effort.
 */
async function recordSkipped(
  orchestrationId: string,
  s: SkippedRecipient,
): Promise<void> {
  try {
    const { error } = (await supabase.from(SPLITS_TABLE).insert({
      orchestration_id: orchestrationId,
      recipient_role: s.role,
      recipient_wallet: '',
      owner_ref: s.ownerRef,
      bps: s.bps,
      amount_usdc: 0,
      status: 'skipped',
      error_message: truncateError(s.reason),
    })) as { error: SupabaseError | null };
    if (error && error.code !== PG_UNIQUE_VIOLATION) {
      log.warn(
        { orchestrationId, role: s.role, detail: error.message },
        'failed to record skipped split row',
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(
      { orchestrationId, role: s.role, detail: msg },
      'recordSkipped threw',
    );
  }
}

/**
 * Marca un leg como `failed` (Ownership Guard) sin propagar errores.
 */
async function markLegFailed(
  orchestrationId: string,
  role: SplitRecipientRole,
  ownerRef: string,
  errorMessage: string,
): Promise<void> {
  try {
    await supabase
      .from(SPLITS_TABLE)
      .update({ status: 'failed', error_message: truncateError(errorMessage) })
      .eq('orchestration_id', orchestrationId)
      .eq('recipient_role', role)
      .eq('owner_ref', ownerRef);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(
      { orchestrationId, role, detail: msg },
      'failed to mark split leg as failed',
    );
  }
}

// ─── reverseFeeSplits (Exemplar 5 — ledger-only, itera TODOS los charged) ────

/**
 * Reversa CONTABLE (ledger-only, SG-7) de todos los legs de una orchestration.
 * Itera sobre TODOS los legs `charged` (CD-4) → `reversed`, bajo Ownership Guard
 * `owner_ref` (CD-2 / WKH-129): si existen legs pero NINGUNO pertenece a
 * `ownerRef` → `ownership_mismatch`.
 *
 * v1: NO se cablea a orchestrate/compose (el fee se cobra post-success). Un
 * clawback on-chain a wallets externas es imposible sin escrow — esto SOLO marca
 * el ledger contable, no mueve fondos (SDD §4.7).
 */
export async function reverseFeeSplits(
  orchestrationId: string,
  ownerRef: string,
): Promise<ReverseResult> {
  const { data: rows, error: selectErr } = (await supabase
    .from(SPLITS_TABLE)
    .select(
      'id, status, owner_ref, recipient_role, recipient_wallet, bps, amount_usdc, tx_hash',
    )
    .eq('orchestration_id', orchestrationId)) as {
    data: Array<{
      id: string;
      status: FeeSplitRow['status'];
      owner_ref: string;
      recipient_role: SplitRecipientRole;
      recipient_wallet: string;
      bps: number;
      amount_usdc: number;
      tx_hash: string | null;
    }> | null;
    error: SupabaseError | null;
  };

  if (selectErr) {
    log.error(
      { orchestrationId, detail: selectErr.message },
      'reverseFeeSplits select error',
    );
    return { status: 'noop', reversedCount: 0 };
  }

  if (!rows || rows.length === 0) {
    return { status: 'noop', reversedCount: 0 };
  }

  // Ownership Guard (WKH-129): si ningún leg pertenece a `ownerRef` → mismatch.
  const owned = rows.filter((r) => r.owner_ref === ownerRef);
  if (owned.length === 0) {
    log.warn(
      { orchestrationId, ownerRef },
      'reverseFeeSplits ownership mismatch — no legs owned by caller',
    );
    return { status: 'ownership_mismatch' };
  }

  const legs: SplitLeg[] = [];
  let reversedCount = 0;

  // CD-4: iterar TODOS los legs `charged` (no solo el primero).
  for (const row of owned) {
    if (row.status !== 'charged') continue;

    const { error: updErr } = (await supabase
      .from(SPLITS_TABLE)
      .update({ status: 'reversed' })
      .eq('orchestration_id', orchestrationId)
      .eq('recipient_role', row.recipient_role)
      .eq('owner_ref', ownerRef)) as { error: SupabaseError | null };

    if (updErr) {
      log.error(
        { orchestrationId, role: row.recipient_role, detail: updErr.message },
        'reverseFeeSplits update error',
      );
      continue;
    }

    reversedCount += 1;
    const leg: SplitLeg = {
      role: row.recipient_role,
      wallet: row.recipient_wallet,
      ownerRef: row.owner_ref,
      bps: row.bps,
      amountUsdc: row.amount_usdc,
      status: 'reversed',
    };
    if (row.tx_hash) leg.txHash = row.tx_hash;
    legs.push(leg);
  }

  return { status: 'reversed', reversedCount, legs };
}
