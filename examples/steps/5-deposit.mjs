// Paso 5 — Declarar el depósito → verify-before-credit.  POST /auth/deposit
// env: A2A_BASE
import { api, readState, writeState, need } from './_state.mjs';

const s = readState();
need(s, 'key', 'key_id', 'tx_hash', 'chain_id');

const dep = await api('/auth/deposit', {
  key: s.key,
  body: { key_id: s.key_id, tx_hash: s.tx_hash, chain_id: s.chain_id },
});

writeState({ balance: dep.balance });
console.log(`[5] Depósito verificado on-chain y acreditado:`);
console.log(`    balance  = ${dep.balance}`);
console.log(`    chain_id = ${dep.chain_id}`);
console.log(`(el server leyó el receipt: status, confirmaciones, Transfer→treasury, from==wallet, anti-replay)`);
console.log(`→ siguiente: node examples/steps/6-me.mjs`);
