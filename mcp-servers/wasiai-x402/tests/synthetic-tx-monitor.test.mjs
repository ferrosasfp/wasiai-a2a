// synthetic-tx-monitor.test.mjs — WKH-74 capa D core (AC-3/4/5, CD-3/5/6/7).
//
// Pure-logic tests: no real network, no real KV, no real spend. Every dependency
// (`getDeployId`, `kvGet`, `kvSet`, `runRealTx`, `sendAlert`) is an injected
// fake so we drive the spend gate (SHA-diff), the pass path (advance KV), the
// fail paths (alert + KV untouched) and fail-open directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkSyntheticTx,
  extractTxHash,
  pipelineFailed,
  SYNTH_TX_FAILED_REASON,
} from '../src/synthetic-tx-monitor.mjs';

const KEY = 'synthetic-last-deploy-id';
const TX = '0x' + 'a'.repeat(64);

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
  return { calls, fn: async (args) => { calls.push(args); return { sent: true }; } };
}

// A tiny in-memory KV double honouring get/set.
function makeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: async (k) => (store.has(k) ? store.get(k) : null),
    set: async (k, v) => { store.set(k, v); return 'OK'; },
  };
}

function okResponse() {
  return { status: 200, json: { kiteTxHash: TX, pipeline: { success: true, steps: [] } } };
}

// The REAL agent-key (prepago) shape: NO top-level kiteTxHash — the on-chain
// proof lives in a downstream step settle (pipeline.steps[].txHash).
function okAgentKeyResponse() {
  return { status: 200, json: { pipeline: { success: true, steps: [{ txHash: TX }] } } };
}

// ── extractTxHash / pipelineFailed (pure) ───────────────────────────────────

test('T-ST-01: extractTxHash — top-level kiteTxHash, step fallback, none', () => {
  assert.equal(extractTxHash({ kiteTxHash: TX }), TX);
  assert.equal(extractTxHash({ pipeline: { steps: [{ txHash: TX }] } }), TX);
  assert.equal(extractTxHash({ pipeline: { steps: [{}, { txHash: TX }] } }), TX);
  assert.equal(extractTxHash({ kiteTxHash: '0xshort' }), null);
  assert.equal(extractTxHash({}), null);
  assert.equal(extractTxHash(null), null);
});

test('T-ST-02: pipelineFailed — only success:false is a failure', () => {
  assert.equal(pipelineFailed({ pipeline: { success: false } }), true);
  assert.equal(pipelineFailed({ pipeline: { success: true } }), false);
  assert.equal(pipelineFailed({ pipeline: {} }), false);
  assert.equal(pipelineFailed({}), false);
  assert.equal(pipelineFailed(null), false);
});

// ── spend gate (AC-5, CD-5) ─────────────────────────────────────────────────

test('T-ST-03: AC-5 — deploy id unchanged → NO real-tx, NO alert, KV untouched', async () => {
  const alert = makeAlertSpy();
  const kv = makeKv({ [KEY]: 'dep-123' });
  let ran = 0;
  const cap = captureStderr();
  try {
    const r = await checkSyntheticTx({
      getDeployId: async () => 'dep-123',
      kvGet: kv.get, kvSet: kv.set, kvKey: KEY,
      runRealTx: async () => { ran += 1; return okResponse(); },
      sendAlert: alert.fn, webhookUrl: 'https://hooks/x',
    });
    assert.equal(ran, 0, 'must NOT spend when deploy id unchanged');
    assert.equal(r.ran, false);
    assert.equal(r.reason, 'no-deploy-change');
    assert.equal(alert.calls.length, 0);
    assert.equal(kv.store.get(KEY), 'dep-123');
  } finally { cap.restore(); }
});

test('T-ST-04: AC-3 — deploy id changed → real-tx runs, tx hash validated, KV advanced', async () => {
  const alert = makeAlertSpy();
  const kv = makeKv({ [KEY]: 'dep-OLD' });
  let ran = 0;
  const cap = captureStderr();
  try {
    const r = await checkSyntheticTx({
      getDeployId: async () => 'dep-NEW',
      kvGet: kv.get, kvSet: kv.set, kvKey: KEY,
      runRealTx: async () => { ran += 1; return okResponse(); },
      sendAlert: alert.fn, webhookUrl: 'https://hooks/x',
    });
    assert.equal(ran, 1, 'must spend exactly once on deploy change');
    assert.equal(r.ran, true);
    assert.equal(r.ok, true);
    assert.equal(r.txHash, TX);
    assert.equal(alert.calls.length, 0);
    // KV advanced to the validated deploy id.
    assert.equal(kv.store.get(KEY), 'dep-NEW');
  } finally { cap.restore(); }
});

