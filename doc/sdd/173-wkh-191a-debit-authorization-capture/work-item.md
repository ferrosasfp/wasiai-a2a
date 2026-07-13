# Work Item — [WKH-191a] Captura + persistencia de la firma EIP-712 DebitAuthorization (flujo normal)

## Resumen

Primera HU de la Wave 0 del epic WKH-191 (fila 172 de `_INDEX.md`, ver
`doc/sdd/172-wkh-191-escrow-noncustodial-settlement/work-item.md`). Captura, valida y
persiste — SIN moverla a ningún side-effect on-chain — la firma EIP-712
`DebitAuthorization` que el buyer (session/upto) somete junto al `close`/`settle` de su
payment intent. Es el primer eslabón para que una HU posterior (191b) pueda invocar
`WasiAIEscrow.debit()` con una autorización cripto-verificable del buyer, en vez del
patrón actual donde el operador mueve fondos propios sin firma alguna del comprador.

## Sizing

- SDD_MODE: full
- Estimación: M
- Branch sugerido: `feat/191a-debit-authorization-capture`

## Nuance de diseño resuelta (cuándo/qué se firma)

El contrato (`WasiAIEscrow._verifyAndConsume`, `WasiAIEscrow.sol:121-141`) exige el
**monto EXACTO firmado** (`if (amount > bal) revert InsufficientBalance()` compara contra
el monto firmado, no contra un tope) — no soporta un modelo "hasta X" (up-to) en una sola
firma. En una `session`, el monto final del settle (`min(Σvouchers, deposit)`) NO se conoce
al abrir; en un `upto`, el monto final (`min(cap, reportedUsage)`) tampoco se conoce al
abrir el intent (el cap es un TOPE, no el monto a cobrar).

**Decisión (DT-1): firmar en CLOSE/SETTLE, no en OPEN.** Tanto `POST /session/:id/close`
como `POST /upto/:id/settle` son llamadas SÍNCRONAS hechas por el buyer (autenticado vía
`resolveCallerKey`) en el momento en que el monto final ya es derivable por el propio
cliente sin ambigüedad:
- **session**: el cliente ya conoce `consumedUsd` (lo recibe echoed en cada respuesta de
  `POST /session/:id/voucher`) y conoce el `deposit` (lo fijó él mismo al abrir) →
  `min(consumedUsd, deposit)` es computable client-side ANTES de llamar a `close`.
- **upto**: el cliente ya conoce el `cap` (lo firmó él mismo al crear el intent) y ELIGE
  `reportedUsageUsd` en el mismo request de `settle` → `min(cap, reportedUsageUsd)` es
  trivialmente computable client-side en el mismo momento.

