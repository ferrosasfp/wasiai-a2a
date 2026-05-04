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

// WKH-91 AC-1/2 + CD-WKH91-1: Discord embed length limits.
//   title       → 256 chars max
//   description → 4096 chars max
// When the input exceeds the limit, `_truncate` slices to (max - 1) and
// appends U+2026 ('…'), producing a final string of exactly `max` chars.
const TITLE_MAX = 256;
const DESCRIPTION_MAX = 4096;

// WKH-91 AC-6: named constant replaces the inline 'unknown' magic string
// previously at line :114. Used when severity is absent or non-string.
const DEFAULT_SEVERITY_LABEL = 'unknown';

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

/**
 * @internal
 * Truncate a string to `max` chars, appending U+2026 ('…') when sliced.
 * Returns the input untouched if not a string or already within limit.
 * Resulting string length equals `max` exactly when truncation happens
 * (CD-WKH91-1: ellipsis at the very end via `slice(0, max - 1) + '…'`).
 */
function _truncate(s, max) {
  if (typeof s !== 'string') return s;
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/**
 * @internal
 * Return the first candidate that is neither undefined, null, nor empty
 * string. Returns `undefined` if none qualify. Used to resolve the embed
 * timestamp from a priority list (rotatedAt > checkedAt) without nested
 * ternaries (WKH-91 AC-7).
 */
function _pickFirstNonEmpty(...candidates) {
  for (const c of candidates) {
    if (c !== undefined && c !== null && c !== '') return c;
  }
  return undefined;
}

export function sanitizeAlertBody(body) {
  if (!body || typeof body !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (ALLOWED_BODY_KEYS.has(k)) out[k] = v;
  }
  return out;
}

/**
 * @internal
 * Build a Discord-webhook-compatible payload from a sanitized alert body.
 * NOT for external consumers — use `sendAlert()` instead. Exposed only so
 * the unit suite can assert the embed shape directly (T-AL-DISC-07).
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
 * Title and description are truncated to Discord's hard limits (256 / 4096)
 * with a trailing '…' (WKH-91 AC-1/2).
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

  const sevLabel = sev || DEFAULT_SEVERITY_LABEL;
  const event = typeof safeBody.event === 'string' ? safeBody.event : '';
  const rawTitle = event ? `[${sevLabel}] ${event}` : `[${sevLabel}]`;

  const embed = {
    title: _truncate(rawTitle, TITLE_MAX),
    color,
  };

  if (typeof safeBody.reason === 'string' && safeBody.reason.length > 0) {
    embed.description = _truncate(safeBody.reason, DESCRIPTION_MAX);
  }

  // Prefer rotatedAt (rotation events) over checkedAt (balance-check events).
  // WKH-91 AC-7: nested ternary replaced with `_pickFirstNonEmpty` helper.
  const ts = _pickFirstNonEmpty(
    typeof safeBody.rotatedAt === 'string' ? safeBody.rotatedAt : '',
    typeof safeBody.checkedAt === 'string' ? safeBody.checkedAt : '',
  );
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

  // WKH-91 MNR-CR-2 refactor: sanitize the body alone; severity is carried
  // as a separate argument and re-attached in the raw-JSON path. This avoids
  // splatting `body` into a synthetic envelope only to filter it back out,
  // and keeps the contract of `sanitizeAlertBody` to "one body in, one body
  // out". The `severity` key is in `ALLOWED_BODY_KEYS` so the raw shape is
  // unchanged byte-for-byte (T-AL-02 / T-AL-DISC-05 still pass).
  const sanitized = sanitizeAlertBody(body);

  // WKH-90: detect Discord host and reshape payload. CD-WKH90-2: any URL
  // parse failure falls back to raw-JSON path silently (no throw, no log of
  // the URL itself per CD-9).
  // WKH-91 AC-3 / CD-WKH91-2: use `parsed.hostname` (port-stripped, already
  // lowercased by URL) so a non-default port like
  // `https://discord.com:8080/...` is still detected as a Discord host.
  let isDiscord = false;
  try {
    const parsed = new URL(webhookUrl);
    isDiscord = DISCORD_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    isDiscord = false;
  }

  const payload = isDiscord
    ? formatForDiscord({ severity, body: sanitized })
    : { ...(severity !== undefined ? { severity } : {}), ...sanitized };

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
