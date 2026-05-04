// SPDX-License-Identifier: MIT
// bearer-rotation.mjs — Core S0..S8 rotation flow (WKH-75 W2).
//
// Used by:
//   - scripts/rotate-bearer.mjs (headless mode)            → W2
//   - api/cron/rotate-bearer.mjs                            → W3
//
// Flow (per SDD §3 DT-2): S0 generate; S1 list; S2 stale PREV cleanup;
// S3 create PREV; S4 update current with rollback; S5 redeploy best-effort;
// S6 KV best-effort; S7 ok.
//
// CDs: CD-5 (timeout 10s inherited), CD-6 (alert timeout 5s inherited),
// CD-9 (no log of bearers/tokens), CD-12 (reason from STAGE_REASONS only),
// CD-16 (no event in log fields).

import { randomBytes } from 'node:crypto';
import {
  listEnvs,
  createEnv,
  updateEnv,
  deleteEnv,
  triggerRedeploy,
} from './vercel-env.mjs';
import { sendAlert } from './alerts.mjs';
import { KV_KEYS } from './kv-keys.mjs';
import * as log from './log.mjs';

const STAGE_REASONS = Object.freeze({
  'list-envs-failed': 'failed to list Vercel envs',
  'delete-stale-prev-failed': 'failed to delete stale PREV env',
  'create-prev-failed': 'failed to create PREV env',
  'update-current-failed': 'failed to update current env (rolled back)',
  'mutex-busy': 'rotation already in progress',
});

const OVERLAP_WINDOW_MS = 24 * 60 * 60 * 1000;
// KV snapshot survives ~1h past the overlap window so the invalidate cron has
// a deterministic anchor even if it runs slightly after expiresAt.
const KV_TTL_SECONDS = 25 * 60 * 60;
// Mutex TTL: long enough for a normal rotation (~30s end-to-end) plus margin,
// short enough that a crashed worker does not block the next scheduled run
// (CD-WKH88-6 caps this at 10 min).
const MUTEX_TTL_SECONDS = 5 * 60;

export class RotationError extends Error {
  constructor(message, { stage, reason } = {}) {
    super(message);
    this.name = 'RotationError';
    this.stage = stage;
    this.reason = reason;
  }
}

async function _dispatchAlert(alertWebhookUrl, stage, rotatedAt) {
  if (!alertWebhookUrl) return;
  const reason = STAGE_REASONS[stage] ?? 'rotation failed';
  try {
    await sendAlert({
      severity: 'critical',
      body: { event: 'bearer-rotation-failed', reason, rotatedAt },
      webhookUrl: alertWebhookUrl,
    });
  } catch {}
}

