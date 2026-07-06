-- ============================================================
-- Down migration: 20260708000000_wkh115_inbound_tasks
-- WKH-115: revierte la tabla de inbound tasks.
-- ============================================================

BEGIN;
DROP TABLE IF EXISTS a2a_inbound_tasks CASCADE;
COMMIT;
