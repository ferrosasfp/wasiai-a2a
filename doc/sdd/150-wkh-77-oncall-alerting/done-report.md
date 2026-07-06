# Report — HU [WKH-77] On-Call Alerting — Health Monitor + Escalation Runbook

## Resumen ejecutivo

Implementación completa de un **health monitor central** en `mcp-servers/wasiai-x402/` que detecta outages y degradación de 4 servicios críticos del ecosistema (gateway P0, facilitator P0, x402-mcp P1, app.wasiai.io P1) vía HTTP polling cada 4 min, disparando alertas por Discord con severidad mapeada (P0→critical, P1→warning, P2→info) + runbook operativo. La HU cierra el 2º lado del incidente 2026-07-05 (facilitator `degraded:true` silencioso durante horas), complementando el monitor de balance del operador (WKH-71). Entregables: 3 módulos nuevos (`health-monitor.mjs`, `api/cron/health-check.mjs`, `oncall-runbook.md`) + extensión de `alerts.mjs` (whitelist) + 6º cron job + tests full coverage. **Status: DONE** — 7/7 ACs PASS, gates de QA superados, pendiente activación (vars de env + deploy).

## Pipeline ejecutado

| Fase | Status | Artefactos |
|------|--------|-----------|
| **F0** | DONE | `project-context.md` cargado; análisis de herencia WKH-71 (patrón cron+alerts reutilizable) |
| **F1** (analyst) | DONE | `work-item.md` — 7 ACs (EARS), 6 CDTs, scope bien delimitado. `HU_APPROVED` (clinical AUTO) |
| **F2** (architect) | DONE | SDD implícito en work-item.md; decisiones técnicas (DT-1..6) y constraint directives ratificadas |
| **F2.5** (story-file) | DONE | Historias implícitas en work-item.md; patrón clear desde WKH-71 |
| **F3** (dev) | DONE | 3 módulos nuevos (Wave 0 core, Wave 2 cron registration) + fix-pack post-AR (Wave 3) |
| **AR** (adversary) | APROBADO | 2 MENORs iniciales detectados (reachability 5xx, paralelización+maxDuration) → fixes aplicados → re-AR APROBADO |
| **CR** (code-review) | APROBADO | 2 NITs (doc afirmaba push sin cablearlo; field duplicado) → fixes aplicados |
| **F4** (QA) | APROBADO | 7/7 ACs PASS con evidencia arquivo:línea; runtime checks + simulaciones verificadas |

**Veredicto**: APROBADO PARA DONE (validation.md del 2026-07-06 **"Veredicto: APROBADO PARA DONE"**)

---

## Acceptance Criteria — resultado final

| # | AC | Status | Evidencia |
|---|----|----|-----------|
| 1 | Monitor central HTTP de health — targets en `HEALTH_MONITOR_TARGETS` (env JSON) | PASS | `health-monitor.mjs:72-134` (`parseHealthTargets`); test T-HM-02/03 |
| 2 | Severidad mapeada por tier (P0→critical, P1→warning, P2→info); timeout ≤5s; cadencia ≤4 min | PASS | `SEVERITY_BY_TIER:28-32`; non-2xx/unreachable/timeout `:158-171,188-191`; cadencia 4 min en `setup-cronjob.mjs`; test T-HM-05/06/16 |
| 3 | Degradado lógico vía `degradedPath` (JSON-path configurable) → severidad `warning` aun en P0 | PASS | `_evaluateTarget:201-208` (reachability + degraded); test T-HM-09; simulación real: facilitator `degraded:true` → warning |
| 4 | Payload de alerta: service/url/logsUrl/httpStatus/checkedAt/severity + whitelist extendido | PASS | `health-monitor.mjs:261-274` (body fields); `alerts.mjs:51-54` (`ALLOWED_BODY_KEYS` extendido); test T-HC-03 |
| 5 | Runbook `doc/operations/oncall-runbook.md` — tabla P0/P1/P2 → escalación + procedimiento por servicio | PASS | Archivo entregado; tabla severidad↔tier↔escalación; config env; test-alert |
| 6 | Test-alert invocable (`?dryRun=1`) — protegido por `CRON_SECRET`, dispara sintético por cada target | PASS | `api/cron/health-check.mjs:56-64,96` (dryRun gateado); auth valida ANTES (`:67-94`); test T-HM-14, T-HC-05 |
| 7 | Fail-open: error por target NUNCA aborta el tick; cron siempre 200 aun en outage total | PASS | try/catch por target `:219-292`; `Promise.allSettled:324-364`; cron siempre 200 `:110-116`; test T-HM-12/13/17, T-HC-07 |

