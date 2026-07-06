# Work Item — [WKH-77] On-Call Alerting — Health Monitor + Escalation Runbook

## Resumen

Detectar automáticamente cuando un servicio del ecosistema WasiAI cae o se
degrada (5xx / unreachable / timeout / `degraded:true` lógico) y alertar por
Discord con severidad P0/P1/P2 + escalation runbook, en vez de descubrirlo
manualmente como pasó hoy (2026-07-05) con el facilitator (`degraded:true`
durante horas, silencioso, hasta que se detectó debuggeando — ver memoria
`chaski-facilitator-fix-2026-07-05`). El ticket original (mayo 2026) pedía un
webhook por-servicio; F0 encontró que el canal YA EXISTE (`MCP_ALERT_WEBHOOK_URL`,
Discord, `mcp-servers/wasiai-x402/src/alerts.mjs::sendAlert()`) y que WKH-71
(fila 149 del índice, DONE) ya shipeó el patrón exacto de cron + módulo puro +
alerta a clonar. Esta HU reformula el AC-1: **un monitor central de health**
(no un webhook por repo).

## Sizing

- SDD_MODE: mini (FAST+AR — nuevo módulo aditivo, sin tocar money-path directo;
  AR obligatorio por extender `alerts.mjs` (`ALLOWED_BODY_KEYS`, compartido con
  WKH-71/WKH-90/WKH-91) y por registrar un nuevo cron)
- Estimación: M (módulo core + cron endpoint + registro en `setup-cronjob.mjs`
  + extensión de whitelist + runbook + mecanismo de test-alert — más superficie
  que un patch simple, pero sin lógica de negocio nueva)
- Branch sugerido: `feat/150-wkh-77-oncall-alerting`

## Acceptance Criteria (EARS)

- **AC-1** (reformulado del ticket original): WHEN el cron de health-monitor
  ejecuta un tick, the system SHALL chequear el endpoint de health HTTP de
  cada servicio configurado en un **registro central** (`HEALTH_MONITOR_TARGETS`
  env, JSON array) — NO requiere webhook ni cambios de código en cada
  repo monitoreado.
- **AC-2**: WHEN un servicio monitoreado responde con status HTTP no-2xx, es
  inalcanzable (connection refused/DNS), o excede el timeout configurado, the
  system SHALL disparar una alerta vía `sendAlert()` (WKH-90/91, reusado sin
  duplicar cliente) con severidad mapeada al tier de negocio del servicio
  (P0→`critical`, P1→`warning`, P2→`info`) dentro de un tick de cron (target
  ≤5 min — ver DT-2, mejor esfuerzo respecto al `<2min` original del ticket
  dada la granularidad de `cron-job.org`).
- **AC-3**: WHEN un servicio monitoreado responde HTTP 2xx pero su payload de
  health señala un estado lógico degradado (p.ej. `{degraded:true}` del
  facilitator), the system SHALL alertar severidad `warning` (P1) aunque el
  status HTTP sea 200 — parseo vía un JSON-path configurable por servicio
  (DT-4), no hardcodeado al shape de un único servicio.
- **AC-4**: the system SHALL incluir en el payload de la alerta: nombre/label
  del servicio, código de error o status HTTP, timestamp del chequeo, un link
  estático a logs/dashboard (Railway/Vercel, configurado por servicio) y la
  severidad — reusando el whitelist `ALLOWED_BODY_KEYS` de `alerts.mjs`
  extendido con las keys no-secretas necesarias (DT-5).
- **AC-5**: the system SHALL documentar un runbook de escalación en
  `doc/operations/oncall-runbook.md`: P0 (servicio caído / revenue path) →
  atención inmediata (mención a @fer en la descripción del embed — ver
  Missing Inputs sobre el límite real de "mention" en Discord), P1 (degradado)
  → canal (revisar en horario hábil), P2 (warning transitorio) → baja
  prioridad / solo log.
- **AC-6**: the system SHALL proveer un mecanismo de test-alert invocable
  manualmente (protegido por `CRON_SECRET`, mismo patrón que el resto de
  `api/cron/*`) que dispare una alerta sintética por cada servicio configurado,
  sin esperar una caída real, para verificar el circuito end-to-end.
- **AC-7** (unwanted / fail-open, patrón heredado de WKH-71 AC-6): IF el
  chequeo HTTP de un servicio falla por una razón ajena a la salud real del
  servicio (bug del propio monitor, DNS local, etc.), THEN the system SHALL
  loggear el error y continuar con los demás servicios sin abortar el tick
  (aislamiento por servicio) y SIEMPRE responder 200 al caller del cron.

