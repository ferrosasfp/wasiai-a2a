# Kite Passport — Onboarding Guide for WasiAI A2A

> **Status**: implementation merged via WKH-69. Real E2E smoke-test is a
> post-merge human gate — see "Smoke Test" section below.

## What this enables

`wasiai-a2a` accepts inbound x402 payments from **two payer types** transparently:

1. **Raw EOA** (legacy path, default): client signs EIP-3009
   `TransferWithAuthorization` with their own private key.
2. **Kite Passport session wallet** (new): client uses `kpass agent:session
   execute` and Passport handles the 402 negotiation + signing internally.

Outbound cross-chain settlement (to Avalanche etc.) **continues to use
`OPERATOR_PRIVATE_KEY`** — unchanged. Only the inbound path is agnostic.

## Architecture (Model B Hybrid)

```
┌─────────────┐   x402 (Passport       ┌──────────────┐   x402 (operator
│ End user /  │   session signs)        │              │   key signs)
│ Passport    │ ──────────────────────► │  wasiai-a2a  │ ────────────────►  Avalanche agents
│ agent       │                         │ (orchestr.)  │                    (downstream)
└─────────────┘                         └──────────────┘
                                              │
                                              ├── reads `x-passport-session` header (telemetry hint)
                                              ├── tags `metadata.payment_origin` in a2a_events
                                              └── (optional) requirePassport guard via PASSPORT_REQUIRE_INBOUND
```

## Quickstart — user onboarding via `kpass` CLI

> Reference: https://agentpassport.ai/quickstart/

### 1. Install the `kpass` CLI

```bash
curl -sSL https://install.gokite.ai/kpass | sh
kpass --version
```

### 2. Sign up

```bash
kpass signup init --email <your-email>
# → check inbox, click verification link
kpass signup poll --signup-id <id-from-step-1> --wait
kpass signup exchange --signup-id <id> --exchange-token <token-from-email>
# → JWT stored at ~/.kite-passport/config.json
```

### 3. Register an agent

```bash
kpass agent:register --type retail --output json
# → agent credentials at ~/.kite-passport/agent.json (gitignored)
```

### 4. Create + approve a session

```bash
kpass agent:session create \
  --task-summary 'Pay wasiai-a2a orchestrate' \
  --max-amount-per-tx 2 \
  --max-total-amount 10 \
  --ttl 2h \
  --assets USDC \
  --output json
```

Response includes `approval_url` (passkey-gated). Open in browser, approve via
passkey. Then poll:

```bash
kpass agent:session status --request-id <id-from-create> --wait --output json
# → status transitions: human_action_required → ready
```

### 5. Execute a paid call

```bash
kpass agent:session execute \
  --url https://wasiai-a2a.up.railway.app/orchestrate \
  --method POST \
  --body '{"goal":"summarize","input":"hello"}' \
  --output json
```

Passport auto-handles 402 negotiation. You get a `200` with the orchestrator
response. Internally a row is inserted in `a2a_events` with
`metadata.payment_origin = 'passport'`.

## Telemetry

Every inbound request that hits a tracked endpoint
(`/discover`, `/orchestrate`, `/compose`, `/auth/agent-signup`,
`/gasless/status`) writes a row in the `a2a_events` table. WKH-69 adds a
new key inside the existing `metadata: jsonb` column:

| Field | Value | When |
|-------|-------|------|
| `metadata.payment_origin` | `'passport'` | Client sent `x-passport-session: true` (or `1` / `yes`) header |
| `metadata.payment_origin` | `'eoa'` | Header absent or any other value (default backward compat) |

**Sample query** (Supabase SQL):

```sql
SELECT
  metadata->>'payment_origin' AS origin,
  COUNT(*) AS req_count,
  AVG(latency_ms) AS avg_latency
FROM a2a_events
WHERE created_at > NOW() - INTERVAL '7 days'
  AND event_type LIKE 'request:%'
GROUP BY 1;
```

