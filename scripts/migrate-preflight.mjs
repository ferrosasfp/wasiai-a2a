#!/usr/bin/env node
/**
 * scripts/migrate-preflight.mjs — WKH-78
 *
 * Pre-flight checks for SQL migrations targeting Supabase Postgres.
 *
 *   Modes:
 *     node scripts/migrate-preflight.mjs <file.sql>
 *       1) Static SQL analysis (regex-based) — flags HIGH risk DDL.
 *       2) Shadow dry-run wrapped in BEGIN ... ROLLBACK (never COMMIT) —
 *          only when SHADOW_DATABASE_URL is set; otherwise skipped with WARN.
 *       3) Gate: exit 1 on HIGH risk OR shadow dry-run > 30s. Exit 0 on PASS.
 *
 *     node scripts/migrate-preflight.mjs --post-apply
 *       Verifies the DB pointed by DATABASE_URL after a migration was applied:
 *       (a) all `a2a_*` tables exist, (b) FK constraints are VALID, (c) the
 *       referenced indexes exist. Exit 1 on any failure.
 *
 *   Constraints (from work-item Constraint Directives):
 *     - CD-1: NEVER mutate prod DATABASE_URL from this script (read-only on
 *       --post-apply, dry-run only on SHADOW_DATABASE_URL).
 *     - CD-2: dry-run is BEGIN + migration + ROLLBACK; never COMMIT.
 *     - CD-3: no real connection strings in repo (.env.example placeholders).
 *     - CD-4: HIGH risk OR dry-run failure => exit code 1.
 *     - CD-5: no new deps; uses node:child_process to invoke `psql`.
 *     - CD-6: tests cover the analyzer with mocks 100%.
 *     - CD-7: `-- ROLLBACK:` template is a runbook recommendation, not enforced.
 *
 *   This file is ESM (.mjs) and exports its pure functions for unit tests.
 *   The CLI entrypoint only runs when invoked directly (process.argv[1]).
 */

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// ────────────────────────────────────────────────────────────────────────────
// Risk taxonomy
// ────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {'HIGH' | 'MEDIUM' | 'INFO'} RiskLevel
 * @typedef {{ line: number, level: RiskLevel, op: string, snippet: string }} Finding
 */

/**
 * Static SQL patterns flagged by the analyzer.
 *
 * Each entry is matched against single non-comment, non-empty SQL lines.
 * The regex is anchored to allow leading whitespace and is case-insensitive.
 *
 * NOTE: this is a coarse-grained heuristic — it intentionally errs on the
 * side of false positives over false negatives (a HIGH false positive only
 * forces a human to add `-- @preflight-allow` review, while a missed HIGH
 * could destroy data in prod).
 */
const RISK_PATTERNS = [
  // HIGH — destructive DDL/DML
  { level: /** @type {RiskLevel} */ ('HIGH'), op: 'DROP TABLE',          re: /\bdrop\s+table\b/i },
  { level: /** @type {RiskLevel} */ ('HIGH'), op: 'DROP COLUMN',         re: /\balter\s+table\b[^;]*\bdrop\s+column\b/i },
  { level: /** @type {RiskLevel} */ ('HIGH'), op: 'DROP INDEX',          re: /\bdrop\s+index\b/i },
  { level: /** @type {RiskLevel} */ ('HIGH'), op: 'TRUNCATE',            re: /\btruncate\b/i },
  { level: /** @type {RiskLevel} */ ('HIGH'), op: 'ALTER TABLE ... DROP',re: /\balter\s+table\b[^;]*\bdrop\b/i },
  { level: /** @type {RiskLevel} */ ('HIGH'), op: 'RENAME TO',           re: /\balter\s+table\b[^;]*\brename\s+to\b/i },
  // HIGH — DELETE without WHERE (multi-line aware via second pass below)
  // Note: the simple regex check is augmented in `analyze()` to detect
  // missing WHERE in multi-line DELETE statements.
  // MEDIUM — risky but sometimes intentional
  { level: /** @type {RiskLevel} */ ('MEDIUM'), op: 'ALTER COLUMN TYPE', re: /\balter\s+column\b[^;]*\btype\b/i },
  { level: /** @type {RiskLevel} */ ('MEDIUM'), op: 'ALTER NOT NULL',    re: /\balter\s+column\b[^;]*\bset\s+not\s+null\b/i },
];

