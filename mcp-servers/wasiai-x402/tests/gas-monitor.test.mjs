// gas-monitor.test.mjs — WKH-71 native-gas monitor core (AC-1/2/6, CD-3/4/6).
//
// Pure-logic tests: no RPC, no network. `readBalance` and `sendAlert` are
// injected fakes so we exercise threshold decisions, per-combo independence,
// fail-open behaviour and the read-only contract directly.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseEther } from 'viem';

import {
  CHAIN_REGISTRY,
  checkGasBalances,
  evaluateSeverity,
  parseTargets,
  resolveRpcUrl,
  resolveThresholds,
} from '../src/gas-monitor.mjs';

const WALLET_A = '0x9c0638506F8C5fc44F0d8C7b9E9e267eA311BB5c';
const WALLET_B = '0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba';

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

// A sendAlert spy matching the src/alerts.mjs contract (never throws).
function makeAlertSpy() {
  const calls = [];
  return {
    calls,
    fn: async (args) => {
      calls.push(args);
      return { sent: true, status: 200 };
    },
  };
}

beforeEach(() => {
  // no global state
});

// ── evaluateSeverity ────────────────────────────────────────────────────────

test('T-GM-01: evaluateSeverity — critical < warning < ok boundaries', () => {
  const th = { criticalWei: parseEther('0.1'), warningWei: parseEther('0.5') };
  assert.equal(evaluateSeverity(parseEther('0.05'), th), 'critical');
  // Exactly at critical is NOT below critical → warning tier.
  assert.equal(evaluateSeverity(parseEther('0.1'), th), 'warning');
  assert.equal(evaluateSeverity(parseEther('0.3'), th), 'warning');
  // Exactly at warning is OK (not below).
  assert.equal(evaluateSeverity(parseEther('0.5'), th), null);
  assert.equal(evaluateSeverity(parseEther('5'), th), null);
});

// ── parseTargets ────────────────────────────────────────────────────────────

test('T-GM-02: parseTargets — valid JSON parsed, chainIds coerced to ints', () => {
  const raw = JSON.stringify([
    { label: 'facilitator', address: WALLET_A, chainIds: [43113, 2368] },
  ]);
  const targets = parseTargets(raw);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].label, 'facilitator');
  assert.equal(targets[0].address, WALLET_A);
  assert.deepEqual(targets[0].chainIds, [43113, 2368]);
});

test('T-GM-03: parseTargets — invalid entries dropped, never throws', () => {
  const cap = captureStderr();
  try {
    assert.deepEqual(parseTargets(undefined), []);
    assert.deepEqual(parseTargets(''), []);
    assert.deepEqual(parseTargets('not-json{'), []);
    assert.deepEqual(parseTargets('{"not":"array"}'), []);
    // Bad address / missing chains dropped; valid one kept.
    const mixed = JSON.stringify([
      { label: 'bad-addr', address: '0xnothex', chainIds: [43113] },
      { label: 'no-chains', address: WALLET_A, chainIds: [] },
      { label: 'ok', address: WALLET_B, chainIds: [84532] },
    ]);
    const out = parseTargets(mixed);
    assert.equal(out.length, 1);
    assert.equal(out[0].label, 'ok');
  } finally {
    cap.restore();
  }
});

// ── resolveThresholds / resolveRpcUrl (CD-6) ────────────────────────────────

test('T-GM-04: resolveThresholds — defaults, env override, invalid fallback', () => {
  const cap = captureStderr();
  try {
    // Defaults (empty env).
    const def = resolveThresholds(43113, {});
    assert.equal(def.warningNative, CHAIN_REGISTRY[43113].defaultWarning);
    assert.equal(def.criticalNative, CHAIN_REGISTRY[43113].defaultCritical);
    assert.equal(def.warningWei, parseEther(CHAIN_REGISTRY[43113].defaultWarning));

    // Env override.
    const ov = resolveThresholds(43113, {
      WALLET_ALERT_THRESHOLD_FUJI_WARNING: '2',
      WALLET_ALERT_THRESHOLD_FUJI_CRITICAL: '0.75',
    });
    assert.equal(ov.warningNative, '2');
    assert.equal(ov.criticalWei, parseEther('0.75'));

    // Invalid (NaN / negative) → falls back to default, logs.
    const bad = resolveThresholds(2368, {
      WALLET_ALERT_THRESHOLD_KITE_WARNING: 'abc',
      WALLET_ALERT_THRESHOLD_KITE_CRITICAL: '-1',
    });
    assert.equal(bad.warningNative, CHAIN_REGISTRY[2368].defaultWarning);
    assert.equal(bad.criticalNative, CHAIN_REGISTRY[2368].defaultCritical);

    // Unknown chain → null.
    assert.equal(resolveThresholds(999999, {}), null);
  } finally {
    cap.restore();
  }
});

