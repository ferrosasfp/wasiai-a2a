/**
 * Discovery Routes — Search agents across registries
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  InvalidLimitError,
  InvalidMinReputationError,
  parseLimit,
  parseMinReputation,
} from '../lib/discovery-query.js';
import { discoveryService } from '../services/discovery.js';

/**
 * Fix-pack P1 (hallazgo 2 + AR MENOR-4): `minReputation` / `limit` inválidos →
 * 400 explícito.
 *
 * Se valida ANTES del fanout: un valor basura no debe gastar un round-trip a los
 * registries ni devolver 200-vacío (o, en el caso de `limit`, un 200 con MÁS
 * agentes de los pedidos). Devuelve los valores normalizados o `undefined` si ya
 * se envió el 400 (para que el handler haga `return reply`).
 */
function parseFiltersOr400(
  reply: FastifyReply,
  raw: { minReputation: unknown; limit: unknown },
):
  | { minReputation: number | undefined; limit: number | undefined }
  | undefined {
  try {
    return {
      minReputation: parseMinReputation(raw.minReputation),
      limit: parseLimit(raw.limit),
    };
  } catch (err) {
    if (
      err instanceof InvalidMinReputationError ||
      err instanceof InvalidLimitError
    ) {
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
   * - limit: max results (PAGE SIZE — ver el contrato de la respuesta). Entero
   *   SEGURO `>= 1`; ausente = sin page size (todos los matches). Valor no entero,
   *   `0`, negativo, no numérico o fuera del rango seguro (`1e21`) → 400
   *   `INVALID_LIMIT` (AR MENOR-4 + it3 MENOR-3: antes `limit=0` devolvía TODO el
   *   catálogo, `limit=-3` devolvía `total-3` por el `slice(0,-3)` y `limit=1e21`
   *   se reenviaba upstream como `'1e+21'` → 200 con 0 agentes; los tres
   *   contradiciendo el contrato documentado).
   * - registry: filter to specific registry
   *
   * Respuesta — contrato de paginación (fix-pack P1, hallazgo 1):
   * - `agents`: hasta `limit` matches, ordenados verified-first → reputación
   *   desc → precio asc.
   * - `total`: cantidad de agentes que matchean TODOS los filtros, ANTES de
   *   aplicar `limit`. Es el denominador para paginar, así que
   *   `total >= agents.length`. NO es el tamaño de la página.
   * - `registries`: nombres de las fuentes que APORTARON FILAS. WKH-318: antes
   *   listaba los registries CONFIGURADOS, así que un registro que fallaba
   *   aparecía igual y la respuesta afirmaba haberlo consultado. El tipo
   *   (`string[]`) y el nombre no cambian; el valor sólo se acorta cuando una
   *   fuente realmente no aportó nada.
   * - `sources`: estado POR FUENTE. `state` es `ok` (respondió y trajo todo lo
   *   que tiene para esta query) | `truncated` (respondió, pero hay más filas
   *   que no trajimos) | `failed` (no se la pudo consultar). `rows` son las
   *   filas que aportó ANTES de los filtros locales, y es `null` — no 0 —
   *   cuando `state` es `failed`: 0 significa "le pregunté y no tiene", `null`
   *   significa "no pude preguntarle".
   * - `catalogStatus`: roll-up de la request. `complete` | `truncated` |
   *   `partial`, con precedencia `partial` > `truncated` > `complete`.
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

      const filters = parseFiltersOr400(reply, {
        minReputation: query.minReputation,
        limit: query.limit,
      });
      if (!filters) return reply;

      const result = await discoveryService.discover({
        capabilities: query.capabilities?.split(',').map((s) => s.trim()),
        query: query.q,
        maxPrice: query.maxPrice ? parseFloat(query.maxPrice) : undefined,
        minReputation: filters.minReputation,
        limit: filters.limit,
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

      const filters = parseFiltersOr400(reply, {
        minReputation: body.minReputation,
        limit: body.limit,
      });
      if (!filters) return reply;

      const result = await discoveryService.discover({
        capabilities,
        query: body.q != null ? String(body.q) : undefined,
        maxPrice: body.maxPrice != null ? Number(body.maxPrice) : undefined,
        minReputation: filters.minReputation,
        limit: filters.limit,
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
