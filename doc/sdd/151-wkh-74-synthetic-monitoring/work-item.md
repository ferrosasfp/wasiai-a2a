# Work Item — [WKH-74] Synthetic monitoring del payment path (capas A + C + D; capa B ya DONE)

## Resumen
Monitoreo SINTÉTICO/funcional (no solo health) que ejercita el payment path real
de `wasiai-a2a` para detectar que REALMENTE funciona, incluso cuando `/health`
está verde. Cierra el hueco visto en el incidente 2026-07-05 (Chaski $0: el
settle timeouteaba con el servicio devolviendo 200-ok, y WKH-77 no lo cazó).
Para on-call / operador del gateway. 4 capas del ticket original, actualizadas
a la arquitectura real (WKH-71/WKH-77 ya cerraron 2 de las 4).

## Contexto — qué ya está hecho (NO duplicar)
- **Capa B (balance del operator wallet)** → **YA HECHA por WKH-71** (fila 149
  `doc/sdd/149-wkh-71-operator-wallet-alert/`, DONE + activado). Monitor
  multi-wallet/multi-chain de gas nativo, cron 15 min, alertas
  critical/warning. **Scope OUT en este WKH.**
- **Canal on-call + runbook de escalación (AC-5 original / dependencia "item
  #9")** → **YA HECHO por WKH-77** (fila 150 `doc/sdd/150-wkh-77-oncall-alerting/`,
  DONE). `sendAlert` → Discord `#wasiai-alerts` + `doc/operations/oncall-runbook.md`.
  Este WKH **reusa** `mcp-servers/wasiai-x402/src/alerts.mjs::sendAlert`,
  `ONCALL_MENTION` y el runbook existente — no crea un canal nuevo.
- **F0 confirmó el probe correcto para la capa A** leyendo el código real (no
  se pudo curlear en vivo — este agente no tiene herramienta shell/curl
  disponible; la conclusión está fundada en lectura de fuente, ver DT-1):
  `src/middleware/a2a-key.ts::requirePaymentOrA2AKey` — sin `x-a2a-key` ni
  `Authorization: Bearer wasi_a2a_*` → delega a `requirePayment()`
  (`src/middleware/x402.ts:245-248`) → si no hay header `x-payment`/`payment-signature`
  → `reply.status(402).send(await buildX402Response(...))`. El shape original
  del ticket ("expect 402") **es correcto**, siempre que el probe NO envíe
  ningún header de auth/pago (ni siquiera una key sin fondos — eso daría 403
  `INSUFFICIENT_BUDGET`, no 402).

## Sizing
- SDD_MODE: full
- Estimación: M
- Pipeline: **FAST+AR** — capa D dispara un settle real ($0.001-0.05 USDC) →
  Adversarial Review obligatorio (money-path).
- Branch sugerido: `feat/151-wkh-74-synthetic-monitoring`

## Acceptance Criteria (EARS)

### Capa A — Free synthetic (expect-402), $0
- **AC-1**: WHEN el cron ejecuta el probe cada 15 min haciendo `POST /orchestrate`
  con un body `{goal, budget}` mínimo válido (pasa el schema) y SIN ningún
  header de auth/pago (`x-a2a-key`, `Authorization`, `x-payment`,
  `payment-signature`), the system SHALL esperar HTTP 402 cuyo
  `body.accepts[0].payTo` coincida con `PAYMENT_WALLET_ADDRESS`/`KITE_WALLET_ADDRESS`
  y `body.accepts[0].asset`/`network` coincidan con el adapter de la chain
  default configurada.
- **AC-2**: IF el probe de capa A recibe cualquier respuesta que NO sea un 402
  con ese shape exacto (incluye 200, 401, 403, 5xx, timeout de red, o un 402
  con `payTo`/`asset`/`network` que no matchea lo esperado), THEN the system
  SHALL disparar un alert `severity: critical` vía `sendAlert` con
  `reason: 'synthetic-payment-path-broken'`.
- **CD-4** (ver abajo) garantiza que capa A nunca gasta dinero.

### Capa D — Real-tx synthetic gated por deploy SHA (~$0.02/mes)
- **AC-3**: WHEN el cron hourly detecta que el identificador de deploy actual
  del gateway (DT-2) difiere del último valor persistido en KV, the system
  SHALL ejecutar UN real-tx synthetic (`POST /orchestrate` real, goal mínimo,
  pagado con la Agent Key dedicada de monitoreo — DT-4) y SHALL validar que la
  respuesta trae `kiteTxHash`/tx hash verificable on-chain antes de actualizar
  el KV al nuevo identificador.
