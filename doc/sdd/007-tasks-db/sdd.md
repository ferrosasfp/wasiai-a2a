# SDD-007 — Tasks DB (WKH-23)

> **Work Item:** `doc/sdd/007-tasks-db/work-item.md`  
> **Branch:** `feat/wkh-23-tasks-db`  
> **Fecha:** 2026-04-03  
> **Autor:** Architect (F2 pipeline)

---

## 1. Context Map

### Archivos leídos y patrones extraídos

| Archivo | Patrón extraído | Aplicar en |
|---------|----------------|------------|
| `src/types/index.ts` | Interfaces agrupadas por sección con comentarios `// ===` separadores | Nuevos tipos Task al final |
| `src/services/registry.ts` | `RegistryRow` interface interna → `rowToRegistry()` / `registryToRow()` helpers → objeto `registryService` con métodos async | `taskService` con misma estructura |
| `src/routes/registries.ts` | `FastifyPluginAsync` → typed `Params`/`Body` generics → service calls → reply codes | `tasksRoutes` idéntico |
| `src/lib/supabase.ts` | Singleton `supabase` exportado, service key, `persistSession: false` | Import directo |
| `supabase/migrations/20260401000000_kite_registries.sql` | `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` + no trigger (registries no tiene `updated_at`) | Agregar trigger `set_updated_at` |
| `src/services/agent-card.ts` | Helper functions exportadas fuera del service object | Referencia de estilo |

### Convenciones detectadas

- **DB → TS:** snake_case en DB, camelCase en TS, helpers explícitos de conversión
- **Error codes:** Supabase `PGRST116` = no rows, `23505` = PK violation
- **Responses:** Service lanza Error, route catchea y devuelve HTTP code
- **No `any`:** todos los tipos explícitos, casts con `as XRow`
- **No `updated_at` en registries** → tasks será la primera tabla con trigger

---

## 2. Migración SQL

**Archivo:** `supabase/migrations/20260403180000_tasks.sql`

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

---

## 3. Tipos TypeScript

**Archivo:** `src/types/index.ts` (append al final)

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

**Tipo interno (en service):**

```typescript
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
```

---

## 4. Servicio — `src/services/task.ts`

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
   * Uses Supabase RPC-free approach: fetch → concat → update.
   * Terminal state guard applied.
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

### Decisiones de diseño

1. **Append strategy: fetch-concat-update** en lugar de SQL `||` — consistente con el patrón Supabase del proyecto (no usa RPC). ⚠️ **Race condition conocida (CD-11):** dos requests simultáneos al mismo task pueden perder datos porque el segundo `update` sobrescribe el array del primero. Aceptado para v1 — fix futuro con `jsonb_concat` RPC o `SELECT FOR UPDATE` en v2.
2. **Custom errors** (`TaskNotFoundError`, `TerminalStateError`) — permite al route layer mapear a HTTP codes sin parsear strings.
3. **`TERMINAL_STATES.includes()`** — guard centralizado, reutilizable.

---

## 5. Ruta — `src/routes/tasks.ts`

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

### Registro en `src/index.ts`

```typescript
import tasksRoutes from './routes/tasks.js'
// ... dentro del setup de Fastify:
fastify.register(tasksRoutes, { prefix: '/tasks' })
```

---

## 6. Tests

### 6.1 `src/services/task.test.ts` — Unit tests

| # | Test | Expectativa |
|---|------|-------------|
| 1 | `create()` con body mínimo (vacío) | Retorna Task con status `submitted`, messages `[]`, artifacts `[]` |
| 2 | `create()` con todos los campos | Retorna Task con contextId, messages, artifacts, metadata poblados |
| 3 | `get()` con ID existente | Retorna Task |
| 4 | `get()` con ID inexistente | Retorna `undefined` |
| 5 | `list()` sin filtros | Retorna array ordenado por created_at DESC, max 50 |
| 6 | `list()` con filtro status | Solo retorna tasks con ese status |
| 7 | `list()` con filtro contextId | Solo retorna tasks con ese context_id |
| 8 | `list()` con limit=2 | Retorna máximo 2 tasks |
| 9 | `list()` con limit>100 | Clampea a 100 |
| 10 | `updateStatus()` de submitted→working | Retorna task con nuevo status |
| 11 | `updateStatus()` en estado terminal `completed` | Lanza `TerminalStateError` |
| 12 | `updateStatus()` en estado terminal `failed` | Lanza `TerminalStateError` |
| 13 | `updateStatus()` en estado terminal `canceled` | Lanza `TerminalStateError` |
| 14 | `updateStatus()` con ID inexistente | Lanza `TaskNotFoundError` |
| 15 | `append()` messages a task existente | Messages son appended, no reemplazados |
| 16 | `append()` artifacts a task existente | Artifacts son appended |
| 17 | `append()` messages + artifacts | Ambos appended atómicamente |
| 18 | `append()` en estado terminal | Lanza `TerminalStateError` |
| 19 | `append()` con ID inexistente | Lanza `TaskNotFoundError` |
| 20 | `append()` sin messages ni artifacts | Retorna task sin cambios |

### 6.2 `src/routes/tasks.test.ts` — Integration tests

