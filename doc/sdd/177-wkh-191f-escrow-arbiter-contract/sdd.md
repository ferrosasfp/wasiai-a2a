# SDD #191f: Contrato — rol árbitro dedicado + `resolveDispute` + lock on-chain (upgrade UUPS)

> SPEC_APPROVED: no
> Fecha: 2026-07-13
> Tipo: feature (security-critical, Solidity)
> SDD_MODE: full
> Branch: feat/191f-escrow-arbiter-contract
> Artefactos: doc/sdd/177-wkh-191f-escrow-arbiter-contract/
> Epic: WKH-191 (Wave 1, HU 6/8) — testnet-only (CD-5 heredado)

---

## 1. Resumen

`WasiAIEscrow.sol` (WKH-126a, auditado, deployado en Base Sepolia) hoy NO tiene ningún
camino para mover fondos de un `keyId` sin la firma EIP-712 del `_depositor`. En una disputa
real el buyer (depositante) por definición NO firma para pagarle al seller — ésa ES la disputa —
así que el árbitro autónomo necesita autoridad propia de contrato. Esta HU agrega, vía upgrade
UUPS (código nuevo solamente; el deploy/upgrade on-chain es 191h):

1. Un rol dedicado `_arbiter` (separado de `_operator`), rotable por el owner.
2. Consentimiento **opt-in explícito, monotónico/irrevocable** por el propio depositante
   (`setArbitrationConsent`) — precondición obligatoria de toda acción del árbitro sobre ese `keyId`.
3. Un **lock on-chain** que activa el primitivo `_lockedAmount[keyId]` (ya presente en storage,
   hoy siempre 0): el árbitro congela el monto disputado (`lockForDispute`), lo que hace que
   `withdraw` (que ya resta `_lockedAmount`) impida al buyer drenar el balance antes de la
   resolución — cerrando el gap DT-5 del work-item.
4. `resolveDispute`: el árbitro paga al seller **sólo de lo lockeado**, con consentimiento
   verificado, anti-replay por nonce, CEI estricto y `SafeERC20`; el residual se libera para el
   `withdraw` del buyer. `releaseDispute` cierra una disputa sin pago (buyer gana).
5. Extensión (nunca reemplazo) de ambas suites de invariantes Foundry con el leg del árbitro.

Garantía non-custodial preservada: el árbitro SOLO puede tocar (congelar o pagar) fondos
**lockeados** de `keyIds` con **consentimiento**; nunca depósitos sin disputa/consentimiento.
El flujo normal (`deposit`/`debit`/`debitBatch`/`withdraw` con firma del depositante) queda
byte-idéntico salvo el storage-layout.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 191f (WKH-191 Wave 1) |
| **Tipo** | feature / security-critical / Solidity |
| **SDD_MODE** | full |
| **Objetivo** | Habilitar el camino on-chain del árbitro (rol + consentimiento + lock + `resolveDispute`) sin debilitar la garantía non-custodial ni los invariantes existentes |
| **Reglas de negocio** | Non-custodial: el árbitro sólo mueve fondos lockeados de keyIds consentidos. Testnet-only (CD-5 epic). Storage UUPS-safe. |
| **Scope IN** | `contracts/src/WasiAIEscrow.sol`, `contracts/src/interfaces/IWasiAIEscrow.sol`, `contracts/test/WasiAIEscrow.t.sol`, `contracts/test/WasiAIEscrow.invariant.t.sol`, `contracts/test/WasiAIEscrow.invariant2.t.sol` |
| **Scope OUT** | `src/adapters/escrow/*`, `src/services/arbiter.ts` (=191g); ejecutar el upgrade real / `Deploy.s.sol` (=191h); mainnet; cambiar firma/lógica de `deposit`/`debit`/`debitBatch`/`withdraw`; auditoría externa |
| **Missing Inputs** | Resueltos por el orquestador (ver §11) — el lock (DT-5) ENTRA a 191f; consentimiento monotónico ratificado; `sellerAmount==0` revierte |

### Acceptance Criteria (EARS)

Copiados/refinados del work-item. AC-10/AC-11/AC-12 nuevos por la incorporación del lock (orden del orquestador).

1. **AC-1**: WHEN el depositante de un `keyId` llama `setArbitrationConsent(keyId, true)`, THE
   system SHALL persistir opt-in on-chain queryable (`arbitrationConsent(keyId)==true`) y emitir
   `ArbitrationConsentSet(keyId, depositor)`, como precondición de toda acción del árbitro sobre
   ese `keyId`.
2. **AC-2**: IF `resolveDispute` (o `lockForDispute`) es llamado sobre un `keyId` SIN
   consentimiento persistido, THEN THE system SHALL revertir `ArbitrationNotConsented` y SHALL NOT
   mover ni congelar fondos.
3. **AC-3**: WHEN el `_arbiter` configurado llama `resolveDispute(keyId, seller, sellerAmount,
   nonce)` con consentimiento válido, `seller != address(0)`, `sellerAmount > 0`, `sellerAmount <=
   _lockedAmount[keyId]`, `sellerAmount <= escrowBalance(keyId)` y un `nonce` no usado, THE system
   SHALL transferir exactamente `sellerAmount` USDC a `seller`, decrementar `_balances[keyId]` en
   `sellerAmount`, poner `_lockedAmount[keyId] = 0` (liberar el residual para el `withdraw` del
   depositante), marcar `(keyId, nonce)` consumido y emitir `DisputeResolved`.
4. **AC-4**: IF cualquier dirección distinta de `_arbiter` llama `resolveDispute`,
   `lockForDispute` o `releaseDispute`, THEN THE system SHALL revertir `NotArbiter` sin importar el
   estado de consentimiento.
5. **AC-5**: IF `resolveDispute` es llamado dos veces con el mismo `(keyId, nonce)`, THEN THE
   system SHALL revertir la segunda llamada `NonceAlreadyUsed` (reusa `_usedNonces[keyId][nonce]`).
