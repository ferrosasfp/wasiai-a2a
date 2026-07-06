# Validation Report — WKH-74 Synthetic Monitoring (COMPACT)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-07-06

## Runtime checks (core value — dry-run capa A contra gateway REAL)
Corrido `checkSyntheticPayment` (import real de `synthetic-payment-monitor.mjs`)
con `fetch` real contra `https://wasiai-a2a-production.up.railway.app/orchestrate`
(request "desnudo", sin `x-a2a-key`/`Authorization`/`x-payment`) + `sendAlert`
mockeado (0 webhooks disparados):
- **(a) HOY** → gateway respondió `402`, `accepts[0]` = `payTo=0xf432baf1…7Ba`,
  `asset=0x8E04D099…42ec9`, `network=eip155:2368` → probe evaluó
  `severity:null, detail:"ok"` (sin alerta) — matchea `SYNTH_EXPECT_*`. Confirma
  que capa A cazaría el gap Chaski-$0 funcionalmente HOY.
- **(b1) simulado 200** → `severity:"critical", detail:"unexpected-status"`,
  alerta emitida con `reason:"synthetic-payment-path-broken"`, body sin secrets.
- **(b2) simulado 402 con payTo distinto** → `severity:"critical",
  detail:"payto-mismatch"`, misma alerta.
- Script: `/tmp/claude-1000/.../scratchpad/dryrun-capa-a.mjs` (ejecutado, no
  persiste en el repo — solo lectura, $0 gastado, ningún webhook real tocado).

Env parity / Railway query (solo lectura, sin gastar): `_makeGetDeployId`
(`api/cron/synthetic-tx-check.mjs:63-103`) usa `deployments(first: 5)` +
filtro `status === 'SUCCESS'` sobre las 5 edges — bien formado, no ejecutado en
vivo (requiere `RAILWAY_TOKEN` no provisto acá, correcto no dispararlo).
Capa D real-tx NO se disparó (dinero real, gated por `MONITOR_A2A_KEY`) — validada
solo vía tests (abajo).

## ACs
| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 | PASS | `src/synthetic-payment-monitor.mjs:126-148` (`evaluateProbe`) + dry-run real (a) arriba + `tests/synthetic-payment-monitor.test.mjs:118` "AC-1 — expected 402 challenge → OK, no alert, no payment header" + `tests/cron-synthetic-payment-check.test.mjs:117` |
| AC-2 | PASS | `src/synthetic-payment-monitor.mjs:194-205` + dry-run (b1)/(b2) arriba + `tests/synthetic-payment-monitor.test.mjs:140,169,189` (non-402/mismatch/timeout→critical) + `tests/cron-synthetic-payment-check.test.mjs:146,174,199` |
| AC-3 | PASS | `src/synthetic-tx-monitor.mjs:199-237` (`checkSyntheticTx` — deploy-diff→real-tx+validar txHash+avanzar KV) + `tests/synthetic-tx-monitor.test.mjs:98` (deploy id changed→tx+KV advance) + `:138` (shape real prepago `steps[].txHash`, sin `kiteTxHash` top-level — fix-pack NIT-1) + `tests/cron-synthetic-tx-check.test.mjs:177` T-STC-04, `:203` T-STC-04b + T-STC-08 (:300, gating sobre SUCCESS con BUILDING encima — fix-pack MNR-3) |
| AC-4 | PASS | `src/synthetic-tx-monitor.mjs:218-224` (fail→alert+KV intacto) + `tests/synthetic-tx-monitor.test.mjs:163,184,202,220` (HTTP error/no-hash/success:false/network-error) + `tests/cron-synthetic-tx-check.test.mjs:231` T-STC-05 (confirma KV se queda en `dep-OLD` + sin secrets en el body) |
| AC-5 | PASS | `src/synthetic-tx-monitor.mjs:193-197` (gate) + `tests/synthetic-tx-monitor.test.mjs:78` + `tests/cron-synthetic-tx-check.test.mjs:159` T-STC-03 (deploy sin cambio → `probes:0`) + T-STC-09 (:326, ninguna SUCCESS entre las 5 → skip, sin spend) |
| AC-6 | PASS | `doc/operations/synthetic-monitoring-runbook.md` (accionable: pasos Vercel §2.1, Railway §2.2/2.3, tabla de respuesta §3) |
| AC-7 | PASS | `api/cron/synthetic-payment-check.mjs:22` + `api/cron/synthetic-tx-check.mjs:26` importan `sendAlert` de `src/alerts.mjs` (sin tocar el archivo — `git diff src/alerts.mjs` vacío); `ALLOWED_BODY_KEYS` ya contenía `service`/`url`/`httpStatus`/`reason`/`event`/`checkedAt` (de WKH-77), sin ampliar whitelist |

## Drift
- Ninguno en Scope IN. Extra menor no listado explícito: `mcp-servers/wasiai-x402/.gitignore`
  (agrega `.vercel` + refuerza `!.env.example`, convención CD-8 preexistente) —
  higiene, sin riesgo, no money-path.
- `tests/setup-cronjob.test.mjs` actualizado consistente (6→8 jobs, T-SC-07 7→9) —
  documentado en `auto-blindaje.md` (fix-pack).

## Gates (re-ejecutados — no había cr-report.md/ar-report.md separados en este WKH,
solo `auto-blindaje.md`; confirmo yo mismo los números citados en el brief)
- `npx tsc --noEmit` → exit 0
- `npm run lint` (biome) → exit 0, "Checked 302 files... No fixes applied"
- `npx vitest run` (root) → PASS 2653 / FAIL 0
- `node --test 'tests/*.test.mjs'` (wasiai-x402) → tests 344, pass 344, fail 0

## AR/CR follow-up
- Fix-pack ya aplicado y documentado en `auto-blindaje.md`: NIT-1 (steps[].txHash
  real shape) y MNR-3 (Railway SUCCESS-filter dead code) — ambos con tests nuevos
  confirmados arriba (T-ST-05b equiv. `:138`, T-STC-04b, T-STC-08/09).
- MNR-1 (double-spend bounded si `kvSet` falla) y MNR-2 (sin threshold de fallos
  consecutivos) — DEFERRED a backlog por diseño, documentado, no bloqueante.

**Listo para DONE.**
