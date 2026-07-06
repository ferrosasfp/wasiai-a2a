# Story File — HU WKH-114: AC verificables + verificación de completitud por step en /orchestrate y /compose

> Contrato autocontenido para `nexus-dev`. **NO releas el SDD** — todo lo necesario está acá.
> Fuente: `doc/sdd/152-wkh-114-verifiable-step-ac/sdd.md` (SPEC_APPROVED).
> Branch: `feat/152-wkh-114-verifiable-step-ac`
> Tipo: feature/observability — **additive-only, billing INTACTO**. **SIN migración, SIN DB.**

---

## 1. Contexto compacto (qué se construye y por qué)

Hoy un step de `/compose` / `/orchestrate` se acepta a ciegas si el agente respondió 2xx:
no hay "definition of done" objetiva por step (gap del incidente Chaski-$0, 2026-07-05:
un step devolvió 200-ok sin haber hecho el trabajo real).

Esta HU:
1. **Plan-time** — adjunta 2-4 acceptance criteria (AC) explícitos a cada step: el planner
   LLM los emite en el MISMO call que ya hace (cero LLM extra), o el greedy fallback usa
   AC genéricos determinísticos, o el caller de `/compose` los provee.
2. **Execute-time** — verifica el output del agente contra esos AC con un motor
   **puro rules-first** (sin LLM en v1, sin red, never-throw), produciendo un veredicto
   `pass`/`fail`/`unverified` por step + un `verificationStatus` a nivel pipeline.

TODO es **additive-only** (campos `?:` nuevos) y **NO toca billing**: el veredicto es SEÑAL,
nunca gatea débito/refund/fee. La rama LLM-judge (Wave 3) está **DIFERIDA a v2 — NO se implementa**.

---

## 2. Acceptance Criteria (EARS) — copiados del SDD aprobado

- **AC-1**: WHEN el planner (LLM o greedy) produce los steps, THE system SHALL adjuntar a
  cada step una lista explícita y no-vacía de AC antes de que `compose` lo ejecute.
- **AC-2**: WHEN el agente de un step devuelve output (2xx), THE system SHALL evaluar ese
  output contra los AC del step y SHALL producir un veredicto `'pass'`/`'fail'`/`'unverified'`.
- **AC-3**: IF el veredicto de un step es `'fail'`, THEN THE system SHALL marcar ese step como
  NO-completado en la respuesta Y SHALL incluir el/los criterio(s) que fallaron (sin fail silencioso).
- **AC-4**: WHERE `/orchestrate` o `/compose` devuelve la respuesta, THE system SHALL incluir
  por step sus AC evaluados + veredicto como campo(s) ADITIVO(S) en `StepResult` — el shape
  existente (`agent`, `output`, `costUsdc`, `latencyMs`, `txHash`, ...) permanece sin cambios.
- **AC-5**: WHEN todos los steps tienen veredicto `'pass'`, THE system SHALL exponer un indicador
  de completitud a nivel pipeline (`verificationStatus`) DISTINTO y ADITIVO respecto de `pipeline.success`.
- **AC-6** (guard): IF un step falla sus AC, THEN THE system SHALL NOT modificar la lógica de
  débito/refund/billing de ese step en base al veredicto de AC.
- **AC-7**: WHERE el origen de un AC es LLM-generado, THE system SHALL usar
  `src/services/llm/models.ts` — PROHIBIDO hardcodear model id/timeout/max_tokens.

---

## 3. Anti-Hallucination Checklist (símbolos verificados — todos existen HOY)

