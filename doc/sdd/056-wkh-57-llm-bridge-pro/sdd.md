# SDD #056: LLM Bridge Pro — Model Selector + Verification + Cache Fingerprint + Telemetry

> SPEC_APPROVED: no
> Fecha: 2026-04-26
> Tipo: feature
> SDD_MODE: full
> Branch: feat/056-wkh-57-llm-bridge-pro
> Artefactos: doc/sdd/056-wkh-57-llm-bridge-pro/
> Work Item: doc/sdd/056-wkh-57-llm-bridge-pro/work-item.md
> HU_APPROVED: 2026-04-26 (clinical review PASS)
> Depende de: WKH-56 mergeado a `main` (PR #28) — provee `BridgeType`, `isA2AMessage`, `AgentCard.capabilities.a2aCompliant`.

---

## 1. Resumen

`maybeTransform` (`src/services/llm/transform.ts`) es el único punto de schema-bridging del gateway. Hoy dispara siempre `claude-sonnet-4-20250514` para cualquier schema, incluso para esquemas triviales (1-2 campos), y NO valida que el output del LLM cumpla el schema antes de devolverlo. El smoke E2E del 2026-04-26 reporta ~3 s y ~1087 tokens **por bridge** — multiplicado por N steps en pipelines reales, escala feo en costo y latencia.

Esta HU mejora el bridge LLM en 4 ejes ortogonales:

1. **Model selector** — `selectModel(schema)` decide Haiku 4.5 (~$0.80/$4 por M tokens) para schemas simples vs Sonnet 4.6 (~$3/$15 por M tokens) para complejos. Reducción esperada de costo ~70% para los schemas más comunes.
2. **Verification loop** — tras generar transform, se aplica y se valida `isCompatible(result, schema)`. Si falla, se reintenta UNA vez con prompt enriquecido (campos faltantes); si vuelve a fallar, throw explícito.
3. **Cache fingerprint** — la cache key actual `${source}:${target}` ignora el schema, dejando stale cache cuando el schema cambia en DB. Se agrega `schema_hash` (canonical-JSON SHA-256) a la key.
4. **Telemetría completa** — `TransformResult.llm` lleva `model`, `tokensIn`, `tokensOut`, `retries`, `costUsd`. `compose_step` event metadata incluye `bridge_type`, `bridge_latency_ms`, `llm_*` y `bridge_cost_usd`.

**Resultado esperado:** Pipelines mantienen idéntico contrato externo (CD-2: cero regresión funcional). El path LLM es ~70% más barato en promedio + más robusto + auditable.

---

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 056 (WKH-57) |
| **Tipo** | feature |
| **SDD_MODE** | full |
| **Objetivo** | Profesionalizar `maybeTransform` con model selection cost-aware, retry loop con verificación, cache key resistente a cambios de schema, y telemetría detallada en evento `compose_step`. |
| **Reglas de negocio** | Cero regresión en flujo non-LLM (CD-2); cero env vars nuevas (CD-3); pricing centralizado (CD-6); fingerprint determinístico (CD-7). |
| **Scope IN** | Ver §6.1 (transform.ts modificar; compose.ts modificar; event.ts modificar; types/index.ts extender; nueva migration; nuevos pricing.ts + canonical-json.ts + select-model.ts; nuevo test file) |
| **Scope OUT** | downstream-payment.ts (WKH-55 DONE); orchestrate.ts (JSON-RPC distinto); a2a-protocol.ts (WKH-56, solo se importa `BridgeType`); routes/*; registry.ts; discovery.ts; nueva tabla DB. |
| **Missing Inputs** | DT-A..DT-E + pricing exact + nombre de modelo Haiku 4.5 — TODOS resueltos en este SDD §4. |

### 2.1 Acceptance Criteria (heredados del work-item)

- **AC-1:** WHEN `maybeTransform` recibe `targetSchema` con <5 required AND ningún property con `type:"object"` AND sin `oneOf|anyOf|allOf`, THEN llama Anthropic con `model='claude-haiku-4-5-20251001'` y `result.llm.model === 'claude-haiku-4-5-20251001'`.
- **AC-2:** WHEN `targetSchema` cumple ≥1 de (a) ≥5 required, (b) ≥1 property con `type:"object"`, (c) `oneOf|anyOf|allOf` presente, THEN llama Anthropic con `model='claude-sonnet-4-6'` y `result.llm.model === 'claude-sonnet-4-6'`.
- **AC-3:** WHEN `applyTransformFn` produce output que NO satisface `isCompatible` en el primer intento, THEN retry exactamente 1 vez con prompt revisado que incluye los required fields faltantes; IF segundo intento también falla, THEN throw error con mensaje matching `/transform validation failed after retry/i` que incluye al menos un nombre de campo faltante.
- **AC-4:** WHEN `maybeTransform` se llama 2 veces con mismo `sourceAgentId+targetAgentId` pero `targetSchema` distintos, THEN computa cache keys distintas → L2 miss en la segunda.
- **AC-5:** WHEN `result.bridgeType === 'LLM'`, THEN `result.llm` está presente con `model:string`, `tokensIn:int>0`, `tokensOut:int>0`, `retries∈{0,1}`, `costUsd:number>0`. WHEN `bridgeType ∈ {'CACHE_L1','CACHE_L2','SKIPPED','A2A_PASSTHROUGH'}`, THEN `result.llm === undefined`.
- **AC-6:** WHEN `compose_step` event se trackea, THEN `metadata` incluye `bridge_type`, `bridge_latency_ms`, `llm_tokens_in|null`, `llm_tokens_out|null`, `bridge_cost_usd|null`, `llm_model|null`. Los campos `llm_*` son null cuando `bridge_type !== 'LLM'`. Campos pre-existentes (`agentId`, `agentName`, `registry`, `status`, `latencyMs`, `costUsdc`, `txHash`) inalterados.
- **AC-7:** WHILE `maybeTransform` retorna sin error en path LLM, el sistema SHALL `console.error` para cualquier intento con `retries>0`, incluyendo nombres de campos faltantes y conteo, independientemente del éxito del segundo intento.
- **AC-8:** WHEN test suite corre post-WKH-57, los 5 tests pre-existentes en `transform.test.ts` (T-1..T-5) pasan sin modificación funcional (puede haber ajustes de assertion para nuevo shape de `TransformResult` pero NO removerse). El nuevo file `src/services/llm/__tests__/transform-verification.test.ts` cubre AC-1..AC-5. Coverage de `transform.ts` ≥90% por inspección manual de branches (AB-WKH-56-3: tooling de coverage no instalado).

---

## 3. Context Map (Codebase Grounding)

### 3.1 Archivos leídos en disco

| Archivo | LOC | Por qué | Patrón extraído |
|---------|-----|---------|-----------------|
| `src/services/llm/transform.ts` | 264 | Punto único a modificar; mapear MODEL constant, cache, helpers | Service modular: helpers privados (`isCompatible`, `applyTransformFn`, `generateTransformFn`, `getFromL2`, `persistToL2`) + export `maybeTransform` + export `_clearL1Cache`. Anthropic SDK con `AbortController` + `setTimeout(controller.abort, 30_000)`. Cache L1 = `Map<string,string>` module-level. CD-8 cumplido: `new Function('output', body)` no `eval`. |
| `src/services/llm/transform.test.ts` | 252 | Patrón de mock chain Supabase + Anthropic; test baseline T-1..T-5 | `vi.mock('../../lib/supabase.js', ...)` con factory `mockFrom().select().eq().eq().single()`. `vi.mock('@anthropic-ai/sdk', ...)` con `mockCreate`. `beforeEach` + `_clearL1Cache()` + `process.env.ANTHROPIC_API_KEY='test-key'`. Helpers locales `getFromMock`, `setupLLMResponse`. |
| `src/services/compose.ts` | 286 | Donde se trackea evento `compose_step` (líneas 153-164); donde se asigna `result.bridgeType` | `eventService.track({ ..., metadata: { bridge_type: result.bridgeType ?? null } })` (línea 163). Hoy SOLO `bridge_type` está en metadata. Ampliable agregando los nuevos campos sin tocar firma de `track`. `result.transformLatencyMs = tr.latencyMs` (línea 134) ya existe. |
| `src/services/event.ts` | 223 | Cómo se persiste metadata; firma del input | `track(input)` recibe `metadata?: Record<string,unknown>` (línea 62) y persiste como `metadata: input.metadata ?? {}` (línea 74). NO hay shape constraints — los nuevos campos van dentro del objeto metadata sin migration de DB. |
| `src/services/a2a-protocol.ts` | 82 | WKH-56 helper; ya disponible | `BridgeType` exportado por `types/index.ts` línea 577-582. `isA2AMessage`, `extractA2APayload`, `buildA2APayload` puros, never-throw (CD-12 WKH-56), tree-shakeable. **NO modificar**, solo importar `BridgeType`. |
| `src/types/index.ts` (WKH-56 patch) | 588 | `TransformResult.bridgeType` ya existe (opcional W0 mergeable, AB-WKH-56-2 lo deja optional); `BridgeType` definido | `TransformResult` (línea 197-210) tiene `bridgeType?: BridgeType` y `cacheHit: boolean \| 'SKIPPED'` legacy. `StepResult` (172-190) tiene `bridgeType?: BridgeType`, `cacheHit?: boolean \| 'SKIPPED'`, `transformLatencyMs?: number`. **No reemplazar `cacheHit`** (consumers legacy lo leen). |
| `supabase/migrations/kite_schema_transforms.sql` | 19 | Tabla a alterar | Tabla con `id UUID PK`, `source_agent_id TEXT`, `target_agent_id TEXT`, `transform_fn TEXT`, `hit_count INT`, `created_at`, `updated_at`, UNIQUE(source,target), INDEX idx_kite_schema_transforms_pair. **Constraint UNIQUE actual no incluye `schema_hash`** → debemos cambiar la unique key. |
| `tsconfig.json` (inferido por imports `.js`) | — | Module resolution | `"module":"Node16"` + `"moduleResolution":"node16"` → imports relativos terminan en `.js`. |
| `doc/sdd/055-wkh-56-a2a-fast-path/auto-blindaje.md` | — | Patrones recurrentes | AB-WKH-56-1: AC con threshold numérico → test asertarse con número exacto (AC-1: `<5` required → test con 4 y 5). AB-WKH-56-2: cuando AC dice "ausente solo cuando X", **todas las ramas** deben setear o omitir explícitamente (aplicado a `result.llm` en AC-5). AB-WKH-56-3: `@vitest/coverage-v8` NO está instalado → coverage en AC-8 se valida por inspección manual de branches. AB-WKH-56-4: documentar semántica de `??` fallback (aplicado a `metadata.llm_* ?? null` en AC-6). |
| `doc/sdd/054-wkh-55-downstream-x402-fuji/auto-blindaje.md` | — | Never-throw + constructor explícito | AB-WKH-55-4: never-throw en módulos críticos (helpers `selectModel`, `canonicalJson`, `computePricing` — pure functions, no I/O, no throws en input válido). AB-WKH-55-5: constructor explícito (NO spread) en envelopes — aplicado al objeto `LLMBridgeStats` y al objeto que pasamos a `eventService.track`. AB-WKH-55-10: cada AC ≥1 test (§7). |
| `doc/sdd/053-wkh-53-rls-ownership/auto-blindaje.md` | — | Architect↔disco drift | AB-WKH-53-#2: Architect debe verificar con grep que el assert/línea referenciada existe. **Aplicado**: este SDD cita líneas reales de transform.ts/compose.ts/event.ts (verificadas con Read). |

### 3.2 Exemplars verificados con Glob/Read en disco

| Para crear/modificar | Seguir patrón de | Razón |
|---------------------|------------------|-------|
| `src/services/llm/pricing.ts` (NUEVO) | `src/lib/downstream-payment.ts:130-160` (constantes USDC FUJI) | Constantes inmutables `as const`, no module-level state mutable, tree-shakeable. CD-6 + CD-9. |
| `src/services/llm/canonical-json.ts` (NUEVO) | `src/services/a2a-protocol.ts` (helpers puros never-throw) | Funciones puras `export function name(...)`, no side-effects, no throws en JSON-able input. AB-WKH-55-4. |
| `src/services/llm/select-model.ts` (NUEVO) | `src/services/llm/transform.ts:27-41` (helper `isCompatible`) | Helper puro side-effect-free que clasifica un schema. Mismo patrón que `isCompatible`. CD-10. |
| Modificación de `src/services/llm/transform.ts` | Bloque actual `transform.ts:190-259` | Mantener forma `maybeTransform(source,target,output,inputSchema): Promise<TransformResult>`. Insertar retry loop entre `generateTransformFn` y `applyTransformFn`. Mantener `_clearL1Cache` export. |
| `src/services/llm/__tests__/transform-verification.test.ts` (NUEVO) | `src/services/llm/transform.test.ts` (mocks ya existentes) | Mismo patrón de `vi.mock('@anthropic-ai/sdk', ...)` + `vi.mock('../../../lib/supabase.js', ...)` (NOTA: 3 niveles de `../`, NO 2, por estar en `__tests__/`). Helpers `setupLLMResponse`, `_clearL1Cache`. |
| `supabase/migrations/20260426120000_kite_schema_transforms_schema_hash.sql` (NUEVO) | `supabase/migrations/20260406000000_a2a_agent_keys.sql` | Migration aditiva: `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS`, `ALTER TABLE ... ADD CONSTRAINT`, `CREATE INDEX IF NOT EXISTS`. Idempotente (CD-13). |
| Modificación de `src/services/compose.ts:153-164` | Bloque actual del `eventService.track` | Agregar campos al objeto `metadata`. NO cambiar firma de `eventService.track`. Constructor explícito (AB-WKH-55-5): declarar cada campo, no spread. |
| Modificación de `src/types/index.ts` `TransformResult` | Bloque actual `types/index.ts:197-210` | Agregar `llm?: LLMBridgeStats` opcional. Mantener `cacheHit` legacy y `bridgeType?` (no tightener a required en esta HU; ver AB-WKH-56-2). Definir `LLMBridgeStats` en mismo bloque. |

### 3.3 Estado de BD relevante

| Tabla | Existe | Columnas actuales | Cambios |
|-------|--------|-------------------|---------|
| `kite_schema_transforms` | Sí | `id`, `source_agent_id`, `target_agent_id`, `transform_fn`, `hit_count`, `created_at`, `updated_at`. UNIQUE(source,target). INDEX (source,target). | **W1**: ADD COLUMN `schema_hash text NULL`; DROP CONSTRAINT old unique; ADD CONSTRAINT new UNIQUE(source,target,schema_hash); ADD INDEX (source,target,schema_hash). Migración idempotente (CD-13). |
| `a2a_events` | Sí | `metadata JSONB` | Sin cambios. Los nuevos campos `bridge_type`, `bridge_latency_ms`, `llm_*`, `bridge_cost_usd` van dentro de `metadata` JSON (CD-9 work-item: campos opcionales). |
| `a2a_registries` | Sí | — | Sin cambios. |

### 3.4 Componentes reutilizables encontrados

- `eventService.track({ metadata })` (event.ts:52-85) — usar `metadata.llm_*`, no agregar columnas top-level a `a2a_events`.
- `BridgeType` (types/index.ts:577-582) — importar para tipar el campo `bridge_type` que vamos a emitir.
- `isCompatible` (transform.ts:27-41) — reutilizar tal cual para validación post-apply en retry loop. **NO duplicar.**
- `_clearL1Cache` (transform.ts:262-264) — sigue siendo el único reset hook para tests.
- `console.error` (compose.ts:145-148, 165-167; transform.ts:241-247) — patrón ya usado para fire-and-forget log; reutilizar para AC-7.

---

## 4. Decisiones técnicas RESUELTAS

### DT-A (RESUELTO): Thresholds Sonnet vs Haiku

**Resolución:** El work-item ya define la regla; este SDD la formaliza así:

```
function selectModel(schema):
  if schema is undefined/null/empty:                  → 'claude-haiku-4-5-20251001'  // schema trivial
  required = schema.required[] (if array, else [])
  hasNestedObject = any property in schema.properties has { type: 'object' }
  hasUnion = ('oneOf' in schema) || ('anyOf' in schema) || ('allOf' in schema)

  isComplex = required.length >= 5 || hasNestedObject || hasUnion
  return isComplex ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001'
```

**Razón:** los 3 marcadores de complejidad (≥5 required, nested object, union types) son los más correlacionados con la dificultad de generar transform fns correctos en una sola pasada. Schemas con <5 required + tipos primitivos son ~80% del tráfico observado en pipelines hackathon (1-2 campos `query/text`). Sonnet es overkill para esos casos. CD-3 cumplido (la lógica es interna, sin env vars).

**Trade-off documentado:** Si Haiku falla validación, el retry NO escala a Sonnet (DT-C). Esto es por diseño: si Haiku no puede generar el transform al segundo intento, el problema es semántico (schema ambiguo, output corrupto), no de capacidad de modelo. El fail-fast es preferible.

**Referencia:** AC-1, AC-2 codifican estos thresholds. Tests asertarán con schema con `required.length === 4` (Haiku) y `required.length === 5` (Sonnet) → AB-WKH-56-1 (threshold numérico exacto).

### DT-B (RESUELTO): Algoritmo de fingerprint del schema

**Resolución:** Opción **(b)** — `JSON.stringify(canonicalSort(schema))` con sort recursivo de keys + SHA-256 → hex string truncado a 16 chars.

**Razón:**
- (a) `JSON.stringify(schema)` directo es no-determinístico: depende del insertion order de keys. CD-7 lo prohíbe explícitamente.
- (c) `json-canonicalize` es una dependencia npm no instalada; CD del work-item indica "no agregar dependencias salvo necesidad estricta". `crypto` de Node es built-in (no dep nueva).
- (b) es minimal, determinístico y testable. Helper de ~20 líneas en `canonical-json.ts`.

**Pseudo-spec del helper (`canonicalJson(schema)`):**

```
canonicalJson(value):
  if value is null or primitive (string/number/boolean): return JSON.stringify(value)
  if value is array: return '[' + value.map(canonicalJson).join(',') + ']'
  if value is object:
    keys = Object.keys(value).sort()  // alphabetical, stable
    parts = keys.map(k => JSON.stringify(k) + ':' + canonicalJson(value[k]))
    return '{' + parts.join(',') + '}'
  return 'null'  // catchall (fns, undefined, etc)
```

**Hash:**
```
schemaHash(schema): string  // 16 hex chars
  = crypto.createHash('sha256').update(canonicalJson(schema)).digest('hex').slice(0, 16)
```

16 chars (64 bits) son suficientes — el universo de target schemas en cache es del orden de 10² a 10⁴; chance de colisión es despreciable.

**Cache key nueva:**
```
cacheKey(source, target, schema?): string
  = `${source}:${target}:${schema ? schemaHash(schema) : 'no-schema'}`
```

**Referencia:** CD-7. AC-4 lo verifica directamente.

### DT-C (RESUELTO): Si Haiku falla 2 veces → throw, no escalar

**Resolución:** Opción **(b)** — fail-fast con throw. NO escalar a Sonnet automáticamente.

**Razón:**
- Si la primera generación produjo output incompatible y la segunda con prompt enriquecido también falla, el problema NO es el modelo: es el schema (mal definido, ambiguo) o el output (forma corrupta del agente upstream).
- Sonnet con el mismo prompt enriquecido NO va a "ver" lo que Haiku no vio en 2 intentos.
- Costo del fallback automático: 3 LLM calls (Haiku x2 + Sonnet x1) en lugar de 2. Multiplicación silenciosa de costo en producción.
- El error es accionable: el caller (`compose.ts`) ya tiene `try/catch` (compose.ts:144-149) que loggea y falla el step limpiamente.

**Forma del throw:**
```
throw new Error(
  `transform validation failed after retry: missing required fields [${missing.join(', ')}] in last attempt (model=${model})`
);
```

**Caller behavior (compose.ts ya lo maneja):** el catch existente loguea `[Compose] Transform failed at step ${i}` pero NO retorna error al usuario — el step continúa con `lastOutput` original (igual que hoy si transform falla). Esto preserva CD-2 (cero regresión funcional).

**Referencia:** AC-3. Test específico: retry-fail asserts throw matching `/transform validation failed after retry/i`.

### DT-D (RESUELTO): Migration aditiva con `schema_hash` nullable

**Resolución:** Opción **(b)** — agregar columna `schema_hash text NULL` a `kite_schema_transforms`.

**Razón:**
- (a) drop full L2 al deploy = cold-start ~3 s × N bridges × M pipelines en producción. En la primera hora post-deploy, todos los pipelines pagarían LLM call. Inaceptable.
- (b) aditivo: SELECT con `WHERE source=? AND target=? AND schema_hash=?` no matcheará entradas legacy (schema_hash IS NULL → comparación con valor ≠ NULL = NULL = falsy en SQL three-valued logic). La primera invocación post-deploy hace LLM call, persiste con `schema_hash` real → segunda invocación hit. Cold-start LIMITADO al primer hit por `(source,target,schema_hash)`, no a todo el cache.
- (c) reusar columna existente sin nueva no funciona: la unique constraint actual es `UNIQUE(source_agent_id, target_agent_id)`. Cambiar a 3-tupla requiere DROP+ADD constraint inevitablemente.

**Migration SQL** (`supabase/migrations/20260426120000_kite_schema_transforms_schema_hash.sql`):

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

**Aplicabilidad runtime:**
- `getFromL2(source, target, schemaHash)` → `WHERE source=? AND target=? AND schema_hash=?`. Entradas legacy (schema_hash NULL) NO matchean (NULL != valor) → miss → LLM regenera con schema actual y persiste con hash.
- `persistToL2(source, target, schemaHash, fn)` → upsert sobre `(source,target,schema_hash)` (la nueva 3-tuple key).

**Referencia:** AC-4. Test específico: 2 invocaciones con schemas distintos → 2 keys distintas → 2 LLM calls.

### DT-E (RESUELTO): Anthropic API timeout/5xx → re-throw (fail clean)

**Resolución:** Opción **(b)** del work-item — re-throw el error LLM. **NO** fallback a passthrough silencioso.

**Razón:**
- CD-5 dice "el pipeline no se rompa silenciosamente". `compose.ts:144-149` ya tiene `try/catch` alrededor de `maybeTransform`: el catch loggea `[Compose] Transform failed at step ${i}` y CONTINÚA con `lastOutput` sin transformar.
- Esto significa que `re-throw` desde `maybeTransform` resulta en pipeline-alive (el step actual no falla; el siguiente step recibe el output sin transformar). El comportamiento ES "no se rompe silenciosamente" porque hay un log explícito.
- Opción (a) "fallback a passthrough con error log dentro de maybeTransform" duplica el log y oculta la naturaleza del error al caller. El caller pierde la capacidad de distinguir "Anthropic timeout" vs "schema mismatch" vs "transform fn corrupto".
- Trade-off documentado: el siguiente agente probablemente fallará al recibir input incompatible (mismatch de schema). Ese fallo cae en su propio error path (HTTP 4xx desde el agente downstream → `composeService.invokeAgent` throw → compose returna `{ success: false, error: '...' }`). Failure mode predecible.

**Forma:**
- En `generateTransformFn`: `throw` propagados (timeout AbortError, network error, JSON parse error, "LLM returned empty or invalid transformFn"). Sin try/catch defensivo.
- En `maybeTransform`: el throw de retry (`transform validation failed after retry`) y los throws de generateTransformFn (Anthropic 5xx, timeout) se propagan al caller (`compose.ts`).
- En `compose.ts`: el `try { ... await maybeTransform ... } catch (transformErr) { console.error(...) }` existente (líneas 144-149) ya maneja ambos tipos de error sin tocar.

**Referencia:** CD-5 (work-item) cumplido por la combinación maybeTransform-throw + compose-catch.

### DT-F (RESUELTO en work-item): Pricing constants en módulo separado

**Confirmado:** ubicación = `src/services/llm/pricing.ts` (NO `src/lib/llm-pricing.ts` propuesta original — más cerca del único consumer `transform.ts`, mismo namespace `services/llm/`).

```ts
// src/services/llm/pricing.ts
export const PRICING_USD_PER_M_TOKENS = {
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
  'claude-sonnet-4-6':         { input: 3.00, output: 15.00 },
} as const;

export type PricedModel = keyof typeof PRICING_USD_PER_M_TOKENS;

export function computeCostUsd(
  model: PricedModel,
  tokensIn: number,
  tokensOut: number,
): number {
  const p = PRICING_USD_PER_M_TOKENS[model];
  return (tokensIn / 1_000_000) * p.input + (tokensOut / 1_000_000) * p.output;
}
```

**Pricing values — VALIDATION REQUIRED:** los valores `0.80/4.00` y `3.00/15.00` provienen del work-item §DT-F y de pricing público comúnmente referenciado. **El Architect/Dev MUST verificar contra el dashboard oficial de Anthropic (https://console.anthropic.com/pricing) antes del merge a `main`.** Si los precios reales difieren, actualizar SOLO el objeto `PRICING_USD_PER_M_TOKENS` (sin cambiar la API). Documentar la verificación en el done-report.

**Nombre del modelo Haiku:** `claude-haiku-4-5-20251001` (work-item). Si el modelo no existe con ese nombre exacto en la API, el primer call fallará y será una BLOCKER de F4. Verificar en `console.anthropic.com/models` antes del merge.

---

## 5. Arquitectura propuesta

### 5.1 Diagrama de flow nuevo `maybeTransform`

```
┌──────────────────────────────────────────────────────────────────┐
│ maybeTransform(source, target, output, inputSchema?)              │
└──────────────────────────────────────────────────────────────────┘
        │
        ▼
   ┌──────────────────┐
   │ isCompatible?    │── true ──► return { bridgeType:'SKIPPED',     │
   └──────────────────┘                     cacheHit:'SKIPPED', ... } │
        │ false                                                       │
        ▼
   ┌──────────────────┐
   │ schemaHash =     │
   │ schemaHash(schema?) │
   │ cacheKey =       │
   │ ${src}:${tgt}:${schemaHash} │
   └──────────────────┘
        │
        ▼
   ┌──────────────────┐
   │ L1 cache hit?    │── true ──► applyFn → return CACHE_L1
   └──────────────────┘
        │ false
        ▼
   ┌──────────────────┐
   │ L2 cache hit?    │── true ──► L1.set; applyFn → return CACHE_L2
   │ (schema-aware)   │
   └──────────────────┘
        │ false
        ▼
   ┌──────────────────────────────────────────┐
   │ model = selectModel(schema)              │
   │   'claude-haiku-4-5-20251001' | 'claude-sonnet-4-6'  │
   └──────────────────────────────────────────┘
        │
        ▼
   ┌──────────────────────────────────────────────────────┐
   │ Attempt 1:                                            │
   │   { fn, tokensIn, tokensOut } = generateTransformFn(  │
   │     output, schema, model, missing=[]                 │
   │   )                                                    │
   │   transformed = applyTransformFn(fn, output)          │
   │   if isCompatible(transformed, schema):               │
   │     persistToL2(source, target, schemaHash, fn) (async)│
   │     L1.set(cacheKey, fn)                              │
   │     return { bridgeType:'LLM',                        │
   │              llm:{ model, tokensIn, tokensOut,        │
   │                    retries:0,                          │
   │                    costUsd: computeCostUsd(...) } }   │
   └──────────────────────────────────────────────────────┘
        │ NOT compatible
        ▼
   ┌──────────────────────────────────────────────────────┐
   │ Attempt 2 (retry):                                    │
   │   missing = required - keys(transformed)              │
   │   console.error('[Transform] retry attempt 1', { missing }) │
   │   { fn2, tIn2, tOut2 } = generateTransformFn(         │
   │     output, schema, model, missing  ← incluido en prompt │
   │   )                                                    │
   │   transformed2 = applyTransformFn(fn2, output)        │
   │   if isCompatible(transformed2, schema):              │
   │     persistToL2 (con fn2, hash); L1.set(cacheKey, fn2)│
   │     return { bridgeType:'LLM',                        │
   │              llm:{ model,                              │
   │                    tokensIn: tIn1+tIn2, tokensOut: tOut1+tOut2, │
   │                    retries:1,                          │
   │                    costUsd: computeCostUsd(model, total tokens) }} │
   │   else:                                                │
   │     missingFinal = required - keys(transformed2)      │
   │     throw new Error('transform validation failed after retry: missing fields [...]') │
   └──────────────────────────────────────────────────────┘
```

### 5.2 Tipos extendidos (`src/types/index.ts`)

```ts
/** WKH-57: telemetry del path LLM. Presente sii bridgeType==='LLM'. */
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

**Nota AB-WKH-56-2:** `bridgeType` se mantiene optional (no se hace required) porque eso es transición de tipos para un futuro hardening, no scope de WKH-57. El campo se POPULA en TODOS los returns de `maybeTransform` (incluyendo el W3 nuevo retry path). `compose.ts` ya lee `tr.bridgeType ?? null` (línea 163) — sin cambios de contrato.

### 5.3 Pricing constants (`src/services/llm/pricing.ts`)

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

### 5.4 Helpers nuevos

**`src/services/llm/canonical-json.ts`** (puro, never-throw para JSON-able input):

```ts
/**
 * Returns deterministic JSON of `value`: keys sorted alphabetically, recursive.
 * Pure. Never throws for JSON-serializable input. (CD-7, AB-WKH-55-4.)
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => JSON.stringify(k) + ':' + canonicalJson((value as Record<string, unknown>)[k]),
  );
  return '{' + parts.join(',') + '}';
}

/** SHA-256 hex truncado a 16 chars del canonicalJson. Pure. */
import { createHash } from 'node:crypto';
export function schemaHash(schema: Record<string, unknown> | undefined): string {
  if (!schema) return 'no-schema';
  return createHash('sha256').update(canonicalJson(schema)).digest('hex').slice(0, 16);
}
```

**`src/services/llm/select-model.ts`** (puro):

```ts
import type { PricedModel } from './pricing.js';

/**
 * WKH-57 DT-A: selector cost-aware.
 * - 'claude-haiku-4-5-20251001' for trivial schemas.
 * - 'claude-sonnet-4-6'         for complex schemas (≥5 required, nested object, oneOf/anyOf/allOf).
 *
 * Pure. Never throws for any input shape (defensive). (CD-10, AB-WKH-55-4.)
 */
export function selectModel(schema: Record<string, unknown> | undefined): PricedModel {
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

### 5.5 Cambios en `compose.ts:153-164` (event metadata)

Constructor explícito (AB-WKH-55-5), todos los nuevos campos opcionales con `?? null` (AB-WKH-56-4):

```ts
// ── compose.ts (POST-WKH-57) ──
const llm = (result as StepResult & { transformLLM?: LLMBridgeStats }).transformLLM;
//                                       ↑ campo de carry-over en StepResult (ver §5.6)
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
      bridge_type:        result.bridgeType        ?? null,
      bridge_latency_ms:  result.transformLatencyMs ?? null,
      bridge_cost_usd:    llm?.costUsd              ?? null,
      llm_model:          llm?.model                ?? null,
      llm_tokens_in:      llm?.tokensIn             ?? null,
      llm_tokens_out:     llm?.tokensOut            ?? null,
    },
  })
  .catch((err) => console.error('[Compose] event tracking failed:', err));
