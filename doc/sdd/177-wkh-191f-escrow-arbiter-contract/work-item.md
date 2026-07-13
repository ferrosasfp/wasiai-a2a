# Work Item — [WKH-191f] Contrato: rol árbitro dedicado + `resolveDispute` (upgrade UUPS)

> Wave 1 (HU 6 de 8) del epic [WKH-191](../172-wkh-191-escrow-noncustodial-settlement/work-item.md).
> Depende del árbitro app-side ya DONE ([WKH-139 v2](../145-wkh-139-agent-arbiter/work-item.md),
> [WKH-189](../171-wkh-189-arb-hold-override/work-item.md)), que hoy opera 100% sobre `budget`
> off-chain sin tocar `WasiAIEscrow.sol`. Esta HU es el **único cambio de Solidity** de la Wave 1.

## Resumen

`WasiAIEscrow.sol` (WKH-126a, auditado, deployado en Base Sepolia) no tiene ningún camino
para mover fondos de un `keyId` SIN la firma EIP-712 de su `_depositor` — ni `_arbiter`, ni
`resolveDispute`, ni ningún concepto de disputa. En una disputa real, el buyer (depositante)
por definición NO va a firmar para pagarle al seller (esa es la disputa), así que el árbitro
autónomo necesita autoridad propia de contrato. Esta HU agrega un rol `_arbiter` dedicado
(separado de `_operator`), un mecanismo de consentimiento explícito **opt-in encodeado
on-chain** por el propio depositante, y una función `resolveDispute` que el árbitro invoca
para pagar al seller — todo vía upgrade UUPS (`proposeUpgrade` + timelock 2 días), extendiendo
(nunca reemplazando) los invariantes Foundry existentes. **Testnet-only** (CD-5 heredado del
epic).

## Sizing

- SDD_MODE: full
- Estimación: L (cambio de Solidity, security-crítico, requiere invariantes nuevos)
- Branch sugerido: `feat/191f-escrow-arbiter-contract`

## Grounding (F0, archivo:línea)

- `contracts/src/WasiAIEscrow.sol:52-59` — storage actual: `_balances`, `_depositor`,
  `_lockedAmount` (línea 54, **DT-11 "stays 0 (optimistic)" — YA EXISTE, no usado hoy**),
  `_usedNonces` (línea 55, `mapping(bytes32 => mapping(uint256 => bool))`), `_operator`
  (línea 57), `__gap uint256[43]` (línea 59, comentario "was 44; -1 for `_operator`, CD-9").
- `:92-98` `setOperator(address) onlyOwner` — patrón a espejar exacto para `setArbiter`.
- `:100-114` `deposit()` — CEI + `_depositor[keyId]` lock-on-first-deposit (DT-10/CD-8), sin
  cambios en esta HU.
- `:121-141` `_verifyAndConsume` — recover EIP-712, `_usedNonces[keyId][nonce]` marca
  irrevocable (línea 139 comentario "irrevocable (CD-3)"), CEI (nonce+balance ANTES del
  transfer). Este mapping es **reusable tal cual** para el anti-replay de `resolveDispute`
  (mismo namespace `keyId=>nonce=>bool`, cero storage nuevo).
- `:148-156` `debit()` — `onlyOperator` (`msg.sender != _operator` → `NotOperator`), paga
  SIEMPRE a `msg.sender` (comentario `:154 "to operator (DT-2)"`) — confirma el hallazgo #1
  del epic: pagar a un tercero (seller/arbiter-target) requiere función nueva, no reactivar
  ésta.
- `:188-194` `withdraw()` — exige `msg.sender == _depositor[keyId]`, `available =
  _balances[keyId] - _lockedAmount[keyId]`. **Hallazgo de seguridad nuevo de este F0**: como
  `_lockedAmount` siempre es 0 hoy, un depositante puede llamar `withdraw()` directamente
  (bypasseando la app) en cualquier momento — incluso con una disputa abierta app-side — y
  drenar el balance ANTES de que el árbitro invoque `resolveDispute`, dejando `sellerAmount >
  escrowBalance(keyId)` y forzando el revert de la resolución legítima. Ver DT-5 / Missing
  Inputs — el primitivo `_lockedAmount` YA EXISTE para cerrar esto pero activar su uso está
  fuera del scope literal pedido para 191f (marcado `[NEEDS CLARIFICATION]`).
