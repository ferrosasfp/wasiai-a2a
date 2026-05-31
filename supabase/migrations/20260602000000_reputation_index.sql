-- WKH-103 (DT-9): índice parcial para el GROUP BY del score de reputación.
-- Cubre el filtro (agent_id, status) + INCLUDE de las columnas del aggregate
-- para evitar heap-fetch. WHERE agent_id IS NOT NULL → parcial (excluye los
-- eventos request:* / orchestrate_goal sin agente). Idempotente, sin DROP.
CREATE INDEX IF NOT EXISTS idx_a2a_events_reputation
  ON a2a_events (agent_id, status)
  INCLUDE (cost_usdc, latency_ms, created_at)
  WHERE agent_id IS NOT NULL;
