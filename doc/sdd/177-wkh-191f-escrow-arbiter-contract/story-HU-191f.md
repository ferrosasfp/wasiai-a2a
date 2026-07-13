# Story File — #191f: Contrato — rol árbitro dedicado + `resolveDispute` + lock on-chain (upgrade UUPS)

> SDD: doc/sdd/177-wkh-191f-escrow-arbiter-contract/sdd.md
> Fecha: 2026-07-13
> Branch: feat/191f-escrow-arbiter-contract
> Epic: WKH-191 (Wave 1, HU 6/8) — **testnet-only**
> Stack: Solidity 0.8.24 + Foundry (`forge`) + OpenZeppelin upgradeable (UUPS)

---

## Goal

`WasiAIEscrow.sol` hoy NO puede mover fondos de un `keyId` sin la firma EIP-712 del `_depositor`.
En una disputa real el buyer (depositante) por definición NO firma para pagarle al seller — ésa ES
la disputa — así que el árbitro autónomo necesita autoridad propia de contrato. Esta HU agrega, vía
**código nuevo para un upgrade UUPS** (el deploy/upgrade on-chain es la HU 191h, fuera de scope):
un rol `_arbiter` dedicado (rotable por el owner), un **consentimiento opt-in monotónico/irrevocable**
por el propio depositante, un **lock on-chain** (`lockForDispute`/`releaseDispute`) que activa el
primitivo `_lockedAmount[keyId]` ya presente en storage, y `resolveDispute` (el árbitro paga al
seller SÓLO de lo lockeado, con consentimiento, anti-replay por nonce, CEI + `nonReentrant` +
`SafeERC20`). Garantía non-custodial preservada: el árbitro sólo toca fondos **lockeados** de
`keyIds` **consentidos**; nunca depósitos sin disputa/consentimiento.

---

## Acceptance Criteria (EARS)

> Copiados del SDD aprobado (§2). QA los verifica en F4.

1. **AC-1**: WHEN el depositante de un `keyId` llama `setArbitrationConsent(keyId, true)`, THE system SHALL persistir opt-in on-chain queryable (`arbitrationConsent(keyId)==true`) y emitir `ArbitrationConsentSet(keyId, depositor)`, como precondición de toda acción del árbitro sobre ese `keyId`.
2. **AC-2**: IF `resolveDispute` (o `lockForDispute`) es llamado sobre un `keyId` SIN consentimiento persistido, THEN THE system SHALL revertir `ArbitrationNotConsented` y SHALL NOT mover ni congelar fondos.
3. **AC-3**: WHEN el `_arbiter` llama `resolveDispute(keyId, seller, sellerAmount, nonce)` con consentimiento válido, `seller != address(0)`, `sellerAmount > 0`, `sellerAmount <= _lockedAmount[keyId]`, `sellerAmount <= escrowBalance(keyId)` y `nonce` no usado, THE system SHALL transferir exactamente `sellerAmount` USDC a `seller`, decrementar `_balances[keyId]` en `sellerAmount`, poner `_lockedAmount[keyId] = 0`, marcar `(keyId, nonce)` consumido y emitir `DisputeResolved`.
4. **AC-4**: IF cualquier dirección distinta de `_arbiter` llama `resolveDispute`, `lockForDispute` o `releaseDispute`, THEN THE system SHALL revertir `NotArbiter` sin importar el estado de consentimiento.
5. **AC-5**: IF `resolveDispute` es llamado dos veces con el mismo `(keyId, nonce)`, THEN THE system SHALL revertir la segunda llamada `NonceAlreadyUsed` (reusa `_usedNonces[keyId][nonce]`).
6. **AC-6**: IF `sellerAmount > escrowBalance(keyId)`, THEN THE system SHALL revertir `InsufficientBalance` y SHALL NOT transferir parcialmente.
7. **AC-7**: THE system SHALL preservar el storage-layout UUPS-safe: `_arbiter` (address) y `_arbitrationConsent` (mapping `bytes32=>bool`) se agregan consumiendo 2 slots del `__gap[43]` (→ `__gap[41]`), sin reordenar ni redimensionar ninguna variable preexistente y sin `reinitializer`; `initialize()` byte-idéntico (`_arbiter` arranca en `address(0)`).
8. **AC-8**: WHEN el owner llama `setArbiter(newArbiter)` con `newArbiter != address(0)`, THE system SHALL rotar `_arbiter` y emitir `ArbiterUpdated(oldArbiter, newArbiter)`; IF el caller no es owner THEN revertir `OwnableUnauthorizedAccount`; IF `newArbiter == address(0)` THEN revertir `ZeroAddress`.
9. **AC-9**: THE system SHALL extender (no reemplazar) ambas suites de invariantes Foundry con (a) el ghost term `ghost_totalArbiterResolved` sumado a las identidades de conservación/solvencia/mirror y (b) witnesses hostiles que prueben que `resolveDispute` / `lockForDispute` NUNCA tienen éxito sin AMBOS `msg.sender==_arbiter` Y `_arbitrationConsent[keyId]==true` (ni con `sellerAmount>_lockedAmount`, ni con nonce reusado); mientras las invariantes preexistentes siguen pasando sin relajarse.
10. **AC-10** (lock): WHEN el `_arbiter` llama `lockForDispute(keyId, amount)` sobre un `keyId` consentido con `amount > 0` y `_lockedAmount[keyId] + amount <= escrowBalance(keyId)`, THE system SHALL fijar `_lockedAmount[keyId] += amount` y emitir `DisputeLocked`; IF `_lockedAmount[keyId] + amount > escrowBalance(keyId)` THEN revertir `InsufficientBalance`.
11. **AC-11** (withdraw respeta el lock): WHILE `_lockedAmount[keyId] > 0`, THE system SHALL permitir `withdraw(keyId, amount)` sólo si `amount <= escrowBalance(keyId) - _lockedAmount[keyId]`; en caso contrario revertir `InsufficientBalance` — **sin cambiar el código de `withdraw`** (ya resta `_lockedAmount`).
12. **AC-12** (residual liberado / release): WHEN `resolveDispute` completa, THE system SHALL dejar `_lockedAmount[keyId] == 0` y el residual disponible para el `withdraw` del depositante; WHEN el árbitro llama `releaseDispute(keyId)` (buyer gana, sin pago), THE system SHALL poner `_lockedAmount[keyId] = 0` y emitir `DisputeReleased`.
13. **AC-13** (consentimiento monotónico): IF el depositante llama `setArbitrationConsent(keyId, false)`, THEN revertir `ConsentIrrevocable`; IF un no-depositante llama `setArbitrationConsent` THEN revertir `Unauthorized`; una segunda llamada `(keyId, true)` es idempotente (no-op, sin evento).

