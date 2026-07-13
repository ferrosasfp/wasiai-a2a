# Work Item — [WKH-191c] Motor de reconciliación — resolver `reconciliation_pending` + drift budget-vs-escrow

## Resumen

Tercera HU de la Wave 0 del epic WKH-191 (settlement non-custodial vía `WasiAIEscrow`).
191b deja intents en `debit_settle_status='reconciliation_pending'` (o huérfanos en
`'hop1_confirmed'`) cuando el hop 1 (`escrow.debit`, buyer→operador) se confirmó
on-chain pero el hop 2 (operador→seller) falló o quedó ambiguo — los fondos del
buyer YA salieron del escrow y están custodiados temporalmente por el operador.
191c construye el motor que **resuelve exactamente un lado** (completar el pago
al seller o devolver al buyer, nunca ambos ni ninguno) tras re-verificar on-chain
la realidad del hop 1, y agrega la detección de drift entre el `budget` off-chain
(cache) y `escrowBalance(keyId)` on-chain (libro autoritativo, decisión del founder).
Para: el equipo de ops (resuelve manualmente vía endpoint admin) y, en el límite,
un cron externo que lo dispare periódicamente una vez activado 191b en prod.

## Sizing

- SDD_MODE: full
- Estimación: L
- Branch sugerido: feat/191c-reconciliation-engine

## Acceptance Criteria (EARS)

- AC-1: WHEN un admin invoca el endpoint de listado, the system SHALL devolver todos
  los intents con `debit_settle_status IN ('hop1_confirmed','reconciliation_pending')`
  (incluye el estado huérfano `hop1_confirmed` que nunca llegó a hop 2 — mismo índice
  `idx_debit_sig_settle_status` de 191b) con la evidencia mínima necesaria (`key_id`,
  `nonce`, `debit_hop1_tx_hash`, `finalAmountUsd`, `owner_ref`, `intent_id`).
- AC-2: WHEN el reconciler procesa un intent pendiente, the system SHALL re-verificar
  on-chain la existencia del evento `Debited(keyId, nonce)` correspondiente al
  `debit_hop1_tx_hash` persistido (reusando el patrón log-scan de
  `escrow-verifier.ts`/`debit-executor.ts`) ANTES de decidir cualquier lado — el hash
  persistido puede ser tentativo (vino de un hop 1 `ambiguous`).
- AC-3: IF la re-verificación confirma que el evento `Debited` existe (el operador
  custodia `finalAmountUsd`) Y el intent aún no está `settled`, THEN the system SHALL
  reintentar EXCLUSIVAMENTE el hop 2 (operador→seller, reusando `settleEscrowAware`
  con la guardia exactly-once de 191b que skipea hop 1) y marcar el intent como
  resuelto-via-hop2, SIN reembolsar el budget off-chain.
- AC-4: IF la re-verificación determina que el evento `Debited` NO existe (el hop 1
  no movió fondos realmente, pese al estado tentativo persistido), THEN the system
  SHALL resolver como refund: transfer directo operador→buyer-wallet (mismo primitivo
  que el hop 2, `payTo` = dirección recuperada de la firma, `debit_signer_recovered`)
  + reembolso correspondiente del budget off-chain (`refund_a2a_key_spend`), marcando
  el intent como resuelto-via-refund.
- AC-5: WHILE un intent ya tiene un estado terminal de resolución persistido por 191c
  (resuelto-via-hop2 O resuelto-via-refund), the system SHALL prevenir una segunda
  ejecución de la resolución sobre ese mismo intent (no-op money-safe ante reintentos
  del reconciler o dobles clicks del admin).
- AC-6: the system SHALL garantizar que NINGÚN intent resulte simultáneamente o en
  corridas sucesivas en hop2-completado Y refund-ejecutado (mutuamente excluyentes,
  verificable vía el estado terminal persistido — CHECK constraint a nivel DB).
