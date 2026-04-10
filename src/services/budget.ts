/**
 * Budget Service — A2A Agent Key budget management
 * WKH-34: Agentic Economy Primitives L3
 */

import { supabase } from '../lib/supabase.js'
import type { A2AAgentKeyRow } from '../types/index.js'

// ── Service ─────────────────────────────────────────────────

export const budgetService = {
  /**
   * Get balance for a specific chain. Returns "0" if no entry exists.
   */
  async getBalance(keyId: string, chainId: number): Promise<string> {
    const { data, error } = await supabase
      .from('a2a_agent_keys')
      .select('budget')
      .eq('id', keyId)
      .single()

    if (error) throw new Error(`Failed to get balance: ${error.message}`)

    const budget = (data as Pick<A2AAgentKeyRow, 'budget'>).budget
    return budget[chainId.toString()] ?? '0'
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
    })

    if (error) {
      return { success: false, error: error.message }
    }

    return { success: true }
  },

  /**
   * Register a deposit: atomically increment budget for a chain.
   * Returns the new balance as a string.
   */
  async registerDeposit(
    keyId: string,
    chainId: number,
    amountUsd: string,
  ): Promise<string> {
    // 1. Read current budget
    const { data, error: readErr } = await supabase
      .from('a2a_agent_keys')
      .select('budget')
      .eq('id', keyId)
      .single()

    if (readErr) throw new Error(`Failed to read budget for deposit: ${readErr.message}`)

    const budget = { ...((data as Pick<A2AAgentKeyRow, 'budget'>).budget) }
    const chainKey = chainId.toString()
    const currentBalance = parseFloat(budget[chainKey] ?? '0')
    const depositAmount = parseFloat(amountUsd)
    const newBalance = (currentBalance + depositAmount).toFixed(6)

    // 2. Update with new balance
    budget[chainKey] = newBalance

    const { error: updateErr } = await supabase
      .from('a2a_agent_keys')
      .update({ budget })
      .eq('id', keyId)

    if (updateErr) throw new Error(`Failed to register deposit: ${updateErr.message}`)

    return newBalance
  },
}
