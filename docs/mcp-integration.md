# MCP Integration

WasiAI A2A exposes the gateway as MCP (Model Context Protocol) tools through
**two independent surfaces**. They share the same wire format (JSON-RPC 2.0)
but ship **different tool sets, different schemas and different auth
requirements**. Pick the one that matches your topology — do not assume the
two are interchangeable.

| Surface | Where it lives | Tools | Auth | Source of truth |
|---------|----------------|-------|------|-----------------|
| **Self-hosted Fastify plugin** | `POST /mcp` on the wasiai-a2a service you run | 4 (`pay_x402`, `get_payment_quote`, `discover_agents`, `orchestrate`) | None at MCP layer (gateway-level rules apply) | `src/mcp/schemas.ts` |
| **Hosted Vercel MCP** | `https://wasiai-x402-mcp.vercel.app/api/mcp` | 3 (`discover_agents`, `get_payment_quote`, `pay_x402`) | **Bearer token required on every request** | `mcp-servers/wasiai-x402/src/handlers.mjs` |

> **Why two surfaces.** The self-hosted plugin is in-process with the
> wasiai-a2a Fastify service and shares its budget/billing path. The hosted
> Vercel deployment is a standalone client wrapper around the same x402
> flow — it operates an external operator wallet and signs from outside the
> gateway. The two evolve independently; if you see a tool or field on one
> that does not exist on the other, that is intentional.

---

## Wire format (shared)

