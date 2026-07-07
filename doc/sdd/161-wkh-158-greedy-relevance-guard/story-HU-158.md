# Story File — #158: LLM planner retry-on-transient-failure (money-safe)

> SDD: doc/sdd/161-wkh-158-greedy-relevance-guard/sdd.md
> Work-item: doc/sdd/161-wkh-158-greedy-relevance-guard/work-item.md
> Fecha: 2026-07-07
> Branch: `fix/161-wkh-158-llm-planner-retry`
> MONEY-PATH — QUALITY. El único edit de producción es un punto de control-flow en `orchestrate.ts`.

---

## Goal

Hoy, cuando el LLM planner (`llmPlan()`) falla de forma **transitoria** (timeout / red / 5xx / 429 /
`JSON.parse` inválido / `selectedAgents` vacío), el caller de `orchestrateService.orchestrate` cae
directo a `greedyPlan()` — un planner ciego al goal (money-unsafe por diseño, degrada goals
multilingües como `"cotiza el precio del dolar"`). **El fix:** reintentar `llmPlan()` **exactamente 1
vez** ante un fallo transitorio, ANTES de caer a greedy. Si el retry produce un plan → se usa el plan
LLM (juicio semántico real). Si el retry también falla → greedy, byte-idéntico a hoy. NO se reintenta
un fallo **permanente** (`!client` sin `ANTHROPIC_API_KEY`, ni `CircuitOpenError` con breaker abierto).

---

## Contexto exacto del fix (leer antes de tocar nada)

- **Archivo único de producción:** `src/services/orchestrate.ts`.
- **Punto de edición:** el bloque `:656-669` — el `let plan = ...; try { plan = await llmPlan(...) }
  catch (CircuitOpenError) { plan = null } else { throw }`.
- **Lo que NO se toca:** el `if (plan) { … } else { greedy }` de `:671-748` queda **FUERA del loop**,
  corre **exactamente 1 vez** sobre el `plan` final. `llmPlan()` (`:152-283`), `greedyPlan()`
  (`:287-329`), `fallbackNoRelevance` (`:824-840`), `allStepsAreDemos` (`:803-805`), backstop WKH-152
  (`:842-879`) y todo el débito (`plannedCostUsd` → `executeApprovedPlan` / `composeService.compose`)
  quedan intactos.
- **Estado actual verificado** (`orchestrate.ts:656-669`, leído en F2.5):
  ```ts
  let plan: Awaited<ReturnType<typeof llmPlan>>;
  try {
    plan = await llmPlan(goal, budget, candidateAgents, maxAgents);
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      log.warn(
        { orchestrationId },
        '[Orchestrate] planner circuit open — using greedy fallback',
      );
      plan = null;
    } else {
      throw err;
    }
  }
  ```

---

## Mecanismo EXACTO del retry (NO reinventar — implementar esto tal cual)

1. Envolver el bloque `:656-669` en un **loop acotado**: `for (let attempt = 0; attempt <= 1; attempt++)`.
   Máximo **2 invocaciones** de `llmPlan()` por request (intento original + 1 retry). NO `while(true)`,
   NO recursión.
2. Dentro del loop, `let circuitOpen = false;` (re-declarado por iteración). En el `catch` de
   `CircuitOpenError` (el existente): `plan = null; circuitOpen = true;`. El `else { throw err }` se
   preserva sin cambios.
3. **Condición de retry** (después del try/catch, dentro del loop):
   - `if (plan) break;` → éxito (1er o 2do intento) → sale sin latencia extra.
   - `if (circuitOpen) break;` → breaker abierto → NO retry → greedy directo (DT-4).
   - `if (!plannerConfigured()) break;` → `!client` sin API key → NO retry → greedy directo (AC-7).
   - Si ninguno rompe: `plan === null` transitorio (timeout/red/parse/`selectedAgents` vacío) → el
     loop reintenta 1 vez.
4. **La variable `plan` es ÚNICA** (declarada antes del loop, tipo `Awaited<ReturnType<typeof
   llmPlan>>`, inicializada a `null`). El loop la sobrescribe; sólo su valor **final** entra al
   `if (plan)` de `:671`. Ningún débito/compose ocurre dentro del loop.
