/**
 * WasiAI A2A Protocol — Types
 */

// ============================================================
// REGISTRY TYPES
// ============================================================

export interface RegistryConfig {
  /** Unique identifier */
  id: string
  
  /** Human-readable name */
  name: string
  
  /** Discovery endpoint URL */
  discoveryEndpoint: string
  
  /** Invoke endpoint URL template (use {agentId} or {slug} as placeholder) */
  invokeEndpoint: string
  
  /** Optional: Get single agent endpoint */
  agentEndpoint?: string
  
  /** Schema mapping for API compatibility */
  schema: RegistrySchema
  
  /** Authentication config */
  auth?: RegistryAuth
  
  /** Is this registry active? */
  enabled: boolean
  
  /** When was it registered */
  createdAt: Date
}

export interface RegistrySchema {
  /** How to map discovery params */
  discovery: {
    /** Query param for capabilities/tags */
    capabilityParam?: string
    /** Query param for free text search */
    queryParam?: string
    /** Query param for limit */
    limitParam?: string
    /** Query param for max price */
    maxPriceParam?: string
    /** Path to agents array in response */
    agentsPath?: string
    /** Field mappings for agent object */
    agentMapping?: AgentFieldMapping
  }
  
  /** How to call invoke */
  invoke: {
    method: 'GET' | 'POST'
    /** Field name for input in request body */
    inputField?: string
    /** Path to result in response */
    resultPath?: string
  }
}

export interface AgentFieldMapping {
  id?: string
  name?: string
  slug?: string
  description?: string
  capabilities?: string
  price?: string
  reputation?: string
}

export interface RegistryAuth {
  type: 'header' | 'query' | 'bearer'
  key: string
  value?: string  // If static, otherwise must be provided per-request
}

// ============================================================
// AGENT TYPES
// ============================================================

export interface Agent {
  id: string
  name: string
  slug: string
  description: string
  capabilities: string[]
  priceUsdc: number
  reputation?: number
  registry: string
  invokeUrl: string
  metadata?: Record<string, unknown>
}

// ============================================================
// DISCOVERY TYPES
// ============================================================

export interface DiscoveryQuery {
  capabilities?: string[]
  query?: string
  maxPrice?: number
  minReputation?: number
  limit?: number
  registry?: string  // Filter to specific registry
}

export interface DiscoveryResult {
  agents: Agent[]
  total: number
  registries: string[]
}

// ============================================================
// COMPOSE TYPES
// ============================================================

export interface ComposeStep {
  /** Agent ID or slug */
  agent: string
  /** Registry name (optional, will search all if not specified) */
  registry?: string
  /** Input for this step */
  input: Record<string, unknown>
  /** Use output from previous step */
  passOutput?: boolean
}

export interface ComposeRequest {
  steps: ComposeStep[]
  /** Max budget in USDC */
  maxBudget?: number
}

export interface ComposeResult {
  success: boolean
  output: unknown
  steps: StepResult[]
  totalCostUsdc: number
  totalLatencyMs: number
  error?: string
}

export interface StepResult {
  agent: Agent
  output: unknown
  costUsdc: number
  latencyMs: number
  txHash?: string  // Hash de tx on-chain si hubo pago x402
  /** Cache hit status for schema transform applied after this step */
  cacheHit?: boolean | 'SKIPPED'
  /** Latency of schema transform (ms) */
  transformLatencyMs?: number
}

// ============================================================
// SCHEMA TRANSFORM TYPES (WKH-14)
// ============================================================

/** Result of a maybeTransform call */
export interface TransformResult {
  transformedOutput: unknown
  /** true = cache hit, false = LLM generated, 'SKIPPED' = schemas compatible */
  cacheHit: boolean | 'SKIPPED'
  latencyMs: number
}

/** Row in kite_schema_transforms table */
export interface SchemaTransformEntry {
  id: string
  sourceAgentId: string
  targetAgentId: string
  transformFn: string
  hitCount: number
  createdAt: Date
  updatedAt: Date
}

// ============================================================
// ORCHESTRATE TYPES
// ============================================================

export interface OrchestrateRequest {
  /** Natural language goal */
  goal: string
  /** Max budget in USDC */
  budget: number
  /** Preferred capabilities (hints) */
  preferCapabilities?: string[]
  /** Max agents to use */
  maxAgents?: number
}

export interface OrchestrateResult {
  orchestrationId: string
  answer: unknown
  reasoning: string
  pipeline: ComposeResult
  consideredAgents: Agent[]
  protocolFeeUsdc: number
  attestationTxHash?: string
}

// ============================================================
// PAYMENT TYPES (Kite)
// ============================================================

export interface PaymentConfig {
  /** Agent Passport address */
  passportAddress: string
  /** Network (testnet/mainnet) */
  network: 'kite-testnet' | 'kite-mainnet'
}

export interface PaymentAuth {
  xPayment: string  // Base64 encoded x402 payload
}

// ============================================================
// x402 PROTOCOL TYPES (Kite Testnet)
// ============================================================