---

## Files to Modify/Create

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `contracts/src/WasiAIEscrow.sol` | Modificar | Storage nuevo (`_arbiter`, `_arbitrationConsent`, `__gap 43→41`) + `arbiter()`/`setArbiter()`/`onlyArbiter` + `arbitrationConsent()`/`setArbitrationConsent()` + `lockedAmount()`/`lockForDispute()`/`releaseDispute()` + `resolveDispute()` + eventos `Debited`-style | `setOperator` `:93-98`, `operator()` `:88-90`, `_verifyAndConsume`/`debit` `:121-156`, `withdraw` `:188-194` |
| 2 | `contracts/src/interfaces/IWasiAIEscrow.sol` | Modificar | Agregar los 5 eventos, 4 errores y 8 firmas nuevas | events `:9-19`, errors `:22-39`, funcs `:42-63` |
| 3 | `contracts/test/WasiAIEscrow.t.sol` | Modificar | 24 unit tests (happy + cada revert + lock + residual + re-entrancy) | `test_SetOperator_*` `:394-425`, `test_Debit_*` `:114-129`, `test_Withdraw_*` `:240-263` |
| 4 | `contracts/test/WasiAIEscrow.invariant.t.sol` | Modificar | Actor árbitro + handlers legit/hostiles + `ghost_totalArbiterResolved` en la identidad + `invariant_lockNeverExceedsBalance` | `EscrowHandler` `:13-175`, `invariant_operatorCannotDrainWithoutSig` `:212-216`, `invariant_hostilePathAlwaysReverts` `:221-223` |
| 5 | `contracts/test/WasiAIEscrow.invariant2.t.sol` | Modificar | Idem multi-tenant + `ghost_keyBalance -= sellerAmount` en el mirror + término en `invariant_conservation` + `invariant_lockNeverExceedsBalance` | `EscrowHandler2` `:30-415`, `invariant_conservation` `:453-457`, `invariant_perKeyBalanceMirror` `:463-472` |
| 6 | `contracts/test/mocks/ReentrantUSDC.sol` | Crear (si el test de re-entrancy lo requiere) | ERC20 mock que re-entra `resolveDispute` en el hook de `transfer` | `contracts/test/mocks/MockUSDC.sol` (todo el archivo) |

> **Ningún otro archivo se toca.** `Deploy.s.sol`, `src/adapters/escrow/*`, `src/services/arbiter.ts` quedan intactos (191g/191h).

---

## Anclas de línea VERIFICADAS (contra los archivos reales en este repo)

> Confirmadas con Read en esta sesión. Si al abrir el archivo un ancla no coincide → **PARAR y escalar** (el archivo cambió desde F2).

**`contracts/src/WasiAIEscrow.sol`:**
- `:54` — `mapping(bytes32 => uint256) internal _lockedAmount;` (ya existe, hoy siempre 0 — SE ACTIVA su uso, no se crea)
- `:55` — `mapping(bytes32 => mapping(uint256 => bool)) internal _usedNonces;` (SE REUSA para el anti-replay de `resolveDispute`)
- `:57` — `address internal _operator;` ← **el storage nuevo va INMEDIATAMENTE DESPUÉS de esta línea**
- `:59` — `uint256[43] private __gap;` ← **pasa a `[41]`**
- `:62` — `event Debited(...)` declarado EN el contrato (patrón de evento auxiliar; los nuevos eventos van en la INTERFAZ, ver W0.4)
- `:73-85` — `initialize(...)` ← **NO se toca (byte-idéntico, sin `reinitializer`)**
- `:88-90` — `operator()` view getter (exemplar de `arbiter()` / `arbitrationConsent()` / `lockedAmount()`)
- `:93-98` — `setOperator(address) onlyOwner` (exemplar EXACTO de `setArbiter`)
- `:121-141` — `_verifyAndConsume` (patrón CEI: nonce+balance ANTES del transfer)
- `:148-156` — `debit(...)` — guard `if (msg.sender != _operator) revert NotOperator();` en `:152`; paga a `msg.sender` en `:154` (`resolveDispute` paga al `seller`, ésa es la diferencia)
- `:188-194` — `withdraw(...)` — `available = _balances[keyId] - _lockedAmount[keyId];` en `:190` ← **NO se toca; el lock lo respeta automático**

