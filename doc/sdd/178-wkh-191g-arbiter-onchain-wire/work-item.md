# Work Item — [WKH-191g] Wire de `arbiter.ts` al contrato `WasiAIEscrow` (rol arbiter)

> Wave 1 (HU 7 de 8) del epic [WKH-191](../172-wkh-191-escrow-noncustodial-settlement/work-item.md).
> Depende de [WKH-191f](../177-wkh-191f-escrow-arbiter-contract/work-item.md) (DONE código ·
> UPGRADE-PENDING) — el contrato ya tiene `_arbiter`/`setArbitrationConsent`/`lockForDispute`/
> `resolveDispute`/`releaseDispute`, pero es INERTE hasta el upgrade+`setArbiter()` de **191h**
> (Scope OUT de esta HU). Depende también de [WKH-139 v2](../145-wkh-139-agent-arbiter/work-item.md)
> y [WKH-189](../171-wkh-189-arb-hold-override/work-item.md) (ambos DONE), que hoy operan 100%
> sobre `a2a_agent_keys.budget` off-chain — esta HU los extiende, no los reemplaza.

## Resumen

`WasiAIEscrow.sol` (191f) agregó las funciones on-chain que el árbitro necesita para mover
fondos escrow-custodiados SIN la firma del buyer (`lockForDispute`, `resolveDispute`,
`releaseDispute`, todas `onlyArbiter`, gateadas por `setArbitrationConsent`). Hoy
`src/services/arbiter.ts` (`openDispute`/`resolveDispute`/`executeArbitration`/`resolveHold`)
no conoce esas funciones — sigue resolviendo TODO sobre `budget` off-chain vía
`close_payment_intent_for_arbitration` + `settlePaymentIntentOnChain` (operator-custodial).
Esta HU cablea el camino on-chain, flag-gated y en paralelo al path actual: al transicionar a
`'disputed'` se lockean los fondos (`lockForDispute`); al resolver (auto rules/llm o override
humano WKH-189) se paga al seller (`resolveDispute`) o se libera el lock (`releaseDispute`).
**Code-complete pero inerte**: cualquier llamada real revierte `NotArbiter` hasta que 191h
ejecute el upgrade UUPS + `setArbiter()`. Testnet-only (CD-5 heredado del epic).

## Sizing

- SDD_MODE: full
- Estimación: **L** (revisa al alza el estimado original del epic de "M" — el F0 de esta HU
  encontró 3 call-sites de wire distintos dentro de `arbiter.ts`, un módulo executor nuevo
  espejo de `debit-executor.ts`, un gap de consentimiento sin resolver que exige manejo
  defensivo explícito, y un riesgo de colisión de namespace de nonces con `debit()`)
- Branch sugerido: `feat/191g-arbiter-onchain-wire`

## Grounding (F0, archivo:línea)

- `contracts/src/WasiAIEscrow.sol:104-124` — `arbiter()`/`setArbiter(address) onlyOwner` (rol
  dedicado, `onlyArbiter` modifier `:108-111` revierte `NotArbiter` si `msg.sender != _arbiter`).
- `:126-139` — `setArbitrationConsent(bytes32 keyId, bool consent)`: SOLO `msg.sender ==
  _depositor[keyId]` puede llamarla (línea 134), monotónica/irrevocable (línea 135). **NO es
  delegable por firma** — es una tx directa del depositante, a diferencia de `DebitAuthorization`
  (firma EIP-712 off-chain que el server sí puede recibir y re-presentar).
- `:237-260` — `lockForDispute(keyId, amount) onlyArbiter` (incremental, top-up, `:245-252`;
  requiere `_arbitrationConsent[keyId]==true` línea 246) y `releaseDispute(keyId) onlyArbiter`
  (libera el lock sin pagar, `:255-260`).
- `:262-288` — `resolveDispute(keyId, seller, sellerAmount, nonce) onlyArbiter nonReentrant`:
  exige consentimiento (`:273`), `sellerAmount <= _lockedAmount[keyId]` (`:278`,
  `ExceedsLockedAmount`), `sellerAmount <= _balances[keyId]` (`:280`), nonce no usado
  (`:276`) — **reusa `_usedNonces[keyId][nonce]`, EL MISMO mapping que `debit()`/`debitBatch()`
  (`:55`, `:162-182`)**. CEI estricto: nonce+balance+lock mutados ANTES del transfer (`:281-286`);
  paga al `seller` (parámetro), NUNCA a `msg.sender` (comentario `:286`).