6. **AC-6**: IF `sellerAmount > escrowBalance(keyId)`, THEN THE system SHALL revertir
   `InsufficientBalance` y SHALL NOT transferir parcialmente.
7. **AC-7**: THE system SHALL preservar el storage-layout UUPS-safe: `_arbiter` (address) y
   `_arbitrationConsent` (mapping `bytes32=>bool`) se agregan consumiendo 2 slots del `__gap[43]`
   (→ `__gap[41]`), sin reordenar ni redimensionar ninguna variable preexistente y sin
   `reinitializer`; `initialize()` byte-idéntico (`_arbiter` arranca en `address(0)`).
8. **AC-8**: WHEN el owner llama `setArbiter(newArbiter)` con `newArbiter != address(0)`, THE
   system SHALL rotar `_arbiter` y emitir `ArbiterUpdated(oldArbiter, newArbiter)`; IF el caller no
   es owner THEN revertir `OwnableUnauthorizedAccount`; IF `newArbiter == address(0)` THEN revertir
   `ZeroAddress`.
9. **AC-9**: THE system SHALL extender (no reemplazar) ambas suites de invariantes Foundry con
   (a) el ghost term `ghost_totalArbiterResolved` sumado a las identidades de
   conservación/solvencia/mirror y (b) witnesses hostiles que prueben que `resolveDispute` /
   `lockForDispute` NUNCA tienen éxito sin AMBOS `msg.sender==_arbiter` Y
   `_arbitrationConsent[keyId]==true` (ni con `sellerAmount>_lockedAmount`, ni con nonce reusado);
   mientras las invariantes preexistentes siguen pasando sin relajarse.
10. **AC-10** (lock): WHEN el `_arbiter` llama `lockForDispute(keyId, amount)` sobre un `keyId`
    consentido con `amount > 0` y `_lockedAmount[keyId] + amount <= escrowBalance(keyId)`, THE
    system SHALL fijar `_lockedAmount[keyId] += amount` y emitir `DisputeLocked`; IF
    `_lockedAmount[keyId] + amount > escrowBalance(keyId)` THEN revertir `InsufficientBalance`.
11. **AC-11** (withdraw respeta el lock): WHILE `_lockedAmount[keyId] > 0`, THE system SHALL
    permitir `withdraw(keyId, amount)` sólo si `amount <= escrowBalance(keyId) - _lockedAmount[keyId]`;
    en caso contrario revertir `InsufficientBalance` — sin cambiar el código de `withdraw` (ya resta
    `_lockedAmount`).
12. **AC-12** (residual liberado / release): WHEN `resolveDispute` completa, THE system SHALL
    dejar `_lockedAmount[keyId] == 0` y el residual `(escrowBalance previo - sellerAmount)`
    disponible para el `withdraw` del depositante; WHEN el árbitro llama `releaseDispute(keyId)` (buyer
    gana, sin pago), THE system SHALL poner `_lockedAmount[keyId] = 0` y emitir `DisputeReleased`.
13. **AC-13** (consentimiento monotónico): IF el depositante llama `setArbitrationConsent(keyId,
    false)` (intento de revocación), THEN THE system SHALL revertir `ConsentIrrevocable`; IF un no-
    depositante llama `setArbitrationConsent` THEN revertir `Unauthorized`; una segunda llamada
    `(keyId, true)` es idempotente (no-op, sin evento).

## 3. Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `contracts/src/WasiAIEscrow.sol` (completo) | contrato a modificar | storage order `:47-59`; `_lockedAmount` `:54` ya presente sin uso; `setOperator` `:92-98` (espejo de `setArbiter`); `_verifyAndConsume` CEI `:121-141` (nonce+balance antes del transfer); `debit` `onlyOperator` `:148-156`; `withdraw` `:188-194` ya resta `_lockedAmount`; UUPS/timelock `:196-234` |
| `contracts/src/interfaces/IWasiAIEscrow.sol` | ABI espejada byte-a-byte con `abi.ts` (191g) | orden de events con `indexed` `:9-19`; errores `:22-39`; funciones `:42-63`; agregar los nuevos acá |
| `contracts/test/WasiAIEscrow.t.sol` | tests unit a extender | helpers `_domainSeparator`/`_signDebit`/`_deposit` `:48-70`; `setUp` con proxy+MockUSDC `:31-45`; patrón `vm.expectRevert(IWasiAIEscrow.X.selector)` + `vm.expectEmit`; `test_SetOperator_*` `:394-425` = plantilla de `setArbiter` |
| `contracts/test/WasiAIEscrow.invariant.t.sol` | invariante conservación + hostile a extender | `EscrowHandler` single-depositor; ghosts `ghost_totalDeposited/Debited/Withdrawn` `:30-33`; witnesses `ghost_hostileAttempts/Reverts` `:35-38`; identidad `invariant_operatorCannotDrainWithoutSig` `:212-216`; `invariant_hostilePathAlwaysReverts` `:221-223`; patrón `try/catch`+contador en handlers hostiles `:121-174` |
| `contracts/test/WasiAIEscrow.invariant2.t.sol` | suite multi-tenant a extender | `EscrowHandler2` 3 depositantes disjuntos; `ghost_keyBalance` mirror `:59`; `usedAuths` replay ledger `:65-73`; `rotateOperator` legit `:245-251`; hostiles `:253-414`; invariantes `invariant_conservation`/`invariant_perKeyBalanceMirror`/`invariant_accessControlAlwaysReverts`/`invariant_noReplay`/`invariant_noUnderflow` `:441-497` |
| `contracts/script/Deploy.s.sol` (grep) | confirmar Scope OUT | sólo llama `initialize` (`:21`); no llama `setOperator`/`setArbiter` → 191f no lo toca; `setArbiter` post-upgrade = 191h |
| `doc/sdd/177-.../work-item.md` | input | DT-1..DT-5, CD-1..CD-7, ACs, hallazgo del withdraw-race |

