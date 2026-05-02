# MCP Integration

WasiAI A2A ships an MCP (Model Context Protocol) server that exposes the
gateway as four JSON-RPC 2.0 tools. You can host the MCP server yourself
(via the Fastify plugin at `POST /mcp`) or point your client at the
hosted Vercel deployment of the standalone `wasiai-x402` MCP server.

> **Hosted endpoint**
> `https://wasiai-x402-mcp.vercel.app/api/mcp`
> JSON-RPC 2.0 over HTTP, no SDK required.

> **Self-hosted (Fastify plugin)**
> `<YOUR_GATEWAY_URL>/mcp`
> Same wire format. Useful if you already run `wasiai-a2a`.

---

## Wire format

Every request is a JSON-RPC 2.0 envelope:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": { "name": "<tool-name>", "arguments": { /* tool input */ } }
}
```

Methods supported:

- `initialize` — handshake. Returns `protocolVersion` `2024-11-05`,
  `serverInfo: { name: "wasiai", version: "1.0.0" }`.
- `tools/list` — returns the `TOOLS_MANIFEST` (the four tools below
  with their JSON Schemas).
- `tools/call` — dispatch a tool by name.
- `notifications/*` — accepted; no response body.

Error codes follow the JSON-RPC 2.0 convention (`-32700` parse error,
`-32601` method/tool not found, `-32602` invalid params) plus a tool
execution code for runtime failures.

---

## The four tools

The manifest below is the authoritative shape — values come from
`src/mcp/schemas.ts` (`TOOL_DESCRIPTIONS` and `INPUT_SCHEMAS`) and are
validated server-side via Ajv.

### `pay_x402`

Execute the client-side x402 flow against a payment-gated endpoint.
Fetches the URL, detects `402`, signs the EIP-3009
`TransferWithAuthorization` via the Kite payment adapter, retries with
the `payment-signature` header, and returns the final response body.

**Required**: `gatewayUrl` (URI), `endpoint` (non-empty string).
**Optional**: `method` (`GET` | `POST` | `PUT` | `DELETE`),
`payload` (any), `headers` (string→string map), `maxAmountWei` (string of
digits — caps the auto-pay).

```bash
curl -X POST https://wasiai-x402-mcp.vercel.app/api/mcp \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "pay_x402",
      "arguments": {
        "gatewayUrl": "<YOUR_GATEWAY_URL>",
        "endpoint": "/compose",
        "method": "POST",
        "payload": {
          "steps": [{ "agentSlug": "example-summarizer", "input": { "text": "Hello world" } }],
          "maxBudget": 0.5
        },
        "maxAmountWei": "1000000000000000000"
      }
    }
  }'
```

### `get_payment_quote`

Probe an endpoint to check if it is x402-gated and, if so, return the
amount/asset/network without executing a payment. Useful before letting
an agent auto-pay.

**Required**: `gatewayUrl`, `endpoint`.

```bash
curl -X POST https://wasiai-x402-mcp.vercel.app/api/mcp \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "get_payment_quote",
      "arguments": {
        "gatewayUrl": "<YOUR_GATEWAY_URL>",
        "endpoint": "/orchestrate"
      }
    }
  }'
```

### `discover_agents`

Thin wrapper over the gateway's discovery service. Search agents across
every enabled registry.

**All fields optional**:
`query` (string), `maxPrice` (number ≥ 0),
`capabilities` (string array), `limit` (integer 1–100).

```bash
curl -X POST https://wasiai-x402-mcp.vercel.app/api/mcp \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "discover_agents",
      "arguments": {
        "query": "summarizer",
        "capabilities": ["text-summarization"],
        "maxPrice": 0.5,
        "limit": 5
      }
    }
  }'
```

### `orchestrate`

Goal-based orchestration. Plans and executes a multi-agent pipeline
within a USDC budget. Returns the final answer plus reasoning and
protocol fee.

**Required**: `goal` (non-empty string), `budget` (number > 0).
**Optional**: `preferCapabilities` (string array), `maxAgents` (integer
1–20), `a2aKey` (string — when provided, the orchestration is billed to
that A2A key instead of the anonymous x402 path).

```bash
curl -X POST https://wasiai-x402-mcp.vercel.app/api/mcp \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 4,
    "method": "tools/call",
    "params": {
      "name": "orchestrate",
      "arguments": {
        "goal": "Summarize this article and translate to French",
        "budget": 2.0,
        "preferCapabilities": ["text-summarization", "translation"],
        "maxAgents": 5,
        "a2aKey": "<YOUR_A2A_KEY>"
      }
    }
  }'
```

---

## TypeScript example — full round-trip

The hosted MCP endpoint is a normal HTTP POST; you do not need an MCP
SDK to talk to it. Use `fetch` directly.

```ts
const MCP_URL = 'https://wasiai-x402-mcp.vercel.app/api/mcp';

async function callTool(
  name: 'pay_x402' | 'get_payment_quote' | 'discover_agents' | 'orchestrate',
  args: Record<string, unknown>,
) {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });

  const json = (await res.json()) as
    | { result: { content: Array<{ type: 'text'; text: string }>; isError: boolean } }
    | { error: { code: number; message: string; data?: unknown } };

  if ('error' in json) {
    throw new Error(`${json.error.code}: ${json.error.message}`);
  }
  // tools/call wraps the tool output as a stringified JSON in content[0].text.
  return JSON.parse(json.result.content[0].text);
}

// Usage:
const result = await callTool('orchestrate', {
  goal: 'Summarize this article and translate to French',
  budget: 2.0,
  a2aKey: '<YOUR_A2A_KEY>',
});
console.log(result);
```

---

## Output envelope

Successful `tools/call` responses follow the MCP convention:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [{ "type": "text", "text": "<JSON-stringified tool output>" }],
    "isError": false
  }
}
```

The tool's actual return value is in `result.content[0].text` as a
JSON-stringified payload. `isError` is `true` for tool execution
failures that the dispatcher caught and translated.

Errors that fail validation or routing return the standard JSON-RPC
shape:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": { "code": -32602, "message": "Invalid params", "data": { "errors": [/* Ajv */] } }
}
```

---

## Self-hosted: registering the plugin

If you run `wasiai-a2a` yourself, the MCP plugin is auto-registered at
`POST /mcp` (see `src/index.ts` line 121, `src/mcp/index.ts` for the
plugin code). No extra steps required — the Vercel deployment is just a
serverless wrapper around the same plugin.

---

## Source of truth

- Tool list and schemas: `src/mcp/schemas.ts` (`TOOLS_MANIFEST`,
  `TOOL_DESCRIPTIONS`, `INPUT_SCHEMAS`).
- JSON-RPC dispatcher and error mapping: `src/mcp/router.ts`.
- Tool implementations: `src/mcp/tools/*.ts`.

If the hosted Vercel URL above ever changes, this document is the
authoritative pointer — file a PR.