**`contracts/src/interfaces/IWasiAIEscrow.sol`:**
- `:9` — `event Deposited(...)`; `:13` — `event OperatorUpdated(...)` (los nuevos eventos se agregan en este bloque `:9-19`)
- `:22-39` — bloque de errores (los 4 nuevos se agregan acá; `ZeroAmount` `:22`, `NonceAlreadyUsed` `:26`, `InsufficientBalance` `:27`, `Unauthorized` `:28`, `ZeroAddress` `:32` YA existen — REUSAR, no redeclarar)
- `:42-63` — bloque de funciones (las 8 firmas nuevas se agregan acá)

---

## Storage layout exacto (CD-1, AC-7) — INVIOLABLE

En `WasiAIEscrow.sol`, reemplazar el tramo `:57-59` para que quede EXACTAMENTE así:

```solidity
    address internal _operator; // F-A1/F-A2: the only address allowed to settle debits

    // ── 191f: arbiter role + consent (consume 2 slots of __gap; CD-1) ─────────
    address internal _arbiter;                            // NEW — was __gap[0]
    mapping(bytes32 => bool) internal _arbitrationConsent; // NEW — was __gap[1]

    uint256[41] private __gap; // was 43; -2 for _arbiter + _arbitrationConsent (191f, CD-1)
```

Reglas (cualquier violación = BLOQUEANTE en AR/CR):
- Las 2 variables nuevas van **inmediatamente después de `_operator` (`:57`)** y **antes de `__gap`**, en ese orden (`_arbiter` primero). NUNCA reordenar ni insertar entre variables preexistentes.
- `__gap` pasa de `[43]` a `[41]` (−2). Ningún otro cambio de tamaño.
- `_lockedAmount` (`:54`) y `_usedNonces` (`:55`) NO son storage nuevo — se activa/reusa su uso. Cero slots nuevos.
- `initialize()` (`:73-85`) permanece **byte-idéntico**. Sin `reinitializer`. `_arbiter` queda en `address(0)`.
- Con `_arbiter == address(0)`, `onlyArbiter` revierte siempre → las 3 funciones del árbitro quedan inertes hasta que el owner llame `setArbiter()` post-upgrade (191h).

---

## Exemplars

### Exemplar 1: rol rotable owner-only (para `arbiter()` / `setArbiter()` / `onlyArbiter`)
**Archivo**: `contracts/src/WasiAIEscrow.sol:88-98`
**Usar para**: Archivo #1, W0.2
**Patrón clave** (`setOperator`, copiar cambiando operator→arbiter):
```solidity
function operator() external view returns (address) {
    return _operator;
}
function setOperator(address newOperator) external onlyOwner {
    if (newOperator == address(0)) revert ZeroAddress();
    address old = _operator;
    _operator = newOperator;
    emit OperatorUpdated(old, newOperator);
}
```
- El modifier `onlyArbiter` sigue el estilo del guard inline de `debit` `:152` (`if (msg.sender != _operator) revert NotOperator();`), pero factorizado como modifier reusable por 3 funciones:
```solidity
modifier onlyArbiter() {
    if (msg.sender != _arbiter) revert NotArbiter();
    _;
}
```

### Exemplar 2: CEI estricto + `nonReentrant` + `SafeERC20` (para `resolveDispute`)
**Archivo**: `contracts/src/WasiAIEscrow.sol:121-156`
**Usar para**: Archivo #1, W2.1
**Patrón clave** (`_verifyAndConsume` + `debit`):
- Checks primero (deadline/nonce/balance), luego Effects (`_usedNonces[keyId][nonce] = true;` + `_balances[keyId] = bal - amount;`), luego Interactions (`_usdc.safeTransfer(...)`) — TODO el estado se muta ANTES del transfer.
- `debit` es `external nonReentrant`, cachea `_balances[keyId]` en un local `bal` y compara `if (amount > bal) revert InsufficientBalance();`.
- **Diferencia clave**: `debit` hace `_usdc.safeTransfer(msg.sender, amount)` (`:154`, paga al operator). `resolveDispute` hace `_usdc.safeTransfer(seller, sellerAmount)` (paga al SELLER, parámetro). Ése es el único camino nuevo que 191f habilita.

### Exemplar 3: withdraw ya resta el lock (para W1.3 — NO tocar)
**Archivo**: `contracts/src/WasiAIEscrow.sol:188-194`
**Usar para**: Confirmar (no modificar) que el lock bloquea el withdraw:
```solidity
function withdraw(bytes32 keyId, uint256 amount) external nonReentrant {
    if (msg.sender != _depositor[keyId]) revert Unauthorized();
    uint256 available = _balances[keyId] - _lockedAmount[keyId]; // :190 — YA resta el lock
    if (amount > available) revert InsufficientBalance();
    _balances[keyId] -= amount;
    _usdc.safeTransfer(msg.sender, amount);
}
```
- Como `lockForDispute` mantiene `_lockedAmount <= _balances`, la resta en `:190` nunca underflowea.

