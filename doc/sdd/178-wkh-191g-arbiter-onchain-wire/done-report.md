# Done Report — HU [WKH-191g] Wire de `arbiter.ts` al contrato `WasiAIEscrow`

## Resumen ejecutivo

**Entrega**: wire backend del árbitro al contrato `WasiAIEscrow` (`lockForDispute`/`resolveDispute`/`releaseDispute`, flag-gated por `ESCROW_ARBITER_ENABLED` con triple gate: flag ON + escrow configurado + consentimiento on-chain). Wave 1 (HU 7/8) del epic WKH-191 (non-custodial settlement). Fallback byte-idéntico al path actual cuando el flag está OFF (default) o falta escrow/consentimiento. Code-complete, inerte en runtime hasta WKH-191h (upgrade del contrato + `setArbiter()`). **Veredicto pipeline**: APROBADO 0 BLQ 1 MNR (refina R-3, no bloquea). **ACs**: 8/8 PASS. **Tests**: 2963 passed / 0 failed.

---

## Pipeline ejecutado

| Fase | Gate | Resultado | Fecha | Notas |
|------|------|-----------|-------|-------|
| F0 | Grounding | APROBADO | 2026-07-12 | `nexus-analyst`: contexto, 3 call-sites de wire en `arbiter.ts`, módulo executor nuevo, nonce namespace |
| F1 | HU_APPROVED | APROBADO | 2026-07-12 | 8 ACs (EARS), 5 DT, 7 CD, sizing L (revisa alza anterior: 3 call-sites + executor espejo + nonce gap) |
| F2 | SPEC_APPROVED | APROBADO | 2026-07-12 | SDD: flag name `ESCROW_ARBITER_ENABLED` (vs `ARBITER_ONCHAIN_ENABLED` propuesto), nonce derivación bit 255 confirmada, bypass de consentimiento confirmado DT-3/CD-7 |
| F2.5 | Story-HU | APROBADO | 2026-07-12 | 3 waves de implementación: (1) ABI + executor, (2) seam + defs, (3) wire + tests. Trazabilidad Wave 0→W3 verificada en F4. |
| F3 | Implementación | APROBADO | 2026-07-12 | Código completo según scope: 6 archivos (abi.ts, arbiter-executor.ts nuevo, escrow-verifier.ts, arbiter.ts, arbiter.test.ts, arbiter-executor.test.ts nuevo) + tests cobertura total |
| AR | Adversary Review | APROBADO 0 BLQ 1 MNR | 2026-07-13 | Foco: flag-off fallback byte-idéntico, triple gate, nonce disjunto (mecánica OK), mapeo desenlaces, key dedicada. MNR-1 refina R-3 (nonce pre-consumible, moneda futura) |
| CR | Code Review | APROBADO 0 BLQ 0 MNR | 2026-07-13 | Gates tsc/vitest/build/biome verificados. CR original no persistió artefacto a disco; QA reconstruyó con veredicto relayado. |
| F4 | QA Validation | APROBADO 8/8 ACs | 2026-07-13 | AC-1 fallback byte-idéntico, AC-2 consent check, AC-3 lock exactamente una vez, AC-4/AC-5 mapeo desenlaces, AC-6 ambiguous→reconcile, AC-7 no romper WKH-139/189, AC-8 ARBITER_PRIVATE_KEY. |

---

## Acceptance Criteria — resultado final

