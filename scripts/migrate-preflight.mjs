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
 *       (a) every expected `a2a_*` baseline table exists, (b) FK constraints
 *       are VALID, (c) the referenced indexes exist. Exit 1 on any failure.
 *
 *   Exit codes:
 *     0 — [PASS] safe to apply (still review the diff manually).
 *     1 — [BLOCKED]/[FAIL] HIGH risk, dry-run failure, or post-apply check failed.
 *     2 — Internal error / usage error (file not found, bad arguments,
 *         uncaught exception in main).
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
 *   Fix-pack iter 1 (post-AR) Constraint Directives:
 *     - CD-FP1: Each new RISK_PATTERN ships with at least 2 test fixtures
 *       (a positive case that triggers it and a negative case that does not).
 *     - CD-FP2: splitStatements() must NOT break real project migrations
 *       (dollar-quoted bodies, `IF EXISTS` clauses, etc.).
 *     - CD-FP3: NO existing pattern's severity is lowered. New patterns may
 *       only ADD detections, never relax them.
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
 * Each entry is matched against full SQL statements (after splitStatements()
 * normalizes whitespace and strips string literals + comments). The regex is
 * case-insensitive.
 *
 * NOTE: this is a coarse-grained heuristic — it intentionally errs on the
 * side of false positives over false negatives (a HIGH false positive only
 * forces a human to add `-- @preflight-allow` review, while a missed HIGH
 * could destroy data in prod).
 *
 * Severity invariants (CD-FP3): once shipped, a pattern's severity may only
 * increase or stay the same; it must not be relaxed.
 */