```

**Nota AB-WKH-56-4:** todos los `??` resuelven a `null` cuando el campo izquierdo es `undefined` (el caso típico para non-LLM bridge). Documentado en CD-15.

### 5.6 Cambios en `StepResult` (`src/types/index.ts`)

Agregar campo opcional `transformLLM?: LLMBridgeStats` (carry-over desde `TransformResult.llm` al evento). NO romper consumers existentes:

```ts
export interface StepResult {
  // ... existing fields ...
  /** WKH-57: telemetry del bridge LLM. Presente solo si bridgeType==='LLM'. */
  transformLLM?: LLMBridgeStats;
}
```

Asignación en `compose.ts` (post-`maybeTransform`):

```ts
const tr = await maybeTransform(...);
result.cacheHit = tr.cacheHit;             // legacy
result.bridgeType = tr.bridgeType;         // WKH-56
result.transformLatencyMs = tr.latencyMs;
if (tr.llm) result.transformLLM = tr.llm;  // WKH-57 (constructor explícito; null path = omit)
lastOutput = tr.transformedOutput;
```

---

## 6. Plan de implementación — Waves

### W0 — Helpers puros (serial, standalone)

Bloque sin dependencias entre archivos. Mergeable por separado.

| W0 task | Archivo | Acción | Exemplar | Verificación |
|---------|---------|--------|----------|---------------|
| W0.1 | `src/services/llm/pricing.ts` | NUEVO | `src/lib/downstream-payment.ts:130-160` | `tsc --noEmit` clean |
| W0.2 | `src/services/llm/canonical-json.ts` | NUEVO | `src/services/a2a-protocol.ts` (helpers puros) | `tsc --noEmit` clean |
| W0.3 | `src/services/llm/select-model.ts` | NUEVO | `src/services/llm/transform.ts:27-41` (`isCompatible`) | `tsc --noEmit` clean |
| W0.4 | `src/types/index.ts` | EXTEND `LLMBridgeStats` + `TransformResult.llm?` + `StepResult.transformLLM?` | Bloque WKH-56 (líneas 197-210) | `tsc --noEmit` clean |
| W0.5 | Tests inline para W0.1..W0.3 (en `__tests__/transform-verification.test.ts` o test files locales — ver §7) | NUEVOS | `transform.test.ts` patrón | `vitest run` clean |

### W1 — DB migration

Aplicar migration aditiva. Standalone (no depende de W0).

| W1 task | Archivo | Acción | Verificación |
|---------|---------|--------|---------------|
| W1.1 | `supabase/migrations/20260426120000_kite_schema_transforms_schema_hash.sql` | NUEVO | SQL idempotente (CD-13) |
| W1.2 | Aplicar la migration localmente (`npx supabase db push` o equivalente) | Manual | Verificar columna `schema_hash` exists en BD |

### W2 — Cache key con `schema_hash` (depende de W0.2 + W1)

| W2 task | Archivo | Acción |
|---------|---------|--------|
| W2.1 | `src/services/llm/transform.ts` `getFromL2` | aceptar `schemaHash` arg + `WHERE source=? AND target=? AND schema_hash=?` |
| W2.2 | `src/services/llm/transform.ts` `persistToL2` | aceptar `schemaHash` arg + insertar columna en upsert + onConflict triple |
| W2.3 | `src/services/llm/transform.ts` `maybeTransform` | calcular `schemaHash(inputSchema)` antes del L1/L2 lookup; cache key = 3-tuple |

### W3 — Model selector + retry loop + telemetría (depende de W0.1+W0.3+W0.4+W2)

| W3 task | Archivo | Acción |
|---------|---------|--------|
| W3.1 | `src/services/llm/transform.ts` `generateTransformFn` | aceptar args `model: PricedModel` y `missingFields: string[]`; usar el model en `client.messages.create({model})`; si `missingFields.length>0` agregar al systemPrompt una línea "PREVIOUS ATTEMPT FAILED: missing required fields [X, Y]"; retornar `{ fn, tokensIn, tokensOut }` (NO solo `string`) |
| W3.2 | `src/services/llm/transform.ts` `maybeTransform` | reemplazar bloque `// 4. Cache miss → LLM` por flow §5.1: selectModel → attempt1 → verify → (retry if fail with missing fields) → return o throw |
| W3.3 | `src/services/llm/transform.ts` `maybeTransform` | en attempt 1 (success path) → return con `llm: { model, tokensIn, tokensOut, retries:0, costUsd }`; en attempt 2 (success path) → return con `llm: { ..., tokensIn: t1+t2, tokensOut: t1+t2, retries:1, costUsd }`; en cache hits y SKIPPED → `llm: undefined` (no setear el campo) — AB-WKH-56-2 |
| W3.4 | `src/services/llm/transform.ts` `maybeTransform` | console.error siempre que retries>0, ANTES del eventual throw o return — AC-7 |

