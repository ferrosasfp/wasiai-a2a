# SDD — WKH-7: Supabase — Migrar registries de in-memory a PostgreSQL

| Campo | Valor |
|-------|-------|
| **Work Item** | WKH-7 |
| **Fase** | F2 — Software Design Document |
| **Autor** | Architect NexusAgile |
| **Fecha** | 2026-04-02 |
| **Estado** | DRAFT — Pendiente revisión Spec Reviewer |

---

## 1. Context Map

### Estado Actual (in-memory)

```
src/services/registry.ts
  └── Map<string, RegistryConfig>   ← store en RAM
        ├── 'wasiai' → { ... }       ← hardcodeado en módulo
        └── ... (registros de usuarios)

Ciclo de vida: los datos viven mientras el proceso está vivo.
Cada restart → pérdida total de registros de usuarios.
```

**Problema:** `RegistryConfig[]` retornado por `list()` y `getEnabled()` se usa en
`src/routes/discover.ts` → `discoveryService.discover()`. Sin persistencia, el gateway
queda ciego tras cada reinicio.

### Estado Objetivo (Supabase PostgreSQL)

```
Supabase dev: bdwvrwzvsldephfibmuu.supabase.co
  └── tabla: registries
        ├── id TEXT PRIMARY KEY
        ├── name TEXT
        ├── discovery_endpoint TEXT
        ├── invoke_endpoint TEXT
        ├── agent_endpoint TEXT (nullable)
        ├── schema JSONB
        ├── auth JSONB (nullable, contiene valor sensible)
        ├── enabled BOOLEAN
        └── created_at TIMESTAMPTZ

src/lib/supabase.ts         ← NUEVO: singleton cliente
src/services/registry.ts    ← MODIFICAR: queries async a Supabase
src/routes/registries.ts    ← MODIFICAR: await en cada llamada al service
migrations/kite_001_registries.sql  ← NUEVO: DDL + seed WasiAI
```

### Qué CAMBIA

| Elemento | Antes | Después |
|----------|-------|---------|
| Storage | `Map<string, RegistryConfig>` en RAM | Tabla `registries` en Supabase PostgreSQL |
| Métodos del service | síncronos | **async** (todos) |
| Inicialización de 'wasiai' | hardcodeado en módulo | seed en migration SQL |
| Retorno de `delete()` | `boolean` | `Promise<boolean>` |
| `src/routes/registries.ts` | sin await | con await en cada llamada al service |
| Dependencias | solo fastify + viem | + `@supabase/supabase-js` |

### Qué NO CAMBIA

| Elemento | Razón |
|----------|-------|
| Firmas de métodos del service (excepto async) | Contrato público — callers no deben cambiar lógica |
| Tipos `RegistryConfig`, `RegistrySchema`, `RegistryAuth` | Sin modificación |
| Endpoints HTTP y sus respuestas | Misma API REST externa |
| `src/routes/discover.ts` | Usa `registryService.getEnabled()` — solo necesita await |
| `src/index.ts` | Sin cambio |
| Generación del ID (`name.toLowerCase().replace(...)`) | Misma lógica de slugificación |
| Guard `id === 'wasiai'` en delete | Misma protección |

---

## 2. Decisiones de Diseño (ADRs)

### ADR-1: @supabase/supabase-js v2 vs postgres directo

**Decisión:** `@supabase/supabase-js` v2

**Contexto:** El proyecto ya tiene Supabase como BD objetivo (ver project-context.md).
La alternativa sería `pg` (node-postgres) o `postgres` (postgres.js).

**Razones:**
- Consistencia con el stack definido en project-context.md (Supabase PostgreSQL)
- `supabase-js` v2 es compatible con ESM nativo (`"type": "module"` en package.json)
- El cliente de servicio bypasea RLS, que es lo correcto para operaciones server-side
- En el futuro, otras tablas (`a2a_tasks`, `a2a_transform_cache`) también usarán el mismo cliente
- Menos configuración de connection pooling vs `pg` directo

