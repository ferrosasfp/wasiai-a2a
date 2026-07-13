-- ============================================================
-- Migration: 20260713000002_wkh191c_reconciliation
-- WKH-191c: motor de reconciliación. Extiende ADITIVAMENTE la tabla de 191a/191b
-- con el state-machine de resolución (resolving_* / resolved_*), 2 columnas de
-- evidencia de la resolución, un índice parcial de resoluciones colgadas, y 2 RPCs
-- SECURITY DEFINER owner-guarded (claim atómico + flip terminal money-atomic con el
-- refund del budget DENTRO del RPC, status-gated). NO toca contracts/, NO toca los
-- RPC de wkh135/191a/191b. El refund es BUDGET-ONLY (nunca mueve fondos on-chain).
-- Patrón: 20260713000001_wkh191b_debit_hop1.sql.
-- ============================================================

BEGIN;

-- ── 1. Widen CHECK de debit_settle_status (3 → 7 valores) ──
-- VERIFY-AT-IMPL (R-5): el nombre auto-generado del CHECK inline de 191b es
-- <tabla>_<col>_check (convención Postgres). Confirmar con `\d
-- a2a_payment_intent_debit_signatures` en dev que el DROP CONSTRAINT matchea el
-- nombre real; el IF EXISTS evita el fallo pero también un no-op silencioso — tras
-- aplicar, verificar que un UPDATE a 'resolving_settle' NO es rechazado por el CHECK.
ALTER TABLE a2a_payment_intent_debit_signatures
  DROP CONSTRAINT IF EXISTS a2a_payment_intent_debit_signatures_debit_settle_status_check;
ALTER TABLE a2a_payment_intent_debit_signatures
  ADD  CONSTRAINT a2a_payment_intent_debit_signatures_debit_settle_status_check
  CHECK (debit_settle_status IS NULL OR debit_settle_status IN
    ('hop1_confirmed','settled','reconciliation_pending',
     'resolving_settle','resolving_refund','resolved_settled','resolved_refunded'));

-- ── 2. Columnas nullable aditivas (evidencia de la resolución) ──
ALTER TABLE a2a_payment_intent_debit_signatures
  ADD COLUMN IF NOT EXISTS debit_resolution_tx_hash TEXT,        -- tx del hop2-retry (NULL en refund budget-only)
  ADD COLUMN IF NOT EXISTS debit_resolved_at        TIMESTAMPTZ; -- timestamp del flip terminal

-- ── 3. Índice parcial (surface de resoluciones colgadas; NO toca el índice de 191b) ──
CREATE INDEX IF NOT EXISTS idx_debit_sig_resolving
  ON a2a_payment_intent_debit_signatures (debit_settle_status)
  WHERE debit_settle_status IN ('resolving_settle','resolving_refund');

-- ============================================================
-- RPC: claim_reconciliation (SECURITY DEFINER, owner-guarded, atómico gana-EXACTAMENTE-uno)
-- Transición condicional pending → resolving_*. Solo UN caller gana la ENTRADA fresca
-- (guard de concurrencia, serializado por el FOR UPDATE de abajo).
--
-- BLQ-ALTO-1 (AR): un 2º caller CONCURRENTE sobre un intent que YA está en resolving_*
-- NO debe re-claimar el lado settle sin evidencia, porque ambos re-enviarían el hop2
-- (double-pay al seller). El re-claim de un resolving_* colgado se permite SOLO con
-- evidencia segura:
--   · settle : exige un debit_resolution_tx_hash previo (lease del envío). El caller
--     re-verifica on-chain ANTES de re-enviar → nunca double-paga. Un resolving_settle
--     SIN tx previo (2º run concurrente / crash pre-envío) → 0 filas → claimed=false.
--   · refund : budget-only e idempotente (el crédito vive status-gated dentro de
--     record_reconciliation_resolution) → re-claim siempre seguro.
-- marker OPUESTO o terminal resolved_* → 0 filas → claimed=false. NUNCA mueve dinero.
-- p_side ∈ ('settle','refund').
-- ============================================================
CREATE OR REPLACE FUNCTION claim_reconciliation(
  p_intent_id UUID,
  p_owner_ref TEXT,
  p_key_id    UUID,
  p_nonce     NUMERIC,
  p_side      TEXT
) RETURNS TABLE(
  claimed            BOOLEAN,
  resolution_tx_hash TEXT,
  amount_atomic      TEXT
) AS $$
DECLARE
  v_owner   TEXT;
  v_target  TEXT;
  v_rows    INT;