### W4 — compose.ts pasa telemetría al evento (depende de W3)

| W4 task | Archivo | Acción |
|---------|---------|--------|
| W4.1 | `src/services/compose.ts:130-135` | leer `tr.llm` y asignar `result.transformLLM = tr.llm` (constructor explícito; si undefined no setear) |
| W4.2 | `src/services/compose.ts:153-164` | construir el objeto `metadata` con los 6 campos del §5.5; usar `?? null` en cada campo nuevo |

### W5 — Tests integración (depende de TODO)

| W5 task | Archivo | Acción |
|---------|---------|--------|
| W5.1 | `src/services/llm/__tests__/transform-verification.test.ts` | NUEVO — covers AC-1..AC-5 + AC-7 (ver §7) |
| W5.2 | `src/services/llm/transform.test.ts` | AJUSTAR — los tests T-1..T-5 deben seguir pasando. Ajustes mínimos sólo para nuevo shape de `TransformResult` (e.g., T-1 puede asertar `result.bridgeType==='LLM'` además del `cacheHit`). NO REMOVER ningún test (AC-8). |
| W5.3 | (opcional) `src/services/compose.test.ts` o nuevo test | AC-6: assert que `eventService.track` se llama con `metadata` que incluye los 6 campos nuevos. Si baseline no tiene mocks de `eventService`, agregar mock minimal local. |

