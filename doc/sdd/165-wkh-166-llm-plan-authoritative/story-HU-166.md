# Story File — WKH-166: Plan del LLM autoritativo (neutralizar el drop léxico del backstop)

> Contrato autocontenido para el Dev (F3). Implementá al pie de la letra. NO redecidas.
> SDD: `doc/sdd/165-wkh-166-llm-plan-authoritative/sdd.md` (SPEC_APPROVED)
> Work Item: `doc/sdd/165-wkh-166-llm-plan-authoritative/work-item.md`
> Branch: `fix/165-wkh-166-llm-plan-authoritative`
> Modo: QUALITY — money-path — cambio de conducta INTENCIONAL en billing.

---

## 0. Contexto compacto (qué se construye y por qué)

El backstop léxico de relevancia (WKH-152 MIXED-PLAN-ONLY, refinado por WKH-158/159/163)
corre POST-LLM sobre el plan del planner y **dropea steps que el LLM seleccionó bien**
cuando el corpus del agente (name+description+capabilities+input) no comparte tokens ≥3
chars con el goal. Rompe el flujo estrella de remesas: `send money to Peru via the best
option` dropea `agentshop-kyc-validator` porque "best" del goal matchea léxicamente la
descripción del corridor.

**Decisión del founder: el plan del LLM es AUTORITATIVO.** Se ejecuta tal cual tras los
guards que NO son de relevancia léxica (slug-existe-en-discovery + budget-fit +
`allStepsAreDemos`). Se **elimina** todo el wiring del drop léxico sobre el plan LLM y el
recompute de billing post-drop. El smart-drop "inteligente" (semántico por embeddings)
vuelve con **WKH-160**, que re-engancha en el mismo hook point.

**Resultado esperado:** un plan MIXTO del LLM (relevante + real-irrelevante) se ejecuta y
cobra completo; el débito sigue siendo el precio del step-0 ORIGINAL del LLM (nunca mutado).

⚠️ **Este es un cambio de REDUCCIÓN de código** (~-60 líneas de producción). NO agregás
superficie nueva. El riesgo está en el recompute de billing y en 3 tests que cambian de
conducta esperada de forma deliberada.

---

## 1. Scope IN (lista exhaustiva de archivos a tocar)

| Archivo | Acción | Qué se hace |
|---------|--------|-------------|
| `src/services/orchestrate.ts` | Modificar (remover) | Eliminar 3 bloques (`llmGoalTokens`, backstop LLM completo, recompute post-drop) + comment hygiene. |
| `src/services/orchestrate.test.ts` | Modificar (3 tests) | Reescribir T-152-1, T-152-4, T-163-4 a la conducta NUEVA (conserve-all / no reprice). |

**NINGÚN OTRO ARCHIVO.** Sin refactors adyacentes (CD-12).

---

## 2. Anti-Hallucination Checklist (específico de esta HU)

- [ ] NO tocar `greedyPlan()` (`~:280-338`) — byte-idéntico (CD-2).
- [ ] NO tocar `fallbackNoRelevance` (`:860-875`) — byte-idéntico (CD-2). Consume `goalTokens`.
- [ ] NO tocar `allStepsAreDemos` (`:830-832`) — byte-idéntico (CD-3).
- [ ] NO tocar `llmPlan()` / planner prompt, `discovery.ts`, `chargeProtocolFee`/`getProtocolFeeRate` (CD-7).
- [ ] NO remover/renombrar/cambiar firma de `tokenizeForRelevance` (`:356-363`) ni `textOverlapsGoal` (`:372-381`). Quedan INERTES, vivas y **exportadas** — hook para WKH-160 + T-152-8 (CD-10).
- [ ] NO agregar smart-drop semántico — eso es WKH-160 (CD-11).
- [ ] NO tocar el early-return `no_relevant_agent` (`:937-1005`) — permanece intacto.
- [ ] NO tocar el recompute final `costPerStep`/`totalCostUsdc`/`maxQuotedCostUsdc`/`protocolFeeUsdc` (`:1040-1059`) — hereda el fix por construcción.
- [ ] CONSERVAR `const goalTokens = tokenizeForRelevance(goal)` (`:851`) — lo consume `fallbackNoRelevance` (`:862,:871`) y el reasoning (`:961`). NO removerlo por error junto a `llmGoalTokens`.
- [ ] NO ejecutar el smart-drop ni redecidir asserts — usá los snippets EXACTOS de §5.
- [ ] NUEVO: NO expandir el diff más allá de los 3 bloques + comment hygiene + 3 tests (CD-12).

