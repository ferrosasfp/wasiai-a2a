import type { FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Agent, RegistryConfig } from '../types/index.js';
import { agentCardService, resolveBaseUrl } from './agent-card.js';

// ---------- resolveAuthSchemes ----------

describe('agentCardService', () => {
  describe('resolveAuthSchemes', () => {
    it('returns ["bearer"] for auth.type bearer', () => {
      const config = {
        auth: { type: 'bearer', key: 'Authorization', value: 'x' },
      } as RegistryConfig;
      expect(agentCardService.resolveAuthSchemes(config)).toEqual(['bearer']);
    });

    it('returns ["apiKey"] for auth.type header', () => {
      const config = {
        auth: { type: 'header', key: 'X-Key', value: 'x' },
      } as RegistryConfig;
      expect(agentCardService.resolveAuthSchemes(config)).toEqual(['apiKey']);
    });

    it('returns [] for auth.type query', () => {
      const config = {
        auth: { type: 'query', key: 'key', value: 'x' },
      } as RegistryConfig;
      expect(agentCardService.resolveAuthSchemes(config)).toEqual([]);
    });

    it('returns [] when auth is undefined', () => {
      const config = {} as RegistryConfig;
      expect(agentCardService.resolveAuthSchemes(config)).toEqual([]);
    });
  });

  // ---------- buildAgentCard ----------

  describe('buildAgentCard', () => {
    const agent: Agent = {
      slug: 'test-agent',
      name: 'Test Agent',
      description: 'A test agent',
      capabilities: ['summarize', 'translate'],
      registry: 'my-registry',
      registry_id: 'my-registry',
      id: 'test-1',
      priceUsdc: 0.01,
      invokeUrl: 'https://example.com/invoke',
      invocationNote: 'Use POST /compose or POST /orchestrate on the gateway.',
      verified: false,
      status: 'active',
    };

    const registryConfig = {
      auth: { type: 'bearer', key: 'Authorization', value: 'tok' },
    } as RegistryConfig;

    const baseUrl = 'https://api.wasiai.io';

    it('maps agent fields to AgentCard fields', () => {
      const card = agentCardService.buildAgentCard(
        agent,
        registryConfig,
        baseUrl,
      );
      expect(card.name).toBe('Test Agent');
      expect(card.description).toBe('A test agent');
    });

    it('maps capabilities to skills with id/name/description', () => {
      const card = agentCardService.buildAgentCard(
        agent,
        registryConfig,
        baseUrl,
      );
      expect(card.skills).toEqual([
        { id: 'summarize', name: 'summarize', description: 'summarize' },
        { id: 'translate', name: 'translate', description: 'translate' },
      ]);
    });

    it('sets streaming and pushNotifications to false', () => {
      const card = agentCardService.buildAgentCard(
        agent,
        registryConfig,
        baseUrl,
      );
      expect(card.capabilities).toEqual({
        streaming: false,
        pushNotifications: false,
      });
    });

    it('sets inputModes and outputModes to ["text/plain"]', () => {
      const card = agentCardService.buildAgentCard(
        agent,
        registryConfig,
        baseUrl,
      );
      expect(card.inputModes).toEqual(['text/plain']);
      expect(card.outputModes).toEqual(['text/plain']);
    });

    it('constructs url from baseUrl + /agents/ + slug', () => {
      const card = agentCardService.buildAgentCard(
        agent,
        registryConfig,
        baseUrl,
      );
      expect(card.url).toBe('https://api.wasiai.io/agents/test-agent');
    });

    it('delegates auth to resolveAuthSchemes', () => {
      const card = agentCardService.buildAgentCard(
        agent,
        registryConfig,
        baseUrl,
      );
      expect(card.authentication.schemes).toEqual(['bearer']);
    });

    // WKH-56: a2aCompliant flag in capabilities (DT-2)
    it('surfaces a2aCompliant=true when agent.metadata.a2aCompliant === true', () => {
      const a2aAgent: Agent = { ...agent, metadata: { a2aCompliant: true } };
      const card = agentCardService.buildAgentCard(
        a2aAgent,
        registryConfig,
        baseUrl,
      );
      expect(card.capabilities.a2aCompliant).toBe(true);
    });

    it('omits a2aCompliant when agent.metadata.a2aCompliant is absent', () => {
      const card = agentCardService.buildAgentCard(
        agent,
        registryConfig,
        baseUrl,
      );
      expect(card.capabilities.a2aCompliant).toBeUndefined();
    });

    // ── WKH-100 (AC-8) — ERC-8004 identity surfacing ──

    it('AC-8: includes identity when the 4th arg is provided', () => {
      const card = agentCardService.buildAgentCard(
        agent,
        registryConfig,
        baseUrl,
        {
          erc8004_token_id: '42',
          chain_id: 84532,
          verified: true,
        },
      );
      expect(card.identity).toEqual({
        erc8004_token_id: '42',
        chain_id: 84532,
        verified: true,
      });
    });

    it('AC-9: omits identity (no field) when the 4th arg is absent', () => {
      const card = agentCardService.buildAgentCard(
        agent,
        registryConfig,
        baseUrl,
      );
      expect(card.identity).toBeUndefined();
      expect('identity' in card).toBe(false);
    });

    // ── WKH-106 (BASE-03) — discoverable opt-in + schema serialization ──

    describe('WKH-106 — Bazaar discovery schemas', () => {
      const validInputSchema = {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      };
      const validOutputSchema = {
        type: 'object',
        properties: { result: { type: 'string' } },
      };

      it('AC-1: appends inputSchema/outputSchema when discoverable=true', () => {
        const a: Agent = {
          ...agent,
          metadata: {
            discoverable: true,
            inputSchema: validInputSchema,
            outputSchema: validOutputSchema,
          },
        };
        const card = agentCardService.buildAgentCard(
          a,
          registryConfig,
          baseUrl,
        );
        expect(card.inputSchema).toEqual(validInputSchema);
        expect(card.outputSchema).toEqual(validOutputSchema);
      });

      it('AC-3 / CD-1: omits schemas when discoverable=false', () => {
        const a: Agent = {
          ...agent,
          metadata: {
            discoverable: false,
            inputSchema: validInputSchema,
            outputSchema: validOutputSchema,
          },
        };
        const card = agentCardService.buildAgentCard(
          a,
          registryConfig,
          baseUrl,
        );
        expect(card.inputSchema).toBeUndefined();
        expect(card.outputSchema).toBeUndefined();
      });

      it('AC-3 / CD-1: omits schemas when discoverable is absent (default opt-out)', () => {
        const a: Agent = {
          ...agent,
          metadata: {
            inputSchema: validInputSchema,
            outputSchema: validOutputSchema,
          },
        };
        const card = agentCardService.buildAgentCard(
          a,
          registryConfig,
          baseUrl,
        );
        expect(card.inputSchema).toBeUndefined();
        expect(card.outputSchema).toBeUndefined();
      });

      it('CD-1: discoverable truthy values (string "true", 1) do NOT promote opt-in', () => {
        for (const truthy of ['true', 1, 'yes']) {
          const a: Agent = {
            ...agent,
            metadata: {
              discoverable: truthy,
              inputSchema: validInputSchema,
            },
          };
          const card = agentCardService.buildAgentCard(
            a,
            registryConfig,
            baseUrl,
          );
          expect(card.inputSchema).toBeUndefined();
        }
      });

      it('appends only inputSchema when outputSchema absent (discoverable=true)', () => {
        const a: Agent = {
          ...agent,
          metadata: {
            discoverable: true,
            inputSchema: validInputSchema,
          },
        };
        const card = agentCardService.buildAgentCard(
          a,
          registryConfig,
          baseUrl,
        );
        expect(card.inputSchema).toEqual(validInputSchema);
        expect(card.outputSchema).toBeUndefined();
      });

      it('AC-4 / CD-7: throws BazaarSchemaError on malformed inputSchema', () => {
        const a: Agent = {
          ...agent,
          metadata: {
            discoverable: true,
            inputSchema: { type: 'not-a-valid-type' },
          },
        };
        expect(() =>
          agentCardService.buildAgentCard(a, registryConfig, baseUrl),
        ).toThrow(/inputSchema/);
      });

      it('AC-4 / CD-7: throws BazaarSchemaError on malformed outputSchema', () => {
        const a: Agent = {
          ...agent,
          metadata: {
            discoverable: true,
            inputSchema: { type: 'object' },
            outputSchema: { properties: 'not-an-object' },
          },
        };
        expect(() =>
          agentCardService.buildAgentCard(a, registryConfig, baseUrl),
        ).toThrow(/outputSchema/);
      });

      it('AC-4 / CD-7: throws when schema is a primitive (string)', () => {
        const a: Agent = {
          ...agent,
          metadata: {
            discoverable: true,
            inputSchema: 'not-a-schema',
          },
        };
        expect(() =>
          agentCardService.buildAgentCard(a, registryConfig, baseUrl),
        ).toThrow(/inputSchema/);
      });

      it('AC-3: ignores malformed schemas when discoverable=false (no throw)', () => {
        // Defense-in-depth: even if dev mis-declares schemas, opt-out
        // means they NEVER trigger validation. The card builds cleanly.
        const a: Agent = {
          ...agent,
          metadata: {
            discoverable: false,
            inputSchema: 'malformed',
          },
        };
        expect(() =>
          agentCardService.buildAgentCard(a, registryConfig, baseUrl),
        ).not.toThrow();
      });
    });
  });

  // ---------- buildSelfAgentCard ----------

  describe('buildSelfAgentCard', () => {
    it('returns gateway card with correct name', () => {
      const card = agentCardService.buildSelfAgentCard('https://gw.wasiai.io');
      expect(card.name).toBe('WasiAI A2A Gateway');
    });

    it('includes discover, compose, orchestrate skills', () => {
      const card = agentCardService.buildSelfAgentCard('https://gw.wasiai.io');
      expect(card.skills.map((s) => s.id)).toEqual([
        'discover',
        'compose',
        'orchestrate',
      ]);
    });

    it('sets empty auth schemes', () => {
      const card = agentCardService.buildSelfAgentCard('https://gw.wasiai.io');
      expect(card.authentication.schemes).toEqual([]);
    });

    it('uses baseUrl as url', () => {
      const card = agentCardService.buildSelfAgentCard('https://gw.wasiai.io');
      expect(card.url).toBe('https://gw.wasiai.io');
    });
  });
});

