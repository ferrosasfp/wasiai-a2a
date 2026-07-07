# Auto-Blindaje — WKH-152 (Planner LLM per-step relevance guard)

### [2026-07-07 10:30] Wave 2 — El filtro per-step vacía planes de goals terse → 35 tests money-path preexistentes rojos

- **Error**: Tras implementar el filtro EXACTAMENTE como lo especifica el Story File
  (§5 predicado + AC-2 "filtro vacía el array → `no_relevant_agent`"), la suite
  `orchestrate.test.ts` pasó de 94 verdes a 67 verdes / 35 rojos. Los 8 tests nuevos
  T-152-* pasan; los 35 que rompen son tests PREEXISTENTES de billing/fee/refund/
  chainId (T-5, T-7, T-11, T-12, T-14..T-26, T-AC1..T-AC11, T-H1a..T-H1e, T-AC-DOUBLE,
  T-PLAN-2, AC-1, MNR-1, T-WKH151-1/2, WKH-114-regression).
- **Causa raíz**: NO es un bug de implementación — el filtro corre AS SPECIFIED. Es
  la CONSECUENCIA DE DISEÑO del predicado §5 + AC-2 aplicado al path LLM
  incondicionalmente (gate CD-13/CD-14). El predicado dropea un step si su corpus
  (`name+description+capabilities+JSON.stringify(input)`) comparte CERO tokens ≥3 chars
  con `goalTokens`. Los 35 tests usan goals PLACEHOLDER lexicalmente disjuntos de los
  agentes mock:
    - T-21 `goal:'master multi-step'` vs Summarizer/Translator corpus
      (`summarizer summarizes text documents ... {"query":"step0"}`) → 0 overlap
      (`step` ≠ `step0`). Plan queda vacío → `no_relevant_agent` → compose NO se llama.
    - T-AC1 `goal:'real price'`, T-AC-DOUBLE `goal:'single refund'`, T-5
      `goal:'test slug validation'` — mismo mecanismo.
  Como el plan queda vacío, se dispara el early-return `no_relevant_agent` (AC-2): cero
  debit, cero compose → las aserciones de billing/fee/chainId de esos tests fallan.
- **Fix**: NO aplicado unilateralmente. Hay dos caminos y AMBOS exceden la autoridad
  del Dev en money-path:
    1. **Alinear los 35 fixtures** (cambiar sus goals para que compartan ≥1 token con
       el corpus del agente, p.ej. incluir `text`). Deja la suite verde PERO enmascara
       el riesgo de producción (ver abajo) ante los gates AR/CR humanos.
    2. **Ajustar el diseño del filtro** (requiere sign-off del Architect): que el filtro
       NUNCA vacíe un plan — dropear steps irrelevantes SOLO cuando sobrevive ≥1 step
       relevante (mixed-plan-only); si TODOS los steps son disjuntos, conservar todo
       (tratar "sin señal léxica en NINGÚN step" igual que CD-14: confiar en el juicio
       semántico del LLM). Esto **CONTRADICE AC-2 y T-152-2** → decisión de spec.
  Se dejó el código FIEL al Story File (35 rojos) para que AR/CR vean el comportamiento
  aprobado y decidan. Reportado al orquestador como BLOQUEANTE.
- **Aplicar en**: Riesgo de PRODUCCIÓN, no solo de tests. WasiAI es LATAM/multilingüe:
  un goal en español ("cotiza el clima") contra un agente descripto en inglés
  ("weather forecast") comparte 0 tokens → el filtro devuelve `no_relevant_agent` aunque
  el LLM haya matcheado correctamente. Igual con sinónimos ("resume" vs "summarizer").
  Esto es un FALSE-NEGATIVE — exactamente lo que el propio Story File (§3) declara
  "PEOR que over-charge". Los 35 tests rojos son el mensajero de ese riesgo; silenciarlos
  reescribiendo fixtures lo ocultaría a los humanos en el gate.

### [2026-07-07 11:12] re-F3 delta — MIXED-PLAN-ONLY: el filtro NUNCA vacía un plan (enmienda del humano)

- **Error**: El AC-2 original ("filtro vacía el plan ⇒ `no_relevant_agent`") rompía 35
  tests money-path por false-negatives multilingües/vocabulario (entrada anterior). El
  humano ratificó el camino #2 de esa entrada (mixed-plan-only) como decisión de spec.
- **Causa raíz**: el overlap léxico binario asume que "0 tokens en común ⇒ irrelevante",
  premisa FALSA bajo multilingüismo (goal español vs. agente inglés) — el caso común en
  WasiAI LATAM, no el borde. Vaciar el plan por señal léxica ausente es rechazar trabajo
  válido que el LLM eligió bien.
- **Fix (delta aplicado sobre el F3 previo)**:
    1. `orchestrate.ts`: reemplacé el gate del drop. Antes: `llmFilterEmptied =
       llmFilterApplies && relevantSteps.length === 0` (ruteaba a `no_relevant_agent`) +
       drop gateado por `llmDropped > 0`. Ahora:
       `applyDrop = llmFilterApplies && relevantSteps.length > 0 && relevantSteps.length
       < steps.length` (solo plan mixto). `relevantSteps.length === 0` ⇒ applyDrop false
       ⇒ conservar todos (no-op). El drop+recompute quedó gateado por `if (applyDrop)`.
    2. Quité el disyunto `|| llmFilterEmptied` del early-return: `if (allStepsAreDemos ||
       fallbackNoRelevance)` — vuelve a ser EXCLUSIVO de all-demos/greedy. Borré la rama
       `else if (llmFilterEmptied)` del `reasoning`.
    3. Tests: T-152-2 reconvertido de "all-irrelevant ⇒ no_relevant_agent" a
       "all-disjoint ⇒ conserva TODOS" (goal disjunto de ambos agentes, ambos ejecutan,
       step-0 debit intacto). T-152-2b NUEVO: goal español + agentes inglés (0 overlap)
       ⇒ conserva todos (lockea el false-negative multilingüe).
- **Resultado**: 35 money-path tests recuperados SIN editarlos (goals all-disjunto ⇒
  no-op ⇒ billing byte-idéntico). Suite completa: orchestrate.test.ts 90 + billing 13 =
  103 verde; baseline total 2788 verde, 0 rojo.
- **Aplicar en**: cualquier filtro determinístico sobre planes multilingües money-path —
  NUNCA vaciar por señal léxica ausente; confiar en el juicio del LLM salvo evidencia
  POSITIVA corroborada (≥1 match dentro del mismo plan). El "conservar ante duda" del
  gate HU se traduce en: dropear solo cuando la señal léxica se corrobora.