> Los números de línea son GUÍA (estado verificado al 2026-07-08). Anclá por el
> texto/identificador exacto, no por el número — si el archivo drifteó, buscá el snippet.

---

## 3. Constraint Directives (heredados del SDD + work-item)

### OBLIGATORIO
- **CD-1:** El plan del LLM se ejecuta tal cual tras slug-check (`:701-703`) + budget-fit (`:719-726`) + `allStepsAreDemos` (`:830-832`). Ningún guard de relevancia per-step corre sobre él.
- **CD-4:** Preservar never-empty: `steps.length > 0` cuando el LLM produjo plan y pasó budget-fit. No introducir ningún path que vacíe el plan LLM.
- **CD-5 (money-safe):** `plannedCostUsd`/débito step-0 proviene EXCLUSIVAMENTE del cálculo en `:755-761`. Ningún recompute posterior debe alterarlo. **Débito == ejecución.**
- **CD-6:** Actualizar T-152-1/T-152-4/T-163-4 de forma DELIBERADA — documentar en el commit/PR que la conducta vieja (drop) ya no aplica. No borrarlos en silencio ni romperlos sin constancia.
- **CD-Multilingüe:** Un goal ES vs agentes EN (0 overlap léxico) SHALL conservarse completo — antes era el caso especial "all-disjoint ⇒ conserve"; ahora es el comportamiento universal.

### PROHIBIDO
- **CD-2:** modificar `fallbackNoRelevance` / `greedyPlan()` (verificar con `git diff`, no solo tests verdes).
- **CD-3:** modificar `allStepsAreDemos` (`:830-832`).
- **CD-7:** tocar planner prompt (`llmPlan`), `discovery.ts`, fee/split.
- **CD-10:** remover/renombrar/cambiar firma de `tokenizeForRelevance`/`textOverlapsGoal`.
- **CD-11:** agregar el smart-drop semántico (es WKH-160).
- **CD-12:** expandir el diff más allá de los 3 bloques + comment hygiene + 3 tests.

### Auto-Blindaje (heredado — auto-blindaje WKH-114)
- **CD-8:** Con `noUncheckedIndexedAccess` activo, todo `ARRAY[i]` es `T | undefined`. Al remover los bloques NO deben quedar accesos colgantes a `steps[...]`/`relevantSteps[...]`. Verificar por grep.
- **CD-9:** Correr `biome check` tras la remoción — eliminar wiring puede dejar variables/imports sin usar (`noUnusedVariables`). Confirmar que `goalTokens` sigue usada (por `fallbackNoRelevance`) y que `tokenizeForRelevance`/`textOverlapsGoal` (exportadas) no disparan warning.

---

## 4. Wave 0 — Neutralización + billing (serial gate)

### W0.1 — Remover `llmGoalTokens` (`:852-859`), CONSERVAR `goalTokens` (`:851`)

**REMOVER** este bloque (comentario WKH-163 + la declaración `llmGoalTokens`):

```ts
    // WKH-163: tokens de relevancia para el backstop LLM SIN los puramente numéricos.
    // Un monto (p.ej. "400") es señal de relevancia casi universal en agentes financieros
    // y su echo en el input tailoreado dropeaba injustamente la pata de entrega
    // (agentshop-cashout-matcher) del plan insignia de remesas. goalTokens (greedy +
    // reasoning no_relevant_agent) queda INTACTO; el cambio se aísla al path LLM.
    const llmGoalTokens = new Set(
      [...goalTokens].filter((t) => !/^\d+$/.test(t)),
    );
```

**CONSERVAR** intacta la línea inmediatamente anterior (NO la borres):

```ts
    const goalTokens = tokenizeForRelevance(goal);
```

### W0.2 — Remover el backstop LLM completo (`:877-935`)

**REMOVER** desde el comentario `// WKH-152 (MIXED-PLAN-ONLY, enmienda 2026-07-07): per-step relevance backstop`
hasta la línea `const llmDropped = ...` inclusive. Es decir, el bloque completo que contiene:

