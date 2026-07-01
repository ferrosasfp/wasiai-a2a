# SDD — [WKH-135] Centralizar la config LLM/modelo en un único punto env-driven

- HU: WKH-135 (doc/sdd/132-wkh-135-centralize-llm-config)
- Modo: QUALITY (toca money-path de telemetría de costos + planner + type compartido)
- SDD_MODE: full · Estimación: M
- Branch sugerido: `refactor/135-centralize-llm-config`
- Fase: F2 (SDD) — gate previo `HU_APPROVED` ✅

---

## 0. Resumen ejecutivo del diseño

Hoy 4 archivos duplican los mismos knobs LLM: los model IDs de Claude
(`claude-sonnet-5`, `claude-haiku-4-5-20251001`), el timeout `30_000` (×3) y 3
`max_tokens` distintos. Cambiar un modelo obliga a editar cada sitio (drift).

La solución NO inventa modelo nuevo: **converge al patrón defensivo env-driven
que ya existe dos veces en el repo** — `getProtocolFeeRate()`
(`fee-charge.ts:100-121`) y `parseOverheadEnv()/clampOverhead()`
(`gas-overhead.ts:106-132`). Se crea **un módulo `src/services/llm/models.ts`**
con 8 getters env-driven (default = valor hardcodeado actual) y 2 helpers
defensivos (parse + validación + fallback + `log.warn`, nunca throw). Los 4
call-sites pasan a importar de ahí. `pricing.ts` gana un **lookup tolerante**:
un model ID env-driven fuera de la tabla degrada a un precio default seguro +
`log.warn`, sin crash (AC-2/CD-2). El tipo compartido `LLMBridgeStats.model`
(`types/index.ts:341`) pasa de union literal a `string` — **widening puro,
blast radius nulo** (el único consumer lo escribe en un campo JSONB de
telemetría sin narrowing; ver §DT-3).

Superficie tocada: `src/services/llm/{models.ts (nuevo), pricing.ts,
select-model.ts, transform.ts, input-retry.ts}` + `src/services/orchestrate.ts`
+ `src/types/index.ts` + `.env.example`. **Cero cambio de comportamiento sin
overrides** (AC-3): mismos model IDs, mismo timeout, mismos `max_tokens`,
`selectModel()` (WKH-57) y `thinking: { type: 'disabled' }` (WKH-134) intactos.

### ⚠️ Drift detectado (reportado al humano, no bloqueante para esta HU)
`.nexus/project-context.md:62` declara `LLM: Claude Sonnet
(claude-sonnet-4-20250514)`. **El código real usa `claude-sonnet-5`**
(`orchestrate.ts:34`, `select-model.ts:18,21,32`, `pricing.ts:15`) y
`claude-haiku-4-5-20251001`. Esta HU toma como **fuente de verdad el código**
(los valores que efectivamente corren en prod hoy) para fijar los defaults —
CD-5 exige defaults byte-idénticos al comportamiento actual, y ese
comportamiento es `claude-sonnet-5`/`claude-haiku-4-5-20251001`, NO el string
stale del context. Recomendación separada: actualizar `project-context.md:62` a
`claude-sonnet-5` (fuera de scope de esta HU).

---

## 1. Context Map (archivos leídos — F0 grounding propio)

