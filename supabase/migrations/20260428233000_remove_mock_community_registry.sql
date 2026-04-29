-- ============================================================
-- Migration: 20260428233000_remove_mock_community_registry
-- TD-LIGHT post WKH-65/66: cleanup post-deploy del seed `mock-community`.
--
-- El registry `mock-community` se creó vía 20260404000000_mock_community_registry
-- como demo multi-registry para el hackathon. Su `discovery_endpoint` apunta a
-- `http://localhost:3001/mock-registry/agents`, que NO funciona en producción
-- (Railway). Para evitar que `/discover` consulte un endpoint roto, lo
-- removemos definitivamente.
--
-- Idempotente: usa DELETE WHERE id = ... — no falla si la fila ya no existe.
-- Re-runnable contra cualquier ambiente (staging/prod).
-- ============================================================

DELETE FROM registries WHERE id = 'mock-community';

-- Verificación (no-op si está borrado)
DO $$
DECLARE
  remaining INT;
BEGIN
  SELECT COUNT(*) INTO remaining FROM registries WHERE id = 'mock-community';
  IF remaining > 0 THEN
    RAISE EXCEPTION 'mock-community registry still present after DELETE — investigate FKs';
  END IF;
END $$;
