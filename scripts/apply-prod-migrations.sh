#!/usr/bin/env bash
# Apply 13 a2a + facilitator migrations to caldzjhjgctpgodldqav (prod)
# Each migration runs as a single SQL transaction (Supabase Management API).
# Idempotent: CREATE TABLE IF NOT EXISTS, ON CONFLICT DO NOTHING, ADD COLUMN IF NOT EXISTS.
# Stop on first error.
#
# ⚠️ FOOTGUN (auditoría 2026-06-25): el gateway de PROD usa la DB
# `caldzjhjgctpgodldqav` (a2a_agent_keys, budgets, RPC de refund). Pero el
# `.env` local tiene `SUPABASE_URL` apuntando a `bdwvrwzvsldephfibmuu` (la DB
# del catálogo de wasiai-v2, DB EQUIVOCADA para el money-path). Por eso este
# script HARDCODEA `PROD_REF` (NO lo deriva de SUPABASE_URL) y abajo verifica
# que el target es realmente la DB de dinero antes de aplicar nada. Si escribís
# otro applier, NO derives el ref de SUPABASE_URL — hardcodeá caldz o reusá el
# guard de abajo. Ver memoria `db-topology-caldz-bdwv`.

set -euo pipefail

PROD_REF="caldzjhjgctpgodldqav"
A2A_DIR="/home/ferdev/.openclaw/workspace/wasiai-a2a"
FAC_DIR="/home/ferdev/.openclaw/workspace/wasiai-facilitator"

PAT=$(grep "^SUPABASE_ACCESS_TOKEN=" "$A2A_DIR/.env" | cut -d'=' -f2- | tr -d '"' | tr -d "'")
if [ -z "$PAT" ]; then
  echo "ERROR: SUPABASE_ACCESS_TOKEN not found in $A2A_DIR/.env" >&2
  exit 1
fi

# Pre-flight guard: confirmá que $PROD_REF ES la DB de dinero del gateway antes
# de aplicar. Marcador distintivo: la RPC `refund_with_dest_policy` (WKH-129)
# existe SOLO en caldz, no en bdwv. Si falta, abortamos: estamos apuntando a la
# DB equivocada y aplicar migraciones de dinero ahí sería un desastre silencioso.
echo "Pre-flight: verificando que $PROD_REF es la DB de dinero del gateway…"
GUARD_PAYLOAD=$(python3 -c "import json; print(json.dumps({'query': \"SELECT count(*) AS n FROM pg_proc WHERE proname='refund_with_dest_policy';\"}))")
GUARD=$(curl -s -H "Authorization: Bearer $PAT" -H "Content-Type: application/json" -X POST \
  -d "$GUARD_PAYLOAD" "https://api.supabase.com/v1/projects/$PROD_REF/database/query" \
  | python3 -c "import json,sys
try:
  d=json.load(sys.stdin); print(d[0]['n'] if isinstance(d,list) and d else 0)
except Exception: print(0)")
if [ "$GUARD" != "1" ]; then
  echo "ABORT: $PROD_REF NO tiene refund_with_dest_policy → NO es la DB de dinero del gateway." >&2
  echo "       Revisá PROD_REF. El gateway de prod usa caldzjhjgctpgodldqav (NO el SUPABASE_URL del .env)." >&2
  exit 1
fi
echo "Pre-flight OK: $PROD_REF es la DB de dinero del gateway."

# Ordered list — order matters (CREATE before ALTER, base before seeds)
MIGS=(
  "$A2A_DIR/supabase/migrations/kite_schema_transforms.sql"
  "$A2A_DIR/supabase/migrations/20260401000000_kite_registries.sql"
  "$A2A_DIR/supabase/migrations/20260403180000_tasks.sql"
  "$A2A_DIR/supabase/migrations/20260404000000_mock_community_registry.sql"
  "$A2A_DIR/supabase/migrations/20260404200000_events.sql"
  "$A2A_DIR/supabase/migrations/20260406000000_a2a_agent_keys.sql"
  "$A2A_DIR/supabase/migrations/20260421015829_a2a_protocol_fees.sql"
  "$A2A_DIR/supabase/migrations/20260426120000_kite_schema_transforms_schema_hash.sql"
  "$A2A_DIR/supabase/migrations/20260427160000_secure_rpc_search_path.sql"
  "$A2A_DIR/supabase/migrations/20260427210000_registries_owner_ref.sql"
  "$A2A_DIR/supabase/migrations/20260427230000_kite_schema_transforms_owner.sql"
  "$FAC_DIR/supabase/migrations/001_facilitator_settlements.sql"
  "$FAC_DIR/supabase/migrations/002_facilitator_audit_log.sql"
)

apply_sql() {
  local sql="$1"
  local label="$2"
  local payload
  payload=$(SQL="$sql" python3 -c "import os, json; print(json.dumps({'query': os.environ['SQL']}))")
  local response
  local http_code
  response=$(curl -s -w "\n__HTTP_CODE__%{http_code}" \
    -H "Authorization: Bearer $PAT" \
    -H "Content-Type: application/json" \
    -X POST \
    -d "$payload" \
    "https://api.supabase.com/v1/projects/$PROD_REF/database/query")
  http_code=$(echo "$response" | grep "__HTTP_CODE__" | sed 's/__HTTP_CODE__//')
  body=$(echo "$response" | sed '/__HTTP_CODE__/d')
  if [ "$http_code" != "200" ] && [ "$http_code" != "201" ]; then
    echo "FAIL [$http_code]: $label"
    echo "$body" | head -10
    return 1
  fi
  echo "OK   [$http_code]: $label"
  return 0
}

echo "═══════════════════════════════════════════════════════"
echo "  Apply 13 migrations to $PROD_REF"
echo "═══════════════════════════════════════════════════════"
echo ""

count=0
total=${#MIGS[@]}

for mig in "${MIGS[@]}"; do
  count=$((count + 1))
  if [ ! -f "$mig" ]; then
    echo "FAIL: file not found: $mig"
    exit 1
  fi
  label="[$count/$total] $(basename $(dirname $(dirname $mig)))/$(basename $mig)"
  sql=$(cat "$mig")
  apply_sql "$sql" "$label" || exit 1
done

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Post-cleanup: drop dev-only mock-community registry"
echo "═══════════════════════════════════════════════════════"
apply_sql "DELETE FROM registries WHERE id='mock-community';" "cleanup mock-community"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ✅ All 13 migrations applied + cleanup complete"
echo "═══════════════════════════════════════════════════════"
