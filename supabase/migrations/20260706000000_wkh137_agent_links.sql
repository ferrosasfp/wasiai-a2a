-- ============================================================
-- Migration: 20260706000000_wkh137_agent_links
-- WKH-137: Invocation Links (mint + redeem). Token opaco single-use,
-- price-capped, atado a un agente-target + al owner_ref/key del minter.
--
-- Aditiva 100%. NO toca compose / orchestrate / agent-price. Crea:
--   - Tabla a2a_agent_links (estado del link; persiste SOLO SHA-256(token)).
--   - 2 RPC atómicos (FOR UPDATE + status-gate + Ownership Guard DB-level):
--       claim_agent_link  (open→redeeming, single-use, cero doble-redeem).
--       settle_agent_link (redeeming→redeemed|failed|open exactly-once).
--   - RLS deny-by-default (service_role bypassa por BYPASSRLS).
--   - Trigger updated_at (trigger_set_updated_at, mismo que a2a_payment_intents).
--
-- Patrones: 20260704000000_wkh135_payment_intents.sql (RPC FOR UPDATE + owner
-- guard + status-gate + hardening search_path/REVOKE/GRANT).
-- ============================================================

-- ── Tabla a2a_agent_links ───────────────────────────────────
CREATE TABLE IF NOT EXISTS a2a_agent_links (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash         TEXT NOT NULL UNIQUE,             -- SHA-256(token); UNIQUE = btree O(1) (CD-12)
  owner_ref          TEXT NOT NULL,                    -- Ownership Guard (CD-2)
  key_id             UUID NOT NULL REFERENCES a2a_agent_keys(id) ON DELETE CASCADE,
  slug               TEXT NOT NULL,                    -- agente-target (del path, NUNCA del request)
  registry           TEXT,                             -- nullable (hint opcional)
  max_price_usdc     NUMERIC(20,8) NOT NULL CHECK (max_price_usdc >= 0),  -- cap server-side (CD-3)
  chain_id           INT  NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','redeeming','redeemed','failed')),
  redeemed_at        TIMESTAMPTZ,
  settle_tx_hash     TEXT,
  consumed_cost_usdc NUMERIC(20,8),
  expires_at         TIMESTAMPTZ NOT NULL,
  error_message      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_a2a_agent_links_key_owner ON a2a_agent_links (key_id, owner_ref);
CREATE INDEX IF NOT EXISTS idx_a2a_agent_links_owner     ON a2a_agent_links (owner_ref);
CREATE INDEX IF NOT EXISTS idx_a2a_agent_links_status    ON a2a_agent_links (status);

-- ── RLS deny-by-default (patrón WKH-SEC-02, SIN policy permisiva) ──
-- service_role bypassa por BYPASSRLS; anon/authenticated → deny-all.
ALTER TABLE a2a_agent_links ENABLE ROW LEVEL SECURITY;

-- ── updated_at trigger (reusa trigger_set_updated_at, igual que a2a_payment_intents) ──
DROP TRIGGER IF EXISTS set_a2a_agent_links_updated_at ON a2a_agent_links;
CREATE TRIGGER set_a2a_agent_links_updated_at
  BEFORE UPDATE ON a2a_agent_links
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ============================================================
-- RPC 1: claim_agent_link
-- Transición atómica open→redeeming bajo FOR UPDATE (single-use, CD-4). N redeems
-- concurrentes: solo el primero gana el lock con status='open' y lo transiciona;
-- los demás pierden el lock-race, releen status<>'open' → LINK_ALREADY_USED.
-- Cero doble-redeem / doble-cobro garantizado por el lock + status-gate.
-- ============================================================
CREATE OR REPLACE FUNCTION claim_agent_link(
  p_token_hash TEXT
) RETURNS TABLE(
  id             UUID,
  owner_ref      TEXT,
  key_id         UUID,
  slug           TEXT,
  registry       TEXT,
  max_price_usdc NUMERIC,
  chain_id       INT
) AS $$
DECLARE
  v_id       UUID;
  v_owner    TEXT;
  v_key      UUID;
  v_slug     TEXT;
  v_registry TEXT;
  v_max      NUMERIC;
  v_chain    INT;
  v_status   TEXT;
  v_expires  TIMESTAMPTZ;
BEGIN
  SELECT l.id, l.owner_ref, l.key_id, l.slug, l.registry, l.max_price_usdc,
         l.chain_id, l.status, l.expires_at
    INTO v_id, v_owner, v_key, v_slug, v_registry, v_max,
         v_chain, v_status, v_expires
    FROM a2a_agent_links l
    WHERE l.token_hash = p_token_hash
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LINK_NOT_FOUND: %', p_token_hash;
  END IF;

  -- open + expirado → LINK_EXPIRED (no consume).
  IF v_status = 'open' AND NOW() >= v_expires THEN
    RAISE EXCEPTION 'LINK_EXPIRED';
  END IF;

  -- ya en uso / terminal (incluye el 2º redeem concurrente que perdió el lock).
  IF v_status IN ('redeeming','redeemed','failed') THEN
    RAISE EXCEPTION 'LINK_ALREADY_USED';
  END IF;

  -- open + no expirado → claim (open→redeeming).
  UPDATE a2a_agent_links SET status = 'redeeming' WHERE a2a_agent_links.id = v_id;

  id             := v_id;
  owner_ref      := v_owner;
  key_id         := v_key;
  slug           := v_slug;
  registry       := v_registry;
  max_price_usdc := v_max;
  chain_id       := v_chain;
  RETURN NEXT;
  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.claim_agent_link(text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.claim_agent_link(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_agent_link(text)
  TO service_role;

-- ============================================================
-- RPC 2: settle_agent_link
-- Cierre exactly-once de un link 'redeeming' (idempotente + Ownership Guard).
--   p_outcome = 'redeemed' → status=redeemed + redeemed_at + tx_hash + cost.
--   p_outcome = 'reopen'   → status=open (SOLO tras __quoteStale, cero débito).
--   p_outcome = <otro>     → status=failed + error_message (terminal, NO reabrir; CD-8).
-- El status-gate (IF v_status <> 'redeeming' THEN RETURN) da idempotencia: un
-- segundo settle sobre un link ya terminal es no-op → cero doble-escritura.
-- ============================================================
CREATE OR REPLACE FUNCTION settle_agent_link(
  p_id        UUID,
  p_owner_ref TEXT,
  p_outcome   TEXT,
  p_tx_hash   TEXT,
  p_cost      NUMERIC,
  p_error     TEXT
) RETURNS void AS $$
DECLARE
  v_owner  TEXT;
  v_status TEXT;
BEGIN
  SELECT owner_ref, status
    INTO v_owner, v_status
    FROM a2a_agent_links
    WHERE id = p_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LINK_NOT_FOUND: %', p_id;
  END IF;
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: link % not owned by caller', p_id;
  END IF;

  -- Idempotencia exactly-once: solo se cierra una transición 'redeeming'.
  IF v_status <> 'redeeming' THEN
    RETURN;
  END IF;

  IF p_outcome = 'redeemed' THEN
    UPDATE a2a_agent_links
      SET status = 'redeemed', redeemed_at = now(),
          settle_tx_hash = p_tx_hash, consumed_cost_usdc = p_cost
      WHERE id = p_id;
  ELSIF p_outcome = 'reopen' THEN
    -- SOLO tras __quoteStale (cero débito garantizado por el cap-gate del execute).
    UPDATE a2a_agent_links SET status = 'open' WHERE id = p_id;
  ELSE
    -- failed / débito ambiguo: terminal, NO reabrir (CD-8).
    UPDATE a2a_agent_links
      SET status = 'failed', error_message = p_error
      WHERE id = p_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.settle_agent_link(uuid, text, text, text, numeric, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.settle_agent_link(uuid, text, text, text, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_agent_link(uuid, text, text, text, numeric, text)
  TO service_role;