BEGIN
  IF p_side NOT IN ('settle','refund') THEN
    RAISE EXCEPTION 'INVALID_SIDE: %', p_side;
  END IF;
  v_target := CASE p_side WHEN 'settle' THEN 'resolving_settle' ELSE 'resolving_refund' END;

  -- Ownership Guard DB-level (CD-8/WKH-53), espejo 191b.
  SELECT owner_ref INTO v_owner
    FROM a2a_payment_intents
    WHERE id = p_intent_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENT_NOT_FOUND: %', p_intent_id;
  END IF;
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: intent % not owned by caller', p_intent_id;
  END IF;

  -- Transición condicional atómica: gana-EXACTAMENTE-uno. La entrada fresca
  -- (hop1_confirmed / reconciliation_pending) la gana un solo caller. El re-claim de un
  -- resolving_* colgado se permite SOLO con evidencia segura (settle: tx previa; refund:
  -- siempre, por ser idempotente) → cierra el doble hop2 concurrente (BLQ-ALTO-1/AR).
  UPDATE a2a_payment_intent_debit_signatures
     SET debit_settle_status = v_target
   WHERE key_id = p_key_id
     AND debit_nonce = p_nonce
     AND debit_validation_status = 'valid'
     AND (
       debit_settle_status IN ('hop1_confirmed','reconciliation_pending')
       OR (
         debit_settle_status = v_target
         AND (p_side = 'refund' OR debit_resolution_tx_hash IS NOT NULL)
       )
     );
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows > 0 THEN
    SELECT TRUE,
           s.debit_resolution_tx_hash,
           s.debit_amount_atomic::TEXT
      INTO claimed, resolution_tx_hash, amount_atomic
      FROM a2a_payment_intent_debit_signatures s
      WHERE s.key_id = p_key_id
        AND s.debit_nonce = p_nonce
        AND s.debit_validation_status = 'valid';
  ELSE
    claimed := FALSE;
  END IF;
  RETURN NEXT;
  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.claim_reconciliation(uuid, text, uuid, numeric, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.claim_reconciliation(uuid, text, uuid, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_reconciliation(uuid, text, uuid, numeric, text)
  TO service_role;

-- ============================================================
-- RPC: record_reconciliation_resolution (SECURITY DEFINER, owner-guarded,
-- status-gated, MONEY-ATOMIC). Flip terminal resolving_* → resolved_*. El refund del
-- budget (SOLO lado refund) ocurre DENTRO de la MISMA tx que el flip, status-gated →
-- exactamente una vez (CD-2). Un retry ve resolved_* → applied=false → NO re-credita.
-- p_terminal_status ∈ ('resolved_settled','resolved_refunded'):
--   resolved_settled  ⇐ SOLO desde resolving_settle
--   resolved_refunded ⇐ SOLO desde resolving_refund   (enforcement CD-1/AC-6)
-- p_refund_amount_usd: >0 SOLO en resolved_refunded; NULL en resolved_settled.
-- ============================================================
CREATE OR REPLACE FUNCTION record_reconciliation_resolution(
  p_intent_id        UUID,
  p_owner_ref        TEXT,
  p_key_id           UUID,
  p_nonce            NUMERIC,
  p_terminal_status  TEXT,
  p_tx_hash          TEXT,
  p_chain_id         INT,
  p_refund_amount_usd NUMERIC
) RETURNS TABLE(applied BOOLEAN) AS $$
DECLARE
  v_owner    TEXT;
  v_required TEXT;
  v_rows     INT;
  v_refunded INT;
BEGIN
  IF p_terminal_status NOT IN ('resolved_settled','resolved_refunded') THEN
    RAISE EXCEPTION 'INVALID_TERMINAL_STATUS: %', p_terminal_status;
  END IF;
  -- CD-1/AC-6: cada terminal solo desde su resolving_* correspondiente.
  v_required := CASE p_terminal_status
                  WHEN 'resolved_settled'  THEN 'resolving_settle'
                  ELSE 'resolving_refund'
                END;

  -- Ownership Guard DB-level (CD-8), espejo 191b.
  SELECT owner_ref INTO v_owner
    FROM a2a_payment_intents
    WHERE id = p_intent_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENT_NOT_FOUND: %', p_intent_id;
  END IF;
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: intent % not owned by caller', p_intent_id;
  END IF;

  -- Flip terminal status-gated. debit_resolution_tx_hash con COALESCE (la 1ª gana).
  UPDATE a2a_payment_intent_debit_signatures
     SET debit_settle_status      = p_terminal_status,
         debit_resolution_tx_hash = COALESCE(debit_resolution_tx_hash, p_tx_hash),
         debit_resolved_at        = now()
   WHERE key_id = p_key_id
     AND debit_nonce = p_nonce
     AND debit_validation_status = 'valid'
     AND debit_settle_status = v_required;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows > 0 THEN
    applied := TRUE;
    -- Money-atomic: SOLO el lado refund acredita el budget, DENTRO de esta tx,
    -- status-gated (exactamente una vez). refund_a2a_key_spend es owner-guarded y
    -- no-op si el monto ≤0. NUNCA mueve fondos on-chain (budget-only, DT-R4/NC-1).
    IF p_terminal_status = 'resolved_refunded'
       AND p_refund_amount_usd IS NOT NULL
       AND p_refund_amount_usd > 0 THEN
      v_refunded := refund_a2a_key_spend(p_key_id, p_chain_id, p_refund_amount_usd, p_owner_ref);
      -- MNR-1 (AR): NO marcar resolved_refunded silenciosamente si el crédito NO ocurrió.
      -- refund_a2a_key_spend devuelve las filas afectadas; 0/NULL ⇒ inconsistencia (key
      -- inexistente, owner_ref discordante, o monto no aplicable). RAISE revierte el flip
      -- terminal completo (atómico) → el intent queda resolving_refund reintentable y el
      -- caller VE el error (nunca un refund fantasma marcado como resuelto).
      IF v_refunded IS NULL OR v_refunded = 0 THEN
        RAISE EXCEPTION 'REFUND_NOOP: key % chain % amount % affected 0 rows',
          p_key_id, p_chain_id, p_refund_amount_usd;
      END IF;
    END IF;
  ELSE
    applied := FALSE; -- ya terminal / marker equivocado → no-op idempotente (CD-2)
  END IF;
  RETURN NEXT;
  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.record_reconciliation_resolution(uuid, text, uuid, numeric, text, text, integer, numeric)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.record_reconciliation_resolution(uuid, text, uuid, numeric, text, text, integer, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_reconciliation_resolution(uuid, text, uuid, numeric, text, text, integer, numeric)
  TO service_role;

COMMIT;
