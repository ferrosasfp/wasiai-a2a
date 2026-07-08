# Mainnet Activation Runbook — WasiAI A2A Protocol

**Status**: Staged (code ready, features flag-gated, env-gated, awaiting founder decision + funding)

**Updated**: 2026-07-07

---

## TL;DR — What to do on Day 1

1. **Fund wallets** — operator gateway + settle relayer (each chain)
2. **Set Railway env vars** — `KITE_NETWORK`, `WASIAI_DOWNSTREAM_NETWORK`, RPC URLs
3. **Migrate DB** — WKH-115 inbound tasks table (if adopting inbound bounties)
4. **Activate synthetic canary** — WKH-74 (post-deploy validation)
5. **Set on-call vars** — `HEALTH_MONITOR_TARGETS`, `ONCALL_MENTION` (WKH-77)
6. **Calibrate gas overhead** — `STEP_GAS_OVERHEAD_USD_<chainId>` (mainnet only)
7. **Smoke E2E** — verify `/orchestrate` on real mainnet chains with $0.10 USDC
8. **Rollback path** — revert env vars, redeploy (3 min)

---

## ⛔ Blocking prerequisite — Marketplace contract upgradeability (WKH-130)

**Esto DEBE estar hecho ANTES de activar mainnet en serio. No es un toggle de Day-1: es una migración de contrato.**

Decisión del founder (2026-07-08, ver WKH-130): el `WasiAIMarketplace` (custodial, no-upgradeable hoy) se migra a **UUPS (upgradeable proxy)** antes de crecer TVL en mainnet. Razón: hoy cada fix del marketplace = redeploy + migración de estado + address-drift (lo que arreglamos parcialmente en WKH-162). Con TVL mainnet creciendo, quedar en un contrato custodial no-upgradeable es una trampa.

| Item | Qué | Repo | Estado |
|------|-----|------|--------|
| Rewrite `WasiAIMarketplace.sol` → UUPS | initializer + `_authorizeUpgrade` (multisig+timelock) + storage layout congelado | wasiai-v2 | ⬜ pendiente (QUALITY + AR + auditoría externa recomendada) |
| Redeploy `WasiEscrow.sol` → proxy nuevo | su `immutable marketplace` queda stale (opción A: repoint, no UUPS) | wasiai-v2 | ⬜ pendiente |
| Migración one-time de estado mainnet | mover earnings + keyBalances de los 8 agentes del marketplace viejo → proxy (SDD de migración propio) | wasiai-v2 | ⬜ pendiente |
| Update env vars al proxy nuevo | `MARKETPLACE_CONTRACT_ADDRESS` + `NEXT_PUBLIC_MARKETPLACE_ADDRESS_*` (el assert de coherencia de WKH-162 los blinda contra drift) | wasiai-v2 | ⬜ pendiente |

**Contratos que NO se tocan:** `WasiAIEscrow.sol` (repo a2a, cross-chain), `CobrayaInvoiceCommitments.sol` (Cobraya). Diferido hasta que el foco pase de "a2a como cerebro" a la activación mainnet del marketplace. Detalle completo + scope en WKH-130.

### DB cleanup pre-mainnet (WKH-147)
El DROP de las 4 columnas legacy de `creator_profiles` (`total_earnings`, `pending_earnings_usdc`, `account_status`, `email_domain` — post WKH-SEC-03) YA se aplicó a **bdwv** (2026-07-08, verificado). Falta aplicarlo a **caldz** (mainnet) — misma migración, project ref `caldzjhjgctpgodldqav`. SQL en `wasiai-v2/supabase/migrations/20260708000000_wkh147_drop_creator_profiles_legacy_columns.sql`. Verificación pre-DROP dio GO (0 usos en código). Correr como parte de esta activación.

---

## ⛔ Blocking prerequisite — Relevancia semántica del money-path (WKH-160)

**NO se pasa a mainnet sin esto** (decisión del founder, 2026-07-09).

La relevancia del money-path (discovery de agentes + drop del plan) usa matching **léxico** (overlap de palabras), intrínsecamente frágil — rompió el flujo estrella de remesas 2 veces (WKH-163 por el número "400"; WKH-166 por la palabra "best"). En WKH-166 se **neutralizó el drop léxico** (el plan del LLM es autoritativo) como parche money-safe, pero eso **expande la superficie de over-charge**: el caller paga el plan completo del LLM aunque incluya un agente poco relevante. En testnet es tolerable; en **mainnet con dinero real, NO**.

