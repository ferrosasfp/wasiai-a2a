# Work Item — [WKH-130] Adaptive Input-Retry

## Resumen

Cuando un step de `/compose` (incluyendo el path `/orchestrate → compose`) falla con un 4xx cuyo body contiene field-errors parseables del agente externo, el sistema regenera el input del step via LLM usando esos errores como contexto y reintenta **una sola vez**. Si el retry resulta exitoso, el step se reporta como exitoso con costo del retry. Si el retry falla o el 4xx no trae field-errors reconocibles, el pipeline aborta con error claro y reembolsa como hoy. El path feliz (200 a la primera) no paga ningún costo extra de LLM ni latencia adicional.

## Sizing

- SDD_MODE: full
- Estimación: L
- Branch sugerido: `feat/127-wkh-130-adaptive-input-retry`
- Smart Sizing: **QUALITY** — money-path (billing del retry), lógica de LLM, parseo de errores heterogéneos, riesgo de doble cobro.

## Skills Router

- `billing-safety` — anti-doble-cobro, refund-si-retry-falla
- `llm-integration` — llamada al LLM para regenerar input desde field-errors

---

## F0 — Codebase Grounding

### Flujo actual en `compose.ts`

**Orden exacto de operaciones por step (confirmado archivo:línea):**

1. `compose.ts:140` — guard `i > 0 && scopingKeyRow && chainId` → debit per-step (fee-on-attempt **antes** de `invokeAgent`). Stores amount in `stepDebitedUsd`.
2. `compose.ts:196-199` — build `input` (`step.input` + `previousOutput` si `passOutput`).
3. `compose.ts:204-209` — `try { await this.invokeAgent(agent, input, a2aKey) }`.
4. `invokeAgent` (`compose.ts:502-519`) — `fetch(agent.invokeUrl)` → si `!response.ok`, lee body (truncado a 300 chars), lanza `new Error("Agent <slug> returned <status>: <detail>")`.
5. `compose.ts:319-383` — `catch (err)` del step: emite evento `compose_step` failed → si `stepDebitedUsd > 0` y path master (sin delegación/sesión) → **reembolsa** via `budgetService.creditWithDest` o `budgetService.credit` (`compose.ts:349-374`). Luego retorna `ComposeResult.success=false`.

**Conclusión clave sobre billing de 4xx:**
- En 4xx el agente rechaza el request **antes de procesar** → no hubo x402 downstream settle (ese ocurre en `invokeAgent` solo si `!response.ok` → no, el settle solo ocurre después del `fetch` exitoso en `compose.ts:557-566`).
- Por tanto: `charged=0` para el agente upstream en 4xx. El único débito es el `stepDebitedUsd` del debit per-step de `compose` (billing interno de wasiai-a2a), que se reembolsa en el catch.
- **El retry es un intento fresco**: debita otra vez, intenta, y si falla reembolsa otra vez. Si tiene éxito, el débito del retry se queda (el del primer intento ya fue reembolsado).

### Dónde vive hoy el input del step

- `/compose` directo: el caller proporciona `step.input` explícito en la request.
- `/orchestrate → compose`: el LLM planner genera `step.input` en `orchestrate.ts:409-413` (`a.input ?? { goal }`). Los steps que llegan a `compose.execute()` ya tienen `step.input` fijado.

**Consecuencia para el retry**: en ambos paths, el `input` que llega a `invokeAgent` ya está construido. Para regenerar el input con los field-errors, la lógica de retry necesita llamar al LLM con: (a) el input fallido, (b) el error body del agente (field-errors). Esa llamada LLM puede vivir completamente en `compose.ts` — no necesita propagarse a `orchestrate.ts`.

### Acceso al LLM desde compose

Hoy `compose.ts` solo usa LLM indirectamente via `maybeTransform` (`compose.ts:260`). El cliente Anthropic vive en `orchestrate.ts:56-63` como singleton lazy. Opciones:
- **DT-1**: extraer el cliente Anthropic a un helper reutilizable en `src/services/llm/` (e.g. `llm-client.ts` o `llm-input-fix.ts`), similar a como `select-model.ts`, `pricing.ts`, etc. son helpers del módulo LLM.
- **DT-2**: instanciar un cliente local en compose para el retry (más simple, menor acoplamiento con orchestrate).

