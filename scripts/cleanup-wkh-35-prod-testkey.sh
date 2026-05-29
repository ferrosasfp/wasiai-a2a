#!/usr/bin/env bash
# WKH-35 — Clean up the prod integration-test artifacts (caldzjhjgctpgodldqav).
# Removes the throwaway key created by scripts/smoke-prod-deposit.mjs and its
# deposit rows. Idempotent: re-running after success is a no-op.
#   - a2a key id   = e4f81389-755c-4296-bf61-ab25cd341825
#   - owner_ref    = wkh35-itest-1780082935982
# Run with `!` after reviewing. Stops on first error.
set -euo pipefail

PROD_REF="caldzjhjgctpgodldqav"
A2A_DIR="/home/ferdev/.openclaw/workspace/wasiai-a2a"
KEY_ID="e4f81389-755c-4296-bf61-ab25cd341825"
OWNER_REF="wkh35-itest-1780082935982"

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
echo "  WKH-35 — pre-cleanup snapshot"
echo "═══════════════════════════════════════════════════════"
run_sql "SELECT (SELECT count(*) FROM a2a_key_deposits WHERE key_id='$KEY_ID') AS deposit_rows, (SELECT count(*) FROM a2a_agent_keys WHERE id='$KEY_ID' AND owner_ref='$OWNER_REF') AS key_rows;" "snapshot"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Delete (deposits first → key, FK-safe)"
echo "═══════════════════════════════════════════════════════"
run_sql "DELETE FROM a2a_key_deposits WHERE key_id='$KEY_ID';" "delete deposit rows"
run_sql "DELETE FROM a2a_agent_keys WHERE id='$KEY_ID' AND owner_ref='$OWNER_REF';" "delete test key"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Verify: both counts must be 0"
echo "═══════════════════════════════════════════════════════"
run_sql "SELECT (SELECT count(*) FROM a2a_key_deposits WHERE key_id='$KEY_ID') AS deposit_rows, (SELECT count(*) FROM a2a_agent_keys WHERE id='$KEY_ID') AS key_rows;" "post-cleanup verification"

echo ""
echo "✅ Cleanup done."