Esto permite firmar el monto EXACTO sin requerir un segundo round-trip (quote→sign→confirm)
y sin ningún cambio de Solidity — confirma/aterriza el DT-1 del epic ("Wave 0 usa `debit()`
tal como existe, sin cambios de contrato") específicamente para el paso de captura.

**Alternativa descartada para esta HU**: firmar una autorización "hasta el deposit/cap" al
abrir el intent. `WasiAIEscrow.debit()` no tiene semántica de consumo parcial/incremental
sobre una sola firma (una firma = un `nonce` = un consumo exacto, `_usedNonces[keyId][nonce]`
se marca usado en el primer `debit()` exitoso) — soportarlo requeriría una función de
contrato nueva (o une "delta" explícito con múltiples firmas pre-emitidas), lo cual es
territorio de Wave 1/cambio de contrato y por lo tanto **fuera de 191a**.

**Validación server-side obligatoria (no confiar ciegamente)**: el servidor sigue
computando su propio monto final dentro de `close_payment_intent_for_settle` (fuente de
verdad, ya implementado en WKH-135). Esta HU valida que `message.amount` (convertido a
unidades atómicas del token del escrow, vía `resolveEscrowContract`/
`bundle.payment.supportedTokens[0].decimals`, mismo patrón que `escrow-verifier.ts:229-243`)
coincide EXACTAMENTE con el monto server-computado. Un mismatch NO rompe el settle actual
(que sigue corriendo por el path operator-custodial sin cambios) — solo marca la firma
capturada como inválida, con motivo, para telemetría/debug de 191b.

## Acceptance Criteria (EARS)

- AC-1: WHEN `ESCROW_DEBIT_CAPTURE_ENABLED=true` AND el caller envía `debitSignature` +
  `debitNonce` + `debitDeadline` en el body de `POST /session/:id/close` o
  `POST /upto/:id/settle`, the system SHALL recover el firmante EIP-712
  `DebitAuthorization` reusando `DEBIT_AUTHORIZATION_TYPES`/`buildDebitDomain` de
  `src/adapters/escrow/eip712.ts` y SHALL persistir la firma, el firmante recuperado y el
  resultado de la validación, ligados al `intent_id`, sin alterar el resultado del
  close/settle.
- AC-2: IF el firmante recuperado no coincide con `buyer_wallet` del intent, OR el
  `amount` firmado (unidades atómicas del token del escrow) no coincide EXACTAMENTE con
  el monto final computado por `close_payment_intent_for_settle` (`min(Σvouchers,deposit)`
  para session / `min(cap,reportedUsage)` para upto), OR el `nonce` ya fue usado para ese
  `keyId`, THEN the system SHALL marcar la firma capturada como inválida (con motivo
  específico persistido) y SHALL NOT rechazar ni alterar el close/settle subyacente.
- AC-3: WHEN `ESCROW_DEBIT_CAPTURE_ENABLED=false` (default) OR no hay contrato escrow
  configurado para la chain del intent (`resolveEscrowContract` devuelve `null`), the
  system SHALL ejecutar `POST /session/:id/close` y `POST /upto/:id/settle`
  byte-idénticamente al comportamiento actual, ignorando cualquier campo `debit*`
  presente en el body.
- AC-4: WHILE una firma `DebitAuthorization` válida está persistida para un intent, the
  system SHALL NOT invocar `WasiAIEscrow.debit()` ni mover fondos en base a ella — el
  settlement sigue fluyendo EXCLUSIVAMENTE por el path operator-custodial existente
  (`settlePaymentIntentOnChain`).
- AC-5: IF el mismo par `(keyId, debitNonce)` se somete dos veces, THEN the system SHALL
  rechazar/marcar como inválida la segunda ocurrencia (anti-replay, espejo de
  `_usedNonces[keyId][nonce]` del contrato) sin afectar el resultado del settle en sí.
- AC-6: WHERE el `debitDeadline` recibido ya venció (`now > deadline`) at capture time,
  the system SHALL marcar la firma como inválida con motivo `DEADLINE_EXPIRED` en vez de
  persistirla como válida.

## Scope IN

- `src/routes/payments.ts`: nuevos campos OPCIONALES `debitSignature` / `debitNonce` /
  `debitDeadline` en el body de `POST /session/:id/close` y `POST /upto/:id/settle`
  (write-boundary: strings/number válidos o ausentes; ausentes ⇒ comportamiento actual).
- `src/services/payment-intent.ts`: paso de captura+validación (best-effort, no bloqueante)
  invocado DESPUÉS de que `closeSession`/`settleUpto` conocen el monto final, ANTES o en
  paralelo al settle real existente — nunca condicionando su resultado.
- `src/adapters/escrow/eip712.ts`: agregar un helper de RECOVER (hoy solo hay
  `buildDebitAuthorization`/`hashDebitAuthorization`, ambos de firma server-side; falta el
  camino de verificación de una firma YA recibida del cliente, análogo a
  `recoverTypedDataAddress` que `payment-intent.ts:verifyCapSignature` ya usa para el cap
  `upto`). Sale de PROVISIONAL para este call-site.
- Reuso (sin duplicar) de `resolveEscrowContract` (`escrow-verifier.ts:94-101`) para
  resolver `verifyingContract` y decidir si la captura aplica a la chain del intent, y de
  `bundle.payment.supportedTokens[0].decimals` para la conversión USD→atómico (mismo
  patrón que `escrow-verifier.ts:229-243`, CD-8 "nunca literal").
- Migración Supabase aditiva: columnas/tabla nueva para persistir
  `debit_signature`, `debit_nonce`, `debit_deadline`, `debit_signer_recovered`,
  `debit_validation_status` (`valid`/`invalid`/`not_provided`/`not_applicable`),
  `debit_validation_reason` — con `owner_ref` (Ownership Guard, CD-2/WKH-53), índice único
  `(key_id, debit_nonce)` para anti-replay (espejo de
  `uq_a2a_payment_intents_cap_nonce`), y RLS deny-by-default (mismo patrón que
  `20260704000000_wkh135_payment_intents.sql`).
- Env var nueva `ESCROW_DEBIT_CAPTURE_ENABLED` (default false/unset).
- Tests unitarios del helper de captura/validación (firma válida, firmante incorrecto,
  monto mismatch, nonce repetido, deadline vencido, flag OFF, chain sin escrow
  configurado) + tests de ruta confirmando comportamiento byte-idéntico con el flag OFF.

## Scope OUT

- Invocar `WasiAIEscrow.debit()` o cualquier función del contrato (rewire real = 191b).
- Cualquier cambio en `contracts/src/*.sol` / `IWasiAIEscrow.sol` (Wave 0 entera es
  sin-Solidity per epic DT-1; un cambio de contrato movería esto a Wave 1).
- Reconciliación `budget` off-chain vs `escrowBalance(keyId)` on-chain (191c).
- Config/deploy del contrato escrow en chains nuevas (191d).
- Wiring del árbitro (`arbiter.ts`) a cualquier camino on-chain (Wave 1, 191f-h) — fuera
  incluso conceptualmente, esta HU no toca `arbiter.ts`.
- SDK/cliente real que PRODUZCA la firma en producción (fuera de este backend HU; los
  tests usan un `PrivateKeyAccount` de viem como mock del firmante, mismo patrón que
  `eip712.test.ts` / los tests existentes del cap `upto`).
- Hacer `debitSignature`/`debitNonce`/`debitDeadline` OBLIGATORIOS en el request (quedan
  opcionales en esta HU; volverlos requeridos es una decisión de 191b/rollout, no de
  captura).

## Decisiones técnicas (DT-N)

- DT-1: firmar en CLOSE/SETTLE (no en OPEN) — ver sección "Nuance de diseño resuelta"
  arriba. Zero cambios de Solidity, zero segundo round-trip.
- DT-2: el monto firmado se valida en unidades ATÓMICAS del token del escrow (decimals
  reales del token, vía `bundle.payment.supportedTokens[0].decimals` — NO asumir 18
  decimales como hace `usdToWei()` en `payment-intent.ts:141-145`, que es específico del
  settlement Kite/PYUSD existente y NO aplica al token del escrow). El Architect debe
  confirmar en F2 los decimals reales del `_usdc` deployado (Base Sepolia testnet USDC).
- DT-3: la captura reusa el mismo patrón de anclaje que el cap `upto` (WKH-135): el
  firmante recuperado se compara contra `buyer_wallet` (= `funding_wallet` del caller),
  no contra ningún otro campo.
- DT-4: la captura es puramente ADITIVA sobre el resultado existente del close/settle —
  el helper de validación NUNCA debe poder lanzar una excepción que interrumpa el flujo
  real de settle (mismo espíritu que CD-7 de `payment-intent.ts`: "el settle NUNCA
  rechaza la promise").
- DT-5: anti-replay del nonce escopeado por `key_id` (no global), espejo exacto de
  `_usedNonces[keyId][nonce]` del contrato — NO reusar el índice `uq_a2a_payment_intents_cap_nonce`
  (ese es del cap `upto`, dominio distinto), crear uno nuevo dedicado.

## Constraint Directives (CD-N)

- CD-1: OBLIGATORIO flag-gated — `ESCROW_DEBIT_CAPTURE_ENABLED` default OFF/unset; con el
  flag OFF, cualquier campo `debit*` recibido en el body se IGNORA por completo (ni se
  parsea con intención de validar, ni se persiste) — comportamiento byte-idéntico al
  actual.
- CD-2: PROHIBIDO que la captura/validación de la firma bloquee, retrase o altere en modo
  alguno el resultado del close/settle real — corre en modo best-effort; cualquier error
  interno de la captura se loguea y se descarta, NUNCA se propaga como fallo del
  close/settle.
- CD-3: PROHIBIDO invocar `WasiAIEscrow.debit()` (ni ninguna función del contrato) desde
  esta HU — es captura+persistencia+validación pura, cero side-effects on-chain. El
  rewire real es 191b.
- CD-4: PROHIBIDO modificar cualquier archivo bajo `contracts/` en esta HU.
- CD-5: OBLIGATORIO reusar EXACTAMENTE `DEBIT_AUTHORIZATION_TYPES` / `buildDebitDomain` de
  `src/adapters/escrow/eip712.ts` (ya marcados "typehash derivado por viem, NUNCA
  hardcodeado" — CD-3 propia del archivo) — prohibido definir un segundo struct EIP-712
  paralelo o divergente.
- CD-6: OBLIGATORIO Ownership Guard (`owner_ref`) en toda query/RPC nueva sobre
  `a2a_payment_intents` o la tabla/columnas nuevas de firmas (patrón WKH-53, exigido por
  CLAUDE.md del repo).
- CD-7: PROHIBIDO tratar una firma persistida y válida como habilitante de movimiento de
  fondos — es un artefacto inerte hasta que 191b la consuma explícitamente.

## Missing Inputs

- [resuelto en F2] Decimals exactos del token `_usdc` del escrow deployado (Base Sepolia
  testnet) — necesarios para la conversión USD→atómico del monto firmado (DT-2). El
  Architect debe confirmarlos leyendo config/`_usdc.decimals()` o el bundle de chain
  correspondiente antes de fijar la fórmula de conversión en el SDD.
- [resuelto en F2] Nombre final de la(s) columna(s)/tabla nueva para persistir la firma —
  esta HU no prescribe si es una tabla sibling nueva (`a2a_payment_intent_debit_signatures`)
  o columnas aditivas directas en `a2a_payment_intents`; el Architect decide en F2 según
  cardinalidad esperada (¿puede haber más de un intento de firma por intent? probablemente
  sí — retries del cliente — lo que favorece tabla sibling con historial vs columna única
  sobreescribible).
- [no bloqueante, informativo] Hoy NO existe ningún cliente/SDK real que produzca esta
  firma en producción — los tests de esta HU (y de 191b) dependen de mocks
  (`PrivateKeyAccount` de viem), igual que el resto de firmas EIP-712 del repo
  (`upto` cap, `signed-auth.ts`, `delegation.ts`).

## Análisis de paralelismo

- No bloquea ninguna HU DONE/in-progress fuera del epic (superficie exclusiva de
  `payment-intent.ts`/`payments.ts`/`adapters/escrow/*`, no tocada por las filas
  159-171 de `_INDEX.md`).
- Bloquea a 191b (rewire del settle) — 191b consume la firma que 191a captura/valida.
- Puede avanzar en paralelo a cualquier trabajo de Wave 1 (191f-h), que está bloqueada por
  decisiones de founder distintas y no comparte código.
