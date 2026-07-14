# Work Item — [WKH-194] Contra-medida del nonce del árbitro (cierra el griefing MNR-1/R-3)

> Follow-up de seguridad de [WKH-191g](../178-wkh-191g-arbiter-onchain-wire/work-item.md) (fila 178
> de `_INDEX.md`), Wave 1 del epic [WKH-191](../172-wkh-191-escrow-noncustodial-settlement/work-item.md).
> Origen: hallazgo **MNR-1** del AR de 191g (`doc/sdd/178-wkh-191g-arbiter-onchain-wire/ar-report.md:70-76`),
> que refina el riesgo **R-3** documentado en el SDD de 191g. El E2E on-chain (2026-07-13) ya probó
> que el árbitro funciona correctamente en el resto de sus propiedades de seguridad (caja de prueba
> `0x85b7…` en kite, `resolveDispute` pagó al seller) — este ticket cierra el único vector de
> griefing pendiente antes de que el árbitro on-chain sea seguro con montos reales.

## Resumen

`deriveArbiterNonce` (`src/adapters/escrow/arbiter-executor.ts:72-83`) deriva el `nonce` de
`resolveDispute` de forma **determinista y pública**: `(1<<255) | (keccak256(dom, keyIdHash,
intentId) & (2^255-1))`. Cualquiera que conozca `keyId` + `intentId` (el propio buyer, dueño de
ambos) puede re-derivarlo off-chain, ANTES de que exista ninguna disputa. Como `debit()` acepta un
`nonce` **elegido libremente por el cliente** en el body de captura
(`src/adapters/escrow/debit-capture.ts:39-44,176-188`, `DebitCaptureInput.nonce`) y comparte el
MISMO mapping `_usedNonces[keyId][nonce]` que `resolveDispute`
(`contracts/src/WasiAIEscrow.sol:55,170,276`), un buyer puede pre-consumir ese nonce vía una firma
`DebitAuthorization` propia (monto trivial) para SU `keyId` en SU `intentId`, antes de perder una
disputa. Cuando el árbitro on-chain esté activo (post-WKH-191h + consentimiento capturado — WKH-193)
y trate de pagar al seller con `resolveDispute(keyId, seller, sellerAmount, nonce)`, el contrato
revierte `NonceAlreadyUsed` (`WasiAIEscrow.sol:276`) → `not_moved` → rama `unequivocal`
(`src/services/arbiter.ts:767-795`) → **refund del deposit COMPLETO al buyer, el seller ganador
cobra CERO**. Esta HU hace el nonce del árbitro **no pre-consumible** por el buyer, preservando
exactly-once.

## Sizing

- SDD_MODE: full
- Estimación: **M** (cambio acotado — 1 función pura + 1 punto de persistencia nueva + 1 env var +
  tests — pero money-path/security-adjacent, amerita SDD completo y AR/CR estrictos aunque el
  árbitro siga inerte hoy)
- Branch sugerido: `fix/194-arbiter-nonce-anti-griefing`

## Grounding (F0, archivo:línea)

- `src/adapters/escrow/arbiter-executor.ts:60-83` — `deriveArbiterNonce(keyIdHash, intentId)`: fórmula
  actual, pura, determinista, **sin ningún componente secreto** — `ARBITER_NONCE_FLAG`/
  `ARBITER_NONCE_LOW_MASK` (bit 255 siempre seteado) son namespace-hygiene contra colisión
  ACCIDENTAL con el generador de nonces del cliente honesto, NO una barrera contra un buyer
  ADVERSARIAL que elige su propio nonce a propósito.
- `src/adapters/escrow/arbiter-executor.ts:252-343` — `executeResolveDispute`: recibe `nonce` como
  parámetro y lo pasa tal cual a `resolveDispute` (`:274-283`); re-verifica el evento
  `DisputeResolved(..., nonce)` (`:330-337`) — no valida nada sobre el origen/imprevisibilidad del
  nonce, confía en el caller.