/**
 * Rotate the MCP bearer token via the Vercel REST API.
 *
 * Flow (S0..S7, see SDD WKH-75 §3 DT-2):
 *   - S0-pre: acquire NX-flagged KV mutex (WKH-88) — early-return if taken.
 *   - S0: generate new bearer + ISO timestamps.
 *   - S1: list Vercel envs.
 *   - S2: delete stale PREV env (if any).
 *   - S3: create new PREV from the current bearer.
 *   - S4: update current env to the new bearer (rollback PREV on failure).
 *   - S5: best-effort redeploy.
 *   - S6: best-effort KV snapshot write (`last-bearer-rotation`).
 *   - S7: return `{ok:true, rotatedAt, expiresAt}`.
 *
 * NEVER throws (CD-12). All error paths return `{ok:false, stage, reason}`.
 * The `reason` field is sourced from `STAGE_REASONS` (whitelist) — never a
 * raw error message — so it is safe to log and forward to clients.
 *
 * Bearers and Vercel/CRON tokens are NEVER logged (CD-9, CD-15).
 *
 * @param {Object} [params={}]
 * @param {string} params.vercelToken
 *   Vercel API token (required). Used as `Authorization: Bearer <token>`.
 * @param {string} params.projectId
 *   Vercel project id (required), e.g. `prj_xxx`.
 * @param {string} [params.teamId]
 *   Optional Vercel team id; appended as `?teamId=...` on every Vercel call.
 * @param {string} [params.alertWebhookUrl]
 *   Optional webhook URL. When set, critical pre-S5 failures dispatch a
 *   fire-and-forget `severity:'critical'` alert via {@link sendAlert}. When
 *   absent, no alert is attempted.
 * @param {Object} [params.kvClient]
 *   Optional Upstash Redis client (any object with `set(key, value, opts)`).
 *   Used both for the S0-pre mutex (NX flag) and the S6 snapshot. When
 *   absent, both steps are skipped (rotation still succeeds; mutex is a
 *   defence-in-depth, not a hard pre-condition).
 *
 * @returns {Promise<RotateBearerResult>}
 *   Resolved promise. Never rejects.
 *
 * @typedef {Object} RotateBearerSuccess
 * @property {true} ok
 * @property {string} rotatedAt
 *   ISO-8601 UTC timestamp of S0 (when the new bearer was generated).
 * @property {string} expiresAt
 *   ISO-8601 UTC timestamp; equals `rotatedAt + 24h` (the overlap window).
 *
 * @typedef {Object} RotateBearerFailure
 * @property {false} ok
 * @property {('pre-check'|'mutex'|'list-envs'|'delete-stale-prev'|'create-prev'|'update-current')} stage
 *   Stage at which the rotation aborted.
 * @property {string} reason
 *   Human-readable, whitelist-sourced reason (`STAGE_REASONS[stage]` or a
 *   stable pre-check string). Safe to forward to clients and logs.
 *
 * @typedef {RotateBearerSuccess | RotateBearerFailure} RotateBearerResult
 *
 * @throws {never} This function NEVER throws. Internal exceptions are
 *   captured and converted to `{ok:false, stage, reason}` per CD-12.
 */
