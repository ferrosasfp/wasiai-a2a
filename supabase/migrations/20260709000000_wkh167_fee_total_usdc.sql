-- ============================================================
-- Migration: 20260709000000_wkh167_fee_total_usdc
-- WKH-167: columna ADITIVA `fee_total_usdc` en a2a_protocol_fees.
--
-- `fee_usdc` NO es el fee total desde WKH-136 (splits) — es SOLO la pata de
-- plataforma post-split. Esta columna guarda el fee TOTAL del protocolo
-- (= budget × rate = el mismo `protocolFeeUsdc` del quote de /orchestrate/plan)
-- para que el total quede legible directo sin joinear con a2a_fee_splits.
--
-- ADITIVA: `ADD COLUMN IF NOT EXISTS` NUMERIC(18,6) NULLABLE, sin NOT NULL/
-- DEFAULT (patrón 20260705000000_wkh136_fee_splits.sql:70-72). Cero regresión
-- en lecturas existentes. Idempotente / re-aplicable.
-- ============================================================
BEGIN;

ALTER TABLE public.a2a_protocol_fees
  ADD COLUMN IF NOT EXISTS fee_total_usdc NUMERIC(18, 6);

-- Backfill de filas existentes (fee_total_usdc IS NULL): el fee TOTAL es
-- `budget_usdc * fee_rate` redondeado a 6 decimales — byte-idéntico al
-- forward-write (`fee-charge.ts:202,394-402`: `feeUsdc = round(feeBaseUsdc ×
-- feeRate, 6)` con `budget_usdc = feeBaseUsdc` y `fee_rate = feeRate`).
--
-- BLQ-1 (AR+CR): NO derivar el total de `fee_usdc + Σ splits(charged)`. Un leg
-- ADICIONAL (creator/referral) que FALLA el settle queda `status='failed'` con
-- `amount_usdc` NO-cero (el monto asignado se persiste y no se pone a 0). Filtrar
-- `charged` subcuenta esas filas → `fee_total ≠ budget×rate` → viola AC-4 y
-- reintroduce el mismatch. Derivar de `budget_usdc × fee_rate` es inmune al
-- outcome del settle (igual que el forward-write, que setea el total
-- INCONDICIONALMENTE) y reconstruye el `protocolFeeUsdc` del quote exacto.
UPDATE public.a2a_protocol_fees
   SET fee_total_usdc = round(budget_usdc * fee_rate, 6)
 WHERE fee_total_usdc IS NULL;

COMMIT;
