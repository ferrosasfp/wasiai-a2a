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
| `pay_x402` | Full flow: probe → balance-gate (USDC outbound) → sign EIP-3009 `TransferWithAuthorization` (PYUSD on Kite) → retry with `payment-signature` header. Requires `payload.maxBudget` (USDC). |

### `pay_x402` inputs (WKH-67)

`pay_x402` separates two independent caps over different chains and decimals:

| Input | Dimension | Required? | What it gates |
|-------|-----------|-----------|---------------|
| `payload.maxBudget` | USDC number on Avalanche C-Chain mainnet (6 decimals, e.g. `0.5`) | **YES** when endpoint requires payment | OUTBOUND budget. Source-of-truth for the balance-gate that reserves a claim against the operator wallet. |
| `args.maxAmountWei` | PYUSD wei on Kite testnet (18 decimals, e.g. `"1000000000000000000"`) | optional | Defensive cap on the INBOUND `accepts.maxAmountRequired` returned by the 402 challenge. Priority: per-call > `MCP_MAX_AMOUNT_WEI_DEFAULT` > undefined. |

These two caps are **independent**. `maxBudget` always speaks USDC.
`maxAmountWei` always speaks PYUSD wei. Confusing them is what WKH-66 broke
in mainnet; the fix (WKH-67) keeps each guard on its own dimension.

**Example 1 — caller declares OUTBOUND budget only (typical):**

```json
{
  "endpoint": "/api/v1/orchestrate",
  "payload": { "maxBudget": 0.5, "task": "..." }
}
```

**Example 2 — caller also adds a defensive INBOUND cap:**

```json
{
  "endpoint": "/api/v1/orchestrate",
  "payload": { "maxBudget": 0.5, "task": "..." },
  "maxAmountWei": "1000000000000000000"
}
```

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

## Operations runbook

> Added in WKH-66. See `doc/sdd/071-wkh-66-prod-hardening/` for the full SDD
> + Story File. All scripts here live under `mcp-servers/wasiai-x402/scripts/`.

### (a) Rotar el bearer token (`MCP_BEARER_TOKEN`)

```bash
cd mcp-servers/wasiai-x402
node scripts/rotate-bearer.mjs
# Stdout: <new bearer hex 64 chars>
# Stderr: instrucciones vercel env add/rm
```

Después de rotar:

1. `vercel env rm MCP_BEARER_TOKEN production` (valor anterior)
2. `vercel env add MCP_BEARER_TOKEN production` (paste nuevo)
3. `vercel deploy --prod` (rollout)

> El script refuses to print on a non-TTY. Si lo corrés desde CI, vas a ver
> `Refusing to print bearer to non-TTY` y exit 1 — eso es by-design.

### (b) Refrescar sesión MCP

```bash
MCP_BEARER_TOKEN=<token> MCP_DEPLOY_URL=https://wasiai-x402-mcp.vercel.app \
  node scripts/refresh-session.mjs
# Verifica que /api/mcp tools/list responde 200 con 3 tools.
```

Salida `{ "ok": true, "toolCount": 3 }` → el MCP está vivo. Cualquier otra
salida + exit ≠ 0 → escalá.

### (c) Alert webhook disparó — qué hacer

El alert significa balance USDC < `MCP_BALANCE_THRESHOLD_USDC` (default 0.50)
en mainnet operator wallet sobre Avalanche C-Chain.

1. Verificar balance actual: `node scripts/refresh-session.mjs` (smoke).
2. Rellenar wallet: enviar USDC a operator address from exchange/faucet.
3. **NOTA CRÍTICA (CD-16)**: el alert mide SOLO USDC ERC-20. El operator
   también necesita AVAX para gas (no monitoreado en esta HU). Verificar
   manualmente con explorador.

### (d) Deshabilitar cron temporariamente

```bash
# En cron-job.org dashboard → seleccionar job → Disable
# O via API:
curl -X PATCH https://api.cron-job.org/jobs/<jobId> \
  -H "Authorization: Bearer $CRONJOB_ORG_API_TOKEN" \
  -d '{"job": {"enabled": false}}'
```

### (e) Bearer TTL

- Recomendado: rotar cada **90 días**.
- Última rotación: <FECHA — actualizar manualmente cada vez>.

### (f) Provisionar los 2 cron jobs (idempotente)

```bash
export CRONJOB_ORG_API_TOKEN="<token from cron-job.org account>"
export MCP_DEPLOY_URL="https://wasiai-x402-mcp.vercel.app"
export CRON_SECRET="<the secret used in Vercel env>"
node scripts/setup-cronjob.mjs
# Imprime 2 jobIds + nextExecution
```

Re-ejecutar el script no duplica jobs (idempotente por `title` — CD-20). Si
ya existen, hace PATCH; si no existen, hace PUT.

### (g) Verificar status de los jobs

