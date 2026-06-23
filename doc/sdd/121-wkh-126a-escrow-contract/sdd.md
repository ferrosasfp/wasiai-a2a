# SDD #121: [WKH-126a] Contrato Solidity del Escrow No-Custodial (Foundry)

> SPEC_APPROVED: no
> Fecha: 2026-06-22
> Tipo: feature / smart-contract
> SDD_MODE: full
> Branch: feat/121-wkh-126a-escrow-contract
> Artefactos: doc/sdd/121-wkh-126a-escrow-contract/

---

## 1. Resumen

`WasiAIEscrow.sol` es el contrato de escrow **no-custodial prepago de USDC por Agent Key**
que materializa la interfaz que WKH-126b (DONE) consume hoy como provisional
(`src/adapters/escrow/abi.ts`, `src/adapters/escrow/eip712.ts`). El agente deposita USDC
(`deposit`), el operador liquida el neto acumulado por ventana en lote (`debitBatch`)
contra una firma EIP-712 `DebitAuthorization` del agente, y el agente retira su saldo
libre cuando quiere (`withdraw`). La invariante central: **el operador NUNCA mueve fondos
sin una firma del agente** (CD-2). El contrato es upgradeable UUPS con timelock + owner
multisig para beta/testnet, diseñado para renunciar al upgrade antes de mainnet. Scope:
Base Sepolia (chainId 84532) únicamente. Stack: **Foundry puro** (`forge build`/`forge test`),
OpenZeppelin Contracts (Upgradeable) vía `forge install` (git submodules en `contracts/lib/`).

Resultado esperado: subproyecto Foundry aislado en `contracts/`, contrato + interfaz + tests
(unit + invariant fuzzing) con `forge coverage >= 95%` del contrato principal, y un script de
deploy a Base Sepolia con proxy UUPS. Al cierre, si hubo divergencia, se actualiza el ABI/EIP-712
TS de 126b (DT-9 / CD-1) — fuera de este SDD, es tarea de cierre de la HU.

---

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 121 |
| **Tipo** | feature / smart-contract |
| **SDD_MODE** | full |
| **Objetivo** | Entregar `WasiAIEscrow` Solidity (Foundry) que implementa byte-a-byte la interfaz que 126b consume, con escrow no-custodial, EIP-712, UUPS upgradeable + timelock, y deploy Base Sepolia. |
| **Reglas de negocio** | Operador no mueve fondos sin firma (CD-2); nonce anti-replay (CD-3); CEI + reentrancy (CD-4); token único USDC (DT-6); convergencia EIP-712 byte-a-byte con 126b (CD-1/DT-9). |
| **Scope IN** | Ver §6 IN — subproyecto `contracts/` completo, `.env.example` (vars de deploy), artefactos NexusAgil. |
| **Scope OUT** | Ver §6 OUT — mainnet, auditoría externa, otras redes, gasless, scheduler off-chain, cambios a `src/` (TS de 126b). |
| **Missing Inputs** | 2 [NEEDS CLARIFICATION] del work-item — **RESUELTOS en este SDD** como DT-10 (NC-1) y DT-11 (NC-2). Ver §10. |

### Acceptance Criteria (EARS) — heredados del work-item (12)

- **AC-1**: WHEN un agente llama `deposit(keyId, amount)` con `amount > 0` USDC aprobado, THEN the system SHALL transferir `amount` al contrato, acreditar `balances[keyId] += amount`, y emitir `Deposited(msg.sender, keyId, amount)`.
- **AC-2**: WHEN `debit(keyId, amount, deadline, signature)` con firma EIP-712 válida (`recovered == depositor[keyId]`), `block.timestamp <= deadline`, nonce no usado, THEN the system SHALL debitar `balances[keyId] -= amount`, marcar el nonce usado, y transferir `amount` USDC a `msg.sender` (operador).
- **AC-3**: WHEN `debitBatch(keyIds[], amounts[], deadline, signatures[])` con arrays de igual longitud y todas las firmas válidas, THEN the system SHALL ejecutar todos los débitos atómicamente; IF cualquier elemento falla, THEN the system SHALL revertir la tx completa sin débito parcial.
- **AC-4**: IF `recovered != depositor[keyId]`, THEN the system SHALL revertir con `InvalidSignature`.
- **AC-5**: IF `block.timestamp > deadline`, THEN the system SHALL revertir con `DeadlineExpired` sin modificar balances.
- **AC-6**: IF el nonce de la `DebitAuthorization` ya fue usado para ese `keyId`, THEN the system SHALL revertir con `NonceAlreadyUsed`.
- **AC-7**: WHEN `withdraw(keyId, amount)` con `msg.sender == depositor[keyId]` y `amount <= balances[keyId] - lockedAmount[keyId]`, THEN the system SHALL transferir `amount` USDC al agente y actualizar `balances[keyId]`.
- **AC-8**: IF `msg.sender != depositor[keyId]` en `withdraw`, THEN the system SHALL revertir con `Unauthorized`.
- **AC-9**: WHILE el operador no posee firma `DebitAuthorization` válida para `keyId`, the system SHALL NOT permitir que ninguna dirección ≠ `depositor[keyId]` retire fondos de `balances[keyId]`.
- **AC-10**: WHEN `escrowBalance(keyId)` es consultado, the system SHALL retornar `balances[keyId]` sin modificar estado (view).
- **AC-11**: WHEN el contrato recibe USDC via `deposit`, the system SHALL operar solo sobre `USDC_TOKEN` (config en `initialize`); no existe path para depositar otro token.
- **AC-12**: WHILE el contrato está en modo upgradeable, the system SHALL requerir que `upgradeTo*` pase un timelock ≥ `UPGRADE_TIMELOCK` y sea ejecutado desde el owner (multisig); IF `renounceUpgrade()`, THEN the system SHALL desactivar el upgrade permanentemente.

