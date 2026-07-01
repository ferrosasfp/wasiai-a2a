# Story File — HU-135 / WKH-135: Centralizar la config LLM/modelo (env-driven)

> **Contrato autocontenido para el Dev (F3).** Este es tu ÚNICO input. Si algo no está acá, no lo hagas. NO releas el SDD entero — todo lo necesario está transcrito abajo.
> SDD: `doc/sdd/132-wkh-135-centralize-llm-config/sdd.md` (SPEC_APPROVED)
> Work Item: `doc/sdd/132-wkh-135-centralize-llm-config/work-item.md` (HU_APPROVED)
> Branch sugerido: `refactor/135-centralize-llm-config`

---

## 1. Contexto mínimo + Regla de oro

Hoy 4 archivos duplican los mismos knobs LLM (model IDs de Claude, timeout `30_000` ×3, `max_tokens` 1024/512/1024). Esta HU los extrae a **un único módulo env-driven** `src/services/llm/models.ts` y re-cablea los 4 call-sites para que importen de ahí. `pricing.ts` gana un lookup tolerante y `LLMBridgeStats.model` se ensancha a `string`.

### Regla de oro (NO violar)

**Defaults byte-idénticos a HOY.** Con TODAS las `LLM_*` env vars unset, el comportamiento es exactamente el actual: mismos model IDs, mismo timeout, mismos `max_tokens`, `selectModel()` (WKH-57) y `thinking:{type:'disabled'}` (WKH-134) intactos. Espejás el patrón defensivo de `getProtocolFeeRate()` (`src/services/fee-charge.ts:100-121`) y `parseOverheadEnv()` (`src/lib/gas-overhead.ts:106-132`): parse → validar rango → fallback → `log.warn` → **NUNCA throw**. Cero cambio de comportamiento sin overrides.

---

## 2. Scope IN (lista exhaustiva — NO tocar nada fuera)

| Archivo | Acción |
|---------|--------|
| `src/services/llm/models.ts` | **NUEVO** — 8 getters + 2 helpers defensivos + constantes DEFAULT/MIN/MAX |
| `src/services/llm/pricing.ts` | `computeCostUsd(model: string)` tolerante + `DEFAULT_PRICING` + `log` |
| `src/services/llm/select-model.ts` | `selectModel(): string`; 5 literales → getters; eliminar import huérfano `PricedModel` |
| `src/services/llm/transform.ts` | importar getters de `models.ts`; params `model: string`; eliminar import `type PricedModel` |
| `src/services/llm/input-retry.ts` | importar getters de `models.ts`; borrar `MODEL`/`TIMEOUT_MS` const |
| `src/services/orchestrate.ts` | importar getters de `models.ts`; borrar `MODEL`/`LLM_TIMEOUT_MS` const |
| `src/types/index.ts` (`:341`) | `LLMBridgeStats.model` → `string` |
| `.env.example` | sección nueva con las 8 env vars (estilo `PROTOCOL_FEE_RATE`) |
| `src/services/llm/models.test.ts` | **NUEVO** — tests AC-1/AC-3/AC-4/AC-5 |
| `src/services/llm/pricing.test.ts` | ampliar — tests AC-2/AC-6 |

### Scope OUT — PROHIBIDO tocar
- `src/adapters/*/payment.ts` / `gasless.ts` (contract addresses, explorer URLs) — CD-3.
- `MAX_AGENTS_IN_PROMPT` (`orchestrate.ts:41`), `PRE_COMPOSE_TIMEOUT_MS` (`orchestrate.ts:94`), `getDemoSlugs()`, `ORCHESTRATE_DEMO_SLUGS`, toda la lógica de planning — DT-5, single-site, no es el drift que atacamos.
- `VM_TIMEOUT_MS` (sandbox del vm-runner en transform.ts) — NO es knob LLM.
- `thinking:{type:'disabled'}` y la lógica de branching de `selectModel` (thresholds WKH-57) — CD-1/CD-8.
- Persistencia en DB (CD-4, es ENV VAR only). Cualquier knob nuevo tipo `temperature` (no se inventa).
- `PRICING_USD_PER_M_TOKENS` (la tabla) y el `export type PricedModel` — se **conservan sin cambios** (los tests los usan).
- `src/services/compose.ts:680,695` — consumer de `LLMBridgeStats`, solo LEE `llm?.model`; **NO editar**, solo confirmar que sigue compilando.

---

## 3. Anti-Hallucination gates (APIs REALES — PROHIBIDO inventar)

Verificado contra el código actual. Reusá tal cual:

