# Story File — [WKH-130] Adaptive Input-Retry

> Fase F2.5. Contrato autocontenido para el Dev (F3). Derivado de `sdd.md` (SPEC_APPROVED).
> **Leé SOLO este archivo.** Todo lo que necesitás para implementar está acá. No releas el SDD.
> Stack: Fastify · `@anthropic-ai/sdk` · vitest · ESM (imports con `.js`) · TS strict (sin `any` explícito).

---

## 0. Contexto compacto (qué se construye y por qué)

Cuando un step de `/compose` (incluido el path `/orchestrate → compose`) falla con un **4xx cuyo
body trae field-errors parseables** del agente externo, el sistema **regenera el input via LLM**
(Haiku) usando esos errores como contexto y **reintenta UNA sola vez**.

- Retry **exitoso** (2xx) → el step se reporta exitoso, se cobra **solo el débito del retry** (el del
  primer intento ya fue reembolsado), y el pipeline continúa.
- Retry **fallido** (cualquier error) → se reembolsa el débito del retry, y se devuelve
  `ComposeResult.success=false` con un error que cita el error original + el del retry.
- **5xx**, **4xx sin field-errors**, errores de red/SSRF/settle, **delegación/sesión** → **NO retry**,
  comportamiento idéntico a hoy (WKH-128/129: refund + error).
- **Path feliz (2xx a la primera)** → **0 llamadas LLM, 0 overhead**. El retry vive SOLO en el `catch`.

El punto neurálgico es **anti-doble-cobro**: en ningún instante coexisten dos débitos del mismo step.

---

## 1. Scope IN (archivos exactos a tocar)

| Archivo | Acción | Wave |
|---|---|---|
| `src/lib/field-error-parser.ts` | **NUEVO** — función pura `parseFieldErrors` | W1 |
| `src/lib/field-error-parser.test.ts` | **NUEVO** — unit tests del parser | W1 |
| `src/services/llm/input-retry.ts` | **NUEVO** — helper LLM `regenerateInputFromErrors` | W2 |
| `src/services/llm/input-retry.test.ts` | **NUEVO** — unit tests del helper (mock Anthropic) | W2 |
| `src/services/compose.ts` | **MOD** — wire del retry en el catch (orden DT-5) + refactor cola-de-éxito | W3 |
| `src/services/compose.test.ts` | **MOD** — extender `mockFetchError(status, body?)` + nuevos `it(...)` | W4 |

**PROHIBIDO tocar cualquier otro archivo.** En particular: NO `src/services/orchestrate.ts`, NO
`src/routes/*`, NO el path con `input_schema` declarado del agente, NO `transform.ts`.

---

## 2. Anti-Hallucination Checklist (verificá ANTES de codear cada wave)

Firmas / hechos confirmados con Read en el código real (no inventar variaciones):

- [ ] **Firma parser** (W1, exacta):
      `export function parseFieldErrors(errorMessage: string): string[] | null`
      Función **pura**: sin I/O, **sin throw para ningún input** (cualquier excepción interna → `null`).
- [ ] **Firma helper LLM** (W2, exacta):
      ```ts
      export async function regenerateInputFromErrors(
        failedInput: Record<string, unknown>,
        missingFields: string[],
        agentSlug: string,
        agentDescription?: string,
      ): Promise<Record<string, unknown> | null>
      ```
- [ ] **Modelo Haiku HARDCODED**: `const MODEL = 'claude-haiku-4-5-20251001'`. **NO** invocar `selectModel`
      (en este path el agente no tiene `input_schema`; `selectModel` lee un schema que no existe acá).
- [ ] **Helpers NUNCA throw hacia compose**: todo error (`CircuitOpenError`, timeout, API error, no-JSON,
      array/primitivo, `ANTHROPIC_API_KEY` ausente, `missingFields` vacío) → `return null`.
- [ ] **Re-debit usa `stepDebitedUsd`** (el MISMO monto que el débito original; **NO recalcula**
      `agent.priceUsdc` ni vuelve a aplicar el fallback 1.0) y pasa **destination** (CD-8).
- [ ] **Orden DT-5 inviolable** (ver §5 W3): refund#1 → parse → guards(master+circuit) → regenerate →
      re-debit → re-invoke → (ok: keep+continúa / fail: refund-retry + return error). **refund#1 SIEMPRE
      antes del re-debit** (CD-1).
