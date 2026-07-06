# Validation Report — HU WKH-77 (COMPACT)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-07-06

## Runtime checks (dry-run READ-ONLY, sendAlert mockeado, sin webhooks reales)

Ejecutado `checkHealthTargets` real (mismo core prod) con `fetchHealth` = `fetch`
real contra los 4 targets del default de `.env.example`:

| target | tier | hoy (real) | severity |
|---|---|---|---|
| gateway-a2a | P0 | `{"status":"ok",...}` HTTP 200 | `ok` |
| facilitator | P0 | `{"status":"ok","degraded":false,...}` HTTP 200 | `ok` |
| x402-mcp | P1 (reachability) | HTTP 404 | `ok` (reachability: <500 = vivo) |
| app-wasiai | P1 | HTTP 200 (sigue redirect) | `ok` |

0 alertas disparadas hoy — consistente con el estado real del ecosistema.

Simulaciones (fetchHealth mockeado, resto de la cadena real):
- **x402-mcp 502 simulado** (crash Vercel) → `severity:"warning"` (P1),
  `reason:"health-http-error"`, `httpStatus:502`, 1 alerta — confirma el fix
  BLQ-BAJO-1 (reachability ya no confunde 5xx con "vivo").
- **facilitator `degraded:true` simulado** (200 OK) → `severity:"warning"`
  (aunque tier=P0), `reason:"health-degraded"`, 1 alerta — replica exacto el
  incidente 2026-07-05 que motivó la HU.

Script usado: `checkHealthTargets` importado directo de
`mcp-servers/wasiai-x402/src/health-monitor.mjs`, `sendAlert` mockeado
(no se disparó ningún webhook Discord real).

## ACs

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 | PASS | `parseHealthTargets` (`health-monitor.mjs:72-134`), env `HEALTH_MONITOR_TARGETS` leído en `api/cron/health-check.mjs:85`; T-HM-02/03 (`tests/health-monitor.test.mjs:56,69`) |
| AC-2 | PASS | severity por tier `SEVERITY_BY_TIER` (`health-monitor.mjs:28-32`), non-2xx/unreachable/timeout (`:158-171`,`:188-191`); T-HM-05/06/16 (`tests/health-monitor.test.mjs:105,136,393`); dry-run real: x402-mcp 502→warning. Cadencia 4 min (`scripts/setup-cronjob.mjs` job `wasiai-x402-health-check`) |
| AC-3 | PASS | `degradedPath` → `warning` aun en P0 (`health-monitor.mjs:201-208`); T-HM-09 (`tests/health-monitor.test.mjs:202`); dry-run real: facilitator `degraded:true`→warning |
| AC-4 | PASS | body `service/url/logsUrl/httpStatus/checkedAt/severity` (`health-monitor.mjs:261-274`) + whitelist extendido `ALLOWED_BODY_KEYS` (`src/alerts.mjs:51-54`); T-HC-03 (`tests/cron-health-check.test.mjs:105`, "webhook bodies whitelisted") |
| AC-5 | PASS | `doc/operations/oncall-runbook.md` — tabla severidad↔tier↔escalación (P0 @fer push / P1 canal / P2 log), procedimiento por servicio, config env, test-alert |
| AC-6 | PASS | `?dryRun=1` (`api/cron/health-check.mjs:56-64,96`), auth (`validateCronSecret`) corre ANTES del dryRun check (líneas 67-94) → auth-gated; T-HM-14 (`tests/health-monitor.test.mjs:330`), T-HC-05 (`tests/cron-health-check.test.mjs:187`) |
| AC-7 | PASS | try/catch por target (`health-monitor.mjs:219-292`) + `Promise.allSettled` (`:324-364`) + cron siempre 200 aun en error (`api/cron/health-check.mjs:110-116`); T-HM-12/13/17 (`tests/health-monitor.test.mjs:274,305,427`), T-HC-07 (`tests/cron-health-check.test.mjs:237`) |
| Push P0 real (`content`) | PASS | `formatForDiscord` agrega `content` solo en `critical`+`mention` (`src/alerts.mjs` diff); T-AL-PUSH-01..06 (`tests/alerts.test.mjs:436-540`), T-HC-04 (`tests/cron-health-check.test.mjs:157`) |
| reachabilityOnly | PASS | 5xx→down, <500→vivo (`health-monitor.mjs:181-186`); T-HM-10/11/16 (`tests/health-monitor.test.mjs:234,253,393`) |

## Drift
- Scope IN respetado: `health-monitor.mjs` (nuevo), `api/cron/health-check.mjs`
  (nuevo), `alerts.mjs` (extendido), `.env.example` (extendido),
  `scripts/setup-cronjob.mjs` (6º job), `vercel.json` (maxDuration:30),
  `doc/operations/oncall-runbook.md` (nuevo), `_INDEX.md` (fila 150).
- Fold-in menor no listado explícito en Scope IN: `gas-balance-check.mjs`
  (+3 líneas, threadea `ONCALL_MENTION` — fix NIT-1 del propio fix-pack,
  documentado en `auto-blindaje.md`) y `.gitignore` (+2 líneas, `.vercel`/`.env*`
  — housekeeping trivial, sin impacto funcional). Ninguno constituye scope
  creep de negocio.
- Wave order: Wave 0 (core) → Wave 2 (cron registration) → fix-pack post-AR
  (reachability 5xx, paralelización, mention threading, mass-ping guard) —
  documentado en `auto-blindaje.md`, consistente.

## Gates
- `npx tsc --noEmit` → 0 errores (ejecutado)
- `npm run lint` (biome) → "Checked 302 files... No fixes applied" (ejecutado)
- `npx vitest run` → PASS 2653 / FAIL 0 (ejecutado)
- `node --test mcp-servers/wasiai-x402/tests/*.test.mjs` → tests 304, pass 304, fail 0 (ejecutado)

## AR/CR follow-up
- Los 2 must-fix de la primera AR (5xx tratado como "vivo" en reachability;
  chequeo serial sin maxDuration) están cerrados en el fix-pack — verificado
  en código (`health-monitor.mjs:181-186` distingue `>=500`; `Promise.allSettled`
  en `:334`; `vercel.json` `maxDuration:30`) y en tests (T-HM-16, T-HM-17).
- Re-AR + CR ya aprobaron (según handoff del orquestador); nada pendiente sin
  resolver detectado en esta pasada.

**Listo para DONE.**
