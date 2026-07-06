# Work Item — [WKH-114] AC verificables + verificación de completitud por step en /orchestrate y /compose

## Resumen

Hoy `/orchestrate` y `/compose` reportan `success: boolean` por pipeline pero
ningún step tiene una "definition of done" objetiva — el output de un agente
se acepta a ciegas si el HTTP fue 2xx. Esta HU adjunta acceptance criteria (AC)
explícitos a cada step en plan-time y evalúa el output del agente contra ellos
en execute-time, exponiendo un veredicto pass/fail/unverified por step en la
respuesta — sin tocar billing/débito. Es la versión a-nivel-de-código del gap
visto en el incidente 2026-07-05 (Chaski: un step devolvió 200-ok sin haber
hecho el trabajo real); WKH-71/74/77 lo cazan DESDE AFUERA (monitoreo externo
post-hoc), esta HU hace que el orquestador MISMO verifique la completitud de
cada step en el momento de ejecutarlo.

## Sizing

- SDD_MODE: full (QUALITY — fijado por el ticket, toca payment/orchestrate surface)
- Estimación: M
- Branch sugerido: `feat/152-wkh-114-verifiable-step-ac`
- Waves sugeridas para F3 (a confirmar/ajustar por el Architect en F2/F2.5):
  - **Wave 1**: types additive-only (`ComposeStep.acceptanceCriteria?`,
    `StepResult.acceptance?`) + helper de verificación determinística
    (rules-first, sin LLM) + wiring en `compose.ts` (post-`invokeAgent`,
    antes de `finishSuccessfulStep`). Standalone-testeable, sin tocar
    `orchestrate.ts`.
  - **Wave 2**: wiring en `orchestrate.ts` — `llmPlan` emite 2-4 AC por step
    en el MISMO prompt/call del planner (sin call LLM adicional) + campo de
    completitud a nivel pipeline (additive, separado de `pipeline.success`).
  - **Wave 3** (opt-in, solo si el Architect la aprueba en F2): rama
    LLM-judge para AC ambiguos que las reglas no pueden decidir, reusando
    `src/services/llm/models.ts` (CD-2), timeout corto, fallback a
    `unverified` en error/timeout (nunca bloquea el pipeline).

## Acceptance Criteria (EARS)

- **AC-1**: WHEN el planner (LLM o greedy fallback) produce los steps del
  pipeline, the system SHALL adjuntar a cada step una lista explícita y no
  vacía de acceptance criteria antes de que `compose` lo ejecute.
- **AC-2**: WHEN el agente de un step devuelve output (2xx), the system SHALL
  evaluar ese output contra los acceptance criteria del step y SHALL producir
  un veredicto de `'pass'`, `'fail'` o `'unverified'` (unverified = la
  verificación no pudo correr — sin criterios adjuntos, error del verificador,
  o timeout).
- **AC-3**: IF el veredicto de un step es `'fail'`, THEN the system SHALL
  marcar ese step como NO-completado en la respuesta Y SHALL incluir el/los
  criterio(s) específico(s) que fallaron — la respuesta NO SHALL reportar el
  step como exitoso por omisión (sin fail silencioso).
- **AC-4**: WHERE `/orchestrate` o `/compose` devuelve la respuesta del
  pipeline, the system SHALL incluir, por cada step, sus acceptance criteria
  evaluados y su veredicto como campo(s) ADITIVO(S) en `StepResult` — el shape
  existente (`agent`, `output`, `costUsdc`, `latencyMs`, `txHash`, ...) SHALL
  permanecer sin cambios de tipo/nombre/semántica.
- **AC-5**: WHEN todos los steps del pipeline tienen veredicto `'pass'`, the
  system SHALL exponer un indicador de completitud a nivel pipeline (ej.
  `verificationStatus: 'verified'`) DISTINTO y ADITIVO respecto de
  `pipeline.success` (boolean) — SIN alterar el tipo ni la semántica actual de
  `pipeline.success`.
- **AC-6** (unwanted/guard): IF un step falla sus acceptance criteria, THEN
  the system SHALL NOT modificar la lógica de débito/refund/billing de ese
  step en base ÚNICAMENTE al veredicto de AC — el fail se expone en la
  respuesta pero el money-path (débito per-step, refund, protocol fee) queda
  intacto en esta HU (cambios de billing por AC-fail son una HU futura, fuera
  de este scope).
- **AC-7** [NEEDS CLARIFICATION — no bloqueante, propuesta abajo]: WHERE el
  origen de un AC es LLM-generado (plan-time o judge de verificación), the
  system SHALL usar el módulo centralizado `src/services/llm/models.ts`
  (`getPlannerModel`/`getComplexModel`/`getTrivialModel`/`getLlmTimeoutMs`/
  getters de `max_tokens`) — PROHIBIDO hardcodear model id/timeout/max_tokens
  literal (mismo criterio WKH-135).

