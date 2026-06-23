# Story File — HU WKH-126a: Contrato Solidity del Escrow No-Custodial (Foundry)

> Contrato de **custodia de dinero** (USDC prepago por Agent Key) — máximo detalle.
> Este Story File es **AUTO-CONTENIDO**: el Dev NO necesita releer el SDD ni el work-item.
> Stack: **Foundry puro** (`forge`), OpenZeppelin Contracts (Upgradeable) v5.x vía git submodules.
>
> SPEC_APPROVED: ✅ (dado). NNN: 121. Branch: `feat/121-wkh-126a-escrow-contract`.
> Artefactos: `doc/sdd/121-wkh-126a-escrow-contract/`.

---

## 0. Contexto compacto (qué se construye y por qué)

`WasiAIEscrow.sol` es el escrow **no-custodial** que el gateway TS de WKH-126b (DONE, mergeado)
ya consume como interfaz provisional (`src/adapters/escrow/abi.ts` + `eip712.ts`). Materializa
ese contrato de forma byte-a-byte. Modelo:

1. **Agente deposita** USDC con `deposit(keyId, amount)` (paga su propio gas).
2. **Agente firma off-chain** (gratis) una `DebitAuthorization{keyId, amount, deadline, nonce}` EIP-712
   por el **neto acumulado** de una ventana de settlement (lo hace 126b con `buildDebitAuthorization`).
3. **Operador liquida en lote** con `debitBatch(...)` (paga su propio gas), presentando las firmas.
   Por cada elemento: valida deadline, `recovered == depositor[keyId]`, nonce no usado; CEI; transfiere USDC al operador.
4. **Agente retira** su saldo libre con `withdraw(keyId, amount)` cuando quiere.

**Invariante central (CD-2):** el operador NUNCA mueve `balances[keyId]` sin una firma del
`depositor[keyId]`. Verificable por invariant fuzzing.

Contrato **UUPS upgradeable** con timelock + owner multisig (testnet/beta), diseñado para
**renunciar al upgrade** antes de mainnet. **Scope: Base Sepolia (chainId 84532) únicamente.**

> ⚠️ **El Dev NO toca `src/` en F3.** La única divergencia con 126b (el `nonce` como argumento
> de `debit`) se documenta como VERIFY-AT-IMPL y se aplica a `abi.ts` en la **tarea de cierre**
> (§9 — última wave). Ver DT-14 / §9.

---

## 1. Scope IN — archivos exactos a tocar

| # | Archivo | Acción | Wave |
|---|---------|--------|------|
| 1 | `contracts/foundry.toml` | Crear | W0 |
| 2 | `contracts/remappings.txt` | Crear | W0 |
| 3 | `contracts/lib/forge-std/` | Submodule (`forge install`) | W0 |
| 4 | `contracts/lib/openzeppelin-contracts/` | Submodule (`forge install`) | W0 |
| 5 | `contracts/lib/openzeppelin-contracts-upgradeable/` | Submodule (`forge install`) | W0 |
| 6 | `contracts/test/mocks/MockUSDC.sol` | Crear | W0 |
| 7 | `contracts/src/interfaces/IWasiAIEscrow.sol` | Crear | W1 |
| 8 | `contracts/src/WasiAIEscrow.sol` | Crear | W1→W3 (incremental) |
| 9 | `contracts/test/WasiAIEscrow.t.sol` | Crear | W4 |
| 10 | `contracts/test/WasiAIEscrow.invariant.t.sol` | Crear | W4 |
| 11 | `contracts/script/Deploy.s.sol` | Crear | W5 |
| 12 | `.env.example` (raíz del repo, ya existe) | **Modificar** (append vars) | W5 |
| 13 | `.gitmodules` (raíz, se crea solo por `forge install`) | Generado | W0 |

**PROHIBIDO tocar cualquier archivo fuera de esta lista** (excepto `.gitmodules` que `forge install`
genera solo). En particular: **NO tocar `src/`** (ni `abi.ts` ni `eip712.ts`) en F3 — eso es §9, tarea de cierre.

> **Nota de grounding (verificado):** `forge 1.5.1-stable` disponible ✓. `contracts/` NO existe (se crea en W0) ✓.
> `.env.example` ya existe en la raíz (se hace **append**, no overwrite) ✓.
> Typehash canónico recomputado con `cast keccak` → `0x5feea67fe2f683c18d6addd1eaab3f2152293b5512c90fdd3f702e973a2328f5` ✓.

---

## 2. Anti-Hallucination Checklist (específico de esta HU)

Antes de escribir cualquier import o llamada OZ, el Dev **DEBE** verificar el path real en `lib/`:

- [ ] **NO inventes paths de OZ.** Tras `forge install`, hacé `ls contracts/lib/openzeppelin-contracts-upgradeable/contracts/` y `ls .../proxy/utils/`, `.../access/`, `.../utils/`, `.../utils/cryptography/` para confirmar los nombres EXACTOS de los archivos OZ v5 antes de importarlos. Los nombres esperados (OZ v5):
  - `@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol`
  - `@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol`
  - `@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol` (extiende `OwnableUpgradeable`)
  - `@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol`
  - `@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol`
  - `@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol` (NO upgradeable — es stateless)
  - `@openzeppelin/contracts/token/ERC20/IERC20.sol`
  - `@openzeppelin/contracts/utils/cryptography/ECDSA.sol`
  - `@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol` (para Deploy.s.sol)
  - `@openzeppelin/contracts/token/ERC20/ERC20.sol` (para MockUSDC)
  - **Si un path no existe en ese lugar → `find contracts/lib -name 'NombreDelArchivo.sol'` y usá el real. NUNCA asumas.**