WKH-160 reemplaza el matching léxico por **semántico (embeddings)** → un drop CONFIABLE de vuelta (sabe que KYC es relevante a una remesa y que un agente de clima no lo es) + cruza idiomas (goal ES ↔ agente EN).

| Item | Qué | Estado |
|------|-----|--------|
| Fase 1 shadow-mode | correr el scorer semántico en paralelo, medir calidad con tráfico real sin actuar | ⬜ pendiente |
| Voyage (embeddings) | modelo de embeddings — API con costo por llamada (cacheable) | ⬜ pendiente (setear API key) |
| pgvector (Supabase) | almacenar vectores + búsqueda por similitud coseno | ⬜ pendiente |
| Re-enganche del drop | re-habilitar el smart-drop en el hook `tokenizeForRelevance`/`textOverlapsGoal` (dejado inerte en WKH-166) | ⬜ pendiente |

SDD ya existe: `doc/sdd/163-wkh-160-semantic-embeddings-relevance/`. WKH-160 rebasa sobre el estado post-WKH-166. Detalle completo en WKH-160.

---

## Prerequisites

### 1. **Accesos y credenciales**

Requerido antes de empezar:

| Resource | Access | Who | Status |
|----------|--------|-----|--------|
| Supabase `caldz` (prod DB) | Admin token + SQL editor | founder | [CONFIRMAR] |
| Railway `wasiai-a2a` project | Env vars editor + deployment | founder | [CONFIRMAR] |
| Railway `wasiai-facilitator` project | Env vars editor + deployment | founder | [CONFIRMAR] |
| Vercel `wasiai-x402-mcp` | Env vars editor (cron activation) | founder | [CONFIRMAR] |
| cron-job.org account | API token (`CRON_SECRET`) | founder | [CONFIRMAR] |
| Discord webhook `#wasiai-alerts` | URL (`MCP_ALERT_WEBHOOK_URL`) | founder | [CONFIRMAR] |

### 2. **Wallet funding (per chain)**

**Operator wallets** que pagan gas en los settles. Fondeo mínimo recomendado:

| Wallet | Chain | Asset | Amount | Used For | Status |
|--------|-------|-------|--------|----------|--------|
| `0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba` | Kite mainnet (2366) | USDC.e | $50 | settle gas overhead | [CONFIRMAR, ver infra bajo] |
| `0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba` | Avalanche C-Chain (43114) | USDC native | $100 | settle gas + outbound agent pays | [CONFIRMAR] |
| `0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba` | Base mainnet (8453) | USDC native | $50 | settle gas (si enabled) | [CONFIRMAR] |
| `0x9c0638...` (facilitator settle wallet, en `wasiai-facilitator`) | Avalanche C-Chain (43114) | AVAX nativo | $2 (~100 txs) | settlement gas relay | [CONFIRMAR] |

**Cómo verificar**: 
```bash
# Avalanche C-Chain (43114) → Snowtrace
https://snowtrace.io/address/0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba

# Kite mainnet (2366) → KiteScan
https://mainnet.kitescan.ai/address/0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba

# Base mainnet (8453) → BaseScan
https://basescan.io/address/0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba
```

### 3. **RPC endpoints — prod grade**

| Chain | RPC URL Env Var | Endpoint | Rationale |
|-------|-----------------|----------|-----------|
| Kite mainnet (2366) | `KITE_MAINNET_RPC_URL` | `https://rpc.gokite.ai/` | Canonical (Kite operated) |
| Avalanche C-Chain (43114) | `AVALANCHE_MAINNET_RPC_URL` | `https://api.avax.network/ext/bc/C/rpc` | Public (suitable for testnet vol) |
| Base mainnet (8453) | `BASE_MAINNET_RPC_URL` | `https://mainnet.base.org/` | Canonical |

**Note**: Today both use public RPCs. For production HA, upgrade to paid tier (Alchemy, Quicknode, etc.) per ops decision — beyond scope here.

---

## Activation Steps

### Step 1 — WKH-115: Inbound Tasks Migration (if adopting bounties)

**Decision point**: Do you want to accept external bounty/task sources pushing to `/inbound/:source/tasks`? If NO, skip to Step 2.

#### If YES — Apply migration

```bash
# 1. Connect to caldz Supabase (prod DB)
# 2. Run migration (find in repo):
#    doc/sdd/155-wkh-115-inbound-adapter/migration.sql
#    (if not found, generate from work-item.md Scope IN)

# Creates: a2a_inbound_tasks table
#   - Columns: owner_ref, source, external_ref, status, goal, budget_usdc, 
#              constraints, orchestration_id, error_reason, created_at, updated_at
#   - Index: idx_a2a_inbound_tasks_owner_ref
#   - RLS: enabled (patrón WKH-SEC-02)
```

