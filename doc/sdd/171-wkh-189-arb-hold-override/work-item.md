# Work Item — [WKH-189] Panel + endpoint de revisión/override de `arb_hold`

> **Nota de grounding**: no se pudo invocar la herramienta MCP `getJiraIssue`
> (no está disponible en el toolset del Analyst en esta sesión) — este
> work-item se construyó a partir de la descripción detallada del
> orquestador + grounding exhaustivo del código real (`src/services/arbiter.ts`,
> `src/routes/payments.ts`, `src/routes/dashboard.ts`, la migración
> `20260704100000_wkh139_arbiter.sql`, y el work-item/done-report de WKH-139 v2
> — fila 145 de `_INDEX.md`). Si el contenido del ticket Jira difiere de lo
> asumido acá, corregir antes de `HU_APPROVED`.

## Resumen

WKH-139 v2 (fila 145, DONE, `PAYOUT`-crítico) construyó un agente-árbitro
autónomo que resuelve disputas sobre `session` payment-intents: auto-resuelve
≤ `ARBITER_AUTO_CAP_USD` (default $25) por reglas/LLM-acotado; sobre-tope o
ambigüedad irresoluble → estado `arb_hold` (congelado, cero movimiento de
fondos). El founder ya ratificó los 5 defaults conservadores de ese diseño
(done-report fila 145, §"Ratificación de 5 defaults conservadores"),
incluyendo el default #4 ("Hold + cooling-off... revisión humana"). Hoy ese
"revisión humana" **no existe en código** — el único camino para destrabar un
`arb_hold` es cirugía manual de DB. Esta HU construye el **Bloque A (código)**:
un endpoint admin-gated para listar holds pendientes + resolverlos
(`release`/`refund`/`split`), reusando el mismo seam de settle/refund del
árbitro autónomo (CD-6), más el panel en el dashboard existente. La activación
en producción (aplicar migración a `caldz`, flip de flags) es Bloque
operativo, fuera de esta HU.

---

## Sizing

- **SDD_MODE**: full
- **Estimación**: M (reusa intensivamente el seam de `arbiter.ts`; superficie
  nueva acotada a 1 migración additive + 1 función de servicio + 2 endpoints +
  1 panel de UI, pero es money-path con scope de admin cross-tenant → AR
  obligatorio, sin atajos)
- **Pipeline**: QUALITY (obligatorio — movimiento de fondos, aunque
  gateado por autorización humana explícita)
- **Branch sugerido**: `feat/171-wkh-189-arb-hold-override`

---

## F0 — Hallazgos de grounding (críticos para F2)

1. **`close_payment_intent_for_arbitration` (la RPC que ejecuta el monto
   forzado) NO acepta hoy el estado `arb_hold`.** Su `IF/ELSIF/ELSE`
   (`supabase/migrations/20260704100000_wkh139_arbiter.sql:192-208`) solo
   transiciona `disputed→arb_closing` (rama nueva) o recupera desde
   `arb_closing` (rama recovery); cualquier otro estado —incluido
   `arb_hold`— cae al `ELSE` y lanza `INTENT_NOT_OPEN`. Esto significa que
   `arbiterService.executeArbitration` (el único choke-point de settle/refund
   forzado, CD-6) **no puede invocarse tal cual** sobre un intent en
   `arb_hold` sin tocar la migración.

2. **El proyecto ya tiene un patrón establecido para este tipo de cambio**:
   "Option B" (usado en la misma migración de WKH-139 v2 sobre
   `record_settle_outcome`/`finalize_payment_intent`, líneas 233-372):
   ensanchar **solo el predicado del status-gate** de una RPC existente
   (`'closing'` → `IN ('closing','arb_closing')`), dejando toda la lógica de
   dinero byte-idéntica. Es exactamente el molde a replicar para
   `close_payment_intent_for_arbitration` (`v_status = 'disputed'` →
   `v_status IN ('disputed','arb_hold')` en la rama que transiciona a
   `arb_closing`) — ver DT-1.

3. **`holdArbitration` (arbiter.ts:728-758) hace el `UPDATE` a `arb_hold`
   directo desde la app (owner-guarded, sin RPC)** — no hay una RPC "abrir
   hold" separada que debamos revertir; solo hace falta que la RPC de cierre
   sepa salir de `arb_hold`.

