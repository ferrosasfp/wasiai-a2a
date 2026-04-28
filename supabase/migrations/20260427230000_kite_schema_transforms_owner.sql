-- ============================================================
-- Migration: 20260427230000_kite_schema_transforms_owner
-- WKH-60 / SEC-RCE-1: scope cached transformFn rows by owner_ref
-- Proyecto: wasiai-a2a
-- Supabase dev: bdwvrwzvsldephfibmuu.supabase.co
-- ============================================================
--
-- Problema: hoy la cache key es (source_agent_id, target_agent_id, schema_hash)
-- y NO incluye el caller. Eso significa que un atacante puede:
--   1) Hacer un compose con prompt-injection que envenene la cached fn.
--   2) Otro tenant ejecuta el mismo (source, target, schema) y recibe
--      la fn envenenada (cross-tenant cache poisoning).
--
-- Fix: agregar owner_ref como cuarta dimensión de la unique key, con
-- NULLS NOT DISTINCT para que entradas legacy (sin owner_ref) sigan siendo
-- accesibles solo cuando el caller también pasa ownerId === undefined
-- (modo degradado / x402 anonymous).
--
-- Aditiva e idempotente:
--   * `IF NOT EXISTS` para columna y índice.
--   * `IF EXISTS` para drop de la unique key vieja.
--   * `BEGIN/COMMIT` para atomicidad: si CREATE INDEX falla, el ALTER se
--     revierte y la migration es re-aplicable.
--
-- Defense-in-depth (TD-SEC-01): mientras RLS no esté habilitado a nivel
-- Postgres (cliente usa SUPABASE_SERVICE_ROLE_KEY que bypassea RLS), el
-- ownership filter vive en `src/services/llm/transform.ts` (app-layer)
-- via `.eq('owner_ref', ownerId)` en la query chain.
-- ============================================================

BEGIN;

-- 1) Add column. Sin DEFAULT — entradas legacy quedan NULL y solo se
--    matchean cuando el caller pasa ownerId === undefined.
ALTER TABLE kite_schema_transforms
  ADD COLUMN IF NOT EXISTS owner_ref TEXT;

-- 2) Drop la unique key 3-tupla creada por la migration anterior (WKH-57).
--    IF EXISTS para idempotencia.
ALTER TABLE kite_schema_transforms
  DROP CONSTRAINT IF EXISTS kite_schema_transforms_source_target_hash_key;

-- 3) Crear nueva unique key 4-tupla con NULLS NOT DISTINCT.
ALTER TABLE kite_schema_transforms
  ADD CONSTRAINT kite_schema_transforms_source_target_hash_owner_key
  UNIQUE NULLS NOT DISTINCT (source_agent_id, target_agent_id, schema_hash, owner_ref);

-- 4) Index para SELECT con owner filter.
CREATE INDEX IF NOT EXISTS idx_kite_schema_transforms_pair_hash_owner
  ON kite_schema_transforms (source_agent_id, target_agent_id, schema_hash, owner_ref);

-- 5) Column for HMAC integrity signature (W3 reads). Nullable: rows sin
--    signature se tratan como miss en modo HMAC enabled, o se aceptan en
--    modo degradado (HMAC key not configured, warn-once).
ALTER TABLE kite_schema_transforms
  ADD COLUMN IF NOT EXISTS transform_fn_sig TEXT;

COMMIT;
