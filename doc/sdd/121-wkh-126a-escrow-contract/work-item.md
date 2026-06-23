# Work Item — [WKH-126a] Contrato Solidity del Escrow No-Custodial (Foundry)

## Resumen

Construcción del contrato Solidity `WasiAIEscrow` — el smart contract que WKH-126b
consume via ABI/EIP-712 provisional. El contrato implementa escrow no-custodial
prepago de USDC por Agent Key: el agente deposita (`deposit`), el operador debita
el neto acumulado en lote (`debitBatch`) contra una firma EIP-712 del agente
(`DebitAuthorization`), y el agente puede retirar su saldo libre en cualquier
momento (`withdraw`). El operador NUNCA puede mover fondos sin firma del agente.
Upgradeable con timelock + multisig (proxy) para beta/testnet; diseñado para
renunciar al upgrade antes de mainnet. Scope: Base Sepolia testnet únicamente.

---

## Sizing

- **SDD_MODE**: full
- **Estimación**: L
- **Flow**: QUALITY (money-custody + upgradeable + EIP-712 + Foundry desde cero)
- **Branch sugerido**: `feat/121-wkh-126a-escrow-contract`

---

## Acceptance Criteria (EARS)

**AC-1**: WHEN un agente llama `deposit(keyId, amount)` con `amount > 0` USDC
previamente aprobado (`ERC-20 approve`), THEN the system SHALL transferir exactamente
`amount` tokens al contrato, acreditar `balances[keyId] += amount`, y emitir
`Deposited(msg.sender, keyId, amount)`.

**AC-2**: WHEN `debit(keyId, amount, deadline, signature)` es llamada con una
firma EIP-712 `DebitAuthorization` válida cuyo `recovered == depositor[keyId]`
y `block.timestamp <= deadline` y `nonce == usedNonces[keyId] + 1` (o política
de nonce definida en F2), THEN the system SHALL debitar `balances[keyId] -= amount`,
marcar el nonce como usado, y transferir `amount` USDC al operador (`msg.sender`).

**AC-3**: WHEN `debitBatch(keyIds[], amounts[], deadline, signatures[])` es
llamada con arrays de igual longitud y todas las firmas EIP-712 válidas para sus
respectivos keyId/amount/deadline/nonce, THEN the system SHALL ejecutar todos los
débitos en la misma tx atómicamente: si cualquier elemento falla (firma inválida,
deadline expirado, saldo insuficiente, nonce replay), THEN the system SHALL revertir
la tx completa sin aplicar ningún débito parcial.

**AC-4**: IF `signature` en `debit`/`debitBatch` no es firmada por el `depositor`
registrado para ese `keyId` (recovered != depositor[keyId]), THEN the system SHALL
revertir con error `InvalidSignature`.

**AC-5**: IF `block.timestamp > deadline` en `debit`/`debitBatch`, THEN the system
SHALL revertir con error `DeadlineExpired` sin modificar balances.

**AC-6**: IF el nonce de la `DebitAuthorization` ya fue usado para ese `keyId`,
THEN the system SHALL revertir con error `NonceAlreadyUsed`, previniendo replay
de la misma autorización de débito.

**AC-7**: WHEN un agente llama `withdraw(keyId, amount)` siendo `msg.sender ==
depositor[keyId]` y `amount <= balances[keyId] - lockedAmount[keyId]`, THEN the
system SHALL transferir `amount` USDC al agente y actualizar `balances[keyId]`.

**AC-8**: IF `msg.sender != depositor[keyId]` en cualquier llamada a `withdraw`,
THEN the system SHALL revertir con error `Unauthorized`.

**AC-9**: WHILE el operador no posee una firma `DebitAuthorization` válida del
agente para `keyId`, the system SHALL NOT permitir que ninguna dirección distinta
al propio agente (`depositor[keyId]`) retire fondos de `balances[keyId]`.

**AC-10**: WHEN `escrowBalance(keyId)` es consultado, the system SHALL retornar
el saldo actual `balances[keyId]` sin modificar estado (view).

**AC-11**: WHEN el contrato recibe USDC via `deposit`, the system SHALL verificar
que el token es exactamente `USDC_TOKEN` (la dirección configurada en el
constructor/inicializador) y revertir si se intenta depositar cualquier otro token.

