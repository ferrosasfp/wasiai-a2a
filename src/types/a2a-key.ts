// ============================================================
// A2A AGENT KEY TYPES (WKH-34 -- Agentic Economy L3)
// ============================================================

// --- ERC-8004 identity binding (WKH-100) ---

/**
 * On-chain-verified ERC-8004 identity bound to an Agent Key (Fase 1, WKH-100).
 * Stored as the `erc8004_identity` JSONB column. Written ONLY after the server
 * verified `ownerOf(token_id) == funding_wallet` on-chain (CD-7/CD-10).
 */
export interface Erc8004IdentityBinding {
  token_id: string; // uint256 serializado como string decimal (sin pérdida — CD-11)
  chain_id: number; // 8453 | 84532
  agent_card_url: string; // tokenURI resuelto; '' si resolve falló al bindear (DT-15)
  owner_address: string; // lowercase (== funding_wallet al momento del bind)
  verified_at: string; // ISO 8601 del verify server-side
  // WKH-100 FIX-PACK v2 (MNR-1 / DT-22): ancla del LADO BINDER del match
  // bidireccional. El owner declara QUÉ agente de discovery opera esta identidad
  // mediante (registry, slug) (= mapAgent: registry.name + slug). El badge
  // `verified:true` surfacea SOLO si el agente A declara este token EN SU CARD
  // (extractDeclaredTokenId) Y este binding declara operar (A.registry, A.slug).
  // `agent_slug` deja de ser hint informativo (DT-21.7) y pasa a ser ancla de
  // trust (ahora sólida porque se cruza con el token on-chain-poseído);
  // `agent_registry` resuelve colisiones de slug entre registries. Match
  // case-insensitive + trim. Van JUNTOS o NINGUNO. Bindings v1 sin estos campos
  // → SIN badge (default seguro, AC-9/CD-9; sin migration de datos).
  agent_registry?: string; // == Agent.registry. Match case-insensitive.
  agent_slug?: string; // == Agent.slug. Match case-insensitive.
}

// --- DB Row ---

export interface A2AAgentKeyRow {
  id: string; // UUID
  owner_ref: string;
  key_hash: string;
  display_name: string | null;
  budget: Record<string, string>; // {"2368": "10.00"}
  daily_limit_usd: string | null; // NUMERIC comes as string from Supabase
  daily_spent_usd: string; // NUMERIC comes as string
  daily_reset_at: string; // ISO timestamp
  allowed_registries: string[] | null;
  allowed_agent_slugs: string[] | null;
  allowed_categories: string[] | null;
  max_spend_per_call_usd: string | null;
  is_active: boolean;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
  erc8004_identity: Erc8004IdentityBinding | null;
  kite_passport: Record<string, unknown> | null;
  agentkit_wallet: Record<string, unknown> | null;
  funding_wallet: string | null; // WKH-35 FIX-1: bound depositor wallet (lowercase)
  metadata: Record<string, unknown>;
  /**
   * WKH-100 (DT-17): transient, in-memory derived flag — NOT a DB column.
   * Set by the middleware / resolveCallerKey from `erc8004_identity != null`.
   */
  erc8004_verified?: boolean;
}

// --- Service inputs ---

export interface CreateKeyInput {
  owner_ref: string;
  display_name?: string;
  daily_limit_usd?: number;
  allowed_registries?: string[];
  allowed_agent_slugs?: string[];
  allowed_categories?: string[];
  max_spend_per_call_usd?: number;
}

export interface DepositInput {
  key_id: string;
  chain_id: number;
  token: string;
  amount: string; // amount string e.g. "10.00"
  tx_hash: string;
}

// --- AuthzService ---

export interface AuthzTarget {
  registry?: string;
  agent_slug?: string;
  category?: string;
  estimated_cost_usd?: number;
}

export interface AuthzResult {
  allowed: boolean;
  reason?: string;
}

// --- API response shapes ---

export interface AgentSignupResponse {
  key: string; // plaintext wasi_a2a_xxx (returned once)
  key_id: string; // UUID
}

export interface DepositResponse {
  balance: string;
  chain_id: number;
}

export interface AgentMeResponse {
  key_id: string;
  display_name: string | null;
  budget: Record<string, string>;
  daily_limit_usd: string | null;
  daily_spent_usd: string;
  daily_reset_at: string;
  scoping: {
    allowed_registries: string[] | null;
    allowed_agent_slugs: string[] | null;
    allowed_categories: string[] | null;
    max_spend_per_call_usd: string | null;
  };
  is_active: boolean;
  bindings: {
    erc8004_identity: Erc8004IdentityBinding | null;
    kite_passport: Record<string, unknown> | null;
    agentkit_wallet: Record<string, unknown> | null;
  };
  created_at: string;
}

// --- Middleware error codes (AC-19) ---

export type A2AKeyErrorCode =
  | 'KEY_INVALID'
  | 'KEY_INACTIVE'
  | 'DAILY_LIMIT'
  | 'INSUFFICIENT_BUDGET'
  | 'SCOPE_DENIED';

export interface A2AKeyError {
  error: string;
  code: A2AKeyErrorCode;
}
