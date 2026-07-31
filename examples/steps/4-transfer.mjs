// Paso 4 — Transferir el token al treasury (tx ERC-20 real, PAGA GAS).
// env: A2A_BASE, FUNDER_PK, AMOUNT (default: el mínimo que publica el gateway)
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, createPublicClient, http, parseUnits } from 'viem';
import { readState, writeState, need, normPk, RPCS } from './_state.mjs';

const s = readState();
need(s, 'network', 'treasury', 'token', 'chain_id', 'min_confirmations');
if (!process.env.FUNDER_PK) { console.error('Falta FUNDER_PK.'); process.exit(1); }
const rpc = RPCS[s.network];
if (!rpc) { console.error(`Sin RPC para '${s.network}' en este ejemplo.`); process.exit(1); }

// El monto por default sale del mínimo que PUBLICA el gateway (paso 2), no de un
// número clavado acá: hasta el fix-pack de hoy este ejemplo transfería 0.05 y el
// gateway lo rechazaba con 400 DEPOSIT_BELOW_MINIMUM, con la plata ya en la treasury
// custodial y sin forma de acreditarla.
need(s, 'deposit_minimum_usdc');
const MINIMUM = s.deposit_minimum_usdc;
const AMOUNT = process.env.AMOUNT ?? MINIMUM;

// Comparación en micro-dólares (enteros): el mínimo del gateway se evalúa con BigInt
// sobre la grilla de 6 decimales de USDC, y acá se replica el mismo criterio. Nada de
// parseFloat: 0.1 + 0.2 !== 0.3.
const toMicro = (v) => {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(v).trim());
  if (!m) return null;
  return BigInt(m[1]) * 1000000n + BigInt((m[2] ?? '').slice(0, 6).padEnd(6, '0'));
};
const amountMicro = toMicro(AMOUNT);
const minimumMicro = toMicro(MINIMUM);
if (amountMicro === null) {
  console.error(`AMOUNT='${AMOUNT}' no es un decimal plano positivo.`);
  process.exit(1);
}
if (minimumMicro === null || amountMicro < minimumMicro) {
  console.error(
    `AMOUNT=${AMOUNT} está por debajo del mínimo publicado (${MINIMUM}). ` +
      'El gateway rechazaría el depósito con 400 DEPOSIT_BELOW_MINIMUM y la transferencia ' +
      'quedaría en la treasury sin poder acreditarse. No se transfiere nada.',
  );
  process.exit(1);
}
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
