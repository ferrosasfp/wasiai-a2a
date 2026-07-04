# Auto-Blindaje — WKH-135 (payment intents session + upto)

### [2026-07-04 21:30] FIX-PACK it.3 — BLQ-DR: double-refund por estado `closing` sobrecargado (F4 QA)
- **Error**: el F4 QA reprodujo un doble-refund (16 USD sobre un deposit de 10). En un
  settle inequívocamente fallido, `closeSession` hacía `refundBuyer(deposit)` FUERA de la
  tx del status y luego `finalize(success=false)` sin chequear el retorno. Si ese finalize
  fallaba (blip DB), el intent quedaba en `closing` **con el deposit ya reembolsado** y sin
  ninguna señal que lo distinguiera de "settle exitoso, finalize pendiente". El retry /
  `expireStale` entraba a la recovery de `closing` que **asumía éxito** (`success=true`
  hardcodeado) y **re-acreditaba el residual** → segundo refund. Análogo en `settleUpto`.
- **Causa raíz**: (1) el refund vivía FUERA de la tx del status (no atómico con el flip);
  (2) el estado `closing` estaba SOBRECARGADO — no había veredicto persistido que la
  recovery pudiera leer, así que asumía siempre "settle exitoso".
- **Fix de raíz** (3 invariantes garantizados por mecanismo, no por parche):
  (1) **Refund DENTRO de `finalize_payment_intent`** (RPC), en la MISMA tx que el status
  flip y **status-gated en `closing`** → re-invocar cuando ya es terminal = no-op ⇒ el
  refund se aplica EXACTAMENTE UNA VEZ bajo cualquier retry/`expireStale`. Se eliminó
  `refundBuyer` (el refund fuera-de-tx era la causa raíz). `p_success BOOLEAN` →
  `p_outcome TEXT` (`settled` | `failed_unequivocal` | `failed_ambiguous`).
  (2) **Veredicto persistido**: nueva columna `settle_outcome` + RPC `record_settle_outcome`
  (money-free, status-gated) que anota el veredicto ANTES de que finalize pueda fallar. La
  recovery LEE `settle_outcome` (devuelto por `close_payment_intent_for_settle`) y aplica la
  acción CORRECTA — nunca asume éxito. `normalizeVerdict(NULL) = 'failed_ambiguous'`
  (money-safe: sin veredicto NO refunda, reconcilia).
  (3) **Chequeo del retorno de finalize en las ramas de fallo** (`unequivocal`/`ambiguous`
  y recovery): si falla → `INTERNAL` (no afirma un refund que no ocurrió); el veredicto
  persistido deja que el retry lo re-aplique una sola vez.
- **Evidencia**: 4 tests nuevos runtime-real (`payment-intent.test.ts`, describe
  `BLQ-DR compound-failure`) con un DB in-memory fiel (status-gate + refund-inside): fallo
  inequívoco→finalize falla→retry→refund 1 vez (`budget_post==budget_pre`); éxito→finalize
  falla→residual 1 vez; ambiguo→finalize falla→NO refund; upto vía `expireStale`. + prueba
  a nivel Postgres 15 (efímero): `finalize` invocado 3× (una con la asunción vieja
  `settled`) → `refund_log` = exactamente 1 fila (10). `_down` + `database.types.ts`
  coherentes. `npm test` 2360 pass / `tsc` limpio / `biome` limpio.
- **Ventana residual documentada**: si `record_settle_outcome` Y `finalize` fallan AMBOS
  (doble-fault de DB), la recovery cae a `failed_ambiguous` (NO refund, reconcile) — nunca
  a doble-refund. Es money-conservador (jamás sobre-acredita); el `RECONCILE:` en
  `error_message` lo flaggea para reconciliación manual.
- **Aplicar en**: cualquier efecto de dinero acoplado a una transición de estado → el money
  DEBE vivir dentro de la misma tx status-gated que la transición (nunca fuera), y todo
  estado intermedio recuperable DEBE tener su veredicto/outcome PERSISTIDO para que la
  recovery aplique la acción correcta en vez de asumir un resultado.

### [2026-07-04 22:30] FIX-PACK it.2 — BLQ-ALTO-1: `session` perdía el deposit en settle fallido
- **Error**: en `closeSession`, si `settlePaymentIntentOnChain` devolvía `failed` se
  llamaba `finalize(success=false)` sin refund. El deposit COMPLETO ya se debitó en
  `openSession` (`open_payment_intent` → `increment_a2a_key_spend`), así que el buyer
  perdía el deposit entero y el seller no cobraba. Asimetría con `upto` (que sí refunda).
