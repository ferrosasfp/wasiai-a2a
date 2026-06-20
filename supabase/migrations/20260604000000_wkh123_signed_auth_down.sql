-- WKH-123 down-migration
DROP TABLE IF EXISTS a2a_signed_auth_nonces;

ALTER TABLE a2a_key_sessions DROP COLUMN IF EXISTS signing_secret_hash;
ALTER TABLE a2a_key_sessions DROP COLUMN IF EXISTS require_signature;
ALTER TABLE a2a_agent_keys   DROP COLUMN IF EXISTS require_signature;
