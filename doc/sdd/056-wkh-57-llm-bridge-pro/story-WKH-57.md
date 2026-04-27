# Story File — WKH-57 LLM Bridge Pro

> **F2.5 Output (Architect)** — Self-contained contract for Dev (F3).
> Si algo no está acá, NO se hace.

---

## Header

| Campo | Valor |
|-------|-------|
| **HU ID** | WKH-57 |
| **Título** | LLM Bridge Pro — Model Selector + Verification + Cache Fingerprint + Telemetry |
| **Tipo** | feature |
| **SDD_MODE** | full |
| **Branch** | `feat/056-wkh-57-llm-bridge-pro` |
| **Branch base** | `main` (post-WKH-56 merge — PR #28 mergeado; commits con `BridgeType` en `src/types/index.ts:577-582` y `src/services/a2a-protocol.ts` disponibles) |
| **SDD source** | `doc/sdd/056-wkh-57-llm-bridge-pro/sdd.md` |
| **Work item** | `doc/sdd/056-wkh-57-llm-bridge-pro/work-item.md` |
| **Gates aprobados** | HU_APPROVED 2026-04-26 ✓ + SPEC_APPROVED 2026-04-26 ✓ |
| **ACs** | 8 (AC-1..AC-8 en SDD §2.1) |
| **Estimación** | L (~14-18 nuevos tests + 6 commits) |

---

## 1. Anti-Hallucination Protocol

### 1.1 Archivos PERMITIDOS modificar (Scope IN)

**MODIFICAR (existentes):**
- `src/services/llm/transform.ts`
- `src/services/compose.ts`
- `src/types/index.ts`
- `src/services/llm/transform.test.ts` (solo ajustes mínimos de assertion shape — NO REMOVER tests)
- `src/services/compose.test.ts` (extender con 1-2 tests para AC-6)

**CREAR (nuevos):**
- `src/services/llm/pricing.ts`
- `src/services/llm/canonical-json.ts`
- `src/services/llm/select-model.ts`
- `src/services/llm/__tests__/transform-verification.test.ts`
- `supabase/migrations/20260426120000_kite_schema_transforms_schema_hash.sql`

### 1.2 Archivos PROHIBIDOS tocar (Scope OUT)

- `src/lib/downstream-payment.ts` (WKH-55 DONE)
- `src/services/orchestrate.ts` (JSON-RPC distinto, no involucrado)
- `src/services/a2a-protocol.ts` (WKH-56 DONE — solo IMPORTAR `BridgeType`, NO modificar)
- `src/services/registry.ts`, `src/services/discovery.ts` (sin cambios)
- `src/routes/*` (CD-4: ningún endpoint nuevo)
- `src/services/event.ts` (NO modificar firma de `track()` — los nuevos campos viajan dentro de `metadata: Record<string,unknown>` que ya es flexible)
- `supabase/migrations/kite_schema_transforms.sql` (migration original; los cambios van en NUEVO archivo idempotente)
- Otros archivos en `supabase/migrations/` no listados arriba
- `doc/sdd/054-*`, `doc/sdd/055-*` (cerrados)

### 1.3 Reglas anti-alucinación

1. **Validar TODA API antes de usar** — `grep`, no inventar. Si vas a importar algo, verificá con `grep -rn "export ... NombreSimbolo" src/`. Si no aparece, NO existe.
2. **Imports relativos terminan en `.js`** — `tsconfig.json` usa `Node16`. Ej: `import { canonicalJson } from './canonical-json.js';`. Para `__tests__/` los imports llevan **3 niveles** de `../` para llegar a `lib/` (`'../../../lib/supabase.js'`).
3. **TypeScript strict — sin `any` explícito** (CD-1). Usá `unknown` y narrowing.
4. **Cada commit cierra una wave** — no commits intermedios sin tests verdes para esa wave.
5. **Pricing values [VALIDATION REQUIRED]** — antes de hardcodear `0.80/4.00` (Haiku) y `3.00/15.00` (Sonnet) en `pricing.ts`, abrí `console.anthropic.com/pricing` y confirmá. Si difieren, actualizá SOLO los números (no la API). Documentá en commit message de W0 ("pricing verified against console.anthropic.com on YYYY-MM-DD"). Si no hay acceso, dejá los valores del work-item con un comentario `// VALIDATE before deploy — see SDD §11`.
6. **Nombre del modelo Haiku** — `claude-haiku-4-5-20251001`. Verificá en `console.anthropic.com/models` que existe con ese string exacto. Si no, BLOCKER de F4 (escalá al humano).
7. **Migration aplicada localmente antes de W2** — sin la columna `schema_hash` en DB, los tests E2E con Supabase fallan. Si no podés aplicarla con tooling local, documentá el step manual en commit W1.
8. **Constructor explícito** (AB-WKH-55-5): NO `{ ...llm }` ni `{ ...metadata }`. Declará cada campo del objeto literal explícitamente. Aplica a `LLMBridgeStats` y al `metadata` del evento.
9. **Helpers puros, never-throw para input válido** (CD-12): `selectModel`, `canonicalJson`, `schemaHash`, `computeCostUsd` NO deben tirar excepciones para entradas JSON-able. NO `maybeTransform` — éste sí puede throw (ver DT-C, DT-E del SDD).
10. **El campo `result.llm` se OMITE en non-LLM paths** (CD-17 / AB-WKH-56-2). NO setear `llm: undefined` ni `llm: null`. Simplemente no incluir la key en el objeto de retorno.

---

## 2. Pre-implementation Checklist

Ejecutá estos pasos ANTES de tocar el primer archivo:

- [ ] Read `.nexus/project-context.md` (skim — stack y reglas)
- [ ] Read `doc/sdd/056-wkh-57-llm-bridge-pro/sdd.md` (completo — fuente de verdad)
- [ ] Read `doc/sdd/056-wkh-57-llm-bridge-pro/work-item.md` (ACs originales)
- [ ] Read `src/services/llm/transform.ts` entero (264 líneas — cómo está hoy)
- [ ] Read `src/services/compose.ts:99-167` (bloque bridge + eventService.track)
- [ ] Read `src/services/event.ts:52-85` (firma de track + cómo persiste metadata)
- [ ] Read `src/types/index.ts:172-210` (StepResult + TransformResult actuales)
- [ ] Read `src/types/index.ts:575-585` (BridgeType union)
- [ ] Read `src/services/llm/transform.test.ts` (252 líneas — patrón de mocks T-1..T-5)
- [ ] Read `src/services/compose.test.ts:540-590` (T-13 baseline AC-6 WKH-56 — patrón de assert sobre eventService.track)
- [ ] Read `supabase/migrations/kite_schema_transforms.sql` (tabla actual + UNIQUE actual)
- [ ] Read `supabase/migrations/20260406000000_a2a_agent_keys.sql` (formato de migration aditiva idempotente — exemplar §3.2 SDD)
- [ ] Read `doc/sdd/055-wkh-56-a2a-fast-path/auto-blindaje.md` (AB-WKH-56-1..4)
- [ ] Read `doc/sdd/054-wkh-55-downstream-x402-fuji/auto-blindaje.md` (AB-WKH-55-4/5/10)
- [ ] Verificá `npx tsc --version` y `npx vitest --version` (toolchain disponible)
- [ ] Verificá `process.env.ANTHROPIC_API_KEY` configurada (tests usan `'test-key'` mockeado, pero F4 smoke real necesita la key)
- [ ] Comando branch:
  ```bash
  git checkout main && git pull origin main && git checkout -b feat/056-wkh-57-llm-bridge-pro
  ```

---

## 3. Tipos exactos (copiar tal cual del SDD §5.2 y §5.3)

### 3.1 `src/types/index.ts` — agregar tras `TransformResult` actual

```ts
/**
 * WKH-57: telemetry del path LLM. Presente sii bridgeType==='LLM'.
 *
 * tokensIn/tokensOut son SUMA de attempts cuando hubo retry (retries===1).
 * costUsd se computa con PRICING_USD_PER_M_TOKENS centralizado (CD-6).
 */
export interface LLMBridgeStats {
  /** Modelo Anthropic invocado (string literal del SDK). */
  model: 'claude-haiku-4-5-20251001' | 'claude-sonnet-4-6';
  /** Total tokens de input cobrados por Anthropic (suma de attempts si hubo retry). */
  tokensIn: number;
  /** Total tokens de output cobrados por Anthropic. */
  tokensOut: number;
  /** 0 = first attempt OK; 1 = second attempt OK (retry exitoso). */
  retries: 0 | 1;
  /** Costo USD computado a partir de PRICING_USD_PER_M_TOKENS. */
  costUsd: number;
}
```

### 3.2 `src/types/index.ts` — extender `TransformResult` (líneas 197-210)

```ts
/** Result of a maybeTransform call */
export interface TransformResult {
  transformedOutput: unknown;
  /** @deprecated Use bridgeType. true = cache hit, false = LLM generated, 'SKIPPED' = schemas compatible */
  cacheHit: boolean | 'SKIPPED';
  /**
   * WKH-56: explicit bridge type derived from cache layer used.
   * Optional from W0 (WKH-56). WKH-57 NO tightener a required (AB-WKH-56-2).
   */
  bridgeType?: BridgeType;
  latencyMs: number;
  /** WKH-57: telemetry del path LLM. undefined si bridgeType !== 'LLM'. */
  llm?: LLMBridgeStats;
}
```

### 3.3 `src/types/index.ts` — extender `StepResult` (línea 172-190)

Agregar SOLO el nuevo campo opcional (NO tocar los existentes):

```ts
export interface StepResult {
  // ... TODOS los fields existentes inalterados ...
  /** WKH-57: telemetry del bridge LLM. Presente solo si bridgeType==='LLM'. */
  transformLLM?: LLMBridgeStats;
}
```

### 3.4 `src/services/llm/pricing.ts` — NUEVO

```ts
/**
 * WKH-57: Pricing público de Anthropic API por modelo.
 * Fuente: https://console.anthropic.com/pricing (verificar en cada actualización).
 *
 * MUST be validated against Anthropic console pricing page before deploy.
 * If real prices differ, update ONLY the values; do NOT rename keys.
 */
export const PRICING_USD_PER_M_TOKENS = {
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
  'claude-sonnet-4-6':         { input: 3.00, output: 15.00 },
} as const;

export type PricedModel = keyof typeof PRICING_USD_PER_M_TOKENS;

/** Cost en USD para un par (tokensIn, tokensOut) bajo `model`. Pure. */
export function computeCostUsd(
  model: PricedModel,
  tokensIn: number,
  tokensOut: number,
): number {
  const p = PRICING_USD_PER_M_TOKENS[model];
  return (tokensIn / 1_000_000) * p.input + (tokensOut / 1_000_000) * p.output;
}
```

### 3.5 `src/services/llm/canonical-json.ts` — NUEVO

```ts
/**
 * WKH-57 DT-B (CD-7): Returns deterministic JSON of `value`: keys sorted
 * alphabetically, recursive. Pure. Never throws for JSON-serializable input.
 * (AB-WKH-55-4.)
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    // primitives + null. JSON.stringify(undefined) === undefined, fall back to 'null'.
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) =>
      JSON.stringify(k) +
      ':' +
      canonicalJson((value as Record<string, unknown>)[k]),
  );
  return '{' + parts.join(',') + '}';
}

import { createHash } from 'node:crypto';

/** SHA-256 hex truncado a 16 chars del canonicalJson. Pure. */
export function schemaHash(schema: Record<string, unknown> | undefined): string {
  if (!schema) return 'no-schema';
  return createHash('sha256').update(canonicalJson(schema)).digest('hex').slice(0, 16);
}
```

### 3.6 `src/services/llm/select-model.ts` — NUEVO

```ts
import type { PricedModel } from './pricing.js';

/**
 * WKH-57 DT-A: selector cost-aware.
 * - 'claude-haiku-4-5-20251001' for trivial schemas.
 * - 'claude-sonnet-4-6'         for complex schemas (>=5 required, nested object, oneOf/anyOf/allOf).
 *
 * Pure. Never throws for any input shape (defensive). (CD-10/CD-12, AB-WKH-55-4.)
 */
export function selectModel(
  schema: Record<string, unknown> | undefined,
): PricedModel {
  if (!schema) return 'claude-haiku-4-5-20251001';

  const required = Array.isArray(schema.required) ? schema.required : [];
  if (required.length >= 5) return 'claude-sonnet-4-6';

  if ('oneOf' in schema || 'anyOf' in schema || 'allOf' in schema) {
    return 'claude-sonnet-4-6';
  }

  const props = schema.properties;
  if (props && typeof props === 'object' && props !== null) {
    for (const v of Object.values(props as Record<string, unknown>)) {
      if (v && typeof v === 'object' && (v as Record<string, unknown>).type === 'object') {
        return 'claude-sonnet-4-6';
      }
    }
  }

  return 'claude-haiku-4-5-20251001';
}
```

### 3.7 `generateTransformFn` (modificar firma + retorno)

```ts
async function generateTransformFn(
  output: unknown,
  inputSchema: Record<string, unknown>,
  model: PricedModel,
  missingFields: string[],
): Promise<{ fn: string; tokensIn: number; tokensOut: number }> {
  // ... mismo apiKey check ...
  // ... mismo client + AbortController ...

  let systemPrompt =
    'Eres un experto en transformación de schemas JSON. Dado un valor de output y un inputSchema JSON Schema, genera SOLO el cuerpo de una función JavaScript (sin declaración de función) que recibe `output` y retorna el objeto transformado para satisfacer el inputSchema. Responde SOLO con JSON válido, sin markdown.';

  // CD-10 (work-item): si hay missing fields del intento previo, agregarlos al prompt.
  if (missingFields.length > 0) {
    systemPrompt +=
      `\n\nPREVIOUS ATTEMPT FAILED: missing required fields [${missingFields.join(', ')}]. ` +
      `The transformFn MUST produce an object that contains ALL of these fields.`;
  }

  // ... mismo userPrompt, mismo client.messages.create({ model, ... }) ...

  // CAMBIO: capturar usage tokens
  const tokensIn = response.usage?.input_tokens ?? 0;
  const tokensOut = response.usage?.output_tokens ?? 0;

  // ... mismo parse de transformFn ...

  return { fn, tokensIn, tokensOut };
}
```

---

## 4. Patrones obligatorios (heredados auto-blindajes)

| Patrón | Origen | Aplicación en WKH-57 |
|--------|--------|----------------------|
| Imports relativos `.js` | tsconfig Node16 | TODOS los imports (incluso en `__tests__/`, donde son `'../../../lib/...'`) |
| TypeScript strict, no `any` | CD-1 | `unknown` + narrowing en input de helpers; tipo de mocks en tests usar `as unknown as`-casts |
| Helpers puros sin throw | CD-12 / AB-WKH-55-4 | `selectModel`, `canonicalJson`, `schemaHash`, `computeCostUsd` |
| Pricing constants `as const` | CD-11 | `PRICING_USD_PER_M_TOKENS = {...} as const` |
| Migration idempotente | CD-13 | `ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS`, `CREATE INDEX IF NOT EXISTS` |
| Constructor explícito (NO spread) | AB-WKH-55-5 | `LLMBridgeStats` y `metadata` del evento — declarar cada campo a mano |
| Campo opcional OMITIDO (no `null`) | AB-WKH-56-2 / CD-17 | `result.llm` se omite en non-LLM paths; en `result.transformLLM` también |
| Threshold numérico exacto en tests | AB-WKH-56-1 | Test AC-1 con `required.length === 4`; Test AC-2a con `required.length === 5` |
| `?? null` en metadata para JSON.stringify-safe | AB-WKH-56-4 / CD-15 | Los 6 campos nuevos en `compose_step.metadata` |
| `console.error` en retry NO leak PII | CD-14 | Solo nombres de campos faltantes + retry count + model. NO output ni schema raw |

---

## 5. Waves de implementación (6 commits secuenciales)

> Cada wave produce 1 commit. Validación obligatoria al cierre. Si falla, NO commitear — fixear la wave.

### W0 — Helpers puros standalone-mergeable

**Archivos:**
- NUEVO `src/services/llm/pricing.ts` (ver §3.4 — copiar literal)
- NUEVO `src/services/llm/canonical-json.ts` (ver §3.5 — copiar literal)
- NUEVO `src/services/llm/select-model.ts` (ver §3.6 — copiar literal)
- MODIFICAR `src/types/index.ts`: agregar `LLMBridgeStats` + extender `TransformResult.llm?` + extender `StepResult.transformLLM?` (ver §3.1, §3.2, §3.3)
- NUEVO `src/services/llm/__tests__/transform-verification.test.ts` con SOLO tests unitarios de helpers (T-Wp1..T-Wp4, T-Ws1..T-Ws6 del SDD §7). Tests de transform integration vienen en W5.

**Validación W0:**
```bash
npx tsc --noEmit
npx vitest run src/services/llm/__tests__/transform-verification.test.ts
```
- tsc clean
- ~10 tests unitarios (4 pricing/canonical + 6 selectModel) verdes

**Commit W0:**
```
feat(WKH-57-W0): pricing + selectModel + canonicalJson helpers

- pricing.ts: PRICING_USD_PER_M_TOKENS as const (Haiku/Sonnet) + computeCostUsd
- canonical-json.ts: canonicalJson recursive sort + schemaHash sha256:16
- select-model.ts: selectModel(schema) -> Haiku|Sonnet (DT-A thresholds)
- types: LLMBridgeStats + TransformResult.llm? + StepResult.transformLLM?
- tests: 10 unit tests para los 3 helpers (T-Wp1..T-Wp4, T-Ws1..T-Ws6)
- pricing values verified against console.anthropic.com on YYYY-MM-DD
  (or marked VALIDATE before deploy if no access — see SDD §11)

Refs: WKH-57, SDD §5.2-§5.4, CD-6/CD-7/CD-11/CD-12
```

---

### W1 — DB migration ALTER TABLE kite_schema_transforms

**Archivos:**
- NUEVO `supabase/migrations/20260426120000_kite_schema_transforms_schema_hash.sql`

**Contenido SQL exacto** (del SDD §4 DT-D — copiar literal):

```sql
-- WKH-57 (DT-D): cache key fortalecido con schema fingerprint.
-- Aditiva — entradas legacy quedan stale (schema_hash IS NULL) y se ignoran al SELECT.

ALTER TABLE kite_schema_transforms
  ADD COLUMN IF NOT EXISTS schema_hash text;

-- Drop unique constraint actual (source, target) y reemplazar por triple.
-- IF EXISTS para que la migration sea idempotente (CD-13).
ALTER TABLE kite_schema_transforms
  DROP CONSTRAINT IF EXISTS kite_schema_transforms_source_agent_id_target_agent_id_key;

-- Postgres asigna nombres deterministas a constraints UNIQUE inline; el nombre
-- exacto puede variar según la versión de generación. Cubrir alias comunes:
ALTER TABLE kite_schema_transforms
  DROP CONSTRAINT IF EXISTS kite_schema_transforms_source_agent_id_target_agent_id_excl;

-- Crear nueva unique key 3-tupla. NULLS NOT DISTINCT para que entradas
-- legacy (schema_hash NULL) sigan siendo unique por par (source,target).
ALTER TABLE kite_schema_transforms
  ADD CONSTRAINT kite_schema_transforms_source_target_hash_key
  UNIQUE NULLS NOT DISTINCT (source_agent_id, target_agent_id, schema_hash);

CREATE INDEX IF NOT EXISTS idx_kite_schema_transforms_pair_hash
  ON kite_schema_transforms (source_agent_id, target_agent_id, schema_hash);
```

**Notas:**
- El nombre del archivo sigue convención existente (`YYYYMMDDHHMMSS_descripcion.sql`). Verificá con `ls supabase/migrations/` — los hits del repo son `20260401000000`, `20260403180000`, `20260406000000`, `20260421015829`. Usá `20260426120000` (alineado con fecha SPEC_APPROVED).
- Si tenés `npx supabase db push` o `psql` local conectado, aplicá. Si no, documentá como step manual en commit body: "Migration NOT applied locally — apply with `npx supabase db push` or `psql -f` before E2E run".

**Validación W1:**
```bash
# Si hay tooling local:
npx supabase db push  # o equivalente
psql "$SUPABASE_DB_URL" -c "\d kite_schema_transforms"
# Esperado: columna schema_hash text NULLable + CONSTRAINT kite_schema_transforms_source_target_hash_key UNIQUE
```
Si NO hay tooling local: el SQL debe parsear sin errores cuando se aplique. Tests W2 con mock no requieren DB real.

**Commit W1:**
```
feat(WKH-57-W1): migration kite_schema_transforms schema_hash column

- ADD COLUMN IF NOT EXISTS schema_hash text (nullable for legacy rows)
- DROP CONSTRAINT IF EXISTS old (source,target) unique
- ADD CONSTRAINT new (source,target,schema_hash) UNIQUE NULLS NOT DISTINCT
- CREATE INDEX IF NOT EXISTS idx (source,target,schema_hash)
- Idempotente (CD-13). Aditiva → primer hit post-deploy regenera con hash real.

Refs: WKH-57, SDD §4 DT-D, CD-13
```

---

### W2 — Cache key con schema_hash en getFromL2 + persistToL2

**Archivos:**
- MODIFICAR `src/services/llm/transform.ts`

**Cambios:**

1. Importar al top del file:
   ```ts
   import { computeCostUsd, type PricedModel } from './pricing.js';
   import { schemaHash } from './canonical-json.js';
   import { selectModel } from './select-model.js';
   ```
   (PricedModel y computeCostUsd se usarán en W3 — incluirlos ya pero el linter no se va a quejar si no se usa todavía si los importás recién en W3. Recomendación: importá solo lo necesario en W2 — `schemaHash` — y el resto en W3.)

2. Modificar `getFromL2` (líneas 128-152) — agregar `schemaHash: string` arg + filter:
   ```ts
   async function getFromL2(
     sourceAgentId: string,
     targetAgentId: string,
     schemaHashValue: string,
   ): Promise<string | null> {
     const { data, error } = await supabase
       .from('kite_schema_transforms')
       .select('transform_fn, hit_count')
       .eq('source_agent_id', sourceAgentId)
       .eq('target_agent_id', targetAgentId)
       .eq('schema_hash', schemaHashValue)
       .single();

     if (error || !data) return null;

     // hit_count update fire-and-forget — agregar también el .eq schema_hash
     void supabase
       .from('kite_schema_transforms')
       .update({
         hit_count: (data.hit_count ?? 0) + 1,
         updated_at: new Date().toISOString(),
       })
       .eq('source_agent_id', sourceAgentId)
       .eq('target_agent_id', targetAgentId)
       .eq('schema_hash', schemaHashValue);

     return data.transform_fn as string;
   }
   ```

3. Modificar `persistToL2` (líneas 158-172) — agregar `schemaHash: string` arg:
   ```ts
   async function persistToL2(
     sourceAgentId: string,
     targetAgentId: string,
     schemaHashValue: string,
     transformFn: string,
   ): Promise<void> {
     await supabase.from('kite_schema_transforms').upsert(
       {
         source_agent_id: sourceAgentId,
         target_agent_id: targetAgentId,
         schema_hash: schemaHashValue,
         transform_fn: transformFn,
         updated_at: new Date().toISOString(),
       },
       { onConflict: 'source_agent_id,target_agent_id,schema_hash' },
     );
   }
   ```

4. En `maybeTransform` (líneas 190-259) — calcular hash + reemplazar cacheKey:
   ```ts
   // tras isCompatible-skip, ANTES del L1/L2:
   const schemaHashValue = schemaHash(inputSchema);
   const cacheKey = `${sourceAgentId}:${targetAgentId}:${schemaHashValue}`;
   ```
   Y pasar el `schemaHashValue` en las llamadas a `getFromL2(..., schemaHashValue)` y `persistToL2(..., schemaHashValue, transformFn)`.

**Validación W2:**
```bash
npx tsc --noEmit
npx vitest run src/services/llm/transform.test.ts
```
- tsc clean
- T-1..T-5 deben SEGUIR pasando (los mocks con chain `.eq().eq().single()` deben extenderse a `.eq().eq().eq().single()`. Si los tests existentes rompen por shape de mock, ajustá el chain en `beforeEach` de `transform.test.ts` agregando un `eq3` step. NO REMOVER ningún test).

**Commit W2:**
```
feat(WKH-57-W2): cache key con schema_hash anti-stale

- getFromL2 + persistToL2 ahora aceptan schemaHash y filtran por columna
- maybeTransform computa schemaHash(inputSchema) antes del L1/L2 lookup
- cacheKey ahora es triple: ${source}:${target}:${schemaHash}
- T-1..T-5 ajustadas para nuevo eq-chain (sin remover tests). Baseline preserved.

Refs: WKH-57, SDD §5 W2, CD-7, AC-4
```

---

### W3 — Model selector + retry loop + verification + telemetry

**Archivos:**
- MODIFICAR `src/services/llm/transform.ts`

**Cambios:**

1. Eliminar la constante `const MODEL = 'claude-sonnet-4-20250514';` (línea 13). El modelo ahora viene de `selectModel(schema)`.

2. Modificar `generateTransformFn` (ver §3.7 arriba) — agregar args `model: PricedModel`, `missingFields: string[]`, retornar `{ fn, tokensIn, tokensOut }`.

3. Reemplazar el bloque "4. Cache miss → LLM" en `maybeTransform` (líneas 235-258) con el flow del SDD §5.1:
   ```ts
   // 4. Cache miss → LLM con model selector + retry verification
   const schema = inputSchema ?? {};
   const model = selectModel(inputSchema);

   // Attempt 1
   const attempt1 = await generateTransformFn(output, schema, model, []);
   const transformed1 = applyTransformFn(attempt1.fn, output);

   if (isCompatible(transformed1, inputSchema)) {
     // Happy path — persist and return
     persistToL2(sourceAgentId, targetAgentId, schemaHashValue, attempt1.fn).catch(
       (err: unknown) => {
         console.error(
           `[Transform] Failed to persist to L2 for ${cacheKey}:`,
           err,
         );
       },
     );
     l1Cache.set(cacheKey, attempt1.fn);

     return {
       transformedOutput: transformed1,
       cacheHit: false,
       bridgeType: 'LLM',
       latencyMs: Date.now() - start,
       llm: {
         model,
         tokensIn: attempt1.tokensIn,
         tokensOut: attempt1.tokensOut,
         retries: 0,
         costUsd: computeCostUsd(model, attempt1.tokensIn, attempt1.tokensOut),
       },
     };
   }

   // Attempt 2 — retry with missing fields hint
   const required = Array.isArray(schema.required) ? schema.required : [];
   const transformed1Keys =
     transformed1 !== null && typeof transformed1 === 'object'
       ? new Set(Object.keys(transformed1 as Record<string, unknown>))
       : new Set<string>();
   const missing = required.filter(
     (k): k is string => typeof k === 'string' && !transformed1Keys.has(k),
   );

   // CD-14: log NO leak raw output/schema. Solo nombres de campos + count + model.
   console.error(
     `[Transform] retry attempt 1: missing fields [${missing.join(', ')}] (model=${model})`,
   );

   const attempt2 = await generateTransformFn(output, schema, model, missing);
   const transformed2 = applyTransformFn(attempt2.fn, output);

   const totalIn = attempt1.tokensIn + attempt2.tokensIn;
   const totalOut = attempt1.tokensOut + attempt2.tokensOut;

   if (isCompatible(transformed2, inputSchema)) {
     // Retry succeeded — persist with attempt2.fn
     persistToL2(sourceAgentId, targetAgentId, schemaHashValue, attempt2.fn).catch(
       (err: unknown) => {
         console.error(
           `[Transform] Failed to persist to L2 for ${cacheKey}:`,
           err,
         );
       },
     );
     l1Cache.set(cacheKey, attempt2.fn);

     return {
       transformedOutput: transformed2,
       cacheHit: false,
       bridgeType: 'LLM',
       latencyMs: Date.now() - start,
       llm: {
         model,
         tokensIn: totalIn,
         tokensOut: totalOut,
         retries: 1,
         costUsd: computeCostUsd(model, totalIn, totalOut),
       },
     };
   }

   // Retry FAILED — throw with explicit message + missing fields (DT-C, AC-3)
   const transformed2Keys =
     transformed2 !== null && typeof transformed2 === 'object'
       ? new Set(Object.keys(transformed2 as Record<string, unknown>))
       : new Set<string>();
   const missingFinal = required.filter(
     (k): k is string => typeof k === 'string' && !transformed2Keys.has(k),
   );

   throw new Error(
     `transform validation failed after retry: missing required fields [${missingFinal.join(', ')}] in last attempt (model=${model})`,
   );
   ```

4. Verificar que los retornos de cache hits (L1, L2, SKIPPED) NO incluyen `llm` field (omitir, no setear). El `cacheHit`/`bridgeType` ya estaban populados pre-W3.

**Validación W3:**
```bash
npx tsc --noEmit
npx vitest run src/services/llm/transform.test.ts
# T-1..T-5 deben pasar. T-1 puede necesitar ajustes para captar el nuevo response.usage shape en el mock
# (el mock actual no tiene usage → tokensIn/tokensOut son 0; eso está OK para T-1 — solo asertar shape).
```

**Ajustes esperados a `transform.test.ts`:**
- `setupLLMResponse(transformFn)` debe retornar `{ content: [...], usage: { input_tokens: 100, output_tokens: 50 } }` para que T-1 (el único path LLM) tenga tokens > 0. Si el assert original es solo `expect(result.cacheHit).toBe(false)` se mantiene; agregar `expect(result.llm?.model).toBeDefined()` es opcional pero útil.
- Si T-1 antes asertaba sólo `cacheHit`, mantenelo + opcionalmente extendelo. NO REMOVER el assert original.

**Commit W3:**
```
feat(WKH-57-W3): model selector + retry + telemetry en maybeTransform

- selectModel(inputSchema) -> Haiku|Sonnet (CD-3: lógica interna, sin env var)
- generateTransformFn ahora acepta { model, missingFields } y retorna usage
- Retry loop: attempt1 -> isCompatible? -> attempt2 (con missing fields prompt) -> isCompatible? -> throw
- console.error siempre que retries>0 (AC-7) — solo nombres de campos (CD-14, no leak PII)
- result.llm populado en path LLM (model, tokensIn, tokensOut, retries, costUsd)
- result.llm OMITIDO (no null) en cache hits + SKIPPED (CD-17, AB-WKH-56-2)
- Throw fail-fast con mensaje matching /transform validation failed after retry/i (DT-C)

Refs: WKH-57, SDD §5.1, AC-1, AC-2, AC-3, AC-5, AC-7, CD-10/CD-14/CD-16/CD-17/CD-18
```

---

### W4 — compose.ts pasa los nuevos fields al evento

**Archivos:**
- MODIFICAR `src/services/compose.ts`

**Cambios:**

1. Importar tipo `LLMBridgeStats` al top:
   ```ts
   import type { ..., LLMBridgeStats } from '../types/index.js';
   ```

2. En el bloque tras `maybeTransform` (líneas ~125-135) — asignar `result.transformLLM` cuando exista:
   ```ts
   const tr = await maybeTransform(
     agent.id,
     nextAgent.id,
     payloadForTransform,
     inputSchema,
   );
   result.cacheHit = tr.cacheHit;             // legacy (DT-3)
   result.bridgeType = tr.bridgeType;         // WKH-56
   result.transformLatencyMs = tr.latencyMs;
   if (tr.llm) {
     result.transformLLM = tr.llm;            // WKH-57: omitir si undefined (CD-17)
   }
   lastOutput = tr.transformedOutput;
   ```

3. Reemplazar el bloque `metadata: { bridge_type: result.bridgeType ?? null }` (línea 163) con el constructor explícito de los 6 campos:
   ```ts
   const llm = result.transformLLM;
   eventService
     .track({
       eventType: 'compose_step',
       agentId: agent.slug,
       agentName: agent.name,
       registry: agent.registry,
       status: 'success',
       latencyMs,
       costUsdc: agent.priceUsdc,
       txHash,
       metadata: {
         bridge_type:        result.bridgeType         ?? null,
         bridge_latency_ms:  result.transformLatencyMs ?? null,
         bridge_cost_usd:    llm?.costUsd              ?? null,
         llm_model:          llm?.model                ?? null,
         llm_tokens_in:      llm?.tokensIn             ?? null,
         llm_tokens_out:     llm?.tokensOut            ?? null,
       },
     })
     .catch((err) => console.error('[Compose] event tracking failed:', err));
   ```

**Validación W4:**
```bash
npx tsc --noEmit
npx vitest run src/services/compose.test.ts
# T-1..T-13 deben PASS. T-13 es el AC-6 baseline de WKH-56 — verificar que aún pasa con metadata extendida (debe pasar porque solo asertaba bridge_type, los nuevos campos son aditivos).
```

**Commit W4:**
```
feat(WKH-57-W4): emit telemetry completa en compose_step event

- result.transformLLM = tr.llm (omitir si undefined, CD-17)
- compose_step.metadata ahora incluye 6 campos (constructor explícito, AB-WKH-55-5):
  bridge_type, bridge_latency_ms, bridge_cost_usd, llm_model, llm_tokens_in, llm_tokens_out
- Todos con `?? null` para JSON.stringify-safe (AB-WKH-56-4, CD-15)
- Campos pre-existentes (agentId, agentName, registry, status, latencyMs, costUsdc, txHash) inalterados
- T-13 baseline (WKH-56 AC-6) preservado.

Refs: WKH-57, SDD §5.5, AC-6, CD-9/CD-15/CD-17
```

---

### W5 — Tests integración (transform-verification + compose AC-6)

**Archivos:**
- MODIFICAR `src/services/llm/__tests__/transform-verification.test.ts` — agregar tests de integración (los unit tests ya están desde W0)
- MODIFICAR (mínimo) `src/services/llm/transform.test.ts` — ajustar mocks si W2/W3 lo requirió (esperado: agregar `eq3` al chain en `beforeEach` y `usage` al mockCreate)
- MODIFICAR `src/services/compose.test.ts` — agregar T-14 para AC-6 con telemetría completa

**Tests a agregar en `transform-verification.test.ts`** (siguiendo el patrón de mocks de `transform.test.ts`):

| Test ID | AC | Descripción |
|---------|----|---|
| T-VER-1 | AC-1 | Schema con `required.length === 4` + primitives → mockCreate llamado con `model='claude-haiku-4-5-20251001'`; `result.llm.model === 'claude-haiku-4-5-20251001'` |
| T-VER-2a | AC-2 | Schema con `required.length === 5` → `model='claude-sonnet-4-6'` |
| T-VER-2b | AC-2 | Schema con `properties.x.type === 'object'` → `model='claude-sonnet-4-6'` |
| T-VER-2c | AC-2 | Schema con `oneOf: [...]` → `model='claude-sonnet-4-6'` |
| T-VER-3 | AC-3 happy | mockCreate retorna attempt1 fn que produce `{wrong:1}`; attempt2 fn que produce `{required_field: ...}`. Assert `result.llm.retries === 1`, `mockCreate.mock.calls.length === 2`, `result.transformedOutput` cumple schema |
| T-VER-4 | AC-3 sad | mockCreate retorna 2x fn que NO cumple. Assert `rejects.toThrow(/transform validation failed after retry/i)`; mensaje incluye nombre de campo |
| T-VER-5 | AC-4 | Call 1 con schemaA → mockCreate=1; call 2 mismo source/target/output con schemaB (schema diff). Assert mockCreate=2 (no L1 hit por hash distinto). Verificar Supabase `.eq('schema_hash', X)` recibe valores diferentes |
| T-VER-6 | AC-5 (LLM) | Path LLM happy: assert `typeof result.llm.model === 'string'`, `result.llm.tokensIn > 0`, `result.llm.tokensOut > 0`, `result.llm.retries === 0`, `result.llm.costUsd > 0` |
| T-VER-7a | AC-5 non-LLM (SKIPPED) | Schema compatible → assert `result.llm === undefined` (NO setear como null/0) |
| T-VER-7b | AC-5 non-LLM (CACHE_L2) | mock Supabase hit → assert `result.llm === undefined` |
| T-VER-7c | AC-5 non-LLM (CACHE_L1) | call1 LLM, call2 mismo schema → L1 hit → assert `result.llm === undefined` |
| T-VER-8 | AC-7 | Spy `console.error`. Trigger retry happy path. Assert `console.error` called con string que include "retry attempt 1" + nombre de campo faltante. CD-14: NO debe contener output raw o schema entero |

**Test a agregar en `compose.test.ts`** (extender bloque existente):

| Test ID | AC | Descripción |
|---------|----|---|
| T-14 | AC-6 | Mock `eventService.track`. Mock `maybeTransform` para retornar bridgeType=LLM con `llm: {...}`. Ejecutar compose con 2 steps. Assert `track` llamado con `metadata` que incluye los 6 campos: `bridge_type='LLM'`, `bridge_latency_ms: number`, `bridge_cost_usd: number`, `llm_model: string`, `llm_tokens_in: number`, `llm_tokens_out: number`. Repetir con `bridgeType='SKIPPED'` → assert los 4 campos `llm_*` y `bridge_cost_usd` son `null` |

**Mock setup hint para `transform-verification.test.ts`:**
- Tests están en `__tests__/` → 3 niveles de `../`. Imports correctos:
  - `vi.mock('../../../lib/supabase.js', ...)` — ojo, **3 `../`**
  - `import { ... } from '../transform.js';`
  - `import { _clearL1Cache } from '../transform.js';`
  - `import { selectModel } from '../select-model.js';`
  - `import { schemaHash, canonicalJson } from '../canonical-json.js';`
  - `import { computeCostUsd, PRICING_USD_PER_M_TOKENS } from '../pricing.js';`
- Anthropic mock: `mockCreate.mockResolvedValue({ content: [...], usage: { input_tokens: N, output_tokens: M } })` para que `result.llm.tokensIn/tokensOut` sean > 0.
- Para retry tests (T-VER-3, T-VER-4): `mockCreate.mockResolvedValueOnce({...})` chain x2.
- Supabase chain ahora tiene `eq().eq().eq().single()` (3 eqs) — actualizar el helper de `beforeEach`.

**Validación W5 — final:**
```bash
npx tsc --noEmit                                          # clean
npx vitest run                                            # full suite (target: ~451 tests, todos verdes)
# Coverage manual de transform.ts:
# (AB-WKH-56-3: NO usar --coverage; coverage tooling no instalado.)
# Inspección visual de branches:
#   - selectModel: 4 paths (no schema, ≥5 required, oneOf/anyOf/allOf, nested object)
#   - maybeTransform: SKIPPED, CACHE_L1, CACHE_L2, LLM-happy, LLM-retry-happy, LLM-retry-fail
#   Esperar ≥90% líneas. Documentar en done-report del Dev.
```

**Commit W5:**
```
feat(WKH-57-W5): tests transform-verification + compose AC-6

- __tests__/transform-verification.test.ts: 12 nuevos tests
  T-VER-1..T-VER-2c: model selector (AC-1, AC-2 a/b/c)
  T-VER-3..T-VER-4: retry happy/sad (AC-3)
  T-VER-5: cache key divergence on schema change (AC-4)
  T-VER-6..T-VER-7c: result.llm shape + omitido en non-LLM (AC-5)
  T-VER-8: console.error on retry (AC-7)
- transform.test.ts: T-1..T-5 preservados (ajustes mínimos: eq3 en mock chain + usage en mockCreate)
- compose.test.ts: T-14 nuevo (AC-6: 6 campos de metadata, LLM y non-LLM)
- AC-8: full suite verde, T-1..T-5 + T-1..T-13 baseline preservados
- Coverage transform.ts ≥90% por inspección manual (AB-WKH-56-3: tooling no instalado)

Refs: WKH-57, SDD §7, AC-1..AC-8
```

---

## 6. Test plan exacto — 1 test por AC

| AC | Archivo | Test ID(s) |
|----|---------|----|
| **AC-1** | `src/services/llm/__tests__/transform-verification.test.ts` | `T-VER-1: schema with 4 required + primitives selects Haiku` |
| **AC-2** | `src/services/llm/__tests__/transform-verification.test.ts` | `T-VER-2a: 5 required selects Sonnet` + `T-VER-2b: nested object selects Sonnet` + `T-VER-2c: oneOf selects Sonnet` |
| **AC-3** (happy) | `src/services/llm/__tests__/transform-verification.test.ts` | `T-VER-3: retry succeeds on second attempt` |
| **AC-3** (sad) | `src/services/llm/__tests__/transform-verification.test.ts` | `T-VER-4: retry fails on second attempt throws` |
| **AC-4** | `src/services/llm/__tests__/transform-verification.test.ts` | `T-VER-5: schema change between calls produces different cache keys` |
| **AC-5** (LLM) | `src/services/llm/__tests__/transform-verification.test.ts` | `T-VER-6: result.llm shape on LLM bridge` |
| **AC-5** (non-LLM) | `src/services/llm/__tests__/transform-verification.test.ts` | `T-VER-7a/b/c: result.llm undefined on SKIPPED/CACHE_L1/CACHE_L2` |
| **AC-6** | `src/services/compose.test.ts` | `T-14 (AC-6): event metadata includes 6 telemetry fields, llm_* null on non-LLM` |
| **AC-7** | `src/services/llm/__tests__/transform-verification.test.ts` | `T-VER-8: console.error called on retry attempt` |
| **AC-8** | full suite + manual coverage | `npx vitest run` (T-1..T-5 transform.test + T-1..T-13 compose.test sin remoción) + inspección manual de branches transform.ts ≥90% |

**Plus — tests unitarios W0 (helpers):**
- `T-Wp1`: `PRICING_USD_PER_M_TOKENS` shape inspection (Haiku.input=0.80, Haiku.output=4, Sonnet.input=3, Sonnet.output=15)
- `T-Wp2`: `computeCostUsd('claude-haiku-4-5-20251001', 1_000_000, 1_000_000)` ≈ `0.80 + 4.00 = 4.80`
- `T-Wp3`: `canonicalJson({b:2, a:1}) === canonicalJson({a:1, b:2})` (determinismo)
- `T-Wp4`: `schemaHash({a:1, b:2}) === schemaHash({b:2, a:1})` y `schemaHash(undefined) === 'no-schema'`
- `T-Ws1..T-Ws6`: `selectModel` con 6 inputs distintos (undefined, schema vacío, ≥5 required, oneOf, nested object, simple — esperar Haiku salvo en los 4 paths Sonnet)

---

## 7. Validation per wave

| Wave | Comando |
|------|---------|
| Per wave | `npx tsc --noEmit && npx vitest run [test-file-relevant-de-la-wave]` |
| Final post-W5 | `npx tsc --noEmit && npx vitest run` (full suite) |
| Coverage | Inspección manual de branches en `src/services/llm/transform.ts` (AB-WKH-56-3: NO usar `--coverage`, paquete no instalado). Documentar branches cubiertas en done-report. |

---

## 8. Branch creation

```bash
git status                                    # asegurar clean
git checkout main
git pull origin main                          # post-WKH-56 PR #28
git checkout -b feat/056-wkh-57-llm-bridge-pro
```

---

## 9. Done Definition (acceptance final)

- [ ] **6 commits W0..W5** en branch `feat/056-wkh-57-llm-bridge-pro`, prefijos `feat(WKH-57-WN):`
- [ ] **`npx tsc --noEmit`** clean
- [ ] **`npx vitest run`** verde — esperar ~437 (post-WKH-56) + ~14-18 nuevos = ~451-455 tests, todos verdes
- [ ] **AC-1..AC-8** todos cubiertos por al menos 1 test (ver §6)
- [ ] **Baseline preservado:** T-1..T-5 transform.test (5) + T-1..T-13 compose.test (13) sin remover, sin assertion-pruning destructivo
- [ ] **Coverage transform.ts ≥90%** por inspección manual de branches (4 paths selectModel, 6 paths maybeTransform, generateTransformFn happy + retry-prompt). Documentar en done-report.
- [ ] **Migration aplicable** — el SQL del W1 parsea sin errores. Si tooling local disponible, aplicada localmente y `\d kite_schema_transforms` muestra `schema_hash text` + nuevo CONSTRAINT.
- [ ] **Pricing values verificados** — comentario en pricing.ts indica fecha de validación contra console.anthropic.com (o marker `// VALIDATE before deploy` si no hay acceso)
- [ ] **No `[NEEDS CLARIFICATION]`** sin resolver
- [ ] **No `any` explícito** introducido (CD-1 — verificar `git diff main...HEAD | grep ': any'` retorna vacío)
- [ ] **No archivos fuera de Scope IN modificados** (verificar `git diff --name-only main...HEAD` solo lista los 9 archivos esperados)
- [ ] **Done report** en `doc/sdd/056-wkh-57-llm-bridge-pro/done-report.md` con: 6 commits hashes, test count antes/después, coverage manual, pricing validation note, migration application status

---

## 10. Anti-Hallucination Checklist (revisión final antes de cerrar F3)

- [ ] **Stack respetado** — TypeScript strict, vitest, Supabase, Anthropic SDK ya instalados. NO ethers/express/jest/zod-runtime nuevas.
- [ ] **No env vars nuevas** — CD-3. `ANTHROPIC_API_KEY` ya existe; no agregar `ANTHROPIC_MODEL_HAIKU` etc.
- [ ] **No endpoints nuevos** — CD-4. Cambios solo en service-layer + types + tests + migration.
- [ ] **`new Function('output', body)` mantenido** — CD-8. NO `eval()`.
- [ ] **Pricing centralizado** — `pricing.ts`, ningún número inline en `transform.ts`/`compose.ts` (CD-6).
- [ ] **Schema fingerprint determinístico** — `canonicalJson` ordena keys recursivamente (CD-7).
- [ ] **Migration idempotente** — `IF NOT EXISTS` / `IF EXISTS` en TODOS los DDL statements (CD-13).
- [ ] **Constructor explícito** — `LLMBridgeStats` y `metadata` event sin spread (AB-WKH-55-5).
- [ ] **`result.llm` OMITIDO en non-LLM** — CD-17. NO `llm: null`. NO `llm: undefined` literal en el objeto.
- [ ] **`?? null` en metadata** — los 6 campos nuevos del `compose_step` (CD-15 / AB-WKH-56-4).
- [ ] **Threshold numérico exacto en tests** — AC-1 con `required.length === 4`; AC-2a con `required.length === 5` (AB-WKH-56-1).
- [ ] **Helpers puros never-throw** — `selectModel`, `canonicalJson`, `schemaHash`, `computeCostUsd` (CD-12).
- [ ] **`maybeTransform` SÍ throw fail-fast** — DT-C: `/transform validation failed after retry/i` con missing field name (CD-16).
- [ ] **No escalar a Sonnet en retry** — DT-C / CD-16. Mismo `model` en attempt1 y attempt2.
- [ ] **`console.error` en retry NO leak PII** — solo `[Transform] retry attempt 1: missing fields [...] (model=...)` (CD-14).
- [ ] **No swallow de Anthropic errors** — propagación natural; compose.ts:144-149 catchea (DT-E / CD-18).
- [ ] **Imports relativos `.js`** — incluso en `__tests__/` (3 niveles `../`).
- [ ] **Auto-blindajes WKH-56 aplicados** — AB-WKH-56-1 (threshold), AB-WKH-56-2 (omit no null), AB-WKH-56-3 (no --coverage), AB-WKH-56-4 (?? null).

---

*Story File generado por NexusAgil — F2.5 (Architect) — 2026-04-26*
*SDD source: `doc/sdd/056-wkh-57-llm-bridge-pro/sdd.md` (SPEC_APPROVED 2026-04-26)*
