# Mainnet Activation Runbook

**Status**: 📋 Staged — config in code, not yet activated
**Decision required**: Fernando + ops decision on RPC providers, monitoring, on-call rotation
**Estimated cost (first month)**: ~$30-50 USDC (operator wallet + a2a operations)

---

## Pre-flight checklist

Before activating mainnet, ALL of these must be true:

- [ ] **Operator wallet funded**:
  - [ ] Avalanche C-Chain mainnet: ≥10 USDC (Circle native, contract `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E`)
  - [ ] Avalanche C-Chain mainnet: ≥0.1 AVAX (gas)
  - [ ] Kite mainnet: ≥10 USDC.e (`0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e`)
  - [ ] Kite mainnet: ≥0.1 KITE (gas)
- [ ] **RPC provider chosen**:
  - [ ] Avalanche: official `https://api.avax.network/ext/bc/C/rpc` OR Infura/Alchemy/Quicknode endpoint with API key
  - [ ] Kite mainnet: `https://rpc.gokite.ai/` (single official RPC at time of writing)
- [ ] **Monitoring**:
  - [ ] Operator wallet balance alerts (low balance ≤ 5 USDC threshold)
  - [ ] Facilitator circuit breaker alerts (any state != CLOSED)
  - [ ] Latency p95 alerts (>40s for compose, >35s for orchestrate)
- [ ] **Code review**:
  - [ ] PR `feat/068-mainnet-support-kite-avalanche` (a2a) — merged
  - [ ] PR `feat/mainnet-support-kite-avalanche` (facilitator) — merged
- [ ] **Backup operator wallet**:
  - [ ] Secondary wallet with same funding (in case primary key rotation needed mid-incident)
- [ ] **Hackathon judges informed** (if applicable):
  - [ ] Mainnet activation date
  - [ ] How to verify on KiteScan + Snowtrace mainnet explorers

---

## Activation sequence

### Step 1 — Activate Avalanche mainnet (downstream USDC outbound)

> ⚠️ **CORRECCIÓN (fix-pack AR-profundo FIX 1c, 2026-07-26).** Este Step
> instruía `WASIAI_DOWNSTREAM_NETWORK=avalanche-mainnet`. Esa env var **NO LA LEE
> NINGÚN ARCHIVO DE `src/`** (desde WKH-112 la chain del leg downstream se
> resuelve por `agent.payment.chain` vía `normalizeChainSlug`): setearla NO
> activaba ni bloqueaba nada. Era un control muerto.
>
> El control REAL es el gate **fail-CLOSED** `WASIAI_DOWNSTREAM_MAINNET_ALLOW`
> (`src/lib/downstream-payment.ts`, `isDownstreamMainnetAllowed`): ausente o
> vacía ⇒ NINGUNA mainnet puede settlear en el leg downstream (skip-code
> `MAINNET_NOT_ALLOWED`). Además `avalanche-mainnet` debe estar en
> `WASIAI_A2A_CHAINS` para que su bundle exista.
>
> El comando de abajo ya usa la env correcta, **pero setea sólo el gate**. Las
> otras tres piezas del rail (ampliado en el fix-pack CR-MAYOR-1, cada una
> verificada contra `src/`):
>
> - `WASIAI_DOWNSTREAM_X402=true` (`src/lib/downstream-payment.ts:42`) — sin esto
>   el leg no settlea nunca (skip `FLAG_OFF`).
> - `WASIAI_A2A_CHAINS` con `avalanche-mainnet` — lector:
>   `src/adapters/registry.ts:318` (`const csvRaw = process.env.WASIAI_A2A_CHAINS`,
>   dentro de `initAdapters`). Sin el slug, el bundle no existe y el leg corta con
>   `CHAIN_NOT_SUPPORTED`, emitido en `src/lib/downstream-payment.ts:543`.
>   *(Re-CR MENOR-5: acá se citaba `registry.ts:268`, que es
>   `if (adapterChainId === configChainId) return;` — el early-return del chequeo 2
>   de coherencia, nada que ver con el CSV.)*
> - ⚠️ **`AVALANCHE_RPC_URL`** en a2a (`src/adapters/avalanche/payment.ts:153` y el
>   mapa `RPC_ENV_BY_CHAIN['avalanche-mainnet']` de
>   `src/lib/downstream-payment.ts:72`). **NO `AVALANCHE_MAINNET_RPC_URL`**: ese
>   nombre tiene 0 lectores en el `src/` de a2a y es el del FACILITATOR
>   (`wasiai-facilitator/src/chains/avalanche.ts:63`) — el Step 3 lo setea allá,
>   que es donde va. Setear el equivocado en a2a no falla ruidoso: el pre-check de
>   balance del operador se saltea con `BALANCE_PRECHECK_SKIPPED`
>   (`downstream-payment.ts`, paso 9 de `signAndSettleDownstream`, guard `if (!rpc)`) y **el leg de mainnet firma sin verificar
>   fondos**.
> - Fondos: USDC nativo en el operator wallet de C-Chain.
>
> Automatizable: `./scripts/activate-mainnet-downstream.sh` (y `--rollback`).