- El comentario de diseño WKH-152 MIXED-PLAN-ONLY (`:877-892`).
- `const llmFilterApplies = !usedFallback && !allStepsAreDemos && llmGoalTokens.size > 0;` (`:893-894`).
- `let relevantSteps = steps;` + el `if (llmFilterApplies) { relevantSteps = steps.filter(...) }` (`:896-906`).
- El terminal-guard WKH-163 (`if (llmFilterApplies && relevantSteps.length > 0 && relevantSteps.length < steps.length) { ... }`) (`:907-927`).
- `const applyDrop = ...` (`:928-934`) + `const llmDropped = ...` (`:935`).

La línea que queda ANTES es el cierre `}));` de `fallbackNoRelevance` (`:875`).
La línea que queda DESPUÉS es `if (allStepsAreDemos || fallbackNoRelevance) {` (`:937`) — **NO se toca**.

### W0.3 — Remover el recompute de billing post-drop (`:1007-1024`)

**REMOVER** este bloque completo (comentario WKH-152 + el `if (applyDrop) { ... }`):

```ts
    // WKH-152 (MIXED-PLAN-ONLY): caso MIXTO — sobrevivió un subset
    // (0 < relevantSteps.length < steps.length ⇒ applyDrop). Reasignamos `steps`
    // reindexando `passOutput` por construcción (el primer sobreviviente pasa a
    // passOutput:false → usa su propio input; sin cirugía de off-by-one) y
    // recomputamos plannedCostUsd/step-0 con el MISMO resolver registry-aware de
    // :707-713 para que débito == ejecución (AC-4). El billing 1..N
    // (costPerStep/totalCostUsdc/protocolFeeUsdc) se recalcula abajo POR CONSTRUCCIÓN
    // sobre el `steps` reasignado. applyDrop === false (todo-relevante O todo-disjunto)
    // ⇒ no-op → `steps` intacto → billing byte-idéntico a sin-filtro (AC-2/AC-3).
    if (applyDrop) {
      steps = relevantSteps.map((s, i) => ({ ...s, passOutput: i > 0 }));
      const step0 = steps[0]; // CD-8: ComposeStep | undefined
      const step0Price = step0
        ? await resolveAgentPriceUsdc(step0.agent, step0.registry)
        : null;
      plannedCostUsd = step0Price ?? 0;
      reasoning += ` (${llmDropped} off-topic agent(s) dropped by relevance backstop)`;
    }
```

La línea que queda ANTES es el cierre `}` del early-return (`:1005`).
La línea que queda DESPUÉS es `// AC8: Check time again before compose` (`:1026`) — **NO se toca**.

> **Verificación money-safe (por qué esto es correcto — §4.4 del SDD):** `plannedCostUsd`
> se setea UNA vez en `:761` (`= step0Price ?? 0`, precio del step-0 ORIGINAL del LLM).
> Al remover `:1016-1022` nada muta `plannedCostUsd` después de `:761` → AC-6. `steps` se
> arma UNA vez en `:728-738` con `passOutput: index>0`; al remover `:1017` no hay
> reasignación → `steps` = plan completo del LLM. El recompute final `:1040-1059` itera la
> variable `steps` → hereda el fix por construcción, **sin cambios**.

### W0.4 — Comment hygiene (parte del cambio, NO opcional)

Ajustar/recortar los comentarios que describen un backstop que **deja de existir** (dejar
comentarios que mienten sobre el código confunde al próximo lector y a WKH-160). SOLO
comentarios, cero cambio de lógica:

1. **`:344-353`** (bloque de diseño arriba de `tokenizeForRelevance`) — la frase
   `pero desde WKH-152 tiene además un backstop léxico determinístico PER-STEP
   (MIXED-PLAN-ONLY) sobre el plan del LLM — ver ':872' y el comentario de diseño de
   ':806-819' — que dropea sólo los steps sin overlap alguno con el goal...` describe el
   backstop removido. Recortar a reflejar que el path LLM es autoritativo (drop léxico
   removido en WKH-166; smart-drop semántico vuelve con WKH-160).
2. **JSDoc de `textOverlapsGoal`** (`:365-371`) — la nota `el path LLM cortocircuita ANTES
   con el guard CD-14 y NO delega el caso vacío acá` referencia el guard removido. Ajustar:
   la función queda INERTE respecto al path LLM (hook WKH-160), aún consumida por T-152-8.
3. **`:842-856`** (dentro del bloque explicativo de `fallbackNoRelevance`) — la nota WKH-152
   `Por eso, abajo, se agrega un backstop determinístico PER-STEP (no todo-o-nada)...`
   describe código que ya no existe. Recortar a que `fallbackNoRelevance` es el único guard
   de relevancia (greedy-only) y el plan LLM es autoritativo.