| Símbolo / hecho | Ubicación verificada | Uso en esta HU |
|-----------------|----------------------|----------------|
| `classify(ev): RulesDecision` — motor PURO, union discriminada `{decision,...} \| {ambiguous,...}`, orden explícito de reglas (primero que matchea gana), sin I/O | `src/services/arbiter/rules.ts:38-80` | **Exemplar directo** de `verification.ts` |
| Docblock con orden numerado de reglas + comentario por regla | `src/services/arbiter/rules.ts:26-37,43-79` | Copiar ese estilo de documentación de reglas |
| `ComposeStep` (agent/registry/input/passOutput?) | `src/types/index.ts:290-299` | += `acceptanceCriteria?: string[]` (exemplar: `passOutput?` :298) |
| `StepResult` (agent/output/costUsdc/latencyMs/txHash?/...) | `src/types/index.ts:367-387` | += `acceptance?: StepAcceptance` (exemplar: `transformLLM?` :386 — campo aditivo con sub-shape) |
| `ComposeResult` (success/output/steps/totalCostUsdc/.../errorCode?) | `src/types/index.ts:347-365` | += `verificationStatus?: PipelineVerificationStatus` (exemplar: `errorCode?` :358) |
| `finishSuccessfulStep` construye `const result: StepResult = {...}` con spread condicional `...(downstream && {...})` | `src/services/compose.ts:595-606` | Punto de inserción de `result.acceptance` |
| `results.push(result)` (ÚNICO push de éxito — compartido happy-path + retry-ok, CD-9) | `src/services/compose.ts:607` | La verificación se engancha justo antes/después del push |
| Return success final `return { success:true, output, steps:results, totalCostUsdc, totalLatencyMs }` | `src/services/compose.ts:539-545` | += `verificationStatus: summarizePipelineVerification(results)` |
| `interface LlmPlanAgent { slug; registry; input; reasoning }` | `src/services/orchestrate.ts:107-112` | += `acceptanceCriteria?: string[]` |
| `systemPrompt` + `userPrompt` (JSON schema del planner, mismo call Sonnet) | `src/services/orchestrate.ts:162-192` | Instruir emisión de 2-4 AC ≤8 palabras en el MISMO call |
| Validación runtime `validated = selectedAgents.filter(a => typeof a?.slug === 'string' ...)` | `src/services/orchestrate.ts:235-239` | Estilo del sanitizado de AC LLM (strings no-vacíos, máx 4) |
| Path LLM: `steps = budgetedAgents.map((a, index) => ({ agent, registry, input, passOutput }))` | `src/services/orchestrate.ts:606-611` | += `acceptanceCriteria: sanitize(a.acceptanceCriteria) ?? genericAcceptanceCriteria()` |
| `greedyPlan`: `steps = selected.map((agent, index) => ({ agent, registry, input, passOutput }))` | `src/services/orchestrate.ts:281-286` | += `acceptanceCriteria: genericAcceptanceCriteria()` |
| Guard anti-double-debit `i > 0 && scopingKeyRow && chainId !== undefined` | `src/services/compose.ts:197` | **NO TOCAR** (CD-4) |
| Exact-match `chargeProtocolFee` params `{ orchestrationId, feeBaseUsdc: 0.5, feeRate: 0.01 }` | `src/services/orchestrate.test.ts:557` | NO debe romperse (CD-3) |
| `arbiter/rules.test.ts` (unit puro de motor de reglas, 1 assertion por rama) | `src/services/arbiter/rules.test.ts` | **Exemplar** de `verification.test.ts` |

> **Si CUALQUIER símbolo o línea de esta tabla no coincide con el código real → PARÁ y escalá al Architect.** No inventes.

---

## 4. Scope IN (lista exhaustiva — SOLO estos 7 archivos)