### Verificación incremental

| Wave | Verificación al completar |
|------|---------------------------|
| W0 | `npx tsc --noEmit` clean; `vitest run src/services/llm/canonical-json` (si test inline) clean |
| W1 | Migration aplicada en local DB; `\d kite_schema_transforms` muestra columna `schema_hash` |
| W2 | `vitest run src/services/llm/transform.test.ts` PASS (T-1..T-5 sin regresión); query manual a Supabase verifica nueva key |
| W3 | `vitest run src/services/llm/__tests__/transform-verification.test.ts` PASS para AC-1..AC-3 |
| W4 | `vitest run src/services/compose.test.ts` PASS (mocked eventService recibe nueva metadata) |
| W5 | Full `npm run test` clean; coverage de `transform.ts` por inspección manual de branches ≥90% (AB-WKH-56-3) |

---

## 7. Test plan — un test por AC mínimo

| AC | Test name | Archivo | Mecánica |
|----|-----------|---------|----------|
| AC-1 | `T-V1: schema with 4 required + primitives selects Haiku` | `__tests__/transform-verification.test.ts` | mock Anthropic; invoke maybeTransform con schema `{ required: ['a','b','c','d'], properties: { a:{type:'string'},...} }`; assert `mockCreate.mock.calls[0][0].model === 'claude-haiku-4-5-20251001'`; assert `result.llm.model === 'claude-haiku-4-5-20251001'` |
| AC-2 | `T-V2a: 5 required selects Sonnet` + `T-V2b: nested object selects Sonnet` + `T-V2c: oneOf selects Sonnet` | `__tests__/transform-verification.test.ts` | 3 sub-tests; cada uno con un trigger distinto; assert model === `'claude-sonnet-4-6'` |
| AC-3 (happy) | `T-V3a: retry succeeds on second attempt` | `__tests__/transform-verification.test.ts` | mockCreate retorna en attempt 1 un transform `'return {wrong:1}'` (NO cumple required); en attempt 2 retorna `'return {required_field: output.x}'`; assert `result.llm.retries === 1`, `result.transformedOutput` ok, mockCreate called 2x |
| AC-3 (sad) | `T-V3b: retry fails on second attempt throws` | `__tests__/transform-verification.test.ts` | mockCreate retorna 2x un transform que NO cumple; assert rejects con `/transform validation failed after retry/i`; mensaje incluye nombre de campo faltante |
| AC-4 | `T-V4: schema change between calls produces different cache keys` | `__tests__/transform-verification.test.ts` | call 1 con schemaA → mockCreate called 1x; call 2 mismo source/target con schemaB (key distinta) → mockCreate called 2x (no L1 hit por hash distinto); spy en `supabase.from('kite_schema_transforms').select().eq('schema_hash', X)` recibe 2 valores distintos |
| AC-5 (LLM) | `T-V5a: result.llm shape on LLM bridge` | `__tests__/transform-verification.test.ts` | assert `typeof result.llm.model === 'string'`, `result.llm.tokensIn > 0`, `result.llm.tokensOut > 0`, `result.llm.retries === 0`, `result.llm.costUsd > 0` |
| AC-5 (non-LLM) | `T-V5b: result.llm undefined on SKIPPED, CACHE_L1, CACHE_L2` | `__tests__/transform-verification.test.ts` | 3 escenarios: SKIPPED (compatible), CACHE_L1 (segundo call mismo schema), CACHE_L2 (mock supabase hit); assert `result.llm === undefined` en los 3 |
| AC-6 | `T-V6: compose_step event metadata includes 6 fields` | `compose.test.ts` (extender) o `__tests__/transform-verification.test.ts` con mock de eventService | mock `eventService.track`; ejecutar compose con LLM bridge; assert track called con `metadata: { bridge_type:'LLM', bridge_latency_ms: number, bridge_cost_usd: number, llm_model: string, llm_tokens_in: number, llm_tokens_out: number }`. Repetir con SKIPPED → assert `llm_*` y `bridge_cost_usd` son `null` |
| AC-7 | `T-V7: console.error called on retry attempt` | `__tests__/transform-verification.test.ts` | spy `console.error`; trigger retry happy path; assert `console.error` called con string que incluye nombre de campo faltante y "retry" |
| AC-8 (T-1..T-5) | (existing tests) | `transform.test.ts` | run sin modificar; deben PASS (ajustes solo de assertion shape, no remoción) |
| AC-8 (coverage) | manual | — | review branches: selectModel 4 paths, generateTransformFn happy + retry-prompt path, retry success, retry fail, SKIPPED, L1 hit, L2 hit, schema undefined → asegurar ≥90% líneas y ≥80% branches por inspección. AB-WKH-56-3: NO usar `--coverage` (tooling no instalado). |
| Pricing/canonical | `T-Wp1..T-Wp4: PRICING_USD_PER_M_TOKENS shape, computeCostUsd math, canonicalJson sort, schemaHash determinismo` | `__tests__/transform-verification.test.ts` | tests unitarios de helpers W0 |
| selectModel | `T-Ws1..T-Ws6: selectModel returns Haiku/Sonnet for cada caso` | `__tests__/transform-verification.test.ts` | tests unitarios |