export async function rotateBearer({
  vercelToken,
  projectId,
  teamId,
  alertWebhookUrl,
  kvClient,
} = {}) {
  if (!vercelToken) return { ok: false, stage: 'pre-check', reason: 'VERCEL_TOKEN missing' };
  if (!projectId)   return { ok: false, stage: 'pre-check', reason: 'VERCEL_PROJECT_ID missing' };

  const newBearer = randomBytes(32).toString('hex');
  const rotatedAt = new Date().toISOString();
  const expiresAt = new Date(Date.parse(rotatedAt) + OVERLAP_WINDOW_MS).toISOString();

  // S0-pre: NX-flagged mutex (WKH-88). Prevents two concurrent invocations
  // from both creating MCP_BEARER_TOKEN_PREV — a race condition that would
  // leave the env in an inconsistent state.
  //
  // CD-WKH88-2: MUST use NX-flagged set (atomic), NEVER read-then-write.
  // Upstash returns 'OK' on success, null when the key already exists.
  // We treat any falsy result (null, undefined, false, '') as "mutex busy".
  if (kvClient && typeof kvClient.set === 'function') {
    let acquired;
    try {
      acquired = await kvClient.set(
        KV_KEYS.ROTATION_MUTEX,
        rotatedAt,
        { nx: true, ex: MUTEX_TTL_SECONDS },
      );
    } catch {
      // KV down / network blip — best-effort: skip the mutex and proceed.
      // We log but do not abort: a missing mutex is strictly weaker than
      // the rotation itself, which has its own listEnvs guard.
      log.warn('mcp.rotate-bearer.mutex-acquire-failed', { stage: 'mutex' });
      acquired = 'OK';
    }
    if (!acquired) {
      log.warn('mcp.rotate-bearer.mutex-busy', { stage: 'mutex' });
      return { ok: false, stage: 'mutex', reason: STAGE_REASONS['mutex-busy'] };
    }
  }

  let envs;
  try {
    envs = await listEnvs({ projectId, token: vercelToken, teamId });
  } catch (err) {
    log.error('mcp.rotate-bearer.list-envs-failed', { stage: 'list-envs', status: err?.status ?? 0 });
    await _dispatchAlert(alertWebhookUrl, 'list-envs-failed', rotatedAt);
    return { ok: false, stage: 'list-envs', reason: STAGE_REASONS['list-envs-failed'] };
  }

  const currentRecord = envs.find(
    (e) => e.key === 'MCP_BEARER_TOKEN' && Array.isArray(e.target) && e.target.includes('production'),
  );
  if (!currentRecord || !currentRecord.id) {
    log.error('mcp.rotate-bearer.list-envs-failed', { stage: 'list-envs', status: 0 });
    await _dispatchAlert(alertWebhookUrl, 'list-envs-failed', rotatedAt);
    return { ok: false, stage: 'list-envs', reason: STAGE_REASONS['list-envs-failed'] };
  }

  const currentEnvId = currentRecord.id;
  const currentBearer = currentRecord.value;

  const prevRecord = envs.find(
    (e) => e.key === 'MCP_BEARER_TOKEN_PREV' && Array.isArray(e.target) && e.target.includes('production'),
  );

  if (prevRecord && prevRecord.id) {
    try {
      await deleteEnv({ projectId, token: vercelToken, teamId, envId: prevRecord.id });
    } catch (err) {
      log.error('mcp.rotate-bearer.delete-stale-prev-failed', { stage: 'delete-stale-prev', status: err?.status ?? 0 });
      await _dispatchAlert(alertWebhookUrl, 'delete-stale-prev-failed', rotatedAt);
      return { ok: false, stage: 'delete-stale-prev', reason: STAGE_REASONS['delete-stale-prev-failed'] };
    }
  }

  let newPrevEnvId;
  try {
    const created = await createEnv({
      projectId, token: vercelToken, teamId,
      key: 'MCP_BEARER_TOKEN_PREV',
      value: currentBearer,
    });
    newPrevEnvId = created?.id;
  } catch (err) {
    log.error('mcp.rotate-bearer.create-prev-failed', { stage: 'create-prev', status: err?.status ?? 0 });
    await _dispatchAlert(alertWebhookUrl, 'create-prev-failed', rotatedAt);
    return { ok: false, stage: 'create-prev', reason: STAGE_REASONS['create-prev-failed'] };
  }

  try {
    await updateEnv({ projectId, token: vercelToken, teamId, envId: currentEnvId, value: newBearer });
  } catch (err) {
    log.error('mcp.rotate-bearer.update-current-failed', { stage: 'update-current', status: err?.status ?? 0 });
    if (newPrevEnvId) {
      try {
        await deleteEnv({ projectId, token: vercelToken, teamId, envId: newPrevEnvId });
      } catch (rollbackErr) {
        log.warn('mcp.rotate-bearer.rollback-failed', { stage: 'rollback', status: rollbackErr?.status ?? 0 });
      }
    }
    await _dispatchAlert(alertWebhookUrl, 'update-current-failed', rotatedAt);
    return { ok: false, stage: 'update-current', reason: STAGE_REASONS['update-current-failed'] };
  }

  try {
    await triggerRedeploy({ projectId, token: vercelToken, teamId });
  } catch (err) {
    log.warn('mcp.rotate-bearer.redeploy-failed', { stage: 'redeploy', status: err?.status ?? 0 });
  }

  if (kvClient && typeof kvClient.set === 'function') {
    try {
      await kvClient.set(
        KV_KEYS.LAST_ROTATION,
        JSON.stringify({ rotatedAt, expiresAt }),
        { ex: KV_TTL_SECONDS },
      );
    } catch {
      log.warn('mcp.rotate-bearer.kv-write-failed', { stage: 'kv-write' });
    }
  }

  return { ok: true, rotatedAt, expiresAt };
}

export { STAGE_REASONS };
