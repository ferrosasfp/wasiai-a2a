// setup-cronjob.test.mjs — WKH-66 W4.6 + WKH-75 W4.
//
// 6 tests T-SC-01..T-SC-06 using a body-aware fetch mock injected via
// `--import`. The mock state lives in a tmpfile (the wrapper module reads
// it at startup and writes calls back to disk) so the test can inspect
// what the script did after the child exits.
//
// W4 contract update (WKH-75): TARGET_JOBS now contains 4 jobs:
//   warmup, balance-check, bearer-rotation, invalidate-prev-bearer.
// T-SC-01..T-SC-03 updated accordingly. T-SC-04 (no secret leak)
// unchanged. T-SC-05 / T-SC-06 added to verify the new W4 schedule contract.
//
// WKH-89: T-SC-06 updated to assert integer-array schedules (cron-job.org
// REST API native types) instead of crontab strings. Added regression
// guards T-CRJ-INT-01..05 which inspect the actual JSON body sent to
// `fetch` for each of the 4 jobs and prove no crontab strings ever
// reach the wire (CD-1, CD-4).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeFileSync, readFileSync, mkdtempSync, unlinkSync } from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', 'scripts', 'setup-cronjob.mjs');

const TEST_TOKEN = 'test-cron-token-aaaaaaaaaaaaaaaaaaaaa';
const TEST_DEPLOY = 'https://wasiai-x402-mcp.vercel.app';
const TEST_SECRET = 'test-cron-secret-bbbbbbbbbbbbbbbbbbbbb';

// W4: titles registered by TARGET_JOBS, sorted alphabetically. Source-of-truth
// for T-SC-01..T-SC-05.
const EXPECTED_TITLES = [
  'wasiai-x402-balance-check',
  'wasiai-x402-bearer-rotation',
  'wasiai-x402-invalidate-prev-bearer',
  'wasiai-x402-warmup',
];

function runScript({ existingJobs = [] } = {}) {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'wkh66-sc-'));
  const callsPath = path.join(tmpDir, 'calls.json');
  const stubPath = path.join(tmpDir, 'fetch-stub.mjs');

  const initial = JSON.stringify({ jobs: existingJobs, calls: [], nextId: 100 });
  writeFileSync(callsPath, initial);

  // The stub IS the mock. It loads state from callsPath, replays semantic
  // routing (GET/PUT/PATCH on /jobs[/<id>]), persists state back on every
  // call.
  writeFileSync(stubPath, `
    import { readFileSync, writeFileSync } from 'node:fs';
    const STATE_PATH = ${JSON.stringify(callsPath)};
    function load() { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); }
    function save(s) { writeFileSync(STATE_PATH, JSON.stringify(s)); }
    globalThis.fetch = async (url, init = {}) => {
      const s = load();
      const u = new URL(String(url));
      const method = (init.method ?? 'GET').toUpperCase();
      s.calls.push({ url: String(url), method, body: init.body ?? null });
      save(s);
      if (u.hostname !== 'api.cron-job.org') {
        return new Response('mock: unknown host', { status: 500 });
      }
      if (method === 'GET' && u.pathname === '/jobs') {
        return new Response(JSON.stringify({ jobs: s.jobs }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (method === 'PUT' && u.pathname === '/jobs') {
        const body = init.body ? JSON.parse(init.body) : {};
        if (!body?.job?.title) return new Response('{"message":"missing title"}', { status: 400 });
        const dup = s.jobs.find((j) => j.title === body.job.title);
        if (dup) return new Response('{"message":"duplicate"}', { status: 409 });
        const jobId = s.nextId++;
        const job = { ...body.job, jobId, nextExecution: 1700000000 };
        s.jobs.push(job);
        save(s);
        return new Response(JSON.stringify({ jobId, nextExecution: 1700000000 }), { status: 200 });
      }
      const m = u.pathname.match(/^\\/jobs\\/(\\d+)$/);
      if (method === 'PATCH' && m) {
        const id = Number(m[1]);
        const body = init.body ? JSON.parse(init.body) : {};
        const idx = s.jobs.findIndex((j) => j.jobId === id);
        if (idx === -1) return new Response('{"message":"not found"}', { status: 404 });
        s.jobs[idx] = { ...s.jobs[idx], ...(body.job ?? {}) };
        save(s);
        return new Response(JSON.stringify({ jobId: id, nextExecution: 1700000010 }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: 'route not handled' }), { status: 404 });
    };
  `);

  const r = spawnSync(process.execPath, ['--import', stubPath, SCRIPT], {
    env: {
      ...process.env,
      CRONJOB_ORG_API_TOKEN: TEST_TOKEN,
      MCP_DEPLOY_URL: TEST_DEPLOY,
      CRON_SECRET: TEST_SECRET,
    },
    encoding: 'utf8',
  });

  const finalState = JSON.parse(readFileSync(callsPath, 'utf8'));
  try { unlinkSync(callsPath); unlinkSync(stubPath); } catch {}

  return { ...r, finalState };
}