| Símbolo | Archivo real | Nota |
|---------|--------------|------|
| `getLogger(name)` | `src/lib/logger.js` (import `'../../lib/logger.js'`) | único import de `models.ts` |
| `PRICING_USD_PER_M_TOKENS` | `src/services/llm/pricing.ts:13-18` | tabla `as const`, SIN cambios |
| `PricedModel` (export type) | `src/services/llm/pricing.ts:20` | **permanece EXPORTADO** (lo usan `transform-verification.test.ts:50,61-62`) |
| `Object.hasOwn(obj, key)` | builtin | guard del index tolerante en `computeCostUsd` |
| `Number.parseInt(raw, 10)` / `Number.isFinite` | builtin | parse defensivo de `readIntEnv` |

**Reglas anti-alucinación específicas:**
- Los valores reales HOY (fuente de verdad = código, NO `project-context.md` que está stale): planner/complex = `claude-sonnet-5`; trivial/input-retry = `claude-haiku-4-5-20251001`; timeout = `30_000`; max_tokens = 1024 (planner) / 512 (transform) / 1024 (input-retry). Precios: Haiku `{input:1.0, output:5.0}`, Sonnet `{input:3.0, output:15.0}`.
- NO tocar `thinking:{type:'disabled'}` en NINGÚN call-site.
- NO tocar la lógica de branching de `selectModel` (`>=5 required`, `oneOf/anyOf/allOf`, nested object type) — SOLO los 5 literales de retorno pasan a getters.
- NO tocar `MAX_AGENTS_IN_PROMPT`, `PRE_COMPOSE_TIMEOUT_MS`, `VM_TIMEOUT_MS`.
- Eliminar imports huérfanos de `PricedModel` en `transform.ts` (`type PricedModel`) y `select-model.ts` (`import type { PricedModel }`) — quedan sin uso tras el widening (biome `noUnusedImports`). Pero MANTENER `PricedModel` EXPORTADO desde `pricing.ts`.
- Widening PricedModel→string permitido en EXACTAMENTE estos 5 sitios: (1) `selectModel()` retorno, (2) `generateTransformFn(...model)` param, (3) `buildLLMResult(...model)` param, (4) `computeCostUsd(model)` firma, (5) `LLMBridgeStats.model`.

---

## 4. Waves de implementación

### W0 — Contratos, tipos y tests-first (SERIAL, base compartida)

Declarar firmas públicas + ensanchar tipos + tests RED. Es la fundación que W1-W3 consumen.

**4.0.a — Widening de tipos (contrato compartido):**
- `select-model.ts`: `selectModel(...): string`.
- `transform.ts`: `generateTransformFn(..., model: string, ...)` y `buildLLMResult(..., model: string, ...)`.
- `pricing.ts`: `computeCostUsd(model: string, ...)` + agregar `DEFAULT_PRICING`.
- `types/index.ts:341`: `LLMBridgeStats.model: string`.

**4.0.b — Firmas públicas de `models.ts`** (los 8 getters, ver W1 para el cuerpo).

**4.0.c — Tests RED** (nuevo `models.test.ts` + ampliación `pricing.test.ts`) para AC-1/AC-2/AC-3/AC-4. Ver §5.

---

### W1 — `src/services/llm/models.ts` (NUEVO) — implementación

Módulo puro salvo `log.warn` en rama de env inválido. Sin imports de red/DB. Único import: `getLogger`.

**Contrato exacto (transcrito del SDD §DT-1):**

```ts
// src/services/llm/models.ts
import { getLogger } from '../../lib/logger.js';

const log = getLogger('llm-models');

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

// Model IDs (env override directo)
export function getPlannerModel(): string    { return readModelEnv('LLM_PLANNER_MODEL', DEFAULT_PLANNER_MODEL); }
export function getComplexModel(): string    { return readModelEnv('LLM_COMPLEX_MODEL', DEFAULT_COMPLEX_MODEL); }
export function getTrivialModel(): string    { return readModelEnv('LLM_TRIVIAL_MODEL', DEFAULT_TRIVIAL_MODEL); }
export function getInputRetryModel(): string { return readModelEnv('LLM_INPUT_RETRY_MODEL', DEFAULT_INPUT_RETRY_MODEL); }

// Timeout único compartido por planner/transform/input-retry (hoy los 3 = 30_000)
export function getLlmTimeoutMs(): number {
  return readIntEnv('LLM_TIMEOUT_MS', DEFAULT_LLM_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
}

// max_tokens por call-site (distintos hoy: 1024 / 512 / 1024)
export function getPlannerMaxTokens(): number    { return readIntEnv('LLM_PLANNER_MAX_TOKENS', DEFAULT_PLANNER_MAX_TOKENS, MIN_MAX_TOKENS, MAX_MAX_TOKENS); }
export function getTransformMaxTokens(): number  { return readIntEnv('LLM_TRANSFORM_MAX_TOKENS', DEFAULT_TRANSFORM_MAX_TOKENS, MIN_MAX_TOKENS, MAX_MAX_TOKENS); }
export function getInputRetryMaxTokens(): number { return readIntEnv('LLM_INPUT_RETRY_MAX_TOKENS', DEFAULT_INPUT_RETRY_MAX_TOKENS, MIN_MAX_TOKENS, MAX_MAX_TOKENS); }
```

