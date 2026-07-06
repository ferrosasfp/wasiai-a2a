# SDD #152: [WKH-114] AC verificables + verificación de completitud por step en /orchestrate y /compose

> SPEC_APPROVED: no
> Fecha: 2026-07-06
> Tipo: feature
> SDD_MODE: full
> Branch: feat/152-wkh-114-verifiable-step-ac
> Artefactos: doc/sdd/152-wkh-114-verifiable-step-ac/
> Work Item: doc/sdd/152-wkh-114-verifiable-step-ac/work-item.md

---

## 1. Resumen

Hoy un step de `/compose` / `/orchestrate` se acepta a ciegas si el agente
respondió 2xx: no existe una "definition of done" objetiva por step. Esta HU
adjunta **acceptance criteria (AC) explícitos** a cada step en plan-time (el
planner LLM los emite en el MISMO call que ya hace, o el caller de `/compose`
los provee, o un fallback determinístico los genera) y **verifica el output del
agente contra ellos en execute-time**, exponiendo un veredicto
`pass`/`fail`/`unverified` por step + un indicador de completitud a nivel
pipeline (`verificationStatus`), TODO **additive-only** y **sin tocar billing**.

Es la versión a-nivel-de-código del gap del incidente 2026-07-05 (Chaski: step
200-ok sin haber hecho el trabajo real). WKH-71/74/77 lo cazan DESDE AFUERA
(monitoreo externo post-hoc); esta HU hace que el orquestador MISMO verifique la
completitud de cada step en el momento de ejecutarlo. Resultado esperado: señal
de observability/completeness en la respuesta, sin latencia/costo/no-determinismo
en el critical path del money-path y sin cambiar un solo débito/refund/fee.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 152 |
| **Tipo** | feature |
| **SDD_MODE** | full |
| **Objetivo** | Adjuntar AC por step en plan-time + verificar output en execute-time → veredicto por step + status a nivel pipeline, additive-only, billing intacto |
| **Reglas de negocio** | El veredicto es señal, NO gate de ejecución ni de billing (CD-1). Rules-first determinístico; LLM-judge SOLO si ambiguo (diferido a v2, ver DT-2/§4.3.3) |
| **Scope IN** | `orchestrate.ts` (llmPlan emite AC, greedy fallback genera AC), `compose.ts` (verifica post-invoke en `finishSuccessfulStep`), `types/index.ts` (campos aditivos), helper nuevo `verification.ts`, tests |
| **Scope OUT** | Cambios de billing por veredicto, UI de veredictos, persistencia DB del veredicto, LLM-judge en v1, disparo del retry WKH-130 por AC-fail |
| **Missing Inputs** | 3 [NEEDS CLARIFICATION] no bloqueantes — RESUELTOS en §4.10 |

### Acceptance Criteria (EARS) — heredados del work-item

- **AC-1**: WHEN el planner (LLM o greedy) produce los steps, THE system SHALL
  adjuntar a cada step una lista explícita y no vacía de acceptance criteria
  antes de que `compose` lo ejecute.
- **AC-2**: WHEN el agente de un step devuelve output (2xx), THE system SHALL
  evaluar ese output contra los AC del step y SHALL producir un veredicto
  `'pass'` / `'fail'` / `'unverified'`.
- **AC-3**: IF el veredicto de un step es `'fail'`, THEN THE system SHALL marcar
  ese step como NO-completado en la respuesta Y SHALL incluir el/los criterio(s)
  que fallaron — sin fail silencioso.
- **AC-4**: WHERE `/orchestrate` o `/compose` devuelve la respuesta, THE system
  SHALL incluir por step sus AC evaluados + veredicto como campo(s) ADITIVO(S)
  en `StepResult` — el shape existente permanece sin cambios.
- **AC-5**: WHEN todos los steps del pipeline tienen veredicto `'pass'`, THE
  system SHALL exponer un indicador de completitud a nivel pipeline
  (`verificationStatus`) DISTINTO y ADITIVO respecto de `pipeline.success`.
- **AC-6** (guard): IF un step falla sus AC, THEN THE system SHALL NOT modificar
  la lógica de débito/refund/billing de ese step en base al veredicto de AC.
- **AC-7**: WHERE el origen de un AC es LLM-generado, THE system SHALL usar
  `src/services/llm/models.ts` — PROHIBIDO hardcodear model id/timeout/max_tokens.