| # | Test | Método | Ruta | Status esperado |
|---|------|--------|------|-----------------|
| 1 | Crear task | POST | /tasks | 201 |
| 2 | Crear task con body vacío | POST | /tasks | 201 (defaults) |
| 3 | Obtener task existente | GET | /tasks/:id | 200 |
| 4 | Obtener task inexistente | GET | /tasks/:id | 404 |
| 5 | Listar tasks | GET | /tasks | 200 |
| 6 | Listar con filtro status | GET | /tasks?status=working | 200 |
| 7 | Listar con status inválido | GET | /tasks?status=xxx | 400 |
| 8 | Listar con filtro context_id | GET | /tasks?context_id=abc | 200 |
| 9 | Actualizar status válido | PATCH | /tasks/:id/status | 200 |
| 10 | Actualizar status inválido | PATCH | /tasks/:id/status | 400 |
| 11 | Actualizar task inexistente | PATCH | /tasks/:id/status | 404 |
| 12 | Actualizar task terminal | PATCH | /tasks/:id/status | 409 |
| 13 | Append messages | PATCH | /tasks/:id | 200 |
| 14 | Append artifacts | PATCH | /tasks/:id | 200 |
| 15 | Append en task terminal | PATCH | /tasks/:id | 409 |
| 16 | Append sin body útil | PATCH | /tasks/:id | 400 |
| 17 | Append task inexistente | PATCH | /tasks/:id | 404 |

### Patrón de test

- Usar `fastify.inject()` para integration tests (patrón existente del proyecto)
- Mock de `supabase` para unit tests del service
- `beforeEach`: crear task fresca para tests que mutan

---

## 7. Constraint Directives

| # | Constraint | Razón |
|---|-----------|-------|
| CD-1 | TypeScript `strict: true`, cero `any` | Consistencia proyecto |
| CD-2 | `TaskRow` es tipo interno del service, no exportado | Encapsulación DB |
| CD-3 | `TERMINAL_STATES` exportado como `readonly` array | Guard reutilizable |
| CD-4 | Terminal guard en **service layer**, no en route | Lógica de negocio centralizada |
| CD-5 | Append usa fetch-concat-update, no SQL `||` | Consistencia con patrón Supabase del proyecto |
| CD-6 | `updated_at` NUNCA se setea manualmente — trigger SQL | Única fuente de verdad |
| CD-7 | Custom errors (`TaskNotFoundError`, `TerminalStateError`) para mapeo HTTP limpio | Separation of concerns |
| CD-8 | Query params de list: `status`, `context_id`, `limit` — snake_case en URL | Convención REST |
| CD-9 | Tabla `tasks` sin prefijo | Consistencia con `registries` |
| CD-10 | `input-required` es estado válido NO terminal | A2A spec compliance |
| CD-11 | Race condition en append es conocida y aceptada para v1. Fix futuro: `jsonb_concat` RPC o `SELECT FOR UPDATE` en v2. NO bloquea hackathon | Pragmatismo v1 |
| CD-12 | Registrar `PATCH /:id/status` ANTES de `PATCH /:id` para evitar que Fastify interprete `status` como `:id` | Fastify route matching |
| CD-13 | Validar formato UUID antes de query a Supabase — evitar errores crípticos de PostgreSQL | Defensive coding |

---

## 8. Sizing

| Aspecto | Estimación |
|---------|------------|
| Sizing | **M (~4h)** |
| Tests | 37 (20 unit + 17 integration) |
| Justificación | Validación UUID + guards + 37 tests + trigger SQL → complejidad media |

---

## 9. Plan de Waves

### Wave 1 — DB + Types (~30 min)
1. Crear `supabase/migrations/20260403180000_tasks.sql`
2. Append tipos a `src/types/index.ts`: `TASK_STATES`, `TaskState`, `TERMINAL_STATES`, `Task`
3. Aplicar migración: `npx supabase db push` o equivalente
4. **Gate:** migración aplicada sin errores, tipos compilan

### Wave 2 — Service + Routes (~1.5h)
1. Crear `src/services/task.ts` con `taskService` + custom errors
2. Crear `src/routes/tasks.ts` con 5 endpoints
3. Registrar `tasksRoutes` en `src/index.ts` con prefix `/tasks`
4. Smoke test: `curl POST /tasks`, `GET /tasks`, `GET /tasks/:id`
5. **Gate:** endpoints responden correctamente, terminal guard funciona

### Wave 3 — Tests (~1.5h)
1. Crear `src/services/task.test.ts` (20 unit tests)
2. Crear `src/routes/tasks.test.ts` (17 integration tests)
3. Run: `npm test` — todo verde
4. **Gate:** 37 tests passing, coverage de todas las ACs

---

## 10. Readiness Check

| Criterio | Estado |
|----------|--------|
| Todos los ACs cubiertos (AC-1 a AC-6) | ✅ |
| Context Map con archivos reales | ✅ |
| Migración SQL completa con trigger | ✅ |
| Tipos sin `any` | ✅ |
| Custom errors para mapeo HTTP | ✅ |
| Terminal state guard en service layer | ✅ |
| Append logic (no replace) | ✅ |
| Tests especificados (37 total) | ✅ |
| Constraint Directives (13) | ✅ |
| Wave plan con gates | ✅ |
| Sin dependencias externas nuevas | ✅ |
| UUID validation guard en routes | ✅ |
| Route registration order documentado | ✅ |
| Sizing actualizado a M | ✅ |

**SDD READY para F3 (implementación).**
