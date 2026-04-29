#!/usr/bin/env bash
# Set 3 Vercel env vars on wasiai-prod project (production target only)
# Idempotent: if var already exists, delete + re-add (no Vercel update endpoint for env values)

set -euo pipefail

A2A_DIR="/home/ferdev/.openclaw/workspace/wasiai-a2a"
PROJECT_ID="prj_RWJ7yv5zqSJlO6kVC6sfWyQf0em2"  # wasiai-prod (app.wasiai.io)

VERCEL_TOKEN=$(grep "^VERCEL_TOKEN=" "$A2A_DIR/.env" | cut -d'=' -f2- | tr -d '"' | tr -d "'")
FORWARD_KEY=$(cat /tmp/wkh65-forward-key.txt)

if [ -z "$VERCEL_TOKEN" ] || [ -z "$FORWARD_KEY" ]; then
  echo "ERROR: missing VERCEL_TOKEN or FORWARD_KEY"
  exit 1
fi

upsert_env() {
  local KEY="$1"
  local VALUE="$2"
  local TYPE="${3:-encrypted}"  # encrypted (default) | plain | sensitive

  # First, check if exists and delete (Vercel has no "update value" endpoint)
  local EXISTING_ID=$(curl -sf -H "Authorization: Bearer $VERCEL_TOKEN" \
    "https://api.vercel.com/v9/projects/$PROJECT_ID/env?decrypt=false" \
    | python3 -c "
import sys, json
d = json.load(sys.stdin)
for e in d.get('envs', []):
    if e.get('key') == '$KEY' and 'production' in e.get('target', []):
        print(e.get('id'))
        break
")

  if [ -n "$EXISTING_ID" ]; then
    echo "  $KEY: exists (id=$EXISTING_ID), deleting..."
    curl -sf -X DELETE -H "Authorization: Bearer $VERCEL_TOKEN" \
      "https://api.vercel.com/v9/projects/$PROJECT_ID/env/$EXISTING_ID" > /dev/null
  fi

  # Create
  local PAYLOAD
  PAYLOAD=$(KEY="$KEY" VALUE="$VALUE" TYPE="$TYPE" python3 -c "
import os, json
print(json.dumps({
    'key': os.environ['KEY'],
    'value': os.environ['VALUE'],
    'type': os.environ['TYPE'],
    'target': ['production']
}))")

  local RESP
  RESP=$(curl -s -w "\n__HTTP__%{http_code}" -X POST \
    -H "Authorization: Bearer $VERCEL_TOKEN" \
    -H "Content-Type: application/json" \
    "https://api.vercel.com/v10/projects/$PROJECT_ID/env" \
    -d "$PAYLOAD")
  local HTTP_CODE=$(echo "$RESP" | grep "__HTTP__" | sed 's/__HTTP__//')

  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
    echo "  $KEY: SET ($TYPE) ✓"
  else
    echo "  $KEY: FAIL [$HTTP_CODE]"
    echo "$RESP" | head -5
    return 1
  fi
}

echo "═══════════════════════════════════════════════════════"
echo "  Set Vercel env vars on wasiai-prod (app.wasiai.io)"
echo "═══════════════════════════════════════════════════════"

upsert_env "WASIAI_A2A_BASE_URL" "https://wasiai-a2a-production.up.railway.app" "plain"
upsert_env "WASIAI_V2_FORWARD_KEY" "$FORWARD_KEY" "encrypted"
upsert_env "V2_DELEGATE_TO_A2A" "capabilities,compose,orchestrate" "plain"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ✅ Vercel env vars configured"
echo "  Note: existing deployment unchanged. Next deploy picks them up."
echo "═══════════════════════════════════════════════════════"