## Scope IN

- Nuevo módulo puro `mcp-servers/wasiai-x402/src/health-monitor.mjs` (mismo
  patrón DI que `src/gas-monitor.mjs`: recibe `targets`, `env`, `fetchHealth`
  inyectado, `sendAlert` inyectado — testeable sin red real).
- Nuevo cron endpoint `mcp-servers/wasiai-x402/api/cron/health-check.mjs`
  (auth vía `cron-auth.mjs`, mismo esqueleto que `gas-balance-check.mjs`).
- Registro del nuevo job en `scripts/setup-cronjob.mjs` (o extensión del job
  existente si F2 lo justifica) — cadencia propuesta DT-2.
- Config vía env: `HEALTH_MONITOR_TARGETS` (JSON: `{label, url, tier,
  degradedPath?, logsUrl?}` por servicio), timeout por request.
- Extensión de `ALLOWED_BODY_KEYS` en `alerts.mjs` con las keys nuevas
  no-secretas que necesite el payload de health (DT-5) — sin tocar el
  comportamiento existente de balance/gas alerts.
- Mecanismo de test-alert (AC-6): script o flag de invocación manual.
- Runbook `doc/operations/oncall-runbook.md` (mismo formato que
  `gas-funding-runbook.md`).

## Scope OUT

- Auto-remediation / restart automático de cualquier servicio caído.
- WKH-74 (synthetic probes — expect-402, transacción real) — concern
  DISTINTO, no se duplica acá. Este work-item es solo health/uptime +
  escalación; WKH-74 es probes funcionales de negocio.
- Mainnet — todo el alcance es testnet/prod-testnet actual del ecosistema.
- Paging externo tipo PagerDuty/SMS/llamada — solo canal Discord existente.
- Cambiar código de los servicios monitoreados: `wasiai-a2a` `/health` ya
  existe y NO se modifica (`src/index.ts:130-142`, shape
  `{status,version,uptime,timestamp}`, sin campo degradado lógico hoy);
  `wasiai-facilitator`, `wasiai-x402-mcp` y `app.wasiai.io` son repos fuera
  de (o parcialmente fuera de) este workspace — no se les agrega ningún
  endpoint nuevo.
- @-mention real (push notification) a @fer en Discord — `formatForDiscord`
  hoy solo arma `embeds`, que NO disparan notificación push sin un campo
  `content: "<@USER_ID>"` a nivel raíz del payload. Agregar eso es fuera de
  scope de este work-item (ver Missing Inputs); AC-5 se cumple con el
  runbook documentado y el texto "@fer" visible en el embed, no con push real.

## Decisiones técnicas (DT-N)

- **DT-1**: el monitor vive en `mcp-servers/wasiai-x402/` (mismo home que
  WKH-71/149), NO dentro de `src/` de `wasiai-a2a` — reusa infra de cron +
  alerts + env ya existente; monitorea a `wasiai-a2a` vía HTTP externo como a
  cualquier otro servicio (sin acoplarse en proceso).
- **DT-2**: cadencia propuesta 4 min, reusando el patrón de minutos de
  `wasiai-x402-warmup` (el cron más frecuente hoy en `setup-cronjob.mjs`) en
  vez de crear un intervalo sub-minuto no soportado con el mismo grado de
  confianza en `cron-job.org` free tier. Esto es mejor esfuerzo frente al
  `<2 min` literal del ticket original — a ratificar en F2.
- **DT-3** (propuesta de targets y tier, a confirmar en F2 — F0 no pudo
  curlear los endpoints reales desde este entorno, sin acceso a red saliente):
  | Servicio | Health URL | Tier | Shape conocido |
  |---|---|---|---|
  | wasiai-a2a gateway | `https://wasiai-a2a-production.up.railway.app/health` | P0 | `{status,version,uptime,timestamp}` — sin degradado lógico (confirmado leyendo `src/index.ts`) |
  | wasiai-facilitator | `https://wasiai-facilitator-production.up.railway.app/health` | P0 | `{degraded, details:{redis,wallet,chains}}` (según contexto de la tarea — degradado lógico soportado, AC-3) |
  | wasiai-x402-mcp | `https://wasiai-x402-mcp.vercel.app` | P1 | sin endpoint público de health confirmado en este repo (`api/mcp.mjs` requiere Bearer, `api/cron/warmup` requiere `CRON_SECRET`) — probe de reachability-only (cualquier respuesta HTTP, incluso 401, cuenta como "vivo"; solo connection-error/timeout cuenta como down) |
  | app.wasiai.io | `https://app.wasiai.io` | P1 | repo `wasiai-v2`, fuera de este workspace — probe de reachability GET `/` esperando 2xx, sin verificación de degradado lógico |