### Exemplar 4: tests de rol owner-only (para los tests de `setArbiter`)
**Archivo**: `contracts/test/WasiAIEscrow.t.sol:394-425`
**Usar para**: Archivo #3, W3.1
**Patrón clave**:
```solidity
function test_SetOperator_byOwner_rotates_emitsEvent() public {
    address newOp = address(0x09E7);
    vm.expectEmit(true, true, false, false, address(escrow));
    emit IWasiAIEscrow.OperatorUpdated(operator, newOp);
    vm.prank(multisig);              // multisig == owner
    escrow.setOperator(newOp);
    assertEq(escrow.operator(), newOp);
}
function test_RevertWhen_SetOperator_byNonOwner() public {
    vm.prank(operator);
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
    escrow.setOperator(address(0x1234));
}
function test_RevertWhen_SetOperator_zeroAddress() public {
    vm.prank(multisig);
    vm.expectRevert(IWasiAIEscrow.ZeroAddress.selector);
    escrow.setOperator(address(0));
}
```
- `setUp` (`:31-45`): proxy vía `ERC1967Proxy` + `initialize(usdc, operator, multisig, TIMELOCK)`. `agent` = depositor con pk `0xA11CE`; `operator = address(0xCAFE)`; `multisig = address(0xBEEF)` = owner.
- Helper `_deposit(kId, amount)` (`:67-70`) hace `vm.prank(agent); escrow.deposit(...)`. El depositor de cualquier key es `agent` (a menos que otro actor deposite primero).
- Para consentir en un test: `vm.prank(agent); escrow.setArbitrationConsent(keyId, true);` (el depositor es `agent`).
- Para asignar el árbitro en `setUp` de los tests que lo necesiten: agregar `address arbiter = address(0xA5B1);` y `vm.prank(multisig); escrow.setArbiter(arbiter);` (o hacerlo por-test antes de usar).

### Exemplar 5: handlers de invariante legítimos + hostiles (para invariant.t.sol / invariant2.t.sol)
**Archivo**: `contracts/test/WasiAIEscrow.invariant.t.sol:104-174`
**Usar para**: Archivos #4 y #5, W3.2/W3.3
**Patrón clave**:
- Handler LEGÍTIMO (`debitByOperator` `:104-117`): bound del amount al balance vivo, ejecuta, actualiza el ghost (`ghost_totalDebited += amount;`).
- Handler HOSTIL (`operatorDrainAttempt` `:121-138`, `botFrontRunAttempt` `:143-160`): `ghost_hostileAttempts++;` ANTES, luego `try escrow.X(...) { revert("VIOLATED"); } catch { ghost_hostileReverts++; }`.
- La invariante hostil (`invariant_hostilePathAlwaysReverts` `:221-223`) es `assertEq(handler.ghost_hostileAttempts(), handler.ghost_hostileReverts());`.
- La identidad de conservación (`invariant_operatorCannotDrainWithoutSig` `:212-216`) es `escrowUSDC == deposited - debited - withdrawn` → **agregar `- ghost_totalArbiterResolved`**.
**Archivo (multi-tenant)**: `contracts/test/WasiAIEscrow.invariant2.t.sol:453-497` — `invariant_conservation`, `invariant_perKeyBalanceMirror`, `invariant_accessControlAlwaysReverts`, `invariant_noReplay`, `invariant_noUnderflow`. `ghost_keyBalance[k]` `:59` es el mirror por-key; `usedAuths` `:73` es el ledger de replay; `rotateOperator` `:245-251` rota el operator legit.

### Exemplar 6: mock ERC20 (para `ReentrantUSDC.sol`, si se crea)
**Archivo**: `contracts/test/mocks/MockUSDC.sol` (17 líneas, todo el archivo)
**Usar para**: Archivo #6 (opcional)
- `ReentrantUSDC` hereda `ERC20` (6 decimales, `mint` público) e **override `transfer`** para, cuando un flag `attack` esté activo, re-entrar `escrow.resolveDispute(...)` con el mismo `(keyId, nonce)` ANTES de completar la transferencia. El `nonReentrant` (o el `NonceAlreadyUsed` por el nonce ya marcado en la fase Effects) debe hacer revertir la re-entrada, dejando los fondos intactos.

---

## Constraint Directives

