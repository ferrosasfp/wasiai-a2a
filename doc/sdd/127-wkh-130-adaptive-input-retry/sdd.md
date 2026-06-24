# SDD — [WKH-130] Adaptive Input-Retry

> Fase F2 (Specification-Driven Design). Input: `work-item.md` (HU_APPROVED).
> SDD_MODE: full · Sizing: L · Smart Sizing: QUALITY (money-path).
> Este SDD fija TODAS las decisiones que el work-item dejó abiertas. 0 `[NEEDS CLARIFICATION]`.

---

## 1. Context Map — archivos leídos y patrón extraído

| Archivo (verificado con Read) | Por qué | Qué extraje |
|---|---|---|
| `src/services/compose.ts:67` | Entry point real | El método público es `composeService.compose(request)` (NO `execute()`). El loop de steps vive dentro. |
| `src/services/compose.ts:139-194` | Débito per-step (fee-on-attempt) | `stepDebitedUsd` se setea tras `budgetService.debit(scopingKeyRow.id, chainId, debitAmount, delegationCtx, sessionCtx, normalizeDestination(\`${registry}/${slug}\`))`. Guard `i>0 && scopingKeyRow && chainId!==undefined`. |
| `src/services/compose.ts:196-209` | Build input + invoke | `input = step.passOutput && lastOutput ? {...step.input, previousOutput:lastOutput} : step.input`. Luego `try { invokeAgent(agent, input, a2aKey) }`. |
| `src/services/compose.ts:319-384` | **Catch del step (CORE)** | Emite `compose_step` failed → si `stepDebitedUsd>0 && scopingKeyRow && chainId!==undefined && !delegationContext && !keySessionContext` reembolsa via `creditWithDest` (si hay destination) o `credit` → `return {success:false, error:\`Step ${i} failed: ${msg}\`}`. ESTE es el bloque que el retry intercepta ANTES del return. |
| `src/services/compose.ts:502-519` | `invokeAgent` throw del 4xx | `if(!response.ok){ detail = (await response.text()).slice(0,300)...; throw new Error(\`Agent ${slug} returned ${status}${detail?\`: ${detail}\`:''}\`) }`. **El status y el body viajan en `Error.message`** — única fuente para el parser. |
| `src/services/compose.ts:422-431` | Firma `invokeAgent` | `invokeAgent(agent, input, a2aKey?, logger?): Promise<{output, txHash?, downstream?}>`. El retry RE-USA este método (no duplica fetch). |
| `src/services/orchestrate.ts:8-12,55-64,122-136` | Patrón Anthropic + circuit-breaker | `import Anthropic from '@anthropic-ai/sdk'`; singleton lazy `getAnthropicClient()` (apiKey desde env, `null` si falta); `AbortController`+`setTimeout(abort, TIMEOUT)`; `anthropicCircuitBreaker.execute(() => client.messages.create(..., {signal}))`. `CircuitOpenError` exportado. |
| `src/services/llm/transform.ts:31,115-190` | Patrón helper LLM module | `TIMEOUT_MS=30_000`; `client.messages.create({model, max_tokens, system, messages:[{role:'user',content}]}, {signal})`; extrae texto `.content.filter(type==='text').map(b=>b.text).join('').trim()`; `JSON.parse(text)`; `return null`/throw en shape inválido. |
| `src/services/llm/select-model.ts:10-40` | Modelo cost-aware | `selectModel(schema)` → `'claude-haiku-4-5-20251001'` por defecto, `'claude-sonnet-4-6'` si `required.length>=5`/nested/oneOf. Tipo `PricedModel`. |
| `src/lib/circuit-breaker.ts:21,44,134-139` | Breaker | `anthropicCircuitBreaker.execute(fn)`; lanza `CircuitOpenError` si `open`. Threshold/window/cooldown desde env. |
| `src/services/budget.ts:72-79,335-340,377-383` | Firmas billing | `debit(keyId, chainId, amountUsd, delegationCtx?, sessionCtx?, destination?)`; `credit(keyId, chainId, amountUsd, ownerRef)`; `creditWithDest(keyId, chainId, amountUsd, ownerRef, destination)`. Todas `Promise<{success, error?}>`. |
| `src/services/compose.test.ts:1-64,98-135,1089,1190-1300` | Patrón de tests | Mocks: `budget.js` (debit/credit/creditWithDest), `fetch` global, `discovery.js`, `event.js`, `llm/transform.js`. Helpers `mockFetchOk()`, `mockFetchError(status)`, `mockAgentsBySlug()`, `makeKeyRow()`. `mockDebit`/`mockCredit`/`mockCreditWithDest` via `vi.mocked`. Asserts de orden via `mock.calls`. |
| `src/services/orchestrate.billing.test.ts` | **Test en riesgo (auto-blindaje)** | Ejercita COMPOSE REAL (fetch mockeado, no mockea `composeService.compose`). Asevera conteos exactos de `budgetService.debit`. El nuevo retry-debit puede alterar conteos aquí → revisar (ver CD-12). |

