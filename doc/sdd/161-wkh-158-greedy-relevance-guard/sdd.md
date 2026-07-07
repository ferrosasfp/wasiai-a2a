# SDD — [WKH-158] LLM planner retry-on-transient-failure (money-safe)

> Fase F2 (QUALITY, MONEY-PATH). Input: `work-item.md` (este directorio, re-escopeado a
> LLM-retry) + `project-context.md` + F0 verificado en código.
> El Architect NO escribe código de producción. Este SDD es el contrato para el Dev (F2.5 → F3).

---

## 0. Resumen ejecutivo

Hoy `llmPlan()` (`orchestrate.ts:152-283`) hace **exactamente 1 intento** por request y
colapsa TODO fallo a `return null` (timeout `:216`, red/5xx/429 `:219-235`, `JSON.parse`
`:237-243`, `selectedAgents` vacío/sin slug `:246-266`), EXCEPTO `CircuitOpenError` que
re-lanza (`:274`). El caller (`:656-669`) captura ese `CircuitOpenError` y también lo
colapsa a `plan = null`; luego `:671 if(plan){…}else{…}` → el `else` (`:741-748`) cae a
`greedyPlan()` (ciego al goal, money-unsafe por diseño). El repro en vivo (`"cotiza el
precio del dolar"`) cayó a greedy por un fallo **transitorio** del LLM en el 1er intento;
un retry manual funcionó y eligió `wasi-chainlink-price` (juicio semántico real).

**Fix:** envolver el bloque `:656-669` en un loop **acotado a 2 invocaciones** (intento
original + **1** retry). Retry SÓLO ante fallo **transitorio**. Si el retry produce un plan
→ se usa el plan LLM (path `:671-740`, con el backstop WKH-152 sin cambios). Si el retry
también falla → greedy (comportamiento actual `:741-748`, byte-idéntico). NO se toca
`llmPlan()`, `greedyPlan()`, `fallbackNoRelevance`, WKH-152 ni el débito.

**Distinción transitorio/permanente — Opción (a) elegida** (ver DT-1): el caller decide
"reintentar sí/no" con dos señales observables SIN modificar `llmPlan()`:
1. `CircuitOpenError` → capturado en el `catch` con un flag `circuitOpen` → **NO retry**
   (DT-4: el breaker seguirá abierto en ms; el cooldown default es 30s).
2. `!client` (falta `ANTHROPIC_API_KEY`, `:159-164`) → detectado con un helper interno
   `plannerConfigured()` (thin wrapper sobre `getAnthropicClient()`, ya module-private) →
   **NO retry** (AC-7). `getAnthropicClient()` devuelve `null` **iff** `!apiKey`
   (`:129-134`), causa única y total → el proxy es exacto.
3. Todo el resto (`plan === null` con client configurado y sin circuit-open) = **transitorio
   → 1 retry**. Cubre timeout/red/parse/`selectedAgents` vacío por construcción, sin
   handling especial.

**Money-safe:** el retry reusa el MISMO `llmPlan()` (mismo prompt/modelo/candidateAgents,
DT-2). El loop escribe una sola variable `plan`; sólo su valor final entra a `:671`. El
débito (`plannedCostUsd` → `executeApprovedPlan`) ocurre DESPUÉS de resolver `plan`, una
sola vez. **Imposible doble-plan / doble-cobro.** El `no_relevant_agent` legítimo
(`fallbackNoRelevance :824`, backstop WKH-152 `:842-879`) es downstream (`:792+`) y ortogonal
al retry (que sólo actúa cuando `plan === null`, `:656-669`).

---

## 1. Context Map (archivos leídos + patrón extraído)

