# Validation Report — WKH-126a: WasiAIEscrow.sol

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-06-22
**Branch**: `feat/121-wkh-126a-escrow-contract`

---

## Runtime Checks

### forge build
```
No files changed, compilation skipped
```
0 errores de solc. Las 5 `note` emitidas son de forge-lint (mixed-case-variable en `__gap` / `ghost_*`, asm-keccak256) — informativas del linter, no del compilador. Gate: PASS.

### forge test
```
Ran 20 tests for test/WasiAIEscrow.t.sol:WasiAIEscrowTest — 20 passed, 0 failed
Ran 2 tests for test/WasiAIEscrow.invariant.t.sol:WasiAIEscrowInvariantTest — 2 passed, 0 failed
Total: 22 passed, 0 failed
  invariant_operatorCannotDrainWithoutSig: runs=256, calls=12800, reverts=0
  invariant_solvency_balanceGteSumBalances: runs=256, calls=12800, reverts=0
```
Gate: PASS (22/22).

### forge coverage (WasiAIEscrow.sol)
```
src/WasiAIEscrow.sol   100.00% (60/60 lines)   100.00% (72/72 stmts)   100.00% (15/15 branches)   100.00% (11/11 funcs)
```
Objetivo era ≥95%. Real: 100%. Gate: PASS.

### CD-1 Typehash — cast keccak verificado
```
cast keccak "DebitAuthorization(bytes32 keyId,uint256 amount,uint256 deadline,uint256 nonce)"
→ 0x5feea67fe2f683c18d6addd1eaab3f2152293b5512c90fdd3f702e973a2328f5
```
Coincide con `DEBIT_AUTHORIZATION_TYPEHASH` en `contracts/src/WasiAIEscrow.sol:30-31` y con el assert de `test_Typehash_matchesCanonical` (`contracts/test/WasiAIEscrow.t.sol:106-110`). Gate: PASS.

### CD-2 Invariant (operador no drena sin firma)
`invariant_operatorCannotDrainWithoutSig` pasa en `WasiAIEscrow.invariant.t.sol:179-183`. El guard real es el `assertEq` del invariant (no el self-revert del handler — documentado como MNR-1 en AR, no bloqueante). 256 runs × 12800 calls, 0 violaciones.

### Convergencia TS (DT-14 / CD-1)
- `src/adapters/escrow/abi.ts:43-49` — `debit` con 5 inputs: `keyId, amount, deadline, nonce, signature`. Converge byte-a-byte con `IWasiAIEscrow.sol:32` y `WasiAIEscrow.sol:105`.
- `src/adapters/escrow/eip712.ts:31-38` — `DEBIT_AUTHORIZATION_TYPES` intacto (`keyId, amount, deadline, nonce` — orden exacto).
- `npx tsc --noEmit` → 0 errores.
- `npx vitest run src/adapters/escrow/eip712.test.ts src/adapters/escrow-verifier.test.ts src/routes/auth.escrow.test.ts` → **34 passed, 0 failed**.

---

## ACs — Verificación con evidencia

