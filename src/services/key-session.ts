/**
 * Key Session Service — WKH-121 (session keys server-side, SIN EIP-712)
 *
 * El owner de una Agent Key (master key) deriva una session key efímera
 * SIN firma EVM ni wallet. Este service:
 *   1. valida que el scope solicitado ⊆ scope del padre (CD-4) ANTES del INSERT,
 *   2. valida TTL (CD-5) y `max_budget_usd` contra el balance del padre (AC-2),
 *   3. emite un token opaco `wasi_a2a_sess_<random>` (persiste SOLO su SHA-256, CD-3),
 *   4. provee lookup hot-path, carga de parent key, listado, y el débito atómico doble.
 *
 * Atomicidad (AC-8): el check+debit de `spent_usd` y del parent budget ocurre
 * DENTRO del RPC `debit_session_and_parent` bajo FOR UPDATE. El service solo
 * invoca `supabase.rpc(...)` y mapea errores por prefijo de mensaje (mismo patrón
 * que delegationService.debitDelegationAndParent). NUNCA propaga el msg crudo de PG.
 */

import crypto from 'node:crypto';
import { getAdaptersBundle } from '../adapters/registry.js';
import { supabase } from '../lib/supabase.js';
import type {
  A2AAgentKeyRow,
  CreateKeySessionInput,
  KeySessionListItem,
  KeySessionResponse,
  KeySessionRow,
  KeySessionStatus,
} from '../types/index.js';
import {
  AgentKeyBudgetExhaustedError,
  AgentKeyInactiveError,
  AgentKeyNotFoundError,
  DailyLimitExceededError,
  logOwnershipMismatch,
  OwnershipMismatchError,
  SessionBudgetExhaustedError,
  SessionExpiredError,
  SessionTokenInvalidError,
} from './security/errors.js';

const KEY_SESSION_TOKEN_PREFIX = 'wasi_a2a_sess_';

const POSITIVE_DECIMAL_RE = /^\d+(\.\d+)?$/;

/** Error de scope/input lanzado por `create`; mapea a 400 en el handler. */
export class ScopeExceedsParentError extends Error {
  readonly code = 'SCOPE_EXCEEDS_PARENT' as const;
  constructor() {
    super('Session scope exceeds parent scope');
    this.name = 'ScopeExceedsParentError';
  }
}

/** Input semánticamente inválido (ttl/budget); mapea a 400 INVALID_INPUT. */
export class InvalidKeySessionInputError extends Error {
  readonly code = 'INVALID_INPUT' as const;
  constructor() {
    super('Invalid key-session input');
    this.name = 'InvalidKeySessionInputError';
  }
}

/**
 * TTL máximo aceptado (CD-5). Lee env con fail-safe: NaN o `<= 0` → default 86400.
 */
function maxTtlSeconds(): number {
  const v = Number(process.env.SESSION_MAX_TTL_SECONDS ?? 86400);
  return Number.isFinite(v) && v > 0 ? v : 86400;
}

/** `true` si `v` es un decimal `> 0` (string canónico, sin signo ni notación). */
function isPositiveDecimalAmount(v: string): boolean {
  if (!POSITIVE_DECIMAL_RE.test(v)) return false;
  return Number.parseFloat(v) > 0;
}

/**
 * Subset check por dimensión (DT-4 / AC-2). `session ⊆ parent`:
 * - parent `null` (sin restricción) → cualquier lista de la sesión es válida.
 * - session `null` (no declara) → válido (hereda la restricción del padre).
 * - ambos lista → todo elemento de la sesión debe estar en el del padre.
 */
function isSubsetOfParent(
  sessionList: string[] | undefined,
  parentList: string[] | null,
): boolean {
  if (sessionList === undefined) return true; // hereda
  if (parentList === null) return true; // padre sin restricción
  return sessionList.every((s) => parentList.includes(s));
}

/**
 * Scope efectivo por dimensión (DT-4): `effective = (session === undefined) ? parent : session`.
 * Se usa al persistir (la sesión no declara → guardamos `null` = hereda del padre).
 */
function effectiveScope(sessionList: string[] | undefined): string[] | null {
  return sessionList === undefined ? null : sessionList;
}

/**
 * Balance del padre para el early-fail guard de creación (AC-2 / DT-4). El
 * `budget` es por-chain (`{"2368":"10.00"}`). Comparamos contra el balance del
 * chain por defecto, salvo que el padre tenga un único chain con fondos: en ese
 * caso ese. Es un guard de salida temprana — la garantía dura del cap por-chain
 * la da el RPC al debitar (`increment_a2a_key_spend`).
 */