### Shape de field-errors (heterogéneo)

El body del error llega como string en el mensaje de la excepción, formato: `"Agent <slug> returned 422: <body_truncado_300chars>"`. Dos shapes confirmados:

| Origen | Shape del body |
|--------|---------------|
| wasiai-v2 / agentes con validación Zod | `{"error":"invalid_input","details":{"fieldErrors":{"campo":["Required","..."]}}}` |
| AgentShop / agentes custom | `{"error":"X required, Y required"}` o `{"message":"field X is required"}` |

El parser debe intentar extraer campos faltantes/inválidos de ambas formas. Si no puede extraer al menos un campo concreto → no hay field-errors parseables → no retry.

### LLM transform existente como modelo

`src/services/llm/transform.ts` ya usa Anthropic SDK con timeout (`TIMEOUT_MS=30_000`), circuit-breaker (`anthropicCircuitBreaker`), y selección de modelo (`selectModel`). El nuevo helper para regenerar input puede seguir el mismo patrón.

---

## Acceptance Criteria (EARS)

- **AC-1 (retry exitoso)**: WHEN a compose step returns a 4xx with parseable field-errors AND the retry succeeds with HTTP 2xx, THEN the system SHALL report the step as successful, charge exactly the retry debit (not the first-attempt debit, which was refunded), and continue the pipeline.

- **AC-2 (retry fallido → refund completo)**: WHEN a compose step returns a 4xx with parseable field-errors AND the retry also fails (any error), THEN the system SHALL refund the retry debit (same path as WKH-128/129: `creditWithDest` or `credit`), and return `ComposeResult.success=false` with a clear error message indicating both the original error and the retry error.

- **AC-3 (5xx no-retry)**: WHEN a compose step returns a 5xx from the upstream agent, THEN the system SHALL NOT attempt a retry, SHALL refund the step debit (existing WKH-128/129 behavior), and SHALL return the error immediately.

- **AC-4 (4xx sin field-errors no-retry)**: WHEN a compose step returns a 4xx AND the error body contains no parseable field-errors (body empty, non-JSON, or no identifiable field names), THEN the system SHALL NOT attempt a retry and SHALL behave identically to the current WKH-128/129 path (refund + error).

- **AC-5 (path feliz sin costo extra)**: WHEN a compose step returns HTTP 2xx on the first attempt, THEN the system SHALL NOT call the LLM for input regeneration and SHALL add zero latency overhead for the retry path.

- **AC-6 (anti-doble-cobro)**: WHEN a compose step first-attempt debit is followed by a retry debit, THEN the system SHALL ensure that at no point both debits are outstanding simultaneously without a refund — specifically: first-attempt debit is refunded BEFORE the retry debit is applied, OR the retry debit occurs on a separate logical unit (one debit wins, never two).

- **AC-7 (max-1-retry)**: WHEN the retry attempt itself returns a 4xx with field-errors, THEN the system SHALL NOT initiate a second retry — the retry path terminates after one attempt regardless of the retry error shape.

- **AC-8 (solo path 4xx con field-errors)**: IF a non-4xx error occurs in `invokeAgent` (network error, SSRF guard, x402 settle failure, JSON parse error), THEN the system SHALL NOT enter the retry path and SHALL execute existing error handling unchanged.

- **AC-9 (observabilidad)**: WHEN the retry path is entered, the system SHALL emit a structured log `[compose.retry]` with fields: `{ step, agent, status, firstError, retryError? }` and SHALL include `retried: true` in the `compose_step` event metadata for the successful retry or `retry_failed: true` for the failed retry.

---

## Scope IN

- `src/services/compose.ts` — lógica de retry dentro del `try/catch` del loop de steps; parseo del error body; llamada al LLM helper para regenerar input; anti-doble-cobro: refund del primer intento antes del retry debit.
- `src/services/llm/input-retry.ts` (nuevo helper) — función `regenerateInputFromErrors(failedInput, fieldErrors, agentSlug): Promise<Record<string, unknown> | null>`; usa Anthropic SDK con timeout y circuit-breaker; modelo Haiku (errores simples de input no requieren Sonnet).
- `src/lib/field-error-parser.ts` (nuevo helper) — función pura `parseFieldErrors(errorMessage: string): string[] | null`; soporta shape Zod (`fieldErrors`) y shape string-mensaje; retorna `null` si no hay field-errors reconocibles.
- Tests unitarios de `field-error-parser.ts` (ambos shapes + casos null).
- Tests de integración/unit de `compose.ts` para los 4 branches: retry-ok, retry-fail, 5xx-no-retry, 4xx-sin-fielderrors-no-retry.

