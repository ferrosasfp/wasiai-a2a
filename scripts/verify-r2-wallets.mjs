/**
 * R-2 verification: facilitator vs v2 operator wallets, AVAX gas on Fuji.
 * If facilitator wallet has AVAX, R-2 is operationally resolved (no blocker).
 */
import { createPublicClient, http, formatUnits, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';

function readEnv(path) {
  const env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) {
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      env[m[1]] = v;
    }
  }
  return env;
}

const facEnv = readEnv('/home/ferdev/.openclaw/workspace/wasiai-facilitator/.env.local');
const v2Env = readEnv('/home/ferdev/.openclaw/workspace/wasiai-v2/.env.local');

function normPk(raw) {
  // Strip everything but [0-9a-fA-F]
  const hex = raw.replace(/[^0-9a-fA-F]/g, '');
  return ('0x' + hex.slice(-64));
}
const facPk = normPk(facEnv.OPERATOR_PRIVATE_KEY);
const v2Pk = normPk(v2Env.OPERATOR_PRIVATE_KEY);
console.log(`[debug] fac pk len=${facPk.length} prefix=${facPk.slice(0,6)} suffix=${facPk.slice(-4)}`);
console.log(`[debug] v2 pk  len=${v2Pk.length} prefix=${v2Pk.slice(0,6)} suffix=${v2Pk.slice(-4)}`);
const facOperator = privateKeyToAccount(facPk);
const v2Operator = privateKeyToAccount(v2Pk);

const fuji = defineChain({
  id: 43113,
  name: 'Avalanche Fuji',
  nativeCurrency: { name: 'AVAX', symbol: 'AVAX', decimals: 18 },
  rpcUrls: { default: { http: ['https://api.avax-test.network/ext/bc/C/rpc'] } },
});
const rpc = createPublicClient({ chain: fuji, transport: http() });

const erc20 = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
];
const USDC = '0x5425890298aed601595a70AB815c96711a31Bc65';

const [facAvax, facUsdc, v2Avax, v2Usdc] = await Promise.all([
  rpc.getBalance({ address: facOperator.address }),
  rpc.readContract({ address: USDC, abi: erc20, functionName: 'balanceOf', args: [facOperator.address] }),
  rpc.getBalance({ address: v2Operator.address }),
  rpc.readContract({ address: USDC, abi: erc20, functionName: 'balanceOf', args: [v2Operator.address] }),
]);

console.log('=== R-2 wallet check on Avalanche Fuji ===');
console.log(`facilitator operator: ${facOperator.address}`);
console.log(`  AVAX: ${formatUnits(facAvax, 18)}`);
console.log(`  USDC: ${formatUnits(facUsdc, 6)}`);
console.log(`v2 operator:          ${v2Operator.address}`);
console.log(`  AVAX: ${formatUnits(v2Avax, 18)}`);
console.log(`  USDC: ${formatUnits(v2Usdc, 6)}`);
console.log('---');
const facCanGas = facAvax >= 1_000_000_000_000_000n; // 0.001 AVAX min
const v2CanSign = v2Usdc >= 100_000n; // 0.1 USDC min
console.log(`facilitator can pay AVAX gas (>= 0.001): ${facCanGas ? '✓ YES' : '✗ NO — needs faucet'}`);
console.log(`v2 operator can sign (>= 0.1 USDC):       ${v2CanSign ? '✓ YES' : '✗ NO — needs USDC'}`);
console.log('---');
if (facCanGas && v2CanSign) {
  console.log('VERDICT: R-2 OPERATIONALLY RESOLVED');
  console.log('  EIP-3009 design allows msg.sender (facilitator) != from (v2 operator)');
  console.log('  v2 signs authorization → facilitator submits tx + pays gas → USDC moves from v2 wallet');
  console.log('  Both wallets funded → no blocker for cross-chain settlement');
} else {
  console.log('VERDICT: R-2 BLOQUEANTE — funding needed before HU can proceed');
}
