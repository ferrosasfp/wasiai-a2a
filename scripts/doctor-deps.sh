#!/usr/bin/env bash
# Doctor 3: Dependency Audit — unused deps, licenses, outdated
set -euo pipefail

PASS=0; FAIL=0; WARN=0

echo "═══════════════════════════════════════════════"
echo "  Doctor 3: Dependency Audit"
echo "═══════════════════════════════════════════════"
echo ""

# ── 1. Unused dependencies ────────────────────────────────
echo "▶ Checking for unused dependencies..."
DEPCHECK=$(npx -y depcheck --json 2>/dev/null)
UNUSED_DEPS=$(echo "$DEPCHECK" | python3 -c "import sys,json; d=json.load(sys.stdin); deps=d.get('dependencies',[]); print(len(deps))" 2>/dev/null || echo "?")
UNUSED_DEV=$(echo "$DEPCHECK" | python3 -c "import sys,json; d=json.load(sys.stdin); deps=d.get('devDependencies',[]); print(len(deps))" 2>/dev/null || echo "?")

if [ "$UNUSED_DEPS" = "0" ]; then
  echo "  ✅ 0 unused production dependencies"; ((PASS++))
else
  echo "  ⚠️  $UNUSED_DEPS unused production dependencies:"; ((WARN++))
  echo "$DEPCHECK" | python3 -c "import sys,json; [print(f'     - {d}') for d in json.load(sys.stdin).get('dependencies',[])]" 2>/dev/null
fi

if [ "$UNUSED_DEV" = "0" ]; then
  echo "  ✅ 0 unused dev dependencies"; ((PASS++))
else
  echo "  ⚠️  $UNUSED_DEV unused dev dependencies:"; ((WARN++))
  echo "$DEPCHECK" | python3 -c "import sys,json; [print(f'     - {d}') for d in json.load(sys.stdin).get('devDependencies',[])]" 2>/dev/null
fi

# ── 2. License check ──────────────────────────────────────
echo ""
echo "▶ Checking licenses..."
LICENSES=$(npx -y license-checker-rsync2 --json --production 2>/dev/null || npx -y license-checker --json --production 2>/dev/null || echo "{}")
COPYLEFT=0
UNKNOWN=0

if [ "$LICENSES" != "{}" ]; then
  # Check for copyleft licenses (GPL, AGPL, SSPL)
  COPYLEFT=$(echo "$LICENSES" | python3 -c "
import sys, json
d = json.load(sys.stdin)
copyleft = ['GPL', 'AGPL', 'SSPL', 'EUPL']
found = []
for pkg, info in d.items():
    lic = str(info.get('licenses', ''))
    if any(c in lic.upper() for c in copyleft):
        found.append(f'{pkg}: {lic}')
print(len(found))
for f in found:
    print(f'     ❌ {f}')
" 2>/dev/null || echo "?")

  UNKNOWN=$(echo "$LICENSES" | python3 -c "
import sys, json
d = json.load(sys.stdin)
found = [f'{pkg}: {info.get(\"licenses\",\"?\")}' for pkg, info in d.items() if 'UNKNOWN' in str(info.get('licenses',''))]
print(len(found))
for f in found[:5]:
    print(f'     ⚠️  {f}')
" 2>/dev/null || echo "?")
fi

if [ "$COPYLEFT" = "0" ]; then
  echo "  ✅ 0 copyleft (GPL/AGPL/SSPL) licenses"; ((PASS++))
else
  echo "  ❌ $COPYLEFT copyleft licenses found"; ((FAIL++))
fi

if [ "$UNKNOWN" = "0" ]; then
  echo "  ✅ 0 unknown licenses"; ((PASS++))
else
  echo "  ⚠️  $UNKNOWN unknown licenses"; ((WARN++))
fi

# ── 3. Outdated check ─────────────────────────────────────
echo ""
echo "▶ Checking for outdated dependencies..."
OUTDATED=$(npm outdated --json 2>/dev/null || echo "{}")
OUTDATED_COUNT=$(echo "$OUTDATED" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")

if [ "$OUTDATED_COUNT" = "0" ]; then
  echo "  ✅ All dependencies up to date"; ((PASS++))
else
  echo "  ⚠️  $OUTDATED_COUNT outdated packages:"; ((WARN++))
  echo "$OUTDATED" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for pkg, info in list(d.items())[:8]:
    print(f'     {pkg}: {info.get(\"current\",\"?\")} → {info.get(\"latest\",\"?\")}')
if len(d) > 8:
    print(f'     ... and {len(d)-8} more')
" 2>/dev/null
fi

# ── 4. Package count ──────────────────────────────────────
echo ""
echo "▶ Dependency tree size..."
TOTAL=$(ls node_modules 2>/dev/null | wc -l)
PROD_DEPS=$(python3 -c "import json; print(len(json.load(open('package.json')).get('dependencies',{})))")
DEV_DEPS=$(python3 -c "import json; print(len(json.load(open('package.json')).get('devDependencies',{})))")
echo "  📦 $PROD_DEPS production deps, $DEV_DEPS dev deps, $TOTAL total in node_modules"
if [ "$TOTAL" -lt 200 ]; then
  echo "  ✅ Lean dependency tree (<200 packages)"; ((PASS++))
else
  echo "  ⚠️  Heavy dependency tree ($TOTAL packages)"; ((WARN++))
fi

# ── Summary ───────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════"
echo "  Results: ✅ $PASS pass | ❌ $FAIL fail | ⚠️  $WARN warn"
if [ "$FAIL" -gt 0 ]; then
  echo "  Verdict: FAIL"
  exit 1
else
  echo "  Verdict: PASS"
fi
echo "═══════════════════════════════════════════════"