- `contracts/src/interfaces/IWasiAIEscrow.sol:21-28,49-53,79-94` — eventos
  (`ArbiterUpdated`, `ArbitrationConsentSet`, `DisputeLocked`, `DisputeResolved`,
  `DisputeReleased`), errores (`NotArbiter`, `ArbitrationNotConsented`, `ConsentIrrevocable`,
  `ExceedsLockedAmount`), y las 7 funciones nuevas (`arbiter`, `setArbiter`,
  `arbitrationConsent`, `setArbitrationConsent`, `lockedAmount`, `lockForDispute`,
  `resolveDispute`, `releaseDispute`) — ninguna está en `src/adapters/escrow/abi.ts`
  (`ESCROW_ABI` hoy solo tiene `deposit`/`debit`/`escrowBalance` + eventos `Deposited`/`Debited`,
  `abi.ts:19-71`).
- `src/adapters/escrow/debit-executor.ts:1-234` — patrón EXACTO a espejar para las llamadas
  `onlyArbiter`: `getEscrowWalletClient`/`getEscrowPublicClient` cacheados per-`ChainKey`
  (`:74-118`), `writeContract` con catch pre-broadcast → `not_moved` (`:155-179`),
  `waitForTransactionReceipt` con timeout → `ambiguous` (`:181-193`), status revert →
  `not_moved` (`:196-198`), evento no matcheado tras receipt success → `ambiguous` (`:227-230`,
  "NUNCA asumir confirmado"). **Diferencia clave para 191g**: este módulo usa
  `process.env.OPERATOR_PRIVATE_KEY` (`:77`) — el árbitro necesita su PROPIA wallet
  (`_arbiter` ≠ `_operator` por diseño de 191f), así que el executor nuevo NO puede reusar
  `getEscrowWalletClient` tal cual (lee la env var equivocada).
- `src/services/arbiter.ts:325-383` (`openDispute`), `:391-478` (`resolveDispute`, el método
  del SERVICIO — no confundir con la función homónima del contrato), `:485-641`
  (`executeArbitration`), `:904-1012` (`resolveHold`, WKH-189): los 3 puntos de wire.
  - `executeArbitration` (`:523-543`) rama refund total (`arbMicro<=0`): hoy NO mueve fondos
    on-chain (solo `recordSettleOutcome`+`finalizePaymentIntent`) — mapea a `releaseDispute`.
  - `executeArbitration` (`:546-641`) rama release/split (`arbMicro>0`): hoy llama
    `settlePaymentIntentOnChain` (operator-custodial, `payment-intent.ts`) — mapea a
    `resolveDispute(keyId, seller, sellerAmount, nonce)`.
  - `resolveHold` (`:904-1012`, WKH-189 override) YA reusa `executeArbitration` (`:1011`,
    "Reusar el seam CD-1") — el wire de esta HU se hereda automáticamente sin tocar
    `resolveHold`.
  - `holdArbitration` (`:793-823`) hoy es "CERO movimiento de fondos" (comentario `:789-791`)
    — es el punto natural para `lockForDispute`, pero el lock también debe cubrir el camino
    de auto-resolución inmediata (rules/llm bajo `ARBITER_AUTO_CAP_USD`) que NUNCA pasa por
    `holdArbitration`. Ver DT-2.
- `src/adapters/escrow/debit-capture.ts:150-259` (`captureDebitSignature`) — patrón de
  `keyIdHash = keccak256(stringToBytes(keyId))` (`:172`) a reusar tal cual para derivar el
  `bytes32 keyId` de las llamadas `onlyArbiter` (los intents guardan `key_id` como uuid, igual
  que `payment-intent.ts`).
- `src/adapters/escrow-verifier.ts:94-101` (`resolveEscrowContract`) — helper YA existente
  para resolver la dirección del escrow por chain-family (`A2A_ESCROW_CONTRACT_<FAMILY>`),
  reusable tal cual para gatear "¿este chain tiene escrow configurado?" (mismo patrón AC-6
  del epic / `escrowEnabledForChain`).
