/**
 * WKH-314 — tests estructurales de la migración del uso único inbound. T-MIG-01..08.
 *
 * 100% mock (`readFileSync` sobre los `.sql`): el repo NO tiene Postgres in-process.
 *
 * ── POR QUE ESTA SUITE NO ES OPCIONAL ──────────────────────────────────────
 *
 * Sin `T-MIG-01` la HU podría shipear con **el uso único ausente** —una tabla sin PK,
 * o con la PK sobre otra cosa— y **todo lo demás verde**: el seam funciona, los tests
 * del seam pasan, el handler concede… y cada firma compra servicio para siempre. La
 * defensa entera de esta HU es una restricción de Postgres, y esto es lo único que la
 * mira.
 *
 * ── Y TODA AFIRMACION DE CONDUCTA USA `code()` ─────────────────────────────
 *
 * El sql CRUDO incluye la cabecera, y la cabecera DESCRIBE en prosa lo mismo que el
 * cuerpo hace ("PK sobre (caip2, signature)", "TEXT, NUNCA NUMERIC", "RENAME, NUNCA
 * DROP"). Un match contra el texto completo se satisface con el COMENTARIO: verificaría
 * que la migración se *describa*, no que *haga*.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, '..', 'supabase', 'migrations');
const UP = resolve(MIGRATIONS, '20260819000000_wkh314_solana_inbound_proofs.sql');
const DOWN = resolve(MIGRATIONS, '20260819000000_wkh314_solana_inbound_proofs_down.sql');

const flat = (s: string) => s.replace(/\s+/g, ' ');

/** SQL con los COMENTARIOS QUITADOS. Ver la cabecera. */
const code = (s: string) =>
  flat(
    s
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n'),
  );

const upSql = readFileSync(UP, 'utf8');
const downSql = readFileSync(DOWN, 'utf8');
const upCode = code(upSql);
const downCode = code(downSql);

