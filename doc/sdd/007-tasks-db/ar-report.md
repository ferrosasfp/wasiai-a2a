# Adversarial Review — WKH-23 Tasks DB

> **Rol:** Adversary (F4 pipeline — NexusAgil)  
> **Branch:** `feat/wkh-23-tasks-db`  
> **Fecha:** 2026-04-03  
> **Revisor:** AR Subagent (nexus-ar-wkh23)

---

## Resumen ejecutivo

| Severidad | Cantidad |
|-----------|----------|
| 🔴 BLOQUEANTE | 2 |
| 🟡 MENOR | 7 |
| ✅ OK | 19 |

**Veredicto:** ⛔ NO APROBADO — 2 bloqueantes deben resolverse antes de F5.

---

## 🔴 BLOQUEANTES

### BLK-1 — `limit=NaN` crashea silenciosamente en `GET /tasks`

**Categoría:** Error handling / Data integrity  
**Archivo:** `src/routes/tasks.ts` → `src/services/task.ts`

**Descripción:**  
Cuando el cliente envía `GET /tasks?limit=abc`, la ruta hace:
```typescript
limit: limit ? parseInt(limit, 10) : undefined,
// parseInt('abc', 10) === NaN
```
`NaN` llega al service donde:
```typescript
const limit = Math.min(Math.max(filters?.limit ?? 50, 1), 100)
// Math.max(NaN, 1) === NaN
// Math.min(NaN, 100) === NaN
```
El valor `NaN` se pasa a Supabase `.limit(NaN)`. Comportamiento no definido: puede devolver **todas las filas** sin límite o lanzar error críptico. No existe test para este path.

**Fix requerido:**
```typescript
// En route:
const parsedLimit = limit ? parseInt(limit, 10) : undefined
if (parsedLimit !== undefined && isNaN(parsedLimit)) {
  return reply.status(400).send({ error: 'Invalid limit: must be a number' })
}
```

---

### BLK-2 — Crash por `null body` en rutas PATCH (TypeError → 500)

**Categoría:** Error handling / Seguridad  
**Archivo:** `src/routes/tasks.ts` — handlers `PATCH /:id/status` y `PATCH /:id`

**Descripción:**  
`POST /tasks` protege el body nulo:
```typescript
if (body === null || typeof body !== 'object') {
  return reply.status(400).send({ error: 'Invalid request body' })
}
```
Las dos rutas PATCH **no tienen esta guarda**:
```typescript
// PATCH /:id/status
const { status } = request.body  // TypeError si body es undefined/null

// PATCH /:id
const { messages, artifacts } = request.body  // Ídem
```
Si Fastify recibe una request PATCH sin `Content-Type: application/json`, o con body inválido, el body parser puede dejar `request.body` como `undefined`. La desestructuración lanza `TypeError: Cannot destructure property 'status' of undefined` → Fastify captura y devuelve **500** en lugar de 400.

**Fix requerido:**
```typescript
// Añadir al inicio de cada handler PATCH:
if (!request.body || typeof request.body !== 'object') {
  return reply.status(400).send({ error: 'Invalid request body' })
}
```

---

## 🟡 MENORES

### MNR-1 — Trigger SQL no idempotente (re-run rompe migración)

**Categoría:** Data integrity / Constraint violations  
**Archivo:** `supabase/migrations/20260403180000_tasks.sql`

**Descripción:**
```sql
CREATE TRIGGER set_updated_at  -- Sin IF NOT EXISTS / OR REPLACE
```
PostgreSQL < 14 no soporta `CREATE OR REPLACE TRIGGER`. Si la migración se re-aplica (rollback + replay, entorno de CI, reset), fallará con `ERROR: trigger "set_updated_at" already exists`. `CREATE TABLE IF NOT EXISTS` e `CREATE INDEX IF NOT EXISTS` son idempotentes; el trigger no.

**Fix:**
```sql
DROP TRIGGER IF EXISTS set_updated_at ON tasks;
CREATE TRIGGER set_updated_at ...
```