4. **`ArbiterMethod` (`src/types/arbiter.ts:17`) es hoy
   `'rules' | 'llm' | 'hold'`** — no hay un valor que distinga "resuelto por
   humano" de "resuelto por regla/LLM" en la auditoría (`a2a_arbitrations.method`
   CHECK, migración línea 48). Se necesita ampliar el tipo + el CHECK
   (additive) con `'admin_override'` para que la fila de auditoría no mienta
   sobre quién decidió.

5. **`a2a_arbitrations` (migración líneas 43-56) no tiene columnas para
   registrar QUIÉN resolvió el hold ni CUÁNDO** — faltan `resolved_by`,
   `resolved_at`, `resolution_note` (nullable, additive).

6. **El patrón de auth admin ya existe y es reusable tal cual**:
   `requireAdminToken` (`src/routes/dashboard.ts:30-60`) — shared-secret
   `X-Admin-Token` vía `timingSafeEqual`, fail-closed en producción si
   `DASHBOARD_ADMIN_TOKEN` no está configurado. El panel/endpoints de esta HU
   deben vivir bajo el prefijo `/dashboard` (ya registrado en
   `src/index.ts:167`) y usar el mismo `preHandler`.

7. **`GET /session/:id/dispute` (payments.ts:328-373) es owner-scoped** (un
   caller solo ve su propio intent) — **no sirve** para un panel admin que
   necesita ver holds de TODOS los owners. Se necesita un endpoint GET nuevo,
   admin-gated, sin filtro `owner_ref` (cross-tenant por diseño, ver CD-4/CD-5).

8. **El flag `ARBITER_ENABLED` (default OFF, `=== 'true'` exacto,
   `arbiter.ts:65-67`) es la fuente de verdad de si el sistema de arbitraje
   existe.** Con el flag OFF, `/session/:id/dispute` devuelve 404
   byte-idéntico — ningún intent puede llegar a `arb_hold`. El panel de
   revisión debe heredar el mismo gate (AC-8).

---

## Acceptance Criteria (EARS)

**AC-1**: WHEN existen uno o más `a2a_payment_intents` en estado `arb_hold`,
THE system SHALL exponer un endpoint `GET` admin-gated (mismo
`requireAdminToken` de `dashboard.ts`) que lista esos holds con su evidencia
persistida (`decision` original, `method`, `ambiguity_reason`, `at_stake_usd`,
`chain_id`, `created_at`, `intent_id`).

**AC-2**: WHEN un admin autenticado envía `POST` de resolución sobre un
`intent_id` que está en `arb_hold`, con una decisión válida
(`release` / `refund` / `split` + `splitPct` si `split`), THE system SHALL
ejecutar el desenlace reusando el seam existente de settle/refund
(`arbiterService.executeArbitration`, CD-6), transicionando
`arb_hold → arb_closing → settled|refunded|failed` según corresponda.

**AC-3**: WHEN se ejecuta un override humano, THE system SHALL emitir un
recibo inmutable (patrón WKH-124, mismo `receiptTypeFor(decision)`) y
persistir en `a2a_arbitrations` `method='admin_override'`, `resolved_by`,
`resolved_at`, y (si se proveyó) `resolution_note`, **preservando**
`ambiguity_reason`/`llm_reasoning` del hold original (no se pisan).

**AC-4**: IF el `intent_id` objetivo no está en estado `arb_hold` (ya
resuelto, no existe, o en cualquier otro estado), THEN THE system SHALL
rechazar el override con un error explícito (404/409) SIN ejecutar ningún
movimiento de fondos.

**AC-5**: IF el caller no presenta un `X-Admin-Token` válido (mismo guard que
`dashboard.ts`), THEN THE system SHALL rechazar tanto la lectura (AC-1) como
la resolución (AC-2) con 401/403, SIN exponer datos de disputas de otros
owners ni ejecutar ningún override.

**AC-6**: IF el intent objetivo resuelve a una chain que NO está en la
allowlist de testnet (`kite-ozone-testnet` 2368, `avalanche-fuji` 43113,
`base-sepolia` 84532) — defensa en profundidad, no debería ocurrir dado que
`openDispute` ya bloquea mainnet antes de llegar a `disputed`/`arb_hold` —
THEN THE system SHALL rechazar el override fail-closed, replicando el
testnet-guard existente de `arbiter.ts:302-305`.

**AC-7**: WHEN el override se ejecuta, THE system SHALL clampear el monto
forzado por el admin a `[0, authorized_usd]` (invariante "no crear plata",
mismo clamp que `close_payment_intent_for_arbitration` ya aplica al auto-path)
y NUNCA permitir que `settleUsd` exceda el deposit del intent.