- [ ] **Retry SOLO en path master con 4xx-con-field-errors-parseables.** Guard
      `isMasterPath = stepDebitedUsd>0 && scopingKeyRow && chainId!==undefined && !request.delegationContext && !request.keySessionContext`.
- [ ] **`invokeAgent` se REUSA** (no duplicar `fetch`). Firma real:
      `invokeAgent(agent, input, a2aKey?, logger?): Promise<{ output: unknown; txHash?: string; downstream?: DownstreamResult }>`.
- [ ] **El status + body del 4xx viajan en `Error.message`**, formato exacto:
      `` `Agent ${agent.slug} returned ${response.status}${detail ? `: ${detail}` : ''}` `` (compose.ts:517-519,
      con `detail` = body truncado a 300 chars). Es la **única** fuente del parser.
- [ ] **Firmas billing** (budget.ts, confirmadas):
      `debit(keyId, chainId, amountUsd, delegationCtx?, sessionCtx?, destination?)`,
      `credit(keyId, chainId, amountUsd, ownerRef)`,
      `creditWithDest(keyId, chainId, amountUsd, ownerRef, destination)`. Todas `Promise<{success, error?}>`.
- [ ] **`normalizeDestination(\`${agent.registry}/${agent.slug}\`)`** es el origen canónico de la destination
      (igual que el débito en compose.ts:174 y el refund en compose.ts:349-351).
- [ ] **No loguear `failedInput`/`newInput` crudos** (PII, CD-12). Logs solo con `agentSlug`,
      `missingFields` (nombres), status, errores.

---

## 3. Constraint Directives operativos (los 14 — qué chequear por wave)

Heredados del work-item (CD-1..CD-8) + nuevos del SDD (CD-9..CD-14):

| CD | Regla | Wave |
|---|---|---|
| **CD-1** | ANTI-DOBLE-COBRO (BLOQUEANTE): nunca dos débitos activos. refund#1 ANTES del re-debit. | W3 |
| **CD-2** | MAX-1-RETRY (BLOQUEANTE): un solo retry por step. Estructural: el catch corre 1 vez/step, el retry NO está en loop, el re-invoke fallido hace `return`. | W3, W4 |
| **CD-3** | SOLO-4xx-CON-FIELD-ERRORS: PROHIBIDO retry en red/SSRF/settle/5xx/4xx-sin-fields. Entrada estricta. | W1, W3, W4 |
| **CD-4** | NO-ROMPER-HAPPY-PATH: 0 overhead en 2xx. El retry vive exclusivamente en el `catch`. | W3, W4 |
| **CD-5** | REFUND-SI-RETRY-FALLA: reembolsar el retry-debit si el retry falla (best-effort; un fallo del credit NO cambia el error reportado). | W3, W4 |
| **CD-6** | SOLO-PATH-MASTER: retry solo si `!delegationContext && !keySessionContext`. Mismo guard que el refund actual (compose.ts:339-345). | W3, W4 |
| **CD-7** | NO-RETRY-SIN-LLM: sin `ANTHROPIC_API_KEY` o circuit-breaker open → degradar silencioso (refund + error). | W2, W3 |
| **CD-8** | OWNERSHIP-GUARD / destination: el re-debit pasa destination igual que el débito original (compose.ts:174). | W3 |
| **CD-9** | NO-DUPLICAR-COLA-DE-ÉXITO: PROHIBIDO copiar-pegar el bloque de éxito (push StepResult + totalCost + lastOutput + bridge/maybeTransform + evento success). Compartir vía helper/reorden con el happy-path. | W3 |
| **CD-10** | PARSER-PURO-SIN-THROW: `parseFieldErrors` no lanza para NINGÚN input (vacío, no-JSON, JSON truncado). Filtra 5xx por el status del mensaje. | W1 |
| **CD-11** | HELPER-LLM-SIN-THROW: `regenerateInputFromErrors` no propaga excepciones a compose → `null`. | W2 |
| **CD-12** | NO-LEAK-INPUT: no loguear `failedInput`/`newInput` crudos (PII). | W2, W3 |
| **CD-13** | TEST-INVARIANTE-TOTAL: los tests money-path aseveran el invariante neto (Σdébitos − Σrefunds), NO solo conteos por capa. retry-ok ⇒ neto = `stepDebitedUsd`; retry-fail ⇒ neto = 0. Verificar **orden** vía `mock.invocationCallOrder`. | W4 |
| **CD-14** | REVISAR-TESTS-FUERA-DE-SCOPE: tras tocar el catch, `orchestrate.billing.test.ts` + `compose.chain-flow.test.ts` NO deben romper (el retry no se dispara en sus fixtures). | W4 |

