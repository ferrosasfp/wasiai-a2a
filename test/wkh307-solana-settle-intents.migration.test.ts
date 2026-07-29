/**
 * WKH-307 — tests estructurales de la migración del ledger de settle Solana.
 *
 * 100% mock (`readFileSync` sobre los `.sql`): el repo NO tiene Postgres in-process.
 *
 * ── LA REGLA QUE GOBIERNA ESTE ARCHIVO ─────────────────────────────────────
 *
 * Los predicados NO se re-escriben en JavaScript: se **EXTRAEN del `.sql` y se
 * EVALÚAN** (`evalSqlPredicate`, helper compartido). Una tabla de verdad
 * re-implementada en JS es **verdadera por construcción** — se puede borrar el
 * `WHERE` entero de la migración y las aserciones siguen verdes. HU-202 cazó
 * exactamente esa vacuidad con una mutación stealth.
 *
 * ── Y TODA AFIRMACIÓN DE CONDUCTA USA `code()` / `fnBody()` ────────────────
 *
 * El sql CRUDO incluye la cabecera, y la cabecera DESCRIBE en prosa lo mismo que el
 * cuerpo hace: un match contra el texto completo se satisface con el comentario. Eso
 * verificaría que la migración se *describa*, no que *haga*. El sql crudo se reserva
 * para las afirmaciones que son SOBRE los comentarios (el gate de orden de release).
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evalSqlPredicate } from './helpers/sql-predicate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, '..', 'supabase', 'migrations');
const SCRIPTS = resolve(HERE, '..', 'scripts');

const UP = resolve(MIGRATIONS, '20260730000000_wkh307_solana_settle_intents.sql');
const DOWN = resolve(
  MIGRATIONS,
  '20260730000000_wkh307_solana_settle_intents_down.sql',
);
const APPLIER = resolve(SCRIPTS, 'apply-wkh307-migration.mjs');

const flat = (s: string) => s.replace(/\s+/g, ' ');

/** SQL con los COMENTARIOS QUITADOS. Ver la cabecera: es la diferencia entre
 * verificar que la migración HAGA algo y que lo DESCRIBA. */
const code = (s: string) =>
  flat(
    s
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n'),
  );

/** Cuerpo de UNA función del `.sql`, sin comentarios. Este archivo define CUATRO
 * funciones y varios literales aparecen en todas: un match sobre el archivo completo
 * se satisface con la función de al lado y la mutación de una quedaría verde. */
function fnBody(sql: string, name: string): string {
  const re = new RegExp(
    `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${name}\\b`,
  );
  const m = re.exec(sql);
  if (!m) throw new Error(`fnBody: no se encontró la función ${name}`);
  const start = m.index;
  const end = sql.indexOf('$$ LANGUAGE', start);
  if (end === -1) throw new Error(`fnBody: no se cerró el cuerpo de ${name}`);
  return code(sql.slice(start, end));
}

/**
 * El `WHERE` del `ON CONFLICT DO UPDATE` del reclamo, tal como está escrito.
 * Si alguien lo borra o lo renombra, esto TIRA — que es el punto.
 */
function claimConflictGuard(sql: string): string {
  const fn = fnBody(sql, 'claim_solana_settle_intent');
  const oc = fn.indexOf('ON CONFLICT');
  if (oc === -1) throw new Error('no hay ON CONFLICT en el reclamo');
  const whereAt = fn.indexOf('WHERE', oc);
  if (whereAt === -1) {
    throw new Error('el ON CONFLICT DO UPDATE no tiene WHERE (¡sin lease ni términos!)');
  }
  const ret = fn.indexOf('RETURNING', whereAt);
  if (ret === -1) throw new Error('no hay RETURNING tras el WHERE del reclamo');
  return fn.slice(whereAt + 'WHERE'.length, ret).trim();
}

/**
 * Sustituye el término del LEASE por una comparación evaluable, para poder correr el
 * resto del predicado REAL contra la tabla de verdad.
 *
 * ⚠️ TIRA SI EL TÉRMINO NO ESTÁ. Ese throw es el que caza al mutante que borra el
 * lease: no hay forma de que el test pase sin que el `.sql` lo tenga.
 */
