#!/usr/bin/env node
/**
 * WKH-35 — DEEP adversarial integration test of /auth/deposit + /auth/funding-wallet
 * on PROD. Complements scripts/smoke-prod-deposit.mjs (the 12-check happy/anti-replay
 * suite) with negative paths and the security gate that matters most: the funding-wallet
 * anti-front-run defense (BLQ-MED-1).
 *
 * Self-contained: binds FRESH random wallets (generated here), so it never collides
 * with the operator's existing funding-wallet binding in prod. No on-chain credit
 * happens (no Transfer.from matches the fresh wallets), so it leaves NO deposit rows —
 * only throwaway keys, listed at the end for cleanup.
 *
 * Coverage beyond the base suite:
 *  E1/E2/E3  no-auth / garbage-key → 403 on /deposit + /funding-wallet
 *  E4        bind a fresh proven wallet → 200
 *  E5        idempotent re-bind (same key, same wallet) → 200
 *  E6        bind same wallet to a SECOND key → 409 FUNDING_WALLET_ALREADY_BOUND
 *            (proves the partial UNIQUE index in prod)
 *  E7        deposit a real operator tx with a non-operator wallet bound
 *            → 403 FUNDING_WALLET_MISMATCH (the anti-front-run gate, BLQ-MED-1)
 *  E8        deposit unsupported chain → 400 CHAIN_NOT_SUPPORTED
 *  E9        header/body chain disagreement → 400 CHAIN_MISMATCH
 *  E10       fake tx while bound → 400 TX_NOT_FOUND (verify-BEFORE-credit ordering)
 *  E11       GET /me → 200, budget is an object (no credit leaked)
 */
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { readFileSync } from 'node:fs';

const PROD = 'https://wasiai-a2a-production.up.railway.app';
const ENV = '/home/ferdev/.openclaw/workspace/wasiai-a2a/.env';

