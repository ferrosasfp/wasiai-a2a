// health-monitor.test.mjs — WKH-77 ecosystem health monitor core
// (AC-1/2/3/6/7, CD-1/2/3/4/6).
//
// Pure-logic tests: no network. `fetchHealth` and `sendAlert` are injected
// fakes so we exercise down/degraded/reachability decisions, per-service
// isolation, fail-open behaviour and the dry-run test-alert directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SEVERITY_BY_TIER,
  parseHealthTargets,
  resolveTimeoutMs,
  checkHealthTargets,
} from '../src/health-monitor.mjs';

function captureStderr() {
  const orig = process.stderr.write.bind(process.stderr);
  const lines = [];
  process.stderr.write = (chunk) => {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (const part of s.split('\n')) if (part.length) lines.push(part);
    return true;
  };
  return { lines, restore() { process.stderr.write = orig; } };
}

function makeAlertSpy() {
  const calls = [];
  return {
    calls,
    fn: async (args) => { calls.push(args); return { sent: true, status: 200 }; },
  };
}

// A fetchHealth fake that resolves { status, json } or throws a named error to
// simulate a connection failure / timeout.
function okResp(status, json = null) {
  return async () => ({ status, json });
}
function throwsWith(name) {
  return async () => { const e = new Error(name); e.name = name; throw e; };
}

// ── SEVERITY_BY_TIER (AC-2) ─────────────────────────────────────────────────

test('T-HM-01: tier → severity map (P0 critical / P1 warning / P2 info)', () => {
  assert.equal(SEVERITY_BY_TIER.P0, 'critical');
  assert.equal(SEVERITY_BY_TIER.P1, 'warning');
  assert.equal(SEVERITY_BY_TIER.P2, 'info');
});

// ── parseHealthTargets (AC-1, CD-3) ─────────────────────────────────────────

test('T-HM-02: parseHealthTargets — valid entries kept, defaults applied', () => {
  const raw = JSON.stringify([
    { label: 'gw', url: 'https://gw.example/health', tier: 'P0', healthyField: 'status', healthyValue: 'ok' },
    { label: 'mcp', url: 'https://mcp.example/', tier: 'P1', mode: 'reachability' },
  ]);
  const t = parseHealthTargets(raw);
  assert.equal(t.length, 2);
  assert.equal(t[0].mode, 'status'); // default
  assert.equal(t[0].healthyField, 'status');
  assert.equal(t[0].healthyValue, 'ok');
  assert.equal(t[1].mode, 'reachability');
});

test('T-HM-03: parseHealthTargets — invalid entries dropped, never throws', () => {
  const cap = captureStderr();
  try {
    assert.deepEqual(parseHealthTargets(undefined), []);
    assert.deepEqual(parseHealthTargets(''), []);
    assert.deepEqual(parseHealthTargets('not-json{'), []);
    assert.deepEqual(parseHealthTargets('{"not":"array"}'), []);
    const mixed = JSON.stringify([
      { label: 'no-url', tier: 'P0' },
      { label: 'bad-url', url: 'ftp://nope', tier: 'P0' },
      { label: 'bad-tier', url: 'https://x.example/', tier: 'P9' },
      { label: 'ok', url: 'https://ok.example/health', tier: 'P1' },
      // duplicate label dropped
      { label: 'ok', url: 'https://ok2.example/health', tier: 'P0' },
    ]);
    const out = parseHealthTargets(mixed);
    assert.equal(out.length, 1);
    assert.equal(out[0].label, 'ok');
    assert.equal(out[0].url, 'https://ok.example/health');
  } finally {
    cap.restore();
  }
});

// ── resolveTimeoutMs (CD-6) ─────────────────────────────────────────────────