### Exemplars verificados (paths confirmados con Read)

| Para crear/modificar | Seguir patrón de | Razón |
|---------------------|------------------|-------|
| `setArbiter` + `arbiter()` + `ArbiterUpdated` | `setOperator`/`operator()`/`OperatorUpdated` (`WasiAIEscrow.sol:87-98`) | espejo exacto: guard zero-address, cachear old, emitir, getter view |
| `onlyArbiter` modifier | inline `if (msg.sender != _operator) revert NotOperator();` (`:152`) | mismo estilo de gate; se factoriza como modifier reusable por 3 fns |
| `resolveDispute` (checks+CEI+transfer) | `_verifyAndConsume` + `debit` (`:121-156`) | nonce+balance ANTES del `safeTransfer`; `nonReentrant`; `SafeERC20`; `Debited`→`DisputeResolved` |
| lock respetado por withdraw | `withdraw` (`:188-194`) YA resta `_lockedAmount` | activar `_lockedAmount` NO requiere tocar `withdraw` (CD-7 intacto) |
| tests `setArbiter` | `test_SetOperator_byOwner_rotates_emitsEvent` (`:394-413`) + `test_RevertWhen_SetOperator_*` (`:415-425`) | copia directa cambiando operator→arbiter |
| handlers invariantes árbitro | `debitByOperator` (legit) + `operatorDrainAttempt`/`botFrontRunAttempt` (hostile) (`invariant.t.sol:104-160`) | mismo patrón ghost + `try/catch`+contador |

### Estado de storage relevante

| Variable | Slot lógico (post-inherited) | Cambia | Nota |
|----------|------------------------------|--------|------|
| `_usdc` … `_operator` | `:48-57` | NO | orden estable |
| `_lockedAmount` | `:54` | NO (se ACTIVA su uso) | ya existe, hoy siempre 0 |
| `_usedNonces` | `:55` | NO (se REUSA namespace) | anti-replay de `resolveDispute` sin storage nuevo |
| `_arbiter` (nuevo) | primer slot de `__gap` | NUEVO | address |
| `_arbitrationConsent` (nuevo) | segundo slot de `__gap` | NUEVO | mapping `bytes32=>bool` |
| `__gap` | `:59` | 43 → 41 | `-2` por las 2 vars nuevas |

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Qué hacer | Exemplar |
|---------|--------|-----------|----------|
| `contracts/src/WasiAIEscrow.sol` | Modificar | storage nuevo + `setArbiter`/`arbiter()`/`onlyArbiter`, `setArbitrationConsent`/`arbitrationConsent()`, `lockForDispute`/`lockedAmount()`/`releaseDispute`, `resolveDispute`; eventos/errores | `setOperator` `:92-98`, `_verifyAndConsume`/`debit` `:121-156` |
| `contracts/src/interfaces/IWasiAIEscrow.sol` | Modificar | agregar eventos, errores y firmas nuevas | `:9-63` |
| `contracts/test/WasiAIEscrow.t.sol` | Modificar | unit tests de las 8 funciones nuevas (happy + cada revert + lock + residual + re-entrancy) | `test_SetOperator_*`, `test_Debit_*`, `test_Withdraw_*` |
| `contracts/test/WasiAIEscrow.invariant.t.sol` | Modificar | actor árbitro + handlers legit/hostiles + `ghost_totalArbiterResolved` en la identidad | `EscrowHandler` `:13-175` |
| `contracts/test/WasiAIEscrow.invariant2.t.sol` | Modificar | idem multi-tenant + mirror + `invariant_lockNeverExceedsBalance` | `EscrowHandler2` `:30-415` |
| `contracts/test/mocks/ReentrantUSDC.sol` | Crear (opcional, si el test de re-entrancy lo requiere) | ERC20 mock que re-entra `resolveDispute` en el `transfer` | `contracts/test/mocks/MockUSDC.sol` |

### 4.2 Storage layout exacto (CD-1, AC-7)

Bloque de storage resultante (sólo se muestra el tramo que cambia — de `_operator` a `__gap`):

```solidity
    address internal _operator;                                   // :57 — sin cambios

    // ── 191f: arbiter role + consent (consumen 2 slots de __gap; CD-1) ────────
    address internal _arbiter;                                     // NUEVO — slot 1 (was __gap[0])
    mapping(bytes32 => bool) internal _arbitrationConsent;         // NUEVO — slot 2 (was __gap[1])

    uint256[41] private __gap; // was 43; -2 for _arbiter + _arbitrationConsent (191f, CD-1)
```

Reglas del layout (inviolables):
- Las 2 variables nuevas van **inmediatamente después de `_operator`** y **antes de `__gap`**, en
  ese orden (`_arbiter` primero, `_arbitrationConsent` segundo). NUNCA reordenar variables
  preexistentes ni insertar entre ellas.
- `__gap` pasa de `uint256[43]` a `uint256[41]` (−2). Ningún otro cambio de tamaño.
- `_lockedAmount` (`:54`) NO es storage nuevo — ya existe; sólo se activa su uso. `_usedNonces`
  (`:55`) se REUSA para el anti-replay de `resolveDispute`. Cero slots nuevos para ambos.
- `initialize()` permanece **byte-idéntico**: `_arbiter` queda en `address(0)` por default y
  `_arbitrationConsent` vacío. Sin `reinitializer` (DT-4). El owner activa el árbitro con
  `setArbiter()` en una tx separada post-upgrade (=191h).
- Efecto de arranque seguro: con `_arbiter == address(0)`, `onlyArbiter` revierte siempre
  (`msg.sender` nunca es `address(0)`), así que `lockForDispute`/`resolveDispute`/`releaseDispute`
  están inertes hasta que el owner setee el árbitro.

