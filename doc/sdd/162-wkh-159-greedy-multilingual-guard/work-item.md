# Work Item — [WKH-159] Greedy fallback multilingual false-negative (money-safe hardening)

## Resumen
El fallback greedy de `/orchestrate` (last-resort — se llega SOLO si `llmPlan()`
falla 2× tras el retry de WKH-158, si `plannerConfigured() === false`
`!ANTHROPIC_API_KEY`, o si el circuit breaker está abierto) todavía tiene un
false-negative multilingüe conocido: el guard léxico `fallbackNoRelevance`
(`src/services/orchestrate.ts:851-867`) hace hard-reject cuando NINGÚN token
del goal aparece en el corpus (`name+description+capabilities`) del agente
seleccionado por precio. Un goal en español contra agentes documentados en
inglés produce overlap=0 y el caller recibe `no_relevant_agent` sin cobrar,
aunque exista un agente realmente relevante en el candidate set. Es una
regresión de disponibilidad (UX), NO de plata — hoy el sistema es
CONSERVADOR (rechaza de más, nunca cobra de más). Esta HU evalúa si conviene
relajar ese rechazo y, si sí, en qué endpoint, sin introducir riesgo de
over-charge.

## Sizing
- SDD_MODE: full
- Estimación: S
- Branch sugerido: `fix/162-wkh-159-greedy-multilingual-guard`
- QUALITY (money-path): cualquier cambio al guard que decide si un step
  greedy se ejecuta/cobra toca directamente el mecanismo de débito post-plan
  (WKH-127/132) del endpoint atómico.

## F0 — Confirmación archivo:línea

### Los dos endpoints y CUÁNDO debitan (confirmado leyendo `orchestrate.ts` + `routes/orchestrate.ts`)

| Endpoint | Función service | Debita? | Dónde |
|---|---|---|---|
| `POST /orchestrate/plan` | `planOrchestration()` únicamente | **NUNCA** — cero debit, cero compose, cero settle (comentario explícito `routes/orchestrate.ts:159-160`, CD-1 de WKH-131) | N/A |
| `POST /orchestrate` (atómico) | `orchestrate()` → `planOrchestration()` y, SOLO SI `planStatus === 'ready'`, `executeApprovedPlan()` (`orchestrate.ts:435-441`) | **SÍ**, si el plan llegó a `ready` | `budgetService.debit(...)` en `executeApprovedPlan`, `orchestrate.ts:1181-1189`, guardado por `billsStep0 && request.scopingKeyRow && request.chainId !== undefined` (`:1165`) |
| `POST /orchestrate/execute` | `executeApprovedPlan()` directo, re-derivando el plan del cliente con `planStatus: 'ready'` FIJO (`routes/orchestrate.ts:397`) | **SÍ, siempre** — NUNCA pasa por `planOrchestration()`/el guard greedy; el caller ya aprobó los steps en un `/plan` previo | mismo `budgetService.debit(...)` de `:1181-1189` |

**Conclusión F0 (confirma la tensión del ticket):** el guard `fallbackNoRelevance`
corre ÚNICAMENTE dentro de `planOrchestration()`, que es compartida por
`/orchestrate/plan` (quote-only, jamás debita) y `/orchestrate` atómico (SÍ
debita, inmediatamente después, sin paso de confirmación intermedio). Relajar
el guard para que un plan greedy-sin-overlap pase a `ready` tiene **cero
riesgo** en `/plan` (solo se devuelve como quote) pero **riesgo directo de
over-charge** en el atómico (el mismo `planStatus: 'ready'` dispara el débito
del step-0 sin que nadie confirme que el agente price-selected es el correcto
para el goal). `/orchestrate/execute` es irrelevante al guard: el cliente ya
aprobó los steps explícitamente en un `/plan` previo, así que el guard nunca
corre ahí (no hay "false negative" que arreglar en ese endpoint).

