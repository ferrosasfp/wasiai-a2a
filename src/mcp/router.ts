/**
 * MCP Router — JSON-RPC 2.0 dispatcher for tools/list + tools/call.
 *
 * Shape validation, schema validation (Ajv), tool dispatch, error mapping,
 * per-call logging (AC-17) and metrics (AC-18), and DT-10 output envelope.
 */

// Use named imports — Ajv 8 CJS + Node16 ESM project:
// `import Ajv from 'ajv'` resolves to the module namespace at runtime even
// though TS is happy to treat it as the class. Named imports avoid both.
import { Ajv, type ValidateFunction } from 'ajv';
// ajv-formats is CJS with `export default`; under Node16 ESM interop the
// default import may be the function itself (Node ≥ 20) or a namespace that
// carries the function at `.default`. Both cases are handled at runtime.
import addFormatsRaw from 'ajv-formats';
import { incrementMcpToolCall } from './metrics.js';
import { INPUT_SCHEMAS, TOOLS_MANIFEST } from './schemas.js';
import { discoverAgents } from './tools/discover-agents.js';
import { getPaymentQuote } from './tools/get-payment-quote.js';
import { orchestrate as orchestrateTool } from './tools/orchestrate.js';
import { payX402 } from './tools/pay-x402.js';
import {
  type DiscoverAgentsInput,
  type GetPaymentQuoteInput,
  MCP_ERRORS,
  type MCPError,
  type MCPResponse,
  type MCPResponseError,
  MCPToolError,
  type OrchestrateToolInput,
  type PayX402Input,
  TOOL_NAMES,
  type ToolContext,
  type ToolName,
} from './types.js';

// ─── Ajv singleton ──────────────────────────────────────────

function normaliseAddFormats(mod: typeof addFormatsRaw): (ajv: Ajv) => void {
  if (typeof mod === 'function') return mod;
  const wrapped = mod as unknown;
  if (
    wrapped !== null &&
    typeof wrapped === 'object' &&
    'default' in wrapped &&
    typeof (wrapped as { default: unknown }).default === 'function'
  ) {
    return (wrapped as { default: (ajv: Ajv) => void }).default;
  }
  throw new Error('Unable to resolve ajv-formats default export');
}
const addFormats = normaliseAddFormats(addFormatsRaw);

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

const VALIDATORS: Record<ToolName, ValidateFunction> = {
  pay_x402: ajv.compile(INPUT_SCHEMAS.pay_x402),
  get_payment_quote: ajv.compile(INPUT_SCHEMAS.get_payment_quote),
  discover_agents: ajv.compile(INPUT_SCHEMAS.discover_agents),
  orchestrate: ajv.compile(INPUT_SCHEMAS.orchestrate),
};

// ─── Helpers ────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidId(value: unknown): value is string | number | null {
  return (
    value === null || typeof value === 'string' || typeof value === 'number'
  );
}

function isToolName(name: unknown): name is ToolName {
  return (
    typeof name === 'string' && (TOOL_NAMES as readonly string[]).includes(name)
  );
}

function buildError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): MCPResponseError {
  const err: MCPError = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id, error: err };
}

// ─── Dispatch ───────────────────────────────────────────────

/**
 * Validate + route a JSON-RPC 2.0 request. Always returns an MCPResponse;
 * never throws. HTTP status is decided by the caller (200 for every path
 * unless auth/rate-limit already short-circuited).
 */
