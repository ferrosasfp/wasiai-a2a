/**
 * WasiAI A2A Protocol — Types
 */

// WKH-61: importamos A2AAgentKeyRow del subarchivo para tiparlo en
// ComposeRequest / OrchestrateRequest. El re-export `export * from './a2a-key.js'`
// del bottom mantiene la API pública intacta.
import type { A2AAgentKeyRow, DelegationDebitContext } from './a2a-key.js';

// ============================================================
// REGISTRY TYPES
// ============================================================

export interface RegistryConfig {
  /** Unique identifier */
  id: string;

  /** Human-readable name */
  name: string;

  /** Discovery endpoint URL */
  discoveryEndpoint: string;

  /** Invoke endpoint URL template (use {agentId} or {slug} as placeholder) */
  invokeEndpoint: string;

  /** Optional: Get single agent endpoint */
  agentEndpoint?: string;

  /** Schema mapping for API compatibility */
  schema: RegistrySchema;

  /** Authentication config */
  auth?: RegistryAuth;

  /** Is this registry active? */
  enabled: boolean;

  /** When was it registered */
  createdAt: Date;

  /**
   * Owner identifier (WKH-63 / SEC-REG-1).
   *
   * Default 'system' for canonical entries (e.g. 'wasiai') created by the
   * platform. Service-layer guards (`registryService.update/delete`) treat
   * `owner_ref === 'system'` as immutable (403). For tenant-created entries,
   * holds the caller's `a2a_agent_keys.owner_ref`.
   *
   * Defense-in-depth: enforced in app-layer because Supabase service-role
   * client bypasses RLS. RLS policy tracked in TD-SEC-01.
   */
  ownerRef: string;
}

export interface RegistrySchema {
  /** How to map discovery params */
  discovery: {
    /** Query param for capabilities/tags */
    capabilityParam?: string;
    /** Query param for free text search */
    queryParam?: string;
    /** Query param for limit */
    limitParam?: string;
    /** Query param for max price */
    maxPriceParam?: string;
    /** Path to agents array in response */
    agentsPath?: string;
    /** Field mappings for agent object */
    agentMapping?: AgentFieldMapping;
  };

  /** How to call invoke */
  invoke: {
    method: 'GET' | 'POST';
    /** Field name for input in request body */
    inputField?: string;
    /** Path to result in response */
    resultPath?: string;
  };
}

export type AgentStatus = 'active' | 'inactive' | 'unreachable';

/**
 * Payment specification declared by an agent in its agent card (WKH-55).
 * Pass-through del raw response — no se normaliza chain/method (preservar shape).
 */
export interface AgentPaymentSpec {
  method: string; // e.g. 'x402'
  chain: string; // e.g. 'avalanche'
  contract: `0x${string}`; // payTo on-chain address
  asset?: string; // e.g. 'USDC' (opcional, pass-through)
}

export interface AgentFieldMapping {
  id?: string;
  name?: string;
  slug?: string;
  description?: string;
  capabilities?: string;
  price?: string;
  reputation?: string;
  verified?: string;
  status?: string;
}

export interface RegistryAuth {
  type: 'header' | 'query' | 'bearer';
  key: string;
  value?: string; // If static, otherwise must be provided per-request
}

// ============================================================
// AGENT TYPES
// ============================================================

export interface Agent {
  id: string;
  name: string;
  slug: string;
  description: string;
  capabilities: string[];
  priceUsdc: number;
  reputation?: number;
  registry: string;
  /**
   * WKH-100 FIX v3 (DT-23): PK canónico del registry (`registry.id`, inmutable
   * y único). Ancla del match de identidad ERC-8004 — reemplaza el cruce por
   * `registry` (display name, mutable) que sufría colisión de normalización
   * (BLQ-MED-1). `registry` se mantiene para backward-compat / display.
   */
  registry_id: string;
  invokeUrl: string;
  /** Explains that invocation must go through POST /compose or POST /orchestrate on the gateway */
  invocationNote: string;
  verified: boolean;
  status: AgentStatus;
  metadata?: Record<string, unknown>;
  /** Payment spec del agent card (WKH-55). Undefined si el registry no lo expone. */
  payment?: AgentPaymentSpec;
  /**
   * WKH-100 (AC-8): ERC-8004 verified identity surfaced from the agent's
   * bound Agent Key. Omitted (not null) when the agent has no bound identity
   * (backward-compat — AC-9/CD-9).
   */
  identity?: AgentCardIdentity;
  /** WKH-103 (AC-1): score off-chain computado. Omitido si 0 tasks (CD-9). */
  computedReputation?: AgentReputation;
}