- `doc/sdd/172-wkh-191-escrow-noncustodial-settlement/work-item.md` (epic) — AC-5/CD-1/CD-4
  citan explícitamente este wire; DT-2 confirma que la Wave 1 requiere upgrade previo.
- `doc/sdd/177-wkh-191f-escrow-arbiter-contract/work-item.md` — DT-3 ("el árbitro app-side
  genera un nonce fresco por resolución") y DT-5 (riesgo de `withdraw()` durante disputa
  ACEPTADO, no mitigado — el lock de esta HU SÍ lo cierra en la práctica una vez el flujo esté
  activo, porque `withdraw()` respeta `_lockedAmount`, `WasiAIEscrow.sol:229-235`).

## Acceptance Criteria (EARS)

- AC-1: WHEN `ARBITER_ONCHAIN_ENABLED=false` (default) OR el escrow no está configurado para
  la chain del intent (`resolveEscrowContract(chainKey) === null`), THE system SHALL resolver
  la disputa byte-idénticamente al path actual (`close_payment_intent_for_arbitration` +
  `settlePaymentIntentOnChain` sobre `budget` off-chain), sin invocar ninguna función
  `onlyArbiter` del contrato.
- AC-2: WHEN el flag está ON y el escrow está configurado para la chain del intent, THE system
  SHALL consultar `arbitrationConsent(keyId)` on-chain (view, sin gas) ANTES de intentar
  `lockForDispute`/`resolveDispute`/`releaseDispute`, y SHALL caer al path operator-custodial
  existente si el resultado es `false` (comportamiento esperado hasta que exista el flujo de
  captura de consentimiento — ver DT-3/Missing Inputs).
- AC-3: WHEN un intent transiciona a `'disputed'` (`openDispute`) bajo las condiciones de AC-2
  con consentimiento `true`, THE system SHALL invocar `lockForDispute(keyId,
  authorized_usd_atomic)` de forma best-effort EXACTAMENTE UNA VEZ por transición (cubre tanto
  el auto-resolve inmediato bajo `ARBITER_AUTO_CAP_USD` como el camino a `arb_hold`), y SHALL
  registrar el outcome (`confirmed`/`not_moved`/`ambiguous`) sin bloquear ni fallar la
  resolución de la disputa si el lock falla.
- AC-4: WHEN `executeArbitration` resuelve un desenlace `release`/`split` (`settleUsd > 0`)
  bajo las condiciones de AC-2/AC-3 con un lock previamente `confirmed` on-chain, THE system
  SHALL invocar `resolveDispute(keyId, seller, sellerAmount, nonce)` en lugar de
  `settlePaymentIntentOnChain`, con un `nonce` generado en un namespace que NUNCA colisiona con
  los nonces de `debit()`/`debitBatch()` sobre el mismo `keyId` (namespace compartido,
  `WasiAIEscrow.sol:55`).
- AC-5: WHEN `executeArbitration` resuelve un desenlace `refund` (`settleUsd <= 0`) bajo las
  mismas condiciones, THE system SHALL invocar `releaseDispute(keyId)` en lugar de dejar el
  lock huérfano, dejando el balance disponible para el `withdraw()` normal del depositante.
- AC-6: IF cualquier leg on-chain de esta HU (`lockForDispute`/`resolveDispute`/
  `releaseDispute`) resulta `ambiguous` (timeout de receipt / RPC no disponible tras
  broadcast), THEN THE system SHALL marcar el intent para reconciliación (mismo patrón
  `reconciliation_pending` de 191b/191c) y SHALL NOT asumir que los fondos se movieron ni
  reintentar automáticamente en el mismo request.
- AC-7 (no-break): IF el wire on-chain no está operante (flag OFF, sin escrow configurado, sin
  consentimiento, o `NotArbiter` porque 191h aún no ejecutó `setArbiter()`), THEN THE system
  SHALL continuar resolviendo disputas — auto rules/llm (WKH-139 v2) y override admin
  (WKH-189) — exactamente como hoy, sin ningún cambio de comportamiento observable.
