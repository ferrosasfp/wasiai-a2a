-- ============================================================
-- Migration: 20260703000000_wkh133_reputation_writebacks
-- WKH-133: idempotency + observability para el write-back de reputación
-- on-chain a ERC-8004 (Base). event_id = a2a_events.id (UUID server-gen)
-- es la CLAVE de idempotencia (UNIQUE) — barrera anti-doble-gasto de gas.
-- Estado de sistema global (SIN owner_ref, como a2a_events/registries):
-- solo el service (SUPABASE_SERVICE_KEY) escribe/lee; ninguna ruta la expone.
-- RLS ENABLE = deny-by-default (defensa en profundidad, patrón WKH-SEC-02).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.a2a_reputation_writebacks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         UUID NOT NULL UNIQUE,          -- FK lógica a a2a_events.id
  agent_slug       TEXT NOT NULL,
  onchain_agent_id TEXT NOT NULL,                 -- token_id ERC-8004 (string, anti-precision-loss)
  chain_id         INTEGER NOT NULL,
  status           TEXT NOT NULL,                 -- 'pending' | 'confirmed' | 'failed'
  tx_hash          TEXT,                          -- solo cuando status='confirmed'
  error_code       TEXT,                          -- código corto (NUNCA error.message crudo — CD-6/CD-3)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- UNIQUE(event_id) ya crea índice; índice extra para el sweeper futuro por status.
CREATE INDEX IF NOT EXISTS idx_a2a_reputation_writebacks_status
  ON public.a2a_reputation_writebacks (status);

-- WKH-SEC-02 (defensa en profundidad): deny-by-default para anon/authenticated.
-- El service usa SUPABASE_SERVICE_KEY (BYPASSRLS), así que el guard real sigue
-- siendo la capa app; RLS es defensa adicional (sin POLICY → nadie más lee/escribe).
ALTER TABLE public.a2a_reputation_writebacks ENABLE ROW LEVEL SECURITY;
