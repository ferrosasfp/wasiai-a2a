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
  buildDryRunPayload,
  runShadowDryRun,
  runPostApplyCheck,
  decide,
  formatFindings,
  POST_APPLY_QUERIES,
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
  }) => { ok: boolean; errors: string[]; details: string[] };
  decide: (
    findings: ReturnType<typeof analyze>,
    dryRun: ReturnType<typeof runShadowDryRun>,
    opts?: { slowMs?: number },
  ) => { pass: boolean; exitCode: number; summary: string };
  formatFindings: (findings: ReturnType<typeof analyze>) => string;
  POST_APPLY_QUERIES: { a2aTables: string; invalidFks: string; a2aIndexes: string };
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
        // a2a_* tables
        return { status: 0, stdout: 'a2a_agent_keys\na2a_registries\n', stderr: '' };
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
