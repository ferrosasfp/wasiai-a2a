import type { PublicClient } from 'viem';
import { createPublicClient, http } from 'viem';
import { kiteTestnet } from './chain.js';

let _client: PublicClient | null = null;
let _initialized = false;

export async function initClient(
  rpcUrl: string | undefined = process.env.KITE_RPC_URL,
): Promise<void> {
  if (!rpcUrl) {
    console.warn('KITE_RPC_URL not set — Kite features disabled');
    _initialized = true;
    return;
  }
  try {
    const client = createPublicClient({
      chain: kiteTestnet,
      transport: http(rpcUrl),
    });
    const chainId = await client.getChainId();
    console.log(`Kite Ozone Testnet connected | chainId: ${chainId}`);
    _client = client;
  } catch (err) {
    console.error('Kite client init failed:', err);
    _client = null;
  }
  _initialized = true;
}

export function getClient(): PublicClient | null {
  return _client;
}

export function requireClient(): PublicClient {
  if (!_client)
    throw new Error('Kite client not initialized. Call initAdapters() first.');
  return _client;
}

export function _resetClient(): void {
  _client = null;
  _initialized = false;
}
