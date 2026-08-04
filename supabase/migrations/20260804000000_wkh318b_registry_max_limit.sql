-- WKH-318 (W2 / corte B) — declarar el techo de `limit` del registro `wasiai`.
-- NO aplicar: la aplica el founder (accion gated, classifier)
--
-- Con la clave puesta, `queryRegistry` envía `min(over-fetch, maxLimit)` en vez
-- del over-fetch pelado, y deja de pedirle al registro más de lo que acepta.
--
-- De dónde sale el 100 (AR MNR-1 — el origen importa, así que va escrito):
-- medido 2026-08-04 contra `https://wasiai-v2.vercel.app/api/v1/capabilities`,
-- SIN auth: `?limit=100` responde 200 y `?limit=101` responde 400. El
-- `discovery_endpoint` que esta fila tiene sembrado es OTRO host
-- (`https://app.wasiai.io/api/v1/capabilities`, ver
-- `20260401000000_kite_registries.sql:41`), y sin auth ese host NO se comporta
-- igual (`?limit=200` devuelve 200 con el payload del proxy). Los dos son el
-- mismo deploy de `wasiai-v2`, pero eso es una inferencia, no una medición.
-- Verificar el techo contra `app.wasiai.io` CON la credencial de la fila queda
-- para F4; si ahí el techo resultara distinto de 100, este número se corrige
-- acá y no hay que tocar una sola línea de código (el clamp lee la fila).
--
-- El over-fetch por defecto es 200, así que hoy toda consulta federada con
-- `limit` del caller choca contra ese 400, y ese 400 tumba la fuente entera.
--
-- Sin esta clave el clamp del corte B existe pero no se activa: el límite que
-- sale por la red queda byte-idéntico al de antes.
--
-- ⚠️ ANTES DE APLICAR, guardar el pre-estado (AR MNR-3). Este `UPDATE`
-- SOBREESCRIBE `maxLimit` si la fila ya tenía uno propio — alcanzable vía
-- `PATCH /registries/:id`, que guarda `schema` sin validar — y el `_down`
-- **borra** la clave en vez de restaurar el valor viejo. O sea: el par up/down
-- NO es reversible si había un valor previo. El `SELECT` de abajo es lo que
-- hace que lo sea:
--
--   SELECT id, schema -> 'discovery' -> 'maxLimit' AS pre_max_limit
--   FROM registries WHERE id = 'wasiai';
--
-- · devuelve NULL (o ninguna fila) ⇒ el `_down` alcanza como rollback.
-- · devuelve un valor ⇒ anotarlo: el rollback fiel es reescribir ESE valor con
--   el mismo `jsonb_set`, no correr el `_down`.
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
