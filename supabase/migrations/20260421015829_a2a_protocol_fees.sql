-- ============================================================
-- Migration: 20260421015829_a2a_protocol_fees
-- WKH-44: Tabla de idempotencia para el cobro del 1% protocol fee
--         de /orchestrate (transfer EIP-712 best-effort).
-- ============================================================

CREATE TABLE IF NOT EXISTS a2a_protocol_fees (
  orchestration_id UUID          PRIMARY KEY,
  budget_usdc      NUMERIC(18,6) NOT NULL,
  fee_rate         NUMERIC(6,4)  NOT NULL,
  fee_usdc         NUMERIC(18,6) NOT NULL,
  fee_wallet       TEXT          NOT NULL,
  status           TEXT          NOT NULL
    CHECK (status IN ('pending', 'charged', 'failed', 'skipped')),
  tx_hash          TEXT,
  error_message    TEXT,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Índice en status (queries comunes: count failed, list pending)
CREATE INDEX IF NOT EXISTS idx_a2a_protocol_fees_status
  ON a2a_protocol_fees (status);

-- Índice por fecha descendente (dashboards / auditoría reciente)
CREATE INDEX IF NOT EXISTS idx_a2a_protocol_fees_created
  ON a2a_protocol_fees (created_at DESC);

-- Trigger updated_at automático (reusa función de 20260403180000_tasks.sql)
DROP TRIGGER IF EXISTS set_updated_at ON a2a_protocol_fees;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON a2a_protocol_fees
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();