### OBLIGATORIO
- **CD-1**: Storage UUPS-safe exacto (ver sección "Storage layout exacto"). `_arbiter` + `_arbitrationConsent` inmediatamente después de `_operator` (`:57`), en ese orden; `__gap[43]→[41]`; `initialize()` byte-idéntico; sin `reinitializer`.
- **CD-2**: `resolveDispute` **Y** `lockForDispute` requieren AMBOS: `msg.sender == _arbiter` (revert `NotArbiter`) **Y** `_arbitrationConsent[keyId] == true` (revert `ArbitrationNotConsented`). Ningún atajo, ningún camino que dependa de uno solo.
- **CD-3**: `resolveDispute` con `nonReentrant`, `SafeERC20`, CEI estricto — marcar `_usedNonces[keyId][nonce] = true` + `_balances[keyId] -= sellerAmount` + `_lockedAmount[keyId] = 0` ANTES del `_usdc.safeTransfer(seller, sellerAmount)`. Patrón de `_verifyAndConsume`/`debit`.
- **CD-4**: Exactly-once vía `_usedNonces[keyId][nonce]` (reuso del mapping `:55`); replay revierte `NonceAlreadyUsed`.
- **CD-5/CD-8** (lock-solvency): mantener `_lockedAmount[keyId] <= _balances[keyId]` en TODO camino. `lockForDispute` valida `newLocked <= _balances[keyId]`; `resolveDispute` valida `sellerAmount <= _lockedAmount[keyId]` (revert `ExceedsLockedAmount`) **Y** `sellerAmount <= _balances[keyId]` (revert `InsufficientBalance`).
- **CD-6**: Eventos nuevos con esos nombres/`indexed` EXACTOS (ver sección "Eventos y errores nuevos").
- **CD-9** (non-custodial): el árbitro SOLO congela/paga fondos **lockeados** de `keyIds` **consentidos**; NUNCA fondos no disputados ni sin consentimiento. `resolveDispute` paga al `seller` (param), no a `msg.sender`.
- **CD-10** (Foundry): los tests deben pasar `forge test`; usar el `MockUSDC` existente; el árbitro se configura con `escrow.setArbiter(...)` (owner) en `setUp` o por-test.
- No relajar/debilitar NINGUNA invariante Foundry preexistente (las 8: `invariant_solvency_balanceGteSumBalances`, `invariant_operatorCannotDrainWithoutSig`, `invariant_hostilePathAlwaysReverts`, `invariant_solvency`, `invariant_conservation`, `invariant_perKeyBalanceMirror`, `invariant_accessControlAlwaysReverts`, `invariant_noReplay`, `invariant_noUnderflow`) — **EXTENDER** con `ghost_totalArbiterResolved` + witnesses nuevos.
- Consentimiento monotónico: `setArbitrationConsent(keyId, false)` revierte `ConsentIrrevocable`; segundo `(keyId, true)` es no-op sin evento.

### PROHIBIDO
- **CD-7**: NO modificar lógica/firma/gas-path de `deposit` (`:101-114`), `debit` (`:148-156`), `debitBatch` (`:163-185`), `withdraw` (`:188-194`) salvo el cambio de storage-layout. `withdraw` ya resta `_lockedAmount` — NO tocarlo.
- NO usar `reinitializer` ni setear `_arbiter` en `initialize`.
- NO agregar librerías/imports nuevos en `WasiAIEscrow.sol` fuera de los ya presentes (`SafeERC20`, OZ upgradeable). Todo lo necesario ya está importado (`:4-13`).
- NO reordenar/redimensionar variables de storage preexistentes ni `__gap` fuera del `-2`.
- NO tocar `Deploy.s.sol`, `src/adapters/escrow/*`, `src/services/arbiter.ts` (191g/191h).
- NO hacer que `resolveDispute` pueda pagar más que `_lockedAmount[keyId]`.
- NO permitir revocación de consentimiento (monotónico).
- NO redeclarar errores que ya existen en la interfaz (`ZeroAmount`, `ZeroAddress`, `InsufficientBalance`, `NonceAlreadyUsed`, `Unauthorized`) — REUSARLOS.

---

## Eventos y errores nuevos (interfaz — Archivo #2)

**Eventos** (agregar al bloque `:9-19` de `IWasiAIEscrow.sol`):
```solidity
event ArbiterUpdated(address indexed oldArbiter, address indexed newArbiter);
event ArbitrationConsentSet(bytes32 indexed keyId, address indexed depositor);
event DisputeLocked(bytes32 indexed keyId, address indexed arbiter, uint256 amount, uint256 totalLocked);
event DisputeResolved(bytes32 indexed keyId, address indexed arbiter, address indexed seller, uint256 sellerAmount, uint256 nonce);
event DisputeReleased(bytes32 indexed keyId, address indexed arbiter, uint256 releasedAmount);
```

**Errores nuevos** (agregar al bloque `:22-39`):
```solidity
error NotArbiter();               // AC-4
error ArbitrationNotConsented();  // AC-2 / CD-2
error ConsentIrrevocable();       // AC-13
error ExceedsLockedAmount();      // AC-3
```
> REUSAR (no redeclarar): `ZeroAmount`, `ZeroAddress`, `InsufficientBalance`, `NonceAlreadyUsed`, `Unauthorized`.

**Firmas** (agregar al bloque `:42-63`):
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

---

## Snippets de referencia (diseño aprobado — el Dev escribe el código real)

> Guías del SDD §4.3. El Dev implementa; estos snippets son el contrato de comportamiento.

**W0 — consentimiento monotónico**:
```solidity
function arbitrationConsent(bytes32 keyId) external view returns (bool) {
    return _arbitrationConsent[keyId];
}
function setArbitrationConsent(bytes32 keyId, bool consent) external {
    if (msg.sender != _depositor[keyId]) revert Unauthorized();  // keyId sin depósito ⇒ _depositor==0 ⇒ revert
    if (!consent) revert ConsentIrrevocable();                   // nunca puede pasar a false
    if (_arbitrationConsent[keyId]) return;                      // idempotente true→true (no-op, sin evento)
    _arbitrationConsent[keyId] = true;
    emit ArbitrationConsentSet(keyId, msg.sender);
}
```