**Total de tests nuevos esperados:** ~14-18 (en transform-verification.test.ts) + 1-2 en compose.test.ts. Baseline previo (transform.test.ts T-1..T-5 + 9 compose) sin remoción.

---

## 8. Constraint Directives (Anti-alucinación)

### Heredados del work-item

- **CD-1:** PROHIBIDO `any` explícito en TS — strict mode todos los archivos.
- **CD-2:** PROHIBIDO regresión funcional — flujos non-LLM (SKIPPED, CACHE_L1, CACHE_L2, A2A_PASSTHROUGH) idénticos.
- **CD-3:** PROHIBIDO env vars nuevas — model selector es lógica interna.
- **CD-4:** PROHIBIDO endpoints nuevos.
- **CD-5:** OBLIGATORIO no romper silenciosamente ante Anthropic 5xx — resuelto en DT-E (re-throw + compose-catch existente).
- **CD-6:** OBLIGATORIO pricing constants centralizadas — ubicación `src/services/llm/pricing.ts` (DT-F).
- **CD-7:** OBLIGATORIO schema fingerprint determinístico — resuelto en DT-B (`canonicalJson` + SHA-256).
- **CD-8:** PROHIBIDO `eval()` — mantener `new Function('output', body)`.
- **CD-9 (work-item):** OBLIGATORIO nuevos campos en `compose_step` event sean opcionales/nullable (zero breaking change).
- **CD-10 (work-item):** OBLIGATORIO retry prompt incluye nombre del campo faltante (no genérico).

