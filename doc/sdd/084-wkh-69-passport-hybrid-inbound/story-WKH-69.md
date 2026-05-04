# Story File — WKH-69 [KITE-PASSPORT] Model B Hybrid (Passport inbound + operator outbound)

> Self-contained F3 contract. **Do NOT read** `work-item.md` or `sdd.md`.
> This file is the ONLY input you need to implement WKH-69.
> If something is missing or ambiguous, STOP and escalate — do not invent.

---

## Section 0 — Context (read first, internalize)

| Field | Value |
|-------|-------|
| HU | WKH-69 |
| Folder | `doc/sdd/084-wkh-69-passport-hybrid-inbound/` |
| Branch | `feat/084-wkh-69-passport-hybrid-inbound` (already checked out from `main` `ce393e9`) |
| Pipeline | QUALITY |
| Tests baseline | ≥ 794 tests passing (post-WKH-87 `ce393e9`). After this HU: ≥ 808 |
| Spike artefacts | `doc/sdd/spike-kite-passport/{decision-doc.md, poc-results.md, discovery-notes.md}` (read-only reference, NOT a place to edit) |
| Goal | Make `wasiai-a2a` agnostic to who funded the inbound x402 payment — Kite Passport session wallet OR raw EOA. Add telemetry tag `payment_origin`. Add opt-in `requirePassport` middleware factory. Document the user onboarding flow. NO outbound (`OPERATOR_PRIVATE_KEY`) changes. |

### What you are NOT doing in this HU

- ❌ NOT modifying `OPERATOR_PRIVATE_KEY` in any outbound settlement path (cross-chain Avalanche stays as-is).
- ❌ NOT adding a Node SDK or subprocess wrap of `kpass` CLI.
- ❌ NOT changing Railway env vars in production.
- ❌ NOT creating any DB migration (`a2a_events.metadata` is `jsonb` — extend in place).
- ❌ NOT mounting `requirePassport` in any route. You only **export** the factory + tests + doc. The human will mount it post-smoke-test.
- ❌ NOT touching `src/cron/`, `src/lib/kv.ts`, `src/lib/downstream-payment.ts`, `src/services/budget.ts`, `src/services/event.ts`, `src/adapters/kite-ozone/payment.ts`, `src/adapters/kite-ozone/chain.ts`.
- ❌ NOT adding new dependencies to `package.json`.
- ❌ NOT creating any new endpoint (REST or JSON-RPC).

### Stack reminders

- TypeScript strict, ESM imports with `.js` extension (e.g. `from './foo.js'`).
- Fastify framework, Pino logger (`request.log`), vitest tests.
- No `any` explicit. No `console.log` in production code (test/example code may use `console.warn`).

---

## Section 1 — Anti-Hallucination Checklist (verify BEFORE coding)

Run these checks **before** opening any file. If ANY fails, stop and escalate.

```bash
# 1. Confirm working branch
git branch --show-current
# Expected: feat/084-wkh-69-passport-hybrid-inbound

# 2. Baseline tests pass
npm test
# Expected: ≥ 794 passing, 0 failing

# 3. Verify exemplar files exist
test -f src/middleware/forward-key.ts && echo OK
test -f src/middleware/forward-key.test.ts && echo OK
test -f src/middleware/x402.ts && echo OK
test -f src/middleware/event-tracking.ts && echo OK
test -f src/middleware/event-tracking.test.ts && echo OK
test -f src/adapters/__tests__/payment.contract.test.ts && echo OK
test -f src/adapters/__tests__/payment.mainnet.test.ts && echo OK
test -f src/types/index.ts && echo OK
test -f .env.example && echo OK

# 4. Confirm DEFAULTS in payment.ts (lines 88-93)
grep -n 'DEFAULT_PAYMENT_TOKEN_MAINNET\|DEFAULT_EIP712_DOMAIN_NAME_MAINNET' src/adapters/kite-ozone/payment.ts
# Expected:
#   line 90: DEFAULT_PAYMENT_TOKEN_MAINNET = '0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e'
#   line 93: DEFAULT_EIP712_DOMAIN_NAME_MAINNET = 'USDC'

# 5. Confirm X402PaymentRequest interface lives at src/types/index.ts:381
grep -n 'export interface X402PaymentRequest' src/types/index.ts
# Expected: 381:export interface X402PaymentRequest {

# 6. Confirm requireForwardKey factory pattern (returns []) at line 66
grep -n 'export function requireForwardKey' src/middleware/forward-key.ts
# Expected: 66:export function requireForwardKey(): preHandlerAsyncHookHandler[] {

# 7. Confirm event-tracking metadata fields (lines 67-74)
grep -n 'endpoint:\|requestId:' src/middleware/event-tracking.ts
# Expected: line 68 endpoint:, line 73 requestId:
```

If everything OK → proceed to Wave 0.

---

## Section 2 — Wave 0 — Audit (read-only, ~15 min)

**Goal**: Confirm mainnet defaults are correct so W1 tests can rely on them. Detect drift early.

**Files to READ ONLY** (do NOT modify):

- `src/adapters/kite-ozone/payment.ts` lines 80-115
- `src/adapters/kite-ozone/chain.ts` (full file, ≤ 50 lines)
- `.env.example` lines 84-99 and 137-149 (Kite Network Selection block)

**Verify** (each line is a checkbox in your head):

- [ ] `DEFAULT_PAYMENT_TOKEN_MAINNET` value = `'0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e'`
- [ ] `DEFAULT_EIP712_DOMAIN_NAME_MAINNET` value = `'USDC'`
- [ ] `DEFAULT_TOKEN_SYMBOL_MAINNET` value = `'USDC.e'`
- [ ] `DEFAULT_PAYMENT_TOKEN_TESTNET` value = `'0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9'` (PYUSD — must NOT change)
- [ ] `DEFAULT_EIP712_DOMAIN_NAME_TESTNET` value = `'PYUSD'` (must NOT change)
- [ ] `chain.ts` exports `chainId: 2366` for mainnet and `2368` for testnet
- [ ] `.env.example` has `KITE_NETWORK=` block already documented

**Exit criteria for Wave 0**:

- All checkboxes above pass.
- Write a 5-line audit report to `doc/sdd/084-wkh-69-passport-hybrid-inbound/w0-audit.md` (template at end of this file, Section 10).
- If ANY check fails: **STOP**, escalate to human (do NOT modify `payment.ts`).

---

## Section 3 — Wave 1 — Inbound contract + Passport-shape tests (~90 min)

**Goal**: Add `request.paymentOrigin` detection to `x402.ts` (header-driven, telemetry-only). Add deterministic Passport-shape mock and tests. Cover AC-1, AC-2, AC-6, AC-8.

### 3.1 Files to create / modify

| File | Action | LOC est. |
|------|--------|----------|
| `src/middleware/x402.ts` | Modify (extend `FastifyRequest` + read header in handler) | +12 |
| `test/fixtures/passport-shape.ts` | Create (fixture builder) | ~80 |
| `src/middleware/x402.passport-shape.test.ts` | Create (4 tests) | ~200 |

