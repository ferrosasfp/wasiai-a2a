# Done Report — HU #137 [WKH-135] Intents de pago `session` + `upto`

## Resumen ejecutivo

**Entregado**: dos intents de pago nuevos (`session` metered + `upto` cap dual-firmado) con naming compatible con OKX Agent Payments Protocol, full money-path completo (deposit, vouchers, settlement, refund del residual, min(cap, usage)). Migración Postgres (2 tablas + 5 RPCs atómicos con Ownership Guard), servicio con EIP-712 del cap y settle multi-chain, endpoints `/payments/session/*` + `/payments/upto/*` con auth middleware, 11 archivos modificados, suite verde (2361 tests), 4 iteraciones de fix-pack money-path identificadas y cerradas en F3/AR/F4 QA. **Status: DONE**, listo para merge + deploy.

**Branch**: `feat/137-wkh-135-payment-intents-session-upto`, HEAD `c42d0e5`, PR #159 (base main, sin mergear — hold explícito).

---

## Pipeline ejecutado

- **F0**: project-context `doc/sdd/` + codebase grounding → 13 archivos leídos (fee-charge, budget, delegation, settlement, RPC patterns, migration exemplars).
- **F1**: `work-item.md` (WKH-135, EARS AC-1..AC-6, scope IN/OUT, paralelismo con WKH-136/141) → **HU_APPROVED**.
- **F2**: `sdd.md` con 3 SPEC-GATE forks ratificados (voucher model, cap clamp, endpoints), 13 CDs (obligatorio/prohibido), context map, data model, servicio, tests plan, error cases → **SPEC_APPROVED**.
- **F2.5**: `story-HU-135.md` (dev contrato, forks bakeados, env gate, wave 0-3).
- **F3 (4 waves)**: 
  - Wave 0: Migración `20260704000000_wkh135_payment_intents.sql` (2 tablas + 5 RPCs con SECURITY DEFINER + RLS) + tipos.
  - Wave 1: `src/services/payment-intent.ts` (open/close/settle/expire, EIP-712 cap, refund, idempotencia).
  - Wave 2: `src/routes/payments.ts` (endpoints, auth middleware, write-boundary validation).
  - Wave 3: Tests (vitest, suite verde 2361 tests), linting (biome).
- **AR** (Adversarial Review — auto-blindaje.md): **4 iteraciones de fix-pack money-path** antes de produción (ver §2 abajo).
- **CR** (Code Review — auto-blindaje.md + commits): Ownership Guard en todos los RPC, EIP-712 domain binding, SQL seguro, TS strict, no regresión `/compose` ni `/orchestrate`.
- **F4** (QA/Validation): `validation.md` **PASS** — 2361 tests, tsc limpio, BLQ previo (double-refund) reproducido y cerrado con evidencia en 2 niveles (runtime + Postgres 15 real), todos los ACs (AC-1 a AC-6) y invariantes money-path verificados. Drift = scope idéntico a los fix-packs.

---

## La saga de los 4 fix-packs money-path (LECCIONES PARA FUTURAS HUs)

En esta HU se entregó y cerró un viaje defensivo completo del ciclo money-path: cada bug encontrado en AR/CR/F4 fue documentado, reproducido en dos niveles (servicio + DB), y cerrado con persistencia verificada. Los patterns que emergieron son lecciones recurrentes en cualquier HU de dinero.

### Fix-Pack it.1 — BLQ-1: `upto` no debitaba al buyer (gateway pagaba de su bolsillo)

**Error**: `settleUpto` transfería `min(cap,uso)` on-chain al seller pero **NUNCA debitaba el budget prepago del buyer** → pérdida de fondos para el gateway (fund-loss real).

**Causa raíz**: `upto` no reserva en el `openPaymentIntent` (a diferencia de `session`), y el débito no se hacía en **ningún punto** del settle. `finalize` solo refundea el residual de `session`.

**Fix**: `settleUpto` ahora debita al buyer (`increment_a2a_key_spend`, 4-arg con `p_owner_ref`) **ANTES** de la transferencia on-chain. Fail-closed: budget insuficiente → `INSUFFICIENT_BUDGET`, NO transfer, mark failed. Atomicidad: si transfer falla DESPUÉS del débito → `refund_a2a_key_spend` (buyer made whole). Invariante testeado: `budget_post == budget_pre − min(cap,uso)`.

