// alerts.mjs — Critical-balance webhook sender (WKH-66 W3.1).
//
// Why this module exists:
//   When the cron-job balance-check sees operator USDC < threshold we POST a
//   single JSON event to MCP_ALERT_WEBHOOK_URL (Slack-incoming / Discord /
//   Datadog event compatible). It MUST:
//     - timeout in 5s (CD-5)
//     - never retry (CD-5)
//     - never throw (the cron caller treats `sendAlert` as best-effort)
//     - whitelist the body (CD-12) so PK / bearer / signatures cannot leak
//       even if a future caller mistakenly passes the whole envelope
//
// Body whitelist (CD-12, T-AL-02):
//   severity, chain, operator, balanceUsdc, threshold, checkedAt, blockNumber.
//   Anything else is silently dropped.
//
// Logs (CD-17 — never put `event:` in fields):
//   warnOnce('alert-webhook-not-configured', 'mcp.alert.no-webhook-configured', {})
//   warn('mcp.alert.webhook-failed', { stage:'alert', status?, error? })
//   info('mcp.alert.sent', { stage:'alert', status })

import * as log from './log.mjs';

const ALLOWED_BODY_KEYS = new Set([
  'severity',
  'chain',
  'operator',
  'balanceUsdc',
  'threshold',
  'checkedAt',
  'blockNumber',
]);

export function sanitizeAlertBody(body) {
  if (!body || typeof body !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (ALLOWED_BODY_KEYS.has(k)) out[k] = v;
  }
  return out;
}

/**
 * POST a critical-balance alert to webhookUrl. Never throws.
 *
 * @returns {{sent: boolean, reason?: string, status?: number}}
 */
export async function sendAlert({ severity, body, webhookUrl, timeoutMs = 5000 }) {
  if (!webhookUrl) {
    log.warnOnce(
      'alert-webhook-not-configured',
      'mcp.alert.no-webhook-configured',
      {},
    );
    return { sent: false, reason: 'webhook not configured' };
  }

  const payload = sanitizeAlertBody({ severity, ...body });

  let resp;
  try {
    resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      // CD-18: never follow a redirect on a webhook (could leak the body to
      // an unintended host).
      redirect: 'error',
      // CD-5: hard timeout. AbortSignal.timeout is the canonical Node 18+
      // primitive. NO retries.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // Includes AbortError (timeout) and network failures. Log + return.
    log.warn('mcp.alert.webhook-failed', {
      stage: 'alert',
      // We log the error class only, not the URL (could include token).
      error: e?.name ?? e?.message ?? 'unknown',
    });
    return { sent: false, reason: 'webhook fetch failed' };
  }

  if (!resp.ok) {
    log.warn('mcp.alert.webhook-failed', {
      stage: 'alert',
      status: resp.status,
    });
    return { sent: false, reason: `webhook status ${resp.status}`, status: resp.status };
  }

  log.info('mcp.alert.sent', { stage: 'alert', status: resp.status });
  return { sent: true, status: resp.status };
}
