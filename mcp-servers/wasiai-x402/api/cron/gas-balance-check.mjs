// SPDX-License-Identifier: MIT
// api/cron/gas-balance-check.mjs — WKH-71 native-gas monitor cron.
//
// SEPARATE from api/cron/balance-check.mjs (DT-5): that one watches the MCP
// operator's USDC spend budget; THIS one watches whether operator/relayer
// wallets still hold enough NATIVE gas to broadcast settles on testnet.
//
// On each ~15-min tick (cron-job.org):
//   1. Auth via CRON_SECRET (CD-4).
//   2. Load wallet targets + thresholds + RPC overrides from env (CD-6).
//   3. For each wallet×chain: read native balance via a zero-cost `getBalance`
//      RPC call (CD-3, AC-5) and, if below WARNING/CRITICAL, fire the alert
//      through the shared src/alerts.mjs::sendAlert (CD-1, AC-1/AC-2).
//   4. ALWAYS respond 200 (CD-4 fail-open) — a webhook/RPC failure never
//      breaks the cron or another wallet's check (AC-6).
//
// CDs: CD-1 reuse sendAlert, CD-2 whitelist body (enforced in sendAlert),
//      CD-3 read-only getBalance, CD-4 fail-open + 200, CD-6 env config.

import { createPublicClient, http as viemHttp } from 'viem';
import * as log from '../../src/log.mjs';
import { validateCronSecret, CronAuthError } from '../../src/cron-auth.mjs';
import { sendAlert } from '../../src/alerts.mjs';
import { checkGasBalances, parseTargets } from '../../src/gas-monitor.mjs';

function _json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

// Memoized read-only viem clients, one per RPC URL (reuses HTTP keep-alive,
// mirrors src/avax-client.mjs). No `chain` object is needed for getBalance.
const _clients = new Map();
function _getClient(rpcUrl) {
  let client = _clients.get(rpcUrl);
  if (!client) {
    client = createPublicClient({ transport: viemHttp(rpcUrl) });
    _clients.set(rpcUrl, client);
  }
  return client;
}

// CD-3: zero-cost read-only balance. NEVER signs / spends gas.
async function readNativeBalance(_chainId, address, rpcUrl) {
  const client = _getClient(rpcUrl);
  return client.getBalance({ address });
}

export default async function gasBalanceCheckHandler(req, res) {
  // 1. Auth.
  try {
    validateCronSecret(req.headers?.authorization ?? '', process.env.CRON_SECRET);
  } catch (e) {
    if (e instanceof CronAuthError) {
      log.warn('mcp.gas-cron.unauthorized', { stage: 'verify' });
      _json(res, e.status, {
        error: e.status === 500 ? 'server misconfigured' : 'unauthorized',
      });
      return;
    }
    log.error('mcp.gas-cron.error', { stage: 'verify', error: e?.message ?? 'unknown' });
    _json(res, 500, { error: 'internal' });
    return;
  }

  // 2. Config from env (CD-6). No targets configured → warnOnce + 200 (nothing
  //    to monitor is not an error; fail-open CD-4).
  const targets = parseTargets(process.env.GAS_ALERT_TARGETS);
  if (targets.length === 0) {
    log.warnOnce(
      'gas-monitor-no-targets',
      'mcp.gas-cron.no-targets',
      { stage: 'config' },
    );
    _json(res, 200, { checked: 0, results: [] });
    return;
  }

  // 3. Check every wallet×chain. checkGasBalances never throws (CD-4).
  let results = [];
  try {
    results = await checkGasBalances({
      targets,
      env: process.env,
      readBalance: readNativeBalance,
      sendAlert,
      webhookUrl: process.env.MCP_ALERT_WEBHOOK_URL,
    });
  } catch (e) {
    // Defensive — the core is designed never to throw, but the cron must stay
    // 200 no matter what (CD-4).
    log.error('mcp.gas-cron.error', { stage: 'check', error: e?.message ?? 'unknown' });
    _json(res, 200, { checked: 0, results: [] });
    return;
  }

  const alerts = results.filter(
    (r) => r.severity === 'critical' || r.severity === 'warning',
  ).length;
  log.info('mcp.gas-cron.ok', {
    stage: 'done', checked: results.length, alerts,
  });

  // 4. Always 200 (CD-4).
  _json(res, 200, { checked: results.length, alerts, results });
}