## 3. Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `src/services/orchestrate.ts` | Punto de generación de AC (plan-time) | `llmPlan` (:134-261) emite `input`+`reasoning` por agente en un solo call Sonnet (thinking disabled, `getPlannerModel`/`getPlannerMaxTokens`). `LlmPlanAgent` (:107-112). `greedyPlan` (:265-304) = fallback sin LLM. `steps = budgetedAgents.map(...)` (:606-611 y :281-286) es donde el `ComposeStep` se construye → acá se inyecta `acceptanceCriteria`. Money-path (debit/refund/fee) vive en `executeApprovedPlan` (:887+), disjunto del planning |
| `src/services/compose.ts` | Punto de verificación (execute-time) | Loop `for i` (:108). Guard anti-double-debit `i > 0 && scopingKeyRow && chainId !== undefined` (**:197**, CD-4). `invokeAgent` (:746) devuelve `{output, txHash, downstream}`. `finishSuccessfulStep` (:557-706) construye el `StepResult` (:595-606), lo pushea (:607) y emite el evento — COMPARTIDO happy-path + retry-ok (CD-9). Return success final (:539-545). La verificación se engancha acá, DESPUÉS del output, sin tocar el `try/catch` de invoke |
| `src/types/index.ts` | Shapes a extender additive-only | `ComposeStep` (:290-299), `ComposeRequest` (:301-345), `ComposeResult` (:347-365), `StepResult` (:367-387) — todos con extensiones opcionales previas (`?:`, spread condicional). `OrchestrateResult` (:478-496) tiene `pipeline: ComposeResult`. `OrchestratePlanResult` (:507-542) tiene `steps: ComposeStep[]` |
| `src/types/arbiter.ts` | Vocabulario `method` (DT-5) | `ArbiterMethod = 'rules' \| 'llm' \| 'hold'` (:17). Reuso el PATRÓN de vocabulario (`'rules' \| 'llm' \| 'none'`), NO el módulo |
| `src/services/arbiter/rules.ts` | Exemplar del motor determinístico puro | Función `classify(ev)` PURA sin I/O (:38), retorna union discriminada `{decision,...} \| {ambiguous, reason}`, orden explícito de reglas (el primero que matchea gana), aritmética en enteros con tolerancia. Este es el exemplar directo para `verification.ts` |
| `src/services/arbiter/llm-classifier.ts` | Exemplar del LLM-judge (para el seam diferido) | `classifyAmbiguous` never-throw → devuelve `null` en TODA ruta de fallo (sin API key / breaker / timeout / JSON inválido). Usa `getInputRetryModel`/`getInputRetryMaxTokens`/`getLlmTimeoutMs` (CD-2). Exemplar exacto SI se activa Wave 3 en v2 |
| `src/services/llm/models.ts` | CD-2 getters env-driven | Patrón `parse → validate range → fallback → log.warn → never throw` (readModelEnv/readIntEnv). `getTrivialModel()` = Haiku (:75). Un getter nuevo (`getVerifyMaxTokens`) seguiría este patrón — sólo en v2 |
| `src/services/orchestrate.test.ts` | CD-3 contrato byte-idéntico | **:557** = `expect(chargeProtocolFee).toHaveBeenCalledWith({orchestrationId, feeBaseUsdc, feeRate})` exact-match. Los campos aditivos NO deben alterar `pipeline.success` ni los params del fee |
| `doc/sdd/{151,150,149,145}/auto-blindaje.md` | Aprendizaje histórico | 4 patrones recurrentes → CD-6..CD-9 (§5) |

### Exemplars

| Para crear/modificar | Seguir patrón de | Razón |
|---------------------|------------------|-------|
| `src/services/verification.ts` (NUEVO) | `src/services/arbiter/rules.ts` | Motor determinístico PURO sin I/O, union discriminada, orden explícito de reglas, never-throw |
| `src/services/verification.test.ts` (NUEVO) | `src/services/arbiter/rules.test.ts` | Unit tests puros de un motor de reglas (una assertion por rama) |
| `StepResult.acceptance` (types) | `StepResult.transformLLM?` (:386) / `downstream*` (:379-384) | Campo aditivo opcional con sub-shape |
| `ComposeStep.acceptanceCriteria` (types) | `ComposeStep.passOutput?` (:298) | Campo aditivo opcional simple |
| `ComposeResult.verificationStatus` (types) | `ComposeResult.errorCode?` (:358) | Campo aditivo opcional a nivel resultado |
| Wiring en `finishSuccessfulStep` | El bloque `downstream &&` (:601-605) + `result.bridgeType = ...` (:629) | Adjuntar campo aditivo al `result` antes/después del push, sin tocar agregados |
| llmPlan emite AC | `LlmPlanAgent` + el `userPrompt` JSON schema (:186-191) | Extender el contrato JSON del planner sin call extra |
| Seam LLM-judge diferido (v2) | `src/services/arbiter/llm-classifier.ts` | never-throw → `null` = 'unverified' |