**W1 — lock + release**:
```solidity
function lockedAmount(bytes32 keyId) external view returns (uint256) {
    return _lockedAmount[keyId];
}
function lockForDispute(bytes32 keyId, uint256 amount) external onlyArbiter {
    if (!_arbitrationConsent[keyId]) revert ArbitrationNotConsented();
    if (amount == 0) revert ZeroAmount();
    uint256 newLocked = _lockedAmount[keyId] + amount;
    if (newLocked > _balances[keyId]) revert InsufficientBalance();
    _lockedAmount[keyId] = newLocked;                            // incremental (top-up de la misma disputa)
    emit DisputeLocked(keyId, msg.sender, amount, newLocked);
}
function releaseDispute(bytes32 keyId) external onlyArbiter {
    uint256 locked = _lockedAmount[keyId];
    if (locked == 0) revert ZeroAmount();
    _lockedAmount[keyId] = 0;
    emit DisputeReleased(keyId, msg.sender, locked);
}
```

**W2 — resolveDispute (CEI EXACTO)**:
```solidity
function resolveDispute(bytes32 keyId, address seller, uint256 sellerAmount, uint256 nonce)
    external onlyArbiter nonReentrant
{
    // Checks
    if (!_arbitrationConsent[keyId]) revert ArbitrationNotConsented();
    if (seller == address(0)) revert ZeroAddress();
    if (sellerAmount == 0) revert ZeroAmount();
    if (_usedNonces[keyId][nonce]) revert NonceAlreadyUsed();
    uint256 locked = _lockedAmount[keyId];
    if (sellerAmount > locked) revert ExceedsLockedAmount();
    uint256 bal = _balances[keyId];
    if (sellerAmount > bal) revert InsufficientBalance();
    // Effects (todo ANTES del transfer)
    _usedNonces[keyId][nonce] = true;
    _balances[keyId] = bal - sellerAmount;
    _lockedAmount[keyId] = 0;                                    // libera el residual al buyer
    // Interactions
    _usdc.safeTransfer(seller, sellerAmount);                    // paga al SELLER (no a msg.sender)
    emit DisputeResolved(keyId, msg.sender, seller, sellerAmount, nonce);
}
```

---

## Test Expectations

### Unit — `contracts/test/WasiAIEscrow.t.sol` (Archivo #3)

| Test | ACs | Descripción |
|------|-----|-------------|
| `test_SetArbiter_byOwner_rotates_emitsEvent` | AC-8 | owner setea, getter `arbiter()`, `ArbiterUpdated` |
| `test_RevertWhen_SetArbiter_byNonOwner` | AC-8 | `Ownable.OwnableUnauthorizedAccount` |
| `test_RevertWhen_SetArbiter_zeroAddress` | AC-8 | `ZeroAddress` |
| `test_SetArbitrationConsent_byDepositor_persists_emitsEvent` | AC-1 | consent true, getter, `ArbitrationConsentSet` |
| `test_RevertWhen_Consent_byNonDepositor` | AC-13 | `Unauthorized` |
| `test_RevertWhen_Consent_revoke` | AC-13 | `setArbitrationConsent(key,false)` → `ConsentIrrevocable` |
| `test_Consent_idempotent_trueTwice_noEvent` | AC-13 | 2ª llamada true = no-op (no revierte, sin evento) |
| `test_LockForDispute_byArbiter_locks_emitsEvent` | AC-10 | lock, getter `lockedAmount()`, `DisputeLocked` |
| `test_RevertWhen_Lock_byNonArbiter` | AC-4 | `NotArbiter` |
| `test_RevertWhen_Lock_withoutConsent` | AC-2 | `ArbitrationNotConsented` |
| `test_RevertWhen_Lock_exceedsBalance` | AC-10 | `newLocked>balance` → `InsufficientBalance` |
| `test_RevertWhen_Lock_zeroAmount` | AC-10 | `ZeroAmount` |
| `test_Withdraw_blockedByLock` | AC-11 | deposit 100, lock 60, withdraw 41 revierte `InsufficientBalance`; withdraw 40 ok |
| `test_ResolveDispute_happy_paysSeller_zeroesLock` | AC-3, AC-12 | seller cobra `sellerAmount`, `_balances-=`, `_lockedAmount==0`, nonce consumido, `DisputeResolved` |
| `test_ResolveDispute_residual_withdrawableByBuyer` | AC-12 | tras resolve, buyer retira `balance-sellerAmount` |
| `test_RevertWhen_Resolve_byNonArbiter` | AC-4 | `NotArbiter` (incluso con consent + lock) |
| `test_RevertWhen_Resolve_withoutConsent` | AC-2 | `ArbitrationNotConsented` |
| `test_RevertWhen_Resolve_overLocked` | AC-3 | `sellerAmount>locked` → `ExceedsLockedAmount` |
| `test_RevertWhen_Resolve_exceedsBalance` | AC-6 | `InsufficientBalance` (edge lock≈balance) |
| `test_RevertWhen_Resolve_zeroSellerAmount` | AC-3 | `ZeroAmount` |
| `test_RevertWhen_Resolve_zeroSeller` | AC-3 | `ZeroAddress` |
| `test_RevertWhen_Resolve_nonceReplay` | AC-5 | 2ª `(keyId,nonce)` → `NonceAlreadyUsed` |
| `test_ReleaseDispute_buyerWins_unlocks` | AC-12 | lock→0, buyer retira todo, `DisputeReleased` |
| `test_RevertWhen_Release_byNonArbiter` | AC-4 | `NotArbiter` |
| `test_ResolveDispute_reentrancy_guarded` | CD-3 | `ReentrantUSDC` re-entra `resolveDispute`; revierte (nonReentrant/NonceAlreadyUsed), fondos intactos |