---

## 3. Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Por qué | Patrón / hallazgo extraído |
|---------|---------|----------------------------|
| `doc/sdd/121-wkh-126a-escrow-contract/work-item.md` | Fuente del scope, 12 ACs, 9 DT, 8 CD, 2 NC | Lockea EIP-712, batch, UUPS, USDC único, nonce anti-replay, CEI+reentrancy |
| `src/adapters/escrow/eip712.ts` | **Interfaz canónica EIP-712 que el contrato DEBE implementar** | `DEBIT_AUTHORIZATION_TYPES` = `[keyId bytes32, amount uint256, deadline uint256, nonce uint256]` (ese orden). Domain `name='WasiAIEscrow'`, `version='1'`, `chainId`, `verifyingContract`. `keyId` es `keccak256(stringToBytes(uuid))`. |
| `src/adapters/escrow/abi.ts` | **ABI surface que el contrato DEBE exponer byte-a-byte** | `event Deposited(address indexed depositor, bytes32 indexed keyId, uint256 amount)`; `deposit(bytes32,uint256)`; `debit(bytes32,uint256,uint256,bytes)`; `escrowBalance(bytes32) view returns(uint256)`. |
| `doc/sdd/117-wkh-126-escrow-noncustodial/gas-settlement-economics.md` | Decisiones de settlement (quién paga gas) | Agente paga gas del `deposit`; operador paga gas del `debit`/`debitBatch`; settlement en LOTE para amortizar gas; lectura del evento es gratis (verifier 126b ya implementado). |
| `.nexus/project-context.md` | Stack, reglas absolutas | viem-only en TS (no afecta Solidity), sin hardcodes, sin secrets en código → deploy lee `.env`. |
| `doc/sdd/117/auto-blindaje.md` · `120/...` · `116/...` | Lecciones recurrentes | Ver CD-12/CD-13/CD-14 abajo (coherencia cross-surface, aserciones estructurales robustas, separar scope propio). |

### Verificaciones de grounding (anti-alucinación)

| Verificación | Resultado |
|--------------|-----------|
| `forge --version` | **1.5.1-stable** ✓ (forge disponible) |
| `contracts/` existe | **NO** — subproyecto nuevo, se crea en W0 |
| **Typehash** `keccak256("DebitAuthorization(bytes32 keyId,uint256 amount,uint256 deadline,uint256 nonce)")` | **`0x5feea67fe2f683c18d6addd1eaab3f2152293b5512c90fdd3f702e973a2328f5`** — computado con keccak256; orden de campos idéntico a `DEBIT_AUTHORIZATION_TYPES` de eip712.ts ✓ |
| Orden de campos struct vs TS | `keyId, amount, deadline, nonce` — **coincide** byte-a-byte ✓ |
| Base Sepolia USDC (Circle) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (chainId 84532) — NO se hardcodea en el contrato (CD-5), se pasa a `initialize`/script |

### Exemplars

> **NO hay código Solidity previo en este repo.** Los "exemplars" son los contratos canónicos
> de OpenZeppelin (instalados en W0 vía `forge install`) y la **interfaz TS de 126b** como
> contrato de forma. El Dev sigue los patrones OZ v5 estándar; este SDD no inventa APIs OZ.

| Para crear | Seguir patrón de | Razón |
|------------|------------------|-------|
| Estructura `contracts/` (foundry.toml, remappings, lib/) | Foundry book default + `forge init` layout | Layout canónico Foundry, no inventar |
| EIP-712 domain + typehash | OZ `EIP712Upgradeable` + struct hash manual | OZ deriva `_domainSeparatorV4()`; el typehash del struct lo declara el contrato (constante) — verificado vs TS |
| Recover de firma | OZ `ECDSA.recover(digest, signature)` | Mismo algoritmo que `recoverTypedDataAddress` de viem en 126b |
| UUPS + 2-step owner + reentrancy | OZ `UUPSUpgradeable` + `Ownable2StepUpgradeable` + `ReentrancyGuardUpgradeable` | DT-7; patrón estándar auditado |
| Transfers ERC-20 | OZ `SafeERC20` (`safeTransfer`/`safeTransferFrom`) | Maneja tokens no-conformes; CEI |
| Deploy con proxy | OZ `ERC1967Proxy` en `Deploy.s.sol` (Foundry script) | Patrón de deploy UUPS estándar |

### Estado de "BD" (storage on-chain) relevante

> N/A en sentido SQL. El "modelo de datos" es el **storage layout del contrato** (§4.2).
> Crítico para upgradeability: el layout NO debe romperse entre versiones (gap reservado).

