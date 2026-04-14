/**
 * MCP Server — JSON Schemas for tool inputs + tools/list manifest
 *
 * Shapes mirror §6.3 exactly. Schemas are Draft-07 compatible (Ajv strict:false).
 */

import type { ToolName } from './types.js';

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  pay_x402:
    'Execute the client-side x402 payment flow against a payment-gated endpoint: fetch, detect 402, EIP-712 sign via KiteOzonePaymentAdapter, retry with payment-signature header, return the final response.',
  get_payment_quote:
    'Probe an endpoint to determine whether it requires an x402 payment, and if so return the amount/token/network without executing a payment.',
  discover_agents:
    'Search agents across all enabled registries (free-text query, capabilities filter, maxPrice cap, limit). Thin wrapper over the internal discovery service.',
  orchestrate:
    'Goal-based multi-agent orchestration. Plans and executes a pipeline to achieve a goal within a USDC budget, returning the final answer plus reasoning and protocol fee.',
};

// ─── Draft-07 JSON schemas (one per tool) ───────────────────

export const INPUT_SCHEMAS: Record<ToolName, Record<string, unknown>> = {
  pay_x402: {
    type: 'object',
    additionalProperties: false,
    required: ['gatewayUrl', 'endpoint'],
    properties: {
      gatewayUrl: { type: 'string', format: 'uri' },
      endpoint: { type: 'string', minLength: 1 },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'] },
      payload: {},
      headers: {
        type: 'object',
        additionalProperties: { type: 'string' },
      },
      maxAmountWei: { type: 'string', pattern: '^\\d+$' },
    },
  },
  get_payment_quote: {
    type: 'object',
    additionalProperties: false,
    required: ['gatewayUrl', 'endpoint'],
    properties: {
      gatewayUrl: { type: 'string', format: 'uri' },
      endpoint: { type: 'string', minLength: 1 },
    },
  },
  discover_agents: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string' },
      maxPrice: { type: 'number', minimum: 0 },
      capabilities: {
        type: 'array',
        items: { type: 'string' },
      },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
  },
  orchestrate: {
    type: 'object',
    additionalProperties: false,
    required: ['goal', 'budget'],
    properties: {
      goal: { type: 'string', minLength: 1 },
      budget: { type: 'number', exclusiveMinimum: 0 },
      preferCapabilities: {
        type: 'array',
        items: { type: 'string' },
      },
      maxAgents: { type: 'integer', minimum: 1, maximum: 20 },
      a2aKey: { type: 'string', minLength: 1 },
    },
  },
};

// ─── tools/list manifest ─────────────────────────────────────

export interface ToolManifestEntry {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOLS_MANIFEST: ToolManifestEntry[] = (
  ['pay_x402', 'get_payment_quote', 'discover_agents', 'orchestrate'] as const
).map((name) => ({
  name,
  description: TOOL_DESCRIPTIONS[name],
  inputSchema: INPUT_SCHEMAS[name],
}));