### 4.3 Funciones nuevas (diseño — sin código de producción; snippets de referencia)

**`arbiter()` / `setArbiter()` / `onlyArbiter` (W0)** — espejo de operator:

```solidity
function arbiter() external view returns (address) { return _arbiter; }

function setArbiter(address newArbiter) external onlyOwner {
    if (newArbiter == address(0)) revert ZeroAddress();
    address old = _arbiter;
    _arbiter = newArbiter;
    emit ArbiterUpdated(old, newArbiter);
}

modifier onlyArbiter() {
    if (msg.sender != _arbiter) revert NotArbiter(); // AC-4
    _;
}
```

**`arbitrationConsent()` / `setArbitrationConsent()` (W0)** — opt-in monotónico (AC-1, AC-13):

```solidity
function arbitrationConsent(bytes32 keyId) external view returns (bool) {
    return _arbitrationConsent[keyId];
}

function setArbitrationConsent(bytes32 keyId, bool consent) external {
    if (msg.sender != _depositor[keyId]) revert Unauthorized();      // sólo el depositante; keyId sin deposito ⇒ _depositor==0 ⇒ revert
    if (!consent) revert ConsentIrrevocable();                       // monotónico: nunca se puede poner en false
    if (_arbitrationConsent[keyId]) return;                          // idempotente true→true (no-op, sin evento)
    _arbitrationConsent[keyId] = true;
    emit ArbitrationConsentSet(keyId, msg.sender);
}
```

Decisión de diseño (resuelve el `[NEEDS CLARIFICATION]` del work-item, ver §11): el intento de
revocación (`consent=false`) **revierte** `ConsentIrrevocable` (no es no-op silencioso). Motivo:
un revert es self-documenting — un front-end que intente "apagar" el consentimiento recibe señal
explícita de que es imposible (anti-griefing DT-2). La invariante queda cristalina: *"el
consentimiento nunca puede pasar a false por esta función"*.

**`lockedAmount()` / `lockForDispute()` (W1)** — congela el monto disputado (AC-10, AC-2, AC-4):

```solidity
function lockedAmount(bytes32 keyId) external view returns (uint256) {
    return _lockedAmount[keyId];
}

function lockForDispute(bytes32 keyId, uint256 amount) external onlyArbiter {
    if (!_arbitrationConsent[keyId]) revert ArbitrationNotConsented(); // CD-2: sin consentimiento el árbitro no toca (ni congela)
    if (amount == 0) revert ZeroAmount();
    uint256 newLocked = _lockedAmount[keyId] + amount;
    if (newLocked > _balances[keyId]) revert InsufficientBalance();    // el lock nunca excede el balance ⇒ withdraw no underflowea
    _lockedAmount[keyId] = newLocked;                                  // incremental (soporta top-up de la misma disputa)
    emit DisputeLocked(keyId, msg.sender, amount, newLocked);
}
```

`withdraw` NO se modifica: ya calcula `available = _balances[keyId] - _lockedAmount[keyId]`
(`:190`). Al activarse el lock, un buyer con disputa abierta sólo puede retirar `balance - locked`
(AC-11). Como `lockForDispute` mantiene `_lockedAmount <= _balances`, la resta nunca underflowea.

**`releaseDispute()` (W1)** — cierra disputa sin pago (buyer gana; AC-12):

```solidity
function releaseDispute(bytes32 keyId) external onlyArbiter {
    uint256 locked = _lockedAmount[keyId];
    if (locked == 0) revert ZeroAmount();     // nada que liberar
    _lockedAmount[keyId] = 0;                  // el residual completo vuelve a estar disponible para withdraw
    emit DisputeReleased(keyId, msg.sender, locked);
}
```

No requiere consentimiento adicional ni nonce: sólo desbloquea fondos a favor del buyer (movimiento
estrictamente favorable al depositante, no hay transfer externo → no `nonReentrant`).

**`resolveDispute()` (W2)** — paga al seller de lo lockeado (AC-3, AC-5, AC-6, AC-12):

```solidity
function resolveDispute(bytes32 keyId, address seller, uint256 sellerAmount, uint256 nonce)
    external
    onlyArbiter                                                     // AC-4
    nonReentrant                                                   // CD-3
{
    // ── Checks ────────────────────────────────────────────────────────────
    if (!_arbitrationConsent[keyId]) revert ArbitrationNotConsented(); // CD-2 (AC-2)
    if (seller == address(0)) revert ZeroAddress();
    if (sellerAmount == 0) revert ZeroAmount();                        // §11: refund-total usa withdraw, no resolveDispute
    if (_usedNonces[keyId][nonce]) revert NonceAlreadyUsed();          // CD-4 (AC-5) — reusa el mapping
    uint256 locked = _lockedAmount[keyId];
    if (sellerAmount > locked) revert ExceedsLockedAmount();           // sólo paga de lo DISPUTADO (AC-3)
    uint256 bal = _balances[keyId];
    if (sellerAmount > bal) revert InsufficientBalance();              // defensa en profundidad (AC-6)
    // ── Effects (CEI: todo ANTES del transfer) ───────────────────────────
    _usedNonces[keyId][nonce] = true;                                 // exactly-once (irrevocable)
    _balances[keyId] = bal - sellerAmount;
    _lockedAmount[keyId] = 0;                                          // libera el residual (locked - sellerAmount) al buyer (AC-12)
    // ── Interactions ─────────────────────────────────────────────────────
    _usdc.safeTransfer(seller, sellerAmount);                         // paga al SELLER (no a msg.sender, a diferencia de debit)
    emit DisputeResolved(keyId, msg.sender, seller, sellerAmount, nonce);
}
```

Diferencia clave vs `debit`: `debit` paga a `msg.sender` (el operator); `resolveDispute` paga al
`seller` (parámetro). Ése es exactamente el camino que 191f habilita.

### 4.4 Mecanismo lock ↔ resolveDispute (invariante de solvencia del lock)

