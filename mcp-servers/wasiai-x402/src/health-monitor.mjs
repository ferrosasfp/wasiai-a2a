// SPDX-License-Identifier: MIT
// src/health-monitor.mjs — WKH-77 ecosystem health / uptime monitor.
//
// SEPARATE module from gas-monitor.mjs (WKH-71): that one reads native-gas
// balances of signing wallets over RPC; THIS one HTTP-pings each ecosystem
// service's health endpoint and decides down / degraded / ok. Two distinct
// invariants — never mixed.
//
// Design (mirrors gas-monitor.mjs):
//   - Pure, dependency-injected core (`checkHealthTargets`) so the unit suite
//     can drive it with a fake `fetchHealth` + `sendAlert` — no real network.
//   - Config comes ONLY from env (CD-3): the service list via
//     HEALTH_MONITOR_TARGETS (JSON), the per-request timeout via
//     HEALTH_MONITOR_TIMEOUT_MS. No URL / tier / timeout is hardcoded here —
//     only in .env.example as documentation.
//   - Each target is evaluated independently (AC-7 / CD-2): a timeout, network
//     error, or throwing alert for one target NEVER aborts or masks another.
//   - Read-only: the core only issues a GET via the injected `fetchHealth`; it
//     never mutates the monitored service (Scope OUT: no auto-remediation).
//   - Fail-open (CD-2): the core never throws; the cron caller still 200s.
//   - No secrets in the alert body (CD-4): only public labels / URLs / status
//     codes flow to sendAlert, filtered again by alerts.mjs::ALLOWED_BODY_KEYS.

import * as log from './log.mjs';

// Business tier → alert severity (AC-2). P0 = revenue/critical path, P1 =
// important-but-not-revenue, P2 = best-effort.
export const SEVERITY_BY_TIER = {
  P0: 'critical',
  P1: 'warning',
  P2: 'info',
};

const VALID_TIERS = new Set(['P0', 'P1', 'P2']);
// "status"      → expect HTTP 2xx (+ optional healthyField / degradedPath).
// "reachability"→ ANY HTTP response (incl. 404) means alive; only a connection
//                 error / timeout is "down" (AC for x402-mcp: no public health
//                 route, so a 404 must NOT alert).
const VALID_MODES = new Set(['status', 'reachability']);

// CD-6: hard upper bound on each outbound health check so one hung service can
// never block the others inside a tick.
const MAX_TIMEOUT_MS = 5000;
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * @internal — read a dot-path (e.g. "details.redis") out of a plain object.
 * Returns undefined for a missing path or a non-object input. Never throws.
 */
function _getPath(obj, path) {
  if (!obj || typeof obj !== 'object') return undefined;
  let cur = obj;
  for (const part of String(path).split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') {
      return undefined;
    }
    cur = cur[part];
  }
  return cur;
}

/**
 * Parse HEALTH_MONITOR_TARGETS (JSON array). Each valid entry is
 * `{ label, url, tier, mode?, degradedPath?, healthyField?, healthyValue?,
 *    logsUrl? }`. Invalid entries are dropped with a log line (fail-open,
 * AC-7 independence). Deduped by `label`. Returns [] on any parse failure
 * (never throws).
 *
 * @param {string|undefined} raw
 * @returns {Array<object>}
 */
export function parseHealthTargets(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    log.error('mcp.health-monitor.targets-parse-failed', {
      stage: 'config', error: e?.message ?? 'unknown',
    });
    return [];
  }
  if (!Array.isArray(parsed)) {
    log.error('mcp.health-monitor.targets-not-array', { stage: 'config' });
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const { label, url, tier } = entry;
    if (typeof label !== 'string' || label.length === 0) continue;
    if (typeof url !== 'string' || url.length === 0) {
      log.warn('mcp.health-monitor.target-invalid-url', { stage: 'config', label });
      continue;
    }
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      log.warn('mcp.health-monitor.target-invalid-url', { stage: 'config', label });
      continue;
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      log.warn('mcp.health-monitor.target-invalid-url', { stage: 'config', label });
      continue;
    }
    if (typeof tier !== 'string' || !VALID_TIERS.has(tier)) {
      log.warn('mcp.health-monitor.target-invalid-tier', { stage: 'config', label });
      continue;
    }
    if (seen.has(label)) continue;
    seen.add(label);

    const t = {
      label,
      url,
      tier,
      mode: VALID_MODES.has(entry.mode) ? entry.mode : 'status',
    };
    if (typeof entry.degradedPath === 'string' && entry.degradedPath.length > 0) {
      t.degradedPath = entry.degradedPath;
    }
    if (typeof entry.healthyField === 'string' && entry.healthyField.length > 0) {
      t.healthyField = entry.healthyField;
      t.healthyValue = entry.healthyValue;
    }
    if (typeof entry.logsUrl === 'string' && entry.logsUrl.length > 0) {
      t.logsUrl = entry.logsUrl;
    }
    out.push(t);
  }
  return out;
}

