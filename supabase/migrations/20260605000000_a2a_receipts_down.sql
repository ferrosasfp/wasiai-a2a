-- WKH-124 down-migration
DROP FUNCTION IF EXISTS insert_receipt(text, uuid, uuid, uuid, text, numeric, integer, text, text, text);
DROP TABLE IF EXISTS a2a_receipts;