/**
 * WKH-103 (AC-5): score de reputación computado off-chain desde a2a_events
 * (tasks liquidadas: status='success' AND cost_usdc>0, anti-sybil CD-1).
 * Campo NUEVO — NO pisa Agent.reputation (upstream del registry). Surfacing
 * SOLO en /discover (off-chain) y AgentCard (off-chain + on-chain opcional).
 */
export interface AgentReputation {
  /** 0-100 entero, determinista (DT-2). */
  score: number;
  /** COUNT de eventos liquidados (status='success' AND cost_usdc>0). */
  tasks_settled: number;
  /** 0-1, 2 decimales — modulador success/(success+failed) (OBS-1). */
  success_rate: number;
  /** SUM(cost_usdc) liquidado, 6 decimales. */
  total_volume_usdc: number;
  /** AVG(latency_ms) entero — OMITIDO si no hay latency (no null). */
  avg_latency_ms?: number;
  /** 'hybrid' solo si AC-7 incorporó read on-chain OK; si no, 'off-chain'. */
  source: 'off-chain' | 'hybrid';
  /**
   * Valor crudo verificado on-chain (AC-7). Shape [VERIFY-AT-IMPL] contra el
   * repo oficial del ReputationRegistry. OMITIDO si no se leyó on-chain.
   * NO altera `score` en v1 (additive, DT-3.1).
   */
  onchain?: { value: string; chain_id: number };
}

/**
 * WKH-100 (AC-8): ERC-8004 verified identity surfaced in discovery.
 * `verified` is a literal `true` — the field is ONLY ever surfaced when the
 * binding was verified on-chain server-side (anti-spoof — CD-7).
 *
 * WKH-100 FIX-PACK v2 (MNR-1 / DT-22.4) — CONTRATO DEL BADGE. `verified:true`
 * atesta un vínculo BIDIRECCIONAL probado por TRES anclajes simultáneos:
 *   (i)   el AgentCard del agente DECLARA este token (extractDeclaredTokenId);
 *   (ii)  ese token está bindeado a una Agent Key y fue `ownerOf`-verificado
 *         on-chain al bindear (el caller poseía el token);
 *   (iii) ese binding DECLARA operar ESTE agente vía (agent_registry,
 *         agent_slug) (= Agent.registry + Agent.slug, case-insensitive).
 * Si falta CUALQUIER anclaje → SIN badge. Esto cierra tanto el vector clásico
 * (slug spoof) como el inverso (declarar el token público de otro agente).
 * El shape de salida NO cambia: el fix es de mecanismo de resolución.
 */
export interface AgentCardIdentity {
  erc8004_token_id: string; // = token_id del binding
  chain_id: number; // 8453 | 84532
  verified: true; // literal: solo se surfacea si verificado on-chain
}

// ============================================================
// DISCOVERY TYPES
// ============================================================

export interface DiscoveryQuery {
  capabilities?: string[];
  query?: string;
  maxPrice?: number;
  minReputation?: number;
  limit?: number;
  registry?: string; // Filter to specific registry
  verified?: boolean;
  includeInactive?: boolean;
}

export interface DiscoveryResult {
  agents: Agent[];
  total: number;
  registries: string[];
}

// ============================================================
// COMPOSE TYPES
// ============================================================

export interface ComposeStep {
  /** Agent ID or slug */
  agent: string;
  /** Registry name (optional, will search all if not specified) */
  registry?: string;
  /** Input for this step */
  input: Record<string, unknown>;
  /** Use output from previous step */
  passOutput?: boolean;
}

