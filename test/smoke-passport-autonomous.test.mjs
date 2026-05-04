/**
 * @file smoke-passport-autonomous.test.mjs
 * @description Tests for scripts/smoke-passport-autonomous.mjs (WKH-92).
 *
 * CD-WKH92-4: subprocess stub only — no real kpass binary, no real HTTP.
 * The script under test reads a JSON fixture from SMOKE_KPASS_MOCK_FILE
 * and routes every "kpass" call through that fixture. Real execFileSync
 * is never invoked because the mock branch short-circuits before it.
 *
 * AC mapping:
 *   T-SMK-01 → AC-2  (no active session → exit 1, status='human_gate_required')
 *   T-SMK-02 → AC-4  (insufficient balance → exit 1, status='insufficient_balance')
 *   T-SMK-03 → AC-3  (success path → exit 0, balance diff matches)
 *   T-SMK-04 → AC-3 / DT-4  (execute returns non-success → exit 2)
 *   T-SMK-05 → AC-3.4 / DT-3 (balance diff outside tolerance → exit 2)
 *   T-SMK-06 → AC-5 / CD-WKH92-2 / DT-4 (kpass throws → exit 3 + no secret leak)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_PATH = resolve(__filename, '../../scripts/smoke-passport-autonomous.mjs');

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'smoke-wkh92-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Helper: write the fixture and run the script under controlled env.
 * Returns {status, stdout, stderr, json}.
 */
