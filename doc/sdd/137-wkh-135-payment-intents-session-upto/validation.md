# Validation Report — WKH-135 Payment intents `session` + `upto` — re-F4 (DENSE)

**Veredicto**: **F4: PASS** — BLQ previo (double-refund) CERRADO con evidencia runtime +
DB real. Listo para DONE.
**Fecha**: 2026-07-03
**Branch**: `feat/137-wkh-135-payment-intents-session-upto` @ `01f1405` (fix-pack it.3, post PR #159)

---

## 1. Repro del doble-refund (BLQ previo) — CERRADO

### 1.1 Runtime (vitest, servicio real, `payment-intent.ts`)
`describe('BLQ-DR compound-failure (double-refund root fix)')`,
`src/services/payment-intent.test.ts:1061-1224` — 4 tests, DB in-memory FIEL a las
semánticas del RPC (status-gate + refund-inside, `failFinalize` simula un blip
atómico que NO muta nada — no un no-op que oculte el bug):

```
npx vitest run src/services/payment-intent.test.ts -t "BLQ-DR"
→ PASS (4) FAIL (0)
```

- `payment-intent.test.ts:1062-1106` — session, settle **inequívoco** falla → 1er
  `finalize` blip (`db.state.failFinalize=1`) → `closeSession` propaga `INTERNAL`,
  `db.refunds=[]`, `status='closing'`, `settle_outcome='failed_unequivocal'`
  (veredicto persistido). Retry → `db.refunds=[10]` (deposit completo, 1 vez). 3er
  retry (terminal) → `db.refunds` sigue `[10]`. `budgetPost = budgetPre - 10 + 10 =
  budgetPre` ✅ (línea 1103-1104). **Antes del fix: `[10, 6]` = 16 sobre 10.**
- `payment-intent.test.ts:1108-1133` — session éxito → finalize blip → recovery
  re-acredita el residual (6) **una sola vez** (`db.refunds=[6]` tras 2 llamadas más).
- `payment-intent.test.ts:1135-1158` — session ambiguo → finalize blip → recovery
  lee `failed_ambiguous` → `status='failed'`, `error_message` empieza con
  `RECONCILE:`, **`db.refunds=[]` siempre** (nunca refunda un caso ambiguo).
- `payment-intent.test.ts:1160-1223` — upto vía `expireStale()` (sweep real, no
  retry directo): débito 5 sobre budget 10 → settle falla → finalize blip →
  `expireStale` barre `closing` con `updated_at` viejo → `db.refunds=[5]` exactamente
  una vez; `budget` vuelve a 10.

### 1.2 DB real — Postgres 15 efímero (Docker `postgres:15-alpine`, destruido al final)
Migración completa aplicada (36 archivos no-`_down`, roles `anon`/`authenticated`/
`service_role` creados a mano + `kite_schema_transforms.sql` reordenado antes de
`20260610000000_wkh_sec02c_rls_registries.sql`, que lo altera) — **0 fallos**.

Repro exacto del escenario BLQ (deposit=10, consumed=4, key con `budget={"2368":"90"}`
tras el deposit ya reservado, intent insertado directamente en `status='closing'` +
`settle_outcome='failed_unequivocal'` — el estado exacto que dejaba el finalize-blip):

```sql
-- llamada 1
SELECT finalize_payment_intent(intent_id,'tenant-A',NULL,10,NULL,'failed_unequivocal','settle failed');
-- status: closing → refunded ; budget: {"2368":"90"} → {"2368":"100.00000000"}  ✅ refund aplicado

-- llamadas 2 y 3 (mismo call, simulando retry/expireStale re-invocando)
SELECT finalize_payment_intent(...);  -- x2 más
-- status permanece 'refunded' (status-gate: IF v_status <> 'closing' THEN RETURN)
-- budget permanece {"2368":"100.00000000"} en AMBAS  ✅ NO doble-refund
```
3 invocaciones de `finalize_payment_intent` → refund aplicado **exactamente 1 vez**
(`20260704000000_wkh135_payment_intents.sql:408-410` status-gate + `:422-437` refund
dentro de la misma tx). Confirmado también que un intento de "re-settlear" con
`p_outcome='settled'` + `txHash` distinto sobre un intent ya terminal es **no-op**
(status/tx_hash/budget sin cambios) — el status-gate ignora el argumento, no solo el
outcome. `record_settle_outcome` también verificado no-op post-terminal (money-free
de por sí, pero confirma el mecanismo).

**Veredicto**: BLQ previo (double-refund) — **CERRADO**. Root cause (refund fuera de
la tx del status + estado `closing` sin veredicto persistido) resuelto por: (1) refund
DENTRO de `finalize_payment_intent` (misma tx, status-gated en `closing`), (2) columna
`settle_outcome` + RPC `record_settle_outcome` (veredicto persistido money-free,
`normalizeVerdict(NULL)='failed_ambiguous'` money-safe), (3) chequeo del retorno de
`finalizePaymentIntent` en TODAS las ramas de fallo (`payment-intent.ts:597-608,
728-739, 767-776, 893-904, 1030-1039, 1064-1073`) → `INTERNAL` si falla, nunca afirma
un refund que no ocurrió.

---

## 2. ACs

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 (settle único, idempotencia por PK) | ✅ PASS | `close_payment_intent_for_settle` (migration:260-280, transición `open→closing` una sola vez). Test: `payment-intent.test.ts:220-254` (T-AC1). |
| AC-2 (refund del residual, incl. recovery compuesta) | ✅ PASS (antes: FAIL condicionado) | Refund dentro de `finalize_payment_intent` (migration:412-420). Test: `payment-intent.test.ts:1108-1133` (residual recovery, 1 vez) + DB real §1.2. |
| AC-3 (`upto` cobra exactamente `min(cap,uso)`) | ✅ PASS | `close_payment_intent_for_settle` (migration:270) + `payment-intent.ts:931-932`. Test: `payment-intent.test.ts` T-AC3 (sin cambios de este fix-pack). |
| AC-4 (Ownership Guard en toda tabla/RPC nueva, incl. `record_settle_outcome`) | ✅ PASS | Los 5 RPC (incl. el nuevo `record_settle_outcome`) validan `IS DISTINCT FROM p_owner_ref` bajo `FOR UPDATE` (migration:113-115,168-170,256-258,333-335,402-404). DB real: `has_function_privilege` → `anon`/`authenticated`=`f`, `service_role`=`t` para los 5. |
| AC-5 (literales APP `session`/`upto`) | ✅ PASS | `payments.ts:172,307`. |
| AC-6 (resolución determinística sin retención indefinida, incl. huérfano `closing`) | ✅ PASS (antes: FAIL condicionado) | `expireStale` (`payment-intent.ts:1089-1139`) barre `open` vencidos + `closing` huérfanos, ahora recuperados vía veredicto persistido (no asunción). Test: `payment-intent.test.ts:1160-1223` (upto vía `expireStale`, DB real). |

## 3. Invariantes money-path

| Invariante | Status | Evidencia |
|---|---|---|
| `upto` éxito: `budget_post == budget_pre − min(cap,uso)` | ✅ PASS | sin cambios de este fix-pack; reconfirmado por suite verde. |
| fallo inequívoco → `budget_post == budget_pre` (refund exactamente 1 vez, incl. compound-failure) | ✅ **PASS — BLQ CERRADO** | `payment-intent.test.ts:1062-1106` (`budgetPost===budgetPre`, no +6) + DB real §1.2 (3 finalize → 1 refund). |
| fallo ambiguo → NO refund + `RECONCILE:` + log, nunca doble-refund tras compound-failure | ✅ PASS | `payment-intent.test.ts:1135-1158` (`db.refunds=[]` incluso tras finalize-blip+retry). |
| fail-closed: budget insuficiente en `upto` → no transfiere | ✅ PASS | sin cambios; reconfirmado por suite verde. |

## 4. Runtime — gates

- `npx vitest run` (suite completa) → **PASS (2360) FAIL (0)** (re-ejecutado, incluye
  los 4 tests nuevos BLQ-DR).
- `npx tsc --noEmit` → `TypeScript compilation completed`, exit limpio (re-ejecutado).
- Migración Postgres 15 efímera: 36/36 aplicadas sin error, `_down` reversible
  (tabla + 5 RPC eliminados, confirmado por conteo `pg_proc` = 0 post-down).

## 5. Drift

- `git diff --name-only main...HEAD`: 11 archivos — mismo scope que el ciclo AR/CR
  previo (`payment-intent.ts`, `payment-intent.test.ts`, `database.types.ts`,
  la migración `.sql`/`_down.sql`, `auto-blindaje.md`, `story-HU-135.md`) + los ya
  aditivos (`payments.ts`, `payments.test.ts`, `index.ts`, `types/index.ts`). Cero
  archivos fuera de scope; `/compose`, `/orchestrate`, `fee-charge.ts` **sin cambios**
  (confirmado por grep sobre el diff).
- El fix-pack `01f1405` es exclusivamente sobre `payment-intent.ts` + su migración +
  tests — no reabre ningún otro archivo.

## 6. Gate Confirmation

- `auto-blindaje.md:3-42` documenta el fix-pack it.3 (BLQ-DR) con la misma causa raíz,
  fix y evidencia reportados acá — consistente con lo re-verificado independientemente
  en esta sesión (no solo leído, re-ejecutado: tests + DB real).
- No hay `cr-report.md` separado; el trazado AR/CR vive en `auto-blindaje.md` +
  mensajes de commit (`bf9eea2`, `bb7f08d`, `01f1405`).

---

## Veredicto final

**F4: PASS.**

El BLQ bloqueante del F4 anterior (double-refund, `budget_post ≠ budget_pre`, 16 sobre
un deposit de 10) está **CERRADO**: el fix de raíz mueve el refund DENTRO de la misma
transacción atómica que el status flip (`finalize_payment_intent`, status-gated en
`closing`), agrega un veredicto persistido (`settle_outcome`) que la recovery lee en
vez de asumir éxito, y verifica el retorno de `finalizePaymentIntent` en todas las
ramas de fallo. Reproducido y confirmado CERRADO en dos niveles independientes: (1)
runtime real contra el servicio (`payment-intent.test.ts:1061-1224`, DB in-memory
fiel al RPC), y (2) DB real en Postgres 15 efímero (3 invocaciones de
`finalize_payment_intent` → refund exactamente 1 vez, budget 90→100→100→100).

Todos los ACs (AC-1 a AC-6) y los 4 invariantes money-path: **PASS** con evidencia
archivo:línea + runtime + DB real. `npm test` 2360/2360, `tsc` limpio. Drift: none
(scope idéntico al fix-pack).

**Listo para DONE.**
