/**
 * SQL-estructural — HU-202: lease del hop 2 (columna + stamp + guard del claim).
 *
 * 100% mock (`readFileSync` sobre los .sql): el repo NO tiene Postgres in-process. Mismo
 * patrón y mismo alcance que `hu198-settle-status.migration.test.ts`.
 *
 * POR QUÉ EXISTE: las tres conductas que introduce la migración —el stamp, su limpieza y
 * el guard del lado settle— se pueden BORRAR del .sql sin que nada más se ponga rojo. Los
 * tests de servicio corren contra dobles; el `WHERE` real que decide si sale un segundo
 * pago al seller vive ACÁ. Además, esta migración REESCRIBE dos funciones completas, así
 * que puede hacer desaparecer en silencio conductas de HU-198 (el guard de transición, la
 * rama refund de MNR-4): eso también se canda acá.
 *
 * ALCANCE DECLARADO: esto verifica el TEXTO del SQL, no su semántica en Postgres. La
 * verificación contra la base real la hace `scripts/apply-hu202-migration.mjs` leyendo del
 * catálogo; eso corre a mano, esto corre en CI.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// WKH-307: el evaluador se movió a un helper compartido (ver su cabecera: importar un
// `.test.ts` desde otro duplica sus suites).
import {
  evalSqlPredicate,
  extractGuardClause,
} from './helpers/sql-predicate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, '..', 'supabase', 'migrations');

const UP = resolve(MIGRATIONS, '20260729000000_hu202_hop2_lease.sql');
const DOWN = resolve(MIGRATIONS, '20260729000000_hu202_hop2_lease_down.sql');

/** Normaliza espacios para poder matchear SQL multilinea sin pelear con el formato. */
const flat = (s: string) => s.replace(/\s+/g, ' ');

/**
 * SQL con los COMENTARIOS QUITADOS, normalizado.
 *
 * ⚠️ EXISTE POR UN TEST VACUO REAL cazado en HU-198: una aserción sobre el TEXTO del .sql
 * SE SATISFACE CON EL COMENTARIO DE CABECERA, porque el header describe en prosa lo mismo
 * que el cuerpo hace. O sea que el test verificaba que la migración se DESCRIBIERA, no que
 * HICIERA.
 *
 * REGLA: toda afirmación sobre la CONDUCTA del SQL usa `code()`/`fnBody()`. El sql crudo se
 * reserva para las afirmaciones que son SOBRE los comentarios (el gate de orden de release,
 * los avisos del `_down`).
 */
const code = (s: string) =>
  flat(
    s
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n'),
  );

/**
 * Cuerpo de UNA función del `.sql`, sin comentarios.
 *
 * ⚠️ EXISTE POR OTRA VACUIDAD REAL de HU-198: este archivo define DOS funciones, y varios
 * literales (`GET DIAGNOSTICS`, `debit_settle_status`, el bloque de GRANTs) aparecen en las
 * dos. Un match sobre el archivo completo se satisface con la función de al lado, así que
 * la mutación de una quedaría verde.
 */
function fnBody(sql: string, name: string): string {
  const re = new RegExp(
    `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${name}\\b`,
  );
  const m = re.exec(sql);
  if (!m) throw new Error(`fnBody: no se encontró la función ${name}`);
  const start = m.index;
  const end = sql.indexOf('$$ LANGUAGE', start);
  if (end === -1) throw new Error(`fnBody: no se cerró el cuerpo de ${name}`);
  return code(sql.slice(start, end));
}

