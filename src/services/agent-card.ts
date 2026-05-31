import type { FastifyRequest } from 'fastify';
import { validateAgentSchemas } from '../lib/bazaar.js';
import type {
  Agent,
  AgentCard,
  AgentCardIdentity,
  AgentSkill,
  RegistryConfig,
} from '../types/index.js';

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
    };
  },

  /**
   * Build the gateway's own Agent Card (self-card).
   */
  buildSelfAgentCard(baseUrl: string): AgentCard {
    return {
      name: 'WasiAI A2A Gateway',
      description:
        'A2A-compliant gateway that discovers, composes, and orchestrates AI agents from multiple registries',
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
        },
        {
          id: 'compose',
          name: 'Compose Agents',
          description: 'Execute multi-agent pipelines with sequential steps',
        },
        {
          id: 'orchestrate',
          name: 'Orchestrate Agents',
          description:
            'Goal-based orchestration that automatically selects and chains agents',
        },
      ],
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
      authentication: {
        schemes: [],
      },
      invocationNote:
        'Agent invocations must go through POST /compose or POST /orchestrate on this gateway, not directly to external agent hosts.',
    };
  },
};