export interface ComposeRequest {
  steps: ComposeStep[];
  /** Max budget in USDC */
  maxBudget?: number;
  /** Propagated to agent invocations as header `x-a2a-key` (WKH-MCP-X402) */
  a2aKey?: string;
  /**
   * WKH-61: row de la a2a_agent_keys del caller, para scoping post-resolve.
   * Cuando está presente, composeService chequea allowed_registries /
   * allowed_agent_slugs / allowed_categories contra el Agent real de cada step.
   * Cuando es undefined (path x402), el check no se ejecuta.
   */
  scopingKeyRow?: A2AAgentKeyRow;
  /**
   * WKH-59 (real-price-debit) DT-D: chainId resuelto por el middleware
   * (request.resolvedChainId). composeService lo usa para debit per-step
   * (steps 2..N) via budgetService.debit. Cuando undefined (path x402 o
   * defensive skip), el debit per-step se omite.
   */
  chainId?: number;
  /**
   * WKH-59 (real-price-debit) BLQ-MED-1 fix: logger opcional para emitir
   * `compose-price.fallback per-step` warn cuando priceUsdc=0/null en
   * steps 2..N (CD-4 fallback honesto). El service NO se acopla a Fastify
   * — se reusa el shape `DownstreamLogger` que ya consume WKH-55. La ruta
   * `/compose` pasa `request.log` (Pino), que es estructuralmente
   * compatible. Cuando undefined → fallback a `console.warn`.
   */
  logger?: DownstreamLogger;
  /**
   * WKH-101 (DT-11): contexto de delegación para el débito per-step (steps 2..N).
   * Cuando está presente, budgetService.debit enruta al RPC atómico
   * debit_delegation_and_parent (AC-7 per-step + AC-8/AC-9). undefined → master
   * key (camino actual increment_a2a_key_spend, CD-5 intacto).
   */
  delegationContext?: DelegationDebitContext;
}

export interface ComposeResult {
  success: boolean;
  output: unknown;
  steps: StepResult[];
  totalCostUsdc: number;
  totalLatencyMs: number;
  error?: string;
  /** WKH-61: discriminator para que el route handler mapee a 403. */
  errorCode?: 'SCOPE_DENIED';
  /** WKH-61: target denegado, para debugging. `category` se omite si el agent no la expone. */
  scopeDeniedTarget?: {
    registry: string;
    agent_slug: string;
    category?: string;
  };
}

export interface StepResult {
  agent: Agent;
  output: unknown;
  costUsdc: number;
  latencyMs: number;
  txHash?: string; // Hash de tx on-chain si hubo pago x402
  /** @deprecated Use bridgeType. Kept for backward-compat (WKH-56 DT-3). */
  cacheHit?: boolean | 'SKIPPED';
  /** Latency of bridge resolution (ms). Includes A2A fast-path or maybeTransform. */
  transformLatencyMs?: number;
  /** Bridge type for the transition step→step+1. WKH-56. */
  bridgeType?: BridgeType;
  /** Hash de la tx downstream Fuji USDC settle (WKH-55) */
  downstreamTxHash?: string;
  /** Block number en Fuji donde se confirmo el downstream settle (WKH-55) */
  downstreamBlockNumber?: number;
  /** Atomic units (string, 6-dec USDC) que se settearon downstream (WKH-55) */
  downstreamSettledAmount?: string;
  /** WKH-57: telemetry del bridge LLM. Presente solo si bridgeType==='LLM'. */
  transformLLM?: LLMBridgeStats;
}

// ============================================================
// SCHEMA TRANSFORM TYPES (WKH-14)
// ============================================================

/**
 * WKH-57: telemetry del path LLM. Presente sii bridgeType==='LLM'.
 *
 * tokensIn/tokensOut son SUMA de attempts cuando hubo retry (retries===1).
 * costUsd se computa con PRICING_USD_PER_M_TOKENS centralizado (CD-6).
 */
export interface LLMBridgeStats {
  /** Modelo Anthropic invocado (string literal del SDK). */
  model: 'claude-haiku-4-5-20251001' | 'claude-sonnet-4-6';
  /** Total tokens de input cobrados por Anthropic (suma de attempts si hubo retry). */
  tokensIn: number;
  /** Total tokens de output cobrados por Anthropic. */
  tokensOut: number;
  /** 0 = first attempt OK; 1 = second attempt OK (retry exitoso). */
  retries: 0 | 1;
  /** Costo USD computado a partir de PRICING_USD_PER_M_TOKENS. */
  costUsd: number;
}