4. **`:820-829`** (nota de `allStepsAreDemos`) — si hay referencia al backstop LLM, alinear;
   si solo describe `allStepsAreDemos` (que permanece), dejar como está.

### W0.5 — Verificación W0 (gate)

- `npx tsc --noEmit` → **0 errores** (CD-8: sin accesos colgantes).
- `./node_modules/.bin/biome check --write src/` → **0 warnings** (CD-9).
- `grep` confirmando que NO quedan referencias colgantes a: `relevantSteps`, `llmDropped`,
  `llmGoalTokens`, `applyDrop`, `llmFilterApplies`. (Todas vivían dentro de los 3 bloques removidos.)
- `grep` confirmando que `goalTokens`, `tokenizeForRelevance`, `textOverlapsGoal` **siguen presentes y usadas/exportadas**.

---

## 5. Wave tests — Reescritura EXACTA de los 3 tests (cambio de conducta INTENCIONAL)

> Framework: **vitest**. Fixtures NO se tocan (`wkh152Agents` `:2080-2103`, `wkh152GetAgent`
> `:2111-2115`, `wkh163TerminalAgents` `:2707-2741`). Solo cambian el cuerpo del `it(...)`,
> el nombre del test y su comentario de encabezado.

### Wt.1 — T-152-1 (`:2117-2162`) → mixed plan conservado completo

Fixture: `weather-v1` (0.4), `defi-sentiment-v1` (0.7). LLM selecciona ambos; step-0 = weather.
El goal (`What is the weather forecast today`) matchea weather, defi es léxicamente disjunto.

**Reemplazar el comentario + el nombre + los últimos 3 asserts.** Nombre nuevo:
`T-152-1: mixed plan is conserved in full — LLM plan is authoritative (WKH-166)`.

Asserts NUEVOS (reemplazan `:2158-2161`):

```ts
    expect(vi.mocked(composeService.compose)).toHaveBeenCalledTimes(1);
    const composeCall = vi.mocked(composeService.compose).mock.calls[0]![0]!;
    expect(composeCall.steps.map((s) => s.agent)).toEqual([
      'weather-v1',
      'defi-sentiment-v1',
    ]);
    // Débito == step-0 ORIGINAL del LLM (weather = 0.4), sin reprice.
    expect(vi.mocked(budgetService.debit)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(budgetService.debit).mock.calls[0]![2]).toBeCloseTo(
      0.4,
      6,
    );
    expect(result.reasoning).not.toContain('dropped');
```

> Eliminá el `expect(composedSlugs).not.toContain('defi-sentiment-v1')` y el
> `expect(result.reasoning).toContain('dropped')` — aseveraban la conducta vieja.

### Wt.2 — T-152-4 (`:2337-2380`) → débito == step-0 ORIGINAL (sin reprice)

Fixture idéntico. LLM pone el agente léxicamente disjunto (`defi-sentiment-v1`, 0.7) PRIMERO
(step-0) y `weather-v1` (0.4) segundo. Conducta NUEVA: NO hay drop, NO hay reprice → el
débito es el precio del step-0 ORIGINAL = **0.7** (defi), y defi queda de head con `passOutput:false`.

**Reemplazar el comentario + el nombre + los asserts.** Nombre nuevo:
`T-152-4: step-0 debit == original LLM head price regardless of lexical relevance (WKH-166)`.

Asserts NUEVOS (reemplazan `:2373-2379`):

```ts
    // Débito == precio del step-0 ORIGINAL del LLM (defi-sentiment-v1 = 0.7), SIN reprice.
    expect(vi.mocked(budgetService.debit)).toHaveBeenCalledTimes(1);
    const debitAmount = vi.mocked(budgetService.debit).mock.calls[0]![2];
    expect(debitAmount).toBeCloseTo(0.7, 6);
    const composeCall = vi.mocked(composeService.compose).mock.calls[0]![0]!;
    expect(composeCall.steps.map((s) => s.agent)).toEqual([
      'defi-sentiment-v1',
      'weather-v1',
    ]);
    expect(composeCall.steps[0]!.agent).toBe('defi-sentiment-v1');
    expect(composeCall.steps[0]!.passOutput).toBe(false);
```