test('T-GM-05: resolveRpcUrl — env override wins over registry default', () => {
  assert.equal(resolveRpcUrl(43113, {}), CHAIN_REGISTRY[43113].defaultRpc);
  assert.equal(
    resolveRpcUrl(43113, { GAS_ALERT_RPC_43113: 'https://custom.rpc/' }),
    'https://custom.rpc/',
  );
  assert.equal(resolveRpcUrl(999999, {}), null);
});

// ── checkGasBalances (AC-1/2/6, CD-3/4) ─────────────────────────────────────

test('T-GM-06: critical balance fires severity=critical alert with public body only', async () => {
  const alert = makeAlertSpy();
  const targets = parseTargets(
    JSON.stringify([{ label: 'facilitator', address: WALLET_A, chainIds: [43113] }]),
  );
  const cap = captureStderr();
  try {
    const results = await checkGasBalances({
      targets,
      env: {}, // defaults: Fuji warning 0.5 / critical 0.1
      readBalance: async () => parseEther('0.05'), // below critical
      sendAlert: alert.fn,
      webhookUrl: 'https://hooks.example.com/x',
    });
    assert.equal(alert.calls.length, 1);
    const call = alert.calls[0];
    assert.equal(call.severity, 'critical');
    assert.equal(call.webhookUrl, 'https://hooks.example.com/x');
    assert.equal(call.body.reason, 'gas-below-critical');
    assert.equal(call.body.operator, WALLET_A);
    assert.equal(call.body.label, 'facilitator');
    assert.equal(call.body.chainId, 43113);
    assert.equal(call.body.symbol, 'AVAX');
    assert.equal(call.body.balanceNative, '0.05');
    assert.equal(call.body.threshold, 0.1);
    // No secret-bearing keys.
    assert.ok(!('privateKey' in call.body));
    assert.ok(!('OPERATOR_PRIVATE_KEY' in call.body));
    // Result recorded.
    assert.equal(results.length, 1);
    assert.equal(results[0].severity, 'critical');
  } finally {
    cap.restore();
  }
});

test('T-GM-06b: NIT-1 — ONCALL mention forwarded to sendAlert on a critical gas alert', async () => {
  const alert = makeAlertSpy();
  const targets = parseTargets(
    JSON.stringify([{ label: 'facilitator', address: WALLET_A, chainIds: [43113] }]),
  );
  const cap = captureStderr();
  try {
    await checkGasBalances({
      targets,
      env: {},
      readBalance: async () => parseEther('0.05'), // below critical
      sendAlert: alert.fn,
      webhookUrl: 'https://hooks.example.com/x',
      mention: '<@123456789012345678>',
    });
    assert.equal(alert.calls.length, 1);
    assert.equal(alert.calls[0].severity, 'critical');
    // The mention flows through so alerts.mjs can turn it into a Discord push.
    assert.equal(alert.calls[0].mention, '<@123456789012345678>');
  } finally {
    cap.restore();
  }
});

test('T-GM-07: warning-tier balance fires severity=warning', async () => {
  const alert = makeAlertSpy();
  const targets = parseTargets(
    JSON.stringify([{ label: 'op', address: WALLET_B, chainIds: [43113] }]),
  );
  const cap = captureStderr();
  try {
    await checkGasBalances({
      targets,
      env: {},
      readBalance: async () => parseEther('0.3'), // between 0.1 and 0.5
      sendAlert: alert.fn,
      webhookUrl: 'https://hooks.example.com/x',
    });
    assert.equal(alert.calls.length, 1);
    assert.equal(alert.calls[0].severity, 'warning');
    assert.equal(alert.calls[0].body.reason, 'gas-below-warning');
    assert.equal(alert.calls[0].body.threshold, 0.5);
  } finally {
    cap.restore();
  }
});

test('T-GM-08: healthy balance fires NO alert', async () => {
  const alert = makeAlertSpy();
  const targets = parseTargets(
    JSON.stringify([{ label: 'op', address: WALLET_B, chainIds: [43113] }]),
  );
  const cap = captureStderr();
  try {
    const results = await checkGasBalances({
      targets,
      env: {},
      readBalance: async () => parseEther('5'),
      sendAlert: alert.fn,
      webhookUrl: 'https://hooks.example.com/x',
    });
    assert.equal(alert.calls.length, 0);
    assert.equal(results[0].severity, 'ok');
  } finally {
    cap.restore();
  }
});