## Scope OUT

- NO tocar el path con `input_schema` declarado en el agente (ya funciona, WKH-14/WKH-57).
- NO retry en 5xx (server error del agente).
- NO retry en errores que no sean HTTP (network, SSRF, JSON parse, settle failure).
- NO más de 1 retry por step.
- NO revertir ni cambiar el behavior de WKH-128/WKH-129 (refund en fallo) — el retry lo extiende, no lo reemplaza.
- NO tocar `orchestrate.ts` ni `src/routes/` — la lógica de retry es completamente interna a `compose.ts`.
- NO retry en path delegación (`delegationContext`) ni sesión (`keySessionContext`) — mismo scope que el refund actual (compose.ts:339-345).
- NO poblar `input_schema` en agentes externos (fuera de scope).
- NO modificar wasiai-v2 ni el fix de shapes de error en wasiai-v2 (ya hecho aparte).

---

## Decisiones Técnicas (DT-N)

- **DT-1 (¿dónde vive la lógica de retry?)**: La lógica vive enteramente en `compose.ts`, dentro del `catch` del loop de steps (`compose.ts:319`). No se propaga a `orchestrate.ts`. Justificación: `/compose` es el único invocador de `invokeAgent`; orchestrate delega a compose; poner la lógica en compose evita duplicidad y mantiene el principio de responsabilidad única del servicio de composición.

- **DT-2 (acceso al LLM para regenerar input)**: Nuevo helper `src/services/llm/input-retry.ts` que instancia su propio cliente Anthropic (singleton lazy, mismo patrón que `orchestrate.ts:56-63`). NO reutiliza ni extiende `transform.ts` (diferentes responsabilidades: transform adapta output→input entre steps; input-retry corrige un input fallido). Justificación: bajo acoplamiento, testeabilidad independiente, y el helper puede mockearse en tests de compose.

- **DT-3 (modelo LLM para regenerar input)**: `claude-haiku-4-5-20251001`. La tarea es simple: dado un objeto input y una lista de campos faltantes/inválidos, corregir/completar el objeto. No requiere razonamiento complejo. Haiku es 10-20x más barato que Sonnet. Si el prompt excede complejidad heurística (≥5 campos requeridos), puede escalar a Sonnet via `selectModel` — [TBD en F2, decidir si aplicar selectModel o hardcode Haiku].

- **DT-4 (parseo de field-errors)**: Función pura en `src/lib/field-error-parser.ts`. Recibe el mensaje de error completo (string del `Error.message` del catch), extrae el JSON del body, y aplica dos estrategias en cascada: (1) busca `details.fieldErrors` (Zod shape), (2) busca patterns de texto libre ("X required", "field X"). Retorna `string[]` con nombres de campos o `null` si no hay nada parseable. Puro, sin efectos, testeable en aislamiento.

- **DT-5 (orden de operaciones anti-doble-cobro)**: El primer intento falló → en el catch, **primero reembolsar** el primer debit (como hoy, WKH-128/129), **luego** hacer el retry debit → invocar agente → si retry falla, reembolsar retry debit → return error. Garantía: en ningún instante están activos dos débits simultáneos para un mismo step.

- **DT-6 (retry solo en path master)**: El retry aplica bajo el mismo guard que el refund hoy (`!request.delegationContext && !request.keySessionContext`). Para delegación/sesión, el behavior es el actual (no retry). Justificación: los contadores de delegación/sesión no tienen rollback implementado (fuera de scope de WKH-128/129); agregar retry allí requeriría extender ese mecanismo, lo cual es scope separado.

- **DT-7 (circuit-breaker para la llamada LLM del retry)**: La llamada a `regenerateInputFromErrors` usa el `anthropicCircuitBreaker` existente (igual que `maybeTransform` y `llmPlan`). Si el circuit está abierto → no retry (tratar como "no field-errors parseables" y caer al comportamiento actual).

