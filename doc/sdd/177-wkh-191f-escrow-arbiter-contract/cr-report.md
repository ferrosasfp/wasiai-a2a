# CR Report — #191f: Contrato árbitro + resolveDispute + lock (upgrade UUPS)

> Fase: Code Review (calidad) — sección Adversary
> Fecha: 2026-07-13
> Reviewer: nexus-adversary (CR)
> Input: story-HU-191f.md + sdd.md + `git diff` (WasiAIEscrow.sol, IWasiAIEscrow.sol, 3 test files, mocks/ReentrantUSDC.sol)
> Build/Test corridos por el reviewer: `forge build` OK (solo lint-notes named-struct-fields) · `forge test` = **76 passed, 0 failed, 0 skipped** (3 suites, runs=256 depth=50)

---

## Veredicto global: **APROBADO con MENORs**

Implementación fiel al SDD/Story File, idiomática, CEI/nonReentrant/SafeERC20 correctos, storage UUPS-safe exacto, interfaz sincronizada sin redeclaraciones, y las 8 invariantes preexistentes siguen presentes y verdes sin relajarse (se **extendieron**, no se reemplazaron). No hay BLOQUEANTEs. Un (1) MENOR informativo sobre la fuerza de detección del patrón de witnesses hostiles (sistémico/preexistente, compensado por los unit tests) y un nit de comentario.

---

## 1. Fidelidad SDD / Story File — OK

| Ítem | Evidencia | Estado |
|------|-----------|--------|
| Storage `_arbiter` + `_arbitrationConsent` justo después de `_operator`, antes de `__gap`, en ese orden | `WasiAIEscrow.sol:57-63` | OK |
| `__gap` 43→41 (−2) | `WasiAIEscrow.sol:63` | OK |
| `initialize()` byte-idéntico, sin `reinitializer`, `_arbiter` arranca en 0 | `WasiAIEscrow.sol:77-89` (sin cambios) | OK |
| `setArbiter` onlyOwner + zero-guard + `ArbiterUpdated` (espejo exacto de `setOperator`) | `:118-124` vs `:97-102` | OK |
| `onlyArbiter` modifier factorizado (estilo guard de `debit`) | `:108-111` | OK |
| `setArbitrationConsent` monotónico: no-depositor→`Unauthorized`, false→`ConsentIrrevocable`, true-idempotente no-op sin evento | `:133-139` | OK (idéntico al snippet W0 del SDD) |
| `lockForDispute` onlyArbiter + consent + `amount>0` + `newLocked<=balance`, incremental, `DisputeLocked` | `:245-252` | OK |
| `releaseDispute` onlyArbiter + `locked>0` → 0 + `DisputeReleased` | `:254-260` | OK |
| `resolveDispute` CEI estricto: consent→seller≠0→amount≠0→nonce→`≤locked`(`ExceedsLockedAmount`)→`≤bal`(`InsufficientBalance`); Effects (nonce+balance+lock=0) ANTES del `safeTransfer(seller,...)`; paga al **seller** param, no a `msg.sender`; `nonReentrant` | `:267-288` | OK (CD-2/3/4/8/9 cumplidos) |
| `withdraw` NO tocado (ya resta `_lockedAmount`) | `:188-194` sin diff | OK (CD-7) |
| Eventos/errores nuevos, nombres/`indexed` exactos | ver §5 | OK |

**Deviación (a) — handlers legit acotados a `balance-locked`**: `debitByOperator`/`withdrawByDepositor`/`withdrawAll`/`lockByArbiter` ahora acotan el amount a `bal - locked` en vez de `bal` (`invariant.t.sol:101-118, 205-211`; `invariant2.t.sol:455-461` y el `withdrawAll`). **Correcta**: modela un operator/depositor cooperativo que respeta el lock (disciplina R-1), mantiene `locked<=balance` para que `invariant_lockNeverExceedsBalance` se sostenga, y NO relaja ninguna invariante (con `locked==0` — estado pre-191f — `bal-locked==bal`, comportamiento idéntico). El camino de revert (withdraw/debit cruzando el lock) queda cubierto por los handlers hostiles `withdrawOverLock`. R-1 (operator adversario) es riesgo aceptado documentado (SDD §4.4/§8) y CD-7 prohíbe tocar `debit`.

