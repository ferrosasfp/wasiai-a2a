# Synthetic Monitoring Runbook (WKH-74)

Operational guide for the synthetic payment-path monitoring of the WasiAI A2A
ecosystem, plus the **manual activation steps** for the native error-rate
alerting on Vercel and Railway (capa C — doc-only in v1, DT-6).

This complements — it does **not** replace — the existing
[`oncall-runbook.md`](./oncall-runbook.md) (WKH-77). All alerts land in the same
Discord channel **#wasiai-alerts** via `MCP_ALERT_WEBHOOK_URL` +
`src/alerts.mjs::sendAlert`.

---

## 1. What WKH-74 adds (automated, already live once env is set)

| Layer | Cron | Cadence | Spend | What it proves |
|-------|------|---------|-------|----------------|
| **A** free payment probe | `api/cron/synthetic-payment-check.mjs` | 15 min | $0 | `/orchestrate` still answers the exact x402 **402 challenge** (right `payTo`/`asset`/`network`) — a silent money-path break a green `/health` would miss. |
| **D** real-tx probe | `api/cron/synthetic-tx-check.mjs` | 1 h (gated) | ~1 tx per deploy (~$0.02/mo) | after each gateway **deploy**, a real settle actually lands on-chain (tx hash verified). |

Both reuse the shared Discord alerting (CD-1). Capa A alerts with
`reason: synthetic-payment-path-broken`; capa D with
`reason: post-deploy-synthetic-tx-failed`. Both are `severity: critical`.

### Activation checklist (env vars — see `.env.example` for full docs)

- **Capa A**: `SYNTH_ORCHESTRATE_URL`, `SYNTH_EXPECT_PAYTO`, `SYNTH_EXPECT_ASSET`,
  `SYNTH_EXPECT_NETWORK`. (Optional: `SYNTH_PROBE_GOAL`, `SYNTH_PROBE_BUDGET`,
  `SYNTH_PROBE_TIMEOUT_MS`.)
- **Capa D**: `MONITOR_A2A_KEY` (dedicated funded Agent Key, ~$0.05),
  `RAILWAY_TOKEN`, `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`,
  `RAILWAY_SERVICE_ID`, plus a configured KV (`KV_REST_API_URL` /
  `KV_REST_API_TOKEN`). (Optional: `MONITOR_TX_GOAL`, `MONITOR_TX_BUDGET`,
  `MONITOR_TX_TIMEOUT_MS`.)

  > **`MONITOR_TX_GOAL` MUST settle.** Capa D pays via `x-a2a-key` (prepago), so
  > the `/orchestrate` response never carries a top-level `kiteTxHash`; the
  > on-chain proof comes ONLY from a `pipeline.steps[].txHash` emitted by a
  > downstream settle. Point `MONITOR_TX_GOAL` at a capability that provably
  > settles at least one step (e.g. the **"AVAX price"** pattern →
  > `wasi-chainlink-price`). A goal that orchestrates but never settles would
  > make capa D fire a **false-positive** critical alert on every deploy.
- Register the two cron jobs: `npm run setup:cronjob` (provisions all 8 jobs
  idempotently on cron-job.org).

If any required var is unset, the corresponding cron **no-ops** (warnOnce + 200)
— it never fails the tick.

---

## 2. Capa C — native error-rate alerting (MANUAL activation)

WKH-74 does **not** automate these toggles (no stable API to verify them without
broadening credentials — DT-6). Activate them by hand in each provider UI and
point every one at **#wasiai-alerts**.

### 2.1 Vercel — `wasiai-x402-mcp` (the MCP server)

1. Open the Vercel dashboard → project **`wasiai-x402-mcp`**.
2. **Settings → Monitoring** (or **Observability → Alerts**, depending on plan).
3. Enable **Error Rate** / **Function Errors** alerting.
   - Condition: error rate over a rolling 5–15 min window above a small
     threshold (e.g. > 5% of invocations or > N 5xx in the window).
4. **Add notification channel → Webhook** (or the native Slack/Discord
   integration if enabled on the account):
   - Point it at the same Discord webhook used by `MCP_ALERT_WEBHOOK_URL`
     (channel **#wasiai-alerts**). For a raw Discord webhook URL, append
     `/slack` if Vercel emits a Slack-shaped payload, or use a Discord
     integration if available.
5. Save. Trigger a test error (or use the provider's "send test alert") and
   confirm a message lands in **#wasiai-alerts**.

> Note: on the Vercel **Hobby** plan native alerting may be limited. In that case
> the WKH-77 health monitor (`x402-mcp` target, `mode: reachability`) already
> catches a hard 5xx/outage — the native toggle is a finer-grained addition, not
> the primary safety net.

### 2.2 Railway — `wasiai-a2a` (the gateway / payment path)

1. Open the Railway dashboard → project **`wasiai-a2a`** → the gateway service.
2. **Settings → Notifications** (project-level) / **Observability**.
3. Enable **deployment failure** and **crash / restart** notifications, and — if
   available on the plan — an **HTTP error-rate** / log-based alert on 5xx.
4. **Add a webhook / Discord integration** pointing at **#wasiai-alerts** (same
   Discord webhook as `MCP_ALERT_WEBHOOK_URL`).
5. Save and send a test notification to confirm delivery.

### 2.3 Railway — `wasiai-facilitator` (the x402 settle relayer)

Repeat 2.2 for the **`wasiai-facilitator`** project/service. This is the
component whose silent settle-timeout caused the 2026-07-05 Chaski-$0 incident,
so its error-rate + crash notifications are the highest-value manual toggle here.

---

## 3. Responding to a synthetic alert

| Alert `reason` | Meaning | First action |
|----------------|---------|--------------|
| `synthetic-payment-path-broken` | `/orchestrate` did not return the expected 402 challenge (wrong status/shape, or `payTo`/`asset`/`network` drift, or unreachable). | Check the gateway `/health`, then curl `/orchestrate` with no auth header and inspect the 402 `accepts[0]`. A `payTo`/`asset`/`network` mismatch means a **config drift** — compare against `SYNTH_EXPECT_*`. |
| `post-deploy-synthetic-tx-failed` | After a deploy, a real settle did not land (HTTP error / no tx hash / `pipeline.success:false`). | Inspect the gateway + facilitator logs for the last hour. The KV deploy id was **not** advanced, so the probe **retries every hour** until it passes — a persistent alert means the money-path is genuinely broken. |

Escalation path and on-call mention behaviour: see
[`oncall-runbook.md`](./oncall-runbook.md).

---

## 4. Guarantees (why these are safe to run in prod)

- **Capa A never spends** (CD-4): the probe sends a "naked" request with no
  `x-a2a-key` / `Authorization` / `x-payment` / `payment-signature` header, so it
  always 402s before any billing logic.
- **Capa D spends ≈1 tx per deploy** (CD-5): a real-tx runs only when the Railway
  deploy id changed vs the KV last-known value.
- **Fail-open** (CD-3): any monitor error (RPC/KV/fetch/timeout) is logged and the
  cron still returns 200 — a monitor failure never tumbles the tick.
- **No secrets in alerts** (CD-7): only public identifiers (severity, reason,
  service, url, httpStatus, checkedAt) reach Discord; the Agent Key, Railway
  token and raw tx never appear.