### 3.2 Modification: `src/middleware/x402.ts`

**Locate** the augmentation block at lines 18-23:

```ts
declare module 'fastify' {
  interface FastifyRequest {
    paymentTxHash?: string;
    paymentVerified?: boolean;
  }
}
```

**Replace** with:

```ts
declare module 'fastify' {
  interface FastifyRequest {
    paymentTxHash?: string;
    paymentVerified?: boolean;
    /**
     * WKH-69: telemetry-only tag for inbound payment origin.
     * - 'passport' when client sends header `x-passport-session: true`
     * - 'eoa' otherwise (default for raw EOA flows, backward compatible)
     * Set by `requirePayment` handler, consumed by `event-tracking` and
     * (opt-in) by `requirePassport`. NEVER used as the sole auth signal.
     */
    paymentOrigin?: 'passport' | 'eoa';
  }
}
```

**Locate** the start of the `requirePayment` handler at line 85 (`const handler: preHandlerHookHandler = async (...) => {`).

**Insert** these lines **immediately after** the wallet-address guard block ends (after line 99, the closing `}` of the `if (!process.env.PAYMENT_WALLET_ADDRESS && !process.env.KITE_WALLET_ADDRESS)` block, BEFORE the `const resource = ...` line):

```ts
    // WKH-69: detect payment origin via header hint (telemetry-only).
    // Truthy values: 'true', '1', 'yes' (case-insensitive). Anything else (or absent) → 'eoa'.
    const sessionHeader = request.headers['x-passport-session'];
    const isPassportSession =
      typeof sessionHeader === 'string' &&
      ['true', '1', 'yes'].includes(sessionHeader.toLowerCase().trim());
    request.paymentOrigin = isPassportSession ? 'passport' : 'eoa';
```

**Do NOT** modify any other line. The adapter `verify()` / `settle()` path is **untouched** (CD-WKH69-2 backward compat).

### 3.3 New file: `test/fixtures/passport-shape.ts`

Create the directory if needed (`mkdir -p test/fixtures`).

Full file content (paste verbatim):

```ts
/**
 * Passport-shape signature fixtures (WKH-69)
 *
 * // PASSPORT-MOCK-SHAPE: structural mock — NOT a cryptographic proof.
 * // (a) Keypair derivation assumption: we use a deterministic 32-byte hex
 * //     private key and derive an EVM address via viem's privateKeyToAccount
 * //     (secp256k1). The real Kite Passport session uses base58-encoded
 * //     ed25519-style public_key (see doc/sdd/spike-kite-passport/poc-results.md
 * //     line 91-92). The exact mapping ed25519 → EVM address inside Passport
 * //     is opaque to us until the post-merge smoke-test (DT-7 of SDD #084).
 * // (b) Test field correspondence:
 * //       authorization.from   ← would map to Passport `delegation.public_key`-derived address
 * //       authorization.to     ← merchant `payTo` (KITE_WALLET_ADDRESS)
 * //       authorization.value  ← amount in wei
 * //       authorization.nonce  ← random 0x bytes
 * //       signature            ← deterministic mock 0x..ab×65
 * // (c) Open question resolved/assumed: this fixture asserts STRUCTURAL
 * //     correctness (decodeXPayment + adapter shape acceptance) only. It
 * //     does NOT validate Passport's internal signing algorithm. Real wire
 * //     shape verification is gated by smoke-test (CD-WKH69-1).
 *
 * CD-WKH69-5 compliance: NO real Passport credentials, JWTs, agent_tokens,
 * user_ids, or public_keys are hardcoded here. The deterministic key is a
 * test-only fabrication (well-known test private key from viem docs).
 */
import { privateKeyToAccount } from 'viem/accounts';

// Deterministic test-only secp256k1 private key. NOT a real Passport credential.
// Same key used in src/adapters/__tests__/payment.contract.test.ts.
const TEST_SESSION_PRIVATE_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;

const TEST_SESSION_ACCOUNT = privateKeyToAccount(TEST_SESSION_PRIVATE_KEY);

export const PASSPORT_SESSION_ADDRESS = TEST_SESSION_ACCOUNT.address;

export interface PassportShapeOpts {
  from?: string;
  to?: string;
  value?: string;
  nonce?: string;
  network?: string;
}

/**
 * Build a base64-encoded `payment-signature` header value with a Passport-
 * shape authorization (deterministic `from` derived from a test keypair).
 *
 * @returns object with `headers` to spread into app.inject() AND the raw
 *   `paymentRequest` for assertions.
 */
export function buildPassportPaymentHeader(opts: PassportShapeOpts = {}): {
  headers: Record<string, string>;
  paymentRequest: {
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    };
    signature: string;
    network?: string;
  };
} {
  const paymentRequest = {
    authorization: {
      from: opts.from ?? PASSPORT_SESSION_ADDRESS,
      to: opts.to ?? '0x000000000000000000000000000000000000dEaD',
      value: opts.value ?? '1000000', // 1 USDC (6 decimals)
      validAfter: '0',
      validBefore: String(Math.floor(Date.now() / 1000) + 600), // +10 min
      nonce:
        opts.nonce ??
        '0x0000000000000000000000000000000000000000000000000000000000000001',
    },
    // Deterministic 0x{ab repeated 65 times} — matches mock signTypedData
    // pattern in payment.contract.test.ts.
    signature: `0x${'ab'.repeat(65)}`,
    network: opts.network ?? 'kite-mainnet',
  };
  const base64 = Buffer.from(JSON.stringify(paymentRequest), 'utf8').toString(
    'base64',
  );
  return {
    headers: {
      'payment-signature': base64,
      'x-passport-session': 'true',
    },
    paymentRequest,
  };
}

/**
 * Same shape but WITHOUT the `x-passport-session` header — simulates a raw
 * EOA path for backward-compat tests (AC-8).
 */
export function buildEoaPaymentHeader(opts: PassportShapeOpts = {}): {
  headers: Record<string, string>;
  paymentRequest: {
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    };
    signature: string;
    network?: string;
  };
} {
  const result = buildPassportPaymentHeader(opts);
  // Strip the Passport hint header.
  const { 'x-passport-session': _omit, ...rest } = result.headers;
  return { headers: rest, paymentRequest: result.paymentRequest };
}
```

### 3.4 New file: `src/middleware/x402.passport-shape.test.ts`

Full file content (paste verbatim):

