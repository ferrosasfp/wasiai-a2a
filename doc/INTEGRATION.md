# Marketplace Integration Guide

> How third-party marketplaces and agent operators integrate with WasiAI A2A Protocol in production.

**Base URL:** `https://wasiai-a2a-production.up.railway.app`
**Protocol:** Google A2A v1 + x402 v2 (spec-literal)
**Supported Chains (inbound x402):** Kite (testnet, mainnet), Avalanche (Fuji, C-Chain mainnet), Base (Sepolia, mainnet). Solana devnet exists as an outbound settle rail only (opt-in-off), it is not a valid `x-payment-chain` for paying the gateway.

This guide is written for backend engineers integrating a marketplace, an agent, or any automated client against the production gateway. If you are exploring the project for the first time, start with the root [`README.md`](../README.md).

---

## Table of Contents

1. [Integration Patterns](#1-integration-patterns)
2. [Onboarding Flow](#2-onboarding-flow)
3. [Endpoints Reference](#3-endpoints-reference)
4. [x402 Payment Flow](#4-x402-payment-flow)
5. [Error Codes](#5-error-codes)
6. [Funding an Agent Key on Solana (devnet)](#6-funding-an-agent-key-on-solana-devnet)
7. [End-to-End Example](#7-end-to-end-example)
8. [Support](#support)

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

The `x-a2a-key` header is **required** here: registry mutations are tenant-scoped
and the anonymous x402 rail cannot own a registry. Without it you get
`403 A2A_KEY_REQUIRED` and **nothing is charged**.

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
| `POST` | `/tasks` | Key required | Create a task (A2A task lifecycle) — **costs $1** |
| `GET` | `/tasks` | Key required | List your tasks (filters: `status`, `context_id`, `limit`) — **free** |
| `GET` | `/tasks/:id` | Key required | Get task status — **free** |
| `PATCH` | `/tasks/:id/status` | Key required | Update task status — **costs $1** |
| `PATCH` | `/tasks/:id` | Key required | Append messages/artifacts to a task — **costs $1** |
| `GET` | `/gasless/status` | Public | Gasless module status (`funding_state` field) |
| `POST` | `/gasless/transfer` | Public | Execute gasless EIP-3009 transfer (503 when not operational) |
| `POST` | `/agents` | Key required | Publish one agent of your own (free, no debit) |
| `PATCH` | `/agents/:slug` | Key required | Update your own agent (free, no debit) |
| `POST` | `/mcp` | MCP token | JSON-RPC 2.0 tool dispatcher for MCP clients |

Notes:

- `POST /auth/agent-signup` is intentionally public — it is the entry point for onboarding. It is protected by a stricter rate limit (`RATE_LIMIT_SIGNUP_MAX`, default 5 / window) to prevent key-spam.
- For `POST /compose` and `POST /orchestrate` the server returns `402 Payment Required` with an `accepts[]` array when no auth is provided. See [Section 4](#4-x402-payment-flow).
- **`/registries` mutations and every `/tasks` endpoint do NOT challenge anonymous callers.** They operate on resources that belong to a tenant, and the anonymous x402 rail carries no tenant identity, so those requests can never succeed. Instead of a `402` you get `403 A2A_KEY_REQUIRED` **before any payment is taken** — no on-chain settle, nothing to refund. Attach an `x-a2a-key` (or `Authorization: Bearer wasi_a2a_*`) to use them. Previously these endpoints emitted a `402`, settled the payment on-chain, and then rejected the request anyway. On the two `/tasks` reads there is no payment layer left at all, so a `402` is not merely avoided: it cannot be produced.
- A2A Protocol interactions (tasks, agent cards, well-known) follow the [Google A2A](https://google.github.io/A2A/) specification. JSON-RPC 2.0 is used inside the MCP surface (`/mcp`).

#### Reading a task is free; creating and updating one is not

**`GET /tasks`, `GET /tasks/:id` and their `HEAD` counterparts cost you nothing.**
No budget debit, no on-chain settle, and — because there is nothing to pay — **no
`402` challenge is ever emitted on those routes**. They still require a credential
(`403 A2A_KEY_REQUIRED` without one) and still return only *your* tasks: free is
not public. A key with an exhausted budget or a spent daily limit can still read
its own tasks.

**Poll as often as your integration needs.** The A2A lifecycle
(`submitted` → `working` → `completed`) is driven by polling `GET /tasks/:id`, so
the previous price of $1 *per read* meant that following this guide at one poll
every 5 seconds cost 720 USD/hour. That is fixed: you are billed for the work
(creating the task, mutating it), not for asking about it. The rate limit still
applies (`RATE_LIMIT_MAX`, default 60 requests / 60s per client), so a 5-second
interval — 12 reads per minute — fits comfortably; cost is no longer a reason to
avoid polling.

`POST /tasks` (create) and the two `PATCH` routes (mutate) keep costing **$1**
each: they write state. Only the reads changed.

### Declaring where your agent gets paid (`payment`)

`POST /agents` and `PATCH /agents/:slug` accept an optional `payment` block. It is
what the gateway later exposes as `agent.payment` in `/discover`, and it is how a
third party says which chain and which wallet its agent charges on. Omit it and
nothing changes: the agent is published exactly as before and gets paid on the
gateway's default rail.

```json
{
  "name": "My FX Agent",
  "agentUrl": "https://api.example.com/agent",
  "capabilities": ["fx"],
  "payment": {
    "method": "x402",
    "chain": "solana-devnet",
    "contract": "YourBase58PubkeyHere11111111111111111111111",
    "asset": "USDC"
  }
}
```

| Field | Required | What it means |
|---|---|---|
| `method` | yes | Must be exactly `"x402"`. Not trimmed, not lowercased: `"X402"` and `" x402 "` are rejected. |
| `chain` | yes | A chain slug this gateway knows **and** has active in this deployment. |
| `contract` | yes | See the warning below. This is a **wallet**, not a token. |
| `asset` | no | A label. Checked against the token the rail settles. Your letter case is preserved exactly; leading and trailing whitespace is trimmed. |

#### `contract` is the wallet that gets paid, not a token address

The name is misleading and it has already caused a false alarm in this codebase.
`contract` is the `payTo` of the outbound transfer: the address that receives the
money. It is **not** the mint, and it is **not** the address of a token contract.
Putting a token address there sends your earnings to the token contract.

The token is decided by the rail, never by your agent card. `asset` does not choose
it either; `asset` is a label that no money path reads.

The format has to match the chain family of `chain`: an EVM `0x...` address for an
EVM chain, a base58 pubkey for Solana. Crossing them is rejected. Letter case is
preserved byte for byte and never normalized, because base58 is case sensitive and
lowercasing a Solana pubkey produces a different, valid looking wallet.

#### Deleting the block

On `PATCH`, send `"payment": null` to remove the block. The key is deleted from the
agent's metadata and every other field is left untouched. Omitting `payment`
entirely means "leave it as it is", which is a different thing.

On `POST` there is nothing to delete, so `"payment": null` is rejected with
`INVALID_PAYMENT_BLOCK` rather than being silently read as "no payment block". To
publish without one, leave the key out.

#### What comes back

The `201` (or `200` for `PATCH`) response echoes the block under `payment`, with the
four fields above and nothing else. Two fields you may have seen in `/discover`,
`resolvedChain` and `network`, are derived by the gateway on every read: they are
rejected on the way in and are never stored.

#### Rejections

All eight are `422`, and all of them are checked before anything is written, so a
rejected request never touches your agent row.

| `error_code` | `field` | When |
|---|---|---|
| `INVALID_PAYMENT_BLOCK` | `payment` | Not an object, or one of the three required strings is missing or blank |
| `UNSUPPORTED_PAYMENT_METHOD` | `payment.method` | `method` is not exactly `"x402"` |
| `INVALID_PAYMENT_CHAIN` | `payment.chain` | The gateway does not know that chain slug |
| `PAYMENT_CHAIN_NOT_INITIALIZED` | `payment.chain` | Known slug, but that rail is not active here. The response adds `initializedChains` with the ones that are |
| `INVALID_PAYMENT_PAYTO_FORMAT` | `payment.contract` | Not a valid address for the chain's family |
| `ZERO_PAYMENT_PAYTO` | `payment.contract` | The zero address, or the all zero Solana pubkey `11111111111111111111111111111111` |
| `PAYTO_IS_OPERATOR` | `payment.contract` | The address is the gateway's own operator address |
| `PAYMENT_ASSET_MISMATCH` | `payment.asset` | The label does not match the token that rail settles |

Error bodies never echo the value you sent. That detail is logged server side.

#### `asset` is checked strictly, and that has a consequence worth knowing

`asset` is compared case insensitively against the symbol the resolved chain's
payment adapter declares. It is a label, so rejecting it cannot move a cent; the
check exists so the public catalog does not advertise a token the rail does not
actually settle.

The consequence is that the right value depends on the rail, and it is not always
`USDC`. Measured in this tree:

| Chain | Symbol the adapter declares | Source |
|---|---|---|
| `solana-devnet` | `USDC` | `src/adapters/solana/payment.ts:82` |
| `avalanche-fuji`, `avalanche-mainnet` | `USDC` | `src/adapters/avalanche/payment.ts:56` |
| `kite-ozone-testnet` | `X402_TOKEN_SYMBOL` if set, otherwise `PYUSD` | `src/adapters/kite-ozone/payment.ts:253` and `:164` |
| `kite-mainnet` | `X402_TOKEN_SYMBOL` if set, otherwise `USDC.e` | `src/adapters/kite-ozone/payment.ts:253` and `:165` |
| `tempo-testnet` | `AlphaUSD` | `src/adapters/tempo/payment.ts:61` |

So `"asset": "USDC"` is correct on Solana and Avalanche and is a `422` on Kite
testnet today. If you do not want to track this, leave `asset` out: it is optional
and nothing depends on it.

#### What this does not do

Publishing a `payment` block does not prove you control that wallet. The gateway
checks the format, the chain, and that the address is not its own; it does not ask
you to sign anything. Declaring someone else's wallet gives them your earnings, so
the damage is to you, not to them.

Nothing is migrated either. Agents that already have a `payment` block keep it
exactly as stored, and this write path never rewrites, normalizes or re-validates a
block it did not just receive.

### `/discover` response contract

`GET /discover` and `POST /discover` return:

```json
{
  "agents":  [ /* ... */ ],
  "total":   42,
  "registries": ["kite-registry", "self-published"]
}
```

- **`agents`** — the page: **up to `limit`** agents that match every filter you
  passed, sorted verified-first → reputation desc → price asc. When you pass a
  `limit`, you get exactly `min(limit, total)` agents.
  - **`limit` must be a safe integer `>= 1`** (i.e. `<= 2^53-1`). Anything else
    (`0`, negative, fractional, non-numeric, or beyond the safe-integer range like
    `1e21`) returns `400 INVALID_LIMIT`. Omitting `limit` returns **every** match,
    with no page size. This is validated so the guarantee above actually holds:
    before validation, `limit=0` returned the whole catalogue, `limit=-3` returned
    `total - 3` agents, and `limit=1e21` was forwarded upstream verbatim as
    `1e+21` — a registry that rejected the malformed parameter made the gateway
    answer `200` with **zero** agents. All three failed silently.
- **`total`** — the number of agents that match **all** your filters, **before**
  `limit` is applied. This is the pagination denominator, so
  `total >= agents.length`. It is **not** the size of the page — do not use it to
  size a loop over `agents`.
- **`agents[].payment`** — how that agent charges. `method` and `chain` are what the
  agent **declared** in its card; `contract` is its **payout wallet** (the x402
  `payTo`), despite the name it is not a token or contract address. Two more fields
  are **derived by the gateway**, because a declared alias does not have to state its
  environment (`avalanche` is the most common one in the live catalog and it resolves
  to Fuji): `resolvedChain` is the canonical rail the gateway resolved `chain` to
  (e.g. `avalanche` → `avalanche-fuji`) and `network` is `"testnet"` or `"mainnet"`.
  What `network` guarantees, stated narrowly: either the payment lands on that
  environment or there is no payment — the outbound leg compares the rail's declared
  environment against the real destination before signing and skips the leg when they
  disagree. It does **not** claim which chainId the deploy points at.
- **`registries`** — names of the registries that contributed candidates.
- **`excluded`** — `{ scope, reputation, trialAvailable, standingUnavailable }`: how
  many candidates each candidacy filter discarded (and whether the reputation read
  itself failed), counted **before** sorting and paging. It exists so an
  empty result can explain itself: without it, "there is no such agent" and "there is
  one but your credential cannot reach it" (or "there is one but it does not meet
  your reputation floor") are the same message, and they send you looking in the
  wrong place.

Filters are applied by the gateway (status, `verified`, `capabilities`, free-text
`q`, `maxPrice`, `minReputation`), not by the upstream registries, so `limit` only
ever trims the final, already-filtered and already-sorted set.

#### The complete list of accepted parameters

These are the **only** parameters `GET /discover` and `POST /discover` accept.
The same names work in the query string (GET) and in the JSON body (POST).

| Parameter | Type | What it does |
|---|---|---|
| `allowTrial` | `'true'` / `'false'` (GET), boolean (POST) | Opt in to the trial lane for agents with no settled history (see below). Omitted = not opted in. |
| `capabilities` | comma-separated string, or array in POST | Keep only agents that declare **all** of these capabilities. Note the **plural**: `capability` is not a parameter. |
| `includeInactive` | `'true'` (GET), `true` (POST) | Include agents whose status is not active. |
| `limit` | safe integer `>= 1` | Page size. Omitted = every match, unpaged. |
| `maxPrice` | number | Maximum price per call, in USDC. |
| `minReputation` | number in `[0, 100]` | Minimum gateway-computed off-chain score. |
| `min_reputation` | number in `[0, 100]` | **Alias of `minReputation`** — see below. |
| `q` | string | Free-text search. This is the public name; `query` is **not** a parameter. |
| `registry` | string | Restrict the search to one registry by name. |
| `verified` | `'true'` (GET), `true` (POST) | Keep only verified agents. |

**`min_reputation` is accepted as an alias of `minReputation`**, on both `GET` and
`POST`, with the same validation and the same result: the two names are parsed by
the same validator and collapse into the same filter before anything else runs.
It exists because the same concept is already called `min_reputation` in the
`constraints` of `/compose`, in this same API. Sending both names with two
different values returns `400 CONFLICTING_MIN_REPUTATION` — they are one filter,
so two incompatible floors cannot both be honoured, and picking one silently
would discard a floor you asked for. Sending both with the same value is fine.

> If you want a single spelling that works on **both** surfaces — `/discover` and
> the `constraints` of `/compose` — use **`min_reputation`**.

**Any parameter not in the table above returns `400 UNKNOWN_DISCOVER_PARAM`**,
and the error message names the offending key and lists the accepted ones, so you
can fix it without coming back to this page. This endpoint used to ignore
unrecognised keys and answer `200`, which meant a misspelled filter looked exactly
like a filter that matched everything: `?capability=payout` (singular) returned
the whole catalogue instead of the one agent that serves it. Discovery is the free
call where you decide who to pay, so a parameter ignored here is paid for on the
next call.

> The key is echoed back **truncated at 64 UTF-16 code units**, and the message
> says so along with the length you sent, in the same unit. Legitimate parameter
> names are far shorter than that (the longest one accepted, `includeInactive`,
> is 15), so this only affects keys built to make the error response large.

**`minReputation`** filters on the **gateway-computed off-chain score**
(`agent.computedReputation.score`), scale **0-100** — derived from tasks the agent
actually settled and paid for, with an anti-sybil cap per caller. It deliberately
does **not** consider the `reputation` value a registry self-reports for its own
agents: a quality filter whose input is controlled by the party being filtered is
not a filter. Consequences:

- An agent with no settled tasks scores `0` and is **excluded** whenever
  `minReputation > 0` — **unless you opt in to the trial lane with `allowTrial`**
  (see below). Without that opt-in, this is unchanged.
- A value that is not a number in `[0, 100]` returns
  `400 INVALID_MIN_REPUTATION` — it is never silently ignored.

#### `allowTrial` — the trial lane for agents with no history

A brand-new agent has no settled tasks, so it has no score, so any floor above `0`
excludes it. That is correct as a default and wrong as a permanent state: it means a
capability served **only** by new agents can never be resolved, and the marketplace
cannot admit new supply.

`allowTrial: true` (query param on `GET /discover`, boolean field on `POST /discover`,
`constraints.allow_trial` on a `/compose` capability step) opts **you**, the caller,
into accepting such a candidate below the floor **you** asked for. Rules:

- **The default is OFF.** Omit it (or send `false`) and you get today's behaviour,
  byte for byte. The gateway never relaxes a floor you asked for on its own: you set
  the floor, you carry the risk, so you make the call.
- **The admitted agent keeps its real score** (`0`, or its real low score). It is
  **not** given a synthetic score to "make it pass", so it sorts **last** and can
  only ever be chosen when **no** agent qualifies on merit. Publishing a hundred new
  agents does not displace one with a reputation.
- **An admitted agent is surfaced with `verified: false` and with `reputation` set to
  its real computed score.** Ranking reads `verified` first and, with no computed
  score, falls back to the `reputation` value on the agent card, and both of those are
  **self-reported by the agent**. A federated agent declaring `{"reputation": 100,
  "verified": true}` would otherwise sort **first** while having no history at all, and
  `/compose` picks the head of the list. So for a trial-admitted agent the gateway
  replaces both claims with what it can verify, in the ranking **and** in the payload.
  Nothing else about the card is touched, and no other agent is affected.
- **The lane only ever applies to an agent the floor would have excluded.** An agent
  that already meets `minReputation` on its own passes on merit, is **not** badged,
  and keeps its card untouched — including when it is still inside the lane by task
  count (with `N = 3`, an agent with 1 or 2 settled tasks has a real score and can
  clear a low floor by itself). Turning `allowTrial` on therefore **cannot** change
  the relative order of agents that already have history, which is what makes it safe
  to switch on for a `/compose` step that picks the head of the list.
- **`allowTrial` and `verified=true` do not combine.** If you filter by
  `verified=true`, the trial lane admits nobody. That filter selects on a claim the
  agent card makes about itself, and trial admission replaces that claim precisely
  because it is not evidence; returning an admitted agent would put a
  `verified: false` agent inside a response to a `verified=true` query. The
  conservative direction wins: the lane narrows, the filter is never contradicted.
- **It is always visible.** An admitted agent carries
  `trial: { granted: true, under_min_reputation, tasks_settled, remaining_settled_tasks }`.
  A floor relaxed in silence would be a worse bug than the one this feature fixes.
- **The lane runs out on its own**, three ways, none of which need anyone to
  intervene: after `N` settled paid tasks the agent leaves the lane and stands on its
  real score; `failed` events from `F` **distinct callers** **void** the lane (a void,
  not a decrement); and a floor above the trial ceiling `T` gets no trial at all —
  asking for a high floor is asking for a proven agent, and the lane does not fake one.
- **Voiding needs independent callers, and it does not expire.** It counts *callers*
  and not failures on purpose: one caller retrying against an agent that was down for
  thirty seconds would otherwise void that agent's lane permanently, and a third party
  could burn a competitor's lane with a single cheap call. Only **identified** callers
  count: a failure with no caller identity (any x402 call without an agent key) is not
  "a caller", it is "we do not know who", so it adds nothing to that tally — otherwise
  an attacker holding one identity would get the second one for free. Failures from
  anonymous callers still lower `success_rate`, and with it the real score. The
  void has no expiry: a voided agent is still discoverable and hireable by anyone who
  does not ask for a floor, so it can still earn settled tasks and leave the lane on
  merit. The lane is a shortcut, and only the shortcut closes.
- **There is a per-publisher quota** `M`: with more eligible agents from the same
  publisher, the `M` oldest by creation date keep the trial. Publishing a hundred
  agents from one account buys `M` trials, not a hundred.
- **For agents that come from a federated registry, the quota is per registry and the
  `M` slots are drawn per request.** The gateway does not know who published a card in
  someone else's catalogue, so the finest anchor available is the registry itself: a
  registry with many independent publishers therefore shares one quota, which
  under-admits rather than over-admits. Those agents also carry no creation date we
  can trust, so the `M` slots are decided by a **draw per request** instead of by name.
  That is deliberate: any fixed ordering (alphabetical, or a hash) would hand the lane
  permanently to whoever picks the right slug and would leave everyone else out
  forever. The draw is fixed once per request, so a single `/compose` pipeline still
  resolves the same capability to the same agent.
- **If the gateway cannot read an agent's history, nobody is admitted.** "I could not
  ask" is not "it has no history".
- Anything other than `true`/`false` returns `400 INVALID_ALLOW_TRIAL`.

**`allowTrial` alone does nothing: it needs `minReputation`.** The lane is evaluated
inside the same step that applies the floor, so a request that opts in without asking
for a floor is accepted, returns `200`, and runs no lane at all. That is coherent — with
no floor nobody is excluded, so there is nothing to relax — but you should not have to
read our source to find it out, so the response says so: `excluded.trialEvaluated` is
`false` in exactly that case. Send `minReputation` too.

Three response fields go with it:

- `excluded.reputation` — candidates the floor discarded.
- `excluded.trialAvailable` — candidates that are **eligible** for the lane. With
  `allowTrial: true` this is **exact** and equals the number of `trial` badges in
  `agents`, **except when the same slug appears in more than one registry**, in which
  case it can read **lower** than the number of badges (the admitted set is keyed by
  bare slug). **Without** `allowTrial` it is an **upper bound**: the per-publisher
  quota needs a lookup that the default path deliberately does not perform, so the
  number is counted before the quota is applied. Read it as "up to N", not as "N will
  be admitted". **Read `excluded.trialEvaluated` first**: when that is `false` this
  number was never computed and the `0` means nothing.
- `excluded.trialEvaluated` — `false` means the lane **was not evaluated** in this
  query, which happens exactly when you did not send `minReputation`. It is there so a
  `trialAvailable` of `0` cannot be misread: "I looked and nobody qualifies" and "I
  never looked" lead to different actions, and only the second one is fixed by changing
  your request. It reports what the **gateway did**, not what you asked for: with a
  floor and no `allowTrial` it is `true`, and `trialAvailable` is the upper bound
  described above.
- `excluded.standingUnavailable` — `true` means the gateway **could not read agent
  history** for this query. Then nobody has a computed score, so the floor excludes
  everyone and `excluded.reputation` counts real exclusions that do **not** mean "these
  agents fall short". Lowering the floor or setting `allowTrial` will not help; the
  trial lane is fail-closed in this case on purpose. Retry instead. A `/compose` step
  in that situation fails with `reason: 'reputation_unavailable'`, which is a separate
  reason from `excluded_by_reputation` for exactly this distinction.

⚠️ **`total` grows when agents are admitted by the trial lane.** That is correct
(`total` is the count of matches for the filters as applied), but it is an observable
change if you paginate with `allowTrial: true`.

`N`, `T`, `M` and `F` are gateway configuration (`TRIAL_MAX_SETTLED_TASKS`,
`TRIAL_MAX_MIN_REPUTATION`, `TRIAL_MAX_AGENTS_PER_PUBLISHER`,
`TRIAL_MAX_FAILED_CALLERS`). Their current values
are **provisional** and pending ratification, so do not hardcode them client-side:
read `trial.remaining_settled_tasks` if you need to know how much lane is left.

A `/compose` step whose candidate set was emptied **by the floor** now fails with
`reason: 'excluded_by_reputation'` instead of `no_candidates`, and the message names
`allow_trial` when a trial candidate is available. `no_candidates` now means what it
says: nothing serves that capability.

### Protocol fee (pricing)

WasiAI charges a **protocol fee** on orchestrated pipelines and publishes it in
the response, so you never have to guess the take rate.

- **Default rate: 1%.** This is the documented default. The operator can override
  it via the `PROTOCOL_FEE_RATE` env var (a fraction, e.g. `0.01` = 1%), clamped
  to `[0, 0.10]`; invalid values fall back to `0.01`. Do not hardcode the rate in
  your client — read it from the quote instead (see below).
- **Base: the real executed cost of the pipeline**, not your declared `budget`.
  A larger `budget` does not increase the fee.

Two fields carry the fee. `POST /orchestrate/plan` (the quote) returns **both**:

| Field | Type | Meaning |
|-------|------|---------|
| `protocolFeeUsdc` | number (USDC) | The fee **amount** for this specific plan. Also returned by `POST /orchestrate` and `POST /orchestrate/execute`. |
| `feeRatePercent` | number (percent) | The effective fee **rate** as a percent (e.g. `1` for 1%). Returned by `POST /orchestrate/plan`. This is the runtime source of truth for the rate, reflecting the operator's effective value after the clamp. |

Consistency guarantee: `protocolFeeUsdc ≈ totalCostUsdc × (feeRatePercent / 100)`
within rounding tolerance. `protocolFeeUsdc` is the **real cost-based fee**, so it
reconciles with `feeRatePercent` by construction.

`maxQuotedCostUsdc` (also in the quote) is a **safety ceiling** the `execute` call
enforces, not `totalCostUsdc + protocolFeeUsdc`. The invariant is
`maxQuotedCostUsdc ≥ totalCostUsdc + protocolFeeUsdc`: the ceiling **can exceed**
cost + fee when an agent has not yet quoted a price (a placeholder headroom is added
so the pre-authorized cap never underestimates). Do not derive the fee from
`maxQuotedCostUsdc − totalCostUsdc`; read `protocolFeeUsdc` / `feeRatePercent`.

On non-`ready` plan outcomes (`no_agents`, `budget_exhausted`,
`insufficient_funds`, `no_relevant_agent`) there is no pipeline, so
`protocolFeeUsdc` is `0` and `feeRatePercent` is omitted — no misleading
"charged" fee is reported when nothing ran. `POST /orchestrate` and
`POST /orchestrate/execute` return the amount (`protocolFeeUsdc`) but not
`feeRatePercent`; use `POST /orchestrate/plan` to read the rate before executing.

### Price freeze: the signed `quote` (10-minute guarantee)

Between `POST /orchestrate/plan` (which quotes) and `POST /orchestrate/execute`
(which runs and debits) an agent's price can change. Without a quote, `execute`
re-resolves prices **live** and the only thing stopping a change is the
`maxQuotedCostUsdc` ceiling you declared: if the price moved but stayed under the
ceiling, **you are debited the new price you never approved**.

A `plan` that comes back `ready` therefore also returns a **signed quote** that
freezes, per step, both the **price** and the **agent identity** (slug +
registry) for exactly **10 minutes**:

```jsonc
{
  "planStatus": "ready",
  "costPerStep": [0.05, 0.06],
  "maxQuotedCostUsdc": 0.1211,

  "quote": "v1.eyJiaW5kIjoi….a3f…",            // opaque token — send it back as-is
  "quoteExpiresAt": "2026-07-28T14:31:07.000Z" // informational; the real exp is signed inside
}
```

Send it back on execute (the field is **optional**):

```jsonc
{
  "orchestrationId": "…",
  "steps": [ /* the same steps, same order, same agents */ ],
  "maxQuotedCostUsdc": 0.1211,  // ⚠️ IGNORED when the quote is valid — see below
  "budget": 1.0,
  "quote": "v1.eyJiaW5kIjoi….a3f…"
}
```

> ⚠️ **With a valid quote, `maxQuotedCostUsdc` is ignored: the frozen price IS the
> ceiling.** The field stays in the schema (it is still required, and it is what
> applies when you send no quote), but the ceiling check does not run on a quoted
> execution — it re-resolves live prices, and rejecting a caller who holds a price
> guarantee because of a live price that no longer affects them would defeat the
> guarantee. If you were using `maxQuotedCostUsdc` as a second safety net, note that
> **on a quoted execution the guarantee replaces it**: you are charged the frozen
> total and nothing else, which is by construction ≤ the ceiling you approved.

With a valid quote you are debited the **frozen** price and the **frozen** agent,
never the live ones. **The freeze is exact in both directions**: if the live price
went up the gateway absorbs the difference; if it went **down you are still
charged the frozen price**, because charging a different number — even a cheaper
one — means charging a price you did not approve. (The agent downstream still
receives its own live price; that is not affected.)

The token is opaque: do not parse it, do not modify it, just store and return it.
It is self-contained and verified with a server-side secret — there is no session
or database row behind it.

**Errors** (all five share the same body shape):

```json
{ "error_code": "QUOTE_EXPIRED", "requiresNewQuote": true }
```

| HTTP | `error_code` | When |
|---|---|---|
| 400 | `QUOTE_INVALID` | malformed token, signature does not verify, invalid payload, or a non-positive frozen price |
| 409 | `QUOTE_EXPIRED` | more than 10 minutes since it was issued |
| 403 | `QUOTE_CALLER_MISMATCH` | the quote was issued to a different credential than the one presenting it |
| 400 | `QUOTE_STEP_MISMATCH` | different number of steps, or a different `agent`/`registry` at some index |
| 409 | `QUOTE_AGENT_UNAVAILABLE` | a frozen agent no longer resolves in any enabled registry |

**None of these debit anything.** All the checks run before any money moves, so a
rejected redemption always leaves your balance untouched. On any of them, ask for
a new plan and use the fresh quote. A mismatched step is **rejected, not
corrected**: the gateway will not silently swap in the agent from the quote,
because your `input` was written for the agent you asked for.

**Binding.** A quote is tied to the **exact credential** that requested the plan
(agent key, delegation, or key session). The same owner using a *different* key
cannot redeem it, and a caller that pays per-request via x402 cannot get or
redeem a quote at all (there is no stable credential to bind to). In that case
both fields are simply absent from the plan response.

**When no quote is issued.** `quote` and `quoteExpiresAt` are omitted entirely
(the keys are not present) when the plan is not `ready`, when any step has no
resolved price, when the caller is not bindeable, or when the server has no quote
secret configured. That response is byte-for-byte what the endpoint returned
before this feature existed, so **omitting the field keeps the old behaviour**:
live price re-resolution against `maxQuotedCostUsdc`, with `409 QUOTE_STALE` if
it is exceeded. Existing integrations need no changes.

> ⚠️ **A quote can be redeemed more than once within its 10 minutes.** This is a
> deliberate trade-off, not an oversight: single-use would require durable
> storage, and the quote is intentionally storage-free. It is **not** double
> billing — each redemption runs a real pipeline and is charged its own amount
> (two redemptions = two executions = two charges). What repeats is the *price
> guarantee*, honoured twice. It is also not a way around your limits: every
> redemption still goes through budget, daily limits and per-destination caps.
> The bounded effect is that, for up to 10 minutes, you may run N pipelines at
> the old price instead of the new one — and only when the price went up.
>
> **What this means for your retry logic.** A quote is *not* an idempotency key.
> If a request times out or a connection drops and your client retries
> `POST /orchestrate/execute` with the same `quote`, you get a **second real
> execution and a second charge** — the gateway has no way to tell that retry
> apart from a deliberate second run. The rule that "a rejected redemption never
> charges" applies to the five `error_code` rejections above; it does **not** make
> re-sending a valid quote free. Treat a retry of `execute` exactly as you would
> treat a retry of any other billable call: only retry when you know the previous
> attempt did not run.

**Key rotation.** The signing secret lives only on the server. If the operator
rotates it, every quote issued with the previous secret stops verifying and comes
back as `400 QUOTE_INVALID` — request a new plan. If the secret is removed
entirely, plans stop returning quotes and any quote presented is rejected
(fail-closed); execution keeps working through the live-price path.

**Fee vs service price.** The `protocolFeeUsdc` is separate from what the
composed agents cost. Each agent charges its own service price (`stepPrice_i`)
for the work it does; those prices are the bulk of `totalCostUsdc`. The 1%
protocol fee is levied once on top of that total. So a caller pays
`totalCostUsdc + protocolFeeUsdc`: the agents' prices plus a 1% protocol fee, not
1% total. How WasiAI internally distributes that 1% (a platform / creator /
referral split, resolved on the pipeline's primary agent) does not change what
you pay and is documented in
[`doc/architecture/FEE-MODEL.md`](architecture/FEE-MODEL.md).

### `/compose` — downstream settlement per step

Each entry of `steps[]` reports whether WasiAI forwarded payment to that agent
(the "downstream leg"). Exactly one of the two shapes is present:

**Settled** — the agent was paid on-chain:

```json
{
  "downstreamTxHash": "0x…",
  "downstreamBlockNumber": 12345,
  "downstreamSettledAmount": "500000"
}
```

**Skipped** — the leg did not settle, and now the response says why
(additive field, added by the P1 fix-pack; previously the reason existed only in
server-side logs):

```json
{ "downstreamSettle": "skipped:NO_PAYMENT_FIELD" }
```

| Code | Meaning | What to do |
|------|---------|------------|
| `NO_PAYMENT_FIELD` | The agent's card declares no `payment` block. | Ask the agent operator to publish a payment spec. |
| `METHOD_NOT_SUPPORTED` | The agent's `payment.method` is not x402. | Not payable through this rail. |
| `CHAIN_NOT_SUPPORTED` | The agent's `payment.chain` is not a rail this gateway settles. | Ask the agent to declare a supported chain. |
| `INVALID_PAY_TO_FORMAT` | The agent's `payment.contract` is not a valid address for its chain. Despite the name, that field is the agent's **payout wallet** (the x402 `payTo`), not a token or contract address. | Agent-side config error. |
| `ZERO_PAY_TO` | The agent's payout address is the zero address. | Agent-side config error. |
| `INVALID_PRICE` | The agent's price is not a finite positive number. | Agent-side config error. |
| `SETTLE_FAILED` | The payment was attempted and did not go through. | Retryable. |
| `NOT_CONFIGURED` | This gateway is not configured to settle that leg. | Operational, not your request. Contact support if persistent. |
| `UNAVAILABLE` | The gateway could not settle right now. | Retryable. Contact support if persistent. |

The first six describe **the agent's own declaration** (the same data you can see
in `GET /discover`), so they are reported verbatim and are actionable.
`NOT_CONFIGURED` and `UNAVAILABLE` are deliberately coarse: the finer-grained
internal reasons would disclose gateway configuration, operator wallet state or
key status, so they are not exposed. Do not build logic that depends on
distinguishing them.

Being skipped does **not** fail the step: the agent still ran and you are still
billed for the pipeline. `downstreamSettle` tells you about the *payout* leg.

### `/compose` — passing one field from the previous step (`inputFromPrevious`)

Sometimes a step needs a value that does not exist yet when you write the request.
A remittance is the canonical case: the quote step mints a `quoteId`, and the
payout step needs it. You cannot send it up front, and the payout agent should not
learn to read `previousOutput.quoteId` — that would turn it into "step 3 of a
remittance pipeline" and it would stop being callable on its own.

`inputFromPrevious` moves that one field for you:

```jsonc
{
  "steps": [
    { "agent": "remit-corridor-fx",    "input": { "corridor": "US-PE", "amountUsd": 400 } },
    { "agent": "remit-cashout-payout", "input": { "method": "yape" },
      "inputFromPrevious": { "quoteId": "quoteId" } }
  ]
}
```

Read it as an assignment: **`{ destination: source }`**, i.e.
`input[destination] = previousStepOutput[source]`. The destination — the name the
agent sees — is on the key side, like an alias in SQL or GraphQL. Here the payout
agent receives `{ "method": "yape", "quoteId": "<the id the fx step returned>" }`.

**This is not an expression language.** Each entry is a single lookup of a
single top-level key. There are no dot-paths, no JSONPath, no functions, no
defaults, and no access to any step other than the immediately previous one. A `.`
inside a key is just a character: `{"x": "a.b"}` against `{"a": {"b": 1}}` does
**not** resolve — it fails with `SOURCE_FIELD_MISSING`.

Rules, all validated **before you are charged**:

| Rule | Detail |
|------|--------|
| Optional | Omit it and nothing changes. A pipeline without mappings behaves exactly as before. |
| Object, not array | Must be a non-null, non-array object. |
| 1 to 8 entries | `{}` is **rejected**, not treated as a no-op: a mapping that maps nothing is a caller error. |
| Strings, ≤ 128 chars | Every key and every value must be a non-empty string of at most 128 characters. |
| No reserved names | `__proto__`, `constructor` and `prototype` are rejected as key **and** as value. |
| Not `previousOutput` | That key belongs to `passOutput`; two writers of the same field is not allowed. |
| Destination must be free | If the key already exists in this step's `input`, the request is rejected instead of silently overwriting the value you sent. |
| Not on step 0 | There is no previous step. |

**It coexists with `passOutput`.** They do different things: `passOutput: true`
injects the whole previous output under `previousOutput`, while
`inputFromPrevious` promotes individual fields to the top level. You can use both
on the same step.

The value is copied **verbatim** — not cloned, not coerced, not stringified. A
`null` in the previous output is a *present* value and is mapped as `null`: the
gateway does not invent a "null does not count" rule over another agent's data.

The mapping reads the previous output **after** the bridge (A2A unwrap / LLM
transform), so it sees exactly the same object `passOutput` would have injected.

**If the agent rejects a mapped field, the step is not retried.** WasiAI normally
retries a step once when the agent replies `4xx` naming the fields it could not
accept. That retry is skipped when any of those fields is a mapping *destination*,
because the mapping would re-write it with the same value the agent just
rejected — the canonical case is an **expired `quoteId`**. Retrying would be
guaranteed to fail while still costing you a second round-trip. You get the
agent's original error instead, which is the same answer you would have received
after paying for the second attempt. A rejected field that is *not* a mapping
destination retries exactly as before.

`inputFromPrevious` also works on `POST /orchestrate/execute`, with the same rules
and the same pre-charge validation.

---

## 4. x402 Payment Flow

x402 lets a client pay per request with a single EIP-712 signature — no pre-funded account, no gas held by the client at payment time. The gateway implements [x402 v2](https://x402.org/) and settles through the [Pieverse](https://pieverse.io) facilitator on Kite Ozone testnet.

### Asset and network

- **Network:** Kite Ozone testnet (chain id `2368`)
- **Asset:** `PYUSD` (EIP-3009 compliant), contract `0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9`
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
          "asset": "0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9",
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

4. **Gateway verifies + executes.** The gateway asks Pieverse to verify the signature, settles the PYUSD transfer on-chain, then executes the request. The response carries the business result; on failure the gateway returns the appropriate HTTP code and does not settle.

A complete, runnable reference implementation lives in [`scripts/demo-x402.ts`](../scripts/demo-x402.ts). It uses `viem` to sign and targets the production gateway; point it at your own base URL by passing it as the first argument.

```bash
npx tsx scripts/demo-x402.ts https://wasiai-a2a-production.up.railway.app
```

### 4.1 Paying in Solana (devnet) — WKH-314

The x402 cycle above is EVM. Solana works the same way at the protocol level and
differently at the wallet level, because Solana has no EIP-3009: **you do not sign an
authorization we then execute — you execute the transfer yourself and show us the
signature.**

**You pay the network fee.** The gateway does not sponsor this transfer, does not build
it and never signs anything on this path: it is a witness, not a treasurer. There are no
sponsor compute limits to hit here, because there is no sponsor.

**This path is OFF by default and devnet-only.** When it is off, asking to pay in Solana
answers `400 CHAIN_INBOUND_PAYMENT_UNSUPPORTED` with the list of chains that do accept
inbound payment. Check `GET /capabilities` — `chains[].acceptsInboundPayment` tells you
whether a chain will take your money before you send any.

**1. Ask for the challenge.** Send `x-payment-chain: solana-devnet` with no payment
header. The `402` carries the tuple you need:

```json
{
  "error": "payment-signature header is required",
  "x402Version": 2,
  "accepts": [
    {
      "scheme": "exact",
      "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      "maxAmountRequired": "1000000",
      "payTo": "<base58 pubkey>",
      "asset": "<USDC mint, base58>",
      "extra": {
        "reference": "<base58 32-byte pubkey>",
        "issuedAt": 1755600000,
        "expiresAt": 1755600900,
        "nonce": "<base58, per-issuance>"
      }
    }
  ]
}
```

`maxAmountRequired` is in **atomic units** of that mint (6 decimals for USDC), as a
string. `expiresAt` is an **absolute** unix timestamp, not a duration.

**2. Send the transfer.** An SPL transfer of `maxAmountRequired` of `asset` to `payTo`,
signed and paid for by you, with **`reference` added to the transfer instruction as a
read-only, non-signer account** (the Solana Pay convention). The reference is what ties
your transaction to this specific charge; a transfer without it is a real payment for
nothing we can attribute.

**3. Wait for finality, then present the signature.** Base64 the envelope and retry:

```json
{
  "authorization": {
    "reference": "<from the 402>",
    "payTo": "<from the 402>",
    "amountAtomic": "<maxAmountRequired>",
    "mint": "<asset>",
    "issuedAt": 1755600000,
    "expiresAt": 1755600900,
    "nonce": "<from extra.nonce>"
  },
  "signature": "<your transaction signature, base58>",
  "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
}
```

Echo the seven `authorization` fields **exactly as they came**: they are covered by a
MAC, so changing any of them —including `expiresAt` and `nonce`— invalidates the
reference.

**A challenge is valid for the price it quoted.** `extra.nonce` is fresh entropy on every
402, so two challenges are never interchangeable even when every other field matches, and
the amount, recipient and mint are checked against what this endpoint charges **now** —
not only against the MAC. If the price of the call changed, or the recipient wallet or the
mint rotated, ask for a fresh 402. Your signature is not consumed by any of those
rejections.

**Finality is a precondition.** The gateway grants access only when the chain reports
your transaction as `finalized`. Presenting it earlier answers
`X402_SOLANA_NOT_FINALIZED` with a `Retry-After`, and **your proof is not consumed** —
present the same signature again once it finalizes.

#### What each rejection means, and whether your signature is still spendable

Every one of these is HTTP `402`. **None of them consumes your proof** except
`X402_SOLANA_PROOF_REPLAY`, which reports one that was already consumed.

| `error_code` | What happened | Retryable | Signature still spendable |
|---|---|---|---|
| `X402_SOLANA_PROOF_MALFORMED` | The envelope is missing a field, or `signature` is not base58 of 64 bytes | no — fix the envelope | yes |
| `X402_SOLANA_REFERENCE_MISMATCH` | The reference does not re-derive from our secret, or it is not among the accounts of that transaction | no — get a fresh challenge | yes |
| `X402_SOLANA_CHALLENGE_EXPIRED` | The challenge expired, or the transaction landed outside its window | no — get a fresh challenge | yes |
| `X402_SOLANA_AMOUNT_SHORT` | The recipient was credited **less** than required, or the challenge you presented was issued for a lower price than this call costs now | no — waiting will not help | yes |
| `X402_SOLANA_TERMS_MISMATCH` | Wrong mint, wrong recipient (including a challenge issued before the recipient wallet or the mint changed), or that signature is already recorded against a different charge | no | yes |
| `X402_SOLANA_TX_FAILED` | The transaction landed and failed on-chain: nothing moved | no | yes |
| `X402_SOLANA_NOT_FINALIZED` | Landed, not finalized yet | **yes** (`Retry-After`) | yes |
| `X402_SOLANA_PROOF_ABSENT` | The node(s) we asked searched their history and do not know that signature. The message says how many actually searched: with a second RPC provider configured it takes **two** independent nodes, without one it is **a single opinion** | **yes** (`Retry-After`) | yes |
| `X402_SOLANA_PROOF_REPLAY` | That signature already bought service | no | **no — already spent** |
| `X402_SETTLE_UNKNOWN` | We could not ask the chain or our own ledger. Not a verdict about your payment | **yes** (`Retry-After`) | yes |

Two things worth internalising, because they are the difference between this path and a
naive one:

- **A Solana signature is not single-use by itself.** Unlike an EIP-3009 nonce, nothing
  on-chain stops you from presenting the same landed transaction again — it is already
  written, there is nothing left to spend. The single-use ledger lives in the gateway,
  and it is keyed on `(chain, signature)`.
- **`X402_SETTLE_UNKNOWN` is not "no".** It means the question could not be answered:
  about the chain, or about our own single-use ledger. No path that returns it grants
  access, and no path that returns it *intends* to consume your proof — retrying is the
  right move.
  **One honest caveat**, because "we never consume it" would be a stronger claim than the
  code can make: if the consuming write commits and its acknowledgement is lost in
  transit, we report `X402_SETTLE_UNKNOWN` without knowing whether the ledger recorded the
  consumption. In that narrow case your retry can come back as
  `X402_SOLANA_PROOF_REPLAY`. It is the residue of a single-use ledger over an unreliable
  network, it is not silent, and it never grants access to anyone else.

---

## 5. Error Codes

All errors share a normalized JSON shape:

```json
{ "error": "human-readable message", "code": "MACHINE_READABLE", "requestId": "..." }
```

| HTTP | Meaning in this API | Recommended action |
|------|---------------------|--------------------|
| `400 Bad Request` | A query/body parameter is malformed or unrecognised. The `code` field says which: `INVALID_MIN_REPUTATION` (`minReputation` / `min_reputation` on `/discover` is not a number in `[0, 100]`), `INVALID_LIMIT` (`limit` is not a safe integer `>= 1`), `INVALID_ALLOW_TRIAL` (`allowTrial` is neither `true` nor `false`), `UNKNOWN_DISCOVER_PARAM` (a key `/discover` does not accept — the message names it and lists the accepted ones), `CONFLICTING_MIN_REPUTATION` (`minReputation` and its alias `min_reputation` were sent with different values), `INVALID_DISCOVER_BODY` (the `POST /discover` body is an array or a primitive instead of a JSON object). | Fix the parameter. `minReputation` uses the **0-100** off-chain score scale, not 0-1. For `UNKNOWN_DISCOVER_PARAM`, the accepted keys are listed in [the complete list of accepted parameters](#the-complete-list-of-accepted-parameters) and in the error message itself. |
| `401 Unauthorized` | Not emitted by the application layer. May appear from infrastructure (CDN, reverse proxy) if your request is dropped before reaching the app. | Check the URL, TLS, and that your `Authorization` header is well-formed. If you need auth, this API uses `403` (see next row). |
| `402 Payment Required` | The endpoint needs payment and none was provided. Body includes `accepts[]` with full x402 payment instructions. Note: a request whose *shape* is invalid is rejected with `400` **before** the `402` is emitted, so you never pay to find out the body was malformed (see [5.1](#51-rejected-requests-what-you-are-charged-and-what-is-refunded)). | Sign the EIP-712 authorization, base64-encode the payload, retry with `PAYMENT-SIGNATURE`. Alternatively attach a valid `x-a2a-key`. |
| `403 Forbidden` | Either no a2a credential was provided on a tenant-scoped endpoint (`error_code: A2A_KEY_REQUIRED` on `/registries` mutations and all of `/tasks` — returned **before any charge**), or an `x-a2a-key` / Bearer was provided but rejected. In the second case the `error_code` field tells you why: `KEY_NOT_FOUND`, `KEY_INACTIVE`, `DAILY_LIMIT`, `INSUFFICIENT_BUDGET`, `SCOPE_DENIED`, `PER_CALL_LIMIT`. The two `/tasks` reads are free, so they never answer the spend-related codes (`DAILY_LIMIT`, `INSUFFICIENT_BUDGET`, `PER_CALL_LIMIT`): nothing is charged, so nothing can be short. Credential problems (`A2A_KEY_REQUIRED`, `KEY_NOT_FOUND`, `KEY_INACTIVE`, and the delegation / key-session codes for those credential types) are still returned. | `KEY_NOT_FOUND`/`KEY_INACTIVE` → verify the key you are sending and that it has not been disabled. `DAILY_LIMIT`/`INSUFFICIENT_BUDGET` → top up or wait for the daily reset. `SCOPE_DENIED` → request a wider scope from the key owner. `PER_CALL_LIMIT` → lower `budget` in the request body. |
| `400` with `errorCode: INPUT_MAPPING_FAILED` | A step's `inputFromPrevious` could not be resolved against the previous step's output. The `inputMappingFailure` object tells you which step, which field and why: `SOURCE_FIELD_MISSING` (the source key is not in the previous output — remember a `.` is a character, not a path), `PREVIOUS_OUTPUT_NOT_OBJECT` (the previous output is `null`, an array or a primitive, so there are no top-level keys to read), `INVALID_MAPPING_SHAPE` (the mapping itself is malformed). | `SOURCE_FIELD_MISSING` → check what the previous agent actually returns (`GET /discover/:slug` shows its output shape); the source key must exist at the **top level**. `PREVIOUS_OUTPUT_NOT_OBJECT` → that agent does not return an object; you cannot map fields out of it. `INVALID_MAPPING_SHAPE` → fix the body. **Billing: the step that failed is never charged** (see [5.1](#51-rejected-requests-what-you-are-charged-and-what-is-refunded)). |
| `429 Too Many Requests` | Per-IP or per-key rate limit exceeded. Response body includes `retryAfterMs`. | Back off for the duration in `retryAfterMs`. Do not hammer — repeated 429 will extend the window. |
| `503 Service Unavailable` | An upstream dependency is down or overloaded. The `code` field clarifies: `CIRCUIT_OPEN` (Anthropic or a registry is failing), `BACKPRESSURE` (too many in-flight `/orchestrate`), `gasless_not_operational`, `SERVICE_ERROR` (budget service). | Retry with exponential backoff (start at 1s, cap at 30s, jitter). If the failure persists for more than a minute, check the status page or contact support. |
| `504 Gateway Timeout` | The request exceeded the configured timeout (`TIMEOUT_ORCHESTRATE_MS` default 120s, `TIMEOUT_COMPOSE_MS` default 60s). | Shrink the workload, split the pipeline, or retry — upstream agents may be cold. |

When `NODE_ENV=development`, error responses include the stack trace. In production only the normalized shape is returned.

### 5.1 Rejected requests: what you are charged, and what is refunded

Paid endpoints charge **before** they execute (charge first, deliver after). The
contract for a rejected request depends on which rail you paid with.

**Validation of the request shape happens before any charge.** If your request is
rejected for its *form* — missing required field, malformed body, bad UUID, a
`status` outside the A2A enum, or a missing `x-a2a-key` on a tenant-scoped endpoint
— you are **not charged at all**, on either rail. No budget debit, no on-chain
settle. The response is `400` (or `403 A2A_KEY_REQUIRED`) instead of `402`.

**A `/compose` field mapping is validated before the charge too — twice.** Its
*shape* (the rules in [Section 3](#compose--passing-one-field-from-the-previous-step-inputfromprevious))
is checked with the rest of the body, so a malformed `inputFromPrevious` is a
`400` with **no debit and no discovery call**. Its *resolution* against the
previous step's output can only happen mid-pipeline, and it is evaluated **before
that step is debited and before its agent is invoked**. So when a mapping cannot
be resolved at step `i`:

- steps `0..i-1` stay charged — they ran and delivered their result, which is in
  the `steps[]` array of the response;
- **step `i` is not charged at all** — not the per-step debit, not the retry debit;
- the response is a `400` carrying `errorCode: INPUT_MAPPING_FAILED` plus the
  partial `steps[]` and the real `totalCostUsdc`.

If step 0 itself had not delivered anything, its prepaid debit is credited back by
the usual mechanism below.

Some rejections can only be decided *after* the charge, because they require a
database read and your authenticated identity (does the resource exist, is it
yours, is it in a terminal state), a DNS lookup (the SSRF guard on registry URLs),
or because the database call itself failed. For those:

| Rail | Rejected after the charge | What happens |
|------|---------------------------|--------------|
| **Agent Key (prepaid)** | `404`, `409`, `422`, the `400` returned by the service layer on `/registries`, and the `500` of a failed database call on `PATCH /tasks/:id/status` and `PATCH /tasks/:id` | The step-0 debit is **credited back** to the same ledger that was debited (including the delegation / key-session counters), so those rejections cost you **0**. If the credit-back itself fails it is queued and retried. |
| **Any rail** | Anything returned by `GET /tasks` and `GET /tasks/:id` — `400`, `403`, `404`, `500` | **Nothing to refund: reads are free.** They cost `0` whether they succeed or fail, so there is no debit and no credit — not a charge that gets reversed. |
| **Agent Key (prepaid)** | `500` on `POST /tasks`, and only there | **NOT refunded.** This is the one path where a rejection leaves you charged $1. See the note right below: it is a deliberate decision, not an oversight. |
| **x402 (pay per call)** | Same statuses | **NOT refunded.** The inbound payment is an on-chain settlement and there is no internal balance to credit: refunding would require sending a transaction back to you. Today the API does not do that. |

**The one prepaid rejection that keeps your $1: `POST /tasks` answering `500`.**
A `500` there means the insert did not report success, but it does *not* prove
that nothing was written: if the row was committed and the connection broke while
the response was being sent, the task exists and you can find it. Refunding would
mean handing you a created resource for free, so the API keeps the charge.
**What that means for your integration: do not blind-retry a `500` from
`POST /tasks`.** List first (`GET /tasks?context_id=...`, which is **free**, so
checking costs you nothing) and retry only if the task is not there, because every
retry costs another $1. On the `/tasks` mutations, and everywhere in
`/registries`, a rejection after the charge is credited back.

Practical consequence for x402 callers: the endpoints where a post-charge rejection
is possible are `POST /compose` and `POST /orchestrate*` (execution failures), plus
`POST /gasless/transfer`. On `/registries` and `/tasks` the x402 rail is rejected
*before* the charge (see the note in [Section 3](#3-endpoints-reference)), so a
rejected request there costs you nothing. If your integration cannot tolerate a
non-refundable rejection, use an Agent Key: on the prepaid rail every post-charge
rejection is credited back except the `500` of `POST /tasks` described above.

---

## 6. Funding an Agent Key on Solana (devnet)

> **Status: devnet only. No real money.** There is no `solana-mainnet` chain key, by
> design. Everything below moves devnet USDC.

An Agent Key holds a prepaid balance per chain. This section is the inbound path for
Solana: you prove you control a Solana wallet, you transfer devnet USDC from it, and
the gateway credits your key after verifying the transfer on-chain.

### 6.1 Why there are two steps and not one

You cannot just send USDC and present the signature. **Signatures of an account are
public** on Solana (`getSignaturesForAddress` over the deposit account), so if the
gateway credited whoever presented a signature first, anyone could poll the deposit
account, grab someone else's signature and claim it. Worse: the anti-replay index that
exists to protect deposits would then guarantee the *legitimate* depositor loses — their
signature would already be "credited", to the attacker.

So the deposit is bound to a wallet you proved you control, and the gateway requires
that the funds came **from that wallet**.

### 6.2 Step 1 — Bind your Solana funding wallet

Sign this exact message with your Solana wallet, where `<key_id>` is your Agent Key id:

```
WASIAI_BIND_FUNDING_WALLET_SOLANA:<key_id>
```

The message is raw bytes (no EIP-191 prefix, no hashing) — this is what
`signMessage` does in Phantom/Solflare and what `nacl.sign.detached` produces.

```bash
curl -X POST https://a2a.wasiai.io/auth/funding-wallet \
  -H "x-a2a-key: $A2A_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "namespace": "solana",
    "wallet":    "<your base58 pubkey>",
    "signature": "<base58 signature, 64 bytes>"
  }'

# 200 OK
# { "funding_wallet_solana": "<your base58 pubkey>" }
```

- `namespace` is **required for Solana**. Omitting it means `evm` (backwards
  compatible); an unrecognized value is a `400 INVALID_INPUT`, never a silent fallback.
- The `key_id` in the message comes from the **authenticated key**, never from the body,
  so a signature cannot be replayed onto a different key.
- The pubkey is stored **byte-exact**. base58 is case-sensitive: `Abc…` and `abc…` are
  different wallets and neither is normalized.
- One wallet binds to at most one key ⇒ a second key claiming it gets
  `409 FUNDING_WALLET_ALREADY_BOUND`.

### 6.3 Step 2 — Read where to send the funds

```bash
curl https://a2a.wasiai.io/auth/deposit-info
```

The Solana entry appears **only when the deposit path is enabled**:

```json
{
  "chain_id": 900001,
  "slug": "solana-devnet",
  "family": "SOLANA",
  "vm_family": "solana",
  "cluster": "devnet",
  "token": { "symbol": "USDC", "mint": "<SPL mint>", "decimals": 6 },
  "deposit_account": "<ATA — SEND HERE>",
  "deposit_account_owner": "<owner pubkey — do NOT send here>",
  "required_commitment": "finalized"
}
```

> ⚠️ **Send to `deposit_account`, not to `deposit_account_owner`.** In Solana, SPL
> tokens do not live in the wallet: they live in an Associated Token Account derived
> from the pair (mint, owner). `deposit_account` is that ATA. Sending to the owner
> pubkey is how people lose tokens.

`chain_id` is a **synthetic sentinel**, not a real Solana chain id — Solana has no EVM
chain id. Use the value this endpoint publishes; do not hardcode it.

### 6.4 Step 3 — Transfer, then register the deposit

Transfer devnet USDC from your bound wallet to `deposit_account`. **You pay your own
transaction fee**: the gateway never signs anything on your behalf.

```bash
curl -X POST https://a2a.wasiai.io/auth/deposit \
  -H "x-a2a-key: $A2A_KEY" \
  -H 'x-payment-chain: solana-devnet' \
  -H 'Content-Type: application/json' \
  -d '{
    "key_id":   "<your key_id>",
    "chain_id":  900001,
    "tx_hash":  "<base58 transaction signature>",
    "amount":   "5"
  }'

# 200 OK
# { "balance": "5.000000", "chain_id": 900001 }
```

- `x-payment-chain: solana-devnet` is **required**. There is deliberately no numeric
  alias for the Solana sentinel: the sentinel is env-driven, so an alias would keep
  routing after it changed and produce an unexplainable `CHAIN_MISMATCH`.
- `tx_hash` is the base58 **signature**, not a `0x…` hash.
- `amount` is **optional** and is only cross-checked. **The credited amount is always
  the one measured on-chain**, never the one you declare. If they disagree you get
  `AMOUNT_MISMATCH` and nothing is credited.
- The gateway waits for **`finalized`** before crediting. A `confirmed` transaction
  returns `400 DEPOSIT_NOT_FINALIZED` — that is a *retry later*, not a rejection.

### 6.5 What each failure means, and whether your proof is burned

**No failure below consumes your signature**: nothing is inserted, so you can present
the same signature again once the cause is gone. The only terminal one is the `409`.

| HTTP | `error_code` | What happened | What to do |
|---|---|---|---|
| 400 | `INVALID_INPUT` | Malformed reference, or the reference format does not match the chain family (a base58 signature with an EVM chain, or a `0x…` with `solana-devnet`) | Fix the request. No network call was made |
| 400 | `TX_ABSENT` | The node searched its history and does not know this signature | Check the signature |
| 400 | `TX_FAILED` | It landed and failed on-chain — nothing moved | Send a new transfer |
| 400 | `DEPOSIT_NOT_FINALIZED` | Measured as `processed`/`confirmed` | **Retry in a few seconds** |
| 400 | `MINT_MISMATCH` | You sent a different token | Send the published `mint` |
| 400 | `RECIPIENT_MISMATCH` | Right token, wrong account | **No automatic refund.** Contact support |
| 400 | `AMOUNT_MISMATCH` | Declared ≠ on-chain | Re-send with the right `amount`, or omit it |
| 400 | `DEPOSITOR_AMBIGUOUS` | More than one source wallet in the same transaction | Deposit from a single wallet |
| 403 | `FUNDING_WALLET_NOT_BOUND` | You skipped 6.2 | Bind your wallet |
| 403 | `FUNDING_WALLET_MISMATCH` | The funds came from a wallet that is not the bound one | Deposit from the bound wallet |
| 409 | `DEPOSIT_ALREADY_CREDITED` | This signature was already credited | Nothing — it is already in your balance |
| 503 | `DEPOSIT_ACCOUNT_NOT_CONFIGURED` | The Solana deposit path is off on the server | Retry later / contact support |
| 503 | `DEPOSIT_VERIFICATION_UNKNOWN` | **We could not determine** whether it landed | **Retry.** Your proof was not consumed |

> The `503 DEPOSIT_VERIFICATION_UNKNOWN` is deliberately not a `400`. "We could not ask
> the chain" is not the same as "your deposit does not exist", and telling you the
> second when only the first is true would be claiming your money never arrived.

### 6.6 Operator runbook — activation order

**Non-negotiable order.** Migration → env → flag:

1. apply `supabase/migrations/20260731000000_wkh315_solana_deposit.sql`;
2. set `A2A_DEPOSIT_OWNER_SOLANA` (and `A2A_DEPOSIT_OWNER_IS_DEDICATED_SOLANA=true`
   only if that account is deliberately *not* the operator's);
3. set `A2A_DEPOSIT_ENABLED_SOLANA=true` **last**.

Migration before code means no window: the column exists and nothing uses it yet. The
reverse order degrades **loudly** (the flag defaults off, so the path simply does not
exist) instead of double-crediting. See `.env.example` for the full reasoning on each
variable, including why no environment variable can weaken the `finalized` requirement.

**Rollback caveat:** the `_down` migration archives the Solana signatures into
`a2a_key_deposits_solana_backup_wkh315` *before* dropping `vm_family`, and the `up`
re-hydrates from it. Do not drop that table by hand — without it, a `down → up` cycle
re-opens every past Solana deposit for re-crediting.

### 6.7 Known debt this path activates — `TD-SOLANA-CAIP2-DENYLIST`

**This is an operator concern, not a depositor one.** Turning
`A2A_DEPOSIT_ENABLED_SOLANA=true` in an environment that also serves real value erodes
one of the three conditions that keep `TD-SOLANA-CAIP2-DENYLIST` tolerable, and the
story that converts it to a fail-CLOSED allowlist has to be opened **first**.

The debt itself, its three conditions, its trigger and the three new environment
variables are tracked where debt is tracked:
[`architecture/MULTI-CHAIN.md`](architecture/MULTI-CHAIN.md) §10 / §10.1. It is
**declared, not closed** by this feature.

---

## 7. End-to-End Example

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