#### Set env vars in Railway `wasiai-a2a`

```bash
# Per-source webhook HMAC secrets (example: generic webhook source)
INBOUND_WEBHOOK_SOURCES='[
  {
    "source": "generic-bounties",
    "hmacSecret": "hmac_abc123...",
    "agentKeyId": "a2a_xxx",
    "maxBudgetPerTask": 100.0,
    "budgetDefault": 10.0
  }
]'
```

**Verification**: 
```bash
POST https://wasiai-a2a-production.up.railway.app/inbound/generic-bounties/tasks \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Signature: hmac_sha256=..." \
  -d '{"goal": "...", "budget": 50.0}'
# Should return 201 + ingestion record (if signature valid)
```

---

### Step 2 — Gas Accounting: STEP_GAS_OVERHEAD_USD (critical mainnet only)

**Problem**: On mainnet, settlement gas costs ($0.10–0.50 per settle) > 1% protocol fee on cheap agents → gateway operates at a loss. Solution: Add a per-step gas overhead the caller pays (on top of agent price) to recover settlement gas.

#### Calculation formula (per chain)

```
gas_overhead_usd = (gasPrice_wei × gas_units_for_settle / 1e18) × nativeTokenUsd
```

**Example mainnet rates** (calibrate to reality before go-live):

| Chain | Gas estimate | Price (wei) | Native/USD | Overhead/step |
|-------|--------------|-------------|-----------|----------------|
| Avalanche C-Chain | 21k units | 25 gwei | $50 AVAX | ~$0.01–0.05 |
| Kite mainnet | 21k units | [CONFIRMAR] | $1–2 USD equivalent | ~$0.01–0.10 |
| Base mainnet | 21k units | 1–3 gwei | ~$1800 ETH | ~$0.001–0.05 |

#### Set in Railway `wasiai-a2a`

**Option A: Manual override (recommended for launch)**

```bash
# Flat override (all chains)
STEP_GAS_OVERHEAD_USD=0.02

# Or per-chain (more granular)
STEP_GAS_OVERHEAD_USD_43114=0.03     # Avalanche C-Chain
STEP_GAS_OVERHEAD_USD_2366=0.05      # Kite mainnet
STEP_GAS_OVERHEAD_USD_8453=0.02      # Base mainnet (if enabled)
```

**Option B: Live calculation (future, requires CoinGecko API)**

- See `src/lib/gas-overhead.ts` for details
- Today: live calc exists but defaults to env fallback (0)
- On mainnet: set flat env vars above to manually pin values

#### Verification

The `composeFeeWithOverhead()` function (in `src/services/compose.ts`) will:
1. Gate by mainnet chain ID (testnet stays 0)
2. Add the overhead to the step price
3. Log the overhead applied in telemetry

**Post-deploy test**:
```bash
# Orchestrate a 2-step pipeline with STEP_GAS_OVERHEAD_USD=0.02
# Verify the quote includes +$0.02 per step in totalCostUsdc
POST https://wasiai-a2a-production.up.railway.app/orchestrate/plan \
  -H "Authorization: Bearer <agent-key>" \
  -d '{"goal": "Check price of Avalanche token on 2 exchanges"}'
# totalCostUsdc should be: (step1_price + 0.02) + (step2_price + 0.02) + 1% fee
```

---

### Step 3 — Activate Synthetic Monitoring (WKH-74)

**Purpose**: Post-deploy, verify that `/orchestrate` actually works on mainnet (not just 200-ok from RPC).

#### Deploy `wasiai-x402-mcp` with WKH-74 code

1. Ensure PR/branch `feat/151-wkh-74-synthetic-monitoring` is merged to `main`
2. Push to Vercel: synthetic cron jobs register on deploy (via `setup-cronjob.mjs`)
3. Verify new jobs in cron-job.org dashboard:
   - `wasiai-x402-synthetic-payment-check` (every 15 min, layer A: expect-402)
   - `wasiai-x402-synthetic-tx-check` (every 1 hour, layer D: real-tx gated by deploy SHA)

#### Create dedicated monitoring Agent Key

