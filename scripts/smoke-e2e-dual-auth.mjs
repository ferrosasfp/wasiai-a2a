#!/usr/bin/env node
/**
 * @file smoke-e2e-dual-auth.mjs
 * @description Dual-auth e2e smoke runner (WKH-117, AC-11).
 *
 * Validates the two payer paths the gateway accepts against a single target:
 *   - Path A — Agent Key (prepaid): `x-a2a-key: <SMOKE_A2A_KEY>` → expects 200.
 *   - Path B — Kite Agent Passport (per-call x402): reuses a pre-approved kpass
 *     session via `agent:session execute`, which re-emits the paid request with
 *     the canonical `X-PAYMENT` header → exercises the WKH-117 alias end-to-end.
 *
 * Bootstrapping Path B (once per ~24h, requires passkey):
 *   kpass agent:session create \
 *     --ttl 24h --max-amount-per-tx 0.10 --max-total-amount 5.00 \
 *     --assets USDC --payment-approach x402
 *   # → click approval URL → approve via passkey
 *
 * Autonomous invocation (CI / cron, no human):
 *   SMOKE_TARGET_URL=https://... SMOKE_A2A_KEY=wasi_a2a_... \
 *     node scripts/smoke-e2e-dual-auth.mjs
 *
 * Env vars (NO secret defaults — CD-6):
 *   SMOKE_TARGET_URL        REQUIRED. Endpoint guarded by requirePaymentOrA2AKey.
 *   SMOKE_TARGET_BODY       Default: {"objective":"dual-auth smoke"}
 *   SMOKE_TARGET_METHOD     Default: POST
 *   SMOKE_A2A_KEY           REQUIRED for Path A. No default (secret).
 *   SMOKE_KPASS_BIN         Default: kpass   (override for tests)
 *   SMOKE_KPASS_MOCK_FILE   Default: unset   (test hook — JSON fixture mapping
 *                                              `<subcommand>` keys to {stdout,status})
 *   SMOKE_FETCH_MOCK_FILE   Default: unset   (test hook — JSON fixture for Path A
 *                                              fetch: {status, body})
 *
 * Exit codes (mirrors smoke-passport-autonomous.mjs):
 *   0 = both paths PASS
 *   1 = human gate required (missing SMOKE_A2A_KEY OR no active kpass session)
 *   2 = smoke assertion failure (non-200 / kpass status != success)
 *   3 = runtime error (kpass CLI missing, JSON parse failure, network error,
 *                       missing required config)
 *
 * Output channels:
 *   stdout: structured JSON only ({status, ...})
 *   stderr: human progress messages only (no secrets)
 *
 * Constraint Directives (WKH-117):
 *   CD-6  No secrets in code: SMOKE_A2A_KEY + target URL from env, no defaults.
 *         Only sha256 first-8 (hashId) of the key is ever logged.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const DEFAULTS = {
  body: '{"objective":"dual-auth smoke"}',
  method: 'POST',
};

function readEnv() {
  return {
    url: process.env.SMOKE_TARGET_URL ?? null,
    body: process.env.SMOKE_TARGET_BODY ?? DEFAULTS.body,
    method: process.env.SMOKE_TARGET_METHOD ?? DEFAULTS.method,
    a2aKey: process.env.SMOKE_A2A_KEY ?? null,
    kpassBin: process.env.SMOKE_KPASS_BIN ?? 'kpass',
  };
}

/**
 * Hash an opaque identifier for traceability without leaking value (CD-6).
 */
