-- ============================================================
-- ROLLBACK WKH-314 (uso unico de las pruebas de pago inbound Solana): borra las 3
-- funciones y el indice, y **RENOMBRA la tabla en vez de borrarla** (ver abajo).
-- ============================================================
--
-- ⚠️ ORDEN DE ROLLBACK (GATE): ESTE DOWN SE APLICA **DESPUES** DE REVERTIR EL CODIGO —
-- el espejo del up.
--
-- CONSECUENCIA DEL ORDEN INVERSO (down primero, con el codigo de WKH-314 todavia vivo):
--   · El preflight inbound deja de encontrar la funcion de peek y da veredicto
--     negativo ⟹ **el cobro Solana deja de verificar**: sigue saliendo el rechazo.
--     Degradacion RUIDOSA, no servicio gratis: es el fail-closed que la HU instala.
--     Recuperable re-aplicando el up.
--   · Ningun pago queda a medias por este orden: lo que no se consume, no se sirve.
--
-- ⚠️ LA TABLA **NO SE BORRA**, A PROPOSITO. `DROP TABLE` esta PROHIBIDO aca.
--
-- Es la UNICA evidencia persistida de que firma compro que servicio y cuando. Y no es
-- solo evidencia: borrarla vuelve GASTABLE cada firma ya cobrada. Es exactamente el
-- dato con el que se decide si a alguien ya se le sirvio — y borrarlo en el momento de
-- maxima incertidumbre (un rollback) es regalar el servicio a todo el que guarde sus
-- firmas viejas. Mismo criterio que el `_down` de WKH-307.
--
-- Se renombra a `a2a_solana_inbound_proofs_backup_wkh314`: queda huerfana y sin
-- escritor (inofensiva), y un re-apply del up NO puede pisarla — el bloque (0) del up
-- ABORTA si el backup conserva filas `consumed` sin re-hidratar.
--
-- INVENTARIO OBLIGATORIO ANTES DE REVERTIR — cada fila `consumed` que salga aca es un
-- servicio ya vendido cuya prueba esta por quedar fuera de linea:
--   SELECT caip2, signature, resource, amount_atomic, pay_to, consumed_at
--     FROM public.a2a_solana_inbound_proofs
--    WHERE status = 'consumed'
--    ORDER BY consumed_at DESC;
--
-- Y las observadas sin cobrar (pagos que la cadena avalo y nadie reclamo):
--   SELECT caip2, signature, resource, amount_atomic, attempts, observed_at
--     FROM public.a2a_solana_inbound_proofs
--    WHERE status = 'observed'
--    ORDER BY observed_at;
-- ============================================================

BEGIN;

-- ── Las 3 funciones ──
DROP FUNCTION IF EXISTS public.record_solana_inbound_observed(text, text, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.consume_solana_inbound_proof(text, text, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.peek_solana_inbound_proof(text, text, boolean);

-- ── El indice del inventario ──
-- (sin codigo que escriba la tabla, no hay inventario que servir)
DROP INDEX IF EXISTS public.idx_a2a_solana_inbound_proofs_status_observed_at;

-- ── La tabla: RENAME, NUNCA DROP ──
ALTER TABLE IF EXISTS public.a2a_solana_inbound_proofs
  RENAME TO a2a_solana_inbound_proofs_backup_wkh314;

COMMENT ON TABLE public.a2a_solana_inbound_proofs_backup_wkh314 IS
  'WKH-314 (rollback): copia huerfana y sin escritor de a2a_solana_inbound_proofs. NO BORRAR sin inventariar: cada fila `consumed` es una firma que YA compro servicio, y perderla la vuelve gastable otra vez. El up de WKH-314 ABORTA si esta tabla conserva filas `consumed` (gate de re-hidratacion).';

COMMIT;
