-- WKH-318 (W2 / corte A) — rollback: quitar `nextCursorPath` de
-- `schema->'discovery'` del registro `wasiai`.
--
-- Sin la clave, `queryRegistry` no tiene evidencia `cursor` y vuelve al
-- comportamiento del corte A sin migración (la heurística `page_full` sigue
-- funcionando: falla en la dirección segura, no en la de sobre-declarar
-- completitud).
--
-- ⚠️ UPDATE ADITIVO sobre `schema->'discovery'`. La columna `auth` NO se toca
-- (CD-17). Aplicar SOLO a bdwv.
UPDATE registries
SET schema = jsonb_set(
      schema,
      '{discovery}',
      (schema -> 'discovery') - 'nextCursorPath'
    )
WHERE id = 'wasiai'
  AND schema -> 'discovery' IS NOT NULL;