- `src/services/arbiter.ts:99-165` (`settleArbitrationOnChain`) — único call-site de
  `deriveArbiterNonce` (línea 130): `nonce = deriveArbiterNonce(keyIdHash, intentId)`, calculado
  FRESCO en cada invocación (no persistido). `keyIdHash = keccak256(stringToBytes(keyId))` (`:120`,
  `keyId` = `params.keyId`, que en la única llamada real (`executeArbitration:728-735`) es
  `row.key_id` del RPC `close_payment_intent_for_arbitration` — el `key_id` real del intent
  disputado, conocido por el buyer desde que abrió el intent original). `intentId` = el propio id
  del payment intent — igualmente conocido por el buyer desde su creación, MUCHO antes de que
  exista una disputa.
- `src/services/arbiter.ts:662-824` (`executeArbitration`) — hoy el determinismo puro da
  exactly-once "gratis": un retry (dentro de la MISMA invocación, antes de llegar a `arb_closing`)
  recomputaría el MISMO nonce. El camino de recovery real (`applyRecovery`, `:687`, invocado cuando
  `row.prev_status === 'arb_closing'`) **no vuelve a llamar** `settleArbitrationOnChain`/
  `deriveArbiterNonce` — reaplica el veredicto YA persistido (`settle_outcome`/`settle_tx_hash`) vía
  `finalizePaymentIntent`. Es decir: el nonce se calcula (potencialmente) más de una vez SOLO dentro
  de intentos que no llegaron a persistir un veredicto — el contrato en Solidity provee la garantía
  final (`NonceAlreadyUsed` en un segundo intento real).
- `src/adapters/escrow/debit-capture.ts:39-44` (`DebitCaptureInput.nonce?: string`) y `:176-188`
  (`captureDebitSignature`, parseo de `capture.nonce` sin NINGUNA validación de rango/procedencia,
  solo verifica después firma/monto/deadline) — confirma que el `nonce` de `debit()` es
  **enteramente elegido por el cliente** en el body del close/settle; el contrato tampoco restringe
  el rango (`_verifyAndConsume`, `contracts/src/WasiAIEscrow.sol:162-182`, solo valida deadline +
  `_usedNonces[keyId][nonce]` + firma EIP-712 + balance). Esto habilita mecánicamente el ataque: el
  buyer firma su PROPIA `DebitAuthorization` válida (monto trivial, `msg.sender` sigue siendo el
  operador — `debit()` es `onlyOperator`, `:193`) eligiendo `nonce = deriveArbiterNonce(keyIdHash,
  intentId)` calculado offline, y la somete como parte de un close/settle legítimo (o de un intent
  señuelo) ANTES de que la disputa exista.
- `contracts/src/WasiAIEscrow.sol:55` — `mapping(bytes32 => mapping(uint256 => bool))
  internal _usedNonces` — namespace COMPARTIDO literal entre `debit()`/`debitBatch()` (`:170,180`) y
  `resolveDispute()` (`:276,282`); `:267-288` (`resolveDispute`) — `if (_usedNonces[keyId][nonce])
  revert NonceAlreadyUsed()` (`:276`), CEI estricto (nonce+balance+lock mutados antes del transfer,
  `:281-286`), paga al `seller` (parámetro), nunca a `msg.sender`.
- `doc/sdd/178-wkh-191g-arbiter-onchain-wire/work-item.md` DT-5/CD-3 (fila 178) — eligió el nonce
  determinista EXPLÍCITAMENTE para exactly-once, documentando el trade-off "exactly-once >
  anti-griefing" como aceptado en su momento (R-3), a resolver en un follow-up. Esta HU es ese
  follow-up.
- `doc/sdd/178-wkh-191g-arbiter-onchain-wire/ar-report.md:70-76` (**MNR-1**) — refina R-3 de
  "money-safe" (nada se mueve mal) a "el buyer puede evadir el pago al seller adjudicado (denegación
  de valor)". Sugiere DOS mitigaciones posibles: (a) distinguir `NonceAlreadyUsed` en la rama
  `unequivocal` (`src/services/arbiter.ts:767-795`) para enrutar a HOLD/RECONCILE en vez de refund
  automático completo, o (b) enforcement on-chain del namespace bit-255. Ninguna de las dos es
  exactamente las 2 opciones evaluadas en esta HU (ver Missing Inputs) — la (a) es un candidato de
  defensa en profundidad COMPLEMENTARIO, no un reemplazo del fix raíz.