| Archivo:línea (verificado) | Por qué lo leí | Qué extraje |
|---|---|---|
| `src/services/orchestrate.ts:34` | planner MODEL | `const MODEL = 'claude-sonnet-5'` (import-time const) |
| `src/services/orchestrate.ts:35` | planner timeout | `const LLM_TIMEOUT_MS = 30_000` |
| `src/services/orchestrate.ts:191-197` | planner call | `model: MODEL, max_tokens: 1024, thinking: { type: 'disabled' }` (CD-1) |
| `src/services/orchestrate.ts:41,94` | DT-5 candidatos | `MAX_AGENTS_IN_PROMPT = 30` / `PRE_COMPOSE_TIMEOUT_MS = 90_000` (single-site) |
| `src/services/llm/select-model.ts:12,14,18,21,32,37` | selector | firma `: PricedModel`; literales trivial=`claude-haiku-4-5-20251001`, complex=`claude-sonnet-5`; lógica de schema (WKH-57) |
| `src/services/llm/pricing.ts:13-18` | tabla + tipo | `PRICING_USD_PER_M_TOKENS` (Haiku 1/5, Sonnet 3/15) `as const`; `PricedModel = keyof typeof` |
| `src/services/llm/pricing.ts:21-28` | money-path | `computeCostUsd(model: PricedModel, …)` — index directo `PRICING[model]`, NO tolerante (crash si model desconocido) |
| `src/services/llm/transform.ts:34` | transform timeout | `const TIMEOUT_MS = 30_000` |
| `src/services/llm/transform.ts:163-172` | transform call | `model, max_tokens: 512, thinking: { type: 'disabled' }` (CD-1) |
| `src/services/llm/transform.ts:23,121,309,325,415` | tipado + uso | importa `computeCostUsd, type PricedModel`; `generateTransformFn(model: PricedModel)`, `buildLLMResult(model: PricedModel)`, `computeCostUsd(model,…)`, `const model = selectModel(inputSchema)` |
| `src/services/llm/input-retry.ts:25,26,89` | input-retry | `MODEL = 'claude-haiku-4-5-20251001'`, `TIMEOUT_MS = 30_000`, `max_tokens: 1024`; contrato "NEVER throws → return null" |
| `src/types/index.ts:339-350` | type change | `LLMBridgeStats.model: 'claude-haiku-4-5-20251001' \| 'claude-sonnet-5'` (línea 341); demás campos numéricos |
| `src/services/compose.ts:680,695` | consumer de LLMBridgeStats | lee `result.transformLLM` y escribe `llm_model: llm?.model ?? null` en `metadata` (JSONB, sin narrowing) → único consumer del literal |
| `src/services/fee-charge.ts:100-121` | **exemplar CD-6** | patrón: leer env por call, `Number.parseFloat`, `Number.isFinite` + rango, fallback const, `log.error` estructurado, nunca throw |
| `src/lib/gas-overhead.ts:106-132` | **exemplar CD-6 (2º)** | `parseOverheadEnv(raw)`: trim, `Number.isFinite`, clamp `[0,MAX]`, retorna `undefined` si ausente → caller usa default |
| `src/services/llm/pricing.test.ts`, `select-model.test.ts`, `__tests__/transform-verification.test.ts` | regresión | assertions con literales exactos `.toBe('claude-haiku-4-5-20251001'/'claude-sonnet-5')` y costos exactos → NO deben romperse con defaults (AC-3) |
| Auto-Blindaje `119-gas-overhead-passthrough/auto-blindaje.md` | lección | fuga de env/mocks entre tests hermanos (`*Once` sobrevive `clearAllMocks`) → CD-9 |

**Confirmación de line-numbers del work-item:** todos coinciden salvo el rango
del call del planner (work-item cita `:192` para `max_tokens`; el bloque real
es `orchestrate.ts:191-197`, `max_tokens: 1024` en `:192` ✔ y `thinking` en
`:197`). Sin correcciones materiales.

---

## 2. Decisiones técnicas (DT-N — todas resueltas)

### DT-1 — Módulo único: `src/services/llm/models.ts`
**Nombre/ubicación:** `src/services/llm/models.ts`. Se prefiere `models.ts` a
`config.ts` porque el contenido primario son **model IDs** + knobs LLM
directamente ligados a esos modelos; `config.ts` es demasiado genérico y
colisiona conceptualmente con otras configs del servicio.

**Getters vs const de módulo (decisión):** getters **funciones**, NO `const`
de import-time. Rationale: (a) espeja `getProtocolFeeRate()` (CD-6 exige el
mismo patrón defensivo, que es una función leída por call); (b) permite
override por env **sin re-importar el módulo** en tests (AC-4 testeable con
`process.env.X = …`); (c) sin cache — un restart de Railway basta para aplicar
un nuevo valor, igual que `PROTOCOL_FEE_RATE`. Con env unset, una función que
retorna el default es **byte-idéntica** al `const` actual (AC-3).

**Contrato de exports:**

