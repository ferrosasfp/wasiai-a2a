# On-Call Alerting Runbook — WKH-77

Cómo responder cuando el **health monitor** del ecosistema WasiAI (testnet) avisa
que un servicio cayó o se degradó. Complementa `gas-funding-runbook.md` (fondeo
de gas de los wallets firmantes); acá el foco es **uptime / estado de salud** de
los servicios HTTP y la **escalación** por severidad.

## Por qué existe (incidente 2026-07-05)

El facilitator quedó en `degraded:true` durante horas **en silencio** (HTTP 200,
pero el settle-path degradado) hasta que se detectó debuggeando a mano. Este
runbook + el monitor `api/cron/health-check.mjs` (WKH-77) existen para que eso
**avise antes**: cada ~4 min el cron pinguea el `/health` de cada servicio y, si
está caído o degradado, dispara un webhook Discord con la severidad del tier.

El monitor **NO remedia solo** (auto-restart está fuera de scope). Dispara la
alerta; la respuesta es manual siguiendo esta guía.

## Servicios monitoreados

Configurados por env `HEALTH_MONITOR_TARGETS` (JSON, ver `.env.example`) — sin
hardcode en código (CD-3). Config recomendada por defecto:

| label | Health URL | Tier | Modo de chequeo | Logs |
|-------|-----------|------|-----------------|------|
| `gateway-a2a` | `https://wasiai-a2a-production.up.railway.app/health` | **P0** | HTTP 200 + `status=="ok"` | Railway → proyecto `wasiai-a2a` |
| `facilitator` | `https://wasiai-facilitator-production.up.railway.app/health` | **P0** | HTTP 200 + `degraded==false` (si `degraded:true` → warning P1 aunque sea 200, AC-3) | Railway → proyecto `wasiai-facilitator` |
| `x402-mcp` | `https://wasiai-x402-mcp.vercel.app/` | **P1** | reachability-only: cualquier respuesta HTTP (incl. 404) = vivo; solo connection-error/timeout = down | Vercel → `wasiai-x402-mcp` |
| `app-wasiai` | `https://app.wasiai.io/` | **P1** | HTTP 2xx (sigue redirects) | Vercel → `wasiai-v2` |

> Los links de logs viven en `logsUrl` de cada target y se incluyen en el body de
> la alerta. NUNCA se ponen secrets en el body (CD-4): solo labels, URLs públicas
> y status codes.

## Mapeo severidad ↔ tier ↔ escalación (AC-5)

| Severidad | Tier | Color embed | Escalación | SLA |
|-----------|------|-------------|-----------|-----|
| `critical` | **P0** (servicio caído / revenue path) | rojo | **@fer por push** (ver abajo) — atención inmediata | ahora |
| `warning` | **P1** (degradado / no-revenue caído) | amarillo | canal Discord — revisar en horario hábil | mismo día |
| `info` | **P2** (transitorio / best-effort) | verde | baja prioridad — solo log, revisar si se repite | best-effort |

Nota: un servicio **degradado** (`degradedPath` truthy con HTTP 200) se reporta
como `warning` aunque el tier sea P0 — está arriba pero comprometido, no es una
caída total (AC-3).

### Push real de P0 (@fer)

Los embeds de Discord **no** disparan notificación push por sí solos. Para que un
`critical` (P0) despierte a alguien, seteá la env **`ONCALL_MENTION`** con un
mention token de Discord:

- Usuario: `ONCALL_MENTION=<@USER_ID>` (p.ej. el ID de @fer)
- Rol: `ONCALL_MENTION=<@&ROLE_ID>`

Con eso, `sendAlert` agrega un campo raíz `content: "<mention> P0 alert …"` SOLO
en alertas `critical`, que sí genera push. Si `ONCALL_MENTION` está vacío → solo
embed, sin push (comportamiento graceful). Esto aplica también a las alertas
`critical` de gas (WKH-71), que comparten el mismo sender.