> **Caveat**: rows persisted before WKH-69 deploy do NOT have this key.
> Use `COALESCE(metadata->>'payment_origin', 'unknown')` for legacy data.

## Opt-in Passport-only enforcement (`requirePassport`)

> **Security caveat — read before mounting in production**
>
> The `requirePassport` middleware checks the `x-passport-session` header to distinguish Passport-funded requests from EOA-signed ones. **This header is client-controlled** — any attacker can spoof `x-passport-session: true` and bypass the guard while signing with a raw EOA.
>
> The guard therefore provides **policy-declaration only**, not adversarial security:
> - Real Passport-vs-EOA distinction requires either:
>   - (a) A Kite Passport session-address registry lookup (server-side verification of the signer wallet against Passport-issued addresses), or
>   - (b) Signature-shape inference (ed25519 vs secp256k1 detection from the EIP-3009 signature bytes).
> - Both options are **deferred to follow-up post-smoke-test** (when real Passport-funded transactions provide ground-truth shape data).
>
> Until then, true security still hangs on EIP-3009 signature verification (the adapter `verify()` checks `from` matches signer). Mounting `requirePassport` is useful for:
> - Routing/observability (which routes prefer Passport flow)
> - UX hints to clients (return 403 with descriptive error)
> - **Not** for keeping EOA traffic out of a Passport-only endpoint

WKH-69 exports a middleware factory `requirePassport()` from
`src/middleware/passport.ts`. **This factory is NOT mounted by default**. To
activate (per deployment, not per route):

1. Set env var `PASSPORT_REQUIRE_INBOUND=true` on Railway (or in `.env`).
   - Strict comparison: only literal `'true'` activates the guard.
   - Any other value (`'TRUE'`, `'1'`, `'yes'`, `'false'`, unset) → guard NOT mounted (factory returns `[]`).
2. Edit your route registration to add the guard AFTER `requirePayment`:

   ```ts
   // BEFORE:
   app.post('/orchestrate', { preHandler: requirePayment({...}) }, handler);

   // AFTER (Passport-only mode):
   app.post('/orchestrate', {
     preHandler: [...requirePayment({...}), ...requirePassport()],
   }, handler);
   ```

   Order matters: `requirePayment` MUST run first (it sets
   `request.paymentOrigin` from the header). `requirePassport` reads that
   field.

3. Behavior when active:
   - Request with `x-passport-session: true` → passthrough.
   - Request without it → `403 {"error":"Passport session required","error_code":"PASSPORT_REQUIRED"}`.

## Smoke Test (post-merge human gate)

> **DO NOT execute this during code review or CI. Manual ops only.**

Real wire-shape verification of a Passport-funded x402 transaction is gated
to a human run because it requires real on-chain funds. Steps:

1. **Prepare**: ensure prod Passport account `user_019de709-…` is registered
   and its session wallet `0x7aB8760225Ffd90F23bd0B5BfC5B04965976AdB3` exists
   on chain 2366 (Kite mainnet).
2. **Fund**: transfer ~$5 USDC mainnet to that wallet (chain 2366 ONLY —
   never Ethereum/Base/Solana, funds will be lost).
3. **Create session**:
   ```bash
   kpass agent:session create \
     --task-summary 'WKH-69 smoke test' \
     --max-amount-per-tx 1 \
     --max-total-amount 5 \
     --ttl 30m \
     --assets USDC \
     --output json
   ```
   Approve via passkey (open `approval_url`).
4. **Execute against prod**:
   ```bash
   kpass agent:session execute \
     --url https://wasiai-a2a.up.railway.app/orchestrate \
     --method POST \
     --body '{"goal":"echo","input":"smoke"}' \
     --output json
   ```