| Archivo | Rango leído | Por qué / qué extraje |
|---|---|---|
| `src/services/orchestrate.ts` | `:1-140` | Imports, `getAnthropicClient()` (`:128-135`, memoiza `_anthropicClient` pero el guard `!apiKey` se evalúa SIEMPRE antes de la memoización → deletear el env var da `null` aunque haya cliente memoizado). `LlmPlanResponse`/`LlmPlanAgent` types (`:108-120`). |
| `src/services/orchestrate.ts` | `:152-283` | `llmPlan()` completo: los 5 `return null` internos + `CircuitOpenError` re-throw (`:274`) + `finally clearTimeout`. Confirmado: no hay retry hoy. |
| `src/services/orchestrate.ts` | `:285-329` | `greedyPlan()` — Scope OUT, byte-idéntico (CD-3). |
| `src/services/orchestrate.ts` | `:620-748` | El caller: candidate set (`:624`), el try/catch `CircuitOpenError`→`plan=null` (`:656-669`), el `if(plan)` con validación de slugs+budget+`plannedCostUsd` (`:671-740`) y el `else` greedy (`:741-748`). **Punto exacto del fix = envolver `:656-669`.** |
| `src/services/orchestrate.ts` | `:750-940` | Guards downstream (`budget_exhausted :750`, `allStepsAreDemos :803`, `fallbackNoRelevance :824`, backstop WKH-152 `:842-879`, early-return `no_relevant_agent :881`). Confirmado ortogonales al retry. Scope OUT (CD-3). |
| `src/lib/circuit-breaker.ts` | `:1-158` | `CircuitOpenError` (`:21-29`), `execute()` fail-fast en `open` SIN llamar `fn()` (`:47-53`), cooldown default 30s (`:138`). Ratifica DT-4. |
| `src/services/orchestrate.test.ts` | `:24-224`, `:320-503`, `:1882-1938` | Harness de mocks: `mockCreate` (`:24`) = `client.messages.create`; `mockBreakerExecute` passthrough `fn=>fn()` (`:38`, `:223`); `setLlmResponse`/`setLlmError` (`:182-190`); `beforeEach` fija `ANTHROPIC_API_KEY='test-key'` (`:200`). Exemplars de test: CircuitOpen→greedy (`:320-339`), `!client`→fallback+`mockCreate NOT called` (T-10 `:488-503`), greedy `no_relevant_agent` (T-W5 `:1882`). **`mockCreate.mockRejectedValueOnce(...).mockResolvedValueOnce(...)` es la palanca directa para simular "1er intento falla, 2do OK".** |
| `.nexus/project-context.md` | full | Stack: Fastify + Claude Sonnet 5 (planner) + TS strict (sin `any`) + vitest + biome. Modelo/timeout centralizados en `src/services/llm/models.ts` (`getLlmTimeoutMs`). |
| Auto-blindaje WKH-150/151/152 | full | Ver §8 (patrones recurrentes → CD-8/CD-9). |

---

## 2. Decisiones técnicas (DT-N)

### DT-1 — Mecanismo de discriminación: Opción (a) (caller-side, `llmPlan` intacto) — ELEGIDA
El caller decide reintentar con **dos señales observables desde afuera**, SIN cambiar la
firma ni los internals de `llmPlan()`:
- **CircuitOpen**: un flag `let circuitOpen = false;` seteado en el `catch` existente
  (`:660`, donde ya se hace `plan = null`).
- **`!client`**: un helper interno nuevo `plannerConfigured(): boolean { return getAnthropicClient() !== null; }` (module-private, junto a `getAnthropicClient` `:128`). CERO API surface nueva, cero export.

Retry sólo si: `plan === null` **&&** `!circuitOpen` **&&** `plannerConfigured()`.

**Por qué (a) y no (b) (discriminated return `{ok}|{transient}`):**
- (a) deja `llmPlan()` — la función que construye el plan que alimenta `plannedCostUsd` y
  el débito — **byte-idéntica**. En un money-path auditado (WKH-114/127/132/152), NO tocar
  la función productora del plan es estrictamente más seguro (CD-4). (b) obligaría a mutar
  5 `return null` internos + el type `LlmPlanResponse|null` + el `Awaited<ReturnType<typeof
  llmPlan>>` del caller (`:656`) + el `if(plan)` (`:671`) — mayor blast-radius sobre la
  función más crítica del archivo, sin beneficio observable (ambas cumplen los ACs).
