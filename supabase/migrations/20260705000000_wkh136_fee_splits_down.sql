-- WKH-136 down-migration — revierte a2a_fee_splits + columnas de a2a_agents.
-- DROP TABLE / DROP COLUMN IF EXISTS son idempotentes (re-aplicables sin error).
-- Al dropear la tabla se eliminan sus índices, trigger y estado RLS asociado.
BEGIN;

DROP TABLE IF EXISTS public.a2a_fee_splits;

ALTER TABLE public.a2a_agents
  DROP COLUMN IF EXISTS payout_wallet,
  DROP COLUMN IF EXISTS referrer_ref;

COMMIT;