test('T-SC-01: create all 4 jobs (no existing)', () => {
  const r = runScript({ existingJobs: [] });
  assert.equal(r.status, 0, `exit ${r.status}, stderr: ${r.stderr}`);
  // 4 jobs final (W4: warmup + balance-check + bearer-rotation + invalidate-prev-bearer).
  assert.equal(r.finalState.jobs.length, 4);
  // Calls: 1 GET + 4 PUT.
  const puts = r.finalState.calls.filter((c) => c.method === 'PUT');
  const gets = r.finalState.calls.filter((c) => c.method === 'GET');
  assert.equal(gets.length, 1);
  assert.equal(puts.length, 4);
  // stdout has 4 jobId lines.
  const stdoutLines = r.stdout.trim().split('\n').filter(Boolean);
  assert.equal(stdoutLines.length, 4);
  for (const line of stdoutLines) {
    assert.match(line, /jobId=\d+/);
    assert.match(line, /nextExecution=/);
  }
});

test('T-SC-02: update existing (idempotent by title) — 1 PATCH + 3 PUT', () => {
  // Only warmup is pre-existing → script should PATCH it and PUT the
  // remaining three (balance-check, bearer-rotation, invalidate-prev-bearer).
  const existingJobs = [
    { title: 'wasiai-x402-warmup', jobId: 50, nextExecution: 1690000000 },
  ];
  const r = runScript({ existingJobs });
  assert.equal(r.status, 0, `exit ${r.status}, stderr: ${r.stderr}`);
  // Final state: 4 jobs, no duplicates.
  const titles = r.finalState.jobs.map((j) => j.title).sort();
  assert.deepEqual(titles, EXPECTED_TITLES);
  const patches = r.finalState.calls.filter((c) => c.method === 'PATCH');
  const puts = r.finalState.calls.filter((c) => c.method === 'PUT');
  assert.equal(patches.length, 1);
  assert.equal(puts.length, 3);
});

test('T-SC-03: idempotent re-run (run twice, end state still 4 jobs)', () => {
  // First run.
  const r1 = runScript({ existingJobs: [] });
  assert.equal(r1.status, 0);
  // Second run with the result of the first as starting state.
  const r2 = runScript({ existingJobs: r1.finalState.jobs });
  assert.equal(r2.status, 0);
  assert.equal(r2.finalState.jobs.length, 4);
  // No duplicates in titles.
  const titles = r2.finalState.jobs.map((j) => j.title);
  const set = new Set(titles);
  assert.equal(set.size, titles.length);
  // 4 PATCH on the second run (all 4 already exist).
  const r2patches = r2.finalState.calls.filter((c) => c.method === 'PATCH');
  assert.equal(r2patches.length, 4);
});