/**
 * Payload dentro del array "accepts" de una respuesta 402.
 * Describe el pago que el cliente debe realizar.
 */
export interface X402PaymentPayload {
  scheme: 'gokite-aa'
  network: 'kite-testnet' | 'kite-mainnet'
  /** Monto máximo requerido en wei */
  maxAmountRequired: string
  /** URL del endpoint que requiere pago */
  resource: string
  description: string
  mimeType: string
  outputSchema?: {
    input?: Record<string, unknown>
    output?: Record<string, unknown>
  }
  /** Wallet address del service provider que recibe el pago */
  payTo: string
  maxTimeoutSeconds: number
  /** Contract address del token de pago */
  asset: string
  extra: null | Record<string, unknown>
  merchantName: string
}

/**
 * Body completo de una respuesta HTTP 402 conforme a x402.
 */
export interface X402Response {
  error: string
  accepts: X402PaymentPayload[]
  x402Version: 1
}

/**
 * Payload decodificado del header X-Payment (base64 JSON).
 * Generado por el cliente (Kite MCP / Agent Passport).
 */
export interface X402PaymentRequest {
  authorization: {
    from: string        // Wallet address del pagador
    to: string          // Wallet address del service provider
    value: string       // Monto en wei
    validAfter: string  // Unix timestamp (string) — "0" si inmediato
    validBefore: string // Unix timestamp (string) — deadline de expiración
    nonce: string       // 0x... nonce único para esta autorización
  }
  signature: string     // Firma EIP-712 del pagador
  network?: string      // "kite-testnet" (opcional)
}

/**
 * Request body para POST /v2/verify en Pieverse.
 */
export interface PieverseVerifyRequest {
  authorization: X402PaymentRequest['authorization']
  signature: string
  network: string
}

/**
 * Response de POST /v2/verify en Pieverse.
 */
export interface PieverseVerifyResponse {
  valid: boolean
  error?: string
}

/**
 * Request body para POST /v2/settle en Pieverse.
 */
export interface PieverseSettleRequest {
  authorization: X402PaymentRequest['authorization']
  signature: string
  network: string
}

/**
 * Response de POST /v2/settle en Pieverse.
 */
export interface PieverseSettleResult {
  txHash: string
  success: boolean
  error?: string
}

// ============================================================
// AGENT CARD TYPES (Google A2A Protocol)
// ============================================================

export interface AgentSkill {
  id: string
  name: string
  description: string
}

export interface AgentCard {
  name: string
  description: string
  url: string
  capabilities: {
    streaming: boolean
    pushNotifications: boolean
  }
  skills: AgentSkill[]
  inputModes: string[]
  outputModes: string[]
  authentication: {
    schemes: string[]
  }
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
] as const

export type TaskState = (typeof TASK_STATES)[number]

export const TERMINAL_STATES: readonly TaskState[] = ['completed', 'failed', 'canceled'] as const

export interface Task {
  id: string
  contextId: string | null
  status: TaskState
  messages: unknown[]
  artifacts: unknown[]
  metadata: Record<string, unknown> | null
  createdAt: Date
  updatedAt: Date
}

// ============================================================
// EVENT TYPES (WKH-27 Dashboard)
// ============================================================

export interface A2AEvent {
  id: string
  eventType: string
  agentId: string | null
  agentName: string | null
  registry: string | null
  status: "success" | "failed"
  latencyMs: number | null
  costUsdc: number
  txHash: string | null
  goal: string | null
  metadata: Record<string, unknown>
  createdAt: Date
}

export interface AgentSummary {
  agentId: string
  agentName: string
  registry: string
  invocations: number
  avgLatencyMs: number
  totalCostUsdc: number
}

export interface DashboardStats {
  registriesCount: number
  tasksByStatus: Record<string, number>
  eventsTotal: number
  successRate: number
  totalCostUsdc: number
  avgLatencyMs: number
  agents: AgentSummary[]
}

// ============================================================
// GASLESS TYPES (WKH-29 — EIP-3009)
// ============================================================

export interface GaslessSupportedToken {
  network: 'testnet' | 'mainnet'
  symbol: string                  // "PYUSD"
  address: `0x${string}`          // 0x8E04...2ec9
  decimals: number                // 18
  eip712Name: string              // "PYUSD"
  eip712Version: string           // "1"
  minimumTransferAmount: string   // wei string ("10000000000000000")
}

export interface GaslessTransferRequest {
  from: `0x${string}`
  to: `0x${string}`
  value: string                   // wei
  validAfter: string              // unix seconds (string)
  validBefore: string             // unix seconds (string)
  tokenAddress: `0x${string}`
  nonce: `0x${string}`            // 0x + 32 random bytes
  v: number
  r: `0x${string}`
  s: `0x${string}`
}

export interface GaslessTransferResponse {
  txHash: `0x${string}`
}

export interface GaslessStatus {
  enabled: boolean
  network: 'kite-testnet'
  supportedToken: GaslessSupportedToken | null
  operatorAddress: `0x${string}` | null   // NUNCA private key
}