function withLeaseAsFlag(clause: string): string {
  const at = clause.indexOf('t.claimed_at');
  if (at === -1) {
    throw new Error(
      'LEASE AUSENTE: el ON CONFLICT DO UPDATE no compara t.claimed_at (cualquier retry robaría el reclamo)',
    );
  }
  const mi = clause.indexOf('make_interval(', at);
  if (mi === -1) {
    throw new Error('el término del lease no usa make_interval sobre now()');
  }
  let depth = 0;
  let i = clause.indexOf('(', mi);
  for (; i < clause.length; i++) {
    if (clause[i] === '(') depth++;
    else if (clause[i] === ')') {
      depth--;
      if (depth === 0) break;
    }
  }
  return `${clause.slice(0, at)}lease_expired = 'yes'${clause.slice(i + 1)}`;
}

const OK_ENV = {
  't.status': 'claimed',
  lease_expired: 'yes',
  't.pay_to': 'PayA',
  'EXCLUDED.pay_to': 'PayA',
  't.amount_atomic': '3000000',
  'EXCLUDED.amount_atomic': '3000000',
  't.mint': 'MintX',
  'EXCLUDED.mint': 'MintX',
};

// ══════════════════════════════════════════════════════════════
// La tabla
// ══════════════════════════════════════════════════════════════

describe('WKH-307 up — la tabla', () => {
  const sql = readFileSync(UP, 'utf8');
  const body = code(sql);

  it('T-MIG-01: crea `a2a_solana_settle_intents` con `intent_id` como PRIMARY KEY', () => {
    // La PK ES lo que hace atómico el reclamo: dos requests concurrentes, un solo
    // ganador, decidido por Postgres y no por el código.
    expect(body).toMatch(
      /CREATE TABLE IF NOT EXISTS public\.a2a_solana_settle_intents/i,
    );
    expect(body).toMatch(/intent_id\s+TEXT\s+PRIMARY KEY/i);
  });

  it('T-MIG-02: `amount_atomic` es TEXT, NUNCA NUMERIC (WKH-196)', () => {
    // PostgREST devuelve NUMERIC como número JSON y JSON.parse redondea > 2^53.
    expect(body).toMatch(/amount_atomic\s+TEXT\s+NOT NULL/i);
    expect(body).not.toMatch(/amount_atomic\s+NUMERIC/i);
  });

  it('T-MIG-03: el `status` está acotado por CHECK a los tres estados', () => {
    expect(body).toMatch(
      /CHECK \(status IN \('claimed','signed','confirmed'\)\)/i,
    );
  });

  it('T-MIG-04: `expired_signatures` existe — la evidencia no se borra', () => {
    expect(body).toMatch(/expired_signatures\s+TEXT\[\]\s+NOT NULL/i);
  });

  it('T-MIG-05: no declara RLS ni columna de owner (decisión explícita)', () => {
    // Es dedup GLOBAL del gateway: el intent_id no es objeto de un tenant y el adapter
    // ni siquiera recibe owner_ref. Se afirma para que el día que alguien agregue RLS
    // sea una decisión y no un accidente.
    expect(body).not.toMatch(/ENABLE ROW LEVEL SECURITY/i);
    expect(body).not.toMatch(/CREATE POLICY/i);
    // No hay COLUMNA de owner. (La palabra sí aparece en el `COMMENT ON TABLE`, que es
    // justamente donde se DECLARA la decisión — por eso se busca la definición de
    // columna, no la palabra suelta.)
    const createTable = body.slice(
      body.indexOf('CREATE TABLE'),
      body.indexOf('COMMENT ON TABLE'),
    );
    expect(createTable).not.toMatch(/owner_ref/i);
  });

  it('T-MIG-06: la tabla no es accesible por anon/authenticated', () => {
    expect(body).toMatch(
      /REVOKE ALL ON public\.a2a_solana_settle_intents FROM PUBLIC, anon, authenticated/i,
    );
  });
});

// ══════════════════════════════════════════════════════════════
// Los índices — M14 muere acá
// ══════════════════════════════════════════════════════════════

