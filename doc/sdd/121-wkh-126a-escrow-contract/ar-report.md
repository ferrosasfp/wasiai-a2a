# Adversarial Review (AR) — WKH-126a: WasiAIEscrow.sol (Foundry, money-custody)

> Reviewer: nexus-adversary · Fecha: 2026-06-22 · Branch: `feat/121-wkh-126a-escrow-contract`
> Tipo: smart-contract de **custodia de dinero** (USDC prepago) → listón máximo.
> Veredicto: **APROBADO con MENORs** (0 BLOQUEANTE, 4 MENOR)

---

## Resumen ejecutivo

| Métrica | Resultado |
|---------|-----------|
| BLOQUEANTE-ALTO | **0** |
| BLOQUEANTE-MEDIO | **0** |
| BLOQUEANTE-BAJO | **0** |
| MENOR | **4** |
| `forge build` | ✅ 0 errores (solo `note` de lint informativo) |
| `forge test` | ✅ **22/22 PASS** (20 unit + 2 invariant, runs 256 / depth 50) |
| `forge coverage` (WasiAIEscrow.sol) | ✅ **100%** — 60/60 líneas, 72/72 stmts, 15/15 branches, 11/11 funcs |
| Typehash (`cast keccak`) | ✅ `0x5feea67fe2f683c18d6addd1eaab3f2152293b5512c90fdd3f702e973a2328f5` byte-a-byte |
| Tests adversariales propios | ✅ **8/8 PASS** (malleability, garbage sig, cross-key reuse, batch overflow, deadline=0, reinit, impl-init-disabled, unknown key) |

**No se encontró ningún path de robo ni pérdida de fondos.** El contrato defiende correctamente
todos los vectores críticos de money-custody. Los 4 MENOR son mejoras de robustez de test y
hardening; ninguno bloquea el gate.

---

## Verificación de los vectores OBLIGATORIOS (money-custody)

### 1. Robo vía firma — ✅ DEFENDIDO (evidencia ejecutable)
- **OZ `ECDSA.recover`** (`WasiAIEscrow.sol:96`) revierte ante malleable (high-s) y firma inválida
  → NO hay bypass por `recovered == address(0)`. Probado: `test_Malleability` y `test_GarbageSig`
  (escritos por el reviewer en scratch) → ambos revierten. ✅
- **Replay mismo nonce** (`_usedNonces[keyId][nonce]`, línea 92/101) → `NonceAlreadyUsed`. Cubierto
  por `test_RevertWhen_NonceReplay` (t.sol:227) y verificado dentro de `debit` (t.sol:124-127). ✅
- **Firma de keyId A reusada en keyId B**: el `structHash` (línea 94) incluye `keyId` → recover
  produce digest distinto → `InvalidSignature`. Probado: `test_CrossKeyReuse` (reviewer) → revierte. ✅
- **Firma de tercero (no depositor)**: línea 97 `recovered != _depositor[keyId]` → `InvalidSignature`.
  Cubierto por `test_RevertWhen_InvalidSignature` (t.sol:201). ✅

### 2. CD-2 (operador nunca mueve fondos sin firma del depositor) — ✅ DEFENDIDO
- Único path que mueve `balances` a un tercero (`safeTransfer(msg.sender, …)`) está en `debit`/`debitBatch`,
  ambos pasan obligatoriamente por `_verifyAndConsume` (líneas 109, 124) que exige
  `recovered == _depositor[keyId]`. `withdraw` solo paga a `_depositor[keyId]` (línea 134). No hay
  otro path. ✅
- El invariant **`invariant_operatorCannotDrainWithoutSig`** (invariant.t.sol:179) chequea la
  identidad de conservación `balanceOf(escrow) == deposited − debited − withdrawn` con `assertEq`
  **dentro del invariant** (no en el handler) → es un guard real. 12800 calls, 0 reverts del assert. ✅
