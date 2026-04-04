# Story File — WKH-23: Tasks DB

> **Branch:** `feat/wkh-23-tasks-db`
> **Sizing:** M (~4h)
> **Este archivo es autocontenido. No necesitas leer ningún otro documento.**

---

## 1. Resumen

Crear tabla `tasks` en Supabase PostgreSQL con estados del Google A2A Protocol, trigger automático para `updated_at`, y exponer 5 endpoints REST CRUD con guard de estados terminales y lógica de append para messages/artifacts.

---

## 2. Acceptance Criteria

**AC-1 — Migración DB**
WHEN the migration `20260403180000_tasks.sql` is applied,
THEN a table `tasks` SHALL exist with columns: `id` (UUID PK, gen_random_uuid), `context_id` (TEXT nullable), `status` (TEXT NOT NULL DEFAULT 'submitted', CHECK in submitted|working|completed|failed|canceled|input-required), `messages` (JSONB DEFAULT '[]'), `artifacts` (JSONB DEFAULT '[]'), `metadata` (JSONB nullable), `created_at` (TIMESTAMPTZ DEFAULT NOW()), `updated_at` (TIMESTAMPTZ DEFAULT NOW()),
AND an index on `status` SHALL exist,
AND an index on `context_id` SHALL exist WHERE `context_id IS NOT NULL`,
AND a trigger `set_updated_at` SHALL exist that automatically sets `updated_at = NOW()` BEFORE UPDATE on each row.

**AC-2 — POST /tasks**
WHEN a client sends POST /tasks with optional `contextId`, `messages`, `artifacts`, `metadata`,
THEN the system SHALL create a new task with status `submitted` and return 201 with the full task object.

**AC-3 — GET /tasks/:id**
WHEN a client sends GET /tasks/:id with a valid UUID, THEN return 200 with the task.
WHEN the id does not exist, THEN return 404.

**AC-4 — GET /tasks (list with filters)**
WHEN a client sends GET /tasks, THEN return array of tasks ordered by `created_at` DESC.
Query params: `status`, `context_id`, `limit` (default 50, max 100).

**AC-5 — PATCH /tasks/:id/status**
WHEN a client sends PATCH /tasks/:id/status with `{ "status": <valid TaskState> }`, THEN update and return 200.
Invalid status → 400. Not found → 404. Terminal state (`completed`|`failed`|`canceled`) → 409.

**AC-6 — PATCH /tasks/:id (append)**
WHEN body contains `messages` and/or `artifacts`, THEN APPEND (not replace) to existing arrays.
Terminal state → 409. Not found → 404. No messages nor artifacts → 400.

---

## 3. Constraint Directives

| # | Constraint |
|---|-----------|
| CD-1 | TypeScript `strict: true`, cero `any` |
| CD-2 | `TaskRow` es tipo interno del service, no exportado |
| CD-3 | `TERMINAL_STATES` exportado como `readonly` array |
| CD-4 | Terminal guard en **service layer**, no en route |
| CD-5 | Append usa fetch-concat-update, no SQL `||` |
| CD-6 | `updated_at` NUNCA se setea manualmente — trigger SQL |
| CD-7 | Custom errors (`TaskNotFoundError`, `TerminalStateError`) para mapeo HTTP |
| CD-8 | Query params de list: `status`, `context_id`, `limit` — snake_case en URL |
| CD-9 | Tabla `tasks` sin prefijo |
| CD-10 | `input-required` es estado válido NO terminal |
| CD-11 | Race condition en append es conocida y aceptada v1 (comment en código) |
| CD-12 | Registrar `PATCH /:id/status` ANTES de `PATCH /:id` en el plugin de rutas |
| CD-13 | Validar formato UUID antes de query a Supabase |

---

## 4. Exemplars — Leer antes de implementar

| Qué | Path exacto |
|-----|-------------|
| Service pattern (Row→Domain, helpers, exports) | `src/services/registry.ts` |
| Route pattern (FastifyPluginAsync, typed params) | `src/routes/registries.ts` |
| Migration pattern (CREATE TABLE + INDEX) | `supabase/migrations/20260401000000_kite_registries.sql` |
| Supabase singleton | `src/lib/supabase.ts` |
| Types grouping style | `src/types/index.ts` |
| Route registration in index | `src/index.ts` (líneas 11-50) |

