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
  paymentRequirements?: { payTo: string; maxAmountRequired: string };
}
export interface SettleResult {
  txHash: string;
  success: boolean;
  error?: string | undefined;
}
export interface X402Proof {
  authorization: X402PaymentRequest['authorization'];
  signature: string;
  network: string;
  paymentRequirements?: { payTo: string; maxAmountRequired: string };
}
export interface VerifyResult {
  valid: boolean;
  error?: string | undefined;
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
// ── Superficie COMÚN, VM-agnóstica (lo que el wiring puede leer SIN narrowing) ──
export interface PaymentAdapterCommon {
  readonly name: string;
  quote(amountUsd: number): Promise<QuoteResult>;
  getScheme(): string;
  getNetwork(): string;
  getMaxTimeoutSeconds(): number;
  getMerchantName(): string;
}

// ── EVM (cuerpo actual de PaymentAdapter, INTACTO + discriminante) ──
export interface EvmPaymentAdapter extends PaymentAdapterCommon {
  readonly vmFamily: 'evm'; // ← ÚNICO campo nuevo
  readonly chainId: number;
  readonly supportedTokens: TokenSpec[]; // TokenSpec.address: `0x${string}` (INTACTO)
  settle(req: SettleRequest): Promise<SettleResult>;
  verify(proof: X402Proof): Promise<VerifyResult>;
  sign(opts: SignRequest): Promise<SignResult>;
  getToken(): `0x${string}`;
}

// ── Solana (superficie honesta; NADA de 0x / EIP-3009) ──
export interface SolanaTokenSpec {
  symbol: string;
  mint: string; // base58 SPL mint
  decimals: number; // MISMO nombre que TokenSpec.decimals → lectura genérica de decimals homogénea
}
export interface SolanaSettleRequest {
  payTo: string; // base58 owner pubkey del agente (payout_wallet)
  amountAtomic: string; // unidades atómicas del mint (decimals-aware)
  intentId: string; // clave de idempotencia (AC-7) — leg/step id determinístico
}
export interface SolanaSettleProof {
  signature: string; // firma/txid base58 del SPL-transfer
  payTo: string;
  amountAtomic: string;
}
export interface SolanaPaymentAdapter extends PaymentAdapterCommon {
  readonly vmFamily: 'solana';
  readonly caip2ChainId: string; // DT-1: `solana:<genesis-prefix>` (NO chainId:number)
  readonly supportedTokens: SolanaTokenSpec[];
  settle(req: SolanaSettleRequest): Promise<SettleResult>; // build+sign+broadcast+confirm, idempotente (AC-7)
  verify(proof: SolanaSettleProof): Promise<VerifyResult>; // getSignatureStatus/getParsedTransaction (verify-before-trust)
  getMint(): string; // base58 (análogo VM-agnóstico de getToken)
  /**
   * Balance SPL del operador (unidades atómicas del mint, como string) —
   * análogo VM-agnóstico del `balanceOf` que la rama EVM lee con viem para su
   * pre-flight de balance (CR-2 de WKH-234). Lectura pura del RPC: NO importa
   * services ni DB (CD-7). LANZA cuando la lectura no se puede hacer (RPC
   * caído, ATA del operador inexistente); el caller decide cómo degradar.
   */
  getOperatorSplBalance(): Promise<string>;
}

export type PaymentAdapter = EvmPaymentAdapter | SolanaPaymentAdapter;
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
 *
 * ⚠️ SECURITY INVARIANT (WKH-150 / WKH-144): every MAINNET slug MUST end in the
 * literal suffix `-mainnet`, and every testnet slug MUST NOT. `isMainnetChainKey()`
 * (`settle-verifier.ts`) classifies mainnet purely via `.endsWith('-mainnet')`,
 * and that classification drives the WKH-144 fail-CLOSED settle re-verify gate:
 * a mainnet chain is BLOCKED when a2a cannot independently re-read the tx, while a
 * testnet chain fails OPEN. If a new mainnet chain is added here WITHOUT the
 * `-mainnet` suffix, `isMainnetChainKey()` will silently treat it as testnet →
 * fail-OPEN with real money at stake (reopens WKH-144). The invariant is guarded
 * by a test in `settle-verifier.test.ts` that cross-checks each `ChainKey` against
 * the independent viem `Chain.testnet` boolean of its adapter chain object.
 */
export type ChainKey =
  | 'kite-ozone-testnet'
  | 'kite-mainnet'
  | 'avalanche-fuji'
  | 'avalanche-mainnet'
  | 'base-sepolia'
  | 'base-mainnet'
  | 'tempo-testnet' // WKH-090 — cuarto rail (testnet-only, CD-2 → sin mainnet)
  | 'solana-devnet'; // WKH-234 — rail Solana (devnet-only, CD-4 → SIN sufijo -mainnet)

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
