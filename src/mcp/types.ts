/**
 * MCP Server — Types (WKH-MCP-X402)
 *
 * JSON-RPC 2.0 envelope + MCP tool contracts for pay_x402, get_payment_quote,
 * discover_agents, orchestrate. No hallucinated shapes: every interface is
 * derived from the Story File §6 contracts and the JSON-RPC 2.0 spec.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { DiscoveryResult } from '../types/index.js';

// ─── Tool names (union, exhaustive) ─────────────────────────
export type ToolName =
  | 'pay_x402'
  | 'get_payment_quote'
  | 'discover_agents'
  | 'orchestrate';

export const TOOL_NAMES: readonly ToolName[] = [
  'pay_x402',
  'get_payment_quote',
  'discover_agents',
  'orchestrate',
] as const;

// ─── JSON-RPC 2.0 error codes (DT-8) ────────────────────────
export const MCP_ERRORS = {
  PARSE_ERROR: -32700, // AC-15
  INVALID_REQUEST: -32600, // AC-11
  METHOD_NOT_FOUND: -32601, // AC-16
  INVALID_PARAMS: -32602, // schema validation
  TOOL_EXECUTION: -32001, // AC-3 / tool internal error
  UPSTREAM_GATEWAY: -32002, // AC-4
  TOO_MANY_REQUESTS: -32029, // AC-12
} as const;

export type MCPErrorCode = (typeof MCP_ERRORS)[keyof typeof MCP_ERRORS];

// ─── JSON-RPC 2.0 envelope ──────────────────────────────────

export interface MCPRequest {
  jsonrpc: '2.0';
  method: string;
  id: string | number | null;
  params?: unknown;
}

export interface MCPError {
  code: number;
  message: string;
  data?: unknown;
}

export interface MCPResponseSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

export interface MCPResponseError {
  jsonrpc: '2.0';
  id: string | number | null;
  error: MCPError;
}

export type MCPResponse = MCPResponseSuccess | MCPResponseError;

// ─── Tool output envelope (tools/call) ──────────────────────

export interface ToolContent {
  type: 'text';
  text: string;
}

export interface ToolCallResult {
  content: ToolContent[];
  isError: boolean;
}

// ─── Tool execution context ─────────────────────────────────

export interface ToolContext {
  requestId: string;
  /** First 8 chars of the incoming MCP token (CD-3) */
  tokenPrefix: string;
  log: FastifyBaseLogger;
}

// ─── Tool-specific inputs/outputs (§6.3) ────────────────────

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface PayX402Input {
  gatewayUrl: string;
  endpoint: string;
  method?: HttpMethod;
  payload?: unknown;
  headers?: Record<string, string>;
  /** Optional guard: wei string. If gateway asks more than this -> error. */
  maxAmountWei?: string;
}

export interface PayX402Output {
  status: number;
  result: unknown;
  txHash?: string;
  amountPaid?: string;
}

export interface GetPaymentQuoteInput {
  gatewayUrl: string;
  endpoint: string;
}

export interface GetPaymentQuoteOutput {
  required: boolean;
  amount?: string;
  token?: string;
  network?: string;
  description?: string;
}

export interface DiscoverAgentsInput {
  query?: string;
  maxPrice?: number;
  capabilities?: string[];
  limit?: number;
}

export type DiscoverAgentsOutput = DiscoveryResult;

export interface OrchestrateToolInput {
  goal: string;
  budget: number;
  preferCapabilities?: string[];
  maxAgents?: number;
  /** Propagated downstream as header x-a2a-key (AC-10) */
  a2aKey?: string;
}

/**
 * Per-step output exposed by the MCP `orchestrate` tool. Derived from
 * `ComposeResult.steps[i]` (which is `StepResult`), but flattened to a
 * stable client-facing shape: the agent slug + registry, the step output,
 * cost/latency, and optional txHash when the step triggered an x402 payment.
 */
export interface OrchestrateStepOutput {
  agent: string;
  registry: string;
  output: unknown;
  costUsdc: number;
  latencyMs: number;
  txHash?: string;
}

export interface OrchestrateToolOutput {
  orchestrationId: string;
  steps: OrchestrateStepOutput[];
  result: unknown;
  kiteTxHash?: string;
  reasoning: string;
  protocolFeeUsdc: number;
}

// ─── Tool error class (used by tool implementations) ────────
/**
 * Thrown by tool implementations to signal a structured MCP JSON-RPC error.
 * Router catches this and wraps it in the MCPResponseError envelope.
 */
export class MCPToolError extends Error {
  public readonly code: number;
  public readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'MCPToolError';
    this.code = code;
    this.data = data;
  }
}