### Invariantes — `invariant.t.sol` + `invariant2.t.sol` (Archivos #4, #5)

**Wiring**: en `setUp` de ambas suites, tras el deploy, `vm.prank(owner/multisig); escrow.setArbiter(ARBITER);` con un `ARBITER` constante nuevo (p.ej. `address(0xA5B1)`). El árbitro NO tiene la pk de ningún depositante.

**Handlers LEGÍTIMOS nuevos** (actualizan ghosts, patrón Exemplar 5):
- `consentByDepositor(seed)` — el depositor de la key opta in.
- `lockByArbiter(seed, amount)` — árbitro lockea `amount <= balance` sobre key consentida; `ghost_keyLocked[k] += amount`.
- `resolveByArbiter(seed, sellerAmount)` — árbitro paga `sellerAmount <= locked` a un seller; `ghost_totalArbiterResolved += sellerAmount`, `ghost_keyBalance[k] -= sellerAmount`, `ghost_keyLocked[k] = 0`; push a `usedAuths`.
- `releaseByArbiter(seed)` — árbitro libera; `ghost_keyLocked[k] = 0`.

**Handlers HOSTILES nuevos** (`ghost_hostileAttempts++` / `try...catch` → `ghost_hostileReverts++`):
- `resolveByNonArbiter` → revert `NotArbiter`.
- `resolveWithoutConsent` (árbitro sobre key sin consent) → revert `ArbitrationNotConsented`.
- `resolveOverLocked` (`sellerAmount>locked`) → revert `ExceedsLockedAmount`.
- `resolveReplay` (replay de `(keyId,nonce)` consumido) → alimenta `ghost_replayAttempts/Reverts` (en invariant2) → revert `NonceAlreadyUsed`.
- `lockByNonArbiter` → revert `NotArbiter`.
- `withdrawOverLock` (depositor intenta `withdraw > balance-locked`) → revert `InsufficientBalance` (prueba que el lock bloquea el withdraw).

**Invariantes EXTENDIDAS** (NO reemplazadas):
- `invariant_operatorCannotDrainWithoutSig` (invariant.t.sol `:212-216`) e `invariant_conservation` (invariant2.t.sol `:453-457`): identidad pasa a `escrowUSDC == deposited - debited - withdrawn - ghost_totalArbiterResolved`.
- `invariant_perKeyBalanceMirror` (`:463-472`): el mirror descuenta también `sellerAmount` en resolve (via `ghost_keyBalance[k] -= sellerAmount` en el handler legit).
- `invariant_solvency*`: sigue `balanceOf(escrow) >= sum(escrowBalance)` — resolve reduce ambos lados en `sellerAmount`, GE se mantiene.
- `invariant_hostilePathAlwaysReverts` / `invariant_accessControlAlwaysReverts`: mismos asserts (`attempts==reverts`), ahora cubren los handlers hostiles del árbitro.
- `invariant_noReplay`: el `resolveReplay` alimenta `ghost_replayAttempts/Reverts`.

**Invariante NUEVA** (agregar en AMBAS suites):
- `invariant_lockNeverExceedsBalance`: para toda key trackeada, `escrow.lockedAmount(k) <= escrow.escrowBalance(k)`.

### Criterio Test-First
Lógica de negocio Solidity security-critical → **Test-first SÍ** para las funciones nuevas. Escribir el test que expresa el AC, verlo fallar (o compilar-fallar), implementar, verlo pasar.

---

## Waves

### Wave -1: Environment Gate (verificar ANTES de tocar código)

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-a2a/contracts
forge --version                 # Foundry instalado
forge build                     # el contrato compila HOY (baseline verde)
forge test 2>&1 | tail -20      # la suite existente pasa HOY (baseline verde)
ls src/WasiAIEscrow.sol src/interfaces/IWasiAIEscrow.sol \
   test/WasiAIEscrow.t.sol test/WasiAIEscrow.invariant.t.sol \
   test/WasiAIEscrow.invariant2.t.sol test/mocks/MockUSDC.sol
