-- WKH-127 down: la RPC es 100% aditiva (no reemplaza ninguna función previa),
-- por lo que el rollback es un simple DROP. Reversibilidad total (sin overloads
-- huérfanos, ref auto-blindaje WKH-125 BLQ-MED-1).
DROP FUNCTION IF EXISTS refund_a2a_key_spend(uuid, integer, numeric, text);