---

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Descripción | Exemplar |
|---------|--------|-------------|----------|
| `contracts/foundry.toml` | Crear | Config Foundry (solc 0.8.x, optimizer, `via-ir` si hace falta para stack-too-deep en batch, paths) | Foundry default |
| `contracts/remappings.txt` | Crear | `@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/`, `@openzeppelin/contracts-upgradeable/=lib/openzeppelin-contracts-upgradeable/contracts/`, `forge-std/=lib/forge-std/src/` | `forge install` layout |
| `contracts/lib/` | Crear (submodules) | `forge install foundry-rs/forge-std`, `OpenZeppelin/openzeppelin-contracts`, `OpenZeppelin/openzeppelin-contracts-upgradeable` (pin a tag v5.x) | CD-6 |
| `contracts/src/interfaces/IWasiAIEscrow.sol` | Crear | Interfaz pública: `Deposited` event, `deposit`, `debit`, `debitBatch`, `withdraw`, `escrowBalance`, custom errors | abi.ts (forma) |
| `contracts/src/WasiAIEscrow.sol` | Crear | Contrato principal: storage, `initialize`, deposit/withdraw/debit/debitBatch, EIP-712 verify, UUPS+owner+timelock+renounce, reentrancy, SafeERC20 | OZ v5 |
| `contracts/test/WasiAIEscrow.t.sol` | Crear | Unit tests: ≥1 por AC (12) + revert tests con custom-error selectors + batch atómico | forge-std `Test` |
| `contracts/test/WasiAIEscrow.invariant.t.sol` | Crear | Invariant fuzzing: solvencia (`sum balances <= token.balanceOf(this)`), operador no retira sin firma (CD-2) | forge-std `StdInvariant` |
| `contracts/test/mocks/MockUSDC.sol` | Crear | ERC-20 mock 6-decimales para tests (no es producción) | OZ `ERC20` |
| `contracts/script/Deploy.s.sol` | Crear | Deploy a Base Sepolia: implementación + `ERC1967Proxy` + `initialize(usdc, multisig, timelockDelay)` | forge-std `Script` |
| `.env.example` | Modificar | Añadir `BASE_SEPOLIA_RPC_URL`, `DEPLOYER_PRIVATE_KEY`, `USDC_BASE_SEPOLIA`, `MULTISIG_ADDRESS`, `TIMELOCK_DELAY` | existente |
| `doc/sdd/121-.../` | Crear | Artefactos NexusAgil | — |

> **Nota Dev (lección WKH-126b auto-blindaje):** la interfaz TS de 126b
> (`src/adapters/escrow/abi.ts` + `eip712.ts`) es un **segundo gate de coherencia**
> análogo al "TS union vs DB constraint". Si surge una divergencia inevitable
> (ej. nombre de un parámetro), **NO** se resuelve tocando `src/` en esta wave;
> se documenta como desvío VERIFY-AT-IMPL y se deja para la tarea de cierre (DT-9/CD-1).
> El Dev NO toca `src/` en F3.

### 4.2 Modelo de datos — Storage layout del contrato (concreto)

```
// === Storage (UUPS-safe; orden estable, gap al final) ===
IERC20  usdc;                                  // token único (DT-6, CD-5) — set en initialize
uint256 upgradeTimelock;                       // UPGRADE_TIMELOCK en segundos (AC-12)
bool    upgradeRenounced;                      // true => upgrade desactivado permanentemente (AC-12)

mapping(bytes32 => uint256) balances;          // keyId => saldo USDC (atómico, 6 dec)
mapping(bytes32 => address) depositor;         // keyId => owner inmutable (DT-10 / CD-8 / NC-1)
mapping(bytes32 => uint256) lockedAmount;      // keyId => fondos comprometidos (DT-11 / NC-2) — ver decisión
mapping(bytes32 => mapping(uint256 => bool)) usedNonces;  // keyId => nonce => usado (CD-3 anti-replay)

// timelock de upgrade (AC-12, opción simplificada — ver DT-12)
mapping(bytes32 => uint256) upgradeProposedAt; // keccak(newImpl) => timestamp de propuesta

uint256[44] __gap;                             // reserva para futuros campos sin romper layout
```

**Decisiones de storage:**
- `usedNonces[keyId][nonce]` (bitmap-style mapping) en vez de `nextNonce` monotónico:
  el work-item AC-2 menciona ambas políticas; se elige **nonce arbitrario marcado usado**
  porque la firma de 126b es por-ventana (DT-3) y no necesariamente secuencial — un
  `usedNonces` mapping es más flexible y sigue siendo irrevocable (CD-3). **Esto es una
  decisión nueva: DT-13.**
- `lockedAmount` está declarado en storage **aunque la decisión NC-2 (DT-11) sea
  modelo optimista** — se reserva el slot para una futura activación del lock explícito
  sin romper el layout. En el modelo elegido, `lockedAmount[keyId]` queda en `0` (ver DT-11).
- `__gap` de 44 slots: reserva estándar OZ para upgradeability segura.

### 4.3 EIP-712 on-chain (convergencia byte-a-byte con 126b — CD-1)

```
// Typehash — DEBE ser exactamente este string (mismo orden de campos que DEBIT_AUTHORIZATION_TYPES)
bytes32 constant DEBIT_AUTHORIZATION_TYPEHASH =
    keccak256("DebitAuthorization(bytes32 keyId,uint256 amount,uint256 deadline,uint256 nonce)");
// Valor esperado (verificado en este SDD): 0x5feea67fe2f683c18d6addd1eaab3f2152293b5512c90fdd3f702e973a2328f5
```

- **Domain**: vía `__EIP712_init("WasiAIEscrow", "1")` de `EIP712Upgradeable`.
  OZ construye el separator con `name`, `version`, `block.chainid` y `address(this)`
  (= `verifyingContract`) dinámicamente. **CD-5 cumplido**: chainId NO hardcodeado.
  Coincide con `buildDebitDomain` de eip712.ts (`name='WasiAIEscrow'`, `version='1'`,
  `chainId`, `verifyingContract`).
- **Verificación de firma** (en `debit` y por elemento en `debitBatch`):
  1. `structHash = keccak256(abi.encode(DEBIT_AUTHORIZATION_TYPEHASH, keyId, amount, deadline, nonce))`
  2. `digest = _hashTypedDataV4(structHash)` (OZ — aplica domain separator)
  3. `recovered = ECDSA.recover(digest, signature)`
  4. `require(recovered == depositor[keyId], InvalidSignature())`
- El **nonce** es parte del struct firmado (no se infiere on-chain); el contrato lo lee del
  argumento y lo valida contra `usedNonces`. **El argumento `nonce` debe entrar a la firma
  EXACTAMENTE** — si no, `ECDSA.recover` daría una address distinta (test obligatorio).