test('T-GM-09: AC-6 — each wallet×chain evaluated independently', async () => {
  const alert = makeAlertSpy();
  const targets = parseTargets(
    JSON.stringify([
      { label: 'facilitator', address: WALLET_A, chainIds: [43113, 2368] },
      { label: 'operator', address: WALLET_B, chainIds: [43113] },
    ]),
  );
  // WALLET_A dry on Fuji only; healthy on Kite. WALLET_B healthy on Fuji.
  const balances = {
    [`${WALLET_A}:43113`]: parseEther('0'),
    [`${WALLET_A}:2368`]: parseEther('5'),
    [`${WALLET_B}:43113`]: parseEther('5'),
  };
  const cap = captureStderr();
  try {
    const results = await checkGasBalances({
      targets,
      env: {},
      readBalance: async (chainId, address) => balances[`${address}:${chainId}`],
      sendAlert: alert.fn,
      webhookUrl: 'https://hooks.example.com/x',
    });
    // 3 combos checked, exactly 1 alert (WALLET_A on Fuji).
    assert.equal(results.length, 3);
    assert.equal(alert.calls.length, 1);
    assert.equal(alert.calls[0].body.operator, WALLET_A);
    assert.equal(alert.calls[0].body.chainId, 43113);
    // The other two combos are 'ok', not masked.
    const oks = results.filter((r) => r.severity === 'ok');
    assert.equal(oks.length, 2);
  } finally {
    cap.restore();
  }
});

test('T-GM-10: CD-4 fail-open — a read error on one combo never masks others', async () => {
  const alert = makeAlertSpy();
  const targets = parseTargets(
    JSON.stringify([
      { label: 'facilitator', address: WALLET_A, chainIds: [43113] },
      { label: 'operator', address: WALLET_B, chainIds: [43113] },
    ]),
  );
  const cap = captureStderr();
  try {
    const results = await checkGasBalances({
      targets,
      env: {},
      readBalance: async (_chainId, address) => {
        if (address === WALLET_A) throw new Error('rpc exploded');
        return parseEther('0'); // WALLET_B critical
      },
      sendAlert: alert.fn,
      webhookUrl: 'https://hooks.example.com/x',
    });
    const a = results.find((r) => r.address === WALLET_A);
    const b = results.find((r) => r.address === WALLET_B);
    assert.equal(a.status, 'read-error');
    assert.equal(b.status, 'checked');
    assert.equal(b.severity, 'critical');
    // WALLET_B still alerted despite WALLET_A read failure.
    assert.equal(alert.calls.length, 1);
    assert.equal(alert.calls[0].body.operator, WALLET_B);
  } finally {
    cap.restore();
  }
});

test('T-GM-11: CD-4 fail-open — a throwing sendAlert never aborts remaining combos', async () => {
  const targets = parseTargets(
    JSON.stringify([
      { label: 'a', address: WALLET_A, chainIds: [43113] },
      { label: 'b', address: WALLET_B, chainIds: [43113] },
    ]),
  );
  let alertAttempts = 0;
  const cap = captureStderr();
  try {
    const results = await checkGasBalances({
      targets,
      env: {},
      readBalance: async () => parseEther('0'), // both critical
      sendAlert: async () => {
        alertAttempts += 1;
        throw new Error('webhook client blew up');
      },
      webhookUrl: 'https://hooks.example.com/x',
    });
    // Both combos still processed even though every alert threw.
    assert.equal(results.length, 2);
    assert.equal(alertAttempts, 2);
  } finally {
    cap.restore();
  }
});

test('T-GM-12: CD-3 read-only — readBalance is the ONLY external call, no signer', async () => {
  const alert = makeAlertSpy();
  const targets = parseTargets(
    JSON.stringify([{ label: 'op', address: WALLET_A, chainIds: [43113] }]),
  );
  const readArgs = [];
  const cap = captureStderr();
  try {
    await checkGasBalances({
      targets,
      env: {},
      readBalance: async (chainId, address, rpcUrl) => {
        readArgs.push({ chainId, address, rpcUrl });
        return parseEther('5');
      },
      sendAlert: alert.fn,
      webhookUrl: 'https://hooks.example.com/x',
    });
    assert.equal(readArgs.length, 1);
    assert.equal(readArgs[0].chainId, 43113);
    assert.equal(readArgs[0].address, WALLET_A);
    // The RPC URL passed is the read-only public default (no signing surface).
    assert.equal(readArgs[0].rpcUrl, CHAIN_REGISTRY[43113].defaultRpc);
  } finally {
    cap.restore();
  }
});

