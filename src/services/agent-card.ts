import type { FastifyRequest } from 'fastify';
import {
  APP_ALIGNMENT_DISCLAIMER,
  getSupportedAppIntents,
} from '../adapters/app-intent-mapper.js';
import { getInboundPaymentChainKeys } from '../adapters/registry.js';
import { validateAgentSchemas } from '../lib/bazaar.js';
import {
  CONTRACTING_CHAIN_HEADER,
  CONTRACTING_DEPTH_HEADER,
  CONTRACTING_LAYER2_BEST_EFFORT_NOTE,
  resolveContractingDepthMax,
} from '../lib/contracting-chain.js';
import type {
  Agent,
  AgentCard,
  AgentCardIdentity,
  AgentReputation,
  AgentSkill,
  RegistryConfig,
} from '../types/index.js';
import { getProtocolFeeRate } from './fee-charge.js';

/**
 * WKH-106 (BASE-03): read the agent's discoverable opt-in flag.
 * Returns true ONLY when `metadata.discoverable === true` (strict literal).
 * Truthy values like 'true' / 1 are NOT promoted — CD-1 demands explicit
 * opt-in. Default (absent or false) → opt-out (no schemas surfaced).
 */
function isDiscoverable(agent: Agent): boolean {
  return agent.metadata?.discoverable === true;
}

/**
 * WKH-141 (CD-4): global feature flag for the APP bridge. ON only with the exact
 * literal 'true' (patrón WKH-133 `isWritebackEnabled`). Default OFF → con flag OFF
 * el Agent Card es byte-idéntico al estado pre-HU.
 */
function isAppBridgeEnabled(): boolean {
  return process.env.APP_BRIDGE_ENABLED === 'true';
}

/**
 * WKH-141: per-agent opt-in estricto. Sólo `metadata.appPaymentIntents === true`
 * (mismo patrón que `isDiscoverable`). Truthy no-literal (p.ej. 'true'/1) NO promueve.
 */
function appPaymentIntentsOptIn(agent: Agent): boolean {
  return agent.metadata?.appPaymentIntents === true;
}

/**
 * WKH-106: extract a JSON-Schema-like object from metadata. Returns
 * `undefined` if the field is absent or not a plain object. AGGREGATE
 * VALIDATION (compileability + schema-draft check) happens via
 * `validateAgentSchemas` in `buildAgentCard`.
 */