- Ver MNR-1 sobre la debilidad del self-revert en el handler (defensa redundante, no el guard real).

### 3. Reentrancy — ✅ DEFENDIDO
- `nonReentrant` en `deposit`/`debit`/`debitBatch`/`withdraw` (líneas 66, 107, 120, 133).
- **CEI estricto**: balances actualizados ANTES de cualquier transfer. `_verifyAndConsume` debita en
  línea 102 antes de `safeTransfer`; `withdraw` debita línea 137 antes de transferir línea 138;
  `deposit` acredita línea 75 antes de `safeTransferFrom` línea 77.
- **`debitBatch` agrega la transferencia AL FINAL** (línea 129): todos los effects por elemento ocurren
  en el loop, y hay UNA sola `safeTransfer(total)` después. No hay transfer dentro del loop. ✅

### 4. debitBatch atómico — ✅ DEFENDIDO
- Cualquier `revert` en `_verifyAndConsume` (deadline/nonce/firma/saldo) deshace TODA la tx (atomicidad
  nativa Solidity). Cubierto por `test_RevertWhen_DebitBatch_oneElementFails_noPartial` (t.sol:160) que
  asserta balances intactos y operador con 0. ✅
- **Length mismatch** validado (línea 121) → `LengthMismatch`. ✅
- **keyId repetido con mismo nonce en el batch**: la 1ª iteración marca `_usedNonces=true`; la 2ª revierte
  `NonceAlreadyUsed` → batch entero revierte. Defensa correcta contra doble-débito. ✅
- **Overflow del `total` agregado**: Solidity 0.8 revierte en overflow; además cada elemento valida
  `amount <= balances` primero. Probado: `test_BatchTotalOverflow` (reviewer, `amounts[0]=type(uint256).max`)
  → revierte, balances intactos. ✅

### 5. Nonce — ✅ SÓLIDO
- `_usedNonces[keyId][nonce]` **por keyId** (correcto, no global), irrevocable (línea 101). No hay path
  para des-marcar. Política arbitraria (DT-13) coherente con el modelo por-ventana de 126b. ✅

### 6. Withdraw optimista (DT-11) — ✅ riesgo SOLO impago, documentado correctamente
- `_lockedAmount[keyId]` está en storage (línea 40) y permanece en 0 (modelo optimista). `withdraw`
  resta `_balances - _lockedAmount` (línea 135) → con locked=0 es `_balances`. `InsufficientBalance`
  si `amount > available` (línea 136). NO existe edge donde withdraw saque más que el balance
  (cubierto por `test_RevertWhen_Withdraw_exceedsAvailable`). ✅
- El griefing (agente front-runea debit con withdraw → debit revierte por `InsufficientBalance`) es
  **impago al vendor, NO robo** — CD-2 intacto. Correctamente documentado en DT-11 y escalado a humano
  para mainnet. Confirmado: no es finding. ✅

### 7. deposit / depositor (DT-10) — ✅ DEFENDIDO
- `_depositor[keyId]` inmutable desde el 1er deposit (líneas 69-73). 2ª address → `DepositorMismatch`.
  Cubierto por `test_RevertWhen_SecondDepositorClaimsKeyId` (t.sol:88). ✅
- **deposit de amount 0** → `ZeroAmount` (línea 67), cubierto. ✅
- **Front-run de claim de keyId ajeno**: quien deposita primero es el owner; un atacante no puede
  "reclamar" un keyId ya fondeado (revierte). El claim por front-run de un keyId vacío es un caso de
  onboarding gasless explícitamente OUT-of-scope (DT-10). No es finding. ✅
- **token != USDC**: `deposit` solo mueve `_usdc` (línea 77). No hay path para otro token. Cubierto por
  `test_OnlyUSDC_noOtherTokenPath` (t.sol:281). ✅