```ts
/**
 * x402 Middleware — Passport-shape signature acceptance tests (WKH-69)
 *
 * Tests cover:
 *   - T-AC1-1: Passport-shape header → decodeXPayment parses without throw
 *   - T-AC1-2: adapter mock accepts → request.paymentOrigin === 'passport', 200
 *   - T-AC6-1: round-trip buildPassportPaymentHeader → handler consumes shape OK
 *   - T-AC8-1: no x-passport-session header → request.paymentOrigin === 'eoa'
 *
 * Strategy: Fastify in-memory + vi.mock the payment adapter registry to
 * skip real Pieverse + viem calls (we are testing middleware glue, not
 * the adapter itself — that's covered by payment.contract.test.ts).
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the adapter registry BEFORE importing the middleware.
const mockVerify = vi.fn().mockResolvedValue({ valid: true });
const mockSettle = vi
  .fn()
  .mockResolvedValue({ txHash: '0xdeadbeef', success: true });
const mockAdapter = {
  verify: (...args: unknown[]) => mockVerify(...args),
  settle: (...args: unknown[]) => mockSettle(...args),
  getToken: vi.fn().mockReturnValue('0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e'),
  getNetwork: vi.fn().mockReturnValue('kite-mainnet'),
  getScheme: vi.fn().mockReturnValue('exact'),
  getMerchantName: vi.fn().mockReturnValue('wasiai-a2a-test'),
  getMaxTimeoutSeconds: vi.fn().mockReturnValue(30),
};

vi.mock('../adapters/registry.js', () => ({
  getPaymentAdapter: () => mockAdapter,
}));

import { decodeXPayment, requirePayment } from './x402.js';
import { buildPassportPaymentHeader, buildEoaPaymentHeader } from '../../test/fixtures/passport-shape.js';

describe('x402 middleware — Passport-shape acceptance (WKH-69)', () => {
  const ORIGINAL_WALLET = process.env.KITE_WALLET_ADDRESS;

  beforeEach(() => {
    vi.clearAllMocks();
    mockVerify.mockResolvedValue({ valid: true });
    mockSettle.mockResolvedValue({ txHash: '0xdeadbeef', success: true });
    process.env.KITE_WALLET_ADDRESS =
      '0x000000000000000000000000000000000000dEaD';
  });

  afterEach(() => {
    if (ORIGINAL_WALLET === undefined) {
      delete process.env.KITE_WALLET_ADDRESS;
    } else {
      process.env.KITE_WALLET_ADDRESS = ORIGINAL_WALLET;
    }
  });

  // ── T-AC1-1: decodeXPayment parses Passport-shape header ──

  it('T-AC1-1: decodeXPayment parses Passport-shape header without throw', () => {
    const { headers } = buildPassportPaymentHeader();
    const decoded = decodeXPayment(headers['payment-signature']);
    expect(decoded.authorization).toBeDefined();
    expect(decoded.authorization.from).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(typeof decoded.signature).toBe('string');
    expect(decoded.signature).toMatch(/^0x[0-9a-fA-F]+$/);
  });

  // ── T-AC1-2: handler sets paymentOrigin='passport' on success ──

  it('T-AC1-2: x-passport-session=true → handler sets paymentOrigin=passport, 200', async () => {
    const app = Fastify();
    let capturedOrigin: string | undefined;
    app.post(
      '/test',
      { preHandler: requirePayment({ description: 'test' }) },
      async (req: FastifyRequest, reply: FastifyReply) => {
        capturedOrigin = req.paymentOrigin;
        return reply.send({ ok: true });
      },
    );
    await app.ready();

    try {
      const { headers } = buildPassportPaymentHeader();
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers,
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(capturedOrigin).toBe('passport');
      expect(mockVerify).toHaveBeenCalledTimes(1);
      expect(mockSettle).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  // ── T-AC6-1: round-trip fixture → middleware happy path ──

  it('T-AC6-1: round-trip Passport fixture → middleware accepts shape end-to-end', async () => {
    const app = Fastify();
    app.post(
      '/test',
      { preHandler: requirePayment({ description: 'test' }) },
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );
    await app.ready();

    try {
      const { headers, paymentRequest } = buildPassportPaymentHeader({
        value: '5000000', // 5 USDC
      });
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers,
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      // adapter.verify received the same authorization shape
      expect(mockVerify).toHaveBeenCalledTimes(1);
      const verifyArg = mockVerify.mock.calls[0][0] as {
        authorization: { from: string; value: string };
      };
      expect(verifyArg.authorization.from).toBe(paymentRequest.authorization.from);
      expect(verifyArg.authorization.value).toBe('5000000');
    } finally {
      await app.close();
    }
  });

  // ── T-AC8-1: no Passport header → paymentOrigin='eoa', backward compat ──

  it('T-AC8-1: no x-passport-session → handler sets paymentOrigin=eoa (backward compat)', async () => {
    const app = Fastify();
    let capturedOrigin: string | undefined;
    app.post(
      '/test',
      { preHandler: requirePayment({ description: 'test' }) },
      async (req: FastifyRequest, reply: FastifyReply) => {
        capturedOrigin = req.paymentOrigin;
        return reply.send({ ok: true });
      },
    );
    await app.ready();

    try {
      const { headers } = buildEoaPaymentHeader();
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers,
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(capturedOrigin).toBe('eoa');
    } finally {
      await app.close();
    }
  });

  // ── Edge: x-passport-session value 'false' → eoa (not truthy) ──

  it('T-AC8-2: x-passport-session=false → paymentOrigin=eoa (strict truthy parse)', async () => {
    const app = Fastify();
    let capturedOrigin: string | undefined;
    app.post(
      '/test',
      { preHandler: requirePayment({ description: 'test' }) },
      async (req: FastifyRequest, reply: FastifyReply) => {
        capturedOrigin = req.paymentOrigin;
        return reply.send({ ok: true });
      },
    );
    await app.ready();

    try {
      const { headers } = buildEoaPaymentHeader();
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers: { ...headers, 'x-passport-session': 'false' },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(capturedOrigin).toBe('eoa');
    } finally {
      await app.close();
    }
  });
});
```

### 3.5 Wave 1 Exit Criteria

- [ ] `npm test src/middleware/x402.passport-shape.test.ts` → 5 tests pass
- [ ] `npm test` full suite → ≥ 794 + 5 = ≥ 799 passing, 0 failing (no regression)
- [ ] `request.paymentOrigin` correctly toggles based on header
- [ ] No changes to `OPERATOR_PRIVATE_KEY` references
- [ ] Commit message: `feat(WKH-69 W1): paymentOrigin detection + Passport-shape tests`

---

## Section 4 — Wave 2 — Documentation (~60 min)

**Goal**: Create `doc/passport-onboarding.md` with onboarding flow, smoke test (deferred human gate), troubleshooting. Cover AC-5.

### 4.1 New file: `doc/passport-onboarding.md`

Full file content (paste verbatim — ~250 lines):