**Deviación (b) — arbiter = token en el test de re-entrancy**: `WasiAIEscrow.t.sol:858-891` monta un escrow cuyo USDC es `ReentrantUSDC` y setea `setArbiter(address(rusdc))`. **Correcta y necesaria**: `resolveDispute` está tras `onlyArbiter`, así que la re-entrada desde el hook `transfer` sólo alcanza el guard `nonReentrant` si el que re-entra pasa `onlyArbiter` — hacer al token el árbitro es la única forma de ejercitar realmente el guard (si no, la re-entrada rebotaría en `NotArbiter` y el test no probaría el `nonReentrant`). Es un mock test-only; no toca producción.

## 2. Calidad de los tests nuevos (25 unit + handlers de invariante) — OK

- Los 25 unit prueban lo que dicen, con `vm.expectRevert(<selector específico>)` y `vm.expectEmit` por evento. Happy path verifica pago al seller, `_balances-=`, `lock==0`, nonce consumido y replay revierte (`t.sol:714-732`). Reverts cubren only-arbiter (incluso con consent+lock, `:749-758`), no-consent, over-locked (`ExceedsLockedAmount`), exceeds-balance (edge lock>balance construido vía `debit`, `:779-793`), zero-seller/zero-amount, nonce-replay (con re-lock intermedio, `:815-828`). `test_Withdraw_blockedByLock` (`:697-711`) prueba AC-11 sin tocar `withdraw`.
- Re-entrancy (`:858-891`): tras el revert asserta balance=100, lock=60, seller=0 → fondos intactos. Genuino (el guard se alcanza de verdad, no rebota en access-control).
- Invariantes: identidad de conservación extendida con `- ghost_totalArbiterResolved` en ambas suites (`invariant.t.sol:368-372`, `invariant2.t.sol:630-634`); mirror por-key descuenta `sellerAmount` en resolve (`invariant2.t.sol:478`); nueva `invariant_lockNeverExceedsBalance` en ambas (`:375-382` / `:677-686`). Handlers legit actualizan ghosts correctamente; hostiles (`resolveByNonArbiter`, `resolveWithoutConsent`, `resolveOverLocked`, `resolveReplay`, `lockByNonArbiter`, `withdrawOverLock`) ejercitan cada camino de revert. Las 8 invariantes preexistentes siguen declaradas y verdes.
- No se detectaron asserts tautológicos que enmascaren un bug: el `resolveReplay` replaya un `(keyId,sellerAmount,nonce)` realmente consumido y el check de nonce precede al de lock en el contrato → revierte por `NonceAlreadyUsed` (el motivo correcto).

## 3. Solidity idiomático / seguridad — OK

CEI estricto (Effects `:282-284` antes de Interactions `:286`), `nonReentrant` en `resolveDispute`, `SafeERC20.safeTransfer`, custom errors, `external`/`view` correctos, eventos con `indexed` consistentes con `Debited`/`OperatorUpdated`. `releaseDispute` sin `nonReentrant` es correcto (no hace transfer externo, sólo movimiento favorable al buyer). Patrón 100% consistente con `setOperator`/`debit`/`withdraw`. Sin imports nuevos (CD respetado). Sin `any`/casts peligrosos (N/A Solidity).

## 4. Storage / UUPS — OK

`_arbiter` (slot que era `__gap[0]`) + `_arbitrationConsent` (`__gap[1]`) agregados en orden, inmediatamente tras `_operator`; `__gap[43]→[41]`; comentario de layout presente y correcto (`:59-63`). `initialize()` sin cambios ni `reinitializer`. Efecto de arranque seguro documentado: `_arbiter==0` ⇒ `onlyArbiter` revierte siempre hasta el `setArbiter()` de 191h. AC-7/CD-1 cumplidos.

## 5. Interfaz — OK

`IWasiAIEscrow.sol`: 5 eventos nuevos (`:19-27`), 4 errores nuevos distintos (`:50-53`: `NotArbiter`, `ArbitrationNotConsented`, `ConsentIrrevocable`, `ExceedsLockedAmount`) y 8 firmas nuevas (`:76-95`). Verificado que NO se redeclaran los reusados (`ZeroAmount`, `ZeroAddress`, `InsufficientBalance`, `NonceAlreadyUsed`, `Unauthorized` siguen únicos, `:31-41`). Firmas/eventos coinciden byte-a-byte con la implementación.

