# Work Item — [WKH-AUDIT-A2A] Remediación Auditoría Profesional — Hardening + Hygiene

## Resumen

Cierra 5 hallazgos de la auditoría staff-level (2026-05-29, calificación A−) que impiden alcanzar A+.
Los hallazgos son: dashboard admin fail-open en prod, `.env.example` incompleto + naming drift entre
code y docs, `/discover` sin rate-limit frente a fanout externo, mock-registry montado en prod, y
2 diffs de formato Biome + 2 TODOs. No hay Critical/High; todos son Medium/Low. Scope acotado —
sin Redis distribuido ni RLS Postgres (diferidos como TD).

---

## Sizing

- **SDD_MODE:** full
- **Estimación:** M
- **QUALITY tier:** QUALITY (toca auth dashboard + config de seguridad en producción)
- **Branch sugerido:** `feat/097-wkh-audit-a2a-hardening`

---

## Skills Router

- `security-hardening` — fail-closed auth, env-guard de rutas de dev
- `code-hygiene` — formato biome, doc/env drift, TODOs

---

## Verificación de hallazgos en código real

### H1 — Dashboard fail-open
`src/routes/dashboard.ts:31`

```ts
const requireAdminToken: preHandlerAsyncHookHandler = async (request, reply) => {
  const expected = process.env.DASHBOARD_ADMIN_TOKEN;
  if (!expected) return; // not configured → allow (dev mode)
```

Confirmado exactamente en línea 31. Si `DASHBOARD_ADMIN_TOKEN` no está seteado en `NODE_ENV=production`,
`/dashboard/api/stats` y `/dashboard/api/events` responden 200 a cualquier request. FAIL-OPEN confirmado.

### H2 — `.env.example` incompleto + naming drift
- `.env.example` tiene `SUPABASE_SERVICE_KEY=your-service-role-key-here` (línea 74).
- `src/lib/supabase.ts:12` lee `process.env.SUPABASE_SERVICE_KEY` — correcto.
- `CLAUDE.md` (project-context y CLAUDE.md del root) menciona `SUPABASE_SERVICE_ROLE_KEY` en la tabla
  de Variables de entorno requeridas (`.nexus/project-context.md:259`) y en el bloque de Security
  Conventions (`CLAUDE.md:patrón OK`).
- Drift real: **CLAUDE.md + project-context hablan de `SUPABASE_SERVICE_ROLE_KEY`; el código y `.env.example`
  usan `SUPABASE_SERVICE_KEY`**. La fuente de verdad es el código; hay que alinear la doc.
- Vars ausentes en `.env.example`: `DASHBOARD_ADMIN_TOKEN`, `DISCOVERY_REGISTRY_TIMEOUT_MS`.
  `AVALANCHE_NETWORK` no existe en el código actual — no se agrega (regla: no inventar).

### H3 — `/discover` sin rate-limit
`src/routes/discover.ts:22` (GET) y línea 64 (POST): ambas rutas tienen `config: { rateLimit: false }`.
Confirmado. El service hace fanout a N registries externos por request → vector de amplificación.

### H4 — mock-registry sin guard de entorno
`src/index.ts:108`:
```ts
await fastify.register(mockRegistryRoutes, { prefix: '/mock-registry/agents' });
```
Montado incondicionalmente. `src/routes/mock-registry.ts` no tiene guard de `NODE_ENV`.
El hallazgo es correcto — en producción el endpoint de datos hardcodeados está siempre expuesto.

### H5 — Biome format diffs + TODOs
- `src/lib/bazaar.ts:88-97`: la función `compileOrCollectErrors` tiene la llave de apertura `{` en
  línea 90 (indentación con espacio extra antes de `)`). Biome detecta formato inconsistente.
- `src/types/index.ts:214`: no se detecta violación visible en el rango leído (205-234), pero la
  auditoría lo marca. Se resuelve con `npm run format` y se acepta su veredicto.
- TODOs: se buscan mediante `format` + revisión manual en F3. Si no son triviales, se marcan
  `[NEEDS CLARIFICATION]` en AR.

---

## Acceptance Criteria (EARS)

