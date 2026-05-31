// Paso 6 — Verificar el saldo.  GET /auth/me
// env: A2A_BASE
import { api, readState, need } from './_state.mjs';

const s = readState();
need(s, 'key');

const me = await api('/auth/me', { method: 'GET', key: s.key });
console.log(`[6] Estado de la key:`);
console.log(`    budget = ${JSON.stringify(me.budget)}`);
console.log(`\nListo. Usá la Agent Key (header x-a2a-key) en /compose y /orchestrate.`);
console.log(`Limpieza: ./scripts/cleanup-wkh-35-prod-testkey.sh  (barre owner_ref LIKE 'wkh35-%')`);
