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
const DOWN2 = resolve(
  MIGRATIONS,
  '20260728010000_hu198_settle_status_applied_down.sql',
);

/** Normaliza espacios para poder matchear SQL multilinea sin pelear con el formato. */
const flat = (s: string) => s.replace(/\s+/g, ' ');

describe('HU-198 up #1 — record_debit_settle_status acepta resolving_settle', () => {
  const sql = readFileSync(UP1, 'utf8');

  it('T1: el guard de p_status incluye los 3 valores (el `IN` ampliado)', () => {
    // ESTA es la conducta que el AR pudo borrar sin romper nada.
    expect(flat(sql)).toContain(
      "IF p_status NOT IN ('settled','reconciliation_pending','resolving_settle') THEN",
    );
    expect(sql).toContain("RAISE EXCEPTION 'INVALID_SETTLE_STATUS: %'");
  });

  it('T2: el guard de transición sólo aplica al valor NUEVO', () => {
    // La condición tiene que estar escapada por `p_status <> 'resolving_settle'`, si no
    // endurecería también los dos valores viejos (cambio de comportamiento preexistente).
    expect(flat(sql)).toContain("p_status <> 'resolving_settle'");
    expect(flat(sql)).toContain(
      "OR debit_settle_status IN ('hop1_confirmed','reconciliation_pending')",
    );
  });

  it('T3: el guard de transición vive DENTRO del UPDATE (no en un IF previo)', () => {
    const updateIdx = sql.indexOf('UPDATE a2a_payment_intent_debit_signatures');
    const guardIdx = sql.indexOf("p_status <> 'resolving_settle'");
    expect(updateIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(updateIdx);
  });

  it('T4: el ownership guard y el search_path/GRANT se conservan', () => {
    expect(sql).toContain("RAISE EXCEPTION 'OWNERSHIP_MISMATCH:");
    expect(sql).toContain('SET search_path = public, pg_temp');
    expect(sql).toContain('FROM PUBLIC, anon, authenticated');
    expect(sql).toContain('TO service_role');
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
    expect(flat(down)).toContain(
      "IF p_status NOT IN ('settled','reconciliation_pending') THEN",
    );
    expect(flat(down)).not.toContain(
      "IF p_status NOT IN ('settled','reconciliation_pending','resolving_settle') THEN",
    );
    // Y avisa que NO revierte las filas ya escritas (reescribirlas podría doble-pagar).
    expect(down).toMatch(/NO ES UN ROLLBACK COMPLETO/);
  });
});

describe('HU-198 up #2 — applied + MNR-4 + MNR-3', () => {
  const sql = readFileSync(UP2, 'utf8');

  it('T7 (BLQ-MEDIO-2): record_debit_settle_status devuelve TABLE(applied BOOLEAN)', () => {
    expect(flat(sql)).toContain(
      'RETURNS TABLE(applied BOOLEAN) AS $$'.replace(/\s+/g, ' '),
    );
    // Y el valor sale del ROW_COUNT del UPDATE, no de un literal.
    expect(sql).toContain('GET DIAGNOSTICS v_rows = ROW_COUNT');
    expect(flat(sql)).toContain('applied := v_rows > 0;');
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
    expect(flat(sql)).toContain(
      "OR (p_side = 'refund' AND debit_settle_status = 'resolving_settle')",
    );
  });

  it('T10 (MNR-4): el lado SETTLE sigue exigiendo tx previa (el re-envío ciego sigue cerrado)', () => {
    // La rama de re-claim conserva su condición original: sin `debit_resolution_tx_hash`
    // el lado settle NO reclama. Si alguien la relaja, vuelve el doble pago.
    expect(flat(sql)).toContain(
      "AND (p_side = 'refund' OR debit_resolution_tx_hash IS NOT NULL)",
    );
    // Contra-chequeo: NO existe una rama que le deje al settle reclamar resolving_settle.
    expect(flat(sql)).not.toContain(
      "OR (p_side = 'settle' AND debit_settle_status = 'resolving_settle')",
    );
  });

  it('T11 (MNR-3): el UPDATE cruza el intent verificado con la fila escrita', () => {
    expect(flat(sql)).toContain('AND intent_id = p_intent_id');
  });

  it('T12: conserva el guard de transición de la migración #1 (no lo pierde al reescribir)', () => {
    // La #2 reescribe la función COMPLETA, así que si alguien copia el cuerpo de 191b
    // en vez del de la #1, el guard desaparece en silencio.
    expect(flat(sql)).toContain("p_status <> 'resolving_settle'");
    expect(flat(sql)).toContain(
      "IF p_status NOT IN ('settled','reconciliation_pending','resolving_settle') THEN",
    );
  });

  it('T13: gate de orden de release + ownership + grants en las DOS funciones', () => {
    expect(sql).toMatch(/ORDEN DE RELEASE \(GATE\)/);
    expect(sql).toMatch(/ORDEN INVERSO/);
    // Las dos funciones re-declaran search_path y sus grants.
    expect(
      sql.match(/SET search_path = public, pg_temp/g)?.length,
    ).toBeGreaterThanOrEqual(2);
    expect(sql.match(/TO service_role/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('T14: el down revierte las DOS conductas de esta migración', () => {
    const down = readFileSync(DOWN2, 'utf8');
    // vuelve a void
    expect(flat(down)).toContain('RETURNS void AS $$');
    expect(flat(down)).not.toContain('RETURNS TABLE(applied BOOLEAN)');
    // saca la rama refund de MNR-4
    expect(flat(down)).not.toContain(
      "OR (p_side = 'refund' AND debit_settle_status = 'resolving_settle')",
    );
    // pero CONSERVA el guard de transición de la #1 (este down no revierte esa)
    expect(flat(down)).toContain("p_status <> 'resolving_settle'");
    expect(down).toMatch(/NO ES UN ROLLBACK COMPLETO/);
  });
});