- `supabase/migrations/20260704100000_wkh139_arbiter.sql` — crea `a2a_arbitrations` (WKH-139 v2),
  la tabla de auditoría que `upsertArbitrationRow`/`holdArbitration` escriben HOY, pero recién
  DESPUÉS de resolver el desenlace (`src/services/arbiter.ts:433-471` `upsertArbitrationRow`,
  invocada desde `emitAndRecord:1010-1031` y `holdArbitration:976-1006`) — es decir, DESPUÉS del
  punto donde hoy se necesitaría el nonce persistido (ver DT-2, timing-gap a resolver en F2).

## Acceptance Criteria (EARS)

- AC-1: WHEN el sistema necesita el nonce de `resolveDispute` para un `intentId` que AÚN NO tiene un
  nonce persistido, THE system SHALL derivarlo incorporando `ARBITER_NONCE_SECRET` (secreto
  server-side, nunca expuesto en logs/telemetría/recibos) junto con `keyIdHash` e `intentId`, y
  SHALL persistirlo ANTES de invocar `resolveDispute` on-chain.
- AC-2: WHEN el sistema necesita el nonce de `resolveDispute` para un `intentId` que YA tiene un
  nonce persistido (retry, recovery vía `arb_closing`, o reintento del mismo request), THE system
  SHALL reusar EXACTAMENTE ese valor persistido y SHALL NOT recomputar `deriveArbiterNonce` para ese
  `intentId`.
- AC-3: IF `ARBITER_NONCE_SECRET` no está configurado (ausente o vacío) mientras
  `ESCROW_ARBITER_ENABLED=true`, THEN THE system SHALL caer al path operator-custodial existente
  (`settlePaymentIntentOnChain`), sin invocar ninguna función `onlyArbiter`, y SHALL NOT usar ninguna
  fórmula de nonce que dependa únicamente de datos públicos (`keyId`/`intentId`) como fallback.
- AC-4 (ubiquitous): the system SHALL mantener el bit 255 SIEMPRE seteado en el nonce derivado
  (namespace disjunto de `debit()`/`debitBatch()`, `ARBITER_NONCE_FLAG` existente de 191g) como capa
  adicional de higiene, ADEMÁS del secreto — el secreto se agrega al digest, no reemplaza la
  estructura del nonce.
- AC-5 (unwanted): IF un buyer (o cualquier actor sin acceso a `ARBITER_NONCE_SECRET`) intenta
  pre-consumir el nonce del árbitro invocando `debit()`/capturando una `DebitAuthorization` con un
  nonce elegido arbitrariamente ANTES de que exista una disputa, THEN la probabilidad de que ese
  nonce coincida con el que el árbitro derivará más tarde para ese `intentId` SHALL ser
  criptográficamente insignificante (equivalente a adivinar un valor uniforme de ~255 bits sin
  conocer el secreto), cerrando el vector documentado en MNR-1/R-3.
- AC-6 (no-break): the system SHALL preservar byte-idéntico el comportamiento de las otras 3 patas
  del triple/cuádruple gate de 191g (flag `ESCROW_ARBITER_ENABLED` OFF, sin escrow configurado para
  la chain, o `arbitrationConsent(keyId)===false`) — esta HU es puramente aditiva sobre el
  cálculo/persistencia del nonce, sin tocar AC-1/AC-2/AC-7 de 191g.

## Scope IN

- `src/adapters/escrow/arbiter-executor.ts` — `deriveArbiterNonce`: incorporar
  `ARBITER_NONCE_SECRET` (leído vía env var, patrón `process.env.X`) al digest `keccak256` (junto al
  dominio existente `'WasiAIEscrow.arbiter-dispute.v1'`, `keyIdHash`, `intentId`) — la función se
  mantiene PURA dado el secreto, pero deja de ser el único punto de verdad del nonce (ver Scope
  IN siguiente).
- `src/services/arbiter.ts` (`settleArbitrationOnChain` y/o un helper nuevo tipo
  `getOrCreateArbiterNonce(intentId, ownerRef, keyIdHash)`) — wire de lectura-antes-de-generar: SELECT
  del nonce persistido; si existe, reusarlo tal cual (AC-2); si no existe, computarlo (AC-1),
  persistirlo, y usarlo. Debe ejecutarse ANTES de la primera llamada real a `executeResolveDispute`.
