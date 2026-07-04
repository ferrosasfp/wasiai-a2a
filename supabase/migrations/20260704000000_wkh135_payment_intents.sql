-- ============================================================
-- Migration: 20260704000000_wkh135_payment_intents
-- WKH-135: Payment intents `session` (metered) + `upto` (dual-signed cap).
--
-- Aditiva 100% (SG-3). NO toca charge (x402) / compose / orchestrate. Crea:
--   - Tabla a2a_payment_intents  (estado del intent + idempotency key = PK UUID).
--   - Tabla a2a_payment_vouchers (ledger append-only de uso, solo session).
--   - 4 RPC atómicos (FOR UPDATE + Ownership Guard DB-level) reusando
--     increment_a2a_key_spend (reserva del deposit) + refund_a2a_key_spend
--     (credit-back del residual).
--   - RLS deny-by-default (service_role bypassa por BYPASSRLS).
--   - Trigger updated_at (trigger_set_updated_at, mismo que a2a_protocol_fees).
--
-- Patrones: 20260603000000_a2a_key_sessions.sql (RPC FOR UPDATE + owner guard),
-- 20260625000000_wkh_audit_a2_refund_rows_affected.sql (refund_a2a_key_spend),
-- 20260609000000_wkh_sec02b_owner_ref_rpc.sql (increment_a2a_key_spend 4-arg).
-- ============================================================

-- ── Tabla a2a_payment_intents ───────────────────────────────
CREATE TABLE IF NOT EXISTS a2a_payment_intents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),  -- idempotency key (AC-1)
  intent_type    TEXT NOT NULL CHECK (intent_type IN ('session','upto')),  -- literal APP (AC-5)
  owner_ref      TEXT NOT NULL,                    -- Ownership Guard (AC-4/CD-2)
  key_id         UUID NOT NULL REFERENCES a2a_agent_keys(id) ON DELETE CASCADE,
  buyer_wallet   TEXT,                             -- funding_wallet (upto: ancla de la firma)
  seller_ref     TEXT NOT NULL,                    -- '<registry>/<slug>' normalizado
  pay_to         TEXT NOT NULL,                    -- address on-chain del Seller (settle)
  chain_id       INT  NOT NULL,
  authorized_usd NUMERIC(20,8) NOT NULL CHECK (authorized_usd >= 0),  -- session: deposit / upto: cap
  consumed_usd   NUMERIC(20,8) NOT NULL DEFAULT 0 CHECK (consumed_usd >= 0),
  cap_signature  TEXT,                             -- upto
  cap_nonce      TEXT,                             -- upto (anti-replay)
  status         TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','closing','settled','refunded','expired','failed')),
  settle_tx_hash TEXT UNIQUE,                      -- anti doble-settle a nivel row
  residual_usd   NUMERIC(20,8),                    -- session post-close
  expires_at     TIMESTAMPTZ NOT NULL,             -- AC-6
  error_message  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_a2a_payment_intents_key_owner ON a2a_payment_intents (key_id, owner_ref);
CREATE INDEX IF NOT EXISTS idx_a2a_payment_intents_owner     ON a2a_payment_intents (owner_ref);
CREATE INDEX IF NOT EXISTS idx_a2a_payment_intents_status    ON a2a_payment_intents (status);
-- anti-replay del cap upto (nonce único por owner): UNIQUE parcial.
CREATE UNIQUE INDEX IF NOT EXISTS uq_a2a_payment_intents_cap_nonce
  ON a2a_payment_intents (owner_ref, cap_nonce) WHERE cap_nonce IS NOT NULL;

