# Migration Pre-flight Runbook — WKH-78

> Owner: Fernando (Platform). Last updated: 2026-05-01.
> Script: [`scripts/migrate-preflight.mjs`](../../scripts/migrate-preflight.mjs)
> npm script: `npm run migrate:preflight -- <file.sql>`

This runbook is the **mandatory checklist** before applying any new SQL
migration to the wasiai-a2a Supabase prod project (`caldzjhjgctpgodldqav`).
Skipping these steps has historically been the single biggest source of
schema-related production incidents in this codebase.

---

## TL;DR — the 30-second flow

```bash
# 0) Make sure the file is in supabase/migrations/ with the conventional
#    timestamp prefix. Add a `-- ROLLBACK:` comment at the bottom (see §6).

# 1) Run the pre-flight script. It analyses the SQL and (if SHADOW_DATABASE_URL
#    is set) runs the migration inside BEGIN ... ROLLBACK on the dev project.
npm run migrate:preflight -- supabase/migrations/<your-migration>.sql

# 2) Read the report.
#    [PASS]    → safe to apply (still requires human eyes for non-trivial DDL).
#    [BLOCKED] → STOP. Open a PR for review. Do NOT apply manually.

# 3) Apply manually via Supabase Management API (existing workflow).
#    See scripts/apply-prod-migrations.sh for the canonical script.

# 4) Run the post-apply integrity check.
DATABASE_URL='postgres://...prod...' \
  node scripts/migrate-preflight.mjs --post-apply
```

If at any step the result is `[BLOCKED]` or `[FAIL]`, **stop and read the rest
of this runbook**. Do not improvise.

---

## 1. Why this runbook exists

The current migration workflow is:

1. A dev writes a `.sql` file under `supabase/migrations/`.
2. The dev (or NexusAgil orchestrator) copy-pastes it into the Supabase
   Dashboard SQL editor for the prod project, or runs
   `scripts/apply-prod-migrations.sh`.
3. There is no shadow DB run, no static analysis, and no post-apply check.

Net result: a `DROP COLUMN`, a `TRUNCATE`, or a long-running `ALTER TABLE`
on `a2a_agent_keys` is only discovered **in production**. This is the worst
possible time to discover it.

This pre-flight is a **prospective guardrail**: it does not change how
migrations are applied (still manual), but it enforces that a migration is
analysed and dry-run before it touches prod.

---

## 2. Pre-requisites

- Node.js >= 20 (project standard, declared in `package.json#engines`).
- `psql` CLI installed locally — only required if you want the shadow
  dry-run (recommended). Without `psql` the script still runs the static
  analyser and exits accordingly.
  - macOS: `brew install libpq && brew link --force libpq`
  - Debian/Ubuntu: `sudo apt-get install postgresql-client`
  - WSL Ubuntu: `sudo apt-get install postgresql-client-16`
- `SHADOW_DATABASE_URL` set in `.env` to the **dev** Supabase project's
  Postgres connection URI. **Never** set this to the prod URL — see CD-1.

To get the connection URI:

> Supabase Dashboard → `bdwvrwzvsldephfibmuu` (dev) → Settings →
> Database → Connection string → URI. Use the **pooler** URI when possible.

Sanity check the URL points at dev:

```bash
echo "$SHADOW_DATABASE_URL" | grep -o 'bdwvrwzvsldephfibmuu' && echo OK || echo "WRONG PROJECT — abort"
```

---

## 3. Running the script

### 3.1 Standard pre-flight

```bash
npm run migrate:preflight -- supabase/migrations/20260501120000_add_owner_ref_to_tasks.sql
```

What it does, in order:

1. Reads the SQL file from disk.
2. Strips line and block comments.
3. Runs a regex-based analyser. Every match becomes a `Finding` with a
   level (`HIGH` / `MEDIUM` / `INFO`), a line number, and the matched
   snippet.
4. If `SHADOW_DATABASE_URL` is set, wraps the migration SQL in
   `BEGIN; <migration>; ROLLBACK;` and pipes it to `psql --single-transaction`.
   The shadow DB is not modified — Postgres aborts the whole transaction.