describe('HU-202 up — la columna del hecho persistido', () => {
  const sql = readFileSync(UP, 'utf8');

  it('T1: agrega `debit_hop2_attempted_at` de forma ADITIVA (idempotente, nullable)', () => {
    expect(code(sql)).toContain(
      'ADD COLUMN IF NOT EXISTS debit_hop2_attempted_at TIMESTAMPTZ',
    );
    // Sin default y sin NOT NULL: una columna con default reescribiría el significado de
    // las filas VIEJAS (afirmaría un intento de hop 2 que nadie hizo).
    expect(code(sql)).not.toContain('debit_hop2_attempted_at TIMESTAMPTZ NOT NULL');
    expect(code(sql)).not.toContain('debit_hop2_attempted_at TIMESTAMPTZ DEFAULT');
  });

  it('T2: la migración corre en UNA transacción', () => {
    expect(code(sql).trim().startsWith('BEGIN;')).toBe(true);
    expect(code(sql).trim().endsWith('COMMIT;')).toBe(true);
  });

  it('T3: NO hay `DROP FUNCTION` — la firma no cambia, así que no hay ventana de schema-cache', () => {
    // Es una propiedad del GATE DE ORDEN DE RELEASE, no cosmética: un DROP+CREATE que
    // cambia la firma hace que PostgREST conteste `PGRST202` hasta que recargue, y en esa
    // ventana el estado del ciclo de vida NO se escribe. Las dos migraciones de HU-198
    // pagaron ese precio; ésta no tiene por qué.
    expect(code(sql)).not.toContain('DROP FUNCTION');
  });
});

describe('HU-202 up — record_debit_settle_status toma y libera el lease', () => {
  const sql = readFileSync(UP, 'utf8');
  const fn = fnBody(sql, 'record_debit_settle_status');

  it('T4: `resolving_settle` ESTAMPA el intento de hop 2', () => {
    // Sin esto no existe el hecho persistido y el candado entero queda colgando del
    // string del status.
    expect(fn).toContain("WHEN p_status = 'resolving_settle' THEN now()");
  });

  it('T5: `reconciliation_pending` LIMPIA el stamp (libera el lease)', () => {
    // ⚠️ La mitad que impide la SOBRE-CORRECCIÓN. Sin esta línea, el rechazo NORMAL del
    // facilitator (veredicto `unequivocal`, caso D) dejaría la fila estampada para
    // siempre ⟹ el reconciliador no la re-envía ⟹ el seller NO cobra automáticamente y
    // nadie mira esas filas.
    expect(fn).toContain("WHEN p_status = 'reconciliation_pending' THEN NULL");
  });

  it('T6: `settled` NO borra el stamp (auditoría del terminal)', () => {
    // El `ELSE` preserva el valor: el rastro de cuándo se intentó el hop 2 sobrevive al
    // terminal, que es lo que se necesita para cuantificar un doble pago si aparece.
    expect(fn).toContain('ELSE debit_hop2_attempted_at END');
  });

  it('T7: el guard de transición de HU-198 SOBREVIVE a la reescritura', () => {
    // Esta migración reescribe la función COMPLETA. Si el guard no se reproduce,
    // desaparece EN SILENCIO y `resolving_settle` vuelve a poder pisar un terminal.
    expect(fn).toContain("p_status <> 'resolving_settle'");
    expect(fn).toContain(
      "OR debit_settle_status IN ('hop1_confirmed','reconciliation_pending')",
    );

    // ⚠️ AR de HU-202, MENOR 2 — LA TABLA DE VERDAD AHORA EVALÚA EL SQL REAL.
    //
    // La versión anterior re-implementaba el predicado en JS y después afirmaba sobre la
    // re-implementación: verdadera por construcción, verde ante CUALQUIER mutación del
    // `.sql`. Acá el predicado se EXTRAE del archivo (`extractGuardClause`) y se EVALÚA
    // (`evalSqlPredicate`), así que mutar el `WHERE` de la migración pone esto en rojo.
    const clause = extractGuardClause(fn, "p_status <> 'resolving_settle'");
    const guard = (pStatus: string, current: string | null) =>
      evalSqlPredicate(clause, {
        p_status: pStatus,
        debit_settle_status: current,
      });
    // El lease se puede tomar desde los estados pre-resolución…
    expect(guard('resolving_settle', 'hop1_confirmed')).toBe(true);
    expect(guard('resolving_settle', 'reconciliation_pending')).toBe(true);
    expect(guard('resolving_settle', null)).toBe(true);
    // …y NUNCA desde un terminal ni pisando otro lease (2º settle concurrente).
    expect(guard('resolving_settle', 'settled')).toBe(false);
    expect(guard('resolving_settle', 'resolved_settled')).toBe(false);
    expect(guard('resolving_settle', 'resolving_settle')).toBe(false);
    // Y los valores viejos siguen pasando sin precondición.
    expect(guard('settled', 'resolving_settle')).toBe(true);
    expect(guard('reconciliation_pending', 'resolving_settle')).toBe(true);
  });

  it('T8: el `applied` que gobierna el fail-closed del caller sigue derivándose del ROW_COUNT', () => {
    // El caller NO manda el hop 2 si esto no dice `true`. Si `applied` se volviera
    // constante, el lease se creería tomado sin estarlo y F se re-abre.
    expect(fn).toContain('GET DIAGNOSTICS v_rows = ROW_COUNT');
    expect(fn).toContain('applied := v_rows > 0');
  });

  it('T9: la firma y el tipo de retorno NO cambian (propiedad del orden de release)', () => {
    expect(fn).toContain(
      'RETURNS TABLE(applied BOOLEAN, current_status TEXT)',
    );
    expect(fn).toContain('p_status TEXT');
    // Ningún parámetro nuevo: la liberación del lease viaja EN el `p_status`, justamente
    // para que el RPC viejo y el nuevo sean intercambiables durante el deploy.
    expect(fn).not.toContain('p_clear');
    expect(fn).not.toContain('p_lease');
  });
});