```sql
-- In Supabase caldz:
INSERT INTO a2a_agent_keys (owner_ref, name, key, budget_usdc, ...)
VALUES (
  'owner_synthetic_monitor',
  'WKH-74 Synthetic Monitor',
  'a2a_synthetic_monitor_xxx',
  0.10,  -- $0.10 budget for ~100 real-tx probes
  ...
);
-- Copy the generated `key` to env var below
```

#### Set env vars in Vercel `wasiai-x402-mcp`

```bash
# Layer A probe (expect-402, $0)
# — no special env needed, probe is unauthenticated

# Layer D probe (real-tx, $~0.02/deploy)
SYNTHETIC_MONITOR_AGENT_KEY="a2a_synthetic_monitor_xxx"
SYNTHETIC_MONITOR_EXPECTED_PAYTO="0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba"
SYNTHETIC_MONITOR_MAX_COST_USDC="100.0"
SYNTHETIC_MONITOR_DEPLOY_IDENTIFIER_KV_KEY="wkh74_deploy_sha_mainnet"

# Reuse existing alert webhook
MCP_ALERT_WEBHOOK_URL="https://discord.com/api/webhooks/..."
```

#### Verification

Wait ~15 min for the first cron tick, then check Discord `#wasiai-alerts`:
- Layer A alert should appear every 15 min (free probe, always 402 expected)
- Layer D alert should appear 1× per deploy (on SHA change), with tx hash

---

### Step 4 — On-Call Alerting: ONCALL_MENTION (WKH-77)

**Purpose**: Health monitor detects outages every 4 min. For P0 critical alerts (revenue path down), notify the on-call operator.

#### Set env vars in Railway `wasiai-a2a`

```bash
# Health targets (copy from doc/operations/oncall-runbook.md)
HEALTH_MONITOR_TARGETS='[
  {
    "label": "gateway-a2a",
    "url": "https://wasiai-a2a-production.up.railway.app/health",
    "tier": "P0",
    "logsUrl": "https://railway.app/project/.../service/wasiai-a2a"
  },
  {
    "label": "facilitator",
    "url": "https://wasiai-facilitator-production.up.railway.app/health",
    "tier": "P0",
    "degradedPath": "degraded",
    "logsUrl": "https://railway.app/project/.../service/wasiai-facilitator"
  },
  {
    "label": "x402-mcp",
    "url": "https://wasiai-x402-mcp.vercel.app",
    "tier": "P1",
    "reachabilityOnly": true,
    "logsUrl": "https://vercel.com/wasiai/.../..."
  },
  {
    "label": "app-wasiai",
    "url": "https://app.wasiai.io",
    "tier": "P1",
    "logsUrl": "https://vercel.com/wasiai/.../..."
  }
]'

# Discord mention for P0 alerts (critical)
# Get user/role ID from Discord, format as <@ID> or <@&ROLE_ID>
ONCALL_MENTION="<@FOUNDER_DISCORD_ID>"

# Reuse existing webhook
MCP_ALERT_WEBHOOK_URL="https://discord.com/api/webhooks/..."

# Cron secret (already set if WKH-77 was deployed)
CRON_SECRET="<same as existing>"
```

#### Verification

Test the alert:
```bash
# Trigger a dry-run test alert
GET https://wasiai-x402-mcp.vercel.app/api/cron/health-check?dryRun=1 \
  -H "Authorization: Bearer <CRON_SECRET>"

# Should return 200 and send 4 test alerts to Discord
# Verify that ONCALL_MENTION appears in the P0 (critical) embed
```

See `doc/operations/oncall-runbook.md` for full escalation procedures.

---

### Step 5 — Railway Env Vars: Network Selection (code stage-gated, env-gated)

#### In `wasiai-a2a-production` (Gateway)

```bash
# Switch from testnet to mainnet
KITE_NETWORK=mainnet                          # was: testnet
WASIAI_DOWNSTREAM_NETWORK=avalanche-mainnet  # was: fuji

# If enabling Base (optional)
BASE_ENABLED=true

# RPC URLs (point to mainnet)
KITE_MAINNET_RPC_URL=https://rpc.gokite.ai/
AVALANCHE_MAINNET_RPC_URL=https://api.avax.network/ext/bc/C/rpc
BASE_MAINNET_RPC_URL=https://mainnet.base.org/
```

**Impact**: 
- `/health` should still return `{status: "ok", ...}`
- `/supported` endpoint should now list mainnet chains
- `/orchestrate` will route to mainnet agents / settles

#### In `wasiai-facilitator-production`

