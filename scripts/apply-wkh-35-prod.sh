#!/usr/bin/env bash
# WKH-35 — Activate prepaid-deposit budget in prod (caldzjhjgctpgodldqav).
# Applies 2 idempotent migrations via the Supabase Management API, in order:
#   1. 20260529000000_a2a_key_deposits.sql      (anti-replay table + RPC v2)
#   2. 20260529000001_a2a_key_funding_wallet.sql (funding_wallet bind, BLQ-MED-1)
# Run with `!` after reviewing. Stops on first error.
set -euo pipefail

PROD_REF="caldzjhjgctpgodldqav"
A2A_DIR="/home/ferdev/.openclaw/workspace/wasiai-a2a"

PAT=$(grep "^SUPABASE_ACCESS_TOKEN=" "$A2A_DIR/.env" | cut -d'=' -f2- | tr -d '"' | tr -d "'")
if [ -z "$PAT" ]; then
  echo "ERROR: SUPABASE_ACCESS_TOKEN not found in $A2A_DIR/.env" >&2
  exit 1
fi

MIGS=(
  "$A2A_DIR/supabase/migrations/20260529000000_a2a_key_deposits.sql"
  "$A2A_DIR/supabase/migrations/20260529000001_a2a_key_funding_wallet.sql"
)

apply_sql() {
  local sql="$1"; local label="$2"; local payload response http_code body
  payload=$(SQL="$sql" python3 -c "import os, json; print(json.dumps({'query': os.environ['SQL']}))")
  response=$(curl -s -w "\n__HTTP_CODE__%{http_code}" \
    -H "Authorization: Bearer $PAT" -H "Content-Type: application/json" \
    -X POST -d "$payload" \
    "https://api.supabase.com/v1/projects/$PROD_REF/database/query")
  http_code=$(echo "$response" | grep "__HTTP_CODE__" | sed 's/__HTTP_CODE__//')
  body=$(echo "$response" | sed '/__HTTP_CODE__/d')
  if [ "$http_code" != "200" ] && [ "$http_code" != "201" ]; then
    echo "FAIL [$http_code]: $label"; echo "$body" | head -20; return 1
  fi
  echo "OK   [$http_code]: $label"; return 0
}

echo "═══════════════════════════════════════════════════════"
echo "  WKH-35 — apply 2 migrations to $PROD_REF"
echo "═══════════════════════════════════════════════════════"
count=0; total=${#MIGS[@]}
for mig in "${MIGS[@]}"; do
  count=$((count + 1))
  [ -f "$mig" ] || { echo "FAIL: file not found: $mig"; exit 1; }
  apply_sql "$(cat "$mig")" "[$count/$total] $(basename "$mig")" || exit 1
done

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Verify: table + RPC v2 present"
echo "═══════════════════════════════════════════════════════"
apply_sql "SELECT to_regclass('public.a2a_key_deposits') AS deposits_table, EXISTS(SELECT 1 FROM pg_proc WHERE proname='register_a2a_key_deposit' AND pronargs=6) AS rpc_v2, EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='a2a_agent_keys' AND column_name='funding_wallet') AS funding_wallet_col;" "verification"

echo ""
echo "✅ Migrations applied. Next: set Railway env vars + deploy (push main)."