**Alternativa rechazada:** `postgres` (postgres.js) requeriría gestión manual de pool y migrations separadas del ecosistema Supabase.

---

### ADR-2: Estructura de tabla `registries`

**Decisión:** Una tabla plana con JSONB para campos anidados

```sql
CREATE TABLE registries (
  id                 TEXT        PRIMARY KEY,
  name               TEXT        NOT NULL,
  discovery_endpoint TEXT        NOT NULL,
  invoke_endpoint    TEXT        NOT NULL,
  agent_endpoint     TEXT,
  schema             JSONB       NOT NULL,
  auth               JSONB,
  enabled            BOOLEAN     NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Nota sobre nombre de tabla:** El project-context.md indica prefijo `a2a_` para tablas, pero
la work-item refiere la tabla como `registries` (sin prefijo). Se usa `registries` sin prefijo
para esta migración Kite (prefijo `kite_` en el archivo de migration). Si en el futuro se decide
unificar con el esquema `a2a_`, se requiere una migration de rename separada.

**Razones para columnas escalares vs JSONB:**
- `id`, `name`, `discovery_endpoint`, `invoke_endpoint`, `enabled`, `created_at` → escalares porque son candidatos a filtros/índices
- `schema` → JSONB: `RegistrySchema` es un objeto profundamente anidado con campos opcionales; normalizar requeriría 3 tablas adicionales sin beneficio real (nunca se filtra por subcampos)
- `auth` → JSONB: `RegistryAuth` tiene variantes por tipo; JSONB permite flexibilidad sin columnas nullable de cada variante

---

### ADR-3: Schema JSON/JSONB para campos anidados

**Decisión:** JSONB para `schema` y `auth`

**Razones técnicas:**
- JSONB almacena binario comprimido, más eficiente en consultas que JSON (texto)
- Operadores `->`, `->>`, `@>` disponibles para consultas futuras si se necesitan
- Supabase JS client serializa/deserializa automáticamente objetos TypeScript ↔ JSONB
- Sin pérdida de tipos: el objeto TypeScript se recupera igual que se insertó

**Mapeo TypeScript → JSONB:**
```typescript
// RegistrySchema se almacena tal cual como objeto JS → JSONB
// RegistryAuth ídem, incluyendo auth.value (documentado en ADR-6)
```

---

### ADR-4: Manejo de errores de DB

**Decisión:** `throw new Error(mensaje)` — mismo patrón que el código actual

**Contexto:** El código actual lanza errores con `throw new Error(...)` en casos como
"Registry already exists" o "Registry not found". Las routes capturan con try/catch.

**Estrategia:**
```
Error de constraint (PK duplicate) → throw Error con mensaje descriptivo
Row not found en update/get       → throw Error('Registry not found') o return undefined
Error de conexión Supabase         → re-throw el error original (será capturado por Fastify)
```

**Tipos de error Supabase:** `supabase-js` retorna `{ data, error }`. El servicio
debe chequear `if (error) throw error` después de cada query. No se expone el error
raw de Supabase a la ruta — se wrappea en mensajes amigables donde corresponde.

**Alternativas rechazadas:**
- `return null` en lugar de throw: rompe el contrato actual de las routes (esperan throw para catch)
- Typed errors (clases): overhead innecesario para este scope

---

### ADR-5: Inicialización del cliente Supabase (singleton en src/lib/supabase.ts)

**Decisión:** Singleton module-level en `src/lib/supabase.ts`

**Razones:**
- Un solo cliente por proceso → un solo connection pool
- `import { supabase } from '../lib/supabase.js'` es idiomático en ESM
- La validación de env vars en startup garantiza AC-8 (falla con mensaje descriptivo)
- `process.exit(1)` en lugar de throw: en ESM top-level, un throw en módulo puede producir
  comportamiento undefined; exit es determinístico

**Ubicación:** `src/lib/supabase.ts` (acorde a la estructura de directorios del proyecto
que ya tiene `src/lib/` con `db.ts`, `redis.ts`, etc.)

**Nota:** El work-item menciona `src/services/db/client.ts` como ubicación alternativa,
pero el proyecto ya tiene `src/lib/` como directorio de singletons de infraestructura.
Se usa `src/lib/supabase.ts` para consistencia con la estructura existente.

---

### ADR-6: Migración del registro 'wasiai' hardcodeado

**Decisión:** Eliminar el hardcode en `registry.ts` y moverlo al seed SQL de la migration

**Estrategia:**
1. La migration `kite_001_registries.sql` incluye un `INSERT ... ON CONFLICT DO NOTHING`
   con los datos completos del registro 'wasiai'
2. El código en `registry.ts` NO pre-popula el Map en el startup — lee desde Supabase
3. `auth.value` del registro 'wasiai' NO se incluye en el seed (el valor del API key
   real se configurará manualmente en el dashboard de Supabase o via script seguro)

**Idempotencia:** `ON CONFLICT (id) DO NOTHING` garantiza que re-aplicar la migration
no duplique el registro.

**Seguridad de `auth.value`:**
- El campo `auth.value` puede contener API keys, tokens o secrets
- **PROHIBIDO** loguear el objeto `auth` completo o `auth.value` en ningún nivel (service, route, middleware)
- En logs, usar: `{ ...registry, auth: registry.auth ? { type: registry.auth.type, key: registry.auth.key } : undefined }`
- El seed incluye `auth` sin `value` — el operador debe configurar el valor manualmente

---

## 3. Diseño Técnico

### 3.1 Migración SQL — `migrations/kite_001_registries.sql`

```sql
-- ============================================================
-- Migration: kite_001_registries
-- WKH-7: Crear tabla registries + seed WasiAI
-- Proyecto: wasiai-a2a (Hackathon Kite)
-- Supabase dev: bdwvrwzvsldephfibmuu.supabase.co
-- ============================================================

