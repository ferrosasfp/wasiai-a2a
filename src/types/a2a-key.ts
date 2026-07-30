import type { Database } from './database.types.js';

// ============================================================
// A2A AGENT KEY TYPES (WKH-34 -- Agentic Economy L3)
// ============================================================

// --- M9: DB-row narrowing helpers (audit 2026-06-24) ---
//
// El cliente Supabase ahora está tipado con `Database` (schema real de prod).
// Las columnas NUMERIC se introspectan como `number` en los tipos generados,
// pero PostgREST las DEVUELVE como `string` en runtime (preserva precisión
// decimal sin pérdida float — ver comentarios "NUMERIC comes as string" en los
// Row de dominio). Igualmente, las columnas jsonb se generan como `Json` pero el
// dominio las modela con shapes concretos (DelegationPolicy, budget map, etc.).
//
// Estos helpers concentran esa divergencia legítima en UN solo punto documentado
// por tabla, en vez de un `as DomainRow` ciego repartido por cada call-site. El
// puente `unknown` es deliberado y acotado a la frontera de mapeo: NO cambia qué
// datos fluyen, solo reconcilia el tipo generado con la forma real de runtime.

type DbAgentKeyRow = Database['public']['Tables']['a2a_agent_keys']['Row'];
type DbDelegationRow = Database['public']['Tables']['a2a_delegations']['Row'];
type DbKeySessionRow = Database['public']['Tables']['a2a_key_sessions']['Row'];

/** Narrowing acotado fila a2a_agent_keys → dominio (NUMERIC→string, jsonb→shape). */
export function asAgentKeyRow(row: DbAgentKeyRow): A2AAgentKeyRow {
  return row as unknown as A2AAgentKeyRow;
}

/** Narrowing acotado fila a2a_delegations → dominio (NUMERIC→string, policy jsonb). */
export function asDelegationRow(row: DbDelegationRow): DelegationRow {
  return row as unknown as DelegationRow;
}

/** Narrowing acotado fila a2a_key_sessions → dominio (NUMERIC→string). */
export function asKeySessionRow(row: DbKeySessionRow): KeySessionRow {
  return row as unknown as KeySessionRow;
}

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
  /**
   * WKH-117 (AC-8/AC-9): bound Kite Agent Passport, shape
   * `{ address: string (lowercase 0x..), bound_at: string (ISO) }`.
   * Read-only on every auth/debit path — NEVER an auth signal (CD-4). Written
   * only by `identityService.bindPassport` (ownership-guarded). Type kept as
   * `Record<string, unknown> | null` (no schema-level change).
   */
  kite_passport: Record<string, unknown> | null;
  agentkit_wallet: Record<string, unknown> | null;
  funding_wallet: string | null; // WKH-35 FIX-1: bound depositor wallet (lowercase)
  /**
   * WKH-315: bound Solana depositor pubkey (base58). Se persiste y se compara
   * BYTE-EXACTO — sin `toLowerCase()` en ningún punto (CD-6/AC-8). Bajar a
   * minúsculas una cadena base58 la DESTRUYE: mapea dos pubkeys distintas a la
   * misma, y el índice UNIQUE de Postgres sobre `TEXT` ya es case-sensitive.
   * Columna SEPARADA de `funding_wallet` a propósito: ese contrato es lowercase
   * (declarado en `20260529000001:14`) y un owner tiene que poder bindear las dos.
   *
   * ⚠️ OPCIONAL A PROPOSITO, Y DECLARADO (Story File W0.5). Como propiedad
   * REQUERIDA rompía `tsc` en 33 archivos de test que construyen un
   * `A2AAgentKeyRow` a mano — entre ellos `routes/auth.test.ts`, que CD-1/AC-10
   * exige VERDE Y SIN EDITAR. Entre ensanchar el tipo un poco y editar una de las
   * cuatro suites que son la prueba de no-regresión del camino EVM, se elige lo
   * primero. El riesgo queda acotado y del lado seguro: el único lector en
   * producción es el gate de `POST /auth/deposit`, que fail-closea sobre
   * cualquier valor falsy (`undefined` incluido) con 403 FUNDING_WALLET_NOT_BOUND.
   */
  funding_wallet_solana?: string | null;
  metadata: Record<string, unknown>;
  /**
   * WKH-123: opt-in per-request signature auth (EIP-712, master keys). When
   * `true` the middleware requires a valid `x-a2a-signature` recovering the
   * bound `funding_wallet`. Default `false` = bearer puro (back-compat, CD-1).
   */
  require_signature: boolean;
  /**
   * WKH-100 (DT-17): transient, in-memory derived flag — NOT a DB column.
   * Set by the middleware / resolveCallerKey from `erc8004_identity != null`.
   */
  erc8004_verified?: boolean;
}

