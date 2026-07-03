-- ============================================================
-- Migration: 20260703000000_wkh134_a2a_agents
-- WKH-134: Self-serve publish de 1 agente (tabla a2a_agents).
-- Proyecto: wasiai-a2a
--
-- Tabla NUEVA para agentes self-published por devs individuales (1 agente,
-- URL + Agent Card mínima). NO reusa `registries` (esos son marketplaces
-- enteros). La discovery mergea estas filas con un SELECT (sin fetch
-- outbound) y las pasa por el mismo pipeline que los agentes de marketplace.
--
-- Seguridad:
--   - owner_ref NOT NULL: ownership app-layer (WKH-53/63 pattern). El cliente
--     Supabase usa SERVICE_KEY (BYPASSRLS) → el guard real vive en la app
--     (`.eq('owner_ref', ...)`).
--   - RLS deny-by-default (espejo WKH-SEC-02c): ENABLE sin FORCE, sin policy.
--     service_role bypassa por BYPASSRLS; anon/authenticated → deny-all.
-- ============================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public.a2a_agents (
  slug         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  capabilities JSONB NOT NULL,
  agent_url    TEXT NOT NULL,
  price_usdc   NUMERIC NOT NULL DEFAULT 0,
  metadata     JSONB,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  owner_ref    TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índice para el ownership filter (GET /agents list-mine, update/delete guard).
CREATE INDEX IF NOT EXISTS idx_a2a_agents_owner_ref
  ON public.a2a_agents (owner_ref);

-- Índice parcial para el SELECT de discovery (listAsAgents → WHERE enabled).
CREATE INDEX IF NOT EXISTS idx_a2a_agents_enabled
  ON public.a2a_agents (enabled)
  WHERE enabled;

-- RLS deny-by-default (espejo WKH-SEC-02c): sin FORCE, sin policy permisiva.
-- ENABLE es idempotente (re-aplicable sin error).
ALTER TABLE public.a2a_agents ENABLE ROW LEVEL SECURITY;

COMMIT;
