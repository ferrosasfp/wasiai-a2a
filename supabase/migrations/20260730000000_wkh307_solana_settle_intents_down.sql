-- ============================================================
-- ROLLBACK WKH-307 (idempotencia durable del settle Solana): borra las 4 funciones y
-- los 2 indices, y **RENOMBRA la tabla en vez de borrarla** (ver abajo).
-- ============================================================
--
-- ⚠️ ORDEN DE ROLLBACK (GATE): ESTE DOWN SE APLICA **DESPUES** DE REVERTIR EL CODIGO —
-- el espejo del up.
--
-- CONSECUENCIA DEL ORDEN INVERSO (down primero, con el codigo de WKH-307 todavia vivo):
--   · El preflight de esquema deja de encontrar la funcion de reclamo y da veredicto
--     negativo ⟹ **el leg Solana deja de settlear**. Degradacion RUIDOSA, no doble pago:
--     es exactamente el fail-closed que la HU instala. Recuperable re-aplicando el up.
--   · Ningun settle Solana queda a medias por este orden: lo que no se reclama, no se
--     transmite.
--
-- ⚠️ LA TABLA **NO SE BORRA**, A PROPOSITO. `DROP TABLE` esta PROHIBIDO aca.
--
-- Es la UNICA evidencia persistida de a que agente se le pago, con que firma y por
-- cuanto. Borrarla destruiria exactamente el dato con el que se decide si un agente
-- cobro dos veces — y lo haria en el momento de maxima incertidumbre (un rollback).
-- Es el mismo criterio del `_down` de HU-202 con su columna.
--
-- Se renombra a `a2a_solana_settle_intents_backup_wkh307`: queda huerfana y sin
-- escritor (inofensiva), y un re-apply del up crea la tabla nueva vacia sin chocar.
-- Si se decide borrarla, que sea en una migracion PROPIA y DESPUES de haber
-- inventariado y reconciliado las filas de la query de abajo.
--
-- INVENTARIO OBLIGATORIO ANTES DE REVERTIR — cada fila que salga aca es un settle
-- cuyo resultado on-chain NO esta confirmado en la tabla, o sea plata posiblemente en
-- vuelo cuya evidencia esta por quedar fuera de linea:
--   SELECT intent_id, status, settle_signature, last_valid_block_height,
--          amount_atomic, pay_to, attempts, claimed_at, signed_at
--     FROM public.a2a_solana_settle_intents
--    WHERE status <> 'confirmed'
--    ORDER BY claimed_at;
--
-- Y las que necesitaron re-firma (colision de firma o blockhash expirado):
--   SELECT intent_id, attempts, expired_signatures
--     FROM public.a2a_solana_settle_intents
--    WHERE attempts > 1 OR cardinality(expired_signatures) > 0;
-- ============================================================

BEGIN;

-- ── Las 4 funciones ──
DROP FUNCTION IF EXISTS public.claim_solana_settle_intent(text, text, text, text, text, integer, boolean);
DROP FUNCTION IF EXISTS public.record_solana_settle_signed(text, text, text);
DROP FUNCTION IF EXISTS public.record_solana_settle_confirmed(text, text);
DROP FUNCTION IF EXISTS public.reclaim_solana_settle_intent(text, text);

-- ── Los 2 indices ──
-- (el UNIQUE parcial se va con ellos: sin codigo que escriba la tabla, no protege nada)
DROP INDEX IF EXISTS public.ux_a2a_solana_settle_intents_signature;
DROP INDEX IF EXISTS public.idx_a2a_solana_settle_intents_status_claimed_at;

-- ── La tabla: RENAME, NUNCA DROP ──
ALTER TABLE IF EXISTS public.a2a_solana_settle_intents
  RENAME TO a2a_solana_settle_intents_backup_wkh307;

COMMENT ON TABLE public.a2a_solana_settle_intents_backup_wkh307 IS
  'WKH-307 rollback: evidencia preservada de que se pago en Solana (a quien, con que firma, por cuanto). Huerfana y sin escritor. NO borrar sin inventariar antes las filas con status <> confirmed.';

NOTIFY pgrst, 'reload schema';

COMMIT;