-- ── Tabla a2a_payment_vouchers (ledger append-only, solo session) ──
CREATE TABLE IF NOT EXISTS a2a_payment_vouchers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id         UUID NOT NULL REFERENCES a2a_payment_intents(id) ON DELETE CASCADE,
  owner_ref         TEXT NOT NULL,                 -- Ownership Guard (AC-4)
  voucher_id        TEXT NOT NULL,                 -- idempotency key del voucher (CD-3)
  amount_usd        NUMERIC(20,8) NOT NULL CHECK (amount_usd >= 0),
  voucher_signature TEXT,                          -- OPCIONAL reservado (SG-1, no se verifica en V1)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (intent_id, voucher_id)                   -- anti doble-conteo (CD-3): 23505 = ya visto
);
CREATE INDEX IF NOT EXISTS idx_a2a_payment_vouchers_intent ON a2a_payment_vouchers (intent_id);

-- ── RLS deny-by-default (patrón WKH-SEC-02, SIN policy permisiva) ──
-- service_role bypassa por BYPASSRLS; anon/authenticated → deny-all.
ALTER TABLE a2a_payment_intents  ENABLE ROW LEVEL SECURITY;
ALTER TABLE a2a_payment_vouchers ENABLE ROW LEVEL SECURITY;

-- ── updated_at trigger (reusa trigger_set_updated_at, igual que a2a_protocol_fees) ──
DROP TRIGGER IF EXISTS set_a2a_payment_intents_updated_at ON a2a_payment_intents;
CREATE TRIGGER set_a2a_payment_intents_updated_at
  BEFORE UPDATE ON a2a_payment_intents
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ============================================================
-- RPC 1: open_payment_intent
-- INSERT del intent (id server-side via crypto.randomUUID → p_id). Para session,
-- en la MISMA tx reserva el deposit vía increment_a2a_key_spend (propaga
-- INSUFFICIENT_BUDGET/DAILY_LIMIT/KEY_INACTIVE/KEY_NOT_FOUND → ROLLBACK total).
-- Para upto: NO debita. Ownership Guard: la key debe pertenecer a p_owner_ref.
-- ============================================================
CREATE OR REPLACE FUNCTION open_payment_intent(
  p_id             UUID,
  p_intent_type    TEXT,
  p_owner_ref      TEXT,
  p_key_id         UUID,
  p_buyer_wallet   TEXT,
  p_seller_ref     TEXT,
  p_pay_to         TEXT,
  p_chain_id       INT,
  p_authorized_usd NUMERIC,
  p_cap_signature  TEXT,
  p_cap_nonce      TEXT,
  p_expires_at     TIMESTAMPTZ
) RETURNS void AS $$
DECLARE
  v_key_owner TEXT;
