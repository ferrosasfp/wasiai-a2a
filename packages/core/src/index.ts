/**
 * @wasiai/a2a-core
 * 
 * Core interfaces and orchestration logic for WasiAI A2A Protocol
 */

// Main client
export { A2A } from './a2a'
export type { A2AConfig } from './a2a'

// Types
export type {
  // Agent types
  AgentId,
  Agent,
  
  // Discovery
  DiscoveryQuery,
  DiscoveryResult,
  
  // Composition
  PipelineStep,
  PipelineContext,
  StepResult,
  ComposeOptions,
  ComposeResult,
  
  // Orchestration
  OrchestrateRequest,
  OrchestrateResult,
  
  // Payments
  PaymentAuth,
  Attestation,
  
  // Adapters
  RegistryAdapter,
  PaymentAdapter,
} from './types'

// Errors
export {
  A2AError,
  DiscoveryError,
  InvocationError,
  PaymentError,
  BudgetExceededError,
} from './types'