5. Decides PASS or BLOCKED based on:
   - any `HIGH` finding → BLOCKED,
   - shadow dry-run failure → BLOCKED,
   - shadow dry-run > 30s → BLOCKED,
   - otherwise → PASS.

Exit codes:

| Code | Meaning                                                        |
|------|----------------------------------------------------------------|
| 0    | `[PASS]` — safe to apply (still review the diff manually).     |
| 1    | `[BLOCKED]` — HIGH risk or dry-run failure / too slow.         |
| 2    | Internal error — usage error (no file argument, file not found), or any uncaught exception thrown by the script (`[ERR] preflight crashed: …`). CI MUST distinguish exit 2 from exit 1: 2 means "preflight itself broke", 1 means "preflight verdict is BLOCKED". |

### 3.2 Post-apply integrity check

After applying the migration to a target DB (prod or staging shadow), run:

```bash
DATABASE_URL='postgres://...the-target-db...' \
  node scripts/migrate-preflight.mjs --post-apply
```

The script issues three **read-only** SELECT queries:

1. `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'a2a_%'`
   → at least one `a2a_*` table must remain (sanity check).
2. `SELECT conname, conrelid::regclass FROM pg_constraint WHERE contype='f' AND NOT convalidated`
   → must return zero rows (no INVALID FKs).
3. `SELECT schemaname, tablename, indexname FROM pg_indexes WHERE schemaname='public' AND tablename LIKE 'a2a_%'`
   → informational; printed to stdout for grep.

The script is read-only against `DATABASE_URL` by construction (CD-1) — it
never issues DML/DDL. Exit code 0 = OK; 1 = at least one check failed.

---

## 4. Risk taxonomy — what the analyser flags

The analyser is intentionally noisy: false positives only force a human
review (cheap), while a missed `HIGH` could destroy production data
(catastrophic).

| Pattern                                | Level   | Why it's flagged                                         |
|----------------------------------------|---------|----------------------------------------------------------|
| `DROP TABLE`                           | HIGH    | Permanent data loss.                                     |
| `ALTER TABLE … DROP COLUMN`            | HIGH    | Permanent data loss; not reversible without backup.      |
| `DROP INDEX`                           | HIGH    | Performance regression risk; hard to roll back online.   |
| `TRUNCATE`                             | HIGH    | Permanent data loss; bypasses triggers, cascades.        |
| `ALTER TABLE … DROP <anything>`        | HIGH    | Catches DROP CONSTRAINT / DROP DEFAULT not covered above.|
| `ALTER TABLE … RENAME TO`              | HIGH    | Application code expects the old name; breaks app.       |
| `DELETE FROM` without `WHERE`          | HIGH    | Wipes the table; multi-line aware.                       |
| `UPDATE … SET …` without `WHERE`       | HIGH    | Mass write across the entire table; same blast radius as `DELETE` without `WHERE` (BLQ-ALTO-1). |
| `DROP DATABASE`/`SCHEMA`/`TYPE`/…      | HIGH    | Catastrophic destructive DDL beyond TABLE/INDEX/COLUMN: covers DATABASE, SCHEMA, TYPE, POLICY, TRIGGER, FUNCTION, VIEW, MATERIALIZED VIEW, SEQUENCE, EXTENSION, PUBLICATION, SUBSCRIPTION (BLQ-ALTO-1). |
| `DISABLE ROW LEVEL SECURITY`           | HIGH    | Disables the tenant boundary that every service relies on (WKH-53 ownership guard) (BLQ-ALTO-1). |
| `REASSIGN OWNED BY`                    | HIGH    | Bulk-transfers every object owned by a role; downstream ACL surprises (BLQ-ALTO-1). |
| `\!`, `\copy`, `\i`, `\<meta>`     | HIGH    | psql meta-command in migration body — refusing to dry-run (BLQ-BAJO-1). `\!` shells out to bash; `\i` includes arbitrary files; both bypass the BEGIN/ROLLBACK guarantee. |
| `GRANT … ON …` / `REVOKE … ON …`       | MEDIUM  | Privilege grants/revokes are security-sensitive but sometimes intentional (e.g. `secure_rpc_search_path` migration) (BLQ-ALTO-1). |
| `ALTER DEFAULT PRIVILEGES`             | MEDIUM  | Silently changes the ACL of every future object created in the schema; hard to audit retroactively (BLQ-ALTO-1). |
| Embedded `COMMIT;`/`ROLLBACK;`         | MEDIUM  | Breaks the BEGIN/ROLLBACK wrap of the shadow dry-run; foot-gun when paired with `apply-prod-migrations.sh` which already wraps each file in its own transaction (BLQ-MED-1). See §9 for the exact `psql --single-transaction` semantics. |
| `ALTER COLUMN … TYPE`                  | MEDIUM  | Can silently change semantics; review numeric precision. |
| `ALTER COLUMN … SET NOT NULL`          | MEDIUM  | Fails if any existing row has NULL; needs backfill plan. |
| `CREATE INDEX CONCURRENTLY` / `VACUUM` | INFO    | Cannot be wrapped in BEGIN/ROLLBACK; the shadow dry-run is structurally unable to validate them (BLQ-BAJO-2). See §11 for the alternative workflow. Also catches `DROP INDEX CONCURRENTLY`, `REINDEX CONCURRENTLY`, `CREATE DATABASE`, `ALTER SYSTEM`. |

