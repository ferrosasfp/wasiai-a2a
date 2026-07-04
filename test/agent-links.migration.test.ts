/**
 * SQL-estructural — WKH-137 migración a2a_agent_links (test 14, RIESGO-6).
 *
 * 100% mock (readFileSync sobre el .sql): NO se conecta a Supabase real. Verifica
 * que la tabla tenga RLS deny-by-default (ENABLE ROW LEVEL SECURITY, sin CREATE
 * POLICY) + el CHECK del status + la firma exacta de los 2 RPC en el down.
 *
 * NO se agrega `a2a_agent_links` al set canónico RLS_TABLES de
 * verify-rls-enabled.test.ts (ripplearía el conteo `toHaveLength(10)`, fuera de
 * scope). Este bloque es aislado (patrón del bloque "SQL estructural — up migration").
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, '..', 'supabase', 'migrations');
const UP = resolve(MIGRATIONS, '20260706000000_wkh137_agent_links.sql');
const DOWN = resolve(MIGRATIONS, '20260706000000_wkh137_agent_links_down.sql');

describe('SQL estructural — up migration (a2a_agent_links)', () => {
  const sql = readFileSync(UP, 'utf8');

  it('RLS deny-by-default: ENABLE ROW LEVEL SECURITY sin CREATE POLICY', () => {
    expect(sql).toMatch(
      /ALTER TABLE a2a_agent_links\s+ENABLE ROW LEVEL SECURITY;/,
    );
    expect(sql.toUpperCase()).not.toContain('CREATE POLICY');
    expect(sql).not.toContain('FORCE ROW LEVEL SECURITY');
  });

  it('CHECK del status con los 4 estados válidos', () => {
    expect(sql).toContain(
      "CHECK (status IN ('open','redeeming','redeemed','failed'))",
    );
  });

  it('token_hash UNIQUE (btree O(1), sin índice extra — CD-12)', () => {
    expect(sql).toMatch(/token_hash\s+TEXT NOT NULL UNIQUE/);
    expect(sql).not.toMatch(/CREATE INDEX .* ON a2a_agent_links \(token_hash\)/);
  });

  it('los 2 RPC son SECURITY DEFINER con FOR UPDATE + hardening', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION claim_agent_link');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION settle_agent_link');
    expect((sql.match(/SECURITY DEFINER/g) ?? []).length).toBe(2);
    // 2 SELECT ... FOR UPDATE; reales (statement terminator; los comentarios
    // mencionan "FOR UPDATE" sin `;`).
    expect((sql.match(/FOR UPDATE;/g) ?? []).length).toBe(2);
    expect(sql).toContain('SET search_path = public, pg_temp');
    expect(sql).toContain('FROM PUBLIC, anon, authenticated');
    expect(sql).toContain('TO service_role');
    // Ownership Guard DB-level en settle (variable local v_owner, patrón wkh135).
    expect(sql).toContain('v_owner IS DISTINCT FROM p_owner_ref');
    // status-gate exactly-once en settle.
    expect(sql).toContain("IF v_status <> 'redeeming' THEN");
  });
});

describe('SQL estructural — down migration (a2a_agent_links)', () => {
  const sql = readFileSync(DOWN, 'utf8');

  it('DROP FUNCTION con tipos exactos + DROP TABLE en BEGIN;…COMMIT; (CD-11)', () => {
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
    expect(sql).toContain(
      'DROP FUNCTION IF EXISTS settle_agent_link(uuid, text, text, text, numeric, text);',
    );
    expect(sql).toContain(
      'DROP FUNCTION IF EXISTS claim_agent_link(text);',
    );
    expect(sql).toContain('DROP TABLE IF EXISTS a2a_agent_links;');
  });
});
