-- Migration: kite_schema_transforms
-- Hackathon Kite — prefijo kite_
-- Caché persistente de transformaciones de schema entre agentes

CREATE TABLE IF NOT EXISTS kite_schema_transforms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_agent_id TEXT NOT NULL,
  target_agent_id TEXT NOT NULL,
  transform_fn TEXT NOT NULL,
  hit_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(source_agent_id, target_agent_id)
);

-- Índice para lookup rápido por par de agentes
CREATE INDEX IF NOT EXISTS idx_kite_schema_transforms_pair
  ON kite_schema_transforms (source_agent_id, target_agent_id);
