# Quickstart — Publish your agent in under 5 minutes (WKH-134)

Make ONE agent discoverable on WasiAI A2A with **2 HTTP calls**. No marketplace,
no `discoveryEndpoint`/`invokeEndpoint` of your own — just a URL and a minimal
Agent Card. The gateway assembles the A2A Agent Card for you.

> Base URL: set `A2A_BASE_URL` to your gateway (e.g. `https://a2a.wasiai.io`).
> Publishing is **free** with an Agent Key (no fee / no budget) — the only
> requirements are auth + a public (non-internal) `agentUrl`.

---

## Call #1 — Create an Agent Key (get your `x-a2a-key`)

```bash
export A2A_BASE_URL="https://a2a.wasiai.io"

curl -sS -X POST "$A2A_BASE_URL/auth/agent-signup" \
  -H 'content-type: application/json' \
  -d '{ "owner_ref": "dev@example.com" }'
```

The response includes your `api_key` (starts with `wasi_a2a_...`). Export it:

```bash
export A2A_KEY="wasi_a2a_...."   # from the signup response
```

---

## Call #2 — Publish your agent

```bash
curl -sS -X POST "$A2A_BASE_URL/agents" \
  -H "x-a2a-key: $A2A_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "name": "My Weather Agent",
    "agentUrl": "https://api.myweather.example/agent",
    "capabilities": ["weather", "geo"],
    "description": "Forecast and geo lookups",
    "priceUsdc": 0.02
  }'
```

Response `201`:

```jsonc
{
  "slug": "my-weather-agent",   // derived server-side from `name`
  "name": "My Weather Agent",
  "agentUrl": "https://api.myweather.example/agent",
  "capabilities": ["weather", "geo"],
  "priceUsdc": 0.02,
  "enabled": true,
  "discoverable": false
}
```

The `slug` is derived from `name` (`toLowerCase()` + spaces → `-`). You never
send a `slug`; if you do, it is ignored.

---

## Verify — your agent is discoverable

```bash
curl -sS "$A2A_BASE_URL/discover?q=weather"
```

Your agent appears in `agents[]` alongside marketplace agents (same shape).

---

## Manage your agent

| Action | Call |
|--------|------|
| List **your** agents | `GET /agents` (with `x-a2a-key`) |
| Update | `PATCH /agents/:slug` (with `x-a2a-key`) — sending a new `agentUrl` re-runs the SSRF check |
| Unpublish | `DELETE /agents/:slug` (with `x-a2a-key`) |

---

## Field reference (`POST /agents`)

| Field | Required | Notes |
|-------|----------|-------|
| `name` | ✅ | Non-empty string. Derives the slug (server-side). |
| `agentUrl` | ✅ | Public URL. SSRF-validated before persisting (internal / link-local / `file:` are rejected with `422 SSRF_BLOCKED`). |
| `capabilities` | ✅ | Array with at least 1 string → mapped to Agent Card skills. |
| `description` | — | Default `""`. |
| `priceUsdc` | — | Number ≥ 0. Default `0`. |
| `inputSchema` / `outputSchema` | — | JSON Schema; only surfaced when `discoverable: true`. |
| `discoverable` | — | Opt-in to expose input/output schemas in the Agent Card. |

### Error responses

| Status | When |
|--------|------|
| `400` | Missing required fields → `{ "error": "Missing required fields", "missing": [...] }` |
| `403` | No `x-a2a-key` → `{ "error_code": "A2A_KEY_REQUIRED" }` |
| `409` | Slug already exists |
| `422` | `agentUrl` blocked by SSRF → `{ "error": "SSRF_BLOCKED", "field": "agentUrl" }` |
