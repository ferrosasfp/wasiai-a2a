# Auto-Blindaje — WKH-125 (KEY-CONSTRAINTS)

> Errores cometidos durante la implementación F3 + decisiones de escalación
> (opción SDD-consistente, sin inventar APIs).

### [2026-06-19] Wave 3 — `errorCode==='DEST_CAP_EXCEEDED'` exige tocar `ComposeResult` (index.ts, no listado en Scope IN)

- **Situación**: el Story File (Files #8b + Test Expectations L657 + Exemplar 9)
  manda un branch `errorCode === 'DEST_CAP_EXCEEDED'` → **402** en
  `routes/compose.ts` para el caso **mid-pipeline** (steps 1..N). Pero:
  1. `ComposeResult.errorCode` (en `src/types/index.ts:295`) hoy es del tipo
     literal `'SCOPE_DENIED'` únicamente.
  2. El call-site per-step de `compose.ts` (L166-178) en un debit fail devuelve
     `error: 'Step i debit failed: ...'` **sin** setear `errorCode`.
  Sin (a) ampliar el union de `errorCode` y (b) setear `errorCode` en
  `compose.ts` cuando el per-step falla con `DEST_CAP_EXCEEDED`, el branch del
  route NUNCA matchea → AC-2 mid-pipeline (402) queda incumplido.
- **Tensión de scope**: `src/types/index.ts` NO está en "Files to Modify"; el
  scope de `compose.ts` (#7) solo menciona el 6º arg + guard `i>0`.
- **Decisión (SDD-consistente, NO inventada)**: opción mínima que satisface el
  contrato explícito del Story File sin agregar APIs nuevas:
  1. Ampliar el union: `errorCode?: 'SCOPE_DENIED' | 'DEST_CAP_EXCEEDED'` en
     `ComposeResult` (`src/types/index.ts`). Cambio puramente aditivo de un tipo.
  2. En `compose.ts`, cuando el per-step debit falla con
     `debitResult.error === 'DEST_CAP_EXCEEDED'`, propagar
     `errorCode: 'DEST_CAP_EXCEEDED'` en el `ComposeResult` (el resto del shape
     intacto; el guard `i>0` y la firma de compose NO cambian).
  3. En `routes/compose.ts`, mapear `result.errorCode === 'DEST_CAP_EXCEEDED'`
     → 402 (junto al branch existente `'SCOPE_DENIED'` → 403).
- **Por qué NO es "inventar"**: el branch del route está LITERAL en el Story
  File (#8b) y la Test Expectation L657 exige el 402 mid-pipeline; la única
  forma de cumplirlo es propagar ese errorCode. Es el camino que el SDD asume.
- **Aplicar en**: cualquier futura HU que agregue un nuevo error-code de
  compose que deba mapear a un HTTP no-400 debe (i) ampliar el union de
  `ComposeResult.errorCode`, (ii) setearlo en el call-site del service,
  (iii) agregar el branch en `routes/compose.ts`.

### [2026-06-19 21:10] Fix-pack AR — BLQ-ALTO-1: destino step-0 derivado del body crudo (cap bypass)

- **Error**: el destino del step-0 se augmentaba como
  `deriveComposeDestination(firstStep.agent, firstStep.registry)` desde el BODY
  crudo del caller (`routes/compose.ts:96,106`), con `registry` opcional. El
  per-step lo deriva del agente RESUELTO por discovery
  (`compose.ts:166` → `agent.registry`/`agent.slug`). En un compose de 1 step el
  único débito es el de step-0 (guard `i>0` salta los demás): si el caller omitía
  `registry`, el destino (`"myagent"`) NO matcheaba la policy (`"wasiai/myagent"`)
  → `v_has_policy=false` → degradaba a `increment_a2a_key_spend` → el cap NUNCA se
  evaluaba (gasto ilimitado). Derrota AC-2/AC-3 en la ruta de dinero.
- **Causa raíz**: dos fuentes distintas de verdad para el MISMO destino. step-0
  keyeaba por el input no-canónico del caller; per-step keyeaba por la forma
  canónica de discovery. No coincidían byte a byte → el SELECT de la policy en el
  RPC fallaba el match.
- **Fix**: nuevo `resolveAgentDestination(slug, registry)` en
  `src/services/agent-price.ts` que resuelve el agente vía
  `discoveryService.getAgent(slug, registry)` con fallback `getAgent(slug)`
  (mismo orden que `compose.resolveAgent`) y devuelve `{registry, slug}` canónicos.
  `routes/compose.ts:resolveComposePriceHandler` ahora deriva
  `request.composeDestination = normalizeDestination(${resolved.registry}/${resolved.slug})`
  del agente resuelto (NO del body). Así step-0 y per-step keyean idéntico.
  Si el agente no resuelve → `composeDestination` undefined → step-0 sigue 3-arg
  (back-compat). NO se tocó `resolveAgentPriceUsdc` (firma intacta).
- **Por qué NO es "inventar"**: el Story File (Derivación del destino, fila
  step-0; Anti-Hallucination checklist "Destino normalizado … Coinciden byte a
  byte") exige que el destino de step-0 coincida con el del per-step. El per-step
  ya usa el agente resuelto; el fix alinea step-0 al MISMO origen canónico. El
  resolver reusa `discoveryService.getAgent` (API existente), no agrega APIs.
- **Tests**: `agent-price.test.ts` (T-DEST-1..4: resolución canónica, omisión de
  registry, fallback sin hint, null si no resuelve) + `routes/compose.test.ts`
  (T-ROUTE-PRICE-DEST-1: body sin registry → `composeDestination="wasiai/myagent"`
  canónico, NO "myagent"; T-ROUTE-PRICE-DEST-2: sin agente → undefined/3-arg).
- **Aplicar en**: cualquier call-site que derive una clave de débito/cap a partir
  de input del caller debe normalizar/resolver a la forma CANÓNICA del recurso
  (discovery) ANTES de keyear, nunca confiar en los crudos del body.

### [2026-06-19 21:10] Fix-pack AR — BLQ-MED-1: CREATE OR REPLACE +1 param crea overload

- **Error**: la UP migration `20260606000000_a2a_key_spend_policies.sql` hacía
  `CREATE OR REPLACE FUNCTION debit_session_and_parent(...6 params, p_destination
  TEXT DEFAULT NULL)` sin dropear la firma de 5 params de `20260603000000`. En
  Postgres `CREATE OR REPLACE` reemplaza SOLO con tipos de entrada idénticos;
  agregar un param crea una SOBRECARGA. La de 5 params persistía → un caller de
  5 args da `ERROR: function debit_session_and_parent(...) is not unique`
  (afecta el e2e `key-session-atomicity.real.test.ts:93` que llama con 5 args).
- **Causa raíz**: malentendido de la semántica de `CREATE OR REPLACE` con cambio
  de aridad. CD-4 ("las llamadas de 5 args siguen válidas por el DEFAULT") solo
  se cumple si existe UNA sola función de 6 params; con la vieja de 5 presente, la
  resolución es ambigua.
- **Fix**: `DROP FUNCTION IF EXISTS debit_session_and_parent(uuid, text, uuid,
  integer, numeric);` ANTES del `CREATE OR REPLACE` de 6 params en el UP. Firma de
  5 params verificada en `20260603000000_a2a_key_sessions.sql:28-33`. El
  `_down.sql` ya dropea la de 6 y restaura la de 5 → reversibilidad intacta (sin
  cambios en el down).
- **Aplicar en**: toda migración que cambie la aridad de una función vía
  `CREATE OR REPLACE` debe `DROP FUNCTION IF EXISTS <firma vieja>` primero, o
  quedan overloads huérfanos que rompen la resolución de funciones.
