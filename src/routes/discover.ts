/**
 * Discovery Routes — Search agents across registries
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  assertKnownDiscoverParams,
  ConflictingMinReputationError,
  InvalidAllowTrialError,
  InvalidDiscoverBodyError,
  InvalidLimitError,
  InvalidMinReputationError,
  parseAllowTrial,
  parseLimit,
  resolveMinReputation,
  UnknownDiscoverParamError,
} from '../lib/discovery-query.js';
import { discoveryService } from '../services/discovery.js';

/**
 * WKH-322 — normaliza el contenedor de parámetros antes de mirar las claves.
 *
 * `null`/`undefined` → `{}`: es el comportamiento vigente del POST con body
 * vacío, pineado por `discover.test.ts` (`payload: {}` → 200 con filtros
 * all-undefined).
 *
 * Un array o un primitivo, en cambio, NO tienen claves nombradas: sobre `[1,2]`
 * el chequeo de abajo leería `['0','1']` y contestaría `unknown parameter '0'`,
 * que es ruidoso e incomprensible a la vez.
 */
function toDiscoverParamBag(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidDiscoverBodyError(raw);
  }
  return raw as Record<string, unknown>;
}

/**
 * Fix-pack P1 (hallazgo 2 + AR MENOR-4): `minReputation` / `limit` inválidos →
 * 400 explícito.
 *
 * Se valida ANTES del fanout: un valor basura no debe gastar un round-trip a los
 * registries ni devolver 200-vacío (o, en el caso de `limit`, un 200 con MÁS
 * agentes de los pedidos). Devuelve los valores normalizados o `undefined` si ya
 * se envió el 400 (para que el handler haga `return reply`).
 *
 * WKH-322 — recibe el BAG CRUDO (`request.query` / `request.body`), no tres
 * campos elegidos a mano. Elegirlos a mano era el bug: el helper nunca veía las
 * claves que nadie eligió, así que no podía notar que existían y `?capability=x`
 * o `?bogusparam=zzz` devolvían 200 con el catálogo entero.
 *
 * El orden de los pasos es una decisión, no un accidente, y está pineado por
 * `T-R31`: primero la FORMA (body válido, claves conocidas) y después los
 * VALORES. Se responde un solo error por request, y una clave desconocida
 * significa que el modelo mental del caller sobre la forma de la API está
 * equivocado; contestarle un error de valor sobre OTRO parámetro lo manda a
 * buscar al lugar equivocado. Es el mismo criterio con que
 * `capability-resolver.ts` ordena los motivos de su 422.
 */