test('T-HM-04: resolveTimeoutMs — default 5000, hard-capped at 5000', () => {
  assert.equal(resolveTimeoutMs({}), 5000);
  assert.equal(resolveTimeoutMs({ HEALTH_MONITOR_TIMEOUT_MS: '3000' }), 3000);
  assert.equal(resolveTimeoutMs({ HEALTH_MONITOR_TIMEOUT_MS: '99999' }), 5000);
  assert.equal(resolveTimeoutMs({ HEALTH_MONITOR_TIMEOUT_MS: 'abc' }), 5000);
  assert.equal(resolveTimeoutMs({ HEALTH_MONITOR_TIMEOUT_MS: '-1' }), 5000);
});

// ── down / 5xx / unreachable / timeout → alert (AC-2) ───────────────────────

test('T-HM-05: HTTP 5xx → down alert at tier severity, public body only', async () => {
  const alert = makeAlertSpy();
  const targets = parseHealthTargets(
    JSON.stringify([{ label: 'gw', url: 'https://gw.example/health', tier: 'P0', logsUrl: 'https://logs.example/gw' }]),
  );
  const cap = captureStderr();
  try {
    const results = await checkHealthTargets({
      targets,
      fetchHealth: okResp(503, { status: 'down' }),
      sendAlert: alert.fn,
      webhookUrl: 'https://hooks.example.com/x',
    });
    assert.equal(alert.calls.length, 1);
    const call = alert.calls[0];
    assert.equal(call.severity, 'critical'); // P0
    assert.equal(call.body.service, 'gw');
    assert.equal(call.body.reason, 'health-http-error');
    assert.equal(call.body.httpStatus, 503);
    assert.equal(call.body.logsUrl, 'https://logs.example/gw');
    // NIT-2: only `service` — no duplicate `label` field in the body.
    assert.ok(!('label' in call.body), 'body must not carry a duplicate label field');
    // No secret-bearing keys.
    assert.ok(!('privateKey' in call.body));
    assert.ok(!('CRON_SECRET' in call.body));
    assert.equal(results[0].severity, 'critical');
  } finally {
    cap.restore();
  }
});

test('T-HM-06: connection error → unreachable alert; timeout → timeout alert', async () => {
  const cap = captureStderr();
  try {
    const targets = parseHealthTargets(
      JSON.stringify([{ label: 'gw', url: 'https://gw.example/health', tier: 'P0' }]),
    );
    const a1 = makeAlertSpy();
    await checkHealthTargets({
      targets, fetchHealth: throwsWith('TypeError'), sendAlert: a1.fn,
      webhookUrl: 'https://hooks.example.com/x',
    });
    assert.equal(a1.calls[0].body.reason, 'health-unreachable');
    assert.equal(a1.calls[0].severity, 'critical');

    const a2 = makeAlertSpy();
    await checkHealthTargets({
      targets, fetchHealth: throwsWith('AbortError'), sendAlert: a2.fn,
      webhookUrl: 'https://hooks.example.com/x',
    });
    assert.equal(a2.calls[0].body.reason, 'health-timeout');
  } finally {
    cap.restore();
  }
});

// ── healthyField mismatch (gateway status !== "ok") → down ───────────────────

test('T-HM-07: 200 but healthyField mismatch → down alert at tier severity', async () => {
  const alert = makeAlertSpy();
  const targets = parseHealthTargets(
    JSON.stringify([{ label: 'gw', url: 'https://gw.example/health', tier: 'P0', healthyField: 'status', healthyValue: 'ok' }]),
  );
  const cap = captureStderr();
  try {
    await checkHealthTargets({
      targets, fetchHealth: okResp(200, { status: 'starting' }), sendAlert: alert.fn,
      webhookUrl: 'https://hooks.example.com/x',
    });
    assert.equal(alert.calls.length, 1);
    assert.equal(alert.calls[0].severity, 'critical');
    assert.equal(alert.calls[0].body.reason, 'health-unhealthy');
  } finally {
    cap.restore();
  }
});

