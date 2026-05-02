// SPDX-License-Identifier: MIT
// api/cron/invalidate-prev-bearer.mjs — Vercel serverless cron (WKH-75 W3).
//
// Runs after the rotation overlap window expires (~25h after each rotate).
// Reads the KV snapshot left by rotateBearer (key 'last-bearer-rotation') and,
// if its `expiresAt` is in the past, deletes the MCP_BEARER_TOKEN_PREV env so
// stale tokens cannot be replayed. Idempotent — running twice in a row is a
// no-op.
//
// Flow:
//   1. Auth via CRON_SECRET (CD-4).
//   2. Verify VERCEL_TOKEN + VERCEL_PROJECT_ID are configured (else 500).
//   3. KV.get('last-bearer-rotation'):
//        - missing  → 200 {ok:true, skipped:true, reason:'no rotation snapshot'}.
//        - expiresAt > now → 200 {ok:true, skipped:true, reason:'overlap window still active'}.
//        - expiresAt <= now → invalidate.
//   4. Invalidate: listEnvs → find MCP_BEARER_TOKEN_PREV → deleteEnv +
//      triggerRedeploy (best-effort). 200 {ok:true, invalidatedAt} on success.
//
// Auto-blindaje guards:
//   - CD-14 (WKH-66): Date.parse on a missing/non-string field returns NaN;
//     `NaN <= Date.now()` is always false but `NaN > Date.now()` is also
//     false, so a NaN expiresAt would trigger the *invalidate* branch on the
//     skip check alone. We refuse to invalidate unless `expiresAt` parses to
//     a finite timestamp.
//   - CD-15 (WKH-67): JSON.parse on KV-stored payload could surface a
//     prototype-pollution attempt (`{"__proto__": {...}}`). We read fields
//     via `Object.prototype.hasOwnProperty.call` to make sure inherited
//     properties are NOT honored.
//
// CDs touched:
//   CD-1 no edits to handlers/sign/config/log/url-validator.
//   CD-4 timing-safe auth; missing CRON_SECRET → 500.
//   CD-5 timeouts inherited from src/vercel-env.mjs (10s per Vercel call).
//   CD-9 NEVER log MCP_BEARER_TOKEN / VERCEL_TOKEN.
//   CD-10 Express-style (req, res); NO Edge.
//   CD-13 clearTimeout abort (heredado).
//   CD-14 parseFloat NaN guard (auto-blindaje WKH-66).
//   CD-15 prototype pollution guard on KV-parsed object (auto-blindaje WKH-67).
//   CD-16 NO `event:` inside log fields.

import * as log from '../../src/log.mjs';
import { validateCronSecret, CronAuthError } from '../../src/cron-auth.mjs';
import { listEnvs, deleteEnv, triggerRedeploy } from '../../src/vercel-env.mjs';
import { getKvClient } from '../../src/kv-client.mjs';

const KV_KEY = 'last-bearer-rotation';

function _json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

// CD-15: read a string field by own-property only, refuse inherited / prototype.
function _readOwnString(obj, field) {
  if (!obj || typeof obj !== 'object') return null;
  if (!Object.prototype.hasOwnProperty.call(obj, field)) return null;
  const v = obj[field];
  return typeof v === 'string' ? v : null;
}