- **DT-4**: parseo de degradado-lógico genérico vía un `degradedPath`
  configurable por entrada de target (p.ej. `"degraded"` para el facilitator),
  no hardcodeado al shape de un servicio específico dentro del core.
- **DT-5**: nuevas keys candidatas para `ALLOWED_BODY_KEYS` (no-secretas):
  `service` (o reusar `label`, ya existe), `url` (o `logsUrl`), `httpStatus`.
  `reason` y `checkedAt` ya existen en el whitelist — se reusan tal cual.
- **DT-6**: test-alert (AC-6) como script `scripts/test-health-alert.mjs` o
  flag `?dryRun=1` en el propio cron endpoint (protegido por `CRON_SECRET`
  igual que el resto) — decisión de implementación exacta para F2.

## Constraint Directives (CD-N)

- **CD-1**: OBLIGATORIO reusar `mcp-servers/wasiai-x402/src/alerts.mjs::sendAlert()`.
  PROHIBIDO crear un segundo cliente de alertas o duplicar el formateo Discord/Slack.
- **CD-2**: OBLIGATORIO fail-open: el cron SIEMPRE responde 200; un timeout o
  error de un servicio NUNCA aborta el chequeo de los demás (mismo patrón
  AC-6/read-error de `gas-monitor.mjs`).
- **CD-3**: PROHIBIDO hardcodear URLs, tiers o timeouts de servicios en
  código — todo vía `HEALTH_MONITOR_TARGETS` (env, JSON), con defaults
  documentados solo en `.env.example` (mismo patrón que `GAS_ALERT_TARGETS`).
- **CD-4**: PROHIBIDO exponer secrets en el payload de alerta. Las keys nuevas
  agregadas a `ALLOWED_BODY_KEYS` deben ser estrictamente no-secretas (URLs
  públicas, status codes, labels) — mismo criterio que CD-2/CD-12 históricos.
- **CD-5**: PROHIBIDO modificar el código de los servicios monitoreados. El
  único cambio permitido en `wasiai-a2a` (este repo) es, si acaso, agregar el
  gateway como UN target más del monitor — no tocar el propio endpoint `/health`
  existente.
- **CD-6**: OBLIGATORIO timeout corto (≤5s, mismo criterio que `sendAlert`)
  por cada health-check HTTP saliente, para que un servicio caído no cuelgue
  el chequeo de los demás dentro del mismo tick.

## Missing Inputs

- `[NEEDS CLARIFICATION]` No se pudo verificar en vivo (curl) el shape real
  de los 4 endpoints propuestos desde este entorno de F0 (sin acceso a red
  saliente en esta sesión) — F2 debe confirmar antes de fijar `degradedPath`
  y el contrato exacto de cada target, especialmente si `wasiai-x402-mcp` o
  `app.wasiai.io` exponen algún endpoint de health real que F0 no vio en este
  workspace.
- `[NEEDS CLARIFICATION]` Tier de negocio exacto por servicio (P0/P1/P2) —
  DT-3 es una propuesta razonable (servicios que cobran = P0, resto = P1),
  a ratificar por el humano.
- `[NEEDS CLARIFICATION]` Mecanismo real de notificación push para P0
  ("@fer") — Discord embeds no notifican sin un `content` field adicional;
  este work-item entrega el runbook + texto visible, NO push real (posible
  fast-follow separado si se confirma que se necesita).
- `[resuelto en F2]` Cadencia exacta del cron — propuesta DT-2 (4 min).

## Análisis de paralelismo

- No bloquea ni es bloqueada por ninguna HU activa (todas las filas de
  `_INDEX.md` están en DONE al momento de este F1).
- Comparte choke-point de merge con WKH-71/149 (`mcp-servers/wasiai-x402/src/alerts.mjs`,
  `scripts/setup-cronjob.mjs`) — evitar tocar esos archivos en simultáneo con
  otra HU para no generar conflicto.
- Relacionado pero NO duplicado con WKH-74 (synthetic monitoring de negocio,
  probes funcionales) — si WKH-74 se retoma en paralelo, coordinar la lista
  de targets/cron jobs para no registrar monitoreo redundante en
  `cron-job.org`.
