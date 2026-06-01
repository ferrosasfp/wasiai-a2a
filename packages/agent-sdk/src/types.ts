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
  chainId: number; // domain EIP-712 + viem chain (debe == server)
  identityRegistryAddress?: `0x${string}`;
  enableIdentityMint?: boolean;
  maxAgentBudgetUsd?: number; // undefined = sin tope
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
  bindTxHash?: `0x${string}`;
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