---

## 4. Patrones a seguir (exemplars verificados — paths reales)

| Para | Copiá de | Qué |
|---|---|---|
| Singleton Anthropic lazy (W2) | `src/services/orchestrate.ts:55-64` | `getAnthropicClient()` (apiKey de env, `null` si falta) |
| Llamada LLM (timeout + breaker + create) (W2) | `src/services/orchestrate.ts:122-136` | `AbortController` + `setTimeout(abort, TIMEOUT)` + `anthropicCircuitBreaker.execute(() => client.messages.create({...}, {signal}))` |
| Extracción texto + JSON.parse (W2) | `src/services/llm/transform.ts:170-176` | `.content.filter(b=>b.type==='text').map(b=>(b as {type:'text';text:string}).text).join('').trim()` → `JSON.parse(text)` |
| Imports breaker (W2) | `src/services/orchestrate.ts:9-12` | `import { anthropicCircuitBreaker, CircuitOpenError } from '../lib/circuit-breaker.js'` (desde `llm/`: `'../../lib/circuit-breaker.js'`) |
| Refund per-step (4 ramas) (W3) | `src/services/compose.ts:349-375` | patrón exacto del refund del retry-debit |
| Débito per-step (6-arg + destination) (W3) | `src/services/compose.ts:168-194` | firma del re-debit |
| Cola de éxito del step (W3) | `src/services/compose.ts:210-318` | lo que el retry-ok debe COMPARTIR (CD-9), no copiar |
| Mocks + helpers de test (W4) | `src/services/compose.test.ts:14-64,126-158` | `mockFetchOk`, `mockFetchError`, `makeAgent`, `makeRegistry`, `makeKeyRow`, `vi.mocked` |

---

## 5. Waves

> Orden: W1 y W2 son independientes (pueden ir en paralelo). W3 depende de W1+W2. W4 depende de W3.

---

### W1 — `parseFieldErrors` (función pura, zero deps) · Risk LOW

**Archivos:** `src/lib/field-error-parser.ts` (nuevo), `src/lib/field-error-parser.test.ts` (nuevo).

**Firma:** `export function parseFieldErrors(errorMessage: string): string[] | null`

**Contrato:**
- Input: el `Error.message` crudo del catch, formato `"Agent <slug> returned <status>: <body_truncado_300>"`.
- Output: `string[]` con ≥1 nombre de campo faltante/inválido, o `null` si nada parseable.
- **Pura**: sin I/O, **sin throw** (cualquier excepción interna → `null`). (CD-10)

**Algoritmo (cascada):**
1. **Guard de status**: extraer el status con regex `/returned (\d{3})/`. Si no es 4xx
   (`status < 400 || status >= 500`) → `return null`. (No inventar campos de un 5xx.)
2. **Extraer el JSON del body**: tomar la subcadena desde el **primer `{`** hasta el **último `}`** del
   mensaje. Si no hay `{...}` → ir al paso 4 (texto libre). `JSON.parse` en try/catch; si falla → paso 4.
3. **Shape Zod (`details.fieldErrors`)**: si `parsed.details?.fieldErrors` es un objeto →
   `Object.keys(fieldErrors)` **filtrando los que tienen al menos un mensaje** (array no vacío). Si ≥1 →
   `return keys`.
4. **Shape texto libre**: tomar el string de `parsed.error ?? parsed.message ?? <el body crudo>`. Patrones:
   - `"a, b, c required"` / `"a, b required"` → split por `,`/`and`, quedarse con tokens que **preceden** a `required`.
   - `"field X is required"` / `"X is required"` / `"missing field X"` → capturar `X`.
   - Normalizar: `trim`, descartar tokens vacíos o no-identificadores (solo `[A-Za-z0-9_]+`).
   - Si ≥1 token → `return tokens`. Si 0 → `return null`.
5. Cualquier path que no produzca ≥1 campo → `return null`.

**Tabla input → output (los 8 casos — son los fixtures de los tests):**

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