**Decisión de naming/import**: el helper LLM nuevo vive en `src/services/llm/input-retry.ts` y el parser puro en `src/lib/field-error-parser.ts` (ambos en Scope IN del work-item). Imports con extensión `.js` (ESM, igual que todo el codebase). El parser NO depende de nada (función pura).

---

## 2. Decisiones técnicas fijadas (DT-N)

Heredo DT-1..DT-7 del work-item. Cierro los TBD:

- **DT-3 (RESUELTO) — modelo LLM hardcoded Haiku, NO `selectModel`**. En este path el agente **no tiene `input_schema`** (es justo la razón por la que falló y por la que `selectModel`, que lee un schema, no aplica). La señal de entrada es una lista plana de nombres de campo (`string[]`), sin nesting ni oneOf. La tarea es trivial: "tomá este input y agregá/corregí estos campos con valores plausibles". → **`MODEL = 'claude-haiku-4-5-20251001'` constante de módulo**. No se invoca `selectModel`. Justificación adicional: Haiku es ~10-15x más barato y la latencia es menor (importa porque esto corre dentro del catch de un pipeline ya degradado). Si en el futuro se quiere escalar, es un cambio de 1 línea — fuera de scope.

- **DT-2 (confirmado) — cliente Anthropic propio en el helper**. `input-retry.ts` instancia su **propio singleton lazy** (`getAnthropicClient()`, espejo exacto de `orchestrate.ts:56-64`). NO importa nada de `transform.ts` ni `orchestrate.ts` (bajo acoplamiento, testeable en aislamiento, mockeable desde `compose.test.ts`).

- **DT-7 (confirmado) — circuit-breaker compartido**. La llamada usa `anthropicCircuitBreaker.execute(...)`. Si está `open`, `execute` lanza `CircuitOpenError` → el helper lo captura y devuelve `null` (= "no retry", cae al comportamiento actual). CD-7.