- `:197-234` `proposeUpgrade`/`cancelUpgrade`/`renounceUpgrade`/`_authorizeUpgrade` — patrón
  de upgrade con `MIN_TIMELOCK = 2 days` (línea 42) + `UPGRADE_GRACE = 7 days` (línea 44);
  191f se propone así, 191h ejecuta el upgrade real (deploy/upgrade queda Scope OUT acá).
- `contracts/src/interfaces/IWasiAIEscrow.sol` — ABI espejada byte-a-byte con
  `src/adapters/escrow/abi.ts` (comentario línea 5); agregar `resolveDispute`,
  `setArbiter`, `setArbitrationConsent`, eventos y errores nuevos acá también.
- `contracts/test/WasiAIEscrow.invariant.t.sol:212-223` —
  `invariant_operatorCannotDrainWithoutSig` (identidad de conservación
  `deposited-debited-withdrawn`) e `invariant_hostilePathAlwaysReverts`
  (`ghost_hostileAttempts == ghost_hostileReverts`). Un `resolveDispute` legítimo (sin firma
  del depositante, por diseño) rompería la PRIMERA invariante tal como está escrita hoy si no
  se agrega un ghost term nuevo — no es un bug del árbitro, es que la identidad actual no
  contempla ese leg.
- `contracts/test/WasiAIEscrow.invariant2.t.sol:453-497` — suite comprehensiva
  multi-tenant: `invariant_conservation`, `invariant_perKeyBalanceMirror`,
  `invariant_accessControlAlwaysReverts`, `invariant_noReplay`, `invariant_noUnderflow`. Mismo
  patrón de extensión requerido: nuevo ghost term `ghost_totalArbiterResolved` en la identidad
  de conservación/mirror, más un handler hostil dedicado a `resolveDispute` sin
  arbiter/sin consentimiento.
- `contracts/script/Deploy.s.sol` — deploy inicial vía `ERC1967Proxy` + `initialize()`; 191f
  NO toca este script (el upgrade real es 191h), pero `initialize()` no puede volver a
  correr — `_arbiter` debe arrancar en `address(0)` y activarse post-upgrade vía
  `setArbiter()` (ver DT-4), no vía `reinitializer`.
- `doc/sdd/172-wkh-191-escrow-noncustodial-settlement/work-item.md` (epic) — decisiones (a)
  rol dedicado + estado app-gated y (b) consentimiento explícito YA RATIFICADAS por el founder
  (ver instrucciones de esta tarea); esta HU resuelve el **mecanismo concreto** de (b), que el
  epic dejaba abierto.
- `doc/sdd/145-wkh-139-agent-arbiter/work-item.md` — el árbitro app-side (DONE) que
  consumirá `resolveDispute` en 191g; DT-1 de esa HU confirma que hoy opera sobre el intent
  `session` (`payment-intent.ts`), no sobre el contrato — 191f no cambia eso, solo habilita el
  camino on-chain que 191g cableará después.

## Acceptance Criteria (EARS)

- AC-1: WHEN el depositante de un `keyId` llama `setArbitrationConsent(keyId, true)`, THE
  system SHALL persistir opt-in explícito on-chain para ese `keyId` (queryable, con evento
  auditable) como precondición obligatoria de cualquier `resolveDispute` futuro sobre ese
  `keyId`.
- AC-2: IF `resolveDispute` es llamado sobre un `keyId` SIN consentimiento persistido, THEN
  THE system SHALL revertir (`ArbitrationNotConsented` o equivalente) y SHALL NOT mover
  fondos.
- AC-3: WHEN el `_arbiter` configurado llama `resolveDispute(keyId, seller, sellerAmount,
  nonce)` para un `keyId` con consentimiento válido, `sellerAmount > 0`, `sellerAmount <=
  escrowBalance(keyId)` y un `nonce` no usado, THE system SHALL transferir exactamente
  `sellerAmount` USDC a `seller`, decrementar `_balances[keyId]` en `sellerAmount`, marcar
  `(keyId, nonce)` como consumido, y dejar el residual disponible para el `withdraw()` propio
  del depositante.
- AC-4: IF cualquier dirección distinta de `_arbiter` llama `resolveDispute`, THEN THE system
  SHALL revertir (`NotArbiter`) sin importar el estado de consentimiento — mismo patrón que
  `onlyOperator` en `debit()` (`WasiAIEscrow.sol:152`).