test('T-ST-05: AC-3 — first run with no baseline runs exactly one tx then seeds KV', async () => {
  const alert = makeAlertSpy();
  const kv = makeKv({}); // no stored baseline
  let ran = 0;
  const cap = captureStderr();
  try {
    const r = await checkSyntheticTx({
      getDeployId: async () => 'dep-FIRST',
      kvGet: kv.get, kvSet: kv.set, kvKey: KEY,
      runRealTx: async () => { ran += 1; return okResponse(); },
      sendAlert: alert.fn, webhookUrl: 'https://hooks/x',
    });
    assert.equal(ran, 1);
    assert.equal(r.ok, true);
    assert.equal(kv.store.get(KEY), 'dep-FIRST');
  } finally { cap.restore(); }
});

test('T-ST-05b: AC-3 — REAL agent-key shape (steps[].txHash, NO top-level kiteTxHash) validates OK + advances KV', async () => {
  const alert = makeAlertSpy();
  const kv = makeKv({ [KEY]: 'dep-OLD' });
  let ran = 0;
  const cap = captureStderr();
  try {
    const r = await checkSyntheticTx({
      getDeployId: async () => 'dep-NEW',
      kvGet: kv.get, kvSet: kv.set, kvKey: KEY,
      // Prepago path: response carries NO kiteTxHash — proof is in steps[].
      runRealTx: async () => { ran += 1; return okAgentKeyResponse(); },
      sendAlert: alert.fn, webhookUrl: 'https://hooks/x',
    });
    assert.equal(ran, 1);
    assert.equal(r.ran, true);
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'passed');
    assert.equal(r.txHash, TX, 'tx hash sourced from pipeline.steps[].txHash');
    assert.equal(alert.calls.length, 0);
    assert.equal(kv.store.get(KEY), 'dep-NEW');
  } finally { cap.restore(); }
});

// ── fail paths (AC-4) — alert + KV untouched ────────────────────────────────