### 8. Upgrade (UUPS) — ✅ DEFENDIDO
- `_authorizeUpgrade` (línea 151) gated por `onlyOwner` (multisig) + timelock + `!_upgradeRenounced`.
- `proposeUpgrade`/`renounceUpgrade` ambos `onlyOwner` (líneas 142, 147). Timelock no bypasseable:
  `proposedAt == 0 || block.timestamp < proposedAt + _upgradeTimelock` → `TimelockNotElapsed`.
- `renounceUpgrade` irreversible (no hay setter que ponga `_upgradeRenounced=false`). ✅
- **Initializer protegido**: `constructor` llama `_disableInitializers()` (línea 51); `initialize` tiene
  modifier `initializer`. Probado por el reviewer: `test_CannotReinit` y `test_ImplInitDisabled` →
  ambos revierten. NO hay re-init ni hijack del owner. ✅
- **Storage layout**: orden estable + `__gap[44]` (línea 44). Coincide con §4.2 del SDD (CD-9). ✅
- Cubierto por `test_Upgrade_requiresTimelockAndOwner` (t.sol:294) y `test_RenounceUpgrade_freezesPermanently`. ✅

### 9. EIP-712 / CD-1 — ✅ CONVERGENCIA byte-a-byte
- Typehash recomputado con `cast keccak` = `0x5feea6…2328f5` exacto (línea 30-31). `test_Typehash_matchesCanonical`
  (t.sol:106) lo asserta. ✅
- Domain vía `__EIP712_init("WasiAIEscrow","1")` (línea 60); `chainId`/`verifyingContract` dinámicos (OZ).
  Coincide con `.env.example` (`ESCROW_EIP712_NAME=WasiAIEscrow`, `VERSION=1`) y eip712.ts de 126b. ✅
- **DT-14 cierre**: `debit` ahora 5 args con `nonce`. `src/adapters/escrow/abi.ts:42-52` actualizado a
  5 inputs (`nonce` antes de `signature`). `eip712.ts` sin cambios (struct ya tenía nonce). `tsc --noEmit`
  sin errores relacionados a escrow. ✅

### 10. ERC-20 / SafeERC20 — ✅ (con MNR-3 sobre fee-on-transfer)
- `using SafeERC20` (línea 26); todas las transfers vía `safeTransfer`/`safeTransferFrom`. No hay
  `IERC20.transfer` crudo (CD-11). ✅
- No asume `decimals` en lógica (los amounts son raw uint256). ✅
- Ver MNR-3: fee-on-transfer rompería contabilidad, pero USDC no es fee-on-transfer → MENOR.

### 11. Coverage / tests honestos — ✅ HONESTOS
- 100% coverage REAL del contrato (no inflado): branches 15/15. Los tests usan `vm.expectRevert(...selector)`
  exactos y `vm.expectEmit`, no substrings (CD-13). El invariant tiene handlers que SÍ intentan drenar
  (`operatorDrainAttempt`, `operatorWithdrawAttempt`). El guard real de conservación es el `assertEq` del
  invariant. Ver MNR-1 sobre la debilidad del self-revert. ✅

---

## Findings

### MNR-1 — [Test Coverage] El self-revert de CD-2 en el handler NO falla la suite (defensa redundante débil)
- **Archivo**: `contracts/test/WasiAIEscrow.invariant.t.sol:116-132` (`operatorDrainAttempt`), `:135-145`
  (`operatorWithdrawAttempt`).
- **Descripción**: con `fail_on_revert = false` (foundry.toml), un `revert("CD-2 VIOLATED…")` lanzado
  DENTRO del handler (caso en que `escrow.debit(...)` con firma forjada *tuviera éxito*) es **contado como
  un revert normal y descartado** — NO falla el test suite. Verificado empíricamente por el reviewer: un
  handler que siempre revierte con mensaje custom produce "12800 reverts" y el invariant **PASA igual**.
  En consecuencia, esos dos handlers NO son el guard efectivo de CD-2; si el contrato regresara y un drain
  forjado tuviera éxito, el `revert` interno quedaría silenciado.