**AC-8**: WHILE `ARBITER_ENABLED !== 'true'`, THE system SHALL negar el
acceso al panel/endpoints de revisión de holds (401/403/404, a definir en F2
cuál — pero SIN filtrar existencia de disputas), ya que con el flag apagado
no puede existir ningún `arb_hold` legítimo en el sistema.

---

## Scope IN

- Nuevo endpoint `GET /dashboard/api/arbitrations?status=held` (o path
  equivalente a definir en F2) — admin-gated, lista holds pendientes con
  evidencia.
- Nuevo endpoint `POST /dashboard/api/arbitrations/:intentId/resolve` —
  admin-gated, ejecuta el override (`release`/`refund`/`split`).
- Nueva función en `arbiterService` (p.ej. `resolveHold`) que: lee
  `owner_ref`/`chain_id`/status desde `a2a_payment_intents` +
  `a2a_arbitrations` (el admin no conoce el `owner_ref` de antemano),
  re-valida testnet (AC-6), computa `settleUsd` clampeado (AC-7), invoca
  `executeArbitration` con `meta.method='admin_override'` preservando
  `ambiguityReason`/`llmReasoning` originales (AC-3).
- Migración additiva nueva (mirror del patrón "Option B" de la migración
  WKH-139 v2):
  - Ensanchar el predicado de `close_payment_intent_for_arbitration`
    (`v_status = 'disputed'` → `v_status IN ('disputed','arb_hold')` en la
    rama que transiciona a `arb_closing`) — **sin tocar**
    `record_settle_outcome`/`finalize_payment_intent` (byte-idénticos, CD-6).
  - Ampliar CHECK `a2a_arbitrations.method` (+`'admin_override'`).
  - Columnas nuevas nullable en `a2a_arbitrations`: `resolved_by TEXT`,
    `resolved_at TIMESTAMPTZ`, `resolution_note TEXT`.
  - Migración `_down` reversible (mismo patrón que
    `20260704100000_wkh139_arbiter_down.sql`).
- Ampliar `ArbiterMethod` (`src/types/arbiter.ts`) con `'admin_override'`.
- Panel nuevo en `src/static/dashboard.html` (sección/tab "Disputas en
  revisión"): tabla de holds + formulario de resolución (decision select,
  `splitPct` condicional, `resolvedBy`, `resolution_note` opcional).
- Tests: unit del servicio nuevo (`resolveHold`) + integración de los 2
  endpoints, mismo patrón que `arbiter.test.ts` (88 tests existentes, no
  tocar).

## Scope OUT

- **El auto-path del árbitro** (`rules.ts`, `llm-classifier.ts`,
  `evidence.ts`, el cap gate de la decisión autónoma en
  `resolveDispute`/`arbiter.ts:394-412`) — sin cambios de comportamiento.
- **Mainnet** — sigue completamente fuera de todo el sistema de arbitraje
  (heredado, CD-5 de WKH-139 v2).