> **Punto fino de ABI (DT-9 / CD-1):** la `debit` canónica de abi.ts NO expone `nonce` ni
> `keyId-nonce` como argumento separado — la firma `debit(bytes32,uint256,uint256,bytes)`
> incluye solo `keyId, amount, deadline, signature`. **El `nonce` viaja DENTRO de la
> firma, no como argumento de la función `debit` single.** Esto obliga a una decisión de
> diseño on-chain: ¿cómo conoce el contrato el `nonce` para verificar la firma si no es un
> argumento? → **DT-14** (abajo). Es la única divergencia estructural potencial con 126b y
> se resuelve sin tocar el ABI de la `debit` single.

### 4.4 Flujo principal (Happy Path)

1. **Fondeo**: agente hace `usdc.approve(escrow, amount)` (tx 1, paga gas) → `escrow.deposit(keyId, amount)` (tx 2, paga gas). Si es el primer deposit del `keyId`, se fija `depositor[keyId] = msg.sender` (DT-10). `balances[keyId] += amount`. Emite `Deposited`.
2. **Gasto off-chain** (no es esta HU): el gateway 126b debita en DB; al cierre de ventana arma el neto.
3. **Firma**: el agente (o session/operator key delegada) firma off-chain una `DebitAuthorization{keyId, amount(neto), deadline, nonce}` (gratis). 126b ya lo hace (`buildDebitAuthorization`).
4. **Settlement**: el operador llama `debitBatch([keyIds], [amounts], deadline, [signatures])` (paga gas). Por cada elemento: valida deadline, recover==depositor, nonce no usado; aplica CEI (debita balance, marca nonce, transfiere USDC al operador). Atómico (AC-3).
5. **Withdraw**: el agente llama `withdraw(keyId, amount)` con `amount <= balances[keyId] - lockedAmount[keyId]`. Transfiere USDC al agente (CEI).

### 4.5 Flujo de error

| Condición | Custom error | AC |
|-----------|--------------|----|
| `amount == 0` en deposit | `ZeroAmount` | AC-1 (guard) |
| segunda address intenta reclamar keyId | `DepositorMismatch` | DT-10 / CD-8 / AC-8-análogo |
| firma no del depositor | `InvalidSignature` | AC-4 |
| `block.timestamp > deadline` | `DeadlineExpired` | AC-5 |
| nonce ya usado | `NonceAlreadyUsed` | AC-6 |
| `amount > balances - locked` en withdraw | `InsufficientBalance` | AC-7 |
| `msg.sender != depositor` en withdraw | `Unauthorized` | AC-8 |
| arrays de distinta longitud en batch | `LengthMismatch` | AC-3 |
| saldo insuficiente en un elemento del batch → revierte todo | `InsufficientBalance` | AC-3 |
| upgrade antes del timelock o desde no-owner | `TimelockNotElapsed` / `OwnableUnauthorizedAccount` | AC-12 |
| upgrade tras renounce | `UpgradeRenounced` | AC-12 |

---

## 5. Constraint Directives (Anti-Alucinación)

### Heredados del work-item (8)

- **CD-1 — Convergencia EIP-712 byte-a-byte con 126b.** Typehash = `keccak256("DebitAuthorization(bytes32 keyId,uint256 amount,uint256 deadline,uint256 nonce)")` (= `0x5feea6…2328f5`). PROHIBIDO omitir/reordenar `nonce` sin actualizar simultáneamente `DEBIT_AUTHORIZATION_TYPES` de 126b.
- **CD-2 — El operador NUNCA retira sin firma del agente.** PROHIBIDO cualquier path que mueva `balances[keyId]` hacia un tercero sin `DebitAuthorization` firmada por `depositor[keyId]`. Verificable por invariant fuzzing.
- **CD-3 — Nonce anti-replay obligatorio.** `usedNonces[keyId][nonce]` irrevocable; revertir `NonceAlreadyUsed` en replay.
- **CD-4 — CEI + reentrancy guard.** Actualizar balances ANTES de transferir. `nonReentrant` en deposit/withdraw/debit/debitBatch. SafeERC20.
- **CD-5 — Sin hardcodes de USDC ni chainId.** USDC vía `initialize`; `block.chainid` dinámico (lo aporta OZ EIP712).
- **CD-6 — Foundry puro, sin Hardhat.** `forge build`/`forge test`. PROHIBIDO `hardhat.config.*` o deps NPM en `contracts/`. Deps vía `forge install` (submodules en `lib/`).
- **CD-7 — Cobertura.** ≥1 test por AC; revert tests con `vm.expectRevert(WasiAIEscrow.X.selector)`; batch atómico testeado; `forge coverage >= 95%` líneas del contrato principal.
- **CD-8 — `depositor[keyId]` fijo en el primer deposit.** PROHIBIDO que una segunda address reclame un keyId. (Resuelto en DT-10.)

### Específicos del SDD / heredados de Auto-Blindaje histórico