// ── BLQ-1: parse-safe thresholds (validate !== parse) ───────────────────────

test('T-GM-13: BLQ-1 — parse-unsafe thresholds fall to default without throwing', () => {
  // Each of these is finite & >= 0 for Number.parseFloat yet makes parseEther
  // throw InvalidDecimalNumberError. Before the fix that throw escaped the whole
  // cron loop (monitor blackout). Now they must silently fall to the default.
  const badValues = ['0.5 ', ' 0.5', '1e-6', '0.1.2', '+1', '.5', '0x1'];
  const cap = captureStderr();
  try {
    for (const bad of badValues) {
      let th;
      assert.doesNotThrow(() => {
        th = resolveThresholds(43113, {
          WALLET_ALERT_THRESHOLD_FUJI_WARNING: bad,
          WALLET_ALERT_THRESHOLD_FUJI_CRITICAL: bad,
        });
      }, `parseEther must not throw for ${JSON.stringify(bad)}`);
      assert.equal(th.warningNative, CHAIN_REGISTRY[43113].defaultWarning);
      assert.equal(th.criticalNative, CHAIN_REGISTRY[43113].defaultCritical);
    }
  } finally {
    cap.restore();
  }
});

test('T-GM-14: BLQ-1 — a malformed threshold for one combo never aborts the loop', async () => {
  const alert = makeAlertSpy();
  const targets = parseTargets(
    JSON.stringify([
      { label: 'facilitator', address: WALLET_A, chainIds: [43113] },
      { label: 'operator', address: WALLET_B, chainIds: [2368] },
    ]),
  );
  const cap = captureStderr();
  try {
    const results = await checkGasBalances({
      targets,
      // Fuji threshold is the exact parse-unsafe string ("0.5 ", trailing space)
      // that used to make parseEther throw and blackout the monitor. It must now
      // fall to the Fuji default AND leave the Kite combo fully evaluated.
      env: { WALLET_ALERT_THRESHOLD_FUJI_WARNING: '0.5 ' },
      readBalance: async () => parseEther('5'), // both healthy
      sendAlert: alert.fn,
      webhookUrl: 'https://hooks.example.com/x',
    });
    // No blackout: both combos evaluated ({checked:0} regression guard).
    assert.equal(results.length, 2);
    assert.equal(results.filter((r) => r.status === 'checked').length, 2);
  } finally {
    cap.restore();
  }
});

// ── NIT-3: inverted threshold order ─────────────────────────────────────────

test('T-GM-15: NIT-3 — inverted warning<critical falls back to chain defaults', () => {
  const cap = captureStderr();
  try {
    const th = resolveThresholds(43113, {
      WALLET_ALERT_THRESHOLD_FUJI_WARNING: '0.1',
      WALLET_ALERT_THRESHOLD_FUJI_CRITICAL: '0.5', // inverted (warning < critical)
    });
    assert.equal(th.warningNative, CHAIN_REGISTRY[43113].defaultWarning);
    assert.equal(th.criticalNative, CHAIN_REGISTRY[43113].defaultCritical);
    // Order restored: warning tier is no longer silently dead.
    assert.ok(th.warningWei >= th.criticalWei);
  } finally {
    cap.restore();
  }
});

// ── NIT-4: parseTargets dedup ───────────────────────────────────────────────

test('T-GM-16: NIT-4 — parseTargets dedups address×chainId (case-insensitive)', () => {
  const cap = captureStderr();
  try {
    // Same wallet (different case) + overlapping chainIds across entries, plus a
    // duplicate chainId inside one entry.
    const raw = JSON.stringify([
      { label: 'a', address: WALLET_A, chainIds: [43113, 43113, 2368] },
      { label: 'b', address: WALLET_A.toLowerCase(), chainIds: [43113, 84532] },
    ]);
    const out = parseTargets(raw);
    const combos = out.flatMap((t) =>
      t.chainIds.map((c) => `${t.address.toLowerCase()}:${c}`),
    );
    // Every combo unique — no double alert for the same wallet×chain.
    assert.equal(combos.length, new Set(combos).size);
    assert.deepEqual(
      [...new Set(combos)].sort(),
      [
        `${WALLET_A.toLowerCase()}:2368`,
        `${WALLET_A.toLowerCase()}:43113`,
        `${WALLET_A.toLowerCase()}:84532`,
      ].sort(),
    );
  } finally {
    cap.restore();
  }
});
