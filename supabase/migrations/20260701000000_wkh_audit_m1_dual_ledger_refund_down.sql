-- Down: 20260701000000_wkh_audit_m1_dual_ledger_refund
-- Dropea los dos RPCs de refund dual-ledger. Revertir esto reintroduce el
-- leak contable de M1 (refund single-ledger que no decrementa
-- total_spent/spent_usd) — sólo para rollback de emergencia.
DROP FUNCTION IF EXISTS refund_delegation_and_parent(uuid, text, uuid, integer, numeric, text);
DROP FUNCTION IF EXISTS refund_session_and_parent(uuid, text, uuid, integer, numeric, text);
