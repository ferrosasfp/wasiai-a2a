/**
 * SQL-estructural — HU-198: `resolving_settle` escribible + `applied` + MNR-4/MNR-3.
 *
 * 100% mock (`readFileSync` sobre los .sql): el repo NO tiene Postgres in-process.
 * Mismo patrón y mismo alcance que `negative-amount-guard.migration.test.ts` y
 * `agent-links.migration.test.ts`.
 *
 * POR QUÉ EXISTE (AR BLQ-MEDIO-4): las dos conductas que introdujo la migración —el
 * `IN` ampliado y el guard de transición— se podían BORRAR del .sql sin que nada se
 * pusiera rojo. La verificación de comportamiento contra la base real la hace
 * `scripts/apply-hu198-migration.mjs` (4 chequeos leyendo del catálogo y por sondeo),
 * pero eso corre a mano; esto corre en CI.
 *
 * ALCANCE DECLARADO: esto verifica el TEXTO del SQL, no su semántica en Postgres. Un
 * test que afirme "el guard rechaza de verdad" necesita un Postgres efímero y es
 * responsabilidad de F4 / del applier.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, '..', 'supabase', 'migrations');

const UP1 = resolve(MIGRATIONS, '20260728000000_hu198_settle_unknown_status.sql');
const DOWN1 = resolve(
  MIGRATIONS,
  '20260728000000_hu198_settle_unknown_status_down.sql',
);
const UP2 = resolve(MIGRATIONS, '20260728010000_hu198_settle_status_applied.sql');
const UP3 = resolve(
  MIGRATIONS,
  '20260728020000_hu198_settle_status_current.sql',
);
const DOWN2 = resolve(
  MIGRATIONS,
  '20260728010000_hu198_settle_status_applied_down.sql',
);
const DOWN3 = resolve(
  MIGRATIONS,
  '20260728020000_hu198_settle_status_current_down.sql',
);

/** Normaliza espacios para poder matchear SQL multilinea sin pelear con el formato. */
const flat = (s: string) => s.replace(/\s+/g, ' ');

/**
 * SQL con los COMENTARIOS QUITADOS, normalizado.
 *
 * ⚠️ EXISTE POR UN TEST VACUO REAL, cazado con mutación en este mismo fix-pack: la
 * primera versión de `T11` afirmaba `flat(sql).toContain('AND intent_id = p_intent_id')`
 * y PASABA con la cláusula BORRADA del UPDATE, porque el header de la migración la
 * menciona en prosa ("(3) MNR-3 — el UPDATE ... agrega `AND intent_id = p_intent_id`").
 * O sea que el test verificaba que la migración se DESCRIBIERA, no que HICIERA.
 *
 * REGLA: toda afirmación sobre la CONDUCTA del SQL usa `code()`. `flat()`/el sql crudo (con
 * comentarios) se reserva para las afirmaciones que son SOBRE los comentarios — el gate
 * de orden de release, los avisos del `_down`.
 */
const code = (s: string) =>
  flat(
    s
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n'),
  );

