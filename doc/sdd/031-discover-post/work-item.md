# Work Item — [WKH-DISCOVER-POST] POST /discover Alias

## Resumen

Add POST /discover as an alias for the existing GET /discover endpoint. External agents, docs, system prompts, and project-context.md all reference `POST /discover`, but the route currently only accepts GET, causing 404s for A2A-compliant callers that use POST. Fix the route and align documentation.

## Sizing

- SDD_MODE: bugfix
- Estimacion: S
- Branch sugerido: feat/031-discover-post
- Clasificacion: FAST (<20 lines, no DB, no auth, no new dependencies)

## Skills

- backend-fastify
- api-design

## Acceptance Criteria (EARS)

- AC-1: WHEN a client sends `POST /discover` with JSON body containing any combination of `capabilities`, `q`, `maxPrice`, `minReputation`, `limit`, `registry`, the system SHALL return the same response as the equivalent `GET /discover` with those values as query params.
- AC-2: WHEN a client sends `GET /discover` with query params, the system SHALL continue to work exactly as before (no regression).
- AC-3: WHEN a client sends `POST /discover` with an empty body or no body, the system SHALL return all discoverable agents (same as `GET /discover` with no params).

## Scope IN

- `src/routes/discover.ts` — add POST handler that reads params from `request.body`, delegates to same `discoveryService.discover()` logic
- `src/index.ts` — update the console banner line 91 from `GET  /discover` to `GET|POST /discover`
- `README.md` — update the endpoint table (line 138) to show `GET \| POST` for `/discover`

## Scope OUT

- `.well-known/agent.json` — does not exist in this repo, nothing to audit
- `project-context.md` — already documents `POST /discover` (line 28), no change needed
- POST /discover/:slug — not requested, out of scope
- Any new tests beyond basic POST smoke test
- Schema validation on POST body (keep it simple, same as GET has no validation)

## Decisiones tecnicas (DT-N)

- DT-1: POST handler reads from `request.body` (JSON), GET handler reads from `request.query`. Both call the same `discoveryService.discover()`. No shared handler extraction needed for <20 lines.
- DT-2: POST body field names match GET query param names exactly: `capabilities` (string, comma-separated or array), `q`, `maxPrice`, `minReputation`, `limit`, `registry`.
- DT-3: For POST, `capabilities` can be either a comma-separated string OR a string array — normalize both to array before calling service.

## Constraint Directives (CD-N)

- CD-1: PROHIBIDO cambiar el comportamiento de GET /discover
- CD-2: PROHIBIDO agregar dependencias nuevas
- CD-3: OBLIGATORIO mantener `{ config: { rateLimit: false } }` en el POST handler igual que en GET

## Missing Inputs

- Ninguno. Requisitos completos.

## Analisis de paralelismo

- No bloquea ni es bloqueada por otras HUs.
- Puede ir en paralelo con WKH-028 (README rewrite) — si 028 merges first, la linea de README a editar puede cambiar, pero el conflicto es trivial.