```ts
// src/services/llm/models.ts
// Defaults = valores hardcodeados HOY (CD-5). Fuente de verdad: el código actual.
const DEFAULT_PLANNER_MODEL      = 'claude-sonnet-5';
const DEFAULT_COMPLEX_MODEL      = 'claude-sonnet-5';
const DEFAULT_TRIVIAL_MODEL      = 'claude-haiku-4-5-20251001';
const DEFAULT_INPUT_RETRY_MODEL  = 'claude-haiku-4-5-20251001';
const DEFAULT_LLM_TIMEOUT_MS     = 30_000;
const DEFAULT_PLANNER_MAX_TOKENS      = 1024;
const DEFAULT_TRANSFORM_MAX_TOKENS    = 512;
const DEFAULT_INPUT_RETRY_MAX_TOKENS  = 1024;

// Rango de sanidad para los knobs numéricos (evita 0/negativo/NaN/absurdos).
const MIN_TIMEOUT_MS = 1;          const MAX_TIMEOUT_MS = 600_000;   // 10 min
const MIN_MAX_TOKENS = 1;          const MAX_MAX_TOKENS = 200_000;   // límite SDK

// Model IDs (string no-vacío; env override directo)
export function getPlannerModel(): string;      // env LLM_PLANNER_MODEL
export function getComplexModel(): string;      // env LLM_COMPLEX_MODEL
export function getTrivialModel(): string;      // env LLM_TRIVIAL_MODEL
export function getInputRetryModel(): string;   // env LLM_INPUT_RETRY_MODEL

// Timeout (compartido por planner/transform/input-retry — hoy los 3 son 30_000)
export function getLlmTimeoutMs(): number;       // env LLM_TIMEOUT_MS

// max_tokens por call-site (distintos hoy: 1024 / 512 / 1024)
export function getPlannerMaxTokens(): number;      // env LLM_PLANNER_MAX_TOKENS
export function getTransformMaxTokens(): number;    // env LLM_TRANSFORM_MAX_TOKENS
export function getInputRetryMaxTokens(): number;   // env LLM_INPUT_RETRY_MAX_TOKENS
```

**Helpers defensivos internos (espejo de `getProtocolFeeRate`/`parseOverheadEnv`):**

```ts
const log = getLogger('llm-models');

/** Model ID: string no-vacío. Vacío/undefined → default. Nunca throw. */
function readModelEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim();
}

/** Int positivo en [min,max]. NaN/Infinity/fuera de rango → fallback + warn. */
function readIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    log.warn({ env: name, raw, min, max, fallback },
      'Invalid LLM config env (must be integer in range); falling back to default');
    return fallback;
  }
  return parsed;
}
```

Cada getter es un one-liner: `return readModelEnv('LLM_PLANNER_MODEL',
DEFAULT_PLANNER_MODEL)` / `return readIntEnv('LLM_TIMEOUT_MS',
DEFAULT_LLM_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)`.

> **Nota timeout único vs por call-site:** hoy los 3 timeouts son el mismo
> literal `30_000`. Se centraliza en **un** `getLlmTimeoutMs()` / `LLM_TIMEOUT_MS`
> (los 3 call-sites lo comparten) — es fiel al estado actual y evita 3 env vars
> redundantes. Si en el futuro se necesita divergir, se agrega un override por
> call-site sin romper este contrato. Los `max_tokens` SÍ divergen hoy
> (1024/512/1024) → 3 getters/env vars separados.

