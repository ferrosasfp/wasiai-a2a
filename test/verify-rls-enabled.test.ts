/**
 * Tests for scripts/verify-rls-enabled.mjs — WKH-SEC-02 (AC-1, AC-2, AC-4, AC-7).
 *
 * 100% mock (CD-7): NO se conecta a Supabase real ni hace fetch real. La
 * decisión (`evaluateRlsRows`) es una función pura; el SQL up/down se valida
 * leyendo el `.sql` con `readFileSync`. `process.env` no se muta aquí.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — .mjs JSDoc-typed module sin shim de tipos (no cubierto por tsconfig src-only)
import { RLS_TABLES, buildRlsQuery, evaluateRlsRows } from '../scripts/verify-rls-enabled.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, '..', 'supabase', 'migrations');
const UP_PATH = resolve(MIGRATIONS, '20260610000000_wkh_sec02c_rls_registries.sql');
const DOWN_PATH = resolve(MIGRATIONS, '20260610000000_wkh_sec02c_rls_registries_down.sql');

const TABLES: string[] = RLS_TABLES;

function allEnabled(): Array<{ table_name: string; rls_enabled: boolean }> {
  return TABLES.map((t) => ({ table_name: t, rls_enabled: true }));
}

// ───────────────────────────────────────────────────────────────────────────
// evaluateRlsRows() — decisión pura (AC-1, AC-2, AC-7, R-2)
// ───────────────────────────────────────────────────────────────────────────

describe('evaluateRlsRows()', () => {
  it('10/10 enabled → ok=true (exit 0)', () => {
    const result = evaluateRlsRows(allEnabled());
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.disabled).toEqual([]);
    expect(result.unexpected).toEqual([]);
  });

  it('una tabla false → ok=false (exit 1)', () => {
    const rows = allEnabled();
    rows[2].rls_enabled = false;
    const result = evaluateRlsRows(rows);
    expect(result.ok).toBe(false);
    expect(result.disabled).toContain(TABLES[2]);
  });

  it('tabla faltante → ok=false (exit 1)', () => {
    const rows = allEnabled().filter((r) => r.table_name !== 'a2a_receipts');
    const result = evaluateRlsRows(rows);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('a2a_receipts');
  });

  it('tabla fuera del set canónico → ok=false, unexpected (exit 1)', () => {
    // `tasks` ahora SÍ tiene owner_ref + RLS (WKH-54) → es esperada, no sirve como
    // "unexpected". Usamos una tabla sin owner_ref (`a2a_events`, telemetría global)
    // como ejemplo fuera del set canónico (CD-8).
    const rows = [...allEnabled(), { table_name: 'a2a_events', rls_enabled: true }];
    const result = evaluateRlsRows(rows);
    expect(result.ok).toBe(false);
    expect(result.unexpected).toContain('a2a_events');
  });

  it('`tasks` está en el set canónico de owner_ref (WKH-54)', () => {
    // WKH-54 agregó `owner_ref` (NOT NULL) + RLS a `tasks`; debe verificarse como
    // las demás tablas con owner_ref. Espeja la cobertura de WKH-SEC-02.
    expect(TABLES).toContain('tasks');
    const result = evaluateRlsRows(allEnabled());
    expect(result.ok).toBe(true);
  });

  it('respuesta vacía → ok=false, faltan las 10', () => {
    const result = evaluateRlsRows([]);
    expect(result.ok).toBe(false);
    expect(result.missing).toHaveLength(10);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// buildRlsQuery() — consulta exactamente las 10 tablas esperadas (AC-1)
// ───────────────────────────────────────────────────────────────────────────

describe('buildRlsQuery()', () => {
  it('consulta exactamente las 10 tablas esperadas', () => {
    expect(TABLES).toHaveLength(10);
    const query = buildRlsQuery();
    for (const t of TABLES) {
      expect(query).toContain(`'${t}'`);
    }
  });

  it('usa pg_class.relrowsecurity (no information_schema)', () => {
    const query = buildRlsQuery();
    expect(query).toContain('pg_class');
    expect(query).toContain('relrowsecurity');
    expect(query).not.toContain('information_schema');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Estructura del SQL up/down (AC-1, AC-4, AC-6, CD-5, CD-6)
// ───────────────────────────────────────────────────────────────────────────

/** Cuenta sentencias DDL reales (líneas `ALTER TABLE ... <action> ROW LEVEL SECURITY;`),
 * ignorando menciones en comentarios (no-frágil, lección WKH-121). */
function countDdlStatements(sql: string, action: 'ENABLE' | 'DISABLE'): number {
  const re = new RegExp(`ALTER TABLE\\s+public\\.\\w+\\s+${action} ROW LEVEL SECURITY;`, 'g');
  return (sql.match(re) ?? []).length;
}

describe('SQL estructural — up migration', () => {
  const sql = readFileSync(UP_PATH, 'utf8');

  it('tiene 2 ENABLE ROW LEVEL SECURITY, una por tabla (registries, kite_schema_transforms)', () => {
    expect(countDdlStatements(sql, 'ENABLE')).toBe(2);
    for (const t of ['registries', 'kite_schema_transforms']) {
      expect(sql).toContain(`ALTER TABLE public.${t}`);
      expect(sql).toMatch(new RegExp(`ALTER TABLE public\\.${t}\\s+ENABLE ROW LEVEL SECURITY;`));
    }
  });

  it('no usa FORCE ROW LEVEL SECURITY (CD-6/DT-4)', () => {
    expect(sql).not.toContain('FORCE ROW LEVEL SECURITY');
  });

  it('no crea ninguna policy (CD-5/DT-1 deny-default)', () => {
    expect(sql.toUpperCase()).not.toContain('CREATE POLICY');
  });

  it('no crea ni reemplaza funciones (CD-12)', () => {
    expect(sql.toUpperCase()).not.toContain('CREATE OR REPLACE FUNCTION');
    expect(sql.toUpperCase()).not.toContain('CREATE FUNCTION');
  });

  it('envuelve el DDL en BEGIN; ... COMMIT;', () => {
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
  });
});

describe('SQL estructural — down migration', () => {
  const sql = readFileSync(DOWN_PATH, 'utf8');

  it('tiene 2 DISABLE ROW LEVEL SECURITY, una por tabla (registries, kite_schema_transforms)', () => {
    expect(countDdlStatements(sql, 'DISABLE')).toBe(2);
    for (const t of ['registries', 'kite_schema_transforms']) {
      expect(sql).toMatch(new RegExp(`ALTER TABLE public\\.${t}\\s+DISABLE ROW LEVEL SECURITY;`));
    }
  });

  it('no necesita DROP POLICY (no se creó ninguna policy)', () => {
    expect(sql.toUpperCase()).not.toContain('DROP POLICY');
  });

  it('envuelve el DDL en BEGIN; ... COMMIT;', () => {
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
  });
});
