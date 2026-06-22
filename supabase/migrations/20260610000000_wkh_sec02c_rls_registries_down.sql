-- WKH-SEC-02c down-migration — revierte RLS en las 2 tablas (AC-3).
-- DISABLE ROW LEVEL SECURITY es idempotente (re-aplicable sin error).
-- NOTA OPS (DT-6): este down NO pasa por `npm run migrate:preflight`. El
-- analizador estático marca DISABLE ROW LEVEL SECURITY como HIGH (correcto para
-- un DISABLE accidental en un up). Aquí es un DISABLE deliberado: se aplica
-- directo via Management API, igual que el up.
BEGIN;

ALTER TABLE public.registries             DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.kite_schema_transforms DISABLE ROW LEVEL SECURITY;

COMMIT;