5. **Helper nuevo** (W0), inmediatamente después de `getAnthropicClient()` (`~:135`), module-private,
   sin export:
   ```ts
   function plannerConfigured(): boolean {
     return getAnthropicClient() !== null;
   }
   ```
   `getAnthropicClient()` retorna `null` **iff** `!apiKey` (`:130`) → proxy exacto de `!client`.

### Condición transitorio vs permanente (por causa de fallo, NUNCA por texto — CD-9)

| Causa | Cómo se detecta | Retry? |
|---|---|---|
| Timeout / red / 5xx / 429 / `JSON.parse` inválido / `selectedAgents` vacío o sin slugs | `plan === null` con client configurado y sin circuit | **SÍ, 1 vez** |
| `CircuitOpenError` (breaker abierto) | flag `circuitOpen === true` en el catch | **NO** — greedy directo |
| `!client` (falta `ANTHROPIC_API_KEY`) | `plannerConfigured() === false` | **NO** — greedy directo |

> La discriminación es SÓLO por causa de fallo. PROHIBIDO mirar el texto del goal o los agentes para
> decidir si reintentar (CD-9, auto-blindaje WKH-152). El retry NO re-juzga relevancia.

---

## Acceptance Criteria (EARS) — copiados del SDD/work-item

- **AC-1**: WHEN `llmPlan()` falla por causa **transitoria** (timeout `:216-217`, red/5xx/429
  `:219-235`, `JSON.parse` `:237-243`, `selectedAgents` vacío/sin slugs `:246-250`/`:257-266`), THE
  system SHALL reintentar `llmPlan()` EXACTAMENTE 1 vez con los mismos args antes de caer a greedy.
- **AC-2**: WHEN el retry produce un plan válido (`plan !== null`), THE system SHALL usar ese plan LLM
  (`usedFallback === false`, sujeto al backstop WKH-152 sin cambios) — NO cae a greedy.
- **AC-3**: WHEN el retry TAMBIÉN falla, THE system SHALL caer a `greedyPlan()` (`usedFallback ===
  true`) — idéntico al actual (`:741-748`).
- **AC-4**: WHEN un goal multilingüe (`"cotiza el precio del dolar"`) falla transitoriamente en el 1er
  intento pero el retry tiene éxito, THE system SHALL producir el plan LLM (p.ej. `wasi-chainlink-price`)
  en vez de degradar a greedy + `fallbackNoRelevance`.
- **AC-5**: WHILE se evalúa reintentar, THE system SHALL NOT reintentar más de 1 vez — máximo 2
  invocaciones de `llmPlan()` por request.
- **AC-6**: WHILE el retry corre, THE system SHALL acotar la latencia extra a ≤1 llamada LLM y SÓLO en
  el path de fallo — éxito al 1er intento = cero latencia/llamada extra.
- **AC-7**: IF `llmPlan()` falla por causa **NO transitoria** (`!client`, `:159-164`), THEN THE system
  SHALL NOT reintentar y SHALL caer directo a greedy.
- **AC-8**: WHILE `fallbackNoRelevance` y el backstop WKH-152 evalúan relevancia downstream (`:792+`),
  THE system SHALL NOT tratar un `no_relevant_agent` legítimo como fallo transitorio — el retry sólo
  actúa cuando `plan === null` (`:656-669`).
- **AC-9**: WHILE `usedFallback === false` o `=== true`, THE system SHALL mantener byte-idénticos
  `fallbackNoRelevance` (`:824-840`), `greedyPlan()` (`:287-329`), `allStepsAreDemos` (`:803-805`) y el
  backstop WKH-152 (`:842-879`).

---

## Files to Modify/Create

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `src/services/orchestrate.ts` | Modificar | (W0) Agregar helper `plannerConfigured()` tras `getAnthropicClient()` (`~:135`). (W1) Envolver `:656-669` en el loop acotado. NADA más. | `orchestrate.ts:128-135` (getAnthropicClient); `orchestrate.ts:656-669` (bloque a envolver) |
| 2 | `src/services/orchestrate.test.ts` | Modificar | (W2) Agregar los 8 tests T-158-1..8. Reusar harness existente (`mockCreate`, `setLlmResponse`, `setLlmError`, `mockBreakerExecute`). Ajustar counts de tests preexistentes de fallo transitorio si rompen (ver §Tests preexistentes). | `orchestrate.test.ts:320-339` (CircuitOpen→greedy); `:488-503` (!client→0 calls); `:1882+` (greedy no_relevant); `:24, 182-190, 223` (harness) |

---

## Constraint Directives