- AC-7: WHEN se invoca el chequeo de drift del libro, the system SHALL comparar el
  histórico de hops 1 confirmados por `key_id` (suma de `debit_amount_atomic` con
  `debit_settle_status` ∈ `{hop1_confirmed, settled, reconciliation_pending}`) contra
  `escrowBalance(keyId)` leído on-chain, y reportar cualquier discrepancia (sin
  corregir automáticamente el `budget` agregado — DT-5).
- AC-8: WHERE `ESCROW_SETTLE_ENABLED` está OFF, the system SHALL permitir el listado
  y el reporte de drift (read-only) pero SHALL rechazar/no-ejecutar cualquier acción
  money-moving (hop2-retry o refund) del reconciler.
- AC-9: IF un caller invoca el endpoint de EJECUCIÓN de la resolución (money-moving)
  sin `X-Admin-Token` válido (con `DASHBOARD_ADMIN_TOKEN` configurado), THEN the
  system SHALL rechazar con 401/403 sin ejecutar ninguna acción money-moving.

## Scope IN

- Endpoint(s) admin-gated (mismo patrón `dashboard.ts`/WKH-189: `X-Admin-Token` +
  `DASHBOARD_ADMIN_TOKEN`) nuevo módulo/archivo (p. ej. `src/routes/reconciliation.ts`
  o extensión de `dashboard.ts`):
  - `GET` — lista intents en `hop1_confirmed`/`reconciliation_pending` (AC-1).
  - `POST` — ejecuta la resolución exactly-one-side de UNO o de todos los pendientes
    (AC-2..AC-6).
- Re-verificación on-chain del evento `Debited` (reuso del log-scan de
  `escrow-verifier.ts`/`debit-executor.ts`, sin ABI paralelo).
- Retry hop2-only reusando `settleEscrowAware` (191b) tal cual — la guardia
  exactly-once (`debit_hop1_tx_hash` seteado → skip hop1) es el primitivo que 191c
  invoca, sin duplicar lógica de hop 1.
- Refund al buyer: transfer directo operador→buyer-wallet (mismo seam que hop 2,
  `payTo` distinto) + `refund_a2a_key_spend` del monto correspondiente.
- Migración additive nueva: columna(s)/estado terminal para distinguir
  resuelto-via-hop2 de resuelto-via-refund (auditable, timestamp, CHECK mutuamente
  excluyente) — extiende `a2a_payment_intent_debit_signatures` (sibling de 191b), NO
  toca los RPC money-path auditados de wkh135.
- Drift check puntual budget-vs-`escrowBalance(keyId)` — DETECCIÓN + REPORTE
  (telemetría/respuesta del endpoint), NO corrección automática del agregado.
- Flag-gating de las acciones money-moving (reusa `isEscrowSettleEnabled()`).
- Idempotencia/exactly-once de la resolución en múltiples corridas del reconciler.

## Scope OUT

- El agente-árbitro autónomo de disputas (WKH-139 v2 / Wave 1 del epic) — la
  resolución de `reconciliation_pending` es MECÁNICA (verificación de hechos
  on-chain), no arbitraje entre partes en disputa. Cero cambios a `arbiter.ts`.
- El seam decimals-aware (WKH-192, referenciado por el orquestador; = R-1/MI-1 de
  191b) — sigue bloqueando el happy-path two-hop en Base hasta que se resuelva; el
  reconciler opera igual sobre lo que EXISTE en DB/on-chain, no arregla el seam.
- La activación de 191b en prod (migración aplicada + flags Railway) — pertenece a
  191d. Hoy no existe NINGUNA fila `reconciliation_pending` en prod porque 191b está
  PENDING-DEPLOY.
- Un scheduler/cron NUEVO en-proceso (`setInterval`/librería de cron) dentro de
  `wasiai-a2a` — el trigger es un endpoint invocable manual o externamente (mismo
  patrón cron-job.org de WKH-75/149-151), no infraestructura de scheduling nueva.
