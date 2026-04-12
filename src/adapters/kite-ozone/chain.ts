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
