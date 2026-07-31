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
 *   - Escrow no-custodial    : contrato on-chain que CUSTODIA tu depósito. El
 *                              operador NO puede mover los fondos sin tu firma
 *                              (EIP-712). Es el modo por defecto en prod.
 *                              (Fallback legacy: treasury de WasiAI, si la red no
 *                              tiene escrow activo.)
 *
 * Flujo (verify-before-credit):
 *   0. Leer config de fondeo      GET  /auth/deposit-info   (escrow_contract/treasury, token, decimales)
 *   1. Crear Agent Key            POST /auth/agent-signup
 *   2. Vincular funding wallet    POST /auth/funding-wallet (firma, sin gas)
 *   3. Depositar on-chain (paga gas):
 *        · escrow:   approve(escrow, amount) + deposit(keyId, amount) -> contrato no-custodial
 *        · treasury: ERC-20 transfer -> treasury (fallback si la red no tiene escrow)
 *   4. Declarar el depósito       POST /auth/deposit (tx_hash)
 *   5. Verificar saldo            GET  /auth/me
 *
 * Requisitos:
 *   npm i viem
 *   - Una wallet con el token (USDC/PYUSD) + un poco de gas nativo en la red elegida.
 *
 * Uso (NO hace falta saber a dónde mandar: lo trae /auth/deposit-info):
 *   A2A_BASE=https://wasiai-a2a-production.up.railway.app \
 *   FUNDER_PK=0xTU_PRIVATE_KEY NETWORK=avalanche-fuji AMOUNT=1.0 \
 *   node examples/fund-agent-key.mjs
 */
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, createPublicClient, http, parseUnits, keccak256, toBytes, defineChain } from 'viem';
import { avalancheFuji, baseSepolia } from 'viem/chains';

// Kite Ozone testnet (chain 2368) no viene en viem/chains; la definimos inline.
const kiteOzoneTestnet = defineChain({
  id: 2368,
  name: 'Kite Ozone Testnet',
  nativeCurrency: { name: 'KITE', symbol: 'KITE', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc-testnet.gokite.ai/'] } },
});

const A2A_BASE = process.env.A2A_BASE ?? 'https://wasiai-a2a-production.up.railway.app';
const FUNDER_PK = process.env.FUNDER_PK;                 // private key de TU funding wallet
const NETWORK  = process.env.NETWORK ?? 'avalanche-fuji';// slug de la red (ver /auth/deposit-info)
const AMOUNT   = process.env.AMOUNT ?? '1.0';            // cuánto depositar
const OWNER_REF = process.env.OWNER_REF ?? 'dev-demo';

// RPC + viem chain por slug (deposit-info NO trae el RPC; lo ponés vos).
const RPCS = {
  'avalanche-fuji':     { chain: avalancheFuji,    rpc: process.env.RPC_URL ?? 'https://api.avax-test.network/ext/bc/C/rpc' },
  'base-sepolia':       { chain: baseSepolia,      rpc: process.env.RPC_URL ?? 'https://sepolia.base.org' },
  'kite-ozone-testnet': { chain: kiteOzoneTestnet, rpc: process.env.KITE_RPC_URL ?? process.env.RPC_URL ?? 'https://rpc-testnet.gokite.ai/' },
};

const ERC20 = [
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
];

// WasiAIEscrow.deposit(bytes32 keyId, uint256 amount). keyId = keccak256(utf8(key_id)).
const ESCROW = [{ name: 'deposit', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ name: 'keyId', type: 'bytes32' }, { name: 'amount', type: 'uint256' }], outputs: [] }];

if (!FUNDER_PK) { console.error('Falta FUNDER_PK (la private key de tu funding wallet).'); process.exit(1); }

