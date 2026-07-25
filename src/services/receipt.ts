/**
 * Receipt Service — WKH-124 KEY-RECEIPTS
 *
 * Recibos inmutables HMAC-encadenados (append-only) por owner. Cada pago exitoso
 * emite (best-effort, fire-and-forget) un recibo con el linaje completo
 * (session_id → agent_key_id → owner_ref), encadenado por owner vía
 * `prev_receipt_hash`, y firmado server-side con
 * `receipt_hash = HMAC-SHA256(RECEIPT_SIGNING_SECRET, canonical_json)`.
 *
 * El secret se usa SOLO en Node (node:crypto): NUNCA va a Postgres, ni se loguea,
 * ni se expone en HTTP (CD-4). La tabla es append-only salvo el UPDATE-once que
 * escribe `receipt_hash` por primera vez (`receipt_hash='' → hash`, CD-2).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { getLogger } from '../lib/logger.js';
import { supabase } from '../lib/supabase.js';
import type { Database } from '../types/database.types.js';
import type {
  EmitReceiptInput,
  ReceiptListItem,
  ReceiptRow,
  VerifyReceiptResult,
} from '../types/receipt.js';

// hex de 64 chars (32 bytes) — un HMAC-SHA256.
const HMAC_HEX_RE = /^[0-9a-f]{64}$/;

const log = getLogger('receipts');

/**
 * Campos que entran al canonical payload. Un superset de las columnas firmables;
 * `buildCanonicalPayload` los ordena alfabéticamente y los normaliza (DT-5).
 */
interface CanonicalFields {
  agent_key_id: string | null;
  amount_usd: number | string;
  chain_id: number;
  counterparty: string | null;
  created_at: string;
  delegation_id: string | null;
  id: string;
  orchestration_id: string | null;
  owner_ref: string;
  prev_receipt_hash: string | null;
  receipt_type: string;
  session_id: string | null;
  tx_hash: string | null;
}

/**
 * Construye el canonical JSON determinista (DT-5). Firma (Node) y verify
 * (lee NUMERIC string de Supabase) DEBEN coincidir byte a byte: ambos lados
 * aplican esta MISMA normalización. NO se confía en el orden de escritura del
 * objeto fuente — las keys se insertan en orden alfabético ascendente.
 */
export function buildCanonicalPayload(fields: CanonicalFields): string {
  // 13 keys, ordenadas alfabéticamente ascendente.
  const ordered: Record<string, string | number | null> = {
    agent_key_id: fields.agent_key_id,
    amount_usd: Number(fields.amount_usd).toFixed(8),
    chain_id: fields.chain_id,
    counterparty: fields.counterparty,
    created_at: new Date(fields.created_at).toISOString(),
    delegation_id: fields.delegation_id,
    id: fields.id,
    orchestration_id: fields.orchestration_id,
    owner_ref: fields.owner_ref,
    prev_receipt_hash: fields.prev_receipt_hash,
    receipt_type: fields.receipt_type,
    session_id: fields.session_id,
    tx_hash: fields.tx_hash,
  };
  return JSON.stringify(ordered);
}

/**
 * Computa el HMAC-SHA256 hex del canonical. Retorna `null` si el secret no está
 * disponible (señal "sin firma posible"). El secret NUNCA se loguea (CD-4).
 */
export function computeReceiptHash(canonical: string): string | null {
  const secret = process.env.RECEIPT_SIGNING_SECRET;
  if (!secret) return null;
  return createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
}

/**
 * Comparación constante-temporal sobre dos hex de 64 chars. Valida formato ANTES
 * de `Buffer.from` y longitud ANTES de `timingSafeEqual` (patrón signed-auth.ts).
 * NUNCA throw.
 */
