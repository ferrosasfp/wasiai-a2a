# Work Item — [WKH-93] Opt-in refunds para fallos del agente en /compose (fee-on-attempt mitigation)

## Resumen
Hoy `/compose` debita `priceUsdc` de cada step ANTES de invocar al agente
(step 0 en el middleware; steps 1..N en `composeService`). Esta HU agrega un
flag **opt-in por step** (`refundOnFailure: boolean`) que, cuando el agente
downstream falla con un error de **infraestructura/servidor** (5xx o error de
red — NO error de validación 4xx), acredita de vuelta el monto debitado de ese
step, deja constancia con un header (`x-refund-applied`), un log estructurado
y una fila de auditoría en una tabla nueva.

**Opción elegida: A (flag por step)**. Opciones B (`POST /compose/refund`
endpoint separado) y C (circuit-breaker) quedan explícitamente OUT — HUs
futuras.

## ⚠️ HALLAZGO CRÍTICO DE F0 — lee esto antes de aprobar

El ticket original describe el modelo actual como **"fee-on-attempt puro"**:
"si el agente downstream falla, el caller paga igual". **Esto ya NO es cierto
en el código de hoy.** Desde WKH-128/129/130 (2026-06-24 → 2026-06-30), el
pipeline de `/compose` **YA reembolsa automáticamente e incondicionalmente**
el débito de un step cuando ese step falla (para steps 1..N vía
`refundStepDebit()` en `compose.ts:321-371`, llamado desde el `catch` sin
gate; para step 0, vía el bloque de refund best-effort en
`routes/compose.ts:442-552`, también incondicional). Esto aplica **a
cualquier tipo de fallo** — 5xx, 4xx, timeout de red, error de validación —
sin distinguir la causa.