---

## 5. Plan de Waves

### Wave 1 — DB + Types

#### 5.1.1 CREAR `supabase/migrations/20260403180000_tasks.sql`

```sql
-- ============================================================
-- Migration: 20260403180000_tasks
-- WKH-23: Crear tabla tasks para A2A Protocol
-- ============================================================

-- Función reutilizable para trigger updated_at (idempotente)
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Tabla principal
CREATE TABLE IF NOT EXISTS tasks (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  context_id  TEXT,
  status      TEXT        NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','working','completed','failed','canceled','input-required')),
  messages    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  artifacts   JSONB       NOT NULL DEFAULT '[]'::jsonb,
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índice en status (queries frecuentes por estado)
CREATE INDEX IF NOT EXISTS idx_tasks_status
  ON tasks (status);

-- Índice parcial en context_id (solo filas con valor)
CREATE INDEX IF NOT EXISTS idx_tasks_context_id
  ON tasks (context_id)
  WHERE context_id IS NOT NULL;

-- Trigger para updated_at automático
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();
```

#### 5.1.2 MODIFICAR `src/types/index.ts` — Append al final del archivo

```typescript
// ============================================================
// TASK TYPES (Google A2A Protocol)
// ============================================================

export const TASK_STATES = [
  'submitted',
  'working',
  'completed',
  'failed',
  'canceled',
  'input-required',
] as const

export type TaskState = (typeof TASK_STATES)[number]

export const TERMINAL_STATES: readonly TaskState[] = ['completed', 'failed', 'canceled'] as const

export interface Task {
  id: string
  contextId: string | null
  status: TaskState
  messages: unknown[]
  artifacts: unknown[]
  metadata: Record<string, unknown> | null
  createdAt: Date
  updatedAt: Date
}
```

**Gate:** migración aplicada sin errores, tipos compilan con `npx tsc --noEmit`.

---

### Wave 2 — Service + Routes

#### 5.2.1 CREAR `src/services/task.ts`