### Nuevos en este SDD

- **CD-11 (SDD):** OBLIGATORIO `pricing.ts` exporta `PRICING_USD_PER_M_TOKENS` con `as const` (immutable). PROHIBIDO mutar el objeto en runtime.
- **CD-12 (SDD):** OBLIGATORIO `selectModel`, `canonicalJson`, `schemaHash`, `computeCostUsd` son funciones puras (sin I/O, sin throws en input válido). AB-WKH-55-4.
- **CD-13 (SDD):** OBLIGATORIO migration SQL es idempotente (`ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS`, `CREATE INDEX IF NOT EXISTS`).
- **CD-14 (SDD):** OBLIGATORIO `console.error` en retry NO debe leak el contenido raw del output o del schema (puede tener PII de payloads). Solo nombres de campos faltantes + retry count + model. Ej: `[Transform] retry attempt 1: missing fields [query, context] (model=claude-haiku-4-5-20251001)`.
- **CD-15 (SDD):** OBLIGATORIO los 6 campos nuevos de `metadata` en `compose_step` evento usan `?? null` (AB-WKH-56-4) — sin esto `JSON.stringify(metadata)` deja `undefined` keys ausentes y dashboards leen `undefined !== null`.
- **CD-16 (SDD):** PROHIBIDO escalar a Sonnet automáticamente cuando Haiku falla retry — fail-fast con throw (DT-C).
- **CD-17 (SDD):** OBLIGATORIO el campo `result.llm` se OMITE (no se setea como `null`) en bridges non-LLM. AB-WKH-56-2: el AC-5 dice "undefined", no "null". Constructor explícito, sin spread.
- **CD-18 (SDD):** OBLIGATORIO si Haiku throws (network/timeout) → propagar throw. PROHIBIDO swallow + escalar a Sonnet. CD-5 + DT-E.