Invariante mantenida en TODO momento: **`_lockedAmount[keyId] <= _balances[keyId]`**.

Análisis por camino que decrementa `_balances`:
- `withdraw`: retira `amount <= balance - locked` ⇒ `balance' = balance - amount >= locked`. Preserva. ✓
- `resolveDispute`: `balance' = balance - sellerAmount`, `locked' = 0 <= balance'`. Preserva. ✓
- `releaseDispute`: no toca balance, `locked' = 0`. Preserva. ✓
- `debit`/`debitBatch`: decrementan `_balances` con guard `amount <= balance` (NO `balance - locked`).
  **Único camino que teóricamente podría romper la invariante** si el árbitro lockea y luego el
  operator settlea un `debit` firmado por el depositante sobre el mismo `keyId` (ver Riesgos R-1).
  El diseño lo mitiga a 3 niveles: (a) operacional — el operator (honesto, único, coordinado con la
  app) no settlea `debit` sobre un `keyId` en `arb_hold`; (b) económico — un `debit` paga al
  **operator** (parte honesta), no al buyer, así que el buyer no puede escapar el lock por esta vía;
  (c) fail-closed on-chain — si aun así `balance < locked`, `withdraw` revierte (resta underflowea)
  y `resolveDispute` revierte por `sellerAmount > bal` (`InsufficientBalance`): NUNCA hay pérdida de
  fondos, sólo un DoS auto-infligido. CD-7 prohíbe tocar `debit`, así que la mitigación NO modifica
  `debit`; se documenta como riesgo aceptado (R-1) y se cubre con el guard `sellerAmount > bal`.

Modelo de disputa asumido (documentado): **una disputa activa por `keyId` a la vez** (un `keyId` en
disputa está en `arb_hold` app-side, WKH-189). `lockForDispute` incrementa para soportar top-up de
esa única disputa; `resolveDispute`/`releaseDispute` ponen `_lockedAmount = 0` liberando el residual
completo. Disputas concurrentes sobre el mismo `keyId` quedan fuera de alcance (la máquina de estados
app-side las serializa).

### 4.5 Eventos y errores nuevos (interfaz)

**Eventos** (agregar a `IWasiAIEscrow`, CD-6):

```solidity
event ArbiterUpdated(address indexed oldArbiter, address indexed newArbiter);
event ArbitrationConsentSet(bytes32 indexed keyId, address indexed depositor);
event DisputeLocked(bytes32 indexed keyId, address indexed arbiter, uint256 amount, uint256 totalLocked);
event DisputeResolved(bytes32 indexed keyId, address indexed arbiter, address indexed seller, uint256 sellerAmount, uint256 nonce);
event DisputeReleased(bytes32 indexed keyId, address indexed arbiter, uint256 releasedAmount);
```

`DisputeResolved` usa los 3 slots `indexed` (keyId, arbiter, seller); `sellerAmount` y `nonce` van
en data. Mismo patrón de auditabilidad que `Debited`.

**Errores** (agregar a `IWasiAIEscrow`):

```solidity
error NotArbiter();               // AC-4
error ArbitrationNotConsented();  // AC-2 / CD-2
error ConsentIrrevocable();       // AC-13 (monotónico)
error ExceedsLockedAmount();      // AC-3 (sólo paga de lo lockeado)
```

Se REUSAN: `ZeroAmount`, `ZeroAddress`, `InsufficientBalance`, `NonceAlreadyUsed`, `Unauthorized`.

**Firmas** (agregar a `IWasiAIEscrow`):

```solidity
function arbiter() external view returns (address);
function setArbiter(address newArbiter) external;
function arbitrationConsent(bytes32 keyId) external view returns (bool);
function setArbitrationConsent(bytes32 keyId, bool consent) external;
function lockedAmount(bytes32 keyId) external view returns (uint256);
function lockForDispute(bytes32 keyId, uint256 amount) external;
function resolveDispute(bytes32 keyId, address seller, uint256 sellerAmount, uint256 nonce) external;
function releaseDispute(bytes32 keyId) external;
```

### 4.6 Flujo principal (happy path — disputa a favor del seller)

1. Buyer deposita en `keyId` (`deposit`, sin cambios). El depositante llama
   `setArbitrationConsent(keyId, true)` → `_arbitrationConsent[keyId]=true`, evento.
2. (Post-upgrade, 191h) owner ya llamó `setArbiter(arbAddr)`.
3. Surge una disputa. El árbitro llama `lockForDispute(keyId, disputed)` →
   `_lockedAmount[keyId]=disputed`, evento. El buyer ya no puede `withdraw` esos fondos.
4. El árbitro resuelve a favor del seller: `resolveDispute(keyId, seller, sellerAmount<=disputed,
   nonce)` → transfiere `sellerAmount` al seller, `_balances -= sellerAmount`, `_lockedAmount=0`,
   nonce consumido, evento `DisputeResolved`.
5. Estado final: seller cobró; el buyer puede `withdraw` el residual (`balance - sellerAmount`).

### 4.7 Flujo de error / bordes

1. Árbitro no configurado (`_arbiter==0`) → cualquier `lock/resolve/release` revierte `NotArbiter`.
2. `keyId` sin consentimiento → `lockForDispute`/`resolveDispute` revierten `ArbitrationNotConsented`.
3. Non-arbiter llama → `NotArbiter`.
4. `sellerAmount > locked` → `ExceedsLockedAmount`. `sellerAmount==0` → `ZeroAmount`. `seller==0` →
   `ZeroAddress`. `sellerAmount > balance` → `InsufficientBalance`.
5. Replay `(keyId,nonce)` → `NonceAlreadyUsed`.
6. Depositante intenta revocar consentimiento → `ConsentIrrevocable`. No-depositante consiente →
   `Unauthorized`.
7. Buyer gana: `releaseDispute(keyId)` → lock a 0, buyer retira todo.

