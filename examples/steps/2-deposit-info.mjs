// Paso 2 — Info de depósito.  GET /auth/deposit-info (público)
// env: A2A_BASE, NETWORK (default avalanche-fuji)
import { api, readState, writeState, need } from './_state.mjs';

const NETWORK = process.env.NETWORK ?? 'avalanche-fuji';
const { networks } = await api('/auth/deposit-info', { method: 'GET' });
const net = networks.find((n) => n.slug === NETWORK);
if (!net) {
  console.error(`Red '${NETWORK}' no disponible. Opciones: ${networks.map((n) => n.slug).join(', ')}`);
  process.exit(1);
}
if (!net.treasury) {
  console.error(`La red ${NETWORK} no tiene treasury configurado.`);
  process.exit(1);
}

readState(); // (solo para validar que existe el archivo; no es obligatorio aquí)
writeState({
  network: net.slug,
  treasury: net.treasury,
  token: net.token,
  chain_id: net.chain_id,
  min_confirmations: net.min_confirmations,
});

console.log(`[2] deposit-info (${net.slug}):`);
console.log(`    treasury          = ${net.treasury}`);
console.log(`    token             = ${net.token.symbol} ${net.token.address} (${net.token.decimals} dec)`);
console.log(`    chain_id          = ${net.chain_id}`);
console.log(`    min_confirmations = ${net.min_confirmations}`);
console.log(`→ siguiente: node examples/steps/3-bind-wallet.mjs   (necesita FUNDER_PK)`);