- Persistencia nueva del nonce por `(intentId)` — decisión de dónde en DT-2/Missing Inputs (columna
  en `a2a_arbitrations` vs. tabla dedicada nueva, con su migración `.sql` + `_down.sql` siguiendo el
  precedente `supabase/migrations/20260713000001_wkh191b_debit_hop1.sql`).
- Env var nueva `ARBITER_NONCE_SECRET` — documentar en `.env.example`, resolución fail-closed
  (ausente/vacío → seam cae al fallback, AC-3), nunca loggeado.
- Tests unitarios: `deriveArbiterNonce` con secreto (mismo secreto+inputs → mismo nonce; secreto
  distinto → nonce distinto; determinismo NO depende de re-derivar sin el valor persistido); tests
  del helper de persistencia (generar una vez, leer en el segundo intento SIN recomputar, incluso si
  el env var del secreto cambiara entre llamadas — para probar que el retry NO depende de la
  estabilidad del secreto); test de fallback con `ARBITER_NONCE_SECRET` ausente.

## Scope OUT

- `contracts/src/WasiAIEscrow.sol` / `IWasiAIEscrow.sol` — **sin cambios** (Opción A elegida es
  app-only). Cualquier enforcement on-chain del namespace de nonces (Opción B) queda explícitamente
  fuera de esta HU — ver DT-1.
- Deploy/upgrade del contrato, timelock, `setArbiter()` — WKH-191h, sin cambios.
- El flujo de captura de `setArbitrationConsent` (buyer firma+envía su propia tx) — gap de
  frontend/wallet-UX de WKH-191g DT-3, HU separada (WKH-193 sugerida en el epic), sin tocar.
- Distinguir `NonceAlreadyUsed` en la rama `unequivocal` de `executeArbitration`
  (`src/services/arbiter.ts:767-795`) para enrutar a HOLD/RECONCILE — sugerencia complementaria de
  AR (MNR-1), NO forma parte de las 2 opciones evaluadas por el humano en esta HU; queda anotada como
  candidato de defensa en profundidad ADICIONAL para que el Architect decida en F2 si la incluye en
  el mismo SDD o la separa en una HU futura (Missing Inputs).
- Rotación/gestión operativa del secreto `ARBITER_NONCE_SECRET` (runbook, rotación automática,
  almacenamiento en un vault) — solo se requiere que exista como env var; el mecanismo operativo de
  rotación es una decisión de infraestructura fuera de este ticket.
- Mainnet — ninguna chain (CD-5/CD-6 heredado del epic WKH-191, testnet-only).
- Cambios a `WKH-139 v2` (rules/llm-classifier/evidence) o `WKH-189` (dashboard/endpoints admin) más
  allá del punto de wire del nonce.

## Decisiones técnicas (DT-N)

- **DT-1 (Opción A vs B — A elegida)**: se evaluaron las 2 opciones planteadas.
  - **(A) app-only: salt secreto server-side + persistencia** — ELEGIDA. Cierra el vector en la
    misma capa donde ya vive TODA la lógica de negocio del árbitro (backend), sin requerir un
    segundo upgrade UUPS del contrato (que implicaría OTRO timelock de `MIN_TIMELOCK=2 days`,
    `contracts/src/WasiAIEscrow.sol:42`, y otra superficie de riesgo de deploy) mientras 191h ni
    siquiera corrió el PRIMER upgrade (191f). El costo es depender de un secreto server-side — patrón
    YA establecido en el proyecto (`ARBITER_PRIVATE_KEY`/`OPERATOR_PRIVATE_KEY` son secretos
    análogos, mismo nivel de confianza operacional) — y de una persistencia nueva para no acoplar
    exactly-once a la estabilidad del secreto entre invocaciones/redeploys.
  - **(B) contract-level: reservar el rango de nonces** (`debit` < 2^255, `resolveDispute` >=
    2^255, enforced en Solidity) — DESCARTADA para esta HU. Es estructuralmente MÁS fuerte (cierra el
    vector incluso si `ARBITER_NONCE_SECRET` se filtrara), pero exige otro cambio de
    `WasiAIEscrow.sol` + otro ciclo completo de deploy/timelock/auditoría — costo desproporcionado
    mientras el árbitro sigue 100% inerte (sin `setArbiter()`, sin consentimiento capturado). Queda
    documentada como candidato de hardening futuro si el modelo de amenaza escala (fondos reales de
    producción a volumen) — ver Missing Inputs.
