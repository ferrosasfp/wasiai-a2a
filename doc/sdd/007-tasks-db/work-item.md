# SDD-007 — Tasks DB (WKH-23)

> **HU:** WKH-23 — Tasks DB
> **Tipo:** feature
> **Mode:** QUALITY
> **Branch:** `feat/wkh-23-tasks-db`
> **Fecha:** 2026-04-03

---

## 1. Work Item normalizado

### Descripción
Crear tabla `tasks` en Supabase PostgreSQL con estados del Google A2A Protocol, trigger automático para `updated_at`, y exponer endpoints CRUD REST para gestión de tasks con guard de estados terminales.

### Acceptance Criteria (EARS)

**AC-1 — Migración DB**
WHEN the migration `YYYYMMDDHHMMSS_tasks.sql` is applied,
THEN a table `tasks` SHALL exist with columns: `id` (UUID PK, gen_random_uuid), `context_id` (TEXT nullable), `status` (TEXT NOT NULL DEFAULT 'submitted', CHECK in submitted|working|completed|failed|canceled|input-required), `messages` (JSONB DEFAULT '[]'), `artifacts` (JSONB DEFAULT '[]'), `metadata` (JSONB nullable), `created_at` (TIMESTAMPTZ DEFAULT NOW()), `updated_at` (TIMESTAMPTZ DEFAULT NOW()),
AND an index on `status` SHALL exist,
AND an index on `context_id` SHALL exist WHERE `context_id IS NOT NULL`,
AND a trigger `set_updated_at` SHALL exist that automatically sets `updated_at = NOW()` BEFORE UPDATE on each row using `trigger_set_updated_at()` function.

**AC-2 — POST /tasks**
WHEN a client sends POST /tasks with a valid body containing optional `context_id`, `messages`, `artifacts`, `metadata`,
THEN the system SHALL create a new task with status `submitted` and return 201 with the full task object,
AND WHEN required fields are malformed THEN the system SHALL return 400.

**AC-3 — GET /tasks/:id**
WHEN a client sends GET /tasks/:id with a valid UUID,
THEN the system SHALL return the task object with 200,
AND WHEN the id does not exist THEN the system SHALL return 404.

**AC-4 — GET /tasks (list with filters)**
WHEN a client sends GET /tasks,
THEN the system SHALL return an array of tasks ordered by `created_at` DESC,
AND WHEN query param `status` is provided THEN only tasks matching that status SHALL be returned,
AND WHEN query param `context_id` is provided THEN only tasks matching that context SHALL be returned,
AND WHEN query param `limit` is provided THEN at most that many tasks SHALL be returned (default 50, max 100).

**AC-5 — PATCH /tasks/:id/status (con guard de estados terminales)**
WHEN a client sends PATCH /tasks/:id/status with body `{ "status": <valid TaskState> }`,
THEN the system SHALL update the task status, returning 200 with the updated task,
AND WHEN the target status is invalid THEN the system SHALL return 400,
AND WHEN the task does not exist THEN the system SHALL return 404,
AND WHEN the task is in a terminal state (`completed`, `failed`, `canceled`) AND any status change is attempted, THEN the system SHALL return 409 Conflict with message "Task in terminal state cannot be updated".

**AC-6 — PATCH /tasks/:id (append messages y artifacts)**
WHEN a client sends PATCH /tasks/:id with body containing `messages` array,
THEN the new messages SHALL be APPENDED to the existing `messages` JSONB array (not replaced),
AND WHEN body contains `artifacts` array, THEN the new artifacts SHALL be APPENDED to the existing `artifacts` JSONB array,
AND WHEN both `messages` and `artifacts` are provided, THEN both SHALL be appended atomically,
AND WHEN the task is in a terminal state (`completed`, `failed`, `canceled`), THEN the system SHALL return 409 Conflict,
AND WHEN the task does not exist THEN the system SHALL return 404.

---

## 2. Scope

### IN
- Migración SQL para `tasks` con CHECK constraint en status y trigger `set_updated_at`
- `src/services/task.ts` — CRUD service (patrón idéntico a `registry.ts`)
- `src/routes/tasks.ts` — Fastify route plugin con 5 endpoints
- `src/types/index.ts` — tipos `Task`, `TaskState`, `TaskRow`, `TERMINAL_STATES`
- Registro de ruta en `src/index.ts`
- Índices en `status` y `context_id`
- Guard de estados terminales en service layer
- Tests unitarios: `src/services/task.test.ts`
- Tests de integración: `src/routes/tasks.test.ts`