// --- Service inputs ---

export interface CreateKeyInput {
  owner_ref: string;
  display_name?: string | undefined;
  daily_limit_usd?: number | undefined;
  allowed_registries?: string[] | undefined;
  allowed_agent_slugs?: string[] | undefined;
  allowed_categories?: string[] | undefined;
  max_spend_per_call_usd?: number | undefined;
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
  registry?: string | undefined;
  agent_slug?: string | undefined;
  category?: string | undefined;
  estimated_cost_usd?: number | undefined;
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

// ============================================================
// DELEGATION (WKH-101 — Fase 2: EIP-712 session keys)
// ============================================================

/** Policy de gasto serializada en el typed-data y en a2a_delegations.policy (JSONB). */
export interface DelegationPolicy {
  max_amount_per_tx: string; // USD decimal, p.ej. "0.50" (string, sin pérdida float — CD-AB-3)
  max_total_amount: string; // USD decimal, p.ej. "100.00"
  expires_at: number; // epoch seconds (uint64)
  allowed_chains: number[]; // uint256[] — lista blanca; VACÍO = sin restricción (DT-3)
  allowed_agent_slugs: string[];
  allowed_registries: string[];
}

/** Mensaje EIP-712 (primaryType = "Delegation"). */
export interface DelegationTypedDataMessage {
  session_key: `0x${string}`;
  policy: DelegationPolicy;
  nonce: `0x${string}`; // bytes32 hex
}

/** Domain EIP-712 sin verifyingContract (NC-3). */
export interface DelegationEip712Domain {
  name: string;
  version: string;
  chainId: number;
}

/** typed-data completo recibido del cliente (auditoría → typed_data_raw). */
export interface DelegationTypedData {
  domain: DelegationEip712Domain;
  types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
  primaryType: string; // debe ser 'Delegation'
  message: DelegationTypedDataMessage;
}

export type DelegationStatus = 'active' | 'expired' | 'revoked';

/** Row de a2a_delegations. */
export interface DelegationRow {
  id: string; // UUID
  key_id: string; // UUID parent key
  owner_ref: string; // desnormalizado (Ownership Guard, CD-2)
  session_key_address: string; // lowercase
  session_token_hash: string; // SHA-256(token)
  policy: DelegationPolicy;
  total_spent: string; // NUMERIC → string desde Supabase
  expires_at: string; // ISO timestamp
  revoked_at: string | null; // null = activa
  typed_data_raw: DelegationTypedData;
  nonce: string; // bytes32 hex
  created_at: string;
}

/** Input del POST /auth/delegation. */
export interface CreateDelegationInput {
  typed_data: DelegationTypedData;
  signature: string;
  session_key_address: string;
  policy: DelegationPolicy;
}

/** Respuesta 201 del POST /auth/delegation (token devuelto UNA vez). */
export interface CreateDelegationResponse {
  delegation_id: string;
  session_token: string; // wasi_a2a_session_<random> — plano, solo en la 201
  expires_at: string;
  policy: DelegationPolicy;
}

/** Item del GET /auth/delegation (sin token, con status derivado). */
export interface DelegationListItem {
  delegation_id: string;
  session_key_address: string;
  policy: DelegationPolicy;
  expires_at: string;
  total_spent: string;
  revoked_at: string | null;
  status: DelegationStatus;
}

/**
 * Contexto compacto de delegación que viaja por la request hasta el débito
 * per-step (DT-11/DT-12). Lo setea el middleware (branch session, W3) en
 * `request.delegationContext`; lo propagan las rutas a compose/orchestrate;
 * lo consume `budgetService.debit` para enrutar al RPC atómico.
 */
export interface DelegationDebitContext {
  delegationId: string; // a2a_delegations.id
  ownerRef: string; // = parentKey.owner_ref (Ownership Guard DB-layer)
  keyId: string; // = parentKey.id (cross-check con la delegación)
  maxAmountPerTx: string; // policy.max_amount_per_tx — AC-7 per-step en budget.debit
}

/** Error codes de delegación (middleware + endpoints). */
export type SessionKeyErrorCode =
  | 'FUNDING_WALLET_NOT_BOUND'
  | 'DELEGATION_SIGNER_MISMATCH'
  | 'DELEGATION_NONCE_REPLAY'
  | 'INVALID_SESSION_TOKEN'
  | 'DELEGATION_REVOKED'
  | 'DELEGATION_EXPIRED'
  | 'DELEGATION_TX_LIMIT_EXCEEDED'
  | 'DELEGATION_TOTAL_LIMIT_EXCEEDED'
  | 'AGENT_KEY_BUDGET_EXHAUSTED'
  | 'DELEGATION_CHAIN_NOT_ALLOWED'
  | 'OWNERSHIP_MISMATCH'
  | 'DELEGATION_NOT_ALLOWED';

// ============================================================
// KEY SESSIONS (WKH-121 — session keys server-side, SIN EIP-712)
// ============================================================

/** Estado derivado de una key session (no es columna; se computa en `list`). */
export type KeySessionStatus = 'active' | 'expired' | 'revoked';

/** Row de a2a_key_sessions. */
export interface KeySessionRow {
  id: string; // UUID
  key_id: string; // UUID parent key
  owner_ref: string; // desnormalizado (Ownership Guard, CD-2)
  session_token_hash: string; // SHA-256(token)
  ttl_seconds: number; // valor solicitado (auditoría)
  expires_at: string; // ISO timestamp (now + ttl_seconds, server-side)
  max_budget_usd: string; // NUMERIC → string desde Supabase
  spent_usd: string; // NUMERIC → string desde Supabase
  allowed_registries: string[] | null; // NULL = hereda restricción del padre
  allowed_agent_slugs: string[] | null; // NULL = hereda restricción del padre
  allowed_categories: string[] | null; // NULL = hereda restricción del padre
  derivation_mode: string; // 'server'
  revoked_at: string | null; // null = activa
  created_at: string;
  /**
   * WKH-123: opt-in per-request signature auth (HMAC-SHA256, session keys).
   * Default `false` = bearer puro (back-compat, CD-1).
   */
  require_signature: boolean;
  /**
   * WKH-123: `SHA-256(signing_secret)` (= la HMAC key). NULL = sin secret
   * (HMAC no disponible). El secret plano NUNCA se persiste (CD-5).
   */
  signing_secret_hash: string | null;
}

/** Input del POST /auth/key-session. */
export interface CreateKeySessionInput {
  ttl_seconds: number; // int > 0 y <= SESSION_MAX_TTL_SECONDS
  max_budget_usd: string; // decimal > 0 (string, sin pérdida float)
  allowed_registries?: string[]; // ausente = hereda restricción del padre
  allowed_agent_slugs?: string[]; // ausente = hereda restricción del padre
  allowed_categories?: string[]; // ausente = hereda restricción del padre
  require_signature?: boolean; // WKH-123: opt-in HMAC; genera signing_secret
  /**
   * WKH-125 (AC-6): override de políticas de gasto por la vida de la sesión.
   * `[TBD-FUTURO]`: el campo se acepta en el tipo pero su semántica de override
   * NO se implementa en este MVP. La herencia automática de las políticas de la
   * parent key vive en el RPC `debit_session_and_parent` (dispatch a
   * `debit_with_dest_policy` cuando hay destino).
   */
  spend_policies?: SpendPolicyInput[];
}

// ============================================================
// SPEND POLICIES (WKH-125 — caps de gasto por destino + ventanas)
// ============================================================

/** Tipo de ventana de una política de gasto por destino. */
export type SpendPolicyWindowType = 'total' | 'rolling';

/**
 * Input del owner para fijar una política (PUT endpoint + override de sesión
 * `[TBD-FUTURO]`). `destination` se normaliza en `spend-policy.ts`.
 */
export interface SpendPolicyInput {
  destination: string; // se normaliza en spend-policy.ts (trim+lowercase)
  max_usd: string; // NUMERIC → string (consistente con budget/amount)
  window_type: SpendPolicyWindowType;
  window_secs?: number | null; // null/ausente para 'total'; >0 para 'rolling'
}

/** Fila tal cual en `a2a_key_spend_policies`. */
export interface SpendPolicyRow {
  id: string;
  key_id: string;
  owner_ref: string;
  destination: string;
  max_usd: string; // NUMERIC → string
  window_type: SpendPolicyWindowType;
  window_secs: number | null;
  created_at: string;
  updated_at: string;
}

/** Shape de respuesta (subset seguro para list/PUT 200). */
export interface SpendPolicy {
  destination: string;
  max_usd: string;
  window_type: SpendPolicyWindowType;
  window_secs: number | null;
  created_at: string;
  updated_at: string;
}

/** Respuesta 201 del POST /auth/key-session (token devuelto UNA vez). */
export interface KeySessionResponse {
  session_id: string;
  session_token: string; // wasi_a2a_sess_<random> — plano, solo en la 201
  expires_at: string;
  scope: {
    max_budget_usd: string;
    allowed_registries: string[] | null;
    allowed_agent_slugs: string[] | null;
    allowed_categories: string[] | null;
  };
  /**
   * WKH-123 (AC-11): plano de 32 bytes hex (64 chars) devuelto UNA SOLA vez
   * cuando la sesión se creó con `require_signature: true`. Nunca aparece en
   * GET/list posteriores. El server persiste SOLO su SHA-256 (CD-5).
   */
  signing_secret?: string;
}

/** Item del GET /auth/key-session (sin token, con status derivado). */
export interface KeySessionListItem {
  session_id: string;
  expires_at: string;
  max_budget_usd: string;
  spent: string; // spent_usd
  status: KeySessionStatus;
  scope: {
    allowed_registries: string[] | null;
    allowed_agent_slugs: string[] | null;
    allowed_categories: string[] | null;
  };
}

/**
 * Contexto compacto de la key session que viaja por la request hasta el débito
 * (CD-2/DT-4). Lo setea el middleware (branch sess, W2) en
 * `request.keySessionContext`; lo propaga budget.debit para enrutar al RPC
 * atómico `debit_session_and_parent`.
 */
export interface KeySessionDebitContext {
  sessionId: string; // a2a_key_sessions.id
  ownerRef: string; // = parentKey.owner_ref (Ownership Guard DB-layer)
  keyId: string; // = parentKey.id (cross-check con la sesión)
}

// ============================================================
// SIGNED AUTH (WKH-123 — per-request signature, opt-in)
// ============================================================

/** Error codes del check de firma (middleware + service). */
export type SignedAuthErrorCode =
  | 'SIGNATURE_REQUIRED'
  | 'SIGNATURE_INVALID'
  | 'NONCE_REPLAY'
  | 'TIMESTAMP_EXPIRED'
  | 'FUNDING_WALLET_NOT_BOUND';

/**
 * Headers de firma extraídos del request (todos opcionales — ausencia =
 * back-compat bearer). El middleware los obtiene con `extractSignedHeaders`.
 */
export interface SignedAuthHeaders {
  signature?: string | undefined; // x-a2a-signature
  nonce?: string | undefined; // x-a2a-nonce
  timestamp?: string | undefined; // x-a2a-timestamp (epoch seconds, string)
}

/**
 * Resultado discriminado del orquestador `verifySignedAuth`. `ok:true` →
 * continuar al debit; `ok:false` → mapear `code` a HTTP en el middleware.
 */
export type SignedAuthResult =
  | { ok: true }
  | { ok: false; code: SignedAuthErrorCode };

/** Row de a2a_signed_auth_nonces (anti-replay, UNIQUE(token_hash, nonce)). */
export interface SignedAuthNonceRow {
  token_hash: string;
  nonce: string;
  expires_at: string; // ISO timestamp (now + ttl)
  created_at: string;
}

/** Domain EIP-712 del request (distinto del de delegación). */
export interface RequestEip712Domain {
  name: string;
  version: string;
  chainId: number;
}

/** Mensaje EIP-712 del request (primaryType = "Request"). */
export interface RequestTypedDataMessage {
  token_hash: `0x${string}`; // bytes32 (`0x${hash}` lowercase)
  method: string;
  path: string;
  nonce: `0x${string}`; // bytes32 hex
  timestamp: bigint; // uint64
}