```markdown
# Kite Passport — Onboarding Guide for WasiAI A2A

> **Status**: implementation merged via WKH-69. Real E2E smoke-test is a
> post-merge human gate — see "Smoke Test" section below.

## What this enables

`wasiai-a2a` accepts inbound x402 payments from **two payer types** transparently:

1. **Raw EOA** (legacy path, default): client signs EIP-3009
   `TransferWithAuthorization` with their own private key.
2. **Kite Passport session wallet** (new): client uses `kpass agent:session
   execute` and Passport handles the 402 negotiation + signing internally.

Outbound cross-chain settlement (to Avalanche etc.) **continues to use
`OPERATOR_PRIVATE_KEY`** — unchanged. Only the inbound path is agnostic.

## Architecture (Model B Hybrid)

```
┌─────────────┐   x402 (Passport       ┌──────────────┐   x402 (operator
│ End user /  │   session signs)        │              │   key signs)
│ Passport    │ ──────────────────────► │  wasiai-a2a  │ ────────────────►  Avalanche agents
│ agent       │                         │ (orchestr.)  │                    (downstream)
└─────────────┘                         └──────────────┘
                                              │
                                              ├── reads `x-passport-session` header (telemetry hint)
                                              ├── tags `metadata.payment_origin` in a2a_events
                                              └── (optional) requirePassport guard via PASSPORT_REQUIRE_INBOUND
```

## Quickstart — user onboarding via `kpass` CLI

> Reference: https://agentpassport.ai/quickstart/

### 1. Install the `kpass` CLI

```bash
curl -sSL https://install.gokite.ai/kpass | sh
kpass --version
```

### 2. Sign up

```bash
kpass signup init --email <your-email>
# → check inbox, click verification link
kpass signup poll --signup-id <id-from-step-1> --wait
kpass signup exchange --signup-id <id> --exchange-token <token-from-email>
# → JWT stored at ~/.kite-passport/config.json
```

### 3. Register an agent

```bash
kpass agent:register --type retail --output json
# → agent credentials at ~/.kite-passport/agent.json (gitignored)
```

### 4. Create + approve a session

```bash
kpass agent:session create \
  --task-summary 'Pay wasiai-a2a orchestrate' \
  --max-amount-per-tx 2 \
  --max-total-amount 10 \
  --ttl 2h \
  --assets USDC \
  --output json
```

Response includes `approval_url` (passkey-gated). Open in browser, approve via
passkey. Then poll:

```bash
kpass agent:session status --request-id <id-from-create> --wait --output json
# → status transitions: human_action_required → ready
```

### 5. Execute a paid call

```bash
kpass agent:session execute \
  --url https://wasiai-a2a.up.railway.app/orchestrate \
  --method POST \
  --body '{"goal":"summarize","input":"hello"}' \
  --output json
```

Passport auto-handles 402 negotiation. You get a `200` with the orchestrator
response. Internally a row is inserted in `a2a_events` with
`metadata.payment_origin = 'passport'`.

## Telemetry

Every inbound request that hits a tracked endpoint
(`/discover`, `/orchestrate`, `/compose`, `/auth/agent-signup`,
`/gasless/status`) writes a row in the `a2a_events` table. WKH-69 adds a
new key inside the existing `metadata: jsonb` column:

| Field | Value | When |
|-------|-------|------|
| `metadata.payment_origin` | `'passport'` | Client sent `x-passport-session: true` (or `1` / `yes`) header |
| `metadata.payment_origin` | `'eoa'` | Header absent or any other value (default backward compat) |

**Sample query** (Supabase SQL):

```sql
SELECT
  metadata->>'payment_origin' AS origin,
  COUNT(*) AS req_count,
  AVG(latency_ms) AS avg_latency
FROM a2a_events
WHERE created_at > NOW() - INTERVAL '7 days'
  AND event_type LIKE 'request:%'
GROUP BY 1;
```

> **Caveat**: rows persisted before WKH-69 deploy do NOT have this key.
> Use `COALESCE(metadata->>'payment_origin', 'unknown')` for legacy data.

## Opt-in Passport-only enforcement (`requirePassport`)

WKH-69 exports a middleware factory `requirePassport()` from
`src/middleware/passport.ts`. **This factory is NOT mounted by default**. To
activate (per deployment, not per route):

1. Set env var `PASSPORT_REQUIRE_INBOUND=true` on Railway (or in `.env`).
   - Strict comparison: only literal `'true'` activates the guard.
   - Any other value (`'TRUE'`, `'1'`, `'yes'`, `'false'`, unset) → guard NOT mounted (factory returns `[]`).
2. Edit your route registration to add the guard AFTER `requirePayment`:

   ```ts
   // BEFORE:
   app.post('/orchestrate', { preHandler: requirePayment({...}) }, handler);

   // AFTER (Passport-only mode):
   app.post('/orchestrate', {
     preHandler: [...requirePayment({...}), ...requirePassport()],
   }, handler);
   ```

   Order matters: `requirePayment` MUST run first (it sets
   `request.paymentOrigin` from the header). `requirePassport` reads that
   field.

3. Behavior when active:
   - Request with `x-passport-session: true` → passthrough.
   - Request without it → `403 {"error":"Passport session required","error_code":"PASSPORT_REQUIRED"}`.

## Smoke Test (post-merge human gate)

> **DO NOT execute this during code review or CI. Manual ops only.**

Real wire-shape verification of a Passport-funded x402 transaction is gated
to a human run because it requires real on-chain funds. Steps:

1. **Prepare**: ensure prod Passport account `user_019de709-…` is registered
   and its session wallet `0x7aB8760225Ffd90F23bd0B5BfC5B04965976AdB3` exists
   on chain 2366 (Kite mainnet).
2. **Fund**: transfer ~$5 USDC mainnet to that wallet (chain 2366 ONLY —
   never Ethereum/Base/Solana, funds will be lost).
3. **Create session**:
   ```bash
   kpass agent:session create \
     --task-summary 'WKH-69 smoke test' \
     --max-amount-per-tx 1 \
     --max-total-amount 5 \
     --ttl 30m \
     --assets USDC \
     --output json
   ```
   Approve via passkey (open `approval_url`).
4. **Execute against prod**:
   ```bash
   kpass agent:session execute \
     --url https://wasiai-a2a.up.railway.app/orchestrate \
     --method POST \
     --body '{"goal":"echo","input":"smoke"}' \
     --output json
   ```
5. **Verify**:
   - HTTP `200` returned.
   - In Supabase `a2a_events`, find the row matching that `requestId` and
     confirm `metadata->>'payment_origin' = 'passport'`.
   - If the row instead shows `'eoa'`: it means the `kpass` CLI did NOT
     send the `x-passport-session` header — open follow-up ticket to
     either (a) ship a custom client wrapper, or (b) detect via signature
     shape heuristic. **Do NOT roll back this HU** — telemetry default
     `'eoa'` is by design.
   - If HTTP `402` returned: signature shape mismatch. Capture the raw
     `payment-signature` header value (base64), open ticket WKH-XX with
     the decoded JSON. **This is the open question post-spike** — see
     `doc/sdd/spike-kite-passport/decision-doc.md` line 168.

## Environment variables reference

| Var | Required? | Default | Purpose |
|-----|-----------|---------|---------|
| `KITE_NETWORK` | No | `testnet` | `mainnet` activates USDC + chain 2366. `testnet` keeps PYUSD + chain 2368. |
| `X402_PAYMENT_TOKEN` | No | derived from `KITE_NETWORK` | Override the EIP-3009 token contract address. Mainnet default `0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e`. |
| `X402_EIP712_DOMAIN_NAME` | No | `'USDC'` (mainnet) / `'PYUSD'` (testnet) | EIP-712 domain name used in signature verification. |
| `X402_TOKEN_SYMBOL` | No | `'USDC.e'` (mainnet) / `'PYUSD'` (testnet) | Display symbol in 402 responses. |
| `KITE_WALLET_ADDRESS` | Yes | — | Merchant `payTo` address. Service refuses to start without it. |
| `OPERATOR_PRIVATE_KEY` | Yes (outbound) | — | Cross-chain downstream signer. **Untouched by WKH-69.** |
| `PASSPORT_REQUIRE_INBOUND` | No | unset | Set to `'true'` (literal, case-sensitive) to mount `requirePassport` guard on routes that opt in. |

## Troubleshooting

### `kpass` not found

The CLI installs to `~/.local/bin` by default. Add it to PATH:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### Wrong directory `~/.kite-passport/` vs `~/.kpass/`

`kpass` uses `~/.kite-passport/` for state (NOT `.kpass/`). The CLI binary
is `kpass` but the dotfile dir is `kite-passport`. Both are gitignored in
this repo by `.gitignore` (`.kite-passport/`).

### `jq` dependency

Some `kpass` shell helpers expect `jq`. Install it:

```bash
sudo apt install jq    # debian/ubuntu
brew install jq        # macOS
```

### Staging faucet returns 500

Known Kite staging issue (unrelated to wasiai-a2a). Use mainnet for the
smoke test, or contact Kite support. Tracking issue is external.

### Telemetry shows `'eoa'` for a Passport call

Means the client did not send `x-passport-session: true`. Either:
- The `kpass` version does not auto-inject the hint header — file an issue
  with Kite or wrap `kpass execute` in a curl that adds it.
- The header value is non-truthy (`'false'`, `'0'`, etc.).

Telemetry is **not** auth — value is `'eoa'` by default and the request
still goes through (CD-WKH69-2 backward compat). Only relevant for analytics.

### `403 PASSPORT_REQUIRED` for an EOA call

Expected when `PASSPORT_REQUIRE_INBOUND=true` is set on the deployment.
Either:
- Switch the caller to Passport (preferred for hackathon demo), or
- Unset `PASSPORT_REQUIRE_INBOUND` env var on Railway and redeploy.

## Related artefacts

- Spike WKH-68: `doc/sdd/spike-kite-passport/{decision-doc.md, poc-results.md, discovery-notes.md}`
- WKH-69 SDD: `doc/sdd/084-wkh-69-passport-hybrid-inbound/sdd.md`
- WKH-69 Story File: `doc/sdd/084-wkh-69-passport-hybrid-inbound/story-WKH-69.md`
- Kite Passport quickstart: https://agentpassport.ai/quickstart/
- Kite chain explorer: https://kitescan.ai (mainnet 2366)
```

