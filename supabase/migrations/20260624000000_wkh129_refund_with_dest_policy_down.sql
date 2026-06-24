-- WKH-129 down: la RPC es 100% aditiva (función NUEVA, no reemplaza ninguna previa),
-- por lo que el rollback es un simple DROP por firma exacta. Reversibilidad total
-- (sin overloads huérfanos — ref auto-blindaje WKH-125 BLQ-MED-1).
DROP FUNCTION IF EXISTS refund_with_dest_policy(uuid, integer, numeric, text, text);