**Notas de diseño (del SDD, no negociables):**
- Getters son **funciones leídas por call, SIN cache de módulo** (CD-7): espeja `getProtocolFeeRate`; permite override por env sin re-importar; un restart de Railway aplica el nuevo valor.
- Timeout UNO solo (`getLlmTimeoutMs`/`LLM_TIMEOUT_MS`) compartido — fiel al estado actual (los 3 call-sites hoy son el mismo literal `30_000`).

**Verde al cerrar:** `models.test.ts` (T-AC1, T-AC3a, T-AC4a, T-AC4b).

---

### W2 — Re-wiring de call-sites (paralelizable por archivo)

Preservar `thinking:{type:'disabled'}` y la lógica de selección en TODOS (CD-1/CD-8).

**4.2.a — `src/services/llm/select-model.ts`** (literales `:14,18,21,32,37`):
```diff
-import type { PricedModel } from './pricing.js';
+import { getComplexModel, getTrivialModel } from './models.js';
-export function selectModel(schema): PricedModel {
+export function selectModel(schema): string {
-  if (!schema || …) return 'claude-haiku-4-5-20251001';
+  if (!schema || …) return getTrivialModel();
-  if (required.length >= 5) return 'claude-sonnet-5';
+  if (required.length >= 5) return getComplexModel();
   // …idéntica lógica de branching (WKH-57): oneOf/anyOf/allOf y nested object
   // también → return getComplexModel(); NO tocar los thresholds…
-  return 'claude-haiku-4-5-20251001';
+  return getTrivialModel();
}
```
Los 5 literales de retorno: 3× trivial (`getTrivialModel()`) y 2× complex (`getComplexModel()`). Branching intacto.

**4.2.b — `src/services/orchestrate.ts`** (`:34,:35,:191-197`):
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
`MAX_AGENTS_IN_PROMPT`, `PRE_COMPOSE_TIMEOUT_MS`, `getDemoSlugs()`, `ORCHESTRATE_DEMO_SLUGS` y la lógica de planning **sin cambios** (DT-5).

**4.2.c — `src/services/llm/transform.ts`** (`:23,:34,:163-172` + params `:121,:309`):
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
`VM_TIMEOUT_MS` NO se toca.

**4.2.d — `src/services/llm/input-retry.ts`** (`:25,:26,:89`):
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
Contrato "NEVER throws → return null" intacto (getters nunca lanzan).

**Verde al cerrar:** `select-model.test.ts`, `transform.test.ts`, `input-retry.test.ts` (env unset).

---

### W3 — Pricing tolerante + propagación de tipo

**4.3.a — `src/services/llm/pricing.ts`** (`:21-28` + header):
```ts
import { getLogger } from '../../lib/logger.js';
const log = getLogger('pricing');

/**
 * DEFAULT_PRICING — precio seguro para un model ID fuera de la tabla.
 * CD-10: usa el rate CONOCIDO más alto (Sonnet $3/$15) para NUNCA
 * sub-reportar costo en telemetría (over-estimate > under-estimate).
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
- `PRICING_USD_PER_M_TOKENS` y `export type PricedModel` **SIN cambios** (la tabla + tests exactos).
- El único `as` es `model as PricedModel`, **guardado por `Object.hasOwn`** → provablemente seguro, respeta `noUncheckedIndexedAccess`. PROHIBIDO `any`/`as unknown` (CD-11).
- Header doc: quitar la palabra "Pure" del doc-comment de `computeCostUsd` (ahora loguea en rama unknown). La rama conocida sigue byte-idéntica.

**4.3.b — `src/services/compose.ts` (consumer, NO editar):** confirmar que `compose.ts:680` (lee `result.transformLLM`) y `:695` (`llm_model: llm?.model ?? null` → metadata JSONB) siguen compilando con `model: string`. Widening puro, sin narrowing → OK.

**4.3.c — `src/types/index.ts:341`:**
```diff
-  /** Modelo Anthropic invocado (string literal del SDK). */
-  model: 'claude-haiku-4-5-20251001' | 'claude-sonnet-5';
+  /** Modelo Anthropic invocado (env-driven vía llm/models.ts; WKH-135). */
+  model: string;
```

**Verde al cerrar:** `pricing.test.ts` (T-AC2a, T-AC2b, T-AC3b, T-AC6).

---

### W4 — Docs + regresión + gates

**4.4.a — `.env.example`** — sección nueva bajo el bloque `# LLM — Anthropic` existente (`.env.example:343-346`), estilo del bloque `PROTOCOL_FEE_RATE` (`.env.example:436-448`): comentario de contexto + default + rango + comportamiento ante valor inválido + nota "se lee por request; restart aplica el nuevo valor". Las 8 vars:

| Env var | Default | Rango/validación |
|---|---|---|
| `LLM_PLANNER_MODEL` | `claude-sonnet-5` | string no-vacío |
| `LLM_COMPLEX_MODEL` | `claude-sonnet-5` | string no-vacío |
| `LLM_TRIVIAL_MODEL` | `claude-haiku-4-5-20251001` | string no-vacío |
| `LLM_INPUT_RETRY_MODEL` | `claude-haiku-4-5-20251001` | string no-vacío |
| `LLM_TIMEOUT_MS` | `30000` | int `[1, 600000]`; inválido → 30000 + warn |
| `LLM_PLANNER_MAX_TOKENS` | `1024` | int `[1, 200000]`; inválido → 1024 + warn |
| `LLM_TRANSFORM_MAX_TOKENS` | `512` | int `[1, 200000]`; inválido → 512 + warn |
| `LLM_INPUT_RETRY_MAX_TOKENS` | `1024` | int `[1, 200000]`; inválido → 1024 + warn |

**4.4.b — Regresión completa verde con TODAS las `LLM_*` unset:** `select-model.test.ts`, `pricing.test.ts`, `transform.test.ts`, `input-retry.test.ts`, `__tests__/transform-verification.test.ts`.

**4.4.c — Gates:** `biome` (lint/format limpio), `tsc --noEmit` (strict + `noUnusedImports` + `noUncheckedIndexedAccess` limpio), `vitest run` (suite completa verde).

---

## 5. ACs → Tests

Archivo nuevo: `src/services/llm/models.test.ts`. Ampliación: `src/services/llm/pricing.test.ts`.

| ID | AC/CD | Archivo | Qué verifica |
|---|---|---|---|
| T-AC1 | AC-1 | `models.test.ts` | El módulo exporta los 8 getters; setear cada env y leer el getter prueba single-source (un knob = un lugar) |
| T-AC2a | AC-2/CD-2 | `pricing.test.ts` | `computeCostUsd('modelo-inexistente', 1e6, 1e6)` **NO lanza** y retorna `18.0` (DEFAULT_PRICING Sonnet); spy en `log.warn` llamado 1× con `{model}` |
| T-AC2b | AC-2/CD-10 | `pricing.test.ts` | DEFAULT_PRICING no sub-reporta: costo default ≥ costo de cualquier modelo conocido para los mismos tokens |
| T-AC3a | AC-3/CD-5 | `models.test.ts` | Con TODAS las `LLM_*` unset: planner/complex → `claude-sonnet-5`; trivial/input-retry → `claude-haiku-4-5-20251001`; timeout → 30000; maxTokens → 1024/512/1024 |
| T-AC3b | AC-3 | `pricing.test.ts` (existente) | Costos exactos de modelos conocidos sin cambio (Haiku 6.0 / Sonnet 18.0 @ 1e6/1e6) |
| T-AC3c | AC-3 | `select-model.test.ts` (existente) | `selectModel` thresholds intactos: retorna literales Haiku/Sonnet con env unset |
| T-AC3d | AC-3/CD-1 | `transform.test.ts` (existente) | `thinking:{type:'disabled'}` presente y `max_tokens:512` en el body del create |
| T-AC4a | AC-4 | `models.test.ts` | `LLM_PLANNER_MODEL='x'` → `'x'`; `LLM_TIMEOUT_MS='5000'` → 5000; `LLM_TRANSFORM_MAX_TOKENS='256'` → 256 |
| T-AC4b | AC-4/CD-6 | `models.test.ts` | Env inválido: `LLM_TIMEOUT_MS='abc'`/`'-1'`/`'0'` → fallback 30000 + `log.warn`; `LLM_PLANNER_MODEL='   '` → default |
| T-AC5 | AC-5 | `models.test.ts` (opcional) | `.env.example` contiene los 8 nombres de env var (presencia de doc); QA valida el texto |
| T-AC6 | AC-6 | `pricing.test.ts` | e2e de tipo: `computeCostUsd(selectModel(schema), t, t)` compila/corre con string env-driven; construir `LLMBridgeStats` con `model` string arbitrario compila |
| T-REG | — | suite completa | `transform-verification.test.ts` + `input-retry.test.ts` verdes con env unset |