## Scope IN

- `src/services/orchestrate.ts` — `llmPlan` (emitir AC por step en el mismo
  call del planner), `planOrchestration`/`executeApprovedPlan` (propagar AC +
  veredicto al `OrchestrateResult`).
- `src/services/compose.ts` — `compose()` / `finishSuccessfulStep()` (correr
  la verificación post-`invokeAgent`, adjuntar veredicto al `StepResult`).
- `src/types/index.ts` — extensiones additive-only: `ComposeStep`,
  `StepResult`, `ComposeResult`, `OrchestrateResult`, `OrchestratePlanResult`.
- Helper nuevo de verificación (rules-first, ubicación a decidir por el
  Architect en F2 — ej. `src/services/verification.ts` o similar), incluyendo
  la rama LLM-judge opt-in (Wave 3) si se aprueba.
- Tests unitarios/integración de lo anterior.

## Scope OUT

- Rediseño de framework LLM-judge genérico / motor de reglas reusable
  cross-dominio — v1 acotado a AC de step en compose/orchestrate.
- UI / dashboard para visualizar veredictos (queda en la respuesta JSON;
  consumo por UI es HU futura).
- Cualquier cambio de billing/débito/refund/protocol fee condicionado por el
  veredicto de AC (ver AC-6/CD-1). Explícitamente WKH-93/127 son las HUs de
  billing existentes; esta HU no las reabre.
- Persistencia del veredicto en DB/`a2a_events` para analytics/reputación —
  v1 vive solo en la respuesta HTTP (stateless). Ver Missing Inputs #3.
- El retry adaptativo de input (WKH-130) NO se dispara por un AC-fail — solo
  por field-errors HTTP parseables, sin cambios en esta HU.

## Decisiones técnicas (DT-N)

- **DT-1 (origen del AC)** — propuesta HÍBRIDA por default: (a) LLM-generado
  en plan-time: el mismo prompt/call de `llmPlan` en `orchestrate.ts` (que ya
  genera `input`+`reasoning` por step) se extiende para emitir 2-4 AC
  concretos y verificables por step — SIN una call LLM adicional (costo/latencia
  cero incremental sobre el planner ya existente); (b) caller-provided
  opcional: `ComposeStep.acceptanceCriteria` es un campo aditivo que un caller
  de `/compose` manual (sin planner) puede poblar directamente; (c) fallback
  greedy (sin LLM, `greedyPlan`) genera AC genéricos determinísticos (ej.
  "output no vacío", "sin campo de error") para no dejar steps sin AC cuando
  el planner LLM falló. El Architect decide el detalle exacto de las reglas
  del fallback en F2.
- **DT-2 (método de verificación)** — propuesta HÍBRIDA rules-first + LLM-judge
  SOLO si ambiguo, mismo patrón ya usado en el codebase por el árbitro de
  disputas WKH-139 v2 (`src/types/arbiter.ts`: `ArbiterMethod = 'rules' |
  'llm' | 'hold'`, "LLM SOLO para casos genuinamente ambiguos, nunca como
  ejecutor de fondos"). Reglas determinísticas primero (output no vacío, sin
  campo `error`/`null`, shape esperado si el AC es estructurable) — 0 costo/0
  latencia extra, cubre la mayoría de los AC en la práctica. Solo cuando las
  reglas no pueden decidir (AC semántico/subjetivo) se dispara 1 LLM-judge
  call vía Haiku (`getTrivialModel()`) reusando `llm/models.ts` (CD-2).
- **DT-3 (presupuesto costo/latencia)** — la verificación es best-effort y NO
  bloqueante del critical path: no agrega retry loops de invocación, y el
  LLM-judge (si Wave 3 se aprueba) corre con un timeout corto y SIN retry —
  en error/timeout el veredicto cae a `'unverified'` (nunca bloquea ni falla
  el pipeline por sí solo). v1 es señal de observability/completeness, NO gate
  de ejecución del pipeline (alineado con CD-1: no billing).
- **DT-4 (shape additive-only)** — NO se sobrecarga `pipeline.success`
  (boolean, contrato externo probado byte-a-byte en tests existentes,
  ej. `orchestrate.test.ts:557`). El indicador de completitud vive en un
  campo NUEVO y opcional (ej. `verificationStatus`), y el veredicto por step
  vive en un campo NUEVO y opcional dentro de `StepResult` — ningún campo
  existente cambia de tipo/nombre/semántica.
- **DT-5 (consistencia de nomenclatura)** — reusar el vocabulario ya
  establecido por el árbitro WKH-139 v2 para el campo `method` de
  verificación (`'rules' | 'llm' | 'none'`), en vez de inventar un vocabulario
  paralelo.

## Constraint Directives (CD-N)

