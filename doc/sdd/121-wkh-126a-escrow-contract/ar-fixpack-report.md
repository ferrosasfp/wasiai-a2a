# AR Fix-Pack Verification — WasiAIEscrow.sol (WKH-126a audit fix-pack)

> nexus-adversary · 2026-06-22 · branch `fix/wkh-126a-audit-fixpack` (working tree) · money-custody
> Modo: verificación adversarial del fix-pack. NO se modificó código ni tests. PoCs en scratch ejecutados (verdes) y borrados.
> Baseline real: `forge test` **43/43 PASS** (40 unit + 3 invariant/runs). `forge coverage` contrato **100%** lines/stmts/branches/funcs. Solc 0.8.24, forge 1.5.1.

## Veredicto final: **APROBADO**

- **F-A1 (front-run/MEV) CERRADO**: confirmado con PoC independiente (mismo nonce, bot front-runea → `NotOperator`, nonce NO se quema, operador re-presenta y liquida).
- **Hallazgos NUEVOS introducidos por el fix-pack: 0 BLOQUEANTES** (0 ALTO / 0 MED / 0 BAJO). 0 MENORs nuevos.
- **Storage layout: SEGURO** (slots 0-7 inmóviles, `_operator` slot 8 nuevo, `__gap[43]`, total 52 slots).
- Regresiones: **ninguna**. Los AC originales (deposit/debit/withdraw/escrowBalance), CEI/reentrancy, e invariantes CD-2 + solvencia siguen sólidos.

---

## Gates reales medidos

| Métrica | Valor |
|---|---|
| `forge test` | **43/43 PASS** (40 unit, 2 invariants × 256 runs / 12 800 calls c/u, 0 reverts) |
| `forge coverage` (WasiAIEscrow.sol) | **100% lines (87/87) · 100% stmts (111/111) · 100% branches (23/23) · 100% funcs (15/15)** |
| Gas batch 256 elem | **8 758 544 gas** (medido, PoC) — cómodamente minable en Base (limit ~120M+) y aun bajo 30M |
| Storage slots totales | **52** (8 vars slots 0-8 + `__gap[43]` slots 9-51) — preservado vs versión vieja |

---

## Verificación por fix

### 1. F-A1/F-A2 — onlyOperator — **VERIFICADO (CRÍTICO cerrado)**
- **Evidencia código:** `WasiAIEscrow.sol:152` (`debit`) y `:170` (`debitBatch`): `if (msg.sender != _operator) revert NotOperator();` ANTES de `_verifyAndConsume`. El check de caller precede a cualquier Effect.
- **PoC front-run (mismo nonce):** bot con firma VÁLIDA del agente llama `debit` → revierte `NotOperator`, bot recibe `0`. El nonce **NO se quema** (el guard está antes de `_usedNonces[...] = true`, `:139`). El operador legítimo re-presenta la MISMA firma/nonce → liquida 40e6, balance 100→60. **Front-run CERRADO y nonce recuperable.** ✅
- **PoC batch:** `debitBatch` por no-operador con firma válida → `NotOperator`. ✅
- **`setOperator` (`:93-98`):** `onlyOwner` + `if (newOperator == address(0)) revert ZeroAddress()`. PoC: no-owner → revert Ownable; owner con `address(0)` → `ZeroAddress`. Emite `OperatorUpdated`. ✅
- **Rotación + firmas en vuelo:** PoC — tras `setOperator(operator2)`, el operador viejo es rechazado (`NotOperator`) y el NUEVO operador liquida la MISMA firma en vuelo (la firma liga al `_depositor`, no al operador). **No hay firmas bricked por rotar.** ✅
- **¿El operador puede robar al agente?** NO — PoC: operador con firma de pk equivocada → `InvalidSignature` (`:134`). Sigue necesitando firma válida del depositor (CD-2 intacto). ✅
- **Cota de confianza (no es finding):** el modelo onlyOperator centraliza el liveness en una sola dirección — si el operador desaparece/es comprometido, las firmas no pueden liquidarse hasta `setOperator`. Es la decisión de diseño elegida sobre la alternativa "recipient-en-firma"; documentada en NatSpec `:18-21`. No reabre F-A1 (el atacante nunca cobra). **No finding.**

