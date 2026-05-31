// Paso 3 — Vincular la funding wallet (firma, SIN gas).  POST /auth/funding-wallet
// env: A2A_BASE, FUNDER_PK
import { privateKeyToAccount } from 'viem/accounts';
import { api, readState, writeState, need, normPk } from './_state.mjs';

const s = readState();
need(s, 'key', 'key_id');
if (!process.env.FUNDER_PK) { console.error('Falta FUNDER_PK.'); process.exit(1); }

const account = privateKeyToAccount(normPk(process.env.FUNDER_PK));
const message = `WASIAI_BIND_FUNDING_WALLET:${s.key_id}`;
const signature = await account.signMessage({ message });

const out = await api('/auth/funding-wallet', {
  key: s.key,
  body: { wallet: account.address, signature },
});

writeState({ wallet: account.address });
console.log(`[3] Funding wallet vinculada (firma EIP-191, sin gas):`);
console.log(`    mensaje firmado = ${message}`);
console.log(`    wallet          = ${account.address}`);
console.log(`    respuesta       = ${JSON.stringify(out)}`);
console.log(`→ siguiente: node examples/steps/4-transfer.mjs   (tx real, paga gas)`);