> Nota truncado-300: si el body se truncó a 300 chars y partió el JSON, `JSON.parse` falla → cae a texto
> libre; si tampoco hay pattern → `null` (degrada seguro, no retry).

**Done de W1:** los tests T-PARSE-1..4 (§6) pasan, cubriendo los 8 casos de la tabla.

---

### W2 — `regenerateInputFromErrors` (helper LLM) · Risk LOW

**Archivos:** `src/services/llm/input-retry.ts` (nuevo), `src/services/llm/input-retry.test.ts` (nuevo).

**Firma EXACTA:**
```ts
export async function regenerateInputFromErrors(
  failedInput: Record<string, unknown>,
  missingFields: string[],
  agentSlug: string,
  agentDescription?: string,
): Promise<Record<string, unknown> | null>
```

**Contrato — devolver `null` (sin throw, CD-11) cuando:**
- `ANTHROPIC_API_KEY` ausente (`getAnthropicClient()` → `null`).
- `missingFields` vacío (defensivo).
- circuit-breaker `open` (`CircuitOpenError`).
- timeout / error de API.
- el LLM devuelve algo que NO es un objeto JSON (no-JSON, array, primitivo, vacío).

**Patrón interno (espejo `orchestrate.ts` / `transform.ts`):**
- Constantes de módulo: `const MODEL = 'claude-haiku-4-5-20251001'` (DT-3, **hardcoded, no `selectModel`**)
  y `const TIMEOUT_MS = 30_000`.
- `getAnthropicClient()` singleton lazy — **copia exacta** de `orchestrate.ts:56-64` (apiKey de env,
  `null` si falta). Al inicio: `const client = getAnthropicClient(); if (!client) return null;`.
- Defensivo: `if (missingFields.length === 0) return null;`.
- `const controller = new AbortController();` + `const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);`
  y `clearTimeout(timeoutId)` en `finally`.
- La llamada va envuelta en `anthropicCircuitBreaker.execute(() => client.messages.create({ model: MODEL, max_tokens: 1024, system, messages: [{ role: 'user', content: userPrompt }] }, { signal: controller.signal }))` (DT-7).
- Extracción de texto idéntica a transform:
  `.content.filter((b) => b.type === 'text').map((b) => (b as { type: 'text'; text: string }).text).join('').trim()`.
- `const parsed = JSON.parse(text);` y validar
  `typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)`; si no → `null`.
- Envolver TODO en `try { ... } catch { return null; }` (captura `CircuitOpenError`, timeout, parse, API).

**System prompt EXACTO** (copiá literal — el agente NO tiene schema en este path, por eso solo input + nombres):
```
You fix failed JSON inputs for an autonomous agent. Given a JSON input object that was
rejected and the list of field names the agent requires, return a corrected JSON input
that (a) keeps every existing key/value from the original input, and (b) adds the missing
fields with plausible values inferred from the field names (e.g. an email-like field gets
an email, an amount/price field gets a number, an id/uuid field gets a uuid-like string,
a name field gets a name, a country/iso field gets a country code). Do NOT invent fields
that were not requested. Return ONLY the JSON object, no markdown, no prose.
```

**User prompt EXACTO** (`agentDescription` incluido SOLO si está presente):
```
Agent: <agentSlug><if agentDescription: "\nWhat it does: <agentDescription>">
Failed input (JSON):
<JSON.stringify(failedInput, null, 2)>
Required field names the agent is missing or rejected:
<missingFields.join(', ')>
Return ONLY the corrected JSON input object.
```

**CD-12 (no-leak):** cualquier `console.*`/log del helper loguea SOLO `agentSlug` + `missingFields` (nombres)
+ status. NUNCA `failedInput` ni `newInput` crudos.

**Done de W2:** los tests T-LLM-1..4 (§6) pasan (objeto corregido / no-JSON→null / sin key→null / circuit/timeout→null).

---

### W3 — Wire del retry en el catch (orden DT-5) · Risk HIGH (money-path) · **CORE**

**Archivo:** `src/services/compose.ts` (mod).

**Imports nuevos (top del archivo):**
```ts
import { parseFieldErrors } from '../lib/field-error-parser.js';
import { regenerateInputFromErrors } from './llm/input-retry.js';
```