-- Tabla principal de registries (marketplaces registrados)
CREATE TABLE IF NOT EXISTS registries (
  id                 TEXT        PRIMARY KEY,
  name               TEXT        NOT NULL,
  discovery_endpoint TEXT        NOT NULL,
  invoke_endpoint    TEXT        NOT NULL,
  agent_endpoint     TEXT,
  schema             JSONB       NOT NULL,
  auth               JSONB,
  enabled            BOOLEAN     NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índice para queries frecuentes (getEnabled())
CREATE INDEX IF NOT EXISTS idx_registries_enabled
  ON registries (enabled)
  WHERE enabled = true;

-- ── Seed WasiAI (idempotente) ────────────────────────────────
-- ON CONFLICT DO NOTHING: re-aplicar la migration es seguro
-- NOTA: auth.value no se incluye en el seed — configurar manualmente
--       vía Supabase dashboard o script seguro (nunca en código)
INSERT INTO registries (
  id,
  name,
  discovery_endpoint,
  invoke_endpoint,
  agent_endpoint,
  schema,
  auth,
  enabled,
  created_at
) VALUES (
  'wasiai',
  'WasiAI',
  'https://app.wasiai.io/api/v1/capabilities',
  'https://app.wasiai.io/api/v1/models/{slug}/invoke',
  'https://app.wasiai.io/api/v1/agents/{slug}',
  '{
    "discovery": {
      "capabilityParam": "tag",
      "queryParam": "q",
      "limitParam": "limit",
      "maxPriceParam": "max_price",
      "agentsPath": "agents",
      "agentMapping": {
        "id": "id",
        "name": "name",
        "slug": "slug",
        "description": "description",
        "capabilities": "tags",
        "price": "price_per_call_usdc",
        "reputation": "erc8004.reputation_score"
      }
    },
    "invoke": {
      "method": "POST",
      "inputField": "input",
      "resultPath": "result"
    }
  }'::jsonb,
  '{"type": "header", "key": "x-agent-key"}'::jsonb,
  true,
  NOW()
) ON CONFLICT (id) DO NOTHING;
```

**Cómo ejecutar:**
1. Copiar el contenido a `migrations/kite_001_registries.sql`
2. Ejecutar en Supabase dev via SQL Editor: `bdwvrwzvsldephfibmuu.supabase.co`
   O via CLI: `supabase db push` (si el proyecto tiene Supabase CLI configurado)
3. Verificar: `SELECT * FROM registries;` — debe mostrar la fila 'wasiai'

---

### 3.2 `src/lib/supabase.ts` — CÓDIGO COMPLETO

```typescript
/**
 * Supabase Client — Singleton para operaciones server-side
 *
 * Usa SUPABASE_SERVICE_KEY (no anon key) para bypasear RLS.
 * Valida env vars en startup; falla con mensaje descriptivo si faltan (AC-8).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

function createSupabaseClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY

  if (!url || !key) {
    const missing = [
      !url ? 'SUPABASE_URL' : null,
      !key ? 'SUPABASE_SERVICE_KEY' : null,
    ]
      .filter(Boolean)
      .join(', ')

    console.error(`[FATAL] Missing required environment variables: ${missing}`)
    console.error('Set these variables in your .env file. See .env.example for reference.')
    process.exit(1)
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,  // servidor: no persistir sesión de usuario
      autoRefreshToken: false,
    },
  })
}

// Singleton — se instancia una vez al importar el módulo
export const supabase = createSupabaseClient()
```

---

### 3.3 `src/services/registry.ts` — CÓDIGO COMPLETO

```typescript
/**
 * Registry Service — Manages marketplace registrations
 *
 * WKH-7: Migrado de Map en memoria a Supabase PostgreSQL.
 * Todos los métodos son ahora async.
 *
 * IMPORTANTE: auth.value puede contener secrets.
 * NUNCA loguear el campo auth completo ni auth.value.
 */