- AC-5: IF `resolveDispute` es llamado dos veces con el mismo `(keyId, nonce)`, THEN THE
  system SHALL revertir en la segunda llamada (`NonceAlreadyUsed`, reusando
  `_usedNonces[keyId][nonce]`) — ejecución exactly-once por resolución de disputa.
- AC-6: IF `sellerAmount` excede `escrowBalance(keyId)`, THEN THE system SHALL revertir
  (`InsufficientBalance`) y SHALL NOT transferir parcialmente.
- AC-7: the system SHALL preservar el storage-layout UUPS-safe: `_arbiter` (address) y
  `_arbitrationConsent` (mapping `bytes32=>bool`) se agregan consumiendo 2 slots del
  `__gap[43]` existente (→ `__gap[41]`), sin reordenar ni redimensionar ninguna variable de
  storage preexistente, y sin requerir un `reinitializer` (ver DT-4).
- AC-8: WHEN el owner del contrato llama `setArbiter(newArbiter)`, THE system SHALL rotar
  `_arbiter` y emitir `ArbiterUpdated(oldArbiter, newArbiter)` — mismo patrón que
  `setOperator`/`OperatorUpdated` (`:92-98`, `:12-13` de la interfaz).
- AC-9: the system SHALL extender (no reemplazar) ambas suites de invariantes Foundry
  (`WasiAIEscrow.invariant.t.sol`, `WasiAIEscrow.invariant2.t.sol`) con: (a) un ghost term
  `ghost_totalArbiterResolved` sumado a las identidades de conservación/solvencia/mirror
  existentes, y (b) witnesses hostiles nuevos que prueben que `resolveDispute` NUNCA tiene
  éxito sin AMBOS `msg.sender==_arbiter` Y `_arbitrationConsent[keyId]==true` — mientras las 7
  invariantes preexistentes (`operatorCannotDrainWithoutSig`, `hostilePathAlwaysReverts`,
  `invariant_solvency*`, `invariant_conservation`, `invariant_perKeyBalanceMirror`,
  `invariant_accessControlAlwaysReverts`, `invariant_noReplay`, `invariant_noUnderflow`)
  siguen pasando sin relajarse.

## Scope IN

- `contracts/src/WasiAIEscrow.sol` — nuevo storage (`_arbiter`, `_arbitrationConsent`),
  `setArbiter`, `setArbitrationConsent`, `resolveDispute`, eventos/errores nuevos.
- `contracts/src/interfaces/IWasiAIEscrow.sol` — extender ABI en paralelo (funciones, eventos,
  errores nuevos), converge byte-a-byte con el futuro `abi.ts` de 191g.
- `contracts/test/WasiAIEscrow.t.sol` — tests unitarios de las 3 funciones nuevas (happy path
  + cada revert de las AC-2/4/5/6).
- `contracts/test/WasiAIEscrow.invariant.t.sol` + `WasiAIEscrow.invariant2.t.sol` — extender
  ambos handlers/invariantes per AC-9.

## Scope OUT

- `src/adapters/escrow/{eip712.ts,abi.ts}`, `src/services/arbiter.ts` — wire del árbitro
  al camino on-chain nuevo = **WKH-191g** (HU separada).
- Ejecutar el upgrade real (`proposeUpgrade` + esperar timelock 2d + `_authorizeUpgrade` en
  cadena) = **WKH-191h** (HU separada, gated).
- `contracts/script/Deploy.s.sol` / script de upgrade — 191h.
- Mainnet — ninguna chain (CD-5 heredado del epic WKH-191).
- Cambiar el comportamiento o firma de `deposit()`, `debit()`, `debitBatch()`, `withdraw()`
  — permanecen byte-idénticos en esta HU salvo el storage-layout (CD-7). El gap de
  "withdraw durante disputa abierta" (ver Grounding) queda documentado, NO resuelto acá.
- Cualquier cambio a la máquina de estados app-side (`payment_intents.disputed`/`arb_hold`,
  `close_payment_intent_for_arbitration`, panel WKH-189) — ya DONE, no se toca.
- Auditoría externa del contrato — condición de CD-5 del epic para habilitar contra fondos
  reales; fuera del alcance de esta HU (que es testnet-only por diseño).