- Corrección automática GLOBAL/recompute del `budget` agregado desde
  `escrowBalance` — desagregar fuentes de funding multi-chain (escrow Base vs.
  treasury en otras chains) está fuera de este corte (DT-5).
- Cambios a `contracts/` (Solidity) — cero.
- Soporte de escrow en chains nuevas — sigue acotado a Base Sepolia (único deploy).

## Decisiones técnicas (DT-N)

- DT-1 (refund NO usa `withdraw()` del contrato): `WasiAIEscrow.withdraw(keyId,
  amount)` exige `msg.sender == _depositor[keyId]` (`contracts/src/WasiAIEscrow.sol:188-194`)
  — el backend/operador NO puede invocarlo en nombre del buyer, no existe función de
  "crédito de vuelta" al escrow que el operador pueda llamar. El refund es un
  **transfer directo operador→buyer-wallet**, reusando el MISMO primitivo/seam que el
  hop 2 (`settlePaymentIntentOnChain`-style; `payTo` = la dirección recuperada de la
  firma persistida, `debit_signer_recovered`, en vez del seller), pagado de los fondos
  propios del operador (que ya los recibió en hop 1). `escrowBalance(keyId)` NO se
  restaura — el buyer recupera el valor real en su wallet EOA, simplemente deja de
  estar "en escrow" (puede re-depositar si quiere seguir operando con escrow). Esta es
  la decisión de diseño más crítica de la HU; sin ella el Architect podría intentar
  diseñar alrededor de `withdraw()`, que es inviable con el contrato actual.
- DT-2 (trigger = endpoint admin-gated, sin scheduler nuevo): mismo patrón
  `DASHBOARD_ADMIN_TOKEN`/`X-Admin-Token` de `dashboard.ts` (WKH-189). `GET`
  (listado/drift, read-only) puede seguir el patrón opt-in actual (público si el env
  no está seteado, igual que hoy). `POST` (ejecución money-moving) se recomienda
  **fail-closed** (requerir el token SIEMPRE en prod, aunque el env no esté seteado —
  desviación del patrón opt-in de `dashboard.ts` justificada porque este POST mueve
  dinero real) — ver Missing Inputs #1. Un cron externo (cron-job.org, patrón WKH-75)
  puede apuntar al `POST` periódicamente una vez activado 191b; el wiring del cron NO
  es parte obligatoria de esta HU (no hay `reconciliation_pending` en prod hasta la
  activación de 191b) — ver Missing Inputs #2.
- DT-3 (exactly-one-side + idempotencia en 3 capas, espejo del modelo de 191b §7):
  (a) status-machine/`FOR UPDATE` en la resolución del intent; (b) guardia app-side —
  el nuevo estado terminal de 191c se persiste ANTES de mover fondos (BLQ-DR, mismo
  principio que `record_debit_hop1`); (c) backstop on-chain — el nonce quemado
  (`_usedNonces`) impide un segundo `debit()` real; para el lado refund, el backstop
  es el propio estado terminal persistido por 191c (CHECK mutuamente excluyente en DB,
  AC-6), porque el contrato no tiene un backstop nativo para transfers directos
  operador→buyer.
- DT-4 (re-verificación on-chain reusa el patrón existente): `decodeEventLog(Debited)`
  filtrado por dirección del contrato + `keyId`/`nonce`, mismo patrón de
  `escrow-verifier.ts:195-227` (`verifyEscrowDeposit`) y del paso 5 de
  `executeDebitHop1` en `debit-executor.ts` (191b) — NO se introduce un ABI ni un
  método de verificación paralelo.