**Cierre**: Todos los ACs PASS. Validación runtime en vivo contra los 4 endpoints reales:
- Gateway a2a: HTTP 200, `{status:"ok",...}` → OK
- Facilitator: HTTP 200, `{degraded:false,...}` → OK (estado sano hoy)
- x402-mcp: HTTP 404 (reachability) → OK (reachability: <500 = vivo)
- app.wasiai.io: HTTP 200 → OK

Simulaciones de outage (fetchHealth mockeado):
- x502-mcp 502 → severity "warning" (P1) ✓ (reachability: >=500 = down)
- facilitator `degraded:true` (200 OK) → severity "warning" ✓ (replica exacto incidente 2026-07-05)

---

## Hallazgos finales

### BLOQUEANTEs (0)
- **Ninguno.** Los 2 hallazgos bloqueantes iniciales de AR fueron **must-fix**:
  1. **Reachability enmascaraba 5xx como "vivo"** → **RESUELTO** (fix-pack: `status >= 500` → DOWN)
  2. **Chequeo secuencial sin maxDuration → el monitor moría bajo outage total** → **RESUELTO** (fix-pack: `Promise.allSettled` + `vercel.json maxDuration:30`)

### MENORs (4 — documentados en auto-blindaje.md, aceptados como deuda operativa)
- **MNR-1** (reachability-5xx): Ahora el monitor distingue 5xx (down) de <500 (vivo). Lección: separar "hubo respuesta HTTP" de "el servicio está sano" en cualquier health-check futuro.
- **MNR-2** (paralelización): Ahora usa `Promise.allSettled`. Lección: todo cron/monitor que itere sobre N targets con I/O deben paralelizar con `allSettled`, nunca `for await` en serie.
- **MNR-3** (doc verdadera): NIT-1 del fix-pack — la doc afirmaba que `ONCALL_MENTION` aplica a TODAS las critical (health+gas), pero el cron de gas NO pasaba `mention`. **Fixeado** en el mismo commit: gas-balance-check ahora threadea `mention`.
- **MNR-4** (mass-ping guard): NIT-2 del fix-pack — un `ONCALL_MENTION=@everyone` por typo hubiera fanout-eado un ping masivo. **Guardado** con `_resolveSafeMention` que rechaza `@everyone`/`@here`.

---

## Auto-Blindaje consolidado

Registro de 4 errores anticipados + 2 fixes complementarios documentados durante F3/fix-pack:

| # | Error/Gotcha | Causa raíz | Fix | Aplicar en futuras HUs |
|----|----------|-----------|-----|---------------|
| **AB-1** | Registrar un cron nuevo rompe asserts hardcodeados en `setup-cronjob.test.mjs` | Test fija conteo exacto (5→6 jobs, 4→5 PUT, asserts en títulos alfabéticos) | Actualizar TODOS los asserts numéricos en el mismo commit (titles, counts, `r2patches`, líneas de stdout) | Toda HU que agregue un 7º+ job: buscar "EXPECTED_TITLES" y todos los conteos |
| **AB-2** | Cadencia cron-job.org: strings crontab (`*/4`) registran job como "Jan 1 yearly" | REST API de cron-job.org exige arrays de enteros (`-1`=every), no strings | Usar `minutes:[0,4,8,...,56]` mismo patrón que warmup; validar `typeof === 'number'` en tests | Nativo en la HU; validar en `setup-cronjob.test.mjs` T-CRJ-INT-07 |
| **AB-3** | `reachability` trataba CUALQUIER status HTTP como "vivo" → outage silencioso en 5xx | Equiparación falsa: "recibí respuesta HTTP" ≠ "servicio sano"; cierto para 401/404, falso para 5xx | Distinguir por rango: `status >= 500` → DOWN; `status < 500` → vivo/ok. Tests T-HM-16 (503→down, 404→ok) | Health-check/ping del ecosistema: NUNCA un 5xx es "vivo" |
| **AB-4** | Monitor secuencial (`for...of await`) × timeout escalaba latencia; sin `maxDuration` plataforma cortaba función → 502 bajo outage | N×timeout worst-case; Vercel sin maxDuration aplica ~10s default | Paralelizar: `Promise.allSettled(targets.map(_processTarget))` + `maxDuration:30` en `vercel.json` | Cron/monitor de N targets: paralelizar con `allSettled`, declarar `maxDuration` explícito |
| **NIT-1** | Doc afirmaba push P0 en TODAS las critical (health+gas); gas-cron NO pasaba `mention` → gas-critical nunca pusheaban | Promesa cross-cutting incumplida en gas-balance-check; falta threadear `mention` | Thread `mention` a `checkGasBalances`; `sendAlert` lo aplica solo en critical (gateado en `alerts.mjs`) | Cuando doc promete comportamiento cross-cutting: verificar TODOS los call-sites |
| **NIT-2** | `ONCALL_MENTION=@everyone` hubiera fanout-eado ping masivo en cada P0 | Sin validación en config; input de notificación sin sanitización | `_resolveSafeMention` rechaza/sanitiza valores conteniendo `@everyone`/`@here`; trata como sin-mention + `warnOnce` | Config de notificación siempre necesita guard contra valores de fanout masivo |

**Política de consolidación**: Todos los hallazgos quedan registrados en el auto-blindaje. Son lecciones operativas para futuras HUs del mismo dominio (health-checks, cronjobs, alerting). Ninguno bloquea DONE.

---

## Entregables — Archivos modificados/creados

### Nuevos módulos (3)
- **`mcp-servers/wasiai-x402/src/health-monitor.mjs`** (450 LOC, CORE)
  - `parseHealthTargets()` — parsear `HEALTH_MONITOR_TARGETS` (env JSON)
  - `checkHealthTargets()` — iterar sobre targets, chequear HTTP, parsear degradado, evaluar severidad
  - `_processTarget()` — try/catch, timeout, aislamiento por target
  - `_evaluateTarget()` — lógica de severidad (normal + reachability distingue 5xx)
  - Inyección de dependencias: `fetchHealth` (fetch real/mock), `sendAlert` (reusado)

- **`mcp-servers/wasiai-x402/api/cron/health-check.mjs`** (120 LOC, ENDPOINT)
  - Auth vía `validateCronSecret()` + `CRON_SECRET` (mismo patrón que `gas-balance-check.mjs`)
  - Parseo de env → targets
  - Invocación de `checkHealthTargets()`
  - Soporte `?dryRun=1` (gateado post-auth)
  - Response siempre 200 (fail-open)

- **`doc/operations/oncall-runbook.md`** (NUEVO, DOCS)
  - Tabla de severidad↔tier↔escalación (P0=immediate/mention, P1=channel, P2=log)
  - Procedimiento por servicio (gateway, facilitator, x402-mcp, app.wasiai.io)
  - Cómo usar test-alert (`?dryRun=1`)
  - Configuración necesaria (env vars, Discord webhook)

### Modificaciones (3)
- **`mcp-servers/wasiai-x402/src/alerts.mjs`** (diff +5 líneas)
  - `ALLOWED_BODY_KEYS` extendido: agregar `service`, `httpStatus` (además de `url`, `logsUrl`, `checkedAt`, `severity` que ya existían)
  - `formatForDiscord()` ya maneja `content` con `mention` en `critical` → no requiere cambios lógicos

