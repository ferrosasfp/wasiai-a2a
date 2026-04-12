/**
 * Discovery Routes — Search agents across registries
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { discoveryService } from '../services/discovery.js';

const discoverRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /discover
   * Search agents across all registered marketplaces
   *
   * Query params:
   * - capabilities: comma-separated list of capabilities
   * - q: free text search
   * - maxPrice: maximum price per call in USDC
   * - minReputation: minimum reputation score (0-1)
   * - limit: max results
   * - registry: filter to specific registry
   */
  fastify.get(
    '/',
    { config: { rateLimit: false } },
    async (
      request: FastifyRequest<{
        Querystring: {
          capabilities?: string;
          q?: string;
          maxPrice?: string;
          minReputation?: string;
          limit?: string;
          registry?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const query = request.query;

      const result = await discoveryService.discover({
        capabilities: query.capabilities?.split(',').map((s) => s.trim()),
        query: query.q,
        maxPrice: query.maxPrice ? parseFloat(query.maxPrice) : undefined,
        minReputation: query.minReputation
          ? parseFloat(query.minReputation)
          : undefined,
        limit: query.limit ? parseInt(query.limit, 10) : undefined,
        registry: query.registry,
      });

      return reply.send(result);
    },
  );

  /**
   * POST /discover
   * Same as GET /discover but reads params from JSON body (WKH-DISCOVER-POST)
   */
  fastify.post(
    '/',
    { config: { rateLimit: false } },
    async (
      request: FastifyRequest<{
        Body: {
          capabilities?: string | string[];
          q?: string;
          maxPrice?: number;
          minReputation?: number;
          limit?: number;
          registry?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const body = (request.body ?? {}) as Record<string, unknown>;

      // Normalize capabilities: accept comma-separated string or string array
      let capabilities: string[] | undefined;
      if (body.capabilities) {
        if (Array.isArray(body.capabilities)) {
          capabilities = (body.capabilities as string[]).map((s) =>
            String(s).trim(),
          );
        } else {
          capabilities = String(body.capabilities)
            .split(',')
            .map((s) => s.trim());
        }
      }

      const result = await discoveryService.discover({
        capabilities,
        query: body.q != null ? String(body.q) : undefined,
        maxPrice: body.maxPrice != null ? Number(body.maxPrice) : undefined,
        minReputation:
          body.minReputation != null ? Number(body.minReputation) : undefined,
        limit: body.limit != null ? Number(body.limit) : undefined,
        registry: body.registry != null ? String(body.registry) : undefined,
      });

      return reply.send(result);
    },
  );

  /**
   * GET /discover/:slug
   * Get a specific agent by slug
   */
  fastify.get(
    '/:slug',
    { config: { rateLimit: false } },
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

      return reply.send(agent);
    },
  );
};

export default discoverRoutes;
