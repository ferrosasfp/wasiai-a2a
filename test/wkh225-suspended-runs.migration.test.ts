/**
 * SQL-estructural — WKH-225 migración a2a_suspended_runs.
 *
 * 100% mock (readFileSync sobre el .sql): NO se conecta a Supabase real.
 * Verifica que la tabla tenga RLS deny-by-default (ENABLE ROW LEVEL SECURITY,
 * sin CREATE POLICY), el CHECK de los 5 estados, el trigger que escribe
 * `expires_at` del lado de POSTGRES, y la firma exacta de los 2 RPC en el down.
 *
 * NO se agrega `a2a_suspended_runs` al set canónico RLS_TABLES de
 * `verify-rls-enabled.test.ts` (ripplearía el conteo `toHaveLength(10)`, fuera
 * de scope). Este bloque es aislado, igual que el de `agent-links.migration`.
 *
 * ⚠️ LO QUE ESTE ARCHIVO NO PUEDE DECIR. Lee TEXTO, no ejecuta SQL: prueba que
 * el guard está ESCRITO, no que Postgres lo haga cumplir. Que el orden de los
 * guards del claim sea el correcto lo prueba acá la secuencia de literales; que
 * ese orden PRODUZCA un 404 indistinguible lo prueban los tests del service.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, '..', 'supabase', 'migrations');
const UP = resolve(MIGRATIONS, '20260823000000_wkh225_suspended_runs.sql');
const DOWN = resolve(
  MIGRATIONS,
  '20260823000000_wkh225_suspended_runs_down.sql',
);

describe('T-MIG · up migration (a2a_suspended_runs)', () => {
  const sql = readFileSync(UP, 'utf8');

  it('T-MIG-1: RLS deny-by-default, ENABLE ROW LEVEL SECURITY sin CREATE POLICY', () => {
    expect(sql).toMatch(
      /ALTER TABLE a2a_suspended_runs\s+ENABLE ROW LEVEL SECURITY;/,
    );
    expect(sql.toUpperCase()).not.toContain('CREATE POLICY');
    expect(sql).not.toContain('FORCE ROW LEVEL SECURITY');
  });

  it('T-MIG-2: CHECK del status con los 5 estados, `expired` incluido', () => {
    expect(sql).toContain(
      "CHECK (status IN ('suspended','resuming','resumed','failed','expired'))",
    );
  });

  it('T-MIG-3: token_hash UNIQUE (btree O(1), sin índice extra)', () => {
    expect(sql).toMatch(/token_hash\s+TEXT NOT NULL UNIQUE/);
    expect(sql).not.toMatch(
      /CREATE INDEX .* ON a2a_suspended_runs \(token_hash\)/,
    );
  });

  it('T-MIG-4: los 2 RPC son SECURITY DEFINER con FOR UPDATE + hardening', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION claim_suspended_run');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION settle_suspended_run');
    expect((sql.match(/SECURITY DEFINER/g) ?? []).length).toBe(2);
    // 2 SELECT ... FOR UPDATE; REALES (con el terminador `;`): los comentarios
    // mencionan "FOR UPDATE" sin punto y coma, y ésa es la trampa que el
    // exemplar de agent-links documenta.
    expect((sql.match(/FOR UPDATE;/g) ?? []).length).toBe(2);
    expect(sql).toContain('SET search_path = public, pg_temp');
    expect(sql).toContain('FROM PUBLIC, anon, authenticated');
    expect(sql).toContain('TO service_role');
  });

  it('T-RUN-2 (SQL): el claim levanta el MISMO literal en "no existe" y en "otro dueño"', () => {
    // AC-6: 404 disclosure-safe. Lo que lo hace disclosure-safe DE VERDAD es
    // que los dos caminos griten IDÉNTICO. Si uno dijera OWNERSHIP_MISMATCH, el
    // atacante aprendería que el run existe.
    expect(sql).toContain('v_owner IS DISTINCT FROM p_owner_ref');
    const claim = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION claim_suspended_run'),
      sql.indexOf('CREATE OR REPLACE FUNCTION settle_suspended_run'),
    );
    expect(claim.length).toBeGreaterThan(0);
    // Exactamente DOS raises de "no existe" dentro del claim: el de NOT FOUND y
    // el del dueño ajeno. Y ninguno de OWNERSHIP_MISMATCH.
    expect((claim.match(/RAISE EXCEPTION 'RUN_NOT_FOUND'/g) ?? []).length).toBe(
      2,
    );
    expect(claim).not.toContain('OWNERSHIP_MISMATCH');
    // ⛔ CD-8: el token NUNCA entra a un mensaje de error.
    expect(claim).not.toMatch(/RAISE EXCEPTION '[^']*', p_token_hash/);
  });

  it('T-MIG-5: el vencido se marca `expired` EN LA MISMA transacción que el raise', () => {
    // AC-7 pide EXACTAMENTE UN residuo. Eso sale de que la transición y el
    // raise vayan juntos: la fila sólo puede pasar suspended→expired una vez, y
    // el segundo intento cae en el guard de "ya usado".
    const claim = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION claim_suspended_run'),
      sql.indexOf('CREATE OR REPLACE FUNCTION settle_suspended_run'),
    );
    const expiredGuard = claim.indexOf(
      "IF v_status = 'suspended' AND NOW() >= v_expires THEN",
    );
    const marcaExpired = claim.indexOf("SET status = 'expired'");
    const raiseExpired = claim.indexOf("RAISE EXCEPTION 'RUN_EXPIRED'");
    const yaUsado = claim.indexOf("RAISE EXCEPTION 'RUN_ALREADY_USED'");
    expect(expiredGuard).toBeGreaterThan(-1);
    expect(marcaExpired).toBeGreaterThan(expiredGuard);
    expect(raiseExpired).toBeGreaterThan(marcaExpired);
    expect(yaUsado).toBeGreaterThan(raiseExpired);
  });

  it('T-MIG-6: el status-gate exactly-once del settle', () => {
    expect(sql).toContain("IF v_status <> 'resuming' THEN");
  });

  it('T-MIG-7 (CD-19): `expires_at` lo escribe POSTGRES, y `Date.now` no aparece', () => {
    expect(sql).toContain(
      'NEW.expires_at := now() + make_interval(secs => NEW.ttl_seconds)',
    );
    expect(sql).toContain('BEFORE INSERT ON a2a_suspended_runs');
    // La LECTURA compara los dos lados contra el reloj de Postgres.
    expect(sql).toContain('NOW() >= v_expires');
    // Y no hay ni un solo reloj de Node en todo el archivo.
    expect(sql).not.toContain('Date.now');
    expect(sql).not.toContain('new Date(');
  });

  it('T-MIG-8 (CD-15): el LEAST contra el vencimiento del quote se toma en Postgres', () => {
    expect(sql).toContain('frozen_prices_expires_at');
    expect(sql).toContain(
      'NEW.expires_at := LEAST(NEW.expires_at, NEW.frozen_prices_expires_at)',
    );
  });

  it('T-MIG-9 (CD-17): las 3 columnas de la traza anti-bucle existen', () => {
    // Sin ellas la reanudación arrancaría con profundidad 0 y conjunto de
    // identidad vacío, o sea un bypass del guard que esta HU abriría.
    expect(sql).toMatch(/contracting_chain\s+JSONB/);
    expect(sql).toMatch(/contracting_depth\s+INT NOT NULL DEFAULT 0/);
    expect(sql).toMatch(/self_host_hint\s+TEXT/);
  });

  it('T-MIG-10: el rango del TTL lo hace cumplir la BASE', () => {
    expect(sql).toContain('CHECK (ttl_seconds BETWEEN 181 AND 86400)');
  });

  it('T-MIG-11: la fila apunta a una key real y se va con ella', () => {
    expect(sql).toContain(
      'key_id                   UUID NOT NULL REFERENCES a2a_agent_keys(id) ON DELETE CASCADE',
    );
    expect(sql).toContain(
      "caller_kind              TEXT NOT NULL CHECK (caller_kind IN ('key','session','delegation'))",
    );
  });
});

describe('T-MIG · down migration (a2a_suspended_runs)', () => {
  const sql = readFileSync(DOWN, 'utf8');

  it('T-MIG-12: DROP FUNCTION con tipos exactos + DROP TABLE en BEGIN;…COMMIT;', () => {
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
    expect(sql).toContain(
      'DROP FUNCTION IF EXISTS settle_suspended_run(uuid, text, text, text);',
    );
    expect(sql).toContain(
      'DROP FUNCTION IF EXISTS claim_suspended_run(text, text);',
    );
    expect(sql).toContain(
      'DROP FUNCTION IF EXISTS trigger_set_suspended_run_expires_at();',
    );
    expect(sql).toContain('DROP TABLE IF EXISTS a2a_suspended_runs;');
  });

  it('T-MIG-13: NO dropea `trigger_set_updated_at`, que es compartida', () => {
    // Es la misma función que usan a2a_agent_links y a2a_payment_intents:
    // dropearla acá se llevaría puesto el `updated_at` de otras dos tablas.
    expect(sql).not.toContain('DROP FUNCTION IF EXISTS trigger_set_updated_at');
  });
});