function hashId(value) {
  if (!value || typeof value !== 'string') return null;
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/**
 * Test hook: load kpass mock fixture once.
 */
let __kpassFixture = null;
function getKpassFixture() {
  if (__kpassFixture !== null) return __kpassFixture;
  const path = process.env.SMOKE_KPASS_MOCK_FILE;
  if (!path) {
    __kpassFixture = false;
    return false;
  }
  try {
    __kpassFixture = JSON.parse(readFileSync(path, 'utf8'));
    return __kpassFixture;
  } catch (err) {
    throw new Error(
      `failed to load SMOKE_KPASS_MOCK_FILE=${path}: ${err.message}`,
    );
  }
}

/**
 * Test hook: load fetch mock fixture once (Path A).
 */
let __fetchFixture = null;
function getFetchFixture() {
  if (__fetchFixture !== null) return __fetchFixture;
  const path = process.env.SMOKE_FETCH_MOCK_FILE;
  if (!path) {
    __fetchFixture = false;
    return false;
  }
  try {
    __fetchFixture = JSON.parse(readFileSync(path, 'utf8'));
    return __fetchFixture;
  } catch (err) {
    throw new Error(
      `failed to load SMOKE_FETCH_MOCK_FILE=${path}: ${err.message}`,
    );
  }
}

/**
 * Build a stable lookup key from kpass args (positional tokens before first --).
 */
function mockKey(args) {
  const positional = [];
  for (const a of args) {
    if (typeof a !== 'string') continue;
    if (a.startsWith('--')) break;
    positional.push(a);
  }
  return positional.join(' ');
}

/**
 * Run kpass with given args. Returns parsed JSON output.
 * If SMOKE_KPASS_MOCK_FILE is set, looks up from the fixture (no real binary).
 */
function kpassRun(bin, args) {
  const fullArgs = [...args, '--output', 'json'];
  const fixture = getKpassFixture();

  if (fixture && typeof fixture === 'object') {
    const key = mockKey(fullArgs);
    const entry = fixture[key];
    if (!entry) {
      throw new Error(`mock fixture missing entry for key: "${key}"`);
    }
    let resolved = entry;
    if (Array.isArray(entry.responses)) {
      const idx = entry.__cursor__ ?? 0;
      if (idx >= entry.responses.length) {
        throw new Error(`mock fixture exhausted for key: "${key}"`);
      }
      resolved = entry.responses[idx];
      entry.__cursor__ = idx + 1;
    }
    if (resolved.throw) {
      throw new Error(resolved.throw);
    }
    const status = resolved.status ?? 0;
    const stdout = resolved.stdout ?? '';
    try {
      return { json: JSON.parse(stdout), exitStatus: status };
    } catch {
      throw new Error(`kpass CLI exit ${status}: non-JSON output`);
    }
  }

  try {
    const out = execFileSync(bin, fullArgs, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { json: JSON.parse(out), exitStatus: 0 };
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'status' in err &&
      err.status !== null
    ) {
      const stdout = err.stdout?.toString?.() ?? '';
      try {
        return { json: JSON.parse(stdout), exitStatus: err.status };
      } catch {
        throw new Error(`kpass CLI exit ${err.status}: non-JSON output`);
      }
    }
    throw new Error(`kpass CLI failure: ${err?.message ?? 'unknown error'}`);
  }
}

/**
 * Path A fetch — real fetch() unless SMOKE_FETCH_MOCK_FILE is set (test hook).
 * Returns { status }.
 */
async function fetchPathA(cfg) {
  const fixture = getFetchFixture();
  if (fixture && typeof fixture === 'object') {
    return { status: fixture.status ?? 0 };
  }
  const res = await fetch(cfg.url, {
    method: cfg.method,
    headers: {
      'Content-Type': 'application/json',
      'x-a2a-key': cfg.a2aKey,
    },
    body: cfg.method === 'GET' ? undefined : cfg.body,
  });
  return { status: res.status };
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function progress(msg) {
  process.stderr.write(`[smoke] ${msg}\n`);
}

async function main() {
  const cfg = readEnv();

  // --- Config gate: target URL is required (CD-6: no default) --------------
  if (!cfg.url) {
    emit({
      status: 'runtime_error',
      stage: 'config',
      error: 'SMOKE_TARGET_URL is required (no default)',
    });
    process.exit(3);
  }

  progress(
    `target=${cfg.url} method=${cfg.method} a2a_key_hash=${hashId(cfg.a2aKey) ?? 'n/a'}`,
  );

  // --- Path A: Agent Key (x-a2a-key) --------------------------------------
  progress('Path A — Agent Key...');
  if (!cfg.a2aKey) {
    emit({
      status: 'human_gate_required',
      path: 'agent_key',
      reason: 'missing_a2a_key',
      next_step: 'Set SMOKE_A2A_KEY env var to a valid wasi_a2a_* key',
    });
    process.exit(1);
  }

  let pathAStatus;
  try {
    const resA = await fetchPathA(cfg);
    pathAStatus = resA.status;
  } catch (err) {
    emit({ status: 'runtime_error', stage: 'path_a_fetch', error: err.message });
    process.exit(3);
  }
  emit({ event: 'path_a', http_status: pathAStatus });
  if (pathAStatus !== 200) {
    emit({
      status: 'test_failure',
      path: 'agent_key',
      http_status: pathAStatus,
    });
    process.exit(2);
  }

  // --- Path B: Passport (x402 via kpass → canonical X-PAYMENT) -------------
  progress('Path B — Passport (X-PAYMENT alias)...');
  let sessions;
  try {
    sessions = kpassRun(cfg.kpassBin, [
      'agent:session',
      'list',
      '--status',
      'active',
    ]);
  } catch (err) {
    emit({
      status: 'runtime_error',
      stage: 'session_list',
      error: err.message,
    });
    process.exit(3);
  }

  const sessionList = sessions.json?.sessions ?? [];
  const active = sessionList.filter((s) => s?.status === 'active');
  if (active.length === 0) {
    emit({
      status: 'human_gate_required',
      path: 'passport',
      reason: 'no_active_session',
      next_step:
        'Run: kpass agent:session create --ttl 24h --max-amount-per-tx 0.10 --max-total-amount 5.00 --assets USDC --payment-approach x402  → click approval URL → approve via passkey',
    });
    process.exit(1);
  }
  const sessionIdHash = hashId(
    active[0]?.id ?? active[0]?.session_id ?? '',
  );
  progress(
    `active session(s): ${active.length} session_id_hash=${sessionIdHash ?? 'n/a'}`,
  );

  let exec;
  try {
    exec = kpassRun(cfg.kpassBin, [
      'agent:session',
      'execute',
      '--url',
      cfg.url,
      '--method',
      cfg.method,
      '--headers',
      JSON.stringify({ 'Content-Type': 'application/json' }),
      '--body',
      cfg.body,
    ]);
  } catch (err) {
    emit({ status: 'runtime_error', stage: 'execute', error: err.message });
    process.exit(3);
  }
  const execStatus = exec.json?.status;
  emit({ event: 'path_b', kpass_status: execStatus });
  if (execStatus !== 'success') {
    emit({
      status: 'test_failure',
      path: 'passport',
      kpass_status: execStatus ?? null,
      kpass_error_code: exec.json?.error?.code ?? null,
    });
    process.exit(2);
  }

  // --- Both paths PASS -----------------------------------------------------
  emit({
    status: 'success',
    target: cfg.url,
    path_a: { auth: 'agent_key', http_status: pathAStatus },
    path_b: { auth: 'passport', kpass_status: execStatus },
    session_id_hash: sessionIdHash,
    timestamp: new Date().toISOString(),
  });
  process.exit(0);
}

main().catch((err) => {
  emit({
    status: 'runtime_error',
    stage: 'main',
    error: err?.message ?? String(err),
  });
  process.exit(3);
});
