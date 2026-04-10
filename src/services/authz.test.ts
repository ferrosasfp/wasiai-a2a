/**
 * Authorization Service Unit Tests — WKH-34
 * Tests: AC-12 (checkScoping)
 * Pure function — no mocks needed.
 */

import { describe, it, expect } from 'vitest'
import { authzService } from './authz.js'
import type { A2AAgentKeyRow, AuthzTarget } from '../types/index.js'

// ── Helpers ─────────────────────────────────────────────────

function makeKeyRow(overrides: Partial<A2AAgentKeyRow> = {}): A2AAgentKeyRow {
  return {
    id: 'key-1',
    owner_ref: 'user-1',
    key_hash: 'hash',
    display_name: null,
    budget: {},
    daily_limit_usd: null,
    daily_spent_usd: '0',
    daily_reset_at: new Date().toISOString(),
    allowed_registries: null,
    allowed_agent_slugs: null,
    allowed_categories: null,
    max_spend_per_call_usd: null,
    is_active: true,
    last_used_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    erc8004_identity: null,
    kite_passport: null,
    agentkit_wallet: null,
    metadata: {},
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────

describe('authzService.checkScoping', () => {
  it('allows when all arrays are null (no restrictions)', () => {
    const key = makeKeyRow()
    const result = authzService.checkScoping(key, { registry: 'kite' })
    expect(result).toEqual({ allowed: true })
  })

  it('allows when all arrays are empty (no restrictions)', () => {
    const key = makeKeyRow({
      allowed_registries: [],
      allowed_agent_slugs: [],
      allowed_categories: [],
    })
    const result = authzService.checkScoping(key, { registry: 'kite' })
    expect(result).toEqual({ allowed: true })
  })

  // --- allowed_registries ---

  it('allows when target registry is in allowed_registries', () => {
    const key = makeKeyRow({ allowed_registries: ['kite', 'morpheus'] })
    const result = authzService.checkScoping(key, { registry: 'kite' })
    expect(result).toEqual({ allowed: true })
  })

  it('denies when target registry is NOT in allowed_registries', () => {
    const key = makeKeyRow({ allowed_registries: ['kite'] })
    const result = authzService.checkScoping(key, { registry: 'morpheus' })
    expect(result).toEqual({ allowed: false, reason: 'SCOPE_DENIED: registry not in allowed list' })
  })

  it('denies when allowed_registries set but target has no registry', () => {
    const key = makeKeyRow({ allowed_registries: ['kite'] })
    const result = authzService.checkScoping(key, {})
    expect(result).toEqual({ allowed: false, reason: 'SCOPE_DENIED: registry not in allowed list' })
  })

  // --- allowed_agent_slugs ---

  it('allows when target agent_slug is in allowed_agent_slugs', () => {
    const key = makeKeyRow({ allowed_agent_slugs: ['agent-1', 'agent-2'] })
    const result = authzService.checkScoping(key, { agent_slug: 'agent-1' })
    expect(result).toEqual({ allowed: true })
  })

  it('denies when target agent_slug is NOT in allowed_agent_slugs', () => {
    const key = makeKeyRow({ allowed_agent_slugs: ['agent-1'] })
    const result = authzService.checkScoping(key, { agent_slug: 'agent-3' })
    expect(result).toEqual({ allowed: false, reason: 'SCOPE_DENIED: agent not in allowed list' })
  })

  // --- allowed_categories ---

  it('allows when target category is in allowed_categories', () => {
    const key = makeKeyRow({ allowed_categories: ['text', 'image'] })
    const result = authzService.checkScoping(key, { category: 'text' })
    expect(result).toEqual({ allowed: true })
  })

  it('denies when target category is NOT in allowed_categories', () => {
    const key = makeKeyRow({ allowed_categories: ['text'] })
    const result = authzService.checkScoping(key, { category: 'audio' })
    expect(result).toEqual({ allowed: false, reason: 'SCOPE_DENIED: category not in allowed list' })
  })

  // --- max_spend_per_call_usd ---

  it('allows when estimated_cost is within max_spend_per_call_usd', () => {
    const key = makeKeyRow({ max_spend_per_call_usd: '5.000000' })
    const result = authzService.checkScoping(key, { estimated_cost_usd: 3.5 })
    expect(result).toEqual({ allowed: true })
  })

  it('allows when estimated_cost equals max_spend_per_call_usd', () => {
    const key = makeKeyRow({ max_spend_per_call_usd: '5.000000' })
    const result = authzService.checkScoping(key, { estimated_cost_usd: 5.0 })
    expect(result).toEqual({ allowed: true })
  })

  it('denies when estimated_cost exceeds max_spend_per_call_usd', () => {
    const key = makeKeyRow({ max_spend_per_call_usd: '5.000000' })
    const result = authzService.checkScoping(key, { estimated_cost_usd: 7.5 })
    expect(result).toEqual({
      allowed: false,
      reason: 'SCOPE_DENIED: estimated cost exceeds per-call limit',
    })
  })

  it('allows when max_spend_per_call_usd set but no estimated_cost in target', () => {
    const key = makeKeyRow({ max_spend_per_call_usd: '5.000000' })
    const result = authzService.checkScoping(key, { registry: 'kite' })
    expect(result).toEqual({ allowed: true })
  })

  // --- Combined checks ---

  it('allows when all scoping rules match', () => {
    const key = makeKeyRow({
      allowed_registries: ['kite'],
      allowed_agent_slugs: ['agent-1'],
      allowed_categories: ['text'],
      max_spend_per_call_usd: '10.000000',
    })
    const target: AuthzTarget = {
      registry: 'kite',
      agent_slug: 'agent-1',
      category: 'text',
      estimated_cost_usd: 5,
    }
    expect(authzService.checkScoping(key, target)).toEqual({ allowed: true })
  })

  it('denies on first failing rule (registries pass, agents fail)', () => {
    const key = makeKeyRow({
      allowed_registries: ['kite'],
      allowed_agent_slugs: ['agent-1'],
    })
    const target: AuthzTarget = {
      registry: 'kite',
      agent_slug: 'agent-99',
    }
    const result = authzService.checkScoping(key, target)
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('agent not in allowed list')
  })
})
