// SPDX-License-Identifier: MIT
// api/cron/balance-check.mjs — Vercel serverless cron (WKH-66 W3.3).
//
// Runs every ~15 min (cron-job.org). On each call:
//   1. Auth via CRON_SECRET (CD-4).
//   2. Read operator USDC balance on Avalanche C-Chain mainnet (viem).
//   3. Persist a balance snapshot to KV (TTL 1800s = 30 min). The same
//      snapshot key is read by src/balance-guard.mjs with TTL fresh-check
//      ≤ 30s — the cron writes the long TTL, the guard treats it as stale
//      after 30s and re-fetches RPC.
//   4. If balance < MCP_BALANCE_THRESHOLD_USDC AND MCP_ALERT_WEBHOOK_URL set,
//      fire-and-forget the alert. Webhook failure NEVER fails the cron
//      (CD-21: cron 200 OK and webhook delivery are separate channels).
//   5. Always respond 200 with { balanceWei, balanceUsdc, checkedAt,
//      blockNumber }.
//
// CDs touched:
//   CD-4 timing-safe auth, CD-5 webhook timeout 5s, CD-10 no log secrets,
//   CD-12 webhook body whitelist (enforced inside sendAlert), CD-16
//   USDC=ERC-20 (NOT native AVAX), CD-17 no `event:` in payload, CD-18
//   redirect:'error' on webhook fetch (in sendAlert), CD-21 separate
//   channels.

import * as log from '../../src/log.mjs';
import { validateCronSecret, CronAuthError } from '../../src/cron-auth.mjs';
import { getOperatorBalance } from '../../src/balance-guard.mjs';
import { sendAlert } from '../../src/alerts.mjs';
import { getKvClient } from '../../src/kv-client.mjs';

const SNAPSHOT_TTL_SEC = 1800; // 30 min — the cron writes long TTL; the
                               // balance-guard re-fetches if its 30s
                               // freshness window already lapsed.
const USDC_DECIMALS_DIVISOR = 10n ** 6n;

function _weiToUsdc(weiBigint) {
  const whole = weiBigint / USDC_DECIMALS_DIVISOR;
  const frac = weiBigint % USDC_DECIMALS_DIVISOR;
  return Number(whole) + Number(frac) / Number(USDC_DECIMALS_DIVISOR);
}

function _json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export default async function balanceCheckHandler(req, res) {
  // 1. Auth.
  try {
    validateCronSecret(req.headers?.authorization ?? '', process.env.CRON_SECRET);
  } catch (e) {
    if (e instanceof CronAuthError) {
      log.warn('mcp.cron.unauthorized', { stage: 'verify' });
      _json(res, e.status, { error: e.status === 500 ? 'server misconfigured' : 'unauthorized' });
      return;
    }
    log.error('mcp.cron.balance-check-error', {
      stage: 'verify', error: e?.message ?? 'unknown',
    });
    _json(res, 500, { error: 'internal' });
    return;
  }

  // 2. Derive operator address from PK. Same path as cfg.operatorAddress
  //    in src/config.mjs but we don't run loadConfig here — this cron does
  //    NOT need the gateway / Kite chain config.
  let operator;
  try {
    const { privateKeyToAccount } = await import('viem/accounts');
    operator = privateKeyToAccount(process.env.OPERATOR_PRIVATE_KEY).address;
  } catch (e) {
    log.error('mcp.cron.balance-check-error', {
      stage: 'derive', error: e?.message ?? 'unknown',
    });
    _json(res, 500, { error: 'operator derivation failed' });
    return;
  }

  const rpcUrl = process.env.AVALANCHE_RPC_URL ?? 'https://api.avax.network/ext/bc/C/rpc';
  const usdcAddress = process.env.AVALANCHE_USDC_ADDRESS
    ?? '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E';
  const threshold = parseFloat(process.env.MCP_BALANCE_THRESHOLD_USDC ?? '0.50');
  const chainId = parseInt(process.env.MCP_OPERATOR_CHAIN_ID ?? '43114', 10);

  // 3. Read balance.
  let balanceWei;
  let blockNumber;
  try {
    balanceWei = await getOperatorBalance(rpcUrl, operator, usdcAddress);
    // blockNumber is best-effort context for the alert/snapshot; not critical.
    try {
      const { createPublicClient, http: viemHttp } = await import('viem');
      const { avalanche } = await import('viem/chains');
      const client = createPublicClient({ chain: avalanche, transport: viemHttp(rpcUrl) });
      blockNumber = (await client.getBlockNumber()).toString();
    } catch {
      blockNumber = null;
    }
  } catch (e) {
    log.error('mcp.cron.balance-check-error', {
      stage: 'read', error: e?.message ?? 'unknown',
    });
    _json(res, 500, { error: 'balance read failed' });
    return;
  }

  const balanceUsdc = _weiToUsdc(balanceWei);
  const checkedAt = new Date().toISOString();

  // 4. Snapshot to KV (best-effort).
  const kv = getKvClient();
  if (kv) {
    const snapKey = `balance-snapshot:eip155:${chainId}:${operator.toLowerCase()}`;
    try {
      await kv.set(
        snapKey,
        JSON.stringify({
          balanceWei: balanceWei.toString(),
          balanceUsdc,
          checkedAt,
          blockNumber,
        }),
        { ex: SNAPSHOT_TTL_SEC },
      );
    } catch (e) {
      log.warn('mcp.cron.snapshot-write-failed', {
        stage: 'snapshot', error: e?.message ?? 'unknown',
      });
    }
  }

  // 5. Alert if below threshold.
  if (balanceUsdc < threshold) {
    log.warn('mcp.cron.balance-below-threshold', {
      stage: 'alert', balanceUsdc, threshold,
    });
    // sendAlert is fire-and-forget — never throws (CD-21).
    await sendAlert({
      severity: 'critical',
      body: {
        chain: 'avalanche-c-chain-mainnet',
        operator,
        balanceUsdc,
        threshold,
        checkedAt,
        blockNumber,
      },
      webhookUrl: process.env.MCP_ALERT_WEBHOOK_URL,
    });
  }

  log.info('mcp.cron.balance-check.ok', {
    stage: 'done', balanceUsdc, threshold, checkedAt, blockNumber,
  });

  _json(res, 200, {
    balanceWei: balanceWei.toString(),
    balanceUsdc,
    checkedAt,
    blockNumber,
  });
}
