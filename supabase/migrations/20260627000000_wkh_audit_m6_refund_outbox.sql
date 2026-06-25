-- ============================================================
-- Migration: 20260627000000_wkh_audit_m6_refund_outbox
-- Auditoría 2026-06-24 — item M6 (confiabilidad: refunds best-effort fallidos).
--
-- PROBLEMA: cuando un refund best-effort falla (orchestrate.ts:662 credit, el
-- refund per-step de compose.ts y el refund post-compose de routes/compose.ts),
-- HOY solo se loguea `refundError` y la plata del caller queda sin devolver.
--
-- FIX: outbox de reintento. Cuando un refund retorna `reverted:false` /
-- `success:false` (NO aplicó NADA) o tira excepción, el call-site encola una
-- fila en a2a_refund_outbox. Un sweep periódico reclama N pending (claim atómico)
-- y reintenta el credit. Done si revierte; attempts++ y dead tras N intentos.
--
-- INVARIANTE ANTI-DOBLE-REFUND: solo se encola cuando NADA se aplicó (apoyado en
-- el check de filas de A2: credit/creditWithDest devuelven reverted:false con 0
-- filas). Reintentar un refund que no ocurrió es idempotente: si el retry ahora
-- afecta >=1 fila → reverted:true → done. Un refund que SÍ aplicó nunca se encola.
--
-- RLS: ENABLE sin policy (deny-by-default para anon/authenticated). El service usa
-- SERVICE_ROLE (BYPASSRLS), igual que el resto de tablas (WKH-SEC-02, 20260607).
-- Aditiva y reversible.
-- ============================================================

CREATE TABLE IF NOT EXISTS a2a_refund_outbox (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id       UUID        NOT NULL,
  chain_id     INT         NOT NULL,
  amount_usd   NUMERIC     NOT NULL,
  owner_ref    TEXT        NOT NULL,
  destination  TEXT,
  reason       TEXT        NOT NULL,
  attempts     INT         NOT NULL DEFAULT 0,
  status       TEXT        NOT NULL DEFAULT 'pending',
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_refund_outbox_status
    CHECK (status IN ('pending', 'processing', 'done', 'dead'))
);

-- Index para el sweep: reclama por status (pending → processing) y ordena por
-- antigüedad para fairness.
CREATE INDEX IF NOT EXISTS idx_refund_outbox_status_created
  ON a2a_refund_outbox (status, created_at);

-- WKH-SEC-02 (defensa en profundidad): deny-by-default para anon/authenticated.
-- service_role bypassa nativamente (BYPASSRLS). ENABLE es idempotente.
ALTER TABLE public.a2a_refund_outbox ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- RPC: claim_refund_outbox(p_limit)
-- Claim atómico de N entries pending → processing. FOR UPDATE SKIP LOCKED para
-- que dos instancias/sweeps concurrentes NUNCA reclamen la misma fila (cada una
-- ve un conjunto disjunto). Devuelve las filas reclamadas para que el service
-- las reintente. El UPDATE marca processing + bump de updated_at en una sola
-- transacción atómica con el SELECT FOR UPDATE.
-- ============================================================
CREATE OR REPLACE FUNCTION claim_refund_outbox(p_limit INT)
RETURNS SETOF a2a_refund_outbox AS $$
BEGIN
  RETURN QUERY
  UPDATE a2a_refund_outbox o
  SET status = 'processing', updated_at = now()
  WHERE o.id IN (
    SELECT c.id
    FROM a2a_refund_outbox c
    WHERE c.status = 'pending'
    ORDER BY c.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(p_limit, 0)
  )
  RETURNING o.*;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Hardening (consistente con los RPCs hermanos, 20260609000000:95-101).
ALTER FUNCTION public.claim_refund_outbox(integer)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.claim_refund_outbox(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_refund_outbox(integer)
  TO service_role;
