# AR Report — HU 191f: Escrow árbitro (rol + consent + lock + resolveDispute, upgrade UUPS)

> Agente: nexus-adversary (AR) · Fecha: 2026-07-13
> Contrato money-path on-chain · máximo rigor
> Input: sdd.md + story-HU-191f.md + diff sobre contracts/{src,test}
> Build: `forge build` OK (solo lint notes) · `forge test`: **76 passed / 0 failed** (Foundry 1.5.1)

## Veredicto global: **APROBADO con MENORs**

Ningún BLOQUEANTE. Los 3 focos (storage UUPS, autoridad de `resolveDispute`, el lock/R-1)
resisten el ataque. Dos hallazgos MENOR (no bloquean el gate).

---

## 1. Storage Layout UUPS — **OK**

`forge inspect WasiAIEscrow storage-layout` (corrido en esta AR):

| Slot | Variable | Estado |
|------|----------|--------|
| 0-8 | `_usdc` … `_operator` | **idénticos al layout previo** (sin desplazamiento) |
| 9 | `_arbiter` (NEW) | era `__gap[0]` (cero) |
| 10 | `_arbitrationConsent` (NEW) | era `__gap[1]` (cero) |
| 11 | `__gap[41]` | era `__gap[2..]`; región termina en slot 51 (idéntica) |

Las 2 vars nuevas se consumen exclusivamente del `__gap`, inmediatamente después de `_operator`
y antes del gap. `__gap 43→41` (−2 = 1 address + 1 mapping). La región reservada total termina en
el mismo slot 51 pre y post upgrade → cero corrupción, upgrade UUPS-safe. `initialize()`
byte-idéntico (diff no lo toca), sin `reinitializer`, `_arbiter` arranca `address(0)`. AC-7 cumplido.

## 2. Autoridad de `resolveDispute` — **OK** (foco)

`WasiAIEscrow.sol:267-288`. Cadena de guards verificada:
`onlyArbiter` (modifier, primero) → consent → `seller!=0` → `sellerAmount!=0` → nonce libre →
`sellerAmount <= locked` (`ExceedsLockedAmount`) → `sellerAmount <= bal` (`InsufficientBalance`).

- El arbiter NO puede drenar fondos no disputados: sólo paga `<= _lockedAmount`, y `_lockedAmount`
  sólo se setea vía `lockForDispute` (que exige `onlyArbiter` + consent). Key no consentida ⇒
  `locked=0` ⇒ revert (además el check de consent es previo). Probado por handlers hostiles
  `resolveWithoutConsent` / `resolveByNonArbiter` / `resolveOverLocked` (todos revierten, fuzz 256×50).
- Paga al `seller` (param), no a `msg.sender` — non-custodial preservado (CD-9).
- `sellerAmount <= bal` NO es dead-code: es la baranda fail-closed de R-1 (defensa en profundidad).

## 3. CEI / Re-entrancy — **OK** (foco)

`:281-287` — Effects (`_usedNonces=true`, `_balances-=`, `_lockedAmount=0`) ANTES del
`safeTransfer`. `nonReentrant` presente. Test `test_ResolveDispute_reentrancy_guarded`
(`WasiAIEscrow.t.sol:858`) es **genuino**: usa `ReentrantUSDC` seteado como *arbiter* (así la
re-entrada supera `onlyArbiter` y ejerce de verdad el guard `nonReentrant`), re-entra con el mismo
`(keyId,nonce)`, la llamada externa revierte y verifica `balance==100e6`, `locked==60e6`,
`seller==0`. Doble baranda: `nonReentrant` + nonce ya marcado en Effects. USDC estándar no llama al
receptor, y aun así el vector se prueba.

## 4. Anti-replay — **OK**

`_usedNonces[keyId][nonce]` compartido con `debit` (reuso deliberado, CD-4). Replay revierte
`NonceAlreadyUsed` (test `test_RevertWhen_Resolve_nonceReplay` + handler `resolveReplay` en
invariant2). Nota (no finding, decisión documentada): el namespace es compartido entre el path
firmado por el depositante (`debit`) y el elegido por el arbiter (`resolveDispute`); un nonce
quemado por un path invalida el mismo nonce en el otro. Impacto nulo (espacio uint256, ambos roles
trusted, sin pérdida de fondos, re-firma trivial). Aceptado.

## 5. Consentimiento — **OK**

`setArbitrationConsent` (`:133-139`): sólo `_depositor[keyId]` (`Unauthorized` para tercero;
keyId sin depósito ⇒ `_depositor==0` ⇒ revert). Monotónico: `consent=false` ⇒ `ConsentIrrevocable`.
Idempotente `true→true` (no-op sin evento). No se puede consentir por key ajena (no sos su
depositor). Sin vector de griefing. AC-1/AC-13 cumplidos.

## 6. El Lock (R-1) — **OK** (foco)

`lockForDispute` (`:245-252`): `onlyArbiter` + consent + `amount>0` + `newLocked <= balance`.
`releaseDispute` (`:255-260`): libera sin pago (movimiento favorable al buyer, sin transfer externo).
`withdraw` (`:229-235`, **no tocado**) ya resta `_lockedAmount` ⇒ el buyer no puede evadir el lock.