/**
 * Resolve the per-request timeout from env. Default 5000, hard-capped at 5000
 * (CD-6). Non-finite / <= 0 → default. Never throws.
 *
 * @param {Record<string,string|undefined>} env
 * @returns {number}
 */
export function resolveTimeoutMs(env) {
  const raw = env?.HEALTH_MONITOR_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(n, MAX_TIMEOUT_MS);
}

/**
 * @internal — evaluate ONE target against a single injected `fetchHealth`
 * probe. `fetchHealth(url, {timeoutMs})` MUST resolve to `{status, json}` for
 * ANY HTTP response received and THROW on a connection error / timeout
 * (AbortError / TimeoutError). Returns a plain outcome; never throws.
 *
 * @returns {{severity: (string|null), reason: string, httpStatus: (number|undefined)}}
 */
async function _evaluateTarget(target, { fetchHealth, timeoutMs }) {
  const tierSeverity = SEVERITY_BY_TIER[target.tier] ?? 'info';

  let res;
  try {
    res = await fetchHealth(target.url, { timeoutMs });
  } catch (e) {
    const isTimeout = e?.name === 'AbortError' || e?.name === 'TimeoutError';
    return {
      severity: tierSeverity,
      reason: isTimeout ? 'health-timeout' : 'health-unreachable',
      httpStatus: undefined,
    };
  }

  const status = res?.status;

  // reachability mode (AC / x402-mcp): the target has no public health route,
  // so an auth-protected 401/404 (or any 2xx/3xx/4xx) means the ORIGIN is alive.
  // BLQ-BAJO-1: a 5xx is NOT "alive" — a crashed origin (Vercel 502/503/504) is
  // exactly the silent outage this HU exists to catch. `status >= 500` → down at
  // the target's tier (same path a normal down target takes); `status < 500`
  // → alive/ok. The network-error / timeout branch above still alerts too.
  if (target.mode === 'reachability') {
    if (typeof status === 'number' && status >= 500) {
      return { severity: tierSeverity, reason: 'health-http-error', httpStatus: status };
    }
    return { severity: null, reason: 'ok', httpStatus: status };
  }

  // status mode: non-2xx / no numeric status → down at the service tier.
  if (typeof status !== 'number' || status < 200 || status >= 300) {
    return { severity: tierSeverity, reason: 'health-http-error', httpStatus: status };
  }

  // 2xx: optional healthyField assertion (e.g. gateway status === "ok").
  if (target.healthyField !== undefined) {
    const actual = res?.json ? res.json[target.healthyField] : undefined;
    if (actual !== target.healthyValue) {
      return { severity: tierSeverity, reason: 'health-unhealthy', httpStatus: status };
    }
  }

  // 2xx: optional degraded-state assertion (AC-3). A truthy degradedPath maps
  // to `warning` regardless of tier — a degraded-but-up P0 is a warning, not a
  // full outage.
  if (target.degradedPath !== undefined) {
    if (_getPath(res?.json, target.degradedPath)) {
      return { severity: 'warning', reason: 'health-degraded', httpStatus: status };
    }
  }

  return { severity: null, reason: 'ok', httpStatus: status };
}

/**
 * @internal — evaluate ONE target end-to-end (probe → decide → alert) and
 * return its result row. NEVER throws (AC-7 / CD-2 isolation): a fetch error,
 * timeout, or a throwing `sendAlert` is caught and folded into the row so it
 * can never abort a sibling target running in parallel.
 */
