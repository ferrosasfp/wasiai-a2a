import type {
  QuoteResult,
  SettleResult,
  SolanaPaymentAdapter as ISolanaPaymentAdapter,
  SolanaSettleProof,
  SolanaSettleRequest,
  SolanaTokenSpec,
  VerifyResult,
} from '../types.js';

/**
 * Solana devnet SPL-transfer payment adapter (WKH-234).
 *
 * W0 scaffold — real settle/verify/quote (build+sign+broadcast+confirm,
 * verify-before-trust, idempotency) lands in W3. Settle-only, operator-signed.
 */
export class SolanaPaymentAdapter implements ISolanaPaymentAdapter {
  readonly vmFamily = 'solana' as const;
  readonly name = 'solana';
  readonly caip2ChainId: string = '';
  readonly supportedTokens: SolanaTokenSpec[] = [];

  async settle(_req: SolanaSettleRequest): Promise<SettleResult> {
    throw new Error('NOT_IMPLEMENTED: SolanaPaymentAdapter.settle (W3)');
  }

  async verify(_proof: SolanaSettleProof): Promise<VerifyResult> {
    throw new Error('NOT_IMPLEMENTED: SolanaPaymentAdapter.verify (W3)');
  }

  async quote(_amountUsd: number): Promise<QuoteResult> {
    throw new Error('NOT_IMPLEMENTED: SolanaPaymentAdapter.quote (W3)');
  }

  getMint(): string {
    throw new Error('NOT_IMPLEMENTED: SolanaPaymentAdapter.getMint (W3)');
  }

  getScheme(): string {
    throw new Error('NOT_IMPLEMENTED: SolanaPaymentAdapter.getScheme (W3)');
  }

  getNetwork(): string {
    throw new Error('NOT_IMPLEMENTED: SolanaPaymentAdapter.getNetwork (W3)');
  }

  getMaxTimeoutSeconds(): number {
    throw new Error(
      'NOT_IMPLEMENTED: SolanaPaymentAdapter.getMaxTimeoutSeconds (W3)',
    );
  }

  getMerchantName(): string {
    throw new Error(
      'NOT_IMPLEMENTED: SolanaPaymentAdapter.getMerchantName (W3)',
    );
  }
}
