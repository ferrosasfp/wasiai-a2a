import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { getBaseNetwork } from '../adapters/base/chain.js';
import {
  erc8004ReputationReader,
  resolveReputationRegistryAddress,
} from '../adapters/erc8004-reputation.js';
import { BazaarSchemaError } from '../lib/bazaar.js';
import { agentCardService, resolveBaseUrl } from '../services/agent-card.js';
import {
  discoveryService,
  extractDeclaredTokenId,
} from '../services/discovery.js';
import { identityService } from '../services/identity.js';
import { registryService } from '../services/registry.js';
import { reputationService } from '../services/reputation.js';
import type { AgentReputation } from '../types/index.js';

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
      // WKH-103 (DT-8): score off-chain resuelto antes del build. Graceful
      // (AC-4/CD-5). Se computa en el ROUTE (NO en getAgent) para una sola
      // fuente y para tener el score listo cuando W3 agregue el on-chain.
      let computedReputation: AgentReputation | undefined;
      try {
        computedReputation =
          (await reputationService.computeReputationForAgent(agent.slug)) ??
          undefined;
      } catch {
        computedReputation = undefined; // sin reputación, NUNCA 5xx (CD-5)
      }

      // WKH-103 W3 (AC-7): read on-chain OPCIONAL. SOLO aquí (single-agent),
      // NUNCA en /discover (CD-13). Additive: NO altera `score` (DT-3.1), NO se
      // cachea (DT-4). Requiere env configurada + token declarado por el agente.
      if (
        computedReputation &&
        decl &&
        resolveReputationRegistryAddress(getBaseNetwork())
      ) {
        try {
          const onchain = await erc8004ReputationReader.read({
            agentId: BigInt(decl.tokenId),
          });
          if (onchain.ok && onchain.value !== undefined) {
            computedReputation = {
              ...computedReputation,
              source: 'hybrid',
              onchain: {
                value: onchain.value,
                chain_id: onchain.chainId ?? 0,
              },
            };
          }
          // onchain falla → se deja source='off-chain' sin campo onchain (AC-8).
        } catch {
          /* on-chain read falla → score off-chain intacto, NUNCA 5xx (CD-5) */
        }
      }

      try {
        const card = agentCardService.buildAgentCard(
          agent,
          registryConfig,
          baseUrl,
          identity ?? undefined,
          computedReputation,
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
