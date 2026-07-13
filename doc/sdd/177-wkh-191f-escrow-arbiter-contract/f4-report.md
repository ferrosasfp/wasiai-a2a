# F4 Validation Report — WKH-191f: Escrow árbitro (rol + consent + lock + resolveDispute)

> Agente: nexus-qa (F4) · Fecha: 2026-07-13
> Input: work-item.md, sdd.md, story-HU-191f.md, ar-report.md (APROBADO, 0 BLQ), cr-report.md (APROBADO, 0 BLQ)
> Runtime checks ejecutados por QA en esta sesión (no re-ejecuto gates que CR ya confirmó salvo para re-verificar el número exacto)

**Veredicto: APROBADO PARA DONE — con 1 acción obligatoria pre-commit (MNR-1 de AR) y 1 nota de doc-drift para nexus-docs.**

---

## 1. Runtime / Build / Test (ejecutado por QA, no solo leído de CR)

| Check | Comando | Resultado |
|---|---|---|
| Build | `forge build` | **exit 0**, solo lint-notes (`named-struct-fields`, `asm-keccak256`, `mixed-case-variable`, `unwrapped-modifier-logic`) — cero errores/warnings de compilación |
| Test suite | `forge test` | **76 passed / 0 failed / 0 skipped** (3 suites: `WasiAIEscrow.t.sol`, `WasiAIEscrow.invariant.t.sol`, `WasiAIEscrow.invariant2.t.sol`), fuzz `runs=256 depth=50`, coincide exacto con lo reportado por AR y CR |
| Storage layout | `forge inspect WasiAIEscrow storage-layout` | ver §2 — UUPS-safe confirmado por QA de forma independiente |

## 2. Storage-Layout UUPS (AC-7) — verificado por QA con `forge inspect`

Baseline (`git show HEAD:contracts/src/WasiAIEscrow.sol`, pre-191f, slots 0-8):
`_usdc`(0) `_upgradeTimelock`(1) `_upgradeRenounced`(2) `_balances`(3) `_depositor`(4)
`_lockedAmount`(5) `_usedNonces`(6) `_upgradeProposedAt`(7) `_operator`(8) → `__gap[43]`(9..51).

Working tree (post-191f, `forge inspect`):
slots 0-8 **idénticos** en nombre/tipo/orden → `_arbiter`(9, address, NEW) → `_arbitrationConsent`(10,
mapping bytes32=>bool, NEW) → `__gap[41]`(11..51).

Región reservada termina en el mismo slot **51** antes y después (43 slots desde 9 = hasta 51; 41
slots desde 11 = hasta 51). Cero desplazamiento de storage preexistente. `initialize()` sin diff
(`git diff` no toca las líneas 73-89 del contrato original) — byte-idéntico, sin `reinitializer`.
**AC-7: PASS.**

## 3. Diff real (line-level) — confirma que `deposit`/`debit`/`debitBatch`/`withdraw` no se tocaron (CD-7)

`git --no-pager diff -- contracts/src/WasiAIEscrow.sol` → 2 únicos hunks: (a) `:56-63` cambio de
`__gap[43]`→`[41]` + 2 vars nuevas, (b) inserciones de funciones nuevas entre `setOperator` y
`deposit` (`:101-143`) y entre `withdraw` y `proposeUpgrade` (`:234-292`). Ningún hunk toca el cuerpo
de `deposit`/`_verifyAndConsume`/`debit`/`debitBatch`/`withdraw`/`initialize`. **Confirmado: CD-7
cumplido, funciones core byte-idénticas.**

## 4. ACs (evidencia archivo:línea, verificada por QA)