- **`ARBITER_AUTO_CAP_USD`** — no se aplica al override humano; el admin
  puede resolver cualquier `at_stake_usd` (clampeado `[0,deposit]`, sin tope
  adicional) — el hold existe precisamente PORQUE superó ese tope o fue
  ambiguo, y el humano ya está en el loop (default ratificado #4).
- **Ops de activación**: aplicar la migración pendiente a `caldz` (prod DB),
  el flip de `ARBITER_ENABLED=true` en Railway, y la migración de esta HU a
  prod — esta HU es **solo código**; queda `DONE (código) · PENDING-DEPLOY`
  igual que WKH-170/171/172 (filas 167-170 del `_INDEX.md`).
- **Identidad de admin fuerte** (RBAC per-user, SSO, JWT individual) — v1
  reusa el mismo `X-Admin-Token` compartido de `dashboard.ts`; `resolvedBy`
  es texto autoreportado por el admin en el form, **no** una identidad
  criptográficamente verificada (ver DT-4/Missing Inputs).
- **Disputas sobre intents `upto`** — el arbiter (heredado de WKH-139 v2) es
  `session`-only; esta HU no amplía ese alcance.
- **Ventana de "cooling-off" adicional post-override** — el estado
  `arb_hold` YA ES la ventana de espera/congelamiento; el override ejecuta
  inmediato al confirmar el admin, sin un segundo delay/aprobación.
- **Reversión de un override ya ejecutado** — una vez el intent llega a
  `settled`/`refunded`/`failed`, es terminal; no hay "undo" en esta HU.
- **Alertas/notificaciones (Discord) por cada override** — no estaba pedido
  explícitamente; queda como sugerencia opcional para F2 (ver Missing
  Inputs), no bloqueante.

---

## Decisiones técnicas (DT-N)

**DT-1** (respuesta a la pregunta del orquestador — ¿RPC nuevo sí/no?): **NO
se crea un RPC nuevo.** Se ensancha `close_payment_intent_for_arbitration`
siguiendo el patrón "Option B" ya establecido en la misma migración WKH-139 v2
para `record_settle_outcome`/`finalize_payment_intent`: el predicado
`IF v_status = 'disputed'` pasa a `IF v_status IN ('disputed','arb_hold')` en
la rama que transiciona a `arb_closing` (persiste el monto forzado en
`consumed_usd`, clamp `[0,deposit]` sin cambios de lógica). Razón: esa RPC ya
es el único choke-point del "monto forzado por el árbitro" (`FOR UPDATE` +
Ownership Guard + clamp); duplicarla en una RPC paralela violaría CD-6
(heredado de WKH-139 v2, "prohibido duplicar sign/settle/verify") y crearía
dos caminos de exactly-once en lugar de uno. `record_settle_outcome` y
`finalize_payment_intent` **no se tocan** — siguen gateados en
`'closing'/'arb_closing'`, ajenos a `arb_hold`.

**DT-2**: El override reusa `arbiterService.executeArbitration` (mismo
código, mismo seam) desde una función nueva `resolveHold(intentId, decision,
splitPct, resolvedBy, note)`. Esa función NO reimplementa settle/refund;
solo resuelve `owner_ref`/valida estado/computa `settleUsd` y delega.

**DT-3**: Autenticación del panel = `requireAdminToken` (shared-secret
`X-Admin-Token`) ya usado en `dashboard.ts` — no se construye un sistema de
auth nuevo para esta HU, evitando expandir la superficie de identidad en una
HU ya money-crítica.

**DT-4**: `resolvedBy`/`resolution_note` son campos de auditoría best-effort
(texto libre ingresado por el admin en el form), NO una identidad
criptográficamente verificada — limitación conocida y aceptada
explícitamente (ver Scope OUT), consistente con el nivel de garantía que ya
ofrece hoy `DASHBOARD_ADMIN_TOKEN` (un secreto compartido, no per-usuario).

---

## Constraint Directives (CD-N)

**CD-1**: OBLIGATORIO reusar el seam de settle/refund vía
`executeArbitration` (CD-6 heredado de WKH-139 v2, fila 145) — PROHIBIDO
clonar o duplicar la lógica de settle/refund/finalize para el path de
override.

**CD-2**: PROHIBIDO debilitar el testnet-guard (`TESTNET_CHAIN_IDS`) o el
`ARBITER_AUTO_CAP_USD` del auto-path existente — el override es un camino
ADICIONAL gateado por auth de admin, no una forma de eludir esas protecciones
para el path autónomo (rules/LLM). Ver AC-6.

**CD-3**: OBLIGATORIO exactly-once vía status-gate a nivel DB: el override
SOLO puede ejecutar sobre un intent en `arb_hold` bajo el mismo `FOR UPDATE`
row-lock que ya aplica `close_payment_intent_for_arbitration` — PROHIBIDO
hacer un `UPDATE` de status en la capa de aplicación ANTES de invocar la RPC
(introduciría una ventana de carrera entre dos resoluciones concurrentes del
mismo hold, o entre un override y un `recoverArbClosing`/`expireStale`
corriendo en paralelo).

**CD-4**: OBLIGATORIO Ownership Guard aun en scope admin: toda escritura a
`a2a_payment_intents`/`a2a_arbitrations` sigue pasando `owner_ref` (leído del
propio row del intent, NUNCA construido/spoofeable desde el request del
admin) a las RPCs existentes — el admin puede VER cross-tenant (by design,
CD-5) pero nunca puede resolver un hold usando un `owner_ref` distinto al
real del intent.

**CD-5**: OBLIGATORIO documentar y auditar el scope privilegiado: el
endpoint `GET` de listado es intencionalmente cross-tenant (un admin ve
holds de TODOS los owners) — esto es una excepción deliberada al patrón
Ownership Guard estándar de `CLAUDE.md` (que aplica a queries de un caller
autenticado como owner, no de un admin de plataforma), y debe quedar
explícito en el SDD/story-file como superficie de alto privilegio a revisar
en cualquier audit de seguridad futuro.

**CD-6**: PROHIBIDO tocar `record_settle_outcome`/`finalize_payment_intent`
en esta HU — sus predicados de gate (`IN ('closing','arb_closing')`) quedan
byte-idénticos; solo `close_payment_intent_for_arbitration` se ensancha
(DT-1).

**CD-7**: OBLIGATORIO que `ARBITER_ENABLED !== 'true'` bloquee el acceso al
panel/endpoints de la misma forma que bloquea `/session/:id/dispute` hoy — no
puede haber holds visibles/resolvibles si el sistema de arbitraje está
apagado (AC-8).

---

## Missing Inputs

- **[bloqueante — grounding, no producto]**: no se pudo leer el ticket
  Jira WKH-189 original (herramienta MCP no disponible en esta sesión del
  Analyst). Este work-item se construyó 100% a partir de la descripción del
  orquestador + grounding de código. **Antes de `HU_APPROVED`, el humano debe
  confirmar que el alcance acá descrito coincide con el ticket real**
  (especialmente los ACs EARS y el scope backend+frontend/fuera-de-alcance
  ops que el prompt del orquestador dice que el ticket ya definía).

- **[NEEDS CLARIFICATION, no bloqueante — default conservador disponible]**:
  ¿`resolvedBy` debe validarse contra una lista fija de nombres/emails
  autorizados (env var), o es completamente libre? Recomendación: libre en
  v1 (mismo nivel de confianza que el token compartido hoy), documentado como
  limitación conocida (DT-4). El Architect puede endurecerlo en F2 sin
  reabrir esta HU si el humano lo pide.

- **[NEEDS CLARIFICATION, no bloqueante]**: ¿se requiere una alerta
  (Discord, mismo patrón WKH-90/91/`alerts.mjs`) cuando se ejecuta un
  override, dado que es dinero moviéndose por decisión humana fuera del flujo
  autónomo? No estaba explícito en la descripción del ticket que recibió el
  Analyst — sugerido como AC opcional de bajo costo para F2 si el humano lo
  confirma.

- **[TBD — F2, no bloqueante]**: shape exacto de la respuesta `GET` (¿incluye
  `seller_ref`/`pay_to`/`chain_id` vía join con `a2a_payment_intents`, o solo
  lo que ya persiste `a2a_arbitrations`?) — decisión de diseño del Architect.

---

## Análisis de paralelismo

- **Depende de (DONE, ya en `main` — confirmado leyendo el código en disco,
  no solo el `_INDEX`)**: WKH-139 v2 (fila 145) — `src/services/arbiter.ts`,
  `src/types/arbiter.ts`, la migración `20260704100000_wkh139_arbiter.sql`, y
  `src/routes/payments.ts` (`/session/:id/dispute`) ya existen en el
  checkout actual de `main`. Solo la migración de fila 145 sigue pendiente
  de **aplicar a `caldz`** (prod DB) — no bloquea esta HU (que trabaja sobre
  `bdwv`/testnet como el resto del repo), pero SÍ significa que el override
  de esta HU heredará el mismo estado "PENDING-DEPLOY" hasta que ambas
  migraciones (145 + esta) se apliquen juntas a `caldz`.
- **No depende de**: ninguna de las HUs `in progress` actuales
  (159/160/161/162/163, filas del `_INDEX`) — todas tocan `orchestrate.ts`
  /`discovery.ts`, no `arbiter.ts`/`dashboard.ts`/`payments.ts`.
- **Bloquea**: ninguna HU identificada en el roadmap actual.
- **Puede correr en paralelo con**: cualquier HU que no toque
  `src/services/arbiter.ts`, `src/routes/dashboard.ts`,
  `src/static/dashboard.html`, `src/types/arbiter.ts`, o la migración
  `20260704100000_wkh139_arbiter.sql`. Ninguna HU activa colisiona hoy.
- **Ops sugerida de secuenciación (fuera de esta HU)**: cuando se aplique la
  migración a `caldz`, conviene aplicar en el MISMO mantenimiento la
  migración de fila 145 (WKH-139 v2, aún pendiente) + la de esta HU (WKH-189),
  para no dejar una ventana donde `ARBITER_ENABLED=true` pueda producir
  `arb_hold`s sin forma de resolverlos en prod.