- Dashboard: https://cron-job.org → Jobs.
- API:
  ```bash
  curl -H "Authorization: Bearer $CRONJOB_ORG_API_TOKEN" \
       https://api.cron-job.org/jobs
  ```

### (h) Desactivar temporariamente via API

```bash
curl -X PATCH https://api.cron-job.org/jobs/<jobId> \
  -H "Authorization: Bearer $CRONJOB_ORG_API_TOKEN" \
  -d '{"job": {"enabled": false}}'
```

### (i) Alert webhook platforms (WKH-90)

`sendAlert()` (in `src/alerts.mjs`) auto-detects the destination platform by
parsing `new URL(MCP_ALERT_WEBHOOK_URL).host` and reshapes the payload only
when needed. There are **no env vars** to toggle this — the host is the source
of truth.

| Host of `MCP_ALERT_WEBHOOK_URL` | Payload sent | Notes |
|---|---|---|
| `discord.com` | Discord embed (`{username, embeds[]}`) | reshape (WKH-90) |
| `discordapp.com` | Discord embed (`{username, embeds[]}`) | reshape (WKH-90) |
| any other host (Slack, Datadog, custom) | Raw sanitized JSON (one flat object) | backward compat |
| invalid / unparseable URL | Raw sanitized JSON (no throw) | CD-WKH90-2 fall-safe |

**Discord embed structure** (when host matches):

```json
{
  "username": "wasiai-alerts",
  "embeds": [{
    "title": "[<severity>] <event>",
    "description": "<body.reason if present>",
    "color": 15158332,
    "timestamp": "<body.rotatedAt or body.checkedAt, ISO-8601>",
    "fields": [
      { "name": "chain",       "value": "avax", "inline": true },
      { "name": "operator",    "value": "0x…",  "inline": true },
      { "name": "balanceUsdc", "value": "0.1",  "inline": true }
    ]
  }]
}
```

**Color mapping by severity:**

| `severity` | Color decimal | Hex | Meaning |
|---|---|---|---|
| `critical` | `15158332` | `#E74C3C` | red |
| `warning` | `15844367` | `#F1C40F` | yellow |
| `info` | `3066993` | `#2ECC71` | green |
| anything else | `3066993` | `#2ECC71` | falls back to info (DT-4) |

**What goes where in the embed:**

- `severity` → embed `color` (not duplicated as a field)
- `event` → embedded in `title` as `[<severity>] <event>`; if absent, title is just `[<severity>]`
- `reason` → embed `description` (omitted if absent)
- `rotatedAt` (preferred) or `checkedAt` → embed `timestamp` (omitted if neither)
- every other whitelisted body key (`chain`, `operator`, `balanceUsdc`,
  `threshold`, `blockNumber`, …) → one `fields[]` entry with `String(value)`
  and `inline: true`

**Why hardcoded `username` (no env var):** simplicity — there is one production
sender. If multi-tenant routing is needed later, that is a separate HU
(CD-WKH90-3).

**Backward compat guarantee (AC-3):** Slack incoming webhooks, Datadog event
intakes, PagerDuty Events V2, and any custom webhook keep receiving the same
raw flat JSON they got before WKH-90. The reshape is **opt-in via host**, not
opt-out.

---

## Bearer rotation runbook (WKH-75)

> Added in WKH-75. Replaces the manual `(a) Rotar el bearer token` flow with
> an automated headless rotation backed by two cron-job.org jobs:
> `bearer-rotation` (every 30 days) and `bearer-prev-cleanup` (24h after each
> rotation). See `doc/sdd/076-wkh-75-bearer-rotation-cron/sdd.md` for the full
> SDD.

<!-- LAST_BEARER_ROTATION: YYYY-MM-DD -->

> ⚠️ **Update the placeholder above manually after every successful rotation
> (automatic or manual).** The line is the only durable on-repo timestamp;
> Vercel env vars do not retain a "last set" timestamp visible from API.

### (a) Cadencia recomendada

- **Automático**: cron-job.org job `bearer-rotation` ejecuta `POST
  /api/cron/rotate-bearer` cada **30 días**. Verificar último run en
  https://cron-job.org → Jobs → `bearer-rotation` → History.
- **Manual (incidente)**: ejecutar inmediatamente si hay sospecha de leak,
  rotación de personal, o compromiso del entorno Vercel. No esperar al cron.

### (b) Manual rotation

Dos modos:

**Modo headless (preferido — requiere `VERCEL_TOKEN` + `VERCEL_PROJECT_ID`):**

```bash
cd mcp-servers/wasiai-x402
export VERCEL_TOKEN=<your vercel api token>
export VERCEL_PROJECT_ID=<prj_xxx>
# export VERCEL_TEAM_ID=<team_xxx>   # only if project is in a team
node scripts/rotate-bearer.mjs --headless
# Stderr: instrucciones de verificación + log JSON-line del flujo
# Exit 0 → rotation completada (env vars actualizadas, redeploy disparado)
```