- **CD-1**: PROHIBIDO que el veredicto de AC (pass/fail/unverified) modifique
  o gatee `budgetService.debit`/`credit`/`chargeProtocolFee`/`refundOutbox` o
  cualquier lógica de débito/refund/billing existente en `compose.ts` /
  `orchestrate.ts`. Un step que falla sus AC se expone en la respuesta pero
  NO cambia el cobro/refund en esta HU. **BLOQUEANTE** en AR/CR si se detecta
  un refund, skip de débito, o cualquier rama de billing condicionada por el
  veredicto de AC.
- **CD-2**: OBLIGATORIO reusar `src/services/llm/models.ts`
  (`getPlannerModel`/`getComplexModel`/`getTrivialModel`/`getInputRetryModel`/
  `getLlmTimeoutMs`/getters de `max_tokens`) para cualquier LLM-judge call que
  se agregue. PROHIBIDO hardcodear model id/timeout/max_tokens literal en el
  código de verificación (mismo criterio WKH-135). Si se necesita un nuevo
  getter (ej. `getVerifyMaxTokens`), debe agregarse a ese módulo siguiendo el
  mismo patrón (parse → validate range → fallback → `log.warn` → never throw).
- **CD-3**: OBLIGATORIO additive-only en `ComposeStep`, `StepResult`,
  `ComposeResult`, `OrchestrateResult`, `OrchestratePlanResult` — todos los
  campos nuevos son opcionales (`?:`). PROHIBIDO romper el contrato externo
  actual (tests de shape byte-idéntico existentes, ej.
  `orchestrate.test.ts:557`; convención CD-4/CD-9 ya usada en HUs previas de
  este repo para cambios de shape).
- **CD-4**: OBLIGATORIO preservar intacto el guard anti-double-debit `i > 0`
  (`compose.ts:197`) y todo el money-path existente. La verificación de AC
  vive en una capa aparte, DESPUÉS de `invokeAgent` y del manejo de
  éxito/error del step — NUNCA reemplaza el `try/catch` de invocación
  existente ni introduce una nueva vía de fallo que dispare refund.
- **CD-5**: PROHIBIDO que la verificación de AC dispare una segunda invocación
  del agente (`invokeAgent`) o interactúe con el retry adaptativo de input
  existente (WKH-130, gatillado SOLO por field-errors HTTP parseables). Un
  AC-fail se expone; NO reintenta la invocación en v1.

## Missing Inputs

- **[NEEDS CLARIFICATION — no bloqueante]** ¿Quién genera el AC cuando el
  caller invoca `/compose` directamente con steps manuales (sin pasar por el
  planner LLM de `/orchestrate`)? Propuesta (default si no hay respuesta):
  reglas determinísticas mínimas (output no vacío, sin campo `error`) —
  el Architect confirma el detalle en F2.
- **[NEEDS CLARIFICATION — no bloqueante]** ¿El LLM-judge (Wave 3) corre en
  `/compose` también, o SOLO en `/orchestrate` (que ya paga el costo de un
  LLM call en el planner)? Propuesta: Wave 3 queda detrás de un flag/decisión
  explícita del Architect — no forzar latencia extra en un `/compose` "plano"
  sin planner por default.
- **[NEEDS CLARIFICATION — no bloqueante]** ¿Se persiste el veredicto en DB
  (`a2a_events` o tabla nueva) para analytics/reputación futura, o queda
  solo en la respuesta HTTP? Propuesta v1 (menor scope, resuelta arriba en
  Scope OUT): solo en response; persistencia es HU separada si se necesita.

## Análisis de paralelismo

- No bloquea ninguna HU activa: la última fila DONE del `_INDEX.md` (151,
  WKH-74 synthetic monitoring) no toca `orchestrate.ts`/`compose.ts`/
  `types/index.ts`.
- Puede correr en paralelo con cualquier HU que no modifique esos 3 archivos.
  Si aparece otra HU que también toca `compose.ts`/`orchestrate.ts` en
  simultáneo, coordinar orden de merge para evitar conflictos (no hay
  dependencia funcional, solo de archivo).
- Relación con WKH-139 v2 (agente-árbitro, `src/types/arbiter.ts`): comparte
  el PATRÓN de diseño (rules-first, LLM solo para casos ambiguos, LLM nunca
  ejecuta acción crítica — ahí fondos, acá el pass/fail) pero NO comparte
  código ni tablas; son dominios distintos (disputas de payment-intent vs
  completitud de step de pipeline). Reusar el patrón, no el módulo.
- Relación con el tripode de observability (WKH-71/74/77, operator-wallet
  alert / on-call health / synthetic monitoring): complementario, sin
  dependencia de código. Esos son monitoreo EXTERNO y post-hoc (polling desde
  afuera del gateway); esta HU es verificación INTERNA y en el momento
  (server-side, dentro del propio call de compose/orchestrate). Ninguno
  bloquea al otro.