### `greedyPlan()` (`orchestrate.ts:297-339`) — confirmado ciego al goal
Selecciona iterando `agents` en el orden del candidate set (post
`deprioritizeDemoAgents`, `:634`) y empuja el primero que entra en
`remaining` budget (`:306-310`). **Cero uso de `goal` en la selección** — el
único lugar donde `goal` aparece es el `input: { goal }` del step (`:316`),
no en el criterio de selección. Confirma el análisis F0 ya hecho por WKH-158
(preservado en `doc/sdd/161-wkh-158-greedy-relevance-guard/work-item.md`):
"la selección es 100% precio/orden de `candidateAgents`, ciega al contenido
del goal".

### `fallbackNoRelevance` (`orchestrate.ts:851-867`, no `:824-840` como decía el
ticket original — las líneas se corrieron por el backstop MIXED-PLAN-ONLY de
WKH-152, ya mergeado) — condición exacta del hard-reject
```ts
851  const goalTokens = tokenizeForRelevance(goal);
852  const fallbackNoRelevance =
853    usedFallback &&
854    (goalTokens.size === 0 ||
855      !steps.some((s) => {
856        const agent = discovered.agents.find(
857          (a) => a.slug === s.agent && a.registry === s.registry,
858        );
859        if (!agent) return false;
860        const agentTokens = tokenizeForRelevance(
861          `${agent.name} ${agent.description} ${agent.capabilities.join(' ')}`,
862        );
863        for (const token of goalTokens) {
864          if (agentTokens.has(token)) return true;
865        }
866        return false;
867      }));
```
Gatilla SOLO cuando `usedFallback === true` (i.e. ya estamos en el path
greedy, tras 2× fallo de `llmPlan()` o fallo permanente `!client`/
`CircuitOpenError`) Y ningún step seleccionado comparte ≥1 token (≥3 chars,
`tokenizeForRelevance`, `:356-363`) con el goal. `tokenizeForRelevance` no
hace ninguna normalización cross-lingüe (sin traducción, sin stemming) — un
goal 100% en español contra un corpus 100% en inglés produce
`agentTokens ∩ goalTokens = ∅` salvo coincidencias accidentales (números,
nombres propios, cognados).

### El early-return `no_relevant_agent` (`orchestrate.ts:908-958`, no `:881+`)
```ts
908  if (allStepsAreDemos || fallbackNoRelevance) {
     ...
918    const noRelevantResult: OrchestratePlanResult = {
919      orchestrationId,
920      planStatus: 'no_relevant_agent',
921      steps: [],
         ...
930    };
     ...
957    return noRelevantResult;
958  }
```
`steps: []` — el plan queda vacío ANTES de llegar al cálculo de
`costPerStep`/`totalCostUsdc`/`protocolFeeUsdc` (`:993-1012`) y ANTES de
`executeApprovedPlan`. Confirma: hoy el hard-reject es 100% previo al débito
— cero riesgo de plata en el estado ACTUAL. El riesgo aparece solo si esta HU
relaja el guard.

### El path LLM (WKH-152/158) — confirmado sin cambios necesarios
`llmPlan()` (`:162-293`), el retry de WKH-158 (`:674-696`) y el backstop
MIXED-PLAN-ONLY de WKH-152 (`:885-906`, antes `:842-879` según el ticket —
mismo corrimiento de líneas) corren en una rama de código completamente
separada (`usedFallback === false`). Esta HU no los toca (Scope OUT).

## Opciones evaluadas (money-safe)

- **(a) Conservar top-1 por precio cuando rechazaría todo.** DESCARTADA. Es
  exactamente la opción que el humano YA rechazó explícitamente para
  WKH-158 (mismo guard, mismo razonamiento: `greedyPlan()` no tiene ningún
  juicio semántico — conservar ahí es cobrar un agente elegido por precio
  que puede no matchear el goal en absoluto). Reintroducirla acá repetiría
  una decisión ya tomada por el humano en un ticket hermano.
