/**
 * Capability Resolver — HU-208 · "qué capacidad necesito" → "qué agente la cumple".
 *
 * Port del contrato de WAS-187 (wasiai-v2), NO de su implementación: allá
 * `discoverAgent` consultaba la tabla local `agents` con tres `.order()` de
 * PostgREST. Acá no existe esa tabla — el catálogo es FEDERADO (registries
 * externos + self-published) y su equivalente es `discoveryService.discover`.
 *
 * ─── ⚠️ ACÁ NO HAY RANKING PROPIO. A PROPÓSITO. ─────────────────────────
 * "El mejor agente" ya está definido en UN solo lugar: el sort de
 * `runDiscoveryPipeline` (verified → reputación computada desc → precio asc).
 * Esta función NO reordena, NO puntúa y NO desempata: pide el conjunto ya
 * ordenado y se queda con la CABEZA. Un segundo criterio de "mejor" divergiría
 * del primero y nadie se enteraría hasta que eligieran agentes distintos.
 *
 * Por eso tampoco se portó `performance_score` de WAS-187: nuestro
 * `AgentReputation.score` ya se computa desde tasks liquidadas + success_rate +
 * latencia, que es lo que aquella columna medía.
 *
 * ─── Por qué el recorte de discovery NO puede robarnos el ganador ────────
 * `runDiscoveryPipeline` ejecuta, EN ESTE ORDEN: filtros (status, verified,
 * capabilities, maxPrice, minReputation, scope) → `attachReputations` →
 * `sort` → `slice(0, limit)`. Como el recorte va DESPUÉS del sort, sobre una
 * lista ya ordenada sólo puede sacar elementos de la COLA:
 *
 *     sorted.slice(0, N)[0] === sorted[0]   para todo N >= 1
 *
 * O sea que el recorte JAMÁS puede cambiar quién gana; sólo descarta candidatos
 * que no íbamos a elegir. Esto es lo que deja el residual TD-189-1 (el `slice`
 * global sobre un over-fetch por-registry, documentado en `discovery.ts`) FUERA
 * de este camino: ese residual muerde al pool POR SLUG de `compose.resolveAgent`,
 * que pide el catálogo entero SIN filtrar y ahí sí el agente buscado compite
 * contra todo por una ventana finita. Acá el conjunto ya viene reducido a los que
 * cumplen la capacidad y el orden que decide quién sobrevive al recorte es el
 * MISMO que decide el ganador.
 *
 * Esa propiedad se sostiene SÓLO mientras todos los filtros corran antes del
 * sort. Por eso `scope` se implementó dentro del pipeline de discovery y no como
 * post-filtro acá sobre la página ya cortada: filtrar después del recorte
 * pondría la precondición de TD-189-1 encima del camino del dinero.
 *
 * ─── ⚠️ NO agregar una restricción de CHAIN ─────────────────────────────
 * Se evaluó y se RECHAZÓ: forzar el rail es hacerle trampa al ranking. El orden
 * verified → reputación → precio se respeta SIEMPRE. Si el agente que queremos no
 * gana, el arreglo va del lado de los DATOS (que se gane la reputación), no del
 * lado del código. `max_price_usdc` y `min_reputation` sí quedan porque son
 * restricciones legítimas del que pide, no una forma de señalar un agente
 * concreto por la puerta de atrás.
 */

import { getLogger } from '../lib/logger.js';
import type {
  A2AAgentKeyRow,
  Agent,
  ComposeStepConstraints,
  DiscoveryQuery,
} from '../types/index.js';
import { discoveryService } from './discovery.js';

const log = getLogger('capability-resolver');

/** Por qué no se pudo resolver una capacidad. Alimenta el cuerpo del 422. */
export type CapabilityResolutionFailure = {
  /**
   * Motivo ACCIONABLE, no un "no hay match" a secas. Un operador que lee "no hay
   * agente" cuando en realidad hay uno que su credencial no alcanza busca el
   * problema en el catálogo, que es el lugar equivocado.
   */
  reason: 'no_candidates' | 'excluded_by_scope' | 'excluded_by_reputation';
  message: string;
};

export type CapabilityResolution =
  | { ok: true; agent: Agent }
  | { ok: false; failure: CapabilityResolutionFailure };

/**
 * Resuelve UNA capacidad al agente que mejor la cumple, dentro del alcance del
 * llamador y de las restricciones declaradas.
 *
 * Fail-closed por contrato: si el conjunto queda vacío devuelve un fallo con el
 * motivo. NUNCA devuelve "alguno" ni el primero de una lista sin filtrar — ese es
 * exactamente el anti-patrón que esta HU viene a NO replicar del lado del
 * servidor.
 */
