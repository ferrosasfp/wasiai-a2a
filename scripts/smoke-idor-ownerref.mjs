#!/usr/bin/env node
/**
 * Smoke — IDOR / ownership-guard probe (FREE, no settlement).
 *
 * The Supabase client uses SUPABASE_SERVICE_KEY (BYPASSRLS), so the ownership
 * guard lives in the app layer: every receipt/key query filters by owner_ref.
 * This probe verifies a caller CANNOT read another owner's data.
 *
 * Strategy with a SINGLE locally-available key (a fresh $0 signup key whose
 * owner_ref is unique to this run):
 *   1. GET /receipts            → only the caller's own receipts (here: []).
 *   2. GET /receipts/:foreignId → a fabricated/foreign UUID the caller does NOT
 *      own → assert 404 RECEIPT_NOT_FOUND (disclosure-safe: NO 200, NO row, NO
 *      cross-tenant leak; the same 404 a non-existent id would give, so existence
 *      is not disclosed).
 *   3. GET /receipts/:foreignId/verify → same disclosure-safe 404.
 *   4. The caller's own receipt list never contains the foreign id.
 *
 * The ownership guard is `.eq('owner_ref', callerKey.owner_ref)` in
 * receiptService.getById (src/services/receipt.ts), enforced for every /receipts
 * read. A fabricated id stands in for "an id owned by someone else": the guard
 * cannot distinguish "not yours" from "doesn't exist" — both are 404 by design.
 *
 * COVERAGE NOTE: full cross-tenant coverage (key A tries to read key B's REAL
 * receipt and gets 404 instead of the row) needs a SECOND real key that owns a
 * settled receipt — that is founder-gated (needs a funded key to produce a
 * receipt). This probe proves the guard rejects ids outside the caller's
 * owner_ref scope; it cannot prove a known-existing foreign id is hidden without
 * that second key. Set FOREIGN_RECEIPT_ID=<a real id owned by another key> to
 * strengthen the assertion to a true cross-tenant hide.
 *
 * Required env:
 *   A2A_URL             gateway base (default prod testnet)
 *   FOREIGN_RECEIPT_ID  (optional) a real receipt id owned by a DIFFERENT key
 *
 * Usage:
 *   node scripts/smoke-idor-ownerref.mjs
 */
const A2A =
  process.env.A2A_URL || 'https://wasiai-a2a-production.up.railway.app';

let pass = 0;
let fail = 0;
const ok = (label, cond, detail = '') => {
  console.log(
    `  ${cond ? '✅ PASS' : '❌ FAIL'}  ${label}${detail ? ' — ' + detail : ''}`,
  );
  cond ? pass++ : fail++;
};
const banner = (msg) => {
  console.error('\n╔══════════════════════════════════════════════════════╗');
  console.error(`║  FAIL: ${String(msg).slice(0, 46).padEnd(46)}║`);
  console.error('╚══════════════════════════════════════════════════════╝\n');
};
const req = async (method, path, key) => {
  const res = await fetch(A2A + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-a2a-key': key },
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* */
  }
  return { code: res.status, json };
};

const main = async () => {
  console.log(`\n🔬 Smoke IDOR / ownership-guard vs ${A2A}\n`);

  // Provision a fresh key whose owner_ref is unique to this run.
  const su = await fetch(`${A2A}/auth/agent-signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ owner_ref: `idor-smoke-${Date.now()}` }),
  });
  if (su.status === 429) {
    banner('rate-limited on signup — retry in ~60s');
    console.error('  (the security-probes smoke may have just bursted signup)');
    process.exit(1);
  }
  const suJson = await su.json();
  const key = suJson?.key;
  ok('provision fresh caller key (POST /auth/agent-signup)',
    su.status === 201 && !!key, `key_id=${suJson?.key_id}`);
  if (!key) {
    banner('could not provision caller key');
    process.exit(1);
  }

  // 1. The caller's own receipts (scoped to its owner_ref).
  const mine = await req('GET', '/receipts', key);
  ok('GET /receipts returns only caller-owned receipts (200)',
    mine.code === 200 && Array.isArray(mine.json?.receipts),
    `n=${mine.json?.receipts?.length}`);

  // 2/3. A foreign / fabricated id the caller does NOT own.
  const foreignId =
    process.env.FOREIGN_RECEIPT_ID ||
    '11111111-2222-3333-4444-555555555555';
  const usingReal = !!process.env.FOREIGN_RECEIPT_ID;
  console.log(
    `  Probing foreign receipt id: ${foreignId}` +
      (usingReal ? ' (REAL, cross-tenant)' : ' (fabricated)'),
  );

  const byId = await req('GET', `/receipts/${foreignId}`, key);
  ok('GET /receipts/:foreignId → 404 (disclosure-safe, no leak)',
    byId.code === 404 && byId.json?.error_code === 'RECEIPT_NOT_FOUND',
    `HTTP ${byId.code} ${byId.json?.error_code ?? ''}`);
  ok('foreign receipt body carries NO row data (no cross-tenant leak)',
    byId.json?.receipt === undefined,
    byId.json?.receipt ? 'LEAKED receipt object!' : 'no receipt field');

  const verify = await req('GET', `/receipts/${foreignId}/verify`, key);
  ok('GET /receipts/:foreignId/verify → 404 (disclosure-safe)',
    verify.code === 404 && verify.json?.error_code === 'RECEIPT_NOT_FOUND',
    `HTTP ${verify.code} ${verify.json?.error_code ?? ''}`);
  ok('verify never exposes secret/valid on a non-owned id',
    verify.json?.valid === undefined && verify.json?.secret === undefined,
    'no valid/secret field');

  // 4. The caller's own list never contains the foreign id.
  const leaked = (mine.json?.receipts ?? []).some((r) => r.id === foreignId);
  ok('caller receipt list does NOT contain the foreign id', !leaked,
    leaked ? 'FOREIGN ID PRESENT!' : 'absent');

  if (usingReal) {
    console.log(
      '\n  ✓ STRONG: a REAL receipt owned by another key was hidden (404), ' +
        'proving cross-tenant isolation.',
    );
  } else {
    console.log(
      '\n  ⚠️  Fabricated id used. Full cross-tenant coverage (hiding a REAL',
    );
    console.log(
      '      foreign receipt) is FOUNDER-GATED: needs a second funded key that',
    );
    console.log(
      '      owns a settled receipt. Set FOREIGN_RECEIPT_ID=<real id> to assert it.',
    );
  }

  console.log(`\n  Resultado: ${pass} PASS / ${fail} FAIL\n`);
  if (fail > 0) {
    banner(`${fail} assertion(s) failed`);
    process.exit(1);
  }
  process.exit(0);
};

main().catch((e) => {
  banner(e.message);
  process.exit(1);
});