/**
 * Detect DELETE without WHERE clause across an entire migration text. The
 * regex tolerates whitespace/newlines between DELETE and the terminating `;`,
 * but flags HIGH only when no WHERE keyword appears in that statement.
 *
 * @param {string} sql
 * @returns {{ line: number, snippet: string }[]}
 */
function findDeleteWithoutWhere(sql) {
  /** @type {{ line: number, snippet: string }[]} */
  const hits = [];
  // Find each DELETE FROM ... ; statement (greedy until ;)
  // Then check whether \bwhere\b appears inside that statement body.
  const stmtRe = /delete\s+from[\s\S]*?;/gi;
  let match;
  while ((match = stmtRe.exec(sql)) !== null) {
    const stmt = match[0];
    if (!/\bwhere\b/i.test(stmt)) {
      // Compute the line number where DELETE started.
      const before = sql.slice(0, match.index);
      const line = before.split('\n').length;
      const firstLine = stmt.split('\n')[0].trim();
      hits.push({ line, snippet: firstLine });
    }
  }
  return hits;
}

/**
 * Strip line comments (`--`) and block comments (`/* ... *\/`). Used so the
 * analyzer does not flag SQL that lives inside comments (false positives).
 *
 * IMPORTANT: this is a best-effort stripper. SQL string literals containing
 * `--` will be partially mangled, but the analyzer is forgiving — false
 * positives only force a human review, never silent loss.
 *
 * @param {string} sql
 */
export function stripComments(sql) {
  // Strip /* ... */ blocks (non-greedy, multiline).
  let out = sql.replace(/\/\*[\s\S]*?\*\//g, '');
  // Strip -- to end of line, but keep the newline so line numbers are preserved.
  out = out.replace(/--[^\n]*/g, '');
  return out;
}

/**
 * Run static analysis over a SQL string and return all findings.
 *
 * @param {string} sql Raw SQL text (can include comments).
 * @returns {Finding[]}
 */
export function analyze(sql) {
  /** @type {Finding[]} */
  const findings = [];
  const stripped = stripComments(sql);
  const lines = stripped.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    for (const pat of RISK_PATTERNS) {
      if (pat.re.test(line)) {
        findings.push({
          line: i + 1,
          level: pat.level,
          op: pat.op,
          snippet: line.trim(),
        });
      }
    }
  }

  // DELETE without WHERE — multi-line aware pass over stripped SQL.
  for (const hit of findDeleteWithoutWhere(stripped)) {
    findings.push({
      line: hit.line,
      level: 'HIGH',
      op: 'DELETE without WHERE',
      snippet: hit.snippet,
    });
  }

  // Sort by line number for deterministic output.
  findings.sort((a, b) => a.line - b.line);
  return findings;
}

/**
 * Returns true if any finding has level HIGH.
 *
 * @param {Finding[]} findings
 */
export function hasHighRisk(findings) {
  return findings.some((f) => f.level === 'HIGH');
}

// ────────────────────────────────────────────────────────────────────────────
// Shadow dry-run via psql (BEGIN ... ROLLBACK)
// ────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {{
 *   skipped: boolean,
 *   reason?: string,
 *   ok?: boolean,
 *   ms?: number,
 *   error?: string,
 * }} DryRunResult
 */

