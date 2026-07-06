// SPDX-License-Identifier: MIT
// src/synthetic-payment-monitor.mjs — WKH-74 capa A: free synthetic
// payment-path probe ($0 always).
//
// SEPARATE concern from health-monitor.mjs (WKH-77): that one HTTP-pings a
// /health route and decides up/down; THIS one exercises the REAL payment path
// by POSTing /orchestrate with a valid body and NO auth/pay header, asserting
// the gateway answers the exact x402 402 challenge it should. It catches a
// silent money-path break (wrong payTo/asset/network, x402 layer down, a 200
// where a 402 is expected) that a green /health would miss — the 2026-07-05
// Chaski-$0 gap.
//
// Design (mirrors gas-monitor.mjs / health-monitor.mjs):
//   - Pure, dependency-injected core (`checkSyntheticPayment`) so the unit suite
//     drives it with a fake `fetchProbe` + `sendAlert` — no real network.
//   - Config comes ONLY from env (CD-6): the probe URL, the probe body and the
//     EXPECTED payTo/asset/network. Nothing is hardcoded in code — a mismatch is
//     exactly the drift we want to catch.
//   - $0 ALWAYS (CD-4): the core never builds or forwards a payment header. The
//     injected `fetchProbe` MUST send a "naked" request (no x-a2a-key /
//     Authorization / x-payment / payment-signature) — enforced in the cron and
//     asserted by the tests.
//   - Fail-open (CD-3): the core never throws; the cron caller still 200s. A
//     broken path is surfaced as a `critical` alert, not an exception.
//   - No secrets in the alert body (CD-7): only whitelisted public identifiers
//     (severity, event, reason, service, url, httpStatus, checkedAt) flow to
//     sendAlert, filtered again by alerts.mjs::ALLOWED_BODY_KEYS.

import * as log from './log.mjs';

// AC-2: every capa-A failure emits this single reason (a broken path is a broken
// path — the specific cause is logged, not alerted, to keep the on-call signal
// crisp and the alert body inside the CD-7 whitelist).
export const SYNTH_PAYMENT_BROKEN_REASON = 'synthetic-payment-path-broken';

// The synthetic probe MUST get exactly this HTTP status (an x402 challenge).
const EXPECTED_STATUS = 402;

// Canonical service label used in the alert body / logs (a public identifier).
const DEFAULT_SERVICE = 'gateway-a2a-orchestrate';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Resolve the probe URL from env. Returns the trimmed https(s) URL or null when
 * absent / unparseable (→ the cron no-ops, warnOnce + 200). Never throws.
 *
 * @param {Record<string,string|undefined>} env
 * @returns {string|null}
 */
export function resolveProbeUrl(env) {
  const raw = env?.SYNTH_ORCHESTRATE_URL;
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const url = raw.trim();
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    log.warn('mcp.synth-payment.invalid-url', { stage: 'config' });
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    log.warn('mcp.synth-payment.invalid-url', { stage: 'config' });
    return null;
  }
  return url;
}

/**
 * Resolve the minimal valid /orchestrate probe body from env. `goal` must be a
 * non-empty string (defaulted), `budget` a finite number > 0 (defaulted). The
 * body only needs to pass the /orchestrate schema so the request reaches the
 * x402 layer and 402s BEFORE any business logic. Never throws.
 *
 * @param {Record<string,string|undefined>} env
 * @returns {{goal:string, budget:number}}
 */
export function resolveProbeBody(env) {
  const rawGoal = env?.SYNTH_PROBE_GOAL;
  const goal =
    typeof rawGoal === 'string' && rawGoal.trim().length > 0
      ? rawGoal.trim()
      : 'synthetic monitoring probe (expect 402, no payment sent)';

  const budgetNum = Number(env?.SYNTH_PROBE_BUDGET);
  const budget = Number.isFinite(budgetNum) && budgetNum > 0 ? budgetNum : 0.01;

  return { goal, budget };
}

/**
 * Resolve the EXPECTED x402 challenge values from env (CD-6). Returns null when
 * any of the three is missing/blank (→ the cron no-ops: without an expectation
 * there is nothing to assert). `payTo`/`asset` are validated as 0x addresses;
 * `network` is any non-empty CAIP-2 string. Never throws.
 *
 * @param {Record<string,string|undefined>} env
 * @returns {{payTo:string, asset:string, network:string}|null}
 */
export function resolveExpected(env) {
  const payTo = (env?.SYNTH_EXPECT_PAYTO ?? '').trim();
  const asset = (env?.SYNTH_EXPECT_ASSET ?? '').trim();
  const network = (env?.SYNTH_EXPECT_NETWORK ?? '').trim();
  if (!payTo || !asset || !network) return null;
  if (!ADDRESS_RE.test(payTo)) {
    log.warn('mcp.synth-payment.invalid-expected', { stage: 'config', field: 'payTo' });
    return null;
  }
  if (!ADDRESS_RE.test(asset)) {
    log.warn('mcp.synth-payment.invalid-expected', { stage: 'config', field: 'asset' });
    return null;
  }
  return { payTo, asset, network };
}

