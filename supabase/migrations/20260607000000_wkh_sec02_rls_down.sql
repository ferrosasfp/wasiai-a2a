-- WKH-SEC-02 down-migration — revierte RLS en las 7 tablas (AC-4).
-- DISABLE ROW LEVEL SECURITY es idempotente (re-aplicable sin error).
-- NOTA OPS (DT-6): este down NO pasa por `npm run migrate:preflight`. El
-- analizador estático marca DISABLE ROW LEVEL SECURITY como HIGH (correcto para
-- un DISABLE accidental en un up). Aquí es un DISABLE deliberado: se aplica
-- directo via Management API, igual que el up.
BEGIN;

ALTER TABLE public.a2a_agent_keys            DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.a2a_key_sessions          DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.a2a_delegations           DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.a2a_key_deposits          DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.a2a_receipts              DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.a2a_key_spend_policies    DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.a2a_key_dest_spend_ledger DISABLE ROW LEVEL SECURITY;

COMMIT;