> Cambio clave vs la versión vieja: `debitAmount` pasa de `0.4` a **`0.7`** y el head pasa
> de `weather-v1` a `defi-sentiment-v1`. Esto pinnea AC-6 (débito == step-0 original).

### Wt.3 — T-163-4 (`:2748-2808`) → plan multi-leg de 3 steps conservado completo

Fixture `wkh163TerminalAgents`: `wkh163-weather` (0.4) / `wkh163-defi` (0.5) /
`wkh163-translator` (0.6). LLM selecciona los 3 en ese orden; goal `weather forecast today`
matchea weather, defi y translator son léxicamente disjuntos. Conducta NUEVA: los 3 se
conservan (terminal-guard removido), sin drop, débito = step-0 = weather (0.4). Pinnea
AC-3/AC-8 en la forma ≥3-step que T-152-1 (2 steps) no cubre.

**Reemplazar el comentario + el nombre + los asserts.** Nombre nuevo:
`T-163-4: multi-leg LLM plan conserved in full (terminal-guard removed — WKH-166)`.

Asserts NUEVOS (reemplazan `:2795-2807`):

```ts
    expect(vi.mocked(composeService.compose)).toHaveBeenCalledTimes(1);
    const composeCall = vi.mocked(composeService.compose).mock.calls[0]![0]!;
    expect(composeCall.steps.map((s) => s.agent)).toEqual([
      'wkh163-weather',
      'wkh163-defi',
      'wkh163-translator',
    ]);
    expect(result.reasoning).not.toContain('dropped');
    // Débito == step-0 original (weather = 0.4).
    expect(vi.mocked(budgetService.debit)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(budgetService.debit).mock.calls[0]![2]).toBeCloseTo(
      0.4,
      6,
    );
```

> Eliminá `expect(result.reasoning).toContain('dropped')` y
> `expect(result.reasoning).toContain('1 off-topic')` — aseveraban el terminal-guard removido.
> El array de steps pasa de `['wkh163-weather','wkh163-translator']` (2, defi dropeado) a los
> **3 completos** en orden original.

---

## 6. Tests PRESERVADOS (NO tocar — deben seguir VERDES)

| Test | Línea | Por qué sigue verde |
|------|-------|---------------------|
| T-152-2 | `:2170` | Ya asevera conserve-all (all-disjoint); ahora es universal — mismo assert pasa. |
| T-152-2b | `:2230` | Multilingüe ES vs EN conserve-all; era all-disjoint, ahora universal. |
| T-152-3 | `:2313` | All-relevant → sin drop; siempre pasó (nunca hubo drop que aplicar). |
| T-152-5 | `:2385` | "not dropped" desde input tokens; sigue cierto (el drop ya no se evalúa). |
| T-152-5b | `:2440` | Zero-token goal → conservado; sigue cierto. |
| T-152-6 | `:2473` | `no_relevant_agent` por `allStepsAreDemos` (NO el bloque removido) — intacto. |
| T-152-8 | `:2521` | `textOverlapsGoal` pura — función conservada INERTE + exportada (CD-10). |
| T-163-1 | `:2616` | Remesa insignia EN, 3 steps intactos, débito 0.5 — ya conservaba. |
| T-163-2 | `:2648` | Remesa insignia ES, 3 steps intactos, débito 0.5 — language-independent, ya conservaba. |
| T-163-3 | `:2680` | Numeric-only goal → 3 steps conservados (razón ahora vacua, aserción sigue verdadera). |
| Suite WKH-158 (`T-158-*`) | `:3690` | Retry greedy path — fuera de scope. |
| Suite WKH-159 (`T-W159*`) | `:1989` | Greedy — fuera de scope. |
| T-W5a/b/c, T-W6 | — | Fallback relevance guard genuino (greedy, `usedFallback===true`). |
| Suite WKH-151 (`T-WKH151-*`) | — | Discovery broaden-retry — `discovery.ts` no se toca. |
| Suites WKH-114 / WKH-132 / WKH-131 | — | No dependen del drop léxico. |

---

## 7. Patrones a seguir (exemplars verificados)

- **Reescritura T-152-1** → seguir forma de **T-152-2** (`:2170-2223`, conserve-all): `composeCall.steps.map(s=>s.agent)).toEqual([...])` + débito step-0 original + `not.toContain('dropped')`.
- **Reescritura T-152-4** → seguir forma de **T-152-3** (`:2313-2335`, head sin drop) + assert de débito de T-152-2 (`:2217-2221`, `budgetService.debit.mock.calls[0]![2]`).
- **Reescritura T-163-4** → seguir forma de **T-163-1** (`:2616-2644`, 3 steps intactos + débito por `.mock.calls[0]![2]`).
- **Remoción de los bloques de producción** → confirmar la frontera del diff contra `fallbackNoRelevance` (`:860-875`, permanece) — es la línea que queda ANTES del bloque removido en W0.2.