| AC | Texto (EARS, condensado) | Status | Evidencia |
|----|--------------------------|--------|-----------|
| AC-1 | WHEN `deposit(keyId,amount)` con amount>0 aprobado THEN transferir al contrato, `balances[keyId]+=amount`, emitir `Deposited` | PASS | `WasiAIEscrow.sol:66-79` (CEI: effects L75, interaction L77, emit L78); `test_Deposit_creditsBalance_emitsEvent` (t.sol:72-79): verifica `escrowBalance==100e6`, `usdc.balanceOf(escrow)==100e6`, `vm.expectEmit` del evento. |
| AC-2 | WHEN `debit` con firma EIP-712 válida + deadline no vencido + nonce no usado THEN debitar balances, marcar nonce, transferir USDC al operador | PASS | `WasiAIEscrow.sol:86-112` (`_verifyAndConsume` L86-103, `debit` L105-112); `test_Debit_validSig_debits_transfersToOperator` (t.sol:113-128): verifica `escrowBalance==60e6`, `usdc.balanceOf(operator)==40e6`, replay falla con `NonceAlreadyUsed`. |
| AC-3 | WHEN `debitBatch` con arrays iguales y firmas válidas THEN todos los débitos atómicamente; IF cualquier elemento falla THEN revertir completo sin estado parcial | PASS | `WasiAIEscrow.sol:114-130` (loop + single safeTransfer post-loop L129); `test_DebitBatch_allValid_atomic` (t.sol:131-158) y `test_RevertWhen_DebitBatch_oneElementFails_noPartial` (t.sol:160-188): verifica balances intactos y `usdc.balanceOf(operator)==0` tras revert. |
| AC-4 | IF `recovered != depositor[keyId]` THEN revertir con `InvalidSignature` | PASS | `WasiAIEscrow.sol:97` (`if (recovered != _depositor[keyId]) revert InvalidSignature()`); `test_RevertWhen_InvalidSignature` (t.sol:201-210): firma con `wrongPk=0xB0B`, espera `IWasiAIEscrow.InvalidSignature.selector`. |
| AC-5 | IF `block.timestamp > deadline` THEN revertir con `DeadlineExpired` sin modificar balances | PASS | `WasiAIEscrow.sol:90` (`if (block.timestamp > deadline) revert DeadlineExpired()`); `test_RevertWhen_DeadlineExpired` (t.sol:214-224): `vm.warp(deadline+1)`, espera `DeadlineExpired.selector`, verifica `escrowBalance==100e6`. |
| AC-6 | IF nonce ya usado para ese keyId THEN revertir con `NonceAlreadyUsed` | PASS | `WasiAIEscrow.sol:92` (`if (_usedNonces[keyId][nonce]) revert NonceAlreadyUsed()`) + L101 (marca irrevocable); `test_RevertWhen_NonceReplay` (t.sol:227-236): primer debit OK, segundo con mismo nonce espera `NonceAlreadyUsed.selector`. |
| AC-7 | WHEN `withdraw(keyId,amount)` siendo `msg.sender==depositor[keyId]` y `amount<=balances-lockedAmount` THEN transferir USDC al agente y actualizar balances | PASS | `WasiAIEscrow.sol:133-139` (guard L134, effects L137, interaction L138); `test_Withdraw_freeBalance_byDepositor` (t.sol:239-246): verifica `escrowBalance==60e6` y `usdc.balanceOf(agent)==before+40e6`. |
| AC-8 | IF `msg.sender != depositor[keyId]` en `withdraw` THEN revertir con `Unauthorized` | PASS | `WasiAIEscrow.sol:134` (`if (msg.sender != _depositor[keyId]) revert Unauthorized()`); `test_RevertWhen_Withdraw_byNonDepositor` (t.sol:249-254): `vm.prank(operator)`, espera `Unauthorized.selector`. |
| AC-9 | WHILE el operador no tiene firma válida, ninguna dirección ≠ depositor puede retirar fondos | PASS | Path único de transferencia a tercero: `debit`/`debitBatch` vía `_verifyAndConsume` (L97: `recovered==_depositor[keyId]`). `withdraw` solo paga a `_depositor[keyId]` (L134+L138). `test_OperatorCannotWithdrawWithoutSignature` (t.sol:265-278): cubre ambas vías. Invariant `invariant_operatorCannotDrainWithoutSig` (invariant.t.sol:179-183) lo verifica fuzz 12800 calls. |
| AC-10 | WHEN `escrowBalance(keyId)` consultado THEN retornar `balances[keyId]` sin modificar estado (view) | PASS | `WasiAIEscrow.sol:81-83` (`function escrowBalance(bytes32 keyId) external view returns (uint256) { return _balances[keyId]; }`). Usado como assertion en todos los tests de balance. |
| AC-11 | WHEN el contrato recibe USDC via `deposit` THEN operar solo sobre `USDC_TOKEN`; no existe path para otro token | PASS | `WasiAIEscrow.sol:77` (`_usdc.safeTransferFrom(...)` — single token fijado en `initialize` L61). No existe función que acepte otra dirección de token. `test_OnlyUSDC_noOtherTokenPath` (t.sol:281-291): verifica `other.balanceOf(escrow)==0`, `usdc.balanceOf(escrow)==50e6`. |
| AC-12 | WHILE upgradeable, `upgradeTo*` requiere timelock ≥ UPGRADE_TIMELOCK desde owner multisig; IF `renounceUpgrade()` THEN upgrade desactivado permanentemente | PASS | `WasiAIEscrow.sol:142-157` (`proposeUpgrade`, `renounceUpgrade`, `_authorizeUpgrade` con guards onlyOwner + timelock + `!_upgradeRenounced`). `test_Upgrade_requiresTimelockAndOwner` (t.sol:294-320): cubre no-owner, pre-timelock, post-timelock. `test_RenounceUpgrade_freezesPermanently` (t.sol:323-338): verifica `UpgradeRenounced.selector` en propose y upgrade post-renounce. |

