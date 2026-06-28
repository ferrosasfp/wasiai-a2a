/**
 * Capabilities Route — read-only capabilities summary.
 *
 * Some clients/demos probe `GET /capabilities` (instead of `/discover`) to
 * learn what the gateway supports. Historically that 404'd. This route returns
 * a minimal, read-only capabilities document: the gateway's own self Agent Card
 * skills (supported methods), the chains the registry has initialized, and the
 * live discovered agent list (same source as `/discover`).
 *
 * Read-only: no money movement, no mutations.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  getChainConfig,
  getDefaultChainKey,
  getInitializedChainKeys,
} from '../adapters/registry.js';
import { agentCardService, resolveBaseUrl } from '../services/agent-card.js';
import { discoveryService } from '../services/discovery.js';

const capabilitiesRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /capabilities
   * Returns a read-only summary of gateway capabilities:
   * - methods: supported A2A gateway skills (discover/compose/orchestrate)
   * - chains: chains the adapter registry has initialized
   * - agents: live discovered agents (alias of /discover)
   */
  fastify.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const baseUrl = resolveBaseUrl(request);
    const card = agentCardService.buildSelfAgentCard(baseUrl);

    const chains = getInitializedChainKeys().map((key) => {
      const config = getChainConfig(key);
      return {
        key,
        name: config.name,
        chainId: config.chainId,
        isDefault: key === getDefaultChainKey(),
      };
    });

    const discovered = await discoveryService.discover({});

    return reply.send({
      name: card.name,
      description: card.description,
      url: card.url,
      protocol: 'a2a',
      capabilities: card.capabilities,
      methods: card.skills,
      inputModes: card.inputModes,
      outputModes: card.outputModes,
      chains,
      agents: discovered.agents,
      agentsTotal: discovered.total,
      registries: discovered.registries,
    });
  });
};

export default capabilitiesRoutes;