### OBLIGATORIO
- **CD-1**: Máximo **1 retry** — bounded (`for attempt <= 1`), sin loop/recursión. Nunca >2 invocaciones
  de `llmPlan()` por request.
- **CD-4 / CD-10**: Money-safe — el retry reusa el MISMO `llmPlan()` con los MISMOS args
  (`goal, budget, candidateAgents, maxAgents`). Una **única** variable `plan`. Ningún débito/compose/
  settle dentro del loop; el débito corre 1 sola vez después de resolver `plan`. Imposible doble-plan /
  doble-cobro.
- **CD-5 / CD-11**: Latencia extra sólo en el path de fallo. El path exitoso-al-1er-intento queda
  inerte: mismo `plan`, mismos logs, cero llamadas extra. Preservar el `log.warn` de `:661-664` **palabra
  por palabra** (mismo string).
- **CD-8** (auto-blindaje WKH-150/WKH-151, recurrente): correr `./node_modules/.bin/biome check --write
  <archivo>` (binario DIRECTO, no `npx biome` — se rompe bajo el hook RTK) sobre CADA archivo tocado
  (esp. el test con `mockRejectedValueOnce` encadenados) ANTES de cada gate.
- TS strict — sin `any`. `plan` tipada `Awaited<ReturnType<typeof llmPlan>>`.

### PROHIBIDO
- **CD-2**: NO reintentar `!client` (config ausente) ni `CircuitOpenError` (breaker abierto) → greedy
  directo.
- **CD-3**: NO modificar `llmPlan()` (`:152-283`), `greedyPlan()` (`:287-329`), `fallbackNoRelevance`
  (`:824-840`), `allStepsAreDemos` (`:803-805`), el backstop WKH-152 (`:842-879`), ni el `if(plan)`
  slug-validation/budget/`plannedCostUsd` (`:671-740`). Byte-idénticos (AC-9).
- **CD-9**: NO introducir heurística léxica / de contenido en la decisión de retry. La discriminación es
  SÓLO por causa de fallo, NUNCA por el texto del goal ni por los agentes.
- NO tocar el fallback de "slugs LLM inválidos" (`:678-687`, `plan !== null` pero `validAgents === 0`) —
  escenario distinto, fuera de scope.
- NO agregar dependencias nuevas (ninguna).
- NO tocar `compose.ts`, settlement, débito de steps 1..N, `discovery.ts` ni el broaden-retry WKH-151.
- NO modificar archivos fuera de la tabla.

---

## Waves

### Wave -1: Environment Gate (verificar antes de tocar código)

```bash
ls /home/ferdev/.openclaw/workspace/wasiai-a2a/src/services/orchestrate.ts \
   /home/ferdev/.openclaw/workspace/wasiai-a2a/src/services/orchestrate.test.ts \
   /home/ferdev/.openclaw/workspace/wasiai-a2a/node_modules/.bin/biome \
   /home/ferdev/.openclaw/workspace/wasiai-a2a/node_modules/.bin/vitest 2>/dev/null \
   || echo "FALTA archivo/binario base"
```
Si algo falla: PARAR y reportar al orquestador. No implementar sobre entorno roto.

### Wave 0 — Baseline + helper (serial, sin lógica de negocio)
- [ ] **W0.1**: Baseline VERDE. Correr:
  `./node_modules/.bin/vitest run src/services/orchestrate.test.ts src/services/orchestrate.billing.test.ts`
  y registrar el count golden (esperado ~90 + 13; suite total ~2788 verde). Este count es el golden de
  "byte-idéntico" para AC-9.
- [ ] **W0.2**: Agregar `plannerConfigured(): boolean { return getAnthropicClient() !== null; }`
  inmediatamente después de `getAnthropicClient()` (`~:135`). Module-private, sin export.
- **Checkpoint W0**: `./node_modules/.bin/tsc --noEmit` limpio + `./node_modules/.bin/biome check --write
  src/services/orchestrate.ts` sin errores. Suite sigue verde (el helper es inerte, aún no se llama).

### Wave 1 — Retry loop (serial, único edit de control-flow)
- [ ] **W1.1**: Reemplazar `:656-669` por el loop acotado (ver §Mecanismo EXACTO). El `if(plan)/else`
  de `:671-748` NO se toca. Preservar el `log.warn` exacto.
