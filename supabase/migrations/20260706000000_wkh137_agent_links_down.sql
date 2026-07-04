-- ============================================================
-- Down migration: 20260706000000_wkh137_agent_links
-- WKH-137: revierte los 2 RPC + la tabla de invocation links.
-- Las firmas de DROP FUNCTION llevan los tipos exactos (CD-11).
-- ============================================================

BEGIN;
DROP FUNCTION IF EXISTS settle_agent_link(uuid, text, text, text, numeric, text);
DROP FUNCTION IF EXISTS claim_agent_link(text);
DROP TABLE IF EXISTS a2a_agent_links;
COMMIT;