function parseFiltersOr400(
  reply: FastifyReply,
  raw: unknown,
):
  | {
      minReputation: number | undefined;
      limit: number | undefined;
      allowTrial: boolean | undefined;
    }
  | undefined {
  try {
    const bag = toDiscoverParamBag(raw);
    assertKnownDiscoverParams(bag);
    return {
      // WKH-322: los dos nombres del piso (`minReputation` y el alias
      // `min_reputation` de `/compose`) colapsan acá en UN valor, con el mismo
      // validador de rango. Aguas abajo hay un solo campo, así que las dos ramas
      // no pueden divergir en el filtrado.
      minReputation: resolveMinReputation(
        bag.minReputation,
        bag.min_reputation,
      ),
      limit: parseLimit(bag.limit),
      // WKH-313: se valida acá, en el helper COMPARTIDO por GET y POST, y no en
      // cada handler. El POST es el que se olvida: un flag que sólo se valida en
      // GET deja al otro camino aceptando basura por el mismo endpoint.
      allowTrial: parseAllowTrial(bag.allowTrial),
    };
  } catch (err) {
    if (
      err instanceof InvalidDiscoverBodyError ||
      err instanceof UnknownDiscoverParamError ||
      err instanceof ConflictingMinReputationError ||
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
   * - min_reputation: WKH-322 — ALIAS de `minReputation`, con el mismo validador
   *   y el mismo efecto. Existe porque el mismo concepto ya se llama así en
   *   `constraints` de `/compose` (`compose-step-shape.ts:51`), y quien escribía
   *   ese nombre acá recibía 200 sin filtro. Los dos juntos con valores
   *   distintos → 400 `CONFLICTING_MIN_REPUTATION` (no hay precedencia: dos
   *   pisos incompatibles no se pueden honrar los dos).
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
   * WKH-322 — toda clave que no esté en `ALLOWED_DISCOVER_PARAMS`
   * (`lib/discovery-query.ts`) → 400 `UNKNOWN_DISCOVER_PARAM`, con el nombre de
   * la clave ofensora y la lista de las aceptadas. Aplica a esta ruta y al POST
   * de abajo; `GET /discover/:slug` no la usa (TD-322-1).
   *
   * Respuesta — contrato de paginación (fix-pack P1, hallazgo 1):
   * - `agents`: hasta `limit` matches, ordenados verified-first → reputación
   *   desc → precio asc.
   * - `total`: cantidad de agentes que matchean TODOS los filtros, ANTES de
   *   aplicar `limit`. Es el denominador para paginar, así que
   *   `total >= agents.length`. NO es el tamaño de la página. WKH-313 (R-5):
   *   SUBE cuando hay admitidos por estreno — es un cambio observable para quien
   *   pagina con `allowTrial=true`.
   *
   *   HU-323 — TERCER ESTADO: `'unknown'` (string) cuando `catalogStatus` es
   *   `truncated` o `partial`, o sea cuando hay EVIDENCIA de que el catálogo
   *   llegó incompleto. Antes se publicaba igual el conteo de lo que había
   *   entrado; medido en producción, `GET /discover` devolvía `total: 23` sobre
   *   un catálogo de 25 porque la fuente federada cortó en su página de 20. Con
   *   `catalogStatus: 'truncated'` al lado eso no era una mentira, pero un cliente
   *   que lee sólo `total` se llevaba un número que no es el total. Es `'unknown'`
   *   y no `null` ni un campo ausente por la misma razón que
   *   `/health.strandedExposureBreached`: un valor falsy se lee como "no hay
   *   problema" (`total ?? 0` daría 0, peor que 23).
   * - `totalAtLeast`: HU-323 — SIEMPRE un número: los matches que se contaron, o
   *   sea una COTA INFERIOR del total. Es exactamente el valor que `total` traía
   *   antes de esta HU, con el nombre que le corresponde. Cuando `total` es un
   *   número, los dos coinciden.
   * - `registries`: nombres de las fuentes que APORTARON FILAS. WKH-318: antes
   *   listaba los registries CONFIGURADOS, así que un registro que fallaba
   *   aparecía igual y la respuesta afirmaba haberlo consultado. El tipo
   *   (`string[]`) y el nombre no cambian; el valor sólo se acorta cuando una
   *   fuente realmente no aportó nada.
   * - `sources`: estado POR FUENTE. `state` es `ok` (respondió, y hay EVIDENCIA
   *   de que trajo todo lo que tiene para esta query) | `truncated` (respondió,
   *   y hay evidencia de que hay más filas que no trajimos) | `unverified`
   *   (respondió, pero no hay forma de saber si trajo todo) | `failed` (no se la
   *   pudo consultar). `rows` son las filas que aportó ANTES de los filtros
   *   locales, y es `null` — no 0 — cuando `state` es `failed`: 0 significa "le
   *   pregunté y no tiene", `null` significa "no pude preguntarle". En
   *   `unverified` hay número: lo que no se sabe es si eran todas.
   *
   *   `ok` NO es el default: se gana con evidencia, y hoy sólo hay dos formas de
   *   tenerla — que el registro declare `nextCursorPath` y el cursor llegue
   *   vacío, o que se le haya enviado un límite y haya devuelto menos filas que
   *   ese límite. Un registro que contesta sin ninguna de las dos es
   *   `unverified`.
   * - `catalogStatus`: roll-up de la request. `complete` | `unverified` |
   *   `truncated` | `partial`, con precedencia
   *   `partial` > `truncated` > `unverified` > `complete`. `complete` significa
   *   "todas las fuentes probaron haber dado todo", no "ninguna se quejó".
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
          /** WKH-322 — alias de `minReputation`; mismo nombre que en `/compose`. */
          min_reputation?: string;
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

      // WKH-322: se le pasa el query string COMPLETO, no tres campos elegidos a
      // mano, para que el helper pueda ver las claves que no reconoce.
      const filters = parseFiltersOr400(reply, query);
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
          /** WKH-322 — alias de `minReputation`; mismo nombre que en `/compose`. */
          min_reputation?: number;
          allowTrial?: boolean;
          limit?: number;
          registry?: string;
          verified?: boolean;
          includeInactive?: boolean;
        };
      }>,
      reply: FastifyReply,
    ) => {
      // WKH-322: PRIMERO del handler, y con el body CRUDO (el helper resuelve
      // `null`/`undefined` → `{}`). Antes corría después de normalizar
      // `capabilities`: no tiene sentido coercionar los valores de una request
      // que ya está rechazada, y la guarda de forma tiene que correr antes de
      // que alguien lea `body.capabilities` de algo que no es un objeto.
      const filters = parseFiltersOr400(reply, request.body);
      if (!filters) return reply;

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