- **Reproducción**: handler con `function f() { revert("X"); }` + `targetContract` + `invariant_dummy(){assert(true)}`
  con `fail_on_revert=false` → suite PASA, 12800 reverts. El framework descarta reverts del handler.
- **Impacto**: BAJO. El guard REAL de CD-2 sí existe y sí funciona: `invariant_operatorCannotDrainWithoutSig`
  (línea 179) usa `assertEq` **en el invariant** (no en el handler), que sí falla la suite. Además los 8
  tests adversariales del reviewer prueban el contrato directamente. Es robustez de test, no vulnerabilidad
  de contrato — por eso MENOR, no bloqueante.
- **Sugerencia**: convertir el self-revert en un assert observable por el invariant: exponer un ghost
  `bool public cd2Violated;` que el handler setee a `true` (en vez de `revert`) si el `try` tuvo éxito, y
  agregar `invariant_cd2NeverViolated() { assertFalse(handler.cd2Violated()); }`. Así una violación falla
  la suite de forma determinista.

### MNR-2 — [Error Handling] `proposeUpgrade` no valida `newImpl != address(0)` ni que sea contrato
- **Archivo**: `contracts/src/WasiAIEscrow.sol:142-145`.
- **Descripción**: `proposeUpgrade(address newImpl)` registra `_upgradeProposedAt[keccak(newImpl)]` sin
  validar que `newImpl != address(0)` ni que tenga code. Un owner (multisig) podría proponer y luego
  ejecutar `upgradeToAndCall(address(0), "")`. OZ `ERC1967Utils.upgradeToAndCall` SÍ revierte si el target
  no es contrato (`ERC1967InvalidImplementation`), así que el daño está mitigado por OZ aguas abajo.
- **Reproducción**: `proposeUpgrade(address(0))` no revierte; el `upgradeToAndCall(address(0))` posterior
  revierte por OZ (no por este contrato).
- **Impacto**: BAJO. Solo el owner (multisig) puede llamarlo → no es un vector de atacante externo. Defensa
  en profundidad faltante. No bloqueante.
- **Sugerencia**: agregar `if (newImpl.code.length == 0) revert ZeroAddress();` (o un error dedicado) en
  `proposeUpgrade` para fallar temprano y de forma legible.

### MNR-3 — [Data Integrity] `deposit` acredita el `amount` declarado, no el realmente recibido (fee-on-transfer)
- **Archivo**: `contracts/src/WasiAIEscrow.sol:75-77`.
- **Descripción**: `_balances[keyId] += amount` usa el `amount` del argumento, no el delta real de
  `balanceOf(this)`. Si el token fuera fee-on-transfer/rebasing, el contrato acreditaría más de lo recibido
  → eventual insolvencia. **USDC de Circle NO es fee-on-transfer** y el contrato es single-token fijado en
  `initialize` (DT-6), así que en el scope real (Base Sepolia USDC) esto NO ocurre.
- **Reproducción**: solo reproducible con un token fee-on-transfer, que está fuera de scope (single USDC).
- **Impacto**: BAJO / casi teórico para el scope actual. Relevante solo si se reconfigurara a un token
  no-estándar (no contemplado). Documentar el supuesto evita sorpresas en una futura migración multi-token.
- **Sugerencia**: documentar explícitamente en NatSpec del `deposit` el supuesto "USDC no fee-on-transfer";
  o (si se quisiera blindar) medir `balanceOf(this)` antes/después y acreditar el delta. No necesario para
  esta HU.

### MNR-4 — [Integration] `forge-std` no está en `.gitmodules` (riesgo de build no-reproducible en clean clone)
- **Archivo**: `.gitmodules` (solo lista los 2 submodules de OZ; `contracts/lib/forge-std/` aparece como
  dir untracked en `git status`).