| # | Archivo | Acción | Wave |
|---|---------|--------|------|
| 1 | `src/types/index.ts` | Modificar — tipos aditivos + 3 campos `?:` | W0 |
| 2 | `src/services/verification.ts` | **Crear** — motor puro rules-first, never-throw | W0 |
| 3 | `src/services/verification.test.ts` | **Crear** — unit puro, todas las ramas | W0 |
| 4 | `src/services/compose.ts` | Modificar — wiring en `finishSuccessfulStep` + return success | W1 |
| 5 | `src/services/compose.test.ts` | Modificar — tests de verificación (AC-2/3/4/5/6) | W1 |
| 6 | `src/services/orchestrate.ts` | Modificar — `llmPlan` emite AC + `greedyPlan`/mapeos setean AC | W2 |
| 7 | `src/services/orchestrate.test.ts` | Modificar — tests AC plan-time + no-regresión CD-3 :557 | W2 |

**PROHIBIDO tocar cualquier otro archivo.** No hay `verification/` como carpeta: es un
**single-file** `src/services/verification.ts` (el seam LLM-judge queda documentado, no construido).

---

## 5. Exemplars (fragmentos reales a seguir como patrón)

### Exemplar 1: motor de reglas puro → `verification.ts`
**Archivo**: `src/services/arbiter/rules.ts:26-80`
**Usar para**: archivo #2 (`verification.ts`)
**Patrón clave**:
- Función PURA sin I/O (`export function classify(ev): RulesDecision`).
- **Union discriminada** de retorno (`{ decision, ... } | { ambiguous, ... }`).
- Docblock que enumera el orden EXACTO de reglas; el **primero que matchea gana**.
- Un comentario `// N. NOMBRE-REGLA: descripción` antes de cada rama.
- Import con extensión `.js`: `import type { ... } from '../../types/arbiter.js'`
  → en `verification.ts`: `import type { ... } from '../types/index.js'`.
- **Never-throw**: acá no throwea porque es puro; en `verification.ts` envolver la
  lógica en un guard try/catch (por `JSON.stringify` de outputs arbitrarios, CD-6) →
  `{ criteria, verdict:'unverified', method:'none' }`.

### Exemplar 2: campo aditivo opcional con sub-shape → `StepResult.acceptance`
**Archivo**: `src/types/index.ts:379-386` (`downstream*` / `transformLLM?`)
**Usar para**: archivo #1 (extensiones de tipo)
**Patrón clave**: todos los campos nuevos con `?:`, comentario `/** ... */` referenciando la HU
(`WKH-114`), ningún campo existente cambia de tipo/nombre/semántica.

### Exemplar 3: spread condicional aditivo en el StepResult → wiring compose
**Archivo**: `src/services/compose.ts:595-607`
**Usar para**: archivo #4 (`compose.ts`)
**Patrón clave**: `result` se construye como objeto literal `StepResult`; el patrón
`...(downstream && { ... })` muestra cómo se adjuntan campos aditivos. Para `acceptance`,
asignar **después** de construir `result` y **antes/en** el `results.push(result)`.

### Exemplar 4: unit test puro de motor de reglas → `verification.test.ts`
**Archivo**: `src/services/arbiter/rules.test.ts`
**Usar para**: archivo #3
**Patrón clave**: Vitest, `describe`/`it`, una assertion por rama del motor, sin mocks de red
(motor puro). Framework: **Vitest** (`import { describe, it, expect } from 'vitest'`).

### Exemplar 5: emisión de AC en el prompt del planner (mismo call)
**Archivo**: `src/services/orchestrate.ts:162-192` (systemPrompt/userPrompt) + `:235-239` (validación runtime)
**Usar para**: archivo #6
**Patrón clave**: extender el JSON schema del `userPrompt` para pedir `acceptanceCriteria`;
sanitizar la respuesta con el mismo estilo de `.filter(...)` que ya valida slugs.
El call LLM es el YA existente (`getPlannerModel`/`getPlannerMaxTokens`/`getLlmTimeoutMs`)
— **CERO call extra, CERO literal de modelo** (CD-2/AC-7).

---

## 6. Tipos aditivos exactos (archivo #1 — `src/types/index.ts`) — W0.1

Agregar (nuevos tipos, ubicar en la sección COMPOSE TYPES, cerca de :288):