async function api(path, { method = 'POST', key, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['x-a2a-key'] = key;
  const res = await fetch(`${A2A_BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

// Retry del POST /auth/deposit (WKH-105). El server cuenta confirmaciones con su
// propio RPC y puede ir 1 bloque por detrás del cliente (race off-by-one) o no
// ver la tx todavía → reintentamos ante INSUFFICIENT_CONFIRMATIONS / TX_NOT_FOUND /
// RPC_UNAVAILABLE (blip transitorio del RPC del server).
// DEPOSIT_ALREADY_CREDITED se trata como éxito (anti-replay; sin doble crédito).
// Cualquier otro error_code es real → fallar inmediato.
const DEPOSIT_RETRYABLE = new Set([
  'INSUFFICIENT_CONFIRMATIONS',
  'TX_NOT_FOUND',
  'RPC_UNAVAILABLE',
]);
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
    console.log(`   deposit aún no confirmado (${code}); reintento ${attempt + 1}/${DEPOSIT_RETRY_MAX} en ${DEPOSIT_RETRY_DELAY_MS}ms…`);
    await sleep(DEPOSIT_RETRY_DELAY_MS);
  }
}

// ── 0. Config de fondeo (self-serve: a dónde mandar y qué token) ────────────
const { networks } = await api('/auth/deposit-info', { method: 'GET' });
const net = networks.find((n) => n.slug === NETWORK);
if (!net) { console.error(`Red '${NETWORK}' no disponible. Opciones: ${networks.map(n => n.slug).join(', ')}`); process.exit(1); }
const escrowActive = Boolean(net.escrow_mode && net.escrow_contract);
if (!escrowActive && !net.treasury) { console.error(`La red ${NETWORK} no tiene escrow ni treasury configurado todavía.`); process.exit(1); }
// Mínimo de depósito publicado por el gateway (chain-agnóstico). Se chequea ANTES de
// firmar nada: un monto por debajo se rechaza recién en /auth/deposit, con la
// transferencia ya hecha, y en modo treasury (custodial) esos fondos no se acreditan.
const minMicro = (v) => {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(v ?? '').trim());
  return m ? BigInt(m[1]) * 1000000n + BigInt((m[2] ?? '').slice(0, 6).padEnd(6, '0')) : null;
};
if (net.deposits_enabled !== true) {
  console.error(`El camino de depósito está CERRADO: el gateway no tiene mínimo configurado (deposits_enabled=${net.deposits_enabled}). Nada de lo que mandes se puede acreditar.`);
  process.exit(1);
}
const amountMicro = minMicro(AMOUNT);
const minimumMicro = minMicro(net.deposit_minimum_usdc);
if (amountMicro === null || minimumMicro === null || amountMicro < minimumMicro) {
  console.error(`AMOUNT=${AMOUNT} no llega al mínimo publicado (${net.deposit_minimum_usdc}). El depósito se rechazaría con 400 DEPOSIT_BELOW_MINIMUM. No se transfiere nada.`);
  process.exit(1);
}
const dest = escrowActive ? `escrow=${net.escrow_contract} (no-custodial)` : `treasury=${net.treasury}`;
console.log(`0. deposit-info: ${dest} token=${net.token.symbol}(${net.token.decimals}d) chain_id=${net.chain_id} min_conf=${net.min_confirmations}`);

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

// ── 3. Depositar on-chain (tx real, paga gas) ───────────────────────────────
// decimales REALES del token de la red (USDC/PYUSD=6); deposit-info es la fuente.
const amount = parseUnits(AMOUNT, net.token.decimals);
let txHash;
if (escrowActive) {
  // No-custodial: 3a approve(escrow, amount) → 3b deposit(keyId, amount) al contrato.
  // keyId on-chain = keccak256(utf8(key_id)); el operador no puede mover sin tu firma.
  const keyIdHash = keccak256(toBytes(key_id));
  const approveTx = await wallet.writeContract({ address: net.token.address, abi: ERC20, functionName: 'approve', args: [net.escrow_contract, amount] });
  console.log(`3a. approve ${AMOUNT} ${net.token.symbol} -> escrow ${net.escrow_contract}  tx=${approveTx}`);
  await publicClient.waitForTransactionReceipt({ hash: approveTx, confirmations: 1 });
  txHash = await wallet.writeContract({ address: net.escrow_contract, abi: ESCROW, functionName: 'deposit', args: [keyIdHash, amount] });
  console.log(`3b. deposit ${AMOUNT} ${net.token.symbol} -> escrow (no-custodial)  tx=${txHash}`);
} else {
  // Fallback legacy: transfer directo al treasury (solo si la red no tiene escrow).
  txHash = await wallet.writeContract({ address: net.token.address, abi: ERC20, functionName: 'transfer', args: [net.treasury, amount] });
  console.log(`3. ${AMOUNT} ${net.token.symbol} -> ${net.treasury} (treasury)  tx=${txHash}`);
}
console.log(`   esperando ${net.min_confirmations} confirmación(es)…`);
await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: net.min_confirmations });
console.log('   confirmada on-chain.');

// ── 4. Declarar el depósito (WasiAI verifica on-chain antes de acreditar) ────
const dep = await depositWithRetry({ key, key_id, tx_hash: txHash, chain_id: net.chain_id });
console.log(`4. Acreditado: balance=${dep.balance} en chain ${dep.chain_id}`);

// ── 5. Verificar saldo ──────────────────────────────────────────────────────
const me = await api('/auth/me', { method: 'GET', key });
console.log(`5. Budget:`, me.budget);
console.log('\nListo. Usá la Agent Key (header x-a2a-key) en /compose y /orchestrate.');
