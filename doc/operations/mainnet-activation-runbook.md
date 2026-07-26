# Mainnet Activation Runbook — WasiAI A2A Protocol

**Status**: Staged (code ready, features flag-gated, env-gated, awaiting founder decision + funding)

**Updated**: 2026-07-07

---

## TL;DR — What to do on Day 1

1. **Fund wallets** — operator gateway + settle relayer (each chain)
2. **Calibrate gas overhead PRIMERO** — `STEP_GAS_OVERHEAD_USD_<chainId>` (mainnet
   only). No es opcional: sin esto, un chainId mainnet en `WASIAI_A2A_CHAINS` hace
   que el proceso **no arranque** en prod (Step 2)
3. **Set Railway env vars** — `WASIAI_A2A_CHAINS` (slug de la mainnet),
   `WASIAI_DOWNSTREAM_MAINNET_ALLOW`, RPC URLs (⚠️ el rail Avalanche mainnet del
   GATEWAY lee `AVALANCHE_RPC_URL`, no `AVALANCHE_MAINNET_RPC_URL` — Prerequisites
   §3). Para Kite mainnet, además, `KITE_NETWORK=mainnet` **y sin slug Kite testnet
   en el CSV** (ver Step 5)
4. **Migrate DB** — WKH-115 inbound tasks table (if adopting inbound bounties)
5. **Activate synthetic canary** — WKH-74 (post-deploy validation)
6. **Set on-call vars** — `HEALTH_MONITOR_TARGETS`, `ONCALL_MENTION` (WKH-77) —
   en **Vercel `wasiai-x402-mcp`**, no en el gateway (Step 4)
7. **Smoke E2E** — verify `/orchestrate` on real mainnet chains with $0.10 USDC
8. **Rollback path** — revert env vars, redeploy (3 min). ⚠️ Las dos envs de Kite
   (`WASIAI_A2A_CHAINS` + `KITE_NETWORK`) se revierten **JUNTAS** o el rail arranca
   roto — ver Rollback

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

> ⚠️ **CORRECCIÓN (fix-pack AR-profundo CR-MAYOR-1, 2026-07-26).** Esta tabla daba
> UN nombre de env por chain, como si los dos servicios usaran el mismo. Para
> Avalanche mainnet **no es así**, y la env equivocada NO falla ruidosamente:
> hace que a2a se saltee el pre-check de fondos del operador y **firme el leg de
> mainnet sin haber verificado que hay plata** (`BALANCE_PRECHECK_SKIPPED`, ver
> `src/lib/downstream-payment.ts` §"balance pre-check"). Cada nombre de abajo fue
> grepeado en el `src/` del servicio que lo lee.

**Un nombre por SERVICIO** (no por chain):

| Chain | En `wasiai-a2a` (gateway) | En `wasiai-facilitator` | Endpoint |
|-------|---------------------------|--------------------------|----------|
| Kite mainnet (2366) | `KITE_MAINNET_RPC_URL`<br><sub>`src/adapters/kite-ozone/payment.ts:204`, `deposit-verifier.ts:137`, `gas-overhead.ts:147`</sub> | `KITE_MAINNET_RPC_URL`<br><sub>`src/chains/kite.ts:36`</sub> | `https://rpc.gokite.ai/` |
| Avalanche C-Chain (43114) | ⚠️ **`AVALANCHE_RPC_URL`**<br><sub>`src/adapters/avalanche/payment.ts:153`, `gasless.ts:197`, `deposit-verifier.ts:139`, `gas-overhead.ts:143`, y el mapa `RPC_ENV_BY_CHAIN['avalanche-mainnet']` de `src/lib/downstream-payment.ts:72`</sub> | `AVALANCHE_MAINNET_RPC_URL`<br><sub>`src/chains/avalanche.ts:63`</sub> | `https://api.avax.network/ext/bc/C/rpc` |
| Base mainnet (8453) | `BASE_MAINNET_RPC_URL`<br><sub>`src/adapters/base/payment.ts:170`, `gasless.ts:211`, `deposit-verifier.ts:143`</sub> | `BASE_MAINNET_RPC_URL`<br><sub>`src/chains/base.ts:81`</sub> | `https://mainnet.base.org/` |