### DT-2 — Pricing robusto (AC-2/CD-2, money-path)
**Decisión: la tabla de precios sigue SEPARADA** (`PRICING_USD_PER_M_TOKENS` en
`pricing.ts`), NO se co-loca el precio junto al model ID en `models.ts`.
Rationale:
1. `pricing.ts` tiene un contrato de auditoría propio ("MUST be validated
   against Anthropic console pricing page before deploy", header) — mezclarlo
   con model IDs env-driven fragmenta esa validación.
2. Co-locar precio con model ID obligaría a que **cada** override de modelo
   traiga TAMBIÉN un override de precio (2 env vars acopladas) → expande scope y
   contradice "no inventes knobs nuevos".
3. Un override de modelo apunta típicamente a un ID **nuevo** cuyo precio no
   conocemos: la respuesta correcta es **degradar tolerante**, no exigir config
   extra.

**`computeCostUsd` tolerante (no throw):**

```ts
import { getLogger } from '../../lib/logger.js';
const log = getLogger('pricing');

/**
 * DEFAULT_PRICING — precio seguro para un model ID fuera de la tabla.
 * CD-10: usa el rate CONOCIDO más alto (Sonnet $3/$15) para NUNCA
 * sub-reportar costo en telemetría (over-estimate > under-estimate en money-path).
 */
const DEFAULT_PRICING = { input: 3.0, output: 15.0 } as const;

export function computeCostUsd(model: string, tokensIn: number, tokensOut: number): number {
  const known = Object.hasOwn(PRICING_USD_PER_M_TOKENS, model);
  const p = known ? PRICING_USD_PER_M_TOKENS[model as PricedModel] : DEFAULT_PRICING;
  if (!known) {
    log.warn({ model, fallback: DEFAULT_PRICING },
      'unknown model ID not in PRICING_USD_PER_M_TOKENS; using safe default price (no throw)');
  }
  return (tokensIn / 1_000_000) * p.input + (tokensOut / 1_000_000) * p.output;
}
```

**Resolución del tipado (`PricedModel`):**
- `PricedModel = keyof typeof PRICING_USD_PER_M_TOKENS` **se conserva** (union de
  modelos conocidos) — sigue tipando la tabla y los tests exactos.
- La **firma de `computeCostUsd` se ensancha a `(model: string, …)`**. Es
  widening puro: todos los call-sites que hoy pasan `PricedModel` (asignable a
  `string`) siguen compilando. El único `as` es `model as PricedModel` para el
  index — **guardado por `Object.hasOwn`**, provablemente seguro, y NO es
  `as unknown`/`any` (permitido). Con `noUncheckedIndexedAccess` activo, sin el
  guard el index daría `{input,output}|undefined`; el `Object.hasOwn` prueba la
  presencia en runtime antes del index.
- **`selectModel` cambia su retorno de `PricedModel` a `string`** (retorna los
  IDs configurados de complex/trivial, ahora env-driven). Ver DT-3 para la
  cascada de tipos.
- **Efecto colateral documentado:** `computeCostUsd` deja de ser "pure" (agrega
  `log.warn` en la rama unknown). Es intencional (AC-2). La rama conocida sigue
  pura y byte-idéntica (AC-3). Actualizar el doc-comment "Pure" del header.

### DT-3 — Type change: `LLMBridgeStats.model` → `string` (AC-6)
**Cambio:** `types/index.ts:341` pasa de
`'claude-haiku-4-5-20251001' | 'claude-sonnet-5'` a `string`.

**Impacto en consumers (grep exhaustivo — 3 usos del type):**
| Sitio | Uso | ¿Rompe con `string`? |
|---|---|---|
| `src/services/compose.ts:680` | `const llm: LLMBridgeStats \| undefined = result.transformLLM` | NO — solo lee la referencia |
| `src/services/compose.ts:695` | `llm_model: llm?.model ?? null` → `metadata` (JSONB) | NO — el campo es telemetría JSONB sin narrowing; `string` encaja tal cual |
| `src/services/llm/transform.ts:320-321` | `buildLLMResult` construye `{ model, … }` donde `model: PricedModel→string` | NO — widening; el valor viene de `selectModel()` |
| `src/types/index.ts:326,369` | `transformLLM?: LLMBridgeStats`, `llm?: LLMBridgeStats` | NO — solo referencian la interface |

**Conclusión (AC-6):** ningún consumer hace `switch`/narrowing sobre el literal
de `model`. El único sink es un campo JSONB de evento (`metadata.llm_model`),
totalmente permisivo. Widening a `string` es **seguro y sin efecto en
telemetría/dashboards** (el dashboard lee el string tal cual del JSONB). El
cambio se documenta acá (F2), NO es efecto colateral silencioso.

**Cascada de tipos a ensanchar (todos widening PricedModel→string):**
1. `select-model.ts` `selectModel(): string` (retorno).
2. `transform.ts:121` `generateTransformFn(…, model: string, …)`.
3. `transform.ts:309` `buildLLMResult(…, model: string, …)`.
4. `pricing.ts` `computeCostUsd(model: string, …)`.
5. `types/index.ts:341` `LLMBridgeStats.model: string`.
6. `transform.ts:23` — `import { … type PricedModel }` queda **sin uso** tras el
   widening → **eliminar** el import de `PricedModel` en `transform.ts`
   (biome flag `noUnusedImports`). `computeCostUsd` sigue importado.
   `select-model.ts:1` `import type { PricedModel }` también queda sin uso →
   eliminar. `PricedModel` permanece EXPORTADO desde `pricing.ts` (lo usan los
   tests `transform-verification.test.ts:50,61-62`).

### DT-4 — Naming env vars (final) + `.env.example`
Se confirman los nombres propuestos por el work-item:

| Env var | Default (= hoy) | Rango/validación |
|---|---|---|
| `LLM_PLANNER_MODEL` | `claude-sonnet-5` | string no-vacío |
| `LLM_COMPLEX_MODEL` | `claude-sonnet-5` | string no-vacío |
| `LLM_TRIVIAL_MODEL` | `claude-haiku-4-5-20251001` | string no-vacío |
| `LLM_INPUT_RETRY_MODEL` | `claude-haiku-4-5-20251001` | string no-vacío |
| `LLM_TIMEOUT_MS` | `30000` | int `[1, 600000]`; inválido → 30000 + warn |
| `LLM_PLANNER_MAX_TOKENS` | `1024` | int `[1, 200000]`; inválido → 1024 + warn |
| `LLM_TRANSFORM_MAX_TOKENS` | `512` | int `[1, 200000]`; inválido → 512 + warn |
| `LLM_INPUT_RETRY_MAX_TOKENS` | `1024` | int `[1, 200000]`; inválido → 1024 + warn |

Documentar en `.env.example` como **sección nueva** con el estilo del bloque
`PROTOCOL_FEE_RATE` (`.env.example:436-448`): comentario de contexto + default +
rango + comportamiento ante valor inválido + nota "se lee por request; restart
aplica el nuevo valor". Ubicación sugerida: inmediatamente bajo el bloque
`# LLM — Anthropic` existente (`.env.example:343-346`).

### DT-5 — `MAX_AGENTS_IN_PROMPT` / `PRE_COMPOSE_TIMEOUT_MS`: **OUT**
**Decisión: quedan FUERA del módulo.** Rationale:
1. **No están duplicados** (single-site cada uno) → no son el drift que esta HU
   ataca (Scope OUT default).
2. `MAX_AGENTS_IN_PROMPT` está acoplado a la lógica WKH-128 de orchestrate
   (deprioritize demos, `ORCHESTRATE_DEMO_SLUGS`) con rationale extenso in-situ;
   moverlo fragmenta ese contexto y no gana nada.
3. `PRE_COMPOSE_TIMEOUT_MS` es un timeout de **orquestación de compose**, NO un
   knob de LLM — semánticamente no pertenece a un módulo "LLM models/config".
   Incluirlo ensancha el blast radius por cero reducción de drift.

Confirmado OUT, consistente con Scope OUT del work-item.

---

## 3. Diseño concreto por archivo (pseudocódigo/diffs)

### 3.1 `src/services/llm/models.ts` (NUEVO) — ver contrato completo en DT-1
Módulo puro salvo `log.warn` en rama de env inválido. Sin imports de red/DB.
Único import: `getLogger` de `../../lib/logger.js`.

### 3.2 `src/services/llm/pricing.ts`
- Agregar `import { getLogger }` + `const log`.
- Agregar `const DEFAULT_PRICING = { input: 3.0, output: 15.0 } as const`.
- `computeCostUsd(model: string, …)` con `Object.hasOwn` + fallback + `log.warn`
  (ver DT-2). `PRICING_USD_PER_M_TOKENS` y `PricedModel` **sin cambios**.
- Actualizar header doc: quitar "Pure" de `computeCostUsd` (ahora loguea en
  rama unknown); resto intacto.

### 3.3 `src/services/llm/select-model.ts`
```diff
-import type { PricedModel } from './pricing.js';
+import { getComplexModel, getTrivialModel } from './models.js';
-export function selectModel(schema): PricedModel {
+export function selectModel(schema): string {
-  if (!schema || …) return 'claude-haiku-4-5-20251001';
+  if (!schema || …) return getTrivialModel();
-  if (required.length >= 5) return 'claude-sonnet-5';
+  if (required.length >= 5) return getComplexModel();
   // …idéntica lógica de branching (WKH-57)…
-  return 'claude-haiku-4-5-20251001';
+  return getTrivialModel();
}
```
**CD-1/CD-8:** la lógica de selección por schema (thresholds `>=5`,
`oneOf/anyOf/allOf`, nested object) NO se toca — solo los 5 literales de retorno
pasan a getters. Con env unset, retorna exactamente los mismos IDs (AC-3).

### 3.4 `src/services/orchestrate.ts`
```diff
-const MODEL = 'claude-sonnet-5';
-const LLM_TIMEOUT_MS = 30_000;
+import { getPlannerModel, getPlannerMaxTokens, getLlmTimeoutMs } from './llm/models.js';
 // …dentro de llmPlan():
-  const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
+  const timeoutId = setTimeout(() => controller.abort(), getLlmTimeoutMs());
   // …client.messages.create:
-      model: MODEL,
-      max_tokens: 1024,
+      model: getPlannerModel(),
+      max_tokens: getPlannerMaxTokens(),
       thinking: { type: 'disabled' },   // ← CD-1: INTACTO
```
`MAX_AGENTS_IN_PROMPT`, `PRE_COMPOSE_TIMEOUT_MS`, `getDemoSlugs()`,
`ORCHESTRATE_DEMO_SLUGS` y toda la lógica de planning **sin cambios** (DT-5,
Scope OUT).

### 3.5 `src/services/llm/transform.ts`
```diff
-import { computeCostUsd, type PricedModel } from './pricing.js';
+import { computeCostUsd } from './pricing.js';
+import { getLlmTimeoutMs, getTransformMaxTokens } from './models.js';
-const TIMEOUT_MS = 30_000;
 // generateTransformFn(…, model: PricedModel, …)  →  model: string
 // buildLLMResult(…, model: PricedModel, …)       →  model: string
 // …dentro del create:
-  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
+  const timeoutId = setTimeout(() => controller.abort(), getLlmTimeoutMs());
-      max_tokens: 512,
+      max_tokens: getTransformMaxTokens(),
       thinking: { type: 'disabled' },   // ← CD-1: INTACTO
```
`VM_TIMEOUT_MS` (sandbox del vm-runner) **NO se toca** — no es un knob LLM.

### 3.6 `src/services/llm/input-retry.ts`
```diff
+import { getInputRetryModel, getInputRetryMaxTokens, getLlmTimeoutMs } from './models.js';
-const MODEL = 'claude-haiku-4-5-20251001';
-const TIMEOUT_MS = 30_000;
 // …dentro de regenerateInputFromErrors():
-  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
+  const timeoutId = setTimeout(() => controller.abort(), getLlmTimeoutMs());
-          model: MODEL,
-          max_tokens: 1024,
+          model: getInputRetryModel(),
+          max_tokens: getInputRetryMaxTokens(),
```
Contrato "NEVER throws → return null" **intacto** (getters nunca lanzan).

### 3.7 `src/types/index.ts:341`
```diff
-  /** Modelo Anthropic invocado (string literal del SDK). */
-  model: 'claude-haiku-4-5-20251001' | 'claude-sonnet-5';
+  /** Modelo Anthropic invocado (env-driven vía llm/models.ts; WKH-135). */
+  model: string;
```

### 3.8 `.env.example` — sección nueva (ver DT-4)

---

## 4. Waves de implementación

> Convención: W0 serial (contratos/tipos + tests-first). W1+ pueden solaparse
> por archivo pero se listan en orden de dependencia.

### W0 — Contratos, tipos y tests-first (SERIAL, base compartida)
- Declarar la superficie pública de `models.ts` (firmas de los 8 getters).
- **Widening de tipos** (contrato compartido que todo lo demás importa):
  `computeCostUsd(model: string)`, `selectModel(): string`,
  `generateTransformFn`/`buildLLMResult` param `model: string`,
  `LLMBridgeStats.model: string`. Agregar `DEFAULT_PRICING`.
- **Tests RED** para AC-1/AC-2/AC-3/AC-4 (nuevo `models.test.ts` +
  ampliación de `pricing.test.ts`).
- Serial porque es la fundación que W1-W3 consumen.

### W1 — `models.ts` implementación
- Implementar `readModelEnv` / `readIntEnv` (espejo `getProtocolFeeRate` /
  `parseOverheadEnv`) + los 8 getters + constantes DEFAULT_*/MIN/MAX.
- Verde de `models.test.ts` (AC-1/AC-3/AC-4).

### W2 — Re-wiring de call-sites (paralelizable por archivo)
- `orchestrate.ts` (planner), `transform.ts`, `select-model.ts`,
  `input-retry.ts` importan de `models.ts`. Eliminar imports `PricedModel`
  huérfanos (transform.ts, select-model.ts).
- **Preservar `thinking:{type:'disabled'}` y lógica de selección (CD-1/CD-8).**

### W3 — Pricing tolerante + propagación de tipo
- Implementar `computeCostUsd` tolerante (Object.hasOwn + DEFAULT_PRICING +
  log.warn). Verde AC-2.
- Confirmar consumer `compose.ts` intacto (solo lee `llm?.model`) — sin edición.

### W4 — Docs + regresión + gates
- `.env.example`: sección LLM config (8 vars, estilo `PROTOCOL_FEE_RATE`).
- Regresión completa verde: `select-model.test.ts`, `pricing.test.ts`,
  `transform.test.ts`, `input-retry.test.ts`,
  `__tests__/transform-verification.test.ts` — todos con env LLM_* unset.
- Gates: `biome` (lint/format), `tsc --noEmit` (strict, noUnusedImports,
  noUncheckedIndexedAccess), `vitest run`.

---

## 5. Plan de tests (≥1 por AC)

Archivo nuevo: `src/services/llm/models.test.ts`. Ampliación:
`src/services/llm/pricing.test.ts`.

| ID | AC | Archivo | Qué verifica |
|---|---|---|---|
| T-AC1 | AC-1 | `models.test.ts` | El módulo exporta los 8 getters (contrato single-source); setear cada env y leer el getter correspondiente prueba que un knob = un lugar |
| T-AC2a | AC-2/CD-2 | `pricing.test.ts` | `computeCostUsd('modelo-inexistente', 1e6, 1e6)` **NO lanza** y retorna `18.0` (DEFAULT_PRICING Sonnet); spy en `log.warn` llamado 1× con `{model}` |
| T-AC2b | AC-2/CD-10 | `pricing.test.ts` | DEFAULT_PRICING no sub-reporta: costo default ≥ costo de cualquier modelo conocido para los mismos tokens |
| T-AC3a | AC-3/CD-5 | `models.test.ts` | Con TODAS las `LLM_*` unset: `getPlannerModel()==='claude-sonnet-5'`, `getComplexModel()==='claude-sonnet-5'`, `getTrivialModel()==='claude-haiku-4-5-20251001'`, `getInputRetryModel()==='claude-haiku-4-5-20251001'`, `getLlmTimeoutMs()===30000`, `getPlannerMaxTokens()===1024`, `getTransformMaxTokens()===512`, `getInputRetryMaxTokens()===1024` |
| T-AC3b | AC-3 | `pricing.test.ts` (existente) | Costos exactos de modelos conocidos sin cambio (Haiku 6.0 / Sonnet 18.0) |
| T-AC3c | AC-3 | `select-model.test.ts` (existente) | `selectModel` thresholds intactos: retorna literales Haiku/Sonnet con env unset |
| T-AC3d | AC-3/CD-1 | `transform.test.ts` (existente) | `thinking:{type:'disabled'}` presente y `max_tokens:512` en el body del create |
| T-AC4a | AC-4 | `models.test.ts` | `LLM_PLANNER_MODEL='x'` → getter `'x'`; `LLM_TIMEOUT_MS='5000'` → 5000; `LLM_TRANSFORM_MAX_TOKENS='256'` → 256 |
| T-AC4b | AC-4/CD-6 | `models.test.ts` | Env inválido: `LLM_TIMEOUT_MS='abc'`/`'-1'`/`'0'` → fallback 30000 + `log.warn`; `LLM_PLANNER_MODEL='   '` → default |
| T-AC5 | AC-5 | `models.test.ts` (opcional) | `.env.example` contiene los 8 nombres de env var (assert de presencia de doc); QA valida el texto |
| T-AC6 | AC-6 | `pricing.test.ts` | end-to-end de tipo: `computeCostUsd(selectModel(schema), t, t)` compila y corre con el string env-driven; construir un `LLMBridgeStats` con `model` string arbitrario compila |
| T-REG | — | suite completa | `transform-verification.test.ts` + `input-retry.test.ts` verdes con env unset |

**Regresión crítica (CD-9):** `select-model.test.ts` y `pricing.test.ts`
comparan contra literales exactos. Con `LLM_COMPLEX_MODEL`/`LLM_TRIVIAL_MODEL`
unset retornan esos literales → verde. Los tests nuevos que setean `LLM_*`
DEBEN limpiar env en `afterEach` (`delete process.env.LLM_*`) para no filtrar
overrides a tests hermanos (lección auto-blindaje `119`: colas/estado global
sobreviven a `clearAllMocks`).

---

## 6. Constraint Directives (cobertura)

### Heredados del work-item (6)
| CD | Cómo lo garantiza el SDD |
|---|---|
| CD-1 | §3.3/§3.4/§3.5: `thinking:{type:'disabled'}` y lógica de `selectModel` NO se tocan; solo literales→getters. T-AC3c/T-AC3d lo verifican |
| CD-2 | DT-2: `computeCostUsd` tolerante (Object.hasOwn + DEFAULT_PRICING + log.warn, sin throw). T-AC2a |
| CD-3 | Scope OUT: `src/adapters/*` NO figura en ningún archivo tocado (§3) |
| CD-4 | Toda la config es ENV VAR (DT-1/DT-4); cero DB. `models.ts` no importa supabase |
| CD-5 | Todos los DEFAULT_* = valor hardcodeado actual (DT-1/DT-4). T-AC3a byte-idéntico |
| CD-6 | `readModelEnv`/`readIntEnv` espejan `getProtocolFeeRate` (parse+rango+fallback+log, nunca throw). T-AC4b |

### Nuevos (específicos del SDD)
- **CD-7:** los getters leen env **por call, sin cache de módulo** (espeja
  no-cache de `getProtocolFeeRate`/CD-G). Un env inválido numérico → fallback +
  `log.warn`, jamás throw.
- **CD-8:** `selectModel` DEBE seguir retornando EXACTAMENTE los IDs
  configurados de complex/trivial y preservar los thresholds WKH-57; solo los 5
  literales de retorno pasan a `getComplexModel()`/`getTrivialModel()`.
- **CD-9 (test hygiene):** todo test que setee `LLM_*` DEBE limpiarlo en
  `afterEach`. Los tests de defaults corren con `LLM_*` unset. Previene fugas de
  env entre tests hermanos (auto-blindaje `119`).
- **CD-10:** `DEFAULT_PRICING` = rate conocido más alto (Sonnet $3/$15) para
  NUNCA sub-reportar costo en telemetría money-path. T-AC2b.
- **CD-11:** widening de tipos únicamente (PricedModel→string). PROHIBIDO
  usar `any`/`as unknown`; el único `as PricedModel` está guardado por
  `Object.hasOwn` (TS strict + noUncheckedIndexedAccess respetados).

---

## 7. Readiness Check

- [x] F0 grounding propio hecho — todos los archivos del Scope IN leídos y
      line-numbers verificados/corregidos (§1)
- [x] Todos los DT resueltos (DT-1..DT-5), sin `[NEEDS CLARIFICATION]`
- [x] Módulo definido: nombre (`src/services/llm/models.ts`), exports, helpers
- [x] Pricing tolerante diseñado sin throw (AC-2/CD-2) + tipado resuelto (DT-2)
- [x] Type change `LLMBridgeStats.model→string` con impacto en consumers
      documentado (AC-6/DT-3) — blast radius confirmado nulo (grep §DT-3)
- [x] Env vars nombradas + rangos + doc `.env.example` (DT-4/AC-5)
- [x] DT-5 decidido (OUT) con justificación
- [x] Waves W0-W4 (W0 serial contratos+tests-first presente)
- [x] Plan de tests ≥1 por AC (6 ACs cubiertos) + regresión + CD-9
- [x] 6 CD heredados + 5 CD nuevos, todos con mecanismo de cobertura
- [x] Exemplars verificados con path real: `fee-charge.ts:100-121`,
      `gas-overhead.ts:106-132`, `pricing.test.ts`, `select-model.test.ts`
- [x] Drift `project-context.md:62` reportado al humano (no bloqueante)

**Estado: LISTO para `SPEC_APPROVED`.** No hay TBDs abiertos.