```typescript
/**
 * Task Service — CRUD + terminal state guard + append messages/artifacts
 * WKH-23: A2A Protocol task management
 */

import type { Task, TaskState } from '../types/index.js'
import { TERMINAL_STATES } from '../types/index.js'
import { supabase } from '../lib/supabase.js'

// ── Tipo interno para filas de Supabase ─────────────────────

interface TaskRow {
  id: string
  context_id: string | null
  status: TaskState
  messages: unknown[]
  artifacts: unknown[]
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

// ── Helpers Row ↔ Domain ────────────────────────────────────

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    contextId: row.context_id,
    status: row.status,
    messages: row.messages,
    artifacts: row.artifacts,
    metadata: row.metadata,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}

// ── Service ─────────────────────────────────────────────────

export const taskService = {
  /**
   * Create a new task (status defaults to 'submitted' via DB)
   */
  async create(input: {
    contextId?: string
    messages?: unknown[]
    artifacts?: unknown[]
    metadata?: Record<string, unknown>
  }): Promise<Task> {
    const row: Partial<TaskRow> = {}
    if (input.contextId !== undefined) row.context_id = input.contextId
    if (input.messages !== undefined) row.messages = input.messages
    if (input.artifacts !== undefined) row.artifacts = input.artifacts
    if (input.metadata !== undefined) row.metadata = input.metadata

    const { data, error } = await supabase
      .from('tasks')
      .insert(row)
      .select()
      .single()

    if (error) throw new Error(`Failed to create task: ${error.message}`)
    return rowToTask(data as TaskRow)
  },

  /**
   * Get a task by ID. Returns undefined if not found.
   */
  async get(id: string): Promise<Task | undefined> {
    const { data, error } = await supabase
      .from('tasks')
      .select('*')
      .eq('id', id)
      .maybeSingle()

    if (error) throw new Error(`Failed to get task '${id}': ${error.message}`)
    return data ? rowToTask(data as TaskRow) : undefined
  },

  /**
   * List tasks with optional filters
   */
  async list(filters?: {
    status?: TaskState
    contextId?: string
    limit?: number
  }): Promise<Task[]> {
    const limit = Math.min(Math.max(filters?.limit ?? 50, 1), 100)

    let query = supabase
      .from('tasks')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit)

    if (filters?.status) {
      query = query.eq('status', filters.status)
    }
    if (filters?.contextId) {
      query = query.eq('context_id', filters.contextId)
    }

    const { data, error } = await query

    if (error) throw new Error(`Failed to list tasks: ${error.message}`)
    return (data as TaskRow[]).map(rowToTask)
  },

  /**
   * Update task status with terminal state guard.
   * Throws if task is in a terminal state.
   */
  async updateStatus(id: string, status: TaskState): Promise<Task> {
    // 1. Fetch current task
    const current = await this.get(id)
    if (!current) throw new TaskNotFoundError(id)

    // 2. Terminal state guard
    if (TERMINAL_STATES.includes(current.status)) {
      throw new TerminalStateError(id, current.status)
    }

    // 3. Update status
    const { data, error } = await supabase
      .from('tasks')
      .update({ status })
      .eq('id', id)
      .select()
      .single()

    if (error) throw new Error(`Failed to update task status: ${error.message}`)
    return rowToTask(data as TaskRow)
  },

  /**
   * Append messages and/or artifacts to a task.
   * Uses fetch-concat-update pattern (consistent with Supabase patterns in this project).
   *
   * ⚠️ Race condition conocida (CD-11): dos requests simultáneos pueden
   * perder datos porque el segundo update sobrescribe el array del primero.
   * Aceptado para v1 — fix futuro con `jsonb_concat` RPC o SELECT FOR UPDATE en v2.
   */
  async append(
    id: string,
    input: { messages?: unknown[]; artifacts?: unknown[] },
  ): Promise<Task> {
    // 1. Fetch current task
    const current = await this.get(id)
    if (!current) throw new TaskNotFoundError(id)

    // 2. Terminal state guard
    if (TERMINAL_STATES.includes(current.status)) {
      throw new TerminalStateError(id, current.status)
    }

    // 3. Build update payload with appended arrays
    const updateRow: Partial<Pick<TaskRow, 'messages' | 'artifacts'>> = {}
    if (input.messages?.length) {
      updateRow.messages = [...current.messages, ...input.messages]
    }
    if (input.artifacts?.length) {
      updateRow.artifacts = [...current.artifacts, ...input.artifacts]
    }

    if (Object.keys(updateRow).length === 0) {
      return current // nothing to append
    }

    const { data, error } = await supabase
      .from('tasks')
      .update(updateRow)
      .eq('id', id)
      .select()
      .single()

    if (error) throw new Error(`Failed to append to task: ${error.message}`)
    return rowToTask(data as TaskRow)
  },
}

// ── Custom Errors ───────────────────────────────────────────

export class TaskNotFoundError extends Error {
  constructor(id: string) {
    super(`Task '${id}' not found`)
    this.name = 'TaskNotFoundError'
  }
}

export class TerminalStateError extends Error {
  constructor(id: string, state: TaskState) {
    super(`Task '${id}' is in terminal state '${state}' and cannot be updated`)
    this.name = 'TerminalStateError'
  }
}
```

#### 5.2.2 CREAR `src/routes/tasks.ts`

