# Work Item — [WKH-HEALTH] GET /health endpoint

## Resumen

Add a dedicated `GET /health` endpoint returning status, version, uptime, and timestamp. Currently `GET /` serves as the health check, but monitoring systems, load balancers, and intelligent agents expect the standard `/health` path (currently returns 404).

## Sizing

- SDD_MODE: mini (FAST)
- Estimation: S (1 file, <15 lines)
- Branch: main (direct commit, patch-level)

## Acceptance Criteria (EARS)

- AC-1: WHEN a client sends `GET /health`, the system SHALL respond with HTTP 200 and a JSON body containing `{ status: "ok", version: "0.1.0", uptime: <number>, timestamp: <ISO-8601 string> }`.
- AC-2: WHILE the server is running, the system SHALL return `uptime` as `process.uptime()` (seconds since process start) and `timestamp` as `new Date().toISOString()`.
- AC-3: WHEN a client sends `GET /health`, the system SHALL bypass rate limiting (same pattern as the existing `GET /` route: `config: { rateLimit: false }`).

## Scope IN

- `src/index.ts` -- add `fastify.get('/health', ...)` route inline, same pattern as existing `GET /`

## Scope OUT

- No changes to `GET /` (keep existing root route as-is)
- No new files, no new modules
- No DB, no auth, no external calls
- No tests (FAST mode, trivial route)

## Decisiones tecnicas (DT-N)

- DT-1: Route registered inline in `src/index.ts` (not in `src/routes/`) because this is a zero-dependency health probe, same pattern as `GET /`.
- DT-2: `version` hardcoded as `"0.1.0"` to match existing `GET /` response. Reading from `package.json` is out of scope for this patch.

## Constraint Directives (CD-N)

- CD-1: OBLIGATORIO usar `config: { rateLimit: false }` para que health checks de load balancers no consuman rate limit budget.
- CD-2: PROHIBIDO tocar la ruta `GET /` existente.

## Missing Inputs

- Ninguno. HU completamente especificada.

## Analisis de paralelismo

- No bloquea ni es bloqueada por ninguna otra HU.
- Puede ejecutarse en paralelo con cualquier WKH en curso.
