#!/usr/bin/env bash
# Doctor 1: Security Scanner — npm audit + header checks + env checks
set -uo pipefail

BASE_URL="${1:-https://wasiai-a2a-production.up.railway.app}"
PASS=0; FAIL=0; WARN=0

echo "═══════════════════════════════════════════════"
echo "  Doctor 1: Security Scanner"
echo "  Target: $BASE_URL"
echo "═══════════════════════════════════════════════"
echo ""

# ── 1. npm audit ────────────────────────────────────────────
echo "▶ npm audit..."
AUDIT=$(npm audit --json 2>/dev/null || true)
VULNS=$(echo "$AUDIT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('metadata',{}).get('vulnerabilities',{}).get('high',0) + d.get('metadata',{}).get('vulnerabilities',{}).get('critical',0))" 2>/dev/null || echo "?")

if [ "$VULNS" = "0" ]; then
  echo "  ✅ 0 high/critical vulnerabilities"; ((PASS++))
else
  echo "  ❌ $VULNS high/critical vulnerabilities found"; ((FAIL++))
fi

# ── 2. Security headers ────────────────────────────────────
echo ""
echo "▶ Security headers on $BASE_URL..."
HEADERS=$(curl -sI "$BASE_URL/health" 2>/dev/null)

# Check X-Content-Type-Options
if echo "$HEADERS" | grep -qi "x-content-type-options"; then
  echo "  ✅ X-Content-Type-Options present"; ((PASS++))
else
  echo "  ⚠️  X-Content-Type-Options missing (mitigates MIME sniffing)"; ((WARN++))
fi

# Check no server version leak
if echo "$HEADERS" | grep -qi "^server:.*fastify\|^x-powered-by"; then
  echo "  ⚠️  Server/framework version exposed in headers"; ((WARN++))
else
  echo "  ✅ No server version leak"; ((PASS++))
fi

# Check CORS
CORS=$(curl -sI -H "Origin: https://evil.com" "$BASE_URL/health" 2>/dev/null)
if echo "$CORS" | grep -qi "access-control-allow-origin: \*"; then
  echo "  ⚠️  CORS allows all origins (origin: *) — OK for public API, risky for admin"; ((WARN++))
else
  echo "  ✅ CORS not wildcard"; ((PASS++))
fi

# ── 3. Sensitive endpoint protection ───────────────────────
echo ""
echo "▶ Endpoint protection..."

# /auth/me without key should return 403
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/auth/me")
if [ "$STATUS" = "403" ]; then
  echo "  ✅ /auth/me without key → 403"; ((PASS++))
else
  echo "  ❌ /auth/me without key → $STATUS (expected 403)"; ((FAIL++))
fi

# /orchestrate without payment should return 402
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -d '{"goal":"test","budget":0.01}' "$BASE_URL/orchestrate")
if [ "$STATUS" = "402" ]; then
  echo "  ✅ /orchestrate without payment → 402"; ((PASS++))
else
  echo "  ❌ /orchestrate without payment → $STATUS (expected 402)"; ((FAIL++))
fi

# /compose without payment should return 402
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -d '{"steps":[]}' "$BASE_URL/compose")
if [ "$STATUS" = "402" ] || [ "$STATUS" = "400" ]; then
  echo "  ✅ /compose without payment → $STATUS (protected)"; ((PASS++))
else
  echo "  ❌ /compose without payment → $STATUS (expected 402/400)"; ((FAIL++))
fi

# ── 4. Input validation ───────────────────────────────────
echo ""
echo "▶ Input validation..."

# Oversized goal
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" \
  -d "{\"goal\":\"$(python3 -c "print('A'*3000)")\",\"budget\":0.01}" "$BASE_URL/orchestrate")
if [ "$STATUS" = "400" ]; then
  echo "  ✅ Oversized goal rejected → 400"; ((PASS++))
else
  echo "  ⚠️  Oversized goal returned $STATUS (expected 400)"; ((WARN++))
fi

# SQL injection attempt in discover
BODY=$(curl -s "$BASE_URL/discover?q=';DROP%20TABLE%20users;--")
if echo "$BODY" | grep -qi "error\|DROP"; then
  echo "  ⚠️  SQL injection in /discover returned error (check logs)"; ((WARN++))
else
  echo "  ✅ SQL injection in /discover handled safely"; ((PASS++))
fi

# Missing required fields
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -d '{}' "$BASE_URL/orchestrate")
if [ "$STATUS" = "400" ]; then
  echo "  ✅ Missing fields rejected → 400"; ((PASS++))
else
  echo "  ⚠️  Missing fields returned $STATUS (expected 400)"; ((WARN++))
fi

# ── Summary ───────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════"
echo "  Results: ✅ $PASS pass | ❌ $FAIL fail | ⚠️  $WARN warn"
if [ "$FAIL" -gt 0 ]; then
  echo "  Verdict: FAIL — fix critical issues"
  exit 1
elif [ "$WARN" -gt 2 ]; then
  echo "  Verdict: WARN — review warnings"
else
  echo "  Verdict: PASS"
fi
echo "═══════════════════════════════════════════════"