**Lección para futuras HUs**: Todo settle donde el **buyer NO reservó en el open** → el débito DEBE preceder la transferencia y refundarse si la transferencia falla. **NUNCA debitar en `finalize`** (corre DESPUÉS del transfer → seguiría drenando el gateway). Orden: `debit → transfer → verify → finalize`.

---

### Fix-Pack it.2a — BLQ-2: intent huérfano en `closing` si `finalize` falla

**Error**: Si el settle on-chain tenía éxito pero `finalize_payment_intent` fallaba (blip DB), el intent quedaba `closing` para siempre:
- El refund del residual **nunca corría** (estaba en el finalize fallido).
- El retry reportaba `settled` con `txHash=null` (mendacidad).
- `expireStale` solo barría `open` (no cubría el `closing`).

**Causa raíz**: 
- `finalize` best-effort (tragaba el error) + short-circuit del retry reportaba `settled` sin verificar que hubiera completado.
- Sweep incompleto (no barría `closing`).

**Fix**: 
1. `finalizePaymentIntent` ahora **devuelve `boolean`** (corrió o no).
2. El short-circuit de `closing` **re-invoca `finalize` idempotente** (residual recomputado sin doble-refund); si sigue fallando → `INTERNAL` (no miente `settled`).
3. `expireStale` ahora barre **TAMBIÉN `status='closing'` con `updated_at` viejo** (umbral `PAYMENT_INTENT_CLOSING_STALE_SECONDS`, default 300s) y los re-procesa.

**Limitación v1 documentada**: la recovery de un `closing` asume que el settle on-chain tuvo éxito. Las ventanas de crash "entre transición y débito/transfer" quedan flaggeadas por log para reconciliación manual (no hay fund-loss del gateway).

**Lección para futuras HUs**: Todo flujo con un estado intermedio (`closing`, `in_progress`, etc.) entre un efecto on-chain y su finalización DB → el **sweep debe cubrir ese estado** y la **finalización debe ser idempotente** y re-ejecutable con chequeo de retorno.

---

### Fix-Pack it.2b — MENOR-1: recovery de `closing` sin log ni txHash

**Error**: La rama `prev_status==='closing'` re-invocaba `finalize(success=true)` asumiendo settle exitoso sin `log.warn`. Si el finalize original falló, el `settle_tx_hash` quedaba null y se perdía la **señal de reconciliación**.

**Causa raíz**: Documentado como "limitación v1" pero no cableado (sin log que disparara la reconciliación manual).

**Fix**: `log.warn({ intentId, txHash: row.settle_tx_hash }, 'finalizando intent en closing bajo asunción de settle exitoso; verificar on-chain')` **ANTES** de `finalize`, en ambas ramas de recovery (session + upto).

**Lección para futuras HUs**: Toda rama de recovery que asume un efecto externo (settle on-chain, transfer, webhook) exitoso → **emitir una señal persistente (log + identificador de la tx) ANTES** del paso que puede volver a fallar. Observable = instrumentación.

---

### Fix-Pack it.3 — BLQ-DR: double-refund por estado `closing` sobrecargado (F4 QA REPRODUJO ESTE)

**Error**:  El F4 QA reprodujo un **doble-refund** (16 USD sobre un deposit de 10). En un settle inequívocamente fallido:
- `closeSession` hacía `refundBuyer(deposit)` **FUERA** de la tx del status.
- Luego `finalize(success=false)` **sin chequear el retorno**.
- Si ese finalize fallaba (blip DB), el intent quedaba `closing` **con el deposit ya reembolsado** y **sin señal que lo distinguiera** de "settle exitoso, finalize pendiente".
- El retry / `expireStale` entraba a la recovery de `closing` que **asumía éxito** (`success=true` hardcodeado) y **re-acreditaba el residual** → **segundo refund**.

**Causa raíz**:
1. El refund vivía **FUERA de la tx del status** (no atómico con el flip).
2. El estado `closing` estaba **SOBRECARGADO** — no había veredicto persistido que la recovery pudiera leer, así que asumía siempre "settle exitoso".

**Fix de raíz (3 invariantes garantizados por mecanismo, no por parche)**:

1. **Refund DENTRO de `finalize_payment_intent`** (RPC), en la **MISMA tx** que el status flip y **status-gated en `closing`** → re-invocar cuando ya es terminal = no-op ⇒ el refund se aplica **EXACTAMENTE UNA VEZ** bajo cualquier retry/`expireStale`. Se eliminó `refundBuyer` (el refund fuera-de-tx era la causa raíz). `p_success BOOLEAN` → `p_outcome TEXT` (`settled` | `failed_unequivocal` | `failed_ambiguous`).

2. **Veredicto persistido**: Nueva columna `settle_outcome` + RPC `record_settle_outcome` (money-free, status-gated) que anota el veredicto **ANTES** de que finalize pueda fallar. La recovery **LEE `settle_outcome`** (devuelto por `close_payment_intent_for_settle`) y aplica la acción **CORRECTA** — nunca asume éxito. `normalizeVerdict(NULL) = 'failed_ambiguous'` (money-safe: sin veredicto NO refunda, reconcilia).

3. **Chequeo del retorno de finalize en las ramas de fallo** (`unequivocal`/`ambiguous` y recovery): si falla → `INTERNAL` (no afirma un refund que no ocurrió); el veredicto persistido deja que el retry lo re-aplique una sola vez.

**Evidencia**: 
- Runtime real (`payment-intent.test.ts`, describe `BLQ-DR compound-failure`): fallo inequívoco→finalize falla→retry→refund 1 vez (`budget_post==budget_pre`, no +6); éxito→finalize falla→residual 1 vez; ambiguo→finalize falla→NO refund; upto vía `expireStale`.
- DB real Postgres 15 (efímero): `finalize` invocado 3×  → `refund_log` = exactamente 1 fila (10). `_down` + `database.types.ts` coherentes. `npm test` 2360 pass / `tsc` limpio / `biome` limpio.

**Ventana residual documentada**: Si `record_settle_outcome` **Y** `finalize` fallan **AMBOS** (doble-fault de DB), la recovery cae a `failed_ambiguous` (NO refund, reconcile) — nunca a doble-refund. Es money-conservador (jamás sobre-acredita); el `RECONCILE:` en `error_message` lo flaggea para reconciliación manual.

**Lección para futuras HUs**: 
- **Cualquier efecto de dinero acoplado a una transición de estado → el money DEBE vivir DENTRO de la MISMA tx status-gated** que la transición (nunca fuera).
- **Todo estado intermedio recuperable DEBE tener su veredicto/outcome PERSISTIDO** para que la recovery aplique la acción correcta en vez de asumir un resultado.
- **Verificar SIEMPRE el retorno de operaciones que pueden fallar**, especialmente aquellas que son best-effort (trap errors, no throw).

---

### Fix-Pack it.4 — BLQ-MED-1: race refund-cero por `closing` fresco tratado como huérfano (re-AR)

**Error**: Dos `close`/`settle` **concurrentes** sobre un intent `open`. 
- Call1 transiciona `open→closing` y entra al settle on-chain (segundos de I/O).
- Call2, dentro de esa ventana, serializa por el row-lock, ve `closing` con `settle_outcome=NULL` (Call1 aún no llamó `record_settle_outcome`) y la rama de recovery directa hacía `normalizeVerdict(NULL) → failed_ambiguous → finalize` → marcaba `failed` y **DESCARTABA el veredicto real**.
- Cuando Call1 terminaba, `record_settle_outcome`/`finalize` ya eran no-op (status terminal): si el settle real fue éxito → **residual no acreditado** + transfer on-chain hecho pero DB dice `failed` (inconsistencia); si fue fallo inequívoco → **deposit no reembolsado**.

**Causa raíz**: La rama de recovery directa de `closeSession`/`settleUpto` **NO distinguía veredicto-desconocido (in-flight) de huérfano-genuino**. `expireStale` SÍ tenía guarda de staleness (`updated_at < staleIso`) antes de recuperar; el path directo/concurrente no. Un `closing` FRESCO con `settle_outcome=NULL` es un settle in-flight, no un huérfano.