> Todos los `.mock.calls[0]![2]` usan `![...]` non-null assertion (patrón vigente del archivo
> bajo `noUncheckedIndexedAccess`). Mantené ese estilo — NO introduzcas `?.` que dispare biome.

---

## 8. Gate de cierre F3 (con números reales)

Ejecutar EN ORDEN y reportar la salida real:

1. `npx tsc --noEmit` → **0 errores**.
2. `./node_modules/.bin/biome check --write src/` → **0 warnings / 0 errors** (biome inline; `noUnusedVariables`, `noUncheckedIndexedAccess`).
3. `npm test` (o `npx vitest run src/services/orchestrate.test.ts`) →
   - Los **3 reescritos** VERDES: T-152-1, T-152-4, T-163-4.
   - Los **preservados** VERDES sin tocar (T-152-2/2b/3/5/5b/6/8, T-163-1/2/3, suites WKH-158/159/151/114/132/131).
   - Suite **full** verde.
4. `git diff` confirma que `greedyPlan()`, `fallbackNoRelevance`, `allStepsAreDemos` son **byte-idénticos** (CD-2/CD-3) — no basta con "tests verdes".

Reportá los números reales (X passed / Y total, 0 errors tsc, 0 warnings biome). Sin números, el gate no cuenta.

---

## 9. Definition of Done

- [ ] **AC-1** — `send money to Peru via the best option` con plan LLM de 3 agentes → los 3 se ejecutan y cobran; `agentshop-kyc-validator` NO dropeado por "best". (cubre T-152-1 reescrito + repro founder)
- [ ] **AC-2** — remesa insignia `Send $400 to my mom in Peru` (EN/ES) → 3 steps, byte-idéntico en `composedSlugs` vs WKH-163. (T-163-1, T-163-2 preservados)
- [ ] **AC-3** — `usedFallback===false` + plan mixto → ejecutado EXACTAMENTE como lo devolvió el LLM (sin drop, sin terminal-guard, sin `'dropped'`/`'off-topic'`). (T-152-1, T-163-4 reescritos)
- [ ] **AC-4** — goal multilingüe + agentes reales → `planStatus:'ready'` con todos los steps intactos. (T-152-2b preservado)
- [ ] **AC-5** — NUNCA `steps: []` para plan LLM que pasó budget-fit (never-empty). (T-152-2/2b/3)
- [ ] **AC-6** — plan LLM `ready` → debita exactamente el precio del step-0 ORIGINAL (`:755-761`), sin reprice. (T-152-4 reescrito = 0.7 + T-152-1 = 0.4)
- [ ] **AC-7** — LLM falla / breaker abierto → `greedyPlan()` byte-idéntico. (`git diff` + suites greedy preservadas)
- [ ] **AC-8** — agente real off-topic en plan LLM → ejecutado y cobrado con el resto (conducta NUEVA). (T-152-1, T-163-4 reescritos)
- [ ] `tsc --noEmit` 0 + `biome check` 0 + suite full verde (§8).
- [ ] CD-6: commit/PR documenta explícitamente que T-152-1/T-152-4/T-163-4 cambian de conducta deliberadamente (drop léxico eliminado, plan LLM autoritativo).

---

## 10. Nota de merge (crítica)

**WKH-166 mergea ANTES que WKH-160** (`feat/163-wkh-160-semantic-embeddings-relevance`,
`in progress`). Ambas tocan el MISMO bloque de `orchestrate.ts` (`:851-935`) — conflicto de
merge garantizado. Resolución: WKH-160 **rebasa sobre el estado ya reducido** por WKH-166 y
re-engancha su scorer semántico en el hook point (entre el early-return `no_relevant_agent`
`:1005` y el check de timeout `:1026`), reusando `tokenizeForRelevance`/`textOverlapsGoal`
como fallback léxico obligatorio. No avanzar WKH-160 a F2/F3 hasta que WKH-166 esté mergeado.

---

*Story File generado por NexusAgil — F2.5 (Architect) — WKH-166 — QUALITY*
