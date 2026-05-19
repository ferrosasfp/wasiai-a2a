import type {
  GaslessAdapter,
  GaslessAdapterResult,
  GaslessAdapterStatus,
  GaslessTransferAdapterRequest,
} from '../types.js';

/**
 * Base gasless stub (WKH-104 / BASE-01).
 *
 * Base MVP does NOT implement gasless transfers — pending CDP Paymaster
 * integration (deferred to WKH-105 / BASE-02). `status()` reports disabled;
 * `transfer()` throws. Documented in DT-11 (facilitator caveat).
 */
export class BaseGaslessAdapter implements GaslessAdapter {
  readonly name = 'base';
  readonly chainId: number;
  private readonly networkTag: 'base-sepolia' | 'base-mainnet';

  constructor(chainId: number) {
    this.chainId = chainId;
    this.networkTag = chainId === 8453 ? 'base-mainnet' : 'base-sepolia';
  }

  async transfer(
    _req: GaslessTransferAdapterRequest,
  ): Promise<GaslessAdapterResult> {
    throw new Error(
      'Base gasless not implemented — pending CDP paymaster (WKH-105)',
    );
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
