// SPDX-License-Identifier: MIT
// api/cron/health-check.mjs — WKH-77 ecosystem health monitor cron.
//
// SEPARATE from api/cron/gas-balance-check.mjs (WKH-71): that one reads native
// gas balances over RPC; THIS one HTTP-pings each service's health endpoint and
// alerts on down / degraded state.
//
// On each ~4-min tick (cron-job.org):
//   1. Auth via CRON_SECRET (CD — same as the rest of api/cron/*).
//   2. Load service targets from env HEALTH_MONITOR_TARGETS (CD-3).
//   3. For each target: GET its health URL with a ≤5s timeout (CD-6), decide
//      down / degraded / ok, and fire the alert through the shared
//      src/alerts.mjs::sendAlert (CD-1) at the tier severity (AC-2/AC-3).
//   4. ALWAYS respond 200 (CD-2 fail-open) — a timeout/error of one service
//      never breaks the cron or another service's check (AC-7).
//
// `?dryRun=1` (AC-6): fire a synthetic alert per configured target (still auth-
// gated by CRON_SECRET) to verify the end-to-end circuit without a real outage.

import * as log from '../../src/log.mjs';
import { validateCronSecret, CronAuthError } from '../../src/cron-auth.mjs';
import { sendAlert } from '../../src/alerts.mjs';
import {
  checkHealthTargets,
  parseHealthTargets,
  resolveTimeoutMs,
} from '../../src/health-monitor.mjs';

function _json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

// Production probe: GET the health URL, follow redirects (app.wasiai.io serves a
// redirect), hard timeout (CD-6). Resolves { status, json } for ANY HTTP
// response; THROWS on connection error / timeout (AbortError) — exactly the
// contract checkHealthTargets expects. A non-JSON body yields json:null.
async function fetchHealth(url, { timeoutMs }) {
  const resp = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': 'wasiai-health-monitor/1.0' },
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

function _isDryRun(req) {
  try {
    const u = new URL(req.url ?? '', 'http://localhost');
    const v = u.searchParams.get('dryRun');
    return v === '1' || v === 'true';
  } catch {
    return false;
  }
}

export default async function healthCheckHandler(req, res) {
  // 1. Auth.
  try {
    validateCronSecret(req.headers?.authorization ?? '', process.env.CRON_SECRET);
  } catch (e) {
    if (e instanceof CronAuthError) {
      log.warn('mcp.health-cron.unauthorized', { stage: 'verify' });
      _json(res, e.status, {
        error: e.status === 500 ? 'server misconfigured' : 'unauthorized',
      });
      return;
    }
    log.error('mcp.health-cron.error', { stage: 'verify', error: e?.message ?? 'unknown' });
    _json(res, 500, { error: 'internal' });
    return;
  }

  // 2. Config from env (CD-3). No targets → warnOnce + 200 (nothing to monitor
  //    is not an error; fail-open CD-2).
  const targets = parseHealthTargets(process.env.HEALTH_MONITOR_TARGETS);
  if (targets.length === 0) {
    log.warnOnce(
      'health-monitor-no-targets',
      'mcp.health-cron.no-targets',
      { stage: 'config' },
    );
    _json(res, 200, { checked: 0, results: [] });
    return;
  }

  const dryRun = _isDryRun(req);

  // 3. Check every target. checkHealthTargets never throws (CD-2).
  let results = [];
  try {
    results = await checkHealthTargets({
      targets,
      fetchHealth,
      sendAlert,
      webhookUrl: process.env.MCP_ALERT_WEBHOOK_URL,
      mention: process.env.ONCALL_MENTION,
      timeoutMs: resolveTimeoutMs(process.env),
      dryRun,
    });
  } catch (e) {
    // Defensive — the core is designed never to throw, but the cron must stay
    // 200 no matter what (CD-2).
    log.error('mcp.health-cron.error', { stage: 'check', error: e?.message ?? 'unknown' });
    _json(res, 200, { checked: 0, results: [] });
    return;
  }

  const alerts = results.filter((r) => r.severity !== 'ok').length;
  log.info('mcp.health-cron.ok', {
    stage: 'done', checked: results.length, alerts, dryRun,
  });

  // 4. Always 200 (CD-2).
  _json(res, 200, { checked: results.length, alerts, dryRun, results });
}
