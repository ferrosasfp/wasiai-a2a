# Final Report — WKH-118: Cobrar el 1% también en /compose (FEE-COMPOSE)

> **Status**: ✅ DONE · **Fecha**: 2026-06-20 · **Branch**: `feat/115-wkh-118-fee-compose` · **Modo**: QUALITY AUTO
> Veredicto F4: APROBADO PARA DONE (7/7 ACs PASS).

## 1. Resumen ejecutivo
WKH-118 extiende el cobro del **1% protocol fee** al endpoint `/compose` (antes solo en `/orchestrate`). Las composiciones explícitas ahora también generan revenue. El cobro es **best-effort** (nunca rompe la composición), **idempotente** por `request.id`, sobre `result.totalCostUsdc` (lo gastado real), reutilizando `chargeProtocolFee` (WKH-44) sin duplicar lógica, y emite el recibo `protocol_fee` (WKH-124) fire-and-forget. Sin migración, sin cambios al response body.

## 2. Pipeline (QUALITY AUTO, 2026-06-20)
HU_APPROVED + SPEC_APPROVED self-aprobados. F2.5 → F3 → AR (APROBADO, 0 findings) + CR (APROBADO, 0 findings) → F4 (APROBADO PARA DONE). Sin fix-pack.

## 3. AC results (7/7 PASS — ver validation.md)
AC-1 cobro con request.id + totalCostUsdc + feeRate · AC-2 best-effort no rompe 200 · AC-3 already-charged no-op · AC-4 gate WALLET_UNSET skip · AC-5 success-false no cobra · AC-6 recibo emitido cuando charged + owner_ref · AC-7 concurrencia idempotente. Gates: tsc 0 · 1564 tests · lint 0.

## 4. Decisiones clave
- **Monto**: 1% sobre `result.totalCostUsdc` (suma de débitos efectivos), no `maxBudget`.
- **Idempotencia**: `request.id` (UUID v4 ya generado) como `orchestration_id` — la PK acepta cualquier UUID, sin migración.
- **Inserción** en el route handler `src/routes/compose.ts` (no en el service — `request.id` es capa HTTP).
- **x402 vs agent-key**: `chargeProtocolFee` transfiere desde el wallet server-side del PaymentAdapter (no del budget del caller) → owner-agnóstico, cobra en ambos. El recibo se emite solo si `request.a2aKeyRow?.owner_ref` (x402 puro → sin recibo).
- **Anti-recurrencia (CD-5)**: en el route el caller es `request.a2aKeyRow` (NO `scopingKeyRow`, que es campo de DTO).

## 5. Hallazgos
0 BLOQUEANTEs, 0 MENORs. El AR atacó la ruta de pago (best-effort, idempotencia, monto, success-only, x402-vs-key, leak) — todo OK. Observaciones no-finding documentadas (latencia idéntica a orchestrate; request.id no estable entre retries — semántica documentada).

## 6. Archivos
**Modificado**: `src/routes/compose.ts` (+59/-0). **Nuevo**: `src/routes/compose.fee.test.ts` (10 tests). Sin migración. orchestrate/compose-service/fee-charge/types intactos.

## 7. Deploy
Sin migración. Merge a main → Railway auto-deploy. El cobro se activa con `WASIAI_PROTOCOL_FEE_WALLET` (ya seteada en prod) → ahora `/compose` también cobra el 1%.

## 8. Nota de cierre (deck honesto)
Con WKH-118, el claim correcto pasa a ser "**1% por cada `/compose` u `/orchestrate`**" (antes "1% por orquestación"). Actualizar deck/flashcards cuando se retome el material de pitch.