test('T-SC-04: token + secret never appear in stdout/stderr', () => {
  const r = runScript({ existingJobs: [] });
  assert.equal(r.status, 0);
  // CD-15 / V6 — token and secret never in output streams.
  assert.ok(!r.stdout.includes(TEST_TOKEN), 'stdout leaked CRONJOB_ORG_API_TOKEN');
  assert.ok(!r.stdout.includes(TEST_SECRET), 'stdout leaked CRON_SECRET');
  assert.ok(!r.stderr.includes(TEST_TOKEN), 'stderr leaked CRONJOB_ORG_API_TOKEN');
  assert.ok(!r.stderr.includes(TEST_SECRET), 'stderr leaked CRON_SECRET');
});

test('T-SC-05: WKH-75 jobs are POST + auth-bearer + correct deploy URL', () => {
  const r = runScript({ existingJobs: [] });
  assert.equal(r.status, 0, `exit ${r.status}, stderr: ${r.stderr}`);

  // Final state contains exactly the 4 expected titles.
  const titles = r.finalState.jobs.map((j) => j.title).sort();
  assert.deepEqual(titles, EXPECTED_TITLES);

  // The 2 NEW W4 jobs must be POST (requestMethod === 2).
  const rotation = r.finalState.jobs.find((j) => j.title === 'wasiai-x402-bearer-rotation');
  const invalidate = r.finalState.jobs.find((j) => j.title === 'wasiai-x402-invalidate-prev-bearer');
  assert.ok(rotation, 'bearer-rotation job missing');
  assert.ok(invalidate, 'invalidate-prev-bearer job missing');
  assert.equal(rotation.requestMethod, 2, 'bearer-rotation must be POST (requestMethod=2)');
  assert.equal(invalidate.requestMethod, 2, 'invalidate-prev-bearer must be POST (requestMethod=2)');

  // Both new jobs must hit the wasiai-x402 deploy under /api/cron/<endpoint>.
  assert.equal(rotation.url, `${TEST_DEPLOY}/api/cron/rotate-bearer`);
  assert.equal(invalidate.url, `${TEST_DEPLOY}/api/cron/invalidate-prev-bearer`);

  // Both new jobs must carry the CRON_SECRET via Authorization: Bearer.
  // CD-4: cron-job.org pings reach our endpoints with this header so
  // src/cron-auth.mjs validates them.
  assert.equal(
    rotation.extendedData?.headers?.Authorization,
    `Bearer ${TEST_SECRET}`,
    'bearer-rotation missing CRON_SECRET auth header',
  );
  assert.equal(
    invalidate.extendedData?.headers?.Authorization,
    `Bearer ${TEST_SECRET}`,
    'invalidate-prev-bearer missing CRON_SECRET auth header',
  );
});

test('T-SC-06: WKH-75 schedules — rotation 1st of month at 09:00, invalidate daily at 10:00 (integer arrays)', () => {
  const r = runScript({ existingJobs: [] });
  assert.equal(r.status, 0, `exit ${r.status}, stderr: ${r.stderr}`);

  const rotation = r.finalState.jobs.find((j) => j.title === 'wasiai-x402-bearer-rotation');
  const invalidate = r.finalState.jobs.find((j) => j.title === 'wasiai-x402-invalidate-prev-bearer');
  assert.ok(rotation && invalidate, 'WKH-75 jobs missing from final state');

  // WKH-89: bearer-rotation now uses integer arrays (cron-job.org REST
  // API native types). 1st of every month at 09:00 UTC. The original
  // "every 30 days" semantic was unrepresentable in the cron-job.org
  // schema — DT-3 in the work-item picks mdays=[1] as the closest
  // monthly cadence.
  assert.deepEqual(rotation.schedule.minutes, [0]);
  assert.deepEqual(rotation.schedule.hours, [9]);
  assert.deepEqual(rotation.schedule.mdays, [1]);
  assert.deepEqual(rotation.schedule.months, [-1]);
  assert.deepEqual(rotation.schedule.wdays, [-1]);

  // WKH-89: invalidate-prev-bearer uses integer arrays. Daily at 10:00 UTC,
  // one hour after rotation — within 24h overlap window the probe sees a
  // stale snapshot and skips; day after rotation it deletes PREV.
  assert.deepEqual(invalidate.schedule.minutes, [0]);
  assert.deepEqual(invalidate.schedule.hours, [10]);
  assert.deepEqual(invalidate.schedule.mdays, [-1]);
  assert.deepEqual(invalidate.schedule.months, [-1]);
  assert.deepEqual(invalidate.schedule.wdays, [-1]);
});