**AC-12**: WHILE el contrato está en modo upgradeable (proxy), the system SHALL
requerir que cualquier `upgradeTo` pase un timelock de al menos `UPGRADE_TIMELOCK`
segundos y sea ejecutado desde la cuenta multisig designada. IF se llama
`renounceUpgrade()`, THEN the system SHALL desactivar permanentemente el mecanismo
de upgrade (UUPS: renunciar al `owner`).

---

## Scope IN

| Artefacto | Descripción |
|-----------|-------------|
| `contracts/src/WasiAIEscrow.sol` | Contrato principal — lógica de deposit/debit/debitBatch/withdraw/escrowBalance + EIP-712 + ownership guard + reentrancy guard |
| `contracts/src/interfaces/IWasiAIEscrow.sol` | Interfaz pública del contrato (ABI surface explícita) |
| `contracts/src/libraries/` | Helpers Solidity internos si aplica (ej. validación de firma EIP-712, batch logic) |
| `contracts/test/WasiAIEscrow.t.sol` | Test suite Foundry (`forge test`) — cobertura de todos los ACs + paths de revert |
| `contracts/test/WasiAIEscrow.invariant.t.sol` | Invariant tests (fuzzing): `sum(balances) == totalDeposited - totalDebited`, operador no puede retirar sin firma |
| `contracts/script/Deploy.s.sol` | Script de deploy a Base Sepolia testnet (con proxy UUPS + timelock + multisig) |
| `contracts/foundry.toml` | Config Foundry del subproyecto |
| `contracts/remappings.txt` | Remappings de dependencias (OpenZeppelin, etc.) |
| `contracts/lib/` | Dependencias Foundry (git submodules: OpenZeppelin Contracts Upgradeable, etc.) |
| `.env.example` | Añadir vars: `BASE_SEPOLIA_RPC_URL`, `DEPLOYER_PRIVATE_KEY`, `USDC_BASE_SEPOLIA`, `MULTISIG_ADDRESS`, `TIMELOCK_DELAY` |
| `doc/sdd/121-wkh-126a-escrow-contract/` | Artefactos NexusAgil de esta HU |

---

## Scope OUT

- Deploy a mainnet (Base, Avalanche, Kite) — fuera de scope
- Auditoría externa del contrato — prerequisito para mainnet, no cubre esta HU
- Replicación a Kite/Avalanche — HU posterior
- Gasless deposit (EIP-2612 permit / EIP-3009) — fuera de scope; el agente paga gas del depósito (DT-5)
- Integración TypeScript del gateway (WKH-126b — ya DONE, mergeada)
- Cambios a `src/` del gateway (TypeScript) — WKH-126b es la única HU que toca TS; esta HU solo entrega el contrato que 126b consume
- Interfaz de gobernanza multi-token — solo USDC (DT-7)
- Frontend / UI de fondeo
- Off-chain job de settlement (scheduling del operador para llamar `debitBatch`) — es operacional, no es código de esta HU

---

## Decisiones Técnicas (DT-N)

**DT-1 — Settlement en lote, no por pago.**
El contrato DEBE soportar `debitBatch(bytes32[] keyIds, uint256[] amounts, uint256 deadline, bytes[] signatures)` para liquidar múltiples keyId en una tx. Esto amortiza el gas del operador (quien paga el gas del debit, según gas-settlement-economics.md). La función `debit` single también se mantiene por compatibilidad con la ABI de 126b.

**DT-2 — El debit lo dispara el operador (job externo).**
`debit`/`debitBatch` son callable por cualquier address (no se restringe a `onlyOwner`) dado que requieren firma del agente — la auth es la firma EIP-712, no el `msg.sender`. El job del operador es off-chain; esta HU no implementa el scheduler.

**DT-3 — El agente firma el NETO acumulado por ventana (no una firma por débito).**
La `DebitAuthorization` representa el monto neto autorizado por el agente para una ventana de settlement. El nonce previene replay del mismo neto: una vez que el operador presenta la autorización para `nonce=N`, no puede re-presentar la misma firma. La política exacta del nonce (monotónico vs. aleatorio) se define en F2; aquí se lockea que DEBE existir anti-replay via nonce.

