// SPDX-License-Identifier: MIT
// api/cron/synthetic-tx-check.mjs — WKH-74 capa D: post-deploy real-tx synthetic
// probe cron, gated by the gateway deploy identifier (≈1 tx per deploy).
//
// SEPARATE from synthetic-payment-check.mjs (capa A, free): that one asserts the
// x402 challenge for $0; THIS one spends a REAL tiny settlement (~$0.001-0.05)
// exactly ONCE per gateway deploy to prove the money-path actually settles.
//
// On each ~1-hour tick (cron-job.org):
//   1. Auth via CRON_SECRET (CD-2).
//   2. Resolve deps from env (CD-6): the dedicated monitoring Agent Key
//      (MONITOR_A2A_KEY), the probe URL/body, and the Railway deploy-id source
//      (RAILWAY_*). Any missing → warnOnce + 200 (no-op).
//   3. Delegate to checkSyntheticTx: read current Railway deploy id, compare to
//      the KV last-known (kv-keys SYNTH_LAST_DEPLOY); ONLY if it changed, run one
//      real-tx with x-a2a-key: MONITOR_A2A_KEY, validate the settle tx hash, and
//      advance the KV. A failed real-tx → critical alert + KV untouched (AC-4).
//   4. ALWAYS respond 200 (CD-3 fail-open).
//
// DT-2: the payment path runs on Railway (not Vercel), so the deploy gate uses
// the Railway GraphQL API's latest SUCCESS deployment id. RAILWAY_TOKEN is a
// secret; it is NEVER logged and NEVER placed in an alert body (CD-7).

import * as log from '../../src/log.mjs';
import { validateCronSecret, CronAuthError } from '../../src/cron-auth.mjs';
import { sendAlert } from '../../src/alerts.mjs';
import { getKvClient } from '../../src/kv-client.mjs';
import { KV_KEYS } from '../../src/kv-keys.mjs';
import { checkSyntheticTx } from '../../src/synthetic-tx-monitor.mjs';
import { resolveProbeUrl, resolveProbeBody } from '../../src/synthetic-payment-monitor.mjs';

const DEFAULT_RAILWAY_GRAPHQL_URL = 'https://backboard.railway.app/graphql/v2';
const RAILWAY_TIMEOUT_MS = 8000;

function _json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function _resolveTxTimeoutMs(env) {
  const n = Number(env?.MONITOR_TX_TIMEOUT_MS);
  if (!Number.isFinite(n) || n <= 0) return 90000;
  // A real orchestration + settle can take tens of seconds; cap at the gateway
  // orchestrate ceiling (120s) so a hung probe never stalls the tick forever.
  return Math.min(n, 120000);
}

// Resolve the Railway deploy-id source config. Returns null if incomplete.
function _resolveRailwayConfig(env) {
  const token = env?.RAILWAY_TOKEN;
  const projectId = env?.RAILWAY_PROJECT_ID;
  const environmentId = env?.RAILWAY_ENVIRONMENT_ID;
  const serviceId = env?.RAILWAY_SERVICE_ID;
  if (!token || !projectId || !environmentId || !serviceId) return null;
  const graphqlUrl = env?.RAILWAY_GRAPHQL_URL || DEFAULT_RAILWAY_GRAPHQL_URL;
  return { token, projectId, environmentId, serviceId, graphqlUrl };
}

// DT-2: query the Railway GraphQL API for the gateway's latest SUCCESS deployment
// id. Returns the id string; THROWS on any failure (→ checkSyntheticTx skips,
// fail-open). The token is sent only as the Bearer header, NEVER logged.
function _makeGetDeployId({ token, projectId, environmentId, serviceId, graphqlUrl }) {
  return async () => {
    // first: 5 (not 1) so a latest BUILDING/FAILED/CRASHED deploy does not mask
    // the most recent SUCCESS below it — we must gate the real-tx on a deploy
    // that actually shipped, never on a broken/in-progress one.
    const query = `query deployments($input: DeploymentListInput!) {
      deployments(first: 5, input: $input) {
        edges { node { id status } }
      }
    }`;
    const variables = { input: { projectId, environmentId, serviceId } };
    const resp = await fetch(graphqlUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'user-agent': 'wasiai-synthetic-monitor/1.0',
      },
      body: JSON.stringify({ query, variables }),
      redirect: 'error',
      signal: AbortSignal.timeout(RAILWAY_TIMEOUT_MS),
    });
    if (!resp.ok) {
      throw new Error(`railway graphql status ${resp.status}`);
    }
    const payload = await resp.json();
    const edges = payload?.data?.deployments?.edges;
    if (!Array.isArray(edges) || edges.length === 0) {
      throw new Error('railway deployments empty');
    }
    // Require a SUCCESS deploy: pick the FIRST (most recent) node whose status is
    // SUCCESS. If none of the returned deploys shipped, THROW → checkSyntheticTx
    // skips (fail-open, no spend) rather than gating a real-tx on a broken deploy.
    const success = edges.find((e) => e?.node?.status === 'SUCCESS');
    const id = success?.node?.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('railway no successful deployment');
    }
    return id;
  };
}