// ────────────────────────────────────────────────────────────────────────
// WKH-89 — T-CRJ-INT-01..05: integer-array schedule regression guards.
//
// These tests inspect `init.body` of the actual `fetch` calls sent to
// api.cron-job.org (CD-4). They do NOT trust the mock-side replayed state
// — they parse the raw JSON the script puts on the wire, and assert that
// every schedule field is an integer array matching the work-item DT-1..4
// values byte-by-byte (AC-5 zero-drift guarantee).
// ────────────────────────────────────────────────────────────────────────

// Helper — extract the `job` payload sent to fetch for a given title.
// Reads from `finalState.calls`, picks the PUT or PATCH whose body's
// `job.title` matches. Returns the parsed `job` object or throws.
function extractJobFromCalls(calls, title) {
  for (const c of calls) {
    if (c.method !== 'PUT' && c.method !== 'PATCH') continue;
    if (!c.body) continue;
    const parsed = JSON.parse(c.body);
    if (parsed?.job?.title === title) return parsed.job;
  }
  throw new Error(`no PUT/PATCH call found for title=${title}`);
}

test('T-CRJ-INT-01: warmup body sends integer minute list [0,4,...,56] and -1 elsewhere', () => {
  const r = runScript({ existingJobs: [] });
  assert.equal(r.status, 0, `exit ${r.status}, stderr: ${r.stderr}`);

  const job = extractJobFromCalls(r.finalState.calls, 'wasiai-x402-warmup');
  assert.deepEqual(
    job.schedule.minutes,
    [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56],
    'warmup minutes must be integer multiples of 4 from 0 to 56 (DT-1)',
  );
  assert.deepEqual(job.schedule.hours, [-1], 'warmup hours must be [-1]');
  assert.deepEqual(job.schedule.mdays, [-1], 'warmup mdays must be [-1]');
  assert.deepEqual(job.schedule.months, [-1], 'warmup months must be [-1]');
  assert.deepEqual(job.schedule.wdays, [-1], 'warmup wdays must be [-1]');

  // Every value in every field must be a number (not a string).
  for (const [field, arr] of Object.entries(job.schedule)) {
    for (const v of arr) {
      assert.equal(
        typeof v, 'number',
        `warmup.schedule.${field} contains non-integer ${JSON.stringify(v)}`,
      );
    }
  }
});

test('T-CRJ-INT-02: balance-check body sends [0,15,30,45] minutes and -1 elsewhere', () => {
  const r = runScript({ existingJobs: [] });
  assert.equal(r.status, 0, `exit ${r.status}, stderr: ${r.stderr}`);

  const job = extractJobFromCalls(r.finalState.calls, 'wasiai-x402-balance-check');
  assert.deepEqual(
    job.schedule.minutes, [0, 15, 30, 45],
    'balance-check minutes must be [0,15,30,45] (DT-2)',
  );
  assert.deepEqual(job.schedule.hours, [-1]);
  assert.deepEqual(job.schedule.mdays, [-1]);
  assert.deepEqual(job.schedule.months, [-1]);
  assert.deepEqual(job.schedule.wdays, [-1]);

  for (const [field, arr] of Object.entries(job.schedule)) {
    for (const v of arr) {
      assert.equal(
        typeof v, 'number',
        `balance-check.schedule.${field} contains non-integer ${JSON.stringify(v)}`,
      );
    }
  }
});

