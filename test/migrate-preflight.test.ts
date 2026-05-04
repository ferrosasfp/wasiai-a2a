/// <reference path="./types/migrate-preflight.d.ts" />
/**
 * Tests for scripts/migrate-preflight.mjs — WKH-78 (AC-6) + WKH-86.
 *
 * Pure unit tests with 100% mocks (CD-6). NEVER connects to a real Supabase
 * project (prod or shadow) — `spawnSync` is replaced via dependency injection
 * on `runShadowDryRun` / `runPostApplyCheck`, and `process.env` is restored
 * after each test.
 *
 * WKH-86 AC-7: the prior `// @ts-expect-error` was replaced by a typed
 * module declaration shim at `test/types/migrate-preflight.d.ts`, loaded
 * via the triple-slash reference directive above. This gives the test
 * file proper types for the `.mjs` import without bypassing the type
 * checker.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  analyze,
  hasHighRisk,
  stripComments,
  stripStringLiterals,
  splitStatements,
  buildDryRunPayload,
  buildPsqlConnectionEnv,
  isIdempotentDropTriggerOrFunction,
  dedupeByLineAndLevel,
  findDeleteWithoutWhere,
  runShadowDryRun,
  runPostApplyCheck,
  decide,
  formatFindings,
  POST_APPLY_QUERIES,
  EXPECTED_A2A_TABLES,
  main,
} from '../scripts/migrate-preflight.mjs';

// ───────────────────────────────────────────────────────────────────────────
// Static analysis (AC-1, AC-6)
// ───────────────────────────────────────────────────────────────────────────

describe('analyze() — static SQL analysis', () => {
  it('detects DROP TABLE as HIGH risk', () => {
    const findings = analyze('DROP TABLE legacy_users;');
    expect(findings.some((f) => f.op === 'DROP TABLE' && f.level === 'HIGH')).toBe(true);
  });

  it('detects DROP COLUMN as HIGH risk with line number', () => {
    const sql = '-- header comment\nALTER TABLE accounts DROP COLUMN legacy_field;\n';
    const findings = analyze(sql);
    const drop = findings.find((f) => f.op === 'DROP COLUMN');
    expect(drop).toBeDefined();
    expect(drop?.level).toBe('HIGH');
    expect(drop?.line).toBe(2);
  });

  it('detects DROP INDEX as HIGH risk', () => {
    const findings = analyze('DROP INDEX idx_users_email;');
    expect(findings.some((f) => f.op === 'DROP INDEX' && f.level === 'HIGH')).toBe(true);
  });

  it('detects TRUNCATE as HIGH risk', () => {
    const findings = analyze('TRUNCATE event_log;');
    expect(findings.some((f) => f.op === 'TRUNCATE' && f.level === 'HIGH')).toBe(true);
  });

  it('detects ALTER TABLE ... RENAME TO as HIGH risk', () => {
    const findings = analyze('ALTER TABLE old_name RENAME TO new_name;');
    expect(findings.some((f) => f.op === 'RENAME TO' && f.level === 'HIGH')).toBe(true);
  });

  it('detects DELETE FROM without WHERE as HIGH risk', () => {
    const findings = analyze('DELETE FROM events;');
    const del = findings.find((f) => f.op === 'DELETE without WHERE');
    expect(del).toBeDefined();
    expect(del?.level).toBe('HIGH');
  });

  it('does NOT flag DELETE FROM ... WHERE clause', () => {
    const findings = analyze("DELETE FROM events WHERE created_at < NOW() - INTERVAL '7 days';");
    expect(findings.some((f) => f.op === 'DELETE without WHERE')).toBe(false);
  });

  it('does NOT flag CREATE TABLE / CREATE INDEX / INSERT / UPDATE', () => {
    const sql = `
      CREATE TABLE foo (id UUID PRIMARY KEY);
      CREATE INDEX idx_foo_id ON foo(id);
      INSERT INTO foo (id) VALUES (gen_random_uuid());
      UPDATE foo SET id = id WHERE id IS NOT NULL;
    `;
    const findings = analyze(sql);
    expect(findings.filter((f) => f.level === 'HIGH').length).toBe(0);
  });

  it('does NOT flag patterns that live inside line comments', () => {
    const sql = '-- DROP TABLE foo;  this is just a note\nCREATE TABLE bar (id INT);';
    const findings = analyze(sql);
    expect(findings.length).toBe(0);
  });

  it('does NOT flag patterns inside /* block */ comments', () => {
    const sql = '/* TRUNCATE old_data; */\nINSERT INTO bar (id) VALUES (1);';
    const findings = analyze(sql);
    expect(findings.length).toBe(0);
  });

  it('flags ALTER COLUMN TYPE as MEDIUM', () => {
    const sql = 'ALTER TABLE accounts ALTER COLUMN amount TYPE NUMERIC(20,8);';
    const findings = analyze(sql);
    expect(findings.some((f) => f.op === 'ALTER COLUMN TYPE' && f.level === 'MEDIUM')).toBe(true);
  });

  it('returns findings sorted by line number', () => {
    const sql = `INSERT INTO foo VALUES (1);
DROP TABLE bar;
TRUNCATE baz;`;
    const findings = analyze(sql);
    const lines = findings.map((f) => f.line);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
  });
});

describe('stripComments()', () => {
  it('removes -- line comments but preserves newlines', () => {
    const out = stripComments('SELECT 1; -- pick one\nSELECT 2;');
    expect(out.split('\n').length).toBe(2);
    expect(out).not.toContain('pick one');
  });

  it('removes /* block */ comments', () => {
    const out = stripComments('SELECT 1; /* note */ SELECT 2;');
    expect(out).not.toContain('note');
    expect(out).toContain('SELECT 2');
  });
});

