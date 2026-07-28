/**
 * DEEP concurrency / race tests — compose + orchestrate money path.
 *
 * Dimension NOT covered by money-path.resilience.test.ts (failure-injection) or
 * the per-service fuzz suites: CONCURRENCY / RACE behaviour. These tests fire N
 * operations with `Promise.all` against a SINGLE in-memory store that MODELS the
 * DB-atomic boundaries (the `FOR UPDATE`-locked RPCs and the `UNIQUE(network,
 * nonce)` insert) so that a NON-atomic implementation — one that did a stale
 * read-then-write outside the lock — would over-spend / double-settle / accept a
 * replay and FAIL the assertions.
 *
 * REAL services under test (no production code is mocked away):
 *   - budgetService.debit / credit                     (real `src/services/budget.ts`)
 *   - checkAndRecordX402Nonce                          (real `src/services/x402-nonce.ts`)
 *   - refundOutbox.processRefundOutbox                 (real `src/services/refund-outbox.ts`)
 *
 * ONLY the DB boundary (`../lib/supabase.js`) is mocked, and it is mocked with an
 * atomic store (`db`) that faithfully reproduces the SQL semantics:
 *   - `increment_a2a_key_spend(p_key_id,p_chain_id,p_amount_usd,p_owner_ref)`:
 *       SELECT ... FOR UPDATE → INSUFFICIENT_BUDGET if balance < amount → debit.
 *   - `refund_a2a_key_spend(...)`: credit + RETURNS row-count (0 = no-op).
 *   - `a2a_x402_nonces` INSERT: UNIQUE(network,nonce) → 23505 on duplicate.
 *   - `claim_refund_outbox`: FOR UPDATE SKIP LOCKED → each row claimed once.
 *
 * Atomicity is modelled by running each RPC body to completion synchronously
 * under a single-flight async queue (`runExclusive`): the read, the check and
 * the write are one indivisible critical section, exactly like a row lock. Any
 * interleaving the JS event loop produces between RPCs is therefore the SAME set
 * of interleavings a real serialized transaction would expose. A NON-atomic
 * service path (read balance over one await, write over another, OUTSIDE the
 * lock) would over-spend and fail R1.
 *
 * Race conditions covered:
 *   R1. Budget race        — N concurrent debits > budget → at most `budget` spent.
 *   R2. Double-settle      — two identical settle/debit attempts → one charge, one no-op.
 *   R3. x402 nonce replay  — two concurrent same-nonce requests → exactly one fresh.
 *   R4. Refund race        — concurrent sweeps of one step → exactly one reverts.
 *   R5. Debit+refund race  — a debit and its refund racing → balance conserved.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Structured logger: silence + assertable ─────────────────
const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({
  getLogger: () => logSpy,
}));

// ── Atomic in-memory DB modelling the locked RPCs / UNIQUE index ──
//
// hoisted so the vi.mock('../lib/supabase.js') factory below can close over it.
const db = vi.hoisted(() => {
  // ── single-flight critical section (models a row lock) ──
  // Every RPC body runs to completion before the next starts. This is what
  // makes the test able to FAIL a non-atomic impl: if budget.ts read the
  // balance, awaited, then wrote OUTSIDE this section, concurrent debits would
  // interleave and over-spend; inside it the check+write is indivisible.
  let tail: Promise<unknown> = Promise.resolve();
  function runExclusive<T>(fn: () => T): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  interface KeyRow {
    id: string;
    owner_ref: string;
    is_active: boolean;
    budget: Record<string, string>;
    daily_spent_usd: number;
    daily_limit_usd: number | null;
    daily_reset_at: string;
  }

  interface OutboxRow {
    id: string;
    key_id: string;
    chain_id: number;
    amount_usd: number;
    owner_ref: string;
    destination: string | null;
    reason: string;
    attempts: number;
    status: string;
    last_error: string | null;
    idem_key: string | null;
  }

  const keys = new Map<string, KeyRow>();
  const nonces = new Set<string>(); // UNIQUE(network, nonce)
  const outbox = new Map<string, OutboxRow>();
  // HU-194: modela `a2a_refund_applications` (PRIMARY KEY idem_key) — el ledger
  // de refunds YA APLICADOS que se escribe en la MISMA transacción que acredita.
  const refundApplications = new Map<string, number>();
  // HU-194: claves cuyo refund debe COMMITEAR y después perder la respuesta
  // (socket reset / timeout post-commit). Modela el escenario exacto del bug.
  const loseResponseFor = new Set<string>();

  return {
    runExclusive,
    keys,
    nonces,
    outbox,
    refundApplications,
    loseResponseFor,
    reset(): void {
      keys.clear();
      nonces.clear();
      outbox.clear();
      refundApplications.clear();
      loseResponseFor.clear();
      tail = Promise.resolve();
    },
    seedKey(
      row: Partial<KeyRow> & { id: string; budget: Record<string, string> },
    ): void {
      keys.set(row.id, {
        id: row.id,
        owner_ref: row.owner_ref ?? 'owner-1',
        is_active: row.is_active ?? true,
        budget: row.budget,
        daily_spent_usd: row.daily_spent_usd ?? 0,
        daily_limit_usd: row.daily_limit_usd ?? null,
        daily_reset_at:
          row.daily_reset_at ?? new Date(Date.now() + 86_400_000).toISOString(),
      });
    },
    balance(keyId: string, chainId: number): number {
      const k = keys.get(keyId);
      return k
        ? Number.parseFloat(k.budget[String(chainId)] ?? '0')
        : Number.NaN;
    },
  };
});

// ── supabase mock backed by the atomic store ─────────────────
vi.mock('../lib/supabase.js', () => {
  type PgError = { code?: string; message: string } | null;

  // increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd, p_owner_ref)
  // Models SELECT ... FOR UPDATE + INSUFFICIENT_BUDGET + atomic debit.
  function increment(args: {
    p_key_id: string;
    p_chain_id: number;
    p_amount_usd: number;
    p_owner_ref: string;
  }): { error: PgError } {
    const k = db.keys.get(args.p_key_id);
    if (!k) return { error: { message: 'KEY_NOT_FOUND' } };
    if (k.owner_ref !== args.p_owner_ref)
      return { error: { message: 'OWNERSHIP_MISMATCH' } };
    // WKH-142: guard NULL / < 0 / NaN ANTES de tocar el budget (mirrors the real
    // RPC: the check sits between the ownership guard and the is_active check).
    if (
      args.p_amount_usd == null ||
      args.p_amount_usd < 0 ||
      Number.isNaN(args.p_amount_usd)
    )
      return { error: { message: 'INVALID_AMOUNT' } };
    if (!k.is_active) return { error: { message: 'KEY_INACTIVE' } };
    const chainKey = String(args.p_chain_id);
    const bal = Number.parseFloat(k.budget[chainKey] ?? '0');
    if (
      k.daily_limit_usd != null &&
      k.daily_spent_usd + args.p_amount_usd > k.daily_limit_usd
    )
      return { error: { message: 'DAILY_LIMIT' } };
    if (bal < args.p_amount_usd)
      return { error: { message: 'INSUFFICIENT_BUDGET' } };
    // atomic write (inside the lock)
    k.budget[chainKey] = String(bal - args.p_amount_usd);
    k.daily_spent_usd += args.p_amount_usd;
    return { error: null };
  }

  // refund_a2a_key_spend(...) RETURNS INT (rows affected). 0 = no-op.
  function refund(args: {
    p_key_id: string;
    p_chain_id: number;
    p_amount_usd: number;
    p_owner_ref: string;
    p_idem_key?: string | null;
  }): { data: number | null; error: PgError } {
    const k = db.keys.get(args.p_key_id);
    if (!k) return { data: null, error: { message: 'KEY_NOT_FOUND' } };
    if (k.owner_ref !== args.p_owner_ref)
      return { data: null, error: { message: 'OWNERSHIP_MISMATCH' } };
    if (args.p_amount_usd == null || args.p_amount_usd <= 0)
      return { data: 0, error: null }; // defensive no-op → 0 rows
    // HU-194: `refund_idem_claim` — el claim va DESPUÉS de los guards y DENTRO de
    // la misma sección crítica que el crédito (= misma transacción en el SQL
    // real). Ya aplicada ⟹ NO se re-acredita y se devuelve 1 ("la plata está de
    // vuelta"), que es lo que el sweep necesita para marcar `done`.
    const idemKey = args.p_idem_key;
    if (idemKey) {
      const applied = db.refundApplications.get(idemKey);
      if (applied !== undefined) {
        if (Math.abs(applied - args.p_amount_usd) > 1e-9) {
          return {
            data: null,
            error: {
              message: `REFUND_IDEM_AMOUNT_MISMATCH: idem_key ${idemKey}`,
            },
          };
        }
        return { data: 1, error: null };
      }
      db.refundApplications.set(idemKey, args.p_amount_usd);
    }
    const chainKey = String(args.p_chain_id);
    const bal = Number.parseFloat(k.budget[chainKey] ?? '0');
    k.budget[chainKey] = String(bal + args.p_amount_usd);
    k.daily_spent_usd = Math.max(k.daily_spent_usd - args.p_amount_usd, 0);
    // HU-194: COMMIT + respuesta perdida. El efecto (crédito + marcador) YA está
    // en la DB y el cliente ve un fallo: es la ambigüedad que el invariante viejo
    // ("sólo se encola lo que no se aplicó") no podía resolver.
    if (idemKey && db.loseResponseFor.has(idemKey)) {
      throw new Error('socket hang up');
    }
    return { data: 1, error: null }; // 1 row reverted
  }

  const rpc = vi.fn(
    (name: string, args: Record<string, unknown>): Promise<unknown> =>
      db.runExclusive(() => {
        switch (name) {
          case 'increment_a2a_key_spend':
            return increment(args as Parameters<typeof increment>[0]);
          case 'refund_a2a_key_spend':
            return refund(args as Parameters<typeof refund>[0]);
          case 'claim_refund_outbox': {
            // FOR UPDATE SKIP LOCKED: claim each pending row exactly once.
            const limit = (args.p_limit as number) ?? 20;
            const claimed: unknown[] = [];
            for (const row of db.outbox.values()) {
              if (claimed.length >= limit) break;
              if (row.status === 'pending') {
                row.status = 'processing';
                claimed.push({ ...row });
              }
            }
            return { data: claimed, error: null };
          }
          default:
            return { data: null, error: { message: `UNHANDLED_RPC:${name}` } };
        }
      }),
  );

  // .from(table) — only the access patterns the real services issue.
  const from = vi.fn((table: string) => {
    if (table === 'a2a_x402_nonces') {
      return {
        insert: (row: { network: string; nonce: string }) =>
          db.runExclusive(() => {
            const key = `${row.network}::${row.nonce}`;
            if (db.nonces.has(key))
              return { data: null, error: { code: '23505', message: 'dup' } };
            db.nonces.add(key);
            return { data: null, error: null };
          }),
      };
    }
    if (table === 'a2a_agent_keys') {
      // budget.ts master path: .select('owner_ref').eq('id', keyId).single()
      return {
        select: () => ({
          eq: (_col: string, id: string) => ({
            single: () =>
              db.runExclusive(() => {
                const k = db.keys.get(id);
                if (!k)
                  return {
                    data: null,
                    error: { code: 'PGRST116', message: 'no row' },
                  };
                return { data: { owner_ref: k.owner_ref }, error: null };
              }),
          }),
        }),
      };
    }
    if (table === 'a2a_refund_outbox') {
      return {
        insert: (row: Record<string, unknown>) =>
          db.runExclusive(() => {
            const idemKey = (row.idem_key as string | null) ?? null;
            // HU-194: índice único PARCIAL `uq_refund_outbox_idem_key`
            // (WHERE idem_key IS NOT NULL) → las filas legacy con NULL no
            // colisionan, las nuevas se dedupean.
            if (idemKey !== null) {
              for (const existing of db.outbox.values()) {
                if (existing.idem_key === idemKey) {
                  return {
                    error: { code: '23505', message: 'duplicate key value' },
                  };
                }
              }
            }
            const id = `ob-${db.outbox.size + 1}`;
            db.outbox.set(id, {
              id,
              key_id: row.key_id as string,
              chain_id: row.chain_id as number,
              amount_usd: row.amount_usd as number,
              owner_ref: row.owner_ref as string,
              destination: (row.destination as string) ?? null,
              reason: row.reason as string,
              attempts: 0,
              status: 'pending',
              last_error: null,
              idem_key: idemKey,
            });
            return { error: null };
          }),
        update: (patch: Record<string, unknown>) => ({
          eq: (_col: string, id: string) =>
            db.runExclusive(() => {
              const r = db.outbox.get(id);
              if (r) Object.assign(r, patch);
              return { error: null };
            }),
        }),
      };
    }
    return {
      select: () => ({
        eq: () => ({ single: async () => ({ data: null, error: null }) }),
      }),
      insert: async () => ({ error: null }),
      update: () => ({ eq: async () => ({ error: null }) }),
    };
  });

  return { supabase: { from, rpc } };
});

// ── Imports AFTER the mocks ──────────────────────────────────
import { budgetService } from './budget.js';
import { refundOutbox } from './refund-outbox.js';
import { checkAndRecordX402Nonce } from './x402-nonce.js';

const KEY = 'key-1';
const OWNER = 'owner-1';
const CHAIN = 8453;

beforeEach(() => {
  vi.clearAllMocks();
  db.reset();
});

// ════════════════════════════════════════════════════════════
// WKH-142 (T2 / AC-1). NEGATIVE AMOUNT GUARD — a negative debit is rejected
// with INVALID_AMOUNT and the balance is NOT mutated (never SUMs to budget).
// ════════════════════════════════════════════════════════════
describe('T2 (AC-1) negative amount guard — debit is rejected, balance unchanged', () => {
  it('negative amount → DEBIT_INVALID_AMOUNT, budget untouched (never credited)', async () => {
    db.seedKey({ id: KEY, owner_ref: OWNER, budget: { [CHAIN]: '5' } });

    const result = await budgetService.debit(
      KEY,
      CHAIN,
      -3,
      undefined,
      undefined,
      undefined,
      OWNER,
    );

    expect(result).toEqual({ success: false, error: 'DEBIT_INVALID_AMOUNT' });
    // El balance NO cambia: sin el guard, new_bal = 5 - (-3) = 8 (SUMA al budget).
    expect(db.balance(KEY, CHAIN)).toBe(5);
  });
});

// ════════════════════════════════════════════════════════════
// R1. BUDGET RACE — N concurrent debits whose sum exceeds budget.
// ════════════════════════════════════════════════════════════
describe('R1 budget race — atomic decrement caps total spend at budget', () => {
  it('10 concurrent $1 debits against a $5 budget → exactly 5 succeed, $0 left, never negative', async () => {
    db.seedKey({ id: KEY, owner_ref: OWNER, budget: { [CHAIN]: '5' } });

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        budgetService.debit(
          KEY,
          CHAIN,
          1,
          undefined,
          undefined,
          undefined,
          OWNER,
        ),
      ),
    );

    const ok = results.filter((r) => r.success).length;
    const denied = results.filter(
      (r) => !r.success && r.error === 'AGENT_KEY_BUDGET_EXHAUSTED',
    ).length;

    expect(ok).toBe(5); // at most `budget` spent
    expect(denied).toBe(5);
    expect(db.balance(KEY, CHAIN)).toBe(0); // never over-spent
    expect(db.balance(KEY, CHAIN)).toBeGreaterThanOrEqual(0); // never negative
  });

  it('uneven amounts: budget $1.00, three concurrent $0.40 debits → 2 succeed, $0.20 left', async () => {
    db.seedKey({ id: KEY, owner_ref: OWNER, budget: { [CHAIN]: '1.00' } });

    const results = await Promise.all([
      budgetService.debit(
        KEY,
        CHAIN,
        0.4,
        undefined,
        undefined,
        undefined,
        OWNER,
      ),
      budgetService.debit(
        KEY,
        CHAIN,
        0.4,
        undefined,
        undefined,
        undefined,
        OWNER,
      ),
      budgetService.debit(
        KEY,
        CHAIN,
        0.4,
        undefined,
        undefined,
        undefined,
        OWNER,
      ),
    ]);

    const ok = results.filter((r) => r.success).length;
    expect(ok).toBe(2);
    expect(db.balance(KEY, CHAIN)).toBeCloseTo(0.2, 10);
    expect(db.balance(KEY, CHAIN)).toBeGreaterThanOrEqual(0);
  });

  it('high contention: 50 concurrent $0.10 debits against $1.00 → exactly 10 succeed', async () => {
    db.seedKey({ id: KEY, owner_ref: OWNER, budget: { [CHAIN]: '1.00' } });

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        budgetService.debit(
          KEY,
          CHAIN,
          0.1,
          undefined,
          undefined,
          undefined,
          OWNER,
        ),
      ),
    );

    const ok = results.filter((r) => r.success).length;
    expect(ok).toBe(10);
    expect(db.balance(KEY, CHAIN)).toBeCloseTo(0, 10);
  });
});

// ════════════════════════════════════════════════════════════
// N5 (audit 2026-07-02): OWNERSHIP GUARD is REAL, not tautological.
//
// The removed cold-path re-derived the target row's OWN owner_ref and fed THAT
// to the RPC, so `p_owner_ref` always equalled the row's owner → the DB
// OWNERSHIP_MISMATCH guard could NEVER fire. Now `ownerRef` is a REQUIRED arg
// threaded from the authenticated caller. This test seeds a key owned by OWNER
// and debits with a DIFFERENT caller owner_ref: the guard (modelled faithfully
// in the increment mock: `k.owner_ref !== p_owner_ref → OWNERSHIP_MISMATCH`)
// MUST reject it and leave the balance untouched.
// ════════════════════════════════════════════════════════════
describe('N5 ownership guard is real (not tautological)', () => {
  it('debit with a caller owner_ref that does NOT match the key owner → OWNERSHIP_MISMATCH, balance untouched', async () => {
    db.seedKey({ id: KEY, owner_ref: OWNER, budget: { [CHAIN]: '5' } });

    const result = await budgetService.debit(
      KEY,
      CHAIN,
      1,
      undefined,
      undefined,
      undefined,
      'not-the-owner',
    );

    expect(result).toEqual({ success: false, error: 'OWNERSHIP_MISMATCH' });
    expect(db.balance(KEY, CHAIN)).toBe(5); // guard rejected → no debit
  });

  it('the SAME debit with the correct caller owner_ref succeeds (control)', async () => {
    db.seedKey({ id: KEY, owner_ref: OWNER, budget: { [CHAIN]: '5' } });

    const result = await budgetService.debit(
      KEY,
      CHAIN,
      1,
      undefined,
      undefined,
      undefined,
      OWNER,
    );

    expect(result).toEqual({ success: true });
    expect(db.balance(KEY, CHAIN)).toBe(4);
  });
});

// ════════════════════════════════════════════════════════════
// R2. DOUBLE-SETTLE / IDEMPOTENCY — two identical settle attempts.
//
// Modelled as two concurrent debits guarded by a single-use x402 nonce: the
// settle path records the inbound nonce (UNIQUE) before debiting, so the
// duplicate is short-circuited at the nonce layer → exactly one charge.
// ════════════════════════════════════════════════════════════
describe('R2 double-settle / idempotency under concurrency', () => {
  async function settleOnce(network: string, nonce: string, amount: number) {
    const n = await checkAndRecordX402Nonce(network, nonce);
    if (n.kind === 'replay')
      return { settled: false as const, reason: 'replay' };
    const d = await budgetService.debit(
      KEY,
      CHAIN,
      amount,
      undefined,
      undefined,
      undefined,
      OWNER,
    );
    return d.success
      ? { settled: true as const, reason: 'ok' }
      : { settled: false as const, reason: d.error ?? 'debit-failed' };
  }

  it('two concurrent identical settles (same nonce) → exactly ONE charges, one is a replay no-op', async () => {
    db.seedKey({ id: KEY, owner_ref: OWNER, budget: { [CHAIN]: '10' } });

    const [a, b] = await Promise.all([
      settleOnce('base-sepolia', '0xsettle', 1),
      settleOnce('base-sepolia', '0xsettle', 1),
    ]);

    const settled = [a, b].filter((r) => r.settled).length;
    expect(settled).toBe(1); // no double-charge
    expect([a, b].some((r) => r.reason === 'replay')).toBe(true);
    expect(db.balance(KEY, CHAIN)).toBe(9); // charged exactly once
  });

  it('5 concurrent identical settles → exactly one charge, balance reflects single debit', async () => {
    db.seedKey({ id: KEY, owner_ref: OWNER, budget: { [CHAIN]: '10' } });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => settleOnce('base-sepolia', '0xdup', 2)),
    );

    expect(results.filter((r) => r.settled).length).toBe(1);
    expect(db.balance(KEY, CHAIN)).toBe(8);
  });
});

// ════════════════════════════════════════════════════════════
// R3. x402 NONCE REPLAY RACE — two concurrent same-nonce requests.
// ════════════════════════════════════════════════════════════
describe('R3 x402 nonce replay race — UNIQUE(network,nonce) admits exactly one', () => {
  it('two concurrent requests, same (network,nonce) → exactly one fresh, one replay', async () => {
    const [a, b] = await Promise.all([
      checkAndRecordX402Nonce('base-sepolia', '0xrace'),
      checkAndRecordX402Nonce('base-sepolia', '0xrace'),
    ]);

    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(['fresh', 'replay']);
  });

  it('20 concurrent requests, same nonce → exactly one fresh, 19 replays', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        checkAndRecordX402Nonce('base-sepolia', '0xstorm'),
      ),
    );
    expect(results.filter((r) => r.kind === 'fresh').length).toBe(1);
    expect(results.filter((r) => r.kind === 'replay').length).toBe(19);
  });

  it('same nonce on two DIFFERENT networks concurrently → both fresh (key is per-network)', async () => {
    const [a, b] = await Promise.all([
      checkAndRecordX402Nonce('base-sepolia', '0xsame'),
      checkAndRecordX402Nonce('kite-testnet', '0xsame'),
    ]);
    expect(a.kind).toBe('fresh');
    expect(b.kind).toBe('fresh');
  });
});

// ════════════════════════════════════════════════════════════
// R4. REFUND RACE — concurrent sweeps over the SAME pending refund.
//
// The atomic RPC reverts the budget once and reports ROW_COUNT; a second
// concurrent refund of the same amount would ALSO add rows (the RPC is a blind
// credit). The anti-double-refund GUARD therefore lives at the call-site: each
// outbox row is claimed exactly once (FOR UPDATE SKIP LOCKED). Two concurrent
// sweeps processing one pending refund must credit it exactly once.
// ════════════════════════════════════════════════════════════
describe('R4 refund race — a single pending refund is applied exactly once', () => {
  it('two concurrent outbox sweeps over one pending refund → credited once, not twice', async () => {
    db.seedKey({ id: KEY, owner_ref: OWNER, budget: { [CHAIN]: '0' } });
    db.outbox.set('ob-1', {
      id: 'ob-1',
      key_id: KEY,
      chain_id: CHAIN,
      amount_usd: 1,
      owner_ref: OWNER,
      destination: null,
      reason: 'compose.refund-failed',
      attempts: 0,
      status: 'pending',
      last_error: null,
      idem_key: 'v1:key-1:8453:op-r4:compose-step:0:d1',
    });

    await Promise.all([
      refundOutbox.processRefundOutbox(20),
      refundOutbox.processRefundOutbox(20),
    ]);

    // Exactly ONE sweep claimed the row → credited once.
    expect(db.balance(KEY, CHAIN)).toBe(1);
    expect(db.outbox.get('ob-1')?.status).toBe('done');
  });

  it('documents that WITHOUT an idem key the RPC is a blind credit (residuo legacy)', async () => {
    // Sin clave (filas encoladas antes de HU-194) la RPC aplica los DOS créditos:
    // ahí la única defensa sigue siendo el claim único del sweep. Es exactamente
    // el residuo documentado en `services/refund-outbox.ts`.
    db.seedKey({ id: KEY, owner_ref: OWNER, budget: { [CHAIN]: '0' } });

    const [a, b] = await Promise.all([
      budgetService.credit(KEY, CHAIN, 1, OWNER, { idemKey: null }),
      budgetService.credit(KEY, CHAIN, 1, OWNER, { idemKey: null }),
    ]);

    expect(a.success && a.reverted).toBe(true);
    expect(b.success && b.reverted).toBe(true);
    expect(db.balance(KEY, CHAIN)).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════
// R5. INTERLEAVED DEBIT + REFUND — a debit and its refund racing.
// ════════════════════════════════════════════════════════════
describe('R5 interleaved debit + refund — balance is conserved', () => {
  it('debit $1 and refund $1 racing against a $1 budget → final balance is $1, never negative', async () => {
    db.seedKey({ id: KEY, owner_ref: OWNER, budget: { [CHAIN]: '1' } });

    // Each RPC is atomic; whatever the interleaving, debit removes $1 and refund
    // adds $1. Conservation: if the debit succeeded, net is 0 → balance 1;
    // if the debit was denied (ran first against $1 then refund pushed to $2 —
    // impossible since refund also runs; concretely debit denied only if it saw
    // <$1, which cannot happen here) → balance 2. Either way: never negative.
    const [debitRes, creditRes] = await Promise.all([
      budgetService.debit(
        KEY,
        CHAIN,
        1,
        undefined,
        undefined,
        undefined,
        OWNER,
      ),
      budgetService.credit(KEY, CHAIN, 1, OWNER, { idemKey: null }),
    ]);

    const expected = debitRes.success ? 1 : 2;
    expect(db.balance(KEY, CHAIN)).toBe(expected);
    expect(db.balance(KEY, CHAIN)).toBeGreaterThanOrEqual(0); // never negative
    expect(creditRes.success).toBe(true); // a credit always applies
  });

  it('many interleaved debit/refund pairs conserve the budget exactly', async () => {
    db.seedKey({ id: KEY, owner_ref: OWNER, budget: { [CHAIN]: '5' } });
    const START = 5;
    const AMOUNT = 1;

    const ops: Promise<{
      kind: 'debit' | 'credit';
      ok: boolean;
      amount: number;
    }>[] = [];
    for (let i = 0; i < 8; i++) {
      ops.push(
        budgetService
          .debit(KEY, CHAIN, AMOUNT, undefined, undefined, undefined, OWNER)
          .then((r) => ({
            kind: 'debit' as const,
            ok: r.success,
            amount: AMOUNT,
          })),
      );
      ops.push(
        budgetService
          .credit(KEY, CHAIN, AMOUNT, OWNER, { idemKey: null })
          .then((r) => ({
            kind: 'credit' as const,
            ok: r.success,
            amount: AMOUNT,
          })),
      );
    }
    const results = await Promise.all(ops);

    let delta = 0;
    for (const r of results) {
      if (!r.ok) continue;
      delta += r.kind === 'debit' ? -r.amount : r.amount;
    }
    // The store's final balance must equal start + the net of all APPLIED ops.
    expect(db.balance(KEY, CHAIN)).toBeCloseTo(START + delta, 10);
    expect(db.balance(KEY, CHAIN)).toBeGreaterThanOrEqual(0); // never negative
  });
});

// ════════════════════════════════════════════════════════════
// R6 (HU-194). COMMIT-THEN-LOST-RESPONSE — el agujero real del outbox.
//
// El invariante viejo ("SOLO se encola cuando NADA se aplicó") era demostrable
// para `success:false` (check de filas de A2) pero NO para la EXCEPCIÓN: la RPC
// puede COMMITEAR y perderse la respuesta (socket reset, timeout post-commit).
// Ahí el `catch` del call-site encolaba un refund YA aplicado y el sweep lo
// acreditaba de nuevo: el caller cobraba DOS VECES.
//
// El store modela la pieza que lo cierra: `a2a_refund_applications` escrito en la
// MISMA sección crítica que el crédito (= misma transacción en el SQL real).
// ════════════════════════════════════════════════════════════
describe('R6 (HU-194) refund idempotente — commit + respuesta perdida', () => {
  const IDEM = 'v1:key-1:8453:op-r6:step0';

  it('T-194-C1 (CENTRAL): el credit commitea, la respuesta se pierde, el sweep reintenta → UN solo crédito', async () => {
    db.seedKey({ id: KEY, owner_ref: OWNER, budget: { [CHAIN]: '0' } });
    db.loseResponseFor.add(IDEM);

    // 1. El call-site pide el refund: la RPC ACREDITA y commitea, y después se
    //    cae la conexión. El service ve una excepción.
    await expect(
      budgetService.credit(KEY, CHAIN, 1, OWNER, { idemKey: IDEM }),
    ).rejects.toThrow('socket hang up');
    expect(db.balance(KEY, CHAIN)).toBe(1); // ya está acreditado

    // 2. El `catch` encola con la MISMA clave (no puede saber si commiteó).
    await refundOutbox.enqueueRefund({
      keyId: KEY,
      chainId: CHAIN,
      amountUsd: 1,
      ownerRef: OWNER,
      reason: 'step0.refund-threw',
      idemKey: IDEM,
    });

    // 3. El sweep reintenta. Sin la clave, acá el balance quedaba en 2.
    db.loseResponseFor.clear(); // el reintento sí ve la respuesta
    await refundOutbox.processRefundOutbox(20);

    expect(db.balance(KEY, CHAIN)).toBe(1);
    expect([...db.outbox.values()][0]?.status).toBe('done');
  });

  it('T-194-C2: el sweep reintentando TRES veces acredita una sola vez', async () => {
    db.seedKey({ id: KEY, owner_ref: OWNER, budget: { [CHAIN]: '0' } });
    db.outbox.set('ob-1', {
      id: 'ob-1',
      key_id: KEY,
      chain_id: CHAIN,
      amount_usd: 1,
      owner_ref: OWNER,
      destination: null,
      reason: 'compose-route.refund-threw',
      attempts: 0,
      status: 'pending',
      last_error: null,
      idem_key: IDEM,
    });

    for (let i = 0; i < 3; i++) {
      // Se fuerza el re-claim (p. ej. el `markDone` se perdió y la fila volvió a
      // pending): el peor caso para la dedup.
      const row = db.outbox.get('ob-1');
      if (row) row.status = 'pending';
      await refundOutbox.processRefundOutbox(20);
    }

    expect(db.balance(KEY, CHAIN)).toBe(1);
    expect(db.outbox.get('ob-1')?.status).toBe('done');
  });

  it('T-194-C3: DOS refunds legítimos distintos de la MISMA operación NO se colapsan', async () => {
    // /compose puede necesitar dos créditos reales del MISMO step: el del primer
    // débito (slot d1) y el del débito del retry adaptativo (slot d2). Mismo
    // monto, mismo destino, misma ejecución. Si compartieran clave, el segundo
    // (dinero REAL del caller) se descartaría como duplicado.
    db.seedKey({ id: KEY, owner_ref: OWNER, budget: { [CHAIN]: '0' } });
    const d1 = 'v1:key-1:8453:run-1:compose-step:3:d1';
    const d2 = 'v1:key-1:8453:run-1:compose-step:3:d2';

    const a = await budgetService.credit(KEY, CHAIN, 1, OWNER, { idemKey: d1 });
    const b = await budgetService.credit(KEY, CHAIN, 1, OWNER, { idemKey: d2 });

    expect(a.reverted).toBe(true);
    expect(b.reverted).toBe(true);
    expect(db.balance(KEY, CHAIN)).toBe(2); // los DOS créditos se aplicaron
  });

  it('T-194-C4: dos procesos concurrentes con la MISMA clave → un solo crédito', async () => {
    // Es el caso que un guard en TypeScript no puede cubrir: la serialización la
    // da el PRIMARY KEY de `a2a_refund_applications`.
    db.seedKey({ id: KEY, owner_ref: OWNER, budget: { [CHAIN]: '0' } });

    const [a, b] = await Promise.all([
      budgetService.credit(KEY, CHAIN, 1, OWNER, { idemKey: IDEM }),
      budgetService.credit(KEY, CHAIN, 1, OWNER, { idemKey: IDEM }),
    ]);

    // Ambos reportan "la plata está de vuelta" (contrato `reverted`), pero el
    // dinero se movió UNA vez.
    expect(a.reverted).toBe(true);
    expect(b.reverted).toBe(true);
    expect(db.balance(KEY, CHAIN)).toBe(1);
  });

  it('T-194-C5: misma clave con OTRO monto → REFUND_IDEM_AMOUNT_MISMATCH y NO acredita', async () => {
    db.seedKey({ id: KEY, owner_ref: OWNER, budget: { [CHAIN]: '0' } });
    await budgetService.credit(KEY, CHAIN, 1, OWNER, { idemKey: IDEM });

    const res = await budgetService.credit(KEY, CHAIN, 2, OWNER, {
      idemKey: IDEM,
    });

    // Reuso indebido de clave (bug), no un reintento: falla CLOSED y visible en
    // vez de acreditar un monto ambiguo.
    expect(res).toEqual({
      success: false,
      error: 'REFUND_IDEM_AMOUNT_MISMATCH',
    });
    expect(db.balance(KEY, CHAIN)).toBe(1);
  });

  it('T-194-C6: el enqueue del MISMO refund lógico dos veces deja UNA fila pendiente', async () => {
    db.seedKey({ id: KEY, owner_ref: OWNER, budget: { [CHAIN]: '0' } });
    const entry = {
      keyId: KEY,
      chainId: CHAIN,
      amountUsd: 1,
      ownerRef: OWNER,
      reason: 'gasless-route.refund-failed:x',
      idemKey: IDEM,
    };
    await refundOutbox.enqueueRefund(entry);
    // Mismo refund lógico, otro camino de error (mismo idemKey, otro reason).
    await refundOutbox.enqueueRefund({
      ...entry,
      reason: 'gasless-route.refund-threw:x',
    });

    expect(db.outbox.size).toBe(1);

    await refundOutbox.processRefundOutbox(20);
    expect(db.balance(KEY, CHAIN)).toBe(1);
  });
});