### 2. B-MED-1 — MIN_TIMELOCK — **VERIFICADO**
- `initialize` `:75`: `if (timelockDelay < MIN_TIMELOCK) revert InvalidTimelock();` con `MIN_TIMELOCK = 2 days` (`:42`).
- PoC: `2 days - 1` → `InvalidTimelock`; `0` → `InvalidTimelock`; `2 days` (al mínimo) → deploy OK. ✅
- Cierra además la mitad de código de BLQ-ALTO-1 (ya no se puede deployar un timelock de 60s). La elección owner=multisig vs EOA queda como config de deploy (env-driven en `Deploy.s.sol`), correctamente fuera del código.

### 3. B-MED-2 — renounceOwnership — **VERIFICADO**
- `:219-221`: override `public view onlyOwner` → `revert UseRenounceUpgrade()`.
- PoC: owner llamando `renounceOwnership` → `UseRenounceUpgrade`, owner sin cambios; no-owner → `OwnableUnauthorizedAccount`, owner sin cambios.
- **Otros paths a owner==0:** verificado `transferOwnership(address(0))` (Ownable2Step) solo setea `pendingOwner=0`, que nunca puede `acceptOwnership` → owner **nunca** llega a `address(0)`. No queda path accidental a estado terminal divergente. ✅

### 4. B-MED-3 — proposeUpgrade — **VERIFICADO**
- `:197-203`: `onlyOwner` + `if (newImpl==0) revert ZeroAddress()` + `if (newImpl.code.length==0) revert NotAContract()` + emite `UpgradeProposed(newImpl, eta)`.
- PoC: `proposeUpgrade(0)` → `ZeroAddress`; `proposeUpgrade(0xDEAD)` (sin code) → `NotAContract`.
- **Edge "no-UUPS":** PoC — proponer un contrato CON code pero no-UUPS pasa el check de code (correcto, no se puede detectar UUPS en propose barato), pero `upgradeToAndCall` luego REVIERTE (ERC1967 exige `proxiableUUID`). El proxy **no se puede brickear** con una impl no-UUPS. ✅

### 5. C-MED-1 — MAX_BATCH — **VERIFICADO**
- `:172`: `if (len == 0 || len > MAX_BATCH) revert InvalidBatchSize();` (temprano, antes del loop), `MAX_BATCH = 256` (`:43`).
- PoC: `len==0` → `InvalidBatchSize`; `len==257` → `InvalidBatchSize` (revert barato y temprano).
- **256 seguro vs gas:** batch lleno de 256 = **8.76M gas** medido. Base block gas limit (~120M+) lo absorbe con margen 13×; aun bajo un límite de 30M cabe holgado. Tope conservador y correcto. ✅

### 6. B-BAJO-1 — expiry + cancel — **VERIFICADO**
- `_authorizeUpgrade` `:225-234`: ventana `[eta, eta+UPGRADE_GRACE]` (GRACE=7d, `:44`); rechaza `proposedAt==0`, antes de `eta`, y pasado `eta+GRACE` con `TimelockNotElapsed`; `delete _upgradeProposedAt[slot]` consume la propuesta.
- PoC expiry: upgrade a `eta+GRACE+1` → `TimelockNotElapsed` (propuesta vieja muerta). ✅
- PoC consume/replay: tras un upgrade exitoso, un segundo `upgradeToAndCall` a la MISMA impl sin re-proponer → `TimelockNotElapsed` (slot borrado, no re-ejecutable). ✅
- PoC cancel: `cancelUpgrade` no-owner → revert Ownable; owner → limpia slot + emite `UpgradeCancelled`; upgrade posterior → `TimelockNotElapsed`. ✅
- No queda edge de propuesta vieja viva: la única forma de ejecutar es dentro de la ventana, y cada slot se borra al consumir o cancelar.

### 7. F-A4 — deadline máximo — **VERIFICADO**
- `_verifyAndConsume` `:127`: `if (deadline > block.timestamp + MAX_DEADLINE_TTL) revert DeadlineTooFar();` (MAX_DEADLINE_TTL=1h, `:45`), junto al lower-bound `:125`.
- PoC: deadline exacto `now+1h` → liquida OK (no rompe el flujo normal del operador que firma TTL corto); `now+1h+1` → `DeadlineTooFar`. ✅
- Acota la ventana de vida de la firma (defensa en profundidad sobre F-A1, ya cerrado por onlyOperator).

