BEGIN;
-- WKH-100 FIX v2 (MNR-2): a lo sumo UNA key activa puede reclamar un mismo
-- (token_id, chain_id) ERC-8004. Cierra la race del pre-check app-layer
-- (check-then-write en src/services/identity.ts:bindErc8004Identity): dos binds
-- concurrentes del mismo token a keys distintas podían pasar ambos el pre-check.
-- El código mapea 23505 -> Erc8004TokenAlreadyBoundError (identity.ts) como
-- defensa en profundidad sobre esta barrera atómica.
-- Aditivo + idempotente (IF NOT EXISTS). NO migra datos (AC-9/CD-9).
--
-- Doble funcion: (1) barrera atomica de unicidad token<->key activa (MNR-2);
-- (2) indice funcional que acelera el reverse-lookup por token_id/chain_id
-- (cubre TD-ERC8004-03 — resolucion por igualdad indexable, no full-table scan).
--
-- NOTA DEPLOY: si ya existen >=2 keys activas con el mismo token_id+chain_id
-- (race de v1), este CREATE falla. Verifica/limpia duplicados ANTES de aplicar:
--   SELECT erc8004_identity->>'token_id', erc8004_identity->>'chain_id', count(*)
--   FROM a2a_agent_keys WHERE is_active AND erc8004_identity IS NOT NULL
--   GROUP BY 1,2 HAVING count(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS uq_a2a_agent_keys_erc8004_token
  ON a2a_agent_keys (
    (erc8004_identity->>'token_id'),
    (erc8004_identity->>'chain_id')
  )
  WHERE is_active AND erc8004_identity IS NOT NULL;
COMMIT;
