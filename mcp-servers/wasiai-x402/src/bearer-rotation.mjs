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
import * as log from './log.mjs';

const STAGE_REASONS = Object.freeze({
  'list-envs-failed': 'failed to list Vercel envs',
  'delete-stale-prev-failed': 'failed to delete stale PREV env',
  'create-prev-failed': 'failed to create PREV env',
  'update-current-failed': 'failed to update current env (rolled back)',
});

const OVERLAP_WINDOW_MS = 24 * 60 * 60 * 1000;
const KV_TTL_SECONDS = 25 * 60 * 60;
const KV_KEY = 'last-bearer-rotation';

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
      await kvClient.set(KV_KEY, JSON.stringify({ rotatedAt, expiresAt }), { ex: KV_TTL_SECONDS });
    } catch {
      log.warn('mcp.rotate-bearer.kv-write-failed', { stage: 'kv-write' });
    }
  }

  return { ok: true, rotatedAt, expiresAt };
}

export { STAGE_REASONS };
