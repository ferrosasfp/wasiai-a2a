-- WKH-318 (W2 / corte B) — declarar el techo de `limit` del registro `wasiai`.
-- NO aplicar: la aplica el founder (accion gated, classifier)
--
-- Con la clave puesta, `queryRegistry` envía `min(over-fetch, maxLimit)` en vez
-- del over-fetch pelado, y deja de pedirle al registro más de lo que acepta.
--
-- Medido 2026-08-04: `GET /api/v1/capabilities?limit=100` responde 200 y
-- `?limit=101` responde 400. El over-fetch por defecto es 200, así que hoy toda
-- consulta federada con `limit` del caller choca contra ese 400, y ese 400 tumba
-- la fuente entera.
--
-- Sin esta clave el clamp del corte B existe pero no se activa: el límite que
-- sale por la red queda byte-idéntico al de antes.
--
-- ⚠️ UPDATE ADITIVO sobre `schema->'discovery'`. La columna `auth` NO se toca
-- (CD-17): borrar esa credencial reabre la recursión a2a → v2 → a2a.
-- Aplicar SOLO a bdwv. Nunca a caldz: caldz es archivo mainnet.
UPDATE registries
SET schema = jsonb_set(
      schema,
      '{discovery,maxLimit}',
      '100'::jsonb,
      true
    )
WHERE id = 'wasiai'
  AND schema -> 'discovery' IS NOT NULL;
