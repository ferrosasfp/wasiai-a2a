-- WKH-SEC-02c (2026-06-22) — RLS defensa en profundidad (DT-1, DT-2, DT-4).
-- Spinoff de WKH-SEC-02: habilita ROW LEVEL SECURITY en las 2 tablas con
-- owner_ref que quedaron fuera de ese scope (registries, kite_schema_transforms).
-- Sin FORCE (DT-4): service_role bypassa por BYPASSRLS; FORCE solo afecta al
-- table owner, no a service_role. Sin policy permisiva (DT-1): ENABLE sin
-- policy => deny-all para anon/authenticated (deny-by-default), service_role
-- bypassa nativamente. ENABLE es idempotente (re-aplicable sin error, AC-6).
BEGIN;

ALTER TABLE public.registries             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kite_schema_transforms ENABLE ROW LEVEL SECURITY;

COMMIT;