**Total: 12/12 ACs PASS.**

---

## Drift Detection

**Scope drift**: `git diff --name-only main...HEAD` muestra los siguientes archivos de esta HU dentro de scope:
- `contracts/` (completo — todo el subproyecto Foundry nuevo)
- `src/adapters/escrow/abi.ts` (cierre DT-14 — actualización de 4 a 5 args en `debit`, documentado en SDD §10 DT-14)
- `.env.example` (5 vars de deploy: `BASE_SEPOLIA_RPC_URL`, `DEPLOYER_PRIVATE_KEY`, `USDC_BASE_SEPOLIA`, `MULTISIG_ADDRESS`, `TIMELOCK_DELAY`)

Los demás archivos en el diff son de HUs previas ya mergeadas (el branch `feat/121-wkh-126a-escrow-contract` arranca de una base que ya tenía esas HUs). No hay archivos fuera de Scope IN atribuibles a esta HU.

**`contracts/src/libraries/`**: no existe — el SDD lo listaba como "si aplica"; `_verifyAndConsume` es helper interno en el contrato principal. No es drift, es decisión de implementación válida.

**Wave drift**: ninguno visible. W0 (scaffold) → W1 (contrato base) → W2 (debit) → W3 (withdraw+UUPS) → W4 (tests) → W5 (deploy script) en el estado final del código.

**Spec drift** (spot-check 3 funciones clave):
- `_verifyAndConsume` (SDD §4.3): orden exacto: deadline → nonce → recover → balance → effects → implementado identicamente en `WasiAIEscrow.sol:86-103`.
- `debitBatch` (SDD §4.4): CEI batch correcto — loop con todos los effects, single `safeTransfer(total)` post-loop — implementado en `WasiAIEscrow.sol:114-130`.
- Storage layout (SDD §4.2): 5 mappings + 2 scalars + bool + `__gap[44]` — implementado en `WasiAIEscrow.sol:34-44`.

**Test drift**: todos los 19 tests del Story File §8 existen en `WasiAIEscrow.t.sol` + 2 invariants en `WasiAIEscrow.invariant.t.sol`. 1 test extra no listado en el SDD: `test_RevertWhen_InitializeZeroAddress` (t.sol:341-346) — adición positiva, no drift negativo.

**Drift**: ninguno.

---

## 9 MNRs (AR + CR) — Confirmación de no-bloqueo