describe('WKH-314 · migración del uso único inbound', () => {
  it('T-MIG-01 💰 · el uso único EXISTE y es una PRIMARY KEY sobre (caip2, signature)', () => {
    expect(upCode).toContain('PRIMARY KEY (caip2, signature)');
    // Y no está escondido como un índice UNIQUE que un `ON CONFLICT` no podría usar
    // como árbitro: `ON CONFLICT (caip2, signature)` exige la restricción.
    expect(upCode).toContain('ON CONFLICT (caip2, signature) DO UPDATE');
  });

  it('T-MIG-02 💰 · `amount_atomic` es TEXT y NO NUMERIC (WKH-196)', () => {
    expect(upCode).toMatch(/amount_atomic\s+TEXT\s+NOT NULL/);
    expect(upCode).not.toMatch(/amount_atomic\s+NUMERIC/i);
  });

  it('T-MIG-03 · la tabla está cerrada: REVOKE ALL + GRANT sólo a `service_role`', () => {
    expect(upCode).toContain(
      'REVOKE ALL ON public.a2a_solana_inbound_proofs FROM PUBLIC, anon, authenticated',
    );
    expect(upCode).toContain(
      'GRANT SELECT, INSERT, UPDATE ON public.a2a_solana_inbound_proofs TO service_role',
    );
    // Ningún GRANT a un rol público sobre la tabla ni sobre sus funciones.
    expect(upCode).not.toMatch(/GRANT[^;]*TO (PUBLIC|anon|authenticated)/i);
  });

  it('T-MIG-04 · las 3 funciones tienen `search_path` FIJO (SECURITY DEFINER sin eso es escalable)', () => {
    for (const fn of [
      'record_solana_inbound_observed',
      'consume_solana_inbound_proof',
      'peek_solana_inbound_proof',
    ]) {
      expect(upCode, fn).toContain(`ALTER FUNCTION public.${fn}(`);
      expect(upCode, fn).toMatch(
        new RegExp(`ALTER FUNCTION public\\.${fn}\\([^)]*\\) SET search_path = public, pg_temp`),
      );
      expect(upCode, fn).toMatch(new RegExp(`REVOKE EXECUTE ON FUNCTION public\\.${fn}\\(`));
    }
    // Las tres son SECURITY DEFINER (si no, el REVOKE de la tabla las rompería).
    expect((upCode.match(/LANGUAGE plpgsql SECURITY DEFINER/g) ?? []).length).toBe(3);
  });

  it('T-MIG-05 💰 · el `up` trae el GATE de re-hidratación EJECUTABLE, y mira `consumed`', () => {
    // No es prosa en un runbook: es un `DO $$` que ABORTA. Re-aplicar el up sobre una
    // tabla vacía volvería gastable cada firma ya cobrada.
    expect(upCode).toContain('RAISE EXCEPTION');
    expect(upCode).toContain('WKH314_BACKUP_NOT_REHYDRATED');
    expect(upCode).toContain('a2a_solana_inbound_proofs_backup_wkh314');
    // Lo que cuenta son las CONSUMIDAS: son las que, perdidas, regalan servicio.
    expect(upCode).toMatch(/count\(\*\) FROM public\.a2a_solana_inbound_proofs_backup_wkh314 WHERE status = ''consumed''/);
    // Y el gate va ANTES de crear la tabla: después no serviría de nada.
    expect(upCode.indexOf('WKH314_BACKUP_NOT_REHYDRATED')).toBeLessThan(
      upCode.indexOf('CREATE TABLE IF NOT EXISTS public.a2a_solana_inbound_proofs'),
    );
  });

  it('T-MIG-06 💰 · el `_down` RENOMBRA, nunca `DROP TABLE`', () => {
    expect(downCode).toContain(
      'ALTER TABLE IF EXISTS public.a2a_solana_inbound_proofs RENAME TO a2a_solana_inbound_proofs_backup_wkh314',
    );
    expect(downCode).not.toMatch(/DROP TABLE/i);
  });

  it('T-MIG-07 · el probe POSITIVO es la PRIMERA sentencia de la función', () => {
    // Recibir la excepción demuestra que la función deployada es la nueva SIN tocar una
    // fila. Si el RAISE estuviera después del SELECT, el probe dejaría de ser gratis y,
    // peor, dejaría de probar lo que dice probar.
    const fnAt = upCode.indexOf('CREATE OR REPLACE FUNCTION public.peek_solana_inbound_proof');
    expect(fnAt).toBeGreaterThan(-1);
    const body = upCode.slice(fnAt);
    const raiseAt = body.indexOf("RAISE EXCEPTION 'WKH314_PROBE_OK'");
    const selectAt = body.indexOf('SELECT TRUE, t.status');
    expect(raiseAt).toBeGreaterThan(-1);
    expect(raiseAt).toBeLessThan(selectAt);
  });

  it('T-MIG-08 💰 · el consumo sólo aplica sobre una fila `observed` y con LOS TERMINOS iguales', () => {
    const fnAt = upCode.indexOf('CREATE OR REPLACE FUNCTION public.consume_solana_inbound_proof');
    const body = upCode.slice(fnAt, upCode.indexOf('$$ LANGUAGE plpgsql SECURITY DEFINER', fnAt));
    // La transición es UNA sola sentencia condicional: sin `status = 'observed'` en el
    // WHERE, dos requests concurrentes ganan los dos.
    expect(body).toContain("SET status = 'consumed'");
    expect(body).toContain("AND t.status = 'observed'");
    for (const col of ['t.reference', 't.resource', 't.pay_to', 't.amount_atomic', 't.mint']) {
      expect(body, col).toContain(`AND ${col} =`);
    }
  });

  it('T-MIG-09 · ninguna de las 3 funciones devuelve un BOOLEAN pelado', () => {
    // Un `false` colapsaría "ya se cobró" / "otros términos" / "el store no está".
    expect(upCode).not.toMatch(/RETURNS BOOLEAN/i);
    expect((upCode.match(/RETURNS TABLE\(/g) ?? []).length).toBe(3);
  });

  it('T-MIG-10 · la tabla NO lleva `owner_ref` (decisión declarada, no olvido)', () => {
    // En el camino x402 puro no hay identidad de caller. Agregarle `owner_ref` metería
    // la tabla al universo del `ownership-filter-guard` y exigiría un filtro que no
    // tiene con qué llenarse.
    const tableAt = upCode.indexOf('CREATE TABLE IF NOT EXISTS public.a2a_solana_inbound_proofs');
    const tableBody = upCode.slice(tableAt, upCode.indexOf(');', tableAt));
    expect(tableBody).not.toContain('owner_ref');
  });

  it('T-MIG-11 · el `up` y el `_down` son transaccionales', () => {
    expect(upCode.trim().startsWith('BEGIN;')).toBe(true);
    expect(upCode.trim().endsWith('COMMIT;')).toBe(true);
    expect(downCode.trim().startsWith('BEGIN;')).toBe(true);
    expect(downCode.trim().endsWith('COMMIT;')).toBe(true);
  });
});