```bash
RAILWAY_TOKEN=<a2a-railway-token>

# Set on wasiai-a2a-production service
curl -X POST "https://backboard.railway.app/graphql/v2" \
  -H "Project-Access-Token: $RAILWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation($i: VariableUpsertInput!) { variableUpsert(input: $i) }",
    "variables": {
      "i": {
        "projectId": "cc694c84-059f-4116-9c31-cb6085e5e79e",
        "environmentId": "a867039e-abc1-4317-aaa9-7409976ad250",
        "serviceId": "27af4db1-9a73-41da-8e12-c2aa6838e52e",
        "name": "WASIAI_DOWNSTREAM_MAINNET_ALLOW",
        "value": "avalanche-mainnet"
      }
    }
  }'
```

Wait Railway redeploy (~2-3min). Verify:

```bash
curl https://wasiai-a2a-production.up.railway.app/health
# { "status": "ok", "version": "0.1.0", ... }
```

### Step 2 — Activate Kite mainnet inbound

> ⚠️ **CORRECCIÓN 2 (fix-pack AR-profundo it2 MNR-3, 2026-07-26).** La versión
> original de este Step instruía `KITE_NETWORK=mainnet` junto al CSV testnet, y la
> corrección anterior (BLQ-ALTO-1) se fue al otro extremo: "NO usar esa env var,
> activá sólo por slug". Un probe con factories reales mostró que ninguna de las
> dos funciona. La verdad, medida:
>
> - `KITE_NETWORK=mainnet` **con un slug Kite testnet** en el CSV ⇒ el bundle de
>   `kite-ozone-testnet` (que se construye SIN `opts`) apunta a chainId **2366**
>   (USDC.e real): dinero real bajo un slug testnet, que engañaba al gate
>   fail-CLOSED de WKH-144 y al opt-in del leg downstream. Hoy
>   `registry.initAdapters` **LANZA** (`assertNoSlugDestinationDrift`).
> - el slug `kite-mainnet` **sin** `KITE_NETWORK=mainnet` ⇒ arranca con
>   `chainConfig.chainId=2366` pero el ADAPTER firma en **2368** con PYUSD de
>   testnet (lee la env en call-time, y el `finally` del factory ya la restauró);
>   el registry lo reporta con `code=ADAPTER_CHAIN_ID_DRIFT`.
> - ⇒ los dos rails Kite **no pueden convivir** en el mismo proceso
>   (`TD-NEW-KITE-PARAMS`).

```bash
# Activar Kite mainnet: las TRES envs juntas (fuente única: doc/architecture/MULTI-CHAIN.md §8).
WASIAI_A2A_CHAINS=kite-mainnet          # el slug mainnet y NINGÚN slug Kite testnet
KITE_NETWORK=mainnet                    # obligatoria: el adapter la lee en call-time
KITE_MAINNET_RPC_URL=https://rpc.gokite.ai/
# Verificar en el log de startup que NO aparezca ADAPTER_CHAIN_ID_DRIFT.
```

Verify the 402 challenge now references USDC.e on Kite mainnet:

```bash
curl -X POST https://wasiai-a2a-production.up.railway.app/compose \
  -H "Content-Type: application/json" -d '{"steps":[]}'

# Expected response shape:
# {
#   "accepts": [{
#     "network": "eip155:2366",          ← mainnet chain
#     "asset": "0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e",  ← USDC.e
#     ...
#   }]
# }
```

### Step 3 — Activate facilitator mainnet chains

```bash
FAC_TOKEN=<facilitator-railway-token>

# Set 4 vars on wasiai-facilitator service
for var in \
  "KITE_MAINNET_ENABLED:true" \
  "AVALANCHE_MAINNET_ENABLED:true" \
  "KITE_MAINNET_RPC_URL:https://rpc.gokite.ai/" \
  "AVALANCHE_MAINNET_RPC_URL:https://api.avax.network/ext/bc/C/rpc"; do
  KEY=$(echo $var | cut -d: -f1)
  VAL=$(echo $var | cut -d: -f2-)
  # variableUpsert API call — same pattern as Step 1
done
```

Verify `/supported` now lists 4 chains:

```bash
curl https://wasiai-facilitator-production.up.railway.app/supported

# Expected:
# {
#   "chains": [
#     {"network": "eip155:2368",  "name": "Kite Testnet",   "breakerState": "CLOSED"},
#     {"network": "eip155:43113", "name": "Avalanche Fuji", "breakerState": "CLOSED"},
#     {"network": "eip155:2366",  "name": "Kite Mainnet",   "breakerState": "CLOSED"},   ← NEW
#     {"network": "eip155:43114", "name": "Avalanche",      "breakerState": "CLOSED"}    ← NEW
#   ]
# }
```

### Step 4 — Verify v2 marketplace agent registrations

The `agents` table in `caldzjhjgctpgodldqav` has agents registered with their `payment.contract` (USDC contract) and `payment.chain`. For mainnet support:

```sql
-- Check current agent payment configs
SELECT slug, payment->>'chain', payment->>'contract'
FROM agents
WHERE status = 'active'
  AND ((payment->>'chain') = 'avalanche-fuji'
       OR (payment->>'chain') = 'avalanche-mainnet');
```

