-- ============================================================
-- Migration: 20260704100000_wkh139_arbiter
-- WKH-139 v2: Agente-árbitro autónomo de disputas sobre payment-intents
-- `session` (WKH-135). Testnet-only. Todo detrás de flag ARBITER_ENABLED
-- (default OFF) — byte-idéntico apagado (CD-11).
--
-- Aditiva. NO toca charge/compose/orchestrate ni las ramas de dinero de los
-- RPCs de settle/refund existentes. Crea:
--   - +3 estados al CHECK de a2a_payment_intents.status
--     ('disputed','arb_closing','arb_hold').
--   - Tabla a2a_arbitrations (RLS deny-by-default, Ownership Guard owner_ref).
--   - RPC open_dispute (gate anti-race status='open' bajo SELECT ... FOR UPDATE).
--   - RPC close_payment_intent_for_arbitration (clamp [0,deposit] + persiste el
--     monto forzado en consumed_usd; espejo de la rama 'upto' de
--     close_payment_intent_for_settle).
--   - CREATE OR REPLACE record_settle_outcome + finalize_payment_intent: se
--     ENSANCHA SÓLO el predicado de status-gate ('closing' → IN
--     ('closing','arb_closing')). NINGUNA rama de dinero cambia (Decisión
--     Crítica del Story File — Option B). Byte-idéntico para todo intent que NO
--     sea de arbitraje (ninguno del money-path normal llega a 'arb_closing').
--   - +4 receipt_type al CHECK de a2a_receipts
--     ('arbitration_release/refund/split/hold').
--
-- Patrones: 20260704000000_wkh135_payment_intents.sql (RPC FOR UPDATE + owner
-- guard + hardening), 20260611000000_a2a_receipts_deposit_verified_check.sql
-- (extensión de CHECK).
-- ============================================================

-- ── 1. Extender status CHECK de a2a_payment_intents (+3, additive) ──
ALTER TABLE a2a_payment_intents DROP CONSTRAINT IF EXISTS a2a_payment_intents_status_check;
ALTER TABLE a2a_payment_intents ADD CONSTRAINT a2a_payment_intents_status_check
  CHECK (status IN (
    'open','closing','settled','refunded','expired','failed',
    'disputed','arb_closing','arb_hold'
  ));
-- Semántica de los nuevos estados:
--   disputed    = disputa abierta, dinero NO movido.
--   arb_closing = árbitro ejecutando el settle forzado (monto ya persistido en
--                 consumed_usd), recuperable por expireStale/recovery.
--   arb_hold    = sobre-tope o ambigüedad irresoluble, congelado, dinero NO movido.

