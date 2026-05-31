/**
 * Identity Service — A2A Agent Key management
 * WKH-34: Agentic Economy Primitives L3
 */

import crypto from 'node:crypto';
import { supabase } from '../lib/supabase.js';
import type {
  A2AAgentKeyRow,
  AgentCardIdentity,
  AgentSignupResponse,
  CreateKeyInput,
  Erc8004IdentityBinding,
} from '../types/index.js';
import {
  Erc8004TokenAlreadyBoundError,
  FundingWalletAlreadyBoundError,
  logOwnershipMismatch,
  OwnershipMismatchError,
} from './security/errors.js';

// ── ERC-8004 identity helper (WKH-100, AC-6) ─────────────────

/**
 * Derived, pure check: a key has a verified ERC-8004 identity iff its
 * `erc8004_identity` JSONB is non-null (DT-17). No RPC — the on-chain verify
 * already happened at bind-time. Used by the middleware / resolveCallerKey to
 * set the transient `erc8004_verified` flag.
 */
export function isIdentityVerified(
  row: Pick<A2AAgentKeyRow, 'erc8004_identity'>,
): boolean {
  return row.erc8004_identity != null;
}

// ── Service ─────────────────────────────────────────────────

export const identityService = {
  /**
   * Create a new agent key. Returns the plaintext key exactly once.
   * The plaintext is NEVER stored or logged (CD-4).
   */
  async createKey(input: CreateKeyInput): Promise<AgentSignupResponse> {
    // 1. Generate 32 random bytes -> 64 hex chars
    const randomHex = crypto.randomBytes(32).toString('hex');
    const plaintext = `wasi_a2a_${randomHex}`;

    // 2. Compute SHA-256 hash
    const keyHash = crypto.createHash('sha256').update(plaintext).digest('hex');

    // 3. Insert row
    const row: Record<string, unknown> = {
      key_hash: keyHash,
      owner_ref: input.owner_ref,
      display_name: input.display_name ?? null,
      daily_limit_usd: input.daily_limit_usd ?? null,
      allowed_registries: input.allowed_registries ?? null,
      allowed_agent_slugs: input.allowed_agent_slugs ?? null,
      allowed_categories: input.allowed_categories ?? null,
      max_spend_per_call_usd: input.max_spend_per_call_usd ?? null,
    };

    const { data, error } = await supabase
      .from('a2a_agent_keys')
      .insert(row)
      .select('id')
      .single();

    if (error) throw new Error(`Failed to create agent key: ${error.message}`);

    return {
      key: plaintext,
      key_id: (data as { id: string }).id,
    };
  },

  /**
   * Look up an agent key row by its SHA-256 hash.
   */
  async lookupByHash(keyHash: string): Promise<A2AAgentKeyRow | null> {
    const { data, error } = await supabase
      .from('a2a_agent_keys')
      .select('*')
      .eq('key_hash', keyHash)
      .single();

    if (error) {
      // PGRST116 = "no rows found" — not an error, just null
      if (error.code === 'PGRST116') return null;
      throw new Error(`Failed to lookup agent key: ${error.message}`);
    }

    return data as A2AAgentKeyRow;
  },

  /**
   * Deactivate an agent key by setting is_active = false.
   * updated_at is handled by the DB trigger.
   */
  async deactivate(keyId: string, ownerId: string): Promise<void> {
    const { data, error } = await supabase
      .from('a2a_agent_keys')
      .update({ is_active: false })
      .eq('id', keyId)
      .eq('owner_ref', ownerId)
      .select('id');

    if (error)
      throw new Error(`Failed to deactivate agent key: ${error.message}`);

    if (!data || data.length === 0) {
      logOwnershipMismatch('deactivate', keyId, ownerId);
      throw new OwnershipMismatchError();
    }
  },

  /**
   * Bind a funding wallet to a key (WKH-35 FIX-1). The caller proved control
   * of `wallet` (signature verified at the route). Stored lowercase.
   *
   * Ownership Guard (CLAUDE.md): UPDATE filtered by id AND owner_ref so a
   * caller can only bind a wallet to ITS OWN key. If no row matches the
   * (id, owner_ref) pair → OwnershipMismatchError. If `wallet` is already
   * bound to another key, the partial UNIQUE index raises 23505 →
   * FundingWalletAlreadyBoundError. Returns the stored (lowercase) wallet.
   */
  async bindFundingWallet(
    keyId: string,
    ownerId: string,
    wallet: string,
  ): Promise<string> {
    const normalized = wallet.toLowerCase();

    const { data, error } = await supabase
      .from('a2a_agent_keys')
      .update({ funding_wallet: normalized })
      .eq('id', keyId)
      .eq('owner_ref', ownerId)
      .select('id');

    if (error) {
      // Partial UNIQUE(funding_wallet) violation: wallet ya bound a otra key.
      if (error.code === '23505') {
        throw new FundingWalletAlreadyBoundError();
      }
      throw new Error(`Failed to bind funding wallet: ${error.message}`);
    }

    if (!data || data.length === 0) {
      logOwnershipMismatch('deactivate', keyId, ownerId);
      throw new OwnershipMismatchError();
    }

    return normalized;
  },

  /**
   * Bind an on-chain-verified ERC-8004 identity to a key (WKH-100, AC-1).
   *
   * The handler already verified `ownerOf(token_id) == funding_wallet`
   * server-side (CD-7/CD-10) and built the `binding`. Here we only persist the
   * JSONB. Ownership Guard (CLAUDE.md / CD-3): UPDATE filtered by id AND
   * owner_ref so a caller can only bind identity to ITS OWN key; 0 rows →
   * OwnershipMismatchError. This method NEVER touches `budget` /
   * `increment_a2a_key_spend` / `register_a2a_key_deposit` (CD-2/AC-12), and
   * does NOT re-check idempotency (that is the handler's job — DT-8).
   *
   * WKH-100 FIX-PACK (BLQ-MED-1 / DT-21.6): UNICIDAD token↔key activa. Antes de
   * persistir, pre-check app-layer: si OTRA key activa (`id != keyId`) ya tiene
   * el mismo `token_id`+`chain_id` bindeado → `Erc8004TokenAlreadyBoundError`
   * (handler → 409, sin write). El re-bind del MISMO owner sobre su MISMA key
   * (idempotencia AC-5) NO colisiona porque se excluye `id == keyId`. El SELECT
   * del pre-check trae SOLO `id`+`erc8004_identity` — NUNCA budget (CD-2). Si en
   * el futuro se agrega el índice parcial UNIQUE, el `23505` también se mapea a
   * este error (defensa en profundidad, igual que `bindFundingWallet`).
   */
  async bindErc8004Identity(
    keyId: string,
    ownerId: string,
    binding: Erc8004IdentityBinding,
  ): Promise<Erc8004IdentityBinding> {
    // Pre-check de unicidad (DT-21.6): otra key activa con el mismo token+chain.
    const { data: clashing, error: clashErr } = await supabase
      .from('a2a_agent_keys')
      .select('id') // SOLO id — NUNCA budget/funding_wallet (CD-2)
      .eq('is_active', true)
      .neq('id', keyId)
      .eq('erc8004_identity->>token_id', binding.token_id)
      .eq('erc8004_identity->>chain_id', String(binding.chain_id))
      .limit(1);

    if (clashErr)
      throw new Error(
        `Failed to check erc8004 token uniqueness: ${clashErr.message}`,
      );
    if (clashing && clashing.length > 0) {
      throw new Erc8004TokenAlreadyBoundError();
    }

    const { data, error } = await supabase
      .from('a2a_agent_keys')
      .update({ erc8004_identity: binding }) // escribe el JSONB completo; NO toca budget (CD-2)
      .eq('id', keyId)
      .eq('owner_ref', ownerId) // Ownership Guard COMPLETO (CD-3)
      .select('id');

    if (error) {
      // Hardening: partial UNIQUE((token_id),(chain_id)) WHERE is_active → 23505.
      if (error.code === '23505') {
        throw new Erc8004TokenAlreadyBoundError();
      }
      throw new Error(`Failed to bind erc8004 identity: ${error.message}`);
    }

    if (!data || data.length === 0) {
      logOwnershipMismatch('deactivate', keyId, ownerId); // DT-13: reusa label existente
      throw new OwnershipMismatchError();
    }

    return binding;
  },

  /**
   * Reverse-lookup PÚBLICO de identidad por el match BIDIRECCIONAL completo
   * (WKH-100 FIX-PACK v2, MNR-1 / DT-22). SUPERSEDE `resolveIdentityForToken`.
   *
   * El badge `verified:true` exige TRES anclajes simultáneos (ver
   * `AgentCardIdentity` en types/index.ts):
   *   (i)   el AgentCard del agente DECLARA este token (lo provee el caller vía
   *         `extractDeclaredTokenId` en discovery → `tokenId`+`chainId`);
   *   (ii)  ese token está bindeado + `ownerOf`-verificado localmente al
   *         bindear (el verify on-chain ya ocurrió, auth.ts);
   *   (iii) ESE binding DECLARA operar ESTE agente vía
   *         `(agent_registry, agent_slug)` == `(agentRegistry, agentSlug)`,
   *         match case-insensitive + trim.
   * Si falta CUALQUIER anclaje → null (SIN badge). Esto cierra el vector
   * inverso (MNR-1): un atacante que declara el token público de la víctima en
   * su propia card NO obtiene badge porque el binding de la víctima declara
   * operar (regVíctima, slugVíctima), no (regAtacante, slugAtacante).
   *
   * Bindings legacy v1 (sin `agent_registry`/`agent_slug`) → null (default
   * seguro, AC-9). La key NO se degrada.
   *
   * DT-19 / NOTA PARA AR-CR: este SELECT NO lleva `.eq('owner_ref', ...)` **a
   * propósito**. Es lectura PÚBLICA (no por `keyId` del caller) que devuelve
   * SOLO `{ token_id, chain_id, verified }` — datos públicamente verificables
   * on-chain. NUNCA trae `budget` / `funding_wallet` / PII (CD-2). NO es IDOR.
   *
   * MNR-1 (perf): la igualdad por `token_id`+`chain_id` es indexable
   * (uq_a2a_agent_keys_erc8004_token, FPv2.7). Se usa el FALLBACK determinista
   * en JS (independiente del soporte de operadores JSONB `->>` de la versión
   * instalada de PostgREST): traer candidatas activas con identity no-null y
   * cruzar los 4 campos en JS. La page de discover solo invoca esto para
   * agentes con declaración válida (skip si no).
   */
  async resolveIdentityForAgent(
    tokenId: string,
    chainId: number,
    agentRegistry: string,
    agentSlug: string,
  ): Promise<AgentCardIdentity | null> {
    const { data, error } = await supabase
      .from('a2a_agent_keys')
      .select('erc8004_identity') // SOLO esta columna — NUNCA budget (CD-2/DT-19)
      .eq('is_active', true) // solo keys activas surfacean
      .not('erc8004_identity', 'is', null);

    if (error || !data) return null;

    const nReg = agentRegistry.trim().toLowerCase();
    const nSlug = agentSlug.trim().toLowerCase();

    for (const row of data as Array<{
      erc8004_identity: Erc8004IdentityBinding | null;
    }>) {
      const b = row.erc8004_identity;
      if (!b) continue;
      // Lado token/agente: el token DECLARADO por el agente está bindeado.
      if (b.token_id !== tokenId || b.chain_id !== chainId) continue;
      // Lado binder: el binding debe declarar operar ESTE agente. Sin ancla
      // (binding v1) → sin badge (default seguro, AC-9).
      if (!b.agent_registry || !b.agent_slug) continue;
      if (b.agent_registry.trim().toLowerCase() !== nReg) continue;
      if (b.agent_slug.trim().toLowerCase() !== nSlug) continue;
      return {
        erc8004_token_id: b.token_id,
        chain_id: b.chain_id,
        verified: true,
      };
    }
    return null;
  },
};
