/**
 * WasiAI A2A Protocol - Core Types
 * 
 * These types define the contract for agent discovery, composition,
 * and orchestration across any agent registry.
 */

// ============================================================
// AGENT TYPES
// ============================================================

/**
 * Unique identifier for an agent across registries
 */
export type AgentId = string

/**
 * Agent metadata as returned by a registry
 */
export interface Agent {
  /** Unique identifier */
  id: AgentId
  
  /** Human-readable name */
  name: string
  
  /** URL-friendly identifier */
  slug: string
  
  /** What the agent does */
  description: string
  
  /** Categorized capabilities */
  capabilities: string[]
  
  /** Price per invocation in USDC */
  priceUsdc: number
  
  /** Average response time in milliseconds */
  avgLatencyMs?: number
  
  /** Reputation score (0-100) */
  reputation?: number
  
  /** Input schema (JSON Schema) */
  inputSchema?: Record<string, unknown>
  
  /** Output schema (JSON Schema) */
  outputSchema?: Record<string, unknown>
  
  /** Registry this agent belongs to */
  registry: string
  
  /** Additional registry-specific metadata */
  metadata?: Record<string, unknown>
}

// ============================================================
// DISCOVERY TYPES
// ============================================================

/**
 * Query parameters for agent discovery
 */
export interface DiscoveryQuery {
  /** Search by capability tags */
  capabilities?: string[]
  
  /** Free-text search */
  query?: string
  
  /** Maximum price per call in USDC */
  maxPrice?: number
  
  /** Minimum reputation score (0-100) */
  minReputation?: number
  
  /** Maximum latency in milliseconds */
  maxLatencyMs?: number
  
  /** Limit results */
  limit?: number
  
  /** Filter by registry */
  registry?: string
}

/**
 * Result of a discovery query
 */
export interface DiscoveryResult {
  /** Matching agents */
  agents: Agent[]
  
  /** Total count (may be more than returned) */
  total: number
  
  /** Query that was executed */
  query: DiscoveryQuery
}

// ============================================================
// COMPOSITION TYPES
// ============================================================

/**
 * A single step in a composition pipeline
 */
export interface PipelineStep {
  /** Agent to invoke (id or slug) */
  agent: AgentId | string
  
  /** Input data for this step */
  input: Record<string, unknown>
  
  /** Optional: transform output before passing to next step */
  transform?: (output: unknown) => unknown
  
  /** Optional: condition to skip this step */
  condition?: (context: PipelineContext) => boolean
}

/**
 * Context passed through a pipeline
 */
export interface PipelineContext {
  /** Results from previous steps, indexed by step number */
  results: Record<number, StepResult>
  
  /** Original input to the pipeline */
  originalInput: Record<string, unknown>
  
  /** Total cost so far */
  totalCostUsdc: number
  
  /** Total latency so far */
  totalLatencyMs: number
}

/**
 * Result of a single pipeline step
 */
export interface StepResult {
  /** Agent that was invoked */
  agent: Agent
  
  /** Output from the agent */
  output: unknown
  
  /** Cost of this invocation */
  costUsdc: number
  
  /** Latency of this invocation */
  latencyMs: number
  
  /** On-chain attestation if available */
  attestation?: Attestation
}

/**
 * Options for pipeline composition
 */
export interface ComposeOptions {
  /** Maximum total budget in USDC */
  maxBudget?: number
  
  /** Maximum total latency in milliseconds */
  maxLatencyMs?: number
  
  /** Stop on first error vs continue */
  stopOnError?: boolean
  
  /** Dry run - validate without executing */
  dryRun?: boolean
}

/**
 * Result of a composed pipeline execution
 */
export interface ComposeResult {
  /** Final output from last step */
  output: unknown
  
  /** All step results */
  steps: StepResult[]
  
  /** Total cost */
  totalCostUsdc: number
  
  /** Total latency */
  totalLatencyMs: number
  
  /** Pipeline succeeded */
  success: boolean
  
  /** Error if failed */
  error?: Error
}

// ============================================================
// ORCHESTRATION TYPES
// ============================================================

/**
 * Request for goal-based orchestration
 */
export interface OrchestrateRequest {
  /** Natural language goal */
  goal: string
  
  /** Maximum budget in USDC */
  budget: number
  
  /** Optional context/constraints */
  context?: Record<string, unknown>
  
  /** Preferred capabilities (hints) */
  preferCapabilities?: string[]
  
  /** Maximum number of agents to use */
  maxAgents?: number
}

/**
 * Result of orchestration
 */
export interface OrchestrateResult {
  /** Synthesized answer/output */
  answer: unknown
  
  /** Pipeline that was composed and executed */
  pipeline: ComposeResult
  
  /** Agents that were discovered and considered */
  consideredAgents: Agent[]
  
  /** Reasoning for agent selection (if available) */
  reasoning?: string
}

// ============================================================
// PAYMENT TYPES
// ============================================================

/**
 * Payment authorization for an invocation
 */
export interface PaymentAuth {
  /** Payer address (AA wallet) */
  payerAddress: string
  
  /** Payee address (agent/creator) */
  payeeAddress: string
  
  /** Amount in token units */
  amount: string
  
  /** Token type (e.g., "USDC") */
  tokenType: string
  
  /** Signed x402 payload */
  xPayment: string
}

/**
 * On-chain attestation of an invocation
 */
export interface Attestation {
  /** Transaction hash */
  txHash: string
  
  /** Chain ID */
  chainId: number
  
  /** Block number */
  blockNumber: number
  
  /** Timestamp */
  timestamp: number
  
  /** Agent that was invoked */
  agentId: AgentId
  
  /** Amount paid */
  amountUsdc: number
}

// ============================================================
// ADAPTER INTERFACES
// ============================================================

/**
 * Registry adapter - connects to an agent registry/marketplace
 */
export interface RegistryAdapter {
  /** Unique identifier for this registry */
  readonly name: string
  
  /** Discover agents matching a query */
  discover(query: DiscoveryQuery): Promise<DiscoveryResult>
  
  /** Get a specific agent by ID or slug */
  getAgent(idOrSlug: string): Promise<Agent | null>
  
  /** Invoke an agent with payment */
  invoke(
    agent: Agent,
    input: Record<string, unknown>,
    payment?: PaymentAuth
  ): Promise<StepResult>
}

/**
 * Payment adapter - handles payments and attestations
 */
export interface PaymentAdapter {
  /** Unique identifier for this payment provider */
  readonly name: string
  
  /** Get payer address for the current session */
  getPayerAddress(): Promise<string>
  
  /** Create payment authorization */
  authorize(
    payeeAddress: string,
    amountUsdc: number,
    merchantName?: string
  ): Promise<PaymentAuth>
  
  /** Verify an attestation */
  verifyAttestation(attestation: Attestation): Promise<boolean>
}

// ============================================================
// ERROR TYPES
// ============================================================

export class A2AError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'A2AError'
  }
}

export class DiscoveryError extends A2AError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'DISCOVERY_ERROR', details)
    this.name = 'DiscoveryError'
  }
}

export class InvocationError extends A2AError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'INVOCATION_ERROR', details)
    this.name = 'InvocationError'
  }
}

export class PaymentError extends A2AError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'PAYMENT_ERROR', details)
    this.name = 'PaymentError'
  }
}

export class BudgetExceededError extends A2AError {
  constructor(required: number, available: number) {
    super(
      `Budget exceeded: required ${required} USDC, available ${available} USDC`,
      'BUDGET_EXCEEDED',
      { required, available }
    )
    this.name = 'BudgetExceededError'
  }
}