/** Result of a maybeTransform call */
export interface TransformResult {
  transformedOutput: unknown;
  /** @deprecated Use bridgeType. true = cache hit, false = LLM generated, 'SKIPPED' = schemas compatible */
  cacheHit: boolean | 'SKIPPED';
  /**
   * WKH-56: explicit bridge type derived from cache layer used.
   *
   * Optional in W0 to keep the wave standalone-mergeable (CD-9).
   * W1 populates this in every return of `maybeTransform` and downstream
   * consumers (compose.ts) treat it as always present after W1+.
   *
   * WKH-57 NO tightener a required (AB-WKH-56-2).
   */
  bridgeType?: BridgeType; // 'SKIPPED' | 'CACHE_L1' | 'CACHE_L2' | 'LLM'
  latencyMs: number;
  /** WKH-57: telemetry del path LLM. undefined si bridgeType !== 'LLM'. */
  llm?: LLMBridgeStats;
}

/** Row in kite_schema_transforms table */
export interface SchemaTransformEntry {
  id: string;
  sourceAgentId: string;
  targetAgentId: string;
  transformFn: string;
  hitCount: number;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================
// ORCHESTRATE TYPES
// ============================================================

export interface OrchestrateRequest {
  /** Natural language goal */
  goal: string;
  /** Max budget in USDC */
  budget: number;
  /** Preferred capabilities (hints) */
  preferCapabilities?: string[];
  /** Max agents to use */
  maxAgents?: number;
  /** Propagated downstream to compose/invokeAgent as header `x-a2a-key` (WKH-MCP-X402) */
  a2aKey?: string;
  /** WKH-61: row de a2a_agent_keys, propagado a composeService.compose. */
  scopingKeyRow?: A2AAgentKeyRow;
  /** WKH-101 (DT-11): contexto de delegación propagado a composeService.compose. */
  delegationContext?: DelegationDebitContext;
  /**
   * chainId resuelto (request.resolvedChainId), propagado a compose para que el
   * débito per-step de steps 1..N funcione. WKH-102 (DT-1): se propaga SIEMPRE
   * (master y delegación, single-chain semantics — modelo WKH-59), no solo bajo
   * delegación. El guard `i>0` de compose.ts:130 protege el step 0 contra
   * double-charge (CD-1, intacto).
   */
  chainId?: number;
}

export interface OrchestrateResult {
  orchestrationId: string;
  answer: unknown;
  reasoning: string;
  pipeline: ComposeResult;
  consideredAgents: Agent[];
  protocolFeeUsdc: number;
  attestationTxHash?: string;
  /** WKH-44: error string propagado cuando el fee charge best-effort falla. */
  feeChargeError?: string;
  /** WKH-44: tx hash del transfer EIP-712 del protocol fee (si tuvo éxito). */
  feeChargeTxHash?: string;
}

// ============================================================
// DOWNSTREAM PAYMENT LOGGER (WKH-55)
// ============================================================

/**
 * Structural logger interface used by `signAndSettleDownstream` and any
 * caller that wants to plumb a Pino-like logger into the downstream
 * payment flow without taking a hard dependency on Pino itself.
 *
 * Canonical home (TD-WKH-55-4 / CR-MNR-3): defined here in `types/index.ts`
 * and consumed via re-export from `src/lib/downstream-payment.ts` and
 * `src/services/compose.ts` to avoid duplicate definitions.
 */
export interface DownstreamLogger {
  warn: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
}

// ============================================================
// PAYMENT TYPES (chain-agnostic)
// ============================================================

export interface PaymentAuth {
  xPayment: string; // Base64 encoded x402 payload
}

// ============================================================
// x402 PROTOCOL TYPES (Kite Testnet)
// ============================================================

/**
 * Payload dentro del array "accepts" de una respuesta 402.
 * Describe el pago que el cliente debe realizar.
 */
export interface X402PaymentPayload {
  scheme: string;
  network: string;
  /** Monto máximo requerido en wei */
  maxAmountRequired: string;
  /** URL del endpoint que requiere pago */
  resource: string;
  description: string;
  mimeType: string;
  outputSchema?: {
    input?: Record<string, unknown>;
    output?: Record<string, unknown>;
  };
  /** Wallet address del service provider que recibe el pago */
  payTo: string;
  maxTimeoutSeconds: number;
  /** Contract address del token de pago */
  asset: string;
  extra: null | Record<string, unknown>;
  merchantName: string;
}

/**
 * Body completo de una respuesta HTTP 402 conforme a x402.
 */
export interface X402Response {
  error: string;
  accepts: X402PaymentPayload[];
  x402Version: 2;
}

/**
 * Payload decodificado del header X-Payment (base64 JSON).
 * Generado por el cliente (wallet del pagador firmando EIP-712) al responder
 * a un 402 Payment Required. Ver `doc/architecture/CHAIN-ADAPTIVE.md` §L2
 * para cómo cada adapter de cadena verifica este payload.
 */
export interface X402PaymentRequest {
  authorization: {
    from: string; // Wallet address del pagador
    to: string; // Wallet address del service provider
    value: string; // Monto en wei
    validAfter: string; // Unix timestamp (string) — "0" si inmediato
    validBefore: string; // Unix timestamp (string) — deadline de expiración
    nonce: string; // 0x... nonce único para esta autorización
  };
  signature: string; // Firma EIP-712 del pagador
  network?: string; // "kite-testnet" (opcional)
}

// NOTE: Pieverse types used by kite-ozone adapter only. Will move to adapters/kite-ozone/types.ts post-hackathon.

/**
 * Request body para POST /v2/verify en Pieverse (v2 envelope).
 */
export interface PieverseVerifyRequest {
  paymentPayload: {
    x402Version: 2;
    scheme: string;
    network: string;
    payload: {
      authorization: X402PaymentRequest['authorization'];
      signature: string;
    };
  };
  paymentRequirements: {
    x402Version: 2;
    scheme: string;
    network: string;
    maxAmountRequired: string;
    payTo: string;
    asset: string;
    extra: null | Record<string, unknown>;
  };
}

/**
 * Response de POST /v2/verify en Pieverse.
 */
export interface PieverseVerifyResponse {
  valid: boolean;
  error?: string;
}

/**
 * Request body para POST /v2/settle en Pieverse (v2 envelope).
 */
export interface PieverseSettleRequest {
  paymentPayload: {
    x402Version: 2;
    scheme: string;
    network: string;
    payload: {
      authorization: X402PaymentRequest['authorization'];
      signature: string;
    };
  };
  paymentRequirements: {
    x402Version: 2;
    scheme: string;
    network: string;
    maxAmountRequired: string;
    payTo: string;
    asset: string;
    extra: null | Record<string, unknown>;
  };
}

/**
 * Response de POST /v2/settle en Pieverse.
 */
export interface PieverseSettleResult {
  txHash: string;
  success: boolean;
  error?: string;
}

// ============================================================
// AGENT CARD TYPES (Google A2A Protocol)
// ============================================================

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
}

