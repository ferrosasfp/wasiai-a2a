import type { PublicClient, WalletClient } from 'viem';

export interface AgentCard {
  name: string;
  description: string;
  url: string;
}

export interface WasiAgentConfig {
  a2aBase: string; // ej. https://wasiai-a2a-production.up.railway.app
  network: string; // slug, matchea /auth/deposit-info (ej. 'base-sepolia')
  rpcUrl: string;
  chainId: number; // viem chain + chain de pago/funding (debe == server)
  // chainId del domain EIP-712 de delegación. Puede diferir de `chainId` (la
  // chain de delegación puede no ser la de pago). DEBE coincidir con el
  // `KITE_CHAIN_ID` del server (default 8453). Si se omite → usa `chainId`.
  delegationChainId?: number;
  identityRegistryAddress?: `0x${string}`;
  enableIdentityMint?: boolean;
  maxAgentBudgetUsd?: number; // undefined = sin tope
  // Retry del POST /auth/deposit ante errores TRANSITORIOS de confirmación
  // (INSUFFICIENT_CONFIRMATIONS / TX_NOT_FOUND): el server cuenta confs con su
  // propio RPC y puede ir 1 bloque por detrás del cliente (race off-by-one /
  // lag de RPC). Defaults: 6 reintentos × 5s ≈ 30s. depositRetryMax es el nº de
  // REINTENTOS además del intento inicial (total de intentos = max + 1).
  depositRetryMax?: number; // default 6
  depositRetryDelayMs?: number; // default 5000
  // Inyectables para test (DT-11) — opcionales, defaults reales en el constructor:
  fetchImpl?: typeof fetch;
  walletClient?: WalletClient;
  publicClient?: PublicClient;
}

export interface ProvisionInput {
  ownerRef: string;
  amount: string; // string decimal, ej. '1.0' (parseUnits con token.decimals)
  displayName?: string;
}

// NUNCA incluye la PK ni el token `key`:
export interface ProvisionResult {
  keyId: string;
  balance: string;
  chainId: number;
  fundingWallet: `0x${string}`; // address pública (no es secreto)
  txHash: `0x${string}`;
}

export interface MintResult {
  skipped: boolean;
  reason?: string; // 'IDENTITY_MINT_DISABLED' cuando skipped
  tokenId?: string;
  chainId?: number;
  agentCardUri?: string; // el data: URI minteado (público)
  // NOTA: el bind (`POST /auth/erc8004/bind`) es verificación de ownership +
  // persist en DB, SIN write on-chain → no produce tx_hash. El único tx
  // on-chain del flujo es el mint (`mintTxHash`). Por eso NO existe bindTxHash.
  mintTxHash?: `0x${string}`;
}

export interface DiscoverQuery {
  goal?: string; // → q
  capabilities?: string[];
  maxPrice?: number;
  minReputation?: number;
  limit?: number;
  registry?: string;
  verified?: boolean;
}

// Subset tipado del Agent del server (el SDK NO importa de ../src):
export interface DiscoveredAgent {
  id: string;
  name: string;
  slug: string;
  priceUsdc: number;
  registry: string;
  registry_id: string;
  verified: boolean;
}

export interface OperateInput {
  goal: string;
}

export interface OperateResult {
  operated: boolean;
  reason?: string; // 'NO_AGENT_IN_BUDGET' cuando operated=false
  agentSlug?: string;
  payload?: unknown;
  kiteTxHash?: string;
}

// Reputación: subset tipado de AgentReputation del server (computedReputation):
export interface AgentReputation {
  score: number;
  tasks_settled: number;
  success_rate: number;
  total_volume_usdc: number;
  avg_latency_ms?: number;
  source: 'off-chain' | 'hybrid';
  onchain?: { value: string; chain_id: number };
}

export type ProvisionStep = 'signup' | 'bind' | 'transfer' | 'deposit';

export interface DelegationPolicy {
  max_amount_per_tx: string;
  max_total_amount: string;
  expires_at: number; // unix seconds (number en el JSON; bigint solo al firmar)
  allowed_chains: number[]; // number[] en JSON; bigint[] solo al firmar
  allowed_agent_slugs: string[];
  allowed_registries: string[];
}

export interface DelegateResult {
  delegationId: string;
  sessionKeyAddress: `0x${string}`;
}
