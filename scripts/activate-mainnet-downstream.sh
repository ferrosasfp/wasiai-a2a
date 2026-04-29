#!/usr/bin/env bash
# Activate hybrid mode: testnet inbound (Kite PYUSD) + Avalanche C-Chain mainnet outbound (USDC).
# Idempotent — variableUpsert overrides existing values.

set -euo pipefail

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

echo "═══════════════════════════════════════════════════════"
echo "  Activate Avalanche mainnet downstream — wasiai-a2a"
echo "═══════════════════════════════════════════════════════"
upsert_var "$A2A_TOKEN" "$A2A_PROJ" "$A2A_ENV" "$A2A_SVC" "WASIAI_DOWNSTREAM_NETWORK" "avalanche-mainnet" "wasiai-a2a"
upsert_var "$A2A_TOKEN" "$A2A_PROJ" "$A2A_ENV" "$A2A_SVC" "AVALANCHE_RPC_URL" "https://api.avax.network/ext/bc/C/rpc" "wasiai-a2a"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Activate Avalanche mainnet chain — wasiai-facilitator"
echo "═══════════════════════════════════════════════════════"
upsert_var "$FAC_TOKEN" "$FAC_PROJ" "$FAC_ENV" "$FAC_SVC" "AVALANCHE_MAINNET_ENABLED" "true" "wasiai-facilitator"
upsert_var "$FAC_TOKEN" "$FAC_PROJ" "$FAC_ENV" "$FAC_SVC" "AVALANCHE_MAINNET_RPC_URL" "https://api.avax.network/ext/bc/C/rpc" "wasiai-facilitator"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ✅ Hybrid mode activated"
echo "  Inbound:  Kite testnet PYUSD (unchanged)"
echo "  Outbound: Avalanche C-Chain MAINNET USDC (NEW)"
echo "  Both Railway services redeploy automatically (~2-3min each)"
echo "═══════════════════════════════════════════════════════"

rm -f "$PYSCRIPT"