## Decisiones técnicas (DT-N)

- DT-1: Mecanismo de consentimiento = función dedicada `setArbitrationConsent(bytes32 keyId,
  bool consent)`, callable SOLO por `_depositor[keyId]` (mismo guard de autorización que
  `withdraw`, `:189`). NO se codea dentro de `deposit()` (mantiene su firma intacta) ni vía
  una firma EIP-712 adicional — el propio `msg.sender` del depositante ya es prueba
  criptográfica suficiente, sin necesidad de un mensaje firmado separado.
- DT-2: El consentimiento es **monotónico/irrevocable** en esta HU (una vez `true`, no puede
  volver a `false`). Alternativa revocable evaluada y descartada: permitir revocación abriría
  un vector de griefing (el depositante revoca justo antes de que el árbitro resuelva una
  disputa legítima, bloqueándola). Si el founder quiere revocación con cooldown, es una
  extensión a ratificar (`[NEEDS CLARIFICATION]`, no bloqueante).
- DT-3: Anti-replay/exactly-once de `resolveDispute` reusa el mapping `_usedNonces[keyId][
  nonce]` YA EXISTENTE (mismo namespace que `debit`/`debitBatch`) — el árbitro (app-side)
  genera un nonce fresco por resolución (p.ej. derivado del dispute id en `payment_intents`).
  Cero storage nuevo para exactly-once.
- DT-4: `_arbiter` arranca en `address(0)` tras el upgrade — el owner debe llamar
  `setArbiter()` en una transacción SEPARADA post-upgrade para activarlo. Se descarta un
  `reinitializer(2)` que setee `_arbiter` durante el propio `_authorizeUpgrade`: evita el
  riesgo de secuenciar mal un reinitializer y mantiene el patrón ya usado por `_operator`
  (seteado explícitamente, rotable vía función dedicada, nunca implícito).
- DT-5 (recomendación NO vinculante — riesgo abierto, ver Grounding): el gap "depositante
  puede `withdraw()` fondos mientras una disputa está abierta app-side, adelantándose al
  árbitro" queda ACEPTADO como riesgo conocido en 191f. El primitivo `_lockedAmount[keyId]`
  (línea 54, comentario "DT-11 — stays 0 (optimistic)") YA EXISTE en el contrato y sería la
  vía natural de cerrarlo (lock del monto en disputa antes de que el árbitro resuelva) sin
  storage nuevo — pero activar su uso implica una función adicional (`lockForDispute`/
  equivalente) no pedida literalmente en el alcance de esta HU. Queda `[NEEDS
  CLARIFICATION]` si entra a 191f o a un follow-up.

## Constraint Directives (CD-N)

- CD-1: OBLIGATORIO storage layout UUPS-safe — `_arbiter` (address) y
  `_arbitrationConsent` (mapping `bytes32=>bool`) se agregan INMEDIATAMENTE después del
  storage existente, consumiendo 2 slots de `__gap[43]` (→ `__gap[41]`); CERO reordenamiento
  ni redimensionamiento de variables preexistentes; `initialize()` permanece byte-idéntico
  (sin `reinitializer`, ver DT-4).
- CD-2: PROHIBIDO que `resolveDispute` ejecute sin AMBOS checks: `msg.sender == _arbiter`
  (revert `NotArbiter`) Y `_arbitrationConsent[keyId] == true` (revert
  `ArbitrationNotConsented`) — ningún atajo, ningún camino que dependa de uno solo de los dos.
- CD-3: OBLIGATORIO `sellerAmount <= _balances[keyId]` (reusa `InsufficientBalance`), orden
  CEI estricto (marcar nonce usado + decrementar `_balances[keyId]` ANTES del
  `_usdc.safeTransfer`), `nonReentrant`, `SafeERC20` — mismo patrón exacto que
  `debit()`/`_verifyAndConsume` (`:121-156`).
- CD-4: OBLIGATORIO exactly-once vía `_usedNonces[keyId][nonce]` (reuso del mapping
  existente, DT-3) — replay del mismo `(keyId, nonce)` DEBE revertir `NonceAlreadyUsed`.