**CD-9 (test hygiene, OBLIGATORIO):** todo test que setee `LLM_*` DEBE limpiarlo en `afterEach` (`delete process.env.LLM_*`). Los tests de defaults corren con `LLM_*` unset. Previene fugas de env entre tests hermanos (lección auto-blindaje `119`: colas/estado global sobreviven a `clearAllMocks`).

---

## 6. Constraint Directives (11 — reglas accionables inline)

| CD | Regla accionable |
|---|---|
| CD-1 | NO tocar `thinking:{type:'disabled'}` ni la lógica de branching de `selectModel` (thresholds WKH-57). Solo literales→getters. Verifica T-AC3c/T-AC3d |
| CD-2 | `computeCostUsd` tolerante: `Object.hasOwn` + `DEFAULT_PRICING` + `log.warn`, **NUNCA throw**. Verifica T-AC2a |
| CD-3 | NO tocar `src/adapters/*/payment.ts` / `gasless.ts` (Scope OUT) |
| CD-4 | Config = ENV VAR únicamente. Cero DB. `models.ts` NO importa supabase |
| CD-5 | Todos los `DEFAULT_*` = valor hardcodeado actual. Byte-idéntico con env unset. Verifica T-AC3a |
| CD-6 | `readModelEnv`/`readIntEnv` espejan `getProtocolFeeRate`/`parseOverheadEnv`: parse + rango + fallback + `log.warn`, nunca throw. Verifica T-AC4b |
| CD-7 | Getters leen env **por call, sin cache de módulo**. Env inválido numérico → fallback + `log.warn`, jamás throw |
| CD-8 | `selectModel` retorna EXACTAMENTE los IDs configurados de complex/trivial y preserva thresholds WKH-57; solo los 5 literales de retorno → getters |
| CD-9 | Todo test que setee `LLM_*` lo limpia en `afterEach`. Tests de defaults con `LLM_*` unset |
| CD-10 | `DEFAULT_PRICING = { input: 3.0, output: 15.0 }` (Sonnet, rate conocido más alto) para NUNCA sub-reportar costo. Verifica T-AC2b |
| CD-11 | SOLO widening PricedModel→string. PROHIBIDO `any`/`as unknown`. El único `as PricedModel` está guardado por `Object.hasOwn`. TS strict + `noUncheckedIndexedAccess` respetados |

---

## 7. Done Definition (tu trabajo termina cuando)

- [ ] `src/services/llm/models.ts` creado con los 8 getters + 2 helpers defensivos + constantes.
- [ ] Los 4 call-sites (`orchestrate.ts`, `transform.ts`, `select-model.ts`, `input-retry.ts`) importan de `models.ts`; consts locales `MODEL`/`TIMEOUT_MS`/`LLM_TIMEOUT_MS` borradas.
- [ ] `computeCostUsd(model: string)` tolerante (Object.hasOwn + DEFAULT_PRICING + log.warn, no throw); `PRICING_USD_PER_M_TOKENS` y `PricedModel` conservados.
- [ ] `LLMBridgeStats.model: string` (`types/index.ts:341`); `compose.ts` sigue compilando sin editar.
- [ ] Imports huérfanos `PricedModel` eliminados en `transform.ts` y `select-model.ts`; `PricedModel` sigue EXPORTADO desde `pricing.ts`.
- [ ] `thinking:{type:'disabled'}`, thresholds `selectModel`, `MAX_AGENTS_IN_PROMPT`, `PRE_COMPOSE_TIMEOUT_MS`, `VM_TIMEOUT_MS` intactos.
- [ ] `models.test.ts` nuevo + `pricing.test.ts` ampliado, verdes. Los 6 ACs cubiertos (§5).
- [ ] Suite completa verde con TODAS las `LLM_*` unset (regresión). Tests con overrides limpian env en `afterEach`.
- [ ] `tsc --noEmit` limpio (strict + noUnusedImports + noUncheckedIndexedAccess). `biome` limpio.
- [ ] `.env.example`: sección LLM con las 8 vars (default + rango + comportamiento inválido), estilo `PROTOCOL_FEE_RATE`.
- [ ] Los 6 ACs (AC-1..AC-6) satisfechos.
