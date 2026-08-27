/**
 * Agent Detail Resolver — WKH-369 (detalle federado con capacidades reales)
 *
 * `GET /discover/<slug>` y `GET /agents/<slug>/agent-card` publicaban
 * `capabilities: []` para todo agente federado: el endpoint de DETALLE del
 * registro no devuelve el campo que el `agentMapping` declara (medido: el crudo
 * del detalle trae 28 claves y ninguna de capacidades), así que el mapper
 * mapeaba bien un dato que no estaba. La única fuente que lo tiene es la LISTA.
 *
 * Consumido SÓLO por las dos rutas GRATIS de detalle (`routes/discover.ts`,
 * `routes/agent-card.ts`). NUNCA por `/compose`, `/orchestrate` ni la cotización.
 *
 * CD-11: `services/discovery.ts` no se toca. `getAgent` tiene call-sites en el
 *   camino del dinero; meter I/O adentro le agregaría llamadas upstream por step.
 *   Por eso el enriquecimiento vive acá y no en el mapper.
 * CD-10: el catálogo se pide por `registry_id` (PK), NUNCA por `registry`
 *   (display name). Con el nombre, la consulta devuelve cero agentes y se
 *   anuncia `complete`: no falla, miente.
 * CD-9: si el listado no resuelve, la salida es `'unresolved'` — jamás una
 *   aproximación derivada de `category` u otra heurística del detalle.
 * CD-16: `metadata` no se toca. Sigue siendo el cuerpo crudo del endpoint de
 *   detalle: es la superficie desde la que otras sondas derivan su input.
 */

import type { Agent } from '../types/index.js';
import { SELF_PUBLISHED_REGISTRY_ID } from '../types/index.js';
import { discoveryService } from './discovery.js';

/**
 * Resuelve la vista de DETALLE de un agente, enriquecida con lo que publica la
 * lista. `registryId` es el mismo valor que hoy recibe `getAgent` (el
 * querystring `?registry=`), y es un ID: termina en `.eq('id', …)`.
 *
 * Aditivo y degradable (Exemplar B): NUNCA produce un 5xx. Si el catálogo no se
 * puede leer, el agente sale igual y la vista se declara no resuelta (AC-2).
 */
export async function resolveAgentForDetailView(
  slug: string,
  registryId?: string,
): Promise<Agent | null> {
  const agent = await discoveryService.getAgent(slug, registryId);
  if (!agent) return null;

  // Self-published: el detalle y la lista salen del MISMO SELECT local, no
  // divergen, y no hay catálogo remoto que consultar. Sin este guard se paga
  // I/O por nada.
  if (agent.registry_id === SELF_PUBLISHED_REGISTRY_ID) return agent;

  try {
    const listado = await discoveryService.discover({
      registry: agent.registry_id,
      // Load-bearing: la lista filtra `status === 'active'` por default y el
      // detalle sirve inactivos. Sin esto, un federado inactivo se declararía
      // no resuelto teniendo capacidades perfectamente resueltas.
      includeInactive: true,
    });
    const entrada = listado.agents.find((a) => a.slug === agent.slug);

    if (entrada) {
      agent.capabilities = entrada.capabilities;
      // `reputation` es opcional y el árbol compila con
      // `exactOptionalPropertyTypes`: copiar lo que la lista publica incluye
      // copiar su AUSENCIA. `mapAgent` siempre lo produce (puede ser NaN), así
      // que la rama de borrado sólo alcanza a una entrada que no lo traiga.
      if (entrada.reputation === undefined) {
        delete agent.reputation;
      } else {
        agent.reputation = entrada.reputation;
      }
      return agent;
    }

    agent.capabilitiesState = 'unresolved';
    return agent;
  } catch {
    agent.capabilitiesState = 'unresolved';
    return agent;
  }
}
