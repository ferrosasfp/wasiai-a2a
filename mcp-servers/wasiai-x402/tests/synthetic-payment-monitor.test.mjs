// synthetic-payment-monitor.test.mjs — WKH-74 capa A core (AC-1/2, CD-3/4/6/7).
//
// Pure-logic tests: no real network. `fetchProbe` and `sendAlert` are injected
// fakes so we exercise the 402-expected happy path, every broken-path branch
// (200/401/403/5xx/timeout/shape+payTo/asset/network mismatch), fail-open, and
// the CD-4 "no payment header ever" contract at the core level.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkSyntheticPayment,
  evaluateProbe,
  resolveExpected,
  resolveProbeBody,
  resolveProbeUrl,
  SYNTH_PAYMENT_BROKEN_REASON,
} from '../src/synthetic-payment-monitor.mjs';

const PAYTO = '0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba';
const ASSET = '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9';
const NETWORK = 'eip155:2368';
const EXPECTED = { payTo: PAYTO, asset: ASSET, network: NETWORK };

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

// A 402 x402 challenge body as the gateway builds it.
function challenge(overrides = {}) {
  return {
    error: 'payment required',
    x402Version: 2,
    accepts: [
      { scheme: 'exact', payTo: PAYTO, asset: ASSET, network: NETWORK, maxAmountRequired: '10000', ...overrides },
    ],
  };
}

// ── config resolvers (CD-6) ─────────────────────────────────────────────────

test('T-SP-01: resolveProbeUrl — valid https, blank/unset → null', () => {
  assert.equal(resolveProbeUrl({ SYNTH_ORCHESTRATE_URL: 'https://g/orchestrate' }), 'https://g/orchestrate');
  assert.equal(resolveProbeUrl({}), null);
  assert.equal(resolveProbeUrl({ SYNTH_ORCHESTRATE_URL: '' }), null);
  const cap = captureStderr();
  try {
    assert.equal(resolveProbeUrl({ SYNTH_ORCHESTRATE_URL: 'not a url' }), null);
    assert.equal(resolveProbeUrl({ SYNTH_ORCHESTRATE_URL: 'ftp://x/y' }), null);
  } finally { cap.restore(); }
});

test('T-SP-02: resolveProbeBody — defaults + env override, schema-valid budget', () => {
  const def = resolveProbeBody({});
  assert.equal(typeof def.goal, 'string');
  assert.ok(def.goal.length > 0);
  assert.equal(def.budget, 0.01);
  const ov = resolveProbeBody({ SYNTH_PROBE_GOAL: 'hi', SYNTH_PROBE_BUDGET: '0.5' });
  assert.equal(ov.goal, 'hi');
  assert.equal(ov.budget, 0.5);
  // Invalid budget (<=0 / NaN) falls back to default.
  assert.equal(resolveProbeBody({ SYNTH_PROBE_BUDGET: '0' }).budget, 0.01);
  assert.equal(resolveProbeBody({ SYNTH_PROBE_BUDGET: 'abc' }).budget, 0.01);
});

test('T-SP-03: resolveExpected — all three required, addresses validated', () => {
  assert.deepEqual(resolveExpected({
    SYNTH_EXPECT_PAYTO: PAYTO, SYNTH_EXPECT_ASSET: ASSET, SYNTH_EXPECT_NETWORK: NETWORK,
  }), EXPECTED);
  // Any missing → null.
  assert.equal(resolveExpected({ SYNTH_EXPECT_PAYTO: PAYTO, SYNTH_EXPECT_ASSET: ASSET }), null);
  const cap = captureStderr();
  try {
    // Bad address → null.
    assert.equal(resolveExpected({
      SYNTH_EXPECT_PAYTO: '0xnothex', SYNTH_EXPECT_ASSET: ASSET, SYNTH_EXPECT_NETWORK: NETWORK,
    }), null);
  } finally { cap.restore(); }
});

// ── evaluateProbe (pure) ────────────────────────────────────────────────────

test('T-SP-04: evaluateProbe — exact 402 challenge matches (case-insensitive)', () => {
  assert.deepEqual(evaluateProbe(402, challenge(), EXPECTED), { ok: true });
  // Checksummed vs lowercased payTo/asset still match.
  assert.deepEqual(
    evaluateProbe(402, challenge({ payTo: PAYTO.toLowerCase(), asset: ASSET.toLowerCase() }), EXPECTED),
    { ok: true },
  );
});

test('T-SP-05: evaluateProbe — mismatches flagged with detail', () => {
  assert.equal(evaluateProbe(200, {}, EXPECTED).detail, 'unexpected-status');
  assert.equal(evaluateProbe(402, {}, EXPECTED).detail, 'missing-accepts');
  assert.equal(evaluateProbe(402, { accepts: [] }, EXPECTED).detail, 'missing-accepts');
  assert.equal(evaluateProbe(402, challenge({ payTo: '0x0000000000000000000000000000000000000001' }), EXPECTED).detail, 'payto-mismatch');
  assert.equal(evaluateProbe(402, challenge({ asset: '0x0000000000000000000000000000000000000002' }), EXPECTED).detail, 'asset-mismatch');
  assert.equal(evaluateProbe(402, challenge({ network: 'eip155:8453' }), EXPECTED).detail, 'network-mismatch');
});