```
**Si algo falla en Wave -1**: PARAR y reportar al orquestador. No implementar sobre un baseline roto.

### Wave 0 (Serial Gate — storage + rol + consentimiento) → Archivo #1, #2
- [ ] W0.1: Storage nuevo (`_arbiter`, `_arbitrationConsent`, `__gap 43→41`) exacto (ver "Storage layout exacto"). CD-1.
- [ ] W0.2: `arbiter()`, `setArbiter()` (onlyOwner + zero-guard), modifier `onlyArbiter`, evento `ArbiterUpdated`, error `NotArbiter`. → Exemplar 1.
- [ ] W0.3: `arbitrationConsent()`, `setArbitrationConsent()` (monotónico), evento `ArbitrationConsentSet`, error `ConsentIrrevocable` (reusa `Unauthorized`). → snippet W0.
- [ ] W0.4: Sincronizar `IWasiAIEscrow` con eventos/errores/firmas de W0.
- **Verificación**: `forge build` compila; `forge test` sigue verde (suite existente intacta).

### Wave 1 (Lock — depende de W0) → Archivo #1, #2
- [ ] W1.1: `lockedAmount()`, `lockForDispute()` (onlyArbiter + consent + `newLocked<=balance` + `amount>0`), evento `DisputeLocked`. → snippet W1.
- [ ] W1.2: `releaseDispute()` (onlyArbiter, `locked>0`), evento `DisputeReleased`.
- [ ] W1.3: Confirmar SIN cambiar código que `withdraw` (`:188-194`) respeta el lock. Sincronizar interfaz.
- **Verificación**: `forge build` + tests de W0 verdes.

### Wave 2 (resolveDispute — depende de W1) → Archivo #1, #2
- [ ] W2.1: `resolveDispute()` (CD-2/CD-3/CD-4/CD-8, CEI EXACTO, `SafeERC20`, `nonReentrant`), evento `DisputeResolved`, errores `ExceedsLockedAmount`/`ArbitrationNotConsented`. → Exemplar 2 + snippet W2.
- [ ] W2.2: Sincronizar interfaz (firmas + eventos + errores finales).
- **Verificación**: `forge build`.

### Wave 3 (Tests + invariantes — depende de W2) → Archivos #3, #4, #5, (#6)
- [ ] W3.1: 24 unit tests en `WasiAIEscrow.t.sol` (tabla Test Expectations). → Exemplar 4.
- [ ] W3.2: Extender `WasiAIEscrow.invariant.t.sol` (actor árbitro + handlers legit/hostiles + `ghost_totalArbiterResolved` en `invariant_operatorCannotDrainWithoutSig` + `invariant_lockNeverExceedsBalance`). → Exemplar 5.
- [ ] W3.3: Extender `WasiAIEscrow.invariant2.t.sol` (idem + mirror `ghost_keyBalance -= sellerAmount` + término en `invariant_conservation` + `invariant_lockNeverExceedsBalance`).
- [ ] W3.4 (opcional): `ReentrantUSDC.sol` mock si `test_ResolveDispute_reentrancy_guarded` lo requiere. → Exemplar 6.
- **Verificación**: `forge test` COMPLETO verde (unit + invariantes viejas SIN relajar + nuevas).

### Verificación Incremental

| Wave | Verificación al completar |
|------|---------------------------|
| W-1 | baseline `forge build` + `forge test` verdes |
| W0 | `forge build` + suite existente verde |
| W1 | `forge build` + W0 verde |
| W2 | `forge build` |
| W3 | `forge test` completo verde (todo, sin relajar invariantes) |

---

## Out of Scope

- `contracts/script/Deploy.s.sol` — el deploy/upgrade on-chain es **191h**. NO tocar.
- `src/adapters/escrow/{eip712.ts,abi.ts}`, `src/services/arbiter.ts` — wire on-chain es **191g**. NO tocar.
- Ejecutar el upgrade real (`proposeUpgrade` + timelock + `upgradeToAndCall`) — **191h**.
- Cambiar lógica/firma de `deposit`/`debit`/`debitBatch`/`withdraw` (CD-7).
- Mainnet (cualquier chain). Auditoría externa.
- Máquina de estados app-side (`payment_intents`, `arb_hold`, panel WKH-189) — ya DONE.
- NO "mejorar" código adyacente. NO agregar funcionalidad no listada.
- El withdraw-race durante disputa se **cierra** en esta HU vía el lock (no queda como riesgo abierto): `lockForDispute` congela; `withdraw` ya lo respeta.

---

## Riesgo aceptado documentado (R-1)

`debit` firmado por el depositante puede reducir `_balances` bajo `_lockedAmount` en una key en disputa → `withdraw` underflowea (DoS auto-infligido, sin pérdida de fondos). Mitigación a 3 niveles (operacional/económico/fail-closed) documentada en SDD §4.4. CD-7 prohíbe tocar `debit`, así que NO se modifica — el guard `sellerAmount > bal` en `resolveDispute` es la baranda on-chain. NO intentar "arreglar" esto tocando `debit`.

---

## Escalation Rule

> **Si algo no está en este Story File, Dev PARA y escala al Architect. No inventar, no asumir.**

Situaciones de escalation:
- Un ancla de línea de la sección "Anclas de línea VERIFICADAS" no coincide con el archivo real → el archivo cambió desde F2.
- Un import necesario no está disponible (todo lo requerido ya está en `WasiAIEscrow.sol:4-13`).
- Un error/evento que se quiere reusar no existe con el nombre esperado.
- Ambigüedad en un AC o en el CEI de `resolveDispute`.
- El cambio requiere tocar un archivo fuera de la tabla "Files to Modify/Create".
- Una invariante preexistente empieza a fallar y no es claro cómo extenderla sin relajarla.

---

*Story File generado por NexusAgil — F2.5 (Architect)*
