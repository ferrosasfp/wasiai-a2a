# Work Item: WKH-7 — Supabase: Migrar registries de in-memory a PostgreSQL

| Campo        | Valor                                           |
|--------------|-------------------------------------------------|
| **ID**       | WKH-7                                           |
| **Tipo**     | Evolutivo — Persistencia de datos               |
| **Prioridad**| Alta (producción bloqueada sin esto)            |
| **Autor**    | Architect NexusAgile                            |
| **Fecha**    | 2026-04-01                                      |
| **Estado**   | READY FOR IMPLEMENTATION                        |

---

## 1. Contexto

`src/services/registry.ts` mantiene todos los registries de marketplaces en un `Map<string, RegistryConfig>` en memoria. Esto significa que **cada reinicio del servidor borra todos los registries** registrados por los usuarios. WasiAI es un producto de producción — se requiere persistencia real en Supabase PostgreSQL.

### F0 — Codebase Grounding

#### Métodos actuales de `registryService`

| Método | Firma | Descripción |
|--------|-------|-------------|
| `list` | `() → RegistryConfig[]` | Retorna todos los registries |
| `get` | `(id: string) → RegistryConfig \| undefined` | Busca por ID |
| `register` | `(config: Omit<RegistryConfig, 'id'\|'createdAt'>) → RegistryConfig` | Crea nuevo registry; ID = `name.toLowerCase().replace(/\s+/g, '-')` |
| `update` | `(id: string, updates: Partial<RegistryConfig>) → RegistryConfig` | Actualiza campos, no permite cambiar ID |
| `delete` | `(id: string) → boolean` | Elimina; lanza error si `id === 'wasiai'` |
| `getEnabled` | `() → RegistryConfig[]` | Filtra donde `enabled === true` |

#### Estructura completa de `RegistryConfig`

```typescript
interface RegistryConfig {
  id: string                   // PK, slug generado desde name
  name: string
  discoveryEndpoint: string
  invokeEndpoint: string       // template con {slug} o {agentId}
  agentEndpoint?: string       // opcional
  schema: RegistrySchema       // objeto anidado — se persiste como JSONB
  auth?: RegistryAuth          // opcional, contiene `value` sensible — JSONB
  enabled: boolean
  createdAt: Date              // → timestamp with time zone
}

interface RegistrySchema {
  discovery: {
    capabilityParam?: string
    queryParam?: string
    limitParam?: string
    maxPriceParam?: string
    agentsPath?: string
    agentMapping?: AgentFieldMapping  // { id, name, slug, description, capabilities, price, reputation }
  }
  invoke: {
    method: 'GET' | 'POST'
    inputField?: string
    resultPath?: string
  }
}

interface RegistryAuth {
  type: 'header' | 'query' | 'bearer'
  key: string
  value?: string   // ⚠️ dato sensible — persiste en JSONB cifrado o con RLS restrictivo
}
```

#### Referencias a Supabase en el proyecto actual

**Ninguna.** El `package.json` no incluye `@supabase/supabase-js`. No existe ningún archivo de cliente Supabase. Esta HU introduce Supabase desde cero.

---

## 2. Acceptance Criteria

| # | Condición | Resultado esperado |
|---|-----------|-------------------|
| AC-1 | WHEN el servidor arranca | THEN carga todos los registries desde Supabase (tabla `registries`) antes de servir requests |
| AC-2 | WHEN POST `/registries` | THEN persiste el nuevo registry en Supabase y retorna el objeto creado con `createdAt` real de la DB |
| AC-3 | WHEN GET `/registries` | THEN retorna registries desde Supabase (no desde Map en memoria) |
| AC-4 | WHEN PATCH `/registries/:id` | THEN actualiza el registro en Supabase y retorna el objeto actualizado |
| AC-5 | WHEN DELETE `/registries/:id` (id ≠ 'wasiai') | THEN elimina de Supabase y retorna 204 |
| AC-6 | WHEN el servidor arranca sin ningún registro en la tabla `registries` | THEN la migration SQL habrá insertado WasiAI como seed (idempotente) |
| AC-7 | WHEN el servidor se reinicia | THEN todos los registries persisten exactamente como estaban |
| AC-8 | IF `SUPABASE_URL` o `SUPABASE_SERVICE_KEY` no están en el entorno | THEN el proceso lanza error y termina con mensaje descriptivo antes de servir cualquier request |

---

## 3. Scope

### IN (archivos a crear/modificar)

