// config.test.mjs — 7 tests + bonus for src/config.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from '../src/config.mjs';
import { resetWarnOnce } from '../src/log.mjs';

const VALID_PK = '0x' + '11'.repeat(32);
const PK_ERR = 'OPERATOR_PRIVATE_KEY is required and must be a 0x-prefixed 32-byte hex';

// Snapshot/restore helpers — keep tests isolated.
function snapshotEnv() {
  return {
    OPERATOR_PRIVATE_KEY: process.env.OPERATOR_PRIVATE_KEY,
    WASIAI_GATEWAY_URL: process.env.WASIAI_GATEWAY_URL,
    MCP_GATEWAY_ALLOWLIST: process.env.MCP_GATEWAY_ALLOWLIST,
    KITE_CHAIN_ID: process.env.KITE_CHAIN_ID,
    KITE_PYUSD: process.env.KITE_PYUSD,
    X402_EIP712_DOMAIN_NAME: process.env.X402_EIP712_DOMAIN_NAME,
    X402_EIP712_DOMAIN_VERSION: process.env.X402_EIP712_DOMAIN_VERSION,
    MCP_MAX_AMOUNT_WEI_DEFAULT: process.env.MCP_MAX_AMOUNT_WEI_DEFAULT,
    MCP_PAY_TIMEOUT_MS: process.env.MCP_PAY_TIMEOUT_MS,
    NODE_ENV: process.env.NODE_ENV,
  };
}
function restoreEnv(snap) {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// Capture stderr lines emitted during a fn call.
function captureStderr(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  const lines = [];
  process.stderr.write = (chunk, ...rest) => {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    lines.push(s);
    return true;
  };
  return Promise.resolve(fn()).finally(() => {
    process.stderr.write = orig;
  }).then(v => ({ value: v, lines }), err => ({ error: err, lines }));
}

test('T09: throws when OPERATOR_PRIVATE_KEY undefined; message exact + no value echo', async () => {
  const snap = snapshotEnv();
  delete process.env.OPERATOR_PRIVATE_KEY;
  process.env.WASIAI_GATEWAY_URL = 'https://app.wasiai.io';
  try {
    await assert.rejects(
      async () => loadConfig(),
      (e) => {
        assert.ok(e instanceof ConfigError, 'instanceof ConfigError');
        assert.equal(e.message, PK_ERR);
        return true;
      },
    );
  } finally { restoreEnv(snap); }
});

test('T10: throws when PK is 63 hex chars', async () => {
  const snap = snapshotEnv();
  process.env.OPERATOR_PRIVATE_KEY = '0x' + 'a'.repeat(63);
  process.env.WASIAI_GATEWAY_URL = 'https://app.wasiai.io';
  try {
    await assert.rejects(
      async () => loadConfig(),
      (e) => {
        assert.ok(e instanceof ConfigError);
        // No PK echo (must NOT contain the actual value substring).
        assert.ok(!e.message.includes('a'.repeat(63)), 'message must not echo PK');
        return true;
      },
    );
  } finally { restoreEnv(snap); }
});

test('T11: throws when PK is 65 hex chars', async () => {
  const snap = snapshotEnv();
  process.env.OPERATOR_PRIVATE_KEY = '0x' + 'a'.repeat(65);
  process.env.WASIAI_GATEWAY_URL = 'https://app.wasiai.io';
  try {
    await assert.rejects(
      async () => loadConfig(),
      (e) => e instanceof ConfigError,
    );
  } finally { restoreEnv(snap); }
});

test('T12: throws when PK has whitespace prefix (no auto-trim)', async () => {
  const snap = snapshotEnv();
  process.env.OPERATOR_PRIVATE_KEY = ' 0x' + 'a'.repeat(64);
  process.env.WASIAI_GATEWAY_URL = 'https://app.wasiai.io';
  try {
    await assert.rejects(
      async () => loadConfig(),
      (e) => e instanceof ConfigError,
    );
  } finally { restoreEnv(snap); }
});

test('T13: valid PK returns config with operatorAddress + NO PK fields', async () => {
  const snap = snapshotEnv();
  process.env.OPERATOR_PRIVATE_KEY = VALID_PK;
  process.env.WASIAI_GATEWAY_URL = 'https://app.wasiai.io';
  try {
    const cfg = await loadConfig();
    assert.ok('operatorAddress' in cfg);
    assert.match(cfg.operatorAddress, /^0x[0-9a-fA-F]{40}$/);
    assert.ok(!('privateKey' in cfg), "config must not include 'privateKey'");
    assert.ok(!('OPERATOR_PRIVATE_KEY' in cfg), "config must not include 'OPERATOR_PRIVATE_KEY'");
    assert.ok(!('pk' in cfg), "config must not include 'pk'");
    // Sanity: no JSON serialization leak either.
    const json = JSON.stringify(cfg);
    assert.ok(!json.includes(VALID_PK), 'JSON serialization must not contain PK');
  } finally { restoreEnv(snap); }
});

test('T14: gateway URL fallback to https://app.wasiai.io + warn-once on stderr', async () => {
  const snap = snapshotEnv();
  delete process.env.WASIAI_GATEWAY_URL;
  process.env.OPERATOR_PRIVATE_KEY = VALID_PK;
  resetWarnOnce();
  try {
    const { value, lines } = await captureStderr(() => loadConfig());
    assert.ok(value, 'loadConfig should resolve');
    // Find the warn-once line.
    const matchingLines = lines.filter(l => l.includes('"event":"config.gateway-default"'));
    assert.equal(matchingLines.length, 1, 'expected exactly 1 stderr line for gateway-default');
    assert.ok(matchingLines[0].includes('"gatewayUrl":"https://app.wasiai.io"'));
    assert.equal(value.gatewayUrl.toString(), 'https://app.wasiai.io/');
  } finally { restoreEnv(snap); resetWarnOnce(); }
});

test('T15: gateway URL http://10.0.0.1 throws SSRF in production', async () => {
  const snap = snapshotEnv();
  process.env.OPERATOR_PRIVATE_KEY = VALID_PK;
  process.env.WASIAI_GATEWAY_URL = 'http://10.0.0.1';
  process.env.NODE_ENV = 'production';
  try {
    await assert.rejects(
      async () => loadConfig(),
      (e) => {
        assert.ok(e instanceof ConfigError);
        assert.match(e.message, /scheme|private-ipv4|category/);
        return true;
      },
    );
  } finally { restoreEnv(snap); }
});

// ── Bonus tests ────────────────────────────────────────────────────────────

test('Bonus: gateway URL http://localhost permitted with NODE_ENV=development', async () => {
  const snap = snapshotEnv();
  process.env.OPERATOR_PRIVATE_KEY = VALID_PK;
  process.env.WASIAI_GATEWAY_URL = 'http://localhost:3000';
  process.env.NODE_ENV = 'development';
  try {
    const cfg = await loadConfig();
    assert.equal(cfg.gatewayUrl.hostname, 'localhost');
  } finally { restoreEnv(snap); }
});

test('Bonus: MCP_MAX_AMOUNT_WEI_DEFAULT invalid string throws', async () => {
  const snap = snapshotEnv();
  process.env.OPERATOR_PRIVATE_KEY = VALID_PK;
  process.env.WASIAI_GATEWAY_URL = 'https://app.wasiai.io';
  process.env.MCP_MAX_AMOUNT_WEI_DEFAULT = 'not-a-number';
  try {
    await assert.rejects(
      async () => loadConfig(),
      (e) => e instanceof ConfigError && e.message.includes('MCP_MAX_AMOUNT_WEI_DEFAULT'),
    );
  } finally { restoreEnv(snap); }
});