| AC | Texto (resumen) | Status | Evidencia |
|----|---|--------|-----------|
| AC-1 | `setArbitrationConsent(keyId,true)` persiste opt-in + evento | PASS | `WasiAIEscrow.sol:133-139` (`_arbitrationConsent[keyId]=true; emit ArbitrationConsentSet`); test `WasiAIEscrow.t.sol:612` `test_SetArbitrationConsent_byDepositor_persists_emitsEvent` |
| AC-2 | `resolveDispute`/`lockForDispute` sin consent → `ArbitrationNotConsented`, sin mover fondos | PASS | `:267 if(!_arbitrationConsent[keyId]) revert ArbitrationNotConsented()` (resolve) y `:246` (lock); test `t.sol:761` `test_RevertWhen_Resolve_withoutConsent`, `t.sol:672` `test_RevertWhen_Lock_withoutConsent` |
| AC-3 | `resolveDispute` happy path: paga seller, decrementa balance, lock=0, nonce consumido, evento | PASS | `:267-288` (Effects antes de Interactions); test `t.sol:714-732` `test_ResolveDispute_happy_paysSeller_zeroesLock` (asserts balance seller 60e6, escrowBalance 40e6, lockedAmount 0, replay revierte) |
| AC-4 | caller ≠ `_arbiter` en resolve/lock/release → `NotArbiter` sin importar consent | PASS | modifier `onlyArbiter` `:108-111`; test `t.sol:749-758` `test_RevertWhen_Resolve_byNonArbiter` (con consent+lock presentes, igual revierte), `t.sol:664` `test_RevertWhen_Lock_byNonArbiter` |
| AC-5 | replay `(keyId,nonce)` → `NonceAlreadyUsed` | PASS | `:276 if(_usedNonces[keyId][nonce]) revert NonceAlreadyUsed()`; test `t.sol:815-828` `test_RevertWhen_Resolve_nonceReplay` (re-lock intermedio, replay sigue revirtiendo por nonce) |
| AC-6 | `sellerAmount > escrowBalance` → `InsufficientBalance`, sin transfer parcial | PASS | `:283-284`; test `t.sol:779-793` `test_RevertWhen_Resolve_exceedsBalance` (edge: lock=100, debit baja balance a 50, sellerAmount=60 > bal=50 → revert) |
| AC-7 | storage-layout UUPS-safe, `__gap 43→41`, `initialize` byte-idéntico | PASS | ver §2 (verificado con `forge inspect` por QA, independiente de AR/CR) |
| AC-8 | `setArbiter` onlyOwner + zero-guard + `ArbiterUpdated` | PASS | `:118-124`; espejo de `setOperator` `:97-102`; test `t.sol:590` `test_SetArbiter_byOwner_rotates_emitsEvent` |
| AC-9 | invariantes extendidas: `ghost_totalArbiterResolved` + hostile-witnesses, 8 preexistentes sin relajar | PASS | `invariant.t.sol:42,227,375` y `invariant2.t.sol:91,476,677` (`ghost_totalArbiterResolved`, `invariant_lockNeverExceedsBalance`); identidad extendida `invariant.t.sol:368-372` (`ghost_totalDeposited - ghost_totalDebited - ghost_totalWithdrawn - ghost_totalArbiterResolved`); handlers hostiles `resolveByNonArbiter`/`resolveWithoutConsent`/`resolveOverLocked`/`resolveReplay`(`invariant2.t.sol:495,510,526,544`)/`lockByNonArbiter`; **76/76 tests verdes confirma que las 8 invariantes preexistentes + las nuevas pasan sin relajarse** |
| AC-10 | `lockForDispute` incremental, `newLocked<=balance`, evento `DisputeLocked` | PASS | `:245-252`; test `t.sol:650` `test_LockForDispute_byArbiter_locks_emitsEvent`, `t.sol:680` `test_RevertWhen_Lock_exceedsBalance`, `t.sol:688` `test_RevertWhen_Lock_zeroAmount` |
| AC-11 | `withdraw` respeta el lock (`amount <= balance-locked`), sin tocar el código de `withdraw` | PASS | `withdraw` sin diff (confirmado §3); test `t.sol:697-711` `test_Withdraw_blockedByLock` (deposit 100, lock 60, withdraw 41 revierte `InsufficientBalance`, withdraw 40 OK) |
| AC-12 | `resolveDispute` deja `lockedAmount==0` + residual disponible; `releaseDispute` (buyer gana) pone lock=0 + evento | PASS | `:284` (`_lockedAmount[keyId]=0` en resolve), `:254-260` (`releaseDispute`); test `t.sol:733-746` `test_ResolveDispute_residual_withdrawableByBuyer`, test `t.sol:831` `test_ReleaseDispute_buyerWins_unlocks` |
| AC-13 | consent monotónico: `false` → `ConsentIrrevocable`; no-depositante → `Unauthorized`; `true→true` idempotente sin evento | PASS | `:134-138`; test `t.sol:621` `test_RevertWhen_Consent_byNonDepositor`, `t.sol:628` `test_RevertWhen_Consent_revoke`, `t.sol:637` `test_Consent_idempotent_trueTwice_noEvent` |

**13/13 ACs — PASS, todos con evidencia archivo:línea verificada directamente por QA (no solo citada de AR/CR).**

## 5. Re-entrancy (foco explícito de la tarea)

`test_ResolveDispute_reentrancy_guarded` (`WasiAIEscrow.t.sol:858-891`) — leído completo por QA.
Deviación documentada por CR (arbiter=token) verificada como **genuina y necesaria**: el mock
`ReentrantUSDC.sol` (leído completo) re-entra `resolveDispute` desde `transfer()` con el mismo
`(keyId,nonce)`; como `resolveDispute` está tras `onlyArbiter`, sólo seteando el token como arbiter
se puede alcanzar el guard `nonReentrant` de verdad (si no, la reentrada rebotaría antes en
`NotArbiter` y el test no probaría nada). El test asserta balance=100e6, lock=60e6, seller=0 tras el
revert. Confirmado: CEI + `nonReentrant` funcionan.

## 6. Drift