- La inferencia "null + client configurado + sin circuit-open ⟹ transitorio" es **precisa,
  no heurística**: `getAnthropicClient()` retorna `null` **exclusivamente** cuando `!apiKey`
  (`:130`, causa única total), y `CircuitOpenError` es la única excepción que escapa el
  `catch` interno de `llmPlan` (`:274`). No hay una tercera causa de `null` que sea
  permanente. Las dos exclusiones son exhaustivas.

(b) NO se descarta por incorrecta — se descarta por invasividad sobre el money-path. No
requiere decisión humana: ambas cumplen todos los ACs y el resultado observable es idéntico.

### DT-2 — El retry reusa EXACTAMENTE `llmPlan(goal, budget, candidateAgents, maxAgents)`
Mismos argumentos, mismo prompt, mismo modelo, mismo candidate set. No hay un "segundo
planner más simple". Consistente con el repro en vivo (mismo prompt, 2do intento OK) y
money-safe (mismo path ya auditado, no introduce vía de cobro nueva).

### DT-3 — El retry envuelve el bloque `:656-669` COMPLETO (try/catch incluido)
No sólo el `else` de `:741`. Un `CircuitOpenError` del 1er intento se normaliza a
`plan = null` dentro del try/catch; el loop debe abarcar ese catch para que la decisión de
retry sea uniforme sobre TODOS los orígenes de `null`. El `if(plan){…}else{…}` de `:671-748`
queda FUERA del loop (corre una sola vez, sobre el `plan` final).

### DT-4 — `CircuitOpenError` NO es retryable (excluido explícito)
Si el breaker ya está `open`, `execute()` hace fail-fast sin round-trip
(`circuit-breaker.ts:47-53`) y el cooldown default (30s, `:138`) no expira entre intentos
(ms de diferencia). Un retry inmediato re-tira `CircuitOpenError` con valor esperado 0. Se
excluye vía el flag `circuitOpen` (DT-1). Costo de red del retry-excluido: 0; se evita por
claridad de intención (el breaker abierto = "degradado, ya lo sabemos → greedy directo").

### DT-5 — `selectedAgents` vacío / sin slugs válidos (`:246-266`) = TRANSITORIO (retryable)
**Ratificado con evidencia del prompt.** El system prompt (`:183`) dice *"Select 1 or more
agents (max N)"* y NUNCA le da al LLM un protocolo para expresar "ningún agente es
relevante" (el contrato JSON `:205-210` sólo tiene forma para `selectedAgents` no-vacío). Un
array vacío/sin slug es por tanto **malformación/generación incompleta de la respuesta**, no
una decisión semántica legítima. El `no_relevant_agent` legítimo se resuelve downstream
(`:824-930`) sobre un plan YA producido, jamás vía `llmPlan → null`. Con Opción (a) este
caso retorna `null` con client configurado y sin circuit → **cae en el set retryable por
construcción, sin código especial**. Si el retry también da vacío → greedy (idéntico a hoy).

### DT-6 — Loop acotado, no recursión, no `while(true)`
`for (let attempt = 0; attempt <= 1; attempt++)` con `break` en éxito / circuit / !client.
Máximo 2 iteraciones estructuralmente garantizado (AC-5). El `finally clearTimeout` de
`llmPlan` (`:280`) ya limpia el `AbortController` por invocación → cada intento tiene su
propio timeout limpio, sin fugas de timers entre intentos.

---

## 3. Constraint Directives (CD-N)

**Heredados del work-item (CD-1..CD-7):**
- **CD-1**: OBLIGATORIO máximo 1 retry — bounded, sin loop/recursión. Nunca >2 invocaciones
  de `llmPlan()` por request (AC-5).
- **CD-2**: PROHIBIDO reintentar fallo NO transitorio `!client`/config ausente (`:159-164`)
  → greedy directo (AC-7). Detectado vía `plannerConfigured()` (DT-1).
