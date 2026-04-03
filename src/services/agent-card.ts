import type { FastifyRequest } from 'fastify'
import type { Agent, AgentCard, AgentSkill, RegistryConfig } from '../types/index.js'

/**
 * Resolve the public base URL for the gateway.
 *
 * Resolution order:
 *   1. env `BASE_URL` (explicit, highest priority)
 *   2. `X-Forwarded-Proto` header (set by most proxies) + request.hostname
 *   3. Fallback: request.protocol + request.hostname
 */
export function resolveBaseUrl(request: FastifyRequest): string {
  if (process.env.BASE_URL) {
    return process.env.BASE_URL.replace(/\/$/, '')
  }

  const proto = (request.headers['x-forwarded-proto'] as string | undefined) ?? request.protocol
  return `${proto}://${request.hostname}`
}

export const agentCardService = {
  /**
   * Resolve auth schemes from registry config.
   * bearer → ["bearer"], header → ["apiKey"], query → [], undefined → []
   */
  resolveAuthSchemes(registryConfig: RegistryConfig): string[] {
    if (!registryConfig.auth?.type) return []

    switch (registryConfig.auth.type) {
      case 'bearer':
        return ['bearer']
      case 'header':
        return ['apiKey']
      case 'query':
        return []
    }

    return []
  },

  /**
   * Build an A2A Agent Card from an internal Agent + its registry config.
   */
  buildAgentCard(agent: Agent, registryConfig: RegistryConfig, baseUrl: string): AgentCard {
    const skills: AgentSkill[] = agent.capabilities.map((cap) => ({
      id: cap,
      name: cap,
      description: cap,
    }))

    return {
      name: agent.name,
      description: agent.description,
      url: `${baseUrl}/agents/${agent.slug}`,
      capabilities: {
        streaming: false,
        pushNotifications: false,
      },
      skills,
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
      authentication: {
        schemes: this.resolveAuthSchemes(registryConfig),
      },
    }
  },

  /**
   * Build the gateway's own Agent Card (self-card).
   */
  buildSelfAgentCard(baseUrl: string): AgentCard {
    return {
      name: 'WasiAI A2A Gateway',
      description:
        'A2A-compliant gateway that discovers, composes, and orchestrates AI agents from multiple registries',
      url: baseUrl,
      capabilities: {
        streaming: false,
        pushNotifications: false,
      },
      skills: [
        {
          id: 'discover',
          name: 'Discover Agents',
          description: 'Search and discover AI agents across multiple registries',
        },
        {
          id: 'compose',
          name: 'Compose Agents',
          description: 'Execute multi-agent pipelines with sequential steps',
        },
        {
          id: 'orchestrate',
          name: 'Orchestrate Agents',
          description: 'Goal-based orchestration that automatically selects and chains agents',
        },
      ],
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
      authentication: {
        schemes: [],
      },
    }
  },
}