**R-1 realmente fail-closed (verificado por análisis):** si un `debit` firmado baja `balance` bajo
`locked` (único camino que rompe `locked<=balance`, porque `debit` guardea contra `bal` no
`bal-locked`, y CD-7 prohíbe tocarlo):
- `withdraw`: `available = bal - locked` underflowea → revert (0.8.24 checked). Sin retiro.
- `resolveDispute`: `sellerAmount > bal` → `InsufficientBalance`. El arbiter paga a lo sumo `bal`.
- Resultado: DoS auto-infligido, los fondos ya salieron al **operator** (parte honesta del modelo),
  **NUNCA pérdida/robo**. Coincide con R-1 documentado + mitigación a 3 niveles. Aceptado.

## 7. Invariantes — **OK**

Las 8 preexistentes siguen SIN relajarse (siguen pasando, 256×50 calls):
`operatorCannotDrainWithoutSig`, `hostilePathAlwaysReverts`, `solvency*`, `conservation`,
`perKeyBalanceMirror`, `accessControlAlwaysReverts`, `noReplay`, `noUnderflow`. La identidad de
conservación se **extendió** (no reemplazó): `escrowUSDC == deposited − debited − withdrawn −
ghost_totalArbiterResolved`. `ghost_totalArbiterResolved` es genuino (se suma en `resolveByArbiter`
con `sellerAmount` real). Nueva `invariant_lockNeverExceedsBalance` en ambas suites (no
tautológica: fallaría si un handler cruzara el lock). Witnesses hostiles nuevos revierten al 100%
(`ghost_hostileAttempts==ghost_hostileReverts`).

**Escrutinio del bounding de los handlers legit (`debit`/`withdraw` → `bal-locked`):** NO enmascara
un bug. Modela al operator cooperativo de R-1 (disciplina operacional documentada). El escenario
adversarial —operator debita una key lockeada— está cubierto por el análisis fail-closed (§6): sólo
produce DoS, no pérdida. Es correcto reflejar el modelo trusted del operator; el contrato no
pretende garantizar `locked<=balance` on-chain contra un `debit` firmado (CD-7 + R-1 aceptado).

## 8. Non-custodial + arranque seguro — **OK**

`_arbiter` arranca `address(0)` ⇒ `onlyArbiter` revierte siempre ⇒ las 3 funciones del arbiter
inertes hasta `setArbiter()` (191h). `setArbiter` onlyOwner + zero-guard (AC-8). El arbiter SOLO
mueve fondos lockeados de keys consentidas. Garantía preservada.

## Categorías nuevas (9/10/11)

- **9. Destructive Migrations — N/A**: no hay SQL. El análogo (storage layout del upgrade) se cubrió
  en §1 (aditivo puro, sin desplazar slots, reversible por diseño UUPS).
- **10. RPC SECURITY DEFINER — N/A**: no hay funciones Postgres.
- **11. Cache Invalidation — N/A**: no se introduce cache.

## Scope Drift — **OK**

Sólo los 5 archivos in-scope + `test/mocks/ReentrantUSDC.sol` (in-scope por Story File §Files #6).
Ningún archivo bajo `src/` (TS), `Deploy.s.sol` ni money-path core (`deposit`/`debit`/`debitBatch`/
`withdraw`) modificado. `_INDEX.md` es del orquestador (esperado).

---

## Hallazgos

### MNR-1 — `ReentrantUSDC.sol` untracked en git (Test Coverage / Integration)
- **Archivo**: `contracts/test/mocks/ReentrantUSDC.sol` (`git status` = `??`, untracked).
- **Descripción**: el archivo del mock existe en disco (la suite compila y pasa localmente) pero NO
  está trackeado. `WasiAIEscrow.t.sol:13` lo importa.
- **Reproducción**: un `git commit` que sólo stage-e tracked files (`git commit -am`) omite el mock →
  en CI / otro clone, `forge build` falla (`import ... ReentrantUSDC` no resuelve) → suite entera roja.
- **Impacto**: rompe el build para terceros/CI; el test de re-entrancy (baranda de seguridad) se
  pierde silenciosamente si alguien lo borra.
- **Sugerencia**: `git add contracts/test/mocks/ReentrantUSDC.sol` antes del commit del fix-pack.
- **Severidad**: MENOR (no bloquea; local todo verde).

### MNR-2 — Namespace de nonce compartido `debit` ↔ `resolveDispute` (Data Integrity)
- **Archivo**: `WasiAIEscrow.sol:276` (`_usedNonces[keyId][nonce]`, mismo mapping que `_verifyAndConsume:170`).
- **Descripción**: decisión documentada (CD-4, reuso de mapping). Un nonce consumido por un path
  invalida el mismo `(keyId,nonce)` en el otro.
- **Impacto**: negligible — sin pérdida de fondos; ambos roles son trusted; espacio de nonce
  uint256; re-selección trivial. Se reporta sólo para trazabilidad; NO requiere fix.
- **Severidad**: MENOR (informativo; aceptado por diseño).

---

## Resumen para el fix-pack (orden de prioridad)
1. MNR-1 — `git add` del mock (evita CI roja). Trivial.
2. MNR-2 — informativo; sin acción requerida.

Ningún BLOQUEANTE → el gate AR **PASA**. Puede avanzar a CR.
