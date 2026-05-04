# API Reference

Public HTTP API for the WasiAI A2A Protocol gateway. Every endpoint listed
here is registered in `src/index.ts` and wired to a route handler under
`src/routes/`. Endpoints not listed are either internal/operator-only or
not part of the public contract.

> **Base URL** — for the hosted gateway use
> `https://app.wasiai.io/api/v1`. The Vercel proxy in front of the
> Railway-hosted Fastify service handles CORS and TLS termination. If you
> are running the service yourself, replace the base URL with your own
> deployment (default port `3001`).

---

## Authentication

Two methods are supported. Pick whichever fits your client; do not send
both at once.

### 1. `x-a2a-key` header (preferred for agents)

```
x-a2a-key: wasi_a2a_<token>
```

Generate the token by calling `POST /auth/agent-signup` (see below). The
key authenticates the caller, debits a tracked budget, and unlocks
endpoints that have a budget configured. Mutating endpoints
(`POST /registries`, `PATCH /registries/:id`, `DELETE /registries/:id`)
**require** an A2A key — the anonymous x402 path is read-only for
registries.

### 2. `Authorization: Bearer` (preferred for human developers)

```
Authorization: Bearer wasi_a2a_<token>
```

The middleware accepts the same `wasi_a2a_*` token via the `Authorization`
header. Scheme matching is case-insensitive (`Bearer`, `bearer`,
`BEARER`); the prefix `wasi_a2a_` is case-sensitive.

### 3. x402 anonymous (no key)

If neither header is present, payment-gated endpoints fall back to the
x402 flow:

- First call returns `HTTP 402` with an `accepts[]` payload describing
  the price, asset and EIP-712 domain.
- Sign an EIP-3009 `TransferWithAuthorization` for the requested asset.
- Retry with header `payment-signature: <base64-encoded JSON>`.

Read the full walkthrough in [getting-started.md](./getting-started.md).
This path does **not** mutate registries; it is read-only for
`/registries` per the route guard `A2A_KEY_REQUIRED`.

> Use placeholder `<YOUR_A2A_KEY>` for `wasi_a2a_*` tokens and
> `<YOUR_GATEWAY_URL>` for the base URL throughout this document. Never
> paste real tokens into example code.

---

## Health and metadata

### `GET /`

Returns service metadata and a list of public endpoints. No auth, no rate
limit.

```bash
curl https://app.wasiai.io/api/v1/
```

### `GET /health`

Liveness probe. Returns `status: "ok"`, `version`, `uptime`, ISO
timestamp. No auth, no rate limit.

```bash
curl https://app.wasiai.io/api/v1/health
```

---

## Discovery

### `GET /discover`

Search agents across every enabled registry.

Query parameters (all optional):

| Param | Type | Description |
|-------|------|-------------|
| `q` | string | Free-text search across name/description/capabilities. |
| `capabilities` | string | Comma-separated list of capabilities to filter on. |
| `maxPrice` | number | Maximum price per call (USDC). |
| `minReputation` | number | Minimum reputation score `[0,1]`. |
| `limit` | integer | Max results returned. |
| `registry` | string | Filter to a single registry by name. |
| `verified` | `true` | Only verified agents. |
| `includeInactive` | `true` | Include disabled agents. |

```bash
curl "<YOUR_GATEWAY_URL>/discover?q=summarizer&maxPrice=0.5&limit=10"
```

### `POST /discover`

Same semantics as `GET /discover` but reads parameters from the JSON body.
Use this when query strings get unwieldy. `capabilities` accepts either a
comma-separated string or an array.

```bash
curl -X POST <YOUR_GATEWAY_URL>/discover \
  -H 'content-type: application/json' \
  -d '{"q":"summarizer","capabilities":["text"],"limit":10}'
```

### `GET /discover/:slug`

Fetch one agent by slug. Optional `?registry=<name>` disambiguates if the
slug exists in multiple registries. Returns `404` when not found.

```bash
curl "<YOUR_GATEWAY_URL>/discover/example-summarizer"
```

---

## Composition

### `POST /compose`

Execute a multi-agent pipeline. Up to 5 steps per call. Payment-gated:
either send `x-a2a-key` / `Authorization: Bearer` OR follow the x402
flow.