### AC-1 — Dashboard fail-closed en producción
WHEN `requireAdminToken` is invoked AND `DASHBOARD_ADMIN_TOKEN` is not set AND `NODE_ENV === 'production'`,
the system SHALL return HTTP 503 with body `{ error: 'service_unavailable', message: 'Dashboard API not configured' }`.

### AC-2 — Dashboard sigue abierto en desarrollo
WHILE `NODE_ENV` is not `'production'` AND `DASHBOARD_ADMIN_TOKEN` is unset,
the system SHALL allow requests to `/dashboard/api/stats` and `/dashboard/api/events` without an admin token (dev mode preserved).

### AC-3 — `.env.example` completo
WHEN a developer copies `.env.example` to `.env`, the system SHALL include documented entries for
`DASHBOARD_ADMIN_TOKEN`, `DISCOVERY_REGISTRY_TIMEOUT_MS`, and `SUPABASE_SERVICE_KEY`
(with inline comment explaining the naming differs from legacy docs).

### AC-4 — Naming drift corregido en docs
WHEN a developer reads `CLAUDE.md` or `.nexus/project-context.md`,
the system SHALL reference `SUPABASE_SERVICE_KEY` (the actual runtime variable) rather than `SUPABASE_SERVICE_ROLE_KEY`.

### AC-5 — Rate limit en `/discover`
WHEN a caller sends more than `RATE_LIMIT_MAX` requests to `GET /discover` or `POST /discover`
within `RATE_LIMIT_WINDOW_MS`, the system SHALL respond HTTP 429 with `{ error: 'RATE_LIMIT_EXCEEDED' }`.

### AC-6 — mock-registry gateado por entorno
WHILE `NODE_ENV === 'production'`, the system SHALL NOT mount the `/mock-registry/agents` route
(any request to that path SHALL return HTTP 404).

### AC-7 — Biome format + TODOs
WHEN `npm run format` and `npm run lint` are executed after the changes,
the system SHALL report zero format violations and zero lint errors in the modified files
(`src/lib/bazaar.ts`, `src/types/index.ts`, and any file touched by this HU).

---

## Scope IN

| Artefacto | Cambio |
|-----------|--------|
| `src/routes/dashboard.ts` | `requireAdminToken`: añadir rama `NODE_ENV === 'production'` → 503 |
| `src/index.ts` | Condicionar `register(mockRegistryRoutes)` a `NODE_ENV !== 'production'` |
| `src/routes/discover.ts` | Quitar `rateLimit: false` de GET y POST `/discover`; aplicar límite global o valor moderado |
| `.env.example` | Agregar `DASHBOARD_ADMIN_TOKEN` y `DISCOVERY_REGISTRY_TIMEOUT_MS` con comentarios |
| `CLAUDE.md` | Corregir `SUPABASE_SERVICE_ROLE_KEY` → `SUPABASE_SERVICE_KEY` en tabla de vars |
| `.nexus/project-context.md` | Corregir misma referencia en sección "Variables de entorno requeridas" |
| `src/lib/bazaar.ts` | `npm run format` — resolver diff de formato |
| `src/types/index.ts` | `npm run format` — resolver diff de formato |
| Archivos con TODOs (detectados en F3) | Resolver o eliminar TODOs triviales; escalar al humano los no-triviales |

---

## Scope OUT

- **Redis distribuido** para rate-limit / circuit-breaker stateful (scale-readiness) — TD trackeado, no en esta HU.
- **Postgres RLS** en `a2a_agent_keys` (WKH-SEC-02 / TD-SEC-01) — migración prod diferida.
- Cambios en lógica de negocio de `/discover` (algoritmo, SSRF, etc.) — solo rate-limit config.
- Nuevas variables de entorno no mencionadas explícitamente en el scope.
- Tests de integración contra Railway prod (solo tests unitarios/vitest en F4).

---

## Decisiones técnicas (DT-N)

