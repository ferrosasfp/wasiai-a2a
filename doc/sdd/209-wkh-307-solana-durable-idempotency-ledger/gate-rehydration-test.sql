-- ============================================================
-- WKH-307 — PRUEBA DEL GATE DE RE-HIDRATACION (rama POSITIVA)
--
-- ⚠️⚠️ NO CORRER CONTRA bdwv NI CONTRA caldz. ⚠️⚠️
--
-- Este guion CREA `public.a2a_solana_settle_intents_backup_wkh307`. Si quedara creada
-- en una base real, el gate de la migracion la detectaria y **abortaria todo apply
-- futuro** — o sea que probar el candado rompe el camino que el candado protege.
--
-- Destino correcto: una base DESCARTABLE (Postgres local en docker, o un proyecto
-- Supabase de usar y tirar). Ver el bloque "COMO CORRERLO" al final.
-- ============================================================
--
-- ── QUE SE PRUEBA, Y POR QUE NO ESTA PROBADO TODAVIA ──────────────────────
--
-- El bloque `DO $wkh307$` de `20260730000000_wkh307_solana_settle_intents.sql` es el
-- unico codigo EJECUTABLE de la migracion que nunca corrio contra Postgres:
--
--   · los 31 tests de `test/wkh307-solana-settle-intents.migration.test.ts` PARSEAN el
--     `.sql` y afirman sobre su texto;
--   · `scripts/exercise-wkh307-functions.mjs` ejercita las 4 FUNCIONES, no el gate;
--   · aplicar la migracion sobre una base sin backup ejercita solo su rama NEGATIVA
--     (`to_regclass(...) IS NULL` ⟹ no hace nada).
--
-- La rama que importa —backup presente CON filas sin confirmar ⟹ `RAISE`— no se
-- ejecuto nunca. Y es la que existe para el peor momento posible: un rollback seguido
-- de una restauracion, donde re-aplicar el `up` sobre una tabla vacia deja **sin dedup
-- a todo intent en vuelo** y el siguiente retry re-paga.
--
-- ============================================================

-- ─────────────────────────────────────────────────────────────────────────
-- CASO 1 · backup CON filas en vuelo ⟹ el gate DEBE abortar
-- ─────────────────────────────────────────────────────────────────────────
BEGIN;

CREATE TABLE public.a2a_solana_settle_intents_backup_wkh307 (
  intent_id                TEXT PRIMARY KEY,
  status                   TEXT NOT NULL,
  settle_signature         TEXT NULL,
  last_valid_block_height  BIGINT NULL,
  expired_signatures       TEXT[] NOT NULL DEFAULT '{}',
  attempts                 INTEGER NOT NULL DEFAULT 1,
  claimed_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Una fila TERMINAL (no debe bloquear) y dos EN VUELO (deben bloquear).
INSERT INTO public.a2a_solana_settle_intents_backup_wkh307 (intent_id, status) VALUES
  ('gate-test:confirmed', 'confirmed'),
  ('gate-test:claimed',   'claimed'),
  ('gate-test:signed',    'signed');

-- ⬇⬇ PEGAR ACA EL BLOQUE `DO $wkh307$ ... $wkh307$;` VERBATIM DE LA MIGRACION ⬇⬇
-- (no se copia en este archivo a proposito: copiarlo lo volveria una re-implementacion,
--  y lo que hay que probar es EL bloque que se deploya, no una version parecida)
--
-- RESULTADO ESPERADO: ERROR  P0001  WKH307_BACKUP_NOT_REHYDRATED: 2 in-flight rows ...
--   · si NO aborta            ⟹ HALLAZGO: el gate no protege nada.
--   · si aborta diciendo 3    ⟹ HALLAZGO: cuenta las `confirmed`, que son terminales
--                                y no necesitan re-hidratarse (bloquearia de mas).

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────
-- CASO 2 · backup SOLO con filas terminales ⟹ el gate NO debe bloquear
-- ─────────────────────────────────────────────────────────────────────────
BEGIN;

CREATE TABLE public.a2a_solana_settle_intents_backup_wkh307 (
  intent_id TEXT PRIMARY KEY,
  status    TEXT NOT NULL
);
INSERT INTO public.a2a_solana_settle_intents_backup_wkh307 (intent_id, status)
VALUES ('gate-test:confirmed', 'confirmed');

-- ⬇⬇ MISMO BLOQUE `DO $wkh307$ ... $wkh307$;` VERBATIM ⬇⬇
--
-- RESULTADO ESPERADO: pasa sin error (las filas `confirmed` son terminales: su
-- `intent_id` —`${composeRunId}:${i}`, UUID fresco por ejecucion— no vuelve a
-- consultarse, asi que no hay dedup que re-hidratar).
--   · si aborta ⟹ HALLAZGO: bloquea de mas y haria imposible re-aplicar el up tras un
--     rollback limpio.

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────
-- CASO 3 · SIN backup ⟹ instalacion limpia, el gate no evalua nada
-- ─────────────────────────────────────────────────────────────────────────
-- (ya cubierto al aplicar la migracion sobre una base virgen: es la rama negativa,
--  y es la unica que si esta ejercitada hoy)

-- ============================================================
-- COMO CORRERLO (entorno descartable)
--
--   docker run --rm -e POSTGRES_PASSWORD=x -p 55432:5432 -d --name wkh307gate postgres:15
--   psql "postgresql://postgres:x@localhost:55432/postgres" -f <este archivo>
--   docker rm -f wkh307gate
--
-- Los `ROLLBACK` dejan la base como estaba; el contenedor descartable es la red de
-- seguridad por si algun paso auto-commitea.
-- ============================================================