### 4.2 Wave 2 Exit Criteria

- [ ] File `doc/passport-onboarding.md` exists, is well-formed markdown.
- [ ] Sections present: Architecture, Quickstart, Telemetry, Opt-in guard, Smoke Test, Env vars, Troubleshooting, Related.
- [ ] No hardcoded JWT / secret / private key (CD-WKH69-5).
- [ ] No claim that smoke-test was executed — only documented as gate.
- [ ] Commit message: `docs(WKH-69 W2): passport onboarding + smoke-test gate`

---

## Section 5 — Wave 3 — Telemetry payment_origin (~45 min)

**Goal**: Propagate `request.paymentOrigin` to `a2a_events.metadata.payment_origin`. Cover AC-4. **CRITICAL**: do NOT break existing test count assertions.

### 5.1 Modification: `src/middleware/event-tracking.ts`

**Locate** the `metadata` object inside the `eventService.track({...})` call (lines 67-74):

```ts
          metadata: {
            endpoint: url.split('?')[0],
            method,
            statusCode,
            responseTimeMs: latencyMs,
            timestamp: new Date().toISOString(),
            requestId: request.id,
          },
```

**Replace** with:

```ts
          metadata: {
            endpoint: url.split('?')[0],
            method,
            statusCode,
            responseTimeMs: latencyMs,
            timestamp: new Date().toISOString(),
            requestId: request.id,
            // WKH-69: tag inbound payment origin (set by x402.ts middleware
            // when payment header parsed). Spread-conditional so legacy rows
            // without paymentOrigin do NOT add a key with value undefined.
            ...(request.paymentOrigin
              ? { payment_origin: request.paymentOrigin }
              : {}),
          },
```

**Do NOT** add any other change. The Fastify augmentation for `paymentOrigin` already lives in `src/middleware/x402.ts` (Wave 1) — a single `declare module 'fastify'` block is sufficient repo-wide.

### 5.2 Modification: `src/middleware/event-tracking.test.ts`

**Add 3 tests** at the END of the existing `describe('registerEventTracking middleware', () => { ... })` block, BEFORE the closing `});` of the describe.

⚠️ **CD-WKH69-7 / auto-blindaje WKH-88 warning**: existing tests use
`expect(mockTrack).toHaveBeenCalledTimes(1)` (e.g. line 111). Your new code
adds a CONDITIONAL key (`...(request.paymentOrigin ? {...} : {})`) — it does
NOT add a `track()` call. Therefore existing call-count assertions stay
valid. Verify after your change: `npm test event-tracking` → all original
tests still pass with `toHaveBeenCalledTimes(1)` intact.

Tests to append (paste verbatim, replace the FINAL `});` of the describe block):

```ts
  // ── WKH-69 AC-4: payment_origin tagging ──

  it('T-AC4-1: paymentOrigin=passport → metadata.payment_origin=passport', async () => {
    // Inject the request and use a preHandler hook to set paymentOrigin
    // before the route runs. We register a separate Fastify app to keep
    // this isolated from the shared `app` (which has no preHandler).
    const localApp = Fastify();
    registerEventTracking(localApp);
    localApp.addHook('preHandler', async (req: FastifyRequest) => {
      req.paymentOrigin = 'passport';
    });
    localApp.post(
      '/orchestrate',
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );
    await localApp.ready();

    try {
      await localApp.inject({
        method: 'POST',
        url: '/orchestrate',
        payload: {},
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(mockTrack).toHaveBeenCalledTimes(1);
      const metadata = mockTrack.mock.calls[0][0].metadata;
      expect(metadata.payment_origin).toBe('passport');
    } finally {
      await localApp.close();
    }
  });

  it('T-AC4-2: paymentOrigin=eoa → metadata.payment_origin=eoa', async () => {
    const localApp = Fastify();
    registerEventTracking(localApp);
    localApp.addHook('preHandler', async (req: FastifyRequest) => {
      req.paymentOrigin = 'eoa';
    });
    localApp.post(
      '/orchestrate',
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );
    await localApp.ready();

    try {
      await localApp.inject({
        method: 'POST',
        url: '/orchestrate',
        payload: {},
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(mockTrack).toHaveBeenCalledTimes(1);
      const metadata = mockTrack.mock.calls[0][0].metadata;
      expect(metadata.payment_origin).toBe('eoa');
    } finally {
      await localApp.close();
    }
  });

  it('T-AC4-3: paymentOrigin undefined → metadata.payment_origin key ABSENT (forward-compat)', async () => {
    // Use the shared app (no preHandler sets paymentOrigin → it stays undefined)
    await app.inject({ method: 'POST', url: '/discover', payload: {} });
    await new Promise((r) => setTimeout(r, 50));

    expect(mockTrack).toHaveBeenCalledTimes(1);
    const metadata = mockTrack.mock.calls[0][0].metadata;
    // Strict: key must be ABSENT, not present-with-undefined.
    expect('payment_origin' in metadata).toBe(false);
  });
```