export default async function invalidatePrevBearerHandler(req, res) {
  // 1. Auth.
  try {
    validateCronSecret(req.headers?.authorization ?? '', process.env.CRON_SECRET);
  } catch (e) {
    if (e instanceof CronAuthError) {
      log.warn('mcp.cron.unauthorized', { stage: 'verify' });
      _json(res, e.status, { error: e.status === 500 ? 'server misconfigured' : 'unauthorized' });
      return;
    }
    log.error('mcp.cron.invalidate-prev-bearer-error', {
      stage: 'verify', error: e?.name ?? 'unknown',
    });
    _json(res, 500, { error: 'internal' });
    return;
  }

  // 2. Server-config gate.
  const vercelToken = process.env.VERCEL_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  const teamId = process.env.VERCEL_TEAM_ID;
  if (!vercelToken || !projectId) {
    log.error('mcp.cron.invalidate-prev-bearer-error', {
      stage: 'config',
      missing: !vercelToken && !projectId
        ? 'VERCEL_TOKEN+VERCEL_PROJECT_ID'
        : (!vercelToken ? 'VERCEL_TOKEN' : 'VERCEL_PROJECT_ID'),
    });
    _json(res, 500, { error: 'server misconfigured' });
    return;
  }

  // 3. KV check — read the last rotation snapshot.
  const kv = getKvClient();
  if (!kv) {
    log.warn('mcp.cron.invalidate-prev-bearer.no-kv', { stage: 'kv-read' });
    _json(res, 200, { ok: true, skipped: true, reason: 'kv not configured' });
    return;
  }

  let raw;
  try {
    raw = await kv.get(KV_KEY);
  } catch (err) {
    log.warn('mcp.cron.invalidate-prev-bearer.kv-read-failed', {
      stage: 'kv-read', error: err?.name ?? 'unknown',
    });
    // Best-effort: if KV is down we cannot know whether the overlap window has
    // expired. Refuse to invalidate (fail-closed) to avoid breaking active
    // bearers mid-rotation. 200 with skipped=true keeps cron-job.org green.
    _json(res, 200, { ok: true, skipped: true, reason: 'kv read failed' });
    return;
  }

  if (raw === null || raw === undefined) {
    log.info('mcp.cron.invalidate-prev-bearer.skipped', {
      stage: 'kv-read', reason: 'no-snapshot',
    });
    _json(res, 200, { ok: true, skipped: true, reason: 'no rotation snapshot' });
    return;
  }

  // KV may return either a string (we wrote JSON.stringify) or already an
  // object (some clients auto-parse). Handle both.
  let snapshot;
  if (typeof raw === 'string') {
    try {
      snapshot = JSON.parse(raw);
    } catch {
      log.warn('mcp.cron.invalidate-prev-bearer.snapshot-parse-failed', {
        stage: 'kv-parse',
      });
      _json(res, 200, { ok: true, skipped: true, reason: 'snapshot parse failed' });
      return;
    }
  } else if (typeof raw === 'object') {
    snapshot = raw;
  } else {
    _json(res, 200, { ok: true, skipped: true, reason: 'snapshot wrong type' });
    return;
  }

  // CD-15: own-property string read. Inherited / prototype-polluted values are
  // ignored (treated as missing → skip).
  const expiresAtIso = _readOwnString(snapshot, 'expiresAt');
  if (!expiresAtIso) {
    log.warn('mcp.cron.invalidate-prev-bearer.snapshot-missing-expires', {
      stage: 'kv-parse',
    });
    _json(res, 200, { ok: true, skipped: true, reason: 'snapshot missing expiresAt' });
    return;
  }

  // CD-14: refuse to act on NaN. Date.parse returns NaN for unparseable input.
  const expiresMs = Date.parse(expiresAtIso);
  if (!Number.isFinite(expiresMs)) {
    log.warn('mcp.cron.invalidate-prev-bearer.snapshot-bad-expires', {
      stage: 'kv-parse',
    });
    _json(res, 200, { ok: true, skipped: true, reason: 'snapshot expiresAt unparseable' });
    return;
  }

  const now = Date.now();
  if (expiresMs > now) {
    log.info('mcp.cron.invalidate-prev-bearer.skipped', {
      stage: 'window', reason: 'overlap-active',
    });
    _json(res, 200, { ok: true, skipped: true, reason: 'overlap window still active' });
    return;
  }

  // 4. Invalidate. Find PREV env, delete it, trigger redeploy.
  let envs;
  try {
    envs = await listEnvs({ projectId, token: vercelToken, teamId });
  } catch (err) {
    log.error('mcp.cron.invalidate-prev-bearer-error', {
      stage: 'list-envs', status: err?.status ?? 0,
    });
    _json(res, 500, { ok: false, error: 'list envs failed' });
    return;
  }

  const prevRecord = envs.find(
    (e) =>
      e.key === 'MCP_BEARER_TOKEN_PREV' &&
      Array.isArray(e.target) &&
      e.target.includes('production'),
  );

  if (!prevRecord || !prevRecord.id) {
    // Nothing to invalidate. Idempotent success.
    log.info('mcp.cron.invalidate-prev-bearer.skipped', {
      stage: 'env-lookup', reason: 'no-prev-env',
    });
    _json(res, 200, { ok: true, skipped: true, reason: 'no PREV env to invalidate' });
    return;
  }

  try {
    await deleteEnv({
      projectId, token: vercelToken, teamId, envId: prevRecord.id,
    });
  } catch (err) {
    log.error('mcp.cron.invalidate-prev-bearer-error', {
      stage: 'delete-prev', status: err?.status ?? 0,
    });
    _json(res, 500, { ok: false, error: 'delete prev failed' });
    return;
  }

  // Best-effort redeploy. Failure here does NOT block invalidation success —
  // Vercel re-injects env state on next worker cold start.
  try {
    await triggerRedeploy({ projectId, token: vercelToken, teamId });
  } catch (err) {
    log.warn('mcp.cron.invalidate-prev-bearer.redeploy-failed', {
      stage: 'redeploy', status: err?.status ?? 0,
    });
  }

  const invalidatedAt = new Date().toISOString();
  log.info('mcp.cron.invalidate-prev-bearer.ok', {
    stage: 'done', invalidatedAt,
  });
  _json(res, 200, { ok: true, invalidatedAt });
}
