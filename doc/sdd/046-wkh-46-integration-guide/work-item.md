# Work Item — [WKH-46] Marketplace Integration Guide — Auth + CORS Policy for 3rd-Party Consumers

## Resumen

Crear `doc/INTEGRATION.md` como guía de integración B2B para marketplaces y agentes de terceros que quieran consumir WasiAI A2A Protocol en producción. El doc cubre los dos patrones de integración (server-to-server y browser-direct), el flujo de onboarding con auth, la tabla de endpoints públicos vs protegidos, el flujo de pago x402, códigos de error con estrategias de retry, y un ejemplo end-to-end copy-pasteable. Actualizar `README.md` para linkear al nuevo archivo. No toca `src/`.

## Sizing

- **SDD_MODE**: mini
- **Flow**: FAST
- **Justificación FAST**: docs-only, sin cambios en `src/`, sin modificaciones a auth/payment/RLS/DB. Riesgo bajo. El ticket está completamente especificado con 6 secciones, estructura y mensajes de negocio definidos. No hay ambigüedad técnica que requiera SDD completo ni Adversarial Review.
- **Estimación**: S (1 archivo nuevo ~300-400 líneas Markdown + 3-5 líneas en README.md)
- **Branch sugerido**: `feat/046-wkh-46-integration-guide`

## Acceptance Criteria (EARS)

- **AC-1**: WHEN a developer reads `doc/INTEGRATION.md`, the system SHALL present two clearly labeled integration patterns: "Server-to-server (default)" and "Browser-direct (SPA)", each with its authentication method and CORS implications.

- **AC-2**: WHEN a developer follows the onboarding section, the system SHALL describe the complete sequence: `POST /auth/agent-signup` → receive `wasi_a2a_*` key → optional `POST /registries` → consume `/discover`, `/compose`, `/orchestrate`, and MCP tools.

- **AC-3**: WHEN a developer reads the endpoints section, the system SHALL list all public endpoints (GET `/registries`, GET `/registries/:id`, `/.well-known/agent.json`, `/health`, GET `/discover`, GET `/agents/:id/agent-card`) and all protected endpoints (POST/PATCH/DELETE `/registries`, POST `/compose`, POST `/orchestrate`, `/a2a` JSON-RPC) in a single scannable reference table.

- **AC-4**: WHEN a developer reads the x402 payment flow section, the system SHALL explain the 402 response/retry cycle for `POST /orchestrate` and SHALL include a reference link to `scripts/demo-x402.ts`.

- **AC-5**: WHEN a developer encounters an HTTP error (401, 402, or 403) from the API, the system SHALL provide in `doc/INTEGRATION.md` the exact meaning of each code in this context and a concrete retry strategy for each.

- **AC-6**: WHEN a developer reads the end-to-end example section, the system SHALL provide at minimum one `curl` snippet and one `fetch` JS snippet, both executable as-is against `https://wasiai-a2a-production.up.railway.app` (no placeholder secrets beyond the auth key variable).

- **AC-7**: WHILE the server-to-server pattern is the documented default, the system SHALL explicitly state that CORS configuration is NOT required for server-to-server integrations and that `CORS_ALLOWED_ORIGINS` is only relevant for browser-direct (SPA) consumers, reinforcing the B2B positioning message.

- **AC-8**: WHEN `README.md` is read, the system SHALL contain a link to `doc/INTEGRATION.md` in a visible section (e.g., "Integration" or "For Marketplace Developers").

## Scope IN

- `doc/INTEGRATION.md` — archivo nuevo, creado desde cero
- `README.md` — agregar link a `doc/INTEGRATION.md` (modificación mínima, 3-5 líneas)

## Scope OUT

- `src/` — ningún archivo de código fuente
- Supabase migrations / RLS policies
- `.env` / `.env.example` — no modificar
- Cambios en lógica de auth o CORS en runtime
- `doc/sdd/` (excepto este work-item)
- Cualquier otro archivo fuera de `doc/INTEGRATION.md` y `README.md`

## Decisiones técnicas

- **DT-1**: El documento se escribe en Markdown GFM (GitHub Flavored Markdown) para compatibilidad con GitHub, GitLab y cualquier renderer de docs.
- **DT-2**: Todos los snippets de código (curl, JS fetch) deben ser ejecutables copy-paste contra `https://wasiai-a2a-production.up.railway.app`. No se incluyen URLs internas ni de staging.
- **DT-3**: El patrón server-to-server se posiciona como el default y se documenta primero. El patrón browser-direct se presenta como caso especial que requiere acción adicional (agregar origin a `CORS_ALLOWED_ORIGINS`).
- **DT-4**: La sección de errores usa una tabla con columnas: código HTTP | significado en este contexto | acción recomendada. Formato escaneable.
- **DT-5**: El documento asume audiencia técnica LATAM/global — lenguaje en inglés (consistente con el resto del proyecto) pero con terminología clara y sin jerga innecesaria.

## Constraint Directives

- **CD-1**: PROHIBIDO modificar cualquier archivo bajo `src/`. Este work-item es docs-only.
- **CD-2**: OBLIGATORIO que todos los snippets curl/fetch sean copy-paste funcionales. Prohibido usar `<YOUR_KEY_HERE>` sin contexto — usar variables de shell nombradas (`A2A_KEY`, etc.) con instrucción de cómo obtenerlas.
- **CD-3**: PROHIBIDO mencionar URLs internas, IPs de Railway, secrets reales, o cualquier valor sensible de las env vars de producción.
- **CD-4**: OBLIGATORIO comunicar en la sección de CORS el mensaje de negocio B2B: "el 99% de integraciones NO requieren tocar CORS". Este posicionamiento debe ser claro y aparecer antes de la descripción del patrón browser-direct.
- **CD-5**: PROHIBIDO documentar endpoints o comportamientos que no existan en producción a la fecha del ticket (2026-04-20). Si hay duda, marcar `[PENDING]`.

## Missing Inputs

- Ninguno. El ticket está completamente especificado. No hay bloqueantes.

## Análisis de paralelismo

- Esta HU es docs-only y no bloquea ninguna HU de código activa.
- Puede ejecutarse en paralelo con WKH-025, WKH-026, WKH-028, WKH-029, WKH-030, WKH-031, WKH-032, WKH-033, WKH-034, WKH-035, WKH-036, WKH-037 (todos en estado "in progress" según `_INDEX.md`).
- WKH-028 (README rewrite) toca `README.md`. Si está en progreso activo en la misma branch, Dev debe coordinar para no generar conflicto en `README.md`. Recomendación: Dev de esta HU aplica el cambio en README al final del wave, revisando el estado de WKH-028 antes del merge.
- **Wave único** (docs-only, sin dependencias de código): una sola wave de implementación.
  - Wave 1: crear `doc/INTEGRATION.md` con las 6 secciones + actualizar `README.md` con el link.
