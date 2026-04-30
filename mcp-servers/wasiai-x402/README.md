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
npm test         # 36+ tests should pass
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
   │   └── sign.mjs
   ```
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
