import type {
  GaslessFundingState,
  GaslessSupportedToken,
  X402PaymentRequest,
} from '../types/index.js';
export interface TokenSpec {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
}
export interface SettleRequest {
  authorization: X402PaymentRequest['authorization'];
  signature: string;
  network: string;
}
export interface SettleResult {
  txHash: string;
  success: boolean;
  error?: string;
}
export interface X402Proof {
  authorization: X402PaymentRequest['authorization'];
  signature: string;
  network: string;
}
export interface VerifyResult {
  valid: boolean;
  error?: string;
}
export interface QuoteResult {
  amountWei: string;
  token: TokenSpec;
  facilitatorUrl: string;
}
export interface SignRequest {
  to: `0x${string}`;
  value: string;
  timeoutSeconds?: number;
}
export interface SignResult {
  xPaymentHeader: string;
  paymentRequest: X402PaymentRequest;
}
export interface AttestEvent {
  type: string;
  payload: Record<string, unknown>;
}
export interface AttestRef {
  txHash: string;
}
export interface GaslessTransferAdapterRequest {
  to: `0x${string}`;
  value: bigint;
}
export interface GaslessAdapterResult {
  txHash: `0x${string}`;
}
export interface GaslessAdapterStatus {
  enabled: boolean;
  network: string;
  supportedToken: GaslessSupportedToken | null;
  operatorAddress: `0x${string}` | null;
  funding_state: GaslessFundingState;
  chain_id?: number;
  relayer?: string;
  documentation?: string;
}
export interface BindResult {
  success: boolean;
  txHash?: string;
  error?: string;
}
export interface BindVerification {
  bound: boolean;
  chainAddress?: string;
  verifiedAt?: string;
}
export interface PaymentAdapter {
  readonly name: string;
  readonly chainId: number;
  readonly supportedTokens: TokenSpec[];
  settle(req: SettleRequest): Promise<SettleResult>;
  verify(proof: X402Proof): Promise<VerifyResult>;
  quote(amountUsd: number): Promise<QuoteResult>;
  sign(opts: SignRequest): Promise<SignResult>;
  getScheme(): string;
  getNetwork(): string;
  getToken(): `0x${string}`;
  getMaxTimeoutSeconds(): number;
  getMerchantName(): string;
}
export interface AttestationAdapter {
  readonly name: string;
  readonly chainId: number;
  attest(event: AttestEvent): Promise<{ txHash: string; proofUrl: string }>;
  verify(ref: AttestRef): Promise<boolean>;
}
export interface GaslessAdapter {
  readonly name: string;
  readonly chainId: number;
  transfer(req: GaslessTransferAdapterRequest): Promise<GaslessAdapterResult>;
  status(): Promise<GaslessAdapterStatus>;
}
export interface IdentityBindingAdapter {
  readonly name: string;
  readonly chainId: number;
  bind(
    keyId: string,
    chainAddress: string,
    sig: `0x${string}`,
  ): Promise<BindResult>;
  verify(keyId: string): Promise<BindVerification>;
}

/**
 * Multi-chain registry (WKH-MULTICHAIN / 086).
 *
 * `ChainKey` is the canonical slug identifier for a chain bundle. Immutable —
 * adding a new chain requires extending this union AND updating the registry
 * factory dispatcher in `registry.ts`.
 */
export type ChainKey =
  | 'kite-ozone-testnet'
  | 'kite-mainnet'
  | 'avalanche-fuji'
  | 'avalanche-mainnet'
  | 'base-sepolia'
  | 'base-mainnet';

/**
 * `AdaptersBundle` groups all chain-specific adapter instances + chain config
 * for a single chain. Stored in `Map<ChainKey, AdaptersBundle>` inside the
 * registry. Treat as immutable from call-sites (CD-18).
 */
export interface AdaptersBundle {
  payment: PaymentAdapter;
  attestation: AttestationAdapter;
  gasless: GaslessAdapter;
  identity: IdentityBindingAdapter | null;
  chainConfig: {
    name: string;
    chainId: number;
    explorerUrl: string;
  };
}