- AC-8 (ubiquitous): the system SHALL firmar/enviar toda llamada `onlyArbiter` usando
  EXCLUSIVAMENTE la wallet derivada de `ARBITER_PRIVATE_KEY` (env var nueva, dedicada) — NUNCA
  `OPERATOR_PRIVATE_KEY`.

## Scope IN

- `src/adapters/escrow/abi.ts` — extender `ESCROW_ABI` con `lockForDispute`, `resolveDispute`,
  `releaseDispute`, `arbitrationConsent` (view), `lockedAmount` (view), y los eventos
  `DisputeLocked`/`DisputeResolved`/`DisputeReleased` (converge byte-a-byte con
  `IWasiAIEscrow.sol`, mismo patrón que la extensión ya hecha para `Debited` en 191b).
- Nuevo módulo `src/adapters/escrow/arbiter-executor.ts` (mirror de `debit-executor.ts`, wallet
  client propio keyed por `ARBITER_PRIVATE_KEY`): `executeLockForDispute`,
  `executeResolveDispute`, `executeReleaseDispute` — cada una devuelve
  `confirmed`/`not_moved`/`ambiguous` con re-verificación del evento correspondiente (nunca
  lanza).
- `src/services/arbiter.ts` — wire en 3 puntos: `resolveDispute` (método del servicio, tras la
  transición `open_dispute`) → best-effort lock; `executeArbitration` → branch on-chain
  (`resolveDispute`/`releaseDispute`) en vez de `settlePaymentIntentOnChain` cuando aplica;
  `resolveHold` NO se toca (hereda el wire vía `executeArbitration`, CD-1 de WKH-189).
- `src/adapters/escrow-verifier.ts` — reuso de `resolveEscrowContract` tal cual (sin cambios),
  y consulta view de `arbitrationConsent(keyId)` (helper nuevo, mismo cliente cacheado).
- Env vars nuevas (nombres a confirmar en F2): `ARBITER_PRIVATE_KEY`,
  `ARBITER_ONCHAIN_ENABLED` (flag maestro, default `false`, mismo patrón `=== 'true'` exacto
  que `ARBITER_ENABLED`/`ESCROW_SETTLE_ENABLED`).
- Persistencia/telemetría del outcome del lock (columna/tabla nueva a definir en F2 —
  precedente `record_debit_hop1`/`record_debit_settle_status` de 191b) — al menos logging
  estructurado si no hay tiempo para tabla dedicada.
- Tests unitarios del executor (mock de `viem` walletClient/publicClient, mismo patrón
  `debit-executor.test.ts`) + tests del wire en `arbiter.ts` (flag ON/OFF, consent true/false,
  lock confirmed/not_moved/ambiguous, cada rama de `executeArbitration`).

## Scope OUT

- `contracts/src/WasiAIEscrow.sol` / `IWasiAIEscrow.sol` — YA DONE (191f), congelado; esta HU
  no toca Solidity.
- Deploy/upgrade del contrato (`proposeUpgrade` + timelock 2d + `_authorizeUpgrade`) y
  `setArbiter(newArbiter)` on-chain = **WKH-191h** (gated, HU separada). **Sin esto, TODAS las
  llamadas `onlyArbiter` de esta HU revierten `NotArbiter` en la práctica** — 191g es
  code-complete/testeable con mocks, su ejecución real depende 100% de 191h.
- El flujo de captura de `setArbitrationConsent` del lado del buyer — ver DT-3: requiere una tx
  DIRECTA del depositante (no delegable por firma/relay), que este backend no tiene hoy ningún
  mecanismo para producir. **Gap de producto/frontend, marcado `[NEEDS CLARIFICATION]`, HU
  separada sugerida** (ver Missing Inputs). 191g solo CONSULTA el estado (view, AC-2), nunca lo
  setea.
- La activación real en producción (191d/191h — aplicar env vars, correr `setArbiter()`).
- Cambios a `WKH-139 v2` (`rules.ts`, `llm-classifier.ts`, `evidence.ts`, el cap gate) o a
  `WKH-189` (`dashboard.html`, los endpoints admin) — sin cambios de comportamiento cuando el
  path on-chain no aplica (AC-7); `resolveHold` no se modifica.