- **CD-9 — Layout UUPS estable.** PROHIBIDO reordenar/eliminar variables de storage; agregar solo al final consumiendo `__gap`. El orden de §4.2 es contractual.
- **CD-10 — `via_ir` solo si `forge build` falla por "stack too deep".** No activar por defecto sin necesidad; documentar en `foundry.toml` si se usa. Mantener el optimizer determinista.
- **CD-11 — No `address(token).transfer` crudo.** Solo `SafeERC20.safeTransfer`/`safeTransferFrom`.
- **CD-12 (de WKH-126b auto-blindaje) — Coherencia cross-surface es un gate separado.** El typehash/ABI Solidity y `DEBIT_AUTHORIZATION_TYPES`/`ESCROW_ABI` de 126b son DOS superficies independientes. PROHIBIDO asumir que compilar Solidity garantiza convergencia con el TS. La convergencia se verifica explícitamente (test que reproduce el typehash + chequeo manual del ABI surface). Si hay divergencia inevitable, documentarla VERIFY-AT-IMPL, NO tocar `src/` en F3. Referencia: WKH-126b auto-blindaje#1.
- **CD-13 (de WKH-SEC-02 auto-blindaje) — Aserciones de test robustas, no por substring.** En tests que cuenten o matcheen estructura (ej. nº de eventos, selectores), usar matchers exactos (`vm.expectEmit`, selector `.selector`), NO `contains`/substring sobre strings. Referencia: WKH-SEC-02 auto-blindaje#1.
- **CD-14 (de WKH-125b auto-blindaje) — Separar fallos propios de pre-existentes.** `forge fmt --check` y coverage se evalúan sobre los archivos de `contracts/` (subproyecto nuevo, aislado). Como `contracts/` no existía, todo fallo es propio — no hay deuda pre-existente que excluir aquí, pero el Dev NO debe "arreglar" nada fuera de `contracts/`. Referencia: WKH-125b auto-blindaje#2.

### PROHIBIDO (resumen)
- NO hardcodear USDC, chainId, multisig, ni timelock en el contrato.
- NO agregar deps NPM/Hardhat en `contracts/`.
- NO tocar `src/` (TS de 126b) en F3 — la sincronización ABI es tarea de cierre post-merge.
- NO usar `ethers` (irrelevante: es Solidity; pero el deploy script es Foundry, no Hardhat).
- NO `delegatecall`/`selfdestruct`/`tx.origin` en lógica de fondos.
- NO permitir débito o withdraw que deje `sum(balances) > token.balanceOf(this)` (insolvencia).

---

## 6. Scope

**IN:**
- `contracts/` subproyecto Foundry completo (config, deps OZ, contrato, interfaz, mock USDC, tests unit + invariant, deploy script).
- `.env.example`: vars de deploy Base Sepolia.
- Artefactos NexusAgil en `doc/sdd/121-.../`.
- Verificación explícita de convergencia EIP-712/ABI con 126b (test de typehash + chequeo manual).

**OUT:**
- Deploy mainnet (Base/Avalanche/Kite). Auditoría externa. Otras redes.
- Gasless deposit (permit/EIP-3009). Scheduler off-chain del operador.
- Cambios a `src/` del gateway TS (126b). La actualización del ABI TS si hubo divergencia es **tarea de cierre de la HU**, no de F3.
- Multi-token / gobernanza multi-token.

---

## 7. Waves de Implementación

### Wave 0 — Scaffold Foundry (Serial Gate)
- [ ] W0.1: Crear `contracts/` y correr `forge init --no-git` (o estructura manual) sin commitear el ejemplo `Counter`.
- [ ] W0.2: `forge install foundry-rs/forge-std`, `OpenZeppelin/openzeppelin-contracts@v5.x`, `OpenZeppelin/openzeppelin-contracts-upgradeable@v5.x` (submodules en `lib/`).
- [ ] W0.3: `foundry.toml` (solc, optimizer, paths) + `remappings.txt`.
- [ ] W0.4: `contracts/test/mocks/MockUSDC.sol` (ERC-20 6-dec para tests).
- **Verificación W0**: `forge build` compila el scaffold + mock.

### Wave 1 — Contrato base: storage, deposit, escrowBalance, EIP-712 domain/typehash
- [ ] W1.1: `IWasiAIEscrow.sol` (interfaz + custom errors + event `Deposited`).
- [ ] W1.2: `WasiAIEscrow.sol` esqueleto: herencia OZ (`Initializable`, `UUPSUpgradeable`, `Ownable2StepUpgradeable`, `ReentrancyGuardUpgradeable`, `EIP712Upgradeable`), storage §4.2, `initialize(usdc, multisig, timelockDelay)`, constructor con `_disableInitializers()`.
- [ ] W1.3: `DEBIT_AUTHORIZATION_TYPEHASH` constante + `deposit` (CEI + SafeERC20 + DT-10 depositor lock) + `escrowBalance` view + `Deposited`.
- **Verificación W1**: `forge build` + test de typehash == `0x5feea6…2328f5`, test de deposit/depositor-lock.

### Wave 2 — Debit + debitBatch + verificación de firma
- [ ] W2.1: helper interno `_verifyAndConsume(keyId, amount, deadline, nonce, signature)`: structHash → `_hashTypedDataV4` → `ECDSA.recover` → checks (deadline/recover/nonce) → marca nonce, debita balance (CEI).
- [ ] W2.2: `debit(...)` single (DT-14 para el `nonce`) + `debitBatch(...)` (loop atómico, `LengthMismatch`, sin estado parcial — todo en una tx revierte por defecto si un require falla).
- [ ] W2.3: transferencia al operador (`msg.sender`) vía SafeERC20 tras los effects.
- **Verificación W2**: tests AC-2..AC-6, batch atómico, replay, deadline.

### Wave 3 — Withdraw + lock (DT-11) + UUPS/owner/timelock/renounce
- [ ] W3.1: `withdraw(keyId, amount)` con `Unauthorized` + `InsufficientBalance` (usa `balances - lockedAmount`; en modelo optimista `lockedAmount==0`).
- [ ] W3.2: `_authorizeUpgrade` (onlyOwner + timelock + not-renounced) + `proposeUpgrade(newImpl)` (registra `upgradeProposedAt`) + `renounceUpgrade()` (setea `upgradeRenounced=true`). Owner = multisig (set en initialize via `__Ownable_init(multisig)`).
- **Verificación W3**: tests AC-7, AC-8, AC-9, AC-12.

