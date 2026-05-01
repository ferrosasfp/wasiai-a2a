// SPDX-License-Identifier: MIT
// api/cron/warmup.mjs — Vercel serverless cron endpoint (WKH-66 W1.3).
//
// Goal: keep the wasiai-x402 MCP function warm against Vercel cold-starts.
// cron-job.org pings this endpoint every ~4 minutes (configured via
// scripts/setup-cronjob.mjs). On each call we:
//   1. Validate Authorization: Bearer <CRON_SECRET> (CD-4 timing-safe).
//   2. Pre-load the heavy modules (handlers, sign) into the worker memory
//      so the next real request (Claude Console → POST /api/mcp) doesn't
//      pay the import cost.
//   3. Derive the operator address from OPERATOR_PRIVATE_KEY in-memory only
//      — NO RPC call, NO gateway fetch, NO signing. The privateKeyToAccount
//      derivation is the most expensive synchronous viem op for a cold
//      worker, so warming it materially reduces tail latency.
//
// Handler shape: Express-style `(req, res) => void` (DT-K). Vercel functions
// in /api default to this shape and will hang if a handler returns a Web
// Standards Response without calling res.end(). This file does NOT use the
// adapter from api/mcp.mjs because the cron path has no streaming body.
//
// Logs (CD-17 — never put `event:` inside the fields object):
//   info('mcp.cron.warmup.ok', { warmedAt })
//   warn('mcp.cron.unauthorized', { stage: 'verify' })
//   error('mcp.cron.warmup-error', { stage, error })

import * as log from '../../src/log.mjs';
import { validateCronSecret, CronAuthError } from '../../src/cron-auth.mjs';

export default async function warmupHandler(req, res) {
  // 1. Auth.
  try {
    validateCronSecret(req.headers?.authorization ?? '', process.env.CRON_SECRET);
  } catch (e) {
    if (e instanceof CronAuthError) {
      log.warn('mcp.cron.unauthorized', { stage: 'verify' });
      _json(res, e.status, { error: e.status === 500 ? 'server misconfigured' : 'unauthorized' });
      return;
    }
    log.error('mcp.cron.warmup-error', { stage: 'verify', error: e?.message ?? 'unknown' });
    _json(res, 500, { error: 'internal' });
    return;
  }

  // 2. Pre-load heavy modules in this worker. Dynamic imports — once
  //    resolved they stay cached for the lifetime of the V8 instance.
  try {
    await import('../../src/handlers.mjs');
    await import('../../src/sign.mjs');

    // 3. Operator address derivation (no network).
    const pk = process.env.OPERATOR_PRIVATE_KEY;
    if (pk) {
      const { privateKeyToAccount } = await import('viem/accounts');
      // Address derivation only — we deliberately discard the result so
      // the address never reaches a log line (defense in depth, even
      // though the address itself is a public artifact).
      privateKeyToAccount(pk);
    }
  } catch (e) {
    // Pre-load failure is logged but should NOT 500 the cron — a successful
    // warmup is best-effort. We still return 200 so cron-job.org doesn't
    // mark the job as failing.
    log.warn('mcp.cron.warmup-preload-failed', { error: e?.message ?? 'unknown' });
  }

  const warmedAt = new Date().toISOString();
  log.info('mcp.cron.warmup.ok', { warmedAt });
  _json(res, 200, { ok: true, warmedAt });
}

function _json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}
