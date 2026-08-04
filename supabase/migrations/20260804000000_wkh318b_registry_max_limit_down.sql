-- WKH-318 (W2 / corte B) — rollback: quitar `maxLimit` del registro `wasiai`.
-- NO aplicar: la aplica el founder (accion gated, classifier)
--
-- Sin la clave en `schema->'discovery'`, `clampToRegistryMaxLimit` no encuentra
-- techo usable y no clampea nada: el límite enviado vuelve a ser el over-fetch
-- pelado, exactamente el comportamiento anterior al corte B. O sea que este
-- rollback devuelve también el 400 del registro y la fuente vuelve a caer.
--
-- ⚠️ ESTO NO ES EL INVERSO EXACTO DEL `_up` (AR MNR-3). El `_up`
-- SOBREESCRIBE; esto BORRA la clave. Si la fila tenía un `maxLimit` propio
-- antes del `_up`, correr esto lo pierde. El `_up` documenta el `SELECT` de
-- pre-estado que hay que haber guardado; con un valor previo anotado, el
-- rollback fiel es reescribirlo con `jsonb_set`, no correr este archivo.
--
-- ⚠️ UPDATE ADITIVO sobre `schema->'discovery'`. La columna `auth` NO se toca
-- (CD-17). Aplicar SOLO a bdwv. Nunca a caldz: caldz es archivo mainnet.
UPDATE registries
SET schema = jsonb_set(
      schema,
      '{discovery}',
      (schema -> 'discovery') - 'maxLimit'
    )
WHERE id = 'wasiai'
  AND schema -> 'discovery' IS NOT NULL;
