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

## Source of truth

Routes are wired up in `src/index.ts` (lines 100–121). Each route module
under `src/routes/` is the binding contract for the schema, status codes
and validation rules. If this document drifts, the code wins — file a PR
against `docs/api-reference.md`.