- **(b) Low-confidence/advisory: no auto-debitar en el atómico.** Money-safe
  en el sentido estricto (cero over-charge), pero es un cambio de contrato
  MAYOR: el endpoint atómico `/orchestrate` prometería "plan+execute en una
  sola llamada" y dejaría de cumplirlo en este caso — necesitaría un campo
  nuevo (`requiresConfirmation`) y, para ser útil, un mecanismo de
  confirmación que hoy NO existe fuera de `/orchestrate/execute` (que exige
  un `/plan` previo). Construir eso es esencialmente decirle al caller "usá
  `/plan`+`/execute` en vez del atómico" — lo cual ya es posible HOY sin
  código nuevo (ver opción d).
- **(c) Distinguir vocabulario-mismatch de irrelevancia real sin juez
  semántico.** Confirmado NO factible de forma confiable: `tokenizeForRelevance`
  es puramente léxico (split + lowercase, sin diccionario ni traducción).
  Cualquier heurística "es español" sería frágil (falsos positivos con
  goals en spanglish, nombres de tickers, código) y agregaría superficie de
  mantenimiento para un beneficio marginal — el guard ya es conservador por
  diseño (bias-to-reject, no bias-to-charge).
- **(d) Per-path: `/orchestrate/plan` relaja el guard (candidatos
  low-confidence, sin cobrar nunca); `/orchestrate` atómico mantiene
  `no_relevant_agent` sin cambios.** Recomendada — ver abajo.

## Recomendación del Analyst (money-safe, mínima)

**Opción (d), acotada aún más: NO tocar `fallbackNoRelevance` en absoluto.**
F0 confirma que `/orchestrate/plan` es 100% quote (cero debit) — un caller
que hoy recibe `no_relevant_agent` en `/plan` para un goal multilingüe puede
YA HOY inspeccionar `consideredAgents` (que sí viaja completo en la
respuesta, `routes/orchestrate.ts:265`) y decidir manualmente construir un
plan para `/orchestrate/execute`, sin ningún cambio de código. La única
mejora real que esta HU podría aportar sin tocar el guard de decisión
money-relevante es **cosmética/informativa**: cuando `fallbackNoRelevance`
dispara, incluir en el `reasoning` (ya lo hace parcialmente, `:915-916`) una
señal explícita de "possible vocabulary/language mismatch — inspect
consideredAgents" para guiar al caller hacia el flujo `/plan`+`/execute`
manual. Este cambio es aditivo, no toca ninguna condición de negocio, y no
introduce riesgo de over-charge en ningún path.

Si el humano prefiere una mejora funcional real (no solo cosmética) — p.ej.
que `/orchestrate/plan` devuelva el plan greedy en `ready` (candidatos
low-confidence, aprovechando que ese endpoint nunca cobra) en vez de
`no_relevant_agent`, MIENTRAS el atómico sigue rechazando — es la opción (d)
completa. Es la MENOS invasiva de las opciones funcionales, pero SIGUE
siendo un cambio de comportamiento observable de un endpoint en producción
(un caller que hoy depende de `no_relevant_agent` para decidir "no ejecutar"
empezaría a recibir `ready` con un plan sin garantía de relevancia) — por
eso se marca `[NEEDS CLARIFICATION]` abajo en vez de asumirse.

## `[NEEDS CLARIFICATION]` — decisión del humano

**Pregunta:** ¿la remediación de WKH-159 debe ser (1) solo cosmética
(reasoning más informativo, sin tocar la condición del guard, CERO riesgo,
recomendado si se quiere cerrar el ticket rápido) o (2) funcional en
`/orchestrate/plan` (el guard deja de hard-rejectar en el endpoint
quote-only, devolviendo un plan `ready` de low-confidence; el atómico
`/orchestrate` NO cambia)?