| AC | Texto (resumen EARS) | Status | Evidencia archivo:línea |
|----|----------------------|--------|------------------------|
| AC-1 | Flag OFF (default) o sin escrow → resuelve byte-idéntico al path actual, sin invocar `onlyArbiter` | PASS | `src/services/arbiter.ts:111` (`if (!isEscrowArbiterEnabled()) return settlePaymentIntentOnChain(base)`); test `arbiter.test.ts:1359` |
| AC-2 | Flag ON + escrow configurado → consulta `arbitrationConsent(keyId)` ANTES; `false` → fallback | PASS | `src/services/arbiter.ts:120-123` (`readArbitrationConsent`); `src/adapters/escrow-verifier.ts:132-151` (try/catch total); test `:1407` |
| AC-3 | Transición a `'disputed'` con consent true → `lockForDispute(keyId, authorized_usd_atomic)` best-effort exactamente UNA VEZ | PASS | `src/services/arbiter.ts:573` (único call-site `resolveDispute` servicio); helper `:172-205` (try/catch, log, no lanza); test `:1470` (`toHaveBeenCalledTimes(1)`) |
| AC-4 | `executeArbitration` release/split (`settleUsd>0`) + lock confirmed → `resolveDispute(keyId, seller, sellerAmount, nonce)` namespace disjunto de `debit()` | PASS | `src/services/arbiter.ts:728-735` (swap único `settleArbitrationOnChain`); `src/adapters/escrow/arbiter-executor.ts:72-83` (`deriveArbiterNonce` bit 255); test `:1439` (args exactos) + `:488-511` (nonce `>= 2^255`) |
| AC-5 | `executeArbitration` refund (`settleUsd<=0`) → `releaseDispute(keyId)` en lugar de lock huérfano | PASS | `src/services/arbiter.ts:700-703` (rama `arbMicro<=0` → `bestEffortReleaseDispute`); test `:1495` (`db.refunds==[10]`) |
| AC-6 | Cualquier leg `ambiguous` (timeout receipt / RPC unavailable) → marca para reconciliación, NO asume movimiento, NO reintenta | PASS | `src/services/arbiter.ts:144-160` (rama `ambiguous`→`failureKind:'ambiguous'`); `:798-814` (RECONCILE sin refund); test `:1563` (`db.status=='failed'`, `db.refunds==[]`) |
| AC-7 | Wire no operante → WKH-139 v2 + WKH-189 siguen funcionando byte-idénticamente, sin cambio observable | PASS | `resolveHold` (`:1087-1195`) delega a `executeArbitration` sin código nuevo; `rules.ts`/`llm-classifier.ts`/`evidence.ts`/`dashboard.html` sin diff; test `:879-925` flag-OFF byte-idéntico |
| AC-8 | Toda llamada `onlyArbiter` firmada EXCLUSIVAMENTE con `ARBITER_PRIVATE_KEY`, NUNCA `OPERATOR_PRIVATE_KEY` | PASS | `src/adapters/escrow/arbiter-executor.ts:110` (lee `process.env.ARBITER_PRIVATE_KEY`); cache propio Maps `:97-98`; `debit-executor.ts:77` intacto; test `:313`/`:325` (missing ARBITER / solo OPERATOR → not_moved) |

---

## Mapeo de desenlaces (DT-2, implementación)

### En `openDispute` (transición a `'disputed'`)
- `bestEffortLockForDispute(intentId, keyId, authorized_usd_atomic)` — ÚNICA llamada, cubre auto-resolve + `arb_hold`
- `authorized_usd_atomic` = deposit total (no `settleUsd` final, aún desconocido)
- Try/catch total, log (no lanza); outcome registrado en telemetría (`record_debit_hop1` precedente)

### En `executeArbitration` rama release/split (`arbMicro>0`)
- Swap: `settleArbitrationOnChain({intentId, ownerRef, payTo, finalAmountUsd, chainId})`
- Reemplaza única llamada `settlePaymentIntentOnChain(base)` (línea 728)
- Devuelve `SettleOutcome` idéntico (mismo contrato de ramas consumidoras `:737-814`)
- **Dentro del seam** si triple gate cumple:
  - `executeResolveDispute(keyId, seller=payTo, sellerAmount=finalAmountUsd, nonce=deriveArbiterNonce())`
  - Nonce namespace: bit 255 seteado (disjunto de `debit()` rango bajo)
- **Si triple gate falla** (flag OFF / sin escrow / consent=false):
  - `settlePaymentIntentOnChain(base)` — fallback byte-idéntico
- **Si seam lanza (wallet missing / contrato revert)**:
  - Caught, logged, fallback aplicado (AC-1)

### En `executeArbitration` rama refund total (`arbMicro<=0`)
- `bestEffortReleaseDispute(intentId, keyId)` — antes de refund off-chain
- Try/catch total; si falla (triple gate, status, exception), refund off-chain intacto
- No duplica lock huérfano (AC-5)

### En `resolveHold` (WKH-189)
- Delega a `executeArbitrationOld` → hereda mapeo sin código nuevo (CD-1)
- Cero diff en la función (verificado)

---

## Hallazgos finales

