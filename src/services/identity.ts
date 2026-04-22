/**
 * Identity Service — A2A Agent Key management
 * WKH-34: Agentic Economy Primitives L3
 */

import crypto from 'node:crypto';
import { supabase } from '../lib/supabase.js';
import type {
  A2AAgentKeyRow,
  AgentSignupResponse,
  CreateKeyInput,
} from '../types/index.js';
import {
  OwnershipMismatchError,
  logOwnershipMismatch,
} from './security/errors.js';

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
};
