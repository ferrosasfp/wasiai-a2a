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
 *   1. Crear Agent Key            POST /auth/agent-signup
 *   2. Vincular funding wallet    POST /auth/funding-wallet  (firma, sin gas)
 *   3. Transferir USDC on-chain   ERC-20 transfer -> treasury (paga gas)
 *   4. Declarar el depósito       POST /auth/deposit  (tx_hash)
 *   5. Verificar saldo            GET  /auth/me
 *
 * Requisitos:
 *   npm i viem
 *   - Una wallet con USDC + un poco de gas nativo (AVAX/ETH) en la red elegida.
 *   - La dirección del TREASURY de WasiAI para esa red (pedírsela a WasiAI;
 *     ver nota al final sobre el endpoint /auth/deposit-info propuesto).
 *
 * Uso:
 *   A2A_BASE=https://wasiai-a2a-production.up.railway.app \
 *   FUNDER_PK=0xTU_PRIVATE_KEY \
 *   TREASURY=0xDIRECCION_TREASURY_WASIAI \
 *   node examples/fund-agent-key.mjs
 */
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, createPublicClient, http, parseUnits } from 'viem';
import { avalancheFuji, baseSepolia } from 'viem/chains';

// ── Config (ajustar) ─────────────────────────────────────────────────────
const A2A_BASE = process.env.A2A_BASE ?? 'https://wasiai-a2a-production.up.railway.app';
const FUNDER_PK = process.env.FUNDER_PK;                 // private key de TU funding wallet
const TREASURY  = process.env.TREASURY;                  // dirección treasury de WasiAI (te la damos)
const AMOUNT_USDC = process.env.AMOUNT_USDC ?? '1.0';    // cuánto depositar
const OWNER_REF = process.env.OWNER_REF ?? 'dev-demo';   // tu identificador de cuenta

// Red elegida. Cada red tiene su chainId, su USDC y su RPC.
const NETWORKS = {
  'avalanche-fuji': {
    chainId: 43113, chain: avalancheFuji,
    usdc: '0x5425890298aed601595a70AB815c96711a31Bc65', // Circle USDC Fuji (6 dec)
    rpc: process.env.RPC_URL ?? 'https://api.avax-test.network/ext/bc/C/rpc',
  },
  'base-sepolia': {
    chainId: 84532, chain: baseSepolia,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Circle USDC Base Sepolia (6 dec)
    rpc: process.env.RPC_URL ?? 'https://sepolia.base.org',
  },
};
const NET = NETWORKS[process.env.NETWORK ?? 'avalanche-fuji'];

const ERC20 = [
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ type: 'bool' }] },
];

if (!FUNDER_PK || !TREASURY) {
  console.error('Faltan FUNDER_PK y/o TREASURY. Ver el header del archivo.');
  process.exit(1);
}

const account = privateKeyToAccount(FUNDER_PK);
const wallet = createWalletClient({ account, chain: NET.chain, transport: http(NET.rpc) });
const publicClient = createPublicClient({ chain: NET.chain, transport: http(NET.rpc) });

async function api(path, { method = 'POST', key, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['x-a2a-key'] = key;
  const res = await fetch(`${A2A_BASE}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

console.log(`Funding wallet: ${account.address}  |  red: ${process.env.NETWORK ?? 'avalanche-fuji'} (${NET.chainId})`);

// ── 1. Crear Agent Key ────────────────────────────────────────────────────
const { key, key_id } = await api('/auth/agent-signup', { body: { owner_ref: OWNER_REF, display_name: 'dev demo' } });
console.log(`1. Agent Key creada: key_id=${key_id} (guardá 'key' de forma segura, se muestra una sola vez)`);

// ── 2. Vincular funding wallet (firma de proof-of-control, SIN gas) ─────────
const bindMessage = `WASIAI_BIND_FUNDING_WALLET:${key_id}`;
const signature = await account.signMessage({ message: bindMessage });
await api('/auth/funding-wallet', { key, body: { wallet: account.address, signature } });
console.log(`2. Funding wallet vinculada: ${account.address}`);

// ── 3. Transferir USDC al treasury (transacción real, PAGA GAS) ─────────────
const amount = parseUnits(AMOUNT_USDC, 6); // USDC = 6 decimales
const txHash = await wallet.writeContract({
  address: NET.usdc, abi: ERC20, functionName: 'transfer', args: [TREASURY, amount],
});
console.log(`3. USDC enviado: ${AMOUNT_USDC} -> ${TREASURY}  tx=${txHash}`);
await publicClient.waitForTransactionReceipt({ hash: txHash });
console.log('   confirmada on-chain.');

// ── 4. Declarar el depósito (WasiAI verifica on-chain antes de acreditar) ───
const dep = await api('/auth/deposit', { key, body: { key_id, tx_hash: txHash, chain_id: NET.chainId } });
console.log(`4. Depósito acreditado: balance=${dep.balance} en chain ${dep.chain_id}`);

// ── 5. Verificar saldo ──────────────────────────────────────────────────────
const me = await api('/auth/me', { method: 'GET', key });
console.log(`5. Budget actual:`, me.budget);
console.log('\nListo. Usá la Agent Key (header x-a2a-key) en /compose y /orchestrate.');