**Fix**: Guarda en la rama de recovery — si `settle_outcome=NULL` y NO es recovery de staleness (`allowStaleRecovery=false`, el default del path directo/ruta) → **NO finalizar, NO mover estado ni dinero** → **retornar `status:'in_progress'`** (nuevo valor en `SettleOutcome`) y dejar que el caller in-flight lo complete (o `expireStale` tras `CLOSING_STALE_SECONDS`, que pasa `allowStaleRecovery=true` porque ahí el NULL SÍ es huérfano genuino). Con `settle_outcome` conocido → huérfano genuino → finalize con ese veredicto (sin cambios). El refund sigue DENTRO de finalize (status-gated) ⇒ no se reintroduce la ventana del double-refund.

**Discriminador in-flight vs huérfano**: `settle_outcome` (NULL=in-flight) + el flag `allowStaleRecovery` (solo `expireStale`, que pre-filtra por `updated_at` viejo, lo pasa true).

**Lección para futuras HUs**: En máquinas de estado con concurrencia sobre un estado intermedio (`closing`, `in_progress`, `settling`) compartido entre "trabajo in-flight" y "huérfano recuperable" → **el discriminador debe ser un dato persistido (veredicto, outcome) + la staleness temporal, NUNCA asumir que el estado intermedio sin resultado es recuperable de inmediato desde un caller concurrente**. El default debe ser "esperar" o "devolver in_progress", no "asumir éxito".

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|----|----|-----------|
| AC-1 (settle único, idempotencia por PK) | PASS | `close_payment_intent_for_settle` (migration:260-280, transición `open→closing` una sola vez). Test: `payment-intent.test.ts:220-254` (T-AC1). |
| AC-2 (refund del residual, incl. recovery compuesta) | PASS | Refund dentro de `finalize_payment_intent` (migration:412-420, status-gated). Test: `payment-intent.test.ts:1108-1133` (residual recovery, 1 vez) + DB real (finalize 3×→refund 1×). |
| AC-3 (`upto` cobra exactamente `min(cap,uso)`) | PASS | `close_payment_intent_for_settle` (migration:270) + `payment-intent.ts:931-932`. Test: `payment-intent.test.ts` T-AC3. |
| AC-4 (Ownership Guard en toda tabla/RPC nueva) | PASS | Los 5 RPC (incl. `record_settle_outcome`) validan `IS DISTINCT FROM p_owner_ref` bajo `FOR UPDATE` (migration:113-115,168-170,256-258,333-335,402-404). DB real: `anon`/`authenticated`=DENY, `service_role`=GRANT. |
| AC-5 (literales APP `session`/`upto`) | PASS | `payments.ts:172,307`. |
| AC-6 (resolución determinística sin retención indefinida) | PASS | `expireStale` (payment-intent.ts:1089-1139) barre `open` vencidos + `closing` huérfanos (ahora recuperables vía veredicto persistido). Test: `payment-intent.test.ts:1160-1223` (upto vía `expireStale`, DB real). |

---

## Archivos modificados (scope final)

11 archivos tocados:
- `supabase/migrations/20260704000000_wkh135_payment_intents.sql` (migrate)
- `supabase/migrations/20260704000000_wkh135_payment_intents_down.sql` (rollback reversible)
- `src/services/payment-intent.ts` (nuevo, 1100+ líneas: open/close/settle/expire, EIP-712, refund, error handling, idempotencia)
- `src/services/payment-intent.test.ts` (nuevo, 1200+ líneas: 13 tests §11 SDD, money-path concurrency, BLQ-DR 4 tests)
- `src/routes/payments.ts` (nuevo, 400+ líneas: endpoints `/payments/session/*` + `/payments/upto/*`, auth, write-boundary validation)
- `src/routes/payments.test.ts` (nuevo, 300+ líneas: auth, owner guard, shape, money-path integration)
- `src/types/index.ts` (modify: tipos `PaymentIntentRow`, `PaymentVoucherRow`, `UptoCapTypedData`, DTOs)
- `src/types/database.types.ts` (modify: row types + Args de los 5 RPC nuevos)
- `src/index.ts` (modify: `register(paymentsRoutes, { prefix: '/payments' })`)
- `auto-blindaje.md` (documentación de los 4 fix-packs + lecciones recurrentes)
- Históricos sin cambios: `work-item.md`, `sdd.md`, `story-HU-135.md`, `validation.md`.