- Mainnet — ninguna chain (CD-5 heredado del epic WKH-191).
- Reconciliación automática de un lock `ambiguous`/huérfano (el motor de 191c es para hop1/hop2
  del flujo normal, NO cubre `lockForDispute`/`resolveDispute` — extenderlo, si hace falta, es
  seguimiento fuera de esta HU).

## Decisiones técnicas (DT-N)

- **DT-1 (key del árbitro)**: `ARBITER_PRIVATE_KEY` — env var NUEVA y DEDICADA, patrón
  idéntico a `OPERATOR_PRIVATE_KEY` en `debit-executor.ts:74-99`
  (`privateKeyToAccount`+`createWalletClient`, cacheado per-`ChainKey`), pero en un módulo
  propio (`arbiter-executor.ts`) para no mezclar el cache de clients del operador con el del
  árbitro. Su address DEBE coincidir con `_arbiter` on-chain (seteado por `setArbiter()` en
  191h). Sin la env var, o si la address no matchea (`NotArbiter` revert), el executor
  devuelve `not_moved` — NUNCA lanza, mismo contrato de `Hop1Outcome`. Justificación: el
  founder + 191f ya ratificaron rol dedicado (separado de `_operator`); reusar
  `OPERATOR_PRIVATE_KEY` violaría ese diseño y sería un solo punto de compromiso para ambos
  roles.
- **DT-2 (mapeo de desenlaces)**:
  - `openDispute`/`resolveDispute` (servicio, transición a `'disputed'`) → best-effort
    `lockForDispute(keyId, authorized_usd_atomic)` por el MONTO TOTAL del deposit (no el
    `settleUsd` final, aún desconocido en ese punto) — UNA sola llamada cubre tanto el
    auto-resolve inmediato (rules/llm bajo `ARBITER_AUTO_CAP_USD`, que nunca pasa por
    `holdArbitration`) como el camino a `arb_hold` + override humano (WKH-189), evitando
    duplicar el punto de wire.
  - `executeArbitration`, rama refund total (`arbMicro<=0`, `:523-543`) → `releaseDispute(keyId)`
    en vez del no-op actual.
  - `executeArbitration`, rama release/split (`arbMicro>0`, `:546-641`) → `resolveDispute(keyId,
    seller, sellerAmount, nonce)` en vez de `settlePaymentIntentOnChain`. `seller` = `row.pay_to`
    (mismo campo que hoy alimenta el settle operator-custodial).
  - `resolveHold` (WKH-189, `:904-1012`) NO requiere código nuevo — ya delega a
    `executeArbitration` (`:1011`), hereda el mapeo automáticamente.
- **DT-3 (consentimiento — GAP, no resuelto en 191g)**: `setArbitrationConsent(keyId, bool)`
  exige `msg.sender == _depositor[keyId]` LITERAL (`WasiAIEscrow.sol:134`) — a diferencia de
  `DebitAuthorization` (firma EIP-712 off-chain, el server la recibe y re-presenta vía
  `debit()`), no existe ningún mecanismo de firma/relay para esta función: el depositante debe
  enviar su PROPIA transacción. Grep exhaustivo de `src/` confirma **cero call-sites** de
  `setArbitrationConsent` hoy — el flujo de captura NO existe. Este backend (`wasiai-a2a`) no
  tiene hoy ningún camino donde el buyer firme+envíe transacciones propias (solo firma
  mensajes off-chain, p.ej. `DebitAuthorization`, `signed-auth.ts`). **Conclusión**: la
  captura de consentimiento es un gap de producto/frontend-wallet, fuera del alcance de un
  backend-only wire como 191g. Se marca `[NEEDS CLARIFICATION]` con recomendación de HU
  separada. 191g solo CONSULTA (view, gratis) `arbitrationConsent(keyId)` antes de actuar
  (AC-2) — con el gap sin resolver, el resultado será `false` para el 100% de los keyIds y el
  sistema caerá SIEMPRE al fallback operator-custodial (comportamiento correcto, no un bug).