## 5. Constraint Directives (Anti-Alucinación)

Heredados del work-item (CD-1..CD-7) + los del orquestador. Todos van al Story File (F2.5).

### OBLIGATORIO seguir
- **CD-1**: storage UUPS-safe — `_arbiter` + `_arbitrationConsent` inmediatamente después de
  `_operator`, en ese orden, `__gap[43]→[41]`; `initialize()` byte-idéntico; sin `reinitializer`.
- **CD-2**: `resolveDispute` y `lockForDispute` requieren **ambos** `msg.sender==_arbiter`
  (`NotArbiter`) **Y** `_arbitrationConsent[keyId]==true` (`ArbitrationNotConsented`). Ningún atajo.
- **CD-3**: `resolveDispute` con `nonReentrant`, `SafeERC20`, CEI estricto (marcar nonce + decrementar
  `_balances` + poner `_lockedAmount=0` ANTES del `safeTransfer`) — patrón de `debit`/`_verifyAndConsume`.
- **CD-4**: exactly-once vía `_usedNonces[keyId][nonce]` (reuso del mapping existente); replay revierte
  `NonceAlreadyUsed`.
- **CD-5**: NO relajar/debilitar ninguna invariante Foundry preexistente
  (`operatorCannotDrainWithoutSig`, `hostilePathAlwaysReverts`, `invariant_solvency*`,
  `invariant_conservation`, `invariant_perKeyBalanceMirror`, `invariant_accessControlAlwaysReverts`,
  `invariant_noReplay`, `invariant_noUnderflow`) — EXTENDER con `ghost_totalArbiterResolved` +
  witnesses hostiles nuevos.
- **CD-6**: eventos auditables nuevos (§4.5) exactamente con esos nombres/`indexed`.
- **CD-8** (nuevo, lock-solvency): mantener la invariante `_lockedAmount[keyId] <= _balances[keyId]`
  en todo camino que modifique lock o balance; `lockForDispute` valida `newLocked <= balance`;
  `resolveDispute` valida `sellerAmount <= locked` Y `sellerAmount <= balance`.
- **CD-9** (nuevo, non-custodial): el árbitro SOLO congela/paga fondos **lockeados** de `keyIds`
  **consentidos**; NUNCA fondos no disputados ni sin consentimiento. `resolveDispute` paga al
  `seller` (param), no a `msg.sender`.
- **CD-10** (nuevo, Foundry): los tests deben pasar `forge test`; usar `MockUSDC` existente; el actor
  árbitro se configura con `escrow.setArbiter(...)` (owner) en `setUp`.

### PROHIBIDO
- **CD-7**: NO modificar lógica/firma/gas-path de `deposit`/`debit`/`debitBatch`/`withdraw` salvo el
  cambio de storage-layout. `withdraw` ya resta `_lockedAmount` — activar el lock NO requiere tocarlo.
- NO usar `reinitializer` ni setear `_arbiter` en `initialize` (DT-4).
- NO agregar librerías/imports nuevos fuera de los ya presentes (`SafeERC20`, OZ upgradeable).
- NO reordenar/redimensionar variables de storage preexistentes ni `__gap` fuera del `-2`.
- NO tocar `Deploy.s.sol`, `src/adapters/escrow/*`, `src/services/arbiter.ts` (191g/191h).
- NO hacer que `resolveDispute` pueda pagar más que `_lockedAmount[keyId]` (no fondos no disputados).
- NO permitir revocación de consentimiento (monotónico).

## 6. Waves de Implementación

### Wave 0 (Serial Gate — storage + rol + consentimiento)
- W0.1: storage nuevo (`_arbiter`, `_arbitrationConsent`, `__gap 43→41`) + comentario CD-1.
- W0.2: `arbiter()`, `setArbiter()`, modifier `onlyArbiter`, evento `ArbiterUpdated`, error `NotArbiter`.
- W0.3: `arbitrationConsent()`, `setArbitrationConsent()` (monotónico), evento `ArbitrationConsentSet`,
  errores `ConsentIrrevocable` (reusa `Unauthorized`).
- W0.4: sincronizar `IWasiAIEscrow` con lo de W0.
- Verificación: `forge build` compila; suite existente sigue verde (`forge test`).

### Wave 1 (Lock — depende de W0)
- W1.1: `lockedAmount()`, `lockForDispute()` (onlyArbiter + consent + `newLocked<=balance`), evento
  `DisputeLocked`.
- W1.2: `releaseDispute()`, evento `DisputeReleased`.
- W1.3: confirmar (sin cambiar código) que `withdraw` respeta el lock; sincronizar interfaz.
- Verificación: `forge build` + tests de W0 verdes.

### Wave 2 (resolveDispute — depende de W1)
- W2.1: `resolveDispute()` (checks CD-2/CD-3/CD-4/CD-8, CEI, `SafeERC20`), evento `DisputeResolved`,
  error `ExceedsLockedAmount`, `ArbitrationNotConsented`.
- W2.2: sincronizar interfaz (firmas + eventos + errores finales).
- Verificación: `forge build`.

### Wave 3 (Tests + invariantes — depende de W2)
- W3.1: unit tests en `WasiAIEscrow.t.sol` (ver §7).
- W3.2: extender `WasiAIEscrow.invariant.t.sol` (actor árbitro + legit + hostiles +
  `ghost_totalArbiterResolved` en `invariant_operatorCannotDrainWithoutSig`).
- W3.3: extender `WasiAIEscrow.invariant2.t.sol` (idem + `ghost_keyBalance -= sellerAmount` en el
  mirror + término en `invariant_conservation` + `invariant_lockNeverExceedsBalance` nuevo).
- W3.4 (opcional): `ReentrantUSDC` mock si el test de re-entrancy lo requiere.
- Verificación: `forge test` completo verde (unit + invariantes viejas + nuevas).

## 7. Test Plan (Foundry)