El modo headless replica exactamente lo que hace el cron `bearer-rotation`,
pero ejecutado desde la laptop del operador. Útil para smoke-test del flujo
o para forzar rotación pre-incidente.

**Modo manual (fallback — sin `VERCEL_TOKEN`):**

```bash
cd mcp-servers/wasiai-x402
node scripts/rotate-bearer.mjs
# Stdout: <new bearer hex 64 chars>
# Stderr: pasos manuales — vercel env add/rm + redeploy
```

Después seguir las instrucciones impresas en stderr (`vercel env rm` →
`vercel env add` → `vercel deploy --prod`).

### (c) Verificación post-rotation

Inmediatamente después de cualquier rotation (automática o manual), validar
con el bearer **nuevo**:

```bash
MCP_BEARER_TOKEN=<new bearer> \
MCP_DEPLOY_URL=https://wasiai-x402-mcp.vercel.app \
  node scripts/refresh-session.mjs
# Esperado: { "ok": true, "toolCount": 3 }, exit 0
```

Cualquier respuesta distinta de `200` con `toolCount: 3` → escalar y
considerar rollback (sección d).

### (d) Rollback

Si la rotation falló mid-flow (ej. `rotate-bearer` actualizó
`MCP_BEARER_TOKEN_PREV` pero no `MCP_BEARER_TOKEN`, o el redeploy quedó en
error), restaurar manualmente:

1. **Identificar bearer anterior** desde Vercel dashboard (Project → Settings
   → Environment Variables → History) o desde los logs estructurados del
   cron-run que falló (stderr JSON contiene `previousBearerHash` para
   correlación, **nunca el bearer en claro** — CD-9).
2. `vercel env rm MCP_BEARER_TOKEN production` (el valor parcial/roto).
3. `vercel env add MCP_BEARER_TOKEN production` y pegar el bearer anterior
   desde el History de Vercel.
4. `vercel env rm MCP_BEARER_TOKEN_PREV production` (si quedó set).
5. `vercel deploy --prod` para forzar rollout con el bearer restaurado.
6. Validar con `refresh-session.mjs` (sección c).
7. Investigar la causa raíz desde Vercel Logs antes de re-intentar la
   rotation.

### (e) Verificación de overlap window (24h)

Durante 24h post-rotation, **ambos bearers** son válidos (`MCP_BEARER_TOKEN`
nuevo + `MCP_BEARER_TOKEN_PREV` antiguo). Esto asegura zero-downtime para
clientes Claude Console que hayan cacheado el bearer anterior.

Test:

```bash
# Bearer NUEVO debe funcionar:
MCP_BEARER_TOKEN=<new> MCP_DEPLOY_URL=https://wasiai-x402-mcp.vercel.app \
  node scripts/refresh-session.mjs
# → { "ok": true, "toolCount": 3 }

# Bearer ANTERIOR también debe funcionar durante 24h:
MCP_BEARER_TOKEN=<previous> MCP_DEPLOY_URL=https://wasiai-x402-mcp.vercel.app \
  node scripts/refresh-session.mjs
# → { "ok": true, "toolCount": 3 }
```

Pasadas las 24h, el cron `bearer-prev-cleanup` ejecuta `POST
/api/cron/invalidate-prev-bearer` y borra `MCP_BEARER_TOKEN_PREV`. A partir
de ese punto el bearer anterior debe responder `401`.

### (f) Last-rotation timestamp

El comentario HTML al inicio de esta sección
(`<!-- LAST_BEARER_ROTATION: YYYY-MM-DD -->`) es el único registro durable
on-repo de la última rotation. **Actualizarlo manualmente después de cada
rotation** — automática o manual. PR sugerido: bump del placeholder + nota
en commit msg con el `previousBearerHash` (no el bearer en claro).

### (g) Advertencia de seguridad

- **NUNCA** compartir el bearer en chat (Slack, Discord, email), GitHub
  issue/PR description, ni `.env` commiteado. El bearer es equivalente a
  acceso completo a los 3 tools del MCP, incluyendo `pay_x402` que mueve
  fondos reales.
- **NUNCA** loguear el bearer en stdout/stderr/clipboard/screenshot. Los
  scripts solo imprimen `bearerHash` (SHA-256) en logs estructurados —
  verificado por tests `tests/bearer-rotation.test.mjs::T-AUDIT-*` y
  `tests/cron-rotation.test.mjs::T-LEAK-*` (CD-9).
- En caso de leak (sospecha o confirmado): rotar inmediatamente con (b) en
  modo headless, validar con (c), revisar Vercel + cron-job.org access logs
  por requests con el bearer comprometido.

---

## License & reporting

Internal — see repository root LICENSE.

Security issues: report privately to the maintainers (do NOT open a public issue).