- [ ] **Typehash EXACTO** (CD-1): `keccak256("DebitAuthorization(bytes32 keyId,uint256 amount,uint256 deadline,uint256 nonce)")`. Orden de campos: `keyId, amount, deadline, nonce` (idéntico a `DEBIT_AUTHORIZATION_TYPES` de `eip712.ts`). Valor esperado: `0x5feea67fe2f683c18d6addd1eaab3f2152293b5512c90fdd3f702e973a2328f5`. **NO reordenes, NO omitas `nonce`.**
- [ ] **Domain EIP-712 EXACTO** (CD-1/CD-5): `name="WasiAIEscrow"`, `version="1"`. Vía `__EIP712_init("WasiAIEscrow", "1")`. `chainId` y `verifyingContract` los aporta OZ dinámicamente — **NO los hardcodees**.
- [ ] **USDC NO hardcodeado** (CD-5): se pasa a `initialize(address usdc, ...)`. La dirección real de Base Sepolia (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) va SOLO en `.env.example` / Deploy script, **NUNCA** literal en `WasiAIEscrow.sol`.
- [ ] **OZ v5 API drift**: `Ownable2StepUpgradeable.__Ownable_init(initialOwner)` recibe el owner como argumento en v5. `ECDSA.recover(digest, signature)` retorna `address` (en v5 `tryRecover` no revierte, `recover` sí). Verificá las firmas reales en `lib/` antes de usar.
- [ ] **SafeERC20** (CD-11): solo `safeTransfer` / `safeTransferFrom`. **NUNCA** `IERC20.transfer` crudo.
- [ ] **CD-6**: PROHIBIDO `hardhat.config.*`, `package.json`, o `node_modules` dentro de `contracts/`. Deps SOLO vía `forge install` (submodules).

---

## 3. Constraint Directives por wave (CD-1..CD-14)