/**
 * Cuerpo de UNA función del `.sql`, sin comentarios (AR#2 MNR-1, especie (i)).
 *
 * ⚠️ EXISTE POR OTRA VACUIDAD REAL, también cazada con mutación: `T7` afirmaba
 * `code(sql).toContain('GET DIAGNOSTICS v_rows = ROW_COUNT')` sobre el archivo COMPLETO,
 * y el archivo define DOS funciones. Cambiar el `GET DIAGNOSTICS` de
 * `record_debit_settle_status` por `v_rows := 1` dejaba el test verde, porque el literal
 * seguía existiendo en `claim_reconciliation` — y el efecto de esa mutación es que
 * `applied` sea SIEMPRE `true`, o sea que el candado de BLQ-MEDIO-2 se anula por
 * completo.
 *
 * Corta desde `CREATE [OR REPLACE] FUNCTION <nombre>` hasta el `$$ LANGUAGE` que cierra
 * ese cuerpo, así que un match no puede satisfacerse con código de la función de al lado.
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

describe('HU-198 up #1 — record_debit_settle_status acepta resolving_settle', () => {
  const sql = readFileSync(UP1, 'utf8');

  it('T1: el guard de p_status incluye los 3 valores (el `IN` ampliado)', () => {
    // ESTA es la conducta que el AR pudo borrar sin romper nada.
    expect(code(sql)).toContain(
      "IF p_status NOT IN ('settled','reconciliation_pending','resolving_settle') THEN",
    );
    expect(code(sql)).toContain("RAISE EXCEPTION 'INVALID_SETTLE_STATUS: %'");
  });

  it('T2: el guard de transición sólo aplica al valor NUEVO', () => {
    // La condición tiene que estar escapada por `p_status <> 'resolving_settle'`, si no
    // endurecería también los dos valores viejos (cambio de comportamiento preexistente).
    const fn = fnBody(sql, 'record_debit_settle_status');
    expect(fn).toContain("p_status <> 'resolving_settle'");
    expect(fn).toContain(
      "OR debit_settle_status IN ('hop1_confirmed','reconciliation_pending')",
    );

    // AR#2 MNR-1(iii): candado SEMÁNTICO, no sólo de presencia. Se evalúa el predicado
    // del guard como booleano para los 3 valores posibles de `p_status` × los estados
    // relevantes, y se afirma la tabla de verdad: los dos valores VIEJOS pasan siempre
    // (comportamiento preexistente intacto) y el NUEVO sólo desde los pre-resolución.
    const guard = (pStatus: string, current: string | null) =>
      pStatus !== 'resolving_settle' ||
      current === null ||
      current === 'hop1_confirmed' ||
      current === 'reconciliation_pending';
    // El predicado de arriba tiene que ser EL MISMO que el del SQL, palabra por palabra.
    expect(fn).toContain(
      "AND ( p_status <> 'resolving_settle' OR debit_settle_status IS NULL OR debit_settle_status IN ('hop1_confirmed','reconciliation_pending') )",
    );
    for (const current of [
      null,
      'hop1_confirmed',
      'reconciliation_pending',
      'settled',
      'resolved_settled',
      'resolving_settle',
    ]) {
      // Los valores viejos NUNCA se endurecen.
      expect(guard('settled', current)).toBe(true);
      expect(guard('reconciliation_pending', current)).toBe(true);
    }
    // El valor nuevo: sólo desde los pre-resolución.
    expect(guard('resolving_settle', null)).toBe(true);
    expect(guard('resolving_settle', 'hop1_confirmed')).toBe(true);
    expect(guard('resolving_settle', 'reconciliation_pending')).toBe(true);
    expect(guard('resolving_settle', 'settled')).toBe(false);
    expect(guard('resolving_settle', 'resolved_settled')).toBe(false);
  });

  it('T3: el guard de transición vive DENTRO del UPDATE (no en un IF previo)', () => {
    const updateIdx = sql.indexOf('UPDATE a2a_payment_intent_debit_signatures');
    const guardIdx = sql.indexOf("p_status <> 'resolving_settle'");
    expect(updateIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(updateIdx);
  });

  it('T4: el ownership guard y el search_path/GRANT se conservan', () => {
    expect(code(sql)).toContain("RAISE EXCEPTION 'OWNERSHIP_MISMATCH:");
    expect(code(sql)).toContain('SET search_path = public, pg_temp');
    expect(code(sql)).toContain('FROM PUBLIC, anon, authenticated');
    expect(code(sql)).toContain('TO service_role');
  });

  it('T5: declara el gate de ORDEN DE RELEASE en el header', () => {
    // Un AR marcó la ausencia de este gate como bloqueante. El candado es textual a
    // propósito: si alguien reescribe el header sin el gate, esto se pone rojo.
    expect(sql).toMatch(/ORDEN DE RELEASE \(GATE\)/);
    expect(sql).toMatch(/\*\*ANTES\*\*/);
    // Y declara la consecuencia del orden inverso, que es lo que hace útil al gate.
    expect(sql).toMatch(/ORDEN INVERSO/);
  });

  it('T6: el down existe y restringe p_status de vuelta a 2 valores', () => {
    const down = readFileSync(DOWN1, 'utf8');
    expect(code(down)).toContain(
      "IF p_status NOT IN ('settled','reconciliation_pending') THEN",
    );
    expect(code(down)).not.toContain(
      "IF p_status NOT IN ('settled','reconciliation_pending','resolving_settle') THEN",
    );
    // Y avisa que NO revierte las filas ya escritas (reescribirlas podría doble-pagar).
    expect(down).toMatch(/NO ES UN ROLLBACK COMPLETO/);
  });
});