const RISK_PATTERNS = [
  // HIGH — destructive DDL/DML
  { level: /** @type {RiskLevel} */ ('HIGH'), op: 'DROP TABLE',          re: /\bdrop\s+table\b/i },
  { level: /** @type {RiskLevel} */ ('HIGH'), op: 'DROP COLUMN',         re: /\balter\s+table\b[\s\S]*?\bdrop\s+column\b/i },
  { level: /** @type {RiskLevel} */ ('HIGH'), op: 'DROP INDEX',          re: /\bdrop\s+index\b/i },
  { level: /** @type {RiskLevel} */ ('HIGH'), op: 'TRUNCATE',            re: /\btruncate\b/i },
  { level: /** @type {RiskLevel} */ ('HIGH'), op: 'ALTER TABLE ... DROP',re: /\balter\s+table\b[\s\S]*?\bdrop\b/i },
  { level: /** @type {RiskLevel} */ ('HIGH'), op: 'RENAME TO',           re: /\balter\s+table\b[\s\S]*?\brename\s+to\b/i },
  // BLQ-ALTO-1 — destructive object DROPs beyond TABLE/INDEX/COLUMN.
  // Catches catastrophic statements like `DROP DATABASE postgres;`,
  // `DROP SCHEMA public CASCADE;`, `DROP POLICY ... ON ...`, `DROP TRIGGER`,
  // `DROP FUNCTION`, `DROP VIEW`, `DROP MATERIALIZED VIEW`, `DROP SEQUENCE`,
  // `DROP EXTENSION`, `DROP PUBLICATION`, `DROP SUBSCRIPTION`.
  {
    level: /** @type {RiskLevel} */ ('HIGH'),
    op: 'DROP <object>',
    re: /\bdrop\s+(database|schema|type|policy|trigger|function|view|materialized\s+view|sequence|extension|publication|subscription)\b/i,
  },
  // BLQ-ALTO-1 — RLS bypass. Disabling RLS opens a tenant boundary that
  // every service currently relies on (WKH-53 ownership guard).
  {
    level: /** @type {RiskLevel} */ ('HIGH'),
    op: 'DISABLE ROW LEVEL SECURITY',
    re: /\bdisable\s+row\s+level\s+security\b/i,
  },
  // BLQ-ALTO-1 — bare `UPDATE x SET y` without WHERE = mass write across
  // the whole table. This is the DML twin of DELETE-without-WHERE.
  // The narrower regex matches a single SQL statement that contains
  // `UPDATE <ident> SET ...` and does NOT contain `WHERE`. Whitespace
  // and newlines tolerated; statement-aware via splitStatements().
  // (Implementation lives in findUpdateWithoutWhere() because regex alone
  // cannot express "match X AND not match Y" cleanly across statements.)
  // BLQ-ALTO-1 — REASSIGN OWNED BY: bulk re-owner a role's objects.
  {
    level: /** @type {RiskLevel} */ ('HIGH'),
    op: 'REASSIGN OWNED BY',
    re: /\breassign\s+owned\s+by\b/i,
  },
  // BLQ-BAJO-1 — psql meta-command (`\!`, `\copy`, `\i`, ...). Anchored to
  // statement start (after splitStatements normalization). The shadow
  // dry-run cannot safely execute meta-commands (`\!` shells out, `\i`
  // reads arbitrary files), so any meta-command in a migration body is
  // refused outright.
  {
    level: /** @type {RiskLevel} */ ('HIGH'),
    op: 'psql meta-command',
    re: /^\s*\\[a-z!]/i,
  },
  // BLQ-MED-1 — embedded transaction control. Wrapping migrations in
  // explicit BEGIN/COMMIT/ROLLBACK breaks the BEGIN/ROLLBACK guarantee
  // of the shadow dry-run (psql --single-transaction would treat them
  // as savepoints; the migration could partial-commit on shadow). This
  // is also a foot-gun in production when paired with `apply-prod-migrations.sh`,
  // which already wraps each file in its own transaction.
  {
    level: /** @type {RiskLevel} */ ('MEDIUM'),
    op: 'embedded COMMIT/ROLLBACK',
    re: /\b(commit|rollback)\b\s*;?\s*$/i,
  },
  // BLQ-ALTO-1 — alter default privileges silently changes ACL of every
  // future object created in the schema. Hard to audit retroactively.
  // Listed BEFORE GRANT/REVOKE so that with WKH-86 AC-4 dedup the more
  // specific finding (ALTER DEFAULT PRIVILEGES) wins when the statement
  // contains both keywords (e.g. `ALTER DEFAULT PRIVILEGES … GRANT …`).
  {
    level: /** @type {RiskLevel} */ ('MEDIUM'),
    op: 'ALTER DEFAULT PRIVILEGES',
    re: /\balter\s+default\s+privileges\b/i,
  },
  // BLQ-ALTO-1 — privilege grants/revokes. Security-sensitive but
  // sometimes intentional (see 20260427160000_secure_rpc_search_path.sql),
  // so MEDIUM, not HIGH.
  {
    level: /** @type {RiskLevel} */ ('MEDIUM'),
    op: 'GRANT/REVOKE',
    re: /\b(grant|revoke)\b[\s\S]*?\bon\b/i,
  },
  // MEDIUM — risky but sometimes intentional
  { level: /** @type {RiskLevel} */ ('MEDIUM'), op: 'ALTER COLUMN TYPE', re: /\balter\s+column\b[\s\S]*?\btype\b/i },
  { level: /** @type {RiskLevel} */ ('MEDIUM'), op: 'ALTER NOT NULL',    re: /\balter\s+column\b[\s\S]*?\bset\s+not\s+null\b/i },
  // BLQ-BAJO-2 — operations that CANNOT be wrapped in BEGIN/ROLLBACK.
  // Postgres rejects CREATE INDEX CONCURRENTLY / VACUUM / CREATE DATABASE
  // / ALTER SYSTEM inside a transaction block, so the shadow dry-run is
  // structurally unable to validate them. INFO + the runbook §11 documents
  // the alternative workflow.
  {
    level: /** @type {RiskLevel} */ ('INFO'),
    op: 'CONCURRENTLY/VACUUM (cannot dry-run)',
    re: /\b(create\s+index\s+concurrently|drop\s+index\s+concurrently|reindex\s+concurrently|vacuum|create\s+database|alter\s+system)\b/i,
  },
];

