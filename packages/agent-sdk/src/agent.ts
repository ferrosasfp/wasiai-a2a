import { randomBytes } from 'node:crypto';
import {
  createPublicClient,
  createWalletClient,
  http,
  type LocalAccount,
  type PublicClient,
  parseUnits,
  type TypedData,
  type TypedDataDomain,
  type WalletClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { A2AClient } from './client.js';
import { resolveViemChain, validateConfig } from './config.js';
import { IdentityMintError, ProvisionError } from './errors.js';
import { buildAgentCardUri, mintIdentityOnChain } from './identity.js';
import type {
  AgentCard,
  AgentReputation,
  DelegateResult,
  DelegationPolicy,
  DiscoveredAgent,
  DiscoverQuery,
  MintResult,
  OperateInput,
  OperateResult,
  ProvisionInput,
  ProvisionResult,
  WasiAgentConfig,
} from './types.js';
import {
  signBindMessage,
  signDelegation,
  transferErc20,
  waitReceipt,
} from './wallet.js';

// ── Shapes de respuesta del server (subset tipado; el SDK NO importa de ../src)

interface DepositInfoNetwork {
  chain_id: number;
  slug: string;
  treasury: `0x${string}` | null;
  token: { symbol: string; address: `0x${string}`; decimals: number };
  min_confirmations: number;
}
interface DepositInfoResponse {
  networks: DepositInfoNetwork[];
}
interface SignupResponse {
  key: string;
  key_id: string;
}
interface DepositResponse {
  balance: string;
  chain_id: number;
}
interface DiscoverResponse {
  agents: DiscoveredAgent[];
  total: number;
  registries: string[];
}
interface ComposeResponse {
  kiteTxHash?: string;
  [key: string]: unknown;
}
interface DelegationResponse {
  delegation_id?: string;
  id?: string;
}
interface AgentCardResponse {
  computedReputation?: AgentReputation;
}

export class WasiAgent {
  readonly #account: LocalAccount; // NUNCA expuesto por getter (CD-5)
  readonly #config: WasiAgentConfig;
  readonly #client: A2AClient;
  readonly #wallet: WalletClient;
  readonly #public: PublicClient;
  #key?: string; // token wasi_a2a_* — interno
  #keyId?: string;

  constructor(account: LocalAccount, config: WasiAgentConfig) {
    validateConfig(config); // CD-1
    this.#account = account;
    this.#config = config;
    const chain = resolveViemChain(config.chainId, config.rpcUrl);
    this.#wallet =
      config.walletClient ??
      createWalletClient({ account, chain, transport: http(config.rpcUrl) });
    this.#public =
      config.publicClient ??
      (createPublicClient({
        chain,
        transport: http(config.rpcUrl),
      }) as PublicClient);
    this.#client = new A2AClient({
      baseUrl: config.a2aBase,
      fetchImpl: config.fetchImpl ?? globalThis.fetch,
    });
  }

  // CD-5: anti-leak. NUNCA exponer #account ni #key.
  toJSON(): Record<string, unknown> {
    return {
      network: this.#config.network,
      chainId: this.#config.chainId,
      address: this.#account.address,
      keyId: this.#keyId ?? null,
    };
  }

  toString(): string {
    return `WasiAgent(address=${this.#account.address}, network=${this.#config.network})`;
  }

  get address(): `0x${string}` {
    return this.#account.address;
  } // OK: address es pública

  /**
   * Ciclo de provision SECUENCIAL (CD-8): deposit-info → signup → bind →
   * transfer (on-chain) → deposit. Cada step en su try → `ProvisionError(step)`.
   * Reproduce `examples/fund-agent-key.mjs:60-99`. El result NO incluye `key`
   * ni la PK (CD-5).
   */
  async provision(input: ProvisionInput): Promise<ProvisionResult> {
    // 1. deposit-info (sin key)
    let net: DepositInfoNetwork | undefined;
    try {
      const info = await this.#client.request<DepositInfoResponse>(
        '/auth/deposit-info',
        { method: 'GET' },
      );
      net = info.networks.find((n) => n.slug === this.#config.network);
    } catch (err) {
      throw new ProvisionError('signup', 'failed to fetch deposit-info', err);
    }
    if (!net) {
      throw new ProvisionError(
        'signup',
        `network ${this.#config.network} not available`,
      );
    }
    if (net.treasury == null) {
      throw new ProvisionError(
        'transfer',
        `treasury not configured for ${this.#config.network}`,
      );
    }
    const treasury = net.treasury;
    const token = net.token;
    const chainId = net.chain_id;
    const minConfirmations = net.min_confirmations;

    // 2. signup
    let key: string;
    let keyId: string;
    try {
      const signup = await this.#client.request<SignupResponse>(
        '/auth/agent-signup',
        {
          method: 'POST',
          body: {
            owner_ref: input.ownerRef,
            display_name: input.displayName ?? 'autonomous-agent',
          },
        },
      );
      key = signup.key;
      keyId = signup.key_id;
      this.#key = key;
      this.#keyId = keyId;
    } catch (err) {
      throw new ProvisionError('signup', 'agent-signup failed', err);
    }

    // 3. bind funding wallet (firma EIP-191, sin gas)
    try {
      const signature = await signBindMessage(this.#account, keyId);
      await this.#client.request('/auth/funding-wallet', {
        method: 'POST',
        key,
        body: { wallet: this.#account.address, signature },
      });
    } catch (err) {
      throw new ProvisionError('bind', 'funding-wallet bind failed', err);
    }

    // 4. transfer on-chain (paga gas) — AC-3
    let txHash: `0x${string}`;
    try {
      const amount = parseUnits(input.amount, token.decimals);
      txHash = await transferErc20(this.#wallet, {
        token: token.address,
        to: treasury,
        amount,
      });
      await waitReceipt(this.#public, txHash, minConfirmations);
    } catch (err) {
      throw new ProvisionError('transfer', 'on-chain transfer failed', err);
    }

    // 5. deposit (verify-before-credit server-side)
    let balance: string;
    try {
      const dep = await this.#client.request<DepositResponse>('/auth/deposit', {
        method: 'POST',
        key,
        body: { key_id: keyId, tx_hash: txHash, chain_id: chainId },
      });
      balance = dep.balance;
    } catch (err) {
      throw new ProvisionError('deposit', 'deposit declaration failed', err);
    }

    // 6. return — SIN key ni PK (CD-5)
    return {
      keyId,
      balance,
      chainId,
      fundingWallet: this.#account.address,
      txHash,
    };
  }

  /**
   * Mint ERC-8004 REAL + bind, gateado por env (CD-7). Mintea SOLO si
   * `enableIdentityMint === true` Y `identityRegistryAddress` está seteada; si
   * no, devuelve `{ skipped: true, reason: 'IDENTITY_MINT_DISABLED' }` sin
   * tocar la cadena (AC-5). Requiere `provision()` previo (necesita `#key`).
   */
  async mintIdentity(card?: Partial<AgentCard>): Promise<MintResult> {
    // CD-7: gate.
    if (
      this.#config.enableIdentityMint !== true ||
      !this.#config.identityRegistryAddress
    ) {
      return { skipped: true, reason: 'IDENTITY_MINT_DISABLED' };
    }
    if (!this.#key) {
      throw new IdentityMintError(
        'bind',
        'provision() must run before mintIdentity()',
      );
    }

    const address = this.#account.address;
    const fullCard: AgentCard = {
      name: card?.name ?? `agent-${address}`,
      description: card?.description ?? 'Autonomous WasiAI agent',
      url: card?.url ?? `${this.#config.a2aBase}/agents/${address}`,
    };
    const agentURI = buildAgentCardUri(fullCard);

    // mint on-chain
    let tokenId: string;
    let mintTxHash: `0x${string}`;
    try {
      const res = await mintIdentityOnChain(this.#wallet, this.#public, {
        registryAddress: this.#config.identityRegistryAddress,
        agentURI,
      });
      tokenId = res.tokenId;
      mintTxHash = res.txHash;
    } catch (err) {
      if (err instanceof IdentityMintError) {
        throw err;
      }
      throw new IdentityMintError('mint', 'on-chain mint failed', err);
    }

    // bind sin ancla (token_id solo — válido, src/routes/auth.ts:644)
    let bindTxHash: `0x${string}` | undefined;
    try {
      const bound = await this.#client.request<{ tx_hash?: `0x${string}` }>(
        '/auth/erc8004/bind',
        { method: 'POST', key: this.#key, body: { token_id: tokenId } },
      );
      bindTxHash = bound.tx_hash;
    } catch (err) {
      throw new IdentityMintError('bind', 'erc8004 bind failed', err);
    }

    return {
      skipped: false,
      tokenId,
      chainId: this.#config.chainId,
      agentCardUri: agentURI,
      mintTxHash,
      bindTxHash,
    };
  }

  /**
   * Discovery vía `POST /discover`. El server ya filtra a `status==='active'`
   * (DT-10): el SDK NO re-filtra status. Retorna el subset tipado.
   */
  async discover(query: DiscoverQuery): Promise<DiscoveredAgent[]> {
    const body: Record<string, unknown> = {};
    if (query.goal !== undefined) body.q = query.goal;
    if (query.capabilities !== undefined)
      body.capabilities = query.capabilities;
    if (query.maxPrice !== undefined) body.maxPrice = query.maxPrice;
    if (query.minReputation !== undefined)
      body.minReputation = query.minReputation;
    if (query.limit !== undefined) body.limit = query.limit;
    if (query.registry !== undefined) body.registry = query.registry;
    if (query.verified !== undefined) body.verified = query.verified;

    const res = await this.#client.request<DiscoverResponse>('/discover', {
      method: 'POST',
      key: this.#key,
      body,
    });
    return res.agents;
  }

  /**
   * Ciclo de operación/pago. discover → selección determinista (primer agente
   * dentro de budget, orden del server, DT-10) → compose (paga budget). AC-7 /
   * OBS-1: `InsufficientBudgetError` se PROPAGA sin retry. `input` es
   * OBLIGATORIO en el ComposeStep → `{}`.
   */
  async operate(input: OperateInput): Promise<OperateResult> {
    const agents = await this.discover({ goal: input.goal });
    const max = this.#config.maxAgentBudgetUsd;
    const target = agents.find((a) => max === undefined || a.priceUsdc <= max);
    if (!target) {
      return { operated: false, reason: 'NO_AGENT_IN_BUDGET' };
    }

    // OBS-4: registry = registry_id (PK canónico); input OBLIGATORIO (= {}).
    // AC-7: NO capturamos InsufficientBudgetError → propaga sin retry.
    const result = await this.#client.request<ComposeResponse>('/compose', {
      method: 'POST',
      key: this.#key,
      body: {
        steps: [
          { agent: target.slug, registry: target.registry_id, input: {} },
        ],
      },
    });

    return {
      operated: true,
      agentSlug: target.slug,
      payload: result,
      kiteTxHash: result.kiteTxHash,
    };
  }

  /**
   * Delegación EIP-712 (reproduce delegation-demo.mjs:42-79). CD-10: split
   * bigint(firma)/number(JSON). `domain` SIN verifyingContract. Session key
   * efímera. PROHIBIDO pasar el policy crudo (number) a signTypedData.
   */
  async delegate(policy: DelegationPolicy): Promise<DelegateResult> {
    const session = privateKeyToAccount(generatePrivateKey());
    const nonce = `0x${randomBytes(32).toString('hex')}` as `0x${string}`;
    const domain: TypedDataDomain = {
      name: 'WasiAI-a2a Delegation',
      version: '1',
      chainId: this.#config.chainId,
    };
    const types: TypedData = {
      Delegation: [
        { name: 'session_key', type: 'address' },
        { name: 'policy', type: 'DelegationPolicy' },
        { name: 'nonce', type: 'bytes32' },
      ],
      DelegationPolicy: [
        { name: 'max_amount_per_tx', type: 'string' },
        { name: 'max_total_amount', type: 'string' },
        { name: 'expires_at', type: 'uint64' },
        { name: 'allowed_chains', type: 'uint256[]' },
        { name: 'allowed_agent_slugs', type: 'string[]' },
        { name: 'allowed_registries', type: 'string[]' },
      ],
    };

    // CD-10: uint → bigint SOLO para firmar.
    const signMsg: Record<string, unknown> = {
      session_key: session.address,
      policy: {
        ...policy,
        expires_at: BigInt(policy.expires_at),
        allowed_chains: policy.allowed_chains.map((c) => BigInt(c)),
      },
      nonce,
    };
    const signature = await signDelegation(this.#account, {
      domain,
      types,
      message: signMsg,
    });

    // Para el server: uint como number (policy crudo).
    const typed_data = {
      domain,
      types,
      primaryType: 'Delegation',
      message: { session_key: session.address, policy, nonce },
    };
    const created = await this.#client.request<DelegationResponse>(
      '/auth/delegation',
      {
        method: 'POST',
        key: this.#key,
        body: {
          typed_data,
          signature,
          session_key_address: session.address,
          policy,
        },
      },
    );

    return {
      delegationId: created.delegation_id ?? created.id ?? '',
      sessionKeyAddress: session.address,
    };
  }

  /**
   * Reputación off-chain (+ on-chain opcional) del agente, vía su AgentCard.
   * `computedReputation` es opcional/omitido si no hay score → retorna null.
   */
  async getReputation(input: {
    agentSlug: string;
  }): Promise<AgentReputation | null> {
    const card = await this.#client.request<AgentCardResponse>(
      `/agents/${input.agentSlug}/agent-card`,
      { method: 'GET' },
    );
    return card.computedReputation ?? null;
  }
}
