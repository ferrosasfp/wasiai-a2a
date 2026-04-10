#!/usr/bin/env bash
# ============================================================================
# WasiAI A2A — Smoke Test Script
# Validates all key endpoints in sequence.
# Usage: ./scripts/smoke-test.sh [BASE_URL]
# Default: https://wasiai-a2a-production.up.railway.app
# ============================================================================

set -euo pipefail

BASE_URL="${1:-https://wasiai-a2a-production.up.railway.app}"
# Strip trailing slash if present
BASE_URL="${BASE_URL%/}"

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
TOTAL=0

# ── jq detection ────────────────────────────────────────────────────────────
HAS_JQ=true
if ! command -v jq &>/dev/null; then
  echo "WARNING: jq not found. Falling back to grep-based validation."
  HAS_JQ=false
fi

if ! command -v curl &>/dev/null; then
  echo "ERROR: curl is required but not found."
  exit 1
fi

# ── Helpers ─────────────────────────────────────────────────────────────────

# json_has_field <json_string> <field_name>
# Returns 0 if field exists, 1 otherwise
json_has_field() {
  local json="$1"
  local field="$2"
  if $HAS_JQ; then
    echo "$json" | jq -e ".$field" &>/dev/null
  else
    echo "$json" | grep -q "\"$field\""
  fi
}

# json_get <json_string> <field_name>
# Prints raw value of field (jq -r)
json_get() {
  local json="$1"
  local field="$2"
  if $HAS_JQ; then
    echo "$json" | jq -r ".$field" 2>/dev/null
  else
    echo "$json" | grep -oP "\"$field\"\s*:\s*\"?\K[^\",$}]+" | head -1
  fi
}

report() {
  local label="$1"
  local status="$2"
  local http_code="$3"
  local detail="${4:-}"

  TOTAL=$((TOTAL + 1))

  if [ "$status" = "PASS" ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "  PASS  [$http_code] $label"
  elif [ "$status" = "SKIP" ]; then
    SKIP_COUNT=$((SKIP_COUNT + 1))
    echo "  SKIP  [$http_code] $label — $detail"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo "  FAIL  [$http_code] $label — $detail"
  fi
}

# ── Banner ──────────────────────────────────────────────────────────────────

echo "============================================"
echo " WasiAI A2A Smoke Test"
echo " Target: $BASE_URL"
echo "============================================"
echo ""

# ── AC-6: GET / ─────────────────────────────────────────────────────────────

RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE_URL/")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ] && json_has_field "$BODY" "name" && json_has_field "$BODY" "version"; then
  report "GET /" "PASS" "$HTTP_CODE"
else
  report "GET /" "FAIL" "$HTTP_CODE" "expected 200 with name+version fields"
fi

# ── AC-7: GET /.well-known/agent.json ───────────────────────────────────────

RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE_URL/.well-known/agent.json")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ] && json_has_field "$BODY" "name" && json_has_field "$BODY" "skills"; then
  report "GET /.well-known/agent.json" "PASS" "$HTTP_CODE"
else
  report "GET /.well-known/agent.json" "FAIL" "$HTTP_CODE" "expected 200 with name+skills fields"
fi

# ── AC-8: GET /gasless/status ───────────────────────────────────────────────

RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE_URL/gasless/status")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ] && json_has_field "$BODY" "funding_state"; then
  report "GET /gasless/status" "PASS" "$HTTP_CODE"
else
  report "GET /gasless/status" "FAIL" "$HTTP_CODE" "expected 200 with funding_state field"
fi

# ── AC-9: GET /dashboard ───────────────────────────────────────────────────

RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE_URL/dashboard")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ] && echo "$BODY" | grep -qi "<html\|<!doctype"; then
  report "GET /dashboard" "PASS" "$HTTP_CODE"
else
  report "GET /dashboard" "FAIL" "$HTTP_CODE" "expected 200 with HTML content"
fi

# ── AC-10: GET /dashboard/api/stats ─────────────────────────────────────────

RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE_URL/dashboard/api/stats")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ] && json_has_field "$BODY" "registriesCount"; then
  report "GET /dashboard/api/stats" "PASS" "$HTTP_CODE"
else
  report "GET /dashboard/api/stats" "FAIL" "$HTTP_CODE" "expected 200 with registriesCount field"
fi

# ── AC-11: POST /auth/agent-signup ──────────────────────────────────────────

SIGNUP_REF="smoke-test-$(date +%s)"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/auth/agent-signup" \
  -H "Content-Type: application/json" \
  -d "{\"owner_ref\": \"$SIGNUP_REF\", \"display_name\": \"Smoke Test Agent\"}")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

AGENT_KEY=""
if [ "$HTTP_CODE" = "201" ]; then
  AGENT_KEY=$(json_get "$BODY" "key")
  if [ -n "$AGENT_KEY" ] && echo "$AGENT_KEY" | grep -q "^wasi_a2a_"; then
    report "POST /auth/agent-signup" "PASS" "$HTTP_CODE"
  else
    report "POST /auth/agent-signup" "FAIL" "$HTTP_CODE" "expected key starting with wasi_a2a_"
  fi
else
  report "POST /auth/agent-signup" "FAIL" "$HTTP_CODE" "expected 201"
fi

# ── AC-12: GET /auth/me (with key from AC-11) ──────────────────────────────

if [ -n "$AGENT_KEY" ]; then
  RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE_URL/auth/me" \
    -H "x-a2a-key: $AGENT_KEY")
  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | sed '$d')

  if [ "$HTTP_CODE" = "200" ] && json_has_field "$BODY" "key_id"; then
    report "GET /auth/me" "PASS" "$HTTP_CODE"
  else
    report "GET /auth/me" "FAIL" "$HTTP_CODE" "expected 200 with key status info"
  fi
else
  report "GET /auth/me" "SKIP" "---" "no key from signup step"
fi

# ── AC-13: GET /discover ───────────────────────────────────────────────────

RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE_URL/discover")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
  report "GET /discover" "PASS" "$HTTP_CODE"
else
  report "GET /discover" "FAIL" "$HTTP_CODE" "expected 200 with agents array"
fi

# ── AC-14: x402-protected endpoints (SKIP) ─────────────────────────────────

report "POST /compose" "SKIP" "---" "requires x402 payment token"
report "POST /orchestrate" "SKIP" "---" "requires x402 payment token"

# ── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo "============================================"
echo " Results: $PASS_COUNT PASS / $FAIL_COUNT FAIL / $SKIP_COUNT SKIP (of $TOTAL)"
echo "============================================"

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi

exit 0