// runRealTx: POST /orchestrate with the DEDICATED monitoring Agent Key
// (x-a2a-key). Resolves { status, json } for ANY HTTP response; THROWS on
// connection error / timeout. The key is sent only as the header, NEVER logged.
function _makeRunRealTx({ url, body, agentKey, timeoutMs }) {
  return async () => {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-a2a-key': agentKey,
        'user-agent': 'wasiai-synthetic-monitor/1.0',
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    let json = null;
    try {
      const text = await resp.text();
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: resp.status, json };
  };
}

export default async function syntheticTxCheckHandler(req, res) {
  // 1. Auth.
  try {
    validateCronSecret(req.headers?.authorization ?? '', process.env.CRON_SECRET);
  } catch (e) {
    if (e instanceof CronAuthError) {
      log.warn('mcp.synth-tx-cron.unauthorized', { stage: 'verify' });
      _json(res, e.status, {
        error: e.status === 500 ? 'server misconfigured' : 'unauthorized',
      });
      return;
    }
    log.error('mcp.synth-tx-cron.error', { stage: 'verify', error: e?.message ?? 'unknown' });
    _json(res, 500, { error: 'internal' });
    return;
  }

  // 2. Config from env (CD-6). Missing key / URL / Railway config → no-op.
  const url = resolveProbeUrl(process.env);
  const agentKey = process.env.MONITOR_A2A_KEY;
  const railway = _resolveRailwayConfig(process.env);
  if (!url || !agentKey || !railway) {
    log.warnOnce(
      'synth-tx-not-configured',
      'mcp.synth-tx-cron.not-configured',
      {
        stage: 'config',
        hasUrl: Boolean(url),
        hasKey: Boolean(agentKey),
        hasRailway: Boolean(railway),
      },
    );
    _json(res, 200, { ran: false, reason: 'not-configured' });
    return;
  }

  const kv = getKvClient();
  if (!kv) {
    // No KV means we cannot gate the spend — refuse to run (fail-open, no tx).
    log.warnOnce('synth-tx-no-kv', 'mcp.synth-tx-cron.no-kv', { stage: 'config' });
    _json(res, 200, { ran: false, reason: 'kv-not-configured' });
    return;
  }

  const body = resolveProbeBody(process.env);
  const txBody = {
    goal: process.env.MONITOR_TX_GOAL?.trim() || body.goal,
    budget: (() => {
      const n = Number(process.env.MONITOR_TX_BUDGET);
      return Number.isFinite(n) && n > 0 ? n : body.budget;
    })(),
  };

  // 3. Delegate. checkSyntheticTx never throws (CD-3).
  let result;
  try {
    result = await checkSyntheticTx({
      getDeployId: _makeGetDeployId(railway),
      kvGet: (key) => kv.get(key),
      kvSet: (key, value) => kv.set(key, value),
      kvKey: KV_KEYS.SYNTH_LAST_DEPLOY,
      runRealTx: _makeRunRealTx({
        url,
        body: txBody,
        agentKey,
        timeoutMs: _resolveTxTimeoutMs(process.env),
      }),
      sendAlert,
      webhookUrl: process.env.MCP_ALERT_WEBHOOK_URL,
      mention: process.env.ONCALL_MENTION,
      url,
    });
  } catch (e) {
    // Defensive — the core never throws, but the cron must stay 200 (CD-3).
    log.error('mcp.synth-tx-cron.error', { stage: 'check', error: e?.message ?? 'unknown' });
    _json(res, 200, { ran: false, reason: 'internal' });
    return;
  }

  log.info('mcp.synth-tx-cron.ok', {
    stage: 'done', ran: result.ran, reason: result.reason,
  });

  // 4. Always 200 (CD-3). Never echo the deploy id / tx hash beyond a boolean.
  _json(res, 200, {
    ran: result.ran,
    ok: result.ok ?? null,
    reason: result.reason,
  });
}