describe('WKH-307 up — los índices', () => {
  const sql = readFileSync(UP, 'utf8');
  const body = code(sql);

  it('T-MIG-10: el índice de `settle_signature` es UNIQUE **y** PARCIAL', () => {
    // ⚠️ NO es defensa en profundidad: REPONE la protección que se pierde al dejar
    // `sendAndConfirmTransaction`. Sin UNIQUE, dos legs al mismo agente por el mismo
    // monto bajo el mismo blockhash producen la MISMA firma ⟹ UNA transferencia
    // on-chain contabilizada como DOS pagos (el agente cobra la mitad).
    // Si esto sale sin UNIQUE, la HU deja el sistema PEOR que como lo encontró.
    const idx =
      /CREATE UNIQUE INDEX IF NOT EXISTS ux_a2a_solana_settle_intents_signature ON public\.a2a_solana_settle_intents \(settle_signature\) WHERE settle_signature IS NOT NULL/i;
    expect(body).toMatch(idx);
  });

  it('T-MIG-10b: es PARCIAL porque las filas `claimed` tienen la firma en NULL', () => {
    // Sin el WHERE, todas las filas reclamadas y sin firmar chocarían entre sí y el
    // segundo reclamo de la vida fallaría.
    const upIdx = body.slice(body.indexOf('ux_a2a_solana_settle_intents_signature'));
    expect(upIdx.slice(0, 200)).toMatch(/WHERE settle_signature IS NOT NULL/i);
  });

  it('T-MIG-11: existe el índice de inventario (status, claimed_at)', () => {
    expect(body).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_a2a_solana_settle_intents_status_claimed_at ON public\.a2a_solana_settle_intents \(status, claimed_at\)/i,
    );
  });
});

// ══════════════════════════════════════════════════════════════
// El reclamo — M12 y M13 mueren acá
// ══════════════════════════════════════════════════════════════

describe('WKH-307 up — el guard del reclamo, EVALUADO desde el .sql', () => {
  const sql = readFileSync(UP, 'utf8');
  /**
   * ⚠️ LAZY A PROPÓSITO. Si el guard se extrajera en el cuerpo del `describe`, un
   * `.sql` sin el término del lease haría que `withLeaseAsFlag` tirara durante la
   * COLECCIÓN, y vitest reportaría "no tests" en vez de un test rojo — un FALSO
   * KILLED: todo en rojo sin haber probado nada. Cazado por el mutante M12.
   */
  const guard = () => withLeaseAsFlag(claimConflictGuard(sql));

  it('T-MIG-08: el LEASE gobierna las dos direcciones (predicado extraído, no re-escrito)', () => {
    // Fuera del lease ⟹ se toma el relevo (y es seguro por la invariante I2: una fila
    // `claimed` no tiene firma, luego nunca se transmitió nada).
    expect(evalSqlPredicate(guard(), { ...OK_ENV, lease_expired: 'yes' })).toBe(true);
    // Dentro del lease ⟹ NO se toma: hay otro request en vuelo.
    expect(evalSqlPredicate(guard(), { ...OK_ENV, lease_expired: 'no' })).toBe(false);
  });

  it('T-MIG-08b: sólo una fila `claimed` puede ser tomada', () => {
    // `signed` y `confirmed` no se re-reclaman: sus salidas pasan por la cadena.
    for (const status of ['signed', 'confirmed']) {
      expect(evalSqlPredicate(guard(), { ...OK_ENV, 't.status': status })).toBe(
        false,
      );
    }
  });

  it('T-MIG-09: los TRES términos del intent tienen que coincidir (AC-8)', () => {
    // Si el caller cambia destino, monto o mint, NO es el mismo pago.
    expect(
      evalSqlPredicate(guard(), { ...OK_ENV, 'EXCLUDED.pay_to': 'PayB' }),
    ).toBe(false);
    expect(
      evalSqlPredicate(guard(), { ...OK_ENV, 'EXCLUDED.amount_atomic': '9999999' }),
    ).toBe(false);
    expect(evalSqlPredicate(guard(), { ...OK_ENV, 'EXCLUDED.mint': 'MintY' })).toBe(
      false,
    );
    // Y con todo igual, pasa.
    expect(evalSqlPredicate(guard(), OK_ENV)).toBe(true);
  });

  it('T-MIG-12: el umbral del lease usa `now()` de POSTGRES, no un parámetro de tiempo', () => {
    // Con el reloj del CLIENTE, dos instancias del gateway con skew tienen leases
    // distintos y la adelantada roba un lease vivo ⟹ dos broadcasts.
    const raw = claimConflictGuard(sql);
    expect(raw).toMatch(/t\.claimed_at\s*<\s*now\(\)\s*-\s*make_interval/i);
    // El parámetro que entra es la DURACIÓN, no un instante ya calculado.
    expect(raw).toMatch(/p_lease_ms/);
    expect(raw).not.toMatch(/p_threshold|p_claimed_before|p_now/i);
  });
});

// ══════════════════════════════════════════════════════════════
// Las cuatro funciones
// ══════════════════════════════════════════════════════════════