export interface AgentCard {
  name: string;
  description: string;
  url: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    /** WKH-56: agent natively speaks Google A2A v1 (Message{role,parts}). */
    a2aCompliant?: boolean;
  };
  skills: AgentSkill[];
  inputModes: string[];
  outputModes: string[];
  authentication: {
    schemes: string[];
  };
  /** Explains that agent invocations must go through POST /compose or POST /orchestrate on the gateway */
  invocationNote?: string;
  /**
   * WKH-106 (BASE-03): JSON Schema describing the agent's input shape.
   * Surfaced ONLY when `agent.metadata.discoverable === true` (CD-1 opt-in).
   * Non-breaking extension — consumers that don't understand the field MUST
   * ignore it (DT-6).
   *
   * Validated at build-time via `declareDiscoveryExtension` from
   * `@x402/extensions/bazaar` + AJV `ajv.compile()` for syntactic JSON
   * Schema correctness. If validation fails, the route handler MUST return
   * HTTP 422 (CD-7).
   */
  inputSchema?: Record<string, unknown>;
  /**
   * WKH-106 (BASE-03): JSON Schema describing the agent's output shape.
   * Same opt-in semantics and validation rules as `inputSchema`.
   */
  outputSchema?: Record<string, unknown>;
  /**
   * WKH-100 (AC-8): ERC-8004 verified identity. Surfaced ONLY when the agent
   * has a bound, on-chain-verified Agent Key identity. Non-breaking optional
   * extension — consumers that don't understand it MUST ignore it (DT-6).
   */
  identity?: AgentCardIdentity;
  /** WKH-103 (AC-5): reputación computada. Non-breaking optional extension. */
  computedReputation?: AgentReputation;
}

