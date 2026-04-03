-- ============================================================
-- Migration: 20260401000000_kite_registries
-- WKH-7: Crear tabla registries + seed WasiAI
-- Proyecto: wasiai-a2a (Hackathon Kite)
-- Supabase dev: bdwvrwzvsldephfibmuu.supabase.co
-- ============================================================

-- Tabla principal de registries (marketplaces registrados)
CREATE TABLE IF NOT EXISTS registries (
  id                 TEXT        PRIMARY KEY,
  name               TEXT        NOT NULL,
  discovery_endpoint TEXT        NOT NULL,
  invoke_endpoint    TEXT        NOT NULL,
  agent_endpoint     TEXT,
  schema             JSONB       NOT NULL,
  auth               JSONB,
  enabled            BOOLEAN     NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índice para queries frecuentes (getEnabled())
CREATE INDEX IF NOT EXISTS idx_registries_enabled
  ON registries (enabled)
  WHERE enabled = true;

-- ── Seed WasiAI (idempotente) ────────────────────────────────
-- auth.value NO se incluye aquí — configurar manualmente en Supabase dashboard
INSERT INTO registries (
  id,
  name,
  discovery_endpoint,
  invoke_endpoint,
  agent_endpoint,
  schema,
  auth,
  enabled,
  created_at
) VALUES (
  'wasiai',
  'WasiAI',
  'https://app.wasiai.io/api/v1/capabilities',
  'https://app.wasiai.io/api/v1/models/{slug}/invoke',
  'https://app.wasiai.io/api/v1/agents/{slug}',
  '{
    "discovery": {
      "capabilityParam": "tag",
      "queryParam": "q",
      "limitParam": "limit",
      "maxPriceParam": "max_price",
      "agentsPath": "agents",
      "agentMapping": {
        "id": "id",
        "name": "name",
        "slug": "slug",
        "description": "description",
        "capabilities": "tags",
        "price": "price_per_call_usdc",
        "reputation": "erc8004.reputation_score"
      }
    },
    "invoke": {
      "method": "POST",
      "inputField": "input",
      "resultPath": "result"
    }
  }'::jsonb,
  '{"type": "header", "key": "x-agent-key"}'::jsonb,
  true,
  NOW()
) ON CONFLICT (id) DO NOTHING;
