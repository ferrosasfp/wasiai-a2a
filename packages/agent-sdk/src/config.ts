import type { Chain } from 'viem';
import { avalanche, avalancheFuji, base, baseSepolia } from 'viem/chains';
import { WasiAgentError } from './errors.js';
import type { WasiAgentConfig } from './types.js';

/**
 * Validador puro de WasiAgentConfig (CD-1). Lanza
 * `WasiAgentError('INVALID_CONFIG', ...)` si falta un campo requerido. NO
 * hardcodea defaults de red/treasury/token: esos salen de /auth/deposit-info.
 */
export function validateConfig(config: WasiAgentConfig): void {
  if (!config.a2aBase || typeof config.a2aBase !== 'string') {
    throw new WasiAgentError('INVALID_CONFIG', 'a2aBase is required');
  }
  if (!config.network || typeof config.network !== 'string') {
    throw new WasiAgentError('INVALID_CONFIG', 'network is required');
  }
  if (!config.rpcUrl || typeof config.rpcUrl !== 'string') {
    throw new WasiAgentError('INVALID_CONFIG', 'rpcUrl is required');
  }
  if (typeof config.chainId !== 'number' || !Number.isFinite(config.chainId)) {
    throw new WasiAgentError('INVALID_CONFIG', 'chainId is required');
  }
}

/**
 * Resuelve la `Chain` de viem por chainId. Para chains conocidas usa las
 * definiciones oficiales de `viem/chains`; para otras construye un objeto
 * `Chain` mínimo desde el rpcUrl de config (sin hardcodear, CD-1).
 */
export function resolveViemChain(chainId: number, rpcUrl: string): Chain {
  switch (chainId) {
    case 8453:
      return base;
    case 84532:
      return baseSepolia;
    case 43113:
      return avalancheFuji;
    case 43114:
      return avalanche;
    default:
      return {
        id: chainId,
        name: `chain-${chainId}`,
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
      };
  }
}
