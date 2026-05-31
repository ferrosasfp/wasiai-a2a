import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { BazaarSchemaError } from '../lib/bazaar.js';
import { agentCardService, resolveBaseUrl } from '../services/agent-card.js';
import {
  discoveryService,
  extractDeclaredTokenId,
} from '../services/discovery.js';
import { identityService } from '../services/identity.js';
import { registryService } from '../services/registry.js';

const agentCardRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /agents/:slug/agent-card
   * Returns an A2A-compliant Agent Card for the given agent.
   *
   * WKH-106 (BASE-03):
   *   - Includes `inputSchema` / `outputSchema` only when the manifest
   *     declares `discoverable: true` (CD-1 opt-in default).
   *   - Returns HTTP 422 with `error_code: 'BAZAAR_SCHEMA_INVALID'` when
   *     the manifest declares `discoverable: true` but the schemas are
   *     malformed (AC-4 / CD-7).
   */
  fastify.get(
    '/:slug/agent-card',
    async (
      request: FastifyRequest<{
        Params: { slug: string };
        Querystring: { registry?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { slug } = request.params;
      const { registry } = request.query;

      const agent = await discoveryService.getAgent(slug, registry);

      if (!agent) {
        return reply.status(404).send({ error: 'Agent not found' });
      }

      // ⚠️ CD-9: Agent.registry = name, NOT id. Match by name.
      const registries = await registryService.getEnabled();
      const registryConfig = registries.find((r) => r.name === agent.registry);

      if (!registryConfig) {
        return reply.status(404).send({ error: 'Agent not found' });
      }

      const baseUrl = resolveBaseUrl(request);
      // WKH-100 FIX-PACK v2 (MNR-1 / DT-22.5): resolve the verified ERC-8004
      // identity by the BIDIRECTIONAL match — the token the AGENT DECLARES in
      // its card crossed with a binding that declares operating
      // (agent.registry, agent.slug). Public, no budget. No declaration / no
      // bidirectional match → no badge (inverse-vector spoofing closed).
      const decl = extractDeclaredTokenId(agent);
      const identity = decl
        ? await identityService.resolveIdentityForAgent(
            decl.tokenId,
            decl.chainId,
            agent.registry_id,
            agent.slug,
          )
        : null;
      try {
        const card = agentCardService.buildAgentCard(
          agent,
          registryConfig,
          baseUrl,
          identity ?? undefined,
        );

        return reply.send(card);
      } catch (err) {
        // WKH-106 AC-4 / CD-7: malformed Bazaar schemas → HTTP 422.
        // The error_code helps callers (e.g. wasiai-v2 dashboard) surface
        // a meaningful message to the agent dev who declared bad schemas.
        if (err instanceof BazaarSchemaError) {
          return reply.status(422).send({
            error: err.message,
            error_code: 'BAZAAR_SCHEMA_INVALID',
            field: err.field,
            details: err.details,
          });
        }
        throw err;
      }
    },
  );
};

export default agentCardRoutes;