### 8. CD-9 — storage layout — **VEREDICTO: SEGURO** (verificado `forge inspect`)
| Slot | Var (nueva) | vs vieja |
|---|---|---|
| 0 | `_usdc` | igual |
| 1 | `_upgradeTimelock` | igual |
| 2 | `_upgradeRenounced` | igual |
| 3 | `_balances` | igual |
| 4 | `_depositor` | igual |
| 5 | `_lockedAmount` | igual |
| 6 | `_usedNonces` | igual |
| 7 | `_upgradeProposedAt` | igual |
| 8 | `_operator` | **NUEVO** (consume el primer slot del gap viejo) |
| 9..51 | `__gap[43]` | era `__gap[44]` slot 8..51 |

- (a) Ninguna variable previa se movió de slot — un upgrade desde la versión vieja (`ba3ea69`) NO colisiona. ✅
- (b) `_operator` ocupa un slot NUEVO (8), antes el inicio del `__gap`. Append-pattern canónico OZ. ✅
- (c) Total slots **52** preservado: 9 vars (slots 0-8) + `__gap[43]` (slots 9-51 = 43 slots) = 52. Idéntico a la versión vieja (8 vars 0-7 + gap 44 slots 8-51 = 52). ✅
- Money-custody: cero riesgo de corrupción de balances por colisión de storage en el upgrade.

### 9. Regresiones — **NINGUNA**
- AC originales: deposit/debit/withdraw/escrowBalance todos PASS en la suite 43/43 + 100% coverage.
- CD-2 (operador no drena sin firma): invariant `invariant_operatorCannotDrainWithoutSig` PASS (12 800 calls, 0 reverts violatorios). El ghost counter `ghost_hostileAttempts/Reverts` (forge `operatorDrainAttempt` + `botFrontRunAttempt` + `operatorWithdrawAttempt`) confirma que TODO intento hostil revierte.
- Nuevo handler `botFrontRunAttempt` (F-A1) integrado al invariant: un bot con firma válida presentándose como no-operador SIEMPRE revierte. Sólido.
- Solvencia: `invariant_solvency_balanceGteSumBalances` PASS.
- CEI/reentrancy: intactos — guards `nonReentrant` en deposit/debit/debitBatch/withdraw; Effects (nonce + balance) antes de cada `safeTransfer`; en batch el transfer agregado va DESPUÉS de todos los Effects.

---

## Hallazgos NUEVOS introducidos por el fix-pack
**NINGUNO.** 0 BLQ-ALTO / 0 BLQ-MED / 0 BLQ-BAJO / 0 MNR nuevos.

Observación no-finding (informativa, ya documentada en NatSpec `:18-21`): el modelo onlyOperator concentra el liveness de liquidación en una sola address; si esa key se pierde/compromete, el owner debe `setOperator` para restaurar el servicio (un operador comprometido NO puede robar — sigue necesitando firma del depositor). Es el trade-off explícito de la opción elegida vs recipient-en-firma. No reabre F-A1 ni ningún AC.

## Estado de los hallazgos del audit original
| ID | Severidad orig | Fix | Estado |
|---|---|---|---|
| F-A1 | CRÍTICO | onlyOperator | **CERRADO** (PoC) |
| F-A2 | ALTO | onlyOperator | **CERRADO** (PoC) |
| F-A4 | BAJO | DeadlineTooFar | **CERRADO** (PoC) |
| B-MED-1 | MED | MIN_TIMELOCK | **CERRADO** (PoC) |
| B-MED-2 | MED | renounceOwnership override | **CERRADO** (PoC) |
| B-MED-3 | MED | propose validación+evento | **CERRADO** (PoC) |
| B-BAJO-1 | BAJO | expiry+cancel+consume | **CERRADO** (PoC) |
| C-MED-1 | MED | MAX_BATCH=256 | **CERRADO** (PoC + gas) |
| BLQ-ALTO-1 (deploy 60s+EOA) | ALTO | MIN_TIMELOCK fuerza ≥2d en código; owner=env | Mitigado en código (timelock); owner=multisig sigue siendo config de deploy |

MENORs no-código del audit (MNR-1 USDC pause, MNR-2 sweep, MNR-3 deposit-delta, MNR-4 lock explícito mainnet, F-A3 delta-convention) son riesgos aceptados/documentados — fuera del scope de este fix-pack, sin regresión.
