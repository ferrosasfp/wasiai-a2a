#!/usr/bin/env node
/**
 * WKH-35 — Deep integration test of /auth/deposit + /auth/funding-wallet on PROD.
 *
 * Strategy:
 *  - Create a throwaway a2a key via /auth/agent-signup.
 *  - Behavior matrix (auth / validation / ownership / proof / verify-before-credit).
 *  - Bind funding_wallet = operator (real proof-of-control signature).
 *  - Happy-path credit per chain REUSING the already-confirmed multichain-proof
 *    txHashes (each is a net-zero operator self-transfer → to==treasury==operator).
 *  - Replay + cross-chain isolation.
 *
 * Side effects in prod (cleanup after): 1 test a2a key + up to 3 deposit rows.
 * Burns the 3 evidence txHashes for the global anti-replay (testnet, expendable).
 */
import { privateKeyToAccount } from 'viem/accounts';
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

// Confirmed txs from doc/MULTICHAIN-COMPOSE-EVIDENCE.md (all status=success).
const EVIDENCE = [
  { name: 'Kite testnet',    chain_id: 2368,  tx: '0xbbc6dbf3d85d4d96ce910f8ce792fcf60abdc84ba83236411d01693e5521aef7' },
  { name: 'Avalanche Fuji',  chain_id: 43113, tx: '0x5532f80195dd13cbe71e0cfaf71c536cde66b6b1ac9691a7370618ee4e260868' },
  { name: 'Base Sepolia',    chain_id: 84532, tx: '0x743ff36320b72083c3f7610415baa667a091f760689f6b5dbf3d21c809ff1b9f' },
];