- **AC-4**: IF el real-tx synthetic falla (HTTP error, ausencia de tx hash, o
  el pipeline reporta `success: false`), THEN the system SHALL disparar un
  alert `severity: critical` con `reason: 'post-deploy-synthetic-tx-failed'`
  y SHALL NOT actualizar el KV del deploy identifier (reintenta en el próximo
  tick hasta que el probe pase).
- **AC-5**: WHILE el deploy identifier no cambió desde la última corrida
  exitosa, the system SHALL NOT ejecutar ningún real-tx (evita gasto repetido;
  presupuesto ~$0.02/mes = ~1 tx por deploy).

### Capa C — Native error-rate alerts (Vercel + Railway), doc-only v1
- **AC-6**: the system SHALL documentar en un runbook (`doc/operations/synthetic-monitoring-runbook.md`)
  los pasos exactos para activar el error-rate alerting nativo en el
  proyecto Vercel (`wasiai-x402-mcp`) y en los proyectos Railway
  (`wasiai-a2a`, `wasiai-facilitator`), incluyendo qué toggle habilitar en
  cada UI y a qué canal (Discord `#wasiai-alerts` u otro) debe apuntar.

### Reuso de alerting (transversal)
- **AC-7**: the system SHALL reusar `mcp-servers/wasiai-x402/src/alerts.mjs::sendAlert`
  y `ONCALL_MENTION` para TODA alerta emitida por capas A y D — PROHIBIDO
  crear un segundo cliente de webhook/canal.

## Scope IN
- `mcp-servers/wasiai-x402/src/synthetic-payment-monitor.mjs` (nuevo, capa A —
  módulo puro DI, mismo patrón que `gas-monitor.mjs`/`health-monitor.mjs`).
- `mcp-servers/wasiai-x402/src/synthetic-tx-monitor.mjs` (nuevo, capa D —
  módulo puro DI).
- `mcp-servers/wasiai-x402/api/cron/synthetic-payment-check.mjs` (nuevo, capa A,
  cadencia 15 min).
- `mcp-servers/wasiai-x402/api/cron/synthetic-tx-check.mjs` (nuevo, capa D,
  cadencia 1h, gated por SHA-diff).
- `mcp-servers/wasiai-x402/src/kv-keys.mjs` (agregar key nueva para el
  last-known deploy SHA).
- `scripts/setup-cronjob.mjs` (agregar los 2 jobs nuevos → total 8).
- `doc/operations/synthetic-monitoring-runbook.md` (nuevo, capa C).
- `.env.example` (nuevas vars: ver DTs).

## Scope OUT
- Capa B (balance del operator wallet) — **ya hecha, WKH-71**.
- Canal on-call / runbook de escalación genérico — **ya hecho, WKH-77**.
- Cambiar el payment path core (`x402.ts`, `a2a-key.ts`, `orchestrate.ts`).
- Mainnet (todo testnet, igual que WKH-71/77).
- PagerDuty o cualquier canal distinto de Discord.
- Bot Telegram/WhatsApp, dashboards de métricas nuevos.
- Automatizar la activación de los toggles nativos Vercel/Railway (capa C es
  doc-only en v1 — DT-6).

## Decisiones técnicas (DT-N)
- **DT-1**: probe de capa A = `POST /orchestrate` con body válido y **sin
  ningún header de auth/pago**. Confirmado leyendo
  `src/middleware/a2a-key.ts` (dispatcher `requirePaymentOrA2AKey`) +
  `src/middleware/x402.ts:245-248` (`requirePayment` → 402 cuando no hay
  `x-payment`). Cubre: server up (Railway), x402 protocol layer, token/chain
  config (`payTo`/`asset`/`network` vienen de env + adapter). **NO cubre DB**
  — el 402 se construye antes de tocar Supabase; gap conocido, no se cierra
  acá (F0 no pudo verificar esto con curl en vivo por falta de herramienta
  shell en este agente; la lectura de código es la fuente de verdad usada).
- **DT-2**: el ticket original asumía "Vercel SHA", pero el payment path real
  (`/orchestrate`) corre en `wasiai-a2a` sobre **Railway**, no Vercel (ver
  CLAUDE.md: "PROD CUTOVER COMPLETO... Railway"). Este WKH usa el
  **deploy identifier de Railway** (`RAILWAY_GIT_COMMIT_SHA` si Railway lo
  inyecta a runtime, a confirmar en F2; fallback: Railway API `deployments`
  con `RAILWAY_TOKEN`, mismo patrón que `VERCEL_TOKEN` de WKH-75/88) — NO
  Vercel SHA. Requiere ratificación del Architect en F2.
- **DT-3**: persistencia del last-known deploy identifier en KV (Upstash, vía
  `kv-client.mjs`), nueva entrada en `KV_KEYS` (`src/kv-keys.mjs`), mismo
  patrón congelado que WKH-88.