**False positive escape hatch**: if you legitimately need a HIGH operation
(e.g. dropping a column that has been deprecated for two releases), do
**not** modify the analyser — instead, document the rationale in the PR
description and ack the BLOCKED in the review. The analyser is advisory:
the human is the final gate.

---

## 5. Interpreting the report

### 5.1 `[PASS]` — safe to apply

Means: no HIGH findings, dry-run completed (or was skipped), under the time
budget. **Still review the diff manually**. PASS does not mean "good
migration" — it means "no obvious red flags".

### 5.2 `[RISK]` — findings reported, but not blocking

Appears when only MEDIUM/INFO findings exist. Read each line:

```
[RISK] Static analysis findings:
  L42  [MEDIUM]  ALTER COLUMN TYPE  →  ALTER TABLE accounts ALTER COLUMN amount TYPE NUMERIC(20,8);
```

Decide if the change is intentional. If yes, proceed; if not, fix the SQL.

### 5.3 `[BLOCKED]` — exit 1

The migration **must not** be applied to prod without a human review.

```
[BLOCKED] Migration requires human review before applying to production
  - HIGH risk operation detected by static analysis
  - Shadow dry-run too slow (47210ms > 30000ms)
```

Workflow:

1. Open or update the PR.
2. Tag a reviewer with the report attached.
3. Discuss whether the HIGH operation is justified, whether the slowness
   is acceptable (e.g. an `ALTER TABLE` that locks `a2a_agent_keys` for
   45 seconds blocks every authenticated request — almost certainly a no).
4. If the team agrees, the reviewer **manually overrides** by mentioning
   the override in the PR (`override-preflight: yes — reason: …`). The
   script does not auto-override; the override is in the human process.

### 5.4 The `--post-apply` index report — AC-4(b) decision

The post-apply check lists every index on `a2a_*` tables (query (c)) but
**does not validate** that the listed indexes match what the migration
declared. We considered two implementations:

1. **Parser**: parse `CREATE INDEX <name>` from the migration file and
   diff against `\dindex` per name. Rejected because (a) parsing CREATE
   INDEX with all its variants (CONCURRENTLY, UNIQUE, partial WHERE,
   expression-based, multi-column) is a SQL-engine-grade task, and (b)
   the shadow dry-run already validates that the migration parses + runs
   against Postgres.

2. **Baseline-count delta**: track the `a2a_*` index count vs. baseline.
   Rejected because index counts naturally grow with every migration —
   a strict "must not decrease" rule would block legitimate `DROP INDEX
   IF EXISTS` cleanup migrations.

**Decision**: keep the index query as informational only. The output is
printed to stdout for grep / human review, not validated. The runbook is
honest about this:

> indexes are listed for grep, not validated against migration declarations.