- **DT-2 (dónde persistir el nonce — a confirmar en F2)**: recomendación del Analyst: **tabla nueva
  dedicada** (ej. `a2a_arbiter_nonces(intent_id PK, owner_ref, nonce TEXT, created_at)`), análoga al
  precedente `record_debit_hop1`/`a2a_payment_intent_debit_signatures` de 191a/191b
  (`supabase/migrations/20260713000000_wkh191a_debit_signatures.sql`), EN VEZ de una columna nueva en
  `a2a_arbitrations`. Motivo: `a2a_arbitrations` HOY se escribe (upsert) DESPUÉS de resolver el
  desenlace (`upsertArbitrationRow`, `src/services/arbiter.ts:433-471`, invocada desde
  `emitAndRecord`/`holdArbitration`), pero el nonce se necesita ANTES del primer intento de
  `resolveDispute` — mover el timing del upsert existente arriesga tocar código YA DONE/AR-aprobado
  de 191g/189 innecesariamente. Una tabla dedicada nueva evita ese blast radius. Decisión final del
  Architect en F2.
- **DT-3 (atomicidad del "leer-o-generar-y-persistir")**: el punto de wire ya corre bajo el gate
  anti-race de `open_dispute`/`close_payment_intent_for_arbitration` (`FOR UPDATE` row-lock sobre el
  intent) — no hay concurrencia normal esperada sobre el mismo `intentId`, pero un retry accidental
  simultáneo (ej. dos requests admin de `resolveHold`) no está 100% excluido. Recomendación: usar un
  `UPSERT ... ON CONFLICT (intent_id) DO NOTHING RETURNING nonce` (o una función RPC dedicada, mismo
  patrón `record_debit_hop1`) para que el PRIMER writer gane atómicamente y cualquier segundo writer
  lea el valor YA persistido — nunca dos nonces distintos para el mismo `intentId`.
- **DT-4 (dominio del hash)**: el secreto se incorpora AL digest `keccak256` existente (junto al
  string de dominio `'WasiAIEscrow.arbiter-dispute.v1'`), NO lo reemplaza — la estructura bit-255
  (`ARBITER_NONCE_FLAG`/`ARBITER_NONCE_LOW_MASK`) se mantiene intacta como defensa en profundidad
  adicional sobre el namespace disjunto de `debit()` (AC-4).

## Constraint Directives (CD-N)

- CD-1: OBLIGATORIO mantener exactly-once: el nonce usado en CUALQUIER intento (inicial, retry, o
  recovery vía `arb_closing`) de `resolveDispute` para un mismo `intentId` DEBE ser IDÉNTICO — se
  genera UNA sola vez y se persiste; PROHIBIDO cualquier código path que recompute
  `deriveArbiterNonce` una vez que ya existe un valor persistido para ese `intentId`.
- CD-2: OBLIGATORIO que el nonce del árbitro sea criptográficamente no-adivinable/no-re-derivable por
  ningún actor sin acceso a `ARBITER_NONCE_SECRET` — PROHIBIDO cualquier fórmula de fallback que
  dependa ÚNICAMENTE de datos públicos (`keyId`, `intentId`). El secreto vive SOLO server-side (env
  var) — PROHIBIDO exponerlo en logs, telemetría, recibos, o respuestas de API.
- CD-3: PROHIBIDO degradar el comportamiento/fallback existente de 191g: si `ARBITER_NONCE_SECRET`
  falta o está vacío, el seam DEBE caer al path operator-custodial (`settlePaymentIntentOnChain`) —
  mismo patrón de las otras patas del gate (CD-1/CD-7 de 191g) — y PROHIBIDO usar la fórmula pública
  antigua como fallback silencioso (eso reintroduciría exactamente el vector que esta HU cierra).