import type { RegistryConfig, RegistrySchema, RegistryAuth } from '../types/index.js'
import { supabase } from '../lib/supabase.js'

// ── Tipo interno para filas de Supabase ─────────────────────

interface RegistryRow {
  id: string
  name: string
  discovery_endpoint: string
  invoke_endpoint: string
  agent_endpoint: string | null
  schema: RegistrySchema
  auth: RegistryAuth | null
  enabled: boolean
  created_at: string
}

// ── Helper: Row → RegistryConfig ────────────────────────────

function rowToRegistry(row: RegistryRow): RegistryConfig {
  return {
    id: row.id,
    name: row.name,
    discoveryEndpoint: row.discovery_endpoint,
    invokeEndpoint: row.invoke_endpoint,
    agentEndpoint: row.agent_endpoint ?? undefined,
    schema: row.schema,
    auth: row.auth ?? undefined,
    enabled: row.enabled,
    createdAt: new Date(row.created_at),
  }
}

// ── Helper: RegistryConfig → columnas para INSERT/UPDATE ────

function registryToRow(
  config: Omit<RegistryConfig, 'id' | 'createdAt'>,
  id: string,
): Omit<RegistryRow, 'created_at'> & { id: string } {
  return {
    id,
    name: config.name,
    discovery_endpoint: config.discoveryEndpoint,
    invoke_endpoint: config.invokeEndpoint,
    agent_endpoint: config.agentEndpoint ?? null,
    schema: config.schema,
    auth: config.auth ?? null,
    enabled: config.enabled,
  }
}

// ── Service ─────────────────────────────────────────────────

