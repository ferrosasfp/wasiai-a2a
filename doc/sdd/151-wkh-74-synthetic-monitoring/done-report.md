# Report — HU [WKH-74] Synthetic Monitoring del Payment Path

## Resumen ejecutivo

**WKH-74 completa la observabilidad operacional del payment path real**: synthetic probes (capa A) detectan el gap visto en el incidente 2026-07-05 (settle-timeout con `/health` verde), real-tx gated por deploy (capa D) valida on-chain antes de desplegar, y runbook de toggles nativos (capa C) documenta escalación. Cierra el trípode de monitoring (WKH-71 gas wallet + WKH-77 health + WKH-74 funcional). **Status DONE**: 7/7 ACs PASS, fix-pack aplicado (NIT-1 steps[].txHash, MNR-3 Railway SUCCESS filter), AR/CR aprobados con deferidos documentados en backlog.

## Pipeline ejecutado

| Fase | Status | Notas |
|------|--------|-------|
| **F0** | COMPLETO | Project context de wasiai-x402 cargado; probe correcto confirmado leyendo código (`a2a-key.ts` + `x402.ts`) — sin `x-a2a-key`/`Authorization`/`x-payment` → `requirePayment()` → 402. |
| **F1** | HU_APPROVED | Clinical AUTO (el orquestador verificó probe de capa A en vivo = 402; `SYNTH_EXPECT_PAYTO/ASSET/NETWORK` matchean). |
| **F2** | COMPLETO | Arquitectura confirmada (Railway deploy identifier, no Vercel SHA). SDD + Story File generados. |
| **F2.5** | COMPLETO | Story File integrado; 2 crons nuevos (15min capa A, 1h capa D) + 8 tests core + 9 test de cron. |
| **F3** | COMPLETO | Implementación 3 módulos + 2 crons: `synthetic-payment-monitor.mjs` (capa A), `synthetic-tx-monitor.mjs` (capa D), setup-cronjob.mjs (6→8 jobs). 302 archivos lintados, tsc clean, 344 tests en wasiai-x402 PASS. |
| **AR** | APROBADO con MENORs | Money-path bien blindado (exige 2xx+txHash+!pipelineFailed). 2 MENORs deferidos (MNR-1 double-spend bounded, MNR-2 alert fatigue → backlog); 1 NIT fijo (NIT-1 steps[].txHash real shape). |
| **CR** | APROBADO con NITs | 2 NITs hallados, ambos fijados (NIT-1 JSDoc/shape, NIT-3 test del shape real). 1 MNR hallado (MNR-3 Railway SUCCESS filter muerto con `first:1` → fix `first:5`). |
| **Fix-pack** | RE-APROBADO | NIT-1 (steps[].txHash docs + default `MONITOR_TX_GOAL=AVAX price`), NIT-2 (tests T-ST-05b/T-STC-04b con shape real), MNR-3 (first:5 + SUCCESS filter + T-STC-08/09) — todos con tests nuevos. |
| **F4** | APROBADO | QA validó 7/7 ACs con evidencia archivo:línea. Dry-run de capa A contra gateway real (402 correcto→ok; 200/mismatch→critical). Ningún drift en Scope IN; extra menor (.gitignore convención CD-8). |

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|----|--------|-----------|
| **AC-1** | PASS | `src/synthetic-payment-monitor.mjs:126-148` (`evaluateProbe` OK sin alerta), dry-run (a) real 402 matchea, `tests/synthetic-payment-monitor.test.mjs:118` + `tests/cron-synthetic-payment-check.test.mjs:117` |
| **AC-2** | PASS | `src/synthetic-payment-monitor.mjs:194-205` (alert emit), dry-run (b1)/(b2) non-402/mismatch→critical, `tests/synthetic-payment-monitor.test.mjs:140,169,189` (timeout/status/mismatch), `tests/cron-synthetic-payment-check.test.mjs:146,174,199` |
| **AC-3** | PASS | `src/synthetic-tx-monitor.mjs:199-237` deploy-diff→real-tx+validar txHash+KV advance, `tests/synthetic-tx-monitor.test.mjs:98` (deploy changed), T-ST-05b new test (real prepago shape steps-only), T-STC-04b (shape real en cron) |
| **AC-4** | PASS | `src/synthetic-tx-monitor.mjs:218-224` fail→alert+KV intacto, `tests/synthetic-tx-monitor.test.mjs:163,184,202,220` (HTTP/no-hash/success:false/network-error), `tests/cron-synthetic-tx-check.test.mjs:231` T-STC-05 (KV stays dep-OLD, no secrets in body) |
| **AC-5** | PASS | `src/synthetic-tx-monitor.mjs:193-197` gate (SHA unchanged→skip), `tests/synthetic-tx-monitor.test.mjs:78`, T-STC-03 (deploy sin cambio → 0 probes), T-STC-09 (no SUCCESS→skip, KV untouched, no spend) |
| **AC-6** | PASS | `doc/operations/synthetic-monitoring-runbook.md` creado (pasos accionables Vercel §2.1, Railway §2.2/2.3, tabla de respuesta §3) |
| **AC-7** | PASS | `api/cron/synthetic-payment-check.mjs:22` + `api/cron/synthetic-tx-check.mjs:26` importan `sendAlert` de `src/alerts.mjs`, `ALLOWED_BODY_KEYS` sin expansión (reusa whitelist WKH-77) |