```typescript
/**
 * Tasks Routes — A2A Protocol task management
 * WKH-23
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { taskService, TaskNotFoundError, TerminalStateError } from '../services/task.js'
import { TASK_STATES } from '../types/index.js'
import type { TaskState } from '../types/index.js'

// ── UUID validation helper ──────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function isValidUUID(id: string): boolean {
  return UUID_RE.test(id)
}

const tasksRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /tasks — Create a new task (AC-2)
   */
  fastify.post(
    '/',
    async (
      request: FastifyRequest<{
        Body: {
          contextId?: string
          messages?: unknown[]
          artifacts?: unknown[]
          metadata?: Record<string, unknown>
        }
      }>,
      reply: FastifyReply,
    ) => {
      const body = request.body
      if (body === null || typeof body !== 'object') {
        return reply.status(400).send({ error: 'Invalid request body' })
      }

      const task = await taskService.create({
        contextId: body.contextId,
        messages: body.messages,
        artifacts: body.artifacts,
        metadata: body.metadata,
      })

      return reply.status(201).send(task)
    },
  )

  /**
   * GET /tasks — List tasks with filters (AC-4)
   */
  fastify.get(
    '/',
    async (
      request: FastifyRequest<{
        Querystring: {
          status?: string
          context_id?: string
          limit?: string
        }
      }>,
      reply: FastifyReply,
    ) => {
      const { status, context_id, limit } = request.query

      // Validate status if provided
      if (status && !TASK_STATES.includes(status as TaskState)) {
        return reply.status(400).send({ error: `Invalid status: ${status}` })
      }

      const tasks = await taskService.list({
        status: status as TaskState | undefined,
        contextId: context_id,
        limit: limit ? parseInt(limit, 10) : undefined,
      })

      return reply.send({ tasks, total: tasks.length })
    },
  )

  /**
   * GET /tasks/:id — Get a task by ID (AC-3)
   */
  fastify.get(
    '/:id',
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      if (!isValidUUID(request.params.id)) {
        return reply.status(400).send({ error: 'Invalid UUID format' })
      }
      const task = await taskService.get(request.params.id)
      if (!task) {
        return reply.status(404).send({ error: 'Task not found' })
      }
      return reply.send(task)
    },
  )

  /**
   * PATCH /tasks/:id/status — Update task status (AC-5)
   * ⚠️ DEBE registrarse ANTES que PATCH /:id (CD-12)
   */
  fastify.patch(
    '/:id/status',
    async (
      request: FastifyRequest<{
        Params: { id: string }
        Body: { status: string }
      }>,
      reply: FastifyReply,
    ) => {
      if (!isValidUUID(request.params.id)) {
        return reply.status(400).send({ error: 'Invalid UUID format' })
      }
      const { status } = request.body

      if (!status || !TASK_STATES.includes(status as TaskState)) {
        return reply.status(400).send({ error: `Invalid status: ${status}` })
      }

      try {
        const task = await taskService.updateStatus(request.params.id, status as TaskState)
        return reply.send(task)
      } catch (err) {
        if (err instanceof TaskNotFoundError) {
          return reply.status(404).send({ error: 'Task not found' })
        }
        if (err instanceof TerminalStateError) {
          return reply.status(409).send({ error: err.message })
        }
        throw err
      }
    },
  )

  /**
   * PATCH /tasks/:id — Append messages/artifacts (AC-6)
   * ⚠️ Registrado DESPUÉS de PATCH /:id/status (CD-12)
   */
  fastify.patch(
    '/:id',
    async (
      request: FastifyRequest<{
        Params: { id: string }
        Body: { messages?: unknown[]; artifacts?: unknown[] }
      }>,
      reply: FastifyReply,
    ) => {
      if (!isValidUUID(request.params.id)) {
        return reply.status(400).send({ error: 'Invalid UUID format' })
      }
      const { messages, artifacts } = request.body

      if (!messages && !artifacts) {
        return reply.status(400).send({ error: 'Must provide messages or artifacts to append' })
      }

      try {
        const task = await taskService.append(request.params.id, { messages, artifacts })
        return reply.send(task)
      } catch (err) {
        if (err instanceof TaskNotFoundError) {
          return reply.status(404).send({ error: 'Task not found' })
        }
        if (err instanceof TerminalStateError) {
          return reply.status(409).send({ error: err.message })
        }
        throw err
      }
    },
  )
}

export default tasksRoutes
```

#### 5.2.3 MODIFICAR `src/index.ts` — Agregar import y registro

Agregar import junto a los demás imports de routes (después de línea 16):

```typescript
import tasksRoutes from './routes/tasks.js'
```

Agregar registro después del último `fastify.register` (después de línea 50):

```typescript
await fastify.register(tasksRoutes, { prefix: '/tasks' })
```

**Gate:** `npx tsc --noEmit` pasa. Smoke test: `curl -X POST http://localhost:3000/tasks -H 'Content-Type: application/json' -d '{}'` retorna 201.

---

### Wave 3 — Tests

#### 5.3.1 CREAR `src/services/task.test.ts` — 20 unit tests