| MNR | Origen | Es hueco de seguridad? | Veredicto |
|-----|--------|----------------------|-----------|
| AR-MNR-1 | Self-revert del handler silenciado por `fail_on_revert=false` | No — el guard real (`assertEq` del invariant, invariant.t.sol:179-183) sí falla la suite. El self-revert es defensa redundante, no el check efectivo. | No bloqueante |
| AR-MNR-2 | `proposeUpgrade` no valida `newImpl!=address(0)` | No — OZ `ERC1967Utils` bloquea el upgrade real; solo el owner (multisig) puede llamar. Sin vector externo. | No bloqueante |
| AR-MNR-3 | Fee-on-transfer: acredita `amount` declarado, no delta real | No — USDC Circle no es fee-on-transfer; contrato es single-token fijado en `initialize`. Teórico para el scope actual. | No bloqueante |
| AR-MNR-4 | `forge-std` no está en `.gitmodules` (solo OZ los dos submodules) | No es hueco de seguridad. Afecta reproducibilidad de clean-clone. Confirmado: `contracts/lib/forge-std` existe pero no como submodule registrado. | No bloqueante (reproducibilidad) |
| CR-MNR-1 | Idem AR-MNR-1 (overlap entre AR y CR) | Idem | No bloqueante |
| CR-MNR-2 | Falta NatSpec por-función en mutadoras públicas | Solo legibilidad/doc-gen, no comportamiento. | No bloqueante |
| CR-MNR-3 | Loop `debitBatch` sin `unchecked{++i}` | Micro-optimización de gas, no correctness. | No bloqueante |
| CR-MNR-4 | `proposeUpgrade`/`_authorizeUpgrade` sin validar `newImpl!=address(0)` | Idem AR-MNR-2 | No bloqueante |
| CR-MNR-5 | Discrepancia conteo TS ("vitest 5" vs 34 reales) | Solo imprecisión de reporte del Dev. Corrida real verificada: 34/34 PASS. | No bloqueante |

Ninguno de los 9 MNRs representa un hueco de seguridad. Los 4 de robustez/reproducibilidad (AR-MNR-1, AR-MNR-4, CR-MNR-2, CR-MNR-4) son candidatos para fix-pack pre-mainnet.

---

## Gates (confirmados desde CR report + verificación propia)

| Gate | Status | Fuente |
|------|--------|--------|
| forge build 0 errores (solc) | PASS | CR report + verificado en esta sesión: 0 errores solc, 5 notes de forge-lint (esperadas) |
| forge test 22/22 | PASS | CR report + verificado: `22 tests passed, 0 failed` |
| forge coverage WasiAIEscrow.sol 100% | PASS | CR report + verificado: `100.00% (60/60 lines, 72/72 stmts, 15/15 branches, 11/11 funcs)` |
| forge fmt --check | PASS | CR report (confirmado, no re-ejecutado) |
| cast keccak typehash | PASS | CR report + verificado: `0x5feea67fe2f683c18d6addd1eaab3f2152293b5512c90fdd3f702e973a2328f5` |
| tsc --noEmit | PASS | CR report + verificado: 0 errores |
| vitest escrow (eip712+verifier+auth.escrow) | PASS | CR report 34/34 + verificado: `34 passed, 0 failed` |

---

## Smoke Manual (para el operador, pre-mainnet)

No hay flujo user-facing automatizable en esta HU (el contrato no está deployado en testnet en este pipeline). Para el deploy real a Base Sepolia:

1. Copiar `.env.example` a `.env` y completar `BASE_SEPOLIA_RPC_URL`, `DEPLOYER_PRIVATE_KEY`, `USDC_BASE_SEPOLIA`, `MULTISIG_ADDRESS`, `TIMELOCK_DELAY`.
2. `cd contracts && forge script script/Deploy.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast`
3. Verificar en output `Escrow proxy: 0x...` y `Escrow impl: 0x...`.
4. En BaseScan Sepolia: confirmar que la proxy es upgradeable (ERC1967) y que el owner del proxy apunta a `MULTISIG_ADDRESS`.
5. Verificar `DEBIT_AUTHORIZATION_TYPEHASH()` on-chain == `0x5feea67fe2f683c18d6addd1eaab3f2152293b5512c90fdd3f702e973a2328f5`.
6. Actualizar `A2A_ESCROW_CONTRACT_BASE` en Vercel/Railway con la dirección del proxy.

---

**Listo para DONE. 12/12 ACs PASS. 0 bloqueantes. Gates verdes (forge + tsc + vitest). Drift: ninguno.**

*QA F4 — nexus-qa — 2026-06-22 — WKH-126a / NNN 121.*