test('T-CRJ-INT-03: bearer-rotation body sends 1st-of-month at 09:00 UTC as integer arrays', () => {
  const r = runScript({ existingJobs: [] });
  assert.equal(r.status, 0, `exit ${r.status}, stderr: ${r.stderr}`);

  const job = extractJobFromCalls(r.finalState.calls, 'wasiai-x402-bearer-rotation');
  assert.deepEqual(job.schedule.minutes, [0], 'bearer-rotation minutes must be [0] (DT-3)');
  assert.deepEqual(job.schedule.hours, [9], 'bearer-rotation hours must be [9]');
  assert.deepEqual(job.schedule.mdays, [1], 'bearer-rotation mdays must be [1] (1st of month)');
  assert.deepEqual(job.schedule.months, [-1]);
  assert.deepEqual(job.schedule.wdays, [-1]);

  for (const [field, arr] of Object.entries(job.schedule)) {
    for (const v of arr) {
      assert.equal(
        typeof v, 'number',
        `bearer-rotation.schedule.${field} contains non-integer ${JSON.stringify(v)}`,
      );
    }
  }
});

test('T-CRJ-INT-04: invalidate-prev-bearer body sends daily 10:00 UTC as integer arrays', () => {
  const r = runScript({ existingJobs: [] });
  assert.equal(r.status, 0, `exit ${r.status}, stderr: ${r.stderr}`);

  const job = extractJobFromCalls(r.finalState.calls, 'wasiai-x402-invalidate-prev-bearer');
  assert.deepEqual(job.schedule.minutes, [0], 'invalidate-prev-bearer minutes must be [0] (DT-4)');
  assert.deepEqual(job.schedule.hours, [10], 'invalidate-prev-bearer hours must be [10]');
  assert.deepEqual(job.schedule.mdays, [-1]);
  assert.deepEqual(job.schedule.months, [-1]);
  assert.deepEqual(job.schedule.wdays, [-1]);

  for (const [field, arr] of Object.entries(job.schedule)) {
    for (const v of arr) {
      assert.equal(
        typeof v, 'number',
        `invalidate-prev-bearer.schedule.${field} contains non-integer ${JSON.stringify(v)}`,
      );
    }
  }
});

test('T-CRJ-INT-05: regression guard — NO schedule value across any job is a string (AC-7)', () => {
  const r = runScript({ existingJobs: [] });
  assert.equal(r.status, 0, `exit ${r.status}, stderr: ${r.stderr}`);

  const titles = [
    'wasiai-x402-warmup',
    'wasiai-x402-balance-check',
    'wasiai-x402-bearer-rotation',
    'wasiai-x402-invalidate-prev-bearer',
  ];

  for (const title of titles) {
    const job = extractJobFromCalls(r.finalState.calls, title);
    for (const [field, arr] of Object.entries(job.schedule)) {
      assert.ok(
        Array.isArray(arr),
        `${title}.schedule.${field} must be an array (got ${typeof arr})`,
      );
      for (const v of arr) {
        // Crontab strings like '*/4', '*', '0' would slip past a naive
        // mock. This guard fails loudly (AC-7) with the exact field path.
        assert.notEqual(
          typeof v, 'string',
          `${title}.schedule.${field} contains string ${JSON.stringify(v)} ` +
          `— cron-job.org REST API rejects strings; use integer arrays (-1 = "every")`,
        );
        assert.equal(
          typeof v, 'number',
          `${title}.schedule.${field} must be integer, got ${typeof v} ${JSON.stringify(v)}`,
        );
        assert.ok(
          Number.isInteger(v),
          `${title}.schedule.${field} value ${v} is not an integer`,
        );
      }
    }
  }
});
