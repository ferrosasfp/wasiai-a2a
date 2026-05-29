-- ============================================================
-- Migration: 20260529000001_a2a_key_funding_wallet
-- WKH-35 FIX-1 (BLQ-MED-1): bind a funding wallet to each key with
-- proof of control, so /deposit can require Transfer.from == funding_wallet.
-- The treasury is shared, so validating only Transfer.to is insufficient:
-- an attacker could front-run another caller's txHash and claim it. Binding
-- the depositor wallet closes that hijack.
-- ============================================================
--
-- Aditiva e idempotente:
--   * `IF NOT EXISTS` para la columna y el índice.
--   * `funding_wallet` es NULLABLE: una key recién creada no tiene wallet
--     bound; debe bindear vía POST /auth/funding-wallet antes de depositar.
--   * Se guarda SIEMPRE lowercase desde la app (src/services/identity.ts).
--   * UNIQUE parcial (WHERE funding_wallet IS NOT NULL): una wallet ↔ a lo
--     sumo una key (defense-in-depth). NULLs no colisionan entre sí.
--
-- Defense-in-depth (TD-SEC-01): el ownership check sigue en app-layer
-- (`src/services/identity.ts` filtra por id + owner_ref); el unique index es
-- una segunda línea a nivel DB contra wallet-reuse cross-key.
-- ============================================================

BEGIN;

ALTER TABLE a2a_agent_keys
  ADD COLUMN IF NOT EXISTS funding_wallet TEXT;

-- Una wallet bound a lo sumo a una key. Parcial: NULL = sin bindear.
CREATE UNIQUE INDEX IF NOT EXISTS uq_a2a_agent_keys_funding_wallet
  ON a2a_agent_keys (funding_wallet)
  WHERE funding_wallet IS NOT NULL;

COMMIT;
