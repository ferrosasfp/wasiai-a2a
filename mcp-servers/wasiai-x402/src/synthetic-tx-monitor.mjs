// SPDX-License-Identifier: MIT
// src/synthetic-tx-monitor.mjs — WKH-74 capa D: post-deploy real-tx synthetic
// probe, gated by the gateway deploy identifier (≈1 tx per deploy).
//
// SEPARATE concern from synthetic-payment-monitor.mjs (capa A): that one is a
// FREE probe that asserts the x402 402 challenge without spending a cent; THIS
// one spends a REAL tiny settlement (~$0.001-0.05) exactly ONCE per gateway
// deploy to prove the money-path end-to-end actually settles on-chain. The two
// are never mixed.
//
// Design (mirrors gas-monitor.mjs / health-monitor.mjs):
//   - Pure, dependency-injected core (`checkSyntheticTx`) so the unit suite
//     drives it with fakes (`getDeployId`, `kvGet`, `kvSet`, `runRealTx`,
//     `sendAlert`) — no real network, no real KV, no real spend.
//   - Config comes ONLY from env (CD-6) in the cron; the core receives already-
//     resolved dependencies. No deploy id / key / URL is hardcoded in code.
//   - Spend gate (CD-5, AC-5): a real-tx runs ONLY when the current deploy id
//     differs from the last-known one persisted in KV. WHILE the deploy id is
//     unchanged, NOTHING is spent.
//   - Fail-open (CD-3): the core never throws; the cron caller still 200s. A
//     failed real-tx is a `critical` alert AND the KV is left untouched so the
//     probe retries next tick until it passes (AC-4).
//   - No secrets in the alert body (CD-7): only whitelisted public identifiers
//     (severity, event, reason, service, url, httpStatus, checkedAt) flow to
//     sendAlert — never the Agent Key, the deploy id or a raw tx.

import * as log from './log.mjs';

// AC-4: every capa-D failure emits this single reason.
export const SYNTH_TX_FAILED_REASON = 'post-deploy-synthetic-tx-failed';

// Canonical service label used in the alert body / logs (a public identifier).
const DEFAULT_SERVICE = 'gateway-a2a-orchestrate';

// A settlement tx hash is a 32-byte hex digest.
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * @internal — pull the FIRST verifiable settlement tx hash out of an
 * /orchestrate response. Returns the hash string or null. Never throws.
 *
 * Two sources, checked in order:
 *   1. top-level `kiteTxHash` (routes/orchestrate.ts) — set ONLY by the on-chain
 *      settle path. On capa D this is EXPECTED TO BE ABSENT: capa D pays via
 *      `x-a2a-key` (prepago) and the a2a-key middleware never sets the top-level
 *      `kiteTxHash`. It would only appear on other (non-agent-key) paths.
 *   2. `pipeline.steps[].txHash` — the EXPECTED source on the agent-key path.
 *      Because the prepago path emits no top-level hash, capa D's on-chain proof
 *      comes from a downstream step settle recorded here. This is the hash capa
 *      D actually validates, so `MONITOR_TX_GOAL` MUST trigger ≥1 settling step.
 *
 * @param {unknown} json
 * @returns {string|null}
 */
export function extractTxHash(json) {
  if (!json || typeof json !== 'object') return null;
  if (typeof json.kiteTxHash === 'string' && TX_HASH_RE.test(json.kiteTxHash)) {
    return json.kiteTxHash;
  }
  const steps = json.pipeline && typeof json.pipeline === 'object'
    ? json.pipeline.steps
    : undefined;
  if (Array.isArray(steps)) {
    for (const s of steps) {
      if (s && typeof s === 'object' && typeof s.txHash === 'string' && TX_HASH_RE.test(s.txHash)) {
        return s.txHash;
      }
    }
  }
  return null;
}

/**
 * @internal — did the orchestration pipeline report an explicit failure?
 * `pipeline.success === false` is the failure signal (AC-4). Absent/true is not
 * a failure here (the tx-hash check covers a missing settle). Never throws.
 *
 * @param {unknown} json
 * @returns {boolean}
 */
export function pipelineFailed(json) {
  if (!json || typeof json !== 'object') return false;
  const pipeline = json.pipeline;
  if (!pipeline || typeof pipeline !== 'object') return false;
  return pipeline.success === false;
}

/**
 * @internal — fire the capa-D critical alert. Best-effort (CD-1) and wrapped so
 * a throwing `sendAlert` can never bubble out of the fail-open core (CD-3).
 */
async function _alert({ sendAlert, webhookUrl, mention, service, url, httpStatus, checkedAt }) {
  log.warn('mcp.synth-tx.failed', { stage: 'alert', service, httpStatus });
  try {
    await sendAlert({
      severity: 'critical',
      webhookUrl,
      mention,
      body: {
        severity: 'critical',
        event: 'synthetic-tx-check',
        reason: SYNTH_TX_FAILED_REASON,
        service,
        url,
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        checkedAt,
      },
    });
  } catch (e) {
    log.warn('mcp.synth-tx.alert-failed', {
      stage: 'alert', service, error: e?.message ?? 'unknown',
    });
  }
}

