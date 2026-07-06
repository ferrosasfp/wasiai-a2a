// SPDX-License-Identifier: MIT
// api/cron/synthetic-payment-check.mjs — WKH-74 capa A: free synthetic
// payment-path probe cron ($0 always).
//
// SEPARATE from the health/gas crons: those ping /health or read balances; THIS
// one exercises the REAL payment path by POSTing /orchestrate with a valid body
// and NO auth/pay header, asserting the exact x402 402 challenge. It catches a
// silent money-path break a green /health would miss (2026-07-05 Chaski-$0 gap).
//
// On each ~15-min tick (cron-job.org):
//   1. Auth via CRON_SECRET (CD-2).
//   2. Load probe URL + body + EXPECTED payTo/asset/network from env (CD-6). Any
//      missing config → warnOnce + 200 (nothing to probe is not an error).
//   3. Fire ONE naked probe (CD-4: no x-a2a-key / Authorization / x-payment /
//      payment-signature header) and, if the response is not the expected 402
//      challenge, alert critical via the shared src/alerts.mjs::sendAlert
//      (CD-1, reason 'synthetic-payment-path-broken').
//   4. ALWAYS respond 200 (CD-3 fail-open) — a probe error never breaks the cron.

import * as log from '../../src/log.mjs';
import { validateCronSecret, CronAuthError } from '../../src/cron-auth.mjs';
import { sendAlert } from '../../src/alerts.mjs';
import {
  checkSyntheticPayment,
  resolveExpected,
  resolveProbeBody,
  resolveProbeUrl,
} from '../../src/synthetic-payment-monitor.mjs';

function _json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function _resolveTimeoutMs(env) {
  const n = Number(env?.SYNTH_PROBE_TIMEOUT_MS);
  if (!Number.isFinite(n) || n <= 0) return 10000;
  // Hard cap: the 402 challenge is built synchronously; a slow response IS the
  // signal. Cap at 15s so one hung probe never stalls the tick.
  return Math.min(n, 15000);
}

// CD-4: the "naked" probe. POSTs the body as JSON with ONLY content-type +
// user-agent — NO x-a2a-key, Authorization, x-payment or payment-signature.
// Resolves { status, json } for ANY HTTP response; THROWS on connection error /
// timeout (AbortError) — exactly the contract checkSyntheticPayment expects.
async function fetchProbe(url, { body, timeoutMs }) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'wasiai-synthetic-monitor/1.0',
    },
    body: JSON.stringify(body),
    // Redirect hardening (anti-SSRF): never follow a redirect on a payment probe.
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json = null;
  try {
    const text = await resp.text();
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: resp.status, json };
}

export default async function syntheticPaymentCheckHandler(req, res) {
  // 1. Auth.
  try {
    validateCronSecret(req.headers?.authorization ?? '', process.env.CRON_SECRET);
  } catch (e) {
    if (e instanceof CronAuthError) {
      log.warn('mcp.synth-payment-cron.unauthorized', { stage: 'verify' });
      _json(res, e.status, {
        error: e.status === 500 ? 'server misconfigured' : 'unauthorized',
      });
      return;
    }
    log.error('mcp.synth-payment-cron.error', { stage: 'verify', error: e?.message ?? 'unknown' });
    _json(res, 500, { error: 'internal' });
    return;
  }

  // 2. Config from env (CD-6). Missing URL or expectation → no-op (fail-open).
  const url = resolveProbeUrl(process.env);
  const expected = resolveExpected(process.env);
  if (!url || !expected) {
    log.warnOnce(
      'synth-payment-not-configured',
      'mcp.synth-payment-cron.not-configured',
      { stage: 'config', hasUrl: Boolean(url), hasExpected: Boolean(expected) },
    );
    _json(res, 200, { checked: 0 });
    return;
  }

  const body = resolveProbeBody(process.env);

  // 3. One probe. checkSyntheticPayment never throws (CD-3).
  let result;
  try {
    result = await checkSyntheticPayment({
      url,
      body,
      expected,
      fetchProbe,
      sendAlert,
      webhookUrl: process.env.MCP_ALERT_WEBHOOK_URL,
      mention: process.env.ONCALL_MENTION,
      timeoutMs: _resolveTimeoutMs(process.env),
    });
  } catch (e) {
    // Defensive — the core is designed never to throw, but the cron must stay
    // 200 no matter what (CD-3).
    log.error('mcp.synth-payment-cron.error', { stage: 'check', error: e?.message ?? 'unknown' });
    _json(res, 200, { checked: 0 });
    return;
  }

  const alerts = result.severity ? 1 : 0;
  log.info('mcp.synth-payment-cron.ok', { stage: 'done', checked: 1, alerts });

  // 4. Always 200 (CD-3).
  _json(res, 200, {
    checked: 1,
    alerts,
    severity: result.severity ?? 'ok',
    detail: result.detail,
    httpStatus: result.httpStatus,
  });
}