## Hallazgos finales

### BLOQUEANTEs: 0
Money-path bien protegido. AR/CR cobertura completa.

### MENORs: 2 (DEFERIDOS A BACKLOG, no bloquean DONE)

1. **MNR-1** (double-spend si `kvSet` falla): bounded por AC-4 retry contract (en máx 1 tx/hora hasta que KV se asiente) + budget-capped por `MONITOR_A2A_KEY` dedicada. Un sentinel no cabe (colisión con retry). Documentado en `auto-blindaje.md:67-71`.

2. **MNR-2** (no consecutive-failure threshold): sin counter en KV → potencial alert fatigue. Deferred to backlog en sync con WKH-77 MNR-3 (ambos requieren persistent failure-count state). Documentado en `auto-blindaje.md:72-74`.

### NITs: 3 (TODOS FIJOS)

1. **NIT-1** (steps[].txHash real shape, no kiteTxHash top-level): corregido en FIX-PACK — JSDoc `extractTxHash`, `.env.example` + runbook requieren `MONITOR_TX_GOAL` que settlea ≥1 step. Documentado en `auto-blindaje.md:30-49`.

2. **NIT-2** (test del shape real): agregados T-ST-05b + T-STC-04b con respuesta prepago (steps-only, sin top-level hash). Validado.

3. **NIT-3/NIT-4** (triviales, menores en tipeos/comentarios): resueltos en commit fix.

## Auto-Blindaje consolidado

| Fecha | Error / Note | Causa | Fix Aplicado | Aplicar en próximas HUs |
|-------|-------|-------|--------------|------------------------|
| 2026-07-06 09:05 | T-SC-07: hardcoded `7` vs magic numbers | Job count duplo en tests | Updated T-SC-07 a `9` (8 ours + 1 foreign) + sweep completo de conteos | Grep `tests/setup-cronjob.test.mjs` por **TODOS** los conteos numéricos al agregar crons, no solo el primer test que falla |
| 2026-07-06 09:08 | KV singleton en cache-busted cron | `synthetic-tx-check.mjs?t=rnd` vs bare `kv-client.mjs` | Verificado singleton es visible a handler via `setKvClientForTesting` | Cron tests: import `setKvClientForTesting` desde path **sin query** (nunca cache-busted) |
| 2026-07-06 12:20 | steps[].txHash vs top-level kiteTxHash | JSDoc + config escribieron "kiteTxHash siempre"; realidad: prepago NO la tiene | JSDoc corregido, `.env.example` + runbook requieren settle, `MONITOR_TX_GOAL=AVAX price` default | Probes que aserten settle desde prepago: leer `pipeline.steps[].txHash`, nunca asumir top-level hash; GOAL debe ser provably settleable |
| 2026-07-06 12:20 | Railway first:1 + SUCCESS filter muerto | Fetch 1 edge → filter inútil; latest BUILDING cae al fallback | Cambiado a `deployments(first: 5)` + `.find(status==='SUCCESS')` | Queries "latest X where status=Y": fetch suficientes filas para que el filter sea útil; fail-closed (skip) si ninguna matchea |
| 2026-07-06 12:20 | MNR-1: double-spend si kvSet falla | Inherente a sync check+act | Documentado bounded + DEFERRED | Monitoreado en backlog |
| 2026-07-06 12:20 | MNR-2: sin threshold de fallos consecutivos | Requiere persistent state en KV | Documentado, sync con WKH-77 MNR-3 | Backlog + WKH-77 follow-up |