| Archivo | Acción | Descripción |
|---------|--------|-------------|
| `supabase/migrations/20260401000000_registries.sql` | **NUEVO** | DDL + seed WasiAI |
| `src/services/db/client.ts` | **NUEVO** | SupabaseClient singleton con validación de env vars |
| `src/services/registry.ts` | **MODIFICAR** | Reemplazar Map con Supabase queries async |
| `src/routes/registries.ts` | **MODIFICAR** | Añadir await a todas las llamadas a registryService (list, get, register, update, delete, getEnabled son ahora async) |
| `src/services/registry.test.ts` | **NUEVO** | Tests de integración con Supabase mockeado: verificar que cada método llama la query correcta, seed WasiAI presente al arrancar |
| `.env.example` | **MODIFICAR** | Añadir `SUPABASE_URL` y `SUPABASE_SERVICE_KEY` |
| `package.json` | **MODIFICAR** | Añadir dependencia `@supabase/supabase-js` |

### OUT (no tocar)

| Archivo | Razón |
|---------|-------|
| ~~`src/routes/registries.ts`~~ | _(movido a Scope IN — ver arriba)_ |
| `src/routes/discover.ts` | Usa `registryService.getEnabled()` — sin cambio de contrato |
| `src/routes/compose.ts` | Sin cambio |
| `src/routes/orchestrate.ts` | Sin cambio |
| `src/index.ts` | Sin cambio (el startup de Supabase ocurre dentro de `registry.ts` o en `client.ts`) |

---

## 4. Diseño técnico

### 4.1 Migration SQL

**Archivo:** `supabase/migrations/20260401000000_registries.sql`

```sql
-- Migration: WKH-7 — Registries table
-- Estrategia de tipos:
--   schema: JSONB  (objeto anidado complejo RegistrySchema)
--   auth:   JSONB  (RegistryAuth con campo value sensible)
--   createdAt: TIMESTAMPTZ

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

-- Índice para queries frecuentes de enabled registries
CREATE INDEX IF NOT EXISTS idx_registries_enabled ON registries(enabled);

-- Seed WasiAI (idempotente)
INSERT INTO registries (
  id, name, discovery_endpoint, invoke_endpoint, agent_endpoint,
  schema, auth, enabled, created_at
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

**Decisión: seed en migration (no en código)**
- Idempotente: `ON CONFLICT (id) DO NOTHING` garantiza que no duplica en re-runs
- Operacional: el seed existe en la DB desde el primer deploy, independientemente de si el servidor ha arrancado
- Consistente con la convención de Supabase

### 4.2 SupabaseClient singleton

**Archivo:** `src/services/db/client.ts`

```typescript
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

function createSupabaseClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY

  if (!url || !key) {
    // AC-8: error descriptivo, falla hard en startup
    const missing = [
      !url && 'SUPABASE_URL',
      !key && 'SUPABASE_SERVICE_KEY',
    ].filter(Boolean).join(', ')
    
    console.error(`[FATAL] Missing required environment variables: ${missing}`)
    console.error('Set these variables in your .env file. See .env.example for reference.')
    process.exit(1)
  }

  return createClient(url, key, {
    auth: { persistSession: false },
  })
}

