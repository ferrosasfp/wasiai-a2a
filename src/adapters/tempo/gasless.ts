import { GaslessNotSupportedError } from '../errors.js';
import type {
  GaslessAdapter,
  GaslessAdapterResult,
  GaslessAdapterStatus,
  GaslessTransferAdapterRequest,
} from '../types.js';

/**
 * Tempo gasless v1 = STUB deshabilitado (DT-7).
 *
 * `AdaptersBundle.gasless` es un campo no-nullable, así que Tempo DEBE proveer
 * una instancia. El relay EIP-3009 real (`transferWithAuthorization` de
 * TIP-20 / pathUSD) queda diferido a WKH-090b: el soporte gasless de TIP-20 NO
 * está confirmado on-chain [VERIFY-AT-IMPL: V8] y requeriría funding de gas del
 * operator en Tempo. NUNCA devolver `null`.
 */
export class TempoGaslessAdapter implements GaslessAdapter {
  readonly name = 'tempo';
  readonly chainId: number;

  constructor(chainId: number) {
    this.chainId = chainId;
  }

  async transfer(
    _req: GaslessTransferAdapterRequest,
  ): Promise<GaslessAdapterResult> {
    throw new GaslessNotSupportedError(
      'tempo-testnet',
      'Gasless relay not supported on Tempo testnet in v1 (deferred to WKH-090b)',
    );
  }

  async status(): Promise<GaslessAdapterStatus> {
    return {
      enabled: false,
      network: 'tempo-testnet',
      supportedToken: null,
      operatorAddress: null,
      funding_state: 'disabled',
      chain_id: this.chainId,
    };
  }
}