### Auto-blindajes históricos aplicados

- **AB-WKH-56-1** (threshold numérico exacto): tests AC-1/AC-2 asertarse con `required.length === 4` y `required.length === 5` (no "varios" ni rangos vagos).
- **AB-WKH-56-2** (campo absent only in case X): el campo `result.llm` se OMITE en non-LLM (no `llm: null`).
- **AB-WKH-56-3** (validar tooling antes de aceptar AC de coverage): coverage AC-8 valida por inspección manual; NO se usa `vitest --coverage` (paquete no instalado en repo, según WKH-56 done-report).
- **AB-WKH-56-4** (documentar `??` semantics): los 6 campos nuevos en metadata usan `?? null`; documentado en CD-15.
- **AB-WKH-55-4** (never-throw en módulo crítico): aplicado a helpers puros (`selectModel`, `canonicalJson`, `schemaHash`, `computeCostUsd`) — NO a `maybeTransform`, que sí debe throw para que compose lo catchee.
- **AB-WKH-55-5** (constructor explícito, NO spread): aplicado a `LLMBridgeStats` y al objeto `metadata` del evento.
- **AB-WKH-55-10** (test baseline invariante): los 5 tests T-1..T-5 + 9 tests baseline compose se mantienen.
- **AB-WKH-53-#2** (architect↔disco drift): este SDD verificó con `Read` que `compose.ts:153-164`, `transform.ts:190-259`, `event.ts:52-85`, `kite_schema_transforms.sql` UNIQUE existen literalmente como se cita.

