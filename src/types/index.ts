/**
 * WasiAI A2A Protocol — Types
 */

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
  invokeUrl: string;
  /** Explains that invocation must go through POST /compose or POST /orchestrate on the gateway */
  invocationNote: string;
  verified: boolean;
  status: AgentStatus;
  metadata?: Record<string, unknown>;
  /** Payment spec del agent card (WKH-55). Undefined si el registry no lo expone. */
  payment?: AgentPaymentSpec;
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
}

export interface ComposeResult {
  success: boolean;
  output: unknown;
  steps: StepResult[];
  totalCostUsdc: number;
  totalLatencyMs: number;
  error?: string;
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
