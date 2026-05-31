/**
 * Budget Service — A2A Agent Key budget management
 * WKH-34: Agentic Economy Primitives L3
 */

import { supabase } from '../lib/supabase.js';
import type { A2AAgentKeyRow, DelegationDebitContext } from '../types/index.js';
import { delegationService, exceedsPerTxLimit } from './delegation.js';
import {
  AgentKeyBudgetExhaustedError,
  AgentKeyInactiveError,
  AgentKeyNotFoundError,
  DailyLimitExceededError,
  DelegationExpiredError,
  DelegationNotFoundError,
  DelegationRevokedError,
  DelegationTotalLimitExceededError,
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
   *
   * WKH-101 (DT-11): delegation-aware. Si `delegationContext` está presente, el
   * débito enruta al RPC atómico `debit_delegation_and_parent` (AC-7 per-step +
   * AC-8/AC-9). Cuando es undefined (master key), el camino actual queda intacto
   * (CD-5). El branch per-step (steps 2..N de compose) usa esta firma extendida.
   */
  async debit(
    keyId: string,
    chainId: number,
    amountUsd: number,
    delegationContext?: DelegationDebitContext,
  ): Promise<{ success: boolean; error?: string }> {
    // ── RUTA DELEGACIÓN (DT-11) ──
    if (delegationContext) {
      // AC-7 PER-STEP: per-tx ANTES del RPC (no necesita lock).
      if (exceedsPerTxLimit(delegationContext.maxAmountPerTx, amountUsd)) {
        return { success: false, error: 'DELEGATION_TX_LIMIT_EXCEEDED' };
      }
      // AC-8 + AC-9 ATÓMICO: el RPC chequea+debita total_spent y parent budget.
      try {
        await delegationService.debitDelegationAndParent(
          delegationContext.delegationId,
          delegationContext.ownerRef,
          delegationContext.keyId,
          chainId,
          amountUsd,
        );
        return { success: true };
      } catch (err) {
        // Mapear a { success:false, error:<code> } para que compose corte el
        // pipeline (mismo shape que la ruta master). NO re-lanzar.
        if (err instanceof DelegationTotalLimitExceededError) {
          return { success: false, error: 'DELEGATION_TOTAL_LIMIT_EXCEEDED' };
        }
        if (err instanceof AgentKeyBudgetExhaustedError) {
          return { success: false, error: 'AGENT_KEY_BUDGET_EXHAUSTED' };
        }
        if (err instanceof DelegationRevokedError) {
          return { success: false, error: 'DELEGATION_REVOKED' };
        }
        if (err instanceof DelegationExpiredError) {
          return { success: false, error: 'DELEGATION_EXPIRED' };
        }
        // AR-MNR-1: límites de la parent key bajo delegación → code estable 403.
        if (err instanceof DailyLimitExceededError) {
          return { success: false, error: 'DAILY_LIMIT' };
        }
        if (err instanceof AgentKeyInactiveError) {
          return { success: false, error: 'KEY_INACTIVE' };
        }
        if (err instanceof AgentKeyNotFoundError) {
          return { success: false, error: 'KEY_NOT_FOUND' };
        }
        if (err instanceof DelegationNotFoundError) {
          return { success: false, error: 'DELEGATION_NOT_FOUND' };
        }
        if (err instanceof OwnershipMismatchError) {
          return { success: false, error: 'OWNERSHIP_MISMATCH' };
        }
        // AR-MNR-2: NO propagar `err.message` (mensaje crudo de Postgres) al
        // cliente. Devolver un error_code estable; el detalle va al log server.
        console.error('[budget] delegation debit failed', {
          keyId,
          chainId,
          detail: err instanceof Error ? err.message : 'unknown',
        });
        return { success: false, error: 'DELEGATION_DEBIT_FAILED' };
      }
    }

    // ── RUTA MASTER KEY — INTACTA (camino actual, CD-5) ──
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
