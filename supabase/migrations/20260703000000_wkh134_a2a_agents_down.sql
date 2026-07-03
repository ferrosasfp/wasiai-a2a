-- WKH-134 down-migration — revierte la tabla a2a_agents (reversible).
-- DROP TABLE IF EXISTS es idempotente (re-aplicable sin error). Al dropear la
-- tabla se eliminan sus índices y el estado RLS asociado.
BEGIN;

DROP TABLE IF EXISTS public.a2a_agents;

COMMIT;