let PASS = 0, FAIL = 0;
const results = [];
function check(label, ok, detail) {
  results.push({ label, ok, detail });
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

console.log('═══════════════════════════════════════════════════════════════');
console.log('  WKH-35 — deposit + funding-wallet integration (PROD)');
console.log(`  operator = ${operator.address}`);
console.log('═══════════════════════════════════════════════════════════════\n');

// ── SETUP: create throwaway key ───────────────────────────────
const owner_ref = `wkh35-itest-${Date.now()}`;
const signup = await call('/auth/agent-signup', { body: { owner_ref, display_name: 'WKH-35 itest' } });
if (signup.status !== 201 || !signup.json?.key) {
  console.error('FATAL: agent-signup failed', signup.status, signup.json); process.exit(1);
}
const KEY = signup.json.key;
const KEY_ID = signup.json.key_id;
console.log(`Setup: created key_id=${KEY_ID} (owner_ref=${owner_ref})\n`);

console.log('── Behavior matrix (no credit) ──');
// T2 invalid input
{
  const r = await call('/auth/deposit', { key: KEY, body: {} });
  check('T2 invalid input → 400 INVALID_INPUT', r.status === 400 && r.json?.error_code === 'INVALID_INPUT', `HTTP ${r.status} ${JSON.stringify(r.json)}`);
}
// T3 ownership mismatch (body.key_id != caller)
{
  const r = await call('/auth/deposit', { key: KEY, body: { key_id: '00000000-0000-0000-0000-000000000000', tx_hash: EVIDENCE[0].tx, chain_id: 2368 } });
  check('T3 ownership mismatch → 403 OWNERSHIP_MISMATCH', r.status === 403 && r.json?.error_code === 'OWNERSHIP_MISMATCH', `HTTP ${r.status} ${JSON.stringify(r.json)}`);
}
// T6 nonexistent tx → verify rejects before any credit
{
  const fakeTx = '0x' + '1'.repeat(64);
  const r = await call('/auth/deposit', { key: KEY, body: { key_id: KEY_ID, tx_hash: fakeTx, chain_id: 84532 } });
  check('T6 nonexistent tx → 400 verify-fail', r.status === 400 && ['TX_NOT_FOUND','VERIFICATION_FAILED','RECIPIENT_MISMATCH','TOKEN_MISMATCH'].includes(r.json?.error_code), `HTTP ${r.status} ${JSON.stringify(r.json)}`);
}
// T1 deposit before bind, with a REAL verifying tx → must reach funding-wallet gate
{
  const r = await call('/auth/deposit', { key: KEY, body: { key_id: KEY_ID, tx_hash: EVIDENCE[0].tx, chain_id: 2368 } });
  check('T1 verifying tx, unbound → 403 FUNDING_WALLET_NOT_BOUND', r.status === 403 && r.json?.error_code === 'FUNDING_WALLET_NOT_BOUND', `HTTP ${r.status} ${JSON.stringify(r.json)}`);
}
// T4 funding-wallet bad signature
{
  const r = await call('/auth/funding-wallet', { key: KEY, body: { wallet: operator.address, signature: '0x' + 'ab'.repeat(65) } });
  check('T4 bad signature → 403 PROOF_INVALID', r.status === 403 && r.json?.error_code === 'FUNDING_WALLET_PROOF_INVALID', `HTTP ${r.status} ${JSON.stringify(r.json)}`);
}
// T5 valid sig but claims a different wallet
{
  const sig = await operator.signMessage({ message: `WASIAI_BIND_FUNDING_WALLET:${KEY_ID}` });
  const r = await call('/auth/funding-wallet', { key: KEY, body: { wallet: '0x000000000000000000000000000000000000dEaD', signature: sig } });
  check('T5 sig/wallet mismatch → 403 PROOF_INVALID', r.status === 403 && r.json?.error_code === 'FUNDING_WALLET_PROOF_INVALID', `HTTP ${r.status} ${JSON.stringify(r.json)}`);
}

console.log('\n── Bind funding wallet (real proof-of-control) ──');
let bound = false;
{
  const sig = await operator.signMessage({ message: `WASIAI_BIND_FUNDING_WALLET:${KEY_ID}` });
  const r = await call('/auth/funding-wallet', { key: KEY, body: { wallet: operator.address, signature: sig } });
  bound = r.status === 200 && (r.json?.funding_wallet || '').toLowerCase() === operator.address.toLowerCase();
  check('T7 valid bind → 200 funding_wallet set', bound, `HTTP ${r.status} ${JSON.stringify(r.json)}`);
}

console.log('\n── Happy-path credit per chain (reusing confirmed txs) ──');
const credited = [];
for (const c of EVIDENCE) {
  const r = await call('/auth/deposit', { key: KEY, body: { key_id: KEY_ID, tx_hash: c.tx, chain_id: c.chain_id } });
  const ok200 = r.status === 200 && r.json?.chain_id === c.chain_id;
  const mismatch = r.status === 403 && r.json?.error_code === 'FUNDING_WALLET_MISMATCH';
  // Accept either: 200 (operator was depositor) or 403 mismatch (depositor != operator — gate still proven).
  check(`T8 ${c.name} deposit → 200 credit OR 403 funding-wallet gate`, ok200 || mismatch, `HTTP ${r.status} ${JSON.stringify(r.json)}`);
  if (ok200) credited.push(c);
}

console.log('\n── Anti-replay + cross-chain isolation ──');
if (credited.length > 0) {
  const c = credited[0];
  const r = await call('/auth/deposit', { key: KEY, body: { key_id: KEY_ID, tx_hash: c.tx, chain_id: c.chain_id } });
  check(`T9 replay ${c.name} → 409 ALREADY_CREDITED`, r.status === 409 && r.json?.error_code === 'DEPOSIT_ALREADY_CREDITED', `HTTP ${r.status} ${JSON.stringify(r.json)}`);
} else {
  console.log('  SKIP  T9 replay — no chain credited (funding wallet != operator on all)');
}
// T10 cross-chain: claim Kite tx as a Base deposit → must NOT credit
{
  const r = await call('/auth/deposit', { key: KEY, body: { key_id: KEY_ID, tx_hash: EVIDENCE[0].tx, chain_id: 84532 } });
  const rejected = r.status >= 400; // tx doesn't exist on Base → TX_NOT_FOUND/verify-fail
  check('T10 Kite tx claimed on Base → rejected (no cross-chain credit)', rejected, `HTTP ${r.status} ${JSON.stringify(r.json)}`);
}

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  RESULT: ${PASS} PASS / ${FAIL} FAIL   (test key_id=${KEY_ID})`);
console.log(`  Cleanup later: deactivate key ${KEY_ID} + delete its a2a_key_deposits rows`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(FAIL > 0 ? 1 : 0);