test('T-HM-08: 200 + healthyField match → NO alert', async () => {
  const alert = makeAlertSpy();
  const targets = parseHealthTargets(
    JSON.stringify([{ label: 'gw', url: 'https://gw.example/health', tier: 'P0', healthyField: 'status', healthyValue: 'ok' }]),
  );
  const cap = captureStderr();
  try {
    const results = await checkHealthTargets({
      targets, fetchHealth: okResp(200, { status: 'ok' }), sendAlert: alert.fn,
      webhookUrl: 'https://hooks.example.com/x',
    });
    assert.equal(alert.calls.length, 0);
    assert.equal(results[0].severity, 'ok');
  } finally {
    cap.restore();
  }
});

// ── degraded-but-200 → warning (AC-3) ───────────────────────────────────────

test('T-HM-09: AC-3 — 200 with degradedPath truthy → warning even on P0', async () => {
  const alert = makeAlertSpy();
  const targets = parseHealthTargets(
    JSON.stringify([{ label: 'facilitator', url: 'https://fac.example/health', tier: 'P0', degradedPath: 'degraded' }]),
  );
  const cap = captureStderr();
  try {
    // degraded:true on HTTP 200 → warning (NOT critical), AC-3.
    await checkHealthTargets({
      targets, fetchHealth: okResp(200, { degraded: true }), sendAlert: alert.fn,
      webhookUrl: 'https://hooks.example.com/x',
    });
    assert.equal(alert.calls.length, 1);
    assert.equal(alert.calls[0].severity, 'warning');
    assert.equal(alert.calls[0].body.reason, 'health-degraded');
    assert.equal(alert.calls[0].body.httpStatus, 200);

    // degraded:false → no alert.
    const alert2 = makeAlertSpy();
    const results = await checkHealthTargets({
      targets, fetchHealth: okResp(200, { degraded: false }), sendAlert: alert2.fn,
      webhookUrl: 'https://hooks.example.com/x',
    });
    assert.equal(alert2.calls.length, 0);
    assert.equal(results[0].severity, 'ok');
  } finally {
    cap.restore();
  }
});

// ── reachabilityOnly (404 = alive, NO alert) ────────────────────────────────

test('T-HM-10: reachability mode — 404 counts as alive, NO alert', async () => {
  const alert = makeAlertSpy();
  const targets = parseHealthTargets(
    JSON.stringify([{ label: 'mcp', url: 'https://mcp.example/', tier: 'P1', mode: 'reachability' }]),
  );
  const cap = captureStderr();
  try {
    const results = await checkHealthTargets({
      targets, fetchHealth: okResp(404), sendAlert: alert.fn,
      webhookUrl: 'https://hooks.example.com/x',
    });
    assert.equal(alert.calls.length, 0, '404 must NOT alert in reachability mode');
    assert.equal(results[0].severity, 'ok');
    assert.equal(results[0].httpStatus, 404);
  } finally {
    cap.restore();
  }
});

test('T-HM-11: reachability mode — connection error IS down (warning P1)', async () => {
  const alert = makeAlertSpy();
  const targets = parseHealthTargets(
    JSON.stringify([{ label: 'mcp', url: 'https://mcp.example/', tier: 'P1', mode: 'reachability' }]),
  );
  const cap = captureStderr();
  try {
    await checkHealthTargets({
      targets, fetchHealth: throwsWith('TypeError'), sendAlert: alert.fn,
      webhookUrl: 'https://hooks.example.com/x',
    });
    assert.equal(alert.calls.length, 1);
    assert.equal(alert.calls[0].severity, 'warning'); // P1
    assert.equal(alert.calls[0].body.reason, 'health-unreachable');
  } finally {
    cap.restore();
  }
});

// ── per-service isolation (AC-7 / CD-2) ─────────────────────────────────────

