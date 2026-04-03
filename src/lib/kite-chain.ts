/**
 * KiteAI Testnet ("Ozone") — Chain Definition
 *
 * Chain ID: 2368
 * No existe definición oficial en viem/chains — se usa defineChain.
 * RPC público, no requiere API key.
 */
import { defineChain } from 'viem'

export const kiteTestnet = defineChain({
  id: 2368,
  name: 'KiteAI Testnet',
  nativeCurrency: {
    decimals: 18,
    name: 'KITE',
    symbol: 'KITE',
  },
  rpcUrls: {
    default: {
      http: ['https://rpc-testnet.gokite.ai/'],
    },
    public: {
      http: ['https://rpc-testnet.gokite.ai/'],
    },
  },
  blockExplorers: {
    default: {
      name: 'KiteScan',
      url: 'https://testnet.kitescan.ai',
    },
  },
  testnet: true,
})
