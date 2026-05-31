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
   */
  async bindErc8004Identity(
    keyId: string,
    ownerId: string,
    binding: Erc8004IdentityBinding,
  ): Promise<Erc8004IdentityBinding> {
    const { data, error } = await supabase
      .from('a2a_agent_keys')
      .update({ erc8004_identity: binding }) // escribe el JSONB completo; NO toca budget (CD-2)
      .eq('id', keyId)
      .eq('owner_ref', ownerId) // Ownership Guard COMPLETO (CD-3)
      .select('id');

    if (error)
      throw new Error(`Failed to bind erc8004 identity: ${error.message}`);

    if (!data || data.length === 0) {
      logOwnershipMismatch('deactivate', keyId, ownerId); // DT-13: reusa label existente
      throw new OwnershipMismatchError();
    }

    return binding;
  },

  /**
   * Reverse-lookup PÚBLICO de identidad por `agent_slug` (WKH-100, AC-8).
   *
   * DT-19 / NOTA PARA AR-CR: este SELECT NO lleva `.eq('owner_ref', ...)` **a
   * propósito**. Es una lectura PÚBLICA por `agent_slug` (no por `keyId` del
   * caller) que devuelve SOLO `{ token_id, chain_id, verified }` — datos
   * públicamente verificables on-chain. NUNCA trae `budget` / `funding_wallet`
   * / PII (CD-2). NO es un IDOR; NO marcar como falso-positivo contra la regla
   * de Ownership Guard de CLAUDE.md.
   *
   * [VERIFY-AT-IMPL] (checklist §0): se usa el FALLBACK en JS documentado en el
   * Story File — traer candidatas activas con identity no-null y filtrar
   * `agent_slug === slug` en JS. Es determinista e independiente del soporte de
   * operadores JSONB `->>` de la versión instalada de PostgREST, y la defensa
   * de shape (`b.agent_slug === slug`) cubre el match.
   */
  async resolveIdentityForSlug(
    slug: string,
  ): Promise<AgentCardIdentity | null> {
    const { data, error } = await supabase
      .from('a2a_agent_keys')
      .select('erc8004_identity') // SOLO esta columna — NUNCA budget (CD-2/DT-19)
      .not('erc8004_identity', 'is', null)
      .eq('is_active', true); // solo keys activas surfacean

    if (error || !data) return null;

    for (const row of data as Array<{
      erc8004_identity: Erc8004IdentityBinding | null;
    }>) {
      const b = row.erc8004_identity;
      if (!b?.agent_slug || b.agent_slug !== slug) continue; // defensa de shape
      return {
        erc8004_token_id: b.token_id,
        chain_id: b.chain_id,
        verified: true,
      };
    }
    return null;
  },
};
