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
//
// WKH-90 — Discord-aware payload formatting:
//   When the host of webhookUrl is `discord.com` or `discordapp.com`, the
//   POST body is reshaped to Discord's `{username, embeds[]}` contract.
//   Any other host (Slack, Datadog, custom) keeps the raw-JSON path.

import * as log from './log.mjs';

const ALLOWED_BODY_KEYS = new Set([
  'severity',
  'chain',
  'operator',
  'balanceUsdc',
  'threshold',
  'checkedAt',
  'blockNumber',
  // WKH-75 (CD-11): rotation-alert identifiers — discrete identifiers and
  // timestamps that never carry secrets. PROHIBITED to add token/bearer/
  // value/signature/privateKey-bearing keys here.
  'event',
  'reason',
  'rotatedAt',
]);

// WKH-90 DT-2: exact host match — no startsWith, no regex, no subdomain
// inference. Only these two hosts are reshaped.
const DISCORD_HOSTS = new Set(['discord.com', 'discordapp.com']);

// WKH-90 AC-2: severity → embed color map.
//   critical → 0xE74C3C (red)
//   warning  → 0xF1C40F (yellow)
//   info     → 0x2ECC71 (green)
const DISCORD_COLOR_BY_SEVERITY = {
  critical: 15158332,
  warning: 15844367,
  info: 3066993,
};
// WKH-90 DT-4: unknown severity falls back to info color (never throws).
const DISCORD_COLOR_DEFAULT = 3066993;

// WKH-90 CD-WKH90-3: hardcoded, NOT env-configurable in this HU.
const DISCORD_USERNAME = 'wasiai-alerts';

// Keys that map to special embed slots and therefore are NOT duplicated as
// fields. Everything else from the sanitized body becomes a `{name, value,
// inline}` field entry.
const DISCORD_RESERVED_KEYS = new Set([
  'severity',
  'event',
  'reason',
  'rotatedAt',
  'checkedAt',
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
 * Build a Discord-webhook-compatible payload from a sanitized alert body.
 *
 * Shape (WKH-90 DT-3):
 *   {
 *     username: "wasiai-alerts",
 *     embeds: [{
 *       title: "[<severity>] <event>" or "[<severity>]",
 *       description?: body.reason,
 *       color: <number per severity>,
 *       timestamp?: body.rotatedAt ?? body.checkedAt,
 *       fields: [{name, value: String(val), inline: true}, ...]
 *     }]
 *   }
 *
 * NEVER throws. Inputs are already sanitized by sanitizeAlertBody().
 *
 * @param {{severity?: string, body: Record<string, unknown>}} args
 * @returns {{username: string, embeds: Array<object>}}
 */
export function formatForDiscord({ severity, body }) {
  const safeBody = body && typeof body === 'object' ? body : {};
  const sev = typeof severity === 'string' ? severity : '';
  const color = Object.prototype.hasOwnProperty.call(
    DISCORD_COLOR_BY_SEVERITY,
    sev,
  )
    ? DISCORD_COLOR_BY_SEVERITY[sev]
    : DISCORD_COLOR_DEFAULT;

  const sevLabel = sev || 'unknown';
  const event = typeof safeBody.event === 'string' ? safeBody.event : '';
  const title = event ? `[${sevLabel}] ${event}` : `[${sevLabel}]`;

  const embed = {
    title,
    color,
  };

  if (typeof safeBody.reason === 'string' && safeBody.reason.length > 0) {
    embed.description = safeBody.reason;
  }

  // Prefer rotatedAt (rotation events) over checkedAt (balance-check events).
  const ts =
    typeof safeBody.rotatedAt === 'string' && safeBody.rotatedAt.length > 0
      ? safeBody.rotatedAt
      : typeof safeBody.checkedAt === 'string' && safeBody.checkedAt.length > 0
        ? safeBody.checkedAt
        : undefined;
  if (ts) embed.timestamp = ts;

  const fields = [];
  for (const [k, v] of Object.entries(safeBody)) {
    if (DISCORD_RESERVED_KEYS.has(k)) continue;
    if (v === undefined || v === null) continue;
    fields.push({ name: k, value: String(v), inline: true });
  }
  embed.fields = fields;

  return {
    username: DISCORD_USERNAME,
    embeds: [embed],
  };
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

  const sanitized = sanitizeAlertBody({ severity, ...body });

  // WKH-90: detect Discord host and reshape payload. CD-WKH90-2: any URL
  // parse failure falls back to raw-JSON path silently (no throw, no log of
  // the URL itself per CD-9).
  let isDiscord = false;
  try {
    const parsed = new URL(webhookUrl);
    isDiscord = DISCORD_HOSTS.has(parsed.host);
  } catch {
    isDiscord = false;
  }

  const payload = isDiscord
    ? formatForDiscord({ severity, body: sanitized })
    : sanitized;

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
