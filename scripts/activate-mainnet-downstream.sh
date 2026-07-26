#!/usr/bin/env bash
# Activate hybrid mode: testnet inbound (Kite PYUSD) + Avalanche C-Chain mainnet outbound (USDC).
# Idempotent — variableUpsert overrides existing values.
#
# ⚠️ REESCRITO (fix-pack AR-profundo it2, BLQ-MED-2 · 2026-07-26).
# Este script seteaba `WASIAI_DOWNSTREAM_NETWORK=avalanche-mainnet` y anunciaba
# "Hybrid mode activated". Esa env var NO LA LEE NINGÚN ARCHIVO de `src/` (control
# muerto desde WKH-112: la chain del leg downstream la declara el agente en
# `payment.chain`), así que correrlo dejaba al operador creyendo que había activado
# mainnet sin haber activado nada.
#
# El control REAL es el gate FAIL-CLOSED `WASIAI_DOWNSTREAM_MAINNET_ALLOW`
# (`src/lib/downstream-payment.ts`): ausente o vacía ⇒ NINGUNA mainnet settlea en el
# leg downstream (skip-code `MAINNET_NOT_ALLOWED`). Acepta un CSV de slugs o chainIds.
#
# Uso:
#   ./scripts/activate-mainnet-downstream.sh              # activa el opt-in avalanche-mainnet
#   ./scripts/activate-mainnet-downstream.sh --rollback   # vacía el opt-in (vuelve a fail-CLOSED)

set -euo pipefail

MODE="activate"
if [[ "${1:-}" == "--rollback" ]]; then
  MODE="rollback"
elif [[ -n "${1:-}" ]]; then
  echo "Uso: $0 [--rollback]" >&2
  exit 2
fi

A2A_DIR="/home/ferdev/.openclaw/workspace/wasiai-a2a"
FAC_DIR="/home/ferdev/.openclaw/workspace/wasiai-facilitator"

A2A_TOKEN=$(grep "^RAILWAY_TOKEN=" "$A2A_DIR/.env" | cut -d'=' -f2- | tr -d '"' | tr -d "'")
FAC_TOKEN=$(grep "^RAILWAY_TOKEN=" "$FAC_DIR/.env.local" | cut -d'=' -f2- | tr -d '"' | tr -d "'")

# Project + service IDs (verified earlier)
A2A_PROJ="cc694c84-059f-4116-9c31-cb6085e5e79e"
A2A_ENV="a867039e-abc1-4317-aaa9-7409976ad250"
A2A_SVC="27af4db1-9a73-41da-8e12-c2aa6838e52e"
FAC_PROJ="2a4a634b-3ca0-4839-adbf-e0aa6ef8a62f"
FAC_ENV="6a55b904-b072-4c32-a694-c40a3344f07c"
FAC_SVC="e24c3e46-4b86-4edf-8a19-d2d00e690edd"

PYSCRIPT=$(mktemp /tmp/railway-upsert-XXXX.py)
cat > "$PYSCRIPT" <<'PYEOF'
import os, json
payload = {
    "query": "mutation($input: VariableUpsertInput!) { variableUpsert(input: $input) }",
    "variables": {
        "input": {
            "projectId": os.environ["PROJ"],
            "environmentId": os.environ["ENV_ID"],
            "serviceId": os.environ["SVC"],
            "name": os.environ["VAR_NAME"],
            "value": os.environ["VAR_VAL"],
        }
    }
}
print(json.dumps(payload))
PYEOF

upsert_var() {
  local TOKEN="$1" PROJ_ID="$2" ENV_ID="$3" SVC_ID="$4" VAR_NAME="$5" VAR_VAL="$6" SVC_LABEL="$7"
  local PAYLOAD
  PAYLOAD=$(PROJ="$PROJ_ID" ENV_ID="$ENV_ID" SVC="$SVC_ID" VAR_NAME="$VAR_NAME" VAR_VAL="$VAR_VAL" python3 "$PYSCRIPT")
  local RESP
  RESP=$(curl -s -w "HTTPCODE:%{http_code}" "https://backboard.railway.app/graphql/v2" \
    -X POST -H "Project-Access-Token: $TOKEN" -H "Content-Type: application/json" -d "$PAYLOAD")
  if echo "$RESP" | grep -q '"variableUpsert":true'; then
    echo "  OK: $SVC_LABEL.$VAR_NAME"
  else
    echo "  FAIL: $SVC_LABEL.$VAR_NAME → $RESP" >&2
    return 1
  fi
}