export async function resolveCapability(
  capability: string,
  constraints: ComposeStepConstraints | undefined,
  scope: A2AAgentKeyRow | undefined,
): Promise<CapabilityResolution> {
  const query: DiscoveryQuery = {
    capabilities: [capability],
    // Sin `query` de texto libre a propósito: el broaden-retry de `discover`
    // está gateado en `total === 0 && query.query`, así que por este camino NUNCA
    // dispara (mismo criterio money-path-safe que usa el planner de /orchestrate).
  };
  if (constraints?.max_price_usdc !== undefined) {
    query.maxPrice = constraints.max_price_usdc;
  }
  if (constraints?.min_reputation !== undefined) {
    query.minReputation = constraints.min_reputation;
  }
  // WKH-313 (DT-7): el opt-in al carril de estreno viaja del step al pipeline. Sin
  // este mapeo el caller manda `allow_trial: true`, pasa la validación de forma y
  // NO PASA NADA — un filtro que el que pide cree haber relajado y no relajó, que es
  // la misma clase de bug (con el signo invertido) que este archivo ya nombra.
  if (constraints?.allow_trial !== undefined) {
    query.allowTrial = constraints.allow_trial;
  }
  if (scope) {
    query.scope = scope;
  }

  const result = await discoveryService.discover(query);
  const best = result.agents[0];

  if (best) {
    return { ok: true, agent: best };
  }

  // ── Conjunto vacío: explicar POR QUÉ, no sólo QUE ────────────────────
  // `excluded` viene de `runDiscoveryPipeline` y dice cuántos candidatos sacó el
  // filtro de candidatura. Importa distinguirlo: el llamador NO declaró un
  // alcance (lo trae su credencial), así que sin este mensaje vería "no hay
  // agente" para algo que sí existe y que otra credencial sí puede usar.
  const excludedByScope = result.excluded?.scope ?? 0;

  if (excludedByScope > 0) {
    return {
      ok: false,
      failure: {
        reason: 'excluded_by_scope',
        message: `No agent fulfilling capability '${capability}' is within this key's scope`,
      },
    };
  }

  // WKH-313 (DT-10): el conjunto vaciado POR EL PISO tiene su propio motivo. Hasta
  // acá volvía como `no_candidates`, o sea INDISTINGUIBLE de "esa capacidad no
  // existe" — y ese diagnóstico costó tres semanas de confusión en Chaski, donde el
  // agente existía y lo excluía un piso de 2 que él no podía alcanzar por no haber
  // trabajado nunca. Se evalúa DESPUÉS del alcance: si la credencial ni siquiera
  // alcanza al agente, ese es el problema de más arriba y gana.
  const excludedByReputation = result.excluded?.reputation ?? 0;
  if (excludedByReputation > 0) {
    const trialAvailable = result.excluded?.trialAvailable ?? 0;
    return {
      ok: false,
      failure: {
        reason: 'excluded_by_reputation',
        message:
          `No agent fulfilling capability '${capability}' meets the requested min_reputation` +
          (trialAvailable > 0
            ? `; ${trialAvailable} candidate(s) have no settled history yet and would be admitted with 'allow_trial'`
            : ''),
      },
    };
  }
  return {
    ok: false,
    failure: {
      reason: 'no_candidates',
      message: `No agent fulfills capability '${capability}'`,
    },
  };
}

/**
 * Resuelve todas las capacidades de un pipeline, memoizando por clave de
 * resolución.
 *
 * La memoización NO es sólo un ahorro de latencia (`discover` abre fanout a todos
 * los registries y un pipeline puede traer hasta `MAX_COMPOSE_STEPS` steps): dos
 * steps que pidan LA MISMA capacidad con LAS MISMAS restricciones tienen que
 * resolver al MISMO agente dentro de una misma request. Sin memo, dos llamadas
 * consecutivas a `discover` pueden devolver rankings distintos (fetch en vivo +
 * reputación recomputada) y el pipeline quedaría internamente inconsistente.
 *
 * La clave incluye las restricciones porque cambian el conjunto de candidatos;
 * el alcance no entra en la clave porque es el mismo para toda la request.
 */
export function createCapabilityResolver(scope: A2AAgentKeyRow | undefined): {
  resolve(
    capability: string,
    constraints: ComposeStepConstraints | undefined,
  ): Promise<CapabilityResolution>;
} {
  const memo = new Map<string, Promise<CapabilityResolution>>();
  return {
    resolve(capability, constraints) {
      const key = `${capability}::${JSON.stringify({
        p: constraints?.max_price_usdc ?? null,
        r: constraints?.min_reputation ?? null,
        // WKH-313 (R-4): `allow_trial` ENTRA a la clave porque cambia el conjunto de
        // candidatos. Sin él, dos steps de la misma capability con opt-in distinto
        // comparten la resolución memoizada, y el que NO optó recibiría un agente en
        // estreno que nunca aceptó — sobre el camino del dinero.
        t: constraints?.allow_trial ?? null,
      })}`;
      let pending = memo.get(key);
      if (!pending) {
        pending = resolveCapability(capability, constraints, scope);
        memo.set(key, pending);
      }
      return pending;
    },
  };
}

/**
 * Telemetría de una elección server-side. Se emite SIEMPRE que el gateway elige
 * (no sólo cuando falla): una decisión automática que no deja rastro no es
 * auditable después, y el llamador no la pidió por slug así que no puede
 * reconstruirla desde su propio request.
 */
export function logCapabilityChoice(
  capability: string,
  agent: Agent,
  requestId: string,
): void {
  log.info(
    {
      capability,
      chosenSlug: agent.slug,
      registry: agent.registry,
      verified: agent.verified,
      reputation: agent.computedReputation?.score ?? null,
      priceUsdc: agent.priceUsdc,
      requestId,
    },
    '[compose.capability-resolved]',
  );
}