**Tradeoff:** (1) dice honestamente al caller "no sé, mirá los candidatos vos
mismo" — cero código de negocio nuevo, cero riesgo, pero no resuelve el
"usuario no recibe nada" del ticket. (2) sí resuelve la UX pero convierte
`/orchestrate/plan` en una fuente de planes NO verificados por ningún juicio
semántico (ni LLM ni léxico) — un caller automatizado (agente, no humano)
que llama `/plan` y auto-aprueba `/execute` sin revisar heredaría el mismo
riesgo de over-charge que la opción (a) descartada para WKH-158, solo movido
un paso más allá (ahora requiere 2 llamadas HTTP en vez de 1, pero un caller
naive las hace igual). Dado que Chaski (el consumer real de `/plan`+
`/execute`, WKH-131) es exactamente ese tipo de caller automatizado, (2)
podría reintroducir el mismo riesgo que (a) por la puerta de atrás.
**Recomendación del Analyst: opción (1).** El humano decide.

## Acceptance Criteria (EARS)

- AC-1: WHILE el guard `fallbackNoRelevance` (`orchestrate.ts:851-867`)
  evalúa un plan greedy con overlap=0 respecto al goal, the system SHALL
  seguir devolviendo `planStatus: 'no_relevant_agent'` sin ejecutar
  `executeApprovedPlan` y sin debitar (comportamiento actual, byte-idéntico
  salvo el texto de `reasoning` si F2 implementa la opción cosmética).
- AC-2: WHEN un goal es genuinamente no-servible (ningún agente, léxica NI
  semánticamente, puede resolverlo), the system SHALL seguir devolviendo
  `no_relevant_agent` sin cobrar — sin cambios de comportamiento.
- AC-3: WHILE se ejecuta el endpoint atómico `POST /orchestrate`, the system
  SHALL NOT auto-debitar un step seleccionado por `greedyPlan()` sin
  ninguna señal de relevancia léxica al goal — esta HU NO introduce ningún
  nuevo camino de `planStatus: 'ready'` en el atómico para el caso
  multilingüe (CD-1).
- AC-4: WHILE el path LLM (`llmPlan()`, el retry de WKH-158
  `orchestrate.ts:674-696`, y el backstop MIXED-PLAN-ONLY de WKH-152
  `orchestrate.ts:885-906`) resuelve un plan, the system SHALL mantenerlos
  byte-idénticos — esta HU toca EXCLUSIVAMENTE el guard greedy
  (`usedFallback === true`).
- AC-5: IF F2/el humano ratifica la opción cosmética (Missing Inputs),
  THEN the system SHALL enriquecer únicamente el string `reasoning` del
  early-return `no_relevant_agent` (`orchestrate.ts:915-916`) para señalar
  un posible vocabulary/language mismatch, sin alterar `planStatus`,
  `steps`, ni ningún campo de billing.

## Scope IN
- `src/services/orchestrate.ts` — SOLO el guard greedy: `fallbackNoRelevance`
  (`:851-867`) y el `reasoning` del early-return `no_relevant_agent`
  (`:908-958`). Alcance final (cosmético vs funcional en `/plan`) depende del
  `[NEEDS CLARIFICATION]`.
- Tests: (a) repro multilingüe (`goal` en español, agente relevante en
  inglés en el candidate set, `usedFallback === true`) confirmando el
  comportamiento ratificado; (b) `no_relevant_agent` genuino (sin agente
  servible) sigue sin cobrar; (c) el path LLM/WKH-152/WKH-158 no cambia
  (test de regresión, mismos fixtures que `161-wkh-158-greedy-relevance-guard`
  y `160-wkh-152-llm-planner-relevance-guard`).

## Scope OUT
- `llmPlan()` (`:162-293`) y el retry de WKH-158 (`:674-696`) — sin cambios.
- El backstop MIXED-PLAN-ONLY de WKH-152 (`:885-906`) — sin cambios.
- `greedyPlan()` (`:297-339`) — selección por precio sin cambios (el humano
  ya descartó darle juicio semántico en WKH-158).
- `allStepsAreDemos` (`:830-832`) — guard independiente, no se toca.
- `discoveryService.discover` / el broaden-retry de WKH-151/157
  (`discovery.ts`, `orchestrate.ts:549-586`) — no se toca.