### Wave 4 — Tests (unit por AC + invariant fuzzing)
- [ ] W4.1: `WasiAIEscrow.t.sol` — ≥1 test por AC (12), revert tests con `.selector`, batch atómico, typehash convergencia.
- [ ] W4.2: `WasiAIEscrow.invariant.t.sol` — handler-based: invariantes (a) `usdc.balanceOf(escrow) >= sum(balances de keyIds tocados)` (solvencia), (b) no existe secuencia de calls del operador (sin firma) que reduzca `balances[keyId]` (CD-2).
- [ ] W4.3: `forge coverage` → asegurar ≥95% líneas de `WasiAIEscrow.sol`.
- **Verificación W4**: `forge test` verde, `forge coverage` ≥95%.

### Wave 5 — Deploy script Base Sepolia
- [ ] W5.1: `Deploy.s.sol` — deploy impl, deploy `ERC1967Proxy(impl, initData)` con `initialize(USDC_BASE_SEPOLIA, MULTISIG_ADDRESS, TIMELOCK_DELAY)`; lee de env. `forge script ... --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast` (no se ejecuta el broadcast real en F3 sin secrets; se valida que el script compila y simula).
- [ ] W5.2: `.env.example` con las 5 vars.
- **Verificación W5**: `forge build` del script + `forge script --sig 'run()'` dry-run (sin `--broadcast`).

### Dependencias entre waves

| Wave | Depende de | Razón |
|------|-----------|-------|
| W1 | W0 | Necesita OZ instalado y compilando |
| W2 | W1 | Usa typehash + storage + depositor |
| W3 | W1, W2 | Usa balances + lockedAmount + verifica que debit no rompe withdraw |
| W4 | W1–W3 | Testea todo |
| W5 | W1 (interfaz estable) | Deploy del contrato final |

---

## 8. Test Plan

| Test | AC que cubre | Wave | Tipo |
|------|--------------|------|------|
| `test_Deposit_creditsBalance_emitsEvent` | AC-1 | W1 | unit (`vm.expectEmit`) |
| `test_Deposit_firstSetsDepositor_immutable` | DT-10/CD-8 | W1 | unit |
| `test_RevertWhen_SecondDepositorClaimsKeyId` | DT-10/CD-8 | W1 | revert (`DepositorMismatch.selector`) |
| `test_Typehash_matchesCanonical` | CD-1 | W1 | unit (assert `== 0x5feea6…2328f5`) |
| `test_Debit_validSig_debits_transfersToOperator` | AC-2 | W2 | unit |
| `test_DebitBatch_allValid_atomic` | AC-3 | W2 | unit |
| `test_RevertWhen_DebitBatch_oneElementFails_noPartial` | AC-3 | W2 | revert + balance unchanged |
| `test_RevertWhen_InvalidSignature` | AC-4 | W2 | revert (`InvalidSignature.selector`) |
| `test_RevertWhen_DeadlineExpired` | AC-5 | W2 | revert (`DeadlineExpired.selector`) |
| `test_RevertWhen_NonceReplay` | AC-6 | W2 | revert (`NonceAlreadyUsed.selector`) |
| `test_Withdraw_freeBalance_byDepositor` | AC-7 | W3 | unit |
| `test_RevertWhen_Withdraw_byNonDepositor` | AC-8 | W3 | revert (`Unauthorized.selector`) |
| `test_RevertWhen_Withdraw_exceedsAvailable` | AC-7/AC-9 | W3 | revert (`InsufficientBalance.selector`) |
| `test_OperatorCannotWithdrawWithoutSignature` | AC-9/CD-2 | W3 | unit (path negativo explícito) |
| `test_OnlyUSDC_noOtherTokenPath` | AC-11 | W3 | unit (no existe función que reciba otro token) |
| `test_Upgrade_requiresTimelockAndOwner` | AC-12 | W3 | unit + revert |
| `test_RenounceUpgrade_freezesPermanently` | AC-12 | W3 | revert (`UpgradeRenounced.selector`) |
| `invariant_solvency_balanceGteSumBalances` | CD-2 (solvencia) | W4 | invariant fuzz |
| `invariant_operatorCannotDrainWithoutSig` | CD-2 | W4 | invariant fuzz |

> Cobertura objetivo: `forge coverage` ≥95% líneas de `WasiAIEscrow.sol` (CD-7).

---

## 9. Dependencias

- Foundry 1.5.1 (verificado). 
- OZ Contracts + Contracts-Upgradeable v5.x vía `forge install` (W0).
- Interfaz TS de 126b (`abi.ts` + `eip712.ts`) como contrato de forma (ya en repo, DONE).
- Para deploy real (fuera de F3): `BASE_SEPOLIA_RPC_URL`, `DEPLOYER_PRIVATE_KEY`, `USDC_BASE_SEPOLIA`, `MULTISIG_ADDRESS`, `TIMELOCK_DELAY` en `.env` (no en código, CD-5).

---

## 10. Resolución de los 2 [NEEDS CLARIFICATION] (decisiones de F2)

### DT-10 — NC-1: `depositor[keyId]` INMUTABLE desde el primer deposit ✅ resuelto por architect

**Decisión:** el `depositor[keyId]` se fija al `msg.sender` del **primer** `deposit(keyId, ...)`
y es **inmutable**. Depósitos subsiguientes al mismo `keyId` solo se aceptan si
`msg.sender == depositor[keyId]`; cualquier otra address revierte con `DepositorMismatch`.

