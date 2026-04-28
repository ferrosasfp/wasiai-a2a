-- ============================================================
-- Migration: 20260427210000_registries_owner_ref
-- WKH-63 / SEC-REG-1: Add owner_ref to registries for ownership guards
-- Proyecto: wasiai-a2a
-- Supabase dev: bdwvrwzvsldephfibmuu.supabase.co
-- ============================================================
--
-- Aditiva e idempotente:
--   * `IF NOT EXISTS` para la columna y el índice.
--   * `DEFAULT 'system'` para back-fill: la fila pre-existente 'wasiai'
--     queda como `system` y el guard del service la trata como inmutable
--     (403 en update/delete).
--   * `NOT NULL` se garantiza por el DEFAULT — todas las filas existentes
--     reciben 'system' al aplicar el ALTER.
--
-- Por qué TEXT (no UUID): el resto de las tablas con ownership
-- (`a2a_agent_keys.owner_ref`) usan TEXT para soportar identifiers
-- heterogéneos (UUID Supabase, Kite passport hex, etc.). Mantener consistencia.
--
-- Defense-in-depth (TD-SEC-01): mientras RLS no esté habilitado a nivel
-- Postgres, el ownership check vive en `src/services/registry.ts` (app-layer)
-- — el cliente Supabase usa SUPABASE_SERVICE_ROLE_KEY que bypassea RLS.
-- ============================================================

ALTER TABLE registries
  ADD COLUMN IF NOT EXISTS owner_ref TEXT NOT NULL DEFAULT 'system';

-- Índice para queries del tipo "list mine" (futuro endpoint) y para
-- acelerar el pre-fetch del ownership check en update/delete.
CREATE INDEX IF NOT EXISTS idx_registries_owner_ref
  ON registries (owner_ref);