describe('HU-202 up — claim_reconciliation respeta el lease', () => {
  const sql = readFileSync(UP, 'utf8');
  const fn = fnBody(sql, 'claim_reconciliation');

  it('T10: el lado SETTLE no reclama una fila con hop 2 estampado y sin tx de resolución', () => {
    // ES EL GUARD QUE CIERRA (B), (C), (F) y (G). Borrarlo devuelve el re-envío ciego.
    expect(fn).toContain(
      "p_side = 'refund' OR debit_hop2_attempted_at IS NULL OR debit_resolution_tx_hash IS NOT NULL",
    );

    // ⚠️ AR de HU-202, MENOR 2 — TABLA DE VERDAD EVALUADA SOBRE EL SQL REAL, no sobre una
    // copia en JS del predicado. Ésta es la que decide si sale un 2º pago al seller, así
    // que era la peor de las dos para tenerla decorativa.
    const clause = extractGuardClause(fn, 'debit_hop2_attempted_at IS NULL');
    const leaseGuard = (
      side: 'settle' | 'refund',
      stamped: boolean,
      hasTx: boolean,
    ) =>
      evalSqlPredicate(clause, {
        p_side: side,
        debit_hop2_attempted_at: stamped ? '2026-07-28T00:00:00Z' : null,
        debit_resolution_tx_hash: hasTx ? '0xhop2' : null,
      });
    // (F)/(B)/(C)/(G): hop 2 intentado, sin tx ⟹ el settle NO puede reclamar.
    expect(leaseGuard('settle', true, false)).toBe(false);
    // (A)/(D): sin intento persistido ⟹ el settle SÍ reclama (el seller cobra solo).
    expect(leaseGuard('settle', false, false)).toBe(true);
    // Con tx hay algo que VERIFICAR on-chain ⟹ se reclama para verificar, no para pagar.
    expect(leaseGuard('settle', true, true)).toBe(true);
    // El refund es inmune SIEMPRE (budget-only, idempotente, no manda hop 2).
    expect(leaseGuard('refund', true, false)).toBe(true);
  });

  it('T11: el lado SETTLE estampa al reclamar (su re-envío también es un intento de hop 2)', () => {
    // Si no estampara, la columna diría "nunca se intentó" sobre una fila a la que el
    // reconciliador le acaba de mandar un pago — una afirmación falsa en el único dato
    // con el que después se decide si hubo doble pago.
    expect(fn).toContain("WHEN p_side = 'settle' THEN now()");
  });

  it('T12 (AC-10, no-regresión): la rama refund de MNR-4 SOBREVIVE a la reescritura', () => {
    // HU-198 la agregó porque sin ella el débito off-chain del buyer quedaba sin acreditar
    // PARA SIEMPRE cuando el hop 1 re-verificaba `not_confirmed`. Esta migración reescribe
    // la función entera: si no se reproduce, ese refund vuelve a ser inalcanzable y nada
    // más lo notaría.
    expect(fn).toContain(
      "OR (p_side = 'refund' AND debit_settle_status = 'resolving_settle')",
    );
  });

  it('T13: el re-claim para VERIFICAR (resolving_settle con tx) sigue habilitado', () => {
    // Es el crash-recovery: sin él, una fila con un hop 2 previo persistido no se puede
    // ni verificar ni cerrar, y queda para siempre en revisión manual.
    expect(fn).toContain(
      "debit_settle_status = v_target AND (p_side = 'refund' OR debit_resolution_tx_hash IS NOT NULL)",
    );
  });

  it('T14: el Ownership Guard DB-level sigue en pie', () => {
    expect(fn).toContain("RAISE EXCEPTION 'OWNERSHIP_MISMATCH:");
    expect(fn).toContain('v_owner IS DISTINCT FROM p_owner_ref');
  });
});

