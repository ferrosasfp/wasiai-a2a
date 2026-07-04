-- ============================================================
-- Migration: 20260705000000_wkh136_fee_splits
-- WKH-136: Splits atómicos del protocol fee (bps: plataforma / creador / referral).
-- Proyecto: wasiai-a2a
--
-- El protocol fee único (WKH-44/132, tabla a2a_protocol_fees) se SUBDIVIDE en N
-- recipients configurables en basis points. El total cobrado al caller NO cambia
-- (invariante WKH-132). Esta tabla registra los legs ADICIONALES (creador /
-- referral / y — en el seam del engine — plataforma) con idempotencia por
-- recipient. a2a_protocol_fees sigue siendo el registro del leg de plataforma en
-- el path v1 (CD-2: PROHIBIDO reusar su PK única para >1 recipient).
--
-- Seguridad:
--   - owner_ref NOT NULL: ownership app-layer (WKH-53/63 pattern). El cliente
--     Supabase usa SERVICE_KEY (BYPASSRLS) → el guard real vive en la app
--     (`.eq('owner_ref', ...)`).
--   - RLS deny-by-default (espejo WKH-134 / SEC-02c): ENABLE sin FORCE, sin
--     policy permisiva. service_role bypassa por BYPASSRLS; anon/authenticated →
--     deny-all.
--   - UNIQUE(orchestration_id, recipient_role): idempotencia por leg (CD-2). Un
--     segundo intento sobre el mismo (orch, role) choca con 23505 → skip.
-- ============================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public.a2a_fee_splits (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  orchestration_id UUID NOT NULL,
  recipient_role   TEXT NOT NULL
                   CHECK (recipient_role IN ('platform', 'creator', 'referral')),
  recipient_wallet TEXT NOT NULL,
  owner_ref        TEXT NOT NULL,
  bps              INT  NOT NULL CHECK (bps >= 0 AND bps <= 10000),
  amount_usdc      NUMERIC(18, 6) NOT NULL CHECK (amount_usdc >= 0),
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'charged', 'failed', 'skipped', 'reversed')),
  tx_hash          TEXT,
  error_message    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (orchestration_id, recipient_role)
);

-- Índice por orchestration (lookup de todos los legs de un settlement / reverse).
CREATE INDEX IF NOT EXISTS idx_a2a_fee_splits_orch
  ON public.a2a_fee_splits (orchestration_id);

-- Índice para el ownership filter (WKH-53 pattern).
CREATE INDEX IF NOT EXISTS idx_a2a_fee_splits_owner
  ON public.a2a_fee_splits (owner_ref);

-- Índice en status (queries comunes: count failed, list pending/charged).
CREATE INDEX IF NOT EXISTS idx_a2a_fee_splits_status
  ON public.a2a_fee_splits (status);

-- Trigger updated_at automático (reusa función trigger_set_updated_at, patrón
-- a2a_protocol_fees:30-34).
DROP TRIGGER IF EXISTS set_updated_at ON public.a2a_fee_splits;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.a2a_fee_splits
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();

-- RLS deny-by-default (espejo WKH-134): sin FORCE, sin policy permisiva.
-- ENABLE es idempotente (re-aplicable sin error).
ALTER TABLE public.a2a_fee_splits ENABLE ROW LEVEL SECURITY;

-- Columnas nuevas en a2a_agents (SG-2/SG-5): payout wallet del creador
-- self-published y referrer_ref capturado al publicar (server-side). IF NOT
-- EXISTS → idempotente / re-aplicable.
ALTER TABLE public.a2a_agents
  ADD COLUMN IF NOT EXISTS payout_wallet TEXT,
  ADD COLUMN IF NOT EXISTS referrer_ref  TEXT;

COMMIT;