function runScript(fixture, extraEnv = {}) {
  const fixturePath = join(tmpDir, 'fixture.json');
  writeFileSync(fixturePath, JSON.stringify(fixture), 'utf8');

  const result = spawnSync(
    process.execPath,
    [SCRIPT_PATH],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        SMOKE_KPASS_MOCK_FILE: fixturePath,
        // Keep defaults aligned with work-item AC-4
        SMOKE_TARGET_URL: 'https://parallelmpp.dev/api/search',
        SMOKE_TARGET_BODY: '{"objective":"smoke ping"}',
        EXPECTED_COST_USDC: '0.01',
        MIN_BALANCE_USDC: '0.05',
        BALANCE_TOLERANCE_PCT: '1',
        ...extraEnv,
      },
    },
  );

  // Parse the LAST JSON object on stdout (final verdict). The script may emit
  // intermediate event objects (pre_balance, execute, post_balance) plus the
  // final result; we want the final result to assert.
  const stdoutChunks = (result.stdout ?? '').trim();
  let lastJson = null;
  if (stdoutChunks.length > 0) {
    // Split on top-level "}\n{" boundaries — JSON.stringify(..., 2) ends each
    // object with a newline, so simple split-by-blank-line works.
    const objs = stdoutChunks.split(/\n(?=\{)/);
    try {
      lastJson = JSON.parse(objs[objs.length - 1]);
    } catch {
      lastJson = null;
    }
  }

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    json: lastJson,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_NO_SESSION = {
  'agent:session list': {
    status: 0,
    stdout: JSON.stringify({ sessions: [] }),
  },
};

const FIXTURE_INSUFFICIENT_BAL = {
  'agent:session list': {
    status: 0,
    stdout: JSON.stringify({
      sessions: [{ id: 'sess_abc123_DO_NOT_LOG', status: 'active' }],
    }),
  },
  'wallet balance': {
    status: 0,
    stdout: JSON.stringify({
      assets: [{ symbol: 'USDC', balance: '0.01' }], // below MIN_BALANCE_USDC=0.05
    }),
  },
};

function fixtureSuccess(opts = {}) {
  const pre = opts.pre ?? '0.50';
  const post = opts.post ?? '0.49'; // diff = 0.01, exactly EXPECTED_COST_USDC
  let balanceCallCount = 0;
  // Two distinct balance fixtures — one for pre, one for post. We encode this
  // with a small inline trick: the script issues `wallet balance` twice in
  // sequence, so we provide a queue-style fixture using key-suffix '#N'. The
  // script doesn't know about that suffix, so we instead stage two fixtures
  // and pick at random — simpler: provide just one entry that the script
  // reads twice. To get a real diff, we vary the response across calls by
  // using the special key 'wallet balance' but with __sequence__: [pre, post].
  return {
    'agent:session list': {
      status: 0,
      stdout: JSON.stringify({
        sessions: [{ id: 'sess_DO_NOT_LOG_xyz789', status: 'active' }],
      }),
    },
    // The script's mock loader does not support sequences out of the box; we
    // therefore stub two separate calls using a small two-step trick: we set
    // pre-balance equal to post-balance and instead use BALANCE_TOLERANCE_PCT
    // and EXPECTED_COST_USDC env to validate the math — see notes per test.
    'wallet balance': {
      status: 0,
      stdout: JSON.stringify({
        assets: [{ symbol: 'USDC', balance: pre }],
      }),
    },
    'agent:session execute': {
      status: 0,
      stdout: JSON.stringify({ status: 'success', http_status: 200 }),
    },
  };
}

// We need pre vs post variation; extend the script's mock to support a
// per-call queue. We do this by writing TWO fixture files and re-running — or
// by wrapping the script through a small env-based counter. Instead, the
// cleanest route is to extend the fixture format to support arrays under each
// key, and have the script consume them in order. The script supports this
// via the `responses` array convention below.

function fixtureSuccessWithBalances(preStr, postStr) {
  return {
    'agent:session list': {
      status: 0,
      stdout: JSON.stringify({
        sessions: [{ id: 'sess_OPAQUE_ID_DO_NOT_LOG', status: 'active' }],
      }),
    },
    'wallet balance': {
      // multi-call: array consumed in order
      responses: [
        { status: 0, stdout: JSON.stringify({ assets: [{ symbol: 'USDC', balance: preStr }] }) },
        { status: 0, stdout: JSON.stringify({ assets: [{ symbol: 'USDC', balance: postStr }] }) },
      ],
    },
    'agent:session execute': {
      status: 0,
      stdout: JSON.stringify({ status: 'success', http_status: 200 }),
    },
  };
}

function fixtureExecuteFailure() {
  return {
    'agent:session list': {
      status: 0,
      stdout: JSON.stringify({
        sessions: [{ id: 'sess_OPAQUE_DO_NOT_LOG', status: 'active' }],
      }),
    },
    'wallet balance': {
      status: 0,
      stdout: JSON.stringify({ assets: [{ symbol: 'USDC', balance: '0.50' }] }),
    },
    'agent:session execute': {
      status: 0,
      // kpass returns JSON status='error'
      stdout: JSON.stringify({ status: 'error', error: { code: 'PAYMENT_REJECTED' } }),
    },
  };
}

function fixtureKpassThrows() {
  return {
    'agent:session list': {
      throw: 'ENOENT: kpass binary not found',
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WKH-92 smoke-passport-autonomous', () => {
  it('T-SMK-01: no active session → exit 1, status=human_gate_required, no JWT leak', () => {
    const r = runScript(FIXTURE_NO_SESSION);
    expect(r.status).toBe(1);
    expect(r.json).toMatchObject({
      status: 'human_gate_required',
      reason: 'no_active_session',
    });
    expect(r.json.next_step).toMatch(/kpass agent:session create/);
    // CD-WKH92-2: no secret-shaped strings on stdout/stderr.
    expect(r.stdout).not.toMatch(/jwt/i);
    expect(r.stdout).not.toMatch(/agent_token/i);
    expect(r.stdout).not.toMatch(/authorization:/i);
    expect(r.stderr).not.toMatch(/jwt/i);
    expect(r.stderr).not.toMatch(/agent_token/i);
  });

  it('T-SMK-02: insufficient pre-balance → exit 1, status=insufficient_balance', () => {
    const r = runScript(FIXTURE_INSUFFICIENT_BAL);
    expect(r.status).toBe(1);
    expect(r.json).toMatchObject({
      status: 'insufficient_balance',
      reason: 'pre_balance_below_min',
      pre_balance_usdc: 0.01,
      min_required_usdc: 0.05,
    });
    expect(r.json.next_step).toMatch(/Top up USDC/);
    // Session id MUST NOT appear plaintext anywhere in output.
    expect(r.stdout).not.toContain('sess_abc123_DO_NOT_LOG');
    expect(r.stderr).not.toContain('sess_abc123_DO_NOT_LOG');
  });

  it('T-SMK-03: success path with diff exactly matching expected → exit 0', () => {
    // pre=0.50 post=0.49 → diff=0.01 == EXPECTED_COST_USDC=0.01 → within 1% tol
    const r = runScript(fixtureSuccessWithBalances('0.50', '0.49'));
    expect(r.status).toBe(0);
    expect(r.json).toMatchObject({
      status: 'success',
      pre_balance_usdc: 0.5,
      post_balance_usdc: 0.49,
      diff_within_tolerance: true,
      http_status: 200,
    });
    expect(r.json.balance_diff_usdc).toBeCloseTo(0.01, 6);
    expect(r.json.expected_cost_usdc).toBe(0.01);
    // session id never plaintext
    expect(r.stdout).not.toContain('sess_OPAQUE_ID_DO_NOT_LOG');
    expect(r.stderr).not.toContain('sess_OPAQUE_ID_DO_NOT_LOG');
    // session_id_hash IS present (8 hex chars) — traceability without leak
    expect(r.json.session_id_hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('T-SMK-04: kpass execute returns status=error → exit 2, status=test_failure', () => {
    const r = runScript(fixtureExecuteFailure());
    expect(r.status).toBe(2);
    expect(r.json).toMatchObject({
      status: 'test_failure',
      stage: 'execute',
      kpass_status: 'error',
      kpass_error_code: 'PAYMENT_REJECTED',
    });
  });

  it('T-SMK-05: balance diff outside tolerance → exit 2, diff_within_tolerance=false', () => {
    // pre=0.50 post=0.40 → diff=0.10, expected=0.01, tol=0.01*1%=0.0001 → outside
    const r = runScript(fixtureSuccessWithBalances('0.50', '0.40'));
    expect(r.status).toBe(2);
    expect(r.json).toMatchObject({
      status: 'test_failure',
      diff_within_tolerance: false,
      expected_cost_usdc: 0.01,
    });
    expect(r.json.balance_diff_usdc).toBeCloseTo(0.1, 6);
  });

  it('T-SMK-06: kpass CLI throws (ENOENT) → exit 3, status=runtime_error, no leak', () => {
    const r = runScript(fixtureKpassThrows());
    expect(r.status).toBe(3);
    expect(r.json).toMatchObject({
      status: 'runtime_error',
      stage: 'session_list',
    });
    expect(r.json.error).toMatch(/ENOENT|kpass/);
    // CD-WKH92-2: even on errors, no secret-shaped strings emitted.
    expect(r.stdout).not.toMatch(/jwt/i);
    expect(r.stdout).not.toMatch(/agent_token/i);
  });
});