test('T-ST-06: AC-4 — HTTP error on real-tx → critical alert, KV NOT advanced', async () => {
  const alert = makeAlertSpy();
  const kv = makeKv({ [KEY]: 'dep-OLD' });
  const cap = captureStderr();
  try {
    const r = await checkSyntheticTx({
      getDeployId: async () => 'dep-NEW',
      kvGet: kv.get, kvSet: kv.set, kvKey: KEY,
      runRealTx: async () => ({ status: 500, json: { error: 'boom' } }),
      sendAlert: alert.fn, webhookUrl: 'https://hooks/x',
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'http-error');
    assert.equal(alert.calls.length, 1);
    assert.equal(alert.calls[0].body.reason, SYNTH_TX_FAILED_REASON);
    assert.equal(alert.calls[0].body.httpStatus, 500);
    // AC-4: KV left at the OLD id so the probe retries next tick.
    assert.equal(kv.store.get(KEY), 'dep-OLD');
  } finally { cap.restore(); }
});

test('T-ST-07: AC-4 — 200 but no tx hash → critical alert, KV NOT advanced', async () => {
  const alert = makeAlertSpy();
  const kv = makeKv({ [KEY]: 'dep-OLD' });
  const cap = captureStderr();
  try {
    const r = await checkSyntheticTx({
      getDeployId: async () => 'dep-NEW',
      kvGet: kv.get, kvSet: kv.set, kvKey: KEY,
      runRealTx: async () => ({ status: 200, json: { pipeline: { success: true, steps: [] } } }),
      sendAlert: alert.fn, webhookUrl: 'https://hooks/x',
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-tx-hash');
    assert.equal(alert.calls.length, 1);
    assert.equal(kv.store.get(KEY), 'dep-OLD');
  } finally { cap.restore(); }
});

test('T-ST-08: AC-4 — pipeline success:false → critical alert, KV NOT advanced', async () => {
  const alert = makeAlertSpy();
  const kv = makeKv({ [KEY]: 'dep-OLD' });
  const cap = captureStderr();
  try {
    const r = await checkSyntheticTx({
      getDeployId: async () => 'dep-NEW',
      kvGet: kv.get, kvSet: kv.set, kvKey: KEY,
      runRealTx: async () => ({ status: 200, json: { kiteTxHash: TX, pipeline: { success: false, steps: [] } } }),
      sendAlert: alert.fn, webhookUrl: 'https://hooks/x',
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'pipeline-failed');
    assert.equal(alert.calls.length, 1);
    assert.equal(kv.store.get(KEY), 'dep-OLD');
  } finally { cap.restore(); }
});

test('T-ST-09: AC-4 — real-tx network error → critical alert, KV NOT advanced', async () => {
  const alert = makeAlertSpy();
  const kv = makeKv({ [KEY]: 'dep-OLD' });
  const cap = captureStderr();
  try {
    const r = await checkSyntheticTx({
      getDeployId: async () => 'dep-NEW',
      kvGet: kv.get, kvSet: kv.set, kvKey: KEY,
      runRealTx: async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); },
      sendAlert: alert.fn, webhookUrl: 'https://hooks/x',
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'probe-error');
    assert.equal(alert.calls.length, 1);
    assert.equal(kv.store.get(KEY), 'dep-OLD');
  } finally { cap.restore(); }
});

// ── fail-open (CD-3) — deploy-id / KV read failure → skip, NO tx, NO alert ───

test('T-ST-10: CD-3 — deploy-id read failure → skip, no tx, no alert', async () => {
  const alert = makeAlertSpy();
  const kv = makeKv({ [KEY]: 'dep-OLD' });
  let ran = 0;
  const cap = captureStderr();
  try {
    const r = await checkSyntheticTx({
      getDeployId: async () => { throw new Error('railway down'); },
      kvGet: kv.get, kvSet: kv.set, kvKey: KEY,
      runRealTx: async () => { ran += 1; return okResponse(); },
      sendAlert: alert.fn, webhookUrl: 'https://hooks/x',
    });
    assert.equal(ran, 0);
    assert.equal(r.ran, false);
    assert.equal(r.reason, 'deploy-id-unavailable');
    assert.equal(alert.calls.length, 0);
  } finally { cap.restore(); }
});

test('T-ST-11: CD-3 — KV read failure → skip, no tx, no alert', async () => {
  const alert = makeAlertSpy();
  let ran = 0;
  const cap = captureStderr();
  try {
    const r = await checkSyntheticTx({
      getDeployId: async () => 'dep-NEW',
      kvGet: async () => { throw new Error('kv down'); },
      kvSet: async () => 'OK', kvKey: KEY,
      runRealTx: async () => { ran += 1; return okResponse(); },
      sendAlert: alert.fn, webhookUrl: 'https://hooks/x',
    });
    assert.equal(ran, 0);
    assert.equal(r.reason, 'kv-read-failed');
    assert.equal(alert.calls.length, 0);
  } finally { cap.restore(); }
});

test('T-ST-12: CD-3 — passed real-tx but KV write fails → ok, no alert, no throw', async () => {
  const alert = makeAlertSpy();
  const cap = captureStderr();
  try {
    const r = await checkSyntheticTx({
      getDeployId: async () => 'dep-NEW',
      kvGet: async () => 'dep-OLD',
      kvSet: async () => { throw new Error('kv write down'); },
      kvKey: KEY,
      runRealTx: async () => okResponse(),
      sendAlert: alert.fn, webhookUrl: 'https://hooks/x',
    });
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'passed-kv-write-failed');
    assert.equal(alert.calls.length, 0);
  } finally { cap.restore(); }
});

test('T-ST-13: CD-3 — a throwing sendAlert on a failed probe never bubbles out', async () => {
  const kv = makeKv({ [KEY]: 'dep-OLD' });
  const cap = captureStderr();
  try {
    const r = await checkSyntheticTx({
      getDeployId: async () => 'dep-NEW',
      kvGet: kv.get, kvSet: kv.set, kvKey: KEY,
      runRealTx: async () => ({ status: 500, json: {} }),
      sendAlert: async () => { throw new Error('webhook blew up'); },
      webhookUrl: 'https://hooks/x',
    });
    assert.equal(r.ok, false);
    assert.equal(kv.store.get(KEY), 'dep-OLD');
  } finally { cap.restore(); }
});
