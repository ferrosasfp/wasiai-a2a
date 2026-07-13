# F4 — Validation Report — WKH-191c · Motor de reconciliación

> Agente: nexus-qa. Fecha: 2026-07-13.
> Input: work-item.md, sdd.md, story-HU-191c.md, ar-report.md (re-AR APROBADO, 0 BLQ),
> cr-report.md (APROBADO con MENORs), auto-blindaje.md.

## Veredicto global: APROBADO PARA DONE

0 BLOQUEANTES activos. 0 ACs en FAIL. 4 MENORes documentados como follow-up (no bloquean):
MNR-3 (recoverability de `resolving_settle` sin lease) y MNR-4 (owner_ref en el lease UPDATE)
del re-AR, más MNR-1/MNR-2 de CR (dead type surface). **Recomendación: cerrar como follow-up
de 191d (activación), NO ahora** — ninguno es money-unsafe ni bloquea el flujo happy-path; son
mejoras de recuperabilidad/consistencia que tienen más sentido junto con el runbook de
activación (191d), donde de todos modos se va a decidir el wiring del cron y el trigger real.

---

## Paso 1 — Runtime/Integration checks

### 1.1 — Gates ejecutados YO MISMO (no solo leídos del CR)

| Gate | Comando | Resultado |
|------|---------|-----------|
| Typecheck | `npx tsc --noEmit` | 0 errores (coincide con AR/CR) |
| Test suite completa | `npx vitest run` | `PASS (2927) FAIL (0)` — coincide EXACTO con el número que reporta el re-AR (2927 passed / 10 skipped) |
| Build | `npm run build` | exit 0, `tsc -p tsconfig.build.json` limpio |
| Lint (biome) | `./node_modules/.bin/biome check src/` | `Checked 321 files in 107ms. No fixes applied.` — 0 findings |

### 1.2 — Migración / Schema apply verification

