/**
 * Discovery Routes — Search agents across registries
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  InvalidAllowTrialError,
  InvalidLimitError,
  InvalidMinReputationError,
  parseAllowTrial,
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
  raw: { minReputation: unknown; limit: unknown; allowTrial: unknown },
):
  | {
      minReputation: number | undefined;
      limit: number | undefined;
      allowTrial: boolean | undefined;
    }
  | undefined {
  try {
    return {
      minReputation: parseMinReputation(raw.minReputation),
      limit: parseLimit(raw.limit),
      // WKH-313: se valida acá, en el helper COMPARTIDO por GET y POST, y no en
      // cada handler. El POST es el que se olvida: un flag que sólo se valida en
      // GET deja al otro camino aceptando basura por el mismo endpoint.
      allowTrial: parseAllowTrial(raw.allowTrial),
    };
  } catch (err) {
    if (
      err instanceof InvalidMinReputationError ||
      err instanceof InvalidLimitError ||
      err instanceof InvalidAllowTrialError
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
   * - allowTrial: WKH-313 — OPT-IN al CARRIL DE ESTRENO. `'true'` admite, bajo
   *   `minReputation`, a agentes sin historial (0 liquidadas, 0 fallos) que además
   *   pasen el techo `T` y el cupo `M` por publicador. Ausente/`'false'` = el
   *   comportamiento de hoy, byte por byte, incluido el costo de I/O. El admitido
   *   NO recibe score fabricado: conserva su puntaje real (0) y ordena ÚLTIMO, así
   *   que sólo puede ser elegido cuando NINGÚN agente pasa por mérito, y viene
   *   marcado con `agents[].trial`. Para que ese "ordena último" sea CIERTO también
   *   para un agente federado, el admitido se surfacea con `verified: false` y con
   *   `reputation` = su score REAL: los dos son campos que el card AUTO-REPORTA y
   *   son las dos primeras claves del ranking (AR fix-pack BLQ-ALTO-1). Cualquier
   *   valor que no sea `'true'`/`'false'` → 400 `INVALID_ALLOW_TRIAL` (nunca se
   *   adivina un flag de riesgo).
   *
   * Respuesta — contrato de paginación (fix-pack P1, hallazgo 1):
   * - `agents`: hasta `limit` matches, ordenados verified-first → reputación
   *   desc → precio asc.
   * - `total`: cantidad de agentes que matchean TODOS los filtros, ANTES de
   *   aplicar `limit`. Es el denominador para paginar, así que
   *   `total >= agents.length`. NO es el tamaño de la página. WKH-313 (R-5):
   *   SUBE cuando hay admitidos por estreno — es un cambio observable para quien
   *   pagina con `allowTrial=true`.
   * - `registries`: nombres de los registries que contribuyeron.
   * - `excluded`: `{ scope, reputation, trialAvailable, standingUnavailable }` —
   *   cuántos descartó cada filtro de candidatura, para que un conjunto vacío pueda
   *   explicarse. `standingUnavailable: true` significa que el gateway NO PUDO LEER
   *   el historial: sin score nadie pasa el piso, así que `reputation` cuenta
   *   exclusiones reales pero NO significan "estos agentes no llegan" (AR fix-pack
   *   BLQ-BAJO-4). `trialAvailable` es exacto con `allowTrial` y una COTA SUPERIOR
   *   sin él (el cupo por publicador se aplica después).
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
          allowTrial?: string;
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
        allowTrial: query.allowTrial,
      });
      if (!filters) return reply;

      const result = await discoveryService.discover({
        capabilities: query.capabilities?.split(',').map((s) => s.trim()),
        query: query.q,
        maxPrice: query.maxPrice ? parseFloat(query.maxPrice) : undefined,
        minReputation: filters.minReputation,
        allowTrial: filters.allowTrial,
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
   *
   * WKH-313: `allowTrial` (booleano) se valida con el MISMO helper que el GET, así
   * que los dos caminos parsean idéntico. Un flag de riesgo validado en un solo
   * verbo deja al otro aceptando basura por el mismo endpoint.
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
          allowTrial?: boolean;
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
        allowTrial: body.allowTrial,
      });
      if (!filters) return reply;

      const result = await discoveryService.discover({
        capabilities,
        query: body.q != null ? String(body.q) : undefined,
        maxPrice: body.maxPrice != null ? Number(body.maxPrice) : undefined,
        minReputation: filters.minReputation,
        allowTrial: filters.allowTrial,
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
