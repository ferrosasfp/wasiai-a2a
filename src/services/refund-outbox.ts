/**
 * Refund Outbox Service — reintento confiable de refunds best-effort fallidos.
 * Auditoría 2026-06-24 (M6).
 *
 * Cuando un refund best-effort (orchestrate / compose) NO aplica nada
 * (`reverted:false` / `success:false`) o tira una excepción, el call-site
 * encola una fila acá. Un sweep periódico reclama N pending (claim atómico vía
 * RPC `claim_refund_outbox` con FOR UPDATE SKIP LOCKED) y reintenta el credit.
 *
 * INVARIANTE ANTI-DOBLE-REFUND (HU-194 — leer completo antes de tocar esto):
 *
 * El check de filas afectadas (A2) demuestra que `success:false` ⟹ NADA se
 * aplicó, así que ese camino se puede reintentar sin riesgo. Pero el camino de
 * EXCEPCIÓN NO es demostrable: `refund_a2a_key_spend` puede COMMITEAR y perderse
 * la respuesta (socket reset, timeout post-commit, pod matado). Ahí el `catch`
 * del call-site encolaba un refund que YA se había aplicado y el sweep lo
 * acreditaba de nuevo: el caller cobraba DOS VECES. Misma ambigüedad que resolvió
 * HU-192 para el transfer gasless ("el error puede ser del read, no de la
 * acción"), que acá quedaba abierta.
 *
 * Por eso la idempotencia NO se apoya en "sólo se encola lo que no se aplicó"
 * (que no se puede garantizar), sino en una clave del refund LÓGICO que viaja
 * hasta Postgres: `idem_key` (ver `lib/refund-idem.ts`). La RPC registra el
 * refund aplicado en `a2a_refund_applications` DENTRO de la misma transacción que
 * mueve el dinero, así que un reintento del mismo refund lógico es un no-op —
 * incluso si lo disparan dos procesos a la vez (la serialización la da el
 * PRIMARY KEY, no un guard en TypeScript).
 * - done:  el retry devolvió `reverted:true` (>=1 fila, o "ya aplicada").
 * - dead:  superó MAX_ATTEMPTS sin revertir → revisión manual, NO seguir.
 *
 * RESIDUO CONOCIDO: las filas encoladas ANTES de la migración
 * 20260727000000_hu194_refund_idempotency tienen `idem_key` NULL y se procesan
 * exactamente como antes (sin dedup). No se les puede deducir una clave: nadie
 * registró el crédito original.
 *
 * Best-effort de punta a punta: `enqueueRefund` y `processRefundOutbox` NUNCA
 * tiran. Si la tabla no existe (migración no aplicada), el enqueue loguea y el
 * response del caller NO se rompe; el sweep no encuentra nada.
 */

import { getLogger } from '../lib/logger.js';
import { supabase } from '../lib/supabase.js';
import { budgetService } from './budget.js';

const log = getLogger('refund-outbox');

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
  /**
   * HU-194: clave del refund LÓGICO (`lib/refund-idem.ts` → `refundIdemKey`).
   * REQUERIDA: tiene que ser LA MISMA que se le pasó al `budgetService.credit*`
   * que falló, o el sweep acreditaría un refund que ya se aplicó. `reason` NO
   * entra en la clave: el mismo refund lógico se encola con reason distinto según
   * cómo falló (`refund-failed` / `refund-threw`) y ambos deben dedupearse.
   */
  idemKey: string;
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
  /** HU-194. NULL sólo en filas encoladas antes de la migración (sin dedup). */
  idem_key?: string | null;
}

/** Código PG de unique_violation. */
const PG_UNIQUE_VIOLATION = '23505';

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
        idem_key: entry.idemKey,
      });
      if (error) {
        // HU-194: el índice único parcial `uq_refund_outbox_idem_key` ya tenía una
        // fila para este refund lógico (dos caminos de error del mismo call-site,
        // o dos procesos encolando lo mismo). NO es un fallo: es la dedup de la
        // cola haciendo su trabajo. Se loguea a nivel info y se sigue.
        if (error.code === PG_UNIQUE_VIOLATION) {
          log.info(
            {
              keyId: entry.keyId,
              idemKey: entry.idemKey,
              reason: entry.reason,
            },
            '[refund-outbox.enqueue-deduped]',
          );
          return;
        }
        log.error(
          {
            keyId: entry.keyId,
            chainId: entry.chainId,
            amountUsd: entry.amountUsd,
            reason: entry.reason,
            error: error.message,
          },
          '[refund-outbox.enqueue-failed]',
        );
      }
    } catch (e) {
      log.error(
        { detail: e instanceof Error ? e.message : String(e) },
        '[refund-outbox.enqueue-threw]',
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
        log.error({ error: error.message }, '[refund-outbox.claim-failed]');
        return;
      }
      // M9: el RPC `claim_refund_outbox` ahora devuelve filas tipadas; el cast
      // acota al shape de dominio (subset de columnas consumidas).
      claimed = (data ?? []) as RefundOutboxRow[];
    } catch (e) {
      log.error(
        { detail: e instanceof Error ? e.message : String(e) },
        '[refund-outbox.claim-threw]',
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

    // HU-194: la clave del refund LÓGICO viaja tal cual hasta la RPC. Es lo que
    // hace que este reintento sea un no-op si el crédito original YA commiteó
    // (respuesta perdida) y que 3 barridos seguidos acrediten UNA sola vez.
    // NULL ⟹ fila encolada antes de la migración ⟹ sin dedup, igual que antes.
    const idem = { idemKey: row.idem_key ?? null };

    const creditRes = row.destination
      ? await budgetService.creditWithDest(
          row.key_id,
          row.chain_id,
          amount,
          row.owner_ref,
          row.destination,
          idem,
        )
      : await budgetService.credit(
          row.key_id,
          row.chain_id,
          amount,
          row.owner_ref,
          idem,
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
      log.error(
        {
          id,
          error: error.message,
        },
        '[refund-outbox.mark-done-failed]',
      );
    }
  } catch (e) {
    log.error(
      { detail: e instanceof Error ? e.message : String(e) },
      '[refund-outbox.mark-done-threw]',
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
      log.error(
        {
          id: row.id,
          error: error.message,
        },
        '[refund-outbox.bump-attempt-failed]',
      );
    }
  } catch (e) {
    log.error(
      { detail: e instanceof Error ? e.message : String(e) },
      '[refund-outbox.bump-attempt-threw]',
    );
  }
}