test('T-HM-12: AC-7 — a thrown fetch for one target never aborts the others', async () => {
  const alert = makeAlertSpy();
  const targets = parseHealthTargets(
    JSON.stringify([
      { label: 'a', url: 'https://a.example/health', tier: 'P0' },
      { label: 'b', url: 'https://b.example/health', tier: 'P1' },
      { label: 'c', url: 'https://c.example/health', tier: 'P0' },
    ]),
  );
  const cap = captureStderr();
  try {
    const results = await checkHealthTargets({
      targets,
      fetchHealth: async (url) => {
        if (url.includes('b.example')) { const e = new Error('boom'); e.name = 'AbortError'; throw e; }
        return { status: 200, json: null }; // a and c healthy
      },
      sendAlert: alert.fn,
      webhookUrl: 'https://hooks.example.com/x',
    });
    assert.equal(results.length, 3);
    // Only b alerted (down); a and c still evaluated as ok.
    assert.equal(alert.calls.length, 1);
    assert.equal(alert.calls[0].body.service, 'b');
    const oks = results.filter((r) => r.severity === 'ok');
    assert.equal(oks.length, 2);
  } finally {
    cap.restore();
  }
});

test('T-HM-13: CD-2 fail-open — a throwing sendAlert never aborts remaining targets', async () => {
  const targets = parseHealthTargets(
    JSON.stringify([
      { label: 'a', url: 'https://a.example/health', tier: 'P0' },
      { label: 'b', url: 'https://b.example/health', tier: 'P0' },
    ]),
  );
  let attempts = 0;
  const cap = captureStderr();
  try {
    const results = await checkHealthTargets({
      targets,
      fetchHealth: okResp(500), // both down
      sendAlert: async () => { attempts += 1; throw new Error('webhook blew up'); },
      webhookUrl: 'https://hooks.example.com/x',
    });
    assert.equal(results.length, 2);
    assert.equal(attempts, 2, 'both alerts attempted despite each throwing');
  } finally {
    cap.restore();
  }
});

// ── dryRun test-alert (AC-6) ────────────────────────────────────────────────

test('T-HM-14: AC-6 dryRun — one synthetic alert per target, no probe', async () => {
  const alert = makeAlertSpy();
  const targets = parseHealthTargets(
    JSON.stringify([
      { label: 'gw', url: 'https://gw.example/health', tier: 'P0' },
      { label: 'mcp', url: 'https://mcp.example/', tier: 'P1', mode: 'reachability' },
    ]),
  );
  let probes = 0;
  const cap = captureStderr();
  try {
    const results = await checkHealthTargets({
      targets,
      fetchHealth: async () => { probes += 1; return { status: 200, json: null }; },
      sendAlert: alert.fn,
      webhookUrl: 'https://hooks.example.com/x',
      dryRun: true,
    });
    assert.equal(probes, 0, 'dryRun must NOT hit fetchHealth');
    assert.equal(alert.calls.length, 2);
    assert.equal(alert.calls[0].severity, 'critical'); // P0
    assert.equal(alert.calls[1].severity, 'warning');  // P1
    for (const c of alert.calls) assert.equal(c.body.reason, 'health-test-alert');
    assert.equal(results.length, 2);
  } finally {
    cap.restore();
  }
});

// ── P0 push mention (refinamiento del orquestador) ──────────────────────────

test('T-HM-15: mention threaded to sendAlert only for the configured critical path', async () => {
  const alert = makeAlertSpy();
  const targets = parseHealthTargets(
    JSON.stringify([
      { label: 'gw', url: 'https://gw.example/health', tier: 'P0' },
      { label: 'app', url: 'https://app.example/', tier: 'P1' },
    ]),
  );
  const cap = captureStderr();
  try {
    await checkHealthTargets({
      targets,
      fetchHealth: okResp(500), // both down
      sendAlert: alert.fn,
      webhookUrl: 'https://hooks.example.com/x',
      mention: '<@123>',
    });
    // mention is passed through on every sendAlert call; alerts.mjs decides
    // whether it becomes a push (critical only). Here both calls receive it.
    assert.equal(alert.calls.length, 2);
    assert.equal(alert.calls[0].mention, '<@123>');
    assert.equal(alert.calls[1].mention, '<@123>');
    // Severity still tier-mapped: gw critical, app warning.
    assert.equal(alert.calls[0].severity, 'critical');
    assert.equal(alert.calls[1].severity, 'warning');
  } finally {
    cap.restore();
  }
});