// ── checkSyntheticPayment (AC-1/2, CD-3/4/7) ────────────────────────────────

test('T-SP-06: AC-1 — expected 402 challenge → OK, no alert, no payment header', async () => {
  const alert = makeAlertSpy();
  const seenOpts = [];
  const cap = captureStderr();
  try {
    const r = await checkSyntheticPayment({
      url: 'https://g/orchestrate',
      body: { goal: 'x', budget: 0.01 },
      expected: EXPECTED,
      fetchProbe: async (_url, opts) => { seenOpts.push(opts); return { status: 402, json: challenge() }; },
      sendAlert: alert.fn,
      webhookUrl: 'https://hooks.example.com/x',
    });
    assert.equal(r.severity, null);
    assert.equal(alert.calls.length, 0);
    // CD-4: the core never adds any header; the injected fetchProbe only sees
    // {body, timeoutMs} — there is no place for a payment header at this layer.
    assert.equal(seenOpts.length, 1);
    assert.deepEqual(Object.keys(seenOpts[0]).sort(), ['body', 'timeoutMs']);
  } finally { cap.restore(); }
});

test('T-SP-07: AC-2 — non-402 statuses each fire ONE critical alert (public body)', async () => {
  for (const status of [200, 401, 403, 500, 502, 503]) {
    const alert = makeAlertSpy();
    const cap = captureStderr();
    try {
      const r = await checkSyntheticPayment({
        url: 'https://g/orchestrate',
        body: { goal: 'x', budget: 0.01 },
        expected: EXPECTED,
        fetchProbe: async () => ({ status, json: { ok: true } }),
        sendAlert: alert.fn,
        webhookUrl: 'https://hooks.example.com/x',
        mention: '<@123>',
      });
      assert.equal(r.severity, 'critical', `status ${status} must alert`);
      assert.equal(alert.calls.length, 1);
      const call = alert.calls[0];
      assert.equal(call.severity, 'critical');
      assert.equal(call.mention, '<@123>');
      assert.equal(call.body.reason, SYNTH_PAYMENT_BROKEN_REASON);
      assert.equal(call.body.httpStatus, status);
      assert.equal(call.body.event, 'synthetic-payment-check');
      // CD-7: no secret-bearing keys in the body.
      assert.ok(!('MONITOR_A2A_KEY' in call.body));
      assert.ok(!('privateKey' in call.body));
    } finally { cap.restore(); }
  }
});

test('T-SP-08: AC-2 — 402 with wrong payTo/asset/network fires critical', async () => {
  for (const bad of [{ payTo: '0x0000000000000000000000000000000000000009' }, { asset: '0x0000000000000000000000000000000000000008' }, { network: 'eip155:1' }]) {
    const alert = makeAlertSpy();
    const cap = captureStderr();
    try {
      const r = await checkSyntheticPayment({
        url: 'https://g/orchestrate',
        body: { goal: 'x', budget: 0.01 },
        expected: EXPECTED,
        fetchProbe: async () => ({ status: 402, json: challenge(bad) }),
        sendAlert: alert.fn,
        webhookUrl: 'https://hooks.example.com/x',
      });
      assert.equal(r.severity, 'critical');
      assert.equal(alert.calls.length, 1);
      assert.equal(alert.calls[0].body.httpStatus, 402);
    } finally { cap.restore(); }
  }
});

test('T-SP-09: AC-2 — network timeout / unreachable fires critical (no throw)', async () => {
  const alert = makeAlertSpy();
  const cap = captureStderr();
  try {
    const timeoutErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const r = await checkSyntheticPayment({
      url: 'https://g/orchestrate',
      body: { goal: 'x', budget: 0.01 },
      expected: EXPECTED,
      fetchProbe: async () => { throw timeoutErr; },
      sendAlert: alert.fn,
      webhookUrl: 'https://hooks.example.com/x',
    });
    assert.equal(r.severity, 'critical');
    assert.equal(r.detail, 'probe-timeout');
    assert.equal(alert.calls.length, 1);
    // No httpStatus on a network failure.
    assert.ok(!('httpStatus' in alert.calls[0].body));
  } finally { cap.restore(); }
});

test('T-SP-10: CD-3 fail-open — a throwing sendAlert never bubbles out', async () => {
  const cap = captureStderr();
  try {
    const r = await checkSyntheticPayment({
      url: 'https://g/orchestrate',
      body: { goal: 'x', budget: 0.01 },
      expected: EXPECTED,
      fetchProbe: async () => ({ status: 200, json: {} }), // broken → will alert
      sendAlert: async () => { throw new Error('webhook blew up'); },
      webhookUrl: 'https://hooks.example.com/x',
    });
    // Still returns a normal row despite the alert client throwing.
    assert.equal(r.severity, 'critical');
  } finally { cap.restore(); }
});