## Archivos modificados

### Core Implementation (wasiai-x402)
- `src/synthetic-payment-monitor.mjs` — **nuevo** (367 líneas): evaluateProbe + formatSyntheticPaymentAlert, sin side-effects, reutiliza `sendAlert`
- `src/synthetic-tx-monitor.mjs` — **nuevo** (301 líneas): checkSyntheticTx + _makeGetDeployId (Railway GraphQL), reutiliza sendAlert + KV
- `api/cron/synthetic-payment-check.mjs` — **nuevo** (49 líneas): cron 15min, validateCronSecret, import real del monitor
- `api/cron/synthetic-tx-check.mjs` — **nuevo** (61 líneas): cron 1h, deploy-diff gated, validar txHash + KV avance
- `src/kv-keys.mjs` — **modificado**: agrega `'synth:deploy:id'` para persistencia de deploy SHA
- `scripts/setup-cronjob.mjs` — **modificado**: agrega los 2 crons nuevos (6 → 8 jobs)
- `tests/setup-cronjob.test.mjs` — **modificado**: T-SC-07 actualizada a conteo correcto (7 → 9), nuevos test cases T-SC-09/10 para los crons
- `tests/synthetic-payment-monitor.test.mjs` — **nuevo** (220 líneas): 8 cases (AC-1, AC-2 non-402/mismatch/timeout/network)
- `tests/cron-synthetic-payment-check.test.mjs` — **nuevo** (211 líneas): 5 cases (handler + cronSecret + error handling + alert shape)
- `tests/synthetic-tx-monitor.test.mjs` — **nuevo** (235 líneas): 10 cases (deploy-diff/no-change/fail/txHash/shape real T-ST-05b)
- `tests/cron-synthetic-tx-check.test.mjs` — **nuevo** (350 líneas): 10 cases (handler + deploy-diff + KV + Railway query + shape real T-STC-04b + SUCCESS filter T-STC-08/09)

### Configuration & Documentation
- `.env.example` — **modificado**: nuevas vars (`SYNTH_EXPECT_PAYTO`, `SYNTH_EXPECT_ASSET`, `SYNTH_EXPECT_NETWORK`, `MONITOR_A2A_KEY`, `RAILWAY_TOKEN`, `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_SERVICE_ID`, `MONITOR_TX_GOAL=AVAX price`), docs corregidas para shape real
- `doc/operations/synthetic-monitoring-runbook.md` — **nuevo** (accionable: pasos Vercel + Railway, tabla de respuesta)
- `mcp-servers/wasiai-x402/.gitignore` — **modificado**: minor (agrega `.vercel`, refuerza `!.env.example` — convención CD-8 preexistente)

### Tests & Gate Checks
- `npx tsc --noEmit` → exit 0
- `npm run lint` (biome) → exit 0, "Checked 302 files... No fixes applied"
- `npx vitest run` (root) → PASS 2653 / FAIL 0
- `node --test 'tests/*.test.mjs'` (wasiai-x402) → 344 tests PASS, 0 FAIL

## Decisiones diferidas a backlog

1. **MNR-1** (double-spend bounded si `kvSet` falla) — deferred per design, no bloqueante (budget-capped, retry inherente, sentinel colisión)
2. **MNR-2** (alert fatigue sin failure-count threshold) — deferred to backlog, sync con WKH-77 MNR-3 (requiere persistent KV state)

## Lecciones para próximas HUs

1. **steps[].txHash es el proof para prepago**: no asumir top-level `kiteTxHash`. Cualquier probe/monitor que valide settle desde agent-key debe leer `pipeline.steps[].txHash` y requerir que el GOAL sea provably settleable (ej: "AVAX price" con chainlink).

2. **Magic numbers duales en tests**: si cambiás `TARGET_JOBS.length` en setup-cronjob.mjs, grep Y **actualiza todos** los conteos numéricos en `tests/setup-cronjob.test.mjs` (T-SC-01/02/03/07, EXPECTED_TITLES), no solo el primer test que falla.