## 6. Legibilidad — OK

Nombres claros y consistentes (`resolveDispute`/`lockForDispute`/`releaseDispute`/`setArbitrationConsent`). NatSpec por función con referencia al AC/CD. Rama de consent auto-documentada (revert vs no-op). Sin dead code.

---

## Hallazgos

### MNR-1 — Category: Test Coverage — Fuerza de detección del witness hostil bajo `fail_on_revert=false`
- **Archivo:línea**: `test/WasiAIEscrow.invariant.t.sol:243-323` y `test/WasiAIEscrow.invariant2.t.sol:544-576` (patrón `ghost_hostileAttempts++; try {...revert("VIOLATED")} catch {ghost_hostileReverts++}`), config `foundry.toml:24` (`fail_on_revert = false`).
- **Descripción**: Si un handler hostil lograra que la llamada protegida **tenga éxito** (violación real de access-control), el `revert("...VIOLATED...")` del cuerpo `try` hace revertir toda la llamada del handler; con `fail_on_revert=false` el fuzzer la ignora y **revierte también el `ghost_hostileAttempts++`** ejecutado antes del `try`. Resultado: `invariant_hostilePathAlwaysReverts`/`invariant_accessControlAlwaysReverts` (`attempts==reverts`) no observarían la violación por esta vía; la detección real recae en (a) los unit tests, que sí afirman selectores específicos con `vm.expectRevert`, y (b) las invariantes de estado (`conservation`, `lockNeverExceedsBalance`) sobre los handlers legítimos.
- **Por qué NO es bloqueante**: es una propiedad **sistémica/preexistente** de la suite (mismo patrón de `operatorDrainAttempt`/`botFrontRunAttempt`, auditado y aceptado; Exemplar 5 que el Architect mandó seguir). El Dev lo extendió fielmente. Los 25 unit tests prueban cada revert de access-control con selector exacto, y las invariantes de conservación cerrarían un drain persistente. No rompe ningún AC.
- **Sugerencia (opcional, backlog)**: mover el contador de `attempts` fuera del path que puede revertir (p.ej. contar en un handler wrapper que no revierta, o usar `assertTrue(success==false)` capturando el bool del `try`), o correr un subconjunto hostil con `fail_on_revert=true`. Aplica a TODA la suite, no sólo a 191f — evaluar como mejora transversal, no como fix de esta HU.

### MNR-2 — Category: Legibilidad — Comentario impreciso en `resolveOverLocked`
- **Archivo:línea**: `test/WasiAIEscrow.invariant.t.sol:288` — comentario `// expected — ExceedsLockedAmount (or ArbitrationNotConsented edge)`.
- **Descripción**: El handler tiene `if (!consented[k]) return;` (`:278`), así que la key siempre está consentida y la rama `ArbitrationNotConsented` es inalcanzable; el revert esperado es siempre `ExceedsLockedAmount`. Comentario levemente engañoso (el `catch` es genérico, no afecta correctitud).
- **Impacto**: nulo funcional; sólo claridad.
- **Sugerencia**: quitar el paréntesis "or ArbitrationNotConsented edge".

---

## Confirmaciones explícitas
- `forge build`: OK (solo lint-notes `named-struct-fields`, no-error, preexistentes en el estilo del repo).
- `forge test`: **76 passed / 0 failed / 0 skipped**.
- Invariantes preexistentes: las 8 siguen declaradas (`invariant_solvency_balanceGteSumBalances`, `invariant_operatorCannotDrainWithoutSig`, `invariant_hostilePathAlwaysReverts`, `invariant_solvency`, `invariant_conservation`, `invariant_perKeyBalanceMirror`, `invariant_accessControlAlwaysReverts`, `invariant_noReplay`, `invariant_noUnderflow`) + nueva `invariant_lockNeverExceedsBalance` en ambas suites. Ninguna relajada.
- Scope: sólo los 6 archivos del Story File. `Deploy.s.sol`, `src/adapters/escrow/*`, `src/services/arbiter.ts` intactos. Sin scope drift.

---

*CR generado por NexusAgil — Adversary (Code Review de calidad).*