**DT-4 — El agente paga el gas del depósito.**
`deposit()` es una tx normal del agente. Gasless (`permit`/`transferWithAuthorization`) es opción futura — fuera de scope de esta HU.

**DT-5 — Withdraw del saldo LIBRE con lock de pendientes.**
El agente puede retirar en cualquier momento el saldo no comprometido: `withdraw(keyId, amount)` donde `amount <= balances[keyId] - lockedAmount[keyId]`. El `lockedAmount` cubre las autorizaciones de débito firmadas pero aún no presentadas on-chain. La mecánica exacta del lock (si es on-chain o implícita por el balance disponible) se define en F2 — lo que se lockea aquí es que el operador NO puede retener fondos más allá de lo autorizado.

**DT-6 — Token único: USDC (una dirección por red).**
El contrato recibe una dirección `usdc` en el inicializador (proxy) y rechaza cualquier otro token. No hay multi-token en esta HU.

**DT-7 — Upgradeable UUPS con timelock + multisig; renunciable.**
Se usa patrón UUPS (OpenZeppelin `UUPSUpgradeable`) con `Ownable2StepUpgradeable`. El `owner` debe ser una cuenta multisig (no el deployer EOA). Se implementa un timelock mínimo sobre upgrades. Antes de mainnet, el owner llama `renounceOwnership()` (o equivalente) para congelar el contrato permanentemente. El F2 define el timelock concreto y si se integra `TimelockController` de OZ o se implementa una versión simplificada.

**DT-8 — Una sola red: Base Sepolia testnet.**
El deploy script apunta a Base Sepolia (chainId 84532). Replicación a Kite/Avalanche es HU futura.

**DT-9 — Convergencia ABI/EIP-712 byte-a-byte con WKH-126b.**
El contrato DEBE implementar exactamente:
- `event Deposited(address indexed depositor, bytes32 indexed keyId, uint256 amount)`
- `function deposit(bytes32 keyId, uint256 amount)`
- `function debit(bytes32 keyId, uint256 amount, uint256 deadline, bytes signature)`
- `function escrowBalance(bytes32 keyId) view returns (uint256)`
- Dominio EIP-712: `name="WasiAIEscrow"`, `version="1"`, `chainId`, `verifyingContract=address(this)`
- Struct: `DebitAuthorization { bytes32 keyId; uint256 amount; uint256 deadline; uint256 nonce; }`
- `keyId` on-chain = `keccak256(abi.encodePacked(uuid_utf8_bytes))` — mismo que `keccak256(stringToBytes(uuid))` en 126b

Cualquier divergencia con `src/adapters/escrow/abi.ts` y `src/adapters/escrow/eip712.ts` debe
actualizarse en AMBOS lados antes de marcar la HU done.

---

## Constraint Directives (CD-N)

**CD-1 — Convergencia EIP-712 byte-a-byte con 126b.**
OBLIGATORIO que el typehash del contrato Solidity sea `keccak256("DebitAuthorization(bytes32 keyId,uint256 amount,uint256 deadline,uint256 nonce)")` — exactamente ese string, mismo orden de campos que en `DEBIT_AUTHORIZATION_TYPES` de `src/adapters/escrow/eip712.ts`. PROHIBIDO omitir `nonce` o reordenar campos sin actualizar simultáneamente el TS de 126b.

**CD-2 — El operador NUNCA puede retirar sin firma del agente.**
PROHIBIDO cualquier path en el contrato que permita al `owner`/operador mover fondos de `balances[keyId]` sin una `DebitAuthorization` firmada por el `depositor[keyId]`. Esta invariante debe ser verificable via invariant fuzzing (ver Scope IN: `WasiAIEscrow.invariant.t.sol`).

**CD-3 — Nonce anti-replay obligatorio.**
OBLIGATORIO que el contrato mantenga un mapping de nonces usados por `keyId` y revierta con `NonceAlreadyUsed` si se reutiliza un nonce. El estado `usedNonces[keyId][nonce]` (o monotónico `nextNonce[keyId]`) debe ser irrevocable.

