/**
 * Budget Service — A2A Agent Key budget management
 * WKH-34: Agentic Economy Primitives L3
 */

import { supabase } from '../lib/supabase.js';
import type { A2AAgentKeyRow } from '../types/index.js';
import {
  DepositAlreadyCreditedError,
  logOwnershipMismatch,
  OwnershipMismatchError,
} from './security/errors.js';

// ── Service ─────────────────────────────────────────────────

export const budgetService = {
  /**
   * Get balance for a specific chain. Returns "0" if no entry exists.
   */
  async getBalance(
    keyId: string,
    chainId: number,
    ownerId: string,
  ): Promise<string> {
    const { data, error } = await supabase
      .from('a2a_agent_keys')
      .select('budget')
      .eq('id', keyId)
      .eq('owner_ref', ownerId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        logOwnershipMismatch('getBalance', keyId, ownerId);
        throw new OwnershipMismatchError();
      }
      throw new Error(`Failed to get balance: ${error.message}`);
    }

    const budget = (data as Pick<A2AAgentKeyRow, 'budget'>).budget;
    return budget[chainId.toString()] ?? '0';
  },

  /**
   * Debit budget by calling the Postgres function increment_a2a_key_spend.
   * Returns success/failure with error code parsed from the PG exception.
   */
  async debit(
    keyId: string,
    chainId: number,
    amountUsd: number,
  ): Promise<{ success: boolean; error?: string }> {
    const { error } = await supabase.rpc('increment_a2a_key_spend', {
      p_key_id: keyId,
      p_chain_id: chainId,
      p_amount_usd: amountUsd,
    });

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true };
  },

  /**
   * Register a deposit: atomically increment budget for a chain (WKH-35 v2).
   * Uses Postgres function register_a2a_key_deposit v2 with FOR UPDATE +
   * UNIQUE(chain_id, tx_hash) for atomic anti-replay (CD-2) and a DB-level
   * Ownership Guard (CD-1). The verified `amountUsd` (derived on-chain) is
   * credited, never the caller-declared amount (CD-4 — enforced at call-site).
   * Returns the new balance as a string.
   */
  async registerDeposit(
    keyId: string,
    chainId: number,
    amountUsd: string,
    ownerId: string,
    txHash: string,
    token?: string,
  ): Promise<string> {
    const { data, error } = await supabase.rpc('register_a2a_key_deposit', {
      p_key_id: keyId,
      p_chain_id: chainId,
      p_amount_usd: parseFloat(amountUsd),
      p_owner_ref: ownerId,
      p_tx_hash: txHash,
      p_token: token ?? null,
    });

    if (error) {
      // PG fn v2 mapea condiciones de negocio a RAISE EXCEPTION con prefijos
      // estables; los traducimos a error classes tipadas (CD-2 / CD-1).
      if (error.message.includes('DEPOSIT_ALREADY_CREDITED')) {
        throw new DepositAlreadyCreditedError();
      }
      if (error.message.includes('OWNERSHIP_MISMATCH')) {
        logOwnershipMismatch('getBalance', keyId, ownerId);
        throw new OwnershipMismatchError();
      }
      throw new Error(`Failed to register deposit: ${error.message}`);
    }

    return data as string;
  },
};