- **DT-4 (idempotencia del lock)**: `lockForDispute` es incremental (top-up, contrato
  `:245-252`) — un retry accidental de `openDispute` podría sobre-lockear si se llama dos
  veces. 191g llama `lockForDispute` UNA sola vez por transición a `'disputed'`, gateado por
  el mismo `FOR UPDATE` row-lock que ya provee el RPC `open_dispute` (CD-4 heredado del epic),
  y persiste el outcome (tx hash / `not_moved` / `ambiguous`) para telemetría — análogo a
  `record_debit_hop1`/`record_debit_settle_status` de 191b.
- **DT-5 (nonce de `resolveDispute`)**: derivación propuesta —
  `keccak256(stringToBytes('arbiter-dispute:' + intentId))` truncado a `uint256`, namespace
  distinguible por prefijo del esquema de nonces client-side de `debit()`
  (`eip712.ts`/191a). El Architect DEBE confirmar en F2 el esquema real de nonces que usa
  191a/191b antes de fijar esto (si 191a usa nonces secuenciales bajos o derivados de forma
  similar, el prefijo textual reduce el riesgo de colisión a ~0 mediante el hash, pero la
  confirmación cruzada es obligatoria — CD-3).

## Constraint Directives (CD-N)

- CD-1: OBLIGATORIO flag-gated con TRIPLE condición — `ARBITER_ONCHAIN_ENABLED=true` **AND**
  `resolveEscrowContract(chainKey) !== null` **AND** `arbitrationConsent(keyId) === true`
  (view on-chain) — las TRES deben cumplirse antes de invocar cualquier función `onlyArbiter`;
  la ausencia de cualquiera cae al path operator-custodial existente, byte-idéntico (AC-1/AC-2).
- CD-2: PROHIBIDO romper `WKH-139 v2` (auto-resolve rules/llm/cap, `arbiter.ts:391-478`) ni
  `WKH-189` (override admin, `:904-1012`) — ambos siguen funcionando byte-idénticamente sobre
  `budget` off-chain cuando el path on-chain no aplica (AC-7); el wire es ADITIVO, nunca
  reemplaza `close_payment_intent_for_arbitration`/`record_settle_outcome`/
  `finalize_payment_intent`.
- CD-3: OBLIGATORIO anti-replay/exactly-once del nonce de `resolveDispute` en un namespace
  DISJUNTO del nonce de `debit()`/`debitBatch()` sobre el mismo `keyId` (comparten
  `_usedNonces[keyId][nonce]`, `WasiAIEscrow.sol:55`) — PROHIBIDO cualquier esquema de
  derivación que pueda colisionar con una autorización de débito pasada o futura del buyer
  (ver DT-5, confirmar en F2).
- CD-4: OBLIGATORIO re-verificar on-chain antes de asumir éxito de cualquier leg
  (`lockForDispute`/`resolveDispute`/`releaseDispute`) — mismo patrón unequivocal/ambiguous de
  `executeDebitHop1` (`debit-executor.ts:181-233`): timeout/RPC-unavailable → `ambiguous`
  (NUNCA asumir movimiento), revert → `not_moved`, receipt success sin evento matcheado →
  `ambiguous`.
- CD-5: OBLIGATORIO que toda llamada `onlyArbiter` se firme EXCLUSIVAMENTE con la wallet de
  `ARBITER_PRIVATE_KEY` — PROHIBIDO reusar `OPERATOR_PRIVATE_KEY` para estas llamadas (rol
  dedicado, DT-1, heredado del epic WKH-191/191f).
- CD-6: PROHIBIDO deployar, upgradear el contrato, o depender de `setArbiter()` habiendo
  corrido contra fondos reales — testnet-only para TODA esta HU (CD-5 heredado del epic
  WKH-191); ninguna llamada on-chain de 191g puede alcanzar mainnet.
- CD-7: OBLIGATORIO que la ausencia del flujo de consentimiento (DT-3) sea manejada como
  fallback SILENCIOSO y correcto — PROHIBIDO que `arbitrationConsent(keyId) === false` genere
  error, warning ruidoso, o bloqueo de la resolución de la disputa; es el comportamiento
  esperado hasta que exista la HU de captura de consentimiento.

## Missing Inputs

