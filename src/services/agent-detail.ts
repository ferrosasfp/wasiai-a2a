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
 *
 * ⚠️ COSTO POR REQUEST, medido en el fix-pack (AR BLQ-BAJO-3). El
 * enriquecimiento agrega un `discover()` completo contra UN registro: un fetch
 * upstream con el over-fetch de `resolveUpstreamFetchLimit` (piso 200 filas) y
 * una query a supabase por cada fila devuelta que declare token ERC-8004
 * (`discovery.attachIdentities`). Antes de esta HU el detalle hacía como mucho
 * UNA. Por eso el fix-pack le sacó a `GET /discover/:slug` la exención de rate
 * limit que traía de WKH-AUDIT-A2A: esa exención se había concedido sobre la
 * premisa "read-only y barato de servir", y esta HU es exactamente lo que la
 * invalidó. Ver `routes/discover.ts`.
 */

import { classifyFetchFailure } from '../lib/discovery-sources.js';
import { getLogger } from '../lib/logger.js';
import type { Agent } from '../types/index.js';
import { SELF_PUBLISHED_REGISTRY_ID } from '../types/index.js';
import { discoveryService } from './discovery.js';

const log = getLogger('agent-detail');

/**
 * AC-2 + AR BLQ-BAJO-1: el marcador dice **el gateway no pudo leer las
 * capacidades**, no «no las pude confirmar contra la lista».
 *
 * Si el payload de DETALLE ya trajo capacidades (un registro cuyo
 * `agentMapping.capabilities` sí resuelve en el detalle), esas capacidades son
 * un dato leído de verdad y salen SIN marcador. Marcarlas igual publicaría
 * datos válidos con una etiqueta que le pide al consumidor descartarlos — peor
 * que no etiquetar nada, y auto-contradictorio con la tabla de contrato:
 * `capabilities: [...]` + `capabilitiesState: 'unresolved'` no tiene lectura.
 *
 * La ausencia de confirmación no se pierde: queda en el `log.warn` del
 * call-site, que es donde la puede usar el operador. Lo que NO viaja al cliente
 * es una afirmación que contradice el dato que la acompaña.
 */
function markUnresolvedIfEmpty(agent: Agent): boolean {
  if (agent.capabilities.length > 0) return false;
  agent.capabilitiesState = 'unresolved';
  return true;
}

/**
 * Resuelve la vista de DETALLE de un agente, enriquecida con lo que publica la
 * lista. `registryId` es el mismo valor que hoy recibe `getAgent` (el
 * querystring `?registry=`), y es un ID: termina en `.eq('id', …)`.
 *
 * Aditivo y degradable (Exemplar B): **el enriquecimiento** NUNCA produce un
 * 5xx. Si el catálogo no se puede leer, el agente sale igual y la vista se
 * declara no resuelta (AC-2).
 *
 * ⚠️ El calificativo es load-bearing (CR MNR-2): la FUNCIÓN sí puede 5xxear.
 * `getAgent` corre FUERA del `try` y propaga — su `getWithSecrets` consulta
 * `registries` y una fila inaccesible tira. Está afuera a propósito: sin agente
 * no hay nada que enriquecer, y tragarse ese error convertiría un 500 honesto
 * ("no pude preguntar") en un 404 falso ("no existe"), que es la misma
 * confusión de causas que esta HU existe para matar.
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

    // AR BLQ-MED-1: esta rama y el `catch` producían un payload byte-idéntico y
    // CERO logs. «el agente no está en el catálogo» y «el catálogo no se pudo
    // leer» son causas distintas con acciones distintas, y sin señal
    // estructurada un registro caído durante horas se ve igual que un slug que
    // legítimamente no está publicado. Precedente del repo: WKH-318, que hizo
    // que toda fuente degradada de `discover()` rinda cuentas con un `warn`.
    // El payload sigue siendo el mismo a propósito (el cliente sólo necesita
    // saber que no está confirmado); lo que se separa es la telemetría.
    const marcado = markUnresolvedIfEmpty(agent);
    log.warn(
      {
        error_code: 'DETAIL_AGENT_ABSENT_FROM_CATALOG',
        slug: agent.slug,
        registry_id: agent.registry_id,
        rows: listado.agents.length,
        marked: marcado,
      },
      '[agent-detail.absent-from-catalog] the agent was not in the registry listing; its capabilities could not be confirmed',
    );
    return agent;
  } catch (err) {
    const marcado = markUnresolvedIfEmpty(agent);
    log.warn(
      {
        error_code: 'DETAIL_CATALOG_UNREADABLE',
        slug: agent.slug,
        registry_id: agent.registry_id,
        // Misma clasificación que usa `discover()` para sus `sources[]`: cinco
        // clases nombradas, y lo desconocido es `unknown`, nunca `ok`.
        failure: classifyFetchFailure(err),
        marked: marcado,
      },
      '[agent-detail.catalog-unreadable] the registry listing could not be read; the agent capabilities could not be confirmed',
    );
    return agent;
  }
}