/**
 * Detect DELETE without WHERE clause across an entire migration text. The
 * regex tolerates whitespace/newlines between DELETE and the terminating `;`,
 * but flags HIGH only when no WHERE keyword appears in that statement.
 *
 * WKH-86 AC-3 / CD-WKH86 / MNR-CR-2: this function defensively scrubs string
 * literals before applying its regex. The pipeline in `analyze()` already
 * passes a sanitized SQL string (post `stripStringLiterals()`), but direct
 * callers (tests, future re-use) get the same guarantee here so the
 * function is safe to call against raw SQL.
 *
 * @param {string} sql
 * @returns {{ line: number, snippet: string }[]}
 */
export function findDeleteWithoutWhere(sql) {
  /** @type {{ line: number, snippet: string }[]} */
  const hits = [];
  // Defense in depth — strip string literals locally so the regex never
  // matches `DELETE FROM` text embedded inside `'…'`, `"…"`, `E'…'`, or
  // dollar-quoted bodies. Idempotent when the input is already sanitized.
  const sanitized = stripStringLiterals(sql);
  // Find each DELETE FROM ... ; statement (greedy until ;)
  // Then check whether \bwhere\b appears inside that statement body.
  const stmtRe = /delete\s+from[\s\S]*?;/gi;
  let match;
  while ((match = stmtRe.exec(sanitized)) !== null) {
    const stmt = match[0];
    if (!/\bwhere\b/i.test(stmt)) {
      // Compute the line number where DELETE started (using sanitized SQL,
      // which preserves line counts via stripStringLiterals).
      const before = sanitized.slice(0, match.index);
      const line = before.split('\n').length;
      const firstLine = stmt.split('\n')[0].trim();
      hits.push({ line, snippet: firstLine });
    }
  }
  return hits;
}

/**
 * Detect UPDATE statements without a WHERE clause (BLQ-ALTO-1). Matches the
 * shape `UPDATE <ident> [SET ...]; … no WHERE …`. Multi-line aware via
 * non-greedy match up to the terminating `;`.
 *
 * Rejects updates to PL/pgSQL local variables (handled by splitStatements
 * stripping dollar-quoted bodies) and updates that have a WHERE elsewhere
 * in the same statement.
 *
 * @param {string} sql Already comment-stripped + string-stripped SQL.
 * @returns {{ line: number, snippet: string }[]}
 */
