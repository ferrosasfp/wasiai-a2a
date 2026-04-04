# SDD #013 — WKH-14 Schema Transform

**Status:** SPEC_APPROVED  
**Branch:** feat/wkh-14-schema-transform  
**Fecha:** 2026-04-04

---

## Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `src/services/compose.ts` | Punto de integración principal | Patrón objeto-servicio `{ async method() {} }`, import types de `../types/index.js`, importa supabase singleton |
| `src/services/orchestrate.ts` | Ejemplo de servicio con LLM | Mismo patrón objeto-servicio; sin llm propio (usa import de planner) |
| `src/lib/supabase.ts` | Cliente Supabase singleton | Export `supabase`, patrón singleton con `createClient` |
| `src/types/index.ts` | Tipos del proyecto | Secciones con comentario `// ══ SECTION ══`, interfaces con JSDoc |
| `src/services/compose.ts` (compose loop) | Donde se integra transform | Loop `for (let i=0; i<steps.length; i++)`, preparación de input antes de invokeAgent |

### Exemplars

| Para crear/modificar | Seguir patrón de | Razón |
|---------------------|------------------|-------|
| `src/services/llm/transform.ts` (nuevo) | Patrón Anthropic de `planner.ts` en feat/wkh-10-llm-planner | Misma estructura: MODEL const, AbortController timeout, JSON parse del LLM |
| Integración en `src/services/compose.ts` | Código existente del loop de compose | Mismo estilo inline, no extraer helper separado |
| Nuevos tipos en `src/types/index.ts` | Secciones existentes con `// ══ ══` y JSDoc | Consistencia en nomenclatura |
| Migration SQL | Tablas `a2a_*` en project-context.md | Mismo DDL style; esta usa prefijo `kite_` |

### Estado de BD relevante

| Tabla | Existe | Columnas relevantes |
|-------|--------|---------------------|
| `kite_schema_transforms` | **No** (crear vía migration) | sourceAgentId, targetAgentId, transformFn, hitCount |
| `a2a_transform_cache` | Existe según project-context | source_schema_hash, target_schema_hash, transform_template — NO confundir con la nuestra |

### Componentes reutilizables encontrados
- `supabase` singleton en `src/lib/supabase.ts` — usar directamente
- `composeService` en `src/services/compose.ts` — integrar transform ahí

---

## SDD (Full)

### Qué se construye

Un servicio `transformSchema` que:
1. Recibe el output de step N y el inputSchema de step N+1
2. Verifica compatibilidad (heurística simple: si el output ya tiene todas las keys requeridas, es compatible)
3. Si incompatible: llama a Claude Sonnet para generar una función JS de transformación
4. Cachea la función en `kite_schema_transforms` keyed por (sourceAgentId, targetAgentId)
5. En cache hit: recupera y aplica la función sin LLM
6. Se integra en `composeService.compose` entre steps
7. Expone `cacheHit` en `StepResult.metadata`

### Arquitectura

```
composeService.compose (loop)
    │
    ├─ [step i] invokeAgent → output
    │
    ├─ [i < last] transformService.maybeTransform(
    │       sourceAgentId, targetAgentId,
    │       output, nextAgent.inputSchema
    │   )
    │       ├─ checkCompatible(output, inputSchema)
    │       │       └─ compatible? → return output as-is, cacheHit: 'SKIPPED'
    │       ├─ supabase.kite_schema_transforms lookup
    │       │       └─ hit? → eval transformFn, apply, cacheHit: true, <50ms
    │       └─ miss? → LLM generateTransformFn
    │               ├─ validate JSON
    │               ├─ supabase.insert (upsert)
    │               └─ apply, cacheHit: false, ~2s
    │
    └─ [step i+1] invokeAgent(transformedOutput)
```

### Archivos a crear/modificar

| Archivo | Acción | Descripción |
|---------|--------|-------------|
| `src/services/llm/transform.ts` | CREAR | `transformSchema` function + cache logic |
| `src/services/compose.ts` | MODIFICAR | Integrar transform entre steps |
| `src/types/index.ts` | MODIFICAR | Añadir `SchemaTransform`, `TransformCacheEntry` types + `cacheHit` en StepResult |
| `supabase/migrations/kite_schema_transforms.sql` | CREAR | DDL tabla Supabase |
| `src/services/llm/transform.test.ts` | CREAR | Tests unitarios |