If a future incident requires programmatic index validation, the right
answer is to introduce a baseline manifest (`expectedIndexes: [...]`)
similar to BLQ-MED-2's `EXPECTED_A2A_TABLES`. Until then, the human
reviewing the migration PR is the gate.

---

## 6. Rollback patterns — when prod is broken

This is the section AC-5 calls out as mandatory. There are **three layers**
of rollback, in order of preference:

### 6.1 Layer 1 — Supabase Point-in-Time Recovery (PITR)

Supabase Pro plan (which this project is on) keeps PITR for the last 7
days at 2-minute granularity.

Steps to restore:

1. Open Supabase Dashboard → `caldzjhjgctpgodldqav` (prod) → Database →
   Backups → **Point-in-Time Recovery**.
2. Pick a timestamp **before** the bad migration was applied. Use the
   migration's commit timestamp as the upper bound.
3. Click "Restore". Supabase clones the project at that timestamp into a
   new project; you then have to swap `DATABASE_URL` on Railway.
4. Update `.env` on Railway with the restored project's connection string.
5. Verify with `node scripts/migrate-preflight.mjs --post-apply` against
   the restored DB.

**Caveat**: PITR loses every write between the picked timestamp and the
incident. Plan accordingly — usually you also export the post-incident
audit logs (`a2a_events`) before restoring, to merge them in afterwards.

### 6.2 Layer 2 — DDL inverse (no PITR needed)

If the migration is small and you have the inverse SQL handy, apply it
directly. Examples:

| Forward                                      | Inverse                                                |
|----------------------------------------------|--------------------------------------------------------|
| `ALTER TABLE foo ADD COLUMN bar TEXT;`       | `ALTER TABLE foo DROP COLUMN bar;`                     |
| `CREATE INDEX idx_foo ON foo(x);`            | `DROP INDEX idx_foo;`                                  |
| `ALTER TABLE foo DROP COLUMN bar;`           | **Cannot be reverted via DDL** — needs PITR.            |
| `ALTER TABLE foo RENAME TO foo_new;`         | `ALTER TABLE foo_new RENAME TO foo;`                   |
| `CREATE TABLE foo (...);`                    | `DROP TABLE foo;`                                      |

**This is exactly why HIGH operations are blocked**: dropping a column or
truncating a table is **not** revertible by DDL alone. Once applied without
a backup, the data is gone.

Workflow for Layer 2:

1. Write the inverse SQL into a new file:
   `supabase/migrations/<timestamp>_rollback_<original_name>.sql`.
