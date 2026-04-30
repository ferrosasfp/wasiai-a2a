# wasiai-x402 — MCP server for WasiAI x402 payments

A standalone MCP (Model Context Protocol) server that exposes 3 tools for Claude Console
managed agents to discover WasiAI agents, request quotes, and execute x402 payments
against `app.wasiai.io` (Kite testnet PYUSD inbound + downstream USDC outbound).

**Status**: alpha. Mainnet exposure: `pay_x402` signs real EIP-3009 authorizations
that may be settled on-chain by the gateway facilitator.

Tools:

| Tool | Purpose |
|------|---------|
| `discover_agents` | GET `/api/v1/capabilities` passthrough with optional `query`, `maxPrice`, `capabilities[]` filters. |
| `get_payment_quote` | POST a probe to a paid endpoint **without** a signature, parse the 402 challenge, return the quote. |
| `pay_x402` | Full flow: probe → sign EIP-3009 `TransferWithAuthorization` (PYUSD on Kite) → retry with `payment-signature` header. |

---

## Setup local

Prerequisites: Node.js >= 20.10.0, npm.

```bash
git clone https://github.com/ferrosasfp/wasiai-a2a.git
cd wasiai-a2a/mcp-servers/wasiai-x402
npm install
cp .env.example .env
# Edit .env — set OPERATOR_PRIVATE_KEY (testnet wallet for local dev).
npm test         # 100+ tests should pass
npm start        # MCP server starts on stdio (waits for client)
```

To verify the server is alive without an MCP client:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node src/index.mjs
```

You should see a JSON-RPC response listing 3 tools.

Per-suite test commands:

```bash
npm run test:sign     # 8 tests (golden vector + signature shape)
npm run test:config   # 7+ tests (env validation + warn-once)
npm run test:url      # 9+ tests (SSRF guard, IPv4/IPv6 private ranges)
npm run test:tools    # 12+ tests (handlers, mocked fetch, concurrency)
npm run test:auth     # bearer token validation (timing-safe, AC-5/AC-6, WKH-65)
npm run test:http     # HTTP transport via api/mcp.mjs (auth, CORS, leaks, WKH-65)
```

---

## Deploy to Claude Console managed env

1. Open Claude Console → MCP Servers → New custom env.
2. Name: `wasiai-orchestrator-env` (or any).
3. Bundle layout — upload these files:
   ```
   wasiai-x402/
   ├── package.json
   ├── package-lock.json
   ├── src/
   │   ├── index.mjs
   │   ├── config.mjs
   │   ├── log.mjs
   │   ├── url-validator.mjs
   │   ├── handlers.mjs    # required (post-WKH-65 refactor: shared handlers for stdio + HTTP)
   │   ├── sign.mjs
   │   └── auth.mjs        # optional for stdio; required only if you also want HTTP transport
   ```
   > For HTTP transport (Vercel), see "Deploy a Vercel" section below — that path
   > additionally requires `api/mcp.mjs` and `vercel.json` on top of the files above.
4. Entry command: `node src/index.mjs`.
5. Env vars (set via Claude Console env panel — never commit):
   - `OPERATOR_PRIVATE_KEY` — REQUIRED. Mainnet-funded wallet for production demos.
   - `WASIAI_GATEWAY_URL` — default `https://app.wasiai.io`.
   - `MCP_MAX_AMOUNT_WEI_DEFAULT` — REQUIRED in production. Set to a sane cap
     (e.g. `5000000000000000000` = 5 PYUSD).
   - `MCP_PAY_TIMEOUT_MS` — default `30000`.
   - `KITE_CHAIN_ID` — default `2368` (testnet). `2366` for mainnet (out-of-scope here).
   - `KITE_PYUSD` — default `0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9`.
   - `X402_EIP712_DOMAIN_NAME` / `X402_EIP712_DOMAIN_VERSION` — default `PYUSD` / `1`.
   - `MCP_GATEWAY_ALLOWLIST` — CSV of hostnames that bypass the SSRF private-IP check
     (use only in dev/staging).
   - `NODE_ENV` — `production` by default; set `development` to allow `http://localhost`.
6. Test from a Claude Console agent: invoke `discover_agents({query:"AVAX"})` and
   verify the response.
7. **Before mainnet**: invoke `pay_x402` against testnet first. Then with a small
   `MCP_MAX_AMOUNT_WEI_DEFAULT` cap, verify the explorer shows the tx.

---

## Deploy a Vercel (Remote MCP via HTTP Streamable transport)

The `api/mcp.mjs` Vercel Serverless Function exposes the same 3 tools over the
MCP HTTP Streamable transport, so a Claude Console managed agent can consume
the server through the **"Add Remote MCP"** UI without bundling code.

Prerequisites: a Vercel account, the `vercel` CLI installed locally
(`npm i -g vercel`), and a funded operator wallet for testnet/mainnet.

### 1. Generate the bearer token

The HTTP transport is protected by a single bearer token (timing-safe
comparison via `node:crypto.timingSafeEqual`). Generate one with:

```bash
openssl rand -hex 32
# → 64 hex chars; copy this value, you'll set it in Vercel below.
```

Treat the token like a production credential — anyone holding it can call the
3 tools and trigger payments. Rotate on suspected leak by adding a new token
in Vercel env, redeploying, and removing the old one.

### 2. Configure Vercel env vars