### OUT
- Streaming SSE / push notifications
- State machine completa de transiciones (solo terminales son inmutables)
- JSON-RPC endpoints (`task/get`, `task/cancel`) — separado
- Autenticación / autorización en endpoints

---

## 3. Smart Sizing

| Dimensión | Valor | Justificación |
|-----------|-------|---------------|
| **Archivos nuevos** | 5 | migration, service, route, 2 test files |
| **Archivos modificados** | 2 | types/index.ts, index.ts |
| **Complejidad** | Baja-Media | CRUD + terminal guard + append logic + tests |
| **Riesgo** | Bajo | Sin dependencias externas nuevas |
| **Estimación** | S-M (~3h) | Patrón copiable pero +AC-5 guard +AC-6 append +tests |

---

## 4. Definition of Ready (DoR)

- [x] ACs en formato EARS
- [x] Scope IN/OUT definido
- [x] Branch name definido: `feat/wkh-23-tasks-db`
- [x] Patrones existentes identificados (registry service/route/migration)
- [x] Sin dependencias bloqueantes
- [x] Tipos A2A Task definidos en project-context

---

## 5. Dependencias

| Tipo | Qué | Estado |
|------|-----|--------|
| Requiere | Supabase client (`src/lib/supabase.ts`) | ✅ Existe |
| Requiere | Fastify setup (`src/index.ts`) | ✅ Existe |
| Bloqueado por | Nada | — |

---

## 6. Waves (implementación sugerida)

### Wave 1 — DB + Types
1. Agregar tipos `TaskState`, `Task`, `TaskRow`, `TERMINAL_STATES` en `src/types/index.ts`
2. Crear migración SQL `supabase/migrations/YYYYMMDDHHMMSS_tasks.sql` (tabla + índices + trigger `set_updated_at`)
3. Aplicar migración

### Wave 2 — Service + Routes
1. Crear `src/services/task.ts` (patrón registry.ts) con:
   - CRUD básico
   - Guard de estados terminales (`TERMINAL_STATES` check antes de update)
   - Lógica de append para messages/artifacts (JSONB `||` o concat)
2. Crear `src/routes/tasks.ts` (patrón registries.ts) con 5 endpoints
3. Registrar ruta en `src/index.ts`
4. Smoke test manual

### Wave 3 — Tests
1. Crear `src/services/task.test.ts` — tests unitarios del service:
   - Crear task, get task, list con filtros
   - Guard terminal: intentar update en estado `completed` → error
   - Append messages/artifacts
2. Crear `src/routes/tasks.test.ts` — tests de integración de rutas:
   - POST 201, GET 200/404, PATCH status 200/409, PATCH append 200/409
   - Validación 400 en body malformado
3. Patrón: seguir `src/services/kite-client.test.ts` y `src/routes/agent-card.test.ts`

---

## 7. Patrones identificados (F0)

| Patrón | Archivo referencia | Aplicar en |
|--------|--------------------|------------|
| Supabase service con Row → Domain mapping | `src/services/registry.ts` | `src/services/task.ts` |
| Fastify route plugin con typed params/body | `src/routes/registries.ts` | `src/routes/tasks.ts` |
| Migration con CREATE TABLE + INDEX + trigger | `supabase/migrations/20260401000000_kite_registries.sql` | nueva migración |
| Supabase singleton import | `src/lib/supabase.ts` | importar en task service |
| Snake_case DB ↔ camelCase TS con helpers | `registry.ts` rowToRegistry/registryToRow | rowToTask/taskToRow |
| Tests unitarios de service | `src/services/kite-client.test.ts` | `src/services/task.test.ts` |
| Tests de integración de rutas | `src/routes/agent-card.test.ts` | `src/routes/tasks.test.ts` |

---

## 8. Notas técnicas

- **Tabla:** `tasks` (sin prefijo, siguiendo convención existente de `registries`)
- **Status CHECK:** usar `CHECK (status IN ('submitted','working','completed','failed','canceled','input-required'))`
- **Estados terminales:** `completed`, `failed`, `canceled` — inmutables, retornar 409 en cualquier intento de cambio
- **`input-required`:** estado adicional del A2A spec para human-in-the-loop (NO es terminal)
- **`updated_at`:** trigger SQL automático `set_updated_at` (ver AC-1), NO actualizar manualmente en service
- **Append JSONB:** usar `messages = tasks.messages || $new_messages::jsonb` en SQL o equivalente Supabase
- **UUID:** usar `gen_random_uuid()` como default para `id`
- **Post-implementación:** Actualizar `project-context.md` con tabla `tasks` y nuevos endpoints