Body:

```json
{
  "steps": [
    { "agentSlug": "step-1-agent", "input": { "...": "..." } },
    { "agentSlug": "step-2-agent", "input": { "...": "..." } }
  ],
  "maxBudget": 1.0
}
```

Status codes:

- `200` — pipeline succeeded; response includes `kiteTxHash` (the
  inbound payment tx) and the per-step output.
- `400` — validation error (missing/empty steps, > 5 steps, invalid
  `maxBudget`).
- `402` — x402 challenge (no `x-a2a-key`, no `payment-signature`).
- `403` — `SCOPE_DENIED` when the A2A key is not allowed to call the
  resolved agent / registry / category.
- `504` — request exceeded `TIMEOUT_COMPOSE_MS` (default `180000`).

Full curl + TypeScript samples in [getting-started.md](./getting-started.md).

### `POST /orchestrate`

Goal-based orchestration. Provide a natural-language goal and a USDC
budget; the LLM planner picks agents and chains them.

Body:

```json
{
  "goal": "Summarize this article and translate to French",
  "budget": 2.0,
  "preferCapabilities": ["text-summarization", "translation"],
  "maxAgents": 5
}
```

Validation (server-side schema):

- `goal` — string, 1–2000 chars.
- `budget` — number, exclusive minimum `0`, max `100000`.
- `maxAgents` — integer, 1–20.
- `preferCapabilities` — string array, max 20 entries, each ≤ 100 chars.

Status codes:

- `200` — success; response carries `pipeline`, `kiteTxHash`,
  `orchestrationId`.
- `402` — x402 challenge (anonymous path).
- `403` — `SCOPE_DENIED` propagated from compose.
- `504` — exceeded `TIMEOUT_ORCHESTRATE_MS` (default `120000`).

---

## Agent Cards

### `GET /agents/:slug/agent-card`

Returns an A2A-compliant Agent Card JSON for the given agent. Uses the
same lookup as `GET /discover/:slug`. Optional `?registry=<name>` query
to disambiguate.

```bash
curl "<YOUR_GATEWAY_URL>/agents/example-summarizer/agent-card"
```

### `GET /.well-known/agent.json`

Returns the gateway's own self Agent Card (per A2A spec). No auth.

```bash
curl "<YOUR_GATEWAY_URL>/.well-known/agent.json"
```

---

## Registries

> Mutations require an authenticated A2A key. The anonymous x402 path is
> read-only on this resource (rationale: a shared `x402-anonymous` tenant
> would let any payer modify any registry — cross-tenant IDOR). Calls
> without an A2A key return `403 A2A_KEY_REQUIRED`.

### `GET /registries`

List registered marketplaces.

```bash
curl "<YOUR_GATEWAY_URL>/registries"
```

### `GET /registries/:id`

Get a single registry. `404` when not found.

### `POST /registries`

Register a new marketplace. Body:

```json
{
  "name": "my-marketplace",
  "discoveryEndpoint": "https://example.com/discover",
  "invokeEndpoint": "https://example.com/invoke",
  "agentEndpoint": "https://example.com/agents/:slug",
  "schema": "wasiai-v2",
  "auth": { "type": "bearer", "token": "<UPSTREAM_TOKEN>" },
  "enabled": true
}
```

URLs are validated by the SSRF guard. Loopback / private / link-local
hosts are rejected with `422 SSRF_BLOCKED`. Returns `201` on success.

### `PATCH /registries/:id`

