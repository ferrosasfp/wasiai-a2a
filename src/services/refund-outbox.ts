/**
 * Refund Outbox Service — reintento confiable de refunds best-effort fallidos.
 * Auditoría 2026-06-24 (M6).
 *
 * Cuando un refund best-effort (orchestrate / compose) NO aplica nada
 * (`reverted:false` / `success:false`) o tira una excepción, el call-site
 * encola una fila acá. Un sweep periódico reclama N pending (claim atómico vía
 * RPC `claim_refund_outbox` con FOR UPDATE SKIP LOCKED) y reintenta el credit.
 *
 * INVARIANTE ANTI-DOBLE-REFUND: SOLO se encola cuando NADA se aplicó. El check
 * de filas afectadas (A2) garantiza que `budgetService.credit/creditWithDest`
 * devuelven `reverted:true` únicamente cuando la reversión fue real (>=1 fila).
 * Por eso reintentar un entry es idempotente: representa un refund que NO ocurrió.
 * - done:  el retry devolvió `reverted:true` (>=1 fila) → refund aplicado, fin.
 * - dead:  superó MAX_ATTEMPTS sin revertir → revisión manual, NO seguir.
 * Un refund que SÍ aplicó NUNCA se encola, así que nunca se re-aplica.
 *
 * Best-effort de punta a punta: `enqueueRefund` y `processRefundOutbox` NUNCA
 * tiran. Si la tabla no existe (migración no aplicada), el enqueue loguea y el
 * response del caller NO se rompe; el sweep no encuentra nada.
 */

import { supabase } from '../lib/supabase.js';
import { budgetService } from './budget.js';

/** Máximo de intentos antes de marcar un entry como `dead` (revisión manual). */
export const MAX_REFUND_ATTEMPTS = 5;

export interface RefundOutboxEntry {
  keyId: string;
  chainId: number;
  amountUsd: number;
  ownerRef: string;
  /** Destino canónico del débito si pasó por dest-policy; null/undefined si no. */
  destination?: string | null;
  /** Motivo legible (p. ej. 'orchestrate.refund-failed'). Para auditoría. */
  reason: string;
}

interface RefundOutboxRow {
  id: string;
  key_id: string;
  chain_id: number;
  amount_usd: number | string;
  owner_ref: string;
  destination: string | null;
  reason: string;
  attempts: number;
  status: string;
  last_error: string | null;
}

export const refundOutbox = {
  /**
   * Encola un refund que NO se aplicó. Best-effort: nunca tira. Si la migración
   * no está aplicada (tabla ausente), loguea y retorna sin romper el caller.
   */
  async enqueueRefund(entry: RefundOutboxEntry): Promise<void> {
    try {
      const { error } = await supabase.from('a2a_refund_outbox').insert({
        key_id: entry.keyId,
        chain_id: entry.chainId,
        amount_usd: entry.amountUsd,
        owner_ref: entry.ownerRef,
        destination: entry.destination ?? null,
        reason: entry.reason,
      });
      if (error) {
        console.error('[refund-outbox.enqueue-failed]', {
          keyId: entry.keyId,
          chainId: entry.chainId,
          amountUsd: entry.amountUsd,
          reason: entry.reason,
          error: error.message,
        });
      }
    } catch (e) {
      console.error(
        '[refund-outbox.enqueue-threw]',
        e instanceof Error ? e.message : String(e),
      );
    }
  },

  /**
   * Reclama hasta `limit` entries pending (claim atómico vía RPC) y reintenta
   * cada credit. Best-effort: nunca tira. Para cada entry reclamado:
   *  - retry `credit`/`creditWithDest` (creditWithDest si tiene destination).
   *  - reverted:true → status='done'.
   *  - reverted:false → attempts++ ; 'dead' si attempts >= MAX, si no 'pending'.
   */
  async processRefundOutbox(limit = 20): Promise<void> {
    let claimed: RefundOutboxRow[];
    try {
      const { data, error } = await supabase.rpc('claim_refund_outbox', {
        p_limit: limit,
      });
      if (error) {
        console.error('[refund-outbox.claim-failed]', { error: error.message });
        return;
      }
      claimed = (data ?? []) as RefundOutboxRow[];
    } catch (e) {
      console.error(
        '[refund-outbox.claim-threw]',
        e instanceof Error ? e.message : String(e),
      );
      return;
    }

    for (const row of claimed) {
      await processEntry(row);
    }
  },
};

/**
 * Reintenta un único entry reclamado (status='processing'). Best-effort: atrapa
 * todo. INVARIANTE: solo marca 'done' si el credit revirtió DE VERDAD (>=1 fila).
 */
async function processEntry(row: RefundOutboxRow): Promise<void> {
  try {
    const amount =
      typeof row.amount_usd === 'string'
        ? Number.parseFloat(row.amount_usd)
        : row.amount_usd;

    const creditRes = row.destination
      ? await budgetService.creditWithDest(
          row.key_id,
          row.chain_id,
          amount,
          row.owner_ref,
          row.destination,
        )
      : await budgetService.credit(
          row.key_id,
          row.chain_id,
          amount,
          row.owner_ref,
        );

    const reverted = creditRes.reverted === true && creditRes.success;

    if (reverted) {
      await markDone(row.id);
      return;
    }

    await bumpAttempt(row, creditRes.error ?? 'REFUND_NOT_REVERTED');
  } catch (e) {
    await bumpAttempt(row, e instanceof Error ? e.message : String(e));
  }
}

/** Marca el entry como aplicado. No re-procesable (status sale de 'processing'). */
async function markDone(id: string): Promise<void> {
  try {
    const { error } = await supabase
      .from('a2a_refund_outbox')
      .update({
        status: 'done',
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);
    if (error) {
      console.error('[refund-outbox.mark-done-failed]', {
        id,
        error: error.message,
      });
    }
  } catch (e) {
    console.error(
      '[refund-outbox.mark-done-threw]',
      e instanceof Error ? e.message : String(e),
    );
  }
}

/**
 * Incrementa attempts y reencola ('pending') o sepulta ('dead') si supera el
 * máximo. El refund NO se aplicó (reverted:false), así que reintentar es seguro.
 */
async function bumpAttempt(
  row: RefundOutboxRow,
  lastError: string,
): Promise<void> {
  const nextAttempts = row.attempts + 1;
  const status = nextAttempts >= MAX_REFUND_ATTEMPTS ? 'dead' : 'pending';
  try {
    const { error } = await supabase
      .from('a2a_refund_outbox')
      .update({
        attempts: nextAttempts,
        status,
        last_error: lastError.slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq('id', row.id);
    if (error) {
      console.error('[refund-outbox.bump-attempt-failed]', {
        id: row.id,
        error: error.message,
      });
    }
  } catch (e) {
    console.error(
      '[refund-outbox.bump-attempt-threw]',
      e instanceof Error ? e.message : String(e),
    );
  }
}
