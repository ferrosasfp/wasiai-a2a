#!/usr/bin/env node
/**
 * WasiAI-a2a — Demo end-to-end de DELEGACIÓN EIP-712 (Fase 2, WKH-101) contra prod.
 * =================================================================================
 * NO mueve dinero ni gas: crea un Agent Key, vincula la funding wallet, FIRMA una
 * policy EIP-712 con esa wallet autorizando una session key efímera, crea la
 * delegación, la lista y la revoca. owner_ref autolimpiable (wkh35-%).
 *
 *   FUNDER_PK=0x<operator/funding-wallet>  node examples/delegation-demo.mjs
 */
import crypto from 'node:crypto';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

const A2A = process.env.A2A_BASE ?? 'https://wasiai-a2a-production.up.railway.app';
const CHAIN_ID = Number(process.env.KITE_CHAIN_ID ?? 8453); // domain EIP-712 (debe == server)
const OWNER_REF = process.env.OWNER_REF ?? 'wkh35-deleg-demo';
const normPk = (s) => `0x${(s || '').replace(/[^0-9a-fA-F]/g, '').slice(-64)}`;
if (!process.env.FUNDER_PK) { console.error('Falta FUNDER_PK (funding wallet = la que firma).'); process.exit(1); }

const owner = privateKeyToAccount(normPk(process.env.FUNDER_PK)); // funding wallet (firma EIP-712, CD-11)
const session = privateKeyToAccount(generatePrivateKey());        // session key efímera

async function api(path, { method = 'POST', key, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['x-a2a-key'] = key;
  const r = await fetch(A2A + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${JSON.stringify(j)}`);
  return j;
}

// 1. Agent Key
const { key, key_id } = await api('/auth/agent-signup', { body: { owner_ref: OWNER_REF, display_name: 'delegation demo' } });
console.log(`1. Agent Key: key_id=${key_id}`);

// 2. Bind funding wallet (firma EIP-191, sin gas)
const bindSig = await owner.signMessage({ message: `WASIAI_BIND_FUNDING_WALLET:${key_id}` });
await api('/auth/funding-wallet', { key, body: { wallet: owner.address, signature: bindSig } });
console.log(`2. Funding wallet vinculada: ${owner.address}`);

// 3. Policy + typed-data EIP-712 (domain {name,version,chainId} SIN verifyingContract)
const policy = {
  max_amount_per_tx: '0.10',
  max_total_amount: '0.50',
  expires_at: Math.floor(Date.now() / 1000) + 3600, // +1h
  allowed_chains: [],          // [] = sin restricción de chain (DT-3)
  allowed_agent_slugs: [],
  allowed_registries: [],
};
const nonce = `0x${crypto.randomBytes(32).toString('hex')}`;
const domain = { name: 'WasiAI-a2a Delegation', version: '1', chainId: CHAIN_ID };
const types = {
  Delegation: [
    { name: 'session_key', type: 'address' },
    { name: 'policy', type: 'DelegationPolicy' },
    { name: 'nonce', type: 'bytes32' },
  ],
  DelegationPolicy: [
    { name: 'max_amount_per_tx', type: 'string' },
    { name: 'max_total_amount', type: 'string' },
    { name: 'expires_at', type: 'uint64' },
    { name: 'allowed_chains', type: 'uint256[]' },
    { name: 'allowed_agent_slugs', type: 'string[]' },
    { name: 'allowed_registries', type: 'string[]' },
  ],
};
// Para firmar: uint64 → bigint, uint256[] → bigint[]
const signMsg = {
  session_key: session.address,
  policy: { ...policy, expires_at: BigInt(policy.expires_at), allowed_chains: [] },
  nonce,
};
const signature = await owner.signTypedData({ domain, types, primaryType: 'Delegation', message: signMsg });
console.log(`3. Policy firmada EIP-712 por ${owner.address} (session key: ${session.address})`);

// 4. Crear delegación (JSON: uint como number)
const typed_data = { domain, types, primaryType: 'Delegation', message: { session_key: session.address, policy, nonce } };
const created = await api('/auth/delegation', { key, body: { typed_data, signature, session_key_address: session.address, policy } });
console.log(`4. Delegación creada: ${JSON.stringify(created)}`);
const delegationId = created.delegation_id ?? created.id;
const sessionToken = created.session_token ?? created.token ?? '(ver respuesta)';
console.log(`   session token: ${String(sessionToken).slice(0, 24)}…  delegation_id: ${delegationId}`);

// 5. Listar
const list = await api('/auth/delegation', { method: 'GET', key });
console.log(`5. Lista de delegaciones: ${JSON.stringify(list)}`);

// 6. Revocar
if (delegationId) {
  const rev = await api(`/auth/delegation/${delegationId}`, { method: 'DELETE', key });
  console.log(`6. Revocada: ${JSON.stringify(rev)}`);
}

console.log(`\nOK ✓ — Fase 2 end-to-end contra prod: bind → firma EIP-712 → crear → listar → revocar.`);
console.log(`Limpieza: ./scripts/cleanup-wkh-35-prod-testkey.sh  (barre owner_ref '${OWNER_REF}'; la delegación cae por ON DELETE CASCADE).`);
