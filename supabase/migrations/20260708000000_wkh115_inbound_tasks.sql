-- ============================================================
-- Migration: 20260708000000_wkh115_inbound_tasks
-- WKH-115: Inbound Adapter — ingesta push/webhook de tareas externas
-- ruteadas in-process a orchestrateService. Aditiva 100%. NO toca
-- orchestrate / compose / tasks.
--
-- Crea:
--   - Tabla a2a_inbound_tasks (lifecycle: ingested→routed→settled|rejected|failed).
--   - 3 índices (owner_ref, source, status).
--   - RLS deny-by-default (service_role bypassa por BYPASSRLS; guard real
--     es el filtro app-layer .eq('owner_ref', ...)).
--   - Trigger updated_at (reusa trigger_set_updated_at, mismo que a2a_agent_links).
--
-- Patrón: 20260706000000_wkh137_agent_links.sql.
-- ============================================================

CREATE TABLE IF NOT EXISTS a2a_inbound_tasks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_ref        TEXT NOT NULL,                         -- Ownership Guard (CD-4); del key row de la fuente
  source           TEXT NOT NULL,                         -- :source del path (sanitizado)
  external_ref     TEXT,                                  -- id externo (del payload), nullable
  status           TEXT NOT NULL DEFAULT 'ingested'
                   CHECK (status IN ('ingested','routed','settled','rejected','failed')),
  goal             TEXT NOT NULL,                         -- goal normalizado
  budget_usdc      NUMERIC(20,8),                         -- budget CAPADO; NULL hasta 'routed'
  constraints      JSONB NOT NULL DEFAULT '{}'::jsonb,
  orchestration_id UUID,                                  -- nullable hasta 'routed'
  error_reason     TEXT,                                  -- nullable; poblado en rejected/failed
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_a2a_inbound_tasks_owner  ON a2a_inbound_tasks (owner_ref);
CREATE INDEX IF NOT EXISTS idx_a2a_inbound_tasks_source ON a2a_inbound_tasks (source);
CREATE INDEX IF NOT EXISTS idx_a2a_inbound_tasks_status ON a2a_inbound_tasks (status);

-- MNR-2 (idempotency / anti-replay money-path): un request firmado capturado y
-- re-enviado dentro de la ventana HMAC (300s) NO debe re-debitar la key de la
-- fuente. Índice UNIQUE parcial scoped por (owner_ref, source, external_ref)
-- SOLO cuando la fuente envía un id externo → dos ingestas idénticas colisionan
-- (backstop de la race concurrente; el pre-check app-layer cubre el caso normal).
CREATE UNIQUE INDEX IF NOT EXISTS uq_a2a_inbound_tasks_source_extref
  ON a2a_inbound_tasks (owner_ref, source, external_ref)
  WHERE external_ref IS NOT NULL;

-- RLS deny-by-default (patrón WKH-SEC-02). service_role bypassa por BYPASSRLS;
-- el guard real es el filtro app-layer .eq('owner_ref', ...). Sin policy permisiva.
ALTER TABLE a2a_inbound_tasks ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_a2a_inbound_tasks_updated_at ON a2a_inbound_tasks;
CREATE TRIGGER set_a2a_inbound_tasks_updated_at
  BEFORE UPDATE ON a2a_inbound_tasks
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
