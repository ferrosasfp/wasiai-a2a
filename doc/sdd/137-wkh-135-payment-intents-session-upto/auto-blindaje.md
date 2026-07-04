# Auto-Blindaje — WKH-135 (payment intents session + upto)

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