- **DT-4**: Agent Key de monitoreo **dedicada** (owner_ref propio, distinta de
  keys de producción/demo), budget pequeño (~$0.05, recarga manual) — para no
  mezclar telemetría de billing real con el synthetic probe.
- **DT-5**: cadencia — capa A cada 15 min (mismo patrón WKH-71/75), capa D
  cada 1h pero gated por SHA-diff (costo real ≈ 1 tx por deploy, no por hora).
- **DT-6**: capa C es **doc-only** en v1 — no hay API estable para verificar/
  automatizar remotamente los toggles nativos de error-rate de Vercel/Railway
  sin ampliar credenciales; se documenta el paso manual.

## Constraint Directives (CD-N)
- **CD-1**: OBLIGATORIO reusar `mcp-servers/wasiai-x402/src/alerts.mjs::sendAlert`
  para toda alerta de capas A/D. PROHIBIDO un segundo cliente de webhook.
- **CD-2**: OBLIGATORIO autenticar los 2 crons nuevos vía `validateCronSecret`/
  `CRON_SECRET` (`src/cron-auth.mjs`), mismo patrón que `api/cron/*.mjs`
  existentes. PROHIBIDO exponerlos sin auth.
- **CD-3**: fail-open — cualquier error del synthetic monitor (RPC, KV, fetch,
  timeout) SHALL loguearse y el cron SHALL responder 200. PROHIBIDO que un
  fallo del monitor tumbe el cron o bloquee el siguiente tick.
- **CD-4**: PROHIBIDO que el probe de capa A envíe cualquier header de pago o
  firme cualquier autorización — debe ser un request "desnudo". Capa A gasta
  $0 SIEMPRE.
- **CD-5**: capa D SHALL gastar como máximo 1 real-tx por deploy detectado
  (gated por SHA-diff — AC-5). PROHIBIDO ejecutar el real-tx en cada tick sin
  cambio de SHA.
- **CD-6**: PROHIBIDO hardcodear la Agent Key de monitoreo, el `payTo`
  esperado, o el deploy identifier — todo vía env vars (mismo patrón que
  `gas-monitor.mjs`/`health-monitor.mjs`).
- **CD-7**: el body de cualquier alert emitida SHALL pasar por
  `sanitizeAlertBody`/`ALLOWED_BODY_KEYS`. PROHIBIDO agregar a esa whitelist
  ningún campo que pueda filtrar secrets (key, firma, tx raw) — solo
  identificadores públicos (severity, reason, httpStatus, chain, checkedAt,
  service, url).

## Missing Inputs
- **[NEEDS CLARIFICATION, no bloqueante]** ¿Railway expone
  `RAILWAY_GIT_COMMIT_SHA` (u otra var) a runtime en el proyecto `wasiai-a2a`
  hoy? A confirmar en F2 con acceso al dashboard/env vars reales. Si no está
  disponible, el Architect debe decidir entre (a) Railway API `deployments`
  con `RAILWAY_TOKEN`, o (b) agregar un campo `commitSha` al `/health` del
  gateway.
- **[NEEDS CLARIFICATION, no bloqueante]** Budget exacto y frecuencia de
  recarga de la Agent Key de monitoreo dedicada (capa D) — sugerido $0.05
  inicial, recarga manual mensual. A confirmar con el humano si prefiere
  automatizar el reload.
- **[NEEDS CLARIFICATION, no bloqueante]** ¿La capa C requiere evidencia de
  que los toggles YA están activados hoy en Vercel/Railway, o el WKH es
  puramente "documentar cómo activarlos"? Asumido lo segundo (doc-only, DT-6)
  por falta de credenciales adicionales para verificar remotamente.
- **[NEEDS CLARIFICATION, no bloqueante — proceso, no producto]** F0 no pudo
  ejecutar curl en vivo contra `https://wasiai-a2a-production.up.railway.app`
  porque este agente (nexus-analyst) no tiene herramienta shell/curl
  disponible en este entorno. La definición del probe de capa A (DT-1) se
  basó en lectura exhaustiva del código fuente real (`a2a-key.ts` + `x402.ts`),
  no en verificación en vivo. Se recomienda que el Architect (F2) o el Dev
  (F3, vía smoke script) valide esto contra el gateway real antes de mergear.

## Análisis de paralelismo
- No bloquea ninguna otra HU. Puede correr en paralelo con cualquier feature
  que no toque `api/cron/*`, `mcp-servers/wasiai-x402/src/alerts.mjs`,
  `mcp-servers/wasiai-x402/src/kv-keys.mjs`, o `scripts/setup-cronjob.mjs`.
- Depende (soft, reuso — no bloqueo) de WKH-71 (fila 149) y WKH-77 (fila 150),
  ambos DONE.
- Capa D (money-path real) requiere AR obligatorio antes de mergear — no
  puede ir directo a CR.