describe('HU-198 up #2 — applied + MNR-4 + MNR-3', () => {
  const sql = readFileSync(UP2, 'utf8');

  it('T7 (BLQ-MEDIO-2): record_debit_settle_status devuelve TABLE(applied BOOLEAN)', () => {
    // AR#2 MNR-1(i): scopeado al cuerpo de ESTA función. El archivo define dos, y
    // `GET DIAGNOSTICS` existe en las dos: sobre el archivo completo, mutar el de
    // `record_debit_settle_status` a `v_rows := 1` (⇒ `applied` SIEMPRE true, o sea el
    // candado de BLQ-MEDIO-2 anulado) dejaba el test verde.
    const fn = fnBody(sql, 'record_debit_settle_status');
    expect(fn).toContain('RETURNS TABLE(applied BOOLEAN) AS');
    // Y el valor sale del ROW_COUNT del UPDATE, no de un literal.
    expect(fn).toContain('GET DIAGNOSTICS v_rows = ROW_COUNT');
    expect(fn).toContain('applied := v_rows > 0;');
  });

  it('T8 (BLQ-MEDIO-2): hace DROP antes del CREATE (Postgres no permite cambiar el retorno)', () => {
    // Sin el DROP, `CREATE OR REPLACE` falla con "cannot change return type" y la
    // migración entera aborta.
    const dropIdx = sql.indexOf(
      'DROP FUNCTION IF EXISTS public.record_debit_settle_status',
    );
    const createIdx = sql.indexOf('CREATE FUNCTION record_debit_settle_status');
    expect(dropIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeGreaterThan(dropIdx);
    // El DROP va DENTRO de la transacción: sin eso habría una ventana sin función.
    expect(sql.indexOf('BEGIN;')).toBeLessThan(dropIdx);
  });

  it('T9 (MNR-4): el lado REFUND puede reclamar una fila resolving_settle', () => {
    expect(code(sql)).toContain(
      "OR (p_side = 'refund' AND debit_settle_status = 'resolving_settle')",
    );
  });

  it('T10 (MNR-4): el lado SETTLE sigue exigiendo tx previa (el re-envío ciego sigue cerrado)', () => {
    // La rama de re-claim conserva su condición original: sin `debit_resolution_tx_hash`
    // el lado settle NO reclama. Si alguien la relaja, vuelve el doble pago.
    const fn = fnBody(sql, 'claim_reconciliation');
    expect(fn).toContain(
      "AND (p_side = 'refund' OR debit_resolution_tx_hash IS NOT NULL)",
    );

    // AR#2 MNR-1(ii): la assertion negativa string-shaped NO alcanzaba. Agregar
    // `OR (debit_settle_status = 'resolving_settle')` SIN condición de lado la pasaba
    // (no contiene la string prohibida) y REABRÍA el re-envío ciego. Así que se afirma
    // la FORMA COMPLETA del predicado: TODA mención de `resolving_settle` dentro del
    // WHERE del claim tiene que venir acompañada de una restricción de lado en la misma
    // condición.
    const where = fn.slice(
      fn.indexOf('UPDATE a2a_payment_intent_debit_signatures'),
      fn.indexOf('GET DIAGNOSTICS'),
    );
    // Las alternativas de `resolving_settle` en el WHERE, una por `OR (...)`.
    const mentions = where.match(/[^()]*resolving_settle[^()]*/g) ?? [];
    expect(mentions.length).toBeGreaterThan(0);
    for (const alt of mentions) {
      // Cada mención está gateada por p_side, o es el `v_target` (que ya ES el lado).
      const gated =
        /p_side\s*=\s*'refund'/.test(alt) || /v_target/.test(alt);
      expect(gated, `mención sin gate de lado: ${alt}`).toBe(true);
      // Y NUNCA gateada por el lado settle.
      expect(/p_side\s*=\s*'settle'/.test(alt)).toBe(false);
    }
  });

  it('T11 (MNR-3): el UPDATE cruza el intent verificado con la fila escrita', () => {
    expect(code(sql)).toContain('AND intent_id = p_intent_id');
  });

  it('T12: conserva el guard de transición de la migración #1 (no lo pierde al reescribir)', () => {
    // La #2 reescribe la función COMPLETA, así que si alguien copia el cuerpo de 191b
    // en vez del de la #1, el guard desaparece en silencio.
    expect(code(sql)).toContain("p_status <> 'resolving_settle'");
    expect(code(sql)).toContain(
      "IF p_status NOT IN ('settled','reconciliation_pending','resolving_settle') THEN",
    );
  });

  it('T13: gate de orden de release + ownership + grants en las DOS funciones', () => {
    expect(sql).toMatch(/ORDEN DE RELEASE \(GATE\)/);
    expect(sql).toMatch(/ORDEN INVERSO/);
    // Las dos funciones re-declaran search_path y sus grants.
    expect(
      code(sql).match(/SET search_path = public, pg_temp/g)?.length,
    ).toBeGreaterThanOrEqual(2);
    expect(code(sql).match(/TO service_role/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('T14: el down revierte las DOS conductas de esta migración', () => {
    const down = readFileSync(DOWN2, 'utf8');
    // vuelve a void
    expect(code(down)).toContain('RETURNS void AS $$');
    expect(code(down)).not.toContain('RETURNS TABLE(applied BOOLEAN)');
    // saca la rama refund de MNR-4
    expect(code(down)).not.toContain(
      "OR (p_side = 'refund' AND debit_settle_status = 'resolving_settle')",
    );
    // pero CONSERVA el guard de transición de la #1 (este down no revierte esa)
    expect(code(down)).toContain("p_status <> 'resolving_settle'");
    expect(down).toMatch(/NO ES UN ROLLBACK COMPLETO/);
  });
});

// ════════════════════════════════════════════════════════════════════
// HU-198 up #3 — `current_status` (AR#2 BLQ-BAJO-1)
//
// ⚠️ ESTE BLOQUE EXISTE POR UNA MUTACIÓN QUE SOBREVIVIÓ (R3): la #3 reescribe
// `record_debit_settle_status` COMPLETA, y NINGÚN test la cubría — el archivo sólo
// verificaba la #1 y la #2. Borrarle el guard de transición dejaba los 14 tests verdes.
// Es la MISMA trampa que T12 nombra para la #2, una migración más tarde: cada migración
// que reescribe una función entera tiene que re-verificar TODO lo que esa función ya
// prometía, no sólo lo que ella agrega.
// ════════════════════════════════════════════════════════════════════
describe('HU-198 up #3 — current_status + TODO lo que la función ya prometía', () => {
  const sql = readFileSync(UP3, 'utf8');
  const fn = () => fnBody(sql, 'record_debit_settle_status');

  it('T15: devuelve TABLE(applied BOOLEAN, current_status TEXT)', () => {
    expect(fn()).toContain(
      'RETURNS TABLE(applied BOOLEAN, current_status TEXT) AS',
    );
    // `current_status` se LEE de la fila, no se deriva de `p_status` (que sería mentira
    // cuando el guard rechaza, justo el caso para el que existe).
    expect(fn()).toContain('SELECT s.debit_settle_status INTO current_status');
  });

  it('T16 (REGRESIÓN R3): conserva el guard de transición, con su tabla de verdad', () => {
    // La mutación que sobrevivió: borrar `p_status <> 'resolving_settle'` acá endurece
    // TAMBIÉN los dos valores viejos ('settled'/'reconciliation_pending' dejarían de
    // poder escribirse desde un terminal), o sea un cambio de comportamiento
    // preexistente que ninguna migración de esta HU declara.
    expect(fn()).toContain(
      "AND ( p_status <> 'resolving_settle' OR debit_settle_status IS NULL OR debit_settle_status IN ('hop1_confirmed','reconciliation_pending') )",
    );
  });

  it('T17: conserva `applied` desde ROW_COUNT y el `AND intent_id` (MNR-3)', () => {
    expect(fn()).toContain('GET DIAGNOSTICS v_rows = ROW_COUNT');
    expect(fn()).toContain('applied := v_rows > 0;');
    expect(fn()).toContain('AND intent_id = p_intent_id');
  });

  it('T18: conserva el guard de p_status (3 valores) y el ownership guard', () => {
    expect(fn()).toContain(
      "IF p_status NOT IN ('settled','reconciliation_pending','resolving_settle') THEN",
    );
    expect(fn()).toContain("RAISE EXCEPTION 'OWNERSHIP_MISMATCH:");
    expect(fn()).toContain("RAISE EXCEPTION 'INTENT_NOT_FOUND:");
  });

  it('T19: DROP antes del CREATE, dentro de la transacción', () => {
    const dropIdx = sql.indexOf(
      'DROP FUNCTION IF EXISTS public.record_debit_settle_status',
    );
    const createIdx = sql.indexOf('CREATE FUNCTION record_debit_settle_status');
    expect(dropIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeGreaterThan(dropIdx);
    expect(sql.indexOf('BEGIN;')).toBeLessThan(dropIdx);
  });

  it('T20: search_path + grants, gate de release y el runbook del schema cache (MNR-5)', () => {
    expect(code(sql)).toContain('SET search_path = public, pg_temp');
    expect(code(sql)).toContain('TO service_role');
    expect(sql).toMatch(/ORDEN DE RELEASE \(GATE\)/);
    expect(sql).toMatch(/ORDEN INVERSO/);
    // AR#2 MNR-5: la ventana del schema cache de PostgREST, nombrada y cerrada.
    expect(sql).toMatch(/PGRST202/);
    expect(code(sql)).toContain("NOTIFY pgrst, 'reload schema'");
  });

  it('T21: el down vuelve a TABLE(applied boolean) sin current_status, conservando el guard', () => {
    const down = readFileSync(DOWN3, 'utf8');
    const dfn = fnBody(down, 'record_debit_settle_status');
    expect(dfn).toContain('RETURNS TABLE(applied BOOLEAN) AS');
    expect(dfn).not.toContain('current_status');
    // No re-introduce la afirmación falsa que BLQ-BAJO-1 corrigió.
    expect(down).not.toMatch(/SIGUE auto-reclamable/);
    // Y conserva lo de las migraciones anteriores (no es un rollback de esas).
    expect(dfn).toContain("p_status <> 'resolving_settle'");
    expect(dfn).toContain('AND intent_id = p_intent_id');
  });
});