- **Checkpoint W1**: `tsc --noEmit` limpio + `biome check --write src/services/orchestrate.ts` +
  `./node_modules/.bin/vitest run src/services/orchestrate.test.ts` — suite verde o sólo con counts de
  `mockCreate` a ajustar (ver §Tests preexistentes). Si rompe billing/`usedFallback`/`plannedCostUsd`/
  `reasoning` → BUG, PARAR.

### Wave 2 — Tests (serial, mismo archivo de test)
- [ ] **W2.1**: Agregar los 8 tests T-158-1..8 (ver §Los 8 tests).
- [ ] **W2.2**: Ajustar el count de `mockCreate` en tests preexistentes de fallo transitorio si
  aplica (ver §Tests preexistentes). SÓLO el count, NO billing.
- **Checkpoint W2**: `biome check --write` sobre `orchestrate.test.ts` (CD-8) + `vitest run` completo
  verde con count W0.1 + los 8 nuevos, 0 rojos.

### Verificación Incremental
| Wave | Verificación |
|------|--------------|
| W0 | tsc + biome limpio, suite verde (helper inerte) |
| W1 | tsc + biome + suite (counts ajustables) |
| W2 | full suite verde con los 8 tests nuevos |

---

## Los 8 tests (T-158-*) — todos en `src/services/orchestrate.test.ts`

> Palanca base "1er intento falla, 2do OK":
> `mockCreate.mockRejectedValueOnce(new Error('API timeout')).mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify(plan) }] })`
> El breaker mock es passthrough (`fn => fn()`, `:38/:223`) → cada `llmPlan` = 1 `mockCreate`.

| Test | AC | Setup | Assert clave |
|---|---|---|---|
| **T-158-1** transient→retry→LLM plan | AC-1, AC-2 | `mockCreate` reject-once (timeout) luego resolve-once con plan válido (`summarizer-v1`) | `reasoning` NO contiene `[FALLBACK]`; `usedFallback === false`; `mockCreate` llamado **2×** |
| **T-158-2** retry-también-falla→greedy | AC-3, CD-7 | `mockCreate` reject **2 veces** (ambas transitorias); goal que overlapea agentes mock (`'summarize text'`) para evitar `no_relevant_agent` | `reasoning` contiene `[FALLBACK] LLM planning failed`; `usedFallback === true`; `mockCreate` **2×**; `composeService.compose` llamado |
| **T-158-3** `!client`→NO retry→greedy | AC-7, CD-2 | `delete process.env.ANTHROPIC_API_KEY` (patrón `:488`) | `reasoning` contiene `[FALLBACK]`; `mockCreate` llamado **0×** (ni intento ni retry) |
| **T-158-4** CircuitOpen→NO retry→greedy | AC-3, DT-4 | `mockBreakerExecute.mockRejectedValue(new CircuitOpenError('anthropic'))` (patrón `:325`) | NO throw; `reasoning` contiene `[FALLBACK]`; `mockBreakerExecute` llamado **1×** (no reintenta breaker abierto); compose llamado |
| **T-158-5** repro multilingüe | AC-4, CD-6 | goal `'cotiza el precio del dolar'`; `mockCreate` reject-once (transient) luego resolve-once con plan `wasi-chainlink-price`; discovery mock que incluya ese agente | `usedFallback === false`; el step del plan es `wasi-chainlink-price`; NO cae a `fallbackNoRelevance`; `mockCreate` **2×** |
| **T-158-6** máx 1 retry (bounded) | AC-5 | `mockCreate` reject **siempre** (`mockRejectedValue`, transitorio) | `mockCreate` llamado **exactamente 2×** (no 3+); termina en greedy sin colgar |
| **T-158-7** éxito-1er-intento sin llamada extra | AC-6, CD-11 | `mockCreate` resolve-once plan válido (happy path, como T-1) | `mockCreate` llamado **exactamente 1×**; `usedFallback === false` |
| **T-158-8** `no_relevant_agent` legítimo intacto | AC-8, AC-9 | Replicar T-W5 (`:1882`): `setLlmError` (transient) + goal nonsense `'asdfqwerty12345'` con agentes reales que no overlapean | `planStatus` → `no_relevant_agent`; `budgetService.debit`/`compose`/`chargeProtocolFee` NO llamados. **Con el retry, `mockCreate` ahora se llama 2× (ambas fallan) antes del greedy** → el downstream es idéntico |