Every request is a JSON-RPC 2.0 envelope:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": { "name": "<tool-name>", "arguments": { /* tool input */ } }
}
```

Methods supported on both surfaces:

- `initialize` — handshake. Returns `protocolVersion` `2024-11-05`,
  `serverInfo: { name: "wasiai", version: "1.0.0" }` (self-hosted) or
  `wasiai-x402` (hosted).
- `tools/list` — returns the tool manifest with JSON Schemas.
- `tools/call` — dispatch a tool by name.
- `notifications/*` — accepted; no response body.

Error codes follow the JSON-RPC 2.0 convention (`-32700` parse error,
`-32601` method/tool not found, `-32602` invalid params) plus a tool
execution code for runtime failures.

---

## Surface A — Self-hosted Fastify plugin (4 tools, in-process)

If you run `wasiai-a2a` yourself, the MCP plugin is auto-registered at
`POST /mcp` (see `src/index.ts` line 121, `src/mcp/index.ts`). The base URL
is your gateway; you supply both `gatewayUrl` and `endpoint` arguments to
each tool because the plugin invokes the gateway by HTTP loopback.

The four tools below come from `src/mcp/schemas.ts`
(`TOOL_DESCRIPTIONS` + `INPUT_SCHEMAS`) and are validated server-side via
Ajv (Draft-07).

### `pay_x402` (self-hosted)

Execute the client-side x402 flow against a payment-gated endpoint.
Fetches the URL, detects `402`, signs the EIP-3009
`TransferWithAuthorization` via the Kite payment adapter, retries with
the `payment-signature` header, and returns the final response body.

**Required**: `gatewayUrl` (URI, format-checked), `endpoint` (non-empty
string).
**Optional**: `method` (enum: `GET` | `POST` | `PUT` | `DELETE`),
`payload` (any), `headers` (string→string map), `maxAmountWei` (string of
digits — caps the auto-pay).

```bash
curl -X POST <YOUR_GATEWAY_URL>/mcp \
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

```ts
// pay_x402 — self-hosted
const res = await fetch('<YOUR_GATEWAY_URL>/mcp', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'pay_x402',
      arguments: {
        gatewayUrl: '<YOUR_GATEWAY_URL>',
        endpoint: '/compose',
        method: 'POST',
        payload: {
          steps: [
            { agentSlug: 'example-summarizer', input: { text: 'Hello world' } },
          ],
          maxBudget: 0.5,
        },
        // NOTE: maxAmountWei is a per-call CAP on the auto-pay; values
        // above are 18-digit defaults, NOT the asset's real decimals.
        // See docs/getting-started.md WARNING block (atomic units, 6 decimals).
        maxAmountWei: '1000000000000000000',
      },
    },
  }),
});
const json = await res.json();
// success path: result.content[0].text holds JSON-stringified tool output
console.log(res.status, json);
```

### `get_payment_quote` (self-hosted)

Probe an endpoint to check if it is x402-gated and, if so, return the
amount/asset/network without executing a payment.

**Required**: `gatewayUrl`, `endpoint`. No other inputs.

```bash
curl -X POST <YOUR_GATEWAY_URL>/mcp \
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

```ts
// get_payment_quote — self-hosted
const res = await fetch('<YOUR_GATEWAY_URL>/mcp', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'get_payment_quote',
      arguments: {
        gatewayUrl: '<YOUR_GATEWAY_URL>',
        endpoint: '/orchestrate',
      },
    },
  }),
});
const json = await res.json();
console.log(res.status, json);
```

### `discover_agents` (self-hosted)

Thin wrapper over the gateway's discovery service.

**All fields optional**: `query` (string), `maxPrice` (number ≥ 0),
`capabilities` (string array), `limit` (integer 1–100).

```bash
curl -X POST <YOUR_GATEWAY_URL>/mcp \
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

```ts
// discover_agents — self-hosted
const res = await fetch('<YOUR_GATEWAY_URL>/mcp', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'discover_agents',
      arguments: {
        query: 'summarizer',
        capabilities: ['text-summarization'],
        maxPrice: 0.5,
        limit: 5,
      },
    },
  }),
});
const json = await res.json();
console.log(res.status, json);
```

### `orchestrate` (self-hosted)

Goal-based orchestration. Plans and executes a multi-agent pipeline
within a USDC budget. Returns the final answer plus reasoning and
protocol fee.

**Required**: `goal` (1–N chars), `budget` (number > 0).
**Optional**: `preferCapabilities` (string array), `maxAgents` (integer
1–20), `a2aKey` (non-empty string — when provided, the orchestration is
billed to that A2A key instead of the anonymous x402 path).

```bash
curl -X POST <YOUR_GATEWAY_URL>/mcp \
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

```ts
// orchestrate — self-hosted
const res = await fetch('<YOUR_GATEWAY_URL>/mcp', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'orchestrate',
      arguments: {
        goal: 'Summarize this article and translate to French',
        budget: 2.0,
        preferCapabilities: ['text-summarization', 'translation'],
        maxAgents: 5,
        // a2aKey is optional — when omitted, falls back to anonymous x402.
        a2aKey: '<YOUR_A2A_KEY>',
      },
    },
  }),
});
const json = await res.json();
console.log(res.status, json);
```

> **No `orchestrate` on the hosted MCP.** The hosted Vercel deployment is
> intentionally limited to discovery + payment because it operates an
> external operator wallet and does not have access to A2A-key-based
> orchestration billing. If you need `orchestrate` from an MCP client, run
> the self-hosted plugin or call `POST /orchestrate` on the gateway
> directly with an A2A key (see [api-reference.md](./api-reference.md)).

---

## Surface B — Hosted Vercel MCP (3 tools, bearer-gated)

> **Bearer token required.** Every request to the hosted endpoint MUST
> carry an `Authorization: Bearer <YOUR_MCP_BEARER_TOKEN>` header. Auth runs
> **before** body parse, so an unauthenticated request never reaches the
> JSON-RPC parser, the tool handlers, or the gateway. To request access,
> contact `ferdev@…` (project maintainers issue tokens manually today; an
> automated rotation flow is tracked under WKH-75). The token is opaque to
> clients — treat it like a production credential, do not commit it.

The three tools below come from `mcp-servers/wasiai-x402/src/handlers.mjs`
(`TOOL_DESCRIPTORS`) and reflect the exact wire shape that
`https://wasiai-x402-mcp.vercel.app/api/mcp` advertises via `tools/list`.

The hosted MCP has **no** `gatewayUrl` argument: the gateway URL is fixed
at deployment time via the `WASIAI_GATEWAY_URL` env var (see
`mcp-servers/wasiai-x402/README.md`). Likewise, `OPERATOR_PRIVATE_KEY` and
the `MCP_MAX_AMOUNT_WEI_DEFAULT` cap live server-side; clients cannot
inject either.

### `discover_agents` (hosted)

Listing wrapper. Calls `GET /api/v1/capabilities` on the configured
gateway (which today is `app.wasiai.io`, a thin proxy in front of the
upstream **wasiai-v2** marketplace) and returns the response body
unchanged.

**All fields optional**: `query` (string), `maxPrice` (number),
`capabilities` (string array). **Note**: no `limit` field on the hosted
version (the upstream `/api/v1/capabilities` does not honor one — it uses
the registry-side default).

```bash
curl -X POST https://wasiai-x402-mcp.vercel.app/api/mcp \
  -H 'Authorization: Bearer <YOUR_MCP_BEARER_TOKEN>' \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "discover_agents",
      "arguments": {
        "query": "summarizer",
        "capabilities": ["text-summarization"],
        "maxPrice": 0.5
      }
    }
  }'
```

> **Hosted MCP `discover_agents` calls `/api/v1/capabilities` on
> `app.wasiai.io` — a thin proxy to wasiai-v2.** The self-hosted plugin
> instead calls `/discover` directly on `wasiai-a2a`. If the wasiai-v2
> capabilities schema changes, the hosted MCP `discover_agents` may break
> independently of `wasiai-a2a`. (`/capabilities` is **not** a public
> endpoint of `wasiai-a2a` — see
> [api-reference.md](./api-reference.md#endpoints-intentionally-not-documented).)

### `get_payment_quote` (hosted)

Probe a paid endpoint without signing; return the 402 challenge as a
quote.

**Required**: `endpoint` (path-only string starting with `/`; absolute
URLs are rejected by the SSRF guard at
`mcp-servers/wasiai-x402/src/handlers.mjs:192`).
**Optional**: `method` (string — defaults to `POST`; **not** an enum on
the hosted side, but only `GET`/`POST` are exercised), `payload` (object
— sent as the probe body).

```bash
curl -X POST https://wasiai-x402-mcp.vercel.app/api/mcp \
  -H 'Authorization: Bearer <YOUR_MCP_BEARER_TOKEN>' \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "get_payment_quote",
      "arguments": {
        "endpoint": "/api/v1/orchestrate",
        "method": "POST",
        "payload": { "goal": "summarize", "budget": 0.1 }
      }
    }
  }'
```

### `pay_x402` (hosted)

Execute a full x402 flow: probe → balance-gate (USDC outbound) →
EIP-3009 sign → retry with `payment-signature` header.

**Required**: `endpoint` (path-only string).
**Optional**: `method` (string — defaults to `POST`), `payload` (object —
**MUST** include a numeric `payload.maxBudget` in USDC when the endpoint
requires payment; the balance-gate at `handlers.mjs:381` rejects missing
or non-numeric values), `maxAmountWei` (`string | number`, NOT enum-typed
— priority: per-call > `MCP_MAX_AMOUNT_WEI_DEFAULT` env > undefined).

The hosted version does **not** accept arbitrary `headers` (no client-side
header injection), and there is **no** `gatewayUrl` argument (gateway is
env-pinned).

```bash
curl -X POST https://wasiai-x402-mcp.vercel.app/api/mcp \
  -H 'Authorization: Bearer <YOUR_MCP_BEARER_TOKEN>' \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "pay_x402",
      "arguments": {
        "endpoint": "/api/v1/compose",
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

---

## TypeScript example — full round-trip (hosted MCP)

The hosted MCP endpoint is a normal HTTP POST; you do not need an MCP
SDK. Use `fetch` directly — and remember the bearer header on every call.

```ts
const MCP_URL = 'https://wasiai-x402-mcp.vercel.app/api/mcp';
const MCP_BEARER = process.env.MCP_BEARER_TOKEN!; // never hardcode

async function callTool(
  name: 'pay_x402' | 'get_payment_quote' | 'discover_agents',
  args: Record<string, unknown>,
) {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${MCP_BEARER}`,
      'content-type': 'application/json',
    },
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
const quote = await callTool('get_payment_quote', {
  endpoint: '/api/v1/orchestrate',
  method: 'POST',
  payload: { goal: 'summarize', budget: 0.1 },
});
console.log(quote);
```

For the self-hosted plugin the only differences are:

- the URL is `<YOUR_GATEWAY_URL>/mcp` (not the Vercel host),
- you do **not** need the `Authorization` bearer header (the plugin's
  auth is the gateway's standard A2A-key / x402 flow at the route level),
- and each tool argument set must carry `gatewayUrl` (URI string).

---

## Output envelope (both surfaces)

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

The hosted MCP additionally returns `401 Unauthorized` (HTTP-level, not
JSON-RPC) when the bearer token is missing or invalid — this short-circuits
**before** body parse, so the response is a plain text/JSON error from the
HTTP framework, not a JSON-RPC envelope.

---

## Source of truth

- Self-hosted plugin tools and schemas: `src/mcp/schemas.ts`
  (`TOOLS_MANIFEST`, `TOOL_DESCRIPTIONS`, `INPUT_SCHEMAS`).
- Self-hosted JSON-RPC dispatcher and error mapping: `src/mcp/router.ts`.
- Self-hosted tool implementations: `src/mcp/tools/*.ts`.
- Hosted MCP tool descriptors and handlers: `mcp-servers/wasiai-x402/src/handlers.mjs`
  (`TOOL_DESCRIPTORS` lives at the bottom of the file).
- Hosted MCP HTTP transport, bearer guard and Vercel deployment notes:
  `mcp-servers/wasiai-x402/README.md`.

If the hosted Vercel URL or bearer-issuing process changes, this document
is the authoritative pointer — file a PR.
