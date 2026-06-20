/**
 * Spend Policy Service — WKH-125 (KEY-CONSTRAINTS)
 *
 * CRUD ownership-guarded de las políticas de gasto por destino
 * (`a2a_key_spend_policies`). El owner de una Agent Key fija un cap de gasto
 * acumulado por destino (`"<registry>/<slug>"`) dentro de una ventana
 * (rolling en segundos, o total de por vida).
 *
 * Atomicidad (CD-1): este service NO chequea el cap ni debita. El check del cap
 * + el debit del budget + el INSERT en el ledger viven enteros en el RPC
 * `debit_with_dest_policy` (ver `budget.ts` / migración 20260606000000). Acá solo
 * se persisten/leen/borran las políticas.
 *
 * Ownership Guard (CD-3, WKH-53): TODO acceso a `a2a_key_spend_policies` filtra
 * por `.eq('key_id', keyId).eq('owner_ref', ownerId)` con `ownerId: string`
 * (NUNCA `string | undefined`). El cliente de Supabase usa SERVICE_ROLE (bypassa
 * RLS), por eso el ownership check vive en la capa de aplicación.
 */

import { supabase } from '../lib/supabase.js';
import type {
  A2AAgentKeyRow,
  SpendPolicy,
  SpendPolicyInput,
  SpendPolicyRow,
  SpendPolicyWindowType,
} from '../types/index.js';
import {
  logOwnershipMismatch,
  OwnershipMismatchError,
} from './security/errors.js';

const MAX_USD_RE = /^\d+(\.\d+)?$/;

/** Input semánticamente inválido (destino/ventana); mapea a 400 INVALID_INPUT. */
export class InvalidSpendPolicyInputError extends Error {
  readonly code = 'INVALID_INPUT' as const;
  constructor() {
    super('Invalid spend policy input');
    this.name = 'InvalidSpendPolicyInputError';
  }
}

/**
 * Normaliza un destino `"<registry>/<slug>"` a su forma canónica
 * (`trim().toLowerCase()`). El MISMO normalizador se usa al persistir la política
 * y al derivar el destino en el débito (compose/step-0) para que el destino de
 * la policy y el del ledger coincidan byte a byte. `""` (tras trim) es inválido.
 */
export function normalizeDestination(raw: string): string {
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === '') {
    throw new InvalidSpendPolicyInputError();
  }
  return normalized;
}

/** Subset seguro de un `SpendPolicyRow` para las respuestas de list/PUT. */
function toResponse(row: SpendPolicyRow): SpendPolicy {
  return {
    destination: row.destination,
    max_usd: row.max_usd,
    window_type: row.window_type,
    window_secs: row.window_secs,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Valida el invariante de ventana (CD-6) y devuelve el `window_secs` canónico:
 *   - `total`   ⇒ `window_secs` debe ser `null`/ausente → se persiste `null`.
 *   - `rolling` ⇒ `window_secs` entero `> 0`.
 * Cualquier violación → `InvalidSpendPolicyInputError` (400).
 */
function validateWindow(
  windowType: SpendPolicyWindowType,
  windowSecs: number | null | undefined,
): number | null {
  if (windowType === 'total') {
    if (windowSecs !== null && windowSecs !== undefined) {
      throw new InvalidSpendPolicyInputError();
    }
    return null;
  }
  // rolling
  if (
    windowSecs === null ||
    windowSecs === undefined ||
    !Number.isInteger(windowSecs) ||
    windowSecs <= 0
  ) {
    throw new InvalidSpendPolicyInputError();
  }
  return windowSecs;
}

export const spendPolicyService = {
  normalizeDestination,

  /**
   * Crea o actualiza (upsert por `(key_id, destination)`) una política de gasto
   * por destino para la key del caller. Ownership Guard: `owner_ref`/`key_id` se
   * toman SIEMPRE de `callerKey` (no del input). Valida destino + invariante de
   * ventana (CD-6) ANTES del upsert. Devuelve la política persistida (200).
   */
  async set(
    callerKey: A2AAgentKeyRow,
    input: SpendPolicyInput,
  ): Promise<SpendPolicy> {
    const destination = normalizeDestination(input.destination);

    if (input.window_type !== 'total' && input.window_type !== 'rolling') {
      throw new InvalidSpendPolicyInputError();
    }
    if (typeof input.max_usd !== 'string' || !MAX_USD_RE.test(input.max_usd)) {
      throw new InvalidSpendPolicyInputError();
    }
    const windowSecs = validateWindow(input.window_type, input.window_secs);

    const { data, error } = await supabase
      .from('a2a_key_spend_policies')
      .upsert(
        {
          key_id: callerKey.id,
          owner_ref: callerKey.owner_ref,
          destination,
          max_usd: input.max_usd,
          window_type: input.window_type,
          window_secs: windowSecs,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'key_id,destination' },
      )
      .select(
        'id, key_id, owner_ref, destination, max_usd, window_type, window_secs, created_at, updated_at',
      )
      .single();

    if (error || !data) {
      throw new Error(
        `Failed to set spend policy: ${error?.message ?? 'no row'}`,
      );
    }

    return toResponse(data as SpendPolicyRow);
  },

  /**
   * Lista las políticas activas de una key. Ownership Guard:
   * `.eq('key_id', keyId).eq('owner_ref', ownerId)`.
   */
  async list(keyId: string, ownerId: string): Promise<SpendPolicy[]> {
    const { data, error } = await supabase
      .from('a2a_key_spend_policies')
      .select(
        'id, key_id, owner_ref, destination, max_usd, window_type, window_secs, created_at, updated_at',
      )
      .eq('key_id', keyId)
      .eq('owner_ref', ownerId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to list spend policies: ${error.message}`);
    }

    return ((data ?? []) as SpendPolicyRow[]).map(toResponse);
  },

  /**
   * Borra UNA política por destino. Ownership Guard:
   * `.eq('key_id').eq('owner_ref').eq('destination')` + `.select('id')`.
   * 0 rows → `logOwnershipMismatch` + `OwnershipMismatchError` (disclosure-safe).
   */
  async delete(
    keyId: string,
    ownerId: string,
    destination: string,
  ): Promise<void> {
    const normalized = normalizeDestination(destination);

    const { data, error } = await supabase
      .from('a2a_key_spend_policies')
      .delete()
      .eq('key_id', keyId)
      .eq('owner_ref', ownerId)
      .eq('destination', normalized)
      .select('id');

    if (error) {
      throw new Error(`Failed to delete spend policy: ${error.message}`);
    }

    if (!data || data.length === 0) {
      logOwnershipMismatch({
        op: 'spendPolicyDelete',
        resourceId: `${keyId}/${normalized}`,
        callerOwnerRef: ownerId,
      });
      throw new OwnershipMismatchError();
    }
  },

  /**
   * `true` si la key tiene al menos una política. Ownership Guard.
   * NO se usa en el hot-path del débito (el RPC `debit_with_dest_policy` es
   * self-back-compat: sin política → degrada a `increment_a2a_key_spend`). Se
   * expone para tests/diagnóstico.
   */
  async hasAnyPolicy(keyId: string, ownerId: string): Promise<boolean> {
    const { data, error } = await supabase
      .from('a2a_key_spend_policies')
      .select('id')
      .eq('key_id', keyId)
      .eq('owner_ref', ownerId)
      .limit(1);

    if (error) {
      throw new Error(`Failed to check spend policies: ${error.message}`);
    }

    return (data ?? []).length > 0;
  },
};