- **`mcp-servers/wasiai-x402/api/cron/gas-balance-check.mjs`** (diff +3 líneas, FOLD-IN NIT-1)
  - Thread `mention` desde el parámetro de invocación a `checkGasBalances()`
  - `sendAlert()` lo gatea a critical-only (ya implementado en `alerts.mjs`)

- **`scripts/setup-cronjob.mjs`** (diff +15 líneas, 6º job)
  - Agregar job `wasiai-x402-health-check` (cadencia 4 min vía arrays `minutes:[0,4,8,...,56]`)
  - Registro en POST call a cron-job.org
  - Asserts en tests actualizados (+count, EXPECTED_TITLES, T-CRJ-INT-07)

### Housekeeping (2)
- **`.env.example`** (diff +10 líneas)
  - `HEALTH_MONITOR_TARGETS` (JSON array con defaults: los 4 targets propuestos)
  - `ONCALL_MENTION` (Discord user/role ID, ej. `<@123456789>`)
  - Documentación de timeout, cadencia

- **`vercel.json`** (diff +1 línea)
  - `functions.["api/cron/health-check.mjs"].maxDuration = 30` (belt-and-suspenders vs Vercel default ~10s)

### Tests (full coverage)
- **`mcp-servers/wasiai-x402/tests/health-monitor.test.mjs`** (350+ lines)
  - T-HM-01..17 (parse, severity, reachability, degraded, timeout, fail-open, paralelización)
  - 22 subtests, todos PASS

- **`mcp-servers/wasiai-x402/tests/cron-health-check.test.mjs`** (300+ lines)
  - T-HC-01..07 (auth, env, dryRun, payload whitelist, alerts, fail-open)
  - 18 subtests, todos PASS

- **`mcp-servers/wasiai-x402/tests/alerts.test.mjs`** (extensión)
  - T-AL-PUSH-01..06 (mention, content, sanitización @everyone/@here)
  - 12 subtests, todos PASS

---

## Decisiones técnicas ratificadas

| DT | Decisión | Ratificación | Impacto |
|----|----------|--------------|---------|
| **DT-1** | Monitor en `mcp-servers/wasiai-x402/` (no en `src/`) | CONFIRMED | Reutiliza infra cron+alerts+env; monitorea gateway externamente sin acoplamiento en-proceso |
| **DT-2** | Cadencia 4 min (no <2 min original) | CONFIRMED | Límite cron-job.org free tier; mejor esfuerzo vs granularidad de plataforma |
| **DT-3** | 4 targets (gateway P0, facilitator P0, x402 P1, app.wasiai P1) | CONFIRMED | Coverage crítica; tiers propuestos validados en vivo |
| **DT-4** | `degradedPath` configurable por target (JSON-path genérico) | CONFIRMED | Facilita agregar servicios sin hardcodeo; soporta heterogeneidad de shapes |
| **DT-5** | Whitelist extendido: `service`, `httpStatus` (no-secretas) | CONFIRMED | Payload completo sin información sensible; consiste con CD-4 |
| **DT-6** | Test-alert como flag `?dryRun=1` (no script aparte) | CONFIRMED | Mismo endpoint, mismo auth, máxima consistencia con `gas-balance-check.mjs` |

---

## Constraint Directives — cumplimiento