**`AVALANCHE_MAINNET_RPC_URL` tiene CERO lectores en el `src/` de a2a.** El rail
`avalanche-mainnet` del gateway usa el MISMO `AVALANCHE_RPC_URL` que el rail Fuji
(el factory recibe `{network}` por parámetro desde `registry.ts:111-113`, no por
env). Los otros dos rails sí comparten el nombre entre servicios. Coincide con lo
que ya dicen `HACKATHON-FINAL.md` §"Mainnet readiness" y `MULTI-CHAIN.md` §8.
`scripts/activate-mainnet-downstream.sh:113` setea `AVALANCHE_MAINNET_RPC_URL`
**en el facilitator**, que es lo correcto — no lo copies al gateway.

**Note**: Today all three use public RPCs. For production HA, upgrade to paid tier (Alchemy, Quicknode, etc.) per ops decision — beyond scope here.

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

> ⚠️ **CORRECCIÓN (fix-pack AR-profundo CR, barrido completo del archivo,
> 2026-07-26).** Este bloque instruía un JSON `INBOUND_WEBHOOK_SOURCES` que **no
> existe**: 0 lectores en todo el repo. La config real es **una env var por campo
> y por fuente** (`src/services/inbound-task.ts:153-197`, `loadSourceConfig`). Con
> el JSON seteado, `loadSourceConfig` devuelve `null` y **toda** ingesta de esa
> fuente se rechaza.

```bash
# Un set de envs POR FUENTE. El sufijo es el nombre de la fuente pasado por
# `sanitizeSource` (`inbound-task.ts:101-103`): MAYÚSCULAS y se BORRA todo lo que
# no sea [A-Z0-9_] — el guión NO se convierte en `_`, se elimina.
#   source "generic-bounties"  →  sufijo GENERICBOUNTIES
INBOUND_SOURCE_SECRET_GENERICBOUNTIES=<hmac shared secret>        # requerido
INBOUND_SOURCE_A2A_KEY_GENERICBOUNTIES=a2a_xxx                   # requerido
INBOUND_SOURCE_MAX_BUDGET_GENERICBOUNTIES=100.0                  # requerido, finito > 0
INBOUND_SOURCE_DEFAULT_BUDGET_GENERICBOUNTIES=10.0               # opcional, finito >= 0 (default 0)
INBOUND_SOURCE_CHAIN_GENERICBOUNTIES=2368                        # opcional (default: chainId del bundle)
# Cualquier REQUERIDO ausente o inválido ⇒ loadSourceConfig() = null ⇒ la fuente
# entera queda rechazada (fail-closed).
```

