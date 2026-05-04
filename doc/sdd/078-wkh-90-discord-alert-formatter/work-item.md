# Work Item — [WKH-90] Discord-aware payload formatting in alerts.mjs

## Resumen

`sendAlert()` en `mcp-servers/wasiai-x402/src/alerts.mjs` envía el cuerpo sanitizado como JSON crudo sin adaptarlo a la plataforma destino. Discord exige el shape `{username, embeds[]}` y responde HTTP 400 a cualquier otro body, por lo que los alertas de producción del cron WKH-75 (bearer rotation + balance check) fallan silenciosamente. Esta HU agrega detección automática del host de la URL y reformateo del payload para Discord, manteniendo backward-compat para cualquier otro webhook.

---

## Sizing

- **Pipeline**: FAST+AR
- **SDD_MODE**: mini (no SDD formal — AR automático post-implementación)
- **Estimación**: S (~30 LOC producción + ~80 LOC tests)
- **Branch sugerido**: `feat/078-wkh-90-discord-alert-formatter` desde `main` (`6847e27`)
- **Jira**: https://ferrosasfp.atlassian.net/browse/WKH-90

---

## Skills Router

1. **webhook-integration** — detección de plataforma, reshaping de payload, contratos de Discord Webhook API
2. **test-coverage** — tests unitarios con mock fetch, cobertura por severidad, baseline regression

---

## Acceptance Criteria (EARS)

**AC-1** — Detección de host Discord
WHEN `sendAlert()` is called with a `webhookUrl` whose parsed host is `discord.com` or `discordapp.com`, the system SHALL POST a Discord-compatible payload with top-level keys `username` (fixed value `"wasiai-alerts"`) and `embeds` (array of exactly one embed object).

**AC-2** — Color por severidad
WHEN building the Discord embed, the system SHALL map severity to embed `color` as follows: `critical` → `15158332` (0xE74C3C red), `warning` → `15844367` (0xF1C40F yellow), `info` → `3066993` (0x2ECC71 green). Any unrecognised severity SHALL default to `3066993`.

**AC-3** — Backward compat para hosts no-Discord
WHEN `sendAlert()` is called with a `webhookUrl` whose host is NOT `discord.com` or `discordapp.com`, the system SHALL POST the sanitized body unchanged (existing raw-JSON behavior), preserving compatibility with Slack incoming webhooks and any future webhook consumer.

**AC-4** — Manejo de errores HTTP Discord sin throw
IF the Discord webhook returns HTTP status 400 or 429, THEN the system SHALL return `{ sent: false, status: <N>, reason: "webhook status <N>" }` and SHALL NOT throw, in accordance with CD-12.

**AC-5** — Cobertura de tests por severidad
WHEN the tests in `tests/alerts.test.mjs` run, the system SHALL assert the exact JSON body sent to a mocked Discord fetch for each of the three severity values (`critical`, `warning`, `info`), verifying `username`, `embeds[0].title`, `embeds[0].color`, `embeds[0].description`, and the presence of `embeds[0].fields` derived from the sanitized body.

**AC-6** — No regresión en baseline
WHEN `npm test` runs after this change, the system SHALL pass all 232 pre-existing baseline tests without modification.

**AC-7** — Documentación Operations
WHEN the README.md `## Operations` section is read, the system SHALL document the auto-detection mechanism (host matching), the list of currently-supported platforms (`discord.com`, `discordapp.com` → Discord-shaped; all others → raw JSON), and the Discord embed fields structure.

---

## Scope IN

| Archivo | Cambio |
|---------|--------|
| `mcp-servers/wasiai-x402/src/alerts.mjs` | Agregar función `formatForDiscord()` (o inline) + detección de host en `sendAlert()` |
| `mcp-servers/wasiai-x402/tests/alerts.test.mjs` | Agregar 3 tests nuevos T-AL-DISC-01/02/03 (uno por severidad) + T-AL-DISC-04 (HTTP 400 no-throw) |
| `mcp-servers/wasiai-x402/README.md` | Documentar en sección `## Operations` sub-sección "Alert webhook platforms" |

## Scope OUT