// ---------- resolveBaseUrl ----------

describe('resolveBaseUrl', () => {
  const originalEnv = process.env.BASE_URL;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.BASE_URL;
    } else {
      process.env.BASE_URL = originalEnv;
    }
  });

  it('returns BASE_URL env when set (strips trailing slash)', () => {
    process.env.BASE_URL = 'https://api.wasiai.io/';
    const request = {
      headers: {},
      protocol: 'http',
      hostname: 'localhost',
    } as unknown as FastifyRequest;
    expect(resolveBaseUrl(request)).toBe('https://api.wasiai.io');
  });

  it('uses X-Forwarded-Proto header when present', () => {
    delete process.env.BASE_URL;
    const request = {
      headers: { 'x-forwarded-proto': 'https' },
      protocol: 'http',
      hostname: 'api.wasiai.io',
    } as unknown as FastifyRequest;
    expect(resolveBaseUrl(request)).toBe('https://api.wasiai.io');
  });

  it('falls back to request.protocol when no proxy headers', () => {
    delete process.env.BASE_URL;
    const request = {
      headers: {},
      protocol: 'http',
      hostname: 'localhost:3001',
    } as unknown as FastifyRequest;
    expect(resolveBaseUrl(request)).toBe('http://localhost:3001');
  });
});