// Singleton — se instancia una vez al importar el módulo
export const supabase = createSupabaseClient()
```

**Notas de diseño:**
- `process.exit(1)` garantiza AC-8: no hay startup silencioso ni degradado
- `SERVICE_KEY` (no `ANON_KEY`) permite bypasear RLS para operaciones server-side
- `persistSession: false` porque es un cliente de servidor, no de browser
- Singleton evita múltiples conexiones de pool

### 4.3 Refactor de `registry.ts`

**Cambios de contrato:**
- Todos los métodos de `registryService` se vuelven `async`
- Los callers en `src/routes/registries.ts` ya hacen `await` (verificar al implementar)
- El Map en memoria se elimina completamente

**Mapeo de columnas SQL ↔ TypeScript:**

| Columna SQL | Campo TS | Notas |
|-------------|----------|-------|
| `id` | `id` | TEXT, PK |
| `name` | `name` | TEXT |
| `discovery_endpoint` | `discoveryEndpoint` | snake_case ↔ camelCase |
| `invoke_endpoint` | `invokeEndpoint` | |
| `agent_endpoint` | `agentEndpoint` | nullable |
| `schema` | `schema` | JSONB → objeto TS directo |
| `auth` | `auth` | JSONB → objeto TS, nullable |
| `enabled` | `enabled` | BOOLEAN |
| `created_at` | `createdAt` | TIMESTAMPTZ → `new Date(row.created_at)` |

**Función helper de mapeo (Row → RegistryConfig):**
```typescript
function rowToRegistry(row: Record<string, unknown>): RegistryConfig {
  return {
    id: row.id as string,
    name: row.name as string,
    discoveryEndpoint: row.discovery_endpoint as string,
    invokeEndpoint: row.invoke_endpoint as string,
    agentEndpoint: row.agent_endpoint as string | undefined,
    schema: row.schema as RegistrySchema,
    auth: row.auth as RegistryAuth | undefined,
    enabled: row.enabled as boolean,
    createdAt: new Date(row.created_at as string),
  }
}
```

**Pseudocódigo de cada método refactorizado:**

```typescript
// list(): SELECT * FROM registries
// get(id): SELECT * FROM registries WHERE id = $1
// register(config): INSERT INTO registries (...) VALUES (...) RETURNING *
//   - ID sigue siendo name.toLowerCase().replace(/\s+/g, '-')
//   - Lanza error si INSERT falla por conflicto de PK (registry ya existe)
// update(id, updates): UPDATE registries SET ... WHERE id = $1 RETURNING *
//   - Lanza error si rowCount === 0 (no encontrado)
// delete(id): DELETE FROM registries WHERE id = $1
//   - Guard: if id === 'wasiai' throw error (igual que ahora)
// getEnabled(): SELECT * FROM registries WHERE enabled = true
```

### 4.4 Dependencia nueva

```bash
npm install @supabase/supabase-js
```

Verificar compatibilidad ESM: el proyecto usa `"type": "module"`. `@supabase/supabase-js` v2 es compatible con ESM nativo. Verificar con `npm ls @supabase/supabase-js` que la versión instalada es ≥2.39.0.

Añadir a `package.json` en `dependencies` (no devDependencies — se usa en runtime de producción).

### 4.5 `.env.example` — adiciones

```dotenv
# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key
```

---

## 5. Decisiones de diseño documentadas

### ¿Por qué JSONB para `schema` y `auth`?

`RegistrySchema` y `RegistryAuth` son objetos anidados con campos opcionales. Normalizar esto en tablas relacionales agregaría 3-4 tablas adicionales y JOINs sin beneficio real (nunca se filtra por campos internos de schema). JSONB permite:
- Persistir el objeto tal cual sin transformación destructiva
- Consultas con operadores `->` si en el futuro se necesita
- Zero-cost serialization/deserialization vía Supabase JS client

### ¿Por qué `SUPABASE_SERVICE_KEY` y no `ANON_KEY`?

Este es un servicio backend. Necesita acceso total a la tabla `registries` sin restricciones de RLS. La `ANON_KEY` está diseñada para clientes de browser con políticas RLS. Usar `SERVICE_KEY` es el patrón correcto para server-side.

### ¿Por qué el seed en migration y no en código?

- **Idempotencia garantizada**: la migration se ejecuta una vez por Supabase, el `ON CONFLICT DO NOTHING` protege contra re-runs
- **Estado de DB independiente del código**: si el servidor nunca arranca (error de config), el seed ya está en la DB
- **Operacional**: los DBAs pueden ver el estado inicial directamente en las migrations

### ¿Por qué `process.exit(1)` en lugar de throw?

En la inicialización top-level (imports de módulo ES), un `throw` no siempre produce un error visible y puede causar comportamientos undefined. `process.exit(1)` con `console.error` descriptivo garantiza que el operador sepa exactamente qué falta, y el proceso no queda en estado zombie.

---

## 6. Plan de implementación

| Paso | Archivo | Tarea |
|------|---------|-------|
| 1 | `package.json` | `npm install @supabase/supabase-js` |
| 2 | `supabase/migrations/20260401000000_registries.sql` | Precondición: Crear directorio supabase/migrations/ si no existe: `mkdir -p supabase/migrations`. Luego crear migration con DDL + seed |
| 3 | `src/services/db/client.ts` | Crear singleton con validación de env |
| 4 | `src/services/registry.ts` | Reemplazar Map con Supabase async queries |
| 5 | `.env.example` | Añadir vars de Supabase |
| 6 | Local test | `npm run dev` con vars reales → verificar ACs 1-8 |

### Precondiciones antes de implementar

- [ ] `SUPABASE_URL` y `SUPABASE_SERVICE_KEY` disponibles en el entorno de dev
- [ ] Migration aplicada en el proyecto Supabase (`supabase db push` o dashboard)
- [ ] Verificar que `src/routes/registries.ts` ya usa `await` en sus calls a `registryService`

---

## 7. Riesgos y mitigaciones

| Riesgo | Probabilidad | Impacto | Mitigación |
|--------|-------------|---------|------------|
| Routes no usan `await` en calls a registryService | Media | Alto | Revisar `src/routes/registries.ts` como primer paso del impl |
| `auth.value` expuesto en logs | Baja | Alto | No loguear el objeto `auth` completo en ningún nivel |
| Migration no aplicada en prod antes del deploy | Media | Alto | CI/CD debe ejecutar `supabase db push` antes del deploy del servicio |
| Pool exhaustion si se crean múltiples clientes | Baja | Media | Patrón singleton en `client.ts` lo previene |

---

F1_COMPLETE_V2 — 4 correcciones aplicadas por Requirements Reviewer