- `src/bearer-rotation.mjs` — no se toca; es el caller y su contrato con `sendAlert()` no cambia
- Contrato público de `sendAlert({ severity, body, webhookUrl, timeoutMs })` — la firma queda idéntica
- Soporte Slack o Telegram — esos usan el path raw-JSON (backward compat, AC-3). No se agrega lógica extra para ellos
- Soporte Datadog, PagerDuty u otros — out of scope; se benefician automáticamente del raw-JSON path
- ESM → CJS migration — no aplica; el módulo sigue siendo `.mjs` puro
- `src/log.mjs` — no cambia
- Cualquier archivo bajo `src/` que no sea `alerts.mjs`

---

## Decisiones técnicas

**DT-1 — Detección por host de URL, no por nombre de variable de entorno**
La detección se hace parseando `new URL(webhookUrl).host` en tiempo de llamada, no comparando nombres de env vars. Razón: `MCP_ALERT_WEBHOOK_URL` puede apuntar a cualquier plataforma; la intención del operador se deduce del host real. La función falla-safe si la URL es inválida (try/catch → raw path o error ya gestionado por el guard de `!webhookUrl`).

**DT-2 — Hosts aceptados: `discord.com` y `discordapp.com`**
Discord usa ambos dominios. `hooks.discord.com` resuelve bajo `discord.com` pero la URL de webhook estándar es `https://discord.com/api/webhooks/...`. Se validan exactamente los dos hosts. No se usa startsWith ni regex para evitar bypasses de subdomain spoofing (ej. `evildiscord.com`).

**DT-3 — Embed fields a partir de las keys del body sanitizado**
Las keys del body pasado por `sanitizeAlertBody()` se convierten en `embeds[0].fields[]` con `{"name": key, "value": String(val), "inline": true}`. Se excluyen `severity` (va al color) y, si el body trae `event`, ese string va como `title` del embed (formato: `[<severity>] <event>`); si no hay `event`, el título es `[<severity>]`. El campo `reason`, si existe, va como `description`. `rotatedAt` o `checkedAt`, si existen, van como `timestamp` del embed (ISO-8601). El resto de keys whitelisted van como fields.

**DT-4 — Color default para severidad desconocida**
Si `severity` no está en el map, se usa el color de `info` (`3066993`). No se lanza error.

**DT-5 — `username` fijo `"wasiai-alerts"`**
No configurable por env var en esta HU. Si se necesita personalización futura, es scope de otra HU.

---

## Constraint Directives (CD-N)

Heredados de WKH-75 (mantener en implementation):

- **CD-9**: PROHIBIDO loguear el webhook URL, el bearer token, o cualquier parte del Authorization header en ninguna rama de `sendAlert()` ni en `formatForDiscord()`.
- **CD-12**: PROHIBIDO que `sendAlert()` lance una excepción en cualquier código path, incluidas las ramas Discord. Todo error debe retornar `{ sent: false, reason, [status] }`.
- **CD-18**: OBLIGATORIO mantener `redirect: 'error'` en el fetch de Discord, igual que el path actual.

Nuevos para esta HU:

- **CD-WKH90-1**: PROHIBIDO agregar keys al whitelist `ALLOWED_BODY_KEYS` como parte de esta HU. El whitelist ya está correcto (WKH-66 + WKH-75). Si el Discord formatter necesita data extra, la extrae del body ya sanitizado.
- **CD-WKH90-2**: OBLIGATORIO que la detección de host falle-safe: si `new URL(webhookUrl)` lanza (URL malformada), `sendAlert()` DEBE caer al path raw-JSON, no throw, y el error de URL debe ser absorbido silenciosamente o logueado sin la URL (CD-9).
- **CD-WKH90-3**: PROHIBIDO hardcodear el `username` de Discord como una variable de entorno leída en esta HU. Valor fijo `"wasiai-alerts"` en código.
- **CD-WKH90-4**: OBLIGATORIO que todos los nuevos tests de Discord usen mock de `globalThis.fetch` consistente con el patrón existente en `tests/alerts.test.mjs` (sin dependencias externas, sin HTTP real).

---

## Missing Inputs

- Ninguno bloqueante. El comportamiento esperado de Discord, la detección de host, el color mapping y la estructura del embed están completamente especificados en la HU.
- [RESUELTO en contexto] El baseline de tests es 232 tests (dato provisto por el smoke test del ticket).

---

## Análisis de paralelismo

- No aplica: scope chico, 1 archivo de producción, 1 test file, 1 README. No bloquea ni es bloqueado por ningún WKH en progreso actualmente.
- Esta HU es follow-up de WKH-75 (DONE) y WKH-77 (DONE). No hay dependencias activas en progreso.