---

### MNR-2 — TOCTOU en `updateStatus()` no documentado (CD-11 incompleto)

**Categoría:** Data integrity / Constraint violations  
**Archivo:** `src/services/task.ts` → `updateStatus()`

**Descripción:**  
CD-11 documenta la race condition en `append()` pero **no menciona que `updateStatus()` tiene el mismo TOCTOU**:
1. Request A: `get()` → status=`working` → pasa guard
2. Request B: `get()` → status=`working` → pasa guard
3. Request A: `update(status='completed')` → OK
4. Request B: `update(status='failed')` → **sobrescribe estado terminal** sin disparar error

La tarea queda en un estado terminal diferente al esperado. El terminal guard en service layer (CD-4) no protege contra esto.

**Fix mínimo para v1:** Documentarlo en CD-11 o crear CD-14. Fix real: condición en el `UPDATE`:
```typescript
.update({ status })
.eq('id', id)
.not('status', 'in', `(${TERMINAL_STATES.join(',')})`)
```

---

### MNR-3 — Tests de ruta no cubren UUID inválido

**Categoría:** Test coverage  
**Archivo:** `src/routes/tasks.test.ts`

**Descripción:**  
Los 17 tests de integración usan siempre `VALID_UUID`. El comportamiento `→ 400` cuando se pasa un UUID inválido (e.g., `GET /tasks/not-a-uuid`) **nunca se testea**. La lógica de `isValidUUID()` existe pero no tiene cobertura de test en ninguna de las 3 rutas que la usan.

**Tests faltantes (mínimo 3):**
- `GET /tasks/invalid-uuid` → 400
- `PATCH /tasks/invalid-uuid/status` → 400  
- `PATCH /tasks/invalid-uuid` → 400

---

### MNR-4 — `input-required` no tiene test explícito de "no es terminal"

**Categoría:** Test coverage  
**Archivo:** `src/services/task.test.ts`

**Descripción:**  
Tests 11-13 verifican los 3 estados terminales. Pero `input-required` (CD-10: "estado válido NO terminal") no tiene test que confirme que una tarea en `input-required` **sí puede** recibir `updateStatus()` o `append()` sin lanzar `TerminalStateError`. Es un AC implícito de A2A spec compliance.

---

### MNR-5 — Info leak en mensajes de error del service

**Categoría:** Seguridad  
**Archivo:** `src/services/task.ts`

**Descripción:**  
```typescript
throw new Error(`Failed to get task '${id}': ${error.message}`)
```
El ID de la task y el mensaje de error interno de Supabase/PostgreSQL se incluyen en el `Error`. Si el error handler de Fastify alguna vez serializa el mensaje de error (p.ej., en un middleware de logging que devuelva detalles), expone el ID y detalles internos. Para producción, los errores de infraestructura deberían loguearse internamente y retornar mensajes genéricos al cliente.

**Severidad:** Menor para hackathon, revisitar antes de producción.

---

### MNR-6 — `append()` con `messages: []` no tiene test explícito

**Categoría:** Test coverage / Data integrity  
**Archivo:** `src/services/task.test.ts`

**Descripción:**  
`append()` silencia arrays vacíos vía `if (input.messages?.length)`. El comportamiento es correcto (nada que agregar) pero no hay test para `append({messages: []})`. Debería comportarse igual que test 20 (retorna task sin cambios, sin llamar `update()`).

---

### MNR-7 — Endpoints sin autenticación

**Categoría:** Seguridad  
**Archivos:** `src/routes/tasks.ts`, `src/index.ts`

**Descripción:**  
Las 5 rutas de tasks (`POST /tasks`, `GET /tasks`, `GET /tasks/:id`, `PATCH /tasks/:id/status`, `PATCH /tasks/:id`) son completamente públicas. El SDD no especifica autenticación, pero dado que el protocolo A2A involucra datos de sesión entre agentes, cualquier cliente puede crear, listar y modificar tasks de otros.