- CD-4: PROHIBIDO tocar `contracts/src/WasiAIEscrow.sol` / `IWasiAIEscrow.sol` en esta HU (Opción A
  es app-only, DT-1) — cualquier enforcement on-chain del namespace de nonces queda diferido a una
  eventual HU futura si se decide adoptar Opción B como capa adicional.
- CD-5: OBLIGATORIO preservar byte-idéntico el resto del wire de 191g — flag `ESCROW_ARBITER_ENABLED`
  OFF, sin escrow configurado, o `arbitrationConsent(keyId)===false` siguen cayendo al path
  operator-custodial exactamente como hoy (AC-6); esta HU es aditiva SOLO sobre el cálculo/
  persistencia del nonce.
- CD-6: OBLIGATORIO testnet-only — heredado CD-5/CD-6 del epic WKH-191; ninguna llamada on-chain de
  esta HU puede alcanzar mainnet.

## Missing Inputs

- `[confirmar en F2]` Dónde persistir el nonce — tabla dedicada nueva (`a2a_arbiter_nonces`,
  recomendación del Analyst, DT-2) vs. columna nueva en `a2a_arbitrations` con el timing de escritura
  movido más temprano. Decisión del Architect.
- `[confirmar en F2]` Mecanismo de atomicidad del "leer-o-generar-y-persistir" — `UPSERT ... ON
  CONFLICT DO NOTHING RETURNING` directo desde el service vs. una función RPC dedicada (precedente
  `record_debit_hop1`) — DT-3.
- `[confirmar en F2]` Formato/longitud mínima de `ARBITER_NONCE_SECRET` (¿validación de entropía
  mínima al arrancar el proceso, ej. exigir ≥32 bytes hex, similar a cómo se tratan otros secretos
  del proyecto?) — no especificado por el humano en el brief de esta HU.
- `[NEEDS CLARIFICATION]` Procedimiento de rotación de `ARBITER_NONCE_SECRET`: por diseño (CD-1/AC-2),
  una rotación NO debería afectar nonces YA persistidos (intents en curso o resueltos) — solo
  cambiaría el valor derivado para `intentId`s NUEVOS a partir de la rotación. Este comportamiento se
  asume correcto por construcción (la persistencia blinda contra la inestabilidad del secreto), pero
  no fue confirmado explícitamente por el humano ni hay runbook de rotación — fuera de Scope IN de
  esta HU (ver Scope OUT), señalado para que el founder/Architect lo evalúe si hace falta un
  procedimiento formal antes de producción real.
- `[TBD — F2, no bloqueante]` La sugerencia complementaria de AR (MNR-1): distinguir
  `NonceAlreadyUsed` en la rama `unequivocal` de `executeArbitration`
  (`src/services/arbiter.ts:767-795`) para enrutar a HOLD/RECONCILE en vez de refund automático
  completo. Es una capa de defensa en profundidad ADICIONAL (no reemplaza el fix raíz de esta HU) —
  el Architect decide en F2 si la incluye en el mismo SDD (dado que ya toca el mismo archivo/función)
  o la separa en un follow-up.

## Análisis de paralelismo

- Depende de (código, DONE): WKH-191g (fila 178 de `_INDEX.md`) — extiende `deriveArbiterNonce`/
  `settleArbitrationOnChain`, no los reemplaza; sin cambios sobre el resto del wire (AC-6/CD-5).
- Es un **pre-requisito de seguridad** (no un bloqueante de código) para activar el árbitro on-chain
  con fondos reales: WKH-191h (deploy/upgrade + `setArbiter()`) puede desarrollarse/ejecutarse en
  paralelo, pero esta HU DEBE estar mergeada/deployada ANTES de que el árbitro on-chain quede
  operativo en producción con montos reales (post-191h + consentimiento capturado, WKH-193) — de lo
  contrario el vector MNR-1/R-3 queda vivo el día que el árbitro se active.
- Puede ejecutarse EN PARALELO con WKH-193 (frontend/wallet-UX de captura de `setArbitrationConsent`,
  gap DT-3 de 191g) — superficies distintas (backend nonce vs. frontend wallet tx), sin overlap.
- No bloquea ninguna otra HU DONE/in-progress fuera del epic WKH-191.
