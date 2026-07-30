/**
 * Capabilities Route — read-only capabilities summary.
 *
 * Some clients/demos probe `GET /capabilities` (instead of `/discover`) to
 * learn what the gateway supports. Historically that 404'd. This route returns
 * a minimal, read-only capabilities document: the gateway's own self Agent Card
 * skills (supported methods), the chains the registry has initialized, and the
 * live discovered agent list (same source as `/discover`).
 *
 * Read-only: no money movement, no mutations.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  acceptsInboundPayment,
  getAdaptersBundle,
  getChainConfig,
  getDefaultChainKey,
  getInitializedChainKeys,
} from '../adapters/registry.js';
import { agentCardService, resolveBaseUrl } from '../services/agent-card.js';
import { discoveryService } from '../services/discovery.js';

const capabilitiesRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /capabilities
   * Returns a read-only summary of gateway capabilities:
   * - methods: supported A2A gateway skills (discover/compose/orchestrate)
   * - chains: chains the adapter registry has initialized
   * - agents: live discovered agents (alias of /discover)
   */
  fastify.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const baseUrl = resolveBaseUrl(request);
    const card = agentCardService.buildSelfAgentCard(baseUrl);

    // HU-204: `chains` listaba TODA chain inicializada como si fuera una red de
    // pago viva. No lo es: una chain outbound-only (el rail Solana) liquida del
    // gateway HACIA el agente pero no acepta cobro de entrada, así que un
    // integrador que leía esta lista y mandaba `x-payment-chain: solana-devnet`
    // se comía un rechazo. `acceptsInboundPayment` publica esa asimetría.
    //
    // Cambio ADITIVO sobre una respuesta pública: los 4 campos anteriores
    // (`key`, `name`, `chainId`, `isDefault`) quedan intactos con el mismo
    // nombre y el mismo valor — sólo se agrega uno.
    const chains = getInitializedChainKeys().map((key) => {
      const config = getChainConfig(key);
      const bundle = getAdaptersBundle(key);
      return {
        key,
        name: config.name,
        chainId: config.chainId,
        isDefault: key === getDefaultChainKey(),
        /**
         * `true`  → acepta cobro de ENTRADA (caller → gateway) vía x402.
         * `false` → sólo liquidación de SALIDA (gateway → agente). Usable con
         *           agent key prepaga, NO con `x-payment-chain` en un x402.
         */
        acceptsInboundPayment:
          bundle !== undefined && acceptsInboundPayment(bundle),
      };
    });

    const discovered = await discoveryService.discover({});

    return reply.send({
      name: card.name,
      description: card.description,
      url: card.url,
      protocol: 'a2a',
      capabilities: card.capabilities,
      methods: card.skills,
      inputModes: card.inputModes,
      outputModes: card.outputModes,
      chains,
      agents: discovered.agents,
      agentsTotal: discovered.total,
      registries: discovered.registries,
      // WKH-318: cambio ADITIVO sobre una respuesta pública — mismo patrón que
      // HU-204 en este archivo (:41-43). Los 11 campos previos quedan intactos,
      // con el mismo nombre y el mismo valor. Esta superficie replicaba el bug:
      // afirmaba haber consultado registros que no habían contestado.
      catalogStatus: discovered.catalogStatus,
      sources: discovered.sources,
    });
  });
};

export default capabilitiesRoutes;
