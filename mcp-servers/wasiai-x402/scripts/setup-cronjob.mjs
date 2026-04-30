#!/usr/bin/env node
// scripts/setup-cronjob.mjs — provision the 2 cron jobs on cron-job.org
// (WKH-66 W4.5).
//
// Idempotent (CD-20): we lookup-by-title, then PATCH if the job already
// exists, PUT if it doesn't. PROHIBITED to create duplicates.
//
// Why cron-job.org and not vercel.json `crons`: DT-C — the Vercel Hobby
// plan does NOT include scheduled functions, and the project lema is
// "no Pro upgrade for hackathon ops". cron-job.org pings our public
// endpoints with a Bearer header (CRON_SECRET) so the auth still flows
// through src/cron-auth.mjs.
//
// Stdout (CD-15, V6 — never log the API token nor CRON_SECRET):
//   one line per job, format `{title} jobId={n} nextExecution={ts}`.
// Stderr: human-friendly progress + final summary.
//
// Mock injection for tests: when globalThis.fetch is overridden by the test
// harness (via `--import`), this script uses the override transparently.

const TOKEN = process.env.CRONJOB_ORG_API_TOKEN;
const DEPLOY_URL = process.env.MCP_DEPLOY_URL;
const CRON_SECRET = process.env.CRON_SECRET;

if (!TOKEN || !DEPLOY_URL || !CRON_SECRET) {
  process.stderr.write(
    'setup-cronjob: CRONJOB_ORG_API_TOKEN, MCP_DEPLOY_URL and CRON_SECRET ' +
    'are required\n',
  );
  process.exit(1);
}

const TARGET_JOBS = [
  {
    title: 'wasiai-x402-warmup',
    url: `${DEPLOY_URL.replace(/\/$/, '')}/api/cron/warmup`,
    schedule: { minutes: ['*/4'], hours: ['*'], mdays: ['*'], months: ['*'], wdays: ['*'] },
    requestMethod: 1, // GET
    extendedData: { headers: { Authorization: `Bearer ${CRON_SECRET}` } },
  },
  {
    title: 'wasiai-x402-balance-check',
    url: `${DEPLOY_URL.replace(/\/$/, '')}/api/cron/balance-check`,
    schedule: { minutes: ['*/15'], hours: ['*'], mdays: ['*'], months: ['*'], wdays: ['*'] },
    requestMethod: 1,
    extendedData: { headers: { Authorization: `Bearer ${CRON_SECRET}` } },
  },
];

async function listJobs() {
  const r = await fetch('https://api.cron-job.org/jobs', {
    method: 'GET',
    headers: { Authorization: `Bearer ${TOKEN}` },
    redirect: 'error', // CD-18
  });
  if (!r.ok) {
    throw new Error(`list jobs failed: ${r.status}`);
  }
  const body = await r.json();
  return body?.jobs ?? [];
}

async function createJob(job) {
  const r = await fetch('https://api.cron-job.org/jobs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ job }),
    redirect: 'error',
  });
  if (!r.ok) {
    // CD-15 — never echo the token in error output. We log just the status.
    throw new Error(`create job '${job.title}' failed: ${r.status}`);
  }
  const body = await r.json();
  return body;
}

async function updateJob(jobId, job) {
  const r = await fetch(`https://api.cron-job.org/jobs/${jobId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ job }),
    redirect: 'error',
  });
  if (!r.ok) {
    throw new Error(`update job '${job.title}' failed: ${r.status}`);
  }
  const body = await r.json();
  return body;
}

async function main() {
  let existing;
  try {
    existing = await listJobs();
  } catch (e) {
    process.stderr.write(`setup-cronjob: ${e.message}\n`);
    process.exit(1);
  }

  for (const target of TARGET_JOBS) {
    const match = existing.find((j) => j.title === target.title);
    let jobId;
    let nextExecution = 'unknown';
    try {
      if (match) {
        const r = await updateJob(match.jobId, target);
        jobId = r?.jobId ?? match.jobId;
        nextExecution = r?.nextExecution ?? match.nextExecution ?? 'unknown';
        process.stderr.write(`patched ${target.title} (jobId=${jobId})\n`);
      } else {
        const r = await createJob(target);
        jobId = r?.jobId;
        nextExecution = r?.nextExecution ?? 'unknown';
        process.stderr.write(`created ${target.title} (jobId=${jobId})\n`);
      }
    } catch (e) {
      // Defensive — never echo TOKEN or CRON_SECRET in any error path.
      process.stderr.write(`setup-cronjob: ${e.message}\n`);
      process.exit(1);
    }
    process.stdout.write(`${target.title} jobId=${jobId} nextExecution=${nextExecution}\n`);
  }
}

await main();
