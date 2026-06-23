# Code Review (CR) — WKH-126a: WasiAIEscrow.sol (Solidity / Foundry)

> Revisor: nexus-adversary (CR — calidad/patrones). Branch: `feat/121-wkh-126a-escrow-contract`.
> Foco: calidad Solidity, patrones OZ v5 upgradeable, mantenibilidad, honestidad de tests, gas, DT-14.
> Fecha: 2026-06-22.

## Veredicto: APROBADO con MENORs

- **BLOQUEANTES: 0**
- **MENORES: 5**
- Gates reales: **forge build OK (0 err/warn)** · **forge test 22/22 PASS** · **coverage WasiAIEscrow.sol 100% (60/60 líneas, 15/15 branches, 11/11 funcs)** · **forge fmt --check OK** · **tsc 0** · **vitest escrow 34/34 PASS (incluye eip712 + verifier + auth.escrow)** · **typehash canónico verificado con `cast keccak`**.

El contrato es de alta calidad: CEI estricto, SafeERC20 en todo path, nonReentrant en las 4 mutaciones que mueven tokens, EIP-712 vía OZ, layout UUPS con `__gap`, `_disableInitializers()` en constructor, owner = multisig en `initialize`, custom errors en toda la superficie de error. No encontré ningún hallazgo que comprometa seguridad o calidad al nivel de bloquear el gate.

---

## Checklist CR — resultado por punto

### 1. Patrones OZ v5 upgradeable — OK
- `constructor()` con `_disableInitializers()` y `@custom:oz-upgrades-unsafe-allow constructor` — `WasiAIEscrow.sol:49-52`. Correcto.
- `initializer` modifier en `initialize` — `:54`.
- Orden de `__*_init` correcto: `__UUPSUpgradeable_init` → `__Ownable_init(multisig)` → `__Ownable2Step_init` → `__ReentrancyGuard_init` → `__EIP712_init("WasiAIEscrow","1")` — `:56-60`. Sin dobles inicializaciones; `__Ownable_init` recibe el owner (API v5). El owner es el multisig, NO el deployer EOA (AC-12).
- Linearización de herencia (`Initializable, UUPSUpgradeable, Ownable2StepUpgradeable, ReentrancyGuardUpgradeable, EIP712Upgradeable, IWasiAIEscrow`) — `:18-25`. Coincide con el Story File.

### 2. Storage layout — OK
- Orden estable, mappings y escalares en el orden contractual del Story File §5 — `:34-44`.
- `uint256[44] private __gap` al final — `:44`. El tamaño es razonable (Ownable2Step/ReentrancyGuard/EIP712/UUPS aportan sus propios gaps vía namespaced storage ERC-7201 en v5, por lo que el `__gap` del contrato solo cubre los slots propios; 44 + 9 slots declarados ≈ 53 ≈ medio "bloque" estándar). No bloqueante.
- Custom errors (no require strings) en toda la superficie — `IWasiAIEscrow.sol:12-22`.

### 3. CEI / SafeERC20 — OK
- `using SafeERC20 for IERC20` — `:26`. Cero `IERC20.transfer` crudo (CD-11 cumplido).
- `deposit`: effects (`_balances += amount`) antes de `safeTransferFrom` — `:75-77`. `nonReentrant` — `:66`.
- `debit`/`debitBatch`: `_verifyAndConsume` aplica TODOS los effects (`_usedNonces=true`, `_balances-=amount`) antes de cualquier `safeTransfer` — `:101-102`, `:109-110`, `:124-129`. En batch la transferencia agregada va después del loop completo (CEI batch correcto) — `:129`.
- `withdraw`: effects antes de transfer — `:137-138`. `nonReentrant` — `:133`.

### 4. EIP-712 — OK
- `DEBIT_AUTHORIZATION_TYPEHASH` como `constant` — `:30-31`. Verificado con `cast keccak` → `0x5feea67f…2328f5` (idéntico al literal y al test `test_Typehash_matchesCanonical`).
- `_hashTypedDataV4` de OZ — `:95`. Domain (chainId + verifyingContract) lo aporta OZ dinámicamente; nada hardcodeado.
- Verificación reusable vía helper interno `_verifyAndConsume` — `:86-103`, consumido por `debit` y `debitBatch`. Buen DRY.
- `ECDSA.recover` (no `tryRecover`): en OZ v5 revierte ante firma malleable/inválida (`ECDSAInvalidSignature`/`ECDSAInvalidSignatureS`) en lugar de devolver `address(0)`. Esto elimina el riesgo clásico de "zero-recover matchea depositor no seteado". Bien.