**Por qué (grounding):**
- **Seguridad anti-takeover (CD-8 lo exige):** si cualquier address pudiera depositar a un
  `keyId` existente y eso cambiara/compartiera la ownership, un atacante podría inyectar fondos
  para enturbiar la contabilidad o, peor, si el modelo permitiera multi-depositor con retiro
  proporcional, reclamar saldo ajeno. Inmutable cierra el vector.
- **Coherencia con la firma EIP-712:** `debit` valida `recovered == depositor[keyId]`. Si el
  depositor fuera mutable o múltiple, la verificación de firma se vuelve ambigua (¿la firma de
  cuál depositor?). Inmutable mantiene un único firmante autorizado por keyId — exactamente lo
  que 126b asume (`buildDebitAuthorization` firma con UNA key por keyId).
- **Costo:** un tercero NO puede fondear en nombre del agente on-chain a ese keyId. Aceptable:
  el fondeo "en nombre de" es un caso de onboarding gasless, explícitamente OUT (DT-4/Scope OUT).

**Implementación:** en `deposit`, si `depositor[keyId] == address(0)` → set `= msg.sender`;
else `require(msg.sender == depositor[keyId], DepositorMismatch())`.

---

### DT-11 — NC-2: Mecánica del lock de withdraw → **Modelo OPTIMISTA (opción a)** con `lockedAmount` reservado en storage ✅ resuelto por architect

**Decisión:** `withdraw` valida `amount <= balances[keyId] - lockedAmount[keyId]`, pero en
esta HU **`lockedAmount[keyId]` permanece en `0`** (no hay lock on-chain explícito). El
contrato es **optimista/implícito**: el agente es responsable de no firmar `DebitAuthorization`
por más de su saldo, y el operador presenta los débitos. Es la **opción (a)** del work-item.

**Por qué (tradeoff explícito):**
- El contrato **no ve la firma off-chain** hasta que el operador la presenta (DT-3), así que
  **no puede lockear contra una firma que no conoce**. Un lock on-chain real (opción b)
  requeriría un paso `lock`/`reserve` adicional (2 tx, más gas para el operador) o que el
  agente declare un lock — ambos contradicen el modelo "el agente firma gratis, el operador
  presenta en lote" (gas-settlement-economics.md) y agregan complejidad y superficie de bug
  en una HU ya grande (L) sobre custodia de dinero.
- La opción (c) (challenge period / delay en withdraw) degrada la UX del agente (no puede
  retirar al instante) y agrega un reloj on-chain — sobredimensionado para **testnet/beta**.
- **(a) es la que mejor balancea seguridad vs complejidad para testnet/beta.**

**Riesgo residual (griefing del vendor) — documentado:**
> Con el modelo optimista, un **agente malicioso puede front-runear** el `debitBatch` del
> operador con un `withdraw` que vacíe su `balances[keyId]` justo antes de que el débito se
> mine. Resultado: el débito del operador revierte por `InsufficientBalance` y el vendor no
> cobra ese neto. El agente NO roba fondos del operador (CD-2 intacto: el operador nunca tuvo
> más que la firma); el daño es que el vendor **no cobra un servicio ya prestado off-chain**
> (impago, no robo). Mitigaciones operativas (fuera de contrato): (1) settlement frecuente
> reduce la ventana; (2) reputación / suspensión del agente que griefea; (3) en mainnet, migrar
> a lock explícito (opción b) — por eso `lockedAmount` ya está en storage, listo para activarse
> sin romper el layout (CD-9).

**¿Escala al humano?** Es una **implicancia de producto** (riesgo de impago al vendor en
beta). El architect lo resuelve para **testnet/beta** (opción a es la decisión técnica
correcta para el alcance actual), **pero lo marca para visibilidad del humano** porque la
elección final para **mainnet** (activar lock explícito) es una decisión de producto/riesgo:

> **[NEEDS CLARIFICATION — humano (NO bloqueante para F2/testnet)]**: para **mainnet**, ¿se
> acepta el riesgo de griefing residual del modelo optimista, o se prioriza activar el lock
> on-chain explícito (opción b, paso `reserve`) antes del cutover a producción? Esta HU
> entrega el modelo optimista (correcto para testnet/beta) con el slot `lockedAmount` ya
> reservado. **No bloquea esta HU.** Avisar al orquestador para que el humano lo registre
> como decisión de roadmap mainnet.

---

### DT nuevos derivados (storage / nonce / ABI)

- **DT-12 — Timelock de upgrade simplificado (no `TimelockController` OZ).** Para testnet/beta
  se implementa timelock inline: `proposeUpgrade(newImpl)` registra `upgradeProposedAt[keccak(newImpl)] = block.timestamp`;
  `_authorizeUpgrade` exige `block.timestamp >= proposedAt + upgradeTimelock`, `onlyOwner` (multisig)
  y `!upgradeRenounced`. Evita la complejidad de integrar `TimelockController` como owner separado
  en una HU testnet. Mainnet puede migrar a `TimelockController` real (no rompe layout). Cumple AC-12.
- **DT-13 — Política de nonce: `usedNonces[keyId][nonce]` (arbitrario marcado usado), no monotónico.**
  Flexible para firmas por-ventana (DT-3), irrevocable (CD-3). El work-item AC-2 admite ambas;
  se elige esta por flexibilidad.