// ============================================================
// TASK TYPES (Google A2A Protocol)
// ============================================================

export const TASK_STATES = [
  'submitted',
  'working',
  'completed',
  'failed',
  'canceled',
  'input-required',
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_STATES: readonly TaskState[] = [
  'completed',
  'failed',
  'canceled',
] as const;

export interface Task {
  id: string;
  contextId: string | null;
  status: TaskState;
  messages: unknown[];
  artifacts: unknown[];
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================
// EVENT TYPES (WKH-27 Dashboard)
// ============================================================

export interface A2AEvent {
  id: string;
  eventType: string;
  agentId: string | null;
  agentName: string | null;
  registry: string | null;
  status: 'success' | 'failed';
  latencyMs: number | null;
  costUsdc: number;
  txHash: string | null;
  goal: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface AgentSummary {
  agentId: string;
  agentName: string;
  registry: string;
  invocations: number;
  avgLatencyMs: number;
  totalCostUsdc: number;
}

export interface DashboardStats {
  registriesCount: number;
  tasksByStatus: Record<string, number>;
  eventsTotal: number;
  successRate: number;
  totalCostUsdc: number;
  avgLatencyMs: number;
  agents: AgentSummary[];
}

// ============================================================
// GASLESS TYPES (WKH-29 — EIP-3009)
// ============================================================

export interface GaslessSupportedToken {
  network: 'testnet' | 'mainnet';
  symbol: string; // "PYUSD"
  address: `0x${string}`; // 0x8E04...2ec9
  decimals: number; // 18
  eip712Name: string; // "PYUSD"
  eip712Version: string; // "1"
  minimumTransferAmount: string; // wei string ("10000000000000000")
}

export interface GaslessTransferRequest {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string; // wei
  validAfter: string; // unix seconds (string)
  validBefore: string; // unix seconds (string)
  tokenAddress: `0x${string}`;
  nonce: `0x${string}`; // 0x + 32 random bytes
  v: number;
  r: `0x${string}`;
  s: `0x${string}`;
}

export interface GaslessTransferResponse {
  txHash: `0x${string}`;
}

export type GaslessFundingState =
  | 'disabled'
  | 'unconfigured'
  | 'unfunded'
  | 'ready';

export interface GaslessStatus {
  enabled: boolean;
  network: string;
  supportedToken: GaslessSupportedToken | null;
  operatorAddress: `0x${string}` | null; // NUNCA private key
  /** Degradation state: disabled | unconfigured | unfunded | ready (WKH-38) */
  funding_state: GaslessFundingState;
  /** Chain ID for the gasless network */
  chain_id?: number;
  /** Gasless relayer base URL */
  relayer?: string;
  /** Documentation link */
  documentation?: string;
}

// ============================================================
// A2A PROTOCOL TYPES (Google A2A v1 — WKH-56)
// ============================================================

/** Discriminated union por kind. Google A2A v1. */
export type A2APart = A2ATextPart | A2ADataPart | A2AFilePart;

export interface A2ATextPart {
  kind: 'text';
  text: string;
}

export interface A2ADataPart {
  kind: 'data';
  data: unknown;
}

export interface A2AFilePart {
  kind: 'file';
  file: {
    name?: string;
    mimeType?: string;
    bytes?: string; // base64
    uri?: string;
  };
}

export interface A2AMessage {
  /** Optional client-side correlator. NO se valida en isA2AMessage. */
  messageId?: string;
  role: 'agent' | 'user' | 'tool';
  parts: A2APart[]; // non-empty (validado en isA2AMessage)
}

// ============================================================
// BRIDGE TYPES (WKH-56)
// ============================================================

export type BridgeType =
  | 'A2A_PASSTHROUGH'
  | 'SKIPPED'
  | 'CACHE_L1'
  | 'CACHE_L2'
  | 'LLM';

// ============================================================
// A2A AGENT KEY TYPES (WKH-34)
// ============================================================

export * from './a2a-key.js';