### Criterio Test-First
Lógica de control-flow de billing → **test-first SÍ**. Escribir/ajustar los tests junto con W1 (o
inmediatamente después), verde antes de cerrar.

---

## Tests preexistentes a ajustar (SÓLO count de `mockCreate`, NUNCA billing)

Con el retry, cualquier test que fuerce un fallo **transitorio persistente** vía `setLlmError`
(`mockCreate.mockRejectedValue(...)` — TODAS las llamadas fallan) ahora invoca `mockCreate` **2 veces**
en vez de 1 antes de caer a greedy. Los tests con `setLlmError` en `orchestrate.test.ts` están en:
`:305` (T-4), `:1751`, `:1884` (T-W5), `:1916`, `:1946`, `:1966`.

- **Comportamiento downstream idéntico**: ambos intentos fallan → greedy corre igual → `[FALLBACK]`,
  `usedFallback`, `plannedCostUsd`, `no_relevant_agent`, compose — todo sin cambios.
- **Verificación en F0/W0.1**: ninguno de esos tests asserta hoy un count exacto de `mockCreate` en el
  path transitorio (el único assert de count es `:502`, `!client` → `not.toHaveBeenCalled` → 0, que
  NO cambia). Por eso lo más probable es que **NINGUNO rompa por count**.
- **Regla**: si alguno rompe por **conteo de invocaciones de `mockCreate`** (1→2) → actualizar el número
  y documentarlo en el reporte. Si rompe por **billing / `usedFallback` / `plannedCostUsd` / `reasoning`**
  → es un BUG del fix, PARAR y escalar. No relajar asserts de money.

---

## Out of Scope (NO tocar bajo ninguna circunstancia)
- `greedyPlan()` (`:287-329`) — el humano descartó tocarlo.
- `fallbackNoRelevance` (`:824-840`) — la Opción (a) top-1 del work-item original queda DESCARTADA.
- Backstop WKH-152 mixed-plan-only (`:842-879`), `allStepsAreDemos` (`:803-805`).
- Fallback "slugs LLM inválidos" (`:678-687`).
- `compose.ts` / settlement / débito steps 1..N / `discovery.ts` / broaden-retry WKH-151.
- NO "mejorar" código adyacente. NO agregar funcionalidad no listada.

## Anti-Hallucination Checklist (verificado por Architect en F2.5)
- [x] `orchestrate.ts:656-669` existe y matchea el snippet (leído en F2.5).
- [x] `getAnthropicClient()` en `:128-135`, retorna `null` iff `!apiKey` → base de `plannerConfigured()`.
- [x] `CircuitOpenError` importado y usado con `instanceof` en el catch existente.
- [x] Harness de test: `mockCreate` (`:24`), `mockBreakerExecute` passthrough (`:38/:223`),
  `setLlmResponse`/`setLlmError` (`:182-190`), `beforeEach` fija `ANTHROPIC_API_KEY='test-key'` (`:200`).
- [x] Exemplars de test: CircuitOpen `:320-339`, `!client` `:488-503`, greedy no-relevant `:1882+`.
- [x] `./node_modules/.bin/biome` y `./node_modules/.bin/vitest` existen (Environment Gate).
- [x] Sin `[NEEDS CLARIFICATION]` — el SDD resolvió todos los Missing Inputs.

## Done Definition
- AC-1..AC-9 verdes con evidencia archivo:línea.
- Los 8 tests T-158-* pasando + suite completa verde (count W0.1 + 8 nuevos, 0 rojos).
- `tsc --noEmit` limpio; `biome check --write` sobre los 2 archivos tocados sin errores (CD-8).
- Scope IN respetado: SÓLO `orchestrate.ts` (helper + loop) y `orchestrate.test.ts`.
- Ningún archivo Scope OUT modificado (verificable por diff: `greedyPlan`/`fallbackNoRelevance`/
  WKH-152/`llmPlan` byte-idénticos).
- Money-safe: una sola var `plan`, débito 1 vez, sin doble-cobro.

## Escalation Rule
Si algo no está en este Story File, Dev PARA y escala al Architect. No inventar, no asumir. En
particular: si un test preexistente rompe por algo distinto a un count de `mockCreate` (billing,
`usedFallback`, `plannedCostUsd`, `reasoning`) → PARAR inmediatamente, es un BUG del fix.

---

*Story File generado por NexusAgil — F2.5 — WKH-158 (MONEY-PATH QUALITY)*