**Snippet de referencia del catch reescrito** (es el **contrato de ORDEN**, no código final literal; el
Dev decide la forma exacta inline vs helper interno `tryAdaptiveRetry`, **mientras el ORDEN sea este**):

```ts
} catch (err) {
  // telemetría del primer intento fallido (sin cambios respecto a compose.ts:320-333,
  // + flag metadata.retry_attempted:true si vamos a reintentar — DT-8).
  const firstError = err instanceof Error ? err.message : String(err);

  // ── PASO 1 (DT-5.1 / CD-1): refund del PRIMER débito — IDÉNTICO a hoy (compose.ts:339-375).
  //    Incondicional para path master. Tras esto NO hay débito activo para este step.
  const isMasterPath =
    stepDebitedUsd > 0 && scopingKeyRow && chainId !== undefined &&
    !request.delegationContext && !request.keySessionContext;
  if (isMasterPath) {
    const destination = normalizeDestination(`${agent.registry}/${agent.slug}`);
    /* ...creditWithDest | credit EXACTAMENTE como compose.ts:349-375... */
  }

  // ── PASO 2 (DT-5.2 / CD-3): ¿se puede reintentar?
  //    Sólo path master (CD-6), sólo si parseFieldErrors devuelve campos (CD-3),
  //    sólo una vez (CD-2: el catch corre 1 vez/step; no hay loop → max-1 estructural).
  const missingFields = isMasterPath ? parseFieldErrors(firstError) : null;
  if (missingFields && missingFields.length > 0) {
    // ── PASO 3 (DT-5.3 / CD-7): regenerar input via LLM (Haiku). null = no retry.
    const newInput = await regenerateInputFromErrors(
      input, missingFields, agent.slug, agent.description,
    );
    if (newInput) {
      // ── PASO 4 (DT-5.4 / CD-1 / CD-8): RE-DEBIT. MISMO monto stepDebitedUsd, MISMA
      //    destination. El primer débito YA fue reembolsado (PASO 1) → un solo débito activo.
      const retryDebit = await budgetService.debit(
        scopingKeyRow.id, chainId, stepDebitedUsd,
        request.delegationContext,   // undefined en path master
        request.keySessionContext,   // undefined en path master
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
          //    correr bridge/maybeTransform igual que el happy-path,
          //    emitir compose_step success con metadata.retried:true (DT-8),
          //    y CONTINUAR el pipeline (NO return; el loop sigue con i+1).
          //    ⚠️ CD-9: COMPARTIR esa cola con el happy-path (NO copiar-pegar).
        } catch (retryErr) {
          const retryError = retryErr instanceof Error ? retryErr.message : String(retryErr);
          // ── PASO 6b (CD-5): retry falló → reembolsar el RETRY débito (best-effort,
          //    mismo creditWithDest|credit). NO re-reintentar (CD-2).
          /* ...refund del retryDebit, idéntico patrón compose.ts:349-375... */
          console.error('[compose.retry]', { step: i, agent: agent.slug, status: 'failed', firstError, retryError });
          // emitir compose_step failed con metadata.retry_failed:true (DT-8)
          return {
            success: false, output: null, steps: results,
            totalCostUsdc: totalCost, totalLatencyMs: totalLatency,
            error: `Step ${i} failed after retry: ${firstError} | retry: ${retryError}`,
          };
        }
      }
      // retryDebit.success === false → nada se invocó, no hay débito que reembolsar
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

**Puntos críticos NO negociables:**

- **CD-1 — refund#1 ANTES del re-debit.** El refund del primer débito (PASO 1) es incondicional para
  path master (ya existe en compose.ts:339-375). El re-debit (PASO 4) ocurre **estrictamente después**.
  En ningún punto coexisten dos débitos activos.
- **CD-2 — max-1 estructural.** El catch corre una vez por step. El retry NO está en loop. El re-invoke
  fallido hace `return`. Evitá cualquier construcción que pueda re-disparar el retry. No hace falta un
  `let retried` porque no hay loop, pero NO introduzcas ninguna estructura que reabra el retry path.
- **CD-9 — NO duplicar la cola de éxito.** El PASO 6a (push StepResult + `totalCost += agent.priceUsdc` +
  `lastOutput = output` + bridge/maybeTransform + evento `compose_step` success) **NO se copia-pega**.
  Refactorizá: extraé un helper `finishSuccessfulStep(...)` (o reordená) que sirva tanto al happy-path
  (compose.ts:210-318) como al retry-ok. Evita drift entre los dos paths de éxito.
- **CD-8 — re-debit con destination.** El PASO 4 pasa `normalizeDestination(\`${agent.registry}/${agent.slug}\`)`
  como 6º arg (igual que el débito original compose.ts:174).
- **Monto del re-debit = `stepDebitedUsd`** (el MISMO del débito original). NO recalcular `agent.priceUsdc`
  ni reaplicar el fallback 1.0. (`agent.priceUsdc` solo se usa para `totalCost += agent.priceUsdc` en éxito,
  igual que el happy-path compose.ts:224.)
- **CD-6 — solo master.** `request.delegationContext`/`keySessionContext` son `undefined` en el path master
  (lo garantiza `isMasterPath`) → el re-debit nunca enruta a RPC de delegación/sesión.
- **DT-8 — telemetría.** Primer intento que dispara retry: `compose_step` failed + `metadata.retry_attempted:true`.
  Retry exitoso: `compose_step` success + `metadata.retried:true`. Retry fallido: `compose_step` failed +
  `metadata.retry_failed:true`. Más el log `[compose.retry]` (AC-9).

**Done de W3:** compila (TS strict, sin `any`), y los tests de integración de W4 (T-RETRY-*, T-5XX-*, etc.)
pasan. La cola de éxito está compartida, no duplicada.

---

### W4 — Tests de integración de compose + regresión · Risk HIGH

**Archivo:** `src/services/compose.test.ts` (mod).

**Paso previo — extender el helper `mockFetchError(status, body?)`** (default = comportamiento actual,
para no romper los tests existentes). Reemplazá la firma actual (compose.test.ts:133-140) por:
```ts
function mockFetchError(status: number, body = '{"error":"fail"}') {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    json: async () => JSON.parse(body),
    text: async () => body,
  });
}
```
Los tests de retry pasan el field-error body explícito; los existentes siguen llamando `mockFetchError(status)`.

> Para mockear el LLM en compose: `vi.mock('./llm/input-retry.js', () => ({ regenerateInputFromErrors: vi.fn() }))`
> y `const mockRegen = vi.mocked(regenerateInputFromErrors)`. En el happy-path NO se setea → spy con
> `not.toHaveBeenCalled()`. En retry-ok: `mockRegen.mockResolvedValueOnce({ ...fixedInput })`.

**Tests requeridos (cada uno con archivo + aserción clave):**

| ID | Cubre | Aserción clave |
|---|---|---|
| **AC-5 / T-RETRY-HAPPY** | path feliz: 0 LLM, 0 overhead | pipeline 2xx → `mockRegen` `not.toHaveBeenCalled()` |
| **AC-1 / T-RETRY-OK** | retry exitoso: cobra 1 vez | fetch 422+fieldErrors → `mockRegen` ok → fetch 200. `success:true`; `mockDebit` **2 calls**; `mockCreditWithDest` **1 call** (refund del 1º); **neto = `stepDebitedUsd`** (CD-13) |
| **AC-6 / T-RETRY-ORDER** | anti-doble-cobro (orden) | `mock.invocationCallOrder`: **debit#1 < refund#1 < debit#2** (retry). Nunca 2 débitos sin refund intermedio |
| **AC-2 / T-RETRY-FAIL** | retry falla: 2 refunds, neto 0 | fetch 422+fieldErrors → `mockRegen` ok → fetch 500. `success:false`; error contiene firstError+retryError; `mockDebit` **2**; `mockCreditWithDest` **2**; **neto = 0** (CD-13) |
| **AC-3 / T-5XX-NO-RETRY** | 5xx no reintenta | fetch 500 (primer intento) → `mockRegen` **0 calls**; 1 refund (existente); `success:false` |
| **AC-4 / T-4XX-NOFIELDS** | 4xx sin field-errors no reintenta | fetch 400 body `Bad Request` → `mockRegen` **0 calls**; comportamiento WKH-128/129 idéntico |
| **AC-7 / T-MAX-1** | max-1: 2º 4xx no dispara 3º | fetch 422+fields → `mockRegen` ok → fetch 422+fields. **1 sola** call a `mockRegen`, **1 sola** re-invoke, `success:false` |
| **AC-8 / T-NON-4XX** | error no-HTTP no entra al retry | `invokeAgent` lanza SSRF/network (sin `returned <4xx>`) → `mockRegen` **0 calls**; refund existente |
| **AC-9 / T-OBS** | telemetría: flags + log | `eventService.track` recibe `metadata.retried:true` (ok) o `retry_failed:true` (fail); spy de `console.error` assert `[compose.retry]` |
| **CD-6 / T-DELEG-NO-RETRY** | delegación/sesión no reintenta | con `delegationContext` o `keySessionContext` + fetch 422+fields → `mockRegen` **0 calls**; comportamiento WKH-128/129 (sin refund bajo delegación) |

**Invariante neto (CD-13) — cómo aseverarlo:** computá
`Σ(amounts de mockDebit.mock.calls) − Σ(amounts de mockCreditWithDest.mock.calls)` y comparalo contra el
esperado: **retry-ok ⇒ `stepDebitedUsd`**, **retry-fail ⇒ `0`**. NO te quedes solo en `toHaveBeenCalledTimes`.

**Orden (CD-13):** usá `mockDebit.mock.invocationCallOrder` y `mockCreditWithDest.mock.invocationCallOrder`
para verificar `debit#1 < refund#1 < debit#2`.

**Verificación CD-14 (regresión, fuera de scope):**
1. Corré `grep -rn "toHaveBeenCalledTimes\|mockDebit\|mockCreditWithDest" src/services/*.test.ts`.
2. Corré la suite completa: **`orchestrate.billing.test.ts`** y **`compose.chain-flow.test.ts`** NO deben romper
   (ejercitan COMPOSE REAL con fetch mockeado; sus fixtures usan 502/200 sin field-errors 4xx parseables →
   el retry no se dispara → conteos invariantes).
3. Si alguno rompe → señal de que el retry se disparó donde no debía (regresión CD-3). Arreglá el guard,
   NO el test ajeno.

**Done de W4:** los 10 tests arriba pasan + parser/helper unit (W1/W2) + suite global verde
(`orchestrate.billing.test.ts` + `compose.chain-flow.test.ts` sin cambios de conteo).

---

## 6. Tests unitarios de W1/W2 (resumen — ya detallados en sus waves)

| ID | Archivo | Aserción clave |
|---|---|---|
| **T-PARSE-1** | `field-error-parser.test.ts` | shape Zod → `['uuidCfdi','rfcEmisor']` |
| **T-PARSE-2** | idem | texto libre multi → `['senderName','amountUSD','receiverCountry']` |
| **T-PARSE-3** | idem | `message`/field X → `['walletAddress']` |
| **T-PARSE-4** | idem | 4xx-sin-campos / 5xx / no-JSON / SSRF / fieldErrors-vacío → cada uno `null` |
| **T-LLM-1** | `input-retry.test.ts` | mock Anthropic 2xx → `Record` con los missingFields |
| **T-LLM-2** | idem | no-JSON / array / primitivo → `null` |
| **T-LLM-3** | idem | sin `ANTHROPIC_API_KEY` → `null`, **0 llamadas** al SDK |
| **T-LLM-4** | idem | `CircuitOpenError` / timeout → `null`, **no throw** |

---

## 7. Done Definition (la HU está lista cuando)

- [ ] W1: `parseFieldErrors` puro, sin throw, cubre los 8 casos (T-PARSE-1..4 verdes).
- [ ] W2: `regenerateInputFromErrors` con Haiku hardcoded, singleton lazy, circuit-breaker+timeout,
      JSON.parse robusto, nunca throw→null (T-LLM-1..4 verdes). Prompts exactos. No leak de input.
- [ ] W3: catch reescrito con orden DT-5 (refund#1 → parse → guards → regenerate → re-debit → re-invoke →
      ok-keep / fail-refund). Cola de éxito **compartida** (CD-9). Re-debit con `stepDebitedUsd` + destination.
      Compila TS strict sin `any`.
- [ ] W4: 10 tests de integración verdes con invariante neto + orden (CD-13). `mockFetchError(status, body?)`
      extendido. `orchestrate.billing.test.ts` + `compose.chain-flow.test.ts` NO rompen (CD-14).
- [ ] Los 14 CDs satisfechos. 9 ACs cubiertos por ≥1 test.
- [ ] NO se tocó `orchestrate.ts`, `src/routes/*`, ni el path con `input_schema`.
