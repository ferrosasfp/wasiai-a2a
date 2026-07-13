# Work Item — [WKH-191b] Rewire escrow-aware del settle (flujo normal, two-hop)

## Resumen

Segunda HU de la Wave 0 del epic WKH-191 (fila 172 de `_INDEX.md`, sucesora directa de
191a — fila 173, DONE código / PENDING-DEPLOY). 191a captura y persiste (INERTE) la firma
EIP-712 `DebitAuthorization` del buyer en `close`/`settle` de `session`/`upto`. 191b la
**consume**: cuando existe una firma `valid` persistida y el flag nuevo está ON, el settle
real deja de mover únicamente fondos propios del operador y en su lugar ejecuta un
**two-hop on-chain**: (1) `escrow.debit(keyId, amount, deadline, nonce, signature)` —
mueve `amount` de `escrowBalance(keyId)` (fondos del BUYER, custodiados en el contrato) al
wallet del operador (`msg.sender`, único destino que el contrato permite hoy — Hallazgo
#1 del epic), y (2) el operador reenvía `amount` al seller (`payTo`) exactamente con el
mismo mecanismo sign+settle EIP-3009 que usa HOY el path operator-custodial (cero cambios
de código en ese hop). Con el flag OFF, sin firma válida, o sin contrato escrow
configurado para la chain, el comportamiento es byte-idéntico al actual (solo hop 2, como
hoy).

## Sizing

- SDD_MODE: full
- Estimación: L
- Branch sugerido: `feat/191b-escrow-settle-rewire`

## Nuances de diseño resueltas

### 1. Atomicidad del two-hop (2 txs, no atómico on-chain)

`escrow.debit()` (hop 1) y el forward operador→seller (hop 2, EIP-3009 sign+settle) son
dos transacciones independientes — no existe una única tx atómica que haga ambas cosas (el
contrato no soporta `debitTo`, ver Hallazgo #1 del epic; cambiarlo es Wave 1/upgrade,
fuera de esta HU).

**Resolución (DT-1, secuencial + fail-safe por leg):**

- Hop 1 se ejecuta y se **espera su confirmación on-chain** (mismo mínimo de
  confirmaciones que `resolveMinConfirmations`/`verifyEscrowDeposit` en
  `escrow-verifier.ts:169-180`) ANTES de siquiera intentar hop 2. Nunca se dispara hop 2 en
  paralelo o antes de confirmar hop 1 (evita firmar/settlear un EIP-3009 de fondos que
  todavía no llegaron al wallet del operador → revert por balance insuficiente).
- **Si hop 1 falla** (revert `DeadlineExpired`/`DeadlineTooFar`/`NonceAlreadyUsed`/
  `InvalidSignature`/`InsufficientBalance`/`NotOperator`, o la re-verificación on-chain
  post-tx lo contradice, o el `writeContract` lanza ANTES de confirmarse): **NINGÚN fondo
  salió del escrow** → el sistema descarta el escrow-settle para ese settle y cae al path
  operator-custodial actual (hop 2 solo, exactamente como hoy). No hay pérdida de fondos ni
  bloqueo del settle: el buyer ya tenía su `budget` off-chain debitado por el flujo
  `session`/`upto` existente (sin relación con el flag de esta HU), y el seller se cobra
  igual, solo que sin el respaldo criptográfico del escrow para ese settle puntual.
- **Si hop 1 tiene éxito confirmado PERO hop 2 falla/es ambiguo**: acá SÍ hay dinero en
  movimiento real fuera del ledger — los fondos del buyer ya salieron de
  `escrowBalance(keyId)` y están en el wallet del operador, pero el seller todavía no fue
  pagado. **NUNCA se asume que el seller fue pagado, NUNCA se reembolsa al buyer** (el
  reembolso sería incorrecto: los fondos existen, están en el wallet del operador,
  simplemente no llegaron a destino todavía). El intent se marca **reconciliation-pending**
  (persistiendo el tx hash de hop 1 + el motivo del fallo de hop 2, mismo patrón
  `RECONCILE: …` que ya usa `settlePaymentIntentOnChain` para el caso ambiguo hoy,
  `payment-intent.ts:430-461`). El único trabajo pendiente en ese estado es reintentar
  ÚNICAMENTE hop 2 (nunca hop 1 de nuevo) — ver punto 2 (exactly-once). La reconciliación
  FORMAL (job/alerta que resuelve estos casos automáticamente y cruza contra
  `escrowBalance`) es 191c (ver corte más abajo); 191b solo deja el estado correctamente
  marcado y no-destructivo.

### 2. Exactly-once (no doble-debit, convergencia con settle_outcome)

El nonce se quema on-chain (`_usedNonces[keyId][nonce]`) SOLO cuando hop 1 tiene éxito —
esa es la garantía primaria (un segundo intento de `escrow.debit()` con la misma firma
revierte `NonceAlreadyUsed`, protección del propio contrato). Pero el problema app-side no
es "¿puede el contrato prevenir el doble-debit?" (sí, siempre) sino "¿cómo evita el server
reintentar hop 1 innecesariamente (y fallar) en un recovery, y cómo sabe que solo debe
reintentar hop 2?".

**Resolución (DT-2):** antes de intentar hop 1 para una firma `valid`, el server verifica
si esa firma YA tiene un hop 1 ejecutado con éxito persistido (tx hash). Si lo tiene:
**skip hop 1, ir directo a hop 2** (retry-safe — los fondos ya están en el wallet del
operador). Si no lo tiene: intentar hop 1 normalmente. Esto requiere persistir el tx hash
de hop 1 de forma que sobreviva a un crash entre hop 1 y hop 2 — **antes** de intentar hop
2, no después (mismo principio BLQ-DR que ya usa `recordSettleOutcome` en
`payment-intent.ts:700-708/737-745`: persistir el veredicto ANTES del side-effect
subsiguiente). Esto converge con el `settle_outcome`/`finalize_payment_intent` existentes:
el resultado final del intent (settled/failed) sigue siendo el mismo veredicto ya usado
hoy — 191b solo agrega el registro intermedio de "hop 1 ejecutado" como guardia de
idempotencia, no un tercer estado de negocio nuevo para el buyer/seller.

### 3. Flag: nuevo, compuesto con el de 191a

**Resolución (DT-3):** flag nuevo `ESCROW_SETTLE_ENABLED` (default OFF/unset), **AND**
lógico con `ESCROW_DEBIT_CAPTURE_ENABLED` (191a) — ambos deben estar ON para que el
two-hop se intente (defensa en profundidad: capturar una firma es inerte y de bajo riesgo;
CONSUMIRLA mueve fondos reales y merece su propio kill-switch independiente). El epic
(fila 172, work-item raíz) mencionaba tentativamente `ESCROW_DEBIT_ENABLED` como nombre —
el Architect reconcilia el nombre final en F2 (aditivo, sin romper nada existente); esta
HU recomienda `ESCROW_SETTLE_ENABLED` por claridad semántica (captura vs. consumo son
kill-switches distintos).

### 4. R-1 — el escrow solo existe en Base Sepolia

El contrato solo está deployado en Base Sepolia (`contracts/script/Deploy.s.sol`); la
chain default del gateway es `kite-ozone-testnet` (sin escrow configurado ⇒
`resolveEscrowContract` devuelve `null` ahí siempre). **Esta HU es code-complete pero
funcionalmente inerte fuera de Base Sepolia** — con el flag ON en un ambiente donde
`A2A_ESCROW_CONTRACT_BASE` no está seteado, el comportamiento cae automáticamente al path
actual (mismo guard `resolveEscrowContract() === null` que ya usa `debit-capture.ts:71-76`
en 191a). Activar el two-hop de verdad en Base Sepolia real depende de 191d
(config/verificación de que `OPERATOR_PRIVATE_KEY` coincide con el `_operator` on-chain
configurado del contrato — si no coinciden, TODO `debit()` revierte `NotOperator`, sin
importar la firma). 191b no bloquea en esto: el código queda correcto y listo, la
activación real es responsabilidad de 191d.

### 5. Libro autoritativo — corte 191b/191c

Decisión del founder (ratificada, no reabierta acá): **el libro autoritativo es
`escrowBalance(keyId)` on-chain**; `a2a_agent_keys.budget` pasa a ser cache/mirror.

**Corte recomendado (DT-4):** 191b hace el movimiento real de fondos on-chain (el
two-hop) + marca el estado mínimo no-destructivo cuando algo queda pendiente
(reconciliation-pending con tx hash de hop 1). 191b **NO** implementa el motor formal de
reconciliación — no compara periódicamente `budget` vs `escrowBalance(keyId)`, no genera
alertas de drift, y no resuelve automáticamente los intents `reconciliation-pending`
dejados por un hop 2 fallido (eso requiere lógica de reintento/backoff/alerting dedicada,
fuera de esta HU). Ese trabajo formal — job de reconciliación, tolerancia de drift,
resolución automática de pendientes, y la transición de `budget` a mero mirror — es
**191c**, tal como ya lo decompuso el epic. 191b deja evidencia suficiente (tx hash + motivo
persistidos) para que 191c pueda operar sobre ella sin re-derivar nada.

## Acceptance Criteria (EARS)

- AC-1: WHEN `ESCROW_SETTLE_ENABLED=true` AND `ESCROW_DEBIT_CAPTURE_ENABLED=true` AND
  existe una firma `DebitAuthorization` con `debit_validation_status='valid'` persistida
  (191a) para el intent AND `resolveEscrowContract(chainKey)` no es `null`, the system
  SHALL invocar `escrow.debit(keyId, amount, deadline, nonce, signature)` (hop 1), esperar
  su confirmación on-chain, y — solo si hop 1 se confirma exitoso — proceder a hop 2 (el
  sign+settle EIP-3009 operador→seller ya existente, sin cambios) para completar el
  settlement.
- AC-2 (fallback default): WHEN `ESCROW_SETTLE_ENABLED=false` (default), OR no existe
  firma `valid` persistida para el intent, OR `resolveEscrowContract(chainKey)` es `null`,
  the system SHALL ejecutar `closeSession`/`settleUpto` byte-idénticamente al path
  operator-custodial actual, sin intentar hop 1.
- AC-3 (hop 1 fail-safe): IF hop 1 revierte, la re-verificación on-chain post-tx lo
  contradice, o el intento lanza antes de confirmarse en cadena, THEN the system SHALL
  descartar el escrow-settle para ese settle y SHALL caer al path operator-custodial
  actual (hop 2 solo) sin bloquear ni fallar el settle, y sin haber movido fondos del
  escrow.
- AC-4 (hop 2 fail después de hop 1 exitoso): IF hop 1 se confirma exitoso on-chain PERO
  hop 2 (forward operador→seller) falla o resulta ambiguo, THEN the system SHALL persistir
  el tx hash de hop 1 y marcar el intent como reconciliation-pending, SHALL NOT asumir que
  el seller fue pagado, y SHALL NOT reembolsar al buyer.
- AC-5 (exactly-once): IF el settle se reintenta (recovery / `expireStale` / segunda
  llamada concurrente a close/settle) para un intent donde hop 1 YA fue ejecutado
  exitosamente (tx hash persistido), THEN the system SHALL NOT reintentar
  `escrow.debit()` para esa firma y SHALL reintentar únicamente hop 2.
- AC-6 (chain scope / R-1): WHERE la chain del intent no tiene contrato escrow configurado
  (`resolveEscrowContract` devuelve `null`, p.ej. la chain default `kite-ozone-testnet`
  hoy), the system SHALL comportarse exactamente como AC-2, sin error, sin importar el
  estado del flag.
- AC-7 (no duplicar anti-replay): the system SHALL leer exclusivamente la firma `valid`
  más reciente persistida para `(intent_id, owner_ref)` vía el reader nuevo, y SHALL
  respetar el índice único parcial `(key_id, debit_nonce)` de 191a como única fuente de
  verdad de qué nonce ya fue reservado — sin duplicar lógica de anti-replay nueva.

## Scope IN

- `src/services/payment-intent.ts`: extender el seam `settlePaymentIntentOnChain`
  (`:343-459`, WKH-136) para aceptar opcionalmente una firma `DebitAuthorization` `valid`
  ya leída y orquestar hop 1 → hop 2 secuencialmente cuando aplica; `closeSession`
  (`:568-799`) y `settleUpto` (`:897-…`) pasan la firma leída al seam.
- Reader nuevo de la firma `valid` más reciente persistida por 191a
  (`a2a_payment_intent_debit_signatures`, owner_ref-guarded) — ubicación sugerida:
  `src/adapters/escrow/debit-capture.ts` (mismo archivo, junto a
  `captureDebitSignatureBestEffort`) o `payment-intent.ts`; el Architect decide en F2.
- Módulo nuevo (sugerido `src/adapters/escrow/debit-executor.ts`) — ejecuta hop 1
  (`writeContract` `escrow.debit(...)` vía `OPERATOR_PRIVATE_KEY`), espera confirmaciones
  (reusa `resolveMinConfirmations`/`resolveRpcUrl`/`resolveChainObject` de
  `deposit-verifier.ts`, mismo patrón que `escrow-verifier.ts`), re-verifica el evento
  `Debited` on-chain, y devuelve un outcome `unequivocal`/`ambiguous` (mismo vocabulario
  que `settlePaymentIntentOnChain`).
- `src/adapters/escrow/abi.ts`: reusar `debit` (ya presente en `ESCROW_ABI`, sin
  duplicar).
- Env var nueva `ESCROW_SETTLE_ENABLED` (default false/unset), compuesta AND con
  `ESCROW_DEBIT_CAPTURE_ENABLED`.
- Migración Supabase aditiva: persistencia del hop 1 ejecutado (tx hash + timestamp),
  extendiendo `a2a_payment_intent_debit_signatures` (191a) o una tabla sibling nueva — el
  Architect decide cardinalidad en F2 (¿puede reintentarse hop 1 tras un hop 2 fallido con
  la MISMA firma? No — el nonce ya está quemado on-chain; una columna nullable en la fila
  de la firma consumida alcanza).
- Marca mínima de estado `reconciliation-pending` sobre el intent cuando hop 1 tiene éxito
  y hop 2 falla (reuso del patrón `error_message` `RECONCILE: …` + `settle_outcome`
  existente, con el tx hash de hop 1 incluido en el detalle persistido).
- Tests unitarios: two-hop happy path, hop 1 falla→fallback a path actual, hop 1
  éxito+hop 2 falla→reconciliation-pending sin refund/sin doble-pago, idempotencia (no
  re-debit tras hop 1 ya ejecutado, retry va directo a hop 2), flag OFF, sin firma válida,
  chain sin escrow configurado (`resolveEscrowContract` null), confirmaciones
  insuficientes de hop 1.

## Scope OUT

- Cualquier cambio en `contracts/` (`debit()` ya existe tal cual — CD-5 del epic, DT-1 del
  epic).
- Wire del árbitro / `resolveDispute` a cualquier camino on-chain (Wave 1, 191f-h) — ni
  siquiera se toca `arbiter.ts`.
- Reconciliación FORMAL `budget` (off-chain) vs `escrowBalance(keyId)` (on-chain) +
  alerting de drift + resolución automática de intents `reconciliation-pending` (191c).
- `withdraw()` real / cualquier refund on-chain al buyer (191c).
- Config/deploy del contrato escrow en chains nuevas, o verificación de que
  `OPERATOR_PRIVATE_KEY` == `_operator` on-chain configurado (191d) — 191b asume que,
  cuando el flag está ON y hay escrow configurado, el ambiente ya está alineado; si no lo
  está, `debit()` revierte `NotOperator` y AC-3 (fallback) cubre ese caso sin romper nada.
- E2E testnet regression suite completa del path nuevo + del path viejo en paralelo
  (191e).
- Cambiar el accounting off-chain existente de `budget` (`openSession`/`addVoucher`/
  `increment_a2a_key_spend`) — sigue exactamente igual, sin relación con esta HU.
- Cambiar el split bps / fee (WKH-136/143) — heredado sin modificar.

## Decisiones técnicas (DT-N)

- DT-1: two-hop secuencial con confirmación intermedia obligatoria — nunca se dispara hop
  2 antes de confirmar hop 1 en cadena. Ver "Nuance de diseño resuelta #1".
- DT-2: idempotencia app-side vía persistencia del tx hash de hop 1 ANTES de intentar hop
  2 (mismo principio BLQ-DR que `recordSettleOutcome`); un retry con hop 1 ya persistido
  salta directo a hop 2. Ver "Nuance #2".
- DT-3: flag nuevo `ESCROW_SETTLE_ENABLED`, AND lógico con `ESCROW_DEBIT_CAPTURE_ENABLED`
  de 191a (defensa en profundidad, capturar ≠ consumir). Ver "Nuance #3".
- DT-4: corte 191b/191c — 191b mueve fondos + marca reconciliation-pending
  no-destructivamente; 191c implementa el motor formal de reconciliación/drift-alerting.
  Ver "Nuance #5".
- DT-5: hop 2 es CERO cambios de código — literalmente el mismo
  `getPaymentAdapter().sign()`/`.settle()`/`verifyDefaultChainSettle()` que ya usa
  `settlePaymentIntentOnChain` hoy (`payment-intent.ts:359-443`); el two-hop no introduce
  un segundo mecanismo de forward, solo una precondición nueva (hop 1) antes de ejecutar
  el mecanismo existente.
- DT-6: el módulo de hop 1 (`debit-executor.ts` sugerido) reusa los helpers
  chain-genéricos ya exportados por `deposit-verifier.ts` (`resolveChainObject`,
  `resolveMinConfirmations`, `resolveRpcUrl`) — mismo patrón DT-6 que ya documenta
  `escrow-verifier.ts:17-21`, sin duplicar lógica de confirmaciones/RPC.

## Constraint Directives (CD-N)

- CD-1: OBLIGATORIO flag-gated — `ESCROW_SETTLE_ENABLED` default OFF/unset, compuesto AND
  con `ESCROW_DEBIT_CAPTURE_ENABLED`; con cualquiera de los dos OFF, cero intento de hop 1
  (comportamiento byte-idéntico al actual).
- CD-2: PROHIBIDO alterar/bloquear el path operator-custodial actual cuando el flag está
  OFF, no hay firma `valid`, la chain no tiene escrow configurado, o hop 1 falla por
  cualquier motivo — en todos esos casos el settle cae al comportamiento de HOY sin
  excepción no capturada ni cambio de latencia perceptible fuera del camino escrow.
- CD-3: OBLIGATORIO exactly-once en hop 1 — NUNCA reintentar `escrow.debit()` para un
  `(keyId, nonce)` cuyo tx hash de éxito ya está persistido; el nonce quemado on-chain es
  el backstop final, pero el guard app-side (persistir ANTES de hop 2) es obligatorio para
  evitar el intento redundante.
- CD-4: PROHIBIDO asumir pago al seller o reembolsar al buyer cuando hop 1 tuvo éxito y
  hop 2 falla/es ambiguo — marcar reconciliation-pending explícito (tx hash + motivo), sin
  mover más fondos hasta que 191c (o un reintento manual acotado a SOLO hop 2) lo resuelva.
- CD-5: PROHIBIDO modificar cualquier archivo bajo `contracts/` en esta HU (`debit()` ya
  existe, sin cambios de Solidity — hereda CD-4 del epic).
- CD-6: PROHIBIDO tocar `src/services/arbiter.ts` o cualquier camino de disputa/override —
  Wave 1, fuera incluso conceptualmente de esta HU.
- CD-7: OBLIGATORIO reusar EXACTAMENTE `DEBIT_AUTHORIZATION_TYPES`/`buildDebitDomain`
  (`eip712.ts`) y `ESCROW_ABI.debit` (`abi.ts`) ya definidos por 191a — prohibido definir
  un segundo struct/ABI paralelo o divergente para hop 1.
- CD-8: OBLIGATORIO esperar el mínimo de confirmaciones on-chain de hop 1 (mismo umbral
  que `verifyEscrowDeposit`) ANTES de iniciar hop 2 — prohibido firmar/settlear el forward
  EIP-3009 contra un balance del operador que todavía no fue actualizado on-chain.

## Missing Inputs

- [resuelto en F2, recomendación Analyst] Nombre final del flag: se recomienda
  `ESCROW_SETTLE_ENABLED` (nuevo, compuesto AND con `ESCROW_DEBIT_CAPTURE_ENABLED`); el
  epic (fila 172) mencionaba tentativamente `ESCROW_DEBIT_ENABLED` — el Architect
  reconcilia el nombre definitivo en F2, es puramente nominal y no cambia el diseño.
- [resuelto en F2] Forma exacta de la persistencia de "hop 1 ejecutado" (columna nueva en
  `a2a_payment_intent_debit_signatures` vs. tabla sibling nueva) — el Architect decide
  según si conviene guardar también metadata de confirmaciones/gas para debugging o basta
  con tx hash + timestamp.
- [bloqueante operacional, NO de código — pertenece a 191d] `OPERATOR_PRIVATE_KEY` debe
  coincidir exactamente con el `_operator` configurado on-chain en el contrato deployado
  (`WasiAIEscrow.sol:57/93-98`); si no coincide, TODO `debit()` revierte `NotOperator` y el
  sistema cae siempre a AC-3 (fallback) — 191b es código-completo y correcto sin esta
  verificación, pero el two-hop nunca se activará de verdad en ningún ambiente hasta que
  191d la confirme.
- [informativo, no bloqueante] Latencia: con el flag ON y todas las condiciones dadas, el
  settle real pasa de 1 tx (hoy) a 2 tx secuenciales confirmadas (hop 1 + hop 2) — el
  Architect debe fijar en F2 un timeout explícito para la espera de confirmación de hop 1
  (recomendado: mismo orden de magnitud que `FACILITATOR_TIMEOUT_MS` / patrones de
  confirmación ya usados en `escrow-verifier.ts`).

## Análisis de paralelismo

- Bloqueada por 191a (fila 173, DONE código / PENDING-DEPLOY) — el reader nuevo consume
  directamente la tabla/RPC que 191a ya define; el código de 191a está disponible en el
  repo (mergeado) aunque su deploy a producción esté pendiente, así que 191b puede
  desarrollarse y testearse ya (con Supabase de test/CI, sin depender del deploy real).
- Bloquea a 191c (reconciliación formal del libro) y a 191e (E2E flag-gated) — ambas
  consumen el two-hop implementado acá.
- No bloquea ninguna HU DONE/in-progress fuera del epic — superficie exclusiva de
  `payment-intent.ts`/`adapters/escrow/*`, no tocada por las filas 159-171 de `_INDEX.md`
  (discovery/relevance/embeddings, módulo `orchestrate.ts`/`discovery.ts` distinto).
- Puede avanzar en paralelo a nivel de código con 191d (config/deploy) — pero
  funcionalmente inerte (AC-3/AC-6 siempre en fallback) hasta que 191d confirme
  `A2A_ESCROW_CONTRACT_BASE`/alineación del operador en un ambiente real.
