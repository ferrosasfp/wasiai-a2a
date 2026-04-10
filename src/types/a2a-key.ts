// ============================================================
// A2A AGENT KEY TYPES (WKH-34 -- Agentic Economy L3)
// ============================================================

// --- DB Row ---

export interface A2AAgentKeyRow {
  id: string                          // UUID
  owner_ref: string
  key_hash: string
  display_name: string | null
  budget: Record<string, string>      // {"2368": "10.00"}
  daily_limit_usd: string | null      // NUMERIC comes as string from Supabase
  daily_spent_usd: string             // NUMERIC comes as string
  daily_reset_at: string              // ISO timestamp
  allowed_registries: string[] | null
  allowed_agent_slugs: string[] | null
  allowed_categories: string[] | null
  max_spend_per_call_usd: string | null
  is_active: boolean
  last_used_at: string | null
  created_at: string
  updated_at: string
  erc8004_identity: Record<string, unknown> | null
  kite_passport: Record<string, unknown> | null
  agentkit_wallet: Record<string, unknown> | null
  metadata: Record<string, unknown>
}

// --- Service inputs ---

export interface CreateKeyInput {
  owner_ref: string
  display_name?: string
  daily_limit_usd?: number
  allowed_registries?: string[]
  allowed_agent_slugs?: string[]
  allowed_categories?: string[]
  max_spend_per_call_usd?: number
}

export interface DepositInput {
  key_id: string
  chain_id: number
  token: string
  amount: string        // amount string e.g. "10.00"
  tx_hash: string
}

// --- AuthzService ---

export interface AuthzTarget {
  registry?: string
  agent_slug?: string
  category?: string
  estimated_cost_usd?: number
}

export interface AuthzResult {
  allowed: boolean
  reason?: string
}

// --- API response shapes ---

export interface AgentSignupResponse {
  key: string           // plaintext wasi_a2a_xxx (returned once)
  key_id: string        // UUID
}

export interface DepositResponse {
  balance: string
  chain_id: number
}

export interface AgentMeResponse {
  key_id: string
  display_name: string | null
  budget: Record<string, string>
  daily_limit_usd: string | null
  daily_spent_usd: string
  daily_reset_at: string
  scoping: {
    allowed_registries: string[] | null
    allowed_agent_slugs: string[] | null
    allowed_categories: string[] | null
    max_spend_per_call_usd: string | null
  }
  is_active: boolean
  bindings: {
    erc8004_identity: Record<string, unknown> | null
    kite_passport: Record<string, unknown> | null
    agentkit_wallet: Record<string, unknown> | null
  }
  created_at: string
}

// --- Middleware error codes (AC-19) ---

export type A2AKeyErrorCode =
  | 'KEY_INVALID'
  | 'KEY_INACTIVE'
  | 'DAILY_LIMIT'
  | 'INSUFFICIENT_BUDGET'
  | 'SCOPE_DENIED'

export interface A2AKeyError {
  error: string
  code: A2AKeyErrorCode
}