/**
 * @internal — decide whether the probe response matches the expected 402 x402
 * challenge. Returns `{ ok:true }` when everything matches, else
 * `{ ok:false, detail }` with a short machine cause (logged, NOT alerted — the
 * alert reason is the fixed SYNTH_PAYMENT_BROKEN_REASON). Never throws.
 *
 * @param {number|undefined} status
 * @param {unknown} json
 * @param {{payTo:string, asset:string, network:string}} expected
 */
export function evaluateProbe(status, json, expected) {
  if (status !== EXPECTED_STATUS) {
    return { ok: false, detail: 'unexpected-status' };
  }
  const accepts = json && typeof json === 'object' ? json.accepts : undefined;
  if (!Array.isArray(accepts) || accepts.length === 0) {
    return { ok: false, detail: 'missing-accepts' };
  }
  const a0 = accepts[0];
  if (!a0 || typeof a0 !== 'object') {
    return { ok: false, detail: 'missing-accepts' };
  }
  if (typeof a0.payTo !== 'string' || a0.payTo.toLowerCase() !== expected.payTo.toLowerCase()) {
    return { ok: false, detail: 'payto-mismatch' };
  }
  if (typeof a0.asset !== 'string' || a0.asset.toLowerCase() !== expected.asset.toLowerCase()) {
    return { ok: false, detail: 'asset-mismatch' };
  }
  if (typeof a0.network !== 'string' || a0.network.toLowerCase() !== expected.network.toLowerCase()) {
    return { ok: false, detail: 'network-mismatch' };
  }
  return { ok: true };
}

/**
 * Run ONE free synthetic payment-path probe end-to-end (probe → assert → alert).
 * NEVER throws (CD-3 fail-open): a network error / timeout of the probe is a
 * broken path (critical alert), and a throwing `sendAlert` is caught so the cron
 * caller still 200s.
 *
 * The injected `fetchProbe(url, {body, timeoutMs})` MUST:
 *   - POST `body` as JSON with NO auth/pay header of any kind (CD-4 — $0), and
 *   - resolve to `{status, json}` for ANY HTTP response, THROWING only on a
 *     connection error / timeout (AbortError / TimeoutError).
 *
 * @param {object} deps
 * @param {string} deps.url
 * @param {{goal:string, budget:number}} deps.body
 * @param {{payTo:string, asset:string, network:string}} deps.expected
 * @param {(url:string, opts:{body:object, timeoutMs:number})=>Promise<{status:number, json:unknown}>} deps.fetchProbe
 * @param {(args:object)=>Promise<unknown>} deps.sendAlert
 * @param {string|undefined} deps.webhookUrl
 * @param {string|undefined} [deps.mention]
 * @param {number} [deps.timeoutMs]
 * @param {string} [deps.service]
 * @param {()=>string} [deps.now]
 * @returns {Promise<{severity:('critical'|null), reason:string, detail:string, httpStatus:(number|undefined), checkedAt:string}>}
 */
export async function checkSyntheticPayment({
  url,
  body,
  expected,
  fetchProbe,
  sendAlert,
  webhookUrl,
  mention,
  timeoutMs = 10000,
  service = DEFAULT_SERVICE,
  now = () => new Date().toISOString(),
}) {
  let severity = null;
  let detail = 'ok';
  let httpStatus;

  try {
    const res = await fetchProbe(url, { body, timeoutMs });
    httpStatus = res?.status;
    const verdict = evaluateProbe(httpStatus, res?.json, expected);
    if (!verdict.ok) {
      severity = 'critical';
      detail = verdict.detail;
    }
  } catch (e) {
    // CD-3: a network error / timeout is itself a broken path (AC-2), surfaced
    // as an alert — never a thrown exception.
    const isTimeout = e?.name === 'AbortError' || e?.name === 'TimeoutError';
    severity = 'critical';
    detail = isTimeout ? 'probe-timeout' : 'probe-unreachable';
    httpStatus = undefined;
  }

  const checkedAt = now();

  if (severity) {
    log.warn('mcp.synth-payment.broken', {
      stage: 'alert', service, detail, httpStatus,
    });
    // sendAlert is best-effort (CD-1). Wrap defensively so a misbehaving alert
    // client can never bubble out of the fail-open core (CD-3).
    try {
      await sendAlert({
        severity,
        webhookUrl,
        mention,
        body: {
          severity,
          event: 'synthetic-payment-check',
          // AC-2: fixed reason for every capa-A failure.
          reason: SYNTH_PAYMENT_BROKEN_REASON,
          service,
          url,
          ...(httpStatus !== undefined ? { httpStatus } : {}),
          checkedAt,
        },
      });
    } catch (e) {
      log.warn('mcp.synth-payment.alert-failed', {
        stage: 'alert', service, error: e?.message ?? 'unknown',
      });
    }
  } else {
    log.info('mcp.synth-payment.ok', { stage: 'done', service, httpStatus });
  }

  return { severity, reason: SYNTH_PAYMENT_BROKEN_REASON, detail, httpStatus, checkedAt };
}
