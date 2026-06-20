-- WKH-SEC-02 (2026-06-20) — RLS defensa en profundidad (DT-1, DT-4).
-- Habilita ROW LEVEL SECURITY en las 7 tablas con owner_ref.
-- Sin FORCE (DT-4): service_role bypassa por BYPASSRLS; FORCE solo afecta al
-- table owner, no a service_role. Sin policy permisiva (DT-1): ENABLE sin
-- policy => deny-all para anon/authenticated (deny-by-default), service_role
-- bypassa nativamente. ENABLE es idempotente (re-aplicable sin error, AC-6).
BEGIN;

ALTER TABLE public.a2a_agent_keys            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.a2a_key_sessions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.a2a_delegations           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.a2a_key_deposits          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.a2a_receipts              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.a2a_key_spend_policies    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.a2a_key_dest_spend_ledger ENABLE ROW LEVEL SECURITY;

COMMIT;
