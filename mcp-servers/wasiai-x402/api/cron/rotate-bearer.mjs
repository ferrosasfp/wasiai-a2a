// SPDX-License-Identifier: MIT
// api/cron/rotate-bearer.mjs — Vercel serverless cron endpoint (WKH-75 W3).
//
// Runs daily (cron-job.org). On each call:
//   1. Auth via CRON_SECRET (CD-4 timing-safe; missing CRON_SECRET → 500).
//   2. Verify VERCEL_TOKEN + VERCEL_PROJECT_ID are configured (else 500).
//   3. Delegate to bearer-rotation.rotateBearer (S0..S7 flow, see SDD §3 DT-2).
//      The core module emits its own alerts (CD-6 fire-and-forget) on critical
//      pre-S5 failures. KV snapshot of {rotatedAt, expiresAt} is written
//      best-effort inside rotateBearer (S6).
//   4. Return 200 {ok:true, rotatedAt, expiresAt} on success, 500 on failure.
//
// Handler shape: Express-style `(req, res) => void` (DT-K, CD-10) — same
// pattern as warmup.mjs and balance-check.mjs. NO Edge runtime.
//
// CDs touched:
//   CD-1 no edits to handlers/sign/config/log/url-validator.
//   CD-4 timing-safe auth via cron-auth.mjs; never bypass on missing secret.
//   CD-5 timeouts inherited from src/vercel-env.mjs (10s per call).
//   CD-6 alerts dispatched by rotateBearer (fire-and-forget); endpoint never
//        adds its own alert and never blocks on alert delivery.
//   CD-9 NEVER log MCP_BEARER_TOKEN / VERCEL_TOKEN. The handler logs only
//        stage names and HTTP-shaped reasons from STAGE_REASONS.
//   CD-10 Express-style (req, res); NO Web-standards Response.
//   CD-13 clearTimeout abort (heredado de vercel-env.mjs).
//   CD-16 NEVER use `event:` inside log fields object.
//   CD-17 separate auth log + outcome log; outcome NEVER carries the secret.

import * as log from '../../src/log.mjs';
import { validateCronSecret, CronAuthError } from '../../src/cron-auth.mjs';
import { rotateBearer } from '../../src/bearer-rotation.mjs';
import { getKvClient } from '../../src/kv-client.mjs';

function _json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export default async function rotateBearerHandler(req, res) {
  // 1. Auth.
  try {
    validateCronSecret(req.headers?.authorization ?? '', process.env.CRON_SECRET);
  } catch (e) {
    if (e instanceof CronAuthError) {
      log.warn('mcp.cron.unauthorized', { stage: 'verify' });
      _json(res, e.status, { error: e.status === 500 ? 'server misconfigured' : 'unauthorized' });
      return;
    }
    log.error('mcp.cron.rotate-bearer-error', {
      stage: 'verify', error: e?.name ?? 'unknown',
    });
    _json(res, 500, { error: 'internal' });
    return;
  }

  // 2. Server-config gate. CD-4: NEVER silently disable rotation; surface 500.
  const vercelToken = process.env.VERCEL_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  const teamId = process.env.VERCEL_TEAM_ID;
  if (!vercelToken || !projectId) {
    log.error('mcp.cron.rotate-bearer-error', {
      stage: 'config',
      missing: !vercelToken && !projectId
        ? 'VERCEL_TOKEN+VERCEL_PROJECT_ID'
        : (!vercelToken ? 'VERCEL_TOKEN' : 'VERCEL_PROJECT_ID'),
    });
    _json(res, 500, { error: 'server misconfigured' });
    return;
  }

  // 3. Delegate to core rotation. The core module:
  //    - dispatches its own alert on critical pre-S5 failures (CD-6).
  //    - writes the KV snapshot best-effort on success (S6).
  //    - never throws — returns {ok, stage, reason} or {ok:true, rotatedAt,
  //      expiresAt}.
  let result;
  try {
    result = await rotateBearer({
      vercelToken,
      projectId,
      teamId,
      alertWebhookUrl: process.env.MCP_ALERT_WEBHOOK_URL,
      kvClient: getKvClient(),
    });
  } catch (err) {
    // Defensive: rotateBearer is designed to never throw, but if a future
    // refactor changes that we MUST NOT crash the cron worker.
    log.error('mcp.cron.rotate-bearer-error', {
      stage: 'rotate', error: err?.name ?? 'unknown',
    });
    _json(res, 500, { ok: false, error: 'rotation failed' });
    return;
  }

  if (result?.ok) {
    log.info('mcp.cron.rotate-bearer.ok', {
      stage: 'done', rotatedAt: result.rotatedAt, expiresAt: result.expiresAt,
    });
    _json(res, 200, {
      ok: true,
      rotatedAt: result.rotatedAt,
      expiresAt: result.expiresAt,
    });
    return;
  }

  // Failure path. Alert was already dispatched inside rotateBearer (CD-6).
  log.error('mcp.cron.rotate-bearer.failed', {
    stage: result?.stage ?? 'unknown',
    // reason comes from STAGE_REASONS literal whitelist (CD-12) — safe to log.
    reason: result?.reason ?? 'unknown',
  });
  _json(res, 500, {
    ok: false,
    stage: result?.stage ?? 'unknown',
    error: result?.reason ?? 'rotation failed',
  });
}
