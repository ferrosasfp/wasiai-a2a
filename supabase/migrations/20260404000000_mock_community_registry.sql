-- ============================================================
-- Migration: 20260404000000_mock_community_registry
-- WKH-32: Seed mock "Community Hub" registry para demo multi-registry
-- Proyecto: wasiai-a2a (Hackathon Kite)
-- Supabase dev: bdwvrwzvsldephfibmuu.supabase.co
-- ============================================================
-- IMPORTANTE: discovery_endpoint usa placeholder http://localhost:3001
-- Actualizar manualmente en Supabase dashboard tras deploy con la URL real
-- (ej: https://wasiai-a2a.up.railway.app/mock-registry/agents)
-- ============================================================

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
  'mock-community',
  'Community Hub',
  'http://localhost:3001/mock-registry/agents',
  'http://localhost:3001/mock-registry/agents/{slug}/invoke',
  NULL,
  '{
    "discovery": {
      "queryParam": "q",
      "limitParam": "limit",
      "capabilityParam": "tag",
      "agentsPath": "agents",
      "agentMapping": {
        "id": "id",
        "name": "name",
        "slug": "slug",
        "description": "description",
        "capabilities": "tags",
        "price": "price_per_call_usdc",
        "reputation": "reputation_score"
      }
    },
    "invoke": {
      "method": "POST",
      "inputField": "input",
      "resultPath": "result"
    }
  }'::jsonb,
  NULL,
  true,
  NOW()
) ON CONFLICT (id) DO NOTHING;