/**
 * Gate on the gateway deploy id, and — ONLY when it changed — run one real-tx
 * synthetic and validate it settled on-chain before advancing the KV.
 *
 * NEVER throws (CD-3 fail-open). Every branch returns a plain result row and the
 * cron caller always 200s.
 *
 * Dependencies (all injected):
 *   - `getDeployId()`  → resolves the CURRENT gateway deploy id (string), THROWS
 *      on failure. A failure to read it → skip (can't compare) — NO tx, NO alert.
 *   - `kvGet(key)`     → last-known deploy id (string|null), THROWS on failure.
 *      A KV read failure → skip (can't compare) — NO tx, NO alert.
 *   - `runRealTx()`    → resolves `{status, json}` for ANY HTTP response, THROWS
 *      only on connection error / timeout. Uses the DEDICATED monitoring Agent
 *      Key (CD-6, wired in the cron).
 *   - `kvSet(key,val)` → persists the new deploy id AFTER a passing real-tx.
 *
 * Spend contract (CD-5 / AC-5):
 *   - deploy id UNCHANGED  → return `{ ran:false, reason:'no-deploy-change' }`,
 *     NOTHING spent.
 *   - deploy id CHANGED (incl. first run with no stored baseline) → run exactly
 *     ONE real-tx.
 *       - passes (2xx + tx hash + pipeline not failed) → advance KV, `ran:true`.
 *       - fails (HTTP error / no tx hash / success:false / network error) →
 *         critical alert AND KV left untouched (AC-4 — retries next tick).
 *
 * @param {object} deps
 * @param {()=>Promise<string>} deps.getDeployId
 * @param {(key:string)=>Promise<string|null>} deps.kvGet
 * @param {(key:string, value:string)=>Promise<unknown>} deps.kvSet
 * @param {string} deps.kvKey
 * @param {()=>Promise<{status:number, json:unknown}>} deps.runRealTx
 * @param {(args:object)=>Promise<unknown>} deps.sendAlert
 * @param {string|undefined} deps.webhookUrl
 * @param {string|undefined} [deps.mention]
 * @param {string} [deps.service]
 * @param {string} [deps.url]
 * @param {()=>string} [deps.now]
 * @returns {Promise<object>} result row (never throws)
 */
export async function checkSyntheticTx({
  getDeployId,
  kvGet,
  kvSet,
  kvKey,
  runRealTx,
  sendAlert,
  webhookUrl,
  mention,
  service = DEFAULT_SERVICE,
  url,
  now = () => new Date().toISOString(),
}) {
  // 1. Current deploy id. A failure to read it means we cannot compare — skip
  //    silently (fail-open, CD-3). NO tx, NO alert.
  let currentId;
  try {
    currentId = await getDeployId();
  } catch (e) {
    log.warn('mcp.synth-tx.deploy-id-failed', { stage: 'deploy-id', error: e?.name ?? 'unknown' });
    return { ran: false, reason: 'deploy-id-unavailable' };
  }
  if (typeof currentId !== 'string' || currentId.length === 0) {
    log.warn('mcp.synth-tx.deploy-id-empty', { stage: 'deploy-id' });
    return { ran: false, reason: 'deploy-id-unavailable' };
  }

  // 2. Last-known deploy id from KV. A KV read failure also means we cannot
  //    safely compare — skip (fail-open). NO tx, NO alert.
  let lastId;
  try {
    lastId = await kvGet(kvKey);
  } catch (e) {
    log.warn('mcp.synth-tx.kv-read-failed', { stage: 'kv-read', error: e?.name ?? 'unknown' });
    return { ran: false, reason: 'kv-read-failed' };
  }

  // 3. Spend gate (AC-5, CD-5): unchanged → nothing to do.
  if (lastId != null && String(lastId) === currentId) {
    log.info('mcp.synth-tx.no-change', { stage: 'gate' });
    return { ran: false, reason: 'no-deploy-change' };
  }

  // 4. Deploy id changed (or first run with no baseline) → run ONE real-tx.
  const checkedAt = now();
  let res;
  try {
    res = await runRealTx();
  } catch (e) {
    // Network error / timeout → failed probe (AC-4). Alert, do NOT advance KV.
    log.warn('mcp.synth-tx.probe-error', {
      stage: 'real-tx', error: e?.name ?? 'unknown',
    });
    await _alert({ sendAlert, webhookUrl, mention, service, url, httpStatus: undefined, checkedAt });
    return { ran: true, ok: false, reason: 'probe-error' };
  }

  const status = res?.status;
  const httpOk = typeof status === 'number' && status >= 200 && status < 300;
  const txHash = extractTxHash(res?.json);
  const failed = pipelineFailed(res?.json);

  // AC-4: any of {non-2xx, pipeline success:false, no verifiable tx hash} = fail.
  if (!httpOk || failed || !txHash) {
    const detail = !httpOk ? 'http-error' : failed ? 'pipeline-failed' : 'no-tx-hash';
    log.warn('mcp.synth-tx.invalid', { stage: 'real-tx', detail, httpStatus: status });
    await _alert({ sendAlert, webhookUrl, mention, service, url, httpStatus: status, checkedAt });
    return { ran: true, ok: false, reason: detail, httpStatus: status };
  }

  // 5. Passed — advance the KV to the validated deploy id. A KV write failure
  //    does NOT fail the probe (the tx already settled); it just means the next
  //    tick re-runs (one extra spend). Log it, never alert, never throw.
  try {
    await kvSet(kvKey, currentId);
  } catch (e) {
    log.warn('mcp.synth-tx.kv-write-failed', { stage: 'kv-write', error: e?.name ?? 'unknown' });
    return { ran: true, ok: true, reason: 'passed-kv-write-failed', txHash, httpStatus: status };
  }

  log.info('mcp.synth-tx.ok', { stage: 'done', httpStatus: status });
  return { ran: true, ok: true, reason: 'passed', txHash, httpStatus: status };
}