`supabase/migrations/20260713000002_wkh191c_reconciliation.sql` + `_down.sql` existen en disco,
NO aplicados al remoto (consistente con 191a/191b, también PENDING-DEPLOY — no hay ninguna fila
`reconciliation_pending` en prod porque 191b no está activo). **NO VERIFICABLE en vivo**: un
intento de query read-only (`SELECT debit_settle_status FROM a2a_payment_intent_debit_signatures
LIMIT 1`) contra la DB compartida (`bdwvrwzvsldephfibmuu`, dev/staging de wasiai-v2) fue
**denegado por el sandbox** del entorno (clasificador de auto-mode: "shared/production Supabase
usando SERVICE_KEY sin target nombrado explícitamente"). No se intentó bypass. Dado que el propio
Scope OUT de la HU declara explícitamente "la activación de 191b en prod... pertenece a 191d" y
que el estado esperado es PENDING-DEPLOY (sin filas en el estado que esta HU resuelve), esto no
bloquea el veredicto — pero queda como acción de 191d: aplicar la migración + verificar
`\d a2a_payment_intent_debit_signatures` en el ambiente real antes de exponer los endpoints.

### 1.3 — Env vars parity

No introduce env vars nuevas obligatorias. `RECONCILE_DRIFT_ALERT_THRESHOLD_ATOMIC` (opcional,
`reconciliation.ts:157`) tiene default seguro (`0n` si ausente/vacío/no-parseable,
`reconciliation.ts:158-164`) — no requiere configuración para operar. `DASHBOARD_ADMIN_TOKEN`
ya existe desde WKH-189 (reusado, no nuevo). N/A verificación de paridad con deployment target.

### 1.4 — Smoke manual (para 191d, cuando se active)

1. Aplicar la migración `20260713000002_wkh191c_reconciliation.sql` en el ambiente objetivo.
2. Confirmar `\d a2a_payment_intent_debit_signatures` — CHECK con 7 valores, columnas
   `debit_resolution_tx_hash`/`debit_resolved_at` presentes, índice `idx_debit_sig_resolving`.
3. `GET /dashboard/api/reconciliation` con `X-Admin-Token` válido → 200, `pending: []`,
   `drift: []` (sin filas todavía) — confirma que el endpoint no rompe con DB vacía.
4. `POST /dashboard/api/reconciliation/:id/resolve` SIN header → 401/503 (según env) —
   confirma fail-closed real contra el server corriendo.
5. Con 191b activo y un intent real en `reconciliation_pending`: disparar el `POST` y
   verificar en DB que el intent terminó `resolved_settled` o `resolved_refunded` (nunca
   ambos) y que `escrowBalance(keyId)` on-chain refleja el resultado esperado.

---

## Paso 2 — AC Verification (evidencia archivo:línea)

| AC | Texto (resumen) | Status | Evidencia |
|----|------------------|--------|-----------|
| AC-1 | GET admin lista `hop1_confirmed`/`reconciliation_pending` con evidencia mínima | PASS | `src/services/reconciliation.ts:177-204` (`listPending`, filtra `PENDING_STATUSES` que incluye ambos estados, `:40-45`); endpoint `src/routes/dashboard.ts:326-348`; test `src/routes/dashboard.test.ts:301-338` (T-13) — 200, `pending` con `key_id/nonce/debit_hop1_tx_hash/finalAmountUsd/owner_ref/intent_id` |
| AC-2 | Re-verificar on-chain el evento `Debited` antes de decidir lado | PASS | `src/adapters/escrow/reconciler-onchain.ts:74-129` (`reverifyDebitedByTxHash`, log-scan con `decodeEventLog`+`parseAbiItem`, espejo `escrow-verifier.ts`/`debit-executor.ts` — DT-4); invocado ANTES del claim en `reconciliation.ts:259-268`; tests `src/adapters/escrow/reconciler-onchain.test.ts:105-180` (confirmed/not_confirmed en sus 2 variantes/indeterminate en sus 3 variantes) |
| AC-3 | `Debited` confirmed → hop2 exclusivo → `resolved_settled`, sin refund | PASS | `reconciliation.ts:298-341` (side settle → `settlePaymentIntentOnChain` directo, DT-R2) + `:365-366` (`terminal='resolved_settled'`, `refundAmount=null`); test T-5 `reconciliation.test.ts:161-211` (seam llamado, `p_refund_amount_usd:null`) |
| AC-4 | `Debited` NOT confirmed → refund BUDGET-ONLY, sin transfer on-chain | PASS | `reconciliation.ts:367-372` (`terminal='resolved_refunded'`, `txHash=null`, seam NUNCA invocado); refund real vive en `record_reconciliation_resolution` (migración:193-206) `refund_a2a_key_spend` DENTRO del RPC; test T-6 `reconciliation.test.ts:212-245` (`mockSettleSeam` NOT called, `p_tx_hash:null`, `p_refund_amount_usd:2`). **Nota de fidelidad**: el work-item original (AC-4 literal) especifica transfer directo operador→buyer + refund; el SDD/story-file resolvió esto a **budget-only** (DT-R4/NC-1, decisión de founder documentada) — desviación de spec documentada y aprobada en AR/CR, no un gap silencioso |
| AC-5 | Estado terminal ya persistido → no-op ante 2ª ejecución (money-safe) | PASS | `reconciliation.ts:288-291` (`claimRow.claimed===false` → `already_resolved`); RPC `claim_reconciliation` migración:106-117 (`v_rows=0` cuando ya terminal); test T-7 `reconciliation.test.ts:246-260` (`already_resolved`, seam no llamado, sin 2º `record`) |
| AC-6 | Nunca hop2-completado Y refund-ejecutado (mutuamente excluyente, CHECK DB) | PASS | migración:135-138/159-163 (`v_required` gated: `resolved_settled` SOLO desde `resolving_settle`, `resolved_refunded` SOLO desde `resolving_refund`) + CHECK 7-valores migración:20-26; test T-8 `reconciliation.test.ts:264-334` documenta el gating SQL como integración (no simulable sin Postgres) + asserta la invariante observable del service (nunca cruza terminal↔side) — revisado en CR/AR como honesto, no tautológico |
| AC-7 | Drift check budget-vs-`escrowBalance`, solo reporte | PASS | `reconciliation.ts:400-489` (`driftCheck`, agrupa por key, `escrowBalanceAtomic - sum`, `exceedsThreshold`, NUNCA escribe `budget`); test T-12 `reconciliation.test.ts:425-497` (incl. caso RPC-ausente → `escrowBalanceAtomic:null`, no asume 0) |
| AC-8 | `ESCROW_SETTLE_ENABLED` OFF → listado/drift permitidos, money-moving rechazado | PASS | GET no gatea el flag (`dashboard.ts:326-348`, corre siempre); `resolveIntent` gatea AL INICIO `reconciliation.ts:211-212` (`if (!isEscrowSettleEnabled()) return {status:'flag_off'}` — cero side-effect, cero lectura de dinero); test T-9 `reconciliation.test.ts:336-350` + T-13 `dashboard.test.ts:301-338` (GET con flag OFF devuelve 200 igual) |
| AC-9 | POST de ejecución sin `X-Admin-Token` válido → 401/403, sin acción money-moving | PASS | `requireAdminTokenStrict` `dashboard.ts:130-157` (fail-closed: 503 sin env SIEMPRE, 401 sin header o header inválido, `timingSafeEqual`); tests T-14a/b `dashboard.test.ts:341-364` (503 sin env, 401 sin header, `mockResolveIntent` NOT called en ambos) |

**9/9 ACs PASS con evidencia archivo:línea.**

---

## Paso 3 — Confirmación del fix del BLOQUEANTE (BLQ-ALTO-1, doble hop2)

Verificado en código, no solo en el ar-report:

- **Claim exclusivo** — `migración:92-103`: el WHERE del `UPDATE` en `claim_reconciliation` ya
  NO re-matchea `v_target` incondicionalmente. Confirmado línea por línea: entrada fresca
  (`hop1_confirmed`/`reconciliation_pending`) OR (`debit_settle_status = v_target` AND
  (`p_side='refund'` OR `debit_resolution_tx_hash IS NOT NULL`)). Un 2º run sobre
  `resolving_settle` sin tx previa → 0 filas → `claimed=false`.
- **Lease** — `reconciliation.ts:342-361`: tras un settle exitoso (`txHash` truthy), persiste
  `debit_resolution_tx_hash=txHash` ANTES del flip terminal (paso 7, línea 376+), vía `UPDATE`
  filtrado por `key_id+nonce+status='resolving_settle'`.
- **Re-verificación previa a re-envío** — `reconciliation.ts:298-320`: si el claim trae
  `resolution_tx_hash` no-null (crash-recovery), llama `verifyDefaultChainSettle` ANTES de
  cualquier re-envío; `warn` → abort `indeterminate` (nunca re-envía a ciegas); `ok` →
  `skipResend=true`.
- **Test de la race es genuino** — `reconciliation.test.ts:606-652` (describe `BLQ-ALTO-1 race
  del doble hop2`): el harness modela el WHERE real de la migración vía `opts.fixed`. El test
  `CONTROL (sin el fix)` (`:618-628`, `fixed:false`) reproduce el double-pay
  (`expect(seam()).toBe(1)` — un 2º run re-envía el hop2), demostrando que el test SÍ falla con
  la semántica pre-fix. El test `fixed:true` (`:606-616`) confirma `seam()===0` con el fix.
  Diferencial control/fix confirmado leyendo ambos bloques — no es un test tautológico que
  siempre pasa.

**BLQ-ALTO-1: RESUELTO y verificado en código (no solo en el reporte de AR).**

---

## Paso 4 — Drift Detection

- **Scope drift**: `git status --short --untracked-files=all` confirma únicamente archivos
  in-scope: `reconciler-onchain.ts`/`.test.ts` (nuevo adapter), `reconciliation.ts`/`.test.ts`
  (nuevo service), `dashboard.ts`/`.test.ts` (extensión, endpoints), `database.types.ts`
  (tipos RPC nuevos), 2 migraciones nuevas. **Cero** cambios en `contracts/` o `arbiter.ts`
  (grep confirmado — las únicas menciones a `arbiter` son referencias pre-existentes a
  `arbiterService`/`ArbiterError` en `dashboard.ts`, no ediciones a `arbiter.ts` mismo).
- **Wave drift**: ninguno — 1 sola wave de implementación + 1 fix-pack post-AR (documentado en
  `auto-blindaje.md:9-21`), orden correcto (F3 → AR → fix-pack → re-AR → CR → F4).
- **Spec drift documentado y correcto** (spot-check, ya auditado en CR Check 1):
  - VERIFY-AT-IMPL (R-5, nombre del CHECK autogenerado) — confirmado correcto por CR
    (61 chars, sin truncación, DROP matchea el nombre real).
  - DT-R2 (hop2 vía `settlePaymentIntentOnChain` directo, no `settleEscrowAware`) —
    confirmado en `reconciliation.ts:324` (import línea 35), consistente con el CD explícito
    del work-item de no duplicar hop1.
- **Test drift**: todos los tests referenciados en story-file/AR/CR (T-1..T-14, BLQ-ALTO-1)
  existen en disco con los números de línea reportados; no hay tests fantasma ni tests
  renombrados sin actualizar reportes.

**Drift: ninguno fuera de lo ya documentado y aprobado en AR/CR.**

---

## Paso 5 — Confirmación de gates (CR + AR + mi propia corrida, Paso 1.1)

| Gate | CR report | AR (re-AR) | QA (yo, corrida directa) |
|------|-----------|------------|---------------------------|
| tsc --noEmit | 0 errores | 0 errores | **0 errores (confirmado)** |
| vitest run | 2923/2923 (pre-fix-pack) | 2927 passed/10 skipped (post-fix-pack) | **PASS (2927) FAIL (0) (confirmado, coincide con re-AR)** |
| build | no reportado explícito por CR | no reportado por AR | **exit 0 (ejecutado por mí, gap cubierto)** |
| biome | 0 findings | 0 findings | **0 findings (confirmado)** |

Nota: ni AR ni CR corrieron explícitamente `npm run build` en sus reportes — lo ejecuté yo
como gate puntual no cubierto (regla de excepción del F4), sin re-ejecutar el resto por default.

---

## Paso 6 — Verificación de no-touch (contratos / seam / árbitro / refund budget-only)

- `contracts/`: cero archivos modificados (confirmado por `git status`).
- Seam (`payment-intent.ts`): NO modificado — `reconciliation.ts` solo lo IMPORTA
  (`reconciliation.ts:35`) y lo invoca (`:324`), reuso puro sin duplicar lógica de hop 1.
- `arbiter.ts`: cero archivos modificados (confirmado por `git status` + grep).
- Refund: 100% budget-only, verificado en 2 capas — (a) código: `reconciliation.ts:367-372`
  nunca invoca el seam en el lado refund; (b) migración: `refund_a2a_key_spend` (línea 196)
  es el ÚNICO efecto de dinero del lado refund, dentro del RPC, sin ningún `transfer`/llamada
  on-chain — consistente con DT-R4/NC-1 (decisión de founder: sin `withdraw()`, sin transfer
  operador→buyer real en este corte).

---

## MENORes residuales — recomendación de disposición

| MENOR | Origen | Riesgo | Recomendación |
|-------|--------|--------|----------------|
| MNR-1 (CR) | dead RETURNS surface en `claim_reconciliation` | nulo (ruido) | Backlog, no urgente |
| MNR-2 (CR) | `SigWithIntentRow` sobre-declara en `listPending` | nulo (ya resuelto post-fix-pack con `PendingSelectRow`, ver `reconciliation.ts:131-139`) | **Ya mitigado** — verificar si el CR de MNR-2 sigue vigente tal cual reportado o si el fix-pack ya lo cerró (el tipo acotado YA existe en el código actual) |
| MNR-3 (re-AR) | `resolving_settle` sin lease queda sin ruta de auto-recovery | money-SAFE (nunca double-paga/pierde fondos), solo operability | **Follow-up en 191d** — junto con el runbook de activación, donde de todos modos se define el trigger real/cron y tiene más sentido decidir si se agrega un endpoint de requeue |
| MNR-4 (re-AR) | lease UPDATE sin `owner_ref` explícito | no explotable (key_id+nonce único, fila ya owner-guarded por el claim previo) | **Follow-up en 191d** — 1 línea, defensa en profundidad, sin urgencia |

Confirmado en código: `reconciliation.ts:131-139` ya declara `PendingSelectRow` acotado
exactamente a las columnas del SELECT de `listPending` (`intent_id, key_id, debit_nonce,
debit_amount_atomic, debit_hop1_tx_hash, debit_settle_status, owner_ref` — sin
`debit_key_id_hash` ni el embed) — **MNR-2 del CR ya está resuelto en el código actual**, el
CR report simplemente lo documentó como aceptado antes de que quedara reflejado que el propio
fix-pack ya lo había cerrado (ver `auto-blindaje.md:19`: "nuevo tipo `PendingSelectRow`").

---

## Resumen

| Check | Resultado |
|-------|-----------|
| Gates (tsc/vitest/build/biome, ejecutados por mí) | PASS — 0/2927-0/0/0 |
| ACs (9/9) | PASS con evidencia archivo:línea |
| BLQ-ALTO-1 (doble hop2) | RESUELTO, verificado en código + test genuino (control falla sin fix) |
| Drift | Ninguno fuera de lo documentado en AR/CR |
| Scope (contracts/arbiter intactos, refund budget-only) | Confirmado |
| Migración aplicada en vivo | NO VERIFICABLE (sandbox bloqueó query read-only; esperado, PENDING-DEPLOY consistente con 191a/191b) |
| MENORes residuales | MNR-1/3/4 → follow-up (191d o backlog); MNR-2 → ya resuelto en código actual |

**Listo para DONE.** Ningún AC en FAIL, cero BLOQUEANTES activos. La única verificación NO
VERIFICABLE (aplicación real de la migración) no es exigible en esta HU — está fuera de scope
(pertenece a 191d) y el sandbox impide una prueba en vivo contra la DB compartida, consistente
con el resto del pipeline (191a/191b también quedaron PENDING-DEPLOY code-complete).