function hashesEqual(a: string, b: string): boolean {
  if (!HMAC_HEX_RE.test(a) || !HMAC_HEX_RE.test(b)) return false;
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export const receiptService = {
  buildCanonicalPayload,
  computeReceiptHash,

  /**
   * Emite un recibo (best-effort, NUNCA throw — CD-1). 3 pasos:
   *   1. Guards: ownerRef no-vacío + RECEIPT_SIGNING_SECRET presente; si no → skip.
   *   2. RPC `insert_receipt` (atómico, advisory lock por owner): inserta con
   *      receipt_hash='' y devuelve { id, prev_receipt_hash, created_at }.
   *   3. Computa el HMAC en Node y hace UPDATE-once
   *      (`.eq('id', id).eq('receipt_hash', '')` → escribe el hash una sola vez).
   * Cualquier error en 2/3 → WARN + return. El secret NUNCA va a Postgres.
   */
  async emit(input: EmitReceiptInput): Promise<void> {
    // 1. Guards previos (CD-D, DT-6).
    if (!input.ownerRef) {
      log.warn('skip: no ownerRef');
      return;
    }
    if (!process.env.RECEIPT_SIGNING_SECRET) {
      log.warn('skip: RECEIPT_SIGNING_SECRET unset');
      return;
    }

    try {
      // 2. RPC atómico: inserta con receipt_hash='' y devuelve id/prev/created_at.
      // M9: el tipo generado declara los FK opcionales como `string` (no captura
      // nullability); la SQL fn `insert_receipt` los acepta NULL. Narrowing
      // acotado al objeto de args para preservar el envío de NULL sin cambiar
      // qué se inserta.
      const insertArgs: Database['public']['Functions']['insert_receipt']['Args'] =
        {
          p_owner_ref: input.ownerRef,
          p_agent_key_id: input.agentKeyId,
          p_session_id: input.sessionId,
          p_delegation_id: input.delegationId,
          p_receipt_type: input.receiptType,
          p_amount_usd:
            typeof input.amountUsd === 'string'
              ? Number(input.amountUsd)
              : input.amountUsd,
          p_chain_id: input.chainId,
          p_tx_hash: input.txHash,
          p_counterparty: input.counterparty,
          p_orchestration_id: input.orchestrationId,
        } as unknown as Database['public']['Functions']['insert_receipt']['Args'];
      const { data, error } = await supabase.rpc('insert_receipt', insertArgs);

      if (error) {
        log.warn({ detail: error.message }, 'emit failed');
        return;
      }

      // El RPC RETURNS TABLE → Supabase devuelve un array de filas.
      const inserted = Array.isArray(data) ? data[0] : data;
      if (!inserted?.id) {
        log.warn('emit failed: no row returned');
        return;
      }

      // 3. Computar el HMAC en Node (el secret NUNCA va a Postgres).
      const canonical = buildCanonicalPayload({
        agent_key_id: input.agentKeyId,
        amount_usd: input.amountUsd,
        chain_id: input.chainId,
        counterparty: input.counterparty,
        created_at: inserted.created_at,
        delegation_id: input.delegationId,
        id: inserted.id,
        orchestration_id: input.orchestrationId,
        owner_ref: input.ownerRef,
        prev_receipt_hash: inserted.prev_receipt_hash ?? null,
        receipt_type: input.receiptType,
        session_id: input.sessionId,
        tx_hash: input.txHash,
      });
      const hash = computeReceiptHash(canonical);
      if (!hash) {
        // Secret desapareció entre el guard y aquí: dejar UNSIGNED (placeholder).
        log.warn('emit: hash unavailable, left unsigned');
        return;
      }

      // UPDATE-once: la columna receipt_hash (+ WKH-234 metadata Solana ADITIVA
      // settle_caip2/settle_signature cuando el leg es Solana), solo si sigue en
      // '' (CD-2). settle_* NO participan del HMAC → firma byte-idéntica para EVM.
      const updatePayload: Database['public']['Tables']['a2a_receipts']['Update'] =
        { receipt_hash: hash };
      if (input.settleCaip2) updatePayload.settle_caip2 = input.settleCaip2;
      if (input.settleSignature)
        updatePayload.settle_signature = input.settleSignature;
      const { error: updErr } = await supabase
        .from('a2a_receipts')
        .update(updatePayload)
        .eq('id', inserted.id)
        .eq('receipt_hash', '');
      if (updErr) {
        log.warn({ detail: updErr.message }, 'emit hash update failed');
      }
    } catch (err) {
      log.warn(
        { detail: err instanceof Error ? err.message : err },
        'emit failed',
      );
    }
  },

  /**
   * Recomputa el hash de un recibo y lo compara con el almacenado (AC-4/AC-5).
   * Ownership Guard: 404 disclosure-safe si el recibo no pertenece al caller
   * (AC-8). NUNCA expone el secret (CD-4); NUNCA throw (CD-A).
   */
  async verify(id: string, ownerRef: string): Promise<VerifyReceiptResult> {
    const row = await this.getById(id, ownerRef);
    if (!row) {
      // Disclosure-safe: el router traduce null → 404 (AC-8). Para mantener
      // el contrato de retorno tipado, devolvemos un valid:false UNSIGNED; el
      // router NO llega aquí para cross-owner (chequea getById antes).
      return { valid: false, receipt_id: id, reason: 'UNSIGNED' };
    }

    if (row.receipt_hash === '') {
      return { valid: false, receipt_id: id, reason: 'UNSIGNED' };
    }

    const computed = computeReceiptHash(
      buildCanonicalPayload({
        agent_key_id: row.agent_key_id,
        amount_usd: row.amount_usd,
        chain_id: row.chain_id,
        counterparty: row.counterparty,
        created_at: row.created_at,
        delegation_id: row.delegation_id,
        id: row.id,
        orchestration_id: row.orchestration_id,
        owner_ref: row.owner_ref,
        prev_receipt_hash: row.prev_receipt_hash,
        receipt_type: row.receipt_type,
        session_id: row.session_id,
        tx_hash: row.tx_hash,
      }),
    );

    if (!computed) {
      return {
        valid: false,
        receipt_id: id,
        reason: 'SIGNING_SECRET_UNAVAILABLE',
      };
    }

    if (hashesEqual(computed, row.receipt_hash)) {
      return {
        valid: true,
        receipt_id: id,
        computed_hash: computed,
        stored_hash: row.receipt_hash,
      };
    }

    return { valid: false, receipt_id: id, tamper_detected: true };
  },

  /**
   * Lista los recibos del owner (AC-7). Ownership Guard OBLIGATORIO
   * (`.eq('owner_ref', ownerRef)`, CD-3). Orden created_at DESC.
   */
  async list(ownerRef: string): Promise<ReceiptListItem[]> {
    const { data, error } = await supabase
      .from('a2a_receipts')
      .select(
        'id, owner_ref, agent_key_id, session_id, delegation_id, receipt_type, amount_usd, chain_id, tx_hash, counterparty, orchestration_id, prev_receipt_hash, receipt_hash, created_at',
      )
      .eq('owner_ref', ownerRef)
      .order('created_at', { ascending: false });

    if (error) throw new Error(`Failed to list receipts: ${error.message}`);
    // M9: narrowing acotado — `amount_usd` es NUMERIC (string en runtime; el
    // tipo generado lo declara `number`).
    return (data as unknown as ReceiptListItem[] | null) ?? [];
  },

  /**
   * Trae un recibo por id, con Ownership Guard (CD-3). `null` = no existe O no es
   * del caller → el router lo traduce a 404 disclosure-safe (AC-8).
   */
  async getById(id: string, ownerRef: string): Promise<ReceiptRow | null> {
    const { data, error } = await supabase
      .from('a2a_receipts')
      .select(
        'id, owner_ref, agent_key_id, session_id, delegation_id, receipt_type, amount_usd, chain_id, tx_hash, counterparty, orchestration_id, prev_receipt_hash, receipt_hash, created_at',
      )
      .eq('id', id)
      .eq('owner_ref', ownerRef)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null; // 0 rows → disclosure-safe null
      throw new Error(`Failed to get receipt: ${error.message}`);
    }
    // M9: narrowing acotado — `amount_usd` es NUMERIC (string en runtime).
    return data as unknown as ReceiptRow;
  },
};
