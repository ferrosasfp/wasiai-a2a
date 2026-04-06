-- ============================================================
-- Migration: 20260405300000_reputation_view
-- WKH-28: SQL VIEW for reputation score computation
-- ============================================================

CREATE OR REPLACE VIEW v_reputation_scores AS
SELECT
  agent_id                                              AS agent_slug,
  MAX(agent_name)                                       AS agent_name,
  MAX(registry)                                         AS registry,
  COUNT(*)                                              AS total_invocations,
  COUNT(*) FILTER (WHERE status = 'success')            AS success_count,
  CASE
    WHEN COUNT(*) > 0
    THEN COUNT(*) FILTER (WHERE status = 'success')::numeric / COUNT(*)
    ELSE 0
  END                                                   AS success_rate,
  COALESCE(AVG(latency_ms)::integer, 0)                AS avg_latency_ms,
  COALESCE(AVG(cost_usdc), 0)                          AS avg_cost_usdc
FROM a2a_events
WHERE event_type = 'compose_step'
  AND agent_id IS NOT NULL
GROUP BY agent_id;