### Diseño detallado: `src/services/llm/transform.ts`

```typescript
// Patrón: mismo que planner — modelo, timeout, AbortController
const MODEL = 'claude-sonnet-4-20250514'
const TIMEOUT_MS = 30_000

export interface TransformResult {
  transformedOutput: unknown
  cacheHit: boolean | 'SKIPPED'  // SKIPPED = schemas compatibles, no transformación necesaria
  latencyMs: number
}

/**
 * Detecta si output ya satisface el inputSchema esperado.
 * Heurística: si inputSchema define "required" fields, verificar que todos existen en output.
 * Si no hay inputSchema → compatible siempre.
 */
function isCompatible(output: unknown, inputSchema: Record<string, unknown> | undefined): boolean

/**
 * Genera (o recupera del cache) una función de transformación JS,
 * la aplica al output y retorna el resultado.
 */
export async function maybeTransform(
  sourceAgentId: string,
  targetAgentId: string,
  output: unknown,
  inputSchema: Record<string, unknown> | undefined,
): Promise<TransformResult>
```

### Cache strategy

No hay Redis en el proyecto. Cache en dos niveles:
1. **L1 In-memory**: `Map<string, string>` (key = `${sourceAgentId}:${targetAgentId}`). Vive mientras el proceso está corriendo.
2. **L2 Supabase** (`kite_schema_transforms`): Persistente entre reinicios. Columna `transform_fn TEXT`.

Lookup: L1 → L2 → LLM → persist L2 → update L1.

### DDL tabla

```sql
-- Migration: kite_schema_transforms
CREATE TABLE IF NOT EXISTS kite_schema_transforms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_agent_id TEXT NOT NULL,
  target_agent_id TEXT NOT NULL,
  transform_fn TEXT NOT NULL,
  hit_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(source_agent_id, target_agent_id)
);
```

### Integración en compose.ts

En el loop, después de obtener `output` del step i y antes de preparar input del step i+1:

```typescript
// Si hay step siguiente y el agente tiene inputSchema
if (i < steps.length - 1 && agent.metadata?.inputSchema) {
  const tr = await maybeTransform(
    agent.id,
    nextAgent.id,
    output,
    agent.metadata.inputSchema as Record<string, unknown>,
  )
  result.cacheHit = tr.cacheHit
  lastOutput = tr.transformedOutput
} else {
  lastOutput = output
}
```

### Modificaciones a StepResult

```typescript
export interface StepResult {
  agent: Agent
  output: unknown
  costUsdc: number
  latencyMs: number
  txHash?: string
  cacheHit?: boolean | 'SKIPPED'   // ← nuevo
  transformLatencyMs?: number        // ← nuevo
}
```

---

## Constraint Directives

### OBLIGATORIO seguir
- Patrón de módulo LLM: seguir exactamente la estructura de `planner.ts` (MODEL const, AbortController, try/finally, JSON.parse)
- Import style: `from '../../lib/supabase.js'` (con .js extension — ESM)
- No dependencias nuevas — usar `@anthropic-ai/sdk` ya instalado y `@supabase/supabase-js` ya instalado
- La función `transformFn` que genera el LLM es código JavaScript como string. Se aplica con `new Function('output', transformFn)(output)` — NO eval() directo

### PROHIBIDO
- NO usar Redis (no está instalado)
- NO modificar `/orchestrate` ni discovery
- NO modificar archivos fuera de Scope IN
- NO agregar dependencias nuevas (ni ioredis ni nada)
- NO hardcodear IDs ni schemas
- NO usar `any` explícito
- NO exportar la función `new Function()` — solo ejecutar localmente en el servicio

---

## Readiness Check

```
READINESS CHECK:
[x] Cada AC tiene al menos 1 archivo asociado en la tabla de archivos
[x] Cada archivo tiene un Exemplar válido (verificado)
[x] No hay [NEEDS CLARIFICATION] pendientes
[x] Constraint Directives incluyen al menos 3 PROHIBIDO
[x] Context Map tiene al menos 2 archivos leídos
[x] Scope IN y OUT son explícitos
[x] Si hay BD: tablas verificadas (kite_schema_transforms NO existe → crear)
```
