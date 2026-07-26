/**
 * Discovery Routes — Search agents across registries
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  InvalidMinReputationError,
  parseMinReputation,
} from '../lib/discovery-query.js';
import { discoveryService } from '../services/discovery.js';

/**
 * Fix-pack P1 (hallazgo 2): `minReputation` inválido → 400 explícito.
 *
 * Se valida ANTES del fanout: un valor basura no debe gastar un round-trip a los
 * registries ni devolver 200-vacío. Devuelve la respuesta ya enviada (para que
 * el handler haga `return`) o `undefined` si el valor es válido.
 */
function replyIfInvalidMinReputation(
  reply: FastifyReply,
  raw: unknown,
): { minReputation: number | undefined } | undefined {
  try {
    return { minReputation: parseMinReputation(raw) };
  } catch (err) {
    if (err instanceof InvalidMinReputationError) {
      reply.status(400).send({ error: err.message, code: err.code });
      return undefined;
    }
    throw err;
  }
}

const discoverRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /discover
   * Search agents across all registered marketplaces
   *
   * Query params:
   * - capabilities: comma-separated list of capabilities
   * - q: free text search
   * - maxPrice: maximum price per call in USDC
   * - minReputation: minimum GATEWAY-COMPUTED off-chain reputation score,
   *   scale **0-100** (`agent.computedReputation.score`). Fix-pack P1: este
   *   JSDoc decía "(0-1)" y era falso — la escala real es 0-100
   *   (`AgentReputation.score`). NO filtra por el `reputation` auto-reportado
   *   por el registry: ese valor lo controla la parte que se está filtrando.
   *   Un agente sin tasks liquidadas cuenta 0 → excluido si minReputation > 0.
   *   Valor no numérico o fuera de [0,100] → 400 `INVALID_MIN_REPUTATION`.
   * - limit: max results (PAGE SIZE — ver el contrato de la respuesta)
   * - registry: filter to specific registry
   *
   * Respuesta — contrato de paginación (fix-pack P1, hallazgo 1):
   * - `agents`: hasta `limit` matches, ordenados verified-first → reputación
   *   desc → precio asc.
   * - `total`: cantidad de agentes que matchean TODOS los filtros, ANTES de
   *   aplicar `limit`. Es el denominador para paginar, así que
   *   `total >= agents.length`. NO es el tamaño de la página.
   * - `registries`: nombres de los registries que contribuyeron.
   */
  fastify.get(
    '/',
    async (
      request: FastifyRequest<{
        Querystring: {
          capabilities?: string;
          q?: string;
          maxPrice?: string;
          minReputation?: string;
          limit?: string;
          registry?: string;
          verified?: string;
          includeInactive?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const query = request.query;

      const minRep = replyIfInvalidMinReputation(reply, query.minReputation);
      if (!minRep) return reply;

      const result = await discoveryService.discover({
        capabilities: query.capabilities?.split(',').map((s) => s.trim()),
        query: query.q,
        maxPrice: query.maxPrice ? parseFloat(query.maxPrice) : undefined,
        minReputation: minRep.minReputation,
        limit: query.limit ? parseInt(query.limit, 10) : undefined,
        registry: query.registry,
        verified: query.verified === 'true' ? true : undefined,
        includeInactive: query.includeInactive === 'true' ? true : undefined,
      });

      return reply.send(result);
    },
  );

  /**
   * POST /discover
   * Same as GET /discover but reads params from JSON body (WKH-DISCOVER-POST).
   * Mismo contrato de respuesta que el GET: `total` = matches pre-`limit`
   * (denominador de paginación), `agents` = la página de hasta `limit`.
   */
  fastify.post(
    '/',
    async (
      request: FastifyRequest<{
        Body: {
          capabilities?: string | string[];
          q?: string;
          maxPrice?: number;
          minReputation?: number;
          limit?: number;
          registry?: string;
          verified?: boolean;
          includeInactive?: boolean;
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

      const minRep = replyIfInvalidMinReputation(reply, body.minReputation);
      if (!minRep) return reply;

      const result = await discoveryService.discover({
        capabilities,
        query: body.q != null ? String(body.q) : undefined,
        maxPrice: body.maxPrice != null ? Number(body.maxPrice) : undefined,
        minReputation: minRep.minReputation,
        limit: body.limit != null ? Number(body.limit) : undefined,
        registry: body.registry != null ? String(body.registry) : undefined,
        verified: body.verified === true ? true : undefined,
        includeInactive: body.includeInactive === true ? true : undefined,
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