```ts
export type StepVerdict = 'pass' | 'fail' | 'unverified';
export type VerificationMethod = 'rules' | 'llm' | 'none'; // DT-5, análogo a ArbiterMethod
export type PipelineVerificationStatus = 'verified' | 'incomplete' | 'unverified';

export interface StepAcceptance {
  /** Los AC efectivamente evaluados (post-substitución de default si el step no traía). */
  criteria: string[];
  verdict: StepVerdict;
  method: VerificationMethod;
  /** Presente SOLO cuando verdict === 'fail'. Subconjunto de `criteria`. */
  failedCriteria?: string[];
}
```

Extender (todos `?:`, ningún campo existente cambia):
- `ComposeStep` (:290-299) += `/** WKH-114: AC adjuntos en plan-time o por el caller. */ acceptanceCriteria?: string[];`
- `StepResult` (:367-387) += `/** WKH-114: veredicto evaluado (AC-4). */ acceptance?: StepAcceptance;`
- `ComposeResult` (:347-365) += `/** WKH-114: completitud a nivel pipeline (AC-5), DISTINTA de success. */ verificationStatus?: PipelineVerificationStatus;`

> **NO** agregar campos propios a `OrchestrateResult` ni a `OrchestratePlanResult`: su `pipeline`
> ES un `ComposeResult` (hereda `verificationStatus`) y sus `steps: ComposeStep[]` ya cargan
> `acceptanceCriteria`. Minimiza la superficie aditiva (menos riesgo CD-3).

---

## 7. Reglas determinísticas v1 (archivo #2 — `src/services/verification.ts`) — W0.2

Módulo PURO (sin I/O, sin billing, sin Anthropic). **NO importar `budgetService`** (CD-1).

### 7.1 Exports del módulo
```ts
export const DEFAULT_AC: string[]; // ['output is present and non-empty', 'output has no error field']
export function genericAcceptanceCriteria(): string[]; // devuelve DEFAULT_AC (copia)
export function verifyStepOutput(output: unknown, criteria: string[] | undefined): StepAcceptance;
export function summarizePipelineVerification(results: StepResult[]): PipelineVerificationStatus;
```

### 7.2 `verifyStepOutput` — orden EXPLÍCITO de reglas (primero que matchea gana)

Toda la función corre bajo un **guard try/catch** (CD-8): ante cualquier error interno inesperado
→ `{ criteria, verdict: 'unverified', method: 'none' }`. **NUNCA throwea.**

1. **Sustitución de default** ([NC-1]): si `criteria` es `undefined`/vacío → usar `DEFAULT_AC`,
   `method='rules'`. (El `/compose` manual sin AC igual obtiene baseline, NO queda ciego.)
2. **Global — non-empty output** (caza Chaski-$0, CD-7): `output` es `null`/`undefined`, string
   vacío, array vacío, u objeto `{}` → `verdict='fail'`, `failedCriteria` incluye el criterio de
   presencia. **"Hubo 2xx" ≠ "hay trabajo" — la regla mira el body, no el status HTTP.**
3. **Global — error field** (CD-7): `output` es objeto y tiene señal de error determinística —
   `error` truthy, `errors` array no-vacío, `success === false`, o `status ∈ {'failed','error'}`
   → `verdict='fail'` con el criterio de error.
4. **Por-criterio estructurable** (best-effort, string-matching case-insensitive sobre el JSON
   del output — envuelto en guard CD-6 por `JSON.stringify` de outputs arbitrarios):
   - `contains "X"` / `includes "X"` / token entrecomillado → el output debe contener `X`.
   - `has <field>` / `<field> present` / `non-empty <field>` → el campo existe y es no-vacío.
   - Criterio NO estructurable (semántico/subjetivo, ej. "the flight was actually booked") →
     marcar **UNDECIDABLE** por reglas.