describe('hasHighRisk()', () => {
  it('returns true when any finding is HIGH', () => {
    expect(
      hasHighRisk([{ line: 1, level: 'HIGH', op: 'DROP TABLE', snippet: 'x' }]),
    ).toBe(true);
  });

  it('returns false when only MEDIUM/INFO findings exist', () => {
    expect(
      hasHighRisk([{ line: 1, level: 'MEDIUM', op: 'ALTER COLUMN TYPE', snippet: 'x' }]),
    ).toBe(false);
  });

  it('returns false on empty findings', () => {
    expect(hasHighRisk([])).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Dry-run payload (CD-2)
// ───────────────────────────────────────────────────────────────────────────

describe('buildDryRunPayload() — BEGIN + migration + ROLLBACK (CD-2)', () => {
  it('wraps the migration in BEGIN ... ROLLBACK and never COMMIT', () => {
    const payload = buildDryRunPayload('CREATE TABLE foo (id INT);');
    expect(payload.startsWith('BEGIN;')).toBe(true);
    expect(payload.trim().endsWith('ROLLBACK;')).toBe(true);
    expect(payload).not.toMatch(/\bCOMMIT\b/);
  });

  it('preserves the migration body verbatim (trimmed)', () => {
    const payload = buildDryRunPayload('   CREATE TABLE foo (id INT);   ');
    expect(payload).toContain('CREATE TABLE foo (id INT);');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Shadow dry-run (AC-2)
// ───────────────────────────────────────────────────────────────────────────

describe('runShadowDryRun() — AC-2', () => {
  const prevShadow = process.env.SHADOW_DATABASE_URL;
  beforeEach(() => {
    delete process.env.SHADOW_DATABASE_URL;
  });
  afterEach(() => {
    if (prevShadow === undefined) delete process.env.SHADOW_DATABASE_URL;
    else process.env.SHADOW_DATABASE_URL = prevShadow;
  });

  it('skips when SHADOW_DATABASE_URL is unset', () => {
    const r = runShadowDryRun('SELECT 1;');
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/SHADOW_DATABASE_URL/);
  });

  it('skips when SHADOW_DATABASE_URL is empty string', () => {
    process.env.SHADOW_DATABASE_URL = '';
    const r = runShadowDryRun('SELECT 1;');
    expect(r.skipped).toBe(true);
  });

  it('runs with mocked spawn — psql exits 0 → ok=true with ms', () => {
    let captured: { input?: string; args?: string[] } = {};
    const mockSpawn = (_cmd: string, args: string[], opts: { input?: string }) => {
      captured = { input: opts.input, args };
      return { status: 0, stdout: '', stderr: '' };
    };
    let t = 1000;
    const r = runShadowDryRun('CREATE TABLE foo (id INT);', {
      shadowUrl: 'postgres://shadow.example/db',
      spawn: mockSpawn,
      nowMs: () => {
        const v = t;
        t += 50;
        return v;
      },
    });
    expect(r.skipped).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.ms).toBe(50);
    expect(captured.input).toContain('BEGIN;');
    expect(captured.input).toContain('ROLLBACK;');
    expect(captured.args?.[0]).toBe('postgres://shadow.example/db');
    expect(captured.args).toContain('--single-transaction');
  });

  it('reports failure when psql exits non-zero', () => {
    const mockSpawn = () => ({ status: 1, stdout: '', stderr: 'ERROR: relation "foo" already exists' });
    const r = runShadowDryRun('CREATE TABLE foo (id INT);', {
      shadowUrl: 'postgres://shadow.example/db',
      spawn: mockSpawn,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already exists/);
  });

  it('reports failure when spawn errors (psql not installed)', () => {
    const mockSpawn = () => ({
      error: new Error('spawn psql ENOENT'),
      status: null,
      stdout: '',
      stderr: '',
    });
    const r = runShadowDryRun('SELECT 1;', {
      shadowUrl: 'postgres://shadow.example/db',
      spawn: mockSpawn,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/spawn failed/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// decide() — gate logic (AC-3)
// ───────────────────────────────────────────────────────────────────────────

describe('decide() — gate logic (AC-3, CD-4)', () => {
  it('exit code 0 when no HIGH and dry-run skipped', () => {
    const d = decide([], { skipped: true });
    expect(d.exitCode).toBe(0);
    expect(d.summary).toContain('[PASS]');
  });

  it('exit code 0 when no HIGH and dry-run ok within 30s', () => {
    const d = decide([], { skipped: false, ok: true, ms: 1500 });
    expect(d.exitCode).toBe(0);
  });

  it('exit code 1 when HIGH risk detected', () => {
    const d = decide(
      [{ line: 1, level: 'HIGH', op: 'DROP TABLE', snippet: 'DROP TABLE x;' }],
      { skipped: true },
    );
    expect(d.exitCode).toBe(1);
    expect(d.summary).toContain('[BLOCKED]');
    expect(d.summary).toContain('HIGH');
  });

  it('exit code 1 when shadow dry-run fails', () => {
    const d = decide([], {
      skipped: false,
      ok: false,
      ms: 200,
      error: 'syntax error',
    });
    expect(d.exitCode).toBe(1);
    expect(d.summary).toMatch(/dry-run failed/);
  });

  it('exit code 1 when shadow dry-run > 30s', () => {
    const d = decide([], { skipped: false, ok: true, ms: 31_000 });
    expect(d.exitCode).toBe(1);
    expect(d.summary).toMatch(/too slow/);
  });

  it('respects the slowMs override', () => {
    const d = decide([], { skipped: false, ok: true, ms: 600 }, { slowMs: 500 });
    expect(d.exitCode).toBe(1);
  });

  it('exit code 0 when only MEDIUM findings', () => {
    const d = decide(
      [{ line: 1, level: 'MEDIUM', op: 'ALTER COLUMN TYPE', snippet: 'x' }],
      { skipped: true },
    );
    expect(d.exitCode).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// formatFindings()
// ───────────────────────────────────────────────────────────────────────────

describe('formatFindings()', () => {
  it('prints OK message when no findings', () => {
    expect(formatFindings([])).toContain('[OK]');
  });

  it('prints risk lines with line number, level, op, snippet', () => {
    const out = formatFindings([
      { line: 7, level: 'HIGH', op: 'DROP TABLE', snippet: 'DROP TABLE foo;' },
    ]);
    expect(out).toContain('L7');
    expect(out).toContain('[HIGH]');
    expect(out).toContain('DROP TABLE');
    expect(out).toContain('DROP TABLE foo;');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// runPostApplyCheck() — AC-4
// ───────────────────────────────────────────────────────────────────────────

describe('runPostApplyCheck() — AC-4', () => {
  it('fails when DATABASE_URL is unset', () => {
    const r = runPostApplyCheck({ databaseUrl: '' });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/DATABASE_URL/);
  });

  it('passes when a2a_* tables present and no INVALID FKs', () => {
    let call = 0;
    const mockSpawn = () => {
      call++;
      if (call === 1) {
        // a2a_* tables — provide every expected baseline table (BLQ-MED-2,
        // WKH-86 AC-1: a2a_events is now part of the manifest).
        return {
          status: 0,
          stdout: 'a2a_agent_keys\na2a_events\na2a_protocol_fees\n',
          stderr: '',
        };
      }
      if (call === 2) {
        // invalid FKs
        return { status: 0, stdout: '', stderr: '' };
      }
      // indexes
      return {
        status: 0,
        stdout: 'public|a2a_agent_keys|idx_a2a_agent_keys_active\n',
        stderr: '',
      };
    };
    const r = runPostApplyCheck({
      databaseUrl: 'postgres://example/db',
      spawn: mockSpawn,
    });
    expect(r.ok).toBe(true);
    expect(r.errors.length).toBe(0);
    expect(r.details.some((d) => d.includes('a2a_* tables'))).toBe(true);
    expect(r.details.some((d) => d.includes('FK constraints: all VALID'))).toBe(true);
  });

  it('fails when no a2a_* tables found (sanity check)', () => {
    let call = 0;
    const mockSpawn = () => {
      call++;
      if (call === 1) return { status: 0, stdout: '', stderr: '' };
      if (call === 2) return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const r = runPostApplyCheck({
      databaseUrl: 'postgres://example/db',
      spawn: mockSpawn,
      minA2aTables: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('a2a_*'))).toBe(true);
  });

  it('fails when INVALID FK constraints exist', () => {
    let call = 0;
    const mockSpawn = () => {
      call++;
      if (call === 1) return { status: 0, stdout: 'a2a_agent_keys\n', stderr: '' };
      if (call === 2)
        return {
          status: 0,
          stdout: 'tasks_owner_fk|public.tasks\n',
          stderr: '',
        };
      return { status: 0, stdout: '', stderr: '' };
    };
    const r = runPostApplyCheck({
      databaseUrl: 'postgres://example/db',
      spawn: mockSpawn,
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('INVALID'))).toBe(true);
  });

  it('fails when a sub-query fails (psql nonzero exit)', () => {
    const mockSpawn = () => ({ status: 1, stdout: '', stderr: 'connection refused' });
    const r = runPostApplyCheck({
      databaseUrl: 'postgres://example/db',
      spawn: mockSpawn,
    });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('uses read-only SELECT queries (CD-1)', () => {
    // Defense in depth: verify the post-apply queries are read-only.
    for (const q of Object.values(POST_APPLY_QUERIES)) {
      expect(q.toUpperCase()).toMatch(/\bSELECT\b/);
      expect(q.toUpperCase()).not.toMatch(/\bDELETE\b/);
      expect(q.toUpperCase()).not.toMatch(/\bUPDATE\b/);
      expect(q.toUpperCase()).not.toMatch(/\bDROP\b/);
      expect(q.toUpperCase()).not.toMatch(/\bTRUNCATE\b/);
      expect(q.toUpperCase()).not.toMatch(/\bINSERT\b/);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// main() — CLI integration (AC-3, AC-7)
// ───────────────────────────────────────────────────────────────────────────

describe('main() — CLI integration', () => {
  it('exit 1 on HIGH risk migration with mocked deps', () => {
    let exitCode = -1;
    const logs: string[] = [];
    main({
      argv: ['node', 'migrate-preflight.mjs', '/tmp/risky.sql'],
      readFile: () => 'DROP TABLE legacy_users;',
      exit: (c) => {
        exitCode = c;
      },
      log: (m) => logs.push(m),
      warn: (m) => logs.push(m),
      error: (m) => logs.push(m),
      shadowDryRun: () => ({ skipped: true, reason: 'SHADOW_DATABASE_URL not set' }),
      postApply: () => ({ ok: true, errors: [], details: [] }),
    });
    expect(exitCode).toBe(1);
    expect(logs.join('\n')).toContain('[BLOCKED]');
    expect(logs.join('\n')).toContain('DROP TABLE');
  });

  it('exit 0 on safe migration with mocked deps', () => {
    let exitCode = -1;
    const logs: string[] = [];
    main({
      argv: ['node', 'migrate-preflight.mjs', '/tmp/safe.sql'],
      readFile: () => 'CREATE TABLE foo (id UUID PRIMARY KEY);',
      exit: (c) => {
        exitCode = c;
      },
      log: (m) => logs.push(m),
      warn: (m) => logs.push(m),
      error: (m) => logs.push(m),
      shadowDryRun: () => ({ skipped: true, reason: 'SHADOW_DATABASE_URL not set' }),
      postApply: () => ({ ok: true, errors: [], details: [] }),
    });
    expect(exitCode).toBe(0);
    expect(logs.join('\n')).toContain('[PASS]');
  });

  it('--post-apply exits 0 when integrity check ok', () => {
    let exitCode = -1;
    main({
      argv: ['node', 'migrate-preflight.mjs', '--post-apply'],
      exit: (c) => {
        exitCode = c;
      },
      log: () => {},
      warn: () => {},
      error: () => {},
      postApply: () => ({
        ok: true,
        errors: [],
        details: ['a2a_* tables: 4 found', 'FK constraints: all VALID'],
      }),
    });
    expect(exitCode).toBe(0);
  });

  it('--post-apply exits 1 when integrity check fails', () => {
    let exitCode = -1;
    const logs: string[] = [];
    main({
      argv: ['node', 'migrate-preflight.mjs', '--post-apply'],
      exit: (c) => {
        exitCode = c;
      },
      log: (m) => logs.push(m),
      warn: (m) => logs.push(m),
      error: (m) => logs.push(m),
      postApply: () => ({
        ok: false,
        errors: ['Found 1 INVALID foreign key constraint(s)'],
        details: [],
      }),
    });
    expect(exitCode).toBe(1);
    expect(logs.join('\n')).toContain('[FAIL]');
  });

  it('exits 2 with usage when no args provided', () => {
    let exitCode = -1;
    const logs: string[] = [];
    main({
      argv: ['node', 'migrate-preflight.mjs'],
      exit: (c) => {
        exitCode = c;
      },
      log: () => {},
      warn: () => {},
      error: (m) => logs.push(m),
    });
    expect(exitCode).toBe(2);
    expect(logs.join('\n')).toMatch(/Usage:/);
  });

  it('exits 2 when SQL file does not exist', () => {
    let exitCode = -1;
    const logs: string[] = [];
    main({
      argv: ['node', 'migrate-preflight.mjs', '/tmp/this-file-does-not-exist-78ec24.sql'],
      exit: (c) => {
        exitCode = c;
      },
      log: () => {},
      warn: () => {},
      error: (m) => logs.push(m),
    });
    expect(exitCode).toBe(2);
    expect(logs.join('\n')).toContain('not found');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AR fix-pack iter 1 — new BLQ-driven tests (CD-FP1: 2 fixtures per pattern).
// ───────────────────────────────────────────────────────────────────────────

describe('analyze() — BLQ-ALTO-1: extended destructive DROP <object>', () => {
  // Each new pattern ships with positive + negative fixtures (CD-FP1).

  // (positives)
  it('flags DROP DATABASE as HIGH', () => {
    const findings = analyze('DROP DATABASE postgres;');
    expect(findings.some((f) => f.op === 'DROP <object>' && f.level === 'HIGH')).toBe(true);
  });
  it('flags DROP SCHEMA as HIGH', () => {
    const findings = analyze('DROP SCHEMA public CASCADE;');
    expect(findings.some((f) => f.op === 'DROP <object>' && f.level === 'HIGH')).toBe(true);
  });
  it('flags DROP TYPE as HIGH', () => {
    const findings = analyze('DROP TYPE my_enum;');
    expect(findings.some((f) => f.op === 'DROP <object>' && f.level === 'HIGH')).toBe(true);
  });
  it('flags DROP POLICY as HIGH', () => {
    const findings = analyze('DROP POLICY tenant_isolation ON tasks;');
    expect(findings.some((f) => f.op === 'DROP <object>' && f.level === 'HIGH')).toBe(true);
  });
  it('flags DROP TRIGGER as HIGH', () => {
    const findings = analyze('DROP TRIGGER set_updated_at ON tasks;');
    expect(findings.some((f) => f.op === 'DROP <object>' && f.level === 'HIGH')).toBe(true);
  });
  it('flags DROP FUNCTION as HIGH', () => {
    const findings = analyze('DROP FUNCTION increment_a2a_key_spend(uuid, integer, numeric);');
    expect(findings.some((f) => f.op === 'DROP <object>' && f.level === 'HIGH')).toBe(true);
  });
  it('flags DROP VIEW as HIGH', () => {
    const findings = analyze('DROP VIEW v_active_tasks;');
    expect(findings.some((f) => f.op === 'DROP <object>' && f.level === 'HIGH')).toBe(true);
  });
  it('flags DROP MATERIALIZED VIEW as HIGH', () => {
    const findings = analyze('DROP MATERIALIZED VIEW mv_dashboard;');
    expect(findings.some((f) => f.op === 'DROP <object>' && f.level === 'HIGH')).toBe(true);
  });
  it('flags DROP SEQUENCE as HIGH', () => {
    const findings = analyze('DROP SEQUENCE seq_event_id;');
    expect(findings.some((f) => f.op === 'DROP <object>' && f.level === 'HIGH')).toBe(true);
  });
  it('flags DROP EXTENSION as HIGH', () => {
    const findings = analyze('DROP EXTENSION pgcrypto;');
    expect(findings.some((f) => f.op === 'DROP <object>' && f.level === 'HIGH')).toBe(true);
  });
  it('flags DROP PUBLICATION as HIGH', () => {
    const findings = analyze('DROP PUBLICATION my_pub;');
    expect(findings.some((f) => f.op === 'DROP <object>' && f.level === 'HIGH')).toBe(true);
  });
  it('flags DROP SUBSCRIPTION as HIGH', () => {
    const findings = analyze('DROP SUBSCRIPTION my_sub;');
    expect(findings.some((f) => f.op === 'DROP <object>' && f.level === 'HIGH')).toBe(true);
  });

  // (negatives)
  it('does NOT flag the substring "drop" inside an identifier', () => {
    const findings = analyze('CREATE TABLE backdrop (id INT);');
    expect(findings.some((f) => f.op === 'DROP <object>')).toBe(false);
  });
  it('does NOT flag "DROP" inside a string literal column DEFAULT', () => {
    const findings = analyze("INSERT INTO logs (msg) VALUES ('user clicked DROP DATABASE button');");
    expect(findings.some((f) => f.op === 'DROP <object>')).toBe(false);
  });
});

describe('analyze() — BLQ-ALTO-1: DISABLE ROW LEVEL SECURITY', () => {
  it('flags DISABLE ROW LEVEL SECURITY as HIGH', () => {
    const findings = analyze('ALTER TABLE a2a_agent_keys DISABLE ROW LEVEL SECURITY;');
    expect(
      findings.some((f) => f.op === 'DISABLE ROW LEVEL SECURITY' && f.level === 'HIGH'),
    ).toBe(true);
  });
  it('does NOT flag ENABLE ROW LEVEL SECURITY', () => {
    const findings = analyze('ALTER TABLE a2a_agent_keys ENABLE ROW LEVEL SECURITY;');
    expect(findings.some((f) => f.op === 'DISABLE ROW LEVEL SECURITY')).toBe(false);
  });
});

describe('analyze() — BLQ-ALTO-1: GRANT/REVOKE ON', () => {
  it('flags GRANT EXECUTE ON FUNCTION as MEDIUM', () => {
    const findings = analyze('GRANT EXECUTE ON FUNCTION foo() TO service_role;');
    expect(findings.some((f) => f.op === 'GRANT/REVOKE' && f.level === 'MEDIUM')).toBe(true);
  });
  it('flags REVOKE EXECUTE ON FUNCTION as MEDIUM', () => {
    const findings = analyze('REVOKE EXECUTE ON FUNCTION foo() FROM PUBLIC;');
    expect(findings.some((f) => f.op === 'GRANT/REVOKE' && f.level === 'MEDIUM')).toBe(true);
  });
  it('does NOT flag a column named "grant_id" by itself', () => {
    const findings = analyze('CREATE TABLE perms (grant_id INT);');
    expect(findings.some((f) => f.op === 'GRANT/REVOKE')).toBe(false);
  });
});

describe('analyze() — BLQ-ALTO-1: UPDATE without WHERE', () => {
  it('flags UPDATE foo SET bar=1 (no WHERE) as HIGH mass write', () => {
    const findings = analyze('UPDATE accounts SET disabled = true;');
    expect(findings.some((f) => f.op === 'UPDATE without WHERE' && f.level === 'HIGH')).toBe(true);
  });
  it('does NOT flag UPDATE foo SET bar=1 WHERE id=2', () => {
    const findings = analyze('UPDATE accounts SET disabled = true WHERE id = 1;');
    expect(findings.some((f) => f.op === 'UPDATE without WHERE')).toBe(false);
  });
  it('does NOT flag UPDATE inside a PL/pgSQL function body (dollar-quoted)', () => {
    const sql = `
      CREATE OR REPLACE FUNCTION f() RETURNS void AS $$
      BEGIN
        UPDATE counters SET value = 1;
      END;
      $$ LANGUAGE plpgsql;
    `;
    const findings = analyze(sql);
    expect(findings.some((f) => f.op === 'UPDATE without WHERE')).toBe(false);
  });
});

describe('analyze() — BLQ-ALTO-1: ALTER DEFAULT PRIVILEGES', () => {
  it('flags ALTER DEFAULT PRIVILEGES as MEDIUM', () => {
    const findings = analyze(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO readonly;',
    );
    expect(
      findings.some((f) => f.op === 'ALTER DEFAULT PRIVILEGES' && f.level === 'MEDIUM'),
    ).toBe(true);
  });
  it('does NOT flag ALTER TABLE foo SET DEFAULT 0', () => {
    const findings = analyze('ALTER TABLE foo ALTER COLUMN x SET DEFAULT 0;');
    expect(findings.some((f) => f.op === 'ALTER DEFAULT PRIVILEGES')).toBe(false);
  });
});

describe('analyze() — BLQ-ALTO-1: REASSIGN OWNED BY', () => {
  it('flags REASSIGN OWNED BY as HIGH', () => {
    const findings = analyze('REASSIGN OWNED BY old_user TO new_user;');
    expect(findings.some((f) => f.op === 'REASSIGN OWNED BY' && f.level === 'HIGH')).toBe(true);
  });
  it('does NOT flag SELECT ... AS owned_by', () => {
    const findings = analyze("SELECT 'reassign' AS owned_by;");
    expect(findings.some((f) => f.op === 'REASSIGN OWNED BY')).toBe(false);
  });
});

describe('analyze() — BLQ-ALTO-2: multi-line statement-aware analyzer', () => {
  it('detects ALTER TABLE foo (newline) DROP COLUMN bar across lines as HIGH', () => {
    const sql = 'ALTER TABLE foo\n  DROP COLUMN bar;\n';
    const findings = analyze(sql);
    expect(findings.some((f) => f.op === 'DROP COLUMN' && f.level === 'HIGH')).toBe(true);
  });
  it('detects ALTER TABLE (newline) RENAME TO across lines as HIGH', () => {
    const sql = 'ALTER TABLE old_name\n  RENAME TO new_name;\n';
    const findings = analyze(sql);
    expect(findings.some((f) => f.op === 'RENAME TO' && f.level === 'HIGH')).toBe(true);
  });
  it('detects DROP COLUMN even when a comment sits between the keyword pair', () => {
    const sql = 'ALTER TABLE foo\n  -- temporary scaffold removal\n  DROP COLUMN obsolete;';
    const findings = analyze(sql);
    expect(findings.some((f) => f.op === 'DROP COLUMN' && f.level === 'HIGH')).toBe(true);
  });
  it('emits stable line numbers when the statement begins on a non-first line', () => {
    const sql = '\n\n\nDROP TABLE legacy;';
    const findings = analyze(sql);
    const drop = findings.find((f) => f.op === 'DROP TABLE');
    expect(drop?.line).toBe(4);
  });
});

describe('analyze() — BLQ-MED-1: embedded COMMIT/ROLLBACK', () => {
  it('flags a bare COMMIT; statement as MEDIUM', () => {
    const findings = analyze('COMMIT;');
    expect(
      findings.some((f) => f.op === 'embedded COMMIT/ROLLBACK' && f.level === 'MEDIUM'),
    ).toBe(true);
  });
  it('flags a bare ROLLBACK; statement as MEDIUM', () => {
    const findings = analyze('ROLLBACK;');
    expect(
      findings.some((f) => f.op === 'embedded COMMIT/ROLLBACK' && f.level === 'MEDIUM'),
    ).toBe(true);
  });
  it('does NOT flag a column named "commit_hash"', () => {
    const findings = analyze('CREATE TABLE commits (commit_hash TEXT);');
    expect(findings.some((f) => f.op === 'embedded COMMIT/ROLLBACK')).toBe(false);
  });
});

describe('analyze() — BLQ-MED-3: string-literal-aware analyzer', () => {
  it('does NOT flag DROP TABLE inside a single-quoted string literal', () => {
    const findings = analyze("INSERT INTO audit_log (note) VALUES ('user ran DROP TABLE foo');");
    expect(findings.some((f) => f.op === 'DROP TABLE')).toBe(false);
  });
  it('does NOT flag TRUNCATE inside a string literal', () => {
    const findings = analyze("INSERT INTO logs (msg) VALUES ('TRUNCATE was rejected');");
    expect(findings.some((f) => f.op === 'TRUNCATE')).toBe(false);
  });
  it("does NOT flag operations inside an E'...' escape string", () => {
    const findings = analyze("INSERT INTO logs (msg) VALUES (E'\\nDROP DATABASE\\npostgres');");
    expect(findings.some((f) => f.op === 'DROP <object>')).toBe(false);
  });
  it('does NOT flag DROP TABLE inside a $$ ... $$ dollar-quoted body', () => {
    const sql =
      "CREATE OR REPLACE FUNCTION nuke() RETURNS void AS $$ BEGIN EXECUTE 'DROP TABLE legacy'; END; $$ LANGUAGE plpgsql;";
    const findings = analyze(sql);
    expect(findings.some((f) => f.op === 'DROP TABLE')).toBe(false);
  });
  it('does NOT flag DROP TABLE inside a $tag$ ... $tag$ tagged body', () => {
    const sql =
      "CREATE FUNCTION g() RETURNS void AS $body$ EXECUTE 'DROP TABLE foo'; $body$ LANGUAGE plpgsql;";
    const findings = analyze(sql);
    expect(findings.some((f) => f.op === 'DROP TABLE')).toBe(false);
  });
  it('still flags DROP TABLE that lives outside string literals', () => {
    const findings = analyze(
      "INSERT INTO logs (msg) VALUES ('DROP TABLE allowed in logs only');\nDROP TABLE legacy_users;",
    );
    const drop = findings.find((f) => f.op === 'DROP TABLE');
    expect(drop).toBeDefined();
    expect(drop?.level).toBe('HIGH');
  });
});

describe('main() — BLQ-MED-4: exit code 2 on internal error', () => {
  it('exits with code 2 when readFile throws', () => {
    let exitCode = -1;
    const logs: string[] = [];
    main({
      argv: ['node', 'migrate-preflight.mjs', '/tmp/explode.sql'],
      readFile: () => {
        throw new Error('disk pulled out of laptop');
      },
      exit: (c) => {
        exitCode = c;
      },
      log: () => {},
      warn: () => {},
      error: (m) => logs.push(m),
    });
    expect(exitCode).toBe(2);
    expect(logs.join('\n')).toMatch(/preflight crashed/i);
  });
});

describe('analyze() — BLQ-BAJO-1: psql meta-command detection', () => {
  it('flags backslash-bang shell escape as HIGH meta-command', () => {
    const findings = analyze('\\! echo PWNED\nSELECT 1;');
    expect(findings.some((f) => f.op === 'psql meta-command' && f.level === 'HIGH')).toBe(true);
  });
  it('flags \\copy as HIGH meta-command', () => {
    const findings = analyze('\\copy users TO STDOUT WITH CSV;');
    expect(findings.some((f) => f.op === 'psql meta-command' && f.level === 'HIGH')).toBe(true);
  });
  it('flags \\i (include file) as HIGH meta-command', () => {
    const findings = analyze('\\i other.sql\nCREATE TABLE foo (id INT);');
    expect(findings.some((f) => f.op === 'psql meta-command' && f.level === 'HIGH')).toBe(true);
  });
  it('does NOT flag a backslash inside a string literal', () => {
    const findings = analyze("INSERT INTO logs (path) VALUES ('C:\\\\foo\\\\bar');");
    expect(findings.some((f) => f.op === 'psql meta-command')).toBe(false);
  });
});

describe('analyze() — BLQ-BAJO-2: CONCURRENTLY/VACUUM cannot be wrapped', () => {
  it('flags CREATE INDEX CONCURRENTLY as INFO', () => {
    const findings = analyze('CREATE INDEX CONCURRENTLY idx_a ON tasks(owner_ref);');
    expect(
      findings.some(
        (f) => f.op === 'CONCURRENTLY/VACUUM (cannot dry-run)' && f.level === 'INFO',
      ),
    ).toBe(true);
  });
  it('flags DROP INDEX CONCURRENTLY (and additionally HIGH DROP INDEX)', () => {
    const findings = analyze('DROP INDEX CONCURRENTLY idx_a;');
    expect(findings.some((f) => f.op === 'DROP INDEX' && f.level === 'HIGH')).toBe(true);
    expect(
      findings.some(
        (f) => f.op === 'CONCURRENTLY/VACUUM (cannot dry-run)' && f.level === 'INFO',
      ),
    ).toBe(true);
  });
  it('flags VACUUM as INFO', () => {
    const findings = analyze('VACUUM ANALYZE tasks;');
    expect(
      findings.some(
        (f) => f.op === 'CONCURRENTLY/VACUUM (cannot dry-run)' && f.level === 'INFO',
      ),
    ).toBe(true);
  });
  it('flags CREATE DATABASE as INFO (also cannot run in transaction)', () => {
    const findings = analyze('CREATE DATABASE shadow;');
    expect(
      findings.some(
        (f) => f.op === 'CONCURRENTLY/VACUUM (cannot dry-run)' && f.level === 'INFO',
      ),
    ).toBe(true);
  });
  it('flags ALTER SYSTEM as INFO', () => {
    const findings = analyze("ALTER SYSTEM SET shared_buffers = '256MB';");
    expect(
      findings.some(
        (f) => f.op === 'CONCURRENTLY/VACUUM (cannot dry-run)' && f.level === 'INFO',
      ),
    ).toBe(true);
  });
  it('does NOT flag a CREATE INDEX without CONCURRENTLY', () => {
    const findings = analyze('CREATE INDEX idx_a ON tasks(owner_ref);');
    expect(findings.some((f) => f.op === 'CONCURRENTLY/VACUUM (cannot dry-run)')).toBe(false);
  });
});

describe('splitStatements() — BLQ-ALTO-2 + CD-FP2', () => {
  it('returns one statement when the input is a single DDL', () => {
    const stmts = splitStatements('CREATE TABLE foo (id INT);');
    expect(stmts.length).toBe(1);
    expect(stmts[0].text.trim()).toContain('CREATE TABLE');
  });

  it('splits two statements separated by ;', () => {
    const stmts = splitStatements('CREATE TABLE a (id INT);\nCREATE TABLE b (id INT);');
    expect(stmts.length).toBe(2);
  });

  it('does NOT split on a ; inside a single-quoted string', () => {
    const stmts = splitStatements("INSERT INTO l(m) VALUES (';'); SELECT 1;");
    expect(stmts.length).toBe(2);
    expect(stmts[0].text).toContain("';'");
  });

  it('does NOT split on a ; inside a $$ ... $$ dollar-quoted body', () => {
    const sql =
      'CREATE FUNCTION f() RETURNS void AS $$ BEGIN PERFORM 1; PERFORM 2; END; $$ LANGUAGE plpgsql;';
    const stmts = splitStatements(sql);
    expect(stmts.length).toBe(1);
  });

  it('does NOT split on a ; inside a $tag$ ... $tag$ dollar-quoted body', () => {
    const sql =
      'CREATE FUNCTION g() RETURNS void AS $body$ BEGIN PERFORM 1; END; $body$ LANGUAGE plpgsql;';
    const stmts = splitStatements(sql);
    expect(stmts.length).toBe(1);
  });

  it('preserves the starting line number of each statement', () => {
    const sql = 'CREATE TABLE a (id INT);\n\n\nCREATE TABLE b (id INT);';
    const stmts = splitStatements(sql);
    expect(stmts[0].line).toBe(1);
    expect(stmts[1].line).toBe(4);
  });

  it('handles a trailing statement without a final ;', () => {
    const stmts = splitStatements('CREATE TABLE a (id INT);\nSELECT 1');
    expect(stmts.length).toBe(2);
  });
});

describe('stripStringLiterals() — BLQ-MED-3', () => {
  it('blanks the body of a single-quoted string literal', () => {
    const out = stripStringLiterals("SELECT 'DROP TABLE x';");
    expect(out).not.toContain('DROP TABLE');
  });
  it('preserves the line count of multi-line string literals', () => {
    const sql = "SELECT 'line one\nline two\nline three';";
    const out = stripStringLiterals(sql);
    expect(out.split('\n').length).toBe(sql.split('\n').length);
  });
  it('blanks the body of a $$ ... $$ dollar-quoted string', () => {
    const out = stripStringLiterals(
      'CREATE FUNCTION f() RETURNS void AS $$ DROP TABLE x; $$ LANGUAGE plpgsql;',
    );
    expect(out).not.toContain('DROP TABLE');
  });
  it('blanks the body of a $tag$ ... $tag$ dollar-quoted string', () => {
    const out = stripStringLiterals(
      'CREATE FUNCTION g() RETURNS void AS $body$ DROP TABLE x; $body$ LANGUAGE plpgsql;',
    );
    expect(out).not.toContain('DROP TABLE');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// BLQ-MED-2 — runPostApplyCheck() expectedA2aTables baseline manifest.
// ───────────────────────────────────────────────────────────────────────────

describe('runPostApplyCheck() — BLQ-MED-2 baseline manifest', () => {
  it('exposes EXPECTED_A2A_TABLES as a non-empty array of a2a_* names', () => {
    expect(Array.isArray(EXPECTED_A2A_TABLES)).toBe(true);
    expect(EXPECTED_A2A_TABLES.length).toBeGreaterThan(0);
    expect(
      EXPECTED_A2A_TABLES.every((t) => typeof t === 'string' && t.startsWith('a2a_')),
    ).toBe(true);
  });

  it('fails when an expected baseline table is missing (set difference)', () => {
    let call = 0;
    const mockSpawn = () => {
      call++;
      if (call === 1) {
        return { status: 0, stdout: 'a2a_agent_keys\n', stderr: '' };
      }
      if (call === 2) return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const r = runPostApplyCheck({
      databaseUrl: 'postgres://example/db',
      spawn: mockSpawn,
      expectedA2aTables: ['a2a_agent_keys', 'a2a_protocol_fees'],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('Missing expected'))).toBe(true);
    expect(r.errors.some((e) => e.includes('a2a_protocol_fees'))).toBe(true);
  });

  it('reports the expected list in details for debugging', () => {
    let call = 0;
    const mockSpawn = () => {
      call++;
      if (call === 1)
        return { status: 0, stdout: 'a2a_agent_keys\na2a_protocol_fees\n', stderr: '' };
      if (call === 2) return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const r = runPostApplyCheck({
      databaseUrl: 'postgres://example/db',
      spawn: mockSpawn,
      expectedA2aTables: ['a2a_agent_keys', 'a2a_protocol_fees'],
    });
    expect(r.ok).toBe(true);
    expect(r.details.some((d) => d.includes('a2a_* tables expected'))).toBe(true);
  });

  it('passes when every expected table is present (and no INVALID FKs)', () => {
    let call = 0;
    const mockSpawn = () => {
      call++;
      if (call === 1)
        return { status: 0, stdout: 'a2a_agent_keys\na2a_protocol_fees\n', stderr: '' };
      if (call === 2) return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const r = runPostApplyCheck({
      databaseUrl: 'postgres://example/db',
      spawn: mockSpawn,
      expectedA2aTables: ['a2a_agent_keys', 'a2a_protocol_fees'],
    });
    expect(r.ok).toBe(true);
    expect(r.errors.length).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// WKH-86 AC-1 — `a2a_events` is part of the EXPECTED_A2A_TABLES manifest.
// T-MPF-EVENTS
// ───────────────────────────────────────────────────────────────────────────

describe('EXPECTED_A2A_TABLES — WKH-86 AC-1 (T-MPF-EVENTS)', () => {
  it('includes a2a_events as a baseline manifest entry', () => {
    expect(EXPECTED_A2A_TABLES).toContain('a2a_events');
  });

  it('fails post-apply when a2a_events is missing from the live DB', () => {
    let call = 0;
    const mockSpawn = () => {
      call++;
      if (call === 1) {
        // Missing a2a_events — only the other two baseline tables exist.
        return {
          status: 0,
          stdout: 'a2a_agent_keys\na2a_protocol_fees\n',
          stderr: '',
        };
      }
      if (call === 2) return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const r = runPostApplyCheck({
      databaseUrl: 'postgres://example/db',
      spawn: mockSpawn,
      // Use the default EXPECTED_A2A_TABLES (which now includes a2a_events).
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('a2a_events'))).toBe(true);
    expect(r.errors.some((e) => e.includes('Missing expected'))).toBe(true);
  });

  it('passes post-apply when a2a_events is present in the live DB', () => {
    let call = 0;
    const mockSpawn = () => {
      call++;
      if (call === 1) {
        return {
          status: 0,
          stdout: 'a2a_agent_keys\na2a_events\na2a_protocol_fees\n',
          stderr: '',
        };
      }
      if (call === 2) return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const r = runPostApplyCheck({
      databaseUrl: 'postgres://example/db',
      spawn: mockSpawn,
    });
    expect(r.ok).toBe(true);
    expect(r.errors.length).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// WKH-86 AC-2 — DROP TRIGGER/FUNCTION IF EXISTS no longer flagged HIGH.
// T-MPF-DROP-IF-EXISTS
// ───────────────────────────────────────────────────────────────────────────

describe('analyze() — WKH-86 AC-2 idempotent DROPs (T-MPF-DROP-IF-EXISTS)', () => {
  // CD-FP1: positives + negatives.

  // (negatives — IF EXISTS variants must NOT be HIGH)
  it('does NOT flag DROP TRIGGER IF EXISTS as HIGH', () => {
    const findings = analyze('DROP TRIGGER IF EXISTS set_updated_at ON tasks;');
    expect(findings.some((f) => f.op === 'DROP <object>' && f.level === 'HIGH')).toBe(false);
  });

  it('does NOT flag DROP FUNCTION IF EXISTS as HIGH', () => {
    const findings = analyze(
      'DROP FUNCTION IF EXISTS increment_a2a_key_spend(uuid, integer, numeric);',
    );
    expect(findings.some((f) => f.op === 'DROP <object>' && f.level === 'HIGH')).toBe(false);
  });

  it('does NOT flag DROP TRIGGER IF EXISTS in mixed-case', () => {
    const findings = analyze('Drop Trigger If Exists my_trig ON foo;');
    expect(findings.some((f) => f.op === 'DROP <object>' && f.level === 'HIGH')).toBe(false);
  });

  it('does NOT flag DROP FUNCTION IF EXISTS with extra whitespace', () => {
    const findings = analyze('DROP   FUNCTION   IF   EXISTS  my_fn();');
    expect(findings.some((f) => f.op === 'DROP <object>' && f.level === 'HIGH')).toBe(false);
  });

  // (positives — bare DROP without IF EXISTS still HIGH; CD-WKH78-FP3)
  it('still flags bare DROP TRIGGER as HIGH', () => {
    const findings = analyze('DROP TRIGGER set_updated_at ON tasks;');
    expect(findings.some((f) => f.op === 'DROP <object>' && f.level === 'HIGH')).toBe(true);
  });

  it('still flags bare DROP FUNCTION as HIGH', () => {
    const findings = analyze('DROP FUNCTION my_fn();');
    expect(findings.some((f) => f.op === 'DROP <object>' && f.level === 'HIGH')).toBe(true);
  });

  // (CD-WKH86-4: DROP TABLE IF EXISTS must remain HIGH)
  it('still flags DROP TABLE IF EXISTS as HIGH (CD-WKH86-4)', () => {
    const findings = analyze('DROP TABLE IF EXISTS legacy_users;');
    expect(findings.some((f) => f.op === 'DROP TABLE' && f.level === 'HIGH')).toBe(true);
  });

  // (other DROP <object> kinds keep HIGH even with IF EXISTS — only TRIGGER
  // and FUNCTION were carved out per AC-2 wording.)
  it('still flags DROP SCHEMA IF EXISTS as HIGH', () => {
    const findings = analyze('DROP SCHEMA IF EXISTS old_schema CASCADE;');
    expect(findings.some((f) => f.op === 'DROP <object>' && f.level === 'HIGH')).toBe(true);
  });

  it('still flags DROP POLICY IF EXISTS as HIGH', () => {
    const findings = analyze('DROP POLICY IF EXISTS tenant_isolation ON tasks;');
    expect(findings.some((f) => f.op === 'DROP <object>' && f.level === 'HIGH')).toBe(true);
  });
});

describe('isIdempotentDropTriggerOrFunction()', () => {
  it('returns true for DROP TRIGGER IF EXISTS', () => {
    expect(isIdempotentDropTriggerOrFunction('DROP TRIGGER IF EXISTS t ON x;')).toBe(true);
  });
  it('returns true for DROP FUNCTION IF EXISTS', () => {
    expect(isIdempotentDropTriggerOrFunction('DROP FUNCTION IF EXISTS f();')).toBe(true);
  });
  it('returns false for bare DROP TRIGGER', () => {
    expect(isIdempotentDropTriggerOrFunction('DROP TRIGGER t ON x;')).toBe(false);
  });
  it('returns false for DROP TABLE IF EXISTS', () => {
    expect(isIdempotentDropTriggerOrFunction('DROP TABLE IF EXISTS x;')).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// WKH-86 AC-3 — findDeleteWithoutWhere skips string literals.
// T-MPF-STRING-LITERAL
// ───────────────────────────────────────────────────────────────────────────

describe('findDeleteWithoutWhere() — WKH-86 AC-3 (T-MPF-STRING-LITERAL)', () => {
  it('does NOT flag DELETE FROM inside a single-quoted string literal', () => {
    const sql = "INSERT INTO audit_log (note) VALUES ('user ran DELETE FROM old_table');";
    expect(findDeleteWithoutWhere(sql).length).toBe(0);
  });

  it('does NOT flag DELETE FROM inside a $$ … $$ dollar-quoted body', () => {
    const sql =
      "CREATE FUNCTION nuke() RETURNS void AS $$ BEGIN EXECUTE 'DELETE FROM legacy'; END; $$ LANGUAGE plpgsql;";
    expect(findDeleteWithoutWhere(sql).length).toBe(0);
  });

  it('still flags a real DELETE FROM without WHERE outside any string', () => {
    const hits = findDeleteWithoutWhere('DELETE FROM events;');
    expect(hits.length).toBe(1);
  });

  it('still flags multiple real DELETE FROM statements without WHERE', () => {
    const sql = "DELETE FROM events;\nINSERT INTO foo VALUES ('DELETE FROM x');\nDELETE FROM logs;";
    const hits = findDeleteWithoutWhere(sql);
    expect(hits.length).toBe(2);
  });

  // analyze() is the public surface — it must agree with the helper.
  it('analyze() does NOT flag DELETE FROM in string literal as HIGH', () => {
    const findings = analyze(
      "INSERT INTO audit_log (note) VALUES ('user ran DELETE FROM old_table');",
    );
    expect(findings.some((f) => f.op === 'DELETE without WHERE')).toBe(false);
  });

  it('analyze() still flags real DELETE FROM as HIGH', () => {
    const findings = analyze('DELETE FROM events;');
    expect(findings.some((f) => f.op === 'DELETE without WHERE' && f.level === 'HIGH')).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// WKH-86 AC-4 — findings deduplicated by (line, level).
// T-MPF-DEDUP / CD-WKH86-2
// ───────────────────────────────────────────────────────────────────────────

describe('analyze() — WKH-86 AC-4 dedup by (line, level) (T-MPF-DEDUP)', () => {
  it('emits a single HIGH finding for ALTER TABLE … DROP COLUMN (no duplicate ALTER TABLE … DROP)', () => {
    const sql = 'ALTER TABLE accounts DROP COLUMN legacy_field;';
    const findings = analyze(sql);
    const highSameLine = findings.filter((f) => f.line === 1 && f.level === 'HIGH');
    expect(highSameLine.length).toBe(1);
  });

  it('preserves DIFFERENT severities on the same line', () => {
    // DROP INDEX CONCURRENTLY triggers HIGH (DROP INDEX) + INFO
    // (CONCURRENTLY/VACUUM cannot dry-run). Different severities → both
    // findings preserved.
    const findings = analyze('DROP INDEX CONCURRENTLY idx_a;');
    const sameLine = findings.filter((f) => f.line === 1);
    const levels = new Set(sameLine.map((f) => f.level));
    expect(levels.has('HIGH')).toBe(true);
    expect(levels.has('INFO')).toBe(true);
  });

  it('preserves order across distinct lines', () => {
    const sql = 'DROP TABLE a;\nDROP TABLE b;\nDROP TABLE c;';
    const findings = analyze(sql);
    const lines = findings.filter((f) => f.op === 'DROP TABLE').map((f) => f.line);
    expect(lines).toEqual([1, 2, 3]);
  });
});

describe('dedupeByLineAndLevel()', () => {
  it('removes duplicates with the same (line, level)', () => {
    const out = dedupeByLineAndLevel([
      { line: 5, level: 'HIGH', op: 'DROP TABLE', snippet: 'a' },
      { line: 5, level: 'HIGH', op: 'ALTER TABLE … DROP', snippet: 'a' },
      { line: 7, level: 'HIGH', op: 'TRUNCATE', snippet: 'b' },
    ]);
    expect(out.length).toBe(2);
    expect(out[0].op).toBe('DROP TABLE'); // first wins
    expect(out[1].line).toBe(7);
  });

  it('keeps findings with the same line but different level', () => {
    const out = dedupeByLineAndLevel([
      { line: 5, level: 'HIGH', op: 'DROP INDEX', snippet: 'a' },
      { line: 5, level: 'INFO', op: 'CONCURRENTLY/VACUUM (cannot dry-run)', snippet: 'a' },
    ]);
    expect(out.length).toBe(2);
  });

  it('returns empty array on empty input', () => {
    expect(dedupeByLineAndLevel([])).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// WKH-86 AC-5 — runPostApplyCheck failures fail the gate (exit 1).
// T-MPF-POSTCHECK-FAIL / CD-WKH86-3
// ───────────────────────────────────────────────────────────────────────────

describe('main() --post-apply — WKH-86 AC-5 (T-MPF-POSTCHECK-FAIL)', () => {
  it('exits 1 when a baseline a2a_* table is missing', () => {
    let exitCode = -1;
    const logs: string[] = [];
    main({
      argv: ['node', 'migrate-preflight.mjs', '--post-apply'],
      exit: (c) => {
        exitCode = c;
      },
      log: (m) => logs.push(m),
      warn: (m) => logs.push(m),
      error: (m) => logs.push(m),
      postApply: () => ({
        ok: false,
        errors: ['Missing expected a2a_* table(s): a2a_events'],
        details: [],
      }),
    });
    expect(exitCode).toBe(1);
    expect(logs.join('\n')).toContain('[FAIL]');
    expect(logs.join('\n')).toContain('a2a_events');
  });

  it('exits 1 when an FK constraint is INVALID', () => {
    let exitCode = -1;
    main({
      argv: ['node', 'migrate-preflight.mjs', '--post-apply'],
      exit: (c) => {
        exitCode = c;
      },
      log: () => {},
      warn: () => {},
      error: () => {},
      postApply: () => ({
        ok: false,
        errors: ['Found 1 INVALID foreign key constraint(s): tasks_owner_fk|public.tasks'],
        details: [],
      }),
    });
    expect(exitCode).toBe(1);
  });

  it('exits 1 when a sub-query (psql) fails', () => {
    let exitCode = -1;
    main({
      argv: ['node', 'migrate-preflight.mjs', '--post-apply'],
      exit: (c) => {
        exitCode = c;
      },
      log: () => {},
      warn: () => {},
      error: () => {},
      postApply: () => ({
        ok: false,
        errors: ['index query failed: connection refused'],
        details: [],
      }),
    });
    expect(exitCode).toBe(1);
  });

  it('exits 0 only when ok=true (no errors anywhere)', () => {
    let exitCode = -1;
    main({
      argv: ['node', 'migrate-preflight.mjs', '--post-apply'],
      exit: (c) => {
        exitCode = c;
      },
      log: () => {},
      warn: () => {},
      error: () => {},
      postApply: () => ({
        ok: true,
        errors: [],
        details: ['a2a_* tables: 3 found', 'FK constraints: all VALID'],
      }),
    });
    expect(exitCode).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// WKH-86 AC-6 — psql connection URL never appears in argv.
// T-MPF-PSQL-NO-LEAK / CD-WKH86-1
// ───────────────────────────────────────────────────────────────────────────

describe('buildPsqlConnectionEnv() — WKH-86 AC-6 (T-MPF-PSQL-NO-LEAK)', () => {
  it('parses a URL with password into args + PGPASSWORD env', () => {
    const out = buildPsqlConnectionEnv('postgres://alice:s3cr3t@db.example.com:5433/mydb');
    expect(out.args).toEqual(['-h', 'db.example.com', '-p', '5433', '-U', 'alice', '-d', 'mydb']);
    expect(out.env.PGPASSWORD).toBe('s3cr3t');
    // Critical: the password must NOT appear anywhere in args.
    expect(out.args.some((a) => a.includes('s3cr3t'))).toBe(false);
    expect(out.args.join(' ')).not.toContain('s3cr3t');
  });

  it('URL-decodes a percent-encoded password', () => {
    const out = buildPsqlConnectionEnv('postgres://alice:p%40ss%21@host/db');
    expect(out.env.PGPASSWORD).toBe('p@ss!');
    expect(out.args.join(' ')).not.toContain('p%40ss');
    expect(out.args.join(' ')).not.toContain('p@ss');
  });

  it('passes URL verbatim and adds NO PGPASSWORD when there is no password', () => {
    const out = buildPsqlConnectionEnv('postgres://alice@host/db');
    expect(out.args).toEqual(['postgres://alice@host/db']);
    expect(out.env.PGPASSWORD).toBeUndefined();
  });

  it('handles an unparseable URL by passing it verbatim (no crash, no leak path)', () => {
    const out = buildPsqlConnectionEnv('not-a-url');
    expect(out.args).toEqual(['not-a-url']);
    expect(out.env.PGPASSWORD).toBeUndefined();
  });

  it('handles a URL with no port (omits -p flag)', () => {
    const out = buildPsqlConnectionEnv('postgres://alice:secret@host/db');
    expect(out.args).toContain('-h');
    expect(out.args).toContain('host');
    expect(out.args).not.toContain('-p');
    expect(out.env.PGPASSWORD).toBe('secret');
  });
});

describe('runShadowDryRun() — WKH-86 AC-6 (T-MPF-PSQL-NO-LEAK)', () => {
  it('passes password via PGPASSWORD env, never via argv', () => {
    let captured: { args?: string[]; env?: Record<string, string> } = {};
    const mockSpawn = (
      _cmd: string,
      args: string[],
      opts: { env?: Record<string, string> },
    ) => {
      captured = { args, env: opts.env };
      return { status: 0, stdout: '', stderr: '' };
    };
    runShadowDryRun('SELECT 1;', {
      shadowUrl: 'postgres://shadow:topsecret@shadow.example.com:5432/sdb',
      spawn: mockSpawn,
    });
    // password must NOT be in argv anywhere
    expect(captured.args?.join(' ')).not.toContain('topsecret');
    // password must be in env via PGPASSWORD
    expect(captured.env?.PGPASSWORD).toBe('topsecret');
  });

  it('still passes shadow URL verbatim when there is no password (no behavior regression)', () => {
    let captured: { args?: string[]; env?: Record<string, string> } = {};
    const mockSpawn = (
      _cmd: string,
      args: string[],
      opts: { env?: Record<string, string> },
    ) => {
      captured = { args, env: opts.env };
      return { status: 0, stdout: '', stderr: '' };
    };
    runShadowDryRun('SELECT 1;', {
      shadowUrl: 'postgres://shadow.example.com/sdb',
      spawn: mockSpawn,
    });
    expect(captured.args?.[0]).toBe('postgres://shadow.example.com/sdb');
    expect(captured.env?.PGPASSWORD).toBeUndefined();
  });
});

describe('runPostApplyCheck() — WKH-86 AC-6 (T-MPF-PSQL-NO-LEAK)', () => {
  it('passes DATABASE_URL password via PGPASSWORD env for every sub-query', () => {
    /** @type {Array<{ args: string[]; env: Record<string,string> }>} */
    const calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
    const mockSpawn = (
      _cmd: string,
      args: string[],
      opts: { env?: Record<string, string> },
    ) => {
      calls.push({ args, env: opts.env });
      return { status: 0, stdout: 'a2a_agent_keys\na2a_events\na2a_protocol_fees\n', stderr: '' };
    };
    runPostApplyCheck({
      databaseUrl: 'postgres://prod:hunter2@db.prod.com:5432/proddb',
      spawn: mockSpawn,
    });
    // All three sub-queries must keep the password out of argv.
    expect(calls.length).toBe(3);
    for (const c of calls) {
      expect(c.args.join(' ')).not.toContain('hunter2');
      expect(c.env?.PGPASSWORD).toBe('hunter2');
    }
  });
});