### 5.3 Wave 3 Exit Criteria

- [ ] `npm test src/middleware/event-tracking.test.ts` → existing tests pass + 3 new tests pass.
- [ ] `npm test` full suite → ≥ 794 + 5 (W1) + 3 (W3) = ≥ 802 passing, 0 failing.
- [ ] No `toHaveBeenCalledTimes` count drift in pre-existing tests.
- [ ] Commit message: `feat(WKH-69 W3): tag payment_origin in a2a_events metadata`

---

## Section 6 — Wave 4 — `requirePassport` factory + .env.example (~75 min)

**Goal**: Add opt-in middleware factory + 6 tests + env var docs. Cover AC-10. **DO NOT MOUNT** the factory in any route (CD-WKH69-1, see Section 9 below).

### 6.1 New file: `src/middleware/passport.ts`

Full file content (paste verbatim):

```ts
/**
 * requirePassport Middleware — Fastify preHandler hook (WKH-69)
 *
 * Optional opt-in guard that rejects inbound x402 requests that did NOT
 * arrive with an `x-passport-session` hint header. Off by default, mounted
 * only when `PASSPORT_REQUIRE_INBOUND=true` (literal, case-sensitive).
 *
 * Behavior (env-gated, AC-10):
 *   - PASSPORT_REQUIRE_INBOUND unset / empty / any value other than 'true'
 *     → factory returns [] (NOT mounted).
 *   - PASSPORT_REQUIRE_INBOUND === 'true'
 *     → handler reads `request.paymentOrigin` (set by `requirePayment` from
 *       x402.ts upstream). If 'passport', passthrough. Otherwise (including
 *       'eoa' or undefined / misconfigured chain), 403 PASSPORT_REQUIRED.
 *
 * MUST be mounted AFTER requirePayment in the route's preHandler array,
 * because requirePayment is the producer of `request.paymentOrigin`.
 *
 * This factory follows the canonical opt-in pattern of `requireForwardKey()`
 * in src/middleware/forward-key.ts (lines 66-127).
 *
 * Logging discipline: NEVER logs the header value. Only logs the boolean
 * `paymentOrigin` for ops debugging.
 */
import type {
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from 'fastify';

const PASSPORT_REQUIRE_ENV = 'PASSPORT_REQUIRE_INBOUND';

/**
 * requirePassport middleware factory.
 *
 * @returns array of zero or one preHandlers depending on env config.
 */
export function requirePassport(): preHandlerAsyncHookHandler[] {
  // Strict literal 'true' — explicit on/off semantics, no truthy coercion
  // (matches WASIAI_DOWNSTREAM_X402 pattern in .env.example).
  if (process.env[PASSPORT_REQUIRE_ENV] !== 'true') {
    return [];
  }

  const handler: preHandlerAsyncHookHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    if (request.paymentOrigin !== 'passport') {
      // Fail-secure: undefined paymentOrigin (e.g. middleware mounted out
      // of order) gets 403 too. CD-WKH69-10.
      request.log.warn(
        { paymentOrigin: request.paymentOrigin ?? 'undefined' },
        'passport-required: rejected non-passport request',
      );
      return reply.status(403).send({
        error: 'Passport session required',
        error_code: 'PASSPORT_REQUIRED',
      });
    }
    // paymentOrigin === 'passport' → passthrough.
  };

  return [handler];
}
```

### 6.2 New file: `src/middleware/passport.test.ts`

Full file content (paste verbatim):

```ts
/**
 * requirePassport Middleware Tests — WKH-69
 *
 * Coverage (≥6 tests, AC-10):
 *   - T-AC10-1: env unset → factory returns [] (NOT mounted)
 *   - T-AC10-2: env 'true' + paymentOrigin='passport' → passthrough
 *   - T-AC10-3: env 'true' + paymentOrigin='eoa' → 403 PASSPORT_REQUIRED
 *   - T-AC10-4: env 'true' + paymentOrigin undefined → 403 (fail-secure)
 *   - T-AC10-5: env 'TRUE' (case mismatch) → factory returns [] (strict)
 *   - T-AC10-6: env 'false' or other → factory returns []
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requirePassport } from './passport.js';

describe('requirePassport middleware (WKH-69)', () => {
  const ORIGINAL_ENV = process.env.PASSPORT_REQUIRE_INBOUND;

  beforeEach(() => {
    delete process.env.PASSPORT_REQUIRE_INBOUND;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.PASSPORT_REQUIRE_INBOUND;
    } else {
      process.env.PASSPORT_REQUIRE_INBOUND = ORIGINAL_ENV;
    }
  });

  // ── T-AC10-1: env unset → not mounted ──

  it('T-AC10-1: PASSPORT_REQUIRE_INBOUND unset → factory returns []', () => {
    delete process.env.PASSPORT_REQUIRE_INBOUND;
    const handlers = requirePassport();
    expect(handlers).toEqual([]);
    expect(handlers.length).toBe(0);
  });

  // ── T-AC10-2: env 'true' + passport origin → passthrough ──

  it("T-AC10-2: env 'true' + paymentOrigin=passport → passthrough", async () => {
    process.env.PASSPORT_REQUIRE_INBOUND = 'true';

    const app = Fastify();
    app.addHook('preHandler', async (req: FastifyRequest) => {
      req.paymentOrigin = 'passport';
    });
    app.post(
      '/test',
      { preHandler: requirePassport() },
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  // ── T-AC10-3: env 'true' + eoa origin → 403 ──

  it("T-AC10-3: env 'true' + paymentOrigin=eoa → 403 PASSPORT_REQUIRED", async () => {
    process.env.PASSPORT_REQUIRE_INBOUND = 'true';

    const app = Fastify();
    app.addHook('preHandler', async (req: FastifyRequest) => {
      req.paymentOrigin = 'eoa';
    });
    app.post(
      '/test',
      { preHandler: requirePassport() },
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        payload: {},
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({
        error: 'Passport session required',
        error_code: 'PASSPORT_REQUIRED',
      });
    } finally {
      await app.close();
    }
  });

  // ── T-AC10-4: env 'true' + undefined origin → 403 (fail-secure) ──

  it("T-AC10-4: env 'true' + paymentOrigin=undefined → 403 (fail-secure)", async () => {
    process.env.PASSPORT_REQUIRE_INBOUND = 'true';

    const app = Fastify();
    // intentionally NO preHandler that sets paymentOrigin
    app.post(
      '/test',
      { preHandler: requirePassport() },
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        payload: {},
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error_code).toBe('PASSPORT_REQUIRED');
    } finally {
      await app.close();
    }
  });

  // ── T-AC10-5: env 'TRUE' (case mismatch) → not mounted ──

  it("T-AC10-5: env 'TRUE' (uppercase) → factory returns [] (strict literal)", () => {
    process.env.PASSPORT_REQUIRE_INBOUND = 'TRUE';
    const handlers = requirePassport();
    expect(handlers).toEqual([]);
  });

  // ── T-AC10-6: env 'false' or other → not mounted ──

  it("T-AC10-6: env 'false' → factory returns []", () => {
    process.env.PASSPORT_REQUIRE_INBOUND = 'false';
    expect(requirePassport()).toEqual([]);
  });

  it("T-AC10-6b: env '1' → factory returns [] (only literal 'true' activates)", () => {
    process.env.PASSPORT_REQUIRE_INBOUND = '1';
    expect(requirePassport()).toEqual([]);
  });

  it("T-AC10-6c: env empty string → factory returns []", () => {
    process.env.PASSPORT_REQUIRE_INBOUND = '';
    expect(requirePassport()).toEqual([]);
  });
});
```