describe('HU-202 down — rollback', () => {
  const down = readFileSync(DOWN, 'utf8');
  const rec = fnBody(down, 'record_debit_settle_status');
  const claim = fnBody(down, 'claim_reconciliation');

  it('T15 (AC-12): el `_down` NUNCA borra la columna (es la única evidencia del hop 2)', () => {
    // Un `DROP COLUMN` destruiría el dato con el que se decide si un seller cobró dos
    // veces, y lo haría en el momento de máxima incertidumbre (un rollback).
    expect(code(down)).not.toContain('DROP COLUMN');
    expect(code(down)).not.toContain('debit_hop2_attempted_at TIMESTAMPTZ');
  });

  it('T16: el `_down` saca el stamp de `record_debit_settle_status`', () => {
    expect(rec).not.toContain("WHEN p_status = 'resolving_settle' THEN now()");
    // …pero DEVUELVE el cuerpo previo completo, con el guard de transición de HU-198.
    expect(rec).toContain("p_status <> 'resolving_settle'");
    expect(rec).toContain(
      'RETURNS TABLE(applied BOOLEAN, current_status TEXT)',
    );
  });

  it('T17: el `_down` saca el guard del lease pero CONSERVA la rama refund de MNR-4', () => {
    expect(claim).not.toContain('debit_hop2_attempted_at IS NULL');
    expect(claim).toContain(
      "OR (p_side = 'refund' AND debit_settle_status = 'resolving_settle')",
    );
  });

  it('T18: el `_down` avisa QUÉ se re-abre y trae la query para inventariarlo', () => {
    // Ésta SÍ es una afirmación sobre los comentarios (por eso va sobre el sql crudo): un
    // rollback que no dice qué agujero devuelve deja al operador sin saber qué mirar.
    expect(down).toMatch(/INVENTARIO OBLIGATORIO ANTES DE REVERTIR/);
    expect(down).toContain('WHERE debit_hop2_attempted_at IS NOT NULL');
    expect(down).toMatch(/ORDEN DE ROLLBACK \(GATE\)/);
  });
});

/**
 * AR de HU-202, MENOR 2 — EL EVALUADOR TIENE QUE SER CONFIABLE, Y LA TABLA DE VERDAD TIENE
 * QUE PODER FALLAR.
 *
 * Un evaluador roto que devolviera siempre lo mismo volvería a hacer decorativas a T7/T10,
 * sólo que con más código. Así que: (a) se lo prueba contra expresiones conocidas, y (b) se
 * demuestra que una MUTACIÓN del clause cambia la tabla de verdad — que es la propiedad que
 * la versión anterior de estos tests no tenía bajo ninguna mutación.
 */