function parentAvailableBalance(budget: Record<string, string>): number {
  const funded = Object.entries(budget).filter(
    ([, bal]) => Number.parseFloat(bal) > 0,
  );
  if (funded.length === 1) {
    return Number.parseFloat(funded[0][1]);
  }
  const defaultChainId = getAdaptersBundle()?.chainConfig.chainId;
  if (defaultChainId !== undefined) {
    return Number.parseFloat(budget[defaultChainId.toString()] ?? '0');
  }
  return 0;
}

// ── Service ─────────────────────────────────────────────────────

export const keySessionService = {
  /**
   * Crea la session key (AC-1/AC-2/AC-3). El handler ya autenticó la master key.
   * Valida TTL + max_budget_usd + scope ⊆ padre (CD-4) ANTES del INSERT; genera
   * token opaco + hash; persiste SOLO el hash (CD-3). `owner_ref`/`key_id` salen
   * de parentKey, NUNCA del request.
   */
  async create(
    parentKey: A2AAgentKeyRow,
    input: CreateKeySessionInput,
  ): Promise<KeySessionResponse> {
    // 1. TTL (CD-5/AC-3): entero > 0 y <= SESSION_MAX_TTL_SECONDS.
    if (
      typeof input.ttl_seconds !== 'number' ||
      !Number.isInteger(input.ttl_seconds) ||
      input.ttl_seconds <= 0 ||
      input.ttl_seconds > maxTtlSeconds()
    ) {
      throw new InvalidKeySessionInputError();
    }

    // 2. max_budget_usd (CD-AB-3): decimal > 0.
    if (
      typeof input.max_budget_usd !== 'string' ||
      !isPositiveDecimalAmount(input.max_budget_usd)
    ) {
      throw new InvalidKeySessionInputError();
    }

    // 3. Scope ⊆ padre (CD-4/AC-2). Cada dimensión declarada debe ser subset.
    if (
      !isSubsetOfParent(
        input.allowed_registries,
        parentKey.allowed_registries,
      ) ||
      !isSubsetOfParent(
        input.allowed_agent_slugs,
        parentKey.allowed_agent_slugs,
      ) ||
      !isSubsetOfParent(input.allowed_categories, parentKey.allowed_categories)
    ) {
      throw new ScopeExceedsParentError();
    }

    // 4. max_budget_usd <= balance disponible del padre (AC-2, early-fail).
    if (
      Number.parseFloat(input.max_budget_usd) >
      parentAvailableBalance(parentKey.budget)
    ) {
      throw new ScopeExceedsParentError();
    }

    // 5. expires_at = now + ttl_seconds (server-side, CD-5).
    const expiresAtIso = new Date(
      Date.now() + input.ttl_seconds * 1000,
    ).toISOString();

    // 6. Token opaco + hash (CD-3). Solo el hash se persiste.
    const token = `${KEY_SESSION_TOKEN_PREFIX}${crypto
      .randomBytes(48)
      .toString('hex')}`;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // 7. Scope efectivo persistido (null = hereda restricción del padre, DT-4).
    const allowedRegistries = effectiveScope(input.allowed_registries);
    const allowedAgentSlugs = effectiveScope(input.allowed_agent_slugs);
    const allowedCategories = effectiveScope(input.allowed_categories);

    // 8. INSERT. owner_ref/key_id desde parentKey (NUNCA del request).
    const row: Record<string, unknown> = {
      key_id: parentKey.id,
      owner_ref: parentKey.owner_ref,
      session_token_hash: tokenHash,
      ttl_seconds: input.ttl_seconds,
      expires_at: expiresAtIso,
      max_budget_usd: input.max_budget_usd,
      allowed_registries: allowedRegistries,
      allowed_agent_slugs: allowedAgentSlugs,
      allowed_categories: allowedCategories,
    };

    const { data, error } = await supabase
      .from('a2a_key_sessions')
      .insert(row)
      .select('id')
      .single();

    if (error) {
      throw new Error(`Failed to create key session: ${error.message}`);
    }

    return {
      session_id: (data as { id: string }).id,
      session_token: token, // plano, SOLO acá (nunca se vuelve a exponer)
      expires_at: expiresAtIso,
      scope: {
        max_budget_usd: input.max_budget_usd,
        allowed_registries: allowedRegistries,
        allowed_agent_slugs: allowedAgentSlugs,
        allowed_categories: allowedCategories,
      },
    };
  },

  /**
   * Lookup del hot path por hash del token (AC-4).
   * NOTA PARA AR-CR: NO lleva .eq('owner_ref', ...) a propósito — el caller se
   * autentica CON el token; el owner se deriva del row. ÚNICA fn sin owner gate.
   * NO es IDOR. PGRST116 → null.
   */
  async lookupByTokenHash(hash: string): Promise<KeySessionRow | null> {
    const { data, error } = await supabase
      .from('a2a_key_sessions')
      .select('*')
      .eq('session_token_hash', hash)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw new Error(`Failed to lookup key session: ${error.message}`);
    }

    return data as KeySessionRow;
  },

  /**
   * Carga la parent key del branch de sesión. Lectura interna server-side, sin
   * owner gate (el caller no eligió el key_id — sale del row de la sesión que
   * autenticó con su token). NO es IDOR. PGRST116 → null.
   */
  async getParentKey(keyId: string): Promise<A2AAgentKeyRow | null> {
    const { data, error } = await supabase
      .from('a2a_agent_keys')
      .select('*')
      .eq('id', keyId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw new Error(`Failed to load parent key: ${error.message}`);
    }

    return data as A2AAgentKeyRow;
  },

  /**
   * Listado del owner con status derivado (AC-13). Ownership Guard:
   * .eq('owner_ref', ownerRef).
   */
  async list(ownerRef: string): Promise<KeySessionListItem[]> {
    const { data, error } = await supabase
      .from('a2a_key_sessions')
      .select(
        'id, expires_at, max_budget_usd, spent_usd, revoked_at, allowed_registries, allowed_agent_slugs, allowed_categories',
      )
      .eq('owner_ref', ownerRef)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to list key sessions: ${error.message}`);
    }

    const rows = (data ?? []) as Array<
      Pick<
        KeySessionRow,
        | 'id'
        | 'expires_at'
        | 'max_budget_usd'
        | 'spent_usd'
        | 'revoked_at'
        | 'allowed_registries'
        | 'allowed_agent_slugs'
        | 'allowed_categories'
      >
    >;

    const now = Date.now();
    return rows.map((r) => {
      let status: KeySessionStatus = 'active';
      if (r.revoked_at !== null) {
        status = 'revoked';
      } else if (now >= new Date(r.expires_at).getTime()) {
        status = 'expired';
      }
      return {
        session_id: r.id,
        expires_at: r.expires_at,
        max_budget_usd: r.max_budget_usd,
        spent: r.spent_usd,
        status,
        scope: {
          allowed_registries: r.allowed_registries,
          allowed_agent_slugs: r.allowed_agent_slugs,
          allowed_categories: r.allowed_categories,
        },
      };
    });
  },

  /**
   * Débito atómico doble (AC-8/AC-9). SOLO invoca el RPC; mapea TODOS los
   * prefijos de la cadena (incl. los de `increment_a2a_key_spend`) por prefijo
   * de mensaje (CD-AB-1). Devuelve el nuevo spent_usd. NUNCA propaga el msg crudo.
   */
  async debitSessionAndParent(
    sessionId: string,
    ownerId: string,
    keyId: string,
    chainId: number,
    amountUsd: number,
  ): Promise<string> {
    const { data, error } = await supabase.rpc('debit_session_and_parent', {
      p_session_id: sessionId,
      p_owner_ref: ownerId,
      p_key_id: keyId,
      p_chain_id: chainId,
      p_amount_usd: amountUsd,
    });

    if (error) {
      const msg = error.message;
      // Prefijos del RPC propio.
      if (msg.includes('SESSION_BUDGET_EXHAUSTED')) {
        throw new SessionBudgetExhaustedError();
      }
      if (msg.includes('SESSION_REVOKED')) {
        throw new SessionTokenInvalidError();
      }
      if (msg.includes('SESSION_EXPIRED')) {
        throw new SessionExpiredError();
      }
      if (msg.includes('SESSION_NOT_FOUND')) {
        throw new SessionTokenInvalidError();
      }
      // Prefijos del parent RPC (increment_a2a_key_spend) vía el PERFORM.
      if (msg.includes('INSUFFICIENT_BUDGET')) {
        throw new AgentKeyBudgetExhaustedError();
      }
      if (msg.includes('DAILY_LIMIT')) {
        throw new DailyLimitExceededError();
      }
      if (msg.includes('KEY_INACTIVE')) {
        throw new AgentKeyInactiveError();
      }
      if (msg.includes('KEY_NOT_FOUND')) {
        throw new AgentKeyNotFoundError();
      }
      if (msg.includes('OWNERSHIP_MISMATCH')) {
        logOwnershipMismatch({
          op: 'keySessionRevoke',
          resourceId: sessionId,
          callerOwnerRef: ownerId,
        });
        throw new OwnershipMismatchError();
      }
      // Fallback inesperado: el msg crudo de PG NUNCA llega al cliente.
      throw new Error('SESSION_DEBIT_FAILED');
    }

    return String(data);
  },
};
