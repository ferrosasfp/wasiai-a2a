# Work Item — [WKH-136] Splits atómicos al settlement (bps: plataforma/creador/referral)

> Nota de numeración: este ítem es **Jira WKH-136** del roadmap OKX Wave 1
> (`doc/competitive/attack-plan-2026-07.md`). NNN de este SDD = **138**
> (siguiente libre en `doc/sdd/`; 136/137 no existen como carpetas SDD —
> WKH-136 como *fila* de `_INDEX.md` ya está ocupada por un ticket distinto,
> WKH-142/SEC follow-up de WKH-134 — no confundir esa fila con esta HU).

## Resumen
Generalizar el protocol fee único actual (1% flat, cost-based desde WKH-132,
cobrado a una única wallet `WASIAI_PROTOCOL_FEE_WALLET` vía
`chargeProtocolFee()`) en **splits configurables en basis points (bps)**
ruteados en el momento del settlement hacia múltiples recipients
(plataforma / creador / referral / royalty). Ataca el gap identificado vs
OKX APP en `doc/competitive/okx-ai-analysis-2026-07.md` ("Splits: First-class
atomic bps splits at settlement" — OKX / "Single protocol fee, credit-back on
failure" — nosotros). Money-path: requiere QUALITY completo (SDD + AR + CR).

## Sizing
- SDD_MODE: full
- QUICK_FLOW: **QUALITY** (money-path — toca el único punto de cobro real
  del sistema: `src/services/fee-charge.ts` + los dos call-sites de
  settlement, `src/routes/orchestrate.ts` execute y `src/services/compose.ts`
  fee-compose WKH-118. Cualquier bug acá es pérdida de fondos o doble-cobro).
- Estimación: M (según attack-plan; grounding confirma que el esqueleto
  reutilizable — idempotencia, EIP-712 sign+settle, re-verify on-chain — ya
  existe en `fee-charge.ts`, pero el modelo N-recipient + refund N-way es
  trabajo real, no trivial).
- Branch sugerido: `feat/138-wkh-136-atomic-splits-bps`

## Skills Router
- `nexus-agile` (metodología, obligatoria)
- Dominio: money-path / billing atómico — mismo dominio que WKH-44 (fee real
  charge), WKH-118 (fee compose), WKH-127/129/130/132 (billing orchestrate) y
  WKH-53/WKH-SEC-02b (ownership guard). Reusar sus patrones de idempotencia
  DB + EIP-712 sign/settle + credit-back, no reinventarlos.

## Acceptance Criteria (EARS)

- AC-1: WHEN un settlement de protocol fee se dispara (orchestrate `/execute`
  o compose fee-compose WKH-118), the system SHALL dividir el monto del fee
  en 1..N recipients según una configuración de bps, donde la suma de todos
  los bps de esa configuración SHALL ser exactamente 10000 (100%) antes de
  aplicar cualquier split.

- AC-2: IF los bps configurados para un settlement no suman exactamente
  10000, THEN the system SHALL rechazar el cálculo del split (fail-closed,
  cero cobro parcial) con un error explícito — mismo espíritu defensivo que
  el guard actual `feeUsdc > feeBaseUsdc` en `fee-charge.ts:173-177`
  (`ProtocolFeeError`), NO un guard nuevo y más débil.

- AC-3: WHEN un settlement con splits se ejecuta y una o más transferencias
  a un recipient fallan mientras otras tienen éxito, the system SHALL
  registrar el status por-recipient individualmente (`charged` / `failed` /
  `skipped`) — un split parcial es observable y NUNCA se reporta como
  "charged" agregado si algún recipient falló.

- AC-4: WHILE un pipeline/step con splits ya aplicados es reembolsado
  (credit-back per WKH-127/129, mismo mecanismo de `refund_with_dest_policy` /
  `creditWithDest`), the system SHALL revertir TODOS los splits asociados a
  ese step/orchestration — no solo el share de plataforma — de forma que
  ningún recipient (creador/referral/royalty) retenga un payout por trabajo
  cancelado/fallido.

- AC-5: WHEN `/orchestrate/plan` (o el quote equivalente de compose) reporta
  el fee al caller, the system SHALL mantener el contrato de transparencia ya
  shippeado (`protocolFeeUsdc` / `feeRatePercent`, WKH-132/WKH-133
  fee-transparency, `doc/sdd/133-wkh-132-fee-transparency/`) — el total
  cobrado al caller sigue siendo el mismo número visible, con o sin desglose
  de splits expuesto.

- AC-6: IF un recipient de la configuración de splits resuelve a una wallet
  inválida o ausente, THEN the system SHALL saltear (skip) ese recipient
  específico (log estructurado, sin crashear el settlement completo) —
  comportamiento exacto de fallback **[NEEDS CLARIFICATION: ver Missing
  Inputs — no está definido si el share huérfano se re-enruta a plataforma,
  se descarta, o aborta todo el settlement]**.

## Scope IN
- `src/services/fee-charge.ts`: generalizar `chargeProtocolFee()` (o crear un
  módulo hermano, p. ej. `fee-split.ts`, que lo envuelva) para aceptar N
  recipients con bps en vez de una única `WASIAI_PROTOCOL_FEE_WALLET`.
- `src/routes/orchestrate.ts` (`/execute`, líneas ~380-411 donde hoy se
  calcula `feeUsdc`/`feeRate`) — punto de invocación del cobro con splits.
- `src/services/compose.ts` (fee-compose, WKH-118) — segundo call-site que
  comparte el mismo servicio de fee-charge; debe quedar coherente con el
  nuevo modelo, no divergir en un fork paralelo.
- Persistencia: extensión o sucesora de `a2a_protocol_fees`
  (`supabase/migrations/20260421015829_a2a_protocol_fees.sql`, hoy PK única
  `orchestration_id` + una sola `fee_wallet` — incompatible tal cual con
  N-recipient) para soportar idempotencia por-recipient.
- Extensión del path de refund/credit-back (mismo patrón que
  `refund_with_dest_policy` / `creditWithDest` de WKH-127/129) para reversar
  N splits en vez de 1.
- Validación fail-closed de `sum(bps) == 10000` antes de cualquier cobro.

## Scope OUT
- Los nuevos intents de pago `session`/`upto` (APP-style) — HU separada,
  Jira **WKH-135 del roadmap OKX** (`doc/competitive/attack-plan-2026-07.md`,
  **[NEEDS CLARIFICATION]** NO confundir con la fila 132 de `_INDEX.md`, un
  WKH-135 histórico ya DONE — "centralizar config LLM" — que es un ticket
  distinto con el mismo número; colisión de numeración documentada en
  `_INDEX.md` filas 132-135).
- UI/dashboard para que un creador configure su % de split — este repo es el
  gateway, no la superficie de administración; si se necesita UI vive en
  `wasiai-v2` (fuera de este scope).
- KYC/onboarding/verificación de wallets de recipients de referral/royalty —
  fuera de scope salvo que F2 decida lo contrario.
- Cambiar el pago directo agente↔caller (`agent.payTo` vía downstream x402
  settle en `compose.ts:invokeAgent`) — ese es el pago POR EL SERVICIO del
  agente, un money-path distinto del protocol fee; esta HU solo generaliza
  el fee de plataforma en splits, no reestructura el pago al agente salvo
  que F2/producto decida lo contrario (ver Missing Inputs #3).
- Nuevo mecanismo de transferencia batch on-chain (contrato tipo
  `WasiAIEscrow.debitBatch`, WKH-126a) — DEFAULT es transferencias
  secuenciales best-effort reusando el adapter actual, salvo que Missing
  Inputs #7 (definición de "atómico") resuelva lo contrario.

## Decisiones técnicas (DT-N)
- DT-1: Cada split-leg reusa EXACTAMENTE el mismo primitivo de transferencia
  que `chargeProtocolFee()` usa hoy (`getPaymentAdapter().sign()` +
  `.settle()` + `verifyDefaultChainSettle()` re-verify on-chain, patrón
  `fee-charge.ts:257-345`) — N transferencias secuenciales idempotentes, NO
  una transacción on-chain multi-output nativa (los adapters actuales son
  transfer-por-recipient, tipo EIP-3009/EIP-712 single-recipient).
- DT-2: El modelo de datos requiere una tabla nueva o una migración de
  `a2a_protocol_fees` — hoy su PK es `orchestration_id` único con una sola
  `fee_wallet`; splits necesitan una clave compuesta
  (`orchestration_id` + `recipient_role` o `recipient_id`) para que cada
  recipient tenga su propia fila idempotente. Diseño exacto: Architect en F2,
  con runbook de migración (`doc/sdd/075-wkh-78-migration-preflight/`).
- DT-3: `getProtocolFeeRate()` (env `PROTOCOL_FEE_RATE`, clamp [0, 0.10])
  sigue siendo la ÚNICA fuente del rate TOTAL cobrado; los splits subdividen
  ese monto ya calculado (`feeUsdc = feeBaseUsdc * feeRate`) en shares por
  bps — NO son un cobro adicional sobre el settlement bruto
  **[NEEDS CLARIFICATION: confirmar — ver Missing Inputs #3, esto asume que
  "plataforma" hoy YA ES el 100% del fee actual, y de ahí en más cede bps a
  otros recipients, en vez de sumar un cobro nuevo encima]**.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO cobrar cualquier split de una configuración cuya suma de
  bps no sea exactamente 10000 — fail-closed (equivalente a
  `ProtocolFeeError`), nunca un cobro parcial silencioso.
- CD-2: OBLIGATORIO que cada split individual tenga su propia clave de
  idempotencia (`orchestration_id` + identificador de recipient) — PROHIBIDO
  reusar la fila/PK única actual de `a2a_protocol_fees` para más de un
  recipient (colisionaría el `PRIMARY KEY (orchestration_id)` existente).
- CD-3: PROHIBIDO introducir un mecanismo de transferencia paralelo a
  `getPaymentAdapter().sign()`/`.settle()` — cada leg del split usa
  exactamente el mismo adapter, la misma conversión `usdc→wei` (patrón
  `feeUsdcToWei`, `fee-charge.ts:133-135`) y el mismo re-verify on-chain
  (`verifyDefaultChainSettle`, TB-01) que el fee único usa hoy.
- CD-4: OBLIGATORIO que el path de refund/credit-back revierta TODOS los
  splits asociados a un step/orchestration fallido — no solo el share de
  plataforma. AR debe verificar, citando archivo:línea, que el nuevo refund
  itera sobre TODOS los recipients cobrados, no solo el primero.
- CD-5: PROHIBIDO romper el contrato de transparencia ya shippeado
  (`protocolFeeUsdc == totalCostUsdc * feeRatePercent/100`, invariante de
  WKH-132/WKH-133) — el caller sigue viendo el mismo total cobrado,
  desglosado o no en splits.
- CD-6: PROHIBIDO derivar recipients de splits desde un input no-autenticado
  del caller (p. ej. un `referralWallet` libre en el body de
  `/orchestrate/execute`) sin un guard de ownership/validación — mismo
  espíritu del ownership guard `owner_ref` (CLAUDE.md, Security Conventions)
  aplicado a la NUEVA superficie de "wallets de recipients".

## Riesgos identificados (categorías, sin resolver — insumo para F2/AR)
- **Suma de bps = 10000 (100%)**: quién valida (env config estática vs
  configuración por-request/por-agente), y qué pasa si la validación se
  hace tarde (post-cobro) en vez de antes — CD-1 exige antes.
- **Redondeo / dust**: bps sobre montos en USDC (6 decimales) no siempre
  dividen exacto (ej. 3333/3333/3334 bps de un monto pequeño). Falta definir
  quién absorbe el residuo (plataforma por default, o se trunca y se pierde
  fee) — no asumido, **[NEEDS CLARIFICATION]**.
- **Doble-cobro**: dos call-sites (`orchestrate.ts` execute y `compose.ts`
  fee-compose) comparten `fee-charge.ts` hoy; si el refactor a splits
  introduce dos rutas de cálculo distintas por call-site, hay riesgo real de
  divergencia (un call-site aplica splits, el otro no, o los aplica distinto).
- **Quién recibe cada split**: hoy NO existe un concepto de "wallet del
  creador de un agente" en el codebase (`registries`/agentes solo tienen
  `payTo` como pago DIRECTO por el servicio, no como revenue-share de
  plataforma) — introducir creator/referral/royalty como recipients de un
  split de PLATAFORMA es una decisión de producto nueva, no una extensión
  natural de una tabla existente.
- **Refund con splits**: el path de credit-back actual
  (`refund_with_dest_policy`/`creditWithDest`) revierte un solo débito hacia
  un solo destino; con N recipients cobrados, un refund parcial (revertir
  solo 2 de 3 legs) deja el sistema en un estado contable inconsistente si no
  se diseña explícitamente como all-or-nothing con reintentos (mismo patrón
  `refundOutbox` ya existente para fallos de refund simple).
- **Atomicidad real vs nominal**: el título dice "splits atómicos", pero el
  money-path actual liquida vía transferencias EIP-712 secuenciales
  (una por recipient), no una transacción on-chain multi-output —
  "atómico" hoy solo puede significar "atómico en el ledger/contabilidad
  interna" (todo-o-nada a nivel aplicación), no atomicidad on-chain nativa
  salvo que se adopte el contrato de escrow (WKH-126a,
  `doc/sdd/121-wkh-126a-escrow-contract/`) con `debitBatch`.

## Missing Inputs
- [NEEDS CLARIFICATION — bloqueante para F2] ¿Quiénes son los recipients de
  los splits (plataforma / creador / referral / royalty)? ¿De dónde vienen
  sus addresses/`owner_ref`? Hoy no existe un campo de "wallet de creador"
  en `registries` ni en el Agent Card — habría que introducirlo.
- [NEEDS CLARIFICATION — bloqueante para F2] ¿Los bps se configuran
  per-agente (ej. campo en `registries`/Agent metadata), per-request (el
  caller especifica splits en el payload de `/orchestrate` o `/compose`), o
  global (env, como `PROTOCOL_FEE_RATE` hoy)? Cada opción tiene superficie de
  ataque distinta (per-request abre la puerta a que un caller malicioso
  defina su propio split — requiere CD-6 reforzado).
- [NEEDS CLARIFICATION — bloqueante para F2] ¿Cómo interactúa con el
  `protocolFeeUsdc` actual? ¿El fee de plataforma de hoy ES uno de los N
  splits (plataforma retiene X bps de ese mismo monto ya calculado, DT-3), o
  los splits son un cobro ADICIONAL sobre el settlement (aumentando el total
  que paga el caller, rompiendo el contrato de transparencia de WKH-132/133,
  CD-5)?
- [NEEDS CLARIFICATION — bloqueante para F2] ¿Se persiste una configuración
  nueva de splits (tabla dedicada, columna JSONB en `registries`, o algo
  distinto)? ¿Quién la administra (endpoint admin, self-serve vía el flujo
  de publish de WKH-134, o solo config estática por env para el MVP)?
- [NEEDS CLARIFICATION] ¿Cómo se atribuye un "referral" a una request
  concreta? Hoy no existe ningún parámetro de referral/atribución en los
  payloads de `/orchestrate` o `/compose` — habría que definir el mecanismo
  de tracking antes de poder pagarle a nadie por ese concepto.
- [NEEDS CLARIFICATION] "royalty" — ¿es sinónimo de "creador" (el publisher
  del agente cobra un royalty por uso) o una categoría distinta (ej. IP
  licenciada de terceros)? El humano no distinguió.
- [NEEDS CLARIFICATION] Definición operacional de "atómico" en el título de
  la HU — ver categoría de riesgo "Atomicidad real vs nominal" arriba. Sin
  esto, F2 no puede decidir si el MVP es transferencias secuenciales
  best-effort (como hoy, ×N) o requiere el contrato de escrow con
  `debitBatch`.
- [NEEDS CLARIFICATION] Fallback de recipient inválido/wallet ausente
  (AC-6): ¿el share huérfano se re-enruta a plataforma, se descarta (dust),
  o aborta el settlement completo?
- [NEEDS CLARIFICATION] ¿Esta HU aplica tanto a `/orchestrate` (execute)
  como a `/compose` (fee-compose, WKH-118), o solo a uno de los dos
  call-sites en un primer MVP? El humano no especificó alcance por endpoint.

## Análisis de paralelismo
- **Comparte el path de settlement con WKH-135 del roadmap OKX** ("Intents
  de pago `session`/`upto`", Jira ticket distinto del WKH-135 histórico de
  `_INDEX.md` fila 132 — ver nota de numeración arriba). Ambas HUs tocan
  `src/services/fee-charge.ts` y los mismos call-sites de settlement
  (`orchestrate.ts` execute, `compose.ts`). El `attack-plan-2026-07.md`
  ordena explícitamente "Intents primero → luego splits (mismo path de
  settlement)" — **recomendación: SERIAL, no paralelo**. Si F3 de WKH-136
  arranca antes de que WKH-135(intents) tenga al menos su SDD/Story File
  aprobado, hay riesgo alto de refactorizar `fee-charge.ts` dos veces
  (splits primero, intents después reabriendo el mismo archivo) en vez de
  diseñar una vez el modelo generalizado (fee-charge con N-recipients Y
  N-intents).
- No bloquea Wave 0 (WKH-132/133/134 del roadmap OKX, ya DONE — filas
  132-135 de `_INDEX.md`).
- No bloquea directamente Wave 2 (WKH-137 IM/QR, WKH-138 embedded wallet) —
  son ejes de UX/transporte, no de fee-splitting.
- Precondición lógica (no dura) para WKH-141 (bridge APP-compatible, Wave 3)
  — APP define splits atómicos como primitiva nativa; tener nuestros propios
  splits shippeados facilita hablar ese protocolo, pero no es un bloqueo
  técnico estricto.
- Dentro de este repo: bloquea cualquier decisión futura de "creator payout"
  si se resuelve que vive en `wasiai-a2a` (vs. `wasiai-v2` como capa de
  producto) — parte de los Missing Inputs de arriba.