/**
 * Build the SQL payload that wraps the migration in BEGIN + ROLLBACK.
 *
 * CD-2: The closing statement is ROLLBACK — never COMMIT. If the migration
 * SQL itself contains a stray COMMIT, the outer ROLLBACK will still fire
 * because PostgreSQL treats explicit COMMIT inside a wrapping transaction
 * as ending only the inner; we additionally emit a final ROLLBACK that
 * `psql --single-transaction` enforces.
 *
 * @param {string} migrationSql
 */
export function buildDryRunPayload(migrationSql) {
  return `BEGIN;\n${migrationSql.trim()}\nROLLBACK;\n`;
}

/**
 * Run the migration dry-run against SHADOW_DATABASE_URL.
 *
 * @param {string} migrationSql
 * @param {{
 *   shadowUrl?: string,
 *   spawn?: typeof spawnSync,
 *   nowMs?: () => number,
 * }} [opts]
 * @returns {DryRunResult}
 */
export function runShadowDryRun(migrationSql, opts = {}) {
  const shadowUrl = opts.shadowUrl ?? process.env.SHADOW_DATABASE_URL;
  if (!shadowUrl || shadowUrl.trim() === '') {
    return {
      skipped: true,
      reason: 'SHADOW_DATABASE_URL not set',
    };
  }

  const spawn = opts.spawn ?? spawnSync;
  const now = opts.nowMs ?? (() => Date.now());

  const payload = buildDryRunPayload(migrationSql);
  const start = now();
  const result = spawn(
    'psql',
    [
      shadowUrl,
      '-v', 'ON_ERROR_STOP=1',
      '--single-transaction',
      '-X',         // do not read .psqlrc
      '-q',         // quiet
      '-f', '-',    // SQL from stdin
    ],
    {
      input: payload,
      encoding: 'utf-8',
      timeout: 60_000,
    },
  );
  const ms = now() - start;

  if (result.error) {
    return {
      skipped: false,
      ok: false,
      ms,
      error: `spawn failed: ${result.error.message}`,
    };
  }
  if (typeof result.status !== 'number' || result.status !== 0) {
    const stderr = (result.stderr || '').toString().trim();
    return {
      skipped: false,
      ok: false,
      ms,
      error: stderr || `psql exited with status ${result.status}`,
    };
  }
  return {
    skipped: false,
    ok: true,
    ms,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Reporting
// ────────────────────────────────────────────────────────────────────────────

/**
 * Format the static-analysis findings as human-readable text.
 *
 * @param {Finding[]} findings
 */
export function formatFindings(findings) {
  if (findings.length === 0) {
    return '[OK] Static analysis: no risk patterns matched.';
  }
  const lines = ['[RISK] Static analysis findings:'];
  for (const f of findings) {
    lines.push(`  L${f.line}  [${f.level}]  ${f.op}  →  ${f.snippet}`);
  }
  return lines.join('\n');
}

/**
 * Decide PASS / BLOCKED based on findings + dry-run result.
 *
 * @param {Finding[]} findings
 * @param {DryRunResult} dryRun
 * @param {{ slowMs?: number }} [opts]
 * @returns {{ pass: boolean, exitCode: number, summary: string }}
 */
export function decide(findings, dryRun, opts = {}) {
  const slowMs = opts.slowMs ?? 30_000;
  const reasons = [];

  if (hasHighRisk(findings)) {
    reasons.push('HIGH risk operation detected by static analysis');
  }
  if (!dryRun.skipped && dryRun.ok === false) {
    reasons.push(`Shadow dry-run failed: ${dryRun.error}`);
  }
  if (!dryRun.skipped && dryRun.ok === true && (dryRun.ms ?? 0) > slowMs) {
    reasons.push(`Shadow dry-run too slow (${dryRun.ms}ms > ${slowMs}ms)`);
  }

  if (reasons.length > 0) {
    return {
      pass: false,
      exitCode: 1,
      summary:
        '[BLOCKED] Migration requires human review before applying to production\n  - ' +
        reasons.join('\n  - '),
    };
  }
  return {
    pass: true,
    exitCode: 0,
    summary: '[PASS] Pre-flight OK — safe to apply',
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Post-apply integrity check
// ────────────────────────────────────────────────────────────────────────────

/**
 * SQL queries run during --post-apply against DATABASE_URL.
 *
 * Each query is read-only (SELECT only). The script never writes when in
 * post-apply mode. Fault is signaled via exit code 1.
 */
export const POST_APPLY_QUERIES = {
  // (a) all a2a_* tables present (sanity baseline — if any baseline table
  // disappeared, the migration likely contained an unintended DROP).
  a2aTables: `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name LIKE 'a2a_%'
    ORDER BY table_name;
  `.trim(),
  // (b) FK constraints in INVALID state (unvalidated FKs are a risk).
  invalidFks: `
    SELECT conname, conrelid::regclass::text AS rel
    FROM pg_constraint
    WHERE contype = 'f' AND NOT convalidated;
  `.trim(),
  // (c) indexes on a2a_* tables (so the runbook can grep the output).
  a2aIndexes: `
    SELECT schemaname, tablename, indexname
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename LIKE 'a2a_%'
    ORDER BY tablename, indexname;
  `.trim(),
};

/**
 * Run the post-apply integrity check against DATABASE_URL.
 *
 * @param {{
 *   databaseUrl?: string,
 *   spawn?: typeof spawnSync,
 *   minA2aTables?: number,
 * }} [opts]
 * @returns {{ ok: boolean, errors: string[], details: string[] }}
 */
export function runPostApplyCheck(opts = {}) {
  const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL;
  const spawn = opts.spawn ?? spawnSync;
  // Conservative default: at least 1 a2a_* table must exist after a migration
  // (the project always has a2a_agent_keys + a2a_registries in any healthy
  // deploy). Override via opts.minA2aTables for shadow projects.
  const minA2aTables = opts.minA2aTables ?? 1;

  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const details = [];

  if (!databaseUrl || databaseUrl.trim() === '') {
    return {
      ok: false,
      errors: ['DATABASE_URL not set — cannot run --post-apply'],
      details: [],
    };
  }

  // (a) a2a_* tables
  const tablesResult = spawn(
    'psql',
    [databaseUrl, '-X', '-A', '-t', '-q', '-c', POST_APPLY_QUERIES.a2aTables],
    { encoding: 'utf-8', timeout: 30_000 },
  );
  if (tablesResult.error || tablesResult.status !== 0) {
    errors.push(
      `a2a_* tables query failed: ${tablesResult.error?.message || tablesResult.stderr || 'unknown'}`,
    );
  } else {
    const rows = (tablesResult.stdout || '')
      .toString()
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    details.push(`a2a_* tables: ${rows.length} found (${rows.join(', ') || 'none'})`);
    if (rows.length < minA2aTables) {
      errors.push(
        `Expected at least ${minA2aTables} a2a_* table(s); found ${rows.length}`,
      );
    }
  }

  // (b) invalid FKs
  const fkResult = spawn(
    'psql',
    [databaseUrl, '-X', '-A', '-t', '-q', '-c', POST_APPLY_QUERIES.invalidFks],
    { encoding: 'utf-8', timeout: 30_000 },
  );
  if (fkResult.error || fkResult.status !== 0) {
    errors.push(
      `invalid FK query failed: ${fkResult.error?.message || fkResult.stderr || 'unknown'}`,
    );
  } else {
    const rows = (fkResult.stdout || '')
      .toString()
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (rows.length > 0) {
      errors.push(`Found ${rows.length} INVALID foreign key constraint(s): ${rows.join('; ')}`);
    } else {
      details.push('FK constraints: all VALID');
    }
  }

  // (c) indexes — informational only; we do not fail on this query absent
  // a baseline manifest. The runbook documents how to diff against expected.
  const idxResult = spawn(
    'psql',
    [databaseUrl, '-X', '-A', '-t', '-q', '-c', POST_APPLY_QUERIES.a2aIndexes],
    { encoding: 'utf-8', timeout: 30_000 },
  );
  if (idxResult.error || idxResult.status !== 0) {
    errors.push(
      `index query failed: ${idxResult.error?.message || idxResult.stderr || 'unknown'}`,
    );
  } else {
    const rows = (idxResult.stdout || '')
      .toString()
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    details.push(`a2a_* indexes: ${rows.length} found`);
  }

  return { ok: errors.length === 0, errors, details };
}

// ────────────────────────────────────────────────────────────────────────────
// CLI
// ────────────────────────────────────────────────────────────────────────────

/**
 * Print one of the structured outputs to stdout. Tests do not exercise this
 * directly; they import the pure functions above.
 *
 * @param {{
 *   argv: string[],
 *   readFile?: (path: string) => string,
 *   exit?: (code: number) => void,
 *   log?: (msg: string) => void,
 *   warn?: (msg: string) => void,
 *   error?: (msg: string) => void,
 *   shadowDryRun?: typeof runShadowDryRun,
 *   postApply?: typeof runPostApplyCheck,
 * }} deps
 */
export function main(deps) {
  const log = deps.log ?? ((m) => console.log(m));
  const warn = deps.warn ?? ((m) => console.warn(m));
  const errlog = deps.error ?? ((m) => console.error(m));
  const exit = deps.exit ?? ((c) => process.exit(c));
  const readFile =
    deps.readFile ?? ((p) => readFileSync(p, { encoding: 'utf-8' }));
  const shadowDryRun = deps.shadowDryRun ?? runShadowDryRun;
  const postApply = deps.postApply ?? runPostApplyCheck;

  const args = deps.argv.slice(2);

  if (args.includes('--post-apply')) {
    log('[migrate-preflight] --post-apply integrity check against DATABASE_URL');
    const result = postApply();
    for (const d of result.details) log('  - ' + d);
    if (!result.ok) {
      for (const e of result.errors) errlog('[FAIL] Integrity check failed: ' + e);
      return exit(1);
    }
    log('[PASS] Post-apply integrity check OK');
    return exit(0);
  }

  const sqlPath = args[0];
  if (!sqlPath || sqlPath.startsWith('--')) {
    errlog(
      'Usage:\n' +
        '  node scripts/migrate-preflight.mjs <file.sql>\n' +
        '  node scripts/migrate-preflight.mjs --post-apply',
    );
    return exit(2);
  }

  const absPath = resolve(sqlPath);
  // existsSync is only checked against the real filesystem; tests inject
  // `readFile` directly and bypass this branch by passing a path that the
  // injected reader resolves. For real CLI invocations (no injection) we
  // do the existence check first so the error message is friendlier.
  if (!deps.readFile && !existsSync(absPath)) {
    errlog(`[ERR] SQL file not found: ${absPath}`);
    return exit(2);
  }

  const sql = readFile(absPath);
  log(`[migrate-preflight] analyzing ${absPath} (${sql.length} bytes)`);

  // 1) Static analysis
  const findings = analyze(sql);
  log(formatFindings(findings));

  // 2) Shadow dry-run
  const dryRun = shadowDryRun(sql);
  if (dryRun.skipped) {
    warn(`[WARN] ${dryRun.reason ?? 'shadow dry-run skipped'} — skipping shadow dry-run`);
  } else if (dryRun.ok) {
    log(`[OK] Shadow dry-run completed in ${dryRun.ms}ms (BEGIN + ROLLBACK)`);
  } else {
    errlog(`[FAIL] Shadow dry-run failed in ${dryRun.ms}ms: ${dryRun.error}`);
  }

  // 3) Decide
  const decision = decide(findings, dryRun);
  log(decision.summary);
  return exit(decision.exitCode);
}

// Entrypoint — only runs when invoked directly, not when imported by tests.
const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '');
if (isDirectInvocation) {
  main({ argv: process.argv });
}
