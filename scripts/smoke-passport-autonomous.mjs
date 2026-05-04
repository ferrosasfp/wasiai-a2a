#!/usr/bin/env node
/**
 * @file smoke-passport-autonomous.mjs
 * @description Autonomous Passport x402 smoke runner (WKH-92).
 *
 * Reuses a pre-approved kpass session — no human intervention at runtime.
 *
 * Bootstrapping (once per ~24h, requires passkey):
 *   kpass agent:session create \
 *     --ttl 24h \
 *     --max-amount-per-tx 0.10 \
 *     --max-total-amount 5.00 \
 *     --assets USDC \
 *     --payment-approach x402
 *   # → click approval URL → approve via passkey
 *
 * Autonomous invocation (CI / cron, no human):
 *   node scripts/smoke-passport-autonomous.mjs
 *
 * Env vars (with defaults from work-item AC-4):
 *   SMOKE_TARGET_URL        Default: https://parallelmpp.dev/api/search
 *   SMOKE_TARGET_BODY       Default: {"objective":"latest news on crypto"}
 *   SMOKE_TARGET_METHOD     Default: POST
 *   EXPECTED_COST_USDC      Default: 0.01
 *   MIN_BALANCE_USDC        Default: 0.05
 *   BALANCE_TOLERANCE_PCT   Default: 1   (% of EXPECTED_COST_USDC, per DT-3)
 *   SMOKE_KPASS_BIN         Default: kpass   (override for tests)
 *   SMOKE_KPASS_MOCK_FILE   Default: unset   (test hook — JSON file mapping
 *                                              `<subcommand>` keys to {stdout,status})
 *
 * Exit codes (DT-4):
 *   0 = full smoke PASS (HTTP 200 implicit + balance diff within tolerance)
 *   1 = human gate required (no active session OR insufficient balance)
 *   2 = smoke assertion failure (HTTP non-200 OR balance diff outside tolerance)
 *   3 = runtime error (kpass CLI missing, JSON parse failure, unexpected output)
 *
 * Output channels (AC-5):
 *   stdout: structured JSON only ({status, ...})
 *   stderr: human progress messages only (no secrets)
 *
 * Constraint Directives (from work-item):
 *   CD-WKH69-5  No hardcoded tokens / JWTs / session credentials
 *   CD-WKH75-15 No JWT/agent_token/session_id plaintext in logs (only sha256 first-8)
 *   CD-WKH92-1  kpass CLI only — no Passport reimplementation
 *   CD-WKH92-2  No literal jwt/agent_token/session_id/authorization values logged
 *   CD-WKH92-3  Idempotent — N runs → N independent smoke results
 *   CD-WKH92-4  Tests use subprocess stub (no real HTTP, no real kpass binary)
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const DEFAULTS = {
  url: 'https://parallelmpp.dev/api/search',
  body: '{"objective":"latest news on crypto"}',
  method: 'POST',
  expectedCost: '0.01',
  minBalance: '0.05',
  tolerancePct: '1',
};

function readEnv() {
  return {
    url: process.env.SMOKE_TARGET_URL ?? DEFAULTS.url,
    body: process.env.SMOKE_TARGET_BODY ?? DEFAULTS.body,
    method: process.env.SMOKE_TARGET_METHOD ?? DEFAULTS.method,
    expectedCost: parseFloat(process.env.EXPECTED_COST_USDC ?? DEFAULTS.expectedCost),
    minBalance: parseFloat(process.env.MIN_BALANCE_USDC ?? DEFAULTS.minBalance),
    tolerancePct: parseFloat(process.env.BALANCE_TOLERANCE_PCT ?? DEFAULTS.tolerancePct),
    kpassBin: process.env.SMOKE_KPASS_BIN ?? 'kpass',
  };
}

/**
 * Hash an opaque identifier for traceability without leaking value (CD-WKH92-2).
 */