### Unit (`contracts/test/WasiAIEscrow.t.sol`)

| Test | AC | Descripción |
|------|----|-------------|
| `test_SetArbiter_byOwner_rotates_emitsEvent` | AC-8 | owner setea, getter, `ArbiterUpdated` |
| `test_RevertWhen_SetArbiter_byNonOwner` | AC-8 | `OwnableUnauthorizedAccount` |
| `test_RevertWhen_SetArbiter_zeroAddress` | AC-8 | `ZeroAddress` |
| `test_SetArbitrationConsent_byDepositor_persists_emitsEvent` | AC-1 | consent true, getter, evento |
| `test_RevertWhen_Consent_byNonDepositor` | AC-13 | `Unauthorized` |
| `test_RevertWhen_Consent_revoke` | AC-13 | `setArbitrationConsent(key,false)` → `ConsentIrrevocable` |
| `test_Consent_idempotent_trueTwice_noEvent` | AC-13 | 2ª llamada true = no-op |
| `test_LockForDispute_byArbiter_locks_emitsEvent` | AC-10 | lock, getter, `DisputeLocked` |
| `test_RevertWhen_Lock_byNonArbiter` | AC-4 | `NotArbiter` |
| `test_RevertWhen_Lock_withoutConsent` | AC-2 | `ArbitrationNotConsented` |
| `test_RevertWhen_Lock_exceedsBalance` | AC-10 | `InsufficientBalance` |
| `test_RevertWhen_Lock_zeroAmount` | AC-10 | `ZeroAmount` |
| `test_Withdraw_blockedByLock` | AC-11 | deposit 100, lock 60, withdraw 41 revierte; 40 ok |
| `test_ResolveDispute_happy_paysSeller_zeroesLock` | AC-3, AC-12 | seller cobra `sellerAmount`, balance−, lock 0, nonce consumido, evento |
| `test_ResolveDispute_residual_withdrawableByBuyer` | AC-12 | tras resolve, buyer retira `balance-sellerAmount` |
| `test_RevertWhen_Resolve_byNonArbiter` | AC-4 | `NotArbiter` (incluso con consent) |
| `test_RevertWhen_Resolve_withoutConsent` | AC-2 | `ArbitrationNotConsented` |
| `test_RevertWhen_Resolve_overLocked` | AC-3 | `sellerAmount>locked` → `ExceedsLockedAmount` |
| `test_RevertWhen_Resolve_exceedsBalance` | AC-6 | `InsufficientBalance` (edge lock≈balance) |
| `test_RevertWhen_Resolve_zeroSellerAmount` | §11 | `ZeroAmount` |
| `test_RevertWhen_Resolve_zeroSeller` | AC-3 | `ZeroAddress` |
| `test_RevertWhen_Resolve_nonceReplay` | AC-5 | 2ª llamada `(keyId,nonce)` → `NonceAlreadyUsed` |
| `test_ReleaseDispute_buyerWins_unlocks` | AC-12 | lock→0, buyer retira todo, `DisputeReleased` |
| `test_RevertWhen_Release_byNonArbiter` | AC-4 | `NotArbiter` |
| `test_ResolveDispute_reentrancy_guarded` | CD-3 | `ReentrantUSDC` re-entra `resolveDispute`; revierte (nonReentrant/NonceAlreadyUsed), fondos intactos |

### Invariantes (`invariant.t.sol` + `invariant2.t.sol`)

Handlers **legítimos** nuevos (actualizan ghosts):
- `consentByDepositor(seed)` — el depositante opta in (crea keys consentidas).
- `lockByArbiter(seed, amount)` — árbitro lockea `amount <= balance` sobre key consentida;
  `ghost_keyLocked[k] += amount`.
- `resolveByArbiter(seed, sellerAmount)` — árbitro paga `sellerAmount <= locked` a un seller;
  `ghost_totalArbiterResolved += sellerAmount`, `ghost_keyBalance[k] -= sellerAmount`,
  `ghost_keyLocked[k] = 0`; push a `usedAuths` para replay.
- `releaseByArbiter(seed)` — árbitro libera; `ghost_keyLocked[k] = 0`.

Handlers **hostiles** nuevos (`try/catch` + `ghost_hostileAttempts++/ghost_hostileReverts++`):
- `resolveByNonArbiter` — bot llama `resolveDispute` sobre key consentida+lockeada → revert `NotArbiter`.
- `resolveWithoutConsent` — árbitro llama sobre key SIN consent → revert `ArbitrationNotConsented`.
- `resolveOverLocked` — árbitro con `sellerAmount>locked` → revert `ExceedsLockedAmount`.
- `resolveReplay` — replay de `(keyId,nonce)` consumido → revert `NonceAlreadyUsed`.
- `lockByNonArbiter` — bot llama `lockForDispute` → revert `NotArbiter`.
- `withdrawOverLock` — depositante intenta `withdraw > balance-locked` sobre key lockeada → revert
  `InsufficientBalance` (prueba que el lock bloquea el withdraw).

Invariantes **extendidas** (NO reemplazadas):
- `invariant_operatorCannotDrainWithoutSig` (invariant.t.sol) e `invariant_conservation`
  (invariant2.t.sol): identidad pasa a `escrowUSDC == deposited - debited - withdrawn -
  arbiterResolved` (nuevo término `ghost_totalArbiterResolved`).
- `invariant_perKeyBalanceMirror`: el mirror por-key descuenta también `sellerAmount` en resolve.
- `invariant_solvency*`: sigue como `balanceOf(escrow) >= sum(escrowBalance)` — el resolve reduce
  ambos lados en `sellerAmount`, GE se mantiene.
- `invariant_hostilePathAlwaysReverts` / `invariant_accessControlAlwaysReverts`: mismos asserts
  (`attempts==reverts`), ahora cubren también los handlers hostiles del árbitro.