### BLOQUEANTEs
- **0 hallazgos bloqueantes** en AR/CR. El wire es aditivo, flag-gated, inerte (default OFF). Con flag OFF comportamiento byte-idéntico garantizado. 

### MENOREs
- **MNR-1** (AR, nonce pre-consumible — refina R-3): cuando 191h + `setArbitrationConsent` estén activos, un buyer perdedor puede pre-consumir el nonce derivado (determinista/público) vía `debit(keyId, ~0, deriveArbiterNonce(...), sig)` → `_usedNonces[keyId][nonce]=true` → `resolveDispute` revierte `NonceAlreadyUsed` → rama `unequivocal` → refund 100% al buyer, seller no cobra (evasión de pago, no griefing). **No bloquea 191g**. Aceptado como material de diseño para HU de contra-medida post-191h (DT-5, avaluar: (a) distinguir `NonceAlreadyUsed` en rama unequivocal + HOLD en lugar de refund, o (b) enforcement on-chain del namespace con bit 255 reservado en contrato). Testnet-only hoy.

---

## Auto-Blindaje consolidado

| Wave | Hallazgo | Causa | Fix | Aplicar en |
|------|----------|-------|-----|-----------|
| W2 | Import placeholder no-existe en arbiter.ts | Edición apresurada, copy sobrante | Remover línea fantasma; verificar con `grep "export <sym>"` | Cualquier edit de bloques `import { ... }` |
| W3 | Mocks vi.fn aridad fija + spread TS2556 | Patrón recurrente epic 191 — wrapper `(...a) => mockX(...a)` rechaza rest param | Tipar TODOS los mocks con `vi.fn((..._a: unknown[]): T => ...)` | Cualquier `vi.mock` factory reexpuesto vía spread |
| W3 | `release` requiere vouchers en evidencia | Rules `classify` NO clasifica release solo por `consumed>=deposit` | Agregar `voucherCount: 2, vouchersTotalUsd: 10` a evidencia de tests release | Cualquier test nuevo del árbitro que necesite veredicto `release` determinístico |

---

## Activación pendiente (gated)

1. **WKH-191h (deploy/upgrade on-chain + `setArbiter()`)**
   - Deploy UUPS + proxy upgrade vía multisig + timelock 2d
   - Call `setArbiter(arbiterAddress)` on-chain (solo una vez, `onlyOwner`)
   - Sin esto: todas las llamadas `onlyArbiter` de 191g revertiríen `NotArbiter` → `not_moved` → fallback (correcto, inerte)
   - Scope OUT de 191g; bloqueante de EJECUCIÓN REAL, NO de código

2. **Env vars (configuración runtime, NO código)**
   - `ARBITER_PRIVATE_KEY`: wallet privada del árbitro (debe matchear `_arbiter` on-chain post-setArbiter)
   - `ESCROW_ARBITER_ENABLED=true` (flag maestro, default false)
   - Sin estas: triple gate falla silenciosamente, fallback aplicado (comportamiento correcto)

3. **HU de captura de consentimiento on-chain (frontend/wallet, separada)**
   - El flujo de `setArbitrationConsent(keyId, true)` NO EXISTE en el codebase
   - Exige tx DIRECTA del depositante (no delegable por firma/relay, a diferencia de `DebitAuthorization`)
   - Gap de producto (DT-3), fuera de alcance backend-only wire
   - Sin esto: `arbitrationConsent(keyId)` siempre `false` → fallback SIEMPRE activo → comportamiento correcto (CD-7)
   - Sugerencia: HU nueva `WKH-191g-consent` (o absorbida por 191h si integra wallet-UX)

---

## Archivos modificados (git diff)