export const registryService = {
  /**
   * List all registries
   */
  async list(): Promise<RegistryConfig[]> {
    const { data, error } = await supabase
      .from('registries')
      .select('*')
      .order('created_at', { ascending: true })

    if (error) throw new Error(`Failed to list registries: ${error.message}`)

    return (data as RegistryRow[]).map(rowToRegistry)
  },

  /**
   * Get a specific registry by ID
   */
  async get(id: string): Promise<RegistryConfig | undefined> {
    const { data, error } = await supabase
      .from('registries')
      .select('*')
      .eq('id', id)
      .maybeSingle()

    if (error) throw new Error(`Failed to get registry '${id}': ${error.message}`)

    return data ? rowToRegistry(data as RegistryRow) : undefined
  },

  /**
   * Register a new marketplace
   * ID is generated from name (slug)
   */
  async register(config: Omit<RegistryConfig, 'id' | 'createdAt'>): Promise<RegistryConfig> {
    const id = config.name.toLowerCase().replace(/\s+/g, '-')

    const row = registryToRow(config, id)

    const { data, error } = await supabase
      .from('registries')
      .insert(row)
      .select()
      .single()

    if (error) {
      // PK violation = ya existe
      if (error.code === '23505') {
        throw new Error(`Registry '${id}' already exists`)
      }
      throw new Error(`Failed to register: ${error.message}`)
    }

    return rowToRegistry(data as RegistryRow)
  },

  /**
   * Update a registry (partial update)
   * ID cannot be changed
   */
  async update(id: string, updates: Partial<RegistryConfig>): Promise<RegistryConfig> {
    // Construir objeto de actualización con snake_case
    const updateRow: Partial<Omit<RegistryRow, 'id' | 'created_at'>> = {}

    if (updates.name !== undefined) updateRow.name = updates.name
    if (updates.discoveryEndpoint !== undefined) updateRow.discovery_endpoint = updates.discoveryEndpoint
    if (updates.invokeEndpoint !== undefined) updateRow.invoke_endpoint = updates.invokeEndpoint
    if (updates.agentEndpoint !== undefined) updateRow.agent_endpoint = updates.agentEndpoint ?? null
    if (updates.schema !== undefined) updateRow.schema = updates.schema
    if (updates.auth !== undefined) updateRow.auth = updates.auth ?? null
    if (updates.enabled !== undefined) updateRow.enabled = updates.enabled

    const { data, error } = await supabase
      .from('registries')
      .update(updateRow)
      .eq('id', id)
      .select()
      .single()

    if (error) {
      // PGRST116 = no rows matched
      if (error.code === 'PGRST116') {
        throw new Error(`Registry '${id}' not found`)
      }
      throw new Error(`Failed to update registry '${id}': ${error.message}`)
    }

    return rowToRegistry(data as RegistryRow)
  },

  /**
   * Delete a registry
   * Guard: 'wasiai' cannot be deleted
   */
  async delete(id: string): Promise<boolean> {
    if (id === 'wasiai') {
      throw new Error('Cannot delete the WasiAI registry')
    }

    const { data, error } = await supabase
      .from('registries')
      .delete()
      .eq('id', id)
      .select()

    if (error) throw new Error(`Failed to delete registry '${id}': ${error.message}`)

    // data es el array de filas eliminadas; si está vacío, no existía
    return Array.isArray(data) && data.length > 0
  },

  /**
   * Get all enabled registries
   */
  async getEnabled(): Promise<RegistryConfig[]> {
    const { data, error } = await supabase
      .from('registries')
      .select('*')
      .eq('enabled', true)
      .order('created_at', { ascending: true })

    if (error) throw new Error(`Failed to get enabled registries: ${error.message}`)

    return (data as RegistryRow[]).map(rowToRegistry)
  },
}
```

---

### 3.4 `src/routes/registries.ts` — Cambios exactos

Los cambios son **solo** los `await` faltantes. El resto del archivo no cambia.

**Diff aplicar:**

```diff
-    const registries = registryService.list()
+    const registries = await registryService.list()

-      const registry = registryService.get(id)
+      const registry = await registryService.get(id)