### 6.3 Modification: `.env.example`

**Locate** the `WASIAI_V2_FORWARD_KEY=` line (line 39, end of the Forward-Key block).

**Insert AFTER line 39** (before the next `# ──` block separator):

```
# ─────────────────────────────────────────────────────────────
# Passport-only inbound enforcement (WKH-69) — OPTIONAL
# Opt-in guard that rejects x402 requests not originating from a
# Kite Passport session. Backward compat is preserved by default.
#
# Behavior:
#   - UNSET / empty / any value other than literal 'true' → middleware NOT
#     mounted. Both EOA and Passport requests are accepted (default).
#   - SET to literal 'true' (case-sensitive) → routes that mount
#     `requirePassport()` will reject inbound requests without
#     `x-passport-session: true` header with HTTP 403 PASSPORT_REQUIRED.
#
# Activation requires TWO steps:
#   1. Set this env var to 'true' on the deployment.
#   2. Edit the route handler to add `requirePassport()` AFTER
#      `requirePayment(...)` in the preHandler array. See
#      doc/passport-onboarding.md § "Opt-in Passport-only enforcement".
#
# Order matters: requirePayment MUST run first because it sets
# request.paymentOrigin from the header. requirePassport reads it.
#
# Pre-merge note (CD-WKH69-1): leave this UNSET in production until the
# post-merge smoke-test confirms real Passport signature shape works.
# ─────────────────────────────────────────────────────────────
PASSPORT_REQUIRE_INBOUND=
```

### 6.4 Wave 4 Exit Criteria

- [ ] `npm test src/middleware/passport.test.ts` → 8 tests pass.
- [ ] `npm test` full suite → ≥ 794 + 5 (W1) + 3 (W3) + 8 (W4) = ≥ 810 passing, 0 failing.
- [ ] `requirePassport` factory NOT mounted in any route (`grep -rn 'requirePassport()' src/routes src/index.ts src/app.ts` returns ZERO matches outside `src/middleware/passport.ts` and its test file).
- [ ] `.env.example` contains `PASSPORT_REQUIRE_INBOUND=` block.
- [ ] Commit message: `feat(WKH-69 W4): requirePassport opt-in middleware factory + tests`

---

## Section 7 — Final Wave — Full suite + readiness check (~20 min)

### 7.1 Run the full test suite

```bash
npm test
```

**Expected**:
- Total tests: ≥ 808 passing, 0 failing.
- Breakdown: 794 baseline + 5 (Wave 1) + 3 (Wave 3) + 8 (Wave 4) = 810 (allow ±2 for naming-driven duplicate detection).

### 7.2 Backward-compat audit

```bash
# 1. Verify OPERATOR_PRIVATE_KEY references unchanged
git diff main..HEAD -- src/lib/downstream-payment.ts
# Expected: NO output (file untouched)

# 2. Verify cron and KV untouched
git diff main..HEAD -- src/cron/ src/lib/kv.ts
# Expected: NO output

# 3. Verify the kite-ozone payment adapter untouched
git diff main..HEAD -- src/adapters/kite-ozone/
# Expected: NO output

# 4. Verify event service untouched
git diff main..HEAD -- src/services/event.ts
# Expected: NO output

# 5. Verify NO new dependencies in package.json
git diff main..HEAD -- package.json package-lock.json
# Expected: NO functional change (or empty)

# 6. Confirm requirePassport NOT mounted in app.ts / routes
grep -rn 'requirePassport' src/index.ts src/app.ts src/routes/ 2>/dev/null
# Expected: NO matches (factory exported but not consumed yet)
```

### 7.3 Final exit criteria

- [ ] All 6 backward-compat audit checks pass.
- [ ] `npm test` ≥ 808 passing, 0 failing.
- [ ] No `[NEEDS CLARIFICATION]` markers in any new file.
- [ ] No `TODO` / `FIXME` introduced (`grep -rn 'TODO\|FIXME' src/middleware/passport.ts src/middleware/x402.passport-shape.test.ts test/fixtures/passport-shape.ts` → empty).
- [ ] No `console.log` in production code (`grep -rn 'console.log' src/middleware/passport.ts src/middleware/x402.ts | grep -v test` → empty for new code).
- [ ] `.kite-passport/` still in `.gitignore` (not committed).

---

## Section 8 — AC mapping (test traceability)

| AC | Description | Wave | Test ID(s) | File |
|----|-------------|------|------------|------|
| AC-1 | Passport-shape signature routes through existing verify+settle path unchanged | W1 | T-AC1-1, T-AC1-2 | `x402.passport-shape.test.ts` |
| AC-2 | Mainnet 402 response asset = USDC | W0 (audit) + W1 | (audit checklist) | `payment.ts` lines 90-91 (verified read-only); `x402.passport-shape.test.ts` mockAdapter returns USDC mainnet address |
| AC-3 | Mainnet EIP-712 domain name = `'USDC'` | W0 (audit) | (audit checklist) | `payment.ts` line 93 (verified read-only); existing test `payment.mainnet.test.ts` lines ≈ 131-159 |
| AC-4 | `payment_origin` persisted in `metadata` JSONB | W3 | T-AC4-1, T-AC4-2, T-AC4-3 | `event-tracking.test.ts` |
| AC-5 | `doc/passport-onboarding.md` exists with required sections | W2 | (manual review) | `doc/passport-onboarding.md` |
| AC-6 | `npm test` includes mock Passport-shape signature test | W1 | T-AC6-1 | `x402.passport-shape.test.ts` |
| AC-7 | Zero regressions vs baseline 794 | Final | Full `npm test` | (entire suite) |
| AC-8 | Testnet PYUSD path unchanged | W1 | T-AC8-1, T-AC8-2 | `x402.passport-shape.test.ts` + existing `payment.contract.test.ts` (untouched) |
| AC-9 | Outbound `OPERATOR_PRIVATE_KEY` path unchanged | Final | Backward-compat audit step 1 | `git diff` shows no change |
| AC-10 | `PASSPORT_REQUIRE_INBOUND=true` rejects non-Passport with 403 | W4 | T-AC10-1..6c (8 tests) | `passport.test.ts` |

