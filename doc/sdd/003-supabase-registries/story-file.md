# Story File — WKH-7: Supabase — Migrar registries de in-memory a PostgreSQL

## Contexto

`src/services/registry.ts` mantiene todos los registries en un `Map<string, RegistryConfig>` en RAM. Cada reinicio del servidor borra todos los registries registrados por usuarios — WasiAI gateway queda ciego tras cada deploy. Esta HU migra el storage a Supabase PostgreSQL (proyecto dev: `bdwvrwzvsldephfibmuu.supabase.co`) con persistencia real.

El cambio central es: todos los métodos de `registryService` pasan de síncronos a `async`. El contrato HTTP (endpoints, responses) no cambia. El registro 'wasiai' deja de estar hardcodeado en el módulo y pasa al seed SQL de la migration. Dos archivos de routes requieren `await` en sus llamadas al service.

---

## Branch

```
feat/wkh-7-supabase-registries
```
Base: `main`

> ⚠️ Este trabajo es evolutivo de WasiAI, NO del hackathon Kite. Branch base es `main`, no `feat/kite-hack`.

---

## Archivos a crear/modificar

| Archivo | Acción |
|---------|--------|
| `supabase/migrations/20260401000000_kite_registries.sql` | CREAR — DDL + seed WasiAI |
| `src/lib/supabase.ts` | CREAR — singleton SupabaseClient |
| `src/services/registry.ts` | REEMPLAZAR — async Supabase queries |
| `src/routes/registries.ts` | REEMPLAZAR — añadir await en todas las calls |
| `src/routes/discover.ts` | MODIFICAR — añadir await a `getEnabled()` |
| `.env.example` | MODIFICAR — añadir vars Supabase |
| `package.json` | MODIFICAR — añadir `@supabase/supabase-js` a dependencies |

---

## Implementación Wave por Wave

---

### Wave 0: supabase/migrations/ — SQL completo

Crea el directorio y el archivo:

```bash
mkdir -p supabase/migrations
```

Crea `supabase/migrations/20260401000000_kite_registries.sql` con este contenido exacto:

```sql
-- ============================================================
-- Migration: 20260401000000_kite_registries
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
-- auth.value NO se incluye aquí — configurar manualmente en Supabase dashboard
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

Ejecuta la migration en Supabase dev:
- Abre: https://supabase.com/dashboard/project/bdwvrwzvsldephfibmuu/editor
- Pega el contenido completo del SQL y ejecuta
- Verifica con: `SELECT * FROM registries;` → debe retornar 1 fila con `id = 'wasiai'`

---

### Wave 1: src/lib/supabase.ts — CÓDIGO COMPLETO

Primero instala la dependencia:

```bash
npm install @supabase/supabase-js
```

Verifica que sea ≥2.39.0:
```bash
npm ls @supabase/supabase-js
```

Añade al final de `.env.example`:

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

Configura tu `.env` local con los valores reales (obtener `SUPABASE_SERVICE_KEY` desde Supabase Dashboard → Settings → API → service_role).

Crea `src/lib/supabase.ts` con este contenido exacto:

```typescript
/**
 * Supabase Client — Singleton para operaciones server-side
 *
 * Usa SUPABASE_SERVICE_KEY (no anon key) para bypasear RLS.
 * Valida env vars en startup; falla con mensaje descriptivo si faltan.
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

### Wave 2: src/services/registry.ts — CÓDIGO COMPLETO

Reemplaza `src/services/registry.ts` con este contenido exacto:

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

### Wave 3: src/routes/registries.ts + src/routes/discover.ts — cambios exactos

#### 3A — Reemplaza `src/routes/registries.ts` completo:

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

#### 3B — Modifica `src/routes/discover.ts` (cambio obligatorio):

Busca en el archivo la línea:

```typescript
const registries = registryService.getEnabled()
```

Reemplázala con:

```typescript
const registries = await registryService.getEnabled()
```

⚠️ Este cambio es obligatorio. Sin el `await`, `registries` recibirá un `Promise<RegistryConfig[]>` en lugar del array real. El bug es silencioso en runtime — no lanza error de compilación, pero el discovery no encontrará ningún agente.

---

### Wave 4: Verificación build + tests

```bash
# 1. TypeScript — sin errores de compilación
npx tsc --noEmit

# 2. Build completo
npm run build

# 3. Levantar en dev (verificar que no hay FATAL por env vars)
npm run dev
# Debe mostrar: "Server running on http://localhost:3001"
# NO debe mostrar: "[FATAL] Missing required environment variables"
```

---

## Verificación por Wave (comandos exactos)

### Wave 0 — Verificar tabla y seed en Supabase
```sql
-- En SQL Editor de Supabase dashboard:
SELECT id, name, enabled, created_at FROM registries;
-- Resultado esperado: 1 fila, id='wasiai', enabled=true
```

### Wave 1 — Verificar dependencia instalada
```bash
npm ls @supabase/supabase-js
# Resultado esperado: @supabase/supabase-js@2.x.x (≥2.39.0)
```

### Wave 2 — Verificar compilación del service
```bash
npx tsc --noEmit 2>&1 | grep registry
# Resultado esperado: sin output (sin errores)
```

### Wave 3 — Verificar compilación de routes
```bash
npx tsc --noEmit
# Resultado esperado: exit 0, sin errores
```

### Wave 4 — Smoke tests manuales
```bash
# AC-3: GET /registries → datos desde Supabase
curl http://localhost:3001/registries
# Esperado: { "registries": [{ "id": "wasiai", ... }], "total": 1 }

# AC-2: POST /registries → persiste en Supabase
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
# Ctrl+C → npm run dev → GET /registries debe retornar ambos registros

# AC-5: DELETE (id ≠ wasiai)
curl -X DELETE http://localhost:3001/registries/test-registry
# Esperado: { "success": true }

# AC-5b: DELETE wasiai → debe rechazar
curl -X DELETE http://localhost:3001/registries/wasiai
# Esperado: 400 + error "Cannot delete the WasiAI registry"

# AC-8: Verificar fallo con env vars ausentes
# En .env, comentar SUPABASE_URL → npm run dev
# Esperado: "[FATAL] Missing required environment variables: SUPABASE_URL" + exit 1
```

---

## Acceptance Criteria (8 ACs EARS)

| # | Formato EARS | Criterio |
|---|-------------|---------|
| AC-1 | WHEN llega cualquier request a `/registries` o `/discover` | THEN los datos provienen de Supabase PostgreSQL; ningún dato viene de Map en memoria |
| AC-2 | WHEN POST `/registries` con payload válido | THEN el nuevo registry persiste en Supabase y la response incluye `createdAt` real de la DB |
| AC-3 | WHEN GET `/registries` | THEN retorna el array de registries desde Supabase, incluyendo 'wasiai' del seed |
| AC-4 | WHEN PATCH `/registries/:id` con campos a actualizar | THEN el registro se actualiza en Supabase y la response refleja los nuevos valores |
| AC-5 | WHEN DELETE `/registries/:id` con id ≠ 'wasiai' | THEN el registro se elimina de Supabase y retorna `{ success: true }` |
| AC-6 | WHEN el servidor arranca con la tabla vacía | THEN la migration SQL ya habrá insertado WasiAI como seed (idempotente con ON CONFLICT DO NOTHING) |
| AC-7 | WHEN el servidor se reinicia | THEN todos los registries persisten exactamente como estaban antes del reinicio |
| AC-8 | IF `SUPABASE_URL` o `SUPABASE_SERVICE_KEY` no están en el entorno | THEN el proceso termina con `process.exit(1)` y mensaje "[FATAL] Missing required environment variables: <nombre>" antes de servir cualquier request |

---

## Prohibiciones

1. **NO** usar `SUPABASE_ANON_KEY` — solo `SUPABASE_SERVICE_KEY` (service_role key)
2. **NO** hardcodear datos del registro 'wasiai' en código TypeScript — el seed está en la migration SQL
3. **NO** loguear el objeto `auth` completo ni `auth.value` — si se necesita debug, usar solo `{ type, key }`
4. **NO** instanciar `createClient()` más de una vez — importar siempre `supabase` desde `src/lib/supabase.ts`
5. **NO** cambiar las firmas de los métodos del service más allá de hacerlos `async`
6. **NO** aplicar la migration en Supabase prod (`caldzjhjgctpgodldqav`) — solo en dev (`bdwvrwzvsldephfibmuu`)
7. **NO** agregar `@supabase/supabase-js` a `devDependencies` — va en `dependencies` (runtime de producción)
8. **NO** omitir el `await` en `discover.ts` — fallo silencioso que rompe el discovery en runtime

---

## Definition of Done (checklist)

- [ ] `supabase/migrations/20260401000000_kite_registries.sql` creado y ejecutado en Supabase dev
- [ ] `SELECT * FROM registries` retorna fila 'wasiai' en Supabase dashboard
- [ ] `@supabase/supabase-js` en `dependencies` de `package.json` (versión ≥2.39.0)
- [ ] `src/lib/supabase.ts` creado con singleton y validación de env vars
- [ ] `.env.example` actualizado con `SUPABASE_URL` y `SUPABASE_SERVICE_KEY`
- [ ] `.env` local configurado con valores reales (no commiteado)
- [ ] `src/services/registry.ts` reemplazado — todos los métodos son `async`, sin Map en memoria
- [ ] `src/routes/registries.ts` reemplazado — todas las calls a registryService tienen `await`
- [ ] `src/routes/discover.ts` modificado — `getEnabled()` tiene `await`
- [ ] `npx tsc --noEmit` pasa sin errores
- [ ] `npm run build` pasa sin errores
- [ ] `npm run dev` arranca sin `[FATAL]` con las env vars configuradas
- [ ] GET `/registries` retorna datos desde Supabase (no Map)
- [ ] POST `/registries` persiste en Supabase y `createdAt` es timestamp real
- [ ] Reinicio del servidor conserva todos los registries (AC-7 verificado)
- [ ] DELETE 'wasiai' retorna error 400 (guard activo)
- [ ] Sin `SUPABASE_URL` → proceso termina con mensaje descriptivo (AC-8 verificado)
