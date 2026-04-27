-- WKH-57 (DT-D): cache key fortalecido con schema fingerprint.
-- Aditiva — entradas legacy quedan stale (schema_hash IS NULL) y se ignoran al SELECT.

ALTER TABLE kite_schema_transforms
  ADD COLUMN IF NOT EXISTS schema_hash text;

-- Drop unique constraint actual (source, target) y reemplazar por triple.
-- IF EXISTS para que la migration sea idempotente (CD-13).
ALTER TABLE kite_schema_transforms
  DROP CONSTRAINT IF EXISTS kite_schema_transforms_source_agent_id_target_agent_id_key;

-- Postgres asigna nombres deterministas a constraints UNIQUE inline; el nombre
-- exacto puede variar según la versión de generación. Cubrir alias comunes:
ALTER TABLE kite_schema_transforms
  DROP CONSTRAINT IF EXISTS kite_schema_transforms_source_agent_id_target_agent_id_excl;

-- Crear nueva unique key 3-tupla. NULLS NOT DISTINCT para que entradas
-- legacy (schema_hash NULL) sigan siendo unique por par (source,target).
ALTER TABLE kite_schema_transforms
  ADD CONSTRAINT kite_schema_transforms_source_target_hash_key
  UNIQUE NULLS NOT DISTINCT (source_agent_id, target_agent_id, schema_hash);

CREATE INDEX IF NOT EXISTS idx_kite_schema_transforms_pair_hash
  ON kite_schema_transforms (source_agent_id, target_agent_id, schema_hash);