```bash
# Enable mainnet settle adapters
KITE_MAINNET_ENABLED=true
AVALANCHE_MAINNET_ENABLED=true
BASE_MAINNET_ENABLED=true

# RPC URLs
KITE_MAINNET_RPC_URL=https://rpc.gokite.ai/
AVALANCHE_MAINNET_RPC_URL=https://api.avax.network/ext/bc/C/rpc
BASE_MAINNET_RPC_URL=https://mainnet.base.org/

# Operator wallet (same wallet that has gas funded in Step 2)
OPERATOR_WALLET_ADDRESS=0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba
OPERATOR_PRIVATE_KEY=<from secrets manager, NOT plaintext>
```

#### Deploy both services

```bash
git push origin main
# or manually trigger Railway deploy via dashboard
# Verify in Railway logs: "KITE_NETWORK=mainnet" appears in startup
```

---

### Step 6 — DB Restore Drill (WKH-76, optional but recommended)

**Purpose**: Validate RTO/RPO before mainnet traffic. If caldz loses data, can we recover?

**Status**: [CONFIRMAR — WKH-76 spec exists in Jira but HU not implemented yet]

**When ready** (post-founder approval):
1. Document PITR window (Supabase enterprise tier required for >24h)
2. Schedule monthly restore simulation on staging DB
3. Measure RTO / RPO / verification time
4. Update runbook with exact steps

**For now**: Supabase caldz has built-in daily backups (included in free tier). Restore available via Supabase dashboard. See `doc/operations/identities-runbook.md` for manual backup steps.

---

### Step 7 — Circuit-Breaker Gate (automatic, no config)

**What happens automatically**:

The facilitator x402 adapter (per-chain) includes **per-chain circuit breakers** that open if a chain's RPC is unavailable. On mainnet:

- If Avalanche RPC fails → breaker opens, settles on that chain return 503
- If Kite RPC fails → breaker opens, settles on Kite return 503
- If Base RPC fails → breaker opens, if enabled, return 503
- Other chains unaffected (breach isolation)