function hashId(value) {
  if (!value || typeof value !== 'string') return null;
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/**
 * Test hook: load mock fixture once. Maps a stable lookup-key (joined args
 * minus flag values) to {stdout, status}. CD-WKH92-4: tests use this so
 * neither real kpass nor real HTTP is invoked.
 */
let __mockFixture = null;
function getMockFixture() {
  if (__mockFixture !== null) return __mockFixture;
  const path = process.env.SMOKE_KPASS_MOCK_FILE;
  if (!path) {
    __mockFixture = false;
    return false;
  }
  try {
    __mockFixture = JSON.parse(readFileSync(path, 'utf8'));
    return __mockFixture;
  } catch (err) {
    throw new Error(`failed to load SMOKE_KPASS_MOCK_FILE=${path}: ${err.message}`);
  }
}

/**
 * Build a stable lookup key from kpass args. We key on the leading positional
 * subcommand tokens (those that do not start with '--'), so callers' fixtures
 * stay readable: e.g. `agent:session list`, `wallet balance`,
 * `agent:session execute`.
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
 * If SMOKE_KPASS_MOCK_FILE is set, looks up the response from the fixture
 * instead of invoking the real binary (CD-WKH92-4).
 */
function kpassRun(bin, args) {
  const fullArgs = [...args, '--output', 'json'];
  const fixture = getMockFixture();

  if (fixture && typeof fixture === 'object') {
    const key = mockKey(fullArgs);
    const entry = fixture[key];
    if (!entry) {
      throw new Error(`mock fixture missing entry for key: "${key}"`);
    }
    // Support per-call queue: { responses: [r1, r2, ...] }
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
    if (status !== 0) {
      try {
        return { json: JSON.parse(stdout), exitStatus: status };
      } catch {
        throw new Error(`kpass CLI exit ${status}: non-JSON output`);
      }
    }
    return { json: JSON.parse(stdout), exitStatus: 0 };
  }

  try {
    const out = execFileSync(bin, fullArgs, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { json: JSON.parse(out), exitStatus: 0 };
  } catch (err) {
    if (err && typeof err === 'object' && 'status' in err && err.status !== null) {
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

function findUsdcBalance(balanceJson) {
  const assets = balanceJson?.assets ?? [];
  const usdc = assets.find((a) => a?.symbol === 'USDC');
  if (!usdc) return null;
  return parseFloat(usdc.balance ?? '0');
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function progress(msg) {
  process.stderr.write(`[smoke] ${msg}\n`);
}

async function main() {
  const cfg = readEnv();
  progress(
    `target=${cfg.url} method=${cfg.method} expectedCost=${cfg.expectedCost} minBalance=${cfg.minBalance} tolerancePct=${cfg.tolerancePct}`,
  );

  // --- Step 1: verify session active (AC-2) -------------------------------
  progress('checking active session...');
  let sessions;
  try {
    sessions = kpassRun(cfg.kpassBin, ['agent:session', 'list', '--status', 'active']);
  } catch (err) {
    emit({ status: 'runtime_error', stage: 'session_list', error: err.message });
    process.exit(3);
  }

  const sessionList = sessions.json?.sessions ?? [];
  const active = sessionList.filter((s) => s?.status === 'active');
  if (active.length === 0) {
    emit({
      status: 'human_gate_required',
      reason: 'no_active_session',
      next_step:
        'Run: kpass agent:session create --ttl 24h --max-amount-per-tx 0.10 --max-total-amount 5.00 --assets USDC --payment-approach x402  → click approval URL → approve via passkey',
    });
    process.exit(1);
  }
  // Emit only hashed session id for traceability (CD-WKH92-2)
  const sessionIdHash = hashId(active[0]?.id ?? active[0]?.session_id ?? '');
  progress(`active session(s): ${active.length} session_id_hash=${sessionIdHash ?? 'n/a'}`);

  // --- Step 2: pre-balance (AC-3.1, AC-4) ---------------------------------
  progress('capturing pre-balance...');
  let balPre;
  try {
    balPre = kpassRun(cfg.kpassBin, ['wallet', 'balance']);
  } catch (err) {
    emit({ status: 'runtime_error', stage: 'pre_balance', error: err.message });
    process.exit(3);
  }
  const usdcPre = findUsdcBalance(balPre.json);
  if (usdcPre === null) {
    emit({ status: 'runtime_error', stage: 'pre_balance', error: 'no USDC asset found in wallet balance response' });
    process.exit(3);
  }
  emit({ event: 'pre_balance', usdc: usdcPre });
  if (usdcPre < cfg.minBalance) {
    emit({
      status: 'insufficient_balance',
      reason: 'pre_balance_below_min',
      pre_balance_usdc: usdcPre,
      min_required_usdc: cfg.minBalance,
      next_step: 'Top up USDC in Passport wallet before running smoke',
    });
    process.exit(1);
  }

  // --- Step 3: execute x402 against target (AC-3.2) -----------------------
  progress('executing x402 against target...');
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
  emit({ event: 'execute', status: execStatus });
  if (execStatus !== 'success') {
    emit({
      status: 'test_failure',
      stage: 'execute',
      kpass_status: execStatus ?? null,
      kpass_error_code: exec.json?.error?.code ?? null,
    });
    process.exit(2);
  }

  // --- Step 4: post-balance & tolerance check (AC-3.3, AC-3.4, DT-3) -----
  progress('capturing post-balance...');
  let balPost;
  try {
    balPost = kpassRun(cfg.kpassBin, ['wallet', 'balance']);
  } catch (err) {
    emit({ status: 'runtime_error', stage: 'post_balance', error: err.message });
    process.exit(3);
  }
  const usdcPost = findUsdcBalance(balPost.json);
  if (usdcPost === null) {
    emit({ status: 'runtime_error', stage: 'post_balance', error: 'no USDC asset found in wallet balance response' });
    process.exit(3);
  }
  emit({ event: 'post_balance', usdc: usdcPost });

  const diff = Number((usdcPre - usdcPost).toFixed(6));
  const expected = cfg.expectedCost;
  const tolerance = Number(((expected * cfg.tolerancePct) / 100).toFixed(6));
  const diffOk = Math.abs(diff - expected) <= tolerance;

  const final = {
    status: diffOk ? 'success' : 'test_failure',
    target: cfg.url,
    pre_balance_usdc: usdcPre,
    post_balance_usdc: usdcPost,
    balance_diff_usdc: diff,
    expected_cost_usdc: expected,
    tolerance_usdc: tolerance,
    diff_within_tolerance: diffOk,
    http_status: 200,
    session_id_hash: sessionIdHash,
    timestamp: new Date().toISOString(),
  };
  emit(final);
  process.exit(diffOk ? 0 : 2);
}

main().catch((err) => {
  emit({ status: 'runtime_error', stage: 'main', error: err?.message ?? String(err) });
  process.exit(3);
});