| CD | Constraint | Verificación | Status |
|----|-----------|--------------|--------|
| **CD-1** | OBLIGATORIO reusar `sendAlert()` — NO duplicar cliente/formateo | `health-monitor.mjs:300-320` inyecta `sendAlert`; no hay segundo cliente de Discord | ✓ CUMPLIDO |
| **CD-2** | Fail-open: cron SIEMPRE 200 aun en error | `api/cron/health-check.mjs:110-116` responde 200 en catch | ✓ CUMPLIDO |
| **CD-3** | PROHIBIDO hardcodear URLs/tiers/timeouts — todo env | Todos los targets + cadencia + timeout vía `HEALTH_MONITOR_TARGETS` env + `TIMEOUT_MS` | ✓ CUMPLIDO |
| **CD-4** | PROHIBIDO secrets en payload — solo non-secretas | Body whitelist sanitizado; `content` genérico (no interp body) | ✓ CUMPLIDO |
| **CD-5** | PROHIBIDO modificar código de servicios monitoreados | Zero cambios en `wasiai-a2a`, `wasiai-facilitator`, etc. Monitor accede solo vía HTTP público | ✓ CUMPLIDO |
| **CD-6** | Timeout ≤5s por health-check para que servicios caídos no cuelguen el monitor | Default 5000ms, soporta override por target | ✓ CUMPLIDO |

---

## Missing Inputs resueltos

| Missing Input | F0 | F2/F3 | Resolución |
|-------|----|----|-----------|
| Shape real de endpoints (curl sin red saliente F0) | ❌ N/A | ✓ CONFIRMADO | Tests mockeados + dry-run en vivo contra 4 endpoints reales (2026-07-06); shapes confirmados |
| Tier de negocio por servicio | ❓ PROPUESTA | ✓ CONFIRMADO | P0: gateway + facilitator (revenue-path); P1: x402 + app (observabilidad) — ratificado |
| Push real de P0 (@fer mention) | ❌ FUERA DE SCOPE | ✓ PARCIAL | Runbook + embed text visible + field `content` cableado. ONCALL_MENTION env necesaria en activación (ver follow-ups) |
| Cadencia exacta | ❓ PROPUESTA (4 min) | ✓ CONFIRMADO | Cadencia 4 min ratificada; validada en `setup-cronjob.mjs` |

---

## Activación pendiente — Follow-ups críticos

### 1. **Deploy wasiai-x402 con código nuevo** (deploy BLOQUEADOR)
- Branch: `feat/150-wkh-77-oncall-alerting` (listos para merge, no mergear aún)
- Steps:
  1. `git push origin feat/150-wkh-77-oncall-alerting`
  2. Merge a `main` (PR review por orquestador)
  3. Deploy a Vercel: `git push origin main` → CI automático en Railway/Vercel

### 2. **Setear vars de env en Railway** (activación CRÍTICA)
- `HEALTH_MONITOR_TARGETS` — JSON array con los 4 targets:
  ```json
  [
    {
      "label": "gateway-a2a",
      "url": "https://wasiai-a2a-production.up.railway.app/health",
      "tier": "P0",
      "logsUrl": "https://railway.app/project/.../service/..."
    },
    {
      "label": "facilitator",
      "url": "https://wasiai-facilitator-production.up.railway.app/health",
      "tier": "P0",
      "degradedPath": "degraded",
      "logsUrl": "https://railway.app/project/.../service/..."
    },
    {
      "label": "x402-mcp",
      "url": "https://wasiai-x402-mcp.vercel.app",
      "tier": "P1",
      "reachabilityOnly": true,
      "logsUrl": "https://vercel.com/wasiai/.../..."
    },
    {
      "label": "app-wasiai",
      "url": "https://app.wasiai.io",
      "tier": "P1",
      "logsUrl": "https://vercel.com/wasiai/.../..."
    }
  ]
  ```
  
- `ONCALL_MENTION` — Discord user/role ID (CRÍTICO para push P0 de verdad)
  - Formato: `<@DISCORD_USER_ID>` (ej. `<@123456789>`)
  - Sin este, las critical de health siguen alertando pero SIN notificación push

### 3. **Verificación de Discord webhook** (pre-requisito)
- `MCP_ALERT_WEBHOOK_URL` ya existe y funciona (reusado de WKH-71/90/91)
- Test: ejecutar `/cron/health-check?dryRun=1&CRON_SECRET=XXX` contra staging/prod → debe disparar 4 alertas de prueba (una por target)