If agents are still pointing to Fuji testnet, decide:
- **Option A**: keep agents on Fuji testnet, only switch operator path to mainnet (mismatched — won't work)
- **Option B**: re-register agents on mainnet (creator action via v2 dashboard)

Likely **Option B**: each agent creator must update their agent's `payment.chain` and contract via v2 marketplace UI.

### Step 5 — Smoke real-money

```bash
# Run smoke with low budget (~$0.10)
A2A_URL=https://app.wasiai.io/api/v1 node scripts/smoke-prod-via-app-wasiai.mjs

# Verify on snowtrace (mainnet, NOT testnet):
# https://snowtrace.io/tx/<hash>
# https://kitescan.ai/tx/<hash>   (Kite mainnet — confirm correct explorer URL)
```

Expected: 4 onchain txs (1 Kite mainnet inbound + 3 Avalanche mainnet outbound). Latency similar to testnet (mainnet RPC may be faster due to higher TPS).

### Step 6 — Documentation update

Update `HACKATHON-FINAL.md`:
- Section "Live Demo URLs" — note mainnet explorers
- Section "Verifiable On-Chain Proofs" — add mainnet section with new txs
- Section "Mainnet readiness" — change status to "ACTIVATED 2026-MM-DD"

---

## Rollback (if mainnet activation fails)

> ⛔ **CORRECCIÓN 3 (fix-pack AR-profundo CR-MAYOR-2, 2026-07-26). La versión
> anterior de este rollback dejaba el sistema PEOR que antes y afirmaba lo
> contrario.** Seteaba `KITE_NETWORK=testnet` pero **no revertía
> `WASIAI_A2A_CHAINS`**, que el Step 2 de arriba puso en `kite-mainnet`. Esa
> combinación (`WASIAI_A2A_CHAINS=kite-mainnet` + `KITE_NETWORK=testnet`) es
> justamente la que el propio Step 2 documenta como rota: `chainConfig.chainId`
> 2366 / `getPaymentAdapter('kite-mainnet').chainId` 2368 / `getToken()` = PYUSD de
> **testnet** ⇒ `ADAPTER_CHAIN_ID_DRIFT`. Y el texto cerraba con *"System reverts to
> testnet-only behavior"*, o sea el procedimiento de emergencia rompía el rail que
> venía a salvar Y decía que estaba bien.
>
> Regla: **las dos envs de Kite se mueven SIEMPRE JUNTAS, en las dos direcciones**
> (activación y rollback). Es la misma regla que ya declaran `MULTI-CHAIN.md` §8 y
> `HACKATHON-FINAL.md` §"Mainnet readiness" B.

```bash
# NO es "single command": son tres envs en a2a, y las dos de Kite van juntas.
# wasiai-a2a service
WASIAI_A2A_CHAINS=kite-ozone-testnet   # ⚠️ IMPRESCINDIBLE: el CSV testnet exacto que
                                       # tenías antes del Step 2. Omitirlo = rail roto.
KITE_NETWORK=                          # vaciar/unset junto con el CSV (cualquier valor
                                       # != 'mainnet' resuelve testnet — kite-ozone/chain.ts:46)
# Vaciar el gate = fail-CLOSED: ninguna mainnet puede settlear en el leg
# downstream (el rollback real; `WASIAI_DOWNSTREAM_NETWORK=fuji` NO hacía nada).
WASIAI_DOWNSTREAM_MAINNET_ALLOW=

# wasiai-facilitator service
KITE_MAINNET_ENABLED=false
AVALANCHE_MAINNET_ENABLED=false
```

Both services auto-redeploy in ~2-3min. **El rollback NO está hecho hasta verificar
el log de startup de a2a**: `Adapters initialized` debe listar sólo slugs testnet
(sin `kite-mainnet`) **y** no debe aparecer ninguna línea
`ADAPTER_CHAIN_ID_DRIFT`. Recién con esas dos cosas el sistema volvió a
testnet-only; si aparece el drift, quedó una de las dos envs de Kite a medio
revertir.

If problem is more severe (e.g., bug in mainnet path), the PRs are revertible:
```bash
gh pr revert <a2a-mainnet-PR>
gh pr revert <facilitator-mainnet-PR>
```

---

## Hybrid mode — testnet + mainnet simultaneously

The architecture supports running BOTH testnet and mainnet at the same time (chain allowlist permits it). Use case: test mainnet flow without disabling testnet for ongoing demo activity.

> ⚠️ **CORRECCIÓN 4 (fix-pack AR-profundo CR, barrido completo, 2026-07-26).** Este
> bloque estaba escrito antes de WKH-MULTICHAIN y describía un a2a mono-chain: decía
> "only ONE network active at a time per request", ponía el override por header como
> "TD: future enhancement" y de ahí recomendaba **dos servicios Railway separados**.
> Las tres cosas están desactualizadas:
> - a2a inicializa **N bundles** desde el CSV `WASIAI_A2A_CHAINS`: el CSV se lee en
>   `src/adapters/registry.ts:318` y el loop que construye y registra un bundle por
>   slug es `src/adapters/registry.ts:369-375`. *(Re-CR MENOR-5: se citaba
>   `:291-325`, que hoy es el docstring de `checkChainEnvironmentCoherence` + el
>   arranque de `initAdapters` — el rango quedó desfasado por el refactor del propio
>   fix-pack.)*
> - el override por request **ya existe**: header `x-payment-chain`
>   (`src/adapters/chain-resolver.ts`, prioridad DT-1 header > manifest > default).
> - ⇒ un segundo servicio Railway NO hace falta para el hybrid mode… **salvo por
>   Kite**, que es la excepción real: los dos rails Kite no pueden convivir en un
>   proceso (`TD-NEW-KITE-PARAMS`), porque el adapter lee `KITE_NETWORK` en
>   call-time. Kite testnet + Kite mainnet a la vez SÍ requiere dos procesos.

```bash
# Enable mainnet WITHOUT disabling testnet
KITE_MAINNET_ENABLED=true        # facilitator
AVALANCHE_MAINNET_ENABLED=true   # facilitator

# a2a: multi-chain real vía CSV — p.ej. Fuji testnet + Avalanche mainnet juntos:
WASIAI_A2A_CHAINS=kite-ozone-testnet,avalanche-fuji,avalanche-mainnet
# y por request: -H "x-payment-chain: avalanche-mainnet"
#
# ⛔ EXCEPCIÓN Kite: NO metas `kite-ozone-testnet` y `kite-mainnet` en el mismo CSV.
#    Con KITE_NETWORK=mainnet el arranque LANZA; sin ella el rail mainnet firma en
#    testnet (ADAPTER_CHAIN_ID_DRIFT). Para los dos rails Kite: dos servicios
#    Railway. Ver doc/architecture/MULTI-CHAIN.md §8 + TD-NEW-KITE-PARAMS.
```

**Recommendation**: do NOT run hybrid mode initially. Activate mainnet, validate, then plan multi-network architecture if business value justifies it.

---

## Monitoring post-activation

| Metric | Threshold | Source |
|--------|-----------|--------|
| Operator wallet balance USDC mainnet | > 2 USDC | Snowtrace API + cron |
| Operator wallet balance USDC.e Kite mainnet | > 2 USDC.e | KiteScan API + cron |
| Facilitator breaker state | == CLOSED for all 4 chains | `GET /supported` |
| Compose p95 latency | < 40s | Vercel logs |
| Error rate `/api/v1/compose` | < 0.5% | Vercel logs |
| 5xx from a2a → v2 | == 0 | Vercel logs |

---

## Decisions outstanding (Fernando)

1. **RPC provider for Avalanche mainnet** — official endpoint (free, rate-limited) vs paid (Infura/Alchemy/Quicknode). For demo: official is fine. For production traffic: paid recommended.
2. **Smart contract for protocol fees on mainnet** — currently fees go to operator wallet. Consider deploying a multi-sig + fee splitter for transparency.
3. **MCP mainnet** — current `mcp` flag is OFF in `V2_DELEGATE_TO_A2A`. Decide whether to delegate MCP via proxy (breaks Claude Desktop) or keep legacy.
4. **Agent re-registration** — coordinate with creators to update agent `payment.chain` from `avalanche-fuji` to `avalanche-mainnet`.
5. **Pricing strategy** — agent prices are USDC-denominated. Same nominal price on mainnet works (USDC = $1). Consider if Kite mainnet KITE-denominated pricing makes sense long-term.

---

*Generated 2026-04-28 by Claude Code autonomous prep — for Fernando's review on activation day*

*Revisado 2026-07-26 (fix-pack AR-profundo, CR MAYOR-1 + MAYOR-2 + barrido completo):
toda env var citada acá fue grepeada contra el `src/` del servicio que la lee (a2a y
`wasiai-facilitator`). Correcciones: (1) `WASIAI_DOWNSTREAM_NETWORK` retirada (0
lectores), (2) las 3 envs acopladas de Kite mainnet, (3) el rollback revierte
`WASIAI_A2A_CHAINS` junto con `KITE_NETWORK` — antes producía un rail roto y decía
que estaba bien, (4) el hybrid mode ya no asume un a2a mono-chain, (5) el Step 1
agrega las 3 piezas que faltaban del rail downstream, incluida
`AVALANCHE_RPC_URL` (gateway) vs `AVALANCHE_MAINNET_RPC_URL` (facilitator).*

*Re-revisado 2026-07-26 (re-CR MENOR-5) — **las citas `archivo:línea` también se
verificaron abriendo cada línea**, no sólo las envs. La revisión anterior había
calculado 2 de ellas ANTES de su propio refactor de `registry.ts` (+22 líneas) y
quedaron apuntando a otro código: `registry.ts:268` (era el early-return de
`checkAdapterChainIdDrift`) → el lector del CSV es `registry.ts:318`, y
`registry.ts:291-325` (era un docstring) → el loop de N bundles es
`registry.ts:369-375`. Se agregó además de dónde se EMITE `CHAIN_NOT_SUPPORTED`
(`downstream-payment.ts:543`). Método reproducible en
`doc/operations/mainnet-activation-runbook.md` §"Verificación de este runbook".
Alcance NO cubierto por grep, igual que allá: los IDs de Railway y los valores que
viven en consolas externas (project/environment/service IDs, tokens) — existen como
envs, pero su VALOR sólo se confirma en el dashboard el día de la activación.*