### 5. Calidad de tests — OK (con 2 MENORs de honestidad, no bloqueantes)
- 22 tests (20 unit + 2 invariant), todos PASS. Cubren los 12 ACs con asserts reales sobre balances, transferencias y eventos (no solo "no revierte").
- Revert tests usan `.selector` exacto (`IWasiAIEscrow.X.selector`) y `vm.expectEmit(true,true,false,true,...)` — CD-13 cumplido.
- El test de batch parcial (`test_RevertWhen_DebitBatch_oneElementFails_noPartial`) verifica explícitamente que NINGÚN balance cambió y el operador recibió 0 — atomicidad genuina (AC-3).
- Coverage de `WasiAIEscrow.sol` = **100% real** (60/60 líneas, 15/15 branches), no inflado.
- El invariant `operatorCannotDrainWithoutSig` SÍ tiene un trampolín genuino: `operatorDrainAttempt` firma con `forgedPk != agentPk` y, si el `debit` NO revierte, dispara `revert("CD-2 VIOLATED")` — un drain exitoso rompería el invariant. Idem `operatorWithdrawAttempt`. Es un handler que GENUINAMENTE intenta robar. → ver MNR-1 (mejora de robustez del trap, no falla actual).

### 6. Deploy script — OK
- 100% env-driven (`USDC_BASE_SEPOLIA`, `MULTISIG_ADDRESS`, `TIMELOCK_DELAY`, `DEPLOYER_PRIVATE_KEY`) — `Deploy.s.sol:13-16`. Cero hardcodes (CD-5).
- `ERC1967Proxy(impl, abi.encodeCall(initialize, ...))` correcto — `:19-21`.
- Coverage 0% del script es esperado (no se ejecuta en tests; es dry-run/broadcast humano).

### 7. Naming / legibilidad / NatSpec — OK (1 MENOR)
- `@title`/`@notice` a nivel contrato — `:15-17`. Custom errors descriptivos. Nombres claros (`_verifyAndConsume`, `_upgradeProposedAt`).
- Funciones públicas mutadoras (`deposit`, `withdraw`, `debit`, `debitBatch`, `proposeUpgrade`, `renounceUpgrade`) carecen de NatSpec `@notice/@param` por-función → MNR-2.

### 8. DT-14 (abi.ts) — OK
- `abi.ts` `debit` ahora tiene 5 inputs con `nonce` (uint256) ANTES de `signature` — `abi.ts:42-52`. Coincide byte-a-byte con `IWasiAIEscrow.debit` (`IWasiAIEscrow.sol:32`) y con el contrato.
- `eip712.ts` intacto: `DEBIT_AUTHORIZATION_TYPES` ya tenía `nonce` (orden keyId, amount, deadline, nonce) — `eip712.ts:31-38`. Sin cambios.
- Tests TS verdes tras el cambio: eip712.test.ts + escrow-verifier.test.ts + auth.escrow.test.ts → **34/34 PASS**. tsc 0.

### 9. Gas / madurez — OK (1 MENOR)
- `debitBatch` agrega una sola `safeTransfer` del total en lugar de N transfers — buena decisión de gas sin sacrificar CEI/seguridad.
- Loop `for` sin `unchecked { ++i }` ni cacheo de `.length` → MNR-3 (micro-optimización; no comprometer seguridad). No se over-optimizó: correcto.

### 10. Gates declarados vs reales — OK
Todo lo declarado por el Dev se confirma. Una nota: el Dev declaró "vitest 5"; la corrida real del directorio `src/adapters/escrow` ejecuta `eip712.test.ts` (18 tests). Sumando las superficies afectadas por DT-14 (`escrow-verifier.test.ts`, `auth.escrow.test.ts`) el total es 34 tests verdes. El número "5" probablemente refiere a otra agrupación; en cualquier caso, **0 fallos** → ver MNR-5 (discrepancia menor de reporte, no de calidad).

---

## Hallazgos MENORES (no bloquean DONE)

### MNR-1 — Invariant: el trap del drain usa try/catch interno (el fuzzer ve 0 reverts)
- **Categoría**: Test Coverage / honestidad de invariant.
- **Archivo:línea**: `WasiAIEscrow.invariant.t.sol:116-145` (`operatorDrainAttempt`, `operatorWithdrawAttempt`).
- **Qué**: ambos handlers envuelven el call hostil en `try/catch` y revierten manualmente solo si el call NO revierte. Como efecto secundario, la tabla de fuzzing muestra `reverts: 0` para esos selectores, lo que a primera vista parece que "nunca se ejercitó el path". En realidad SÍ se ejercita (2500+ calls cada uno) y el trap es válido. El riesgo real es de legibilidad: un revisor futuro podría leer `reverts: 0` y concluir erróneamente que el handler no hace nada.
- **Impacto**: ninguno funcional (el invariant es honesto y atrapa un drain real). Solo claridad de la señal de fuzzing.
- **Sugerencia**: agregar un ghost counter (ej. `ghost_drainAttemptsRejected++` en el `catch`) y un assert auxiliar de que el contador crece, para hacer visible que el path hostil se ejerce realmente. Alternativamente, documentar en comentario que el `reverts: 0` es esperado por el try/catch.