5. **Resolución del veredicto**:
   - Cualquier criterio estructurable FALLA (o falla regla global 2/3) → `verdict='fail'`,
     `method='rules'`, `failedCriteria=[...]`.
   - Todos los evaluables PASAN y NO hay undecidables → `verdict='pass'`, `method='rules'`.
   - Hay ≥1 undecidable y ninguno falló → `verdict='unverified'`, `method='rules'`
     (las reglas no pudieron decidir; en v1 NO se escala a LLM).

### 7.3 `summarizePipelineVerification` — precedencia
- Algún `acceptance?.verdict === 'fail'` → `'incomplete'`.
- Si TODOS los steps con acceptance son `'pass'` → `'verified'` (AC-5: `'verified'` ⟺ todos pass).
- En otro caso (≥1 `'unverified'`, sin fails) → `'unverified'`.

---

## 8. Call-sites exactos (con línea)

### 8.1 W1 — `src/services/compose.ts`
- **`finishSuccessfulStep`** (:557-607): después de construir `const result: StepResult = {...}`
  (:595-606) y en/antes del `results.push(result)` (:607):
  ```ts
  result.acceptance = verifyStepOutput(output, steps[i]?.acceptanceCriteria);
  ```
  Es sync, puro, never-throw. Corre en el ÚNICO call-site de éxito (compartido happy-path +
  retry-ok, CD-9) → cubre ambos paths con un cambio. NO toca el `try/catch` de `invokeAgent`,
  NO reinvoca (CD-5), NO toca débito/refund/guard `i>0` (CD-4/CD-1).
- **Return success final** de `compose()` (:539-545): agregar campo aditivo:
  ```ts
  return {
    success: true,
    output: lastOutput,
    steps: results,
    totalCostUsdc: totalCost,
    totalLatencyMs: totalLatency,
    verificationStatus: summarizePipelineVerification(results),
  };
  ```
  **SOLO** este return. Los early-returns de fallo (:114-121, :133-148, :162-169, :248-258,
  :503-510, :529-536) **NO se tocan** (money-path byte-estable); los `steps[].acceptance` de
  steps completados igual viajan en `results`.

### 8.2 W2 — `src/services/orchestrate.ts`
- **`LlmPlanAgent`** (:107-112): += `acceptanceCriteria?: string[];`.
- **`llmPlan` prompts** (:162-192): en `systemPrompt` agregar una regla instruyendo emitir
  **2-4 AC concretos, concisos (≤ ~8 palabras c/u), verificables** por agente. En el `userPrompt`
  JSON schema (:186-191) agregar el campo `"acceptanceCriteria": ["short verifiable criterion"]`
  al ejemplo del objeto de agente. **Mismo call, mismo modelo/timeout** (`getPlannerModel`/
  `getPlannerMaxTokens`/`getLlmTimeoutMs` — CD-2/AC-7). No agregar literal de modelo/timeout.
- **Validación runtime AC LLM** (estilo de :235-239): quedarse con strings no-vacíos, recortar
  a máx 4; si el agente no trajo AC válidos → `genericAcceptanceCriteria()`.
- **Mapeo LLM → ComposeStep** (:606-611): += `acceptanceCriteria: sanitize(a.acceptanceCriteria) ?? genericAcceptanceCriteria()`.
- **`greedyPlan` → ComposeStep** (:281-286): += `acceptanceCriteria: genericAcceptanceCriteria()` (DT-1(c), sin LLM).
- Garantiza AC-1: TODO step lleva una lista no-vacía antes de que `compose` corra.

---

## 9. Constraint Directives (checklist BLOQUEANTE — copiados del SDD, no se relajan)

### PROHIBIDO
- [ ] **CD-1** — El verificador **NO importa `budgetService`**. El veredicto de AC NUNCA
      modifica/gatea `debit`/`credit`/`creditDelegation`/`creditSession`/`chargeProtocolFee`/
      `refundOutbox` ni ninguna rama de billing. Un AC-fail se expone pero NO cambia cobro/refund/fee.
      **BLOQUEANTE en AR/CR.**
