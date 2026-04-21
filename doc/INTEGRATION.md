# Marketplace Integration Guide

> How third-party marketplaces and agent operators integrate with WasiAI A2A Protocol in production.

**Base URL:** `https://wasiai-a2a-production.up.railway.app`
**Protocol:** Google A2A v1 + x402 v2 (Pieverse facilitator on Kite Ozone testnet)

This guide is written for backend engineers integrating a marketplace, an agent, or any automated client against the production gateway. If you are exploring the project for the first time, start with the root [`README.md`](../README.md).

---

## Table of Contents

1. [Integration Patterns](#1-integration-patterns)
2. [Onboarding Flow](#2-onboarding-flow)
3. [Endpoints Reference](#3-endpoints-reference)
4. [x402 Payment Flow](#4-x402-payment-flow)
5. [Error Codes](#5-error-codes)
6. [End-to-End Example](#6-end-to-end-example)
7. [Support](#support)

---

## 1. Integration Patterns

WasiAI A2A is a **B2B protocol**. The 99% case is another server calling ours — not a browser. That single fact shapes every recommendation in this guide.

### Server-to-Server (default)

This is the supported default. Your backend (Node, Python, Go, anything) calls the gateway with a `wasi_a2a_*` key obtained once at onboarding.

- Obtain a key via `POST /auth/agent-signup` (one-time).
- Pass the key on every authenticated call using either header:
  - `x-a2a-key: wasi_a2a_...` (preferred), or
  - `Authorization: Bearer wasi_a2a_...`
- No browser, no preflight, no CORS involved.

Minimal call shape:

```bash
curl https://wasiai-a2a-production.up.railway.app/auth/me \
  -H "x-a2a-key: $A2A_KEY"
```

or equivalently:

```bash
curl https://wasiai-a2a-production.up.railway.app/auth/me \
  -H "Authorization: Bearer $A2A_KEY"
```

**Why CORS is not required here.** CORS is a browser-only policy enforced by the user's browser on cross-origin XHR/fetch. A server-to-server call never triggers a browser preflight, so `CORS_ALLOWED_ORIGINS` on our side is irrelevant to your integration. If your integration is server-to-server, you do not need us to configure anything origin-specific.

### Browser-Direct (SPA, exception case)

Use this only if your product needs a browser (single-page app) to call the gateway directly without a backend relay. This is rare in B2B because it forces you to ship auth material to end-user browsers.

Requirements:

- The gateway must include your SPA's origin in `CORS_ALLOWED_ORIGINS` (production environment variable). If your origin is not listed, the browser blocks the response.
- In development (`NODE_ENV !== production`) the gateway allows any origin. In production it is fail-secure: if `CORS_ALLOWED_ORIGINS` is unset, all cross-origin requests are rejected and a warning is logged at startup.
- To request an origin be added, open an issue or email the operator (see [Support](#support) below) with: SPA origin (scheme + host + port), marketplace name, expected traffic profile.

Never embed a long-lived `wasi_a2a_*` key in an SPA. Use a short-lived proxy key per user session, or keep the key server-side and expose a thin relay.

---

## 2. Onboarding Flow

Four steps from zero to first paid call.

### Step 1 — Create your agent key

`POST /auth/agent-signup` is public (rate-limited to prevent spam). It returns a plaintext `wasi_a2a_*` key **once**. Store it securely; it cannot be recovered later.

```bash
curl -X POST https://wasiai-a2a-production.up.railway.app/auth/agent-signup \
  -H "Content-Type: application/json" \
  -d '{
    "owner_ref": "your-marketplace-slug",
    "display_name": "Your Marketplace"
  }'

# 201 Created
# { "key": "wasi_a2a_abc123...", "key_id": "uuid..." }
```

Export the key as a shell variable for the rest of this guide:

```bash
export A2A_KEY="wasi_a2a_abc123..."  # the "key" field from the response above
```

### Step 2 — (Optional) Register your marketplace

If you operate a marketplace that exposes agents for discovery, register it so the gateway can federate searches to your endpoint.

```bash
curl -X POST https://wasiai-a2a-production.up.railway.app/registries \
  -H "Content-Type: application/json" \
  -H "x-a2a-key: $A2A_KEY" \
  -d '{
    "name": "your-marketplace",
    "discoveryEndpoint": "https://your-marketplace.example.com/api/agents",
    "invokeEndpoint": "https://your-marketplace.example.com/api/invoke",
    "schema": "a2a-v1"
  }'

# 201 Created — returns the registry object
```

This step is only needed if you publish agents. Pure consumers skip it.

### Step 3 — Start consuming

Call the protocol surface with your key. The key authenticates you against the gateway and, if budgeted, covers the usage fee from your pre-funded balance.

```bash
# Discover agents
curl "https://wasiai-a2a-production.up.railway.app/discover?capabilities=data-analysis&limit=5"

# Execute a pipeline
curl -X POST https://wasiai-a2a-production.up.railway.app/compose \
  -H "Content-Type: application/json" \
  -H "x-a2a-key: $A2A_KEY" \
  -d '{ "pipeline": [ /* agent steps */ ] }'

# Goal-based orchestration (LLM plans the pipeline)
curl -X POST https://wasiai-a2a-production.up.railway.app/orchestrate \
  -H "Content-Type: application/json" \
  -H "x-a2a-key: $A2A_KEY" \
  -d '{ "goal": "Analyze token safety for KITE", "budget": 0.10 }'
```

Response headers include `x-a2a-remaining-budget` so you can track your balance per call.

### Step 4 — Pay per call with x402 (alternative)

If you do not want to pre-fund a key, you can pay per call using the x402 protocol and an EIP-712 signature from your wallet. See [Section 4](#4-x402-payment-flow) for the full flow.

You can freely mix both: reserve `wasi_a2a_*` keys for hot paths and use x402 for one-off exploration.

---

## 3. Endpoints Reference

Single scannable reference. "Auth" column legend:

- **Public** — no authentication required
- **Payment/Key** — accepts `PAYMENT-SIGNATURE` (x402) **or** `x-a2a-key` / `Authorization: Bearer wasi_a2a_*`
- **Key required** — requires `x-a2a-key` or `Authorization: Bearer wasi_a2a_*`
- **MCP token** — requires the MCP bearer token provisioned for the Claude Managed Agent or another MCP client

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| `GET` | `/` | Public | Service root: name, version, endpoint map |
| `GET` | `/health` | Public | Liveness probe: `{ status, version, uptime, timestamp }` |
| `GET` | `/.well-known/agent.json` | Public | Gateway's self-describing A2A Agent Card |
| `GET` | `/discover` | Public | Federated agent search (query string) |
| `POST` | `/discover` | Public | Federated agent search (JSON body) |
| `GET` | `/discover/:slug` | Public | Lookup a specific agent by slug |
| `GET` | `/agents/:slug/agent-card` | Public | A2A Agent Card for a specific agent |
| `GET` | `/registries` | Public | List registered marketplaces |
| `GET` | `/registries/:id` | Public | Get a specific registry |
| `POST` | `/registries` | Payment/Key | Register a new marketplace |
| `PATCH` | `/registries/:id` | Payment/Key | Update an existing registry |
| `DELETE` | `/registries/:id` | Payment/Key | Remove a registry |
| `POST` | `/compose` | Payment/Key | Execute an explicit multi-agent pipeline |
| `POST` | `/orchestrate` | Payment/Key | Goal-based orchestration (LLM plans the pipeline) |
| `POST` | `/auth/agent-signup` | Public (rate-limited) | Create a new `wasi_a2a_*` key |
| `GET` | `/auth/me` | Key required | Inspect your key: budget, scoping, bindings, daily limits |
| `POST` | `/auth/deposit` | Public | Register a deposit (returns 501 — pending on-chain verification) |
| `POST` | `/auth/bind/:chain` | Public | On-chain identity binding (returns 501 — planned) |
| `POST` | `/tasks` | Public | Create a task (A2A task lifecycle) |
| `GET` | `/tasks/:id` | Public | Get task status |
| `PATCH` | `/tasks/:id` | Public | Update task state |
| `GET` | `/gasless/status` | Public | Gasless module status (`funding_state` field) |
| `POST` | `/gasless/transfer` | Public | Execute gasless EIP-3009 transfer (503 when not operational) |
| `POST` | `/mcp` | MCP token | JSON-RPC 2.0 tool dispatcher for MCP clients |

Notes:

- `POST /auth/agent-signup` is intentionally public — it is the entry point for onboarding. It is protected by a stricter rate limit (`RATE_LIMIT_SIGNUP_MAX`, default 5 / window) to prevent key-spam.
- For `POST /registries`, `POST /compose`, and `POST /orchestrate` the server returns `402 Payment Required` with an `accepts[]` array when no auth is provided. See [Section 4](#4-x402-payment-flow).
- A2A Protocol interactions (tasks, agent cards, well-known) follow the [Google A2A](https://google.github.io/A2A/) specification. JSON-RPC 2.0 is used inside the MCP surface (`/mcp`).

---

## 4. x402 Payment Flow

x402 lets a client pay per request with a single EIP-712 signature — no pre-funded account, no gas held by the client at payment time. The gateway implements [x402 v2](https://x402.org/) and settles through the [Pieverse](https://pieverse.io) facilitator on Kite Ozone testnet.

### Asset and network

- **Network:** Kite Ozone testnet (chain id `2368`)
- **Asset:** `KXUSD` (EIP-3009 compliant), contract `0x1b7425d288ea676FCBc65c29711fccF0B6D5c293`
- **Facilitator:** Pieverse, verifier contract `0x12343e649e6b2b2b77649DFAb88f103c02F3C78b`

### Cycle

1. **Call without payment.** The client makes the request normally. If no `PAYMENT-SIGNATURE` header and no `x-a2a-key` are present, the gateway responds `402 Payment Required`:

    ```json
    {
      "error": "payment-signature header is required",
      "x402Version": 2,
      "accepts": [
        {
          "scheme": "exact",
          "network": "kite-ozone-testnet",
          "maxAmountRequired": "1000000000000000000",
          "payTo": "0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba",
          "asset": "0x1b7425d288ea676FCBc65c29711fccF0B6D5c293",
          "maxTimeoutSeconds": 300,
          "merchantName": "WasiAI",
          "mimeType": "application/json",
          "resource": "/orchestrate"
        }
      ]
    }
    ```

2. **Sign the authorization.** The client builds an EIP-712 `Authorization` payload (`from`, `to = payTo`, `value = maxAmountRequired`, `validAfter`, `validBefore = now + maxTimeoutSeconds`, random `nonce`) and signs it with its wallet. The domain is `{ name: "Kite x402", version: "1", chainId: 2368, verifyingContract: <facilitator> }`.

3. **Retry with the signature.** The client base64-encodes `{ authorization, signature, network }` and sends the retry request:

    ```http
    POST /orchestrate HTTP/1.1
    Content-Type: application/json
    PAYMENT-SIGNATURE: eyJhdXRob3JpemF0aW9uIjogey4uLn0sICJzaWduYXR1cmUiOiAiMHguLi4ifQ==

    { "goal": "...", "budget": 0.10 }
    ```

4. **Gateway verifies + executes.** The gateway asks Pieverse to verify the signature, settles the KXUSD transfer on-chain, then executes the request. The response carries the business result; on failure the gateway returns the appropriate HTTP code and does not settle.

A complete, runnable reference implementation lives in [`scripts/demo-x402.ts`](../scripts/demo-x402.ts). It uses `viem` to sign and targets the production gateway; point it at your own base URL by passing it as the first argument.

```bash
npx tsx scripts/demo-x402.ts https://wasiai-a2a-production.up.railway.app
```

---

## 5. Error Codes

All errors share a normalized JSON shape:

```json
{ "error": "human-readable message", "code": "MACHINE_READABLE", "requestId": "..." }
```

| HTTP | Meaning in this API | Recommended action |
|------|---------------------|--------------------|
| `401 Unauthorized` | Not emitted by the application layer. May appear from infrastructure (CDN, reverse proxy) if your request is dropped before reaching the app. | Check the URL, TLS, and that your `Authorization` header is well-formed. If you need auth, this API uses `403` (see next row). |
| `402 Payment Required` | The endpoint needs payment and none was provided. Body includes `accepts[]` with full x402 payment instructions. | Sign the EIP-712 authorization, base64-encode the payload, retry with `PAYMENT-SIGNATURE`. Alternatively attach a valid `x-a2a-key`. |
| `403 Forbidden` | An `x-a2a-key` / Bearer was provided but rejected. The `error_code` field tells you why: `KEY_NOT_FOUND`, `KEY_INACTIVE`, `DAILY_LIMIT`, `INSUFFICIENT_BUDGET`, `SCOPE_DENIED`, `PER_CALL_LIMIT`. | `KEY_NOT_FOUND`/`KEY_INACTIVE` → verify the key you are sending and that it has not been disabled. `DAILY_LIMIT`/`INSUFFICIENT_BUDGET` → top up or wait for the daily reset. `SCOPE_DENIED` → request a wider scope from the key owner. `PER_CALL_LIMIT` → lower `budget` in the request body. |
| `429 Too Many Requests` | Per-IP or per-key rate limit exceeded. Response body includes `retryAfterMs`. | Back off for the duration in `retryAfterMs`. Do not hammer — repeated 429 will extend the window. |
| `503 Service Unavailable` | An upstream dependency is down or overloaded. The `code` field clarifies: `CIRCUIT_OPEN` (Anthropic or a registry is failing), `BACKPRESSURE` (too many in-flight `/orchestrate`), `gasless_not_operational`, `SERVICE_ERROR` (budget service). | Retry with exponential backoff (start at 1s, cap at 30s, jitter). If the failure persists for more than a minute, check the status page or contact support. |
| `504 Gateway Timeout` | The request exceeded the configured timeout (`TIMEOUT_ORCHESTRATE_MS` default 120s, `TIMEOUT_COMPOSE_MS` default 60s). | Shrink the workload, split the pipeline, or retry — upstream agents may be cold. |

When `NODE_ENV=development`, error responses include the stack trace. In production only the normalized shape is returned.

---

## 6. End-to-End Example

A single flow that signs up, discovers, and composes — both as a Bash/curl script and as a Node/TypeScript `fetch` snippet. Both target production and require no placeholders other than values you compute at runtime.

### Version A — curl

```bash
#!/usr/bin/env bash
set -euo pipefail

BASE="https://wasiai-a2a-production.up.railway.app"

# 1. Sign up — receive a one-time plaintext key
SIGNUP=$(curl -s -X POST "$BASE/auth/agent-signup" \
  -H "Content-Type: application/json" \
  -d '{"owner_ref": "integration-demo", "display_name": "Integration Demo"}')

A2A_KEY=$(echo "$SIGNUP" | jq -r .key)
echo "Got key: ${A2A_KEY:0:16}..."

# 2. Inspect the key (sanity check)
curl -s "$BASE/auth/me" \
  -H "x-a2a-key: $A2A_KEY" | jq '{ key_id, is_active, budget, daily_limit_usd }'

# 3. Discover agents
curl -s "$BASE/discover?limit=3" | jq '.agents | length'

# 4. Call /compose with the key
curl -s -X POST "$BASE/compose" \
  -H "Content-Type: application/json" \
  -H "x-a2a-key: $A2A_KEY" \
  -d '{
    "pipeline": [
      { "agentSlug": "example-agent", "input": { "query": "hello" } }
    ]
  }' | jq .
```

Prerequisites: `curl`, `jq`. The script exits on first error. If `/compose` returns `403 INSUFFICIENT_BUDGET` the key has no funds yet — switch to the x402 flow in [Section 4](#4-x402-payment-flow) or wait for the deposit endpoint (WKH-35).

### Version B — TypeScript / fetch

```ts
const BASE = 'https://wasiai-a2a-production.up.railway.app';

async function main() {
  // 1. Sign up
  const signupRes = await fetch(`${BASE}/auth/agent-signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      owner_ref: 'integration-demo',
      display_name: 'Integration Demo',
    }),
  });
  if (!signupRes.ok) throw new Error(`signup failed: ${signupRes.status}`);
  const { key: a2aKey, key_id: keyId } = await signupRes.json();
  console.log(`Got key ${keyId}: ${a2aKey.slice(0, 16)}...`);

  // 2. /auth/me sanity check
  const meRes = await fetch(`${BASE}/auth/me`, {
    headers: { 'x-a2a-key': a2aKey },
  });
  const me = await meRes.json();
  console.log('key status:', { is_active: me.is_active, budget: me.budget });

  // 3. Discover (public, no key needed)
  const discoverRes = await fetch(`${BASE}/discover?limit=3`);
  const discover = await discoverRes.json();
  console.log(`discovered ${discover.agents?.length ?? 0} agents`);

  // 4. Compose
  const composeRes = await fetch(`${BASE}/compose`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-a2a-key': a2aKey,
    },
    body: JSON.stringify({
      pipeline: [
        { agentSlug: 'example-agent', input: { query: 'hello' } },
      ],
    }),
  });

  if (composeRes.status === 403) {
    const err = await composeRes.json();
    console.warn(`compose rejected: ${err.error_code ?? err.error}`);
    return;
  }

  const result = await composeRes.json();
  console.log('compose result:', result);
  console.log('remaining budget:', composeRes.headers.get('x-a2a-remaining-budget'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Run with `npx tsx your-file.ts` (or compile with `tsc`). Works in Node 20+ and any modern runtime with a global `fetch`.

---

## Support

- **Issues and feature requests:** [github.com/ferrosasfp/wasiai-a2a/issues](https://github.com/ferrosasfp/wasiai-a2a/issues)
- **Source, changelog, and roadmap:** [github.com/ferrosasfp/wasiai-a2a](https://github.com/ferrosasfp/wasiai-a2a)
- **Protocol version:** Google A2A v1 + x402 v2 (Pieverse facilitator)
- **Architecture detail:** [`doc/architecture/CHAIN-ADAPTIVE.md`](architecture/CHAIN-ADAPTIVE.md)
- **On-chain contracts:** [`doc/kite-contracts.md`](kite-contracts.md)

Contributions welcome — see the `doc/sdd/` directory for the full NexusAgile methodology used by this project.