---

## Section 9 — Deferred items (gate humano post-merge)

The following items are explicitly **NOT** part of this HU. Do NOT attempt them in F3:

1. **E2E Smoke Test on prod with real funds**
   - Documented as procedure in `doc/passport-onboarding.md` § Smoke Test.
   - Requires ~$5 USDC mainnet on `0x7aB8760225Ffd90F23bd0B5BfC5B04965976AdB3`.
   - The human will run it post-merge; if signature shape diverges from the
     mock, follow-up ticket WKH-XX captures the delta.

2. **Mounting `requirePassport()` on production routes**
   - This HU only EXPORTS the factory. No `app.ts` or route file is modified.
   - The human will edit the relevant route after the smoke-test passes.
   - CD-WKH69-1 + CD-WKH69-10 enforce this gating.

3. **Updating Railway env vars** (`X402_PAYMENT_TOKEN`, `X402_TOKEN_SYMBOL`,
   `X402_EIP712_DOMAIN_NAME`, `KITE_NETWORK=mainnet`, `PASSPORT_REQUIRE_INBOUND=true`)
   - Documented in onboarding doc; human-driven activation.
   - CD-WKH69-1 prohibits this in F3.

4. **Detecting Passport sessions via signature-shape inference**
   - Spike WKH-68 explicitly rejected this. The header hint is the canonical
     mechanism. If the smoke-test reveals `kpass` does NOT inject the header,
     follow-up ticket evaluates either (a) wrapper script or (b) inference.
     Out of scope here.

5. **Dashboard analytics breakdown by `payment_origin`**
   - Future HU consumes the new `metadata.payment_origin` key. Out of scope.

---

## Section 10 — `w0-audit.md` template (write at end of Wave 0)

Path: `doc/sdd/084-wkh-69-passport-hybrid-inbound/w0-audit.md`

Content (5-7 lines, fill in `<...>`):

```markdown
# Wave 0 Audit — WKH-69 (read-only)

Date: <YYYY-MM-DD>
Branch: feat/084-wkh-69-passport-hybrid-inbound

| Check | Expected | Actual | Status |
|-------|----------|--------|--------|
| `DEFAULT_PAYMENT_TOKEN_MAINNET` | `0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e` | `<value>` | OK / DRIFT |
| `DEFAULT_EIP712_DOMAIN_NAME_MAINNET` | `'USDC'` | `<value>` | OK / DRIFT |
| `DEFAULT_TOKEN_SYMBOL_MAINNET` | `'USDC.e'` | `<value>` | OK / DRIFT |
| `DEFAULT_PAYMENT_TOKEN_TESTNET` | `0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9` | `<value>` | OK / DRIFT |
| `DEFAULT_EIP712_DOMAIN_NAME_TESTNET` | `'PYUSD'` | `<value>` | OK / DRIFT |
| `chain.ts` mainnet chainId | `2366` | `<value>` | OK / DRIFT |
| `chain.ts` testnet chainId | `2368` | `<value>` | OK / DRIFT |

Conclusion: <"all defaults correct, proceed to W1" | "DRIFT detected, escalate before W1">
```

---

## Section 11 — Done Definition (entire HU)

The HU is DONE when ALL of the following are true:

- [ ] All 5 waves (W0..W4 + Final) completed.
- [ ] All wave exit criteria satisfied.
- [ ] `npm test` shows ≥ 808 passing, 0 failing.
- [ ] All AC-1..AC-10 mapped to tests in Section 8.
- [ ] `doc/sdd/084-wkh-69-passport-hybrid-inbound/w0-audit.md` exists.
- [ ] `doc/passport-onboarding.md` exists.
- [ ] No file outside the Scope IN list has been modified (verify with `git diff --stat main..HEAD`).
- [ ] All commits scoped per wave with format `feat(WKH-69 W{N}): <summary>` or `docs(WKH-69 W2): <summary>`.
- [ ] Final commit hash + branch ready for `nexus-adversary` AR (Phase 5).

---

## Constraint Directives (anchor — do not violate)

| ID | Directive |
|----|-----------|
| CD-WKH53 | Any query/mutation on `a2a_agent_keys` MUST include `.eq('owner_ref', ownerId)`. (This HU does NOT touch that table — N/A.) |
| CD-WKH75 | NO modifying `src/cron/` or `src/lib/kv.ts` outside HU scope. |
| CD-WKH88 | HTTP method gates on cron endpoints. (This HU creates no cron — N/A.) |
| CD-WKH69-1 | NO Railway env changes; NO mounting `requirePassport` in routes. |
| CD-WKH69-2 | NO breaking backward compat with EOA flows. Testnet PYUSD path untouched. |
| CD-WKH69-3 | NO modifying `OPERATOR_PRIVATE_KEY` or downstream settlement. |
| CD-WKH69-4 | `.kite-passport/` stays gitignored; no Passport accounts deleted. |
| CD-WKH69-5 | NO hardcoded JWTs / agent_tokens / user_ids / public_keys. |
| CD-WKH69-6 | All Passport-shape mocks include `// PASSPORT-MOCK-SHAPE:` comment block. |
| CD-WKH69-7 | New tests must NOT break existing `toHaveBeenCalledTimes` assertions. Use object-matching, not raw counts when adding shape. |
| CD-WKH69-8 | NO new files in `mcp-servers/`, `dist/`, or any deployable target. Scope: `src/middleware/`, `test/fixtures/`, `doc/`, `.env.example`. |
| CD-WKH69-9 | NO new deps in `package.json`. Imports limited to `viem`, `node:crypto`, `fastify`, `vitest`, libs already in lockfile. |
| CD-WKH69-10 | When mounted, `requirePayment` MUST precede `requirePassport` in the preHandler array. (This HU does not mount, but doc/test demonstrates correct order.) |

If you find yourself wanting to violate any CD: **STOP, escalate to human.** Do not invent a workaround.

---

*Story File generated by NexusAgil — F2.5 — Architect — 2026-05-03*
*Branch: feat/084-wkh-69-passport-hybrid-inbound · From sdd.md (SPEC_APPROVED)*