- [ ] **CD-4** — NO tocar el guard `i > 0` (`compose.ts:197`) ni el money-path. La verificación
      vive en capa aparte, DESPUÉS de `invokeAgent`; NUNCA reemplaza el `try/catch` de invocación
      ni introduce una nueva vía de fallo que dispare refund.
- [ ] **CD-5** — La verificación NO dispara una 2ª `invokeAgent` ni interactúa con el retry
      adaptativo (WKH-130). Un AC-fail se expone; NO reintenta.
- [ ] **CD-6** — "validate ≠ parse": al inspeccionar el output NO asumir tipos. `Number(x)` /
      `JSON.stringify(x)` de outputs arbitrarios pueden dar `NaN`/circular/throw → envolver en
      guard, tratar el fallo como `unverified`, nunca propagar el throw.
- [ ] **CD-7** — "200-ok ≠ trabajo hecho": la regla de presencia NUNCA trata "hubo 2xx" como
      "step completo". Reglas 2 (non-empty) + 3 (error field) separan "recibí un body" de
      "el body evidencia trabajo real".
- [ ] **CD-8** — Aislamiento never-throw: un error verificando el step `i` NUNCA aborta los
      demás steps ni el pipeline → cae a `verdict='unverified'`. (v1 es sync/puro, sin red.)
- [ ] NO agregar dependencias nuevas. NO modificar archivos fuera del Scope IN (§4). NO persistir
      el veredicto en DB (v1 stateless).

### OBLIGATORIO
- [ ] **CD-2 / AC-7** — Cualquier AC LLM-generado usa `src/services/llm/models.ts` (getters ya
      en uso por el planner). PROHIBIDO hardcodear model id/timeout/max_tokens. (v1 no agrega
      getters nuevos — el judge y `getVerifyMaxTokens` son v2.)
- [ ] **CD-3** — Additive-only en `ComposeStep`/`StepResult`/`ComposeResult`/`OrchestrateResult`/
      `OrchestratePlanResult`: todos los campos nuevos `?:`. `orchestrate.test.ts:557`
      (exact-match `chargeProtocolFee`) y el shape de `pipeline.success` NO se rompen.
- [ ] `verification.ts` sigue el patrón de `arbiter/rules.ts` (función pura, union discriminada,
      orden explícito de reglas).
- [ ] **CD-9** — Correr `biome check --write` sobre cada archivo nuevo/modificado ANTES de cerrar
      la wave; imports en orden alfabético.

---

## 10. Waves (orden de ejecución — W3 DIFERIDA, NO se implementa)

### Wave -1: Environment Gate (verificar ANTES de tocar código)
```bash
cd /home/ferdev/.openclaw/workspace/wasiai-a2a
npm install 2>/dev/null || echo "revisar package.json"
# Archivos base del Scope IN deben existir:
ls src/types/index.ts src/services/compose.ts src/services/orchestrate.ts \
   src/services/arbiter/rules.ts src/services/arbiter/rules.test.ts \
   src/services/compose.test.ts src/services/orchestrate.test.ts 2>&1
# Baseline verde antes de empezar:
npx tsc --noEmit && npx biome check src/ && npx vitest run
```
**Si algo falla → PARAR y reportar al orquestador.** No implementar sobre entorno roto.