- **Scope**: `git diff --stat` → solo `contracts/src/WasiAIEscrow.sol`, `contracts/src/interfaces/IWasiAIEscrow.sol`, `contracts/test/WasiAIEscrow.{t,invariant.t,invariant2.t}.sol` + `doc/sdd/_INDEX.md` (orquestador). `contracts/script/Deploy.s.sol`, `src/adapters/escrow/*`, `src/services/arbiter.ts` → sin diff (confirmado, 0 líneas). Ningún archivo fuera de Scope IN.
- **Wave**: único commit de código de la Wave 1 (191f); no pisa work de 191g/191h (ambos Scope OUT, sin tocar). Working tree está sobre `main` directamente (no hay branch `feat/191f-escrow-arbiter-contract` creado aún — el Story File sugiere ese branch; no es bloqueante para F4 pero lo dejo anotado).
- **Spec drift**: spot-check de 3 funciones (`resolveDispute`, `lockForDispute`, `setArbitrationConsent`) contra SDD §2/§4 → coinciden exacto en orden de checks, errores y nombres.
- **Expansión de scope AC-10/11/12 (lock)**: el work-item.md original (F1) sólo tenía AC-1..AC-9 y dejaba DT-5 (withdraw-race durante disputa) como `[NEEDS CLARIFICATION]`. El SDD (F2, `sdd.md:27`) decidió explícitamente **cerrar DT-5 dentro de esta misma HU** agregando `lockForDispute`/`releaseDispute` + AC-10..AC-13 — decisión de Architect documentada, no drift no autorizado. AR y CR ya revisaron y aprobaron esta superficie ampliada.
- **Doc-drift (para nexus-docs)**: la fila 177 de `doc/sdd/_INDEX.md` (agregada en este mismo diff) todavía describe "Hallazgo de seguridad nuevo documentado (DT-5, **NO resuelto acá**)" — pero el código SÍ lo resuelve (lock on-chain, AC-10/11/12). Este texto quedó desactualizado respecto a la decisión de F2. **Nota para nexus-docs**: corregir la redacción de la fila 177 en el done-report/_INDEX final para reflejar que DT-5 quedó cerrado por el lock, no diferido.

## 7. Gate Confirmation (leído de AR + CR, no re-ejecutado dos veces — sólo re-corrí forge build/test una vez para evidencia propia de F4 por ser el único gate real de esta HU)

- AR (`ar-report.md`): APROBADO, 0 BLOQUEANTE, 2 MENOR (MNR-1 mock untracked, MNR-2 namespace nonce compartido — informativo, sin acción). `forge test`: 76 passed/0 failed reportado por AR — **coincide con lo que QA corrió independientemente**.
- CR (`cr-report.md`): APROBADO, 0 BLOQUEANTE, 2 MENOR (MNR-1 fuerza de detección del witness hostil bajo `fail_on_revert=false` — sistémico/preexistente, no de esta HU; MNR-2 comentario impreciso en `resolveOverLocked` línea 288). `forge build`/`forge test` reportado idéntico por CR.
- No hay gates adicionales que CR no haya cubierto (no aplica lint TS/tsc/vitest — esta HU es 100% Solidity).

## 8. Acción obligatoria antes de DONE (MNR-1 de AR, confirmado por QA en esta sesión)

**`contracts/test/mocks/ReentrantUSDC.sol` sigue UNTRACKED en git** (`git status` → `?? contracts/test/mocks/ReentrantUSDC.sol`, verificado en este momento por QA). `WasiAIEscrow.t.sol:13` lo importa y el test de re-entrancy (§5, baranda de seguridad real) depende de él. Si el commit del fix-pack/DONE usa `git commit -am` o cualquier flujo que no haga `git add` explícito de este archivo, el build rompe en cualquier clone limpio / CI y la suite entera queda roja (76→0 passed por fallo de compilación, no por fallo de test).

**Acción**: `git add contracts/test/mocks/ReentrantUSDC.sol` DEBE incluirse en el commit que cierre esta HU. No es opcional — sin esto, `forge build` falla fuera de este working tree local.

---

## Veredicto final

**13/13 ACs PASS con evidencia archivo:línea verificada independientemente por QA** (no solo re-leída
de AR/CR). Runtime checks (build, test, storage-layout) ejecutados y coinciden con lo reportado por
AR y CR. CEI/nonReentrant/anti-replay/access-control verificados por lectura directa del código y de
los tests que los ejercitan. Cero funciones core (`deposit`/`debit`/`debitBatch`/`withdraw`/
`initialize`) modificadas (confirmado por diff, no por inferencia). Cero scope drift no autorizado.

**APROBADO PARA DONE**, condicionado a: `git add contracts/test/mocks/ReentrantUSDC.sol` en el commit
final (bloqueante para CI, no para la lógica) + nota de redacción para nexus-docs en la fila 177 de
`_INDEX.md` (DT-5 quedó resuelto, no diferido).
