import type {
  GaslessAdapter,
  GaslessAdapterResult,
  GaslessAdapterStatus,
  GaslessTransferAdapterRequest,
} from '../types.js';

/**
 * Avalanche gasless stub (WKH-MULTICHAIN / 086 W1).
 *
 * Avalanche MVP does NOT implement gasless transfers (no equivalent of the
 * `gasless.gokite.ai` relayer). `status()` reports disabled; `transfer()`
 * throws. This is intentional — a future HU may wire Biconomy/Gelato.
 */
export class AvalancheGaslessAdapter implements GaslessAdapter {
  readonly name = 'avalanche';
  readonly chainId: number;
  private readonly networkTag: 'avalanche-fuji' | 'avalanche-mainnet';

  constructor(chainId: number) {
    this.chainId = chainId;
    this.networkTag =
      chainId === 43114 ? 'avalanche-mainnet' : 'avalanche-fuji';
  }

  async transfer(
    _req: GaslessTransferAdapterRequest,
  ): Promise<GaslessAdapterResult> {
    throw new Error('Avalanche gasless not implemented (stub)');
  }

  async status(): Promise<GaslessAdapterStatus> {
    return {
      enabled: false,
      network: this.networkTag,
      chain_id: this.chainId,
      supportedToken: null,
      operatorAddress: null,
      funding_state: 'disabled',
      documentation:
        'https://github.com/ferrosasfp/wasiai-a2a/blob/main/doc/architecture/CHAIN-ADAPTIVE.md',
    };
  }
}
