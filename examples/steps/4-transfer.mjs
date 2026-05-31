// Paso 4 — Transferir el token al treasury (tx ERC-20 real, PAGA GAS).
// env: A2A_BASE, FUNDER_PK, AMOUNT (default 0.05)
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, createPublicClient, http, parseUnits } from 'viem';
import { readState, writeState, need, normPk, RPCS } from './_state.mjs';

const s = readState();
need(s, 'network', 'treasury', 'token', 'chain_id', 'min_confirmations');
if (!process.env.FUNDER_PK) { console.error('Falta FUNDER_PK.'); process.exit(1); }
const rpc = RPCS[s.network];
if (!rpc) { console.error(`Sin RPC para '${s.network}' en este ejemplo.`); process.exit(1); }

const AMOUNT = process.env.AMOUNT ?? '0.05';
const ERC20 = [{ name: 'transfer', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }];

const account = privateKeyToAccount(normPk(process.env.FUNDER_PK));
const wallet = createWalletClient({ account, chain: rpc.chain, transport: http(rpc.rpc) });
const publicClient = createPublicClient({ chain: rpc.chain, transport: http(rpc.rpc) });

const amount = parseUnits(AMOUNT, s.token.decimals);
const tx_hash = await wallet.writeContract({
  address: s.token.address, abi: ERC20, functionName: 'transfer', args: [s.treasury, amount],
});
console.log(`[4] transfer ${AMOUNT} ${s.token.symbol}  ${account.address} → ${s.treasury}`);
console.log(`    tx = ${tx_hash}`);
console.log(`    esperando ${s.min_confirmations} confirmación(es)…`);
await publicClient.waitForTransactionReceipt({ hash: tx_hash, confirmations: s.min_confirmations });

writeState({ tx_hash });
console.log(`    confirmada on-chain.`);
console.log(`→ siguiente: node examples/steps/5-deposit.mjs`);