describe('WKH-307 up — las 4 funciones de transición', () => {
  const sql = readFileSync(UP, 'utf8');
  const NAMES = [
    'claim_solana_settle_intent',
    'record_solana_settle_signed',
    'record_solana_settle_confirmed',
    'reclaim_solana_settle_intent',
  ];

  it('T-MIG-07: las 4 existen y devuelven LA MISMA fila', () => {
    // Misma forma de retorno ⟹ un solo consumo en TS y, sobre todo, una migración
    // futura puede CREATE OR REPLACE sin DROP (sin ventana PGRST202).
    for (const n of NAMES) {
      const b = fnBody(sql, n);
      expect(b).toMatch(
        /RETURNS TABLE\( applied BOOLEAN, outcome TEXT, status TEXT, settle_signature TEXT, last_valid_block_height TEXT, attempts INTEGER \)/i,
      );
    }
  });

  it('T-MIG-07b: `last_valid_block_height` sale como TEXT aunque la columna sea BIGINT', () => {
    // Convención WKH-196 en la dirección de salida: un uint64 como número JSON pierde
    // dígitos por encima de 2^53.
    expect(code(sql)).toMatch(/last_valid_block_height\s+BIGINT/i);
    for (const n of NAMES) {
      expect(fnBody(sql, n)).toMatch(/t\.last_valid_block_height::TEXT/i);
    }
  });

  it('T-MIG-07c: las 4 son SECURITY DEFINER con search_path fijo y sin acceso público', () => {
    const body = code(sql);
    // `SECURITY DEFINER` va DESPUÉS del `$$ LANGUAGE`, o sea fuera del cuerpo que
    // `fnBody` recorta: se cuenta sobre el archivo (4 funciones ⟹ 4 apariciones).
    expect(body.match(/LANGUAGE plpgsql SECURITY DEFINER/gi) ?? []).toHaveLength(
      NAMES.length,
    );
    for (const n of NAMES) {
      expect(body).toMatch(
        new RegExp(`ALTER FUNCTION public\\.${n}[^;]*SET search_path = public, pg_temp`, 'i'),
      );
      expect(body).toMatch(
        new RegExp(`REVOKE EXECUTE ON FUNCTION public\\.${n}[^;]*FROM PUBLIC, anon, authenticated`, 'i'),
      );
      expect(body).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${n}[^;]*TO service_role`, 'i'),
      );
    }
  });

  it('T-MIG-07d: el probe hace RAISE como PRIMERA sentencia, antes de escribir', () => {
    // Es lo que lo vuelve seguro y concluyente a la vez: prueba positiva sin efectos.
    const b = fnBody(sql, 'claim_solana_settle_intent');
    const raiseAt = b.indexOf('WKH307_PROBE_OK');
    const insertAt = b.indexOf('INSERT INTO');
    expect(raiseAt).toBeGreaterThan(-1);
    expect(insertAt).toBeGreaterThan(-1);
    expect(raiseAt).toBeLessThan(insertAt);
    expect(b).toMatch(/IF p_probe THEN RAISE EXCEPTION 'WKH307_PROBE_OK'/i);
  });

  it('T-MIG-07e: `record_signed` sólo aplica sobre una fila `claimed`', () => {
    // Es el paso que crea la invariante I2: si no aplica, no se transmite.
    const b = fnBody(sql, 'record_solana_settle_signed');
    expect(b).toMatch(/WHERE t\.intent_id = p_intent_id AND t\.status = 'claimed'/i);
  });

  it('T-MIG-07f: `record_confirmed` exige que la FIRMA coincida', () => {
    // Confirmar "el intent" sin decir cuál firma permitiría marcar confirmado un pago
    // distinto del que aterrizó.
    expect(fnBody(sql, 'record_solana_settle_confirmed')).toMatch(
      /AND t\.settle_signature = p_signature/i,
    );
  });

  it('T-MIG-07g: `reclaim` ARCHIVA la firma vieja en vez de perderla', () => {
    const b = fnBody(sql, 'reclaim_solana_settle_intent');
    expect(b).toMatch(
      /expired_signatures\s*=\s*t\.expired_signatures \|\| ARRAY\[t\.settle_signature\]/i,
    );
    // Y sólo sale de `signed` con la firma exacta que se está descartando.
    expect(b).toMatch(/AND t\.status = 'signed' AND t\.settle_signature = p_signature/i);
  });

  it('T-MIG-07h: el 23505 NO se atrapa en plpgsql (tiene que aflorar al caller)', () => {
    // Atraparlo colapsaría "colisión de firma" (se re-firma) con "no estaba claimed"
    // (se abandona), que tienen remedios opuestos.
    expect(fnBody(sql, 'record_solana_settle_signed')).not.toMatch(
      /EXCEPTION\s+WHEN\s+unique_violation/i,
    );
  });
});

// ══════════════════════════════════════════════════════════════
// El down — M15 muere acá
// ══════════════════════════════════════════════════════════════

describe('WKH-307 down — la evidencia no se destruye', () => {
  const down = readFileSync(DOWN, 'utf8');
  const body = code(down);

  it('T-MIG-13: RENOMBRA la tabla, NUNCA `DROP TABLE`', () => {
    // La tabla es la única evidencia persistida de a qué agente se le pagó, con qué
    // firma y por cuánto. Borrarla destruiría el dato con el que se decide si alguien
    // cobró dos veces — y justo en el momento de máxima incertidumbre (un rollback).
    expect(body).toMatch(
      /ALTER TABLE IF EXISTS public\.a2a_solana_settle_intents RENAME TO a2a_solana_settle_intents_backup_wkh307/i,
    );
    expect(body).not.toMatch(/DROP TABLE/i);
  });

  it('T-MIG-13b: sí borra las 4 funciones y los 2 índices', () => {
    for (const n of [
      'claim_solana_settle_intent',
      'record_solana_settle_signed',
      'record_solana_settle_confirmed',
      'reclaim_solana_settle_intent',
    ]) {
      expect(body).toMatch(new RegExp(`DROP FUNCTION IF EXISTS public\\.${n}`, 'i'));
    }
    expect(body).toMatch(/DROP INDEX IF EXISTS public\.ux_a2a_solana_settle_intents_signature/i);
  });

  it('T-MIG-13c: la cabecera trae el inventario obligatorio previo al rollback', () => {
    // Afirmación SOBRE los comentarios (por eso usa el sql crudo): sin el inventario,
    // un rollback deja fuera de línea filas con plata posiblemente en vuelo.
    expect(down).toMatch(/INVENTARIO OBLIGATORIO ANTES DE REVERTIR/i);
    expect(down).toMatch(/status <> 'confirmed'/i);
  });
});

// ══════════════════════════════════════════════════════════════
// Gate de orden de release + applier (AC-7)
// ══════════════════════════════════════════════════════════════

describe('WKH-307 — gate de orden de release y applier', () => {
  const up = readFileSync(UP, 'utf8');
  const applier = readFileSync(APPLIER, 'utf8');

  it('T-MIG-14a: el `.sql` declara que la migración va ANTES del código', () => {
    expect(up).toMatch(/ORDEN DE RELEASE \(GATE\)/i);
    expect(up).toMatch(/ANTES\*{0,2} DE DEPLOYAR EL CODIGO/i);
  });

  it('T-MIG-14: el applier es bdwv-only y aborta si resuelve a caldz', () => {
    // El ref de bdwv se HARDCODEA y no se deriva de SUPABASE_URL: el `.env` local
    // apunta a otra base que el gateway de prod.
    expect(applier).toMatch(/const BDWV_REF = 'bdwvrwzvsldephfibmuu'/);
    expect(applier).toMatch(/const TARGET_REF = BDWV_REF/);
    expect(applier).toMatch(/if \(TARGET_REF === CALDZ_REF\)[\s\S]{0,200}process\.exit\(3\)/);
    // El literal de caldz aparece UNA sola vez (su constante); nunca como destino.
    const occurrences = applier.split('caldzjhjgctpgodldqav').length - 1;
    expect(occurrences).toBe(1);
    expect(applier).not.toMatch(/TARGET_REF = CALDZ_REF/);
  });

  it('T-MIG-14b: las keys se identifican por el claim `ref` del JWT, no por el nombre', () => {
    // Motivo REAL medido en este repo: en `.env.local` la variable SIN sufijo apunta a
    // PRODUCCIÓN. El nombre no es evidencia.
    expect(applier).toMatch(/function jwtRef\(token\)/);
    expect(applier).toMatch(/const ref = jwtRef\(val\)/);
  });

  it('T-MIG-14c: el post-estado se LEE del catálogo, no se asume del exit code', () => {
    expect(applier).toMatch(/information_schema\.columns/);
    expect(applier).toMatch(/pg_indexes/);
    expect(applier).toMatch(/pg_get_functiondef/);
    // Y el chequeo del UNIQUE está entre los que hacen fallar el applier.
    expect(applier).toMatch(/sigIndexUnique/);
    expect(applier).toMatch(/sigIndexPartial/);
  });
});