2. Run `npm run migrate:preflight -- supabase/migrations/...rollback...sql`
   (yes, the rollback itself needs a pre-flight — it's also a migration).
3. Apply via the existing manual process.
4. Verify with `--post-apply`.

### 6.3 Layer 3 — Manual `psql` against prod (last resort, gated)

If neither PITR nor a clean DDL inverse work (e.g. the migration left the
DB in a half-applied state because Postgres aborted mid-statement), connect
manually:

```bash
psql "$DATABASE_URL_PROD" \
  -v ON_ERROR_STOP=1 \
  --single-transaction \
  -X \
  -f rollback.sql
```

**Rules**:

- Two engineers on a pairing call. No solo prod surgery.
- Wrap everything in `BEGIN; ... ; COMMIT;` explicitly so you can `\q` to
  abort.
- Record the session: `script` on Linux, screen recording on macOS.
- Post-mortem mandatory within 48h (write it under `doc/sdd/.../retro.md`).

---

## 7. The `-- ROLLBACK:` template (best practice)

Every new file in `supabase/migrations/` **should** end with a comment
block describing the rollback SQL. The script does not enforce this
(CD-7) — it is an editorial convention.

Template:

```sql
-- ============================================================
-- Migration: 20260501120000_add_owner_ref_to_tasks
-- WKH-54: Tasks ownership guard
-- ============================================================

ALTER TABLE tasks
  ADD COLUMN owner_ref TEXT NOT NULL DEFAULT 'legacy';

CREATE INDEX idx_tasks_owner_ref ON tasks(owner_ref);

-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_tasks_owner_ref;
--   ALTER TABLE tasks DROP COLUMN IF EXISTS owner_ref;
```

If a migration has no clean DDL rollback (e.g. it drops a column), the
rollback block must say so explicitly:

```sql
-- ROLLBACK:
--   This migration is NOT reversible via DDL — restore the dropped column
--   value requires Supabase PITR. See doc/runbooks/migration-preflight.md §6.1.
```

---

## 8. CI / pre-merge integration (future work)

Out of scope for WKH-78, but tracked: wiring `migrate:preflight` into a
GitHub Actions job that runs against every PR adding a file under
`supabase/migrations/`. The exit code (0 / 1) is the pass/fail signal.

For now, the convention is:

> Every PR that adds a `.sql` file under `supabase/migrations/` MUST
> include the pre-flight report output in the PR description.

The orchestrator (NexusAgil) will refuse to mark such PRs as `DONE`
unless the pre-flight ran.

---

## 9. Known limitations

- **The analyser is statement-based, not parser-based**. As of WKH-78
  fix-pack iter 1, the analyser splits SQL into top-level statements
  (BLQ-ALTO-2 fix) and is aware of single-quoted, double-quoted, escape,
  and dollar-quoted strings (BLQ-MED-3 fix). It still cannot reason
  about computed SQL inside `EXECUTE 'DROP TABLE ' || quote_ident(x)`
  blocks — those live inside dollar-quoted PL/pgSQL bodies that the
  analyser deliberately treats as opaque. The mitigation is the shadow
  dry-run — if the SQL constructs DDL at runtime, Postgres will execute
  it inside the wrapper transaction and ROLLBACK aborts it.
- **The shadow DB is not a perfect mirror of prod**. Schema drift between
  dev and prod can mask real issues. Owners should periodically rebase
  dev from a prod snapshot — tracked separately.
- **Postgres allows DDL in transactions**. This works for our case
  (Supabase Postgres) — unlike MySQL, where most DDL auto-commits. If a
  future Postgres extension changes this behaviour, the script's
  BEGIN+ROLLBACK guarantee weakens. Audit the changelog when upgrading.
- **CD-1 is enforced only by convention**. The script cannot tell
  `bdwvrwzvsldephfibmuu` from `caldzjhjgctpgodldqav` from a connection
  string alone. The §2 sanity-check command above is the human gate.
- **Embedded `COMMIT;` / `ROLLBACK;` semantics under `psql --single-transaction`**.
  When the migration body itself contains explicit `COMMIT;` or
  `ROLLBACK;`, the analyser flags it MEDIUM (BLQ-MED-1) but does not
  refuse to dry-run. `psql --single-transaction` opens an outer
  `BEGIN;` and treats the migration's embedded `COMMIT` as terminating
  the *outer* transaction — meaning subsequent statements run outside
  the rollback wrap and CAN partial-commit on the shadow project. The
  outer `ROLLBACK;` we append is a no-op in that case. **Therefore**:
  any migration that contains `COMMIT;` is structurally untrustworthy
  for shadow validation. The runbook position is: rewrite the migration
  to remove embedded transaction control, or accept the MEDIUM finding
  and human-review the diff manually.
- **psql meta-commands (`\!`, `\copy`, `\i`, …)** are flagged HIGH
  (BLQ-BAJO-1) and refused. The shell-escape (`\!`) is the most
  dangerous: it executes arbitrary commands on the host running psql,
  bypassing every BEGIN/ROLLBACK guarantee. Even if a meta-command is
  benign, the analyser refuses to dry-run because Postgres-side
  execution is the only safe sandbox. **Known security limitation**:
  the analyser cannot prove that a meta-command was deliberately
  authored vs. injected via clipboard or copy-paste; the gate must be
  the human reviewer.
- **EXECUTE-string DDL inside PL/pgSQL bodies is invisible**. A
  function body of the form `$$ EXECUTE 'DROP TABLE legacy'; $$` will
  pass the analyser because dollar-quoted bodies are stripped during
  string-literal-aware preprocessing (BLQ-MED-3). The shadow dry-run
  still catches it (Postgres executes the DROP inside the wrapping
  transaction and ROLLBACK aborts it), but the static report alone
  will be silent. If you author such a function, either inline the
  DDL outside the function body or add `-- @preflight-allow` review
  notes to the PR.

---

## 10. Quick reference card

```
Static analyser exit codes:
  0 → [PASS]    safe to apply (still review the diff)
  1 → [BLOCKED] / [FAIL] HIGH risk, dry-run failure, dry-run > 30s, or post-apply integrity failure
  2 → INTERNAL  usage error, file not found, or uncaught script exception
                 (look for `[ERR] preflight crashed: …` in stderr)

Pre-flight commands:
  npm run migrate:preflight -- supabase/migrations/<file>.sql
  DATABASE_URL='...' node scripts/migrate-preflight.mjs --post-apply

Constraint Directives (from work-item):
  CD-1   Never mutate prod from this script (read-only on --post-apply).
  CD-2   Dry-run wraps in BEGIN + ROLLBACK; never COMMIT.
  CD-3   No real connection strings in repo.
  CD-4   HIGH risk OR dry-run failure → exit 1.
  CD-5   No new deps; uses node:child_process + psql binary.
  CD-6   Tests are mocks 100%, never connect to real Supabase.
  CD-7   -- ROLLBACK template is recommendation, not enforcement.

Fix-pack iter 1 CDs (post-AR):
  CD-FP1 Each new RISK_PATTERN ships with at least 2 test fixtures
         (positive + negative).
  CD-FP2 splitStatements() must NOT break real project migrations
         (dollar-quoted bodies, `IF EXISTS` clauses, etc.).
  CD-FP3 No existing pattern's severity is lowered. New patterns may
         only ADD detections, never relax them.
```

---

## 11. Migrations that bypass the shadow dry-run

Some Postgres operations **cannot** run inside a `BEGIN; … ROLLBACK;`
wrapper. The analyser flags them INFO (BLQ-BAJO-2) and the shadow
dry-run will fail with a syntax error if you try anyway. They include:

- `CREATE INDEX CONCURRENTLY` / `DROP INDEX CONCURRENTLY` / `REINDEX CONCURRENTLY`
- `VACUUM`, `VACUUM ANALYZE`, `VACUUM FULL`
- `CREATE DATABASE` / `DROP DATABASE`
- `ALTER SYSTEM SET …`

For these migrations, **do not use the standard pre-flight path**.
Instead:

1. Confirm the migration has zero non-CONCURRENTLY DDL — split the file
   if it mixes wrappable and unwrappable statements. The convention is
   one `_concurrent` migration per such operation.
2. Run the static analyser **only**:

   ```bash
   node scripts/migrate-preflight.mjs supabase/migrations/<file>.sql
   ```

   The exit code will still be `0` (no HIGH findings — INFO doesn't
   block) and the output will print the INFO lines so a reviewer sees
   what's about to happen.
3. Apply the migration to the **dev/shadow project first**, manually:

   ```bash
   psql "$SHADOW_DATABASE_URL" \
     -v ON_ERROR_STOP=1 \
     -X \
     -f supabase/migrations/<file>.sql
   ```

   Note the **absence** of `--single-transaction` — that's the whole
   point. If it fails on shadow, fix it on shadow first.
4. After it succeeds on shadow, run the post-apply integrity check
   against the shadow URL to confirm no FK invalidations:

   ```bash
   DATABASE_URL="$SHADOW_DATABASE_URL" \
     node scripts/migrate-preflight.mjs --post-apply
   ```

5. Only after shadow validation, apply to prod via
   `scripts/apply-prod-migrations.sh` (which itself does NOT add
   `--single-transaction`, so CONCURRENTLY survives the prod run).
6. Run `--post-apply` again against the prod `DATABASE_URL`.

**Why this matters**: `CREATE INDEX CONCURRENTLY` takes minutes on
multi-million-row tables, holds a `ShareUpdateExclusiveLock` (does NOT
block reads or writes, but blocks other DDL), and is the only safe way
to add an index to a busy table. Wrapping it in BEGIN/ROLLBACK would
both fail at parse time AND defeat the entire purpose. The pre-flight
script honors this constraint by flagging INFO and pointing here.
