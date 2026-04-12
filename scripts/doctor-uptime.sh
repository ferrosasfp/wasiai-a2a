#!/usr/bin/env bash
# Doctor 5: Uptime Monitor — health check for cron
# Usage:
#   One-shot:  ./scripts/doctor-uptime.sh
#   Cron:      */5 * * * * /path/to/scripts/doctor-uptime.sh >> /var/log/wasiai-uptime.log 2>&1
#   Watch:     watch -n 60 ./scripts/doctor-uptime.sh
set -euo pipefail

BASE_URL="${1:-https://wasiai-a2a-production.up.railway.app}"
TIMEOUT=10
ENDPOINTS=("/health" "/.well-known/agent.json" "/gasless/status" "/discover?limit=1")
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
ALL_OK=true

echo "[$TIMESTAMP] Uptime check: $BASE_URL"

for EP in "${ENDPOINTS[@]}"; do
  START=$(date +%s%N)
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time $TIMEOUT "$BASE_URL$EP" 2>/dev/null || echo "000")
  END=$(date +%s%N)
  DURATION_MS=$(( (END - START) / 1000000 ))

  if [ "$HTTP_CODE" = "200" ]; then
    echo "  ✅ $EP → $HTTP_CODE (${DURATION_MS}ms)"
  elif [ "$HTTP_CODE" = "000" ]; then
    echo "  ❌ $EP → TIMEOUT/UNREACHABLE"
    ALL_OK=false
  else
    echo "  ❌ $EP → $HTTP_CODE (${DURATION_MS}ms)"
    ALL_OK=false
  fi
done

if $ALL_OK; then
  echo "  Status: UP"
else
  echo "  Status: DEGRADED"
  # Uncomment to send alert:
  # curl -s -X POST "https://hooks.slack.com/services/YOUR/WEBHOOK/URL" \
  #   -H "Content-Type: application/json" \
  #   -d "{\"text\":\"🚨 WasiAI A2A DEGRADED at $TIMESTAMP — check $BASE_URL\"}"
  exit 1
fi