- **Descripción**: OZ Contracts/Upgradeable están pinneados como submodules `v5.1.0` (verificado:
  `git describe` → `v5.1.0` en ambos). Pero `forge-std` quedó como directorio sin trackear, no como
  submodule. En un clone limpio, `forge-std` podría no resolverse (los tests no compilarían) salvo que el
  Dev lo commitee como contenido o submodule.
- **Reproducción**: `git clone` + `forge build` en máquina limpia → si `lib/forge-std` no está versionado,
  falla la resolución de `forge-std/Test.sol`.
- **Impacto**: BAJO — afecta reproducibilidad de CI/clean-clone, no la seguridad ni la lógica del contrato.
  El contrato productivo (`src/`) no depende de forge-std (es solo test).
- **Sugerencia**: agregar `forge-std` como submodule pinneado en `.gitmodules` (o versionar su contenido)
  para builds reproducibles. Verificar en el commit final que `contracts/lib/forge-std` quede trackeado.

---

## Categorías de ataque — tabla resumen

| # | Categoría | Resultado |
|---|-----------|-----------|
| 1 | Security (firma/auth/replay/IDOR) | ✅ OK |
| 2 | Error Handling | ⚠️ MNR-2 (proposeUpgrade no valida newImpl) |
| 3 | Data Integrity (reentrancy/atomicidad/conservación) | ⚠️ MNR-3 (fee-on-transfer, teórico/OUT) |
| 4 | Performance | ✅ OK (batch agrega 1 transfer; sin N+1/loops peligrosos) |
| 5 | Integration (ABI/backwards-compat 126b) | ⚠️ MNR-4 (forge-std submodule) — ABI DT-14 ✅ converge |
| 6 | Type Safety | ✅ OK (Solidity tipado; 0.8 overflow-checked; sin casts peligrosos) |
| 7 | Test Coverage | ⚠️ MNR-1 (self-revert del handler silenciado) — coverage 100% real |
| 8 | Scope Drift | ✅ OK (solo archivos del Story File + abi.ts cierre + .env.example) |
| 9 | Destructive Migrations | N/A — no hay SQL/migrations en esta HU (smart-contract) |
| 10 | RPC SECURITY DEFINER | N/A — no hay funciones Postgres en esta HU |
| 11 | Cache Invalidation | N/A — no se introduce capa de cache en esta HU |

---

## Convergencia EIP-712 / ABI con 126b (CD-1 / DT-14) — verificado

- Typehash on-chain == `cast keccak` == constante del contrato (línea 30) == valor del SDD. ✅
- `src/adapters/escrow/abi.ts`: `debit` actualizado a **5 inputs** (`keyId, amount, deadline, nonce, signature`),
  coincide con `IWasiAIEscrow.debit` (interfaz línea 32) y con el contrato (línea 105). ✅
- `eip712.ts` sin cambios (correcto — el struct ya tenía `nonce`). ✅
- `tsc --noEmit` sin errores relacionados a escrow. ✅

---

## Veredicto final

**APROBADO con MENORs.** 0 BLOQUEANTE (ALTO/MEDIO/BAJO). El contrato de custodia de dinero defiende
correctamente todos los vectores críticos: robo vía firma, replay, cross-key reuse, malleability,
reentrancy, atomicidad de batch, re-init, hijack de owner, e insolvencia. Coverage 100% real, typehash
byte-a-byte, 22/22 tests verdes + 8/8 ataques propios neutralizados.

Los 4 MENOR (robustez del invariant CD-2, guard de `newImpl`, supuesto fee-on-transfer, `forge-std`
submodule) son hardening / reproducibilidad y **NO bloquean el gate**. Pueden entrar en este fix-pack o
backlog a criterio del orquestador. Recomendación: MNR-1 y MNR-4 conviene atenderlos antes del deploy
real (uno mejora la garantía de CD-2 en CI, el otro la reproducibilidad del build).

*AR generado por NexusAgil — Adversary — 2026-06-22 — WKH-126a / NNN 121.*
