# Story File #013 — WKH-14 Schema Transform

> **Dev: lee SOLO este documento. No el SDD, no el work-item.**
> Si algo no está claro, escalar al Architect — NO inventar.

---

## Goal

Cuando el output de step N en un pipeline `compose` no coincide con el inputSchema de step N+1, Claude transforma el payload automáticamente. La transformación se cachea (in-memory + Supabase `kite_schema_transforms`) para que la segunda llamada al mismo par de agentes sea <50ms en vez de ~2s.

---

## Acceptance Criteria

| # | Criterio |
|---|----------|
| AC1 | WHEN el output de step N es incompatible con el inputSchema de step N+1, THEN `maybeTransform` SHALL generar una función JS que mapea el payload |
| AC2 | WHEN `maybeTransform` se llama con schemas ya cacheados, THEN SHALL retornar la transformación sin llamar al LLM en <50ms |
| AC3 | WHEN la transformación se genera (cache miss), THEN SHALL persistirse en `kite_schema_transforms` |
| AC4 | WHEN el output de step N es compatible con el inputSchema de step N+1, THEN SHALL pasar el output directo sin transformar (`cacheHit: 'SKIPPED'`) |
| AC5 | WHEN `composeService.compose` devuelve el resultado, THEN cada `StepResult` SHALL incluir `cacheHit` |
| AC6 | IF la transformación LLM falla, THEN SHALL propagar error con mensaje descriptivo |

---

## Files to Modify/Create

| Archivo | Acción | Exemplar |
|---------|--------|----------|
| `src/services/llm/transform.ts` | CREAR | Patrón Anthropic: ver sección Exemplars abajo |
| `src/services/compose.ts` | MODIFICAR | Existente en repo |
| `src/types/index.ts` | MODIFICAR | Sección `COMPOSE TYPES` existente |
| `supabase/migrations/kite_schema_transforms.sql` | CREAR | DDL directo |
| `src/services/llm/transform.test.ts` | CREAR | Patrón vitest de `src/services/compose.test.ts` |

---

## Exemplars

### Patrón LLM (para transform.ts)

Extraído de `orchestrate.ts` + patrón `@anthropic-ai/sdk`:

```typescript
import Anthropic from '@anthropic-ai/sdk'

const MODEL = 'claude-sonnet-4-20250514'
const TIMEOUT_MS = 30_000

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const controller = new AbortController()
const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS)

try {
  const response = await client.messages.create(
    {
      model: MODEL,
      max_tokens: 512,
      system: '...',
      messages: [{ role: 'user', content: '...' }],
    },
    { signal: controller.signal },
  )
  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('')
    .trim()
  const parsed = JSON.parse(text) as Record<string, unknown>
  // use parsed
} finally {
  clearTimeout(timeoutId)
}
```

### Patrón Supabase (upsert)

```typescript
import { supabase } from '../../lib/supabase.js'

// SELECT
const { data } = await supabase
  .from('kite_schema_transforms')
  .select('transform_fn, hit_count')
  .eq('source_agent_id', sourceAgentId)
  .eq('target_agent_id', targetAgentId)
  .single()

// UPSERT
await supabase
  .from('kite_schema_transforms')
  .upsert({
    source_agent_id: sourceAgentId,
    target_agent_id: targetAgentId,
    transform_fn: transformFn,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'source_agent_id,target_agent_id' })

// INCREMENT hit_count
await supabase.rpc('increment_transform_hits', {
  p_source: sourceAgentId,
  p_target: targetAgentId,
})
// Si rpc no está disponible, usar update directamente:
await supabase
  .from('kite_schema_transforms')
  .update({ hit_count: (data.hit_count ?? 0) + 1, updated_at: new Date().toISOString() })
  .eq('source_agent_id', sourceAgentId)
  .eq('target_agent_id', targetAgentId)
```

### Patrón composeService (loop existente — NO reemplazar, insertar en él)

El loop actual en `src/services/compose.ts`:
```typescript
for (let i = 0; i < steps.length; i++) {
  // ... resolve agent, check budget ...
  const input = step.passOutput && lastOutput
    ? { ...step.input, previousOutput: lastOutput }
    : step.input
  
  // invokeAgent
  const { output, txHash } = await this.invokeAgent(agent, input)
  // ...
  results.push(result)
  lastOutput = output   // ← AQUÍ insertar transform si hay step siguiente
}
```

Después de `lastOutput = output`, agregar:
```typescript
// Schema transform — si hay step siguiente con inputSchema
if (i < steps.length - 1) {
  const nextStep = steps[i + 1]
  const nextAgent = await this.resolveAgent(nextStep)
  const inputSchema = nextAgent?.metadata?.inputSchema as Record<string, unknown> | undefined
  if (inputSchema) {
    const tr = await maybeTransform(
      agent.id,
      nextAgent!.id,
      lastOutput,
      inputSchema,
    )
    result.cacheHit = tr.cacheHit
    result.transformLatencyMs = tr.latencyMs
    lastOutput = tr.transformedOutput
  }
}
```

---

## Waves

### W0 (serial) — Infraestructura

1. Crear `supabase/migrations/kite_schema_transforms.sql`
2. Añadir tipos `SchemaTransform`, `TransformCacheEntry` y campos `cacheHit?`, `transformLatencyMs?` en `src/types/index.ts`

### W1 (principal) — Implementación transform.ts

3. Crear `src/services/llm/transform.ts` completo

### W2 — Integración y tests

4. Modificar `src/services/compose.ts` para usar `maybeTransform`
5. Crear `src/services/llm/transform.test.ts`
6. Verificar: `npm run build` + `npm test`

---

## Constraint Directives

### OBLIGATORIO
- Import con `.js` extension: `from '../../lib/supabase.js'`
- MODEL = `'claude-sonnet-4-20250514'`
- Usar `new Function('output', fn)(output)` para aplicar transformFn — NO `eval()`
- Cache L1 = `Map<string, string>` en módulo scope (fuera de la función exportada)
- TypeScript strict: no `any` explícito

### PROHIBIDO
- NO usar Redis ni instalar nuevas dependencias
- NO modificar archivos fuera de los listados
- NO exportar el `new Function` helper
- NO tocar `/orchestrate`, `/discover`, pagos x402
- NO `eval()` directo
- NO hardcodear agent IDs

---

## Test Expectations

| Test | AC cubre | Método |
|------|----------|--------|
| T-1: cache miss → llama LLM → guarda en Supabase | AC1, AC3 | mock Anthropic + mock supabase |
| T-2: cache hit (L1) → no llama LLM | AC2 | mock supabase, pre-seed L1 |
| T-3: cache hit (L2 Supabase) → no llama LLM | AC2 | mock supabase devuelve fn |
| T-4: schemas compatibles → SKIPPED | AC4 | sin mock LLM ni supabase |
| T-5: LLM error → propaga error | AC6 | mock LLM que throws |

---

## Out of Scope

- Redis
- Endpoint HTTP propio para transform
- Schema inference para marketplaces sin A2A
- Modificar `orchestrate.ts`
- UI

---

## Escalation Rule

Si algo no está en este Story File, Dev PARA y pregunta al Architect. No inventar.