function readEnv(p) {
  const out = {};
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
function normPk(s) { const hex = s.replace(/[^0-9a-fA-F]/g, ''); return '0x' + hex.slice(-64); }

const env = readEnv(ENV);
const operator = privateKeyToAccount(normPk(env.OPERATOR_PRIVATE_KEY));

// A confirmed Avalanche-Fuji operator self-transfer (status=success, from==operator).
const FUJI_TX = '0x5532f80195dd13cbe71e0cfaf71c536cde66b6b1ac9691a7370618ee4e260868';

let PASS = 0, FAIL = 0;
function check(label, ok, detail) {
  if (ok) { PASS++; console.log(`  PASS  ${label}  — ${detail}`); }
  else    { FAIL++; console.log(`  FAIL  ${label}  — ${detail}`); }
}
async function call(path, { method = 'POST', key, body, chainHeader } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['x-a2a-key'] = key;
  if (chainHeader) headers['x-payment-chain'] = chainHeader;
  const res = await fetch(`${PROD}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json; const txt = await res.text();
  try { json = JSON.parse(txt); } catch { json = txt; }
  return { status: res.status, json };
}
async function signup(tag) {
  const owner_ref = `wkh35-deep-${tag}-${Date.now()}`;
  const r = await call('/auth/agent-signup', { body: { owner_ref, display_name: `WKH-35 deep ${tag}` } });
  if (r.status !== 201 || !r.json?.key) { console.error('FATAL signup', tag, r.status, r.json); process.exit(1); }
  return { key: r.json.key, key_id: r.json.key_id, owner_ref };
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  WKH-35 — DEEP adversarial deposit/funding-wallet (PROD)');
console.log(`  operator = ${operator.address}`);
console.log('═══════════════════════════════════════════════════════════════\n');

const created = [];

// Fresh wallets we control (never the operator → no on-chain credit possible).
const walletA = privateKeyToAccount(generatePrivateKey());
const walletB = privateKeyToAccount(generatePrivateKey());

const A = await signup('A'); created.push(A);
const B = await signup('B'); created.push(B);
console.log(`Setup: keyA=${A.key_id}  keyB=${B.key_id}`);
console.log(`       walletA=${walletA.address}  walletB=${walletB.address}\n`);

console.log('── Auth gate (no credit) ──');
{ const r = await call('/auth/deposit', { body: { key_id: A.key_id, tx_hash: FUJI_TX, chain_id: 43113 } });
  check('E1 deposit no-auth → 403', r.status === 403, `HTTP ${r.status} ${JSON.stringify(r.json)}`); }
{ const r = await call('/auth/funding-wallet', { body: { wallet: walletA.address, signature: '0x' + 'ab'.repeat(65) } });
  check('E2 funding-wallet no-auth → 403', r.status === 403, `HTTP ${r.status} ${JSON.stringify(r.json)}`); }
{ const r = await call('/auth/deposit', { key: 'wasi_a2a_deadbeef', body: { key_id: A.key_id, tx_hash: FUJI_TX, chain_id: 43113 } });
  check('E3 deposit garbage key → 403', r.status === 403, `HTTP ${r.status} ${JSON.stringify(r.json)}`); }

console.log('\n── Funding-wallet bind invariants ──');
{ const sig = await walletA.signMessage({ message: `WASIAI_BIND_FUNDING_WALLET:${A.key_id}` });
  const r = await call('/auth/funding-wallet', { key: A.key, body: { wallet: walletA.address, signature: sig } });
  check('E4 bind fresh proven wallet → 200', r.status === 200 && (r.json?.funding_wallet || '').toLowerCase() === walletA.address.toLowerCase(), `HTTP ${r.status} ${JSON.stringify(r.json)}`); }
{ const sig = await walletA.signMessage({ message: `WASIAI_BIND_FUNDING_WALLET:${A.key_id}` });
  const r = await call('/auth/funding-wallet', { key: A.key, body: { wallet: walletA.address, signature: sig } });
  check('E5 idempotent re-bind same wallet → 200', r.status === 200, `HTTP ${r.status} ${JSON.stringify(r.json)}`); }
{ // walletA already bound to keyA → binding it to keyB must hit the partial UNIQUE index.
  const sig = await walletA.signMessage({ message: `WASIAI_BIND_FUNDING_WALLET:${B.key_id}` });
  const r = await call('/auth/funding-wallet', { key: B.key, body: { wallet: walletA.address, signature: sig } });
  check('E6 same wallet → 2nd key → 409 ALREADY_BOUND', r.status === 409 && r.json?.error_code === 'FUNDING_WALLET_ALREADY_BOUND', `HTTP ${r.status} ${JSON.stringify(r.json)}`); }

console.log('\n── Security gate: anti-front-run (BLQ-MED-1) ──');
{ // keyA is bound to walletA. The Fuji tx was sent BY the operator (Transfer.from==operator≠walletA).
  // Even though the tx verifies on-chain and pays the shared treasury, the deposit MUST be rejected.
  const r = await call('/auth/deposit', { key: A.key, body: { key_id: A.key_id, tx_hash: FUJI_TX, chain_id: 43113 } });
  check('E7 real tx, depositor≠funding_wallet → 403 FUNDING_WALLET_MISMATCH', r.status === 403 && r.json?.error_code === 'FUNDING_WALLET_MISMATCH', `HTTP ${r.status} ${JSON.stringify(r.json)}`); }

console.log('\n── Chain validation + verify-before-credit ordering ──');
{ const r = await call('/auth/deposit', { key: A.key, body: { key_id: A.key_id, tx_hash: FUJI_TX, chain_id: 999999 } });
  check('E8 unsupported chain → 400 CHAIN_NOT_SUPPORTED', r.status === 400 && r.json?.error_code === 'CHAIN_NOT_SUPPORTED', `HTTP ${r.status} ${JSON.stringify(r.json)}`); }
{ // header resolves to fuji(43113) but body says 2368 → mismatch BEFORE any verify.
  const r = await call('/auth/deposit', { key: A.key, chainHeader: 'fuji', body: { key_id: A.key_id, tx_hash: FUJI_TX, chain_id: 2368 } });
  check('E9 header/body chain disagree → 400 CHAIN_MISMATCH', r.status === 400 && r.json?.error_code === 'CHAIN_MISMATCH', `HTTP ${r.status} ${JSON.stringify(r.json)}`); }
{ const fakeTx = '0x' + '1'.repeat(64);
  const r = await call('/auth/deposit', { key: A.key, body: { key_id: A.key_id, tx_hash: fakeTx, chain_id: 43113 } });
  // bound + fake tx: verify runs first → TX_NOT_FOUND (proves verify precedes the funding gate & credit).
  check('E10 fake tx while bound → 400 TX_NOT_FOUND (verify-first)', r.status === 400 && r.json?.error_code === 'TX_NOT_FOUND', `HTTP ${r.status} ${JSON.stringify(r.json)}`); }

console.log('\n── /me reflects no leaked credit ──');
{ const r = await call('/auth/me', { method: 'GET', key: A.key });
  const ok = r.status === 200 && typeof r.json?.budget === 'object' && r.json.budget !== null;
  const noCredit = !r.json?.budget?.['43113'] || Number(r.json.budget['43113']) === 0;
  check('E11 /me → 200, budget object, no Fuji credit', ok && noCredit, `HTTP ${r.status} budget=${JSON.stringify(r.json?.budget)}`); }

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  RESULT: ${PASS} PASS / ${FAIL} FAIL`);
console.log(`  Throwaway keys (no deposit rows): ${created.map(c => c.key_id).join(', ')}`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(FAIL > 0 ? 1 : 0);
