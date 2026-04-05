-- ============================================================
-- Migration: 20260404200000_events
-- WKH-27: Tabla de eventos para Dashboard Analytics
-- ============================================================

CREATE TABLE IF NOT EXISTS a2a_events (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type  TEXT        NOT NULL DEFAULT 'compose_step',
  agent_id    TEXT,
  agent_name  TEXT,
  registry    TEXT,
  status      TEXT        NOT NULL CHECK (status IN ('success', 'failed')),
  latency_ms  INTEGER,
  cost_usdc   NUMERIC(12,6) DEFAULT 0,
  tx_hash     TEXT,
  goal        TEXT,
  metadata    JSONB       DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indice principal: queries por fecha (dashboard)
CREATE INDEX IF NOT EXISTS idx_a2a_events_created
  ON a2a_events (created_at DESC);

-- Indice por agente (agregaciones por agente)
CREATE INDEX IF NOT EXISTS idx_a2a_events_agent
  ON a2a_events (agent_id);

-- Indice por status (filtros success/failed)
CREATE INDEX IF NOT EXISTS idx_a2a_events_status
  ON a2a_events (status);