-        const registry = registryService.register({
+        const registry = await registryService.register({

-        const registry = registryService.update(id, body)
+        const registry = await registryService.update(id, body)

-        const deleted = registryService.delete(id)
+        const deleted = await registryService.delete(id)
```

**Archivo completo post-cambio** (para que el Dev copie directamente):

```typescript
/**
 * Registries Routes — CRUD for marketplace registrations
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { registryService } from '../services/registry.js'
import type { RegistrySchema, RegistryAuth } from '../types/index.js'

const registriesRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /registries
   * List all registered marketplaces
   */
  fastify.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
    const registries = await registryService.list()
    return reply.send({
      registries,
      total: registries.length,
    })
  })

  /**
   * GET /registries/:id
   * Get a specific registry
   */
  fastify.get(
    '/:id',
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params
      const registry = await registryService.get(id)

      if (!registry) {
        return reply.status(404).send({ error: 'Registry not found' })
      }

      return reply.send(registry)
    },
  )

  /**
   * POST /registries
   * Register a new marketplace
   */
  fastify.post(
    '/',
    async (
      request: FastifyRequest<{
        Body: {
          name: string
          discoveryEndpoint: string
          invokeEndpoint: string
          agentEndpoint?: string
          schema: RegistrySchema
          auth?: RegistryAuth
          enabled?: boolean
        }
      }>,
      reply: FastifyReply,
    ) => {
      try {
        const body = request.body

        // Validate required fields
        if (!body.name || !body.discoveryEndpoint || !body.invokeEndpoint || !body.schema) {
          return reply.status(400).send({
            error: 'Missing required fields: name, discoveryEndpoint, invokeEndpoint, schema',
          })
        }

        const registry = await registryService.register({
          name: body.name,
          discoveryEndpoint: body.discoveryEndpoint,
          invokeEndpoint: body.invokeEndpoint,
          agentEndpoint: body.agentEndpoint,
          schema: body.schema,
          auth: body.auth,
          enabled: body.enabled ?? true,
        })

        return reply.status(201).send(registry)
      } catch (err) {
        return reply.status(400).send({
          error: err instanceof Error ? err.message : 'Failed to register',
        })
      }
    },
  )

  /**
   * PATCH /registries/:id
   * Update a registry
   */
  fastify.patch(
    '/:id',
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: Record<string, unknown> }>,
      reply: FastifyReply,
    ) => {
      try {
        const { id } = request.params
        const body = request.body

        const registry = await registryService.update(id, body)
        return reply.send(registry)
      } catch (err) {
        return reply.status(400).send({
          error: err instanceof Error ? err.message : 'Failed to update',
        })
      }
    },
  )

  /**
   * DELETE /registries/:id
   * Delete a registry
   */
  fastify.delete(
    '/:id',
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const { id } = request.params
        const deleted = await registryService.delete(id)

        if (!deleted) {
          return reply.status(404).send({ error: 'Registry not found' })
        }

        return reply.send({ success: true })
      } catch (err) {
        return reply.status(400).send({
          error: err instanceof Error ? err.message : 'Failed to delete',
        })
      }
    },
  )
}

export default registriesRoutes
```

---

### 3.5 `.env.example` — Variables a añadir

Añadir al final del archivo `.env.example` existente:

```dotenv
# ─────────────────────────────────────────────────────────────
# Supabase — PostgreSQL persistencia
# SERVICE_KEY: usar service_role key (NO la anon key)
# Obtener en: Supabase Dashboard → Settings → API
# Dev project: bdwvrwzvsldephfibmuu.supabase.co
# ─────────────────────────────────────────────────────────────
SUPABASE_URL=https://bdwvrwzvsldephfibmuu.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key-here
```

**⚠️ NUNCA commitear el valor real de `SUPABASE_SERVICE_KEY` en el repositorio.**

---

## 4. Waves de Implementación

### Wave 0 — Precondiciones

**Quién:** Dev + operador Supabase
**Archivos:** `migrations/kite_001_registries.sql`

```bash
# 1. Crear directorio de migrations (si no existe)
mkdir -p migrations

# 2. Crear el archivo SQL con el contenido de sección 3.1
# (copiar desde sdd.md sección 3.1)

# 3. Ejecutar en Supabase dev
# Opción A — SQL Editor en dashboard:
#   https://supabase.com/dashboard/project/bdwvrwzvsldephfibmuu/editor
#   Pegar y ejecutar el contenido de kite_001_registries.sql

# 4. Verificar resultado
# SELECT * FROM registries;
# → debe retornar 1 fila: id='wasiai'
```

**Criterio de Done:** Tabla `registries` existe en Supabase dev y contiene el seed 'wasiai'.

---

### Wave 1 — Supabase Client Singleton

**Quién:** Dev
**Archivos:** `src/lib/supabase.ts`, `package.json`, `.env.example`, `.env`

```bash
# 1. Instalar dependencia
npm install @supabase/supabase-js

