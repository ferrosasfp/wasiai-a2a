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

test('T-SC-06: WKH-75 schedules — rotation every 30 days at 09:00, invalidate daily at 10:00', () => {
  const r = runScript({ existingJobs: [] });
  assert.equal(r.status, 0, `exit ${r.status}, stderr: ${r.stderr}`);

  const rotation = r.finalState.jobs.find((j) => j.title === 'wasiai-x402-bearer-rotation');
  const invalidate = r.finalState.jobs.find((j) => j.title === 'wasiai-x402-invalidate-prev-bearer');
  assert.ok(rotation && invalidate, 'WKH-75 jobs missing from final state');

  // Bearer rotation: minutes ['0'], hours ['9'], mdays ['*/30'] — every 30
  // days at 09:00 UTC. Matches SDD §3 DT-2 cadence.
  assert.deepEqual(rotation.schedule.minutes, ['0']);
  assert.deepEqual(rotation.schedule.hours, ['9']);
  assert.deepEqual(rotation.schedule.mdays, ['*/30']);
  assert.deepEqual(rotation.schedule.months, ['*']);
  assert.deepEqual(rotation.schedule.wdays, ['*']);

  // Invalidate-prev-bearer: minutes ['0'], hours ['10'], mdays ['*'] — daily
  // at 10:00 UTC, one hour after rotation, so within 24h overlap window the
  // probe sees a stale snapshot and skips. Day after rotation it deletes
  // PREV.
  assert.deepEqual(invalidate.schedule.minutes, ['0']);
  assert.deepEqual(invalidate.schedule.hours, ['10']);
  assert.deepEqual(invalidate.schedule.mdays, ['*']);
  assert.deepEqual(invalidate.schedule.months, ['*']);
  assert.deepEqual(invalidate.schedule.wdays, ['*']);
});
