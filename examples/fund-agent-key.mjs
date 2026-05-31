#!/usr/bin/env node
/**
 * WasiAI-a2a — Ejemplo de integración: fondear un Agent Key con USDC on-chain.
 * =========================================================================
 *
 * Modelo de 3 entidades (NO confundir):
 *   - Agent Key (wasi_a2a_*) : API key (token). NO es wallet, no tiene private key.
 *                              Guarda tu saldo budget[chainId].
 *   - Funding wallet         : TU wallet (esta private key). Tiene los USDC,
 *                              firma y paga el gas. WasiAI nunca la ve.
 *   - Treasury / Operator    : direcciones de WasiAI. El treasury RECIBE tu USDC.
 *
 * Flujo (verify-before-credit):
 *   0. Leer config de fondeo      GET  /auth/deposit-info   (treasury, token, decimales, chain_id)
 *   1. Crear Agent Key            POST /auth/agent-signup
 *   2. Vincular funding wallet    POST /auth/funding-wallet (firma, sin gas)
 *   3. Transferir token on-chain  ERC-20 transfer -> treasury (paga gas)
 *   4. Declarar el depósito       POST /auth/deposit (tx_hash)
 *   5. Verificar saldo            GET  /auth/me
 *
 * Requisitos:
 *   npm i viem
 *   - Una wallet con el token (USDC/PYUSD) + un poco de gas nativo en la red elegida.
 *
 * Uso (NO hace falta saber el treasury: lo trae /auth/deposit-info):
 *   A2A_BASE=https://wasiai-a2a-production.up.railway.app \
 *   FUNDER_PK=0xTU_PRIVATE_KEY NETWORK=avalanche-fuji AMOUNT=1.0 \
 *   node examples/fund-agent-key.mjs
 */
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, createPublicClient, http, parseUnits } from 'viem';
import { avalancheFuji, baseSepolia } from 'viem/chains';

const A2A_BASE = process.env.A2A_BASE ?? 'https://wasiai-a2a-production.up.railway.app';
const FUNDER_PK = process.env.FUNDER_PK;                 // private key de TU funding wallet
const NETWORK  = process.env.NETWORK ?? 'avalanche-fuji';// slug de la red (ver /auth/deposit-info)
const AMOUNT   = process.env.AMOUNT ?? '1.0';            // cuánto depositar
const OWNER_REF = process.env.OWNER_REF ?? 'dev-demo';

// RPC + viem chain por slug (deposit-info NO trae el RPC; lo ponés vos).
const RPCS = {
  'avalanche-fuji': { chain: avalancheFuji, rpc: process.env.RPC_URL ?? 'https://api.avax-test.network/ext/bc/C/rpc' },
  'base-sepolia':   { chain: baseSepolia,   rpc: process.env.RPC_URL ?? 'https://sepolia.base.org' },
};

const ERC20 = [{ name: 'transfer', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }];

if (!FUNDER_PK) { console.error('Falta FUNDER_PK (la private key de tu funding wallet).'); process.exit(1); }

async function api(path, { method = 'POST', key, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['x-a2a-key'] = key;
  const res = await fetch(`${A2A_BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

// ── 0. Config de fondeo (self-serve: a dónde mandar y qué token) ────────────
const { networks } = await api('/auth/deposit-info', { method: 'GET' });
const net = networks.find((n) => n.slug === NETWORK);
if (!net) { console.error(`Red '${NETWORK}' no disponible. Opciones: ${networks.map(n => n.slug).join(', ')}`); process.exit(1); }
if (!net.treasury) { console.error(`La red ${NETWORK} no tiene treasury configurado todavía.`); process.exit(1); }
console.log(`0. deposit-info: treasury=${net.treasury} token=${net.token.symbol}(${net.token.decimals}d) chain_id=${net.chain_id} min_conf=${net.min_confirmations}`);

const rpc = RPCS[NETWORK];
if (!rpc) { console.error(`Sin RPC configurado para '${NETWORK}' en este ejemplo.`); process.exit(1); }
// Acepta la PK con o sin '0x' / espacios; toma los últimos 64 hex.
const normPk = (s) => `0x${(s || '').replace(/[^0-9a-fA-F]/g, '').slice(-64)}`;
const account = privateKeyToAccount(normPk(FUNDER_PK));
const wallet = createWalletClient({ account, chain: rpc.chain, transport: http(rpc.rpc) });
const publicClient = createPublicClient({ chain: rpc.chain, transport: http(rpc.rpc) });
console.log(`   funding wallet: ${account.address}`);

// ── 1. Crear Agent Key ──────────────────────────────────────────────────────
const { key, key_id } = await api('/auth/agent-signup', { body: { owner_ref: OWNER_REF, display_name: 'dev demo' } });
console.log(`1. Agent Key: key_id=${key_id} (guardá 'key', se muestra una vez)`);

// ── 2. Vincular funding wallet (firma, sin gas) ─────────────────────────────
const signature = await account.signMessage({ message: `WASIAI_BIND_FUNDING_WALLET:${key_id}` });
await api('/auth/funding-wallet', { key, body: { wallet: account.address, signature } });
console.log(`2. Funding wallet vinculada.`);

// ── 3. Transferir el token al treasury (tx real, paga gas) ──────────────────
const amount = parseUnits(AMOUNT, net.token.decimals); // decimales REALES de la red (Kite=18, USDC=6)
const txHash = await wallet.writeContract({ address: net.token.address, abi: ERC20, functionName: 'transfer', args: [net.treasury, amount] });
console.log(`3. ${AMOUNT} ${net.token.symbol} -> ${net.treasury}  tx=${txHash}`);
console.log(`   esperando ${net.min_confirmations} confirmación(es)…`);
await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: net.min_confirmations });
console.log('   confirmada on-chain.');

// ── 4. Declarar el depósito (WasiAI verifica on-chain antes de acreditar) ────
const dep = await api('/auth/deposit', { key, body: { key_id, tx_hash: txHash, chain_id: net.chain_id } });
console.log(`4. Acreditado: balance=${dep.balance} en chain ${dep.chain_id}`);

// ── 5. Verificar saldo ──────────────────────────────────────────────────────
const me = await api('/auth/me', { method: 'GET', key });
console.log(`5. Budget:`, me.budget);
console.log('\nListo. Usá la Agent Key (header x-a2a-key) en /compose y /orchestrate.');