**CD-4 — Checks-Effects-Interactions + reentrancy guard.**
OBLIGATORIO aplicar el patrón CEI en `deposit`, `withdraw`, `debit`, `debitBatch`: actualizar balances ANTES de llamar al token ERC-20. OBLIGATORIO usar `ReentrancyGuardUpgradeable` de OpenZeppelin en las funciones que modifican balances y transfieren tokens.

**CD-5 — Sin hardcodes de dirección USDC o chain IDs.**
PROHIBIDO hardcodear la dirección del token USDC. Debe recibirse en el `initialize(address usdc, address multisig, uint256 timelockDelay)` del proxy. PROHIBIDO hardcodear `block.chainid` en el contrato (EIP-712 usa `block.chainid` dinámicamente).

**CD-6 — Foundry puro, sin Hardhat.**
El stack de build/test es `forge build` / `forge test`. PROHIBIDO agregar `hardhat.config.ts` o dependencias NPM en `contracts/`. Las dependencias Solidity se gestionan via `forge install` (git submodules en `contracts/lib/`).

**CD-7 — Cobertura de tests: todos los ACs + todos los paths de revert.**
Cada AC tiene al menos un test en `WasiAIEscrow.t.sol`. OBLIGATORIO testear los `revert` con expectativas de custom error (`vm.expectRevert(WasiAIEscrow.InvalidSignature.selector)`). OBLIGATORIO el test de `debitBatch` atómico (un elemento malo revierte todo). Cobertura mínima: `forge coverage` >= 95% de líneas del contrato principal.

**CD-8 — `depositor[keyId]` se registra en el primer `deposit`.**
El `depositor` de un `keyId` es el `msg.sender` del PRIMER `deposit(keyId, ...)`. Depósitos subsiguientes al mismo `keyId` aceptados solo si `msg.sender == depositor[keyId]` (o de cualquier address si el negocio lo permite — definir en F2, no asumir). PROHIBIDO que una segunda dirección reclaime un `keyId` existente.

---

## Missing Inputs

- [NEEDS CLARIFICATION] **Política de depósito multi-depositor**: ¿puede un `keyId` recibir depósitos de múltiples addresses (ej. el agente y el operador fondeando en su nombre), o el `depositor` queda fijado al primer depositante? Este determina si `depositor[keyId]` es inmutable tras el primer deposit. Si no se define, se lockea como "inmutable desde el primer deposit" (más seguro — definir en F2).

- [NEEDS CLARIFICATION] **Mecánica de `lockedAmount`**: ¿el contrato trackea on-chain las autorizaciones de débito pendientes (bloqueando `withdraw` por ese monto) o el lock es implícito (el agente no firma más de su saldo disponible y el contrato no trackea pendientes)? Si el lock es off-chain, `withdraw` simplemente valida `amount <= balances[keyId]` sin restricción adicional. Definir en F2 — afecta si `withdraw` puede vaciar el balance mientras hay un `DebitAuthorization` firmado no presentado.

Ambos son decisiones de dominio que el Architect puede proponer como DTs en F2 con opciones concretas — no bloquean el avance de F2.

---

## Análisis de paralelismo

- **WKH-126b** (NNN 117): DONE, mergeada. Esta HU (126a) es la hermana/prerequisito real del contrato — con 126b mergeada la integración TS ya tiene la interfaz provisional; esta HU la materializa.
- **Dependencia con 126b**: al completarse 126a, se debe actualizar `src/adapters/escrow/abi.ts` y `src/adapters/escrow/eip712.ts` si hubo divergencias entre la interfaz provisional de 126b y el contrato real (CD-1 / DT-9). Esta actualización es una tarea de cierre dentro de 126a.
- **No bloquea otras HUs activas** en el INDEX (las HUs 025, 026, 029-036 son features TS ortogonales al contrato Solidity).
- **Puede ir en paralelo con** cualquier HU que no toque `contracts/` — el subproyecto Foundry está completamente aislado en `contracts/` (sin dependencias desde `src/`).
- **Prerequisito para**: smoke E2E on-chain real (`writeContract debit(...)` de 126b, actualmente detrás de flag), y para cualquier HU de mainnet/otras redes.

---

*Analyst F1 — 2026-06-22 — WKH-126a. NNN: 121. Branch: feat/121-wkh-126a-escrow-contract.*