| CD | Regla (PROHIBIDO / OBLIGATORIO) | Waves donde aplica |
|----|--------------------------------|--------------------|
| **CD-1** | Typehash byte-a-byte: `keccak256("DebitAuthorization(bytes32 keyId,uint256 amount,uint256 deadline,uint256 nonce)")` = `0x5feea6…2328f5`. PROHIBIDO reordenar/omitir `nonce`. Domain `name="WasiAIEscrow"`,`version="1"`. | W1, W2, W4 |
| **CD-2** | El operador NUNCA mueve `balances[keyId]` sin `DebitAuthorization` firmada por `depositor[keyId]`. PROHIBIDO cualquier path que lo viole. Verificable por invariant. | W2, W3, W4 |
| **CD-3** | Nonce anti-replay: `usedNonces[keyId][nonce]` irrevocable; revertir `NonceAlreadyUsed` en replay. | W2, W4 |
| **CD-4** | CEI + `nonReentrant` en `deposit`/`withdraw`/`debit`/`debitBatch`. Actualizar balances ANTES de transferir. | W1, W2, W3 |
| **CD-5** | Sin hardcodes de USDC ni chainId. USDC vía `initialize`. `block.chainid` dinámico (OZ EIP712). | W1, W5 |
| **CD-6** | Foundry puro. PROHIBIDO Hardhat / deps NPM en `contracts/`. Deps vía `forge install` (submodules en `lib/`). | W0 (todas) |
| **CD-7** | ≥1 test por AC (12). Revert tests con `vm.expectRevert(WasiAIEscrow.X.selector)`. Batch atómico testeado. `forge coverage` ≥95% líneas de `WasiAIEscrow.sol`. | W4 |
| **CD-8** | `depositor[keyId]` fijo en el PRIMER deposit; inmutable. Segunda address → `DepositorMismatch`. (DT-10) | W1 |
| **CD-9** | Layout UUPS estable. PROHIBIDO reordenar/eliminar storage. Solo agregar al final consumiendo `__gap`. El orden de §5 es contractual. | W1 (todas) |
| **CD-10** | `via_ir` SOLO si `forge build` falla por "stack too deep". No activar por defecto. Documentar en `foundry.toml` si se usa. | W0, W2 |
| **CD-11** | PROHIBIDO `IERC20.transfer` crudo. Solo `SafeERC20.safeTransfer`/`safeTransferFrom`. | W1, W2, W3 |
| **CD-12** | (de WKH-126b auto-blindaje#1) El typehash/ABI Solidity y `DEBIT_AUTHORIZATION_TYPES`/`ESCROW_ABI` de 126b son DOS superficies independientes. PROHIBIDO asumir que compilar Solidity garantiza convergencia con el TS. Verificar explícito (test de typehash + checklist ABI). Divergencia inevitable → VERIFY-AT-IMPL, NO tocar `src/` en F3. | W4, W2 |
| **CD-13** | (de WKH-SEC-02 auto-blindaje#1) Aserciones de test robustas. Usar `vm.expectEmit`, `.selector` exacto. NO `contains`/substring sobre strings. | W4 |
| **CD-14** | (de WKH-125b auto-blindaje#2) `contracts/` es subproyecto nuevo aislado → todo fallo es propio. El Dev NO "arregla" nada fuera de `contracts/`. `forge fmt --check` + coverage se evalúan SOLO sobre `contracts/`. | todas |

---

## 4. WAVE 0 — Scaffold Foundry (Serial Gate) — comandos EXACTOS

> **Objetivo:** subproyecto Foundry aislado en `contracts/`, OZ instalado, mock USDC, `forge build` verde.

### W0.1 — Crear estructura e inicializar Foundry

> `forge init` por defecto crea un repo git y un ejemplo `Counter`. Como ya estamos en un repo git
> y NO queremos el ejemplo, usar `--no-git --no-commit` y **borrar los archivos de ejemplo** que genera
> (`src/Counter.sol`, `test/Counter.t.sol`, `script/Counter.s.sol`).

```bash
# desde la raíz del repo (wasiai-a2a/)
forge init contracts --no-git --no-commit
# borrar el ejemplo Counter (NO commitearlo)
rm -f contracts/src/Counter.sol contracts/test/Counter.t.sol contracts/script/Counter.s.sol
# crear las carpetas que vamos a usar
mkdir -p contracts/src/interfaces contracts/test/mocks
```

### W0.2 — Instalar dependencias OZ (git submodules en `contracts/lib/`)

> **CD-6:** deps SOLO por submodule. Pinear a un tag **v5.x** estable. Verificar el tag disponible
> con `git ls-remote --tags` si el pin exacto falla. `forge-std` se instala con `forge init`, pero
> reinstalar explícito asegura la versión.

```bash
# IMPORTANTE: forge install debe correrse DENTRO de contracts/ para resolver lib/ correcto.
# Ejecutar cada comando con working dir = contracts/ (usar pushd/popd o el cwd del shell).

# forge-std (suele venir con forge init; reinstalar si falta)
forge install foundry-rs/forge-std --no-git --no-commit  # (correr dentro de contracts/)

# OpenZeppelin Contracts v5.x (pinear al tag estable, ej. v5.1.0 o el más reciente v5.x verificado)
forge install OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git --no-commit

# OpenZeppelin Contracts Upgradeable v5.x (MISMA minor que contracts para evitar drift)
forge install OpenZeppelin/openzeppelin-contracts-upgradeable@v5.1.0 --no-git --no-commit
```

> **[VERIFY-AT-IMPL] Tag exacto:** si `@v5.1.0` no resuelve, listar tags con
> `git ls-remote --tags https://github.com/OpenZeppelin/openzeppelin-contracts-upgradeable | grep v5` y
> usar el último `v5.x` estable. **Contracts y Contracts-Upgradeable DEBEN ser la misma minor** (drift de API entre versiones rompe imports).

### W0.3 — `foundry.toml` + `remappings.txt`

**`contracts/foundry.toml`** (contenido objetivo — el Dev lo escribe):

```toml
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
test = "test"
script = "script"
solc = "0.8.24"            # fijar la versión; debe ser compatible con OZ v5 (>=0.8.20)
optimizer = true
optimizer_runs = 200
# via_ir = false          # CD-10: activar SOLO si forge build falla por "stack too deep" en debitBatch
remappings = [
    "@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/",
    "@openzeppelin/contracts-upgradeable/=lib/openzeppelin-contracts-upgradeable/contracts/",
    "forge-std/=lib/forge-std/src/"
]
fs_permissions = [{ access = "read", path = "./"}]

[fuzz]
runs = 256

[invariant]
runs = 256
depth = 50
fail_on_revert = false
```

**`contracts/remappings.txt`** (redundante con foundry.toml pero explícito — algunos tooling lo leen):

```
@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/
@openzeppelin/contracts-upgradeable/=lib/openzeppelin-contracts-upgradeable/contracts/
forge-std/=lib/forge-std/src/
```

> **Pin de solc:** `0.8.24` es seguro para OZ v5 (que exige `>=0.8.20`). Si OZ v5.1 exige otra, ajustar.
> No usar `^0.8.x` flotante en `foundry.toml` (determinismo de build).

### W0.4 — Mock USDC para tests

**`contracts/test/mocks/MockUSDC.sol`** — ERC-20 de 6 decimales (USDC real tiene 6), con `mint`
público para tests. NO es producción. Hereda `@openzeppelin/contracts/token/ERC20/ERC20.sol`,
override `decimals() => 6`, función `mint(address,uint256)` pública.

### Verificación W0 (gate serial — NO avanzar a W1 sin esto)

```bash
# dentro de contracts/
forge build         # compila scaffold + MockUSDC, 0 errores
ls lib/             # confirmar: forge-std/ openzeppelin-contracts/ openzeppelin-contracts-upgradeable/
ls src/             # confirmar: NO existe Counter.sol; existe interfaces/
```

---

## 5. WAVE 1 — Contrato base: storage, deposit, escrowBalance, EIP-712 domain/typehash

### W1.1 — `contracts/src/interfaces/IWasiAIEscrow.sol`

Interfaz pública + **custom errors** + event `Deposited`. La interfaz declara la ABI surface que
debe converger con 126b. Contenido objetivo:

- **Event** (orden y `indexed` EXACTOS según `ESCROW_ABI` de abi.ts):
  ```solidity
  event Deposited(address indexed depositor, bytes32 indexed keyId, uint256 amount);
  ```
- **Custom errors** (todos los del §7 flujo de error):
  `ZeroAmount`, `DepositorMismatch`, `InvalidSignature`, `DeadlineExpired`, `NonceAlreadyUsed`,
  `InsufficientBalance`, `Unauthorized`, `LengthMismatch`, `TimelockNotElapsed`, `UpgradeRenounced`, `ZeroAddress`.
- **Funciones** (firmas): `deposit(bytes32,uint256)`, `escrowBalance(bytes32) view returns(uint256)`,
  `withdraw(bytes32,uint256)`, `debit(bytes32,uint256,uint256,uint256,bytes)` (5 args — ver §9 DT-14),
  `debitBatch(bytes32[],uint256[],uint256,uint256[],bytes[])`.

> **NOTA DT-14 / §9:** la `debit` de la **interfaz del contrato** lleva **5 args** (incluye `nonce` explícito).
> La de `abi.ts` (126b) hoy tiene 4 args. Esa divergencia se sincroniza en §9 (tarea de cierre). NO tocar `abi.ts` ahora.

### W1.2 — `contracts/src/WasiAIEscrow.sol` — esqueleto + storage + initializer

**Herencia (orden importa para linearization OZ):**
```solidity
contract WasiAIEscrow is
    Initializable,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    ReentrancyGuardUpgradeable,
    EIP712Upgradeable,
    IWasiAIEscrow
{ ... }
```

**Storage layout — EXACTO y CONTRACTUAL (CD-9). NO reordenar, NO eliminar, solo agregar al final consumiendo `__gap`:**

```solidity
// === Storage (UUPS-safe; orden estable, __gap al final) ===
IERC20  internal _usdc;                          // token único (DT-6, CD-5) — set en initialize
uint256 internal _upgradeTimelock;               // UPGRADE_TIMELOCK en segundos (AC-12)
bool    internal _upgradeRenounced;              // true => upgrade desactivado permanentemente (AC-12)

mapping(bytes32 => uint256) internal _balances;          // keyId => saldo USDC (6 dec)
mapping(bytes32 => address) internal _depositor;         // keyId => owner inmutable (DT-10/CD-8)
mapping(bytes32 => uint256) internal _lockedAmount;      // keyId => comprometido (DT-11) — queda en 0 (modelo optimista)
mapping(bytes32 => mapping(uint256 => bool)) internal _usedNonces;  // keyId => nonce => usado (CD-3)
mapping(bytes32 => uint256) internal _upgradeProposedAt; // keccak(newImpl) => timestamp propuesta (DT-12)

uint256[44] private __gap;                        // reserva OZ para upgradeability
```

> El Dev puede exponer `escrowBalance(keyId)` como getter view de `_balances`. Los mappings privados con
> getters explícitos son aceptables; lo crítico es el **orden de declaración de slots** (CD-9).

**Constructor + initializer:**
```solidity
/// @custom:oz-upgrades-unsafe-allow constructor
constructor() { _disableInitializers(); }       // OBLIGATORIO en upgradeable (bloquea init de la impl)

function initialize(address usdc, address multisig, uint256 timelockDelay) external initializer {
    if (usdc == address(0) || multisig == address(0)) revert ZeroAddress();
    __UUPSUpgradeable_init();
    __Ownable_init(multisig);                    // OZ v5: owner = multisig (NO el deployer EOA) — AC-12
    __Ownable2Step_init();                       // si v5 lo requiere por separado; verificar en lib/
    __ReentrancyGuard_init();
    __EIP712_init("WasiAIEscrow", "1");          // CD-1: name/version EXACTOS
    _usdc = IERC20(usdc);
    _upgradeTimelock = timelockDelay;
}
```

> **[VERIFY-AT-IMPL]** En OZ v5, `Ownable2StepUpgradeable` puede heredar `OwnableUpgradeable` y exponer
> solo `__Ownable_init(initialOwner)` (sin `__Ownable2Step_init` separado). **Verificar en `lib/` el set real
> de inicializadores** antes de escribir. Llamar SOLO los `__*_init` que existan.

### W1.3 — `deposit`, `escrowBalance`, typehash constant, `Deposited`

**Typehash (CD-1) — constante exacta:**
```solidity
bytes32 public constant DEBIT_AUTHORIZATION_TYPEHASH =
    keccak256("DebitAuthorization(bytes32 keyId,uint256 amount,uint256 deadline,uint256 nonce)");
// == 0x5feea67fe2f683c18d6addd1eaab3f2152293b5512c90fdd3f702e973a2328f5
```

**`deposit(bytes32 keyId, uint256 amount)`** (CEI + nonReentrant + SafeERC20 + DT-10):
1. `if (amount == 0) revert ZeroAmount();`
2. depositor lock (DT-10/CD-8): si `_depositor[keyId] == address(0)` → `_depositor[keyId] = msg.sender`;
   else `if (msg.sender != _depositor[keyId]) revert DepositorMismatch();`
3. **Effects:** `_balances[keyId] += amount;`
4. **Interactions:** `_usdc.safeTransferFrom(msg.sender, address(this), amount);`
5. `emit Deposited(msg.sender, keyId, amount);`

> **Orden CEI estricto:** effects (`_balances += amount`) ANTES del `safeTransferFrom` (CD-4). `nonReentrant`.

**`escrowBalance(bytes32 keyId) external view returns (uint256)`** → `return _balances[keyId];` (AC-10, no muta estado).

### Verificación W1

```bash
# dentro de contracts/
forge build                       # 0 errores
# tests de W1 (escritos en W4 pero el Dev puede smoke-testear el typehash ya):
forge test --match-test test_Typehash_matchesCanonical -vv   # assert == 0x5feea6…2328f5
```

---

## 6. WAVE 2 — Debit + debitBatch + verificación de firma EIP-712

### W2.1 — Helper interno `_verifyAndConsume`

```solidity
function _verifyAndConsume(
    bytes32 keyId,
    uint256 amount,
    uint256 deadline,
    uint256 nonce,
    bytes calldata signature
) internal {
    // 1. deadline
    if (block.timestamp > deadline) revert DeadlineExpired();
    // 2. nonce no usado (CD-3)
    if (_usedNonces[keyId][nonce]) revert NonceAlreadyUsed();
    // 3. recover EIP-712 (CD-1)
    bytes32 structHash = keccak256(
        abi.encode(DEBIT_AUTHORIZATION_TYPEHASH, keyId, amount, deadline, nonce)
    );
    bytes32 digest = _hashTypedDataV4(structHash);   // OZ aplica domain separator (chainId + this dinámicos)
    address recovered = ECDSA.recover(digest, signature);
    if (recovered != _depositor[keyId]) revert InvalidSignature();   // AC-4 (depositor == firmante autorizado)
    // 4. balance
    if (amount > _balances[keyId]) revert InsufficientBalance();
    // === Effects (CEI) ===
    _usedNonces[keyId][nonce] = true;                // marcar nonce (irrevocable, CD-3)
    _balances[keyId] -= amount;                      // debitar ANTES de transferir
}
```

> **CRÍTICO (CD-1):** el `abi.encode` del structHash usa el orden EXACTO `keyId, amount, deadline, nonce` —
> el mismo del typehash. Si el orden difiere, `ECDSA.recover` da otra address y la firma de 126b/viem no recover.
> **`recovered == _depositor[keyId]`** es la materialización de CD-2: sin firma del depositor, no hay débito.

### W2.2 — `debit` single + `debitBatch`

**`debit(bytes32 keyId, uint256 amount, uint256 deadline, uint256 nonce, bytes calldata signature)`**
(5 args — ver §9 DT-14), `nonReentrant`:
1. `_verifyAndConsume(keyId, amount, deadline, nonce, signature);`  (effects)
2. **Interactions:** `_usdc.safeTransfer(msg.sender, amount);`  (al operador = `msg.sender`, DT-2)
3. (opcional) emitir evento `Debited(keyId, msg.sender, amount, nonce)` — útil para auditoría.

**`debitBatch(bytes32[] calldata keyIds, uint256[] calldata amounts, uint256 deadline, uint256[] calldata nonces, bytes[] calldata signatures)`**, `nonReentrant`:
1. `if (keyIds.length != amounts.length || keyIds.length != nonces.length || keyIds.length != signatures.length) revert LengthMismatch();`
2. `uint256 total = 0;`
3. loop `i`: `_verifyAndConsume(keyIds[i], amounts[i], deadline, nonces[i], signatures[i]); total += amounts[i];`
   — cualquier `revert` dentro del loop revierte la tx COMPLETA (atomicidad nativa, AC-3, sin estado parcial).
4. **Interactions (una sola transferencia agregada):** `_usdc.safeTransfer(msg.sender, total);`

> **Atomicidad (AC-3):** NO usar `try/catch` ni acumular fallos — un `revert` natural deshace todo. Eso ES la garantía de "sin débito parcial".
> **CEI en batch:** TODOS los effects (`_verifyAndConsume` por elemento) ocurren ANTES de la única `safeTransfer` agregada.
> **[VERIFY-AT-IMPL] CD-10:** si `forge build` falla por "stack too deep" en `debitBatch`, activar `via_ir = true` en `foundry.toml` y documentarlo. NO activar preventivamente.

### Verificación W2

```bash
forge test --match-contract WasiAIEscrowTest -vv   # AC-2..AC-6, batch atómico, replay, deadline
```

---

## 7. WAVE 3 — Withdraw + lock + UUPS/owner/timelock/renounce

### W3.1 — `withdraw(bytes32 keyId, uint256 amount)` (CEI + nonReentrant)

```solidity
function withdraw(bytes32 keyId, uint256 amount) external nonReentrant {
    if (msg.sender != _depositor[keyId]) revert Unauthorized();                 // AC-8
    uint256 available = _balances[keyId] - _lockedAmount[keyId];               // DT-11: lockedAmount==0 (optimista)
    if (amount > available) revert InsufficientBalance();                       // AC-7
    _balances[keyId] -= amount;                                                 // Effects ANTES de transferir
    _usdc.safeTransfer(msg.sender, amount);                                      // Interactions
}
```

> **DT-11 (modelo optimista):** `_lockedAmount[keyId]` siempre vale `0` en esta HU; la resta lo deja listo
> para activar lock explícito en mainnet sin romper layout. **Riesgo de griefing documentado** (el agente puede
> front-runear el debit con un withdraw → el debit revierte por `InsufficientBalance`; NO roba fondos del operador,
> CD-2 intacto). No bloquea esta HU; es decisión de roadmap mainnet (ver §12).

### W3.2 — UUPS + owner multisig + timelock + renounce (AC-12)

**`proposeUpgrade(address newImpl)`** — `onlyOwner`:
```solidity
function proposeUpgrade(address newImpl) external onlyOwner {
    if (_upgradeRenounced) revert UpgradeRenounced();
    _upgradeProposedAt[keccak256(abi.encode(newImpl))] = block.timestamp;
}
```

**`_authorizeUpgrade(address newImpl)`** — override UUPS, `onlyOwner`:
```solidity
function _authorizeUpgrade(address newImpl) internal override onlyOwner {
    if (_upgradeRenounced) revert UpgradeRenounced();
    uint256 proposedAt = _upgradeProposedAt[keccak256(abi.encode(newImpl))];
    if (proposedAt == 0 || block.timestamp < proposedAt + _upgradeTimelock) revert TimelockNotElapsed();
}
```

**`renounceUpgrade()`** — `onlyOwner`, congela upgrades permanentemente:
```solidity
function renounceUpgrade() external onlyOwner {
    _upgradeRenounced = true;
}
```

> **AC-12:** owner = multisig (set en `initialize` vía `__Ownable_init(multisig)`). Upgrade exige
> `onlyOwner` + timelock elapsed + `!_upgradeRenounced`. Tras `renounceUpgrade()`, todo `upgradeToAndCall`
> revierte con `UpgradeRenounced`. **DT-12:** timelock inline (no `TimelockController` OZ) — suficiente para testnet/beta.

### Verificación W3

```bash
forge test --match-contract WasiAIEscrowTest -vv   # AC-7, AC-8, AC-9, AC-11, AC-12
```

---

## 8. WAVE 4 — Tests (unit por AC + invariant fuzzing) — CD-7 / CD-12 / CD-13

### W4.1 — `contracts/test/WasiAIEscrow.t.sol` — mapeo AC → test (los 12 ACs)

> **Setup del test:** desplegar `MockUSDC`, desplegar la impl `WasiAIEscrow`, envolver en `ERC1967Proxy`
> con `initialize(address(usdc), multisig, TIMELOCK)`, castear el proxy a `WasiAIEscrow`. Mintear USDC al
> agente, `approve` al proxy. El "agente" se modela con `vm.addr(agentPk)` para poder firmar con `vm.sign`.

**Firma EIP-712 en test (replicar el digest del contrato):**
```solidity
function _signDebit(uint256 pk, bytes32 keyId, uint256 amount, uint256 deadline, uint256 nonce)
    internal view returns (bytes memory)
{
    bytes32 structHash = keccak256(abi.encode(
        escrow.DEBIT_AUTHORIZATION_TYPEHASH(), keyId, amount, deadline, nonce
    ));
    // domain separator: replicar el de OZ EIP712 (name="WasiAIEscrow", version="1", chainid, address(escrow))
    bytes32 digest = _toTypedDataHash(structHash);   // helper que arma EIP712Domain con address(escrow)
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
    return abi.encodePacked(r, s, v);
}
```
> **CD-1 verificado en test:** el digest se arma con el typehash del contrato y el domain separator real
> (`address(escrow)` como `verifyingContract`, `block.chainid`). Si `_signDebit` firma con `agentPk` y el
> `_depositor[keyId]` es `vm.addr(agentPk)`, `debit` debe PASAR; si firma con otra pk → `InvalidSignature`.

| Test | AC / CD | Tipo / aserción |
|------|---------|-----------------|
| `test_Deposit_creditsBalance_emitsEvent` | AC-1 | `vm.expectEmit(true,true,false,true)` → `Deposited(agent, keyId, amount)`; assert `escrowBalance == amount` |
| `test_Deposit_firstSetsDepositor_immutable` | DT-10/CD-8 | depositor del keyId == primer caller |
| `test_RevertWhen_SecondDepositorClaimsKeyId` | DT-10/CD-8 | `vm.expectRevert(IWasiAIEscrow.DepositorMismatch.selector)` |
| `test_RevertWhen_DepositZeroAmount` | AC-1 guard | `vm.expectRevert(IWasiAIEscrow.ZeroAmount.selector)` |
| `test_Typehash_matchesCanonical` | CD-1 | `assertEq(escrow.DEBIT_AUTHORIZATION_TYPEHASH(), 0x5feea67fe2f683c18d6addd1eaab3f2152293b5512c90fdd3f702e973a2328f5)` |
| `test_Debit_validSig_debits_transfersToOperator` | AC-2 | balance baja `amount`; USDC del operador sube `amount`; nonce marcado |
| `test_DebitBatch_allValid_atomic` | AC-3 | 2+ keyIds; todos debitados; operador recibe `total` |
| `test_RevertWhen_DebitBatch_oneElementFails_noPartial` | AC-3 | un elemento con saldo insuficiente → `expectRevert(InsufficientBalance.selector)`; assert **ningún** balance cambió |
| `test_RevertWhen_DebitBatch_lengthMismatch` | AC-3 | `expectRevert(LengthMismatch.selector)` |
| `test_RevertWhen_InvalidSignature` | AC-4 | firma con pk distinta a depositor → `InvalidSignature.selector` |
| `test_RevertWhen_DeadlineExpired` | AC-5 | `vm.warp(deadline+1)` → `DeadlineExpired.selector`; assert balance sin cambio |
| `test_RevertWhen_NonceReplay` | AC-6/CD-3 | mismo `(keyId,nonce)` 2 veces → 2ª `NonceAlreadyUsed.selector` |
| `test_Withdraw_freeBalance_byDepositor` | AC-7 | depositor retira; USDC vuelve al agente; balance baja |
| `test_RevertWhen_Withdraw_byNonDepositor` | AC-8 | otra address → `Unauthorized.selector` |
| `test_RevertWhen_Withdraw_exceedsAvailable` | AC-7/AC-9 | `amount > balance` → `InsufficientBalance.selector` |
| `test_OperatorCannotWithdrawWithoutSignature` | AC-9/CD-2 | operador (no depositor) intenta `withdraw` → `Unauthorized`; y NO existe otro path |
| `test_OnlyUSDC_noOtherTokenPath` | AC-11 | no existe función que reciba otra dirección de token; `deposit` solo mueve `_usdc` |
| `test_Upgrade_requiresTimelockAndOwner` | AC-12 | upgrade antes del timelock → `TimelockNotElapsed`; desde no-owner → `OwnableUnauthorizedAccount`; tras timelock+owner → OK |
| `test_RenounceUpgrade_freezesPermanently` | AC-12 | `renounceUpgrade()` → cualquier upgrade posterior `UpgradeRenounced.selector` |

> **CD-13:** usar `.selector` exacto y `vm.expectEmit` con flags correctos. NO comparar substrings de strings.
> Para custom errors definidos en la interfaz, referenciarlos como `IWasiAIEscrow.X.selector` (o `WasiAIEscrow.X.selector` si redeclarados).

### W4.2 — `contracts/test/WasiAIEscrow.invariant.t.sol` (handler-based)

**Handler** que expone acciones acotadas (deposit, withdraw, debit con firma generada en el handler) y
un actor "operador" que NO tiene la pk del depositor.

**Invariantes:**
- `invariant_solvency_balanceGteSumBalances`: `_usdc.balanceOf(address(escrow)) >= Σ _balances[keyId]`
  para todos los keyIds tocados por el handler (solvencia — el contrato nunca debe menos de lo que tiene).
- `invariant_operatorCannotDrainWithoutSig` (CD-2): tras cualquier secuencia de calls del operador SIN
  firma del depositor, `_balances[keyId]` no disminuye por acción del operador. (El handler del operador
  intenta `withdraw`/`debit` con firmas inválidas o sin firma → deben revertir; el invariant chequea que
  el balance trackeado por el handler == balance on-chain).

> **`fail_on_revert = false`** en `[invariant]` para que el fuzzer explore calls que revierten (esperado).
> El handler debe llevar contadores "ghost" (totalDeposited, totalDebited, totalWithdrawn) para aserciones de conservación.

### W4.3 — Cobertura

```bash
# dentro de contracts/
forge coverage --report summary
# Objetivo CD-7: >= 95% líneas de src/WasiAIEscrow.sol
forge fmt --check          # CD-14: formato sobre contracts/ (subproyecto aislado)
```

> Si coverage < 95%, agregar tests para las ramas faltantes (típicamente guards de error poco ejercitados).
> **CD-14:** coverage/fmt se evalúan SOLO sobre `contracts/`. NO "arreglar" nada fuera de `contracts/`.

### Verificación W4

```bash
forge test -vv             # TODO verde (unit + invariant)
forge coverage --report summary   # WasiAIEscrow.sol >= 95% líneas
```

---

## 9. WAVE 5 — Deploy script Base Sepolia + `.env.example`

### W5.1 — `contracts/script/Deploy.s.sol`

forge-std `Script`. Lee de env (CD-5: nada hardcodeado). Deploy: impl → `ERC1967Proxy(impl, initData)`
donde `initData = abi.encodeCall(WasiAIEscrow.initialize, (usdc, multisig, timelockDelay))`.

```solidity
function run() external {
    address usdc      = vm.envAddress("USDC_BASE_SEPOLIA");
    address multisig  = vm.envAddress("MULTISIG_ADDRESS");
    uint256 timelock  = vm.envUint("TIMELOCK_DELAY");
    uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");

    vm.startBroadcast(deployerPk);
    WasiAIEscrow impl = new WasiAIEscrow();
    bytes memory initData = abi.encodeCall(WasiAIEscrow.initialize, (usdc, multisig, timelock));
    ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
    vm.stopBroadcast();

    console2.log("Escrow proxy:", address(proxy));
    console2.log("Escrow impl :", address(impl));
}
```

> **Apunta a Base Sepolia (84532)** vía `--rpc-url $BASE_SEPOLIA_RPC_URL`. **En F3 NO se hace `--broadcast` real**
> (no hay secrets). Solo se valida que **compila y simula** (dry-run sin broadcast). El broadcast lo hace el humano post-merge.

### W5.2 — `.env.example` (append a la raíz, NO overwrite)

Agregar al final del `.env.example` existente:

```bash
# ── WKH-126a: Escrow deploy (Base Sepolia testnet) ──
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
DEPLOYER_PRIVATE_KEY=0x...            # EOA deployer (NUNCA el real en .env.example)
USDC_BASE_SEPOLIA=0x036CbD53842c5426634e7929541eC2318f3dCF7e   # Circle USDC Base Sepolia (84532)
MULTISIG_ADDRESS=0x...                # owner del proxy (multisig, NO el deployer EOA)
TIMELOCK_DELAY=172800                 # 2 días en segundos (ejemplo testnet)
```

> **CD-5:** `USDC_BASE_SEPOLIA` y `MULTISIG_ADDRESS` viven SOLO en env, nunca literales en `WasiAIEscrow.sol`.
> `.env.example` lleva placeholders (`0x...`), nunca secrets reales.

### Verificación W5

```bash
# dentro de contracts/  — dry-run (sin --broadcast, sin secrets reales)
forge build script/Deploy.s.sol
forge script script/Deploy.s.sol:Deploy --rpc-url $BASE_SEPOLIA_RPC_URL --sig "run()"   # simula, NO broadcast
```

---

## 9-bis. TAREA DE CIERRE (post-tests, fin de F3) — Convergencia ABI con 126b (DT-14)

> **Esta es la ÚLTIMA tarea de F3, después de que todo `contracts/` esté verde.** Es la única tarea que toca `src/`.

**Qué:** el contrato expone `debit` con **5 args** (`keyId, amount, deadline, nonce, signature`) y
`debitBatch` con `nonces[]`. La interfaz TS de 126b (`src/adapters/escrow/abi.ts`) hoy declara `debit`
con **4 args** (sin `nonce` como argumento de función). El typehash y el struct EIP-712 **NO cambian**
(siguen siendo `keyId, amount, deadline, nonce` — CD-1 intacto); lo único que cambia es la **firma de la
función `debit`** en el ABI.

**Acción (al cierre, NO antes):** actualizar `src/adapters/escrow/abi.ts` → en el `function` `debit`,
agregar `{ name: 'nonce', type: 'uint256' }` ANTES de `signature` (4→5 inputs):
```ts
inputs: [
  { name: 'keyId', type: 'bytes32' },
  { name: 'amount', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
  { name: 'nonce', type: 'uint256' },     // <-- AGREGADO (DT-14)
  { name: 'signature', type: 'bytes' },
],
```
> `eip712.ts` (`DEBIT_AUTHORIZATION_TYPES`) **NO se toca** — ya tiene `nonce` en el struct y coincide byte-a-byte.

**Verificación de cierre (OBLIGATORIA — Definition of Done):**
```bash
# desde la raíz del repo
npm run build && npm test    # (o el runner TS del repo) — los tests de 126b siguen VERDES tras el cambio de abi.ts
```
Si algún test TS de 126b se rompe por el cambio de `abi.ts`, **es un fallo de esta tarea de cierre** y debe
resolverse aquí (no se deja roto). Documentar el cambio en el report como "abi.ts: debit 4→5 args (DT-14), eip712.ts sin cambios".

> **CD-12:** esta convergencia se verifica explícitamente — compilar Solidity NO garantiza que el TS converja.
> El test de typehash (`test_Typehash_matchesCanonical`) + este chequeo del ABI son los DOS gates de coherencia cross-surface.

---

## 10. Orden serial de waves

```
W0 (scaffold, GATE serial) → W1 (storage+deposit) → W2 (debit/batch+firma) → W3 (withdraw+UUPS)
   → W4 (tests+invariant+coverage) → W5 (deploy+env) → 9-bis (cierre: abi.ts 4→5 args + tests TS verdes)
```

| Wave | Depende de | Razón |
|------|-----------|-------|
| W1 | W0 | Necesita OZ instalado y compilando |
| W2 | W1 | Usa typehash + storage + depositor |
| W3 | W1, W2 | Usa balances + lockedAmount + verifica que debit no rompe withdraw |
| W4 | W1–W3 | Testea todo |
| W5 | W1 (interfaz estable) | Deploy del contrato final |
| 9-bis | W4 verde | Solo tras el contrato testeado; toca `src/` una vez |

---

## 11. Definition of Done

- [ ] `contracts/` existe, aislado, **sin** Hardhat / `package.json` / `node_modules` (CD-6).
- [ ] OZ Contracts + Contracts-Upgradeable v5.x (misma minor) instalados como submodules en `contracts/lib/`.
- [ ] `forge build` → **0 errores, 0 warnings críticos** (warnings de OZ de terceros aceptables; el código propio sin warnings).
- [ ] `DEBIT_AUTHORIZATION_TYPEHASH` == `0x5feea67fe2f683c18d6addd1eaab3f2152293b5512c90fdd3f702e973a2328f5` (test `test_Typehash_matchesCanonical` PASS) — **CD-1**.
- [ ] Domain EIP-712 `name="WasiAIEscrow"`, `version="1"`, chainId+verifyingContract dinámicos — **CD-5**.
- [ ] Los 12 ACs cubiertos por ≥1 test cada uno; revert tests con `vm.expectRevert(...selector)` — **CD-7**.
- [ ] `debitBatch` atómico testeado (un elemento malo revierte todo, sin estado parcial) — **AC-3**.
- [ ] Invariantes: solvencia + operador-no-drena-sin-firma (CD-2) PASS — **W4.2**.
- [ ] `forge test` → **TODO verde** (unit + invariant).
- [ ] `forge coverage` → `WasiAIEscrow.sol` **≥ 95% líneas** — **CD-7**.
- [ ] `forge fmt --check` limpio sobre `contracts/` — **CD-14**.
- [ ] `Deploy.s.sol` **compila y simula** (dry-run sin `--broadcast`); `.env.example` con las 5 vars (placeholders) — **CD-5**.
- [ ] **Tarea de cierre (9-bis):** `abi.ts` `debit` 4→5 args (`nonce`); `eip712.ts` sin cambios; **tests TS de 126b siguen VERDES** — **DT-14 / CD-1 / CD-12**.
- [ ] **NO** se tocó ningún archivo de `src/` excepto `abi.ts` (en 9-bis); **NADA** fuera de `contracts/` + `abi.ts` + `.env.example`.

---

## 12. Markers (no bloqueantes — para visibilidad del humano)

| Marker | Descripción | Bloqueante? |
|--------|-------------|-------------|
| `[NEEDS CLARIFICATION — humano, roadmap mainnet]` | Modelo optimista (DT-11): riesgo de griefing residual (agente front-runea el debit con withdraw → impago al vendor, NO robo). Para **mainnet** decidir si activar lock explícito (opción b). `_lockedAmount` ya reservado en storage. **No bloquea esta HU.** | **NO** |
| `[VERIFY-AT-IMPL]` | Tags exactos de OZ v5.x los fija el Dev al `forge install`; verificar paths reales en `lib/` antes de importar. Inicializadores de `Ownable2StepUpgradeable` en v5 — verificar el set real. | NO |
| `[VERIFY-AT-IMPL]` | `via_ir` solo si "stack too deep" en `debitBatch` (CD-10). | NO |

---

*Story File generado por NexusAgil — Architect F2.5 — 2026-06-22 — WKH-126a. NNN: 121.*
*Contrato de custodia de dinero: máximo detalle, auto-contenido, anti-alucinación. El Dev implementa en F3 desde ESTE archivo sin releer el SDD.*