**No env var needed** — the breaker is **fail-closed by default** (rejects on doubt, doesn't proceed with partial settlement).

**Monitoring**: Check facilitator `/health` endpoint — if `degraded:true`, a breaker may be open. See `oncall-runbook.md` for diagnosis steps.

---

## Smoke Test — End-to-End (Step 8)

### Pre-flight checklist

- [ ] Wallets funded (Step 2)
- [ ] Railway vars set (Step 5)
- [ ] DB migrated if inbound enabled (Step 1)
- [ ] Synthetic monitoring deployed (Step 3)
- [ ] On-call alerting deployed & vars set (Step 4)
- [ ] Gas overhead env vars set (Step 2)
- [ ] Deploy succeeded (check Railway logs)

### Run smoke test

```bash
# 1. Verify /health endpoints return 200
curl -i https://wasiai-a2a-production.up.railway.app/health
curl -i https://wasiai-facilitator-production.up.railway.app/health

# 2. Verify /supported lists mainnet chains
curl -H "Authorization: Bearer <agent-key>" \
  https://wasiai-a2a-production.up.railway.app/supported

# 3. Run a small real orchestrate (goal + budget $0.50)
curl -X POST https://wasiai-a2a-production.up.railway.app/orchestrate \
  -H "Authorization: Bearer <agent-key>" \
  -d '{
    "goal": "What is the price of AVAX on mainnet?",
    "budget": 0.50
  }'

# Should return:
# - kiteTxHash (verifiable on KiteScan mainnet explorer)
# - steps executed
# - totalCostUsdc < budget
# - success: true
```

### Verify on-chain

```bash
# Get the kiteTxHash from response, check on KiteScan mainnet
https://mainnet.kitescan.ai/tx/<kiteTxHash>

# Should show:
# - USDC inbound from caller
# - USDC outbound to agent(s) on Avalanche / other chain
# - Timestamp = now (verifies network is live)
```

---

## Rollback — Emergency Revert (3 min)

If mainnet activation breaks revenue path:

```bash
# 1. In Railway wasiai-a2a:
KITE_NETWORK=testnet
WASIAI_DOWNSTREAM_NETWORK=fuji
# (unset MAINNET_ENABLED flags if set)

# 2. In Railway wasiai-facilitator:
KITE_MAINNET_ENABLED=false
AVALANCHE_MAINNET_ENABLED=false
BASE_MAINNET_ENABLED=false

# 3. Deploy (automatic on env var change)
git push origin main

# Wait ~2 min for Railway auto-deploy
# Verify /health and /orchestrate redirect back to testnet
```

**Result**: All traffic reverts to Kite testnet (PYUSD) + Avalanche Fuji (USDC testnet). Production revenue path restored.

---

## Post-Activation Checklist

### Day 1 (Go-live)

- [ ] All smoke tests PASS (Step 8)
- [ ] Layer A synthetic probes firing every 15 min (Discord confirms)
- [ ] Health monitor running (4 min cadence)
- [ ] Real transaction on-chain verified (KiteScan + Snowtrace)
- [ ] On-call mentioned in first P0 test alert (if triggered)
- [ ] Log first 10 real transactions, verify cost ≈ quote

### Week 1

- [ ] Monitor facilitator wallet balance (should decrease by settlement gas cost)
- [ ] Check for any `health-degraded` alerts (none expected on stable RPC)
- [ ] Verify operator wallet gas levels (should not drop to warning threshold)
- [ ] Run manual restore simulation on staging (WKH-76)

### Ongoing

- [ ] WKH-74 synthetic probes: verify post-deploy validation works
- [ ] WKH-77 health monitor: confirm alerts reach on-call mention
- [ ] Gas overhead: if mainnet fee margin is negative, increase `STEP_GAS_OVERHEAD_USD`

---

## Related Tickets — Status

| Ticket | Feature | Status | Notes |
|--------|---------|--------|-------|
| **WKH-71** | Operator wallet balance alerts (gas low) | DONE | Monitoring live on testnet; reuses on mainnet |
| **WKH-74** | Synthetic monitoring (post-deploy validation) | DONE | Code merged; activate in Step 3 of this runbook |
| **WKH-77** | On-call health monitor + escalation | DONE | Code merged; activate in Step 4 |
| **WKH-115** | Inbound bounty adapter (push-based tasks) | DONE | Migration optional; enable in Step 1 if needed |
| **WKH-73** | Rollback drill | [DEFERRED] | See Rollback section above — manual procedure documented |
| **WKH-76** | DB restore drill (PITR simulation) | [DEFERRED] | See Step 6 — Supabase built-in backup available |
| **WKH-144** | x402 settle re-verify fail-closed mainnet | DONE | Automatic; no config needed |

---

## Troubleshooting

### Symptom: `/orchestrate` returns 200 but `success: false`

**Cause**: Likely RPC timeout or facilitator degraded.

**Check**: 
1. `curl https://wasiai-facilitator-production.up.railway.app/health` — if `degraded:true`, see oncall-runbook WKH-77
2. Check RPC endpoint reachability: `curl https://api.avax.network/ext/bc/C/rpc -X POST -d '{"jsonrpc":"2.0","method":"eth_blockNumber"}'`
3. If RPC down, it's a dependency issue, not a code issue — use rollback above

### Symptom: Circuit breaker opened (503 from settle)

**Cause**: Chain RPC unreachable or rate-limited.

**Check**: 
1. Facilitator `/health` → `degraded:true` + details
2. Manually curl the RPC from your machine (verify connectivity)
3. If RPC is down globally, wait for recovery (no action needed — breaker will auto-reset)
4. If only our requests hit rate limit, upgrade RPC to paid tier

### Symptom: Gas overhead too high / operator losing money

**Cause**: `STEP_GAS_OVERHEAD_USD` calibrated wrong.

**Fix**: 
1. Measure actual settlement gas cost on mainnet (Snowtrace gas tracker)
2. Recalculate formula above
3. Update `STEP_GAS_OVERHEAD_USD_<chainId>` in Railway
4. Redeploy

---

## References

- **Payment path**: `src/services/compose.ts` (fee calculation + gas overhead injection)
- **Gas overhead**: `src/lib/gas-overhead.ts` (live calc + env override)
- **Mainnet chains**: `src/lib/chain-resolver.ts` (mainnet IDs gated)
- **Health monitoring**: `mcp-servers/wasiai-x402/src/health-monitor.mjs` (WKH-77)
- **Synthetic monitoring**: `mcp-servers/wasiai-x402/src/synthetic-tx-monitor.mjs` (WKH-74)
- **Inbound adapter**: `src/routes/inbound.ts` (WKH-115)
- **Runbooks**: 
  - `doc/operations/oncall-runbook.md` (escalation)
  - `doc/operations/gas-funding-runbook.md` (wallet management)
  - `doc/operations/identities-runbook.md` (operator identity backup)

---

**Last updated**: 2026-07-07 (nexus-docs consolidation)

**Next revision**: Post-mainnet-go-live (capture lessons learned)