# 2. Verificar versión instalada (debe ser ≥2.39.0)
npm ls @supabase/supabase-js

# 3. Crear src/lib/supabase.ts
# (copiar código completo de sección 3.2)

# 4. Actualizar .env.example
# (añadir bloque de sección 3.5)

# 5. Configurar .env local con valores reales
# SUPABASE_URL=https://bdwvrwzvsldephfibmuu.supabase.co
# SUPABASE_SERVICE_KEY=<service_role_key del dashboard>
```

**Criterio de Done:** `import { supabase } from './lib/supabase.js'` compila sin errores.

---

### Wave 2 — Registry Service (async Supabase)

**Quién:** Dev
**Archivos:** `src/services/registry.ts`

```bash
# Reemplazar src/services/registry.ts con código completo de sección 3.3
# Verificar compilación: npx tsc --noEmit
```

**Criterio de Done:** `npx tsc --noEmit` pasa sin errores en `registry.ts`.

---

### Wave 3 — Routes (await async methods)

**Quién:** Dev
**Archivos:** `src/routes/registries.ts`

```bash
# Reemplazar src/routes/registries.ts con código completo de sección 3.4
# Verificar compilación: npx tsc --noEmit
```

**⚠️ OBLIGATORIO — también modificar `src/routes/discover.ts`:**

`discover.ts` llama `registryService.getEnabled()` — si se omite el `await`, el endpoint recibirá un `Promise<RegistryConfig[]>` en lugar del array real. Fallo silencioso en runtime, no error de compilación.

```typescript
// En src/routes/discover.ts — buscar esta línea:
const registries = registryService.getEnabled()
// Reemplazar con:
const registries = await registryService.getEnabled()
```

Archivos a modificar en Wave 3: `src/routes/registries.ts` + `src/routes/discover.ts`

**Criterio de Done:** `npx tsc --noEmit` pasa sin errores en todo el proyecto.

---

### Wave 4 — Verificación Build + Tests

**Quién:** Dev

```bash
# 1. Build completo
npm run build
# → debe compilar sin errores

# 2. Levantar servidor en modo dev
npm run dev
# → debe mostrar "Server running on http://localhost:3001"
# → NO debe mostrar "[FATAL] Missing required environment variables"

# 3. Smoke tests manuales (con curl o similar)

# AC-3: GET /registries → debe retornar 'wasiai' desde Supabase
curl http://localhost:3001/registries
# Esperado: { registries: [{ id: 'wasiai', ... }], total: 1 }

# AC-2: POST /registries → debe persistir en Supabase
curl -X POST http://localhost:3001/registries \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Test Registry",
    "discoveryEndpoint": "https://example.com/discover",
    "invokeEndpoint": "https://example.com/invoke/{slug}",
    "schema": {
      "discovery": { "queryParam": "q" },
      "invoke": { "method": "POST" }
    }
  }'
# Esperado: 201 + objeto con id='test-registry', createdAt real de DB

