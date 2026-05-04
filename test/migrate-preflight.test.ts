/**
 * Tests for scripts/migrate-preflight.mjs — WKH-78 (AC-6).
 *
 * Pure unit tests with 100% mocks (CD-6). NEVER connects to a real Supabase
 * project (prod or shadow) — `spawnSync` is replaced via dependency injection
 * on `runShadowDryRun` / `runPostApplyCheck`, and `process.env` is restored
 * after each test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// @ts-expect-error -- the script is .mjs ESM with JSDoc types; vitest resolves
// it at runtime, but TypeScript has no resolver for it without a .d.ts.
import * as preflight from '../scripts/migrate-preflight.mjs';

const {
  analyze,
  hasHighRisk,
  stripComments,
  stripStringLiterals,
  splitStatements,
  buildDryRunPayload,
  runShadowDryRun,
  runPostApplyCheck,
  decide,
  formatFindings,
  POST_APPLY_QUERIES,
  EXPECTED_A2A_TABLES,
  main,
} = preflight as {
  analyze: (sql: string) => Array<{
    line: number;
    level: 'HIGH' | 'MEDIUM' | 'INFO';
    op: string;
    snippet: string;
  }>;
  hasHighRisk: (findings: ReturnType<typeof analyze>) => boolean;
  stripComments: (sql: string) => string;
  stripStringLiterals: (sql: string) => string;
  splitStatements: (sql: string) => Array<{ line: number; text: string }>;
  buildDryRunPayload: (sql: string) => string;
  runShadowDryRun: (
    sql: string,
    opts?: {
      shadowUrl?: string;
      // biome-ignore lint/suspicious/noExplicitAny: test mock injection
      spawn?: any;
      nowMs?: () => number;
    },
  ) => {
    skipped: boolean;
    reason?: string;
    ok?: boolean;
    ms?: number;
    error?: string;
  };
  runPostApplyCheck: (opts?: {
    databaseUrl?: string;
    // biome-ignore lint/suspicious/noExplicitAny: test mock injection
    spawn?: any;
    minA2aTables?: number;
    expectedA2aTables?: string[];
  }) => { ok: boolean; errors: string[]; details: string[] };
  decide: (
    findings: ReturnType<typeof analyze>,
    dryRun: ReturnType<typeof runShadowDryRun>,
    opts?: { slowMs?: number },
  ) => { pass: boolean; exitCode: number; summary: string };
  formatFindings: (findings: ReturnType<typeof analyze>) => string;
  POST_APPLY_QUERIES: { a2aTables: string; invalidFks: string; a2aIndexes: string };
  EXPECTED_A2A_TABLES: string[];
  main: (deps: {
    argv: string[];
    readFile?: (p: string) => string;
    exit?: (c: number) => void;
    log?: (m: string) => void;
    warn?: (m: string) => void;
    error?: (m: string) => void;
    // biome-ignore lint/suspicious/noExplicitAny: test mock injection
    shadowDryRun?: any;
    // biome-ignore lint/suspicious/noExplicitAny: test mock injection
    postApply?: any;
  }) => void;
};

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
        // a2a_* tables — provide both expected baseline tables (BLQ-MED-2).
        return {
          status: 0,
          stdout: 'a2a_agent_keys\na2a_protocol_fees\n',
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