---

## 9. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| Pricing values incorrectos → billing dashboard erróneo | M | M | CD del work-item: validar contra console.anthropic.com antes del merge. Si es necesario actualizar, cambiar SOLO el objeto `PRICING_USD_PER_M_TOKENS`. |
| Nombre `claude-haiku-4-5-20251001` no existe en API | B | A | Smoke test en F4: invocar maybeTransform con schema simple en entorno con `ANTHROPIC_API_KEY` real → verificar response no es 404 model_not_found. Si falla, BLOCKER F4. |
| Cambio en unique constraint rompe upserts existentes | B | A | Migration drop/add explícito (CD-13); rollback es `DROP CONSTRAINT new + ADD CONSTRAINT old`. Documentar en done-report. |
| Latencia adicional por retry duplica tiempo de bridge | B | M | Solo afecta path LLM con schema malformado. Caso happy 0 retries. Smoke test en F4 cuantifica latencia retry vs no-retry. |
| `canonicalJson` en input con `undefined` o `function` (no JSON-able) | B | B | `JSON.stringify(undefined)` retorna `undefined` no string → defensiva: `JSON.stringify(value) ?? 'null'` en path primitive. NO debería pasar (input es schema JSON parseado), pero la guardia es defensiva. |
| Cache cold-start en deploy (entradas legacy stale) | B | B | Aceptado por DT-D — primer hit por (source,target,schema_hash) hace LLM call, segundo hit ya está poblado. Mucho mejor que invalidar full L2. |
| Tests con 3 niveles de `../` rompen import paths | B | B | Verificado en exemplar `agent-card.test.ts` (también está en `__tests__/`). Ajustar imports en test file (`'../../../lib/supabase.js'`). |

---

## 10. Dependencias

- WKH-56 mergeado a `main` (PR #28) ✓ — provee `BridgeType` (`types/index.ts:577-582`), `isA2AMessage` (`a2a-protocol.ts:27`), `AgentCard.capabilities.a2aCompliant` (`types/index.ts:404`).
- Anthropic SDK ya instalado (`@anthropic-ai/sdk`) ✓ — usado en `transform.ts:9`.
- `crypto` (Node built-in) ✓ — sin dependency nueva.
- Supabase migration tooling ✓ — migrations existen en `supabase/migrations/`.
- `process.env.ANTHROPIC_API_KEY` configurado en runtime ✓ — usado en F4 smoke real.

---

## 11. Missing Inputs / Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| `[VALIDATION REQUIRED]` | DT-F (§4) | Pricing exacto (`0.80/4.00`, `3.00/15.00`) — debe confirmarse contra `console.anthropic.com/pricing` antes del merge a main. Si difiere, actualizar el objeto `PRICING_USD_PER_M_TOKENS`. | **NO bloqueante de F2**. Bloqueante de F4 (deploy). |
| `[VALIDATION REQUIRED]` | DT-F (§4) | Nombre del modelo Haiku 4.5: `claude-haiku-4-5-20251001`. Verificar en `console.anthropic.com/models`. Si no existe con ese string exacto, primer call producirá 404 → BLOCKER F4. | **NO bloqueante de F2**. Bloqueante de F4. |

**No hay `[NEEDS CLARIFICATION]` activos.** Todas las DTs originales (DT-A..DT-E) están RESUELTAS en §4.

---

## 12. Readiness Check (gate F2)

```
READINESS CHECK:
[X] Cada AC tiene al menos 1 archivo asociado en tabla §6 (W0..W5)
[X] Cada archivo en §6 tiene un Exemplar valido verificado en disco (§3.2)
[X] No hay [NEEDS CLARIFICATION] pendientes — solo 2 [VALIDATION REQUIRED] no bloqueantes de F2
[X] Constraint Directives incluyen 8 PROHIBIDO/OBLIGATORIO heredados + 8 nuevos del SDD (16 totales)
[X] Context Map tiene 11 archivos leídos en disco (§3.1)
[X] Scope IN y OUT son explícitos y no ambiguos (§2)
[X] BD: tabla `kite_schema_transforms` verificada existe; migration scripted (DT-D)
[X] Flujo principal (Happy Path) descrito en §5.1 (diagrama ASCII completo)
[X] Flujo de error definido: throw retry-fail (DT-C); re-throw network/timeout (DT-E)
[X] Auto-blindajes históricos aplicados (AB-WKH-56-1..4, AB-WKH-55-4/5/10, AB-WKH-53-#2) — §8
[X] DTs OPEN del work-item (DT-A..DT-E) RESUELTAS en §4 con razón explícita
[X] Cada AC del work-item (AC-1..AC-8) mapeado a test específico en §7
[X] Pricing values con marker explícito de validación (no inventados sin marker)
[X] Migration SQL idempotente (CD-13)
[X] No se modifican archivos fuera del Scope IN
```

**Veredicto:** READY for SPEC_APPROVED.

---

*SDD generado por NexusAgil — F2 (Architect) — 2026-04-26*