### MNR-2 — Falta NatSpec por-función en mutadoras públicas
- **Categoría**: Legibilidad / NatSpec.
- **Archivo:línea**: `WasiAIEscrow.sol:66` (`deposit`), `:105` (`debit`), `:114` (`debitBatch`), `:133` (`withdraw`), `:142` (`proposeUpgrade`), `:147` (`renounceUpgrade`).
- **Qué**: contrato de custodia de dinero sin `@notice/@param/@dev` por función pública. Hay comentarios inline buenos, pero no NatSpec estructurado.
- **Impacto**: menor — afecta auditabilidad/doc-gen, no comportamiento.
- **Sugerencia**: agregar `@notice` + `@param` a las 6 funciones públicas mutadoras (especialmente semántica de `debitBatch` y el modelo optimista de `withdraw`).

### MNR-3 — Loop de `debitBatch` sin `unchecked{++i}` ni cacheo de length
- **Categoría**: Gas.
- **Archivo:línea**: `WasiAIEscrow.sol:123` (`for (uint256 i = 0; i < keyIds.length; i++)`).
- **Qué**: micro-ineficiencia de gas en el loop (overflow check redundante de `i`, relectura de `keyIds.length` por iteración).
- **Impacto**: gas marginal en batches grandes; nulo en correctness.
- **Sugerencia**: `uint256 len = keyIds.length;` + `unchecked { ++i; }`. Opcional — no sacrificar legibilidad si el equipo prefiere no micro-optimizar.

### MNR-4 — `proposeUpgrade`/`_authorizeUpgrade` no validan `newImpl != address(0)`
- **Categoría**: Error handling / robustez.
- **Archivo:línea**: `WasiAIEscrow.sol:142-144`, `:151-157`.
- **Qué**: `proposeUpgrade(address(0))` registra un timestamp para `keccak(address(0))` sin revertir. El upgrade real a `address(0)` lo bloquea OZ UUPS downstream (`ERC1967Utils`), pero la propuesta a cero impl es un estado sin sentido aceptado silenciosamente.
- **Impacto**: bajo — solo el owner (multisig) puede llamarlo; no hay escalada. Es higiene.
- **Sugerencia**: `if (newImpl == address(0)) revert ZeroAddress();` en `proposeUpgrade` (el error ya existe en la interfaz).

### MNR-5 — Discrepancia menor en el conteo de tests TS reportado
- **Categoría**: Reporte / trazabilidad.
- **Archivo:línea**: report del Dev ("vitest 5") vs corrida real.
- **Qué**: el Dev reportó "vitest 5"; la corrida real de `src/adapters/escrow` da 18 (eip712) y el conjunto afectado por DT-14 da 34 tests, todos verdes.
- **Impacto**: nulo en calidad — solo precisión del reporte. No hay regresión.
- **Sugerencia**: en el report final citar el comando exacto y el número observado (ej. `vitest run src/adapters/escrow/eip712.test.ts → 18 passed`).

---

## Notas adicionales verificadas (sin hallazgo)
- `withdraw` resta `_balances - _lockedAmount` con `_lockedAmount==0` siempre (DT-11): sin underflow; el griefing residual (agente front-runea withdraw → debit revierte por `InsufficientBalance`) está documentado en Story File §12 como roadmap mainnet, NO roba fondos del operador (CD-2 intacto). Respetado como decisión documentada — no es finding.
- `debitBatch` con nonces duplicados dentro del mismo batch para el mismo keyId revertiría en el 2º elemento por `NonceAlreadyUsed` (los effects del 1º ya marcaron el nonce antes del 2º `_verifyAndConsume`). Atomicidad nativa → toda la tx revierte. Correcto.
- `auto-blindaje.md` documenta 2 errores reales corregidos (flag `--no-commit` inexistente en Foundry 1.5.1; warning 2018 `_authorizeUpgrade` → `view`). Verificado: `_authorizeUpgrade` es `internal view override onlyOwner` (`:151`) y el build sale sin warnings de compilador.
- Las "notes" que emite `forge build` son de **forge-lint** (asm-keccak256, mixed-case-variable sobre `__gap`/`ghost_*`), NO warnings del compilador solc. No afectan la DoD ("código propio sin warnings" se refiere a warnings de solc). No es finding.

---

## Resumen para el orquestador
- **Veredicto: APROBADO con MENORs.**
- **0 BLOQUEANTES**, **5 MENORES** (MNR-1 honestidad de señal del invariant, MNR-2 NatSpec, MNR-3 gas, MNR-4 guard zero-impl, MNR-5 conteo de tests). Ninguno bloquea DONE; entran a criterio del equipo (ahora o backlog).
- Gates reales confirmados: forge build 0 err/0 warn (solc), forge test **22/22**, coverage `WasiAIEscrow.sol` **100%**, forge fmt --check limpio, tsc 0, vitest escrow **34/34**, typehash canónico verificado.
- Path: `doc/sdd/121-wkh-126a-escrow-contract/cr-report.md`.
