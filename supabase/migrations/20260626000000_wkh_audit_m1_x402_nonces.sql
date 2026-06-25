-- ============================================================
-- Migration: 20260626000000_wkh_audit_m1_x402_nonces
-- Auditoría 2026-06-24 — item M1 (seguridad, defensa en profundidad).
--
-- PROBLEMA: el x402 INBOUND propio (src/middleware/x402.ts) delega el anti-replay
-- 100% al facilitator externo. Depósitos (UNIQUE(chain_id, tx_hash)) y signed-auth
-- (UNIQUE(token_hash, nonce)) SÍ tienen anti-replay local; el x402 inbound no.
--
-- FIX: tabla de nonces vistos por (network, nonce). El UNIQUE garantiza atomicidad:
-- un INSERT que choca con 23505 = replay. Espeja a2a_signed_auth_nonces. Es defensa
-- en profundidad SOBRE el nonce on-chain EIP-3009 (el authorization.nonce ya es
-- single-use a nivel token), por eso el fail-open ante DB-down es aceptable (ver
-- middleware) — esta tabla nunca es la única línea de defensa del replay.
--
-- RLS: ENABLE sin policy (deny-by-default para anon/authenticated). El service usa
-- SERVICE_ROLE (BYPASSRLS), igual que el resto de tablas (WKH-SEC-02, 20260607).
-- Aditiva y reversible.
-- ============================================================

CREATE TABLE IF NOT EXISTS a2a_x402_nonces (
  network     TEXT        NOT NULL,
  nonce       TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_x402_nonce UNIQUE (network, nonce)
);

-- WKH-SEC-02 (defensa en profundidad): deny-by-default para anon/authenticated.
-- service_role bypassa nativamente (BYPASSRLS). ENABLE es idempotente.
ALTER TABLE public.a2a_x402_nonces ENABLE ROW LEVEL SECURITY;