- `invariant_noReplay`: el `resolveReplay` alimenta `ghost_replayAttempts/Reverts`.

Invariante **nueva**:
- `invariant_lockNeverExceedsBalance`: para toda key trackeada, `lockedAmount(k) <= escrowBalance(k)`
  (solvencia del lock; garantiza que `withdraw` nunca underflowea).

Wiring: en `setUp` de ambas suites, tras deploy, `vm.prank(owner); escrow.setArbiter(ARBITER);` con
`ARBITER` constante nuevo. El árbitro NO tiene la pk de ningún depositante (no puede firmar debits).

## 8. Riesgos

| # | Riesgo | Prob | Impacto | Mitigación |
|---|--------|------|---------|------------|
| R-1 | `debit` firmado por el depositante reduce `_balances` bajo `_lockedAmount` en una key en disputa → `withdraw` underflowea (DoS) | B | M | Operacional (operator no settlea keys en `arb_hold`) + económico (debit paga al operator honesto, no al buyer) + fail-closed (`resolveDispute` guard `sellerAmount<=bal`; withdraw revierte, sin pérdida de fondos). Documentado; CD-7 impide tocar `debit` |
| R-2 | Layout de storage mal aplicado rompe el upgrade UUPS | B | A | CD-1 explícito + AC-7 + revisión AR/CR del diff de storage; `__gap` −2 exacto; sin `reinitializer` |
| R-3 | `resolveDispute` paga fondos no disputados | B | A | CD-9 + `sellerAmount<=_lockedAmount` (`ExceedsLockedAmount`) + invariante `lockNeverExceedsBalance` + witness hostil |
| R-4 | Re-entrancy en el transfer al seller | B | A | `nonReentrant` + CEI (nonce/balance/lock antes del transfer) + test `ReentrantUSDC` |
| R-5 | Consentimiento revocado para griefear al árbitro | B | M | Monotónico/irrevocable (`ConsentIrrevocable`) — DT-2 |
| R-6 | Invariante existente se rompe al agregar el leg del árbitro | M | M | Agregar `ghost_totalArbiterResolved` a las identidades ANTES de correr (W3); CD-5 |
| R-7 | USDC Circle-pausable congela fondos | B | A | Riesgo externo aceptado preexistente (Audit C MNR-1), sin cambio |

## 9. Dependencias

- DONE (sin cambios): WKH-126a (`WasiAIEscrow.sol` base), WKH-139 v2 (árbitro app-side), WKH-189
  (panel `arb_hold`). El árbitro sigue operando 100% sobre `budget` off-chain hasta 191g.
- Foundry (`forge`) instalado; `MockUSDC` en `contracts/test/mocks/`.
- Bloquea: 191g (wire `arbiter.ts`→on-chain) y 191h (deploy/upgrade + smoke E2E).

## 10. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| — | — | Sin `[NEEDS CLARIFICATION]` pendientes: los 3 abiertos del work-item fueron resueltos por el orquestador (§11) | No |

## 11. Resolución de los Missing Inputs del work-item

| Missing Input (work-item) | Resolución (orquestador, este SDD) |
|---------------------------|------------------------------------|
| Mecanismo de consentimiento (DT-1/DT-2) | Confirmado: función dedicada `setArbitrationConsent` callable sólo por el depositante, **monotónico/irrevocable**; revocación → revert `ConsentIrrevocable` |
| DT-5 — ¿lock dentro de 191f o diferido? | **ENTRA a 191f**: se activa `_lockedAmount` vía `lockForDispute`/`releaseDispute` (onlyArbiter+consent); `withdraw` ya lo respeta; cierra el withdraw-race |
| `sellerAmount == 0` en `resolveDispute` | **Revierte `ZeroAmount`** — refund-total usa el `withdraw` normal, no `resolveDispute` |
| Nombres finales de fn/evento/error | Fijados en §4.5 |

## 12. Auto-Blindaje histórico (aprendizaje del pasado)

Se revisaron los auto-blindaje recientes (WKH-189, WKH-159, WKH-144, WKH-150, WKH-143). Los
patrones recurrentes documentados son **app-layer TypeScript/Fastify/biome** (casts de embeds
PostgREST, generics de rutas Fastify, `biome format`, rango de inputs de admin antes del clamp
money-path) — **no aplican** a esta HU (Solidity/Foundry, sin TS ni Supabase). El único patrón
transversal relevante es de WKH-189 FIX-PACK: *"validar el RANGO de inputs de admin ANTES del clamp
money-path; el clamp es defensa en profundidad, no la primera baranda"*. Se honra en `resolveDispute`
(valida `sellerAmount<=locked` y `sellerAmount<=balance` como checks primarios, no como clamp
silencioso) y en `lockForDispute` (`newLocked<=balance` explícito). Sin patrón de error Solidity
recurrente en el histórico → no se agregan CD adicionales por esta vía.

---

## Readiness Check

```
[x] Cada AC tiene ≥1 archivo asociado (tabla §4.1) y ≥1 test (§7)
[x] Cada archivo en §4.1 tiene Exemplar verificado con Read (§3)
[x] No hay [NEEDS CLARIFICATION] pendientes (§10, §11)
[x] Constraint Directives incluyen ≥3 PROHIBIDO (§5)
[x] Context Map tiene ≥2 archivos leídos (§3: 7 archivos)
[x] Scope IN y OUT explícitos (§2)
[x] Storage/BD: layout UUPS verificado contra WasiAIEscrow.sol:47-59 (§4.2)
[x] Flujo principal (happy path) completo (§4.6)
[x] Flujo de error definido (§4.7, ≥7 casos)
[x] Invariantes: plan de extensión sin relajar las 8 existentes (§7, CD-5)
[x] Waves con verificación incremental por wave (§6)
```

SDD LISTO para GATE 2 (SPEC_APPROVED).

---

*SDD generado por NexusAgil — FULL — Architect F2*