- **DT-1:** El fix de `requireAdminToken` usa el patrón `NODE_ENV === 'production'` (string literal), consistente con el código existente en `src/index.ts:36` (`const isProduction = process.env.NODE_ENV === 'production'`). No se introduce una nueva constante para evitar over-engineering.
- **DT-2:** Para AC-5 (`/discover` rate-limit), se elimina `rateLimit: false` y se deja caer al límite global configurado vía `RATE_LIMIT_MAX` (default 60/min). No se introduce un tier propio para `/discover` — es un endpoint de lectura; el global es suficiente para esta remediación. Si en el futuro se necesita un tier diferenciado, se trackea como TD.
- **DT-3:** El status 503 para dashboard fail-closed (AC-1) comunica "no configurado" sin revelar si el token existe o no. Se eligió sobre 401 para distinguir semánticamente "token incorrecto" (401) de "servicio no habilitado en este entorno" (503).
- **DT-4:** `DISCOVERY_REGISTRY_TIMEOUT_MS` se agrega a `.env.example` como variable documentada aunque el código actual no la consuma (se detectó en la auditoría como variable que falta en la documentación del ejemplo). Si el código no la lee, el comentario lo aclara y se marca `[TBD implementación]`.

---

## Constraint Directives (CD-N)

- **CD-1:** PROHIBIDO cambiar el comportamiento dev-local. Sin `DASHBOARD_ADMIN_TOKEN` Y con `NODE_ENV` distinto de `'production'` (incluyendo ausente/undefined), el dashboard API DEBE seguir abierto sin token. Solo el `NODE_ENV === 'production'` activa el fail-closed.
- **CD-2:** PROHIBIDO remover el `rateLimit: false` de GET `/dashboard` (la página HTML, no la API). Solo las rutas `/dashboard/api/stats` y `/dashboard/api/events` tienen el `requireAdminToken`; la página HTML es pública por diseño.
- **CD-3:** OBLIGATORIO: el guard de `mock-registry` en `src/index.ts` DEBE usar la misma variable `isProduction` o la misma expresión `process.env.NODE_ENV === 'production'` que ya existe en el archivo. No hardcodear el string `'production'` de nuevo sin reusar la constante existente.
- **CD-4:** PROHIBIDO tocar `src/lib/supabase.ts` — el nombre de la variable de entorno `SUPABASE_SERVICE_KEY` es correcto en código. Solo se corrige la documentación.

---

## Missing Inputs

- `DISCOVERY_REGISTRY_TIMEOUT_MS`: la auditoría lo menciona como variable faltante en `.env.example`, pero en el código actual no se encontró su consumo. **[NEEDS CLARIFICATION]** — en F3: buscar `DISCOVERY_REGISTRY_TIMEOUT_MS` en todo el codebase; si no existe, documentarlo como "reservado para futura implementación" en el comment de `.env.example`.
- TODOs: su contenido exacto no fue leído en F1 (requiere `grep`). Se resuelven en F3 anti-hallucination pass.

---

## Test Plan (mínimo 1 test por AC)

| AC | Test | Tipo |
|----|------|------|
| AC-1 | `requireAdminToken` con `NODE_ENV=production` y token ausente → espera reply.status(503) | vitest unitario |
| AC-2 | `requireAdminToken` con `NODE_ENV=development` y token ausente → espera passthrough (no reply) | vitest unitario |
| AC-3 | Verificar que `.env.example` contiene las 3 líneas (`grep` en test o snapshot) | snapshot / script |
| AC-4 | `grep -rn SUPABASE_SERVICE_ROLE_KEY CLAUDE.md .nexus/project-context.md` devuelve 0 matches | script en CI o test de integración doc |
| AC-5 | Inyectar 61 requests en ventana de 60s contra `GET /discover` → respuesta 61 es 429 | vitest con fastify inject |
| AC-6 | Con `NODE_ENV=production`, `fastify.inject({ method: 'GET', url: '/mock-registry/agents' })` → 404 | vitest con fastify inject |
| AC-7 | `npm run format && npm run lint` sin errores (evidencia en AR: salida de terminal) | CI / evidencia AR |

---

## Análisis de paralelismo

- Esta HU no bloquea ninguna otra HU activa conocida.
- El fix de `src/index.ts` (H4) y el fix de `src/routes/dashboard.ts` (H1) son independientes entre sí — se pueden trabajar en waves separadas.
- El fix de `.env.example` y docs (H2) es puramente cosmético y puede ir en la misma wave que Biome (H5).
- No existe conflicto con WKH-35 (depositado, no desplegado) ni con las HUs 093-095 (done).
- Puede correr en paralelo con documentación y tareas no-src si las hubiera.
