-- WKH-167 down-migration — revierte la columna aditiva fee_total_usdc.
-- DROP COLUMN IF EXISTS es idempotente (re-aplicable sin error).
BEGIN;

ALTER TABLE public.a2a_protocol_fees
  DROP COLUMN IF EXISTS fee_total_usdc;

COMMIT;
