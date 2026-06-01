// Paso 5 — Declarar el depósito → verify-before-credit.  POST /auth/deposit
// env: A2A_BASE
import { A2A_BASE, api, readState, writeState, need } from './_state.mjs';

const s = readState();
need(s, 'key', 'key_id', 'tx_hash', 'chain_id');

// Retry del POST /auth/deposit (WKH-105). El server cuenta confirmaciones con su
// propio RPC y puede ir 1 bloque por detrás del cliente (race off-by-one) o no
// ver la tx todavía → reintentamos SOLO ante INSUFFICIENT_CONFIRMATIONS / TX_NOT_FOUND.
// DEPOSIT_ALREADY_CREDITED se trata como éxito (anti-replay; sin doble crédito).
// Cualquier otro error_code es real → fallar inmediato.
const DEPOSIT_RETRYABLE = new Set(['INSUFFICIENT_CONFIRMATIONS', 'TX_NOT_FOUND']);
const DEPOSIT_RETRY_MAX = Number(process.env.DEPOSIT_RETRY_MAX ?? 6);
const DEPOSIT_RETRY_DELAY_MS = Number(process.env.DEPOSIT_RETRY_DELAY_MS ?? 5000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function depositWithRetry({ key, key_id, tx_hash, chain_id }) {
  const headers = { 'Content-Type': 'application/json', 'x-a2a-key': key };
  const payload = JSON.stringify({ key_id, tx_hash, chain_id });
  for (let attempt = 0; attempt <= DEPOSIT_RETRY_MAX; attempt++) {
    const res = await fetch(`${A2A_BASE}/auth/deposit`, { method: 'POST', headers, body: payload });
    const json = await res.json().catch(() => ({}));
    if (res.ok) return json; // { balance, chain_id }
    const code = json?.error_code;
    if (code === 'DEPOSIT_ALREADY_CREDITED') {
      // ya acreditada (re-declaración de la misma tx): leemos el saldo de /auth/me
      const me = await api('/auth/me', { method: 'GET', key });
      return { balance: me.budget?.[String(chain_id)] ?? '0', chain_id };
    }
    if (!DEPOSIT_RETRYABLE.has(code) || attempt === DEPOSIT_RETRY_MAX) {
      throw new Error(`/auth/deposit -> ${res.status} ${JSON.stringify(json)}`);
    }
    console.log(`    deposit aún no confirmado (${code}); reintento ${attempt + 1}/${DEPOSIT_RETRY_MAX} en ${DEPOSIT_RETRY_DELAY_MS}ms…`);
    await sleep(DEPOSIT_RETRY_DELAY_MS);
  }
}

const dep = await depositWithRetry({
  key: s.key,
  key_id: s.key_id,
  tx_hash: s.tx_hash,
  chain_id: s.chain_id,
});

writeState({ balance: dep.balance });
console.log(`[5] Depósito verificado on-chain y acreditado:`);
console.log(`    balance  = ${dep.balance}`);
console.log(`    chain_id = ${dep.chain_id}`);
console.log(`(el server leyó el receipt: status, confirmaciones, Transfer→treasury, from==wallet, anti-replay)`);
console.log(`→ siguiente: node examples/steps/6-me.mjs`);