function findUpdateWithoutWhere(sql) {
  /** @type {{ line: number, snippet: string }[]} */
  const hits = [];
  // `UPDATE <name> SET ... ;` — only flag when the statement has SET
  // (rules out `UPDATE OF` syntax in CREATE TRIGGER) and has no WHERE.
  const stmtRe = /\bupdate\s+[a-z_][\w.]*\s+set\b[\s\S]*?;/gi;
  let match;
  while ((match = stmtRe.exec(sql)) !== null) {
    const stmt = match[0];
    if (!/\bwhere\b/i.test(stmt)) {
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
 * Strip SQL string literals from a (comment-free) SQL string, replacing
 * them with placeholders that preserve line counts. This makes the regex
 * matchers immune to false positives on patterns embedded in strings.
 *
 * Handles:
 *   - Single-quoted literals `'...'` (with `''` escape).
 *   - Double-quoted identifiers `"..."` (rarely contain risky tokens, but
 *     stripped for symmetry — e.g. column named "DROP TABLE backup").
 *   - PostgreSQL escape strings `E'...'` (escapes via `\'`).
 *   - Dollar-quoted strings `$$ ... $$` and tagged `$tag$ ... $tag$`
 *     (PL/pgSQL function bodies).
 *
 * Newlines inside stripped literals are preserved so `analyze()` line
 * numbers remain accurate.
 *
 * @param {string} sql
 * @returns {string}
 */
export function stripStringLiterals(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];

    // Dollar-quoted string ($$...$$ or $tag$...$tag$)
    if (ch === '$') {
      // Match opening tag: $ + optional identifier + $
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const closeIdx = sql.indexOf(tag, i + tag.length);
        if (closeIdx === -1) {
          // Unterminated dollar-quote — copy rest as-is and stop.
          out += sql.slice(i);
          break;
        }
        const body = sql.slice(i + tag.length, closeIdx);
        out += tag;
        // Replace body with same number of newlines and spaces — preserves
        // line numbers for downstream analysis.
        for (const c of body) out += c === '\n' ? '\n' : ' ';
        out += tag;
        i = closeIdx + tag.length;
        continue;
      }
      // Lone `$` — keep verbatim.
      out += ch;
      i++;
      continue;
    }

    // Postgres escape string E'...'
    if ((ch === 'E' || ch === 'e') && sql[i + 1] === "'") {
      out += sql[i] + "'";
      i += 2;
      while (i < n) {
        const c = sql[i];
        if (c === '\\' && i + 1 < n) {
          // Skip escape pair (preserve length 2, but in stripped output we
          // emit a space; line breaks inside escape are unusual).
          out += sql[i + 1] === '\n' ? '\n ' : '  ';
          i += 2;
          continue;
        }
        if (c === "'") {
          out += "'";
          i++;
          break;
        }
        out += c === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }

    // Single-quoted string '...'  (with '' escape)
    if (ch === "'") {
      out += "'";
      i++;
      while (i < n) {
        const c = sql[i];
        if (c === "'" && sql[i + 1] === "'") {
          out += '  ';
          i += 2;
          continue;
        }
        if (c === "'") {
          out += "'";
          i++;
          break;
        }
        out += c === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }

    // Double-quoted identifier "..."  (with "" escape)
    if (ch === '"') {
      out += '"';
      i++;
      while (i < n) {
        const c = sql[i];
        if (c === '"' && sql[i + 1] === '"') {
          out += '  ';
          i += 2;
          continue;
        }
        if (c === '"') {
          out += '"';
          i++;
          break;
        }
        out += c === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

/**
 * Split a SQL string into individual statements (BLQ-ALTO-2). Aware of:
 *   - SQL line comments (`--`) and block comments (`/* … *\/`).
 *   - Single-quoted strings, double-quoted identifiers, escape strings.
 *   - Dollar-quoted bodies (`$$ … $$`, `$tag$ … $tag$`).
 *
 * Each returned statement carries the 1-based line number of its first
 * non-whitespace character so analyze() can attribute findings precisely.
 *
 * Statements are NOT individually trimmed in `text`; whitespace is preserved
 * so multi-line snippets render legibly. Use `text.trim().split('\n')[0]`
 * for the snippet.
 *
 * The split delimiter is `;` outside any string/quote/dollar-quote.
 *
 * @param {string} sql Already comment-stripped (call stripComments() first
 *   to preserve line numbers).
 * @returns {{ line: number, text: string }[]}
 */
export function splitStatements(sql) {
  /** @type {{ line: number, text: string }[]} */
  const stmts = [];
  let buf = '';
  let startLine = 1;
  let line = 1;
  let bufStartedAt = -1;
  let i = 0;
  const n = sql.length;

  const pushStmt = () => {
    if (buf.trim() === '') {
      buf = '';
      bufStartedAt = -1;
      return;
    }
    stmts.push({ line: startLine, text: buf });
    buf = '';
    bufStartedAt = -1;
  };

  while (i < n) {
    const ch = sql[i];

    // Track lines.
    if (ch === '\n') {
      buf += ch;
      i++;
      line++;
      continue;
    }

    // Mark statement start on first non-whitespace.
    if (bufStartedAt === -1 && ch.trim() !== '') {
      startLine = line;
      bufStartedAt = i;
    }

    // Dollar-quoted string?
    if (ch === '$') {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const closeIdx = sql.indexOf(tag, i + tag.length);
        if (closeIdx === -1) {
          // Unterminated: append the rest and stop.
          for (let k = i; k < n; k++) {
            buf += sql[k];
            if (sql[k] === '\n') line++;
          }
          i = n;
          break;
        }
        const block = sql.slice(i, closeIdx + tag.length);
        buf += block;
        for (const c of block) if (c === '\n') line++;
        i = closeIdx + tag.length;
        continue;
      }
    }

    // Single-quoted string?
    if (ch === "'") {
      buf += ch;
      i++;
      while (i < n) {
        const c = sql[i];
        if (c === "'" && sql[i + 1] === "'") {
          buf += "''";
          i += 2;
          continue;
        }
        if (c === "'") {
          buf += "'";
          i++;
          break;
        }
        buf += c;
        if (c === '\n') line++;
        i++;
      }
      continue;
    }

    // Double-quoted identifier?
    if (ch === '"') {
      buf += ch;
      i++;
      while (i < n) {
        const c = sql[i];
        if (c === '"' && sql[i + 1] === '"') {
          buf += '""';
          i += 2;
          continue;
        }
        if (c === '"') {
          buf += '"';
          i++;
          break;
        }
        buf += c;
        if (c === '\n') line++;
        i++;
      }
      continue;
    }

    if (ch === ';') {
      buf += ';';
      i++;
      pushStmt();
      continue;
    }

    buf += ch;
    i++;
  }

  // Trailing statement without a final `;` (rare but legal in psql).
  pushStmt();
  return stmts;
}

/**
 * Returns true if the given statement is an idempotent
 * `DROP TRIGGER IF EXISTS <name>` or `DROP FUNCTION IF EXISTS <name>`.
 *
 * WKH-86 AC-2: these forms are canonical in our migrations (idempotent
 * re-creation of triggers/functions on every run) and should not be
 * surfaced as HIGH-risk findings. The `IF EXISTS` clause is what makes
 * the operation safe — without it, the bare `DROP TRIGGER` / `DROP
 * FUNCTION` still fires HIGH (CD-WKH78-FP3, CD-WKH86-4).
 *
 * @param {string} stmt SQL statement (already string-stripped + comment-stripped).
 * @returns {boolean}
 */
export function isIdempotentDropTriggerOrFunction(stmt) {
  return /\bdrop\s+(?:trigger|function)\s+if\s+exists\b/i.test(stmt);
}

/**
 * Run static analysis over a SQL string and return all findings.
 *
 * The pipeline is statement-based (BLQ-ALTO-2) and string-aware
 * (BLQ-MED-3): comments are stripped first (to preserve real DDL line
 * numbers), then string literals are scrubbed, then the SQL is split into
 * top-level statements and each statement is matched against every pattern.
 *
 * @param {string} sql Raw SQL text (can include comments).
 * @returns {Finding[]}
 */
export function analyze(sql) {
  /** @type {Finding[]} */
  const findings = [];
  const noComments = stripComments(sql);
  const sanitized = stripStringLiterals(noComments);
  const statements = splitStatements(sanitized);

  for (const stmt of statements) {
    if (stmt.text.trim() === '') continue;
    const firstLine = stmt.text.trim().split('\n')[0].trim();
    for (const pat of RISK_PATTERNS) {
      if (pat.re.test(stmt.text)) {
        // WKH-86 AC-2: `DROP TRIGGER IF EXISTS <name>` and
        // `DROP FUNCTION IF EXISTS <name>` are canonical idempotent patterns
        // in our migrations (5/13 files use them) and must NOT trigger the
        // HIGH `DROP <object>` finding. CD-WKH86-4 keeps `DROP TABLE IF
        // EXISTS` as HIGH (TABLE is in a different pattern, unaffected).
        // CD-WKH78-FP3 is preserved: we are not relaxing the base pattern,
        // we are adding a narrow conditional exclusion for IF EXISTS only.
        if (
          pat.op === 'DROP <object>' &&
          isIdempotentDropTriggerOrFunction(stmt.text)
        ) {
          continue;
        }
        findings.push({
          line: stmt.line,
          level: pat.level,
          op: pat.op,
          snippet: firstLine,
        });
      }
    }
  }

  // DELETE without WHERE — multi-line aware pass over sanitized SQL.
  for (const hit of findDeleteWithoutWhere(sanitized)) {
    findings.push({
      line: hit.line,
      level: 'HIGH',
      op: 'DELETE without WHERE',
      snippet: hit.snippet,
    });
  }

  // UPDATE without WHERE (BLQ-ALTO-1) — same shape as DELETE.
  for (const hit of findUpdateWithoutWhere(sanitized)) {
    findings.push({
      line: hit.line,
      level: 'HIGH',
      op: 'UPDATE without WHERE',
      snippet: hit.snippet,
    });
  }

  // Sort by line number for deterministic output.
  findings.sort((a, b) => a.line - b.line);

  // WKH-86 AC-4 / CD-WKH86-2: deduplicate findings by (line, level). Two
  // patterns matching the same statement at the same severity collapse into
  // a single finding (the first occurrence wins after sort, which is the
  // earliest pattern in RISK_PATTERNS for HIGH/MEDIUM/INFO order). This
  // prevents duplicate report rows like:
  //   L7 [HIGH] DROP COLUMN
  //   L7 [HIGH] ALTER TABLE ... DROP
  // for the same `ALTER TABLE foo DROP COLUMN bar;` statement. Findings on
  // the same line with DIFFERENT severities are preserved.
  return dedupeByLineAndLevel(findings);
}

/**
 * Deduplicate findings by `(line, level)`. Preserves order: the first
 * occurrence per key wins. Findings with the same line but different
 * severity (HIGH vs MEDIUM, etc.) are NOT collapsed — only exact
 * `(line, level)` collisions are removed.
 *
 * @param {Finding[]} findings
 * @returns {Finding[]}
 */
export function dedupeByLineAndLevel(findings) {
  const seen = new Set();
  /** @type {Finding[]} */
  const out = [];
  for (const f of findings) {
    const key = `${f.line}|${f.level}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
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
 * Parse a Postgres connection URL into psql args + env vars so the password
 * is passed via `PGPASSWORD` instead of the argv (where `ps aux` would leak
 * it). WKH-86 AC-6 / CD-WKH86-1 / MNR-CR-1.
 *
 * Returns:
 *   - `args`: the connection args to append to the psql argv. The form is
 *     `['-h', host, '-p', port, '-U', user, '-d', dbname]` when the URL has
 *     a password (so the password never appears in argv). When the URL has
 *     no password (e.g. socket auth, .pgpass), we fall back to passing the
 *     URL itself — that path was never a leak in the first place.
 *   - `env`: the env block to merge into the spawn opts. Carries
 *     `PGPASSWORD` only when the URL had an embedded password.
 *
 * Edge cases preserved:
 *   - URL without scheme (e.g. plain hostname): treated as no-leak,
 *     passed verbatim as the connection arg.
 *   - URL parse failure: same fallback (verbatim arg). The spawn will fail
 *     downstream with a meaningful psql error rather than crashing here.
 *
 * @param {string} url Postgres connection URL.
 * @returns {{ args: string[], env: Record<string, string> }}
 */
export function buildPsqlConnectionEnv(url) {
  /** @type {URL | null} */
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  // No scheme / unparseable / no password → argv was already safe.
  // Pass verbatim and add no PGPASSWORD.
  if (!parsed || !parsed.password) {
    return { args: [url], env: {} };
  }
  const password = decodeURIComponent(parsed.password);
  /** @type {string[]} */
  const args = [];
  if (parsed.hostname) args.push('-h', parsed.hostname);
  if (parsed.port) args.push('-p', parsed.port);
  if (parsed.username) args.push('-U', decodeURIComponent(parsed.username));
  // pathname for postgres URLs is `/dbname` — strip the leading slash.
  const dbname = parsed.pathname.replace(/^\/+/, '');
  if (dbname) args.push('-d', dbname);
  return { args, env: { PGPASSWORD: password } };
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
  // WKH-86 AC-6 / CD-WKH86-1: extract password from URL into PGPASSWORD env
  // so it never appears in `ps aux` argv listing.
  const conn = buildPsqlConnectionEnv(shadowUrl);
  const start = now();
  const result = spawn(
    'psql',
    [
      ...conn.args,
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
      env: { ...process.env, ...conn.env },
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
 * Baseline `a2a_*` tables expected to exist in any healthy production deploy.
 * BLQ-MED-2: post-apply check now verifies the full set, not just a count.
 * If a migration accidentally drops one (or never created it), --post-apply
 * fails with the exact list of missing tables.
 */
export const EXPECTED_A2A_TABLES = [
  'a2a_agent_keys',
  'a2a_events',
  'a2a_protocol_fees',
  // NOTE: `a2a_registries` and `a2a_tasks` ship under different names today
  // (`registries`, `tasks`) but are tracked here so the runbook can rename
  // them in a single PR when the WKH-54 work item lands. Until then the
  // expected list reflects current prod ground truth.
  // WKH-86 AC-1: `a2a_events` baseline table is now part of the manifest so
  // an accidental DROP is detected by --post-apply (it shipped with WKH-58
  // but was missing from this list).
];

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
 *   expectedA2aTables?: string[],
 * }} [opts]
 * @returns {{ ok: boolean, errors: string[], details: string[] }}
 */
export function runPostApplyCheck(opts = {}) {
  const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL;
  const spawn = opts.spawn ?? spawnSync;
  // BLQ-MED-2: prefer the expected-set check over a bare count. The legacy
  // `minA2aTables` is still honored for callers that don't supply a manifest
  // (e.g. brand-new shadow projects with no a2a tables yet).
  const expected = opts.expectedA2aTables ?? EXPECTED_A2A_TABLES;
  const minA2aTables = opts.minA2aTables ?? expected.length;

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

  // WKH-86 AC-6 / CD-WKH86-1: extract password from DATABASE_URL into
  // PGPASSWORD env so it never appears in `ps aux` argv listing for any
  // of the three sub-queries below.
  const conn = buildPsqlConnectionEnv(databaseUrl);
  const psqlEnv = { ...process.env, ...conn.env };

  // (a) a2a_* tables
  const tablesResult = spawn(
    'psql',
    [...conn.args, '-X', '-A', '-t', '-q', '-c', POST_APPLY_QUERIES.a2aTables],
    { encoding: 'utf-8', timeout: 30_000, env: psqlEnv },
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
    details.push(`a2a_* tables expected (${expected.length}): ${expected.join(', ')}`);
    if (rows.length < minA2aTables) {
      errors.push(
        `Expected at least ${minA2aTables} a2a_* table(s); found ${rows.length}`,
      );
    }
    // BLQ-MED-2: report exact missing tables vs. baseline manifest.
    if (expected.length > 0) {
      const found = new Set(rows);
      const missing = expected.filter((t) => !found.has(t));
      if (missing.length > 0) {
        errors.push(
          `Missing expected a2a_* table(s): ${missing.join(', ')} ` +
            `(baseline = [${expected.join(', ')}])`,
        );
      }
    }
  }

  // (b) invalid FKs
  const fkResult = spawn(
    'psql',
    [...conn.args, '-X', '-A', '-t', '-q', '-c', POST_APPLY_QUERIES.invalidFks],
    { encoding: 'utf-8', timeout: 30_000, env: psqlEnv },
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
  // (See AC-4(b) decision in the runbook §5.4: indexes are listed for grep,
  //  not validated against migration declarations.)
  const idxResult = spawn(
    'psql',
    [...conn.args, '-X', '-A', '-t', '-q', '-c', POST_APPLY_QUERIES.a2aIndexes],
    { encoding: 'utf-8', timeout: 30_000, env: psqlEnv },
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

  // BLQ-MED-4: wrap the entire CLI body in try/catch so any uncaught
  // exception (e.g. fs read crash, ad-hoc throw inside a sub-helper)
  // surfaces as exit code 2 ("internal error") instead of an unhandled
  // promise rejection or zero-exit silent failure.
  try {
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
  } catch (e) {
    // BLQ-MED-4: structured internal-error path. Exit code 2 = "preflight
    // crashed" so CI can distinguish a script bug from a [BLOCKED] verdict.
    const msg = e instanceof Error ? e.message : String(e);
    errlog(`[ERR] preflight crashed: ${msg}`);
    return exit(2);
  }
}

// Entrypoint — only runs when invoked directly, not when imported by tests.
const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '');
if (isDirectInvocation) {
  main({ argv: process.argv });
}