Es decir: **el "fee-on-attempt" que el ticket quiere mitigar con un opt-in ya
no existe hoy tal cual** — existe un reembolso automático (sin distinguir
5xx/4xx) que se implementó por una razón distinta (WKH-128: "el caller no
debe pagar un step que no entregó valor", robustez, no anti-DoS).

Los AC del ticket (AC-3: 4xx NO refund; AC-4: flag ausente + fallo → paga, NO
refund) **solo tienen sentido si esta HU además REVIERTE el comportamiento
actual** para que, por defecto (`refundOnFailure` ausente/false), el sistema
vuelva a NO reembolsar en 4xx y a cobrar en 5xx salvo que el caller opte in.
Esto es un cambio de comportamiento de billing en producción, sobre un
money-path que ya tiene 4 HUs de hardening encima (WKH-128/129/130 + WKH-142).
Ver DT-1 / Missing Inputs — **bloqueante para F2**.

## Sizing
- SDD_MODE: full
- Estimación: L (money-path + migración + nueva taxonomía de error HTTP en
  `invokeAgent` + dos superficies de refund — step 0 en route, steps 1..N en
  service — + variantes dual-ledger delegación/sesión)
- Branch sugerido: `feat/153-wkh-93-compose-refund-on-failure`

## Acceptance Criteria (EARS)

- **AC-1**: WHEN un step tiene `refundOnFailure: true` Y su invocación falla
  con un status HTTP 5xx o un error de red/conexión (fetch failure) del
  agente downstream, THE system SHALL acreditar de vuelta exactamente el
  monto debitado para ese step (`stepDebitedUsd` en steps 1..N /
  `composeEstimatedCostUsd` en step 0) vía el camino de crédito atómico
  existente (`budgetService.credit`/`creditWithDest`/`creditDelegation`/
  `creditSession`) Y SHALL setear el header de respuesta
  `x-refund-applied: <amount>`.
- **AC-2**: WHEN un step tiene `refundOnFailure: true` Y el agente responde
  2xx, THE system SHALL NOT alterar el billing (el débito normal del step se
  mantiene, sin crédito adicional).
- **AC-3**: IF un step tiene `refundOnFailure: true` Y la invocación falla con
  un status HTTP 4xx (error de input/validación del caller), THEN THE system
  SHALL NOT acreditar de vuelta el monto debitado de ese step.
- **AC-4**: WHILE el `refundOnFailure` de un step es `false` o está ausente,
  THE system SHALL cobrar por el intento sin reembolso en caso de fallo
  (comportamiento fee-on-attempt puro) — **requiere DT-1 resuelto**: esta AC
  implica revertir el auto-refund incondicional que existe hoy (WKH-128/129)
  para los steps SIN el flag activo.
- **AC-5**: WHEN se aplica un refund por AC-1, THE system SHALL emitir un log
  estructurado `compose-refund.applied` con `requestId`, `step` (índice),
  `slug` del agente, `priceUsdc`/monto acreditado y `reason`.
- **AC-6**: WHEN se aplica un refund por AC-1, THE system SHALL insertar una
  fila de auditoría en la tabla nueva `a2a_compose_refunds` (columnas:
  `id`, `request_id`, `step_index`, `key_id`, `chain_id`, `amount_usd`,
  `reason`, `owner_ref`, `created_at`).
- **AC-7**: WHERE ya existe una fila de auditoría para el par
  `(request_id, step_index)` en `a2a_compose_refunds`, THE system SHALL
  tratar una re-aplicación de ese refund como no-op (idempotente), reforzado
  por un constraint `UNIQUE(request_id, step_index)`.
- **AC-8**: THE system SHALL exponer `refundOnFailure?: boolean` como campo
  aditivo y opcional en `ComposeStep` — callers existentes que lo omiten no
  ven cambio de shape ni de comportamiento salvo lo definido en AC-4/DT-1.
- **AC-9**: WHEN se ejecuta la suite de tests, THE system SHALL pasar la
  baseline existente completa Y SHALL incluir tests nuevos que cubran
  AC-1..AC-8 (incluyendo los caminos dual-ledger de delegación/sesión y el
  camino step-0).

## Scope IN
- `src/types/index.ts` — `refundOnFailure?: boolean` en `ComposeStep`
  (aditivo). Campo aditivo adicional en `ComposeResult`/`StepResult` para
  transportar la clasificación HTTP del fallo (necesario para que
  `routes/compose.ts` pueda decidir sobre el fallo de step 0 — hoy solo
  llega un `string` en `result.error`). Diseño exacto del campo: F2.
- `src/services/compose.ts` — detección post-invoke de 5xx/network-error para
  steps 1..N dentro del `catch` existente (líneas ~300-540), gateado por
  `steps[i].refundOnFailure`, reusando la maquinaria de refund YA existente
  (`refundStepDebit`, `stepDestination`, dual-ledger delegación/sesión).
- `src/services/compose.ts` (`invokeAgent`) — nueva taxonomía de error tipado
  (status HTTP / kind red vs 4xx) en vez del `Error(message)` genérico actual
  (`compose.ts:888-890`), para que el `catch` pueda distinguir 5xx de 4xx sin
  parsear el string del mensaje.
- `src/routes/compose.ts` — gate de `steps[0].refundOnFailure` en el bloque
  de refund post-fallo existente (líneas 442-552), usando la clasificación
  HTTP propagada desde el service.
- `supabase/migrations/` — migración nueva: tabla `a2a_compose_refunds`
  (mirror del patrón `a2a_refund_outbox`, RLS deny-by-default + owner_ref) +
  su down script. **NO** se crea una función PG nueva de crédito — se
  reutilizan las RPCs atómicas existentes (ver DT-2).
- Logging: nuevo evento estructurado `compose-refund.applied`.
- Tests: nuevos + baseline intacta.

## Scope OUT
- Opción B: endpoint `POST /compose/refund` — HU futura.
- Opción C: circuit-breaker por agente — HU futura.
- Mecanismo de timeout POR STEP (hoy no existe — solo el timeout de TODO el
  request vía `TIMEOUT_COMPOSE_MS` en el preHandler). Ver DT-5.
- Tocar el veredicto de acceptance criteria de WKH-114
  (`result.acceptance.verdict`) — ese trigger es DISTINTO (AC-fail de
  contenido) y su CD-1/AC-6 dice explícitamente que NO toca billing. Esta HU
  NUNCA debe disparar refund desde `acceptance.verdict==='fail'`.
- Cambiar la lógica interna del retry adaptativo (WKH-130) — el refund/re-debit
  interno del retry sigue igual; `refundOnFailure` aplica al fallo TERMINAL
  del step (post-retry-agotado), no a los intentos intermedios (ver Missing
  Inputs #3).
- Aplicar la migración en la DB (queda para el paso de activación, DB
  objetivo hoy = bdwv/testnet).

## Decisiones técnicas (DT-N)
- **DT-1 (BLOQUEANTE)**: el modelo "fee-on-attempt" que el ticket describe
  como comportamiento actual **ya fue revertido por WKH-128/129/130** — hoy
  se reembolsa automáticamente e incondicionalmente CUALQUIER fallo de step
  (5xx, 4xx, red). Para que AC-3/AC-4 tengan sentido, esta HU debe **gatear
  ese auto-refund existente detrás del nuevo flag** (default false = vuelve
  a cobrar sin reembolso en cualquier fallo; true = reembolsa SOLO 5xx/red).
  Alternativa: dejar el auto-refund incondicional intacto para 4xx (como
  hoy) y que esta HU solo AGREGUE el header/log/audit-row sin cambiar qué se
  reembolsa — pero eso contradice AC-3 tal como está escrito. **Requiere
  ratificación humana explícita antes de F2** (ver Missing Inputs #1).
- **DT-2**: la primitiva de "credit" que el ticket pide como PG function
  nueva (`decrement_a2a_key_spend`, espejo de `increment_a2a_key_spend`) **ya
  existe** — no como esa función exacta, sino como la familia
  `refund_a2a_key_spend` (WKH-127) / `refund_with_dest_policy` (WKH-129) /
  `refund_delegation_and_parent` / `refund_session_and_parent` (audit M1,
  2026-07-01), expuestas vía `budgetService.credit`/`creditWithDest`/
  `creditDelegation`/`creditSession` (`src/services/budget.ts:381-591`), cada
  una atómica (`FOR UPDATE`) con ownership guard DB-level. **NO crear una PG
  function nueva de crédito** — reusar estas 4. La única migración nueva de
  esta HU es la tabla de auditoría `a2a_compose_refunds`.
- **DT-3**: el `requestId` para la fila de auditoría es `request.id`
  (Fastify, auto-generado, ya usado como `requestId` en la response y como
  `orchestrationId` de `chargeProtocolFee` en `routes/compose.ts:593`).
  Se propaga a `composeService.compose()` para los steps 1..N (hoy no viaja
  en `ComposeRequest` — se agrega, aditivo) y ya está disponible en el route
  handler para step 0.
- **DT-4**: distinguir 5xx / 4xx / error-de-red requiere que `invokeAgent`
  (`compose.ts:755-994`) deje de lanzar `Error(string)` genérico
  (`compose.ts:888`) para el caso `!response.ok`, y en su lugar lance un
  error tipado que porte el `status` HTTP (y un discriminador para errores de
  red pre-response, p. ej. `fetch failed`/`ECONNREFUSED`/`SSRFViolationError`
  — este último NO debe calificar como "fallo del agente" reembolsable,
  ver DT-6). Diseño exacto de la clase de error: F2.
- **DT-5**: hoy NO existe timeout por-step — solo `TIMEOUT_COMPOSE_MS` a
  nivel de TODO el `/compose` request (`routes/compose.ts:345-347`). Si ese
  timeout global dispara, `reply.sent` ya es `true` y el flujo actual corta
  con varios `if (reply.sent) return;` — el catch de refund per-step de
  `compose.ts` puede no alcanzar a correr de forma observable por el
  cliente. Recomendación (default si no hay objeción): **v1 acota el
  trigger a 5xx + error de red del fetch al agente** (lo que SÍ es
  detectable hoy); un timeout POR STEP real (AbortController con
  `timeoutMs` configurable) queda fuera de esta HU salvo que F2 decida
  incluirlo como sub-feature.
- **DT-6**: taxonomía de "fallo elegible para refund" a definir en F2 — debe
  EXCLUIR explícitamente: errores de scoping/budget que nunca llegan a
  `invokeAgent` (ya manejados antes en el loop), bloqueos SSRF
  (`SSRFViolationError` — decisión de seguridad del gateway, no falla del
  agente) y errores de field-parsing que YA disparan el retry adaptativo de
  WKH-130 (el refund de esta HU aplica al fallo TERMINAL post-retry, no a
  cada intento).
- **DT-7**: `ComposeResult` necesita un campo aditivo (p. ej.
  `errorHttpStatus?: number` o similar) para que `routes/compose.ts` pueda
  clasificar el fallo de STEP 0 sin re-parsear el string `result.error` —
  hoy ese string es de la forma `Step 0 failed: Agent x returned 503: ...`
  y no es un contrato estable para parsear.

## Constraint Directives (CD-N)
- **CD-1**: PROHIBIDO disparar un refund de esta HU desde
  `result.acceptance.verdict === 'fail'` (WKH-114). El trigger es
  EXCLUSIVAMENTE 5xx/error-de-red HTTP del agente — nunca el veredicto de
  acceptance criteria de contenido. WKH-114 CD-1/AC-6 son intocables.
- **CD-2**: OBLIGATORIO usar las RPCs atómicas existentes
  (`refund_a2a_key_spend` / `refund_with_dest_policy` /
  `refund_delegation_and_parent` / `refund_session_and_parent`) vía
  `budgetService`. PROHIBIDO escribir un `UPDATE` directo a
  `a2a_agent_keys.budget` fuera de esas RPCs (rompe el `FOR UPDATE` +
  ownership guard).
- **CD-3**: OBLIGATORIO `UNIQUE(request_id, step_index)` en
  `a2a_compose_refunds` — reintentar/reaplicar el mismo refund debe ser
  no-op (AC-7).
- **CD-4**: PROHIBIDO tocar o remover el guard anti-double-debit `i > 0`
  (`compose.ts:201`, CD-11 de WKH-59). Esta HU es aditiva sobre el flujo de
  refund existente.
- **CD-5**: OBLIGATORIO `owner_ref` + `RLS ENABLE` (deny-by-default) en
  `a2a_compose_refunds`, mismo patrón que `a2a_refund_outbox`
  (WKH-SEC-02 / audit M6). El service usa `SERVICE_ROLE` (bypassa RLS); la
  RLS es defensa en profundidad, no el guard real.
- **CD-6**: OBLIGATORIO additive-only en `ComposeStep`/`ComposeResult` —
  ningún caller existente que omite `refundOnFailure` debe ver un shape de
  request/response distinto (salvo el comportamiento de billing que define
  DT-1/AC-4, que debe resolverse explícitamente, no por omisión silenciosa).
- **CD-7**: PROHIBIDO propagar el mensaje crudo de Postgres al cliente en el
  insert de auditoría nuevo — mismo patrón "CD-B" ya usado en
  `budget.ts` (log server-side, error code estable al cliente).
- **CD-8**: OBLIGATORIO enrutar el refund por delegación/sesión al camino
  DUAL-LEDGER correspondiente (`creditDelegation`/`creditSession`) cuando
  `request.delegationContext`/`request.keySessionContext` estén presentes —
  igual que el fix M1 (audit 2026-07-01). PROHIBIDO usar
  `credit`/`creditWithDest` bajo delegación/sesión (dejaría
  `total_spent`/`spent_usd` inflado — self-DoS de la credencial).
- **CD-9**: SI el credit-back falla (`reverted:false`), OBLIGATORIO encolar
  en `a2a_refund_outbox` (patrón existente, audit M6) en vez de inventar un
  mecanismo de retry paralelo. La fila de auditoría de `a2a_compose_refunds`
  SOLO se inserta cuando el refund efectivamente revirtió (no reclamar un
  refund que no ocurrió).
- **CD-10**: PROHIBIDO que el nuevo flag interfiera con el retry adaptativo
  de WKH-130 — el refund/re-debit interno del retry (PASO 1/PASO 6b en
  `compose.ts`) queda intacto; `refundOnFailure` solo decide si el fallo
  TERMINAL final del step (tras agotar el retry, si aplica) queda
  efectivamente reembolsado o no.

## Waves QUALITY (para F2.5/F3)
- **Wave 0**: tipos aditivos (`refundOnFailure` en `ComposeStep`, campo de
  clasificación HTTP en `ComposeResult`) + migración `a2a_compose_refunds`
  (tabla + RLS + UNIQUE + down script).
- **Wave 1**: taxonomía de error tipado en `invokeAgent` (status HTTP /
  network-error), sin cambiar comportamiento default (solo el tipo del throw).
- **Wave 2**: refund condicional per-step (i>0) en `compose.ts`, gateado por
  `refundOnFailure` + clasificación 5xx/red, + log `compose-refund.applied` +
  insert de auditoría + outbox en fallo de refund.
- **Wave 3**: refund condicional step-0 en `routes/compose.ts`, mismo gate,
  usando la clasificación HTTP propagada desde el service + header
  `x-refund-applied`.
- **Wave 4**: tests (baseline completa + AC-1..AC-9, incluyendo variantes
  dual-ledger delegación/sesión y step-0) + drift check F4.

## Missing Inputs
- **[BLOQUEANTE] #1 (DT-1)**: ¿esta HU debe REVERTIR el auto-refund
  incondicional que existe hoy (WKH-128/129/130) para que, sin el flag, el
  sistema vuelva a cobrar sin reembolso en CUALQUIER fallo (lectura literal
  de AC-3/AC-4)? ¿O el auto-refund actual debe quedar intacto para 4xx (como
  hoy) y esta HU solo agrega header/log/audit-row al camino 5xx, dejando
  AC-3 sin cumplir tal como está redactado? **Necesita ratificación humana
  explícita antes de pasar a F2** — es un cambio de comportamiento de
  billing en producción sobre un money-path con 4 HUs de hardening previas.
- **[NEEDS CLARIFICATION, no bloqueante, default aplicado] #2 (DT-5)**: no
  existe timeout por-step hoy. Default: v1 acota el trigger a 5xx + error de
  red del fetch (sin construir un timeout-por-step nuevo). Si se requiere
  timeout real por step, es una sub-feature a decidir en F2.
- **[NEEDS CLARIFICATION, no bloqueante, default aplicado] #3 (CD-10)**:
  interacción exacta con el retry adaptativo WKH-130 — default: el flag
  aplica solo al fallo TERMINAL post-retry-agotado (no a intentos
  intermedios), consistente con que el retry ya maneja su propio
  refund/re-debit interno sin exponerlo al caller.

## Análisis de paralelismo
- Bloquea/es bloqueada: ninguna HU abierta depende de esta. No compite con
  WKH-114 (152, DONE) — trigger distinto y billing-neutral por diseño (CD-1).
- Puede ir en paralelo con cualquier HU que no toque `compose.ts` /
  `budget.ts` / `routes/compose.ts` / migraciones de `a2a_agent_keys`.
- Comparte superficie (money-path de compose) con WKH-128/129/130/142 — el
  Adversary Review de esta HU DEBE releer esas 4 HUs para no reintroducir un
  double-debit o un refund duplicado (mismo checklist que auto-blindaje de
  HUs anteriores).
