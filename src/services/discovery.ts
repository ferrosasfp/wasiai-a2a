/**
 * Discovery Service — Search agents across all registries
 */

import type { Agent, DiscoveryQuery, DiscoveryResult, RegistryConfig } from '../types/index.js'
import { registryService } from './registry.js'
import { getRegistryCircuitBreaker } from '../lib/circuit-breaker.js'

export const discoveryService = {
  /**
   * Discover agents across all enabled registries
   */
  async discover(query: DiscoveryQuery): Promise<DiscoveryResult> {
    const registries = query.registry
      ? [await registryService.get(query.registry)].filter(Boolean) as RegistryConfig[]
      : await registryService.getEnabled()

    if (registries.length === 0) {
      return { agents: [], total: 0, registries: [] }
    }

    // Query all registries in parallel
    const results = await Promise.all(
      registries.map(registry => 
        this.queryRegistry(registry, query).catch(err => {
          console.error(`[Discovery] Error querying ${registry.name}:`, err.message)
          return [] as Agent[]
        })
      )
    )

    // Merge results
    let allAgents = results.flat()

    // Local post-fetch filters (upstream may not support all filter params)
    if (query.capabilities?.length) {
      const caps = query.capabilities.map(c => c.toLowerCase())
      allAgents = allAgents.filter(a =>
        a.capabilities.some(ac => caps.includes(ac.toLowerCase())) ||
        caps.some(c => a.description.toLowerCase().includes(c))
      )
    }
    if (query.query) {
      const q = query.query.toLowerCase()
      allAgents = allAgents.filter(a =>
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        a.capabilities.some(c => c.toLowerCase().includes(q))
      )
    }
    if (query.maxPrice != null) {
      allAgents = allAgents.filter(a => a.priceUsdc <= query.maxPrice!)
    }

    // Sort by reputation (desc) then by price (asc)
    allAgents.sort((a, b) => {
      const repDiff = (b.reputation ?? 0) - (a.reputation ?? 0)
      if (repDiff !== 0) return repDiff
      return a.priceUsdc - b.priceUsdc
    })

    // Apply limit
    const limited = query.limit ? allAgents.slice(0, query.limit) : allAgents

    return {
      agents: limited,
      total: allAgents.length,
      registries: registries.map(r => r.name),
    }
  },

  /**
   * Query a single registry
   */
  async queryRegistry(registry: RegistryConfig, query: DiscoveryQuery): Promise<Agent[]> {
    const url = new URL(registry.discoveryEndpoint)
    const schema = registry.schema.discovery

    // Map query params based on registry schema
    if (query.capabilities?.length && schema.capabilityParam) {
      url.searchParams.set(schema.capabilityParam, query.capabilities.join(','))
    }
    if (query.query && schema.queryParam) {
      url.searchParams.set(schema.queryParam, query.query)
    }
    if (query.limit && schema.limitParam) {
      url.searchParams.set(schema.limitParam, query.limit.toString())
    }
    if (query.maxPrice && schema.maxPriceParam) {
      url.searchParams.set(schema.maxPriceParam, query.maxPrice.toString())
    }

    // Build headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    // Add auth if configured
    if (registry.auth?.type === 'header' && registry.auth.value) {
      headers[registry.auth.key] = registry.auth.value
    } else if (registry.auth?.type === 'bearer' && registry.auth.value) {
      headers['Authorization'] = `Bearer ${registry.auth.value}`
    }

    const cb = getRegistryCircuitBreaker(registry.name)
    const response = await cb.execute(() => fetch(url.toString(), { headers }))

    if (!response.ok) {
      throw new Error(`Registry ${registry.name} returned ${response.status}`)
    }

    const data = await response.json()

    // Extract agents array using path
    const agentsData = schema.agentsPath
      ? getNestedValue(data, schema.agentsPath)
      : data

    if (!Array.isArray(agentsData)) {
      return []
    }

    // Map to standard Agent format
    return agentsData.map(raw => this.mapAgent(registry, raw))
  },

  /**
   * Map raw API response to standard Agent format
   */
  mapAgent(registry: RegistryConfig, raw: Record<string, unknown>): Agent {
    const mapping = registry.schema.discovery.agentMapping ?? {}

    const slug = String(getNestedValue(raw, mapping.slug ?? 'slug') ?? raw.id)
    const invokeUrl = registry.invokeEndpoint
      .replace('{slug}', slug)
      .replace('{agentId}', String(raw.id ?? slug))

    return {
      id: String(getNestedValue(raw, mapping.id ?? 'id') ?? ''),
      name: String(getNestedValue(raw, mapping.name ?? 'name') ?? ''),
      slug,
      description: String(getNestedValue(raw, mapping.description ?? 'description') ?? ''),
      capabilities: toArray(getNestedValue(raw, mapping.capabilities ?? 'capabilities')),
      priceUsdc: Number(getNestedValue(raw, mapping.price ?? 'price') ?? 0),
      reputation: Number(getNestedValue(raw, mapping.reputation ?? 'reputation') ?? undefined),
      registry: registry.name,
      invokeUrl,
      invocationNote: 'The invokeUrl is an internal reference. To invoke this agent, use POST /compose or POST /orchestrate on the WasiAI A2A gateway.',
      metadata: raw,
    }
  },

  /**
   * Get a specific agent by slug
   */
  async getAgent(slug: string, registryId?: string): Promise<Agent | null> {
    const registries = registryId
      ? [await registryService.get(registryId)].filter(Boolean) as RegistryConfig[]
      : await registryService.getEnabled()

    for (const registry of registries) {
      try {
        if (!registry.agentEndpoint) continue

        const url = registry.agentEndpoint
          .replace('{slug}', slug)
          .replace('{agentId}', slug)

        const response = await fetch(url, {
          headers: { 'Content-Type': 'application/json' },
        })

        if (response.ok) {
          const data = await response.json()
          return this.mapAgent(registry, data)
        }
      } catch {
        continue
      }
    }

    return null
  },
}

// Helper: Get nested value from object using dot notation
function getNestedValue(obj: unknown, path: string): unknown {
  return path.split('.').reduce((current, key) => {
    if (current && typeof current === 'object' && key in current) {
      return (current as Record<string, unknown>)[key]
    }
    return undefined
  }, obj)
}

// Helper: Convert value to array
function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string') return value.split(',').map(s => s.trim())
  return []
}