if [[ "$MODE" == "rollback" ]]; then
  echo "═══════════════════════════════════════════════════════"
  echo "  ROLLBACK — empty the downstream mainnet opt-in (wasiai-a2a)"
  echo "═══════════════════════════════════════════════════════"
  # Valor vacío = fail-CLOSED (isDownstreamMainnetAllowed devuelve false).
  upsert_var "$A2A_TOKEN" "$A2A_PROJ" "$A2A_ENV" "$A2A_SVC" "WASIAI_DOWNSTREAM_MAINNET_ALLOW" "" "wasiai-a2a"

  echo ""
  echo "═══════════════════════════════════════════════════════"
  echo "  Disable Avalanche mainnet chain — wasiai-facilitator"
  echo "═══════════════════════════════════════════════════════"
  upsert_var "$FAC_TOKEN" "$FAC_PROJ" "$FAC_ENV" "$FAC_SVC" "AVALANCHE_MAINNET_ENABLED" "false" "wasiai-facilitator"

  echo ""
  echo "═══════════════════════════════════════════════════════"
  echo "  ✅ Downstream mainnet opt-in EMPTIED (fail-CLOSED again)"
  echo "  Effect: any downstream leg to a mainnet chain is now skipped"
  echo "          with skip-code MAINNET_NOT_ALLOWED."
  echo "  Both Railway services redeploy automatically (~2-3min each)"
  echo "═══════════════════════════════════════════════════════"
  rm -f "$PYSCRIPT"
  exit 0
fi

echo "═══════════════════════════════════════════════════════"
echo "  Activate Avalanche mainnet downstream — wasiai-a2a"
echo "═══════════════════════════════════════════════════════"
# El ÚNICO control real del leg downstream (gate fail-CLOSED, CSV de slugs/chainIds).
upsert_var "$A2A_TOKEN" "$A2A_PROJ" "$A2A_ENV" "$A2A_SVC" "WASIAI_DOWNSTREAM_MAINNET_ALLOW" "avalanche-mainnet" "wasiai-a2a"
upsert_var "$A2A_TOKEN" "$A2A_PROJ" "$A2A_ENV" "$A2A_SVC" "AVALANCHE_RPC_URL" "https://api.avax.network/ext/bc/C/rpc" "wasiai-a2a"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Activate Avalanche mainnet chain — wasiai-facilitator"
echo "═══════════════════════════════════════════════════════"
upsert_var "$FAC_TOKEN" "$FAC_PROJ" "$FAC_ENV" "$FAC_SVC" "AVALANCHE_MAINNET_ENABLED" "true" "wasiai-facilitator"
upsert_var "$FAC_TOKEN" "$FAC_PROJ" "$FAC_ENV" "$FAC_SVC" "AVALANCHE_MAINNET_RPC_URL" "https://api.avax.network/ext/bc/C/rpc" "wasiai-facilitator"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ✅ Downstream mainnet opt-in SET: avalanche-mainnet"
echo "  Inbound:  Kite testnet PYUSD (unchanged)"
echo "  Outbound: un leg downstream PUEDE settlear en Avalanche C-Chain MAINNET"
echo "            USDC — sólo si el AGENTE declara payment.chain avalanche-mainnet"
echo "            (o 43114). El gateway NO elige la chain del leg."
echo ""
echo "  ⚠️ Falta para que ese leg funcione de verdad (NO lo hace este script):"
echo "     · 'avalanche-mainnet' dentro de WASIAI_A2A_CHAINS (si no, el leg corta"
echo "        con CHAIN_NOT_SUPPORTED: el bundle no existe)."
echo "     · WASIAI_DOWNSTREAM_X402=true."
echo "     · operator wallet con USDC en C-Chain mainnet."
echo "  Rollback: $0 --rollback  (vacía el opt-in ⇒ fail-CLOSED)"
echo "  Both Railway services redeploy automatically (~2-3min each)"
echo "═══════════════════════════════════════════════════════"

rm -f "$PYSCRIPT"