// ── BLQ-BAJO-1: reachability must NOT mask a 5xx (silent outage) ─────────────

test('T-HM-16: reachability mode — 503 → DOWN alert; 404 still counts as alive', async () => {
  const targets = parseHealthTargets(
    JSON.stringify([{ label: 'mcp', url: 'https://mcp.example/', tier: 'P1', mode: 'reachability' }]),
  );
  const cap = captureStderr();
  try {
    // 503 (crashed origin) must alert — the whole point of the monitor.
    const a1 = makeAlertSpy();
    const r1 = await checkHealthTargets({
      targets, fetchHealth: okResp(503), sendAlert: a1.fn,
      webhookUrl: 'https://hooks.example.com/x',
    });
    assert.equal(a1.calls.length, 1, 'reachability + 503 MUST alert (no silent outage)');
    assert.equal(a1.calls[0].severity, 'warning'); // P1 tier
    assert.equal(a1.calls[0].body.reason, 'health-http-error');
    assert.equal(a1.calls[0].body.httpStatus, 503);
    assert.equal(r1[0].severity, 'warning');

    // 404 (auth-protected route) still means the origin is alive → NO alert.
    const a2 = makeAlertSpy();
    const r2 = await checkHealthTargets({
      targets, fetchHealth: okResp(404), sendAlert: a2.fn,
      webhookUrl: 'https://hooks.example.com/x',
    });
    assert.equal(a2.calls.length, 0, '404 must NOT alert in reachability mode');
    assert.equal(r2[0].severity, 'ok');
    assert.equal(r2[0].httpStatus, 404);
  } finally {
    cap.restore();
  }
});

// ── BLQ-BAJO-2: targets are probed in parallel, not serialized ──────────────

test('T-HM-17: N timing-out targets → tick bounded to ~one timeout, all probed', async () => {
  const alert = makeAlertSpy();
  const targets = parseHealthTargets(
    JSON.stringify([
      { label: 'a', url: 'https://a.example/health', tier: 'P0' },
      { label: 'b', url: 'https://b.example/health', tier: 'P0' },
      { label: 'c', url: 'https://c.example/health', tier: 'P0' },
      { label: 'd', url: 'https://d.example/health', tier: 'P0' },
    ]),
  );
  const DELAY = 100;
  const probed = new Set();
  // Each probe waits DELAY then times out (AbortError). Serial → 4×DELAY;
  // parallel (Promise.allSettled) → ~1×DELAY.
  const fetchHealth = async (url) => {
    probed.add(url);
    await new Promise((r) => setTimeout(r, DELAY));
    const e = new Error('timeout'); e.name = 'AbortError'; throw e;
  };
  const cap = captureStderr();
  try {
    const start = Date.now();
    const results = await checkHealthTargets({
      targets, fetchHealth, sendAlert: alert.fn,
      webhookUrl: 'https://hooks.example.com/x',
    });
    const elapsed = Date.now() - start;
    // Every target was probed despite all timing out (isolation preserved).
    assert.equal(probed.size, 4, 'all targets must be probed');
    assert.equal(results.length, 4);
    // All four timed out → all four alerted at their tier.
    assert.equal(alert.calls.length, 4);
    for (const c of alert.calls) assert.equal(c.body.reason, 'health-timeout');
    // Parallel: bounded to ~one DELAY, NOT the 4×DELAY serial sum. Generous
    // upper bound (3×) to avoid CI flakiness while still failing a serial impl.
    assert.ok(elapsed < DELAY * 3, `expected parallel (<${DELAY * 3}ms), got ${elapsed}ms`);
  } finally {
    cap.restore();
  }
});