**Verification** (headers y esquema de firma reales — `src/routes/inbound.ts:7-8`
y `:69-70`; el `X-Webhook-Signature: hmac_sha256=...` que decía antes no lo lee
nadie):
```bash
# signature = HMAC-SHA256(secret, "<timestamp>.<rawBody>") en HEX
POST https://wasiai-a2a-production.up.railway.app/inbound/generic-bounties/tasks \
  -H "Content-Type: application/json" \
  -H "x-wasiai-timestamp: <unix seconds>" \
  -H "x-wasiai-signature: <hex hmac>" \
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

> ⛔ **CORRECCIÓN (fix-pack AR-profundo CR, barrido completo, 2026-07-26): esto NO
> es opcional en mainnet, es un GATE DE ARRANQUE.** Si `WASIAI_A2A_CHAINS` incluye
> un chainId mainnet (43114 / 8453 / 2366) y no hay ni `STEP_GAS_OVERHEAD_USD` ni
> `STEP_GAS_OVERHEAD_USD_<chainId>`, en producción el proceso **se niega a
> arrancar** (`assertGasOverheadConfigured`, `src/lib/gas-overhead.ts:384-399`,
> invocada en `src/index.ts:55`), y un settle que llegue igual tira
> `GasOverheadUnavailableError` (`gas-overhead.ts:362-373`). ⇒ **Hacé este Step
> ANTES del Step 5.**

**Option A: Manual override (recommended for launch — y obligatoria hoy)**

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

⚠️ No existe ninguna `composeFeeWithOverhead()` (este párrafo la nombraba; 0 hits
en `src/`). El camino real es `getStepGasOverheadUsd(chainId)`
(`src/lib/gas-overhead.ts:362`), llamada por step desde
`src/services/compose.ts:171`, que:
1. Gatea por chainId mainnet — `MAINNET_CHAIN_IDS` = {43114, 8453, 2366}
   (`gas-overhead.ts:49-51`); cualquier testnet devuelve 0 y nunca lanza.
2. Suma el overhead al precio del step (el caller lo paga ARRIBA del precio del
   agente; NO se le settlea al agente — es margen del gateway).
3. Clampea a `[0, $1.00]` (`MAX_OVERHEAD_USD`) — un valor fuera de rango o no
   finito se trata como misconfig y cae a 0 (fail-safe: nunca sobre-cobrar).

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

#### Set env vars in Vercel `wasiai-x402-mcp`

> ⚠️ **CORRECCIÓN (fix-pack AR-profundo CR, barrido completo, 2026-07-26): NO van
> en Railway `wasiai-a2a`.** Las cuatro envs de abajo tienen **0 lectores en el
> `src/` de a2a**; las lee el servicio de monitoreo, que corre en Vercel:
> `HEALTH_MONITOR_TARGETS` y `ONCALL_MENTION` en
> `mcp-servers/wasiai-x402/api/cron/health-check.mjs:85`, `MCP_ALERT_WEBHOOK_URL`
> en `mcp-servers/wasiai-x402/src/alerts.mjs`, `CRON_SECRET` en los mismos
> handlers de cron. Setearlas en el gateway = alerting P0 que nunca dispara,
> silenciosamente (y el propio comando de verificación de este Step ya apunta a
> `wasiai-x402-mcp.vercel.app`).

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
# Switch from testnet to mainnet (fix-pack AR-profundo it2 BLQ-ALTO-1 + MNR-3).
# Kite mainnet exige las DOS envs juntas y NINGÚN slug Kite testnet en el CSV:
#   · `KITE_NETWORK=mainnet` es OBLIGATORIA — `getKiteChain()`/`getKiteNetworkTag()`
#     la leen en call-time, así que el `{network:'mainnet'}` del registry sólo fija el
#     chainConfig; sin la env el adapter firma en 2368 con PYUSD de TESTNET (el
#     registry lo reporta con code=ADAPTER_CHAIN_ID_DRIFT).
#   ⛔ pero con un slug Kite TESTNET en el CSV esa misma env hace que
#     `kite-ozone-testnet` (bundle construido sin `opts`) apunte a chainId 2366
#     (USDC.e MAINNET) — dinero real bajo un slug testnet, que engañaba al gate
#     fail-CLOSED de WKH-144 y al opt-in del leg downstream: `initAdapters` LANZA.
#   ⇒ los dos rails Kite NO pueden convivir en un proceso (TD-NEW-KITE-PARAMS).
# Fuente única: doc/architecture/MULTI-CHAIN.md §8.
WASIAI_A2A_CHAINS=kite-mainnet   # was: kite-ozone-testnet
KITE_NETWORK=mainnet             # was: <unset>/testnet
# ⚠️ CORRECCIÓN (fix-pack AR-profundo FIX 1c, 2026-07-26): `WASIAI_DOWNSTREAM_NETWORK`
# NO la lee ningún archivo de src/ (control muerto desde WKH-112 — la chain del leg
# downstream se resuelve por agent.payment.chain). El control REAL es el gate
# fail-CLOSED de abajo: ausente/vacío ⇒ NINGUNA mainnet settlea en el leg downstream
# (skip-code MAINNET_NOT_ALLOWED). CSV de slugs o chainIds.
WASIAI_DOWNSTREAM_MAINNET_ALLOW=avalanche-mainnet   # was: <unset> (fail-closed)

# ⚠️ CORRECCIÓN 2 (fix-pack AR-profundo CR-MAYOR-1, 2026-07-26): acá vivían dos
# envs que a2a NO lee. Verificado con grep sobre el src/ de los DOS servicios:
#
#   · `BASE_ENABLED=true` → CERO lectores, en a2a Y en el facilitator. Control
#     100% muerto (el facilitator usa BASE_SEPOLIA_ENABLED / BASE_MAINNET_ENABLED,
#     `src/chains/base.ts:114-123`). En a2a el control REAL de Base es el SLUG en
#     `WASIAI_A2A_CHAINS` (`base-mainnet`), como cualquier otro rail.
#   · `AVALANCHE_MAINNET_RPC_URL` → CERO lectores en el src/ de a2a. El rail
#     `avalanche-mainnet` del gateway lee `AVALANCHE_RPC_URL`
#     (`src/lib/downstream-payment.ts:72`, `src/adapters/avalanche/payment.ts:153`).
#     El nombre con `_MAINNET_` existe pero es del FACILITATOR
#     (`src/chains/avalanche.ts:63`) — dos servicios, dos nombres, por diseño.
#     Setear el equivocado NO falla ruidoso: `RPC_ENV_BY_CHAIN['avalanche-mainnet']`
#     queda vacío ⇒ el pre-check de balance se saltea con
#     `BALANCE_PRECHECK_SKIPPED` (`downstream-payment.ts`, paso 9 de `signAndSettleDownstream`, guard `if (!rpc)`) ⇒ el leg de
#     MAINNET firma sin verificar fondos. Ver la tabla de Prerequisites §3.

# Base mainnet (opcional): se habilita agregando el slug al CSV de arriba, p.ej.
# WASIAI_A2A_CHAINS=kite-mainnet,base-mainnet
# (y BASE_MAINNET_ENABLED=true en el facilitator — ver el bloque de abajo).

# RPC URLs (point to mainnet) — nombres del GATEWAY, no del facilitator
KITE_MAINNET_RPC_URL=https://rpc.gokite.ai/
AVALANCHE_RPC_URL=https://api.avax.network/ext/bc/C/rpc   # NO `AVALANCHE_MAINNET_RPC_URL`
BASE_MAINNET_RPC_URL=https://mainnet.base.org/
```