```bash
cd mcp-servers/wasiai-x402
vercel login
vercel link                              # link this folder to a Vercel project
                                         #   (project name e.g. wasiai-x402-mcp)
vercel env add OPERATOR_PRIVATE_KEY production
vercel env add MCP_BEARER_TOKEN production       # paste the openssl-generated hex
vercel env add WASIAI_GATEWAY_URL production     # e.g. https://app.wasiai.io
vercel env add MCP_CORS_ALLOWED_ORIGINS production  # CSV; usually leave empty
                                                    # (Claude Console proxies
                                                    #  server-side; deny-by-default)
vercel env add MCP_MAX_AMOUNT_WEI_DEFAULT production  # cap, e.g. 5000000000000000000
# Optional, per ticket / chain config:
#   KITE_CHAIN_ID, KITE_PYUSD, X402_EIP712_DOMAIN_NAME, X402_EIP712_DOMAIN_VERSION
```

### 3. Deploy

```bash
vercel deploy --prod
# → outputs e.g. https://wasiai-x402-mcp.vercel.app
```

### 4. Configure in Claude Console

In Claude Console, open **Settings → Connectors → Add Remote MCP** and provide:

| Field | Value |
|-------|-------|
| Name | `wasiai-x402` |
| URL | `https://wasiai-x402-mcp.vercel.app/api/mcp` |
| Custom header | `Authorization: Bearer <MCP_BEARER_TOKEN>` |

After saving, the 3 tools (`discover_agents`, `get_payment_quote`, `pay_x402`)
appear in the agent's tool palette. Behavior is identical to stdio: the
handlers are the exact same code path (`src/handlers.mjs`).

### Operational notes

- `vercel.json` declares `maxDuration: 60` so a slow x402 flow
  (probe + sign + Kite + Avalanche confirms) completes within the function
  budget. On Vercel Hobby this is the cap; for higher latencies upgrade to
  Pro and raise `maxDuration`.
- Region is pinned to `iad1` (Virginia) — adjust if your gateway is elsewhere.
- Logs go to **Vercel Logs** as JSON-line stderr (`log.mjs`). The bearer
  token, the operator PK, and the presented `Authorization` header are
  NEVER written to logs (verified by `tests/http.test.mjs::T-HTTP-11`).
- Auth runs **before** body parse: an unauthenticated request never touches
  the JSON-RPC parser, never reaches the handlers, and never hits the
  gateway.

### Local dev for the HTTP transport

The HTTP function is testable in-process via `node --test tests/http.test.mjs`
without spinning up Vercel; for end-to-end smoke against a real Vercel
deploy, use:

```bash
curl -X POST https://wasiai-x402-mcp.vercel.app/api/mcp \
  -H "Authorization: Bearer <MCP_BEARER_TOKEN>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

The stdio transport (`npm start`) is unchanged — it still works for local
dev and for the original "Deploy to Claude Console managed env" path above.

---

## Security warnings

- **Operator private key custody**: `OPERATOR_PRIVATE_KEY` controls real funds.
  - Treat it like a production credential. Rotate on any suspected leak.
  - Never paste it in a chat transcript or commit it. The server **never** logs
    the PK (verified by `tests/tools.test.mjs` with 0-match assertions across all
    error paths).
  - Blast radius if leaked: drain of operator wallet (~$5 USDC mainnet at the
    time of writing) **plus** potential abuse of the protocol fee key (see WKH-44).
- **Mainnet exposure**: each successful `pay_x402` call generates a real on-chain
  transaction. There is no "sandbox" mode at the gateway level — testnet vs mainnet
  is decided by `KITE_CHAIN_ID` and the contract address.
- **Cap guard**: ALWAYS set `MCP_MAX_AMOUNT_WEI_DEFAULT` in production. Without it,
  a malicious gateway response with a huge `maxAmountRequired` would be signed
  blindly. The per-call `maxAmountWei` input parameter overrides the env default
  (priority: per-call > env > undefined).
- **SSRF defense**: `WASIAI_GATEWAY_URL` is validated at startup (private-IP
  rejection, scheme allowlist, literal-host block). In `NODE_ENV=development`
  the rules are relaxed to allow `localhost`/`127.0.0.1`.
  - **Set the gateway URL as origin-only** (e.g. `https://app.wasiai.io` or
    `https://app.wasiai.io/`), NOT a path-prefix like `https://app.wasiai.io/x402/`.
    Tool inputs (`endpoint`) are paths resolved against the configured gateway
    via `new URL(endpoint, gateway)`. A path-bearing gateway changes how
    relative resolution works and can shift the surface area of the
    post-resolution host check (MNR-iter3-2, WKH-64).
- **Redirect refusal (BLQ-iter3-1)**: every outgoing `fetch()` is set to
  `redirect: 'error'`. WHATWG fetch only strips
  `Authorization` / `Cookie` / `Proxy-Authorization` on cross-origin
  redirects; **custom headers like `payment-signature` are FORWARDED**.
  Without this guard, a hostile (or compromised) gateway answering
  `302 Location: https://evil.com/...` to the settle call would leak the
  signed EIP-3009 envelope to the attacker, who could replay it on the
  legitimate gateway and drain the operator wallet. The guard rejects any
  3xx (even legitimate); the legitimate gateway must answer
  `200`/`4xx`/`5xx` directly.
- **Prompt injection resistance**: input fields named `OPERATOR_PRIVATE_KEY`,
  `signature`, or `authorization` (top-level) are stripped silently and trigger
  a `warn-once` log. **Nested fields are NOT inspected** (out of scope for
  WKH-64; documented limitation — see SDD §15 V5.4). If a future capability
  needs deep sanitization, expand the sanitizer accordingly.
- **No stdout logging**: stdout is reserved for MCP JSON-RPC stdio frames.
  All logs go to stderr as JSON-line per event. Do not rely on `console.log`
  inside this server.
- **Rotation**: to rotate, deploy with the new PK, drain the old wallet, never
  reuse the old PK across environments.

---

## License & reporting

Internal — see repository root LICENSE.

Security issues: report privately to the maintainers (do NOT open a public issue).