## Procedimiento por servicio caído (paso a paso)

1. **Leer la alerta**: `service`/`label`, `severity`, `reason`
   (`health-http-error` / `health-unreachable` / `health-timeout` /
   `health-unhealthy` / `health-degraded`), `httpStatus` (si aplica), `logsUrl`,
   `checkedAt`.
2. **Confirmar** manualmente:
   `curl -i <health-url>` (con el mismo timeout ≤5s). Si responde bien, pudo ser
   transitorio — ver si la próxima alerta (≤4 min) se limpia sola.
3. **Abrir logs** del `logsUrl` de la tabla y buscar el error real.

### `gateway-a2a` (P0 — Railway)

- `health-http-error` / `health-unreachable`: el gateway A2A está caído. Revisar
  Railway → deploy status, últimos logs, memoria/reinicios. Redeploy si crasheó.
- `health-unhealthy` (200 pero `status!="ok"`): el proceso vive pero se
  auto-reporta no-sano. Revisar dependencias (Supabase, RPC) en logs.
- Impacto: **revenue path** — `compose`/`orchestrate`/`capabilities` de v2 delegan
  acá. Prioridad máxima.

### `facilitator` (P0 — Railway)

- `health-degraded` (warning, 200 + `degraded:true`): el settle-path x402 está
  comprometido (típicamente Redis / wallet / RPC de una chain). Revisar el
  `details` del `/health` y los logs Railway del facilitator. Cruzar con el
  gas-funding-runbook si es falta de gas del settle wallet `0x9c0638…`.
- `health-http-error` / `health-unreachable`: facilitator caído — los settles
  OUTBOUND fallan. Redeploy / revisar Railway.

### `x402-mcp` (P1 — Vercel, reachability-only)

- Solo alerta por `health-unreachable` / `health-timeout` (no expone `/health`
  público; un 404 cuenta como vivo). Si alerta, el deploy Vercel no responde:
  revisar Vercel → deployment status / function logs. Un cold-start puntual puede
  dar timeout aislado — confirmar con un segundo curl.

### `app-wasiai` (P1 — Vercel)

- `health-http-error` / `health-unreachable`: la app marketplace no sirve `/`.
  Revisar Vercel → `wasiai-v2` deployment + logs. Impacto: UX del marketplace, no
  el protocolo A2A directamente.

## Verificar el circuito end-to-end (test-alert, AC-6)

Sin esperar una caída real, disparar una alerta sintética por cada target:

```
GET /api/cron/health-check?dryRun=1
Authorization: Bearer $CRON_SECRET
```

Debe llegar una alerta por servicio configurado (reason `health-test-alert`).
Sirve para validar que el webhook Discord y el `ONCALL_MENTION` funcionan.

## Config operativa (env)

| Env | Qué es | Default |
|-----|--------|---------|
| `HEALTH_MONITOR_TARGETS` | JSON array de servicios (label/url/tier/mode/degradedPath/healthyField/logsUrl) | ver `.env.example` |
| `ONCALL_MENTION` | mention Discord para push de P0 (`<@id>` / `<@&roleId>`) | vacío = sin push |
| `HEALTH_MONITOR_TIMEOUT_MS` | timeout por chequeo (ms), cap duro 5000 (CD-6) | 5000 |
| `MCP_ALERT_WEBHOOK_URL` | webhook Discord/Slack compartido con las demás alertas | — |
| `CRON_SECRET` | Bearer que autentica el cron | — |

## Registro del cron

El job `wasiai-x402-health-check` se registra con `npm run setup:cronjob`
(`scripts/setup-cronjob.mjs`), cadencia ~4 min, autenticado con `CRON_SECRET`
(Bearer), idempotente por título. El script solo toca los jobs propios
(`wasiai-x402-*`); jobs de otros proyectos en la misma cuenta cron-job.org
quedan intactos.
