-- ============================================================
-- Migration: 20260628000000_wkh54_tasks_owner_ref
-- Completa WKH-54: la tabla `tasks` nunca recibió la columna `owner_ref`
-- en prod, pese a que `src/services/task.ts` filtra/inserta por ella
-- (ownership isolation, mismo patrón que WKH-53 para a2a_agent_keys).
--
-- Hallazgo: auditoría 2026-04 (CLAUDE.md "tasks | — pending WKH-54") +
-- auditoría 2026-06-24 (M9: el tipo generado y test/verify-rls-enabled.test.ts
-- confirman que `tasks` NO tiene owner_ref). Sin esta columna, toda operación
-- de la API de tasks erroraría ("column owner_ref does not exist"); no estalló
-- porque la tabla tiene 0 filas (feature no usada).
--
-- `tasks` tiene 0 filas en prod, así que ADD COLUMN NOT NULL sin default es seguro.
-- Cada insert de task.ts provee owner_ref, así que NOT NULL refleja el invariante.
-- ============================================================

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS owner_ref TEXT NOT NULL;

-- Index para los filtros por owner (get/list/updateStatus/append).
CREATE INDEX IF NOT EXISTS idx_tasks_owner_ref
  ON tasks (owner_ref);

-- WKH-SEC-02 (defensa en profundidad): deny-by-default para anon/authenticated.
-- El service usa SUPABASE_SERVICE_KEY (BYPASSRLS), así que el guard real sigue
-- siendo el filtro app-layer `.eq('owner_ref', ...)`; RLS es defensa adicional.
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
