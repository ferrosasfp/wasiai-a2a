/**
 * Authorization Service — A2A Agent Key scoping checks
 * WKH-34: Agentic Economy Primitives L3
 *
 * Pure function, no DB access, no async.
 */

import type { A2AAgentKeyRow, AuthzTarget, AuthzResult } from '../types/index.js'

// ── Service ─────────────────────────────────────────────────

export const authzService = {
  /**
   * Check if a target operation is allowed by the key's scoping rules.
   * Pure synchronous function — no DB, no side effects.
   */
  checkScoping(keyRow: A2AAgentKeyRow, target: AuthzTarget): AuthzResult {
    // 1. Check allowed_registries
    if (keyRow.allowed_registries && keyRow.allowed_registries.length > 0) {
      if (!target.registry || !keyRow.allowed_registries.includes(target.registry)) {
        return { allowed: false, reason: 'SCOPE_DENIED: registry not in allowed list' }
      }
    }

    // 2. Check allowed_agent_slugs
    if (keyRow.allowed_agent_slugs && keyRow.allowed_agent_slugs.length > 0) {
      if (!target.agent_slug || !keyRow.allowed_agent_slugs.includes(target.agent_slug)) {
        return { allowed: false, reason: 'SCOPE_DENIED: agent not in allowed list' }
      }
    }

    // 3. Check allowed_categories
    if (keyRow.allowed_categories && keyRow.allowed_categories.length > 0) {
      if (!target.category || !keyRow.allowed_categories.includes(target.category)) {
        return { allowed: false, reason: 'SCOPE_DENIED: category not in allowed list' }
      }
    }

    // 4. Check max_spend_per_call_usd
    if (
      keyRow.max_spend_per_call_usd !== null &&
      target.estimated_cost_usd !== undefined
    ) {
      if (target.estimated_cost_usd > parseFloat(keyRow.max_spend_per_call_usd)) {
        return { allowed: false, reason: 'SCOPE_DENIED: estimated cost exceeds per-call limit' }
      }
    }

    return { allowed: true }
  },
}