---

## Constraint Directives (CD-N)

- **CD-1 (ANTI-DOBLE-COBRO — BLOQUEANTE)**: PROHIBIDO que dos débits de un mismo step estén activos simultáneamente. El primer debit DEBE reembolsarse antes de aplicar el retry debit. AR/CR debe verificar el orden en `compose.ts`.

- **CD-2 (MAX-1-RETRY — BLOQUEANTE)**: PROHIBIDO entrar al retry path más de una vez por step. El retry NO puede gatillar otro retry aunque el segundo 4xx traiga field-errors. Implementar con flag local `let retried = false` o estructura equivalente.

- **CD-3 (SOLO-4xx-CON-FIELD-ERRORS)**: PROHIBIDO intentar retry en: (a) errores de red, (b) SSRFViolationError, (c) errores de settle x402, (d) 5xx, (e) 4xx sin field-errors parseables. La condición de entrada al retry path es ESTRICTA.

- **CD-4 (NO-ROMPER-HAPPY-PATH)**: PROHIBIDO agregar cualquier overhead (LLM call, await extra) en el path exitoso (HTTP 2xx). El código del retry vive exclusivamente en el `catch`.

- **CD-5 (REFUND-SI-RETRY-FALLA)**: OBLIGATORIO reembolsar el retry debit si el retry falla (mismo mecanismo WKH-128/129: `creditWithDest` si hay destination, `credit` si no). El refund del retry es best-effort (un fallo del credit no cambia el error reportado).

- **CD-6 (SOLO-PATH-MASTER)**: El retry se aplica SOLO cuando `!request.delegationContext && !request.keySessionContext`. Mismo guard que el refund actual (compose.ts:339-345). PROHIBIDO expandir a delegación/sesión en esta HU.

- **CD-7 (NO-RETRY-SIN-LLM)**: Si `ANTHROPIC_API_KEY` no está configurado o el circuit-breaker está abierto, PROHIBIDO retry — degradar silenciosamente al comportamiento actual (refund + error).

- **CD-8 (OWNERSHIP-GUARD)**: El retry debit DEBE pasar `owner_ref` igual que el debit original (compose.ts:357). PROHIBIDO llamar a `budgetService.debit` sin el argumento de destination para los casos donde la policy de destino aplica.

---

## Missing Inputs

- [resuelto en F2] Confirmar si `selectModel` aplica para la llamada LLM de retry (DT-3) o si hardcode Haiku es suficiente.
- [resuelto en F2] Definir el system prompt exacto para `regenerateInputFromErrors` — si debe incluir el schema conocido del agente (si el agente lo tiene declarado, aunque improbable en este path) o solo el input original + field-errors.
- [resuelto en F2] Decidir si el evento `compose_step` del retry exitoso reemplaza al del primer intento (i.e. no emitir el evento failed del primer intento si hay retry, para no contaminar métricas) o si se emiten ambos (con flag `retried: true`). [NEEDS CLARIFICATION si hay SLAs de métricas que requieran no contar el primer intento como fallo].

---

## Waves sugeridas (para F2.5 Story File)

| Wave | Contenido | Risk |
|------|-----------|------|
| W1 | `src/lib/field-error-parser.ts` + tests unitarios (función pura, zero deps) | LOW |
| W2 | `src/services/llm/input-retry.ts` + tests unitarios (mock Anthropic) | LOW |
| W3 | Integración retry en `compose.ts`: orden debit→refund→retry-debit→invokeAgent→refund-si-falla; guards CD-2/CD-3/CD-6 | HIGH (money-path) |
| W4 | Tests de integración de compose: retry-ok, retry-fail, 5xx-no-retry, 4xx-sin-errors-no-retry, happy-path-sin-overhead | HIGH |

---

## Análisis de paralelismo

- Esta HU no bloquea otras HUs conocidas del backlog.
- Depende de: WKH-128/129 (DONE — refund per-step) y WKH-125/129 (DONE — dest-cap refund). El código de refund que extiende esta HU ya existe y está consolidado.
- Puede correr en paralelo con HUs de features independientes (escrow, RLS, etc.).
- No tiene HUs hermanas bloqueantes pendientes.