### Wave 0 (Serial Gate — contratos/tipos + helper puro)
- [ ] **W0.1**: Tipos aditivos en `src/types/index.ts` (archivo #1, §6).
- [ ] **W0.2**: Crear `src/services/verification.ts` (archivo #2, §7) → Exemplar `arbiter/rules.ts`.
- [ ] **W0.3**: Crear `src/services/verification.test.ts` (archivo #3) → Exemplar `arbiter/rules.test.ts`.
      Cubrir los 10 tests W0 de §11.
- [ ] **Gate W0**: `npx tsc --noEmit` 0 errores + `npx biome check src/services/verification.ts src/services/verification.test.ts src/types/index.ts` 0 + `npx vitest run src/services/verification.test.ts` verde.

### Wave 1 (Depende de W0 — verificación en compose, SIN planner)
- [ ] **W1.1**: Wiring en `finishSuccessfulStep` (`result.acceptance`) + return success
      (`verificationStatus`) en `compose.ts` (archivo #4, §8.1).
- [ ] **W1.2**: Tests en `compose.test.ts` (archivo #5) — los 4 tests W1 de §11.
- [ ] **Gate W1**: `npx tsc --noEmit` 0 + `npx biome check` 0 + `npx vitest run src/services/compose.test.ts` verde, sin romper baseline.

### Wave 2 (Depende de W0 — AC en plan-time; paralelizable con W1)
- [ ] **W2.1**: `llmPlan` emite `acceptanceCriteria` (mismo call) + validación runtime +
      `greedyPlan`/mapeos setean AC (generic fallback) en `orchestrate.ts` (archivo #6, §8.2).
- [ ] **W2.2**: Tests en `orchestrate.test.ts` (archivo #7) — los 4 tests W2 de §11, incluida la
      no-regresión del exact-match `:557`.
- [ ] **Gate W2**: `npx tsc --noEmit` 0 + `npx biome check` 0 + `npx vitest run src/services/orchestrate.test.ts` verde (incluye `:557`), sin romper baseline.

### Wave 3 (LLM-judge) — **DIFERIDA. NO IMPLEMENTAR.** Seam documentado en SDD §4.3.3 (follow-up WKH-114b).

---

## 11. Test Expectations (18 tests, mapeados a AC y wave — Vitest)

| # | Test (archivo) | AC / CD cubierto | Descripción | Wave |
|---|----------------|------------------|-------------|------|
| 1 | `verification.test.ts` — good output → pass | AC-2 | Output no-vacío que cumple AC estructurables → `verdict='pass'`, `method='rules'` | W0 |
| 2 | `verification.test.ts` — empty/200-ok body → fail | AC-2, AC-3, CD-7 | `null`/`''`/`{}`/`[]` → `verdict='fail'` + `failedCriteria` con criterio de presencia | W0 |
| 3 | `verification.test.ts` — error field → fail | AC-2, AC-3, CD-7 | `{error:'x'}`/`{success:false}`/`{status:'failed'}` → `fail` + `failedCriteria` | W0 |
| 4 | `verification.test.ts` — no criteria → default baseline | AC-2, NC-1 | `criteria=undefined` → sustituye `DEFAULT_AC`, evalúa pass/fail | W0 |
| 5 | `verification.test.ts` — semantic criterion → unverified | AC-2 | Criterio no estructurable + output válido → `verdict='unverified'`, `method='rules'` | W0 |
| 6 | `verification.test.ts` — circular/BigInt output never throws | CD-6, CD-8 | Output que rompe `JSON.stringify` → `unverified`, sin throw | W0 |
| 7 | `verification.test.ts` — summarize: all pass → verified | AC-5 | Todos `pass` → `'verified'` | W0 |
| 8 | `verification.test.ts` — summarize: any fail → incomplete | AC-3, AC-5 | ≥1 `fail` → `'incomplete'` | W0 |
| 9 | `verification.test.ts` — summarize: unverified mix → unverified | AC-5 | Sin fails, ≥1 `unverified` → `'unverified'` | W0 |
| 10 | `verification.test.ts` — genericAcceptanceCriteria non-empty | AC-1 | Devuelve lista no-vacía determinística | W0 |
| 11 | `compose.test.ts` — StepResult.acceptance additive, base shape intact | AC-4 | `agent/output/costUsdc/latencyMs/txHash` sin cambios; `acceptance` presente | W1 |
| 12 | `compose.test.ts` — pipeline.verificationStatus additive & distinct | AC-5 | Todos pass → `verificationStatus='verified'`; `success` sigue boolean idéntico | W1 |
| 13 | `compose.test.ts` — AC-fail step does NOT alter billing | AC-6, CD-1 | Step 2xx con `acceptance.verdict='fail'` → `credit`/refund NO llamado por AC; `totalCostUsdc` intacto | W1 |
| 14 | `compose.test.ts` — verifier error → pipeline still succeeds | CD-4, CD-8 | Verificador cae a `unverified` sin abortar el pipeline ni disparar refund | W1 |
| 15 | `orchestrate.test.ts` — llmPlan attaches non-empty AC per step | AC-1 | `steps[].acceptanceCriteria` no-vacío (LLM path) | W2 |
| 16 | `orchestrate.test.ts` — greedy fallback attaches generic AC | AC-1 | Fallback sin LLM → `acceptanceCriteria = generic` no-vacío | W2 |
| 17 | `orchestrate.test.ts` — :557 chargeProtocolFee params unchanged | AC-4, AC-6, CD-3 | El exact-match del fee y `pipeline.success` NO cambian | W2 |
| 18 | `orchestrate.test.ts` — AC uses centralized model getters (no hardcode) | AC-7, CD-2 | El planner no introduce model id/timeout literal; los AC viajan en el call existente | W2 |

### Criterio Test-First
| Tipo de cambio | Test-first? |
|----------------|-------------|
| Motor de reglas puro (`verification.ts`) | Sí |
| Wiring compose/orchestrate (lógica condicional) | Sí |
| Tipos aditivos (`types/index.ts`) | No (los cubren los tests de W0/W1/W2) |

---

## 12. Out of Scope (NO tocar bajo ninguna circunstancia)
- LLM-judge / Wave 3 (diferido a v2/WKH-114b) — NO crear `verification/llm-judge.ts` ni `getVerifyMaxTokens`.
- Cualquier cambio de billing/débito/refund/protocol fee condicionado por el veredicto.
- Persistencia del veredicto en DB / `a2a_events`.
- UI / dashboard de veredictos.
- Disparo del retry WKH-130 por AC-fail.
- `verificationStatus` en los early-returns de fallo de `compose` (follow-up; en v1 solo en el return de éxito).
- Guard `i > 0` (`compose.ts:197`) y money-path. NO "mejorar" código adyacente.

---

## 13. Definition of Done
- [ ] Los 7 ACs (AC-1..7) cubiertos por ≥1 test (§11) y verdes.
- [ ] Los 18 tests de §11 implementados y verdes (10 W0 + 4 W1 + 4 W2).
- [ ] **Additive-only confirmado**: todos los campos nuevos `?:`; ningún campo/tipo/semántica existente cambia.
- [ ] **Billing intacto**: `verification.ts` NO importa `budgetService`; guard `i>0` sin tocar; `chargeProtocolFee` params byte-idénticos (`:557` verde).
- [ ] **Baseline verde**: `npx tsc --noEmit` 0 errores + `npx biome check src/` 0 + `npx vitest run` suite completa verde (sin regresiones).
- [ ] Todas las CD-checklist de §9 tildadas.

---

## Escalation Rule
> **Si algo no está en este Story File, Dev PARA y escala al Architect.** No inventar, no asumir, no improvisar.

Situaciones de escalation:
- Una línea/símbolo del §3 no coincide con el código real.
- Un import necesario no está disponible.
- El planner LLM trunca el JSON al agregar AC (riesgo §7 del SDD) → reportar, no ampliar tokens por tu cuenta.
- Ambigüedad en un AC o en el orden de reglas.
- El cambio requiere tocar un archivo fuera del Scope IN (§4).

---

*Story File generado por NexusAgil — F2.5 — nexus-architect*