- DT-5 (libro autoritativo = `escrowBalance(keyId)`, alcance mínimo correcto): por
  decisión del founder, on-chain es la fuente de verdad; el `budget` off-chain agrega
  funding de MÚLTIPLES chains/rutas (escrow Base + treasury en chains sin escrow), por
  lo que 191c **NO recomputa el agregado** desde `escrowBalance` (desagregar fuentes
  de funding está fuera de este corte). Alcance mínimo: (a) drift check PUNTUAL —
  reportar/alertar discrepancias entre el histórico de hop1-confirmados por `key_id`
  y el `escrowBalance(keyId)` real leído on-chain; (b) la única corrección de dinero
  que 191c ejecuta es la resolución exactly-one-side de `reconciliation_pending`
  (Scope IN #1), puntual por-intent, NO una recomputación global del libro.
- DT-6 (flag-gated money-moving, read-only libre): el reconciler reusa
  `isEscrowSettleEnabled()`/`ESCROW_SETTLE_ENABLED` como gate de TODA acción que mueva
  dinero (hop2-retry, refund). El listado y el reporte de drift (AC-1/AC-7) pueden
  correr con el flag OFF (telemetría inocua) — solo el `POST` de ejecución respeta
  el gate.

## Constraint Directives (CD-N)

- CD-1 (EXACTLY-ONE-SIDE): PROHIBIDO que un mismo intent resulte en hop2-completado
  Y refund-ejecutado (double-credit), simultáneamente o en corridas sucesivas del
  reconciler. PROHIBIDO también que un intent quede sin resolver tras un run exitoso
  de la resolución (fondos colgados indefinidamente en el operador).
- CD-2 (IDEMPOTENCIA / BLQ-DR): OBLIGATORIO persistir el estado terminal de la
  resolución (settled-via-191c / refunded-via-191c) ANTES o ATómicamente con el
  side-effect de dinero, de forma que un retry del reconciler sobre el MISMO intent
  sea un no-op money-safe.
- CD-3 (RE-VERIFICACIÓN ON-CHAIN PREVIA): PROHIBIDO decidir el lado (hop2 vs refund)
  basándose únicamente en el estado persistido en DB (`debit_hop1_tx_hash`/
  `debit_settle_status`) sin re-confirmar on-chain el evento `Debited` correspondiente
  — el estado persistido puede ser tentativo (vino de un hop 1 `ambiguous`).
- CD-4 (LIBRO AUTORITATIVO ON-CHAIN, sin autocorrección global): OBLIGATORIO tratar
  `escrowBalance(keyId)` como fuente de verdad para el drift check; PROHIBIDO
  sobrescribir/corregir el `budget` off-chain agregado a partir de una comparación
  simplista sin desagregar fuentes de funding — solo reportar drift.
- CD-5 (NO CONTRATO / NO ÁRBITRO): PROHIBIDO tocar `contracts/` (Solidity) y
  PROHIBIDO tocar `arbiter.ts`/lógica de disputa (Wave 1, bloqueada por decisión de
  founder pendiente).
- CD-6 (FLAG-GATED MONEY-MOVING): PROHIBIDO ejecutar hop2-retry o refund si
  `ESCROW_SETTLE_ENABLED` está OFF; el listado/reporte read-only SÍ puede correr.
- CD-7 (ADMIN-GATED TRIGGER MONEY-MOVING): OBLIGATORIO que el endpoint que EJECUTA
  la resolución (`POST`, money-moving) esté gateado por `DASHBOARD_ADMIN_TOKEN`/
  `X-Admin-Token`; PROHIBIDO exponer un trigger público sin autenticación que mueva
  fondos (a diferencia del `GET` read-only, que puede seguir el patrón opt-in actual).
- CD-8 (OWNERSHIP GUARD, WKH-53): OBLIGATORIO que cualquier RPC/query nueva sobre
  `a2a_payment_intent_debit_signatures`/`a2a_payment_intents`/`a2a_agent_keys` filtre
  por `owner_ref`; las llamadas a `refund_a2a_key_spend`/RPCs existentes deben usar
  el `owner_ref` REAL del intent (leído de la fila), nunca asumido/inventado por el
  caller admin.

## Missing Inputs

- [NEEDS CLARIFICATION] #1: ¿El `POST` que ejecuta la resolución debe requerir
  SIEMPRE `DASHBOARD_ADMIN_TOKEN` en prod (fail-closed si el env no está seteado),
  a diferencia del patrón opt-in actual de `dashboard.ts` (público si el env no está
  seteado)? Recomendación del Analyst: SÍ — fail-closed obligatorio para el `POST`
  money-moving, dado el riesgo (mueve fondos reales), aunque el `GET` read-only puede
  mantener el patrón opt-in existente. A ratificar/detallar en F2.
- [NEEDS CLARIFICATION] #2: ¿Se requiere wiring de un cron externo (cron-job.org) que
  dispare el `POST` periódicamente dentro de ESTA HU, o alcanza con el endpoint
  invocable manualmente (dashboard/curl/ops)? Recomendación: DIFERIR el wiring del
  cron a la activación (191d) — no hay ninguna fila `reconciliation_pending` en prod
  hasta que 191b se despliegue y active; el endpoint por sí solo es suficiente scope
  para 191c.
- [NEEDS CLARIFICATION] #3: umbral/severidad del drift budget-vs-`escrowBalance` para
  decidir cuándo ALERTAR (vs. solo reportar en el response del endpoint). Dado que
  son unidades atómicas enteras (sin redondeo esperado salvo el gap ya conocido de
  R-1/seam decimals-aware), recomendación: reportar CUALQUIER discrepancia ≠ 0;
  dejar el mecanismo de alerting (Discord/`alerts.mjs`, patrón WKH-71/77 vs. solo
  respuesta HTTP) a decisión de Architect en F2.
- [resuelto en F2]: naming exacto de la(s) columna(s)/valor(es) del estado terminal
  nuevo que distingue resuelto-via-hop2 de resuelto-via-refund — el criterio
  FUNCIONAL ya está fijado en DT-3/CD-1 (mutuamente excluyente, persistido,
  CHECK-constrained); el Architect define el shape exacto de la migración en el SDD.

## Análisis de paralelismo

- **Depende de:** WKH-191b (fila 174, DONE código · PENDING-DEPLOY) — 191c consume
  directamente la tabla/RPCs/primitivo `settleEscrowAware` que 191b entrega. No puede
  arrancar F2 antes de tener el contrato de datos de 191b como base (ya lo tiene, es
  código DONE aunque no deployado).
- **NO bloquea la activación funcional de 191b:** 191b es code-complete y money-safe
  sin 191c (deja los fondos custodiados de forma segura y auditable, nunca los
  pierde). 191c es la pieza que SANEA ese estado temporal — recomendado tenerlo listo
  ANTES de habilitar el flag `ESCROW_SETTLE_ENABLED` ampliamente en prod, para no
  acumular reconciliation-pending sin mecanismo de resolución, pero no es un
  bloqueante duro de código.
- **Paralelizable con WKH-192 (seam decimals-aware, R-1/MI-1 de 191b):** superficie de
  archivos distinta en su mayoría (191c toca un endpoint admin nuevo + un módulo de
  reconciliación + migración sibling; WKH-192 toca `usdToWei`/decimals en
  `payment-intent.ts`/adapters de settle). Overlap leve posible en
  `payment-intent.ts` (ambas HUs tocan el vecindario de `settleEscrowAware`/
  `settlePaymentIntentOnChain`) — recomendado coordinar el merge order si corren en
  simultáneo, pero no requiere secuenciarlas.
- **Bloqueada por decisión de founder (Wave 1, fuera de esta HU):** el árbitro
  (WKH-139 v2 activado sobre escrow) sigue bloqueado por las 2 decisiones pendientes
  del epic (fila 172) — 191c no las destraba ni las necesita.
- **191d (activación: migraciones + flags Railway + verificación `OPERATOR_PRIVATE_KEY`
  == `_operator`)** debería secuenciarse DESPUÉS de 191c code-complete, para activar
  el flag con el motor de reconciliación ya disponible desde el día 1 de producción.