- **Causa raíz**: el seam `settlePaymentIntentOnChain` colapsaba TODOS los subcasos de
  falla en un único `{ status:'failed' }` sin distinguir si hubo o no transferencia
  on-chain. Sin esa distinción no se puede decidir refund vs reconcile.
- **Fix**: agregué `failureKind: 'unequivocal' | 'ambiguous'` a `SettleOutcome`. El seam
  lo etiqueta: `sign() throw` / `settle.success===false` → `unequivocal` (CIERTO que no
  hubo tx); `settle() throw` / `verify contradiction` / catch inesperado → `ambiguous`
  (el transfer PUDO ocurrir). `closeSession` (y `settleUpto`) refundan SOLO en el caso
  inequívoco (session: deposit COMPLETO; upto: el débito). En el ambiguo NO refundan
  (evita doble-gasto) y marcan reconciliable: `error_message` con prefijo `RECONCILE:`
  + `log.warn` explícito. `RPC_UNAVAILABLE` sigue fail-OPEN (intacto).
- **Aplicar en**: cualquier money-path con debit-antes-de-transfer. NUNCA colapsar
  "settle falló" en una sola rama: distinguir "no hubo transfer" (refund seguro) de
  "pudo haber transfer" (reconciliar, jamás refundar a ciegas → doble-gasto).

### [2026-07-04 22:30] FIX-PACK it.2 — MENOR-1: recovery de `closing` sin log ni txHash
- **Error**: la rama `prev_status==='closing'` (session + upto) re-invocaba
  `finalize(success=true)` asumiendo settle exitoso sin `log.warn`; si el finalize
  original falló, el `settle_tx_hash` quedaba null y se perdía la señal de reconciliación.
- **Causa raíz**: la "limitación v1" estaba documentada pero no cableada (sin log que
  disparara la reconciliación manual).
- **Fix**: `log.warn({ intentId, txHash: row.settle_tx_hash }, 'finalizando intent en
  closing bajo asunción de settle exitoso; verificar on-chain')` ANTES de `finalize`, en
  ambas ramas de recovery (session + upto).
- **Aplicar en**: toda rama de recovery que asume un efecto externo (settle on-chain)
  exitoso debe emitir una señal persistente (log + identificador de la tx) ANTES del
  paso que puede volver a fallar.

### [2026-07-04 19:40] Wave 0 — Placeholder SQL inválido en close RPC
- **Error**: en la rama `ELSE` (intent ya no-open) de `close_payment_intent_for_settle`
  escribí una línea placeholder sin sentido: `v_final := COALESCE(v_tx,'')::TEXT IS NOT
  NULL::TEXT AND false;` que no parsea en plpgsql.
- **Causa raíz**: dejé un stub mental para "no-op" y no lo limpié antes de escribir el archivo.
- **Fix**: reemplazado por `v_final := 0;` (el service lee `prev_status <> 'open'` y NO
  re-settlea, así que `final_amount` es irrelevante en esa rama).
- **Aplicar en**: cualquier rama de RPC que compute un valor "no usado" — asignar un
  literal simple, nunca dejar expresiones tentativas. Revisar el SQL completo antes del Write.

### [2026-07-04 19:41] Wave 0 — RETURNS TABLE: ambigüedad OUT-param vs columna
- **Error potencial**: los RPC `accumulate_payment_voucher` y `close_payment_intent_for_settle`
  usan `RETURNS TABLE(...)` con nombres que coinciden con columnas de la tabla
  (`consumed_usd`, `intent_type`, etc.). En plpgsql eso dispara "column reference is ambiguous".
- **Causa raíz**: OUT params de un RETURNS TABLE son variables en scope; un `SELECT col INTO`
  sobre la misma tabla colisiona.
- **Fix**: (1) el SELECT interno califica TODAS las columnas con alias `pi.` ; (2) los OUT del
  voucher se nombran distinto de la columna (`consumed`, `is_duplicate` vs `consumed_usd`).
- **Aplicar en**: todo RPC nuevo con `RETURNS TABLE` — calificar columnas con alias y/o
  nombrar los OUT distinto de las columnas fuente.