async function _processTarget(target, {
  fetchHealth, sendAlert, webhookUrl, mention, timeoutMs, dryRun, now,
}) {
  let outcome;
  try {
    outcome = dryRun
      ? {
          severity: SEVERITY_BY_TIER[target.tier] ?? 'info',
          reason: 'health-test-alert',
          httpStatus: undefined,
        }
      : await _evaluateTarget(target, { fetchHealth, timeoutMs });
  } catch (e) {
    // Defensive — _evaluateTarget is designed never to throw, but AC-7
    // isolation must hold even if a future path does. Treat as unreachable.
    log.warn('mcp.health-monitor.check-failed', {
      stage: 'check', label: target.label, error: e?.message ?? 'unknown',
    });
    outcome = {
      severity: SEVERITY_BY_TIER[target.tier] ?? 'info',
      reason: 'health-monitor-error',
      httpStatus: undefined,
    };
  }

  const checkedAt = now();

  if (outcome.severity) {
    log.warn('mcp.health-monitor.alert', {
      stage: 'alert',
      label: target.label,
      severity: outcome.severity,
      reason: outcome.reason,
      httpStatus: outcome.httpStatus,
    });
    // sendAlert is best-effort (CD-1). Wrap defensively so a misbehaving
    // alert client can never abort the remaining targets (AC-7 / CD-2).
    try {
      await sendAlert({
        severity: outcome.severity,
        webhookUrl,
        mention,
        body: {
          severity: outcome.severity,
          event: 'health-check',
          reason: outcome.reason,
          // NIT-2: only `service` — `label` was a duplicate field in the
          // Discord embed (same value). One canonical service identifier.
          service: target.label,
          url: target.url,
          ...(target.logsUrl ? { logsUrl: target.logsUrl } : {}),
          ...(outcome.httpStatus !== undefined
            ? { httpStatus: outcome.httpStatus }
            : {}),
          checkedAt,
        },
      });
    } catch (e) {
      log.warn('mcp.health-monitor.alert-failed', {
        stage: 'alert', label: target.label, error: e?.message ?? 'unknown',
      });
    }
  }

  return {
    label: target.label,
    url: target.url,
    tier: target.tier,
    severity: outcome.severity ?? 'ok',
    reason: outcome.reason,
    httpStatus: outcome.httpStatus,
    checkedAt,
  };
}

/**
 * Check every configured target, decide down / degraded / ok, and fire the
 * alert through the injected `sendAlert` (reusing src/alerts.mjs in
 * production — CD-1).
 *
 * NEVER throws. Each target is isolated (AC-7 / CD-2): a fetch error, timeout,
 * or a throwing `sendAlert` for one target is recorded and skipped without
 * affecting the others; the cron caller still responds 200.
 *
 * BLQ-BAJO-2: targets are probed CONCURRENTLY via `Promise.allSettled`, so a
 * total outage where every target times out bounds the tick to ~one timeout
 * (max) instead of N×timeout. A rejected promise never aborts the set, and each
 * `_processTarget` is self-isolating, so the fail-open guarantee (cron always
 * 200) holds. Result order matches the input `targets` order.
 *
 * `dryRun` (AC-6): synthesize a down-outcome per target at its tier severity
 * (reason `health-test-alert`) WITHOUT any real probe, to exercise the whole
 * alert circuit end-to-end.
 *
 * @param {object} deps
 * @param {Array<object>} deps.targets
 * @param {(url:string, opts:{timeoutMs:number})=>Promise<{status:number,json:object|null}>} deps.fetchHealth
 * @param {(args:object)=>Promise<unknown>} deps.sendAlert
 * @param {string|undefined} deps.webhookUrl
 * @param {string|undefined} [deps.mention]
 * @param {number} [deps.timeoutMs]
 * @param {boolean} [deps.dryRun]
 * @param {()=>string} [deps.now]
 * @returns {Promise<Array<object>>} per-target results
 */
export async function checkHealthTargets({
  targets,
  fetchHealth,
  sendAlert,
  webhookUrl,
  mention,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  dryRun = false,
  now = () => new Date().toISOString(),
}) {
  const settled = await Promise.allSettled(
    targets.map((target) => _processTarget(target, {
      fetchHealth, sendAlert, webhookUrl, mention, timeoutMs, dryRun, now,
    })),
  );

  const results = [];
  for (let i = 0; i < settled.length; i += 1) {
    const s = settled[i];
    if (s.status === 'fulfilled') {
      results.push(s.value);
      continue;
    }
    // Defensive — _processTarget is designed never to throw, but a rejected
    // promise must still yield an isolated row (AC-7 / CD-2), never abort.
    const target = targets[i];
    log.warn('mcp.health-monitor.check-failed', {
      stage: 'check', label: target.label, error: s.reason?.message ?? 'unknown',
    });
    results.push({
      label: target.label,
      url: target.url,
      tier: target.tier,
      severity: SEVERITY_BY_TIER[target.tier] ?? 'info',
      reason: 'health-monitor-error',
      httpStatus: undefined,
      checkedAt: now(),
    });
  }
  return results;
}