- **CD-3**: PROHIBIDO modificar (byte-idénticos, AC-9): `llmPlan()` (`:152-283`),
  `greedyPlan()` (`:287-329`), `fallbackNoRelevance` (`:824-840`), `allStepsAreDemos`
  (`:803-805`), backstop WKH-152 (`:842-879`), el `if(plan)` slug-validation/budget/
  `plannedCostUsd` (`:671-740`). El ÚNICO edit permitido en `src/` es envolver `:656-669` +
  agregar el helper `plannerConfigured()` cerca de `:135`.
- **CD-4**: OBLIGATORIO money-safe: el retry reusa el MISMO `llmPlan()` (DT-2); NO altera
  `plannedCostUsd`/`resolveAgentPriceUsdc`/`executeApprovedPlan`; NO introduce vía de cobro.
- **CD-5**: OBLIGATORIO latencia extra acotada a ≤1 llamada LLM y SÓLO en el path de fallo.
  Éxito en el 1er intento → `break` inmediato → cero latencia extra (AC-6).
- **CD-6**: OBLIGATORIO test del repro exacto (`"cotiza el precio del dolar"`, 1er intento
  mock-fail transitorio, 2do mock-success con `wasi-chainlink-price`) verificando
  `usedFallback === false` y plan LLM usado.
- **CD-7**: OBLIGATORIO test de 2 fallos transitorios consecutivos → greedy idéntico a hoy
  (`usedFallback === true`, mismo shape de `reasoning`/`plannedCostUsd`).