describe('HU-202 — el evaluador de predicados SQL no es decorativo', () => {
  it('T20: evalúa el subconjunto usado por los guards (IS NULL / IN / <> / = / AND / OR / paréntesis)', () => {
    expect(evalSqlPredicate('a IS NULL', { a: null })).toBe(true);
    expect(evalSqlPredicate('a IS NULL', { a: 'x' })).toBe(false);
    expect(evalSqlPredicate('a IS NOT NULL', { a: 'x' })).toBe(true);
    expect(evalSqlPredicate("a IN ('x','y')", { a: 'y' })).toBe(true);
    expect(evalSqlPredicate("a IN ('x','y')", { a: 'z' })).toBe(false);
    expect(evalSqlPredicate("a IN ('x')", { a: null })).toBe(false);
    expect(evalSqlPredicate("a <> 'x'", { a: 'y' })).toBe(true);
    expect(evalSqlPredicate("a = 'x'", { a: 'x' })).toBe(true);
    expect(evalSqlPredicate("a = 'x' OR b IS NULL", { a: 'z', b: null })).toBe(
      true,
    );
    expect(evalSqlPredicate("a = 'x' AND b IS NULL", { a: 'z', b: null })).toBe(
      false,
    );
    expect(
      evalSqlPredicate("(a = 'x' OR b = 'y') AND c IS NULL", {
        a: 'x',
        b: 'n',
        c: null,
      }),
    ).toBe(true);
  });

  it('T21: un identificador que el test NO modeló TIRA (no puede pasar por verdadero en silencio)', () => {
    expect(() => evalSqlPredicate('sorpresa IS NULL', {})).toThrow(
      /unmodelled identifier/,
    );
  });

  it('T22 (ANTI-VACUIDAD): mutar el clause CAMBIA la tabla de verdad — o sea que T7/T10 pueden fallar', () => {
    const up = readFileSync(UP, 'utf8');

    // (a) El guard del lease del claim, mutado con un `IS NULL` → `IS NOT NULL`: el typo
    //     de una letra que INVIERTE el guard y reabre el re-envío ciego de (B)/(C)/(F)/(G).
    const real = extractGuardClause(
      fnBody(up, 'claim_reconciliation'),
      'debit_hop2_attempted_at IS NULL',
    );
    const mutated = real.replace(
      'debit_hop2_attempted_at IS NULL',
      'debit_hop2_attempted_at IS NOT NULL',
    );
    expect(mutated).not.toBe(real); // la mutación se aplicó de verdad
    const stampedNoTx = {
      p_side: 'settle',
      debit_hop2_attempted_at: '2026-07-28T00:00:00Z',
      debit_resolution_tx_hash: null,
    };
    // El SQL real REFUSA el claim; el mutado lo dejaría pasar. Distintos ⟹ la aserción de
    // T10 depende del texto del `.sql`, no de una copia en JS.
    expect(evalSqlPredicate(real, stampedNoTx)).toBe(false);
    expect(evalSqlPredicate(mutated, stampedNoTx)).toBe(true);

    // (b) El guard de transición del lease, mutado: se le agrega `resolving_settle` a la
    //     lista de estados desde los que se puede tomar (o sea, pisar el lease de otro).
    const realT = extractGuardClause(
      fnBody(up, 'record_debit_settle_status'),
      "p_status <> 'resolving_settle'",
    );
    const mutatedT =
      "p_status <> 'resolving_settle' OR debit_settle_status IS NULL OR debit_settle_status IN ('hop1_confirmed','reconciliation_pending','resolving_settle')";
    const alreadyLeased = {
      p_status: 'resolving_settle',
      debit_settle_status: 'resolving_settle',
    };
    expect(evalSqlPredicate(realT, alreadyLeased)).toBe(false);
    expect(evalSqlPredicate(mutatedT, alreadyLeased)).toBe(true);
  });
});

describe('HU-202 — gate de orden de release en el header', () => {
  const up = readFileSync(UP, 'utf8');

  it('T19: el header declara el orden Y la consecuencia del orden inverso', () => {
    // Sobre el sql CRUDO a propósito: la afirmación es sobre los comentarios.
    expect(up).toMatch(/ORDEN DE RELEASE \(GATE\)/);
    expect(up).toMatch(/ANTES\*\* DE DEPLOYAR EL CÓDIGO/);
    expect(up).toMatch(/CONSECUENCIA DEL ORDEN INVERSO/);
    // Y nombra el residuo que la migración NO puede cerrar.
    expect(up).toMatch(/QUÉ \*\*NO\*\* CIERRA/);
  });
});
