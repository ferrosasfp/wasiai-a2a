-- WKH-123 KEY-SIGNED-AUTH: auth por firma opt-in (EIP-712 master + HMAC-SHA256 session)
-- Aditiva y reversible. Filas existentes quedan require_signature=false (= bearer, back-compat).

-- 1. Flag opt-in en master keys
ALTER TABLE a2a_agent_keys
  ADD COLUMN IF NOT EXISTS require_signature BOOLEAN NOT NULL DEFAULT false;

-- 2. Flag opt-in + secret hash en session keys
ALTER TABLE a2a_key_sessions
  ADD COLUMN IF NOT EXISTS require_signature BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE a2a_key_sessions
  ADD COLUMN IF NOT EXISTS signing_secret_hash TEXT;   -- NULL = sin secret (HMAC no disponible)

-- 3. Anti-replay: nonces vistos por token, con TTL. UNIQUE(token_hash, nonce) = garantía atómica.
CREATE TABLE IF NOT EXISTS a2a_signed_auth_nonces (
  token_hash  TEXT        NOT NULL,
  nonce       TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_signed_auth_nonce UNIQUE (token_hash, nonce)
);

-- Índice para housekeeping/limpieza de filas expiradas (no requiere job en MVP).
CREATE INDEX IF NOT EXISTS idx_signed_auth_nonces_expires
  ON a2a_signed_auth_nonces (expires_at);
