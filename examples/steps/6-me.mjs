// Paso 6 — Verificar el saldo.  GET /auth/me
// env: A2A_BASE
import { api, readState, need } from './_state.mjs';

const s = readState();
need(s, 'key');

const me = await api('/auth/me', { method: 'GET', key: s.key });
console.log(`[6] Estado de la key:`);
console.log(`    budget = ${JSON.stringify(me.budget)}`);
console.log(`\nListo. Usá la Agent Key (header x-a2a-key) en /compose y /orchestrate.`);
// No se nombra ningún script: el de barrido es utilería interna y NO está en este repo,
// así que decirle al usuario que lo corra es una instrucción falsa. Se describe el criterio.
console.log(`Limpieza: borrá las filas de a2a_agent_keys y a2a_key_deposits con owner_ref LIKE 'wkh35-%'.`);