```
Scope IN (6 archivos):
  M src/adapters/escrow/abi.ts                     (+funciones nuevas lockForDispute/resolveDispute/releaseDispute/arbitrationConsent/lockedAmount + eventos)
  A src/adapters/escrow/arbiter-executor.ts        (nuevo módulo espejo debit-executor.ts, 3 executors + deriveArbiterNonce)
  M src/adapters/escrow-verifier.ts                (+helper readArbitrationConsent, reuso resolveEscrowContract)
  M src/services/arbiter.ts                        (seam settleArbitrationOnChain, best-effort lock/release, wire en 3 puntos)
  M src/services/arbiter.test.ts                   (+wire tests cobertura AC-1 a AC-8, flag OFF/ON, consent true/false, desenlaces)
  A src/adapters/escrow/arbiter-executor.test.ts   (nuevo, 18+ tests executor: wallet missing, write-failed, receipt-timeout, reverts, evento match)

Scope OUT (intactos):
  contracts/src/WasiAIEscrow.sol                   (191f, congelado)
  contracts/src/interfaces/IWasiAIEscrow.sol        (191f, congelado)
  src/adapters/escrow/debit-executor.ts            (sin diff, patrón copiado)
  src/services/arbiter/rules.ts                    (sin diff)
  src/services/arbiter/llm-classifier.ts           (sin diff)
  src/services/arbiter/evidence.ts                 (sin diff)
  src/services/arbiter/dashboard.html              (sin diff)
  supabase/                                        (sin migraciones, sin SQL)
```

---

## Decisiones diferidas a backlog

1. **Post-191h (contra-medida R-3 / MNR-1)**
   - Nonce pre-consumible: evaluar (a) branch `unequivocal` + NonceAlreadyUsed → HOLD en lugar de refund, o (b) reservation on-chain del bit 255
   - Material para HU nueva post-Wave 1

2. **Captura de consentimiento (producto, separada)**
   - HU nueva sugerida `WKH-191g-consent` (frontend/wallet)
   - Backend (191g) está listo; producto requiere que el buyer firme tx on-chain

3. **Telemetría del lock (low priority, logging default)**
   - Forma persistencia outcome `lockForDispute`: tabla dedicada vs logging estructurado
   - Arquitecto decidió logging (precedente `record_debit_hop1` de 191b); si más observabilidad, HU follow-up

---

## Lecciones para próximas HUs

1. **Bloques de imports en módulos nuevos**: verificar existencia de CADA símbolo antes de `tsc`. Patrón: `grep "export .* <sym>"` sobre el destino del import. Evitar copy-paste sobrante.

2. **Mocks vi.fn con spread: usar rest-param en la tipación**. No es suficiente tipar el wrapper; el mock mismo debe aceptar rest: `vi.fn((..._a: unknown[]): T => ...)`. Patrón recurrente en tests que reexponent mocks cacheados.

3. **Rules + evidence para veredictos específicos**: no asumir que un solo campo (p.ej. `consumed >= deposit`) determina la clasificación. La evidencia requiere correlación múltiple (p.ej. `voucherCount` + monto). Copiar exemplares de tests existentes al construir nuevos escenarios.

4. **Fallback byte-idéntico requiere revisión de forma de ramas consumidoras**: cuando introduzcas un seam que PUEDE retornar el resultado de la rama anterior (fallback), verificar que las 3+ ramas consumidoras del resultado NO cambian de forma (mismos campos, mismas aserciones). Diff línea-a-línea de las ramas post-seam + test específico `flag OFF → byte-idéntico`.

5. **Namespace de nonce disjunto en contexto de reuso de mapping**: cuando dos funciones on-chain (p.ej. `debit()` y `resolveDispute()`) compartan `_usedNonces[keyId][nonce]`, el bit de orden alto (255) es un patrón robusto para disjunción (público/derivable en app-side, no requiere estado on-chain dedicado). Confirmar en F2 la estrategia de derivación antes de codear.

---

## Estado final

**Code-complete, testeable con mocks, inerte en runtime hasta WKH-191h.**

- Todas las llamadas `onlyArbiter` de 191g son best-effort (no lanzan nunca).
- Triple gate asegurado: sin flag/escrow/consentimiento → fallback byte-idéntico.
- Nonce namespace disjunto (bit 255) previene colisión con `debit()`.
- `resolveHold` (WKH-189) hereda automáticamente sin código nuevo.
- WKH-139 v2 (auto-rules/llm/cap) + WKH-189 (override admin) siguen funcionando idénticamente.
- 2963 tests pasando, tsc 0, biome 0, build OK.

**Ready to merge** cuando WKH-191h deployee el upgrade on-chain y setee el arbitrador. Hasta entonces, el comportamiento en producción es 100% idéntico al path actual.

---

*Reporte generado por `nexus-docs` · Pipeline QUALITY NexusAgil · 2026-07-13*