3. **KV singleton en cache-busted crons**: imports cache-busted (query param `?t=rnd`) del handler, pero KV debe venir de un import SIN query para que `setKvClientForTesting` funcione. Patrón: `import { setKvClientForTesting } from '../src/kv-client.mjs'` (sin query).

4. **Railway paginated queries con filtros**: fetch suficientes filas para que el `.find(status==='SUCCESS')` no sea dead code. Con `first:1` + fallback, cualquier BUILDING latest cae al fallback no filtrado. Cambio: `first:5` + `.find()` + fail-closed (skip) si ninguno matchea.

5. **Real-tx synthetic costo real vs documental**: el ticket pedía "expect-402 desde Vercel"; la realidad es Railway + capa D dispara real-tx ($0.001-0.05). El deploy identifier viene de Railway API (no inyectado a runtime hoy, verificar en próximas ops). DT-2 asumió bien el gap pero requiere validación con Railway dashboard.

## Seguimiento post-DONE — Activación Pendiente

**Rol: Orquestador + Ops (no nexus-docs). Estos son los pasos que el humano/Ops DEBE ejecutar para activar WKH-74 en prod:**

1. **Setear env vars en Railway (`wasiai-a2a` gateway)**:
   - `SYNTH_EXPECT_PAYTO`: `0xf432baf1...7Ba` (payment wallet actual, verificar en `.env.prod`)
   - `SYNTH_EXPECT_ASSET`: `0x8E04D099...42ec9` (AVAX wrapped, verificar adapter Kite)
   - `SYNTH_EXPECT_NETWORK`: `eip155:2368` (Kite testnet)
   - `MONITOR_A2A_KEY`: Agent Key dedicada, **PRE-FONDEADA** (~$0.05 USDC)
   - `RAILWAY_TOKEN`: Token API de Railway (generar en dashboard)
   - `RAILWAY_PROJECT_ID`: wasiai-a2a project ID
   - `RAILWAY_ENVIRONMENT_ID`: production environment ID
   - `RAILWAY_SERVICE_ID`: gateway service ID
   - `MONITOR_TX_GOAL`: `AVAX price` (default ya en `.env.example`)

2. **Crear + registrar el MONITOR_A2A_KEY**:
   - POST `/auth/agent-key` con owner_ref distinto (telemetría segregada)
   - Fondear ~$0.05 USDC en Kite testnet vía `/auth/deposit` + On-Chain proof
   - Verificar `GET /auth/agent-key/:id` → budget disponible

3. **Registrar los 2 crons nuevos en Vercel**:
   - `https://wasiai-x402.vercel.app/api/cron/synthetic-payment-check` (cadencia 15 min)
   - `https://wasiai-x402.vercel.app/api/cron/synthetic-tx-check` (cadencia 1h)
   - Validar `CRON_SECRET` env var en Vercel

4. **Dry-run funcional**:
   - POST `https://wasiai-a2a-production.up.railway.app/orchestrate` con body mínimo, **sin headers de auth/pago** → esperar 402 con `accepts[0].payTo/asset/network` correctos
   - Esperar ~15min hasta que el cron de capa A ejecute → verificar en Discord `#wasiai-alerts` que NO hay alertas (probe OK)

5. **Deploy actual**:
   - Mergear PR a main en wasiai-a2a (incluye `/src/synthetic-*.mjs` + crons + runbook)
   - Mergear PR a main en wasiai-x402 (incluye `/api/cron/*.mjs` + `.env.example` actualizado)
   - Verificar que `scripts/setup-cronjob.mjs` (8 jobs totales, incluye los 2 nuevos) corre correctamente en Vercel post-deploy

6. **Monitorear 72h post-deploy**:
   - Alertas en `#wasiai-alerts`: esperar que capa A ejecute cada 15min (0 alerts = todo bien)
   - Alertas de capa D: solo cuando hay deploy nuevo (1 real-tx ~$0.001/deploy, ~1 deploy/semana en testnet)
   - Runbook `doc/operations/synthetic-monitoring-runbook.md` disponible para Ops en escalaciones

## Cierre de pipeline

**Status final: DONE**
- Reporte: `/doc/sdd/151-wkh-74-synthetic-monitoring/done-report.md`
- Branch: `feat/151-wkh-74-synthetic-monitoring`
- Commits: [dev team provides via git log]
- Próximo: Orquestador → humano (presentar reporte, confirmar deploy) → Ops (activación env vars + crons + dry-run)