BEGIN
  -- Ownership Guard DB-level: la key debe existir y pertenecer al caller.
  SELECT owner_ref INTO v_key_owner
    FROM a2a_agent_keys
    WHERE id = p_key_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'KEY_NOT_FOUND: key_id % does not exist', p_key_id;
  END IF;
  IF v_key_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: key % not owned by caller', p_key_id;
  END IF;

  -- INSERT del intent (el 23505 del nonce único = replay del cap upto).
  INSERT INTO a2a_payment_intents (
    id, intent_type, owner_ref, key_id, buyer_wallet, seller_ref, pay_to,
    chain_id, authorized_usd, cap_signature, cap_nonce, status, expires_at
  ) VALUES (
    p_id, p_intent_type, p_owner_ref, p_key_id, p_buyer_wallet, p_seller_ref, p_pay_to,
    p_chain_id, p_authorized_usd, p_cap_signature, p_cap_nonce, 'open', p_expires_at
  );

  -- session: reserva del deposit contra el budget prepago (misma tx → atómico).
  IF p_intent_type = 'session' THEN
    PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_authorized_usd, p_owner_ref);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.open_payment_intent(uuid, text, text, uuid, text, text, text, integer, numeric, text, text, timestamptz)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.open_payment_intent(uuid, text, text, uuid, text, text, text, integer, numeric, text, text, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_payment_intent(uuid, text, text, uuid, text, text, text, integer, numeric, text, text, timestamptz)
  TO service_role;

-- ============================================================
-- RPC 2: accumulate_payment_voucher (solo session)
-- INSERT idempotente del voucher (ON CONFLICT DO NOTHING). Duplicado → NO
-- incrementa consumed. Nuevo → consumed += amount, CLAMP a authorized_usd
-- (el settle nunca cobra > deposit). Devuelve (consumed, is_duplicate).
-- ============================================================
CREATE OR REPLACE FUNCTION accumulate_payment_voucher(
  p_intent_id UUID,
  p_owner_ref TEXT,
  p_voucher_id TEXT,
  p_amount     NUMERIC
) RETURNS TABLE(consumed NUMERIC, is_duplicate BOOLEAN) AS $$
DECLARE
  v_owner    TEXT;
  v_status   TEXT;
  v_consumed NUMERIC;
  v_auth     NUMERIC;
  v_inserted INT;
  v_new      NUMERIC;
BEGIN
  SELECT pi.owner_ref, pi.status, pi.consumed_usd, pi.authorized_usd
    INTO v_owner, v_status, v_consumed, v_auth
    FROM a2a_payment_intents pi
    WHERE pi.id = p_intent_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENT_NOT_FOUND: %', p_intent_id;
  END IF;
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: intent % not owned by caller', p_intent_id;
  END IF;
  IF v_status <> 'open' THEN
    RAISE EXCEPTION 'INTENT_NOT_OPEN: intent % is %', p_intent_id, v_status;
  END IF;

  INSERT INTO a2a_payment_vouchers (intent_id, owner_ref, voucher_id, amount_usd)
  VALUES (p_intent_id, p_owner_ref, p_voucher_id, p_amount)
  ON CONFLICT (intent_id, voucher_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 THEN
    -- Duplicado (voucher_id ya visto): NO incrementa consumed (idempotente).
    consumed := v_consumed;
    is_duplicate := true;
    RETURN NEXT;
    RETURN;
  END IF;

  v_new := v_consumed + p_amount;
  -- CLAMP al deposit: consumed nunca supera authorized_usd (SG-1).
  IF v_new > v_auth THEN
    v_new := v_auth;
  END IF;
  UPDATE a2a_payment_intents SET consumed_usd = v_new WHERE id = p_intent_id;

  consumed := v_new;
  is_duplicate := false;
  RETURN NEXT;
  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.accumulate_payment_voucher(uuid, text, text, numeric)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.accumulate_payment_voucher(uuid, text, text, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accumulate_payment_voucher(uuid, text, text, numeric)
  TO service_role;

-- ============================================================
-- RPC 3: close_payment_intent_for_settle
-- Transición idempotente open→closing (AC-1). Si el status ya NO es 'open', NO
-- re-transiciona y devuelve prev_status = ese estado (el service NO re-settlea).
-- final_amount bajo lock: session → LEAST(consumed, authorized);
-- upto → LEAST(authorized, p_reported_usage).
-- ============================================================
CREATE OR REPLACE FUNCTION close_payment_intent_for_settle(
  p_intent_id      UUID,
  p_owner_ref      TEXT,
  p_reported_usage NUMERIC
) RETURNS TABLE(
  final_amount   NUMERIC,
  prev_status    TEXT,
  intent_type    TEXT,
  key_id         UUID,
  chain_id       INT,
  pay_to         TEXT,
  authorized_usd NUMERIC,
  consumed_usd   NUMERIC,
  settle_tx_hash TEXT
) AS $$
DECLARE
  v_owner    TEXT;
  v_status   TEXT;
  v_type     TEXT;
  v_key      UUID;
  v_chain    INT;
  v_payto    TEXT;
  v_auth     NUMERIC;
  v_consumed NUMERIC;
  v_tx       TEXT;
  v_final    NUMERIC;
BEGIN
  SELECT pi.owner_ref, pi.status, pi.intent_type, pi.key_id, pi.chain_id,
         pi.pay_to, pi.authorized_usd, pi.consumed_usd, pi.settle_tx_hash
    INTO v_owner, v_status, v_type, v_key, v_chain,
         v_payto, v_auth, v_consumed, v_tx
    FROM a2a_payment_intents pi
    WHERE pi.id = p_intent_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENT_NOT_FOUND: %', p_intent_id;
  END IF;
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: intent % not owned by caller', p_intent_id;
  END IF;

  IF v_status = 'open' THEN
    IF v_type = 'session' THEN
      v_final := LEAST(v_consumed, v_auth);
    ELSE
      v_final := LEAST(v_auth, COALESCE(p_reported_usage, 0));
    END IF;
    -- Transición idempotente: solo el primer close mueve open→closing.
    UPDATE a2a_payment_intents SET status = 'closing' WHERE id = p_intent_id;
  ELSE
    -- Ya cerrado/settled/failed/expired: NO re-transiciona (AC-1). El service
    -- lee prev_status <> 'open' y NO re-settlea → final_amount es irrelevante.
    v_final := 0;
  END IF;

  final_amount   := v_final;
  prev_status    := v_status;
  intent_type    := v_type;
  key_id         := v_key;
  chain_id       := v_chain;
  pay_to         := v_payto;
  authorized_usd := v_auth;
  consumed_usd   := v_consumed;
  settle_tx_hash := v_tx;
  RETURN NEXT;
  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.close_payment_intent_for_settle(uuid, text, numeric)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.close_payment_intent_for_settle(uuid, text, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_payment_intent_for_settle(uuid, text, numeric)
  TO service_role;

-- ============================================================
-- RPC 4: finalize_payment_intent
-- Idempotente: solo actúa mientras status='closing'. Éxito → settled + tx_hash +
-- residual; para session con residual>0 → refund_a2a_key_spend (credit-back del
-- residual, AC-2) en la MISMA tx. upto NO refunda (no reservó). Fallo → failed +
-- error_message, NO refund, NO settle_tx_hash.
-- ============================================================
CREATE OR REPLACE FUNCTION finalize_payment_intent(
  p_intent_id    UUID,
  p_owner_ref    TEXT,
  p_tx_hash      TEXT,
  p_final_amount NUMERIC,
  p_residual     NUMERIC,
  p_success      BOOLEAN,
  p_error        TEXT
) RETURNS void AS $$
DECLARE
  v_owner  TEXT;
  v_status TEXT;
  v_type   TEXT;
  v_key    UUID;
  v_chain  INT;
BEGIN
  SELECT owner_ref, status, intent_type, key_id, chain_id
    INTO v_owner, v_status, v_type, v_key, v_chain
    FROM a2a_payment_intents
    WHERE id = p_intent_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENT_NOT_FOUND: %', p_intent_id;
  END IF;
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: intent % not owned by caller', p_intent_id;
  END IF;

  -- Idempotencia del settle (AC-1): solo se finaliza una transición 'closing'.
  IF v_status <> 'closing' THEN
    RETURN;
  END IF;

  IF p_success THEN
    UPDATE a2a_payment_intents
      SET status = 'settled', settle_tx_hash = p_tx_hash, residual_usd = p_residual
      WHERE id = p_intent_id;
    -- credit-back del residual (session, AC-2). upto NO reservó → NO refunda.
    IF v_type = 'session' AND p_residual IS NOT NULL AND p_residual > 0 THEN
      PERFORM refund_a2a_key_spend(v_key, v_chain, p_residual, p_owner_ref);
    END IF;
  ELSE
    UPDATE a2a_payment_intents
      SET status = 'failed', error_message = p_error
      WHERE id = p_intent_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.finalize_payment_intent(uuid, text, text, numeric, numeric, boolean, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.finalize_payment_intent(uuid, text, text, numeric, numeric, boolean, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_payment_intent(uuid, text, text, numeric, numeric, boolean, text)
  TO service_role;
