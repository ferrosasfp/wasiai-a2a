import type {
  GaslessAdapter,
  GaslessAdapterResult,
  GaslessAdapterStatus,
  GaslessTransferAdapterRequest,
} from '../types.js';

/**
 * Solana gasless stub (WKH-234 / DT-7).
 *
 * Gasless (sponsored) transfers on Solana are OUT of scope. `status()` degrades
 * gracefully to `{ enabled: false }`; `transfer()` throws NOT_IMPLEMENTED.
 */
export class SolanaGaslessAdapter implements GaslessAdapter {
  readonly name = 'solana';
  readonly chainId: number;

  constructor(chainId: number) {
    this.chainId = chainId;
  }

  async transfer(
    _req: GaslessTransferAdapterRequest,
  ): Promise<GaslessAdapterResult> {
    throw new Error('NOT_IMPLEMENTED: solana gasless transfer (DT-7)');
  }

  async status(): Promise<GaslessAdapterStatus> {
    return {
      enabled: false,
      network: 'solana-devnet',
      supportedToken: null,
      operatorAddress: null,
      funding_state: 'disabled',
      chain_id: this.chainId,
    };
  }
}