- **DT-8 (NUEVO) — telemetría: emitir AMBOS eventos con flags**. (Resuelve Missing #3). El evento `compose_step` failed del primer intento **se emite igual** (el primer intento SÍ falló, suprimirlo falsearía la tasa de error upstream del agente). Cuando hay retry se agregan flags al metadata:
  - Primer intento fallido que dispara retry: `compose_step` `status:'failed'` + `metadata.retry_attempted: true`.
  - Retry exitoso: el `compose_step` `status:'success'` del happy-path lleva `metadata.retried: true`.
  - Retry fallido: `compose_step` `status:'failed'` (el del retry) + `metadata.retry_failed: true`.
  - Además, log estructurado `[compose.retry]` con `{step, agent, status, firstError, retryError?}` (AC-9).
  Justificación: no se pierde telemetría; un dashboard puede filtrar `retry_attempted && !retry_failed` para medir "recuperados por retry" sin contaminar la tasa de fallo real del agente. NO hay SLA que exija ocultar el primer fallo → no aplica `[NEEDS CLARIFICATION]`.

- **DT-9 (NUEVO) — el retry vive en un helper interno `tryAdaptiveRetry`, NO inline**. Razón: el catch actual hace `refund → return`. El retry necesita interceptar ENTRE el refund y el return. Inlinear duplicaría el bloque de refund (4 ramas: creditWithDest/credit + guard) y haría el catch ilegible (~90 líneas). Se extrae una closure/método interno `tryAdaptiveRetry(...)` que recibe el contexto del step y devuelve un resultado discriminado:
  ```
  type RetryOutcome =
    | { kind: 'retried-ok'; result: StepResult }      // re-invoke 2xx → seguir pipeline
    | { kind: 'no-retry' }                              // no parseable / 5xx / circuit / deleg-sesión → comportamiento actual
    | { kind: 'retried-failed'; retryError: string };   // re-invoke falló → refund retry-debit ya hecho dentro
  ```
  El refund del PRIMER débito sigue ocurriendo en el catch ANTES de invocar `tryAdaptiveRetry` (orden DT-5). El refund del RETRY débito (si el retry falla) ocurre DENTRO de `tryAdaptiveRetry` (mantiene la simetría: quien debita, reembolsa). Ver §4.

- **DT-10 (NUEVO) — `max_tokens` y formato del helper**. `max_tokens: 1024` (input objects son chicos; suficiente). System prompt y user prompt fijados en §3.2. El helper devuelve `Record<string,unknown> | null` (nunca throw hacia compose — degrada a `null`).

---

## 3. Diseño de los nuevos artefactos

### 3.1 `src/lib/field-error-parser.ts` — función pura

**Firma**: `export function parseFieldErrors(errorMessage: string): string[] | null`

**Contrato**:
- Input: el `Error.message` crudo del catch, formato `"Agent <slug> returned <status>: <body_truncado_300>"`.
- Output: `string[]` con ≥1 nombre de campo faltante/inválido, o `null` si nada parseable.
- **Pura**: sin I/O, sin throw (cualquier excepción interna → `null`). Testeable en aislamiento.

**Algoritmo (cascada)**:
1. **Guard de status**: extraer el status con regex `/returned (\d{3})/`. Si no es 4xx (`status < 400 || status >= 500`) → `return null`. (Refuerza CD-3 a nivel parser; el caller igual filtra, pero el parser no debe inventar campos de un 5xx).
2. **Extraer el JSON del body**: tomar la subcadena desde el primer `{` hasta el último `}` del mensaje. Si no hay `{...}` → ir al paso 4 (texto libre). `JSON.parse` con try/catch; si falla → paso 4.
3. **Shape Zod (`details.fieldErrors`)**: si `parsed.details?.fieldErrors` es un objeto → `Object.keys(fieldErrors)` filtrando los que tienen al menos un mensaje. Si ≥1 → `return keys`.
4. **Shape texto libre**: tomar el string de `parsed.error ?? parsed.message ?? <el body crudo>`. Aplicar patrones:
   - `"a, b, c required"` / `"a, b required"` → split por `,`/`and`, quedarse con tokens que preceden a `required`.
   - `"field X is required"` / `"X is required"` / `"missing field X"` → capturar `X`.
   - Normalizar: trim, descartar tokens vacíos o no-identificadores (solo `[A-Za-z0-9_]+`).
   - Si ≥1 token → `return tokens`. Si 0 → `return null`.
5. Cualquier path que no produzca ≥1 campo → `return null`.

**Ejemplos input → output (shapes reales confirmados en work-item §Shape de field-errors)**:

| Input (`errorMessage`) | Output |
|---|---|
| `Agent cobraya-cfdi returned 422: {"error":"invalid_input","details":{"fieldErrors":{"uuidCfdi":["Required"],"rfcEmisor":["Required"]}}}` | `['uuidCfdi','rfcEmisor']` (shape Zod) |
| `Agent agentshop-remit returned 400: {"error":"senderName, amountUSD, receiverCountry required"}` | `['senderName','amountUSD','receiverCountry']` (texto libre) |
| `Agent foo returned 422: {"message":"field walletAddress is required"}` | `['walletAddress']` (texto libre, key `message`) |
| `Agent foo returned 422: {"error":"invalid_input"}` (sin fieldErrors, sin pattern) | `null` |
| `Agent foo returned 502: {"error":"upstream down"}` | `null` (5xx, guard paso 1) |
| `Agent foo returned 400: Bad Request` (no JSON, sin "required") | `null` |
| `Agent foo invokeUrl blocked by SSRF guard (link-local)` | `null` (sin status 4xx → guard paso 1) |
| `Agent foo returned 422: {"error":"invalid_input","details":{"fieldErrors":{}}}` | `null` (fieldErrors vacío, 0 keys) |

> Nota truncado-300: si el body se truncó a 300 chars y partió el JSON a la mitad, `JSON.parse` falla → cae a texto libre; si tampoco hay pattern → `null` (degrada seguro, no retry). Aceptable: el 99% de los field-error bodies reales caben en 300 chars.

### 3.2 `src/services/llm/input-retry.ts` — helper LLM

**Firma**:
```
export async function regenerateInputFromErrors(
  failedInput: Record<string, unknown>,
  missingFields: string[],
  agentSlug: string,
  agentDescription?: string,
): Promise<Record<string, unknown> | null>
```

**Contrato**:
- Devuelve un objeto input corregido, o `null` cuando NO se debe reintentar:
  - `ANTHROPIC_API_KEY` ausente (`getAnthropicClient()` → null).
  - `missingFields` vacío (defensivo; el caller no debería llamarlo así).
  - circuit-breaker `open` (`CircuitOpenError`).
  - timeout / error de API.
  - el LLM devuelve algo que NO es un objeto JSON (no-JSON, array, primitivo, vacío).
- **Nunca throw hacia compose** (todo error → `null`). Esto es lo que garantiza CD-7 (degradación silenciosa).

**Patrón interno** (espejo `transform.ts` / `orchestrate.ts`):
- Constante de módulo `const MODEL = 'claude-haiku-4-5-20251001'` (DT-3) y `const TIMEOUT_MS = 30_000`.
- `getAnthropicClient()` singleton lazy (copia de `orchestrate.ts:56-64`).
- `AbortController` + `setTimeout(abort, TIMEOUT_MS)` + `clearTimeout` en `finally`.
- `anthropicCircuitBreaker.execute(() => client.messages.create({model:MODEL, max_tokens:1024, system, messages:[{role:'user',content:userPrompt}]}, {signal}))` (DT-7).
- Extracción de texto idéntica a transform: `.content.filter(b=>b.type==='text').map(...).join('').trim()`.
- `JSON.parse(text)`; validar `typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)`; si no → `null`.
- `catch (CircuitOpenError | any) → return null`.

**System prompt EXACTO** (resuelve Missing #2 — el agente NO tiene schema en este path, por eso solo se pasan input + nombres de campo):
```
You fix failed JSON inputs for an autonomous agent. Given a JSON input object that was
rejected and the list of field names the agent requires, return a corrected JSON input
that (a) keeps every existing key/value from the original input, and (b) adds the missing
fields with plausible values inferred from the field names (e.g. an email-like field gets
an email, an amount/price field gets a number, an id/uuid field gets a uuid-like string,
a name field gets a name, a country/iso field gets a country code). Do NOT invent fields
that were not requested. Return ONLY the JSON object, no markdown, no prose.
```

**User prompt EXACTO**:
```
Agent: <agentSlug><if agentDescription: "\nWhat it does: <agentDescription>">
Failed input (JSON):
<JSON.stringify(failedInput, null, 2)>
Required field names the agent is missing or rejected:
<missingFields.join(', ')>
Return ONLY the corrected JSON input object.
```
(`agentDescription` se incluye sólo si está presente; el caller en compose lo toma de `agent.description`, que es siempre string en `Agent`.)

> CD-LEAK: el log `[compose.retry]` y cualquier `console.*` del helper NO deben loguear `failedInput` crudo (puede traer PII). Solo `agentSlug` + `missingFields` (nombres) + status. Mismo principio que `transform.ts:444` (CD-14 histórico).

### 3.3 Wire en `compose.ts` — orden DT-5 (CORE / money-path)

Imports nuevos en `compose.ts` (top del archivo):
```ts
import { parseFieldErrors } from '../lib/field-error-parser.js';
import { regenerateInputFromErrors } from './llm/input-retry.js';
```

**Snippet de referencia del catch reescrito** (NO es código de producción — es el contrato de orden que el Dev debe respetar; el Dev decide la forma exacta inline vs helper `tryAdaptiveRetry`, mientras el ORDEN sea este):

```ts
} catch (err) {
  // (telemetría del primer intento fallido — sin cambios, + flag retry_attempted
  //  si vamos a reintentar; ver DT-8)
  const firstError = err instanceof Error ? err.message : String(err);

  // ── PASO 1 (DT-5.1): refund del PRIMER débito — IDÉNTICO a hoy (WKH-128/129).
  //    Se ejecuta SIEMPRE que stepDebitedUsd>0 y path master. Tras esto NO hay
  //    ningún débito activo para este step (invariante CD-1).
  const isMasterPath =
    stepDebitedUsd > 0 && scopingKeyRow && chainId !== undefined &&
    !request.delegationContext && !request.keySessionContext;
  if (isMasterPath) {
    const destination = normalizeDestination(`${agent.registry}/${agent.slug}`);
    /* ...creditWithDest|credit EXACTAMENTE como compose.ts:349-374... */
  }

  // ── PASO 2 (DT-5.2/CD-3): ¿se puede reintentar?
  //    Sólo path master (CD-6), sólo si parseFieldErrors devuelve campos (CD-3),
  //    sólo una vez (CD-2: este catch corre una vez por step; no hay loop interno
  //    de retry → el max-1 es estructural).
  const missingFields = isMasterPath ? parseFieldErrors(firstError) : null;
  if (missingFields && missingFields.length > 0) {
    // ── PASO 3 (DT-5.3): regenerar input via LLM (Haiku). null = no retry (CD-7).
    const newInput = await regenerateInputFromErrors(
      input, missingFields, agent.slug, agent.description,
    );
    if (newInput) {
      // ── PASO 4 (DT-5.4): RE-DEBIT (misma firma/monto/destination que el original).
      //    En este punto el primer débito YA fue reembolsado (PASO 1) → un solo
      //    débito activo a la vez (CD-1).
      const retryDebit = await budgetService.debit(
        scopingKeyRow.id, chainId, stepDebitedUsd,
        request.delegationContext,   // siempre undefined acá (path master)
        request.keySessionContext,   // idem
        normalizeDestination(`${agent.registry}/${agent.slug}`), // CD-8
      );
      if (retryDebit.success) {
        try {
          // ── PASO 5 (DT-5.5): RE-INVOKE reusando invokeAgent (NO duplicar fetch).
          const startRetry = Date.now();
          const { output, txHash, downstream } =
            await this.invokeAgent(agent, newInput, a2aKey);
          // ── PASO 6a: 2xx → éxito. El retry-debit SE QUEDA (caller pagó 1 vez).
          //    push StepResult, totalCost += agent.priceUsdc, lastOutput = output,
          //    correr el bridge/maybeTransform igual que el happy-path,
          //    emitir compose_step success con metadata.retried=true (DT-8),
          //    y CONTINUAR el pipeline (no return; el loop sigue con i+1).
          //    → break del catch hacia el flujo normal del happy-path.
        } catch (retryErr) {
          const retryError = retryErr instanceof Error ? retryErr.message : String(retryErr);
          // ── PASO 6b (CD-5): retry falló → reembolsar el RETRY débito (best-effort,
          //    mismo creditWithDest|credit). NO re-reintentar (CD-2).
          /* ...refund del retryDebit, idéntico patrón... */
          console.error('[compose.retry]', { step: i, agent: agent.slug, status: 'failed', firstError, retryError });
          // emitir compose_step failed con metadata.retry_failed=true (DT-8)
          return {
            success: false, output: null, steps: results,
            totalCostUsdc: totalCost, totalLatencyMs: totalLatency,
            error: `Step ${i} failed after retry: ${firstError} | retry: ${retryError}`,
          };
        }
      }
      // retryDebit.success === false → no se invocó nada, no hay débito que reembolsar
      // (el debit falló) → caer al return de error normal de abajo.
    }
  }

  // ── PASO 0 (default): comportamiento ACTUAL (refund ya hecho en PASO 1) → return error.
  console.error('[compose.retry]', { step: i, agent: agent.slug, status: 'no-retry', firstError });
  return {
    success: false, output: null, steps: results,
    totalCostUsdc: totalCost, totalLatencyMs: totalLatency,
    error: `Step ${i} failed: ${firstError}`,
  };
}
```

**Puntos críticos de la integración** (el Dev DEBE cumplir):
- **PASO 1 antes que PASO 4 — INVARIANTE CD-1**. El refund del primer débito es incondicional para path master (ya existe). El re-debit ocurre estrictamente después. En ningún punto coexisten dos débitos.
- **CD-2 estructural**: el catch corre **una vez por step**. El retry NO está dentro de un loop. El re-invoke fallido hace `return` (no vuelve a entrar). Implementar igual un `let` flag defensivo NO es necesario porque no hay loop, pero el snippet evita cualquier construcción que pueda re-disparar `tryAdaptiveRetry`.
- **PASO 6a NO debe duplicar la lógica del happy-path** (push result, totalCost, lastOutput, bridge/maybeTransform, evento success). El Dev debe **refactorizar** para compartir esa cola con el try original (extraer un helper `finishSuccessfulStep(...)` o reordenar) en lugar de copiar-pegar. Esto evita drift entre los dos paths de éxito.
- **`agent.priceUsdc`** es el costo que se suma a `totalCost` en éxito (igual que happy-path:224), independientemente de que el débito interno fuera `stepDebitedUsd` (fallback 1.0 si priceUsdc inválido — ver compose.ts:150-154). El retry-debit usa `stepDebitedUsd` (el MISMO monto que el débito original) — NO recalcula.
- **`request.delegationContext`/`keySessionContext` son `undefined` en el path master** (el guard `isMasterPath` lo garantiza) → el re-debit nunca enruta a RPC de delegación/sesión. CD-6.

---

## 4. Constraint Directives (CD-N) — heredados + nuevos

Heredo **CD-1..CD-8 del work-item** sin cambios. Agrego del SDD:

- **CD-9 (NO-DUPLICAR-COLA-DE-ÉXITO)**: PROHIBIDO copiar-pegar el bloque de éxito (push StepResult + totalCost + lastOutput + bridge/maybeTransform + evento) en el path del retry-ok. Compartir vía helper/reorden. Evita drift entre los dos paths de éxito.
- **CD-10 (PARSER-PURO-SIN-THROW)**: `parseFieldErrors` NO puede lanzar para ningún input (string vacío, no-JSON, JSON truncado). Cualquier excepción interna → `null`. Debe filtrar 5xx por el status del mensaje (no inventar campos de un 5xx).
- **CD-11 (HELPER-LLM-SIN-THROW)**: `regenerateInputFromErrors` NO propaga excepciones a compose. `CircuitOpenError`, timeout, API error, no-JSON → `null`.
- **CD-12 (NO-LEAK-INPUT)**: PROHIBIDO loguear `failedInput`/`newInput` crudos (PII). Logs solo con `agentSlug`, `missingFields` (nombres), status, errores. Espejo CD-14 de `transform.ts`.
- **CD-13 (TEST-INVARIANTE-TOTAL, del auto-blindaje WKH-127)**: los tests de money-path DEBEN aseverar el **invariante neto** (Σ débitos − Σ refunds) contra el costo real, NO solo conteos por capa. retry-ok ⇒ neto = `stepDebitedUsd` (1 cobro). retry-fail ⇒ neto = 0 (2 débitos + 2 refunds). Verificar **orden** de calls (refund-primer-débito ANTES de retry-debit) vía `mock.invocationCallOrder` o secuencia de `mock.calls`.
- **CD-14 (REVISAR-TESTS-FUERA-DE-SCOPE, del auto-blindaje WKH-127)**: tras tocar el catch de compose, correr `grep -rn "toHaveBeenCalledTimes\|mockDebit\|mockCreditWithDest" src/services/*.test.ts` y verificar `orchestrate.billing.test.ts` + `compose.chain-flow.test.ts` (ejercitan COMPOSE REAL con fetch mockeado). Ningún test existente debe romper: el retry NO se dispara en sus fixtures actuales (fetch 502/200 sin field-errors 4xx parseables) → conteos invariantes. Si alguno rompe, es señal de que el retry se disparó donde no debía (regresión CD-3).

---

## 5. Waves de implementación

| Wave | Contenido | Archivos | Serial/Paralelo | Risk |
|---|---|---|---|---|
| **W1** | `parseFieldErrors` (función pura, zero deps) + tests unitarios | `src/lib/field-error-parser.ts` (nuevo), `src/lib/field-error-parser.test.ts` (nuevo) | Serial (contrato base) | LOW |
| **W2** | `regenerateInputFromErrors` (helper LLM, mock Anthropic) + tests unitarios | `src/services/llm/input-retry.ts` (nuevo), `src/services/llm/input-retry.test.ts` (nuevo) | Paralelo a W1 | LOW |
| **W3** | Wire del retry en el catch (orden DT-5), refactor cola-de-éxito (CD-9), guards CD-2/3/6/8 | `src/services/compose.ts` (mod) | Serial (depende de W1+W2) | **HIGH (money-path)** |
| **W4** | Tests de integración de compose (≥1/AC) + regresión invariante (CD-13) + verificación tests fuera de scope (CD-14) | `src/services/compose.test.ts` (mod: helper `mockFetchError(status, body?)`, nuevos `it(...)`) | Serial (depende de W3) | **HIGH** |

W0 no aplica (no hay tipos/contratos compartidos nuevos más allá de las firmas, ya fijadas en §3).

---

## 6. Exemplars verificados (paths reales confirmados con Read)

| Exemplar | Path:línea | Qué copiar |
|---|---|---|
| Anthropic singleton lazy | `src/services/orchestrate.ts:55-64` | `getAnthropicClient()` para `input-retry.ts` |
| Circuit-breaker + timeout + create | `src/services/orchestrate.ts:122-136` | estructura de la llamada LLM |
| Extracción de texto + JSON.parse | `src/services/llm/transform.ts:160-186` | parseo robusto de la respuesta |
| Constante de modelo Haiku | `src/services/llm/select-model.ts:14,38` | literal `'claude-haiku-4-5-20251001'` |
| Refund per-step (4 ramas) | `src/services/compose.ts:339-375` | patrón exacto del refund del retry-debit |
| Débito per-step (6-arg + destination) | `src/services/compose.ts:168-194` | firma del re-debit |
| Cola de éxito del step | `src/services/compose.ts:210-318` | lo que el retry-ok debe compartir (CD-9) |
| Mocks + helpers de test | `src/services/compose.test.ts:13-64,98-135,126-135` | `mockFetchError`, `mockAgentsBySlug`, `makeKeyRow`, `vi.mocked` |
| Test de refund existente | `src/services/compose.test.ts:1190-1256` | modelo de los tests de retry |

Todos los paths confirmados existentes (Read directo). **No se inventó ningún path.**

---

## 7. Plan de tests (≥1 por AC — 9 ACs)

> Unit tests del parser y del helper LLM en sus propios archivos; tests de integración en `compose.test.ts`.
> Para los tests de compose se extiende el helper a `mockFetchError(status, body?)` (default body actual para no romper los existentes). Field-error body se pasa explícito en los tests de retry.

| ID | Cubre | Archivo | Aserción clave |
|---|---|---|---|
| **T-PARSE-1** | parser shape Zod | `field-error-parser.test.ts` | `parseFieldErrors('...returned 422: {"details":{"fieldErrors":{"uuidCfdi":["Required"]}}}') === ['uuidCfdi']` |
| **T-PARSE-2** | parser texto libre (multi) | idem | `'...400: {"error":"senderName, amountUSD required"}' → ['senderName','amountUSD']` |
| **T-PARSE-3** | parser texto libre (`message`/field X) | idem | `'...422: {"message":"field walletAddress is required"}' → ['walletAddress']` |
| **T-PARSE-4** | parser null (4xx sin campos, 5xx, no-JSON, SSRF, fieldErrors vacío) | idem | cada caso → `null` |
| **T-LLM-1** | helper devuelve objeto corregido (mock Anthropic 2xx) | `input-retry.test.ts` | retorna `Record` con los missingFields |
| **T-LLM-2** | helper `null` si no-JSON / array / primitivo | idem | `null` |
| **T-LLM-3** | helper `null` si `ANTHROPIC_API_KEY` ausente | idem | sin key → `null`, 0 llamadas al SDK |
| **T-LLM-4** | helper `null` si circuit-breaker open / timeout | idem | `CircuitOpenError` → `null`, no throw |
| **AC-5 / T-RETRY-HAPPY** | path feliz: 0 LLM calls, 0 overhead | `compose.test.ts` | spy de `regenerateInputFromErrors` `not.toHaveBeenCalled()` en pipeline 2xx |
| **AC-1 / T-RETRY-OK** | retry exitoso: cobra 1 vez (el retry) | idem | fetch 422+fieldErrors → LLM ok → fetch 200. `success:true`, `mockDebit` 2 calls, `creditWithDest` 1 call (refund del 1º), **neto = stepDebitedUsd** (CD-13) |
| **AC-6 / T-RETRY-ORDER** | anti-doble-cobro (orden) | idem | `mock.invocationCallOrder`: debit#1 < refund#1 < debit#2 (retry). Nunca 2 débitos sin refund intermedio |
| **AC-2 / T-RETRY-FAIL** | retry falla: 2 refunds, neto 0 | idem | fetch 422+fieldErrors → LLM ok → fetch 500. `success:false`, error contiene firstError+retryError, `mockDebit` 2, `creditWithDest` 2, **neto 0** (CD-13) |
| **AC-3 / T-5XX-NO-RETRY** | 5xx no reintenta | idem | fetch 500 (primer intento) → 0 LLM calls, 1 refund (existente), `success:false` |
| **AC-4 / T-4XX-NOFIELDS** | 4xx sin field-errors no reintenta | idem | fetch 400 body `Bad Request` → 0 LLM calls, comportamiento WKH-128/129 idéntico |
| **AC-7 / T-MAX-1** | max-1-retry: 2º 4xx no dispara 3º | idem | fetch 422+fields → LLM ok → fetch 422+fields (retry). 1 sola LLM call, 1 sola re-invoke, `success:false` |
| **AC-8 / T-NON-4XX** | error no-HTTP no entra al retry | idem | invokeAgent lanza SSRF/network error (sin `returned <4xx>`) → 0 LLM calls, refund existente |
| **AC-9 / T-OBS** | telemetría: flags + log | idem | `eventService.track` recibe `metadata.retried:true` (ok) o `retry_failed:true` (fail); spy de console assert `[compose.retry]` |
| **CD-6 / T-DELEG-NO-RETRY** | delegación/sesión no reintenta | idem | con `delegationContext` o `keySessionContext` + fetch 422+fields → 0 LLM calls, comportamiento WKH-128/129 (sin refund bajo delegación) |
| **CD-14 / regresión** | tests existentes no rompen | `orchestrate.billing.test.ts`, `compose.chain-flow.test.ts` | correr suite completa; conteos de debit invariantes (el retry no se dispara en sus fixtures) |

Cobertura: AC-1✓ AC-2✓ AC-3✓ AC-4✓ AC-5✓ AC-6✓ AC-7✓ AC-8✓ AC-9✓ + CDs.

---

## 8. Readiness Check

- [x] Work-item leído completo (Scope IN/OUT, 9 ACs, DT-1..7, CD-1..8, Missing #1/2/3).
- [x] `project-context.md` leído — stack confirmado (Fastify, Anthropic SDK, vitest, ESM `.js`, TS strict no-`any`).
- [x] Todos los exemplars verificados con Read (paths reales §6). 0 paths inventados.
- [x] Firma real de `invokeAgent`, `debit`, `credit`, `creditWithDest`, `anthropicCircuitBreaker`, `CircuitOpenError`, `selectModel`/`PricedModel` confirmadas en código.
- [x] Orden DT-5 anti-doble-cobro especificado con snippet de referencia (§3.3) — refund#1 → parse → guards → regenerate → re-debit → re-invoke → (ok: keep / fail: refund retry).
- [x] **Missing #1 RESUELTO** (DT-3): Haiku hardcoded, no `selectModel`.
- [x] **Missing #2 RESUELTO** (§3.2): system + user prompt exactos, sin schema (input + nombres de campo).
- [x] **Missing #3 RESUELTO** (DT-8): emitir ambos eventos con flags `retry_attempted`/`retried`/`retry_failed`. NO hay SLA que requiera ocultar el 1er fallo.
- [x] Auto-blindaje histórico revisado (WKH-127, SSRF-04): patrones recurrentes de money-path incorporados como **CD-13** (invariante total) y **CD-14** (tests fuera de scope).
- [x] Test plan ≥1 por AC (9/9) + unit parser + unit helper + regresión.
- [x] CDs heredados (1-8) + nuevos (9-14).
- [x] **0 `[NEEDS CLARIFICATION]`**.

**SDD listo para SPEC_APPROVED.**
