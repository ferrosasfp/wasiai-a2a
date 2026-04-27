-- WKH security hot-fix (2026-04-27)
-- Mitigation parcial de BLQ-ALTO-3: schema hijacking en RPCs SECURITY DEFINER
-- + prevenir invocación desde anon/authenticated roles via PostgREST.
-- (Mitigation completa requiere agregar p_owner_ref + auth check dentro de cada función.)

BEGIN;

ALTER FUNCTION public.increment_a2a_key_spend(uuid, integer, numeric)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.register_a2a_key_deposit(uuid, integer, numeric)
  SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.increment_a2a_key_spend(uuid, integer, numeric)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.register_a2a_key_deposit(uuid, integer, numeric)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.increment_a2a_key_spend(uuid, integer, numeric)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.register_a2a_key_deposit(uuid, integer, numeric)
  TO service_role;

COMMIT;