⛔ **Orden obligatorio: Step 2 (gas overhead) ANTES de este Step.** Con un chainId
mainnet en `WASIAI_A2A_CHAINS` y sin `STEP_GAS_OVERHEAD_USD` /
`STEP_GAS_OVERHEAD_USD_<chainId>`, el proceso **se niega a arrancar** en producción
(`assertGasOverheadConfigured`, `src/lib/gas-overhead.ts:384-399`, llamada desde
`src/index.ts:55`). Si hacés este Step primero, el deploy no levanta.

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
# Verify in Railway logs: "Adapters initialized" lists `kite-mainnet` in startup
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

> ⛔ **CORRECCIÓN (fix-pack AR-profundo CR-MAYOR-2, 2026-07-26). Este
> procedimiento dejaba el sistema PEOR que antes y afirmaba lo contrario.**
> Seteaba `KITE_NETWORK=testnet` y vaciaba el gate, pero **no revertía
> `WASIAI_A2A_CHAINS`**, que el Step 5 puso en `kite-mainnet`. El resultado era
> `WASIAI_A2A_CHAINS=kite-mainnet` + `KITE_NETWORK=testnet` ⇒
> `chainConfig.chainId=2366` / `getPaymentAdapter('kite-mainnet').chainId=2368` /
> `getToken()` = PYUSD de **testnet** ⇒ `ADAPTER_CHAIN_ID_DRIFT`: el rail arranca
> ROTO (config mainnet, firma testnet). Es exactamente el bundle que pinnea
> `src/adapters/__tests__/registry.test.ts` (T-it2-MNR-3-reg). Un rollback de
> emergencia que rompe el rail que venís a salvar no es un rollback.
>
> Las dos envs de Kite se mueven **SIEMPRE JUNTAS**, en las dos direcciones (misma
> regla que la activación — `MULTI-CHAIN.md` §8, `HACKATHON-FINAL.md`
> §"Mainnet readiness" B).

If mainnet activation breaks revenue path:

```bash
# 1. In Railway wasiai-a2a — las dos envs de Kite JUNTAS (una sola = rail roto):
WASIAI_A2A_CHAINS=kite-ozone-testnet        # ⚠️ IMPRESCINDIBLE: volver al CSV testnet
                                            # (el valor exacto que tenías antes del Step 5)
KITE_NETWORK=                               # vaciar/unset (NO 'testnet' a secas: da igual el
                                            # valor, pero dejarla seteada no aporta nada y el
                                            # default ya es testnet — kite-ozone/chain.ts:46)
WASIAI_DOWNSTREAM_MAINNET_ALLOW=            # vaciar = fail-closed (rollback del leg downstream)

# 2. In Railway wasiai-facilitator:
KITE_MAINNET_ENABLED=false
AVALANCHE_MAINNET_ENABLED=false
BASE_MAINNET_ENABLED=false

# 3. Deploy (automatic on env var change)
git push origin main

# Wait ~2 min for Railway auto-deploy
# 4. VERIFICAR EL LOG DE STARTUP — el rollback no está hecho hasta que se cumplan
#    las dos cosas:
#      · `Adapters initialized` lista SÓLO slugs testnet (sin `kite-mainnet`)
#      · NO aparece ninguna línea `ADAPTER_CHAIN_ID_DRIFT`
#    Si aparece el drift, quedó una de las dos envs de Kite a medio revertir.
```

**Result**: si y sólo si los dos checks del paso 4 pasan, el tráfico vuelve a Kite
testnet (PYUSD) + Avalanche Fuji (USDC testnet) y el revenue path de producción
queda restaurado. (Antes de esta corrección este párrafo afirmaba
"reverts to testnet-only behavior" incondicionalmente, incluso en la combinación
que arranca rota.)

**`MAINNET_ENABLED` a secas NO existe**: la instrucción "(unset `MAINNET_ENABLED`
flags if set)" que vivía acá no tiene lector en ningún repo (0 hits en el `src/` de
a2a y del facilitator). Los flags reales son los tres `*_MAINNET_ENABLED` del
facilitator, ya listados arriba.

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
- **Gas overhead**: `src/lib/gas-overhead.ts` (live calc + env override + boot assert)
- **Mainnet chains**: `src/adapters/chain-resolver.ts` — ⚠️ el path que decía acá
  (`src/lib/chain-resolver.ts`) NO existe. Ahí viven `classifyEvmChainId` /
  `classifyDestinationEnvironment` / `findChainEnvironmentDrift`.
- **Gate mainnet del leg downstream**: `src/lib/downstream-payment.ts`
  (`isDownstreamMainnetAllowed` → `WASIAI_DOWNSTREAM_MAINNET_ALLOW`) + el mapa
  `RPC_ENV_BY_CHAIN` (qué env de RPC lee cada rail del GATEWAY)
- **Coherencia testnet/mainnet al arrancar**: `src/adapters/registry.ts`
  (`checkChainEnvironmentCoherence`)
- **Health monitoring**: `mcp-servers/wasiai-x402/src/health-monitor.mjs` (WKH-77)
- **Synthetic monitoring**: `mcp-servers/wasiai-x402/src/synthetic-tx-monitor.mjs` (WKH-74)
- **Inbound adapter**: `src/routes/inbound.ts` (WKH-115)
- **Runbooks**: 
  - `doc/operations/oncall-runbook.md` (escalation)
  - `doc/operations/gas-funding-runbook.md` (wallet management)
  - `doc/operations/identities-runbook.md` (operator identity backup)

---

**Last updated**: 2026-07-26 (fix-pack AR-profundo, CR MAYOR-1 + MAYOR-2 + barrido
completo del archivo). Toda env var citada en este runbook fue grepeada contra el
`src/` del servicio que la lee (a2a y `wasiai-facilitator`). Envs RETIRADAS por no
tener ningún lector: `WASIAI_DOWNSTREAM_NETWORK`, `BASE_ENABLED`, `MAINNET_ENABLED`,
`INBOUND_WEBHOOK_SOURCES`, y `AVALANCHE_MAINNET_RPC_URL` **en el bloque del
gateway** (sigue siendo válida en el del facilitator).

**Next revision**: Post-mainnet-go-live (capture lessons learned)