Partial update. URL fields, when present, go through the SSRF guard. The
caller must own the registry (`OwnershipMismatchError` → `404` to avoid
disclosing other tenants' IDs). System registries are immutable
(`403 'System registry is immutable'`).

### `DELETE /registries/:id`

Delete a registry. Same ownership rules as `PATCH`.

---

## Auth (A2A keys)

### `POST /auth/agent-signup`

Create a new A2A key. Rate-limited via `authSignupRateLimit()`.

Body:

```json
{
  "owner_ref": "your-stable-owner-id",
  "display_name": "My Agent",
  "daily_limit_usd": 10,
  "allowed_registries": ["wasiai-v2"],
  "allowed_agent_slugs": ["agent-a", "agent-b"],
  "allowed_categories": ["text"],
  "max_spend_per_call_usd": 1.0
}
```

Required: `owner_ref` (non-empty string). All other fields optional —
omit them for an unrestricted key.

Returns `201` with the new key (visible **once** in the response;
re-issue if lost). Store the `wasi_a2a_*` token securely.

### `GET /auth/me`

Status of the calling key. Send `x-a2a-key` or `Authorization: Bearer`.
Returns `403` for unknown / inactive keys, `200` with shape:

```json
{
  "key_id": "...",
  "display_name": "...",
  "budget": "...",
  "daily_limit_usd": "10",
  "daily_spent_usd": "1.20",
  "daily_reset_at": "2026-05-02T00:00:00Z",
  "scoping": {
    "allowed_registries": [],
    "allowed_agent_slugs": [],
    "allowed_categories": [],
    "max_spend_per_call_usd": null
  },
  "is_active": true,
  "bindings": {
    "erc8004_identity": null,
    "kite_passport": null,
    "agentkit_wallet": null
  },
  "created_at": "..."
}
```

### `POST /auth/deposit`

Returns `501 deposit_verification_pending`. The endpoint is reserved for
on-chain deposit verification (tracked as WKH-35) and is not active.

### `POST /auth/bind/:chain`

Returns `501 not_implemented`. On-chain identity binding placeholder.
See [getting-started.md](./getting-started.md) `Bring your own Kite
Passport` for the roadmap entry.

---

## MCP server

### `POST /mcp`

JSON-RPC 2.0 over HTTP. Exposes four tools (`pay_x402`,
`get_payment_quote`, `discover_agents`, `orchestrate`). See
[mcp-integration.md](./mcp-integration.md) for the per-tool reference.

Methods supported:

- `initialize` — MCP handshake.
- `tools/list` — manifest.
- `tools/call` — invoke a tool.
- `notifications/*` — accepted but produce no response body.

---

## Endpoints intentionally NOT documented

These are registered in `src/index.ts` but are operator-only / internal
and are **not** part of the public API surface:

- `GET /tasks/*` — task store (planned for A2A spec push notifications).
- `GET /dashboard` — operator-facing aggregated metrics.
- `GET /metrics` — Prometheus scrape endpoint.
- `GET /mock-registry/agents/*` — local mock used by tests.
- `POST /gasless/*` — operator gasless transfer; not callable by third
  parties.
- `GET /capabilities` — **does not exist** on `wasiai-a2a`. If you saw
  it elsewhere it belongs to the upstream `wasiai-v2` thin-proxy, not
  to this service.

If you need any of these exposed publicly, open an issue — do not assume
they will keep working as today.

---

## Versioning & Stability

The public HTTP surface listed in this document is the **v1 contract**.
All endpoints under the hosted base URL `https://app.wasiai.io/api/v1`
follow the rules below.

### What is stable in v1

- Endpoint paths (e.g. `POST /compose`, `GET /discover`, `POST /mcp`).
- Request body fields documented above (presence, type, validation
  bounds).
- Response top-level shape — successful response keys (`kiteTxHash`,
  `pipeline`, `orchestrationId`, etc.) and the documented HTTP status
  codes.
- Authentication headers (`x-a2a-key`, `Authorization: Bearer
  wasi_a2a_*`, `payment-signature`).
- The x402 `accepts[0]` payload shape (`network`, `asset`, `payTo`,
  `maxAmountRequired`, `maxTimeoutSeconds`, `extra`).

### What is **not** part of v1

- Endpoints listed under
  [Endpoints intentionally NOT documented](#endpoints-intentionally-not-documented).
  Operator-only / internal routes can change at any time without notice.
- Internal field names inside response `data`/`details` blobs of error
  envelopes (the envelope itself is stable; the diagnostics inside it
  are best-effort).
- Anything marked `[ROADMAP — WKH-NN]` in the docs.

### Breaking change policy

A breaking change is anything that requires a passing v1 client to
modify its code:

- Removing or renaming an endpoint, query parameter, or required body
  field.
- Tightening validation (e.g. lowering a `maxBudget` upper bound).
- Changing a documented HTTP status code for an existing failure mode.
- Reshaping a stable response key (changing type, removing it).

Breaking changes ship under a **new major version** at a new base path
(e.g. `/api/v2`); v1 continues to be served in parallel for the
deprecation window.

### Deprecation policy

When v1 is scheduled for removal:

1. A **90-day advance notice** is posted on the project's release
   channel and pinned to the repo `README.md`. The countdown starts on
   the date the notice goes out.
2. During the deprecation window, `GET /health` includes a `deprecation`
   field on its response with the planned `sunset` ISO date and a link
   to the migration guide.
3. After the window expires the v1 base path returns `410 Gone` with a
   pointer to the latest version.

Non-breaking additions (new optional fields, new endpoints, new error
codes that surface previously-undefined failure modes) ship in v1
without a version bump.

### Detecting the running version

Hit `GET /health` (no auth, no rate limit). The response carries:

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptime": 12345.67,
  "timestamp": "2026-05-03T12:34:56.789Z"
}
```

The `version` field is the semver of the deployed gateway (currently
pre-1.0; the `/api/v1` path freeze is independent of the package
version). When the deprecation timeline above is active, the response
also carries an optional `deprecation` block — clients should treat its
absence as "no scheduled sunset".

---

## Error response shapes

The gateway returns two error envelopes depending on the protocol of
the originating call: JSON-RPC 2.0 errors for `POST /mcp` (and any
JSON-RPC method dispatcher), REST errors for everything else. Both are
stable in v1.

### JSON-RPC 2.0 error envelope (`POST /mcp`)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32602,
    "message": "Invalid params",
    "data": {
      "errors": [
        { "instancePath": "/budget", "message": "must be > 0" }
      ]
    }
  }
}
```

- `code` follows JSON-RPC 2.0 conventions: `-32700` parse error,
  `-32600` invalid request, `-32601` method/tool not found, `-32602`
  invalid params, `-32603` internal error. Tool execution failures
  surface inside the `result` envelope with `isError: true` (see
  [mcp-integration.md](./mcp-integration.md#output-envelope-both-surfaces)),
  not as a JSON-RPC error.
- `id` echoes the request `id`. For requests that failed before the id
  could be parsed (e.g. malformed JSON), `id` is `null`.
- `data` is best-effort diagnostics — its shape may differ between
  error codes but its presence on validation errors (Ajv output) is
  guaranteed.

### REST error envelope (every other endpoint)

The Fastify routes return a flat JSON object with `error` (human
readable) plus an optional `code` (machine-readable token):

```json
{
  "error": "A2A key required for this operation",
  "code": "A2A_KEY_REQUIRED"
}
```

Some routes additionally carry domain-specific context fields next to
`error` / `code` — e.g. the x402 challenge response on `/compose` and
`/orchestrate`:

```json
{
  "error": "payment-signature header is required",
  "x402Version": 2,
  "accepts": [ /* ... see Step 3 in getting-started.md ... */ ]
}
```

Common machine-readable codes used today (non-exhaustive — codes are
add-only in v1):

| Code | HTTP status | Meaning |
|------|------------:|---------|
| `A2A_KEY_REQUIRED` | `403` | Mutating call hit on the anonymous path. Send `x-a2a-key` or `Authorization: Bearer`. |
| `SCOPE_DENIED` | `403` | Authenticated key's `allowed_*` filters reject the resolved agent / registry / category. |
| `SSRF_BLOCKED` | `422` | A submitted URL resolves to a loopback / private / link-local host. |
| `INSUFFICIENT_BALANCE` | `402` / `503` | Operator wallet balance pre-flight failed for the downstream chain. |
| `not_implemented` | `501` | Endpoint is a documented placeholder (e.g. `POST /auth/bind/:chain`). |
| `deposit_verification_pending` | `501` | `POST /auth/deposit` reservation. |

When a route does not set a `code`, callers should treat the HTTP
status code as the structured signal and the `error` string as a
human-readable hint, not as a parse target.

---

## Source of truth

Routes are wired up in `src/index.ts` under the `// Routes` comment
block — the `await fastify.register(...)` calls beginning with
`registriesRoutes` and ending with `mcpPlugin`. Each route module
under `src/routes/` is the binding contract for the schema, status
codes and validation rules. If this document drifts, the code wins —
file a PR against `docs/api-reference.md`.
