/**
 * @wasiai/a2a-adapter-wasiai
 * 
 * Registry adapter for WasiAI marketplace
 */

import type {
  Agent,
  RegistryAdapter,
  DiscoveryQuery,
  DiscoveryResult,
  StepResult,
  PaymentAuth,
} from '@wasiai/a2a-core'

// ============================================================
// CONFIGURATION
// ============================================================

export interface WasiAIAdapterConfig {
  /** API key for authentication (wasi_xxx) */
  apiKey: string
  
  /** Base URL for WasiAI API */
  baseUrl?: string
  
  /** Request timeout in milliseconds */
  timeoutMs?: number
}

// ============================================================
// ADAPTER
// ============================================================

export class WasiAIAdapter implements RegistryAdapter {
  readonly name = 'wasiai'
  
  private apiKey: string
  private baseUrl: string
  private timeoutMs: number

  constructor(config: WasiAIAdapterConfig) {
    this.apiKey = config.apiKey
    this.baseUrl = config.baseUrl ?? 'https://app.wasiai.io/api/v1'
    this.timeoutMs = config.timeoutMs ?? 30000
  }

  /**
   * Discover agents matching a query
   */
  async discover(query: DiscoveryQuery): Promise<DiscoveryResult> {
    const params = new URLSearchParams()
    
    if (query.query) params.set('q', query.query)
    if (query.capabilities?.length) params.set('capabilities', query.capabilities.join(','))
    if (query.maxPrice) params.set('maxPrice', query.maxPrice.toString())
    if (query.minReputation) params.set('minReputation', query.minReputation.toString())
    if (query.limit) params.set('limit', query.limit.toString())

    const response = await this.fetch(`/agents/discover?${params}`)
    const data = await response.json()

    return {
      agents: data.agents.map(this.mapAgent),
      total: data.total,
      query,
    }
  }

  /**
   * Get a specific agent by ID or slug
   */
  async getAgent(idOrSlug: string): Promise<Agent | null> {
    try {
      const response = await this.fetch(`/models/${idOrSlug}`)
      const data = await response.json()
      return this.mapAgent(data)
    } catch {
      return null
    }
  }

  /**
   * Invoke an agent
   */
  async invoke(
    agent: Agent,
    input: Record<string, unknown>,
    payment?: PaymentAuth
  ): Promise<StepResult> {
    const headers: Record<string, string> = {}
    
    if (payment?.xPayment) {
      headers['X-Payment'] = payment.xPayment
    }

    const startTime = Date.now()
    
    const response = await this.fetch(`/models/${agent.slug}/invoke`, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    })

    const data = await response.json()
    const latencyMs = Date.now() - startTime

    return {
      agent,
      output: data.result,
      costUsdc: data.cost ?? agent.priceUsdc,
      latencyMs,
      attestation: data.attestation,
    }
  }

  // ==========================================================
  // HELPERS
  // ==========================================================

  private async fetch(path: string, options?: RequestInit): Promise<Response> {
    const url = `${this.baseUrl}${path}`
    
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        ...options?.headers,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    })

    if (!response.ok) {
      throw new Error(`WasiAI API error: ${response.status} ${response.statusText}`)
    }

    return response
  }

  private mapAgent = (data: Record<string, unknown>): Agent => {
    return {
      id: data.id as string,
      name: data.name as string,
      slug: data.slug as string,
      description: data.description as string,
      capabilities: (data.capabilities as string[]) ?? [],
      priceUsdc: data.priceUsdc as number,
      avgLatencyMs: data.avgLatencyMs as number | undefined,
      reputation: data.reputation as number | undefined,
      inputSchema: data.inputSchema as Record<string, unknown> | undefined,
      outputSchema: data.outputSchema as Record<string, unknown> | undefined,
      registry: this.name,
      metadata: {
        payeeAddress: data.creatorAddress,
        ...data.metadata as Record<string, unknown>,
      },
    }
  }
}
