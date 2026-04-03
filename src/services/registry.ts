/**
 * Registry Service — Manages marketplace registrations
 */

import type { RegistryConfig, RegistrySchema, RegistryAuth } from '../types/index.js'

// In-memory store (replace with DB in production)
const registries = new Map<string, RegistryConfig>()

// Pre-register WasiAI
registries.set('wasiai', {
  id: 'wasiai',
  name: 'WasiAI',
  discoveryEndpoint: 'https://app.wasiai.io/api/v1/capabilities',
  invokeEndpoint: 'https://app.wasiai.io/api/v1/models/{slug}/invoke',
  agentEndpoint: 'https://app.wasiai.io/api/v1/agents/{slug}',
  schema: {
    discovery: {
      capabilityParam: 'tag',
      queryParam: 'q',
      limitParam: 'limit',
      maxPriceParam: 'max_price',
      agentsPath: 'agents',
      agentMapping: {
        id: 'id',
        name: 'name',
        slug: 'slug',
        description: 'description',
        capabilities: 'tags',
        price: 'price_per_call_usdc',
        reputation: 'erc8004.reputation_score',
      },
    },
    invoke: {
      method: 'POST',
      inputField: 'input',
      resultPath: 'result',
    },
  },
  auth: {
    type: 'header',
    key: 'x-agent-key',
  },
  enabled: true,
  createdAt: new Date(),
})

export const registryService = {
  /**
   * List all registries
   */
  list(): RegistryConfig[] {
    return Array.from(registries.values())
  },

  /**
   * Get a specific registry
   */
  get(id: string): RegistryConfig | undefined {
    return registries.get(id)
  },

  /**
   * Register a new marketplace
   */
  register(config: Omit<RegistryConfig, 'id' | 'createdAt'>): RegistryConfig {
    const id = config.name.toLowerCase().replace(/\s+/g, '-')
    
    if (registries.has(id)) {
      throw new Error(`Registry '${id}' already exists`)
    }

    const registry: RegistryConfig = {
      ...config,
      id,
      createdAt: new Date(),
    }

    registries.set(id, registry)
    return registry
  },

  /**
   * Update a registry
   */
  update(id: string, updates: Partial<RegistryConfig>): RegistryConfig {
    const existing = registries.get(id)
    if (!existing) {
      throw new Error(`Registry '${id}' not found`)
    }

    const updated = { ...existing, ...updates, id }  // Don't allow changing ID
    registries.set(id, updated)
    return updated
  },

  /**
   * Delete a registry
   */
  delete(id: string): boolean {
    if (id === 'wasiai') {
      throw new Error('Cannot delete the WasiAI registry')
    }
    return registries.delete(id)
  },

  /**
   * Get all enabled registries
   */
  getEnabled(): RegistryConfig[] {
    return Array.from(registries.values()).filter(r => r.enabled)
  },
}