**Confirmado cero regresión**: `/compose`, `/orchestrate`, `fee-charge.ts`, `budget.ts` sin cambios (grep verificado en diff).

---

## Auto-Blindaje consolidado (Tabla de lecciones para futuras HUs de dinero)

| Iteración | Categoría | Error / Antición | Patrón / Lección | Cuándo aplica | Checksum |
|-----------|-----------|------------------|------------------|---------------|----------|
| it.1 | Money-path | Debit olvidado en path que NO reserva al abrir | Debit DEBE preceder transfer; si transfer falla, refundar; NUNCA debitar en finalize | Any settle con "no-reserve open" (upto, delegation, custom intents) | WKH-135#1 |
| it.2a | State Machine | Finalize falla → intent huérfano forever, sweep incompleto | Finalize DEBE ser idempotente + devolver retorno + verificado; sweep DEBE cubrir todo estado intermedio + staleness temporal | Any flujo con estado intermedio (`closing`, `in_flight`, `settling`) que finaliza con DB | WKH-135#2a |
| it.2b | Observability | Recovery sin log → pérdida de señal de reconciliación manual | Log.warn ANTES del paso que puede fallar en recovery, con identifiador (txHash, intentId) | Any recovery que asume efecto externo exitoso | WKH-135#2b |
| it.3 | Atomicity | Refund FUERA de tx + veredicto NO persistido → doble-refund en recovery | Money effects DENTRO de MISMA tx status-gated; veredicto PERSISTIDO ANTES finalize para recovery; chequear retorno de finalize | Any debit/credit/transfer acoplado a transición de estado | WKH-135#3 |
| it.4 | Concurrency | Concurrent callers, estado intermedio fresco sin veredicto, recovery asume éxito | Discriminador in-flight vs huérfano = veredicto persistido + staleness; default = "NO recuperar si veredicto=NULL", no "asumir éxito" | Máquinas de estado con concurrencia sobre estado intermedio | WKH-135#4 |

---

## Status final y follow-ups

**Status**: **DONE** — F4 PASS, 2361 tests green, Postgres real verificado, BLQ-DR reproducido y cerrado.

**Follow-ups documentados** (abiertos en el backlog, NO bloquean esta HU):

1. **MNR-1** (status HTTP 200 → 202/409): La rama `in_progress` devuelve `status:'in_progress'` en `SettleOutcome`, pero la ruta `/close` y `/settle` aún retornan HTTP 200. Opcionales futuros: 202 (Accepted, en progreso) o 409 (Conflict) con retry-after. Hoy es funcional (el cliente puede ver el estado); semántica HTTP es DX polish.

2. **Reconciliación manual de ventana residual**: Si `record_settle_outcome` Y `finalize` fallan ambos (doble-fault de DB), la recovery cae a `failed_ambiguous` + `RECONCILE:` en `error_message`. El operador debe revisar manualmente el log y resolver. Documentado en §BLQ-3 auto-blindaje; sin fund-loss del gateway (money-conservador). No hay ruta automática hoy; si ocurre merece investigación (es raro, requiere blip DB doble).

3. **WKH-136 (splits)** está listo para consumir el seam `settlePaymentIntentOnChain` — la interfaz estable está documentada en SDD §4.9. No ha pasado aún en el pipeline.

4. **WKH-141 (bridge APP)** depende de que esta HU cierre. Con WKH-135 DONE, WKH-141 puede empezar.

---

## Decisiones diferidas a backlog

Ninguna — la HU entregó el scope completo. Los follow-ups (MNR-1, reconciliación, downstream WKH-136/141) son postulados externos, no HUs suspendidas.

---

## Resumen para el orquestador

**WKH-135 DONE**: intents `session` + `upto` con full money-path completo (deposit, vouchers, settlement, refund, min(cap, usage)), naming APP-compatible, 11 archivos, suite verde 2361 tests, Postgres real verificado. Ruta de aprendizaje defensivo: 4 fix-packs de dinero encontrados y cerrados en AR/CR/F4, cada uno con patrón documentado para futuras HUs. PR #159 MERGEABLE, branch `feat/137-wkh-135-payment-intents-session-upto` en HOLD. Report: `doc/sdd/137-wkh-135-payment-intents-session-upto/done-report.md`. Próximo: update _INDEX.md + merge decision al humano.
