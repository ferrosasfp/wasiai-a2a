-- WKH-318 (W2 / corte A): declarar dónde vive el cursor de paginación del
-- registro `wasiai`, para poder DETECTAR truncamiento. No se pagina (TD-318-2).
--
-- Medido 2026-07-30: la tabla `agents` de wasiai-v2 tiene 22 activos y el camino
-- sin `limit` devuelve 20 con `next_cursor` seteado. Sin esta clave, /discover
-- seguiría afirmando completitud sobre una página truncada.
--
-- ⚠️ UPDATE ADITIVO sobre `schema->'discovery'`. La columna `auth` NO se toca
-- (CD-17): borrar esa credencial reabre la recursión a2a → v2 → a2a.
-- Aplicar SOLO a bdwv.
UPDATE registries
SET schema = jsonb_set(
      schema,
      '{discovery,nextCursorPath}',
      '"next_cursor"'::jsonb,
      true
    )
WHERE id = 'wasiai'
  AND schema -> 'discovery' IS NOT NULL;