- `compose.ts` / settlement / débito de steps 1..N — mecanismo existente
  (WKH-127/132), no se modifica.
- `/orchestrate/execute` — el guard nunca corre ahí (el cliente ya aprobó
  los steps), no hay cambio aplicable.

## Decisiones técnicas (DT-N)
- DT-1: El fix (cualquiera que ratifique el humano) se acota
  EXCLUSIVAMENTE al guard greedy (`usedFallback === true`) — no se toca
  ninguna lógica del path LLM.
- DT-2: Si se implementa la opción cosmética (recomendada), el cambio es
  puramente de string — cero cambio de `planStatus`/`steps`/billing.
- DT-3: Si el humano ratifica la opción funcional en `/plan` (2), el
  Architect debe diseñar el gate para que sea IMPOSIBLE que el mismo plan
  `ready` llegue al atómico sin el paso de confirmación explícita del
  caller — es decir, la relajación debe vivir en la capa de RESPUESTA del
  route `/plan` (`routes/orchestrate.ts`), nunca en `planOrchestration()`
  (compartida por ambos endpoints), para no reabrir el riesgo de over-charge
  en `/orchestrate` atómico por transitividad.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO introducir un camino donde el endpoint atómico
  `POST /orchestrate` llegue a `planStatus: 'ready'` (y por lo tanto debite)
  para un plan greedy sin overlap léxico/semántico con el goal — cero
  over-charge nuevo.
- CD-2: PROHIBIDO romper el caso `no_relevant_agent` LEGÍTIMO (goal sin
  ningún agente servible) — debe seguir sin cobrar, mismo `reasoning` shape
  salvo el texto ratificado en AC-5.
- CD-3: PROHIBIDO tocar `llmPlan()`, el retry de WKH-158
  (`orchestrate.ts:674-696`), o el backstop MIXED-PLAN-ONLY de WKH-152
  (`orchestrate.ts:885-906`) — byte-idénticos.
- CD-4: PROHIBIDO modificar `greedyPlan()` (`:297-339`) — sin juicio
  semántico, sin cambios (mismo criterio ya ratificado por el humano en
  WKH-158).
- CD-5: Si F2 implementa la opción funcional (2), OBLIGATORIO que la
  relajación viva en `routes/orchestrate.ts` (capa de respuesta de `/plan`),
  NUNCA en `planOrchestration()` compartida — ver DT-3.

## Missing Inputs
- **[BLOQUEANTE para F2]** Ver sección `[NEEDS CLARIFICATION]` arriba:
  opción cosmética (1, recomendada) vs funcional en `/plan` (2). El
  orquestador debe escalar esto al humano en el gate `HU_APPROVED` — no es
  un detalle mecánico, es un genuine product/money-path tradeoff (mismo tipo
  de decisión que el humano ya resolvió para WKH-152/WKH-158).

## Análisis de paralelismo
- No bloquea ninguna HU en curso. Independiente de WKH-157 (fila 159,
  discover free-text, in progress) y de WKH-152 (fila 160, in progress —
  el backstop MIXED-PLAN-ONLY ya está en el código leído, sin cambios acá).
- **Conflicto de merge potencial con WKH-158 (fila 161, in progress)**: ambas
  HUs tocan `src/services/orchestrate.ts` en la MISMA región del archivo
  (WKH-158 toca `:656-748`, el punto de decisión LLM→greedy; esta HU toca
  `:851-958`, el guard greedy post-decisión). No se solapan línea a línea,
  pero SÍ comparten el mismo archivo grande — verificar que WKH-158 esté
  mergeado (o al menos su F3 completo) antes de F3 de esta HU para evitar
  reescribir line-comments/anchors que WKH-158 ya movió.
- Puede correr en paralelo con cualquier HU que no toque
  `src/services/orchestrate.ts:297-339` (`greedyPlan`) o `:851-958`
  (el guard + early-return `no_relevant_agent`).