- `[bloqueante para EJECUCIÓN real, NO para código]` 191h (deploy/upgrade + `setArbiter()`) no
  ha corrido — toda llamada `onlyArbiter` de esta HU revierte `NotArbiter` hasta entonces. Esta
  HU es code-complete y testeable con mocks (viem walletClient/publicClient simulados, mismo
  patrón `debit-executor.test.ts`); su activación end-to-end depende 100% de 191h.
- `[bloqueante de producto, HU separada sugerida]` El flujo de captura de
  `setArbitrationConsent` (buyer firma+envía su PROPIA tx on-chain) no existe en el codebase —
  requiere una HU de frontend/wallet-UX (sugerida `WKH-191g-consent`, o absorbida por 191h si el
  Architect lo considera parte del mismo paquete de activación). Hasta que exista, `191g`
  permanecerá funcionalmente inerte en producción (siempre fallback), comportamiento correcto
  y explícitamente contemplado por CD-1/CD-7/AC-2.
- `[confirmar en F2]` Nombre final de la env var flag (`ARBITER_ONCHAIN_ENABLED` propuesto —
  el Architect puede preferir consistencia con `ESCROW_SETTLE_ENABLED`/
  `ESCROW_DEBIT_CAPTURE_ENABLED`, p.ej. `ESCROW_ARBITER_ENABLED`).
- `[confirmar en F2]` Esquema exacto de derivación del nonce de `resolveDispute` (DT-5) — el
  Architect debe verificar el esquema real de nonces de 191a/191b (`eip712.ts`/`debit-capture.ts`)
  antes de fijar la fórmula propuesta, para garantizar namespace disjunto (CD-3).
- `[confirmar en F2]` Forma de persistencia del outcome del lock (`lockForDispute`) — ¿columna
  nueva en `a2a_arbitrations`, tabla dedicada (precedente `record_debit_hop1` de 191b), o solo
  logging estructurado? Decisión de diseño del Architect según presupuesto de la HU.
- `[TBD — F2, no bloqueante]` ¿`executeArbitration` debe re-verificar el lock (`lockedAmount(keyId)
  >= sellerAmount`) vía una llamada view ADICIONAL inmediatamente antes de `resolveDispute`
  (defensa en profundidad, más gas/latencia) o confiar en la re-verificación implícita del
  propio revert del contrato (`ExceedsLockedAmount`)? Recomendación del Analyst: confiar en el
  revert del contrato (ya cubierto por AC-4/CD-4, mismo patrón que el resto del money-path que
  no re-simula on-chain antes de intentar).

## Análisis de paralelismo

- Depende de (DONE, sin cambios en esta HU): WKH-191f (fila 177, contrato) — código congelado;
  WKH-139 v2 (fila 145) y WKH-189 (fila 171) — el wire es aditivo sobre ambos, sin tocar
  `rules.ts`/`llm-classifier.ts`/`evidence.ts`/`dashboard.html`.
- Bloquea WKH-191h (deploy/upgrade + smoke E2E de disputa) — 191h necesita el wire de código
  YA en `main` antes de poder validar el path real end-to-end tras el upgrade.
- Puede ejecutarse EN PARALELO con la Wave 0 (191a-191e, en curso/pendiente) — superficie
  distinta (`arbiter.ts`/`escrow/arbiter-executor.ts` vs `payment-intent.ts`
  /`escrow/debit-capture.ts`/`debit-executor.ts`), con UN punto de overlap de bajo riesgo:
  ambas Waves extienden `src/adapters/escrow/abi.ts` — 191g agrega funciones NUEVAS
  (`lockForDispute`/`resolveDispute`/`releaseDispute`/`arbitrationConsent`), sin tocar las que
  191a-e ya agregaron (`debit`, `Debited`), riesgo de conflicto de merge bajo (secciones
  distintas del array `as const`).
- No bloquea ninguna HU DONE/in-progress fuera del epic WKH-191 (filas 159-163/176 de
  `_INDEX.md` tocan `orchestrate.ts`/`discovery.ts`, módulo distinto, sin overlap).
- El gap de consentimiento (DT-3/Missing Inputs) es candidato a HU nueva, coordinable en
  paralelo a 191h — no bloquea el CÓDIGO de 191g, solo su activación real en producción.
