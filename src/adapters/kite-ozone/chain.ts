import { defineChain } from 'viem';

export const kiteTestnet = defineChain({
  id: 2368,
  name: 'KiteAI Testnet',
  nativeCurrency: { decimals: 18, name: 'KITE', symbol: 'KITE' },
  rpcUrls: {
    default: { http: ['https://rpc-testnet.gokite.ai/'] },
    public: { http: ['https://rpc-testnet.gokite.ai/'] },
  },
  blockExplorers: {
    default: { name: 'KiteScan', url: 'https://testnet.kitescan.ai' },
  },
  testnet: true,
});

/**
 * KiteAI Mainnet — chainId 2366. Stablecoin canonical es USDC.e
 * (`0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e`); PYUSD NO existe en mainnet.
 *
 * Activación: setear `KITE_NETWORK=mainnet` en env. Default permanece
 * `testnet` para preservar comportamiento existente (zero breaking change).
 */
export const kiteMainnet = defineChain({
  id: 2366,
  name: 'KiteAI Mainnet',
  nativeCurrency: { decimals: 18, name: 'KITE', symbol: 'KITE' },
  rpcUrls: {
    default: { http: ['https://rpc.gokite.ai/'] },
    public: { http: ['https://rpc.gokite.ai/'] },
  },
  blockExplorers: {
    default: { name: 'KiteScan', url: 'https://kitescan.ai' },
  },
  testnet: false,
});

/**
 * Selecciona Kite chain según `KITE_NETWORK`. Default `testnet`.
 * Ningún otro valor está soportado; si se setea algo distinto a `mainnet`
 * caemos a testnet (fail-safe — preserva el path probado).
 */
export type KiteNetwork = 'testnet' | 'mainnet';

export function getKiteNetwork(): KiteNetwork {
  return process.env.KITE_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
}

export function getKiteChain() {
  return getKiteNetwork() === 'mainnet' ? kiteMainnet : kiteTestnet;
}