5. **Verify**:
   - HTTP `200` returned.
   - In Supabase `a2a_events`, find the row matching that `requestId` and
     confirm `metadata->>'payment_origin' = 'passport'`.
   - If the row instead shows `'eoa'`: it means the `kpass` CLI did NOT
     send the `x-passport-session` header — open follow-up ticket to
     either (a) ship a custom client wrapper, or (b) detect via signature
     shape heuristic. **Do NOT roll back this HU** — telemetry default
     `'eoa'` is by design.
   - If HTTP `402` returned: signature shape mismatch. Capture the raw
     `payment-signature` header value (base64), open ticket WKH-XX with
     the decoded JSON. **This is the open question post-spike** — see
     `doc/sdd/spike-kite-passport/decision-doc.md` § Open questions still unresolved.

## Environment variables reference

| Var | Required? | Default | Purpose |
|-----|-----------|---------|---------|
| `KITE_NETWORK` | No | `testnet` | `mainnet` activates USDC + chain 2366. `testnet` keeps PYUSD + chain 2368. |
| `X402_PAYMENT_TOKEN` | No | derived from `KITE_NETWORK` | Override the EIP-3009 token contract address. Mainnet default `0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e`. |
| `X402_EIP712_DOMAIN_NAME` | No | `'USDC'` (mainnet) / `'PYUSD'` (testnet) | EIP-712 domain name used in signature verification. |
| `X402_TOKEN_SYMBOL` | No | `'USDC.e'` (mainnet) / `'PYUSD'` (testnet) | Display symbol in 402 responses. |
| `KITE_WALLET_ADDRESS` | Yes | — | Merchant `payTo` address. Service refuses to start without it. |
| `OPERATOR_PRIVATE_KEY` | Yes (outbound) | — | Cross-chain downstream signer. **Untouched by WKH-69.** |
| `PASSPORT_REQUIRE_INBOUND` | No | unset | Set to `'true'` (literal, case-sensitive) to mount `requirePassport` guard on routes that opt in. |

## Troubleshooting

### `kpass` not found

The CLI installs to `~/.local/bin` by default. Add it to PATH:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### Wrong directory `~/.kite-passport/` vs `~/.kpass/`

`kpass` uses `~/.kite-passport/` for state (NOT `.kpass/`). The CLI binary
is `kpass` but the dotfile dir is `kite-passport`. Both are gitignored in
this repo by `.gitignore` (`.kite-passport/`).

### `jq` dependency

Some `kpass` shell helpers expect `jq`. Install it:

```bash
sudo apt install jq    # debian/ubuntu
brew install jq        # macOS
```

### Staging faucet returns 500

Known Kite staging issue (unrelated to wasiai-a2a). Use mainnet for the
smoke test, or contact Kite support. Tracking issue is external.

### Telemetry shows `'eoa'` for a Passport call

Means the client did not send `x-passport-session: true`. Either:
- The `kpass` version does not auto-inject the hint header — file an issue
  with Kite or wrap `kpass execute` in a curl that adds it.
- The header value is non-truthy (`'false'`, `'0'`, etc.).

Telemetry is **not** auth — value is `'eoa'` by default and the request
still goes through (CD-WKH69-2 backward compat). Only relevant for analytics.

### `403 PASSPORT_REQUIRED` for an EOA call

Expected when `PASSPORT_REQUIRE_INBOUND=true` is set on the deployment.
Either:
- Switch the caller to Passport (preferred for hackathon demo), or
- Unset `PASSPORT_REQUIRE_INBOUND` env var on Railway and redeploy.

## Related artefacts

- Spike WKH-68: `doc/sdd/spike-kite-passport/{decision-doc.md, poc-results.md, discovery-notes.md}`
- WKH-69 SDD: `doc/sdd/084-wkh-69-passport-hybrid-inbound/sdd.md`
- WKH-69 Story File: `doc/sdd/084-wkh-69-passport-hybrid-inbound/story-WKH-69.md`
- Kite Passport quickstart: https://agentpassport.ai/quickstart/
- Kite chain explorer: https://kitescan.ai (mainnet 2366)