- CD-5: PROHIBIDO debilitar o relajar cualquiera de las 7 invariantes Foundry preexistentes
  (`operatorCannotDrainWithoutSig`, `hostilePathAlwaysReverts`, `invariant_solvency*`,
  `invariant_conservation`, `invariant_perKeyBalanceMirror`,
  `invariant_accessControlAlwaysReverts`, `invariant_noReplay`, `invariant_noUnderflow`) —
  deben EXTENDERSE (nuevo ghost term `ghost_totalArbiterResolved` + nuevos hostile-witnesses
  para `resolveDispute` sin arbiter/sin consentimiento), nunca reemplazarse.
- CD-6: OBLIGATORIO eventos nuevos auditables: `DisputeResolved(bytes32 indexed keyId,
  address indexed arbiter, address indexed seller, uint256 sellerAmount, uint256 nonce)` y
  `ArbiterUpdated(address indexed oldArbiter, address indexed newArbiter)` — mismo patrón de
  auditabilidad que `Debited`/`OperatorUpdated`.
- CD-7: PROHIBIDO modificar la lógica, firma o gas-path de `deposit()`, `debit()`,
  `debitBatch()`, `withdraw()` en esta HU salvo el cambio de storage-layout (CD-1) —
  permanecen byte-idénticos. El riesgo DT-5 (withdraw-race durante disputa) queda documentado
  como conocido, no mitigado en 191f.

## Missing Inputs

- `[resuelto por el founder, mecanismo concreto propuesto en DT-1/DT-2 — confirmar en F2]`
  Rol dedicado (a) y consentimiento explícito encodeado (b) YA fueron ratificados a nivel de
  decisión de producto por el founder (instrucción de esta tarea). Esta HU propone el
  mecanismo CONCRETO (función dedicada `setArbitrationConsent`, monotónica/irrevocable) — el
  Architect debe confirmar en F2 que este mecanismo es aceptable o si el founder prefiere una
  alternativa (p.ej. consentimiento revocable con cooldown, o consentimiento vía firma EIP-712
  separada en vez de una tx directa).
- `[NEEDS CLARIFICATION, no bloqueante para arrancar F2]` DT-5 — ¿cerrar el withdraw-race
  durante disputa abierta usando el `_lockedAmount` ya existente dentro de 191f, o diferir a
  un follow-up (sugerido 191f-bis, o parte de 191g/191h)? Recomendación del Analyst: diferir
  (mantiene 191f acotada al pedido literal del ticket), pero documentar el riesgo
  explícitamente en el SDD de 191f para que el Architect decida con contexto completo.
- `[confirmar en F2]` ¿`sellerAmount == 0` en `resolveDispute` debe revertir (`ZeroAmount`,
  propuesta del Analyst) o ser un no-op válido? Un refund-total sin pago a seller no necesita
  `resolveDispute` — el balance simplemente queda disponible para el `withdraw()` normal del
  depositante — por eso la propuesta es revertir y mantener la función enfocada en el caso
  "hay un pago a seller que forzar".
- `[TBD — F2, no bloqueante]` Nombres finales exactos de función/evento/error (mantener
  consistencia con la nomenclatura ya usada en el contrato) — el Architect los fija en el SDD.

## Análisis de paralelismo

- 191f bloquea 191g (wire de `arbiter.ts` al camino on-chain) y 191h (deploy/upgrade +
  smoke E2E de disputa) — secuencial dentro de la Wave 1 del epic.
- 191f puede diseñarse (F2 SDD) en paralelo a la Wave 0 (191a-e) que sigue ejecutándose sin
  relación de código (superficie `contracts/` vs `src/services/payment-intent.ts` +
  `src/adapters/escrow-verifier.ts`), pero su F3 (Solidity real) depende de que el Architect
  confirme el mecanismo concreto de consentimiento (DT-1/DT-2) — si el founder objeta el
  mecanismo propuesto, 191f debe reabrirse antes de F3.
- No bloquea ninguna HU DONE/in-progress fuera del epic WKH-191 (filas 159-176 de
  `_INDEX.md` tocan `orchestrate.ts`/`discovery.ts`, módulo distinto, sin overlap).
- Depende de (DONE, sin cambios en esta HU): WKH-126a (`WasiAIEscrow.sol` base), WKH-139 v2
  (árbitro app-side, fila 145), WKH-189 (panel override, fila 171) — 191f solo habilita el
  camino on-chain que 191g cableará después; el árbitro sigue operando 100% sobre `budget`
  off-chain hasta que 191g exista.