# AC-7: Reiniciar servidor → datos persisten
# Ctrl+C, npm run dev → GET /registries debe retornar ambos registros
```

**Criterio de Done:** Todos los ACs del work-item validados manualmente.

---

## 5. Constraint Directives

### OBLIGATORIO

1. **`@supabase/supabase-js` en `dependencies`** (no `devDependencies`) — se usa en runtime de producción.

2. **`SUPABASE_SERVICE_KEY` en env vars** — nunca hardcodeado en código. Si falta, el proceso debe terminar con `process.exit(1)` y mensaje descriptivo.

3. **`auth.value` NUNCA se loguea** — ni en `console.log`, ni en Fastify logger, ni en error messages. Si se necesita debug de auth, loguear solo `{ type, key }` y omitir `value`.

4. **Prefijo `kite_` en el nombre del archivo de migration** — el archivo debe llamarse `kite_001_registries.sql` (no `001_registries.sql`).

5. **Seed WasiAI en migration SQL** (no en código TypeScript) — la migration es la fuente de verdad del estado inicial de la BD.

6. **`ON CONFLICT (id) DO NOTHING`** en el seed de 'wasiai' — la migration debe ser idempotente y re-aplicable sin errores.

7. **Todos los métodos del service deben retornar `Promise<T>`** — `list()`, `get()`, `register()`, `update()`, `delete()`, `getEnabled()` son todos async.

8. **`discover.ts` también debe añadir `await`** a su llamada `registryService.getEnabled()` — aunque no está en el scope principal, es un caller del mismo service y fallará en runtime si no se actualiza.

9. **El cliente Supabase es un singleton** — no instanciar `createClient()` múltiples veces. Solo importar `supabase` desde `src/lib/supabase.ts`.

10. **`npm install @supabase/supabase-js` antes de Wave 2** — el service importa el cliente; sin la dependencia instalada, el build falla.

### PROHIBIDO

11. **PROHIBIDO** usar `SUPABASE_ANON_KEY` en el servidor — solo `SUPABASE_SERVICE_KEY` (service_role).

12. **PROHIBIDO** cambiar las firmas de los métodos del service más allá de hacerlos async — los tipos de parámetros y retorno deben permanecer idénticos.

13. **PROHIBIDO** loguear objetos `RegistryConfig` completos cuando contengan `auth` — filtrar el campo `auth.value` antes de cualquier log.

14. **PROHIBIDO** hardcodear datos del registro 'wasiai' en el código TypeScript — el seed está en la migration SQL.

15. **PROHIBIDO** aplicar esta migration en Supabase prod (`caldzjhjgctpgodldqav`) — solo en el proyecto dev (`bdwvrwzvsldephfibmuu`).

---

## 6. Readiness Check

### ¿El SDD es suficiente para que el Dev implemente sin preguntas?

| Pregunta que podría tener el Dev | Respuesta en el SDD |
|----------------------------------|---------------------|
| ¿Qué tabla creo en Supabase? | Sección 3.1: SQL completo y ejecutable |
| ¿Cómo creo el cliente Supabase? | Sección 3.2: código completo |
| ¿Qué variables de entorno necesito? | Sección 3.5 + constraint #2 |
| ¿Cómo mapeo snake_case ↔ camelCase? | Sección 3.3: helpers `rowToRegistry` y `registryToRow` |
| ¿Qué error retorna Supabase si hay PK duplicate? | Sección 3.3: `error.code === '23505'` |
| ¿Qué error si no encuentra la fila en update? | Sección 3.3: `error.code === 'PGRST116'` |
| ¿Cómo verifico que delete eliminó algo? | Sección 3.3: `Array.isArray(data) && data.length > 0` |
| ¿Necesito cambiar `discover.ts`? | Wave 3 + constraint #8 |
| ¿Cómo ejecuto la migration? | Wave 0: instrucciones paso a paso |
| ¿Qué pasa con `auth.value`? | ADR-6 + constraint #3 y #13 |
| ¿Dónde va el archivo SQL? | `migrations/kite_001_registries.sql` (constraint #4) |
| ¿En qué Supabase proyecto ejecuto la migration? | Dev: `bdwvrwzvsldephfibmuu` (constraint #15) |
| ¿`@supabase/supabase-js` va en deps o devDeps? | Constraint #1: `dependencies` |
| ¿Cuándo instalo la dependencia? | Wave 1, paso 1 |

**Veredicto: ✅ SDD completo.** El Dev puede implementar todas las waves sin preguntas bloqueantes.

Los únicos items operacionales externos al código son:
- Obtener la `SUPABASE_SERVICE_KEY` del dashboard de Supabase (requiere acceso al proyecto)
- Ejecutar la migration SQL en el dashboard (paso manual de Wave 0)

Ambos están documentados en el SDD con instrucciones claras.

---

SDD_COMPLETE_WKH7 — Listo para revisión
