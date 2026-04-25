import { createPublicClient, http, formatUnits, defineChain } from 'viem';

const FUJI_RPC = 'https://api.avax-test.network/ext/bc/C/rpc';
const OPERATOR = '0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba';
const USDC_FUJI = '0x5425890298aed601595a70AB815c96711a31Bc65';
const MARKETPLACE = '0xC01DEF0ca66b86E9F8655dc202347F1cf104b7A7';

const fuji = defineChain({
  id: 43113,
  name: 'Avalanche Fuji',
  nativeCurrency: { name: 'AVAX', symbol: 'AVAX', decimals: 18 },
  rpcUrls: { default: { http: [FUJI_RPC] } },
});
const rpc = createPublicClient({ chain: fuji, transport: http(FUJI_RPC) });

const erc20 = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'name', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint8' }] },
];

const [avax, usdc, sym, name, dec, mpCode] = await Promise.all([
  rpc.getBalance({ address: OPERATOR }),
  rpc.readContract({ address: USDC_FUJI, abi: erc20, functionName: 'balanceOf', args: [OPERATOR] }),
  rpc.readContract({ address: USDC_FUJI, abi: erc20, functionName: 'symbol' }),
  rpc.readContract({ address: USDC_FUJI, abi: erc20, functionName: 'name' }),
  rpc.readContract({ address: USDC_FUJI, abi: erc20, functionName: 'decimals' }),
  rpc.getCode({ address: MARKETPLACE }).catch(() => '0x'),
]);

console.log('Network    : Avalanche Fuji (43113)');
console.log('RPC        :', FUJI_RPC);
console.log('---');
console.log('Operator   :', OPERATOR);
console.log('  AVAX     :', formatUnits(avax, 18), 'AVAX');
console.log(`  USDC     : ${formatUnits(usdc, Number(dec))} ${sym} (${name}, ${dec} dec)  contract=${USDC_FUJI}`);
console.log('---');
console.log('Marketplace:', MARKETPLACE);
console.log('  deployed :', mpCode === '0x' ? 'NO (no bytecode)' : `YES (${(mpCode.length - 2) / 2} bytes)`);
