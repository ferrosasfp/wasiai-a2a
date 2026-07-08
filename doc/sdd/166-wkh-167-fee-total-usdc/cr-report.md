# CR Report — WKH-167 (fee_total_usdc)

**Fecha:** 2026-07-09 · **Modo:** CR (calidad), READ-ONLY · **Branch:** `feat/166-wkh-167-fee-total-usdc`

## Ronda 1: RECHAZADO — 1 BLOQUEANTE
Backfill con filtro `status='charged'` (migración :30) contradice la fórmula del work-item + rompe AC-4 para filas históricas con legs no-charged (failed con amount_usdc no-cero) → reintroduce el mismatch de auditoría. Repro idéntica a la del AR. Fix: quitar el filtro (sumar todos) o `budget_usdc * fee_rate`.

## Revisión OK (ronda 1)
- fee-charge.ts:402 `fee_total_usdc: feeUsdc` usa la var correcta (el total :202, no platformAmount); `fee_usdc: platformAmount` (:398) intacto. Un solo campo agregado.
- Migración: patrón WKH-136, BEGIN/COMMIT, ADD COLUMN IF NOT EXISTS NUMERIC(18,6) nullable, idempotente, sin doble-conteo (el leg plataforma no se escribe en a2a_fee_splits). Down-migration OK.
- Tests: T-FEE-TOTAL (8000/2000/0 → fee_usdc=0.008 vs fee_total_usdc=0.01, DIFIEREN) + FT-10 (default, coinciden). Asserts significativos.
- .env.example: comentario prod 8000/1500/500, default sin cambio (safe deploy fresco). Correcto.
- Scope: solo los archivos declarados.

## Ronda 2 (post fix-pack): resuelto
El fix-pack reemplazó el backfill por `round(budget_usdc * fee_rate, 6)` (byte-idéntico al forward-write) + tipó fee_total_usdc en database.types.ts. Verificado por el re-AR (APROBADO). tsc 0, biome 0, 2806 passed.

## Veredicto final: APROBADO (post fix-pack)