**Nota:** El resto de las rutas del proyecto (registries, discover, etc.) aparentemente tampoco tienen auth. Esto parece ser una decisión de arquitectura consciente para el hackathon. **No bloquea WKH-23** pero debe registrarse.

---

## ✅ OK — Items verificados sin hallazgos

| # | Item verificado |
|---|----------------|
| OK-1 | `TaskRow` no exportado (CD-2 ✅) |
| OK-2 | `updated_at` nunca seteado manualmente (CD-6 ✅) |
| OK-3 | `TERMINAL_STATES` exportado como `readonly` (CD-3 ✅) |
| OK-4 | Terminal guard en service layer, no en route (CD-4 ✅) |
| OK-5 | Custom errors `TaskNotFoundError` / `TerminalStateError` (CD-7 ✅) |
| OK-6 | Query params snake_case en URL (`context_id`, `status`, `limit`) (CD-8 ✅) |
| OK-7 | `input-required` en `TASK_STATES`, ausente de `TERMINAL_STATES` (CD-10 ✅) |
| OK-8 | Race condition de `append()` documentada en CD-11 ✅ |
| OK-9 | `PATCH /:id/status` registrado antes de `PATCH /:id` (CD-12 ✅) |
| OK-10 | UUID validation con regex en ambos PATCH y GET /:id (CD-13 ✅) |
| OK-11 | `rowToTask()` mapeo correcto snake→camel, `new Date()` en timestamps ✅ |
| OK-12 | `limit` clampeo `[1, 100]` correcto para valores válidos ✅ |
| OK-13 | `append()` usa spread (`[...current.messages, ...input.messages]`) no replace ✅ |
| OK-14 | `append()` retorna `current` sin DB call cuando no hay nada que agregar ✅ |
| OK-15 | `create()` con body vacío → solo inserta campos presentes (no sobreescribe defaults DB) ✅ |
| OK-16 | Migration: `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS` ✅ |
| OK-17 | Migration: trigger `trigger_set_updated_at` con `CREATE OR REPLACE FUNCTION` ✅ |
| OK-18 | Tabla sin prefijo `kite_` ni otro prefijo (CD-9 ✅) |
| OK-19 | Todos los ACs cubiertos en tests (AC-2 a AC-6 mapeados en 37 tests) ✅ |

---

## Matriz de ACs vs cobertura

| AC | Descripción | Tests service | Tests route | Estado |
|----|-------------|--------------|-------------|--------|
| AC-1 | Migración SQL | N/A | N/A | ✅ (SQL revisado) |
| AC-2 | POST /tasks | Tests 1-2 | Tests 1-2 | ✅ |
| AC-3 | GET /tasks/:id | Tests 3-4 | Tests 3-4 | ✅ (falta UUID inválido) |
| AC-4 | GET /tasks | Tests 5-9 | Tests 5-8 | ✅ (falta UUID inválido) |
| AC-5 | PATCH status | Tests 10-14 | Tests 9-12 | ✅ (falta UUID inválido, input-required) |
| AC-6 | PATCH append | Tests 15-20 | Tests 13-17 | ✅ (falta UUID inválido, empty array) |

---

## Acciones requeridas

### Antes de F5 (BLOQUEANTES):
- [ ] **BLK-1** — Validar `limit` no-NaN en route `GET /tasks`
- [ ] **BLK-2** — Guard `body !== null/object` en ambos PATCH handlers

### Recomendado (MENORES):
- [ ] **MNR-1** — `DROP TRIGGER IF EXISTS` antes del `CREATE TRIGGER` en migración
- [ ] **MNR-2** — Documentar TOCTOU de `updateStatus()` en CDs
- [ ] **MNR-3** — Agregar 3 tests de UUID inválido en routes
- [ ] **MNR-4** — Test `input-required` no bloquea update/append
- [ ] **MNR-6** — Test `append({messages: []})` no llama update()

---

*Reporte generado por Adversarial Review agent — NexusAgil pipeline F4*
