#!/usr/bin/env bash
# WKH-35 — Sweep prod integration-test artifacts (caldzjhjgctpgodldqav).
# Removes every throwaway key created by the WKH-35 test scripts and its
# deposit rows. Keys are matched by their reserved owner_ref prefixes:
#   - wkh35-itest-*  (scripts/smoke-prod-deposit.mjs)
#   - wkh35-deep-*   (scripts/smoke-prod-deposit-deep.mjs)
# These prefixes are test-only, so the sweep can never touch real keys.
# Idempotent: re-running after success is a no-op. Run with `!` after reviewing.
set -euo pipefail

PROD_REF="caldzjhjgctpgodldqav"
A2A_DIR="/home/ferdev/.openclaw/workspace/wasiai-a2a"
OWNER_LIKE="wkh35-%"

PAT=$(grep "^SUPABASE_ACCESS_TOKEN=" "$A2A_DIR/.env" | cut -d'=' -f2- | tr -d '"' | tr -d "'")
if [ -z "$PAT" ]; then
  echo "ERROR: SUPABASE_ACCESS_TOKEN not found in $A2A_DIR/.env" >&2
  exit 1
fi

run_sql() {
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
  echo "OK   [$http_code]: $label  $body"; return 0
}

echo "═══════════════════════════════════════════════════════"
echo "  WKH-35 — pre-cleanup snapshot (owner_ref LIKE '$OWNER_LIKE')"
echo "═══════════════════════════════════════════════════════"
run_sql "SELECT (SELECT count(*) FROM a2a_key_deposits d JOIN a2a_agent_keys k ON k.id=d.key_id WHERE k.owner_ref LIKE '$OWNER_LIKE') AS deposit_rows, (SELECT count(*) FROM a2a_agent_keys WHERE owner_ref LIKE '$OWNER_LIKE') AS key_rows;" "snapshot"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Delete (deposits first → keys, FK-safe)"
echo "═══════════════════════════════════════════════════════"
run_sql "DELETE FROM a2a_key_deposits WHERE key_id IN (SELECT id FROM a2a_agent_keys WHERE owner_ref LIKE '$OWNER_LIKE');" "delete deposit rows"
run_sql "DELETE FROM a2a_agent_keys WHERE owner_ref LIKE '$OWNER_LIKE';" "delete test keys"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Verify: both counts must be 0"
echo "═══════════════════════════════════════════════════════"
run_sql "SELECT (SELECT count(*) FROM a2a_key_deposits d JOIN a2a_agent_keys k ON k.id=d.key_id WHERE k.owner_ref LIKE '$OWNER_LIKE') AS deposit_rows, (SELECT count(*) FROM a2a_agent_keys WHERE owner_ref LIKE '$OWNER_LIKE') AS key_rows;" "post-cleanup verification"

echo ""
echo "✅ Cleanup done."