### [2026-07-04 21:10] FIX-PACK — BLQ-1: `upto` no debitaba al buyer (gateway pagaba de su bolsillo)
- **Error**: `settleUpto` transfería `min(cap,uso)` on-chain al seller desde la wallet
  del gateway, pero NUNCA debitaba el budget prepago del buyer → fund-loss del gateway.
- **Causa raíz**: `upto` no reserva en el open (a diferencia de `session`), y el débito
  no se hacía en ningún punto del settle. `finalize` sólo refunda residual de `session`.
- **Fix**: `settleUpto` ahora debita al buyer (`increment_a2a_key_spend`, 4-arg con
  `p_owner_ref`) ANTES de la transferencia on-chain. Fail-closed: budget insuficiente →
  `INSUFFICIENT_BUDGET`, NO transfer, mark failed. Atomicidad: si el transfer falla
  DESPUÉS del débito → `refund_a2a_key_spend` (buyer made whole). Invariante testeado:
  `budget_post == budget_pre − min(cap,uso)` + orden `['debit','transfer']`.
- **Aplicar en**: todo settle donde el buyer NO reservó en el open — el débito debe
  preceder la transferencia y refundarse si la transferencia falla; NUNCA debitar en
  `finalize` (corre DESPUÉS del transfer → seguiría drenando el gateway).

### [2026-07-04 21:12] FIX-PACK — BLQ-2: intent huérfano en `closing` si `finalize` falla
- **Error**: si el settle on-chain de `session` tenía éxito pero `finalize_payment_intent`
  fallaba (blip DB), el intent quedaba `closing` para siempre: el refund del residual
  nunca corría, el retry reportaba `settled` con `txHash=null`, y `expireStale` sólo
  barría `open`.
- **Causa raíz**: `finalize` best-effort (traga el error) + short-circuit del retry
  reportaba `settled` a ciegas cuando `prev_status='closing'` + sweep incompleto.
- **Fix**: (1) `finalizePaymentIntent` devuelve `boolean` (corrió o no). (2) El
  short-circuit de `closing` RE-INVOCA `finalize` idempotente (residual recomputado
  de la fila, sin doble-refund); si sigue fallando → `INTERNAL` (no miente `settled`).
  (3) `expireStale` ahora barre TAMBIÉN `status='closing'` con `updated_at` viejo
  (umbral `PAYMENT_INTENT_CLOSING_STALE_SECONDS`, default 300s) y los re-procesa.
- **Limitación v1 documentada**: la recovery de un `closing` asume que el settle on-chain
  tuvo éxito (escenario BLQ-2). Las ventanas de crash "entre transición y débito/transfer"
  quedan flageadas por log para reconciliación manual (no hay fund-loss del gateway).
- **Aplicar en**: todo flujo con un estado intermedio (`closing`) entre un efecto on-chain
  y su finalización DB → el sweep debe cubrir ese estado y la finalización debe ser
  idempotente y re-ejecutable.

### [2026-07-04 21:14] FIX-PACK — MNR-1 + MNR-2
- **MNR-1**: `payments.ts` aceptaba cualquier `chainId` pero el settle usa siempre la
  default chain (adapter/verifier sin `chainKey`) → riesgo de settlear en la cadena
  equivocada. Fix: validar `chainId === getChainConfig().chainId` en el write-boundary
  de `/session` y `/upto` → 422 `CHAIN_NOT_SUPPORTED` (fail-closed).
- **MNR-2**: la rama idempotente de `settleUpto` recomputaba el monto con el
  `reportedUsage` del request actual (mentía en un retry). Fix: el close RPC PERSISTE
  `LEAST(cap,uso)` en `consumed_usd` al transicionar; el retry lee ese valor real.
- **Aplicar en**: (MNR-1) todo write-boundary money-path multi-chain con settle
  single-chain — validar la cadena explícitamente. (MNR-2) los reportes idempotentes
  deben leer el valor persistido, nunca recomputar de un input que puede variar.

### [2026-07-04 19:55] Wave 3 — Import no usado en el test del servicio
- **Error**: `PaymentIntentError` importado en `payment-intent.test.ts` pero nunca referenciado
  (los asserts usan `.rejects.toMatchObject({ code })`), → biome `noUnusedImports` (warning).
- **Causa raíz**: import defensivo agregado "por si acaso" al escribir los tests.
- **Fix**: quitado del import; solo se importan `paymentIntentService` +
  `settlePaymentIntentOnChain`.
- **Aplicar en**: correr `biome check src/` sobre los tests nuevos ANTES de dar la wave por
  cerrada; no importar símbolos "por si acaso".