### Estado de BD relevante

| Tabla | Existe | Uso en esta HU |
|-------|--------|----------------|
| — | — | N/A. Persistencia del veredicto = Scope OUT (§4.10, [NC-3]). v1 vive SOLO en la respuesta HTTP (stateless) |

### Componentes reutilizables encontrados

- `getPlannerModel()` / `getPlannerMaxTokens()` / `getLlmTimeoutMs()` en `src/services/llm/models.ts` — el planner YA los usa; los AC LLM-generados viajan en ESE call (cero LLM extra).
- El vocabulario `'rules' | 'llm' | 'none'` es análogo a `ArbiterMethod` — reusar el patrón conceptual, no importar el tipo.
- `finishSuccessfulStep` es el ÚNICO punto de éxito de step (compartido happy-path + retry-ok) → un solo call-site para la verificación.

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Descripción | Exemplar | Wave |
|---------|--------|-------------|----------|------|
| `src/services/verification.ts` | Crear | Helper puro rules-first: `verifyStepOutput(output, criteria) → StepAcceptance` + `summarizePipelineVerification(results) → PipelineVerificationStatus` + `DEFAULT_AC` + `genericAcceptanceCriteria()` | `arbiter/rules.ts` | W0 |
| `src/types/index.ts` | Modificar | +`StepAcceptance`, +`StepVerdict`, +`VerificationMethod`, +`PipelineVerificationStatus`; extender `ComposeStep.acceptanceCriteria?`, `StepResult.acceptance?`, `ComposeResult.verificationStatus?` | campos `?:` previos | W0 |
| `src/services/verification.test.ts` | Crear | Unit tests puros del helper (todas las ramas de veredicto + summarize + generic AC) | `arbiter/rules.test.ts` | W0 |
| `src/services/compose.ts` | Modificar | En `finishSuccessfulStep`: adjuntar `result.acceptance = verifyStepOutput(output, steps[i]?.acceptanceCriteria)` (never-throw). En el return success final: `verificationStatus = summarizePipelineVerification(results)` | :601-605 / :539-545 | W1 |
| `src/services/compose.test.ts` | Modificar | Tests de verificación en compose (AC-2/3/4/5/6) | tests existentes | W1 |
| `src/services/orchestrate.ts` | Modificar | `llmPlan` emite `acceptanceCriteria` por agente (mismo call); `greedyPlan` + ambos `.map(...)` a `ComposeStep` setean `acceptanceCriteria` (LLM > generic fallback) | :186-191 / :281-286 / :606-611 | W2 |
| `src/services/orchestrate.test.ts` | Modificar | Tests de AC en plan-time (AC-1) + no-regresión de shape (CD-3) | :557 | W2 |

### 4.2 Modelo de datos

N/A — sin cambios de BD. El veredicto vive solo en la respuesta HTTP (stateless, v1).

### 4.3 Componentes / Servicios

#### 4.3.1 Tipos aditivos (`src/types/index.ts`) — DT-4 / DT-5 / CD-3

