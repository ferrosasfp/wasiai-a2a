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

### [2026-07-04 19:55] Wave 3 — Import no usado en el test del servicio
- **Error**: `PaymentIntentError` importado en `payment-intent.test.ts` pero nunca referenciado
  (los asserts usan `.rejects.toMatchObject({ code })`), → biome `noUnusedImports` (warning).
- **Causa raíz**: import defensivo agregado "por si acaso" al escribir los tests.
- **Fix**: quitado del import; solo se importan `paymentIntentService` +
  `settlePaymentIntentOnChain`.
- **Aplicar en**: correr `biome check src/` sobre los tests nuevos ANTES de dar la wave por
  cerrada; no importar símbolos "por si acaso".