### 4. **Registración del 6º cron en cron-job.org** (automático)
- El 6º job se registra automáticamente en el próximo deploy vía `scripts/setup-cronjob.mjs`
- Se ejecutará cada 4 min: `wasiai-x402-health-check`
- Dashboard de cron-job.org: verificar "wasiai-x402-health-check" en la lista de jobs

### 5. **Documentación final en runbook** (entregado, solo revisar)
- `doc/operations/oncall-runbook.md` — ya contiene procedimiento completo
- Link a este report desde la landing interna si aplica

---

## Gates de QA — Resultados

```
npx tsc --noEmit                 → ✓ 0 errores
npm run lint (biome)             → ✓ "No fixes applied"
npx vitest run                   → ✓ PASS 2653 / FAIL 0
node --test tests/*.test.mjs     → ✓ tests 304, pass 304, fail 0
```

**Drift detection**: Scope IN respetado (ninguna artefacto fuera de spec). Fold-in menores documentado (gas-balance-check +mention, .gitignore housekeeping).

---

## Relación con WKH-71 y WKH-74

| HU | Concern | Patrón | Status |
|----|---------|--------|--------|
| **WKH-71** (fila 149) | Operator wallet balance (gas nativo) | Monitor de balance + alerta + runbook | DONE |
| **WKH-77** (esta) | Service health (uptime/degradation) | Monitor de health + alerta + runbook | DONE |
| **WKH-74** (futura) | Synthetic probes (functional) | Transacción real expect-402 | BACKLOG |

**Trípode observabilidad**: Gas (WKH-71) + Health (WKH-77) + Synthetic (WKH-74). Este cierre completa los 2 primeros lados.

---

## Lecciones para próximas HUs

1. **Health-check genérico vs especializado** (AB-3)
   - Separar "recibí respuesta HTTP" de "el servicio está sano"
   - Para reachability-only: `status >= 500` es DOWN, `< 500` es vivo
   - Para health-check completo: incluir degradado-lógico vía JSON-path configurable

2. **Paralelización de I/O en cronjobs** (AB-4)
   - Nunca iterar targets en serie (`for await`) cuando hay I/O de red
   - `Promise.allSettled(targets.map(...))` acota latencia a ~max(timeout) + preserva aislamiento
   - Siempre declarar `maxDuration` explícito en Vercel para que el monitor no muera bajo el outage que debe reportar

3. **Asserts hardcodeados en tests de infra** (AB-1)
   - Si un test fija conteo exacto (N jobs, N líneas), documentar cada assert numérico
   - Agregar un nuevo job requiere actualizar TODOS los asserts en el mismo commit, no solo el más obvio

4. **Configuración de cronjobs: tipos correctos** (AB-2)
   - cron-job.org REST API exige arrays de enteros para cadencia, nunca strings crontab
   - Validar `typeof === 'number'` en tests para atrapar typos temprano

5. **Doc debe ser verdadera en toda la capa** (NIT-1)
   - Cuando la doc promete un comportamiento cross-cutting (ej. "mention en TODAS las critical"), verificar TODOS los call-sites
   - Si un subsistema (gas-cron) promete comportamiento, debe cumplo independientemente; no asumir que "alguien más" lo hace

6. **Sanitización de valores de notificación** (NIT-2)
   - Config de alerts/paging debe validar contra valores de fanout masivo (`@everyone`, `@here`, etc.)
   - Trata valores inválidos como sin-notificación + log, nunca falla la ejecución por config corrupta

---

## Status final

**DONE** — validación aprobada, tests pasados, entregables compilados. En espera de:
1. Merge de PR a `main`
2. Deploy a Railway/Vercel
3. Seteo de `HEALTH_MONITOR_TARGETS` + `ONCALL_MENTION` en vars de env
4. Test manual con `?dryRun=1` contra los 4 endpoints reales

Una vez activado, el monitor ejecutará un tick cada 4 min, detectando outages en <5 min y escalando por Discord con la severidad correcta. Cierra el hueco que dejó el incidente 2026-07-05.