| # | Test | Expectativa |
|---|------|-------------|
| 1 | `create()` con body vacío | Task con status `submitted`, messages `[]`, artifacts `[]` |
| 2 | `create()` con todos los campos | Task con contextId, messages, artifacts, metadata poblados |
| 3 | `get()` con ID existente | Retorna Task |
| 4 | `get()` con ID inexistente | Retorna `undefined` |
| 5 | `list()` sin filtros | Array ordenado por created_at DESC, max 50 |
| 6 | `list()` con filtro status | Solo tasks con ese status |
| 7 | `list()` con filtro contextId | Solo tasks con ese context_id |
| 8 | `list()` con limit=2 | Máximo 2 tasks |
| 9 | `list()` con limit>100 | Clampea a 100 |
| 10 | `updateStatus()` submitted→working | Task con nuevo status |
| 11 | `updateStatus()` en estado `completed` | Lanza `TerminalStateError` |
| 12 | `updateStatus()` en estado `failed` | Lanza `TerminalStateError` |
| 13 | `updateStatus()` en estado `canceled` | Lanza `TerminalStateError` |
| 14 | `updateStatus()` con ID inexistente | Lanza `TaskNotFoundError` |
| 15 | `append()` messages | Messages appended, no reemplazados |
| 16 | `append()` artifacts | Artifacts appended |
| 17 | `append()` messages + artifacts | Ambos appended |
| 18 | `append()` en estado terminal | Lanza `TerminalStateError` |
| 19 | `append()` con ID inexistente | Lanza `TaskNotFoundError` |
| 20 | `append()` sin messages ni artifacts | Retorna task sin cambios |

#### 5.3.2 CREAR `src/routes/tasks.test.ts` — 17 integration tests

| # | Test | Método | Ruta | Status |
|---|------|--------|------|--------|
| 1 | Crear task | POST | /tasks | 201 |
| 2 | Crear task body vacío | POST | /tasks | 201 |
| 3 | Obtener task existente | GET | /tasks/:id | 200 |
| 4 | Obtener task inexistente | GET | /tasks/:id | 404 |
| 5 | Listar tasks | GET | /tasks | 200 |
| 6 | Listar filtro status | GET | /tasks?status=working | 200 |
| 7 | Listar status inválido | GET | /tasks?status=xxx | 400 |
| 8 | Listar filtro context_id | GET | /tasks?context_id=abc | 200 |
| 9 | Update status válido | PATCH | /tasks/:id/status | 200 |
| 10 | Update status inválido | PATCH | /tasks/:id/status | 400 |
| 11 | Update task inexistente | PATCH | /tasks/:id/status | 404 |
| 12 | Update task terminal | PATCH | /tasks/:id/status | 409 |
| 13 | Append messages | PATCH | /tasks/:id | 200 |
| 14 | Append artifacts | PATCH | /tasks/:id | 200 |
| 15 | Append task terminal | PATCH | /tasks/:id | 409 |
| 16 | Append sin body útil | PATCH | /tasks/:id | 400 |
| 17 | Append task inexistente | PATCH | /tasks/:id | 404 |

**Patrones de test:**
- Integration tests: usar `fastify.inject()` (ver exemplar `src/routes/agent-card.test.ts`)
- Unit tests: mock de `supabase` (ver exemplar `src/services/kite-client.test.ts`)
- `beforeEach`: crear task fresca para tests que mutan

**Gate:** `npm test` — 37 tests passing.

---

## 6. Definition of Done

- [ ] Migración aplicada sin errores (`npx supabase db push`)
- [ ] `npx tsc --noEmit` pasa sin errores
- [ ] 5 endpoints responden con los status codes correctos
- [ ] Terminal state guard bloquea updates en `completed`/`failed`/`canceled`
- [ ] Append agrega (no reemplaza) messages y artifacts
- [ ] `PATCH /:id/status` registrado ANTES de `PATCH /:id`
- [ ] UUID validation en todas las rutas con `:id`
- [ ] 37 tests passing (`npm test`)
- [ ] Todos los ACs (AC-1 a AC-6) cubiertos
- [ ] Cero `any` en todo el código nuevo
- [ ] Branch: `feat/wkh-23-tasks-db`