**Nuevos del SDD:**
- **CD-8** (auto-blindaje WKH-150#2 + WKH-151 — recurrente ≥2 HUs): correr
  `./node_modules/.bin/biome check --write <archivo>` sobre CADA archivo tocado (esp. el
  test con literales/objetos inline y `mockRejectedValueOnce` encadenados) ANTES del gate.
  `npx biome` se rompe bajo el hook RTK → usar el binario directo.
- **CD-9** (auto-blindaje WKH-152 — false-negative multilingüe): PROHIBIDO introducir
  cualquier heurística léxica/de contenido en la decisión de retry. La discriminación es
  SÓLO por causa de fallo (circuit/`!client`/transient), NUNCA por el texto del goal ni por
  los agentes. El retry NO re-juzga relevancia (eso es 100% downstream, WKH-152/greedy).
- **CD-10**: el loop debe escribir una ÚNICA variable `plan`; PROHIBIDO acumular/ejecutar
  más de un plan. Ningún débito/compose dentro del loop (money-safe, no doble-plan).
- **CD-11**: NO cambiar el comportamiento del path exitoso-al-1er-intento: mismos logs,
  mismo `plan`, cero llamadas extra. El código nuevo es inerte salvo en el path de fallo.

---

## 4. Waves de implementación

### W0 — Baseline + contrato (serial, sin lógica de negocio)
- **W0.1** Correr `./node_modules/.bin/vitest run src/services/orchestrate.test.ts
  src/services/orchestrate.billing.test.ts` y registrar el baseline VERDE
  (esperado ~90 + 13; suite total ~2788 verde por auto-blindaje WKH-152). Guardar el count
  como golden para el "byte-idéntico" de AC-9.
- **W0.2** Agregar el helper interno `plannerConfigured(): boolean` inmediatamente después
  de `getAnthropicClient()` (`~:135`). Module-private, sin export. Único "contrato" nuevo.
  Debe compilar con `tsc`/biome sin tocar nada más.

### W1 — Retry loop + tests (serial; un solo punto de edición en `src/`)
- **W1.1** Reemplazar el bloque `:656-669` por el loop acotado (ver §5). El `if(plan)`/
  `else` de `:671-748` NO se toca (queda fuera del loop, corre una vez).
- **W1.2** Tests nuevos (ver §6). Todos en `src/services/orchestrate.test.ts` reusando el
  harness existente (`mockCreate`, `setLlmResponse`, `setLlmError`, `mockBreakerExecute`).
- **W1.3** `biome check --write` sobre los 2 archivos tocados (CD-8) + suite completa verde
  (`vitest run`) con el count W0.1 + los tests nuevos, 0 rojos.

No hay W2+: el fix es un único punto de control-flow + su helper + tests. No paralelizable
(un solo archivo de producción, un solo archivo de test).

---

## 5. Forma de referencia del loop (pseudocódigo — el Dev implementa en TS strict)

> Referencia de INTENCIÓN, no código a copiar literal. Reemplaza `orchestrate.ts:656-669`.
> `:671-748` (el `if(plan){…}else{…}`) queda intacto debajo, fuera del loop.

```
let plan: Awaited<ReturnType<typeof llmPlan>> = null;
for (let attempt = 0; attempt <= 1; attempt++) {   // CD-1: máx 2 invocaciones
  let circuitOpen = false;
  try {
    plan = await llmPlan(goal, budget, candidateAgents, maxAgents);  // DT-2: mismos args
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      log.warn({ orchestrationId }, '[Orchestrate] planner circuit open — using greedy fallback');
      plan = null;
      circuitOpen = true;                    // DT-4: no retry
    } else {
      throw err;                             // no debería ocurrir (llmPlan captura el resto)
    }
  }
  if (plan) break;                           // éxito (1er o 2do intento) → CD-5 cero latencia extra
  if (circuitOpen) break;                    // DT-4 / AC (breaker abierto → greedy directo)
  if (!plannerConfigured()) break;           // CD-2 / AC-7 (!client → greedy directo)
  // else: null transitorio (timeout/red/parse/selectedAgents vacío) → loop reintenta 1 vez
}
// ↓ INTACTO — el mismo if(plan){…}else{ greedy }…  de :671-748
```

Notas de implementación (TS strict, sin `any`):
- `circuitOpen` se declara DENTRO del `for` (se re-evalúa por intento).
- El helper: `function plannerConfigured(): boolean { return getAnthropicClient() !== null; }`.
- El mensaje `log.warn` es el MISMO string actual (`:661-664`) — preservarlo palabra por
  palabra (CD-11: no cambiar telemetría/logs del path existente).

---

## 6. Test Plan (≥1 por AC; todos en `src/services/orchestrate.test.ts`)

Palanca base para "1er intento falla, 2do OK":
`mockCreate.mockRejectedValueOnce(new Error('API timeout')).mockResolvedValueOnce({ content: [{ type:'text', text: JSON.stringify(plan) }] })`.
(El breaker mock es passthrough `fn=>fn()`, así que cada `llmPlan` = 1 `mockCreate`.)

| Test (id sugerido) | AC | Setup | Aserción clave |
|---|---|---|---|
| **T-158-1** transient→retry→LLM plan | AC-1, AC-2 | `mockCreate` reject-once (timeout) luego resolve-once con plan válido de `summarizer-v1` | `result.reasoning` NO contiene `[FALLBACK]`; `usedFallback === false` (vía ausencia de `[FALLBACK]` + compose llamado con el plan LLM); `mockCreate` llamado **2 veces** |
| **T-158-2** retry-también-falla→greedy | AC-3, CD-7 | `mockCreate` reject **dos** veces (ambas transitorias); goal que overlapea los agentes mock para evitar `no_relevant_agent` (p.ej. `'summarize text'`) | `reasoning` contiene `[FALLBACK] LLM planning failed`; `usedFallback === true`; `mockCreate` llamado **2 veces**; compose llamado (greedy ejecuta) |
| **T-158-3** `!client`→NO retry→greedy | AC-7, CD-2 | `delete process.env.ANTHROPIC_API_KEY` (patrón T-10 `:488`) | `reasoning` contiene `[FALLBACK]`; `mockCreate` llamado **0 veces** (prueba que NO hubo ni intento ni retry) |
| **T-158-4** CircuitOpen→NO retry→greedy | AC-3, DT-4 | `mockBreakerExecute.mockRejectedValue(new CircuitOpenError('anthropic'))` (patrón `:320-325`) | NO throw; `reasoning` contiene `[FALLBACK]`; `mockBreakerExecute` llamado **1 vez** (no se reintentó el breaker abierto); compose llamado |
| **T-158-5** repro multilingüe | AC-4, CD-6 | goal `'cotiza el precio del dolar'`; `mockCreate` reject-once (transient) luego resolve-once con plan `wasi-chainlink-price`; discovery mock que incluya ese agente | `usedFallback === false`; el step del plan es `wasi-chainlink-price`; NO cae a `fallbackNoRelevance`; `mockCreate` 2 veces |
| **T-158-6** máx 1 retry (bounded, no loop) | AC-5 | `mockCreate` reject **siempre** (`mockRejectedValue`, transitorio) | `mockCreate` llamado **exactamente 2 veces** (no 3+); termina en greedy sin colgar |
| **T-158-7** éxito-1er-intento sin latencia/llamada extra | AC-6, CD-11 | `mockCreate` resolve-once plan válido (happy path, como T-1) | `mockCreate` llamado **exactamente 1 vez**; `usedFallback === false` |
| **T-158-8** `no_relevant_agent` legítimo intacto | AC-8, AC-9 | Reusar/replicar T-W5 (`:1882`): `setLlmError` (transient) + goal nonsense `'asdfqwerty12345'` con agentes reales que no overlapean | `planStatus`→`no_relevant_agent`; `debit`/`compose`/`chargeProtocolFee` NO llamados. **NOTA:** con el retry, `mockCreate` ahora se llama 2 veces (ambas fallan) antes del greedy → el resultado downstream es idéntico. Si un test preexistente asertaba `mockCreate` 1 vez en un path de fallo transitorio, actualizar el count a 2 (único cambio esperado; documentarlo en el reporte). |

**Regresión (AC-9 byte-idéntico):** la suite completa `vitest run` debe quedar verde con el
count W0.1 + T-158-*. Cualquier test preexistente que rompa por el **conteo de invocaciones**
de `mockCreate` en un path de fallo transitorio (ahora 2 en vez de 1) es un ajuste ESPERADO
del count (no del comportamiento de billing/plan) → actualizar el número y documentarlo. Si
rompe algo distinto a un count de invocaciones (billing, `usedFallback`, `plannedCostUsd`,
`reasoning`) = BUG, parar. Ver §7.

---

## 7. Análisis money-safe (confirmaciones explícitas)

1. **No doble-plan**: el loop escribe una sola variable `plan` (CD-10); `break` en el primer
   éxito. Sólo el valor final entra a `:671`. Imposible que dos planes lleguen a
   `executeApprovedPlan`.
2. **No doble-cobro**: NINGÚN débito/compose/settle ocurre dentro del loop. El débito
   (`plannedCostUsd` step-0 en `executeApprovedPlan`, steps 1..N en `composeService.compose`)
   corre una sola vez, DESPUÉS de resolver `plan`, exactamente como hoy.
3. **`greedyPlan` byte-idéntico**: el `else` de `:741-748` no se toca; sólo se alcanza si
   AMBOS intentos fallan (o circuit/!client) — mismo resultado que hoy con 1 intento.
4. **WKH-152 / `fallbackNoRelevance` / `allStepsAreDemos` intactos** (`:803-879`): corren en
   `:792+`, sobre el plan YA resuelto, sin saber si hubo retry. El retry sólo actúa cuando
   `plan === null` (`:656-669`), rama disjunta y anterior. AC-8 garantizado por construcción.
5. **`no_relevant_agent` legítimo ≠ fallo transitorio**: el primero exige un plan concreto
   (LLM/greedy) sin overlap léxico, evaluado downstream; el retry sólo dispara sobre
   `null`/excepción upstream. Dos ramas secuenciales distintas (F0 del work-item `:113-124`).

---

## 8. Aprendizaje de auto-blindaje histórico (últimas HUs DONE)

Revisadas: WKH-152 (`160-…`), WKH-151 (`157-…`), WKH-150 (`156-…`).

| Patrón recurrente (≥2 HUs) | HUs | Prevención en este SDD |
|---|---|---|
| biome rompe formato en tests con literales/objetos inline; `npx biome` falla bajo hook RTK | WKH-150#2, WKH-151 | **CD-8**: `./node_modules/.bin/biome check --write` (binario directo) sobre cada archivo tocado antes del gate |
| Heurística léxica sobre planes multilingües genera false-negatives money-path (goal ES vs agente EN) | WKH-152 (×2 entradas) | **CD-9**: la decisión de retry es SÓLO por causa de fallo, JAMÁS por texto del goal/agentes; el retry no re-juzga relevancia |

WKH-152 además deja una lección de proceso directamente aplicable: **el path multilingüe es
el caso común en WasiAI LATAM, no el borde** — por eso el retry (que le da al LLM un 2do
juicio semántico real) es la mejora correcta sobre degradar al greedy léxico ciego.

---

## 9. Exemplars verificados (paths confirmados vía Read/Glob)

| Exemplar | Ubicación | Uso |
|---|---|---|
| Try/catch `CircuitOpenError`→`plan=null` a envolver | `orchestrate.ts:656-669` | Punto exacto de edición (W1.1) |
| `else` greedy (byte-idéntico) | `orchestrate.ts:741-748` | Queda intacto debajo del loop |
| `llmPlan()` error handling (5×`return null` + re-throw) | `orchestrate.ts:152-283` | Fuente de la clasificación (no se toca) |
| `getAnthropicClient()` (base de `plannerConfigured`) | `orchestrate.ts:128-135` | Helper nuevo W0.2 |
| Mock harness (`mockCreate`, `setLlmError`, `setLlmResponse`) | `orchestrate.test.ts:24, 182-190` | Base de todos los T-158-* |
| Test CircuitOpen→greedy | `orchestrate.test.ts:320-339` | Patrón de T-158-4 |
| Test `!client`→fallback + `mockCreate NOT called` | `orchestrate.test.ts:488-503` (T-10) | Patrón de T-158-3 |
| Test greedy `no_relevant_agent` (money-safe) | `orchestrate.test.ts:1882-1906` (T-W5) | Patrón de T-158-8 |
| `CircuitOpenError` + fail-fast + cooldown 30s | `circuit-breaker.ts:21-29, 47-53, 138` | Ratifica DT-4 |

---

## 10. Readiness Check

- [x] Work-item leído completo (re-escopeado a LLM-retry) — Scope IN/OUT, AC-1..AC-9, CD-1..CD-7, DT-1..DT-5, Missing Inputs.
- [x] `project-context.md` leído — stack ratificado (Claude Sonnet 5 planner, TS strict, vitest, biome). Sin drift.
- [x] Punto de edición verificado con Read: `orchestrate.ts:656-669` (un único bloque en `src/`).
- [x] Exemplars de test verificados (CircuitOpen `:320`, `!client` `:488`, greedy no-relevant `:1882`) + palanca `mockRejectedValueOnce/mockResolvedValueOnce` confirmada contra el harness (`:24`, `:38`, `:182`).
- [x] Missing Input #1 (clasificación `selectedAgents` vacío) RESUELTO en DT-5 con evidencia del prompt (`:183`) → transitorio/retryable, cubierto sin código especial.
- [x] Missing Input #2 (`CircuitOpenError` retryable?) RESUELTO en DT-4 → excluido explícito.
- [x] Decisión (a) vs (b) RESUELTA en DT-1 → Opción (a) (menos invasiva, `llmPlan` byte-idéntico, money-safe). NO requiere gate humano (ambas cumplen los ACs).
- [x] Money-safe confirmado (§7): no doble-plan, no doble-cobro, greedy/WKH-152/débito intactos.
- [x] Auto-blindaje histórico incorporado → CD-8, CD-9.
- [x] **Sin `[NEEDS CLARIFICATION]` pendientes.** SDD listo para SPEC_APPROVED.

---

*F2 SDD — WKH-158 — MONEY-PATH QUALITY. Próximo paso: gate humano `SPEC_APPROVED` → F2.5 Story File.*