- **DT-14 — El `nonce` viaja en la firma, NO como argumento de `debit` single (convergencia ABI).**
  La `debit(bytes32,uint256,uint256,bytes)` de abi.ts NO tiene parámetro `nonce`. **Resolución:**
  la función `debit` single recibe `(keyId, amount, deadline, signature)` y el contrato deriva el
  `nonce` esperado como **`usedNonces`-aware sequential**: usa el siguiente nonce no consumido del
  `keyId`. PERO esto entra en tensión con DT-13 (nonce arbitrario). **Para evitar ambigüedad y
  mantener convergencia byte-a-byte sin tocar el ABI de 126b**, se decide:
  - La **`debit` single** se trata como `debitBatch` de un solo elemento internamente; el `nonce`
    se incluye en la firma y, para que el contrato lo conozca sin un parámetro, se **agrega una
    sobrecarga `debit(bytes32 keyId, uint256 amount, uint256 deadline, uint256 nonce, bytes signature)**
    como API canónica del settlement, y se **mantiene** la firma de 4 args de abi.ts como wrapper
    que asume `nonce = nextExpectedNonce(keyId)` (monotónico) SOLO si 126b la usa así.
  - **[DECISIÓN DE CIERRE / VERIFY-AT-IMPL]:** dado que 126b firma con `nonce` explícito
    (`buildDebitAuthorization` recibe `nonce`), lo más limpio es que el **ABI de `debit` exponga
    `nonce` como argumento** y se actualice abi.ts en la tarea de cierre (DT-9/CD-1). El Dev
    implementa `debit(bytes32,uint256,uint256,uint256,bytes)` (con `nonce`) + `debitBatch(...)`
    con arrays incluyendo `nonces[]`, y **documenta la divergencia con abi.ts/eip712.ts de 126b
    como VERIFY-AT-IMPL** (la `debit` de 4-args de abi.ts se actualiza a 5-args en cierre). NO se
    toca `src/` en F3. Esta es la **única divergencia estructural** y queda explícitamente trackeada.

  > **Nota para el Adversary/QA:** verificar que `debitBatch` reciba `nonces[]` y que el ABI
  > resultante se documente en el report como "abi.ts/eip712.ts requieren update de cierre:
  > `debit`/`debitBatch` exponen `nonce(s)` como argumento". Esto NO viola CD-1 porque el
  > **typehash y el orden de campos del struct firmado se mantienen idénticos**; lo que cambia
  > es la **firma de la función** `debit` (no el struct EIP-712), y se sincroniza en cierre.

---

## 11. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| Divergencia ABI `debit` (nonce como arg) con abi.ts de 126b | A | M | DT-14: documentar VERIFY-AT-IMPL, actualizar abi.ts/eip712.ts en cierre, NO tocar `src/` en F3. Typehash/struct intactos (CD-1 cumplido). |
| Griefing del vendor (withdraw front-run del debit) | M | M | DT-11: aceptado para testnet/beta; `lockedAmount` reservado; escalado a humano para mainnet. |
| `stack too deep` en `debitBatch` | M | B | CD-10: activar `via_ir` en `foundry.toml` solo si build falla. |
| Storage layout roto en futuro upgrade | B | A | CD-9 + `__gap[44]`. |
| Typehash mal computado (firma no recovers) | B | A | Test `test_Typehash_matchesCanonical` asserta `== 0x5feea6…2328f5`; test de recover con firma viem-generada. |
| Insolvencia (debit/withdraw deja balance < tokens) | B | A | invariant fuzzing de solvencia (W4). |
| OZ v5 API drift (nombres de init) | B | M | `forge install` pin a tag v5.x; el Dev verifica los paths reales en `lib/` antes de importar (no asumir). |

---

## 12. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| [NEEDS CLARIFICATION — humano] | DT-11 | Para **mainnet**: ¿aceptar griefing residual del modelo optimista o activar lock explícito (opción b) antes del cutover? Testnet/beta resuelto (opción a). | **NO** (roadmap mainnet, no bloquea esta HU) |
| [VERIFY-AT-IMPL] | DT-14 | `debit`/`debitBatch` exponen `nonce(s)` como argumento → abi.ts/eip712.ts de 126b se actualizan en **tarea de cierre** (DT-9/CD-1). Typehash/struct sin cambios. | NO (tarea de cierre, no F3) |
| [VERIFY-AT-IMPL] | §7 W0 | Tags exactos de OZ v5.x los fija el Dev al `forge install`; verificar paths reales en `lib/` antes de importar. | NO |

> Gate: **no hay [NEEDS CLARIFICATION] bloqueante de F2.** Los dos NC del work-item están
> resueltos (DT-10 inmutable; DT-11 optimista). El único marker que toca al humano es de
> **roadmap mainnet**, explícitamente no bloqueante.

---

## 13. Implementation Readiness Check

```
READINESS CHECK:
[x] Cada AC (12) tiene al menos 1 test asociado (tabla §8)
[x] Cada archivo en §4.1 tiene un Exemplar válido (OZ v5 / forge-std / interfaz TS 126b)
[x] No hay [NEEDS CLARIFICATION] BLOQUEANTE pendiente (NC-1/NC-2 resueltos; el de mainnet es no-bloqueante)
[x] Constraint Directives incluyen >3 PROHIBIDO (CD-1..CD-14 + §5 PROHIBIDO)
[x] Context Map tiene >2 archivos leídos (work-item, eip712.ts, abi.ts, gas-settlement, project-context, 3 auto-blindajes)
[x] Scope IN y OUT explícitos (§6)
[x] "BD"/storage layout verificado y concreto (§4.2)
[x] Happy Path completo (§4.4)
[x] Flujo de error definido (§4.5, tabla de custom errors)
[x] Typehash verificado byte-a-byte vs 126b: 0x5feea67fe2f683c18d6addd1eaab3f2152293b5512c90fdd3f702e973a2328f5
[x] forge disponible (1.5.1) y contracts/ confirmado inexistente (se crea en W0)
[x] Lecciones de Auto-Blindaje histórico aplicadas (CD-12/CD-13/CD-14)
```

**SDD listo para SPEC_APPROVED.**

---

*SDD generado por NexusAgil — Architect F2 — 2026-06-22 — WKH-126a. NNN: 121.*