export async function dispatch(
  req: unknown,
  ctx: ToolContext,
): Promise<MCPResponse> {
  // 1. Envelope validation — AC-15.
  if (!isRecord(req)) {
    return buildError(null, MCP_ERRORS.PARSE_ERROR, 'Parse error');
  }
  const id = isValidId(req.id) ? req.id : null;
  if (
    req.jsonrpc !== '2.0' ||
    typeof req.method !== 'string' ||
    !('id' in req) ||
    !isValidId(req.id)
  ) {
    return buildError(id, MCP_ERRORS.PARSE_ERROR, 'Parse error');
  }

  const method = req.method;

  // 2a. initialize — MCP spec handshake (required by clients like Claude Managed Agent).
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'wasiai', version: '1.0.0' },
      },
    };
  }

  // 2b. notifications/initialized — client acknowledgement, no response body required.
  if (method === 'notifications/initialized') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  // 2c. tools/list — AC-14.
  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: { tools: TOOLS_MANIFEST },
    };
  }

  // 3. tools/call — AC-1..AC-10 + AC-16/AC-17/AC-18.
  if (method === 'tools/call') {
    const params = isRecord(req.params) ? req.params : undefined;
    const rawName = params?.name;
    if (!isToolName(rawName)) {
      return buildError(
        id,
        MCP_ERRORS.METHOD_NOT_FOUND,
        'Method not found',
        typeof rawName === 'string' ? { name: rawName } : undefined,
      );
    }
    const toolName: ToolName = rawName;
    const args = isRecord(params?.arguments) ? params.arguments : {};

    // 3a. Schema validation.
    const validator = VALIDATORS[toolName];
    if (!validator(args)) {
      incrementMcpToolCall(toolName, 'error');
      return buildError(id, MCP_ERRORS.INVALID_PARAMS, 'Invalid params', {
        errors: validator.errors ?? [],
      });
    }

    // 3b. Execute tool with timing + logging + metrics.
    const t0 = Date.now();
    try {
      const output = await executeTool(toolName, args, ctx);
      const durationMs = Date.now() - t0;
      ctx.log.info(
        {
          requestId: ctx.requestId,
          mcpToken: ctx.tokenPrefix,
          tool: toolName,
          durationMs,
          success: true,
        },
        'mcp tool call',
      );
      incrementMcpToolCall(toolName, 'success');
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(output) }],
          isError: false,
        },
      };
    } catch (err) {
      const durationMs = Date.now() - t0;
      ctx.log.info(
        {
          requestId: ctx.requestId,
          mcpToken: ctx.tokenPrefix,
          tool: toolName,
          durationMs,
          success: false,
        },
        'mcp tool call',
      );
      incrementMcpToolCall(toolName, 'error');
      if (err instanceof MCPToolError) {
        return buildError(id, err.code, err.message, err.data);
      }
      const message =
        err instanceof Error ? err.message : 'Tool execution failed';
      return buildError(id, MCP_ERRORS.TOOL_EXECUTION, message);
    }
  }

  // 4. Unknown method — AC-16.
  return buildError(id, MCP_ERRORS.METHOD_NOT_FOUND, 'Method not found');
}

// ─── Tool dispatch table ────────────────────────────────────

/**
 * Coerce Ajv-validated arguments into the tool input shape. Ajv has already
 * verified the shape against INPUT_SCHEMAS[name]; this helper just re-expresses
 * that invariant in TypeScript without `as unknown as` (CD-2).
 */
const HTTP_METHODS: readonly PayX402Input['method'][] = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
];

function toHttpMethod(value: unknown): PayX402Input['method'] | undefined {
  if (typeof value !== 'string') return undefined;
  return (HTTP_METHODS as readonly string[]).includes(value)
    ? (value as PayX402Input['method'])
    : undefined;
}

function toStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function toPayX402Input(args: Record<string, unknown>): PayX402Input {
  return {
    gatewayUrl: String(args.gatewayUrl),
    endpoint: String(args.endpoint),
    method: toHttpMethod(args.method),
    payload: args.payload,
    headers: toStringRecord(args.headers),
    maxAmountWei:
      typeof args.maxAmountWei === 'string' ? args.maxAmountWei : undefined,
  };
}

function toGetPaymentQuoteInput(
  args: Record<string, unknown>,
): GetPaymentQuoteInput {
  return {
    gatewayUrl: String(args.gatewayUrl),
    endpoint: String(args.endpoint),
  };
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === 'string') out.push(v);
  }
  return out;
}

function toDiscoverAgentsInput(
  args: Record<string, unknown>,
): DiscoverAgentsInput {
  return {
    query: typeof args.query === 'string' ? args.query : undefined,
    maxPrice: typeof args.maxPrice === 'number' ? args.maxPrice : undefined,
    capabilities: toStringArray(args.capabilities),
    limit: typeof args.limit === 'number' ? args.limit : undefined,
  };
}

function toOrchestrateInput(
  args: Record<string, unknown>,
): OrchestrateToolInput {
  return {
    goal: String(args.goal),
    budget: Number(args.budget),
    preferCapabilities: toStringArray(args.preferCapabilities),
    maxAgents: typeof args.maxAgents === 'number' ? args.maxAgents : undefined,
    a2aKey: typeof args.a2aKey === 'string' ? args.a2aKey : undefined,
  };
}

async function executeTool(
  name: ToolName,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  switch (name) {
    case 'pay_x402':
      return payX402(toPayX402Input(args), ctx);
    case 'get_payment_quote':
      return getPaymentQuote(toGetPaymentQuoteInput(args), ctx);
    case 'discover_agents':
      return discoverAgents(toDiscoverAgentsInput(args), ctx);
    case 'orchestrate':
      return orchestrateTool(toOrchestrateInput(args), ctx);
  }
}
