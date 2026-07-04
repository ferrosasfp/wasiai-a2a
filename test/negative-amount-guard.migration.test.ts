/**
 * SQL-estructural — WKH-142 guard de importe negativo en el money-path.
 *
 * 100% mock (readFileSync sobre el .sql): el repo NO tiene Postgres in-process.
 * Verifica: (T1/AC-1) el guard INVALID_AMOUNT dentro de increment_a2a_key_spend
 * ANTES del UPDATE; (T3/AC-2) INVALID_AMOUNT aparece exactamente 1 vez y los 3
 * RPC hermanos NO se redefinen; (T5/AC-4) el clamp precede al constraint;
 * (T6/AC-5) el constraint declarado en el UP + DROP en el down. La verificación
 * de comportamiento real (23514 al insertar -1) es responsabilidad de F4 sobre
 * Postgres efímero.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, '..', 'supabase', 'migrations');
const UP = resolve(
  MIGRATIONS,
  '20260707000000_wkh142_negative_amount_guard.sql',
);
const DOWN = resolve(
  MIGRATIONS,
  '20260707000000_wkh142_negative_amount_guard_down.sql',
);

describe('SQL estructural — up migration (WKH-142 negative amount guard)', () => {
  const sql = readFileSync(UP, 'utf8');

  it('T1 (AC-1): guard NULL / < 0 / NaN + RAISE INVALID_AMOUNT, ANTES del UPDATE', () => {
    // El guard existe con el literal correcto de NaN (DT-3: = "NaN"::numeric,
    // NO el truco IEEE x<>x que en Postgres numeric no detecta).
    expect(sql).toMatch(
      /IF p_amount_usd IS NULL OR p_amount_usd < 0 OR p_amount_usd = 'NaN'::numeric THEN/,
    );
    expect(sql).toContain("RAISE EXCEPTION 'INVALID_AMOUNT:");
    // El guard queda dentro de increment_a2a_key_spend.
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION increment_a2a_key_spend',
    );
    // AC-1: el guard (path de rechazo sin mutación) precede al UPDATE del budget.
    const guardIdx = sql.indexOf("RAISE EXCEPTION 'INVALID_AMOUNT:");
    const updateIdx = sql.indexOf('UPDATE a2a_agent_keys');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(updateIdx);
  });

  it('T1 (DT-3): NO usa el truco IEEE x <> x para NaN', () => {
    expect(sql).not.toMatch(/p_amount_usd\s*<>\s*p_amount_usd/);
  });

  it('T3 (AC-2 / CD-7): INVALID_AMOUNT aparece exactamente 1 vez (choke-point único)', () => {
    expect((sql.match(/INVALID_AMOUNT/g) ?? []).length).toBe(1);
  });

  it('T3 (CD-2): los 3 RPC hermanos debit_* NO se redefinen', () => {
    expect(sql).not.toContain(
      'CREATE OR REPLACE FUNCTION debit_with_dest_policy',
    );
    expect(sql).not.toContain(
      'CREATE OR REPLACE FUNCTION debit_session_and_parent',
    );
    expect(sql).not.toContain(
      'CREATE OR REPLACE FUNCTION debit_delegation_and_parent',
    );
  });

  it('CD-2: refund_* NO se tocan en el UP', () => {
    expect(sql).not.toContain('refund_a2a_key_spend');
    expect(sql).not.toContain('refund_with_dest_policy');
    expect(sql).not.toContain('refund_delegation_and_parent');
    expect(sql).not.toContain('refund_session_and_parent');
  });

  it('CD-4: hardening (search_path + REVOKE + GRANT) re-aplicado al recrear la función', () => {
    expect(sql).toContain('SET search_path = public, pg_temp');
    expect(sql).toContain('FROM PUBLIC, anon, authenticated');
    expect(sql).toContain('TO service_role');
  });

  it('CD-1: NO hay DROP de increment_a2a_key_spend (la aridad no cambia)', () => {
    expect(sql).not.toMatch(/DROP FUNCTION[^;]*increment_a2a_key_spend/);
  });

  it('T5 (AC-4 / CD-3): el clamp UPDATE precede al ADD CONSTRAINT en la misma tx', () => {
    const clampIdx = sql.indexOf(
      'UPDATE public.a2a_agents SET price_usdc = 0 WHERE price_usdc < 0',
    );
    const constraintIdx = sql.indexOf(
      'ADD CONSTRAINT a2a_agents_price_usdc_nonneg',
    );
    expect(clampIdx).toBeGreaterThan(-1);
    expect(constraintIdx).toBeGreaterThan(-1);
    expect(clampIdx).toBeLessThan(constraintIdx);
    // Misma tx (BEGIN/COMMIT).
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
  });

  it('T6 (AC-5): declara el CHECK (price_usdc >= 0)', () => {
    expect(sql).toContain(
      'ADD CONSTRAINT a2a_agents_price_usdc_nonneg CHECK (price_usdc >= 0',
    );
  });

  it("MNR-1: el CHECK rechaza NaN (<> 'NaN'::numeric) — simetría con el guard RPC", () => {
    // En Postgres 'NaN' >= 0 es true, así que el CHECK debe excluir NaN explícito.
    expect(sql).toContain(
      "ADD CONSTRAINT a2a_agents_price_usdc_nonneg CHECK (price_usdc >= 0 AND price_usdc <> 'NaN'::numeric)",
    );
    // El clamp también limpia NaN preexistente antes del constraint.
    expect(sql).toContain(
      "UPDATE public.a2a_agents SET price_usdc = 0 WHERE price_usdc < 0 OR price_usdc = 'NaN'::numeric",
    );
  });
});

describe('SQL estructural — down migration (WKH-142 negative amount guard)', () => {
  const sql = readFileSync(DOWN, 'utf8');

  it('T6: DROP CONSTRAINT IF EXISTS del check', () => {
    expect(sql).toContain(
      'DROP CONSTRAINT IF EXISTS a2a_agents_price_usdc_nonneg',
    );
  });

  it('restaura increment_a2a_key_spend SIN el guard INVALID_AMOUNT', () => {
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION increment_a2a_key_spend',
    );
    expect(sql).not.toContain('INVALID_AMOUNT');
    // Hardening preservado en el down.
    expect(sql).toContain('SET search_path = public, pg_temp');
    expect(sql).toContain('TO service_role');
  });
});
