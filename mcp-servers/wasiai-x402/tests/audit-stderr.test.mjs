// audit-stderr.test.mjs — WKH-66 W5 cross-cutting audit (AC-X-1).
//
// This is a focused stderr-leak audit that complements T-CH-20 inside
// chaos.test.mjs. It re-runs the most secret-sensitive paths (auth fail,
// rate-limit hit, balance-gate reject, alert webhook fail) and asserts no
// secret slipped through ANY stderr line emitted by:
//   - src/balance-guard.mjs
//   - src/rate-limit.mjs
//   - src/alerts.mjs
//   - src/cron-auth.mjs
//   - src/kv-client.mjs
//
// Forbidden patterns:
//   - OPERATOR_PRIVATE_KEY (raw, hex, with/without 0x prefix)
//   - MCP_BEARER_TOKEN (raw)
//   - CRON_SECRET (raw)
//   - CRONJOB_ORG_API_TOKEN (raw)
//   - KV_REST_API_TOKEN (raw)
//   - any 0x-prefixed 64-char hex (unattributed)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkBalanceWithClaim } from '../src/balance-guard.mjs';
import { checkRateLimit, hashBearer } from '../src/rate-limit.mjs';
import { sendAlert } from '../src/alerts.mjs';
import { validateCronSecret, CronAuthError } from '../src/cron-auth.mjs';
import { resetWarnOnce } from '../src/log.mjs';
import { createKvMock } from './_mocks/kv-mock.mjs';
import { createRpcMock } from './_mocks/rpc-mock.mjs';

// Distinct secret values so substring checks are unambiguous.
const SECRETS = {
  PK: '0x' + 'cd'.repeat(32),
  PK_BARE: 'cd'.repeat(32),
  BEARER: 'cafebabe' + 'a'.repeat(56),
  CRON_SECRET: 'cron-secret-' + 'a'.repeat(20),
  CRONJOB_TOKEN: 'cronjob-token-' + 'b'.repeat(20),
  KV_TOKEN: 'kv-token-' + 'c'.repeat(20),
};

const OPERATOR = '0x' + '11'.repeat(20);
const USDC_ADDR = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E';

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

test('audit: no secret leaks across balance-guard / rate-limit / alerts / cron-auth fail paths', async () => {
  resetWarnOnce();
  // Stage env vars that COULD leak if the modules misbehave.
  process.env.OPERATOR_PRIVATE_KEY = SECRETS.PK;
  process.env.MCP_BEARER_TOKEN = SECRETS.BEARER;
  process.env.CRON_SECRET = SECRETS.CRON_SECRET;
  process.env.CRONJOB_ORG_API_TOKEN = SECRETS.CRONJOB_TOKEN;
  process.env.KV_REST_API_TOKEN = SECRETS.KV_TOKEN;

  const cap = captureStderr();
  try {
    // 1. balance-guard: fail-secure on null kv.
    await checkBalanceWithClaim({
      operator: OPERATOR, chainId: 43114, requestedWei: 100_000n,
      threshold: 0.5, kvClient: null, publicClient: createRpcMock(),
      usdcAddress: USDC_ADDR,
    });

    // 2. balance-guard: RPC throw fail-secure.
    const kv = createKvMock();
    const rpc = createRpcMock({ failNext: 1 });
    await checkBalanceWithClaim({
      operator: OPERATOR, chainId: 43114, requestedWei: 100_000n,
      threshold: 0.5, kvClient: kv, publicClient: rpc,
      usdcAddress: USDC_ADDR,
    });

    // 3. rate-limit: KV throw → fail-open + log warn.
    kv._setFailNext(1);
    await checkRateLimit({
      bearerHash16: hashBearer(SECRETS.BEARER), kvClient: kv,
      perMin: 5, windowSec: 60,
    });

    // 4. alerts: webhook missing → warnOnce.
    await sendAlert({
      severity: 'critical',
      body: { chain: 'avax', operator: OPERATOR },
      webhookUrl: '',
    });

    // 5. alerts: webhook throws → log warn.
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('boom'); };
    try {
      await sendAlert({
        severity: 'critical',
        body: { chain: 'avax', operator: OPERATOR },
        webhookUrl: 'https://hooks.example.com/x',
      });
    } finally {
      globalThis.fetch = origFetch;
    }

    // 6. cron-auth: wrong secret → 401 (caller would log warn).
    try {
      validateCronSecret('Bearer wrong-' + 'x'.repeat(50), SECRETS.CRON_SECRET);
    } catch (e) {
      assert.ok(e instanceof CronAuthError);
    }
  } finally {
    cap.restore();
    delete process.env.OPERATOR_PRIVATE_KEY;
    delete process.env.MCP_BEARER_TOKEN;
    delete process.env.CRON_SECRET;
    delete process.env.CRONJOB_ORG_API_TOKEN;
    delete process.env.KV_REST_API_TOKEN;
  }

  const blob = cap.lines.join('\n');
  // Check every secret variant.
  assert.ok(!blob.includes(SECRETS.PK), 'stderr leaked PK (0x-form)');
  assert.ok(!blob.includes(SECRETS.PK_BARE), 'stderr leaked PK (bare hex)');
  assert.ok(!blob.includes(SECRETS.BEARER), 'stderr leaked bearer');
  assert.ok(!blob.includes(SECRETS.CRON_SECRET), 'stderr leaked CRON_SECRET');
  assert.ok(!blob.includes(SECRETS.CRONJOB_TOKEN), 'stderr leaked CRONJOB_ORG_API_TOKEN');
  assert.ok(!blob.includes(SECRETS.KV_TOKEN), 'stderr leaked KV_REST_API_TOKEN');
  // Generic 0x{64hex} pattern — anything matching is a private key shape.
  const matches = blob.match(/0x[0-9a-fA-F]{64}/g) ?? [];
  assert.equal(matches.length, 0, `stderr contains 0x{64hex} pattern(s): ${matches.join(', ')}`);
});