function readSchemaField(
  agent: Agent,
  field: 'inputSchema' | 'outputSchema',
): Record<string, unknown> | undefined {
  const raw = agent.metadata?.[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

/**
 * Resolve the public base URL for the gateway.
 *
 * Resolution order:
 *   1. env `BASE_URL` (explicit, highest priority)
 *   2. `X-Forwarded-Proto` header (set by most proxies) + request.hostname
 *   3. Fallback: request.protocol + request.hostname
 */
export function resolveBaseUrl(request: FastifyRequest): string {
  if (process.env.BASE_URL) {
    return process.env.BASE_URL.replace(/\/$/, '');
  }

  const proto =
    (request.headers['x-forwarded-proto'] as string | undefined) ??
    request.protocol;
  return `${proto}://${request.hostname}`;
}

export const agentCardService = {
  /**
   * Resolve auth schemes from registry config.
   * bearer → ["bearer"], header → ["apiKey"], query → [], undefined → []
   */
  resolveAuthSchemes(registryConfig: RegistryConfig): string[] {
    if (!registryConfig.auth?.type) return [];

    switch (registryConfig.auth.type) {
      case 'bearer':
        return ['bearer'];
      case 'header':
        return ['apiKey'];
      case 'query':
        return [];
    }

    return [];
  },

  /**
   * Build an A2A Agent Card from an internal Agent + its registry config.
   *
   * WKH-106 (BASE-03): when `agent.metadata.discoverable === true`, the
   * returned card includes the agent's `inputSchema` / `outputSchema`
   * (AC-1 / AC-6). Schemas are validated via `validateAgentSchemas`
   * BEFORE inclusion — if invalid, throws `BazaarSchemaError` which the
   * route handler maps to HTTP 422 (AC-4 / CD-7). When `discoverable` is
   * absent or false, the schemas are NEVER serialized regardless of
   * whether the manifest declared them (AC-3 / CD-1 opt-out default).
   */
  buildAgentCard(
    agent: Agent,
    registryConfig: RegistryConfig,
    baseUrl: string,
    identity?: AgentCardIdentity, // WKH-100 AC-8 — resuelto por el route ANTES de llamar
    computedReputation?: AgentReputation, // WKH-103 AC-5 — resuelto por el route ANTES de llamar
  ): AgentCard {
    const skills: AgentSkill[] = agent.capabilities.map((cap) => ({
      id: cap,
      name: cap,
      description: cap,
    }));

    // WKH-106: discoverable opt-in gate (CD-1). Even if the manifest
    // declares schemas, they're ONLY surfaced when discoverable is true.
    const discoverable = isDiscoverable(agent);

    // CD-7 / AC-4: when discoverable=true, validate the RAW metadata
    // fields (not just the well-typed ones) so primitive / invalid
    // declarations also fail with BazaarSchemaError → route returns 422.
    // When discoverable=false, skip validation entirely (opt-out gate).
    let inputSchema: Record<string, unknown> | undefined;
    let outputSchema: Record<string, unknown> | undefined;
    if (discoverable) {
      const rawInput = agent.metadata?.inputSchema;
      const rawOutput = agent.metadata?.outputSchema;
      validateAgentSchemas({
        inputSchema: rawInput,
        outputSchema: rawOutput,
      });
      // Validation passed → raw values are guaranteed to be plain objects.
      // Use the typed reader to extract them with the correct type.
      inputSchema = readSchemaField(agent, 'inputSchema');
      outputSchema = readSchemaField(agent, 'outputSchema');
    }

    return {
      name: agent.name,
      description: agent.description,
      url: `${baseUrl}/agents/${agent.slug}`,
      capabilities: {
        streaming: false,
        pushNotifications: false,
        // WKH-56: surface a2aCompliant only when agent.metadata explicitly
        // declares `true`. Truthy values like 'yes' / 1 are NOT promoted.
        // The field is OMITTED (not set to false) when absent to preserve
        // backward-compat with consumers that validate exact shape.
        ...(agent.metadata?.a2aCompliant === true && { a2aCompliant: true }),
      },
      skills,
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
      authentication: {
        schemes: this.resolveAuthSchemes(registryConfig),
      },
      invocationNote:
        'Do not call the agent URL directly. Invoke this agent through POST /compose or POST /orchestrate on the WasiAI A2A gateway.',
      // WKH-106: append schemas only when discoverable=true AND the
      // manifest declared them. Absent fields stay OMITTED (no null /
      // empty-object placeholders) to preserve DT-6 non-breaking semantics.
      ...(inputSchema !== undefined && { inputSchema }),
      ...(outputSchema !== undefined && { outputSchema }),
      // WKH-100 (AC-8/DT-6): surface verified ERC-8004 identity only when
      // resolved. Absent → field OMITTED (no null) to preserve non-breaking
      // semantics for consumers validating exact shape (AC-9/CD-9).
      ...(identity !== undefined && { identity }),
      // WKH-103 (AC-5/CD-9): surface computed reputation only when present
      // (>0 settled tasks). Absent → field OMITTED (no null) — backward-compat.
      ...(computedReputation !== undefined && { computedReputation }),
      // WKH-141 (AC-1/CD-4): declare APP-compatible payment intents ONLY when the
      // global flag is ON AND the agent opted in (double gate). Otherwise the key
      // is OMITTED entirely (CD-4 byte-idéntico). alignment/disclaimer horneados
      // (CD-3); supported deriva de getSupportedAppIntents() (sin `escrow`, CD-8).
      ...(isAppBridgeEnabled() &&
        appPaymentIntentsOptIn(agent) && {
          paymentIntents: {
            vocabulary: 'app' as const,
            supported: getSupportedAppIntents().map((d) => d.intent),
            alignment: 'conceptual' as const,
            disclaimer: APP_ALIGNMENT_DISCLAIMER,
          },
        }),
    };
  },

  /**
   * WKH-360 (AC-2) — el contexto que la carta propia necesita para declarar CÓMO se
   * la contrata. UN solo call-site: `buildSelfAgentCard`, más abajo en este mismo
   * objeto.
   *
   * ⚠️ POR QUÉ UNA FUNCIÓN Y NO TRES LECTURAS INLINE. AC-2 exige que la carta se
   * construya desde UNA sola función y que `/capabilities` siga derivando de ella
   * (hoy `/capabilities` hace `card.skills`, `card.name`, `card.url`). Si estos tres
   * datos se leyeran en el route, habría una SEGUNDA expresión de la oferta y las
   * dos superficies podrían divergir sin que `tsc` diga nada.
   *
   * Las tres fuentes, una por dato, ninguna inventada:
   *  · **esquemas de pago** — `bearer` SIEMPRE (el carril de agent key prepaga no
   *    está gateado por nada) y `x402` SÓLO si hay alguna chain inicializada que
   *    acepte cobro de ENTRADA. Sale de `getInboundPaymentChainKeys()`, que es la
   *    lista viva del proceso y no una constante: si mañana no hay ninguna chain
   *    EVM, `x402` desaparece de la carta sin que nadie edite nada.
   *  · **tasa** — `getProtocolFeeRate()`, la MISMA expresión que ya usa
   *    `/orchestrate/plan`. No hay precio fijo por skill (ver abajo).
   *  · **profundidad de contratación** — `resolveContractingDepthMax()`, el MISMO
   *    lector que usa el guard. Publicar un número distinto del que se aplica sería
   *    peor que no publicarlo.
   */
  resolveSelfCardContext(): {
    schemes: string[];
    feeRatePercent: number;
    depthMax: number;
  } {
    const inboundChains = getInboundPaymentChainKeys();
    return {
      // `bearer` primero: es el carril que SIEMPRE está disponible.
      schemes: ['bearer', ...(inboundChains.length > 0 ? ['x402'] : [])],
      // 6 decimales, igual que el resto de los montos/tasas de este repo.
      feeRatePercent: Number((getProtocolFeeRate() * 100).toFixed(6)),
      depthMax: resolveContractingDepthMax(),
    };
  },

  /**
   * Build the gateway's own Agent Card (self-card).
   *
   * ── WKH-360 (AC-1): la carta ahora dice CÓMO CONTRATARLA ───────────────────
   * Antes declaraba 9 claves, `authentication.schemes: []` y ningún endpoint ni
   * precio por skill: publicaba QUÉ sabe hacer el gateway y nada sobre cómo
   * contratarlo, o sea que la tesis "el coordinador es a su vez un agente A2A" no
   * era accionable desde la carta.
   *
   * ⚠️ NO HAY `priceUsdc` POR SKILL, Y SU AUSENCIA ES DELIBERADA (AC-3). Declarar
   * un precio fijo sería FABRICAR UNA OFERTA: los precios de los agentes son
   * pass-through y lo que este gateway cobra es una TASA sobre el costo realmente
   * ejecutado, que no se conoce antes de ejecutar. Así que la carta declara el
   * MODELO (`protocol-fee-on-executed-cost` + la tasa) y apunta al COTIZADOR
   * (`POST /orchestrate/plan`, que devuelve `costPerStep`, `totalCostUsdc`,
   * `protocolFeeUsdc` y `maxQuotedCostUsdc`, y NO cobra). Eso es exactamente lo que
   * AC-1 admite con su "o la forma de obtenerlo".
   *
   * ⚠️ Los `path` de los endpoints son una SEGUNDA EXPRESIÓN del registro de rutas
   * de `src/index.ts`, y `tsc` NO los ata. El control es mecánico y vive en
   * `src/routes/well-known.test.ts` (`T-CARD-3`): arranca la app con
   * `fastify.inject()` y verifica que cada `endpoint` declarado responda distinto de
   * 404. Si alguien renombra un prefijo, ese test se pone rojo.
   *
   * CD-5: ningún campo se emite en `0` ni en `null` para decir "no sé". `x402`
   * simplemente NO se lista cuando no hay chain de entrada — no sale
   * `x402: false`.
   */
  buildSelfAgentCard(baseUrl: string): AgentCard {
    const ctx = agentCardService.resolveSelfCardContext();
    /** El cotizador al que apunta el modelo de precio de las skills pagas. */
    const quoteEndpoint = '/orchestrate/plan';
    const paidPricing = {
      model: 'protocol-fee-on-executed-cost' as const,
      feeRatePercent: ctx.feeRatePercent,
      quoteEndpoint,
    };
    return {
      // ⛔ EL NOMBRE ES `Coordinator`, NO `Gateway`, Y LA DIFERENCIA NO ES DE GUSTO. `gateway` describe
      // el ROL TÉCNICO (una puerta HTTP) y aparece 29 veces en el README con ese sentido, que es
      // correcto. `Coordinator` es el NOMBRE de la pieza, y es como la nombran el pitch (lámina 4),
      // el registro de agentes de Solana y esta carta. Tener dos nombres para lo mismo hacía que la
      // lámina se leyera como si hubiera dos piezas: lo notó el founder leyendo este mismo campo.
      // ⚠️ SI ESTE LITERAL CAMBIA, hay que republicar los metadatos del registro on-chain: el activo
      // `8EQfLhMG9aKTgxS5YarUmg9SsUWqCFa4ZQ8NMR2HzFde` (devnet) apunta a un IPFS que copia este nombre.
      name: 'WasiAI A2A Coordinator',
      description:
        'A2A coordinator that discovers, composes, and orchestrates AI agents from multiple registries',
      url: baseUrl,
      capabilities: {
        streaming: false,
        pushNotifications: false,
      },
      skills: [
        {
          id: 'discover',
          name: 'Discover Agents',
          description:
            'Search and discover AI agents across multiple registries',
          endpoint: { method: 'POST', path: '/discover' },
          // `free` no es un acto de fe: `/discover` no tiene preHandler de pago
          // (medido) y `T-CARD-2` lo fija con un `inject` sin credencial que espera
          // distinto de 402.
          pricing: { model: 'free' },
        },
        {
          id: 'compose',
          name: 'Compose Agents',
          description: 'Execute multi-agent pipelines with sequential steps',
          endpoint: { method: 'POST', path: '/compose' },
          pricing: paidPricing,
        },
        {
          id: 'orchestrate',
          name: 'Orchestrate Agents',
          description:
            'Goal-based orchestration that automatically selects and chains agents',
          endpoint: { method: 'POST', path: '/orchestrate' },
          pricing: paidPricing,
        },
      ],
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
      authentication: {
        // DERIVADO del registry vivo, no una constante. Antes era `[]`, o sea una
        // carta que no decía con qué se paga.
        schemes: ctx.schemes,
      },
      // WKH-360 (AC-1): el contrato de la traza de contratación, para que otro
      // coordinador pueda hablarlo sin leer nuestro código.
      //
      // `bestEffortNote` NO es adorno y NO se puede omitir: publica que la
      // detección de bucles TRANSITIVOS depende de que cada intermediario reenvíe
      // los headers. Sin ese texto, la carta induciría a creer que declarar los
      // headers alcanza para estar cubierto. Sale de la MISMA constante que va al
      // body del error (CD-6/CD-19), así que la promesa publicada y la emitida no
      // pueden divergir.
      contracting: {
        depthMax: ctx.depthMax,
        chainHeader: CONTRACTING_CHAIN_HEADER,
        depthHeader: CONTRACTING_DEPTH_HEADER,
        bestEffortNote: CONTRACTING_LAYER2_BEST_EFFORT_NOTE,
      },
      invocationNote:
        'Agent invocations must go through POST /compose or POST /orchestrate on this gateway, not directly to external agent hosts.',
      // WKH-141 (AC-1/AC-4/CD-4): the self-card declares APP-compatible payment
      // intents gated ONLY by the global flag (no per-agent metadata here). Flag
      // OFF → key OMITTED (byte-idéntico). alignment/disclaimer horneados (CD-3).
      ...(isAppBridgeEnabled() && {
        paymentIntents: {
          vocabulary: 'app' as const,
          supported: getSupportedAppIntents().map((d) => d.intent),
          alignment: 'conceptual' as const,
          disclaimer: APP_ALIGNMENT_DISCLAIMER,
        },
      }),
    };
  },
};