```
export type StepVerdict = 'pass' | 'fail' | 'unverified';
export type VerificationMethod = 'rules' | 'llm' | 'none';   // DT-5, análogo a ArbiterMethod
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

Extensiones additive-only (todos `?:`, ningún campo existente cambia):
- `ComposeStep.acceptanceCriteria?: string[]` — AC adjuntos en plan-time o por el caller.
- `StepResult.acceptance?: StepAcceptance` — veredicto evaluado (AC-4).
- `ComposeResult.verificationStatus?: PipelineVerificationStatus` — completitud a nivel pipeline (AC-5), DISTINTA de `success: boolean`.

> `OrchestrateResult` NO necesita campo nuevo propio: su `pipeline` ES un
> `ComposeResult`, así que `verificationStatus` viaja dentro de `pipeline`
> automáticamente. `OrchestratePlanResult` tampoco: sus `steps: ComposeStep[]`
> ya cargan `acceptanceCriteria` (visible en el quote de `/orchestrate/plan`).
> Esto minimiza la superficie aditiva (menos riesgo CD-3).

#### 4.3.2 Helper de verificación (`src/services/verification.ts`) — DT-2, rules-first

Módulo PURO (sin I/O, sin billing, sin Anthropic en v1). Ubicación decidida:
**`src/services/verification.ts`** (single-file — el work-item lo lista como
"helper"; el seam LLM-judge diferido queda documentado, no construido).

Firma principal:

```
verifyStepOutput(output: unknown, criteria: string[] | undefined): StepAcceptance
```

Reglas determinísticas v1 (orden explícito — mismo estilo que `arbiter/rules.ts`):

1. **Sustitución de default**: si `criteria` es `undefined`/vacío → usar
   `DEFAULT_AC = ['output is present and non-empty', 'output has no error field']`
   y `method='rules'`. (Resuelve [NC-1]: `/compose` manual sin AC igual obtiene
   un baseline determinístico, NO queda ciego.)
2. **Global — non-empty output**: `output` es `null`/`undefined`, string vacío,
   array vacío, u objeto `{}` → `verdict='fail'`, `failedCriteria` incluye el
   criterio de presencia. (Éste caza el Chaski-$0: 200-ok con cuerpo vacío.)
3. **Global — error field**: si `output` es objeto y tiene una señal de error
   determinística — `error` truthy, `errors` array no vacío, `success === false`,
   o `status ∈ {'failed','error'}` → `verdict='fail'` con el criterio de error.
4. **Por-criterio estructurable** (best-effort, string-matching determinístico
   sobre el JSON del output, case-insensitive):
   - `contains "X"` / `includes "X"` / token entrecomillado → el output debe
     contener `X`.
   - `has <field>` / `<field> present` / `non-empty <field>` → el campo existe y
     es no-vacío.
   - Un criterio que las reglas NO pueden estructurar (semántico/subjetivo, ej.
     "the flight was actually booked") → se marca UNDECIDABLE por reglas.
5. **Resolución del veredicto**:
   - Cualquier criterio estructurable FALLA (o falla una regla global 2/3) →
     `verdict='fail'`, `method='rules'`, `failedCriteria=[...]`.
   - Todos los criterios evaluables PASAN y no hay undecidables → `verdict='pass'`,
     `method='rules'`.
   - Hay ≥1 criterio undecidable y ninguno falló → `verdict='unverified'`,
     `method='rules'` (las reglas no pudieron decidir; en v1 NO se escala a LLM).

Never-throw (CD-8): TODA la función corre bajo un guard; ante cualquier error
interno inesperado devuelve `{criteria, verdict:'unverified', method:'none'}`.

Helpers auxiliares del módulo:
- `summarizePipelineVerification(results: StepResult[]): PipelineVerificationStatus`
  → precedencia: algún `acceptance.verdict==='fail'` → `'incomplete'`; si TODOS
  `'pass'` → `'verified'`; en otro caso (≥1 `'unverified'`, sin fails) →
  `'unverified'`. (AC-5: `'verified'` ⟺ todos pass.)
- `genericAcceptanceCriteria(): string[]` → devuelve `DEFAULT_AC` (usado por
  `greedyPlan` y por el planner cuando el LLM no emitió AC — DT-1(c)).

#### 4.3.3 Decisión arquitectónica: Wave 3 (LLM-judge) — **DIFERIDA a v2**

**Decisión: v1 ships rules-only. El LLM-judge queda DIFERIDO a una HU
follow-up (sugerida WKH-114b), detrás de flag.** Razones:

1. **Money-path critical path**: `/orchestrate` ya paga 1 call Sonnet (planner,
   30s timeout). Un judge por-step multiplicaría los calls LLM (N steps × Haiku)
   metiendo latencia, costo y no-determinismo en el path que mueve plata —
   exactamente lo que el orquestador pidió evitar (recomendación conservadora).
2. **CD-1 neutraliza el valor marginal**: como el veredicto NO gatea billing,
   `unverified` vs `fail` no tiene consecuencia financiera en v1 → el call LLM
   extra compra señal marginal a cambio de latencia real.
3. **Rules-first ya caza el gap objetivo**: el incidente Chaski-$0 (200-ok con
   cuerpo vacío / error silencioso) lo detectan las reglas globales 2/3 sin LLM.
4. **Seam limpio ya provisto**: el tipo `VerificationMethod` incluye `'llm'` sin
   cambio de shape; `verdict='unverified'` es el punto de enganche natural. La
   HU v2 sólo agregaría `src/services/verification/llm-judge.ts` (espejo de
   `arbiter/llm-classifier.ts`, never-throw → `null` = 'unverified'), un getter
   `getVerifyMaxTokens` en `llm/models.ts` (CD-2), timeout corto vía
   `getLlmTimeoutMs()`, SIN retry, corriendo SOLO en `/orchestrate` (no forzar
   latencia en `/compose` plano — resuelve [NC-2]).

> El SDD NO construye el judge. Deja el gancho documentado y el vocabulario listo.

#### 4.3.4 Wiring en `compose.ts` (W1) — CD-4 / CD-5

- En `finishSuccessfulStep`, DESPUÉS de construir `result` (:595-606) y ANTES o
  justo en el push (:607): `result.acceptance = verifyStepOutput(output, steps[i]?.acceptanceCriteria)`.
  - Es sync, puro, never-throw → no agrega vía de fallo, no toca el `try/catch`
    de `invokeAgent`, no reinvoca (CD-5), no toca débito/refund (CD-4/CD-1).
  - Corre en el ÚNICO call-site de éxito (compartido happy-path + retry-ok, CD-9)
    → cobertura de ambos paths con un solo cambio.
- En el return success final de `compose()` (:539-545): agregar
  `verificationStatus: summarizePipelineVerification(results)` (campo aditivo).
  - v1 computa `verificationStatus` SOLO en el return de éxito. Los early-returns
    de fallo (:114-121, :133-148, :162-169, :248-258, :503-510, :529-536) NO se
    tocan (money-path byte-estable); los `steps[].acceptance` de los steps que sí
    completaron igual viajan en `results`. (Nivel-pipeline en fallo = follow-up.)

#### 4.3.5 Wiring en `orchestrate.ts` (W2) — DT-1, AC-1, CD-2

- `LlmPlanAgent` (:107-112) += `acceptanceCriteria?: string[]`.
- `llmPlan` systemPrompt + userPrompt JSON schema (:162-192): instruir al planner
  a emitir **2-4 AC concretos, concisos (≤ ~8 palabras c/u), verificables** por
  agente, en el MISMO call (cero LLM extra, cero cambio de modelo/timeout — CD-2).
- Validación de AC LLM (mismo estilo runtime que el filtro de slugs :236-239):
  quedarse con strings no-vacíos, recortar a máx 4; si el agente no trajo AC
  válidos → `genericAcceptanceCriteria()`.
- Al construir los `ComposeStep`:
  - Path LLM (:606-611): `acceptanceCriteria: sanitize(a.acceptanceCriteria) ?? genericAcceptanceCriteria()`.
  - `greedyPlan` (:281-286): `acceptanceCriteria: genericAcceptanceCriteria()` (DT-1(c), sin LLM).
- Garantiza AC-1: TODO step lleva una lista no-vacía antes de que `compose` corra.

### 4.4 Flujo principal (Happy Path)

1. `/orchestrate`: `planOrchestration` corre discovery + `llmPlan`. El planner
   devuelve, por agente, `input` + `reasoning` + `acceptanceCriteria` (2-4 AC).
2. Cada `ComposeStep` se construye con `acceptanceCriteria` poblado (LLM o
   generic fallback). El quote de `/orchestrate/plan` ya los muestra.
3. `executeApprovedPlan` → `composeService.compose(...)` (money-path INTACTO).
4. Por step: `invokeAgent` OK → `finishSuccessfulStep` construye el `StepResult`,
   corre `verifyStepOutput(output, criteria)` (rules-first) y adjunta
   `result.acceptance = {criteria, verdict, method, failedCriteria?}`.
5. Al terminar el pipeline con éxito: `verificationStatus =`
   `summarizePipelineVerification(results)` (`'verified'` si todos pass).
6. La respuesta expone `pipeline.steps[].acceptance` + `pipeline.verificationStatus`,
   `pipeline.success` sin cambios. Billing sin cambios.

### 4.5 Flujo de error

1. **Output vacío / con error field (Chaski-$0)**: agente responde 2xx pero
   cuerpo vacío/`{error:...}` → `verifyStepOutput` → `verdict='fail'` +
   `failedCriteria`. El step se reporta en `results` con `acceptance.verdict='fail'`
   (AC-3, sin fail silencioso). **El débito/settle del step NO cambia** (CD-1/
   AC-6): el money-path ya corrió y se mantiene; el veredicto es solo señal.
2. **AC semántico indecidible por reglas**: `verdict='unverified'`, `method='rules'`
   (en v1 no se escala a LLM). Pipeline con ≥1 unverified y 0 fails →
   `verificationStatus='unverified'`.
3. **Error interno del verificador**: guard never-throw → `{verdict:'unverified',
   method:'none'}`. NUNCA aborta el pipeline ni dispara refund (CD-4/CD-8).
4. **Pipeline falla en un step (no-AC)**: compose hace su early-return de fallo
   habitual (money-path intacto); `verificationStatus` no se computa en v1 en ese
   return (los `steps[].acceptance` de steps completados siguen presentes).

## 5. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir
- **CD-2** (heredado): cualquier AC LLM-generado usa `src/services/llm/models.ts`
  (`getPlannerModel`/`getPlannerMaxTokens` ya en uso por el planner). En v2, el
  judge usaría `getTrivialModel`/`getLlmTimeoutMs` + nuevo `getVerifyMaxTokens`
  (patrón parse→validate→fallback→log.warn→never-throw). PROHIBIDO hardcodear
  model id/timeout/max_tokens.
- **CD-3** (heredado): additive-only en `ComposeStep`/`StepResult`/`ComposeResult`/
  `OrchestrateResult`/`OrchestratePlanResult` — todos los campos nuevos `?:`. El
  test `orchestrate.test.ts:557` (exact-match de `chargeProtocolFee` params) y el
  shape de `pipeline.success` NO se rompen.
- `verification.ts` sigue el patrón de `arbiter/rules.ts`: función pura, union
  discriminada, orden explícito de reglas.
- **CD-9** (nuevo, auto-blindaje WKH-71/WKH-139): correr `biome check --write`
  sobre cada archivo nuevo ANTES de cerrar la wave; imports en orden alfabético.

### PROHIBIDO
- **CD-1** (heredado): PROHIBIDO que el veredicto de AC modifique/gatee
  `budgetService.debit`/`credit`/`creditDelegation`/`creditSession`/
  `chargeProtocolFee`/`refundOutbox` o cualquier rama de billing en
  `compose.ts`/`orchestrate.ts`. Un step que falla sus AC se expone pero NO
  cambia cobro/refund/fee. **BLOQUEANTE** en AR/CR.
- **CD-4** (heredado): PROHIBIDO tocar el guard `i > 0` (`compose.ts:197`) o el
  money-path. La verificación vive en capa aparte, DESPUÉS de `invokeAgent` y del
  manejo éxito/error del step; NUNCA reemplaza el `try/catch` de invocación ni
  introduce una nueva vía de fallo que dispare refund.
- **CD-5** (heredado): PROHIBIDO que la verificación dispare una 2ª `invokeAgent`
  o interactúe con el retry adaptativo (WKH-130, gatillado SOLO por field-errors
  HTTP). Un AC-fail se expone; NO reintenta.
- **CD-6** (nuevo, auto-blindaje WKH-71 BLQ-1 "validate ≠ parse"): el verificador
  al inspeccionar el output NUNCA asume que un valor "parece" de un tipo — validar
  con el MISMO criterio con que se lo consume. `Number(x)`/`JSON.stringify(x)` de
  outputs arbitrarios pueden dar `NaN`/circular → envolver en guard, tratar el
  fallo como `unverified`, nunca propagar el throw.
- **CD-7** (nuevo, auto-blindaje WKH-77 "200-ok ≠ trabajo hecho"): PROHIBIDO que
  la regla de presencia trate "hubo respuesta HTTP 2xx" como "el step está
  completo". La regla 2 (non-empty) + regla 3 (error field) existen precisamente
  para separar "recibí un body" de "el body evidencia trabajo real".
- **CD-8** (nuevo, auto-blindaje WKH-71/WKH-77 aislamiento never-throw): la
  verificación por-step corre aislada — un error verificando el step `i` NUNCA
  aborta los demás steps ni el pipeline; cae a `verdict='unverified'`. Nunca
  `for await` en serie con red (v1 es sync/puro, sin red — pero SI v2 agrega el
  judge, aislar cada judge con su propio try/catch, never-throw → null).
- NO agregar dependencias nuevas.
- NO modificar archivos fuera del Scope IN.
- NO persistir el veredicto en DB (v1 stateless).

## 6. Scope

**IN:** `verification.ts` (nuevo helper puro), extensiones aditivas en
`types/index.ts`, wiring en `compose.ts` (`finishSuccessfulStep` + return success)
y `orchestrate.ts` (`llmPlan` + `greedyPlan` + mapeos a `ComposeStep`), tests.

**OUT:** LLM-judge (diferido v2/WKH-114b), cambios de billing por veredicto,
persistencia DB, UI de veredictos, disparo del retry WKH-130 por AC-fail,
`verificationStatus` en los early-returns de fallo de compose (follow-up).

## 7. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| Emitir 2-4 AC por agente infla el output del planner y trunca el JSON del plan (ver comentario WKH-134 en orchestrate.ts:203-207) | M | A | Instrucción explícita "concisos ≤8 palabras, máx 3-4 por step"; el knob `LLM_PLANNER_MAX_TOKENS` ya existe (env, sin cambiar default); validación runtime tolera AC ausentes → generic fallback (no rompe el plan) |
| Un campo aditivo altera un test de shape byte-idéntico | M | A | Todos `?:`; verificar `orchestrate.test.ts:557` + suite completa verde; el fee params object NO recibe campos nuevos |
| `JSON.stringify(output)` con referencia circular / BigInt lanza | B | M | CD-6: guard try/catch → `unverified` (never-throw) |
| Falso `fail` por criterio estructurable mal parseado | M | B | AC-fail NO afecta billing (CD-1) → sin consecuencia financiera; es solo señal; reglas conservadoras (undecidable → unverified, no fail) |
| Un AR/CR lee el wiring como si gateara billing | B | A | Comentarios explícitos CD-1/CD-4 en el call-site; el verificador no importa `budgetService` |

## 8. Dependencias

- Ninguna HU activa bloquea (según work-item §Análisis de paralelismo: la última
  DONE, 151/WKH-74, no toca estos 3 archivos).
- Coordinar orden de merge si otra HU toca `compose.ts`/`orchestrate.ts`/
  `types/index.ts` en simultáneo (conflicto de archivo, no funcional).

## 9. Missing Inputs

Ninguno bloqueante. Los 3 [NEEDS CLARIFICATION] del work-item se resuelven en §4.10.

## 10. Uncertainty Markers / Resolución de [NEEDS CLARIFICATION]

| Marker | Sección | Descripción | Resolución | Bloqueante? |
|--------|---------|-------------|------------|-------------|
| [NC-1] | 4.3.2 | ¿Quién genera el AC en `/compose` manual sin planner? | **RESUELTO**: el verificador sustituye `DEFAULT_AC` determinístico (output no vacío + sin error field) cuando el step no trae `acceptanceCriteria`. El caller PUEDE proveerlos vía `ComposeStep.acceptanceCriteria`. Nunca queda ciego. | No |
| [NC-2] | 4.3.3 | ¿El LLM-judge corre en `/compose` también o solo `/orchestrate`? | **RESUELTO**: LLM-judge DIFERIDO a v2 (WKH-114b). Cuando se implemente, corre SOLO en `/orchestrate` (no forzar latencia en `/compose` plano). v1 no tiene judge. | No |
| [NC-3] | 4.2 | ¿Se persiste el veredicto en DB? | **RESUELTO**: NO en v1. Vive solo en la respuesta HTTP (stateless). Persistencia = HU separada. | No |

> Gate: cero [NEEDS CLARIFICATION] pendientes. Todos resueltos con default del
> work-item + decisión del Architect.

## 11. Plan de Waves

### Wave 0 (Serial Gate — contratos/tipos + helper puro)
- **W0.1**: Tipos aditivos en `src/types/index.ts` (`StepVerdict`,
  `VerificationMethod`, `PipelineVerificationStatus`, `StepAcceptance`,
  `ComposeStep.acceptanceCriteria?`, `StepResult.acceptance?`,
  `ComposeResult.verificationStatus?`).
- **W0.2**: `src/services/verification.ts` (rules-first puro, never-throw) →
  Exemplar: `arbiter/rules.ts`.
- **W0.3**: `src/services/verification.test.ts` (unit puro, todas las ramas).
- Verificación: `tsc` + `biome check` + `vitest verification.test.ts` verde.

### Wave 1 (Paralelizable — verificación en compose, sin planner)
- **W1.1**: Wiring en `finishSuccessfulStep` (`result.acceptance`) + return
  success (`verificationStatus`) en `compose.ts`. Depende de W0.
- **W1.2**: Tests en `compose.test.ts` (AC-2/3/4/5/6, CD-1/CD-4).
- Standalone-testeable SIN tocar `orchestrate.ts` (el work-item lo sugiere).
- Verificación: `tsc` + `biome` + `vitest compose.test.ts`.

### Wave 2 (Depende de W0 — AC en plan-time)
- **W2.1**: `llmPlan` emite `acceptanceCriteria` (mismo call) + validación
  runtime + `greedyPlan`/mapeos setean AC (generic fallback). En `orchestrate.ts`.
- **W2.2**: Tests en `orchestrate.test.ts` (AC-1 + no-regresión shape CD-3 :557).
- Verificación: `tsc` + `biome` + `vitest orchestrate.test.ts` (incluye :557).

### Wave 3 (LLM-judge) — **DIFERIDA (no se implementa en esta HU)**
- Gancho documentado (§4.3.3). HU follow-up sugerida WKH-114b.

## 12. Test Plan (≥1 test por AC)

| Test (archivo) | AC cubierto | Descripción | Wave |
|----------------|-------------|-------------|------|
| `verification.test.ts` — `verify: good output → pass` | AC-2 | Output no vacío que cumple AC estructurables → `verdict='pass'`, `method='rules'` | W0 |
| `verification.test.ts` — `verify: empty/200-ok body → fail` | AC-2, AC-3, CD-7 | Output `null`/`''`/`{}`/`[]` → `verdict='fail'` + `failedCriteria` con el criterio de presencia | W0 |
| `verification.test.ts` — `verify: error field → fail` | AC-2, AC-3, CD-7 | `{error:'x'}` / `{success:false}` / `{status:'failed'}` → `verdict='fail'` + `failedCriteria` | W0 |
| `verification.test.ts` — `verify: no criteria → default baseline` | AC-2, NC-1 | `criteria=undefined` → sustituye `DEFAULT_AC`, evalúa pass/fail | W0 |
| `verification.test.ts` — `verify: semantic criterion → unverified` | AC-2 | Criterio no estructurable + output válido → `verdict='unverified'`, `method='rules'` | W0 |
| `verification.test.ts` — `verify: circular/BigInt output never throws` | CD-6, CD-8 | Output que rompe `JSON.stringify` → `unverified`, sin throw | W0 |
| `verification.test.ts` — `summarize: all pass → verified` | AC-5 | Todos `pass` → `'verified'` | W0 |
| `verification.test.ts` — `summarize: any fail → incomplete` | AC-3, AC-5 | ≥1 `fail` → `'incomplete'` | W0 |
| `verification.test.ts` — `summarize: unverified mix → unverified` | AC-5 | Sin fails, ≥1 `unverified` → `'unverified'` | W0 |
| `verification.test.ts` — `genericAcceptanceCriteria non-empty` | AC-1 | Devuelve lista no-vacía determinística | W0 |
| `compose.test.ts` — `StepResult.acceptance additive, base shape intact` | AC-4 | `agent/output/costUsdc/latencyMs/txHash` sin cambios; `acceptance` presente | W1 |
| `compose.test.ts` — `pipeline.verificationStatus additive & distinct` | AC-5 | Todos pass → `verificationStatus='verified'`; `success` sigue boolean idéntico | W1 |
| `compose.test.ts` — `AC-fail step does NOT alter billing` | AC-6, CD-1 | Step 2xx con `acceptance.verdict='fail'` → `budgetService.credit`/refund NO llamado por AC; `totalCostUsdc` intacto | W1 |
| `compose.test.ts` — `verifier error → pipeline still succeeds` | CD-4, CD-8 | Verificador cae a `unverified` sin abortar el pipeline ni disparar refund | W1 |
| `orchestrate.test.ts` — `llmPlan attaches non-empty AC per step` | AC-1 | `steps[].acceptanceCriteria` no-vacío (LLM path) | W2 |
| `orchestrate.test.ts` — `greedy fallback attaches generic AC` | AC-1 | Fallback sin LLM → `acceptanceCriteria = generic` no-vacío | W2 |
| `orchestrate.test.ts` — `:557 chargeProtocolFee params unchanged` | AC-4, AC-6, CD-3 | El exact-match del fee y `pipeline.success` NO cambian | W2 |
| `orchestrate.test.ts` — `AC uses centralized model getters (no hardcode)` | AC-7, CD-2 | El planner no introduce model id/timeout literal; los AC viajan en el call existente | W2 |

## 13. Readiness Check

```
READINESS CHECK:
[x] Cada AC (AC-1..7) tiene ≥1 archivo asociado en tabla 4.1 y ≥1 test en §12
[x] Cada archivo en 4.1 tiene Exemplar verificado con Read/Glob (arbiter/rules.ts, StepResult.transformLLM, orchestrate.test.ts:557 confirmados en disco)
[x] Cero [NEEDS CLARIFICATION] pendientes — [NC-1/2/3] resueltos en §10
[x] Constraint Directives incluyen ≥3 PROHIBIDO (CD-1,4,5,6,7,8 + varios)
[x] Context Map tiene ≥2 archivos leídos (8 archivos + 4 auto-blindajes)
[x] Scope IN y OUT explícitos y no ambiguos (§6)
[x] BD: N/A confirmado (v1 stateless, sin tablas nuevas)
[x] Happy Path completo (§4.4)
[x] Flujo de error definido (§4.5, 4 casos)
[x] Additive-only verificado: todos los campos nuevos `?:`; ningún campo/tipo/semántica existente cambia (CD-3)
[x] Billing-safe verificado: el verificador es puro, no importa budgetService, corre DESPUÉS del money-path, never-throw (CD-1/CD-4/CD-5)
[x] Decisión Wave 3 tomada: LLM-judge DIFERIDO a v2, seam documentado (§4.3.3)
[x] Aprendizaje histórico aplicado: CD-6/7/8/9 derivados de auto-blindajes WKH-71/77/139
```

Todos los checks pasan. SDD listo para GATE 2 (SPEC_APPROVED).

---

*SDD generado por NexusAgil — FULL — nexus-architect F2*
