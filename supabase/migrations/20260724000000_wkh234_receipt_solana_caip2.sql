-- WKH-234 (W5, AC-8) — Solana settle metadata on the receipt ledger.
--
-- ADITIVA y NO destructiva: agrega dos columnas nullable a `a2a_receipts` para
-- registrar el CAIP-2 (`solana:<cluster>`) y la firma base58 del SPL-transfer de
-- un leg Solana. NULL para todos los legs EVM existentes/nuevos → byte-idéntico
-- (AC-8). NO participan del HMAC canónico (`buildCanonicalPayload`, 13 keys):
-- son metadata anexa no firmada, así la verificación de recibos previos NO cambia.
--
-- NO toca columnas ni queries existentes, ni el RPC atómico `insert_receipt` /
-- `debit_with_dest_policy` (mínimo riesgo money-path). Idempotente (IF NOT EXISTS).

ALTER TABLE public.a2a_receipts
  ADD COLUMN IF NOT EXISTS settle_caip2 text NULL,
  ADD COLUMN IF NOT EXISTS settle_signature text NULL;

COMMENT ON COLUMN public.a2a_receipts.settle_caip2 IS
  'WKH-234: CAIP-2 chain id (solana:<cluster>) del settle de un leg Solana. NULL para legs EVM.';
COMMENT ON COLUMN public.a2a_receipts.settle_signature IS
  'WKH-234: firma base58 del SPL-transfer del settle Solana (idempotencia DT-10). NULL para legs EVM.';
