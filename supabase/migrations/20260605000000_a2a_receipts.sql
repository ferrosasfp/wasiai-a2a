-- WKH-124 KEY-RECEIPTS: recibos inmutables HMAC-encadenados (append-only) por owner.
-- Aditiva y reversible. agent_key_id es NULLABLE (path protocol_fee no tiene la key en scope);
-- la integridad la garantiza receipt_hash, no la NOT-NULL constraint. owner_ref SÍ es NOT NULL
-- (clave de la cadena + Ownership Guard); si el call-site no tiene owner_ref → NO emite.

CREATE TABLE IF NOT EXISTS a2a_receipts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_ref          TEXT NOT NULL,                                          -- Ownership Guard (CD-3)
  agent_key_id       UUID REFERENCES a2a_agent_keys(id) ON DELETE SET NULL,  -- nullable (protocol_fee)
  session_id         UUID REFERENCES a2a_key_sessions(id) ON DELETE SET NULL,
  delegation_id      UUID REFERENCES a2a_delegations(id) ON DELETE SET NULL,
  receipt_type       TEXT NOT NULL CHECK (receipt_type IN ('protocol_fee','budget_debit')),
  amount_usd         NUMERIC(20,8) NOT NULL,
  chain_id           INT NOT NULL,
  tx_hash            TEXT,
  counterparty       TEXT,
  orchestration_id   TEXT,
  prev_receipt_hash  TEXT,                                                   -- NULL en el primer recibo del owner
  receipt_hash       TEXT NOT NULL DEFAULT '',                              -- '' = sin firmar (placeholder)
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índice para "último recibo del owner" (chain prev_receipt_hash) y para list (AC-7).
CREATE INDEX IF NOT EXISTS idx_a2a_receipts_owner_created
  ON a2a_receipts (owner_ref, created_at DESC);

-- ============================================================
-- RPC atómico: insert_receipt
-- Bajo advisory lock POR OWNER: lee el último receipt_hash del owner como prev,
-- inserta la fila con receipt_hash='' (el HMAC se computa en Node, NUNCA en Postgres),
-- y devuelve (id, prev_receipt_hash, created_at) para que el service firme + UPDATE-once.
-- El lock serializa inserts concurrentes del mismo owner → cadena lineal sin bifurcación.
-- ============================================================
CREATE OR REPLACE FUNCTION insert_receipt(
  p_owner_ref        TEXT,
  p_agent_key_id     UUID,
  p_session_id       UUID,
  p_delegation_id    UUID,
  p_receipt_type     TEXT,
  p_amount_usd       NUMERIC,
  p_chain_id         INT,
  p_tx_hash          TEXT,
  p_counterparty     TEXT,
  p_orchestration_id TEXT
) RETURNS TABLE (id UUID, prev_receipt_hash TEXT, created_at TIMESTAMPTZ) AS $$
DECLARE
  v_prev TEXT;
  v_id   UUID;
  v_at   TIMESTAMPTZ;
BEGIN
  -- 1. Lock por owner (serializa la cadena; se libera al COMMIT/ROLLBACK de esta tx).
  PERFORM pg_advisory_xact_lock(hashtext(p_owner_ref));

  -- 2. prev_receipt_hash = receipt_hash del último recibo del owner (NULL si es el primero).
  SELECT r.receipt_hash INTO v_prev
    FROM a2a_receipts r
    WHERE r.owner_ref = p_owner_ref
    ORDER BY r.created_at DESC
    LIMIT 1;

  -- 3. INSERT con receipt_hash='' (placeholder; el service firma luego).
  INSERT INTO a2a_receipts (
    owner_ref, agent_key_id, session_id, delegation_id, receipt_type,
    amount_usd, chain_id, tx_hash, counterparty, orchestration_id,
    prev_receipt_hash, receipt_hash
  ) VALUES (
    p_owner_ref, p_agent_key_id, p_session_id, p_delegation_id, p_receipt_type,
    p_amount_usd, p_chain_id, p_tx_hash, p_counterparty, p_orchestration_id,
    v_prev, ''
  )
  RETURNING a2a_receipts.id, a2a_receipts.created_at INTO v_id, v_at;

  id                := v_id;
  prev_receipt_hash := v_prev;
  created_at        := v_at;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Hardening obligatorio (CD-C).
ALTER FUNCTION public.insert_receipt(text, uuid, uuid, uuid, text, numeric, integer, text, text, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.insert_receipt(text, uuid, uuid, uuid, text, numeric, integer, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_receipt(text, uuid, uuid, uuid, text, numeric, integer, text, text, text)
  TO service_role;
