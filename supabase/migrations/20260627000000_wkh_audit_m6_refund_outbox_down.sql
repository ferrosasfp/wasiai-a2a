-- ============================================================
-- DOWN: 20260627000000_wkh_audit_m6_refund_outbox
-- ============================================================
DROP FUNCTION IF EXISTS public.claim_refund_outbox(integer);
DROP TABLE IF EXISTS a2a_refund_outbox;