-- ── 2. Tabla a2a_arbitrations (RLS deny-by-default; service_role bypassa) ──
CREATE TABLE IF NOT EXISTS a2a_arbitrations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id        UUID NOT NULL REFERENCES a2a_payment_intents(id) ON DELETE CASCADE,
  owner_ref        TEXT NOT NULL,                          -- Ownership Guard (CD-2)
  decision         TEXT NOT NULL CHECK (decision IN ('release','refund','split','hold')),
  method           TEXT NOT NULL CHECK (method IN ('rules','llm','hold')),
  at_stake_usd     NUMERIC(20,8) NOT NULL,                 -- = authorized_usd (base del cap, AC-6)
  settle_usd       NUMERIC(20,8) NOT NULL DEFAULT 0,       -- monto forzado al Seller (0 si refund/hold)
  ambiguity_reason TEXT,                                   -- por qué se escaló / por qué hold
  llm_reasoning    TEXT,                                   -- auditable si method='llm' (CD-4)
  evidence_digest  TEXT,                                   -- hash/resumen de la evidencia consultada
  status           TEXT NOT NULL CHECK (status IN ('decided','executed','held')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_a2a_arbitrations_intent ON a2a_arbitrations (intent_id);
CREATE INDEX IF NOT EXISTS idx_a2a_arbitrations_owner  ON a2a_arbitrations (owner_ref);
-- 1 arbitraje activo por intent (UNIQUE parcial sobre intent_id).
CREATE UNIQUE INDEX IF NOT EXISTS uq_a2a_arbitrations_intent ON a2a_arbitrations (intent_id);

ALTER TABLE a2a_arbitrations ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- RPC: open_dispute
-- Transición atómica open→disputed bajo SELECT ... FOR UPDATE. El gate
-- status='open' + el row-lock hacen el anti-race con close_payment_intent_for_settle
-- (AC-4): ambos exigen 'open' bajo lock; el perdedor ve no-open y aborta →
-- doble-settle imposible. NO mueve dinero (sólo marca la disputa).
-- ============================================================
CREATE OR REPLACE FUNCTION open_dispute(
  p_intent_id UUID,
  p_owner_ref TEXT
) RETURNS TABLE(
  intent_type    TEXT,
  key_id         UUID,
  chain_id       INT,
  pay_to         TEXT,
  seller_ref     TEXT,
  authorized_usd NUMERIC,
  consumed_usd   NUMERIC,
  expires_at     TIMESTAMPTZ
) AS $$
DECLARE
  v_owner    TEXT;
  v_status   TEXT;
  v_type     TEXT;
  v_key      UUID;
  v_chain    INT;
  v_payto    TEXT;
  v_seller   TEXT;
  v_auth     NUMERIC;
  v_consumed NUMERIC;
  v_expires  TIMESTAMPTZ;
BEGIN
  SELECT pi.owner_ref, pi.status, pi.intent_type, pi.key_id, pi.chain_id,
         pi.pay_to, pi.seller_ref, pi.authorized_usd, pi.consumed_usd, pi.expires_at
    INTO v_owner, v_status, v_type, v_key, v_chain,
         v_payto, v_seller, v_auth, v_consumed, v_expires
    FROM a2a_payment_intents pi
    WHERE pi.id = p_intent_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENT_NOT_FOUND: %', p_intent_id;
  END IF;
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: intent % not owned by caller', p_intent_id;
  END IF;
  -- Gate anti-race (AC-4): sólo un intent 'open' puede entrar en disputa.
  IF v_status <> 'open' THEN
    RAISE EXCEPTION 'INTENT_NOT_OPEN: intent % is %', p_intent_id, v_status;
  END IF;

  UPDATE a2a_payment_intents SET status = 'disputed' WHERE id = p_intent_id;

  intent_type    := v_type;
  key_id         := v_key;
  chain_id       := v_chain;
  pay_to         := v_payto;
  seller_ref     := v_seller;
  authorized_usd := v_auth;
  consumed_usd   := v_consumed;
  expires_at     := v_expires;
  RETURN NEXT;
  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.open_dispute(uuid, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.open_dispute(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_dispute(uuid, text)
  TO service_role;

-- ============================================================
-- RPC: close_payment_intent_for_arbitration
-- Espejo de close_payment_intent_for_settle (misma forma de retorno). Transiciona
-- disputed→arb_closing persistiendo el monto forzado por el árbitro en consumed_usd
-- (clamp [0,deposit] — el árbitro NUNCA settlea > deposit, invariante "no crear plata").
-- En 'arb_closing' (recovery) NO re-transiciona ni re-clampa: lee el monto ya
-- persistido — espejo exacto de la rama 'closing' de close_payment_intent_for_settle.
-- ============================================================
CREATE OR REPLACE FUNCTION close_payment_intent_for_arbitration(
  p_intent_id  UUID,
  p_owner_ref  TEXT,
  p_arb_amount NUMERIC
) RETURNS TABLE(
  final_amount   NUMERIC,
  prev_status    TEXT,
  intent_type    TEXT,
  key_id         UUID,
  chain_id       INT,
  pay_to         TEXT,
  authorized_usd NUMERIC,
  consumed_usd   NUMERIC,
  settle_tx_hash TEXT,
  settle_outcome TEXT
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
  v_outcome  TEXT;
  v_final    NUMERIC;
  v_arb      NUMERIC;
BEGIN
  SELECT pi.owner_ref, pi.status, pi.intent_type, pi.key_id, pi.chain_id,
         pi.pay_to, pi.authorized_usd, pi.consumed_usd, pi.settle_tx_hash,
         pi.settle_outcome
    INTO v_owner, v_status, v_type, v_key, v_chain,
         v_payto, v_auth, v_consumed, v_tx, v_outcome
    FROM a2a_payment_intents pi
    WHERE pi.id = p_intent_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENT_NOT_FOUND: %', p_intent_id;
  END IF;
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: intent % not owned by caller', p_intent_id;
  END IF;

  -- Clamp: el árbitro NUNCA settlea > deposit ni < 0 ("no crear plata").
  v_arb := GREATEST(0, LEAST(v_auth, COALESCE(p_arb_amount, 0)));

  IF v_status = 'disputed' THEN
    -- Transición disputed→arb_closing: persiste el monto forzado (MNR-2), para que
    -- el path idempotente/recovery en 'arb_closing' lea el monto realmente settleado
    -- desde la fila en vez de recomputarlo.
    v_final    := v_arb;
    v_consumed := v_arb;
    UPDATE a2a_payment_intents
      SET status = 'arb_closing', consumed_usd = v_arb
      WHERE id = p_intent_id;
  ELSIF v_status = 'arb_closing' THEN
    -- Recovery: NO re-transiciona, NO re-clampa. Lee el monto persistido
    -- (espejo de la rama 'closing' de close_payment_intent_for_settle).
    v_final := v_consumed;
  ELSE
    -- No está en un estado de arbitraje settleable → el service NO re-settlea.
    RAISE EXCEPTION 'INTENT_NOT_OPEN: intent % is %', p_intent_id, v_status;
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
  settle_outcome := v_outcome;
  RETURN NEXT;
  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.close_payment_intent_for_arbitration(uuid, text, numeric)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.close_payment_intent_for_arbitration(uuid, text, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_payment_intent_for_arbitration(uuid, text, numeric)
  TO service_role;

-- ============================================================
-- CREATE OR REPLACE record_settle_outcome (Decisión Crítica — Option B)
-- Cuerpo VERBATIM de la migración WKH-135, cambiando UNA línea: el gate de status
-- 'closing' → IN ('closing','arb_closing'). NINGUNA rama de dinero cambia. Additive
-- y byte-idéntico para todo intent no-arbitraje (ninguno del money-path normal llega
-- a 'arb_closing'). Re-declara el hardening.
-- ============================================================
CREATE OR REPLACE FUNCTION record_settle_outcome(
  p_intent_id    UUID,
  p_owner_ref    TEXT,
  p_outcome      TEXT,
  p_tx_hash      TEXT,
  p_residual     NUMERIC,
  p_error        TEXT
) RETURNS void AS $$
DECLARE
  v_owner  TEXT;
  v_status TEXT;
BEGIN
  SELECT owner_ref, status
    INTO v_owner, v_status
    FROM a2a_payment_intents
    WHERE id = p_intent_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENT_NOT_FOUND: %', p_intent_id;
  END IF;
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: intent % not owned by caller', p_intent_id;
  END IF;

  -- Solo anota mientras sigue en un estado de cierre (money-free, idempotente).
  -- WKH-139 (Option B): gate ensanchado a 'arb_closing' — SÓLO el predicado; el
  -- resto es byte-idéntico a WKH-135.
  IF v_status NOT IN ('closing','arb_closing') THEN
    RETURN;
  END IF;

  UPDATE a2a_payment_intents
    SET settle_outcome = p_outcome,
        settle_tx_hash = COALESCE(p_tx_hash, settle_tx_hash),
        residual_usd   = p_residual,
        error_message  = p_error
    WHERE id = p_intent_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.record_settle_outcome(uuid, text, text, text, numeric, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.record_settle_outcome(uuid, text, text, text, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_settle_outcome(uuid, text, text, text, numeric, text)
  TO service_role;

-- ============================================================
-- CREATE OR REPLACE finalize_payment_intent (Decisión Crítica — Option B)
-- Cuerpo VERBATIM de la migración WKH-135, cambiando UNA línea: el gate de status
-- 'closing' → IN ('closing','arb_closing'). NINGUNA rama de dinero cambia (refund,
-- outcomes, clamp — todo verbatim). Re-declara el hardening.
-- ============================================================
CREATE OR REPLACE FUNCTION finalize_payment_intent(
  p_intent_id    UUID,
  p_owner_ref    TEXT,
  p_tx_hash      TEXT,
  p_final_amount NUMERIC,
  p_residual     NUMERIC,
  p_outcome      TEXT,
  p_error        TEXT
) RETURNS void AS $$
DECLARE
  v_owner    TEXT;
  v_status   TEXT;
  v_type     TEXT;
  v_key      UUID;
  v_chain    INT;
  v_auth     NUMERIC;
  v_consumed NUMERIC;
BEGIN
  SELECT owner_ref, status, intent_type, key_id, chain_id, authorized_usd, consumed_usd
    INTO v_owner, v_status, v_type, v_key, v_chain, v_auth, v_consumed
    FROM a2a_payment_intents
    WHERE id = p_intent_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENT_NOT_FOUND: %', p_intent_id;
  END IF;
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: intent % not owned by caller', p_intent_id;
  END IF;

  -- Idempotencia + atomicidad money+status: solo se finaliza una transición de
  -- cierre. Re-invocar sobre un intent terminal = no-op ⇒ refund UNA sola vez.
  -- WKH-139 (Option B): gate ensanchado a 'arb_closing' — SÓLO el predicado; el
  -- resto (todas las ramas de dinero) es byte-idéntico a WKH-135.
  IF v_status NOT IN ('closing','arb_closing') THEN
    RETURN;
  END IF;

  IF p_outcome = 'settled' THEN
    UPDATE a2a_payment_intents
      SET status = 'settled', settle_tx_hash = p_tx_hash,
          residual_usd = p_residual, settle_outcome = 'settled'
      WHERE id = p_intent_id;
    -- credit-back del residual (session, AC-2). upto NO reservó → NO refunda.
    IF v_type = 'session' AND p_residual IS NOT NULL AND p_residual > 0 THEN
      PERFORM refund_a2a_key_spend(v_key, v_chain, p_residual, p_owner_ref);
    END IF;

  ELSIF p_outcome = 'failed_unequivocal' THEN
    -- settle NO ocurrió on-chain → refund del monto reservado/debitado del buyer,
    -- en la MISMA tx que el status flip (status-gated ⇒ exactamente una vez).
    UPDATE a2a_payment_intents
      SET status = 'refunded', settle_outcome = 'failed_unequivocal',
          error_message = COALESCE(p_error, error_message)  -- recovery: preserva el detalle persistido
      WHERE id = p_intent_id;
    IF v_type = 'session' THEN
      IF v_auth IS NOT NULL AND v_auth > 0 THEN
        PERFORM refund_a2a_key_spend(v_key, v_chain, v_auth, p_owner_ref);
      END IF;
    ELSE
      IF v_consumed IS NOT NULL AND v_consumed > 0 THEN
        PERFORM refund_a2a_key_spend(v_key, v_chain, v_consumed, p_owner_ref);
      END IF;
    END IF;

  ELSE
    -- failed_ambiguous / debit-fail: status failed, NO refund (evita doble-gasto).
    UPDATE a2a_payment_intents
      SET status = 'failed', settle_outcome = 'failed_ambiguous',
          error_message = COALESCE(p_error, error_message)  -- recovery: preserva el RECONCILE persistido
      WHERE id = p_intent_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.finalize_payment_intent(uuid, text, text, numeric, numeric, text, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.finalize_payment_intent(uuid, text, text, numeric, numeric, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_payment_intent(uuid, text, text, numeric, numeric, text, text)
  TO service_role;

-- ── 6. Extender receipt_type CHECK de a2a_receipts (+4, additive) ──
ALTER TABLE a2a_receipts DROP CONSTRAINT IF EXISTS a2a_receipts_receipt_type_check;
ALTER TABLE a2a_receipts ADD CONSTRAINT a2a_receipts_receipt_type_check
  CHECK (receipt_type IN (
    'protocol_fee','budget_debit','deposit_verified',
    'arbitration_release','arbitration_refund',
    'arbitration_split','arbitration_hold'
  ));
