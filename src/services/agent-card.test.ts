import type { FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONTRACTING_LAYER2_BEST_EFFORT_NOTE } from '../lib/contracting-chain.js';
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

    // ── WKH-103 (AC-5) — computed reputation surfacing ──

    const computedRep = {
      score: 72,
      tasks_settled: 36,
      success_rate: 0.95,
      total_volume_usdc: 12.5,
      avg_latency_ms: 240,
      source: 'off-chain' as const,
    };

    it('T-AC5: includes computedReputation when the 5th arg is provided', () => {
      const card = agentCardService.buildAgentCard(
        agent,
        registryConfig,
        baseUrl,
        undefined,
        computedRep,
      );
      expect(card.computedReputation).toEqual(computedRep);
    });

    it('T-AC3: omits computedReputation (no key) when the 5th arg is absent', () => {
      const card = agentCardService.buildAgentCard(
        agent,
        registryConfig,
        baseUrl,
      );
      expect(card.computedReputation).toBeUndefined();
      expect('computedReputation' in card).toBe(false);
    });

    it('T-BACKWARD: legacy agent (no identity, no reputation) keeps prior shape', () => {
      const card = agentCardService.buildAgentCard(
        agent,
        registryConfig,
        baseUrl,
      );
      expect('identity' in card).toBe(false);
      expect('computedReputation' in card).toBe(false);
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

    // ── WKH-141 — APP bridge payment intents (flag + per-agent opt-in) ──

    describe('WKH-141 — APP payment intents declaration', () => {
      const ORIGINAL_FLAG = process.env.APP_BRIDGE_ENABLED;

      beforeEach(() => {
        delete process.env.APP_BRIDGE_ENABLED;
      });

      afterEach(() => {
        if (ORIGINAL_FLAG === undefined) {
          delete process.env.APP_BRIDGE_ENABLED;
        } else {
          process.env.APP_BRIDGE_ENABLED = ORIGINAL_FLAG;
        }
      });

      it('AC-4/CD-4: flag OFF → no paymentIntents key (byte-idéntico)', () => {
        const a: Agent = { ...agent, metadata: { appPaymentIntents: true } };
        const card = agentCardService.buildAgentCard(
          a,
          registryConfig,
          baseUrl,
        );
        expect('paymentIntents' in card).toBe(false);
      });

      it('AC-1: flag ON + opt-in true → paymentIntents present with app vocabulary', () => {
        process.env.APP_BRIDGE_ENABLED = 'true';
        const a: Agent = { ...agent, metadata: { appPaymentIntents: true } };
        const card = agentCardService.buildAgentCard(
          a,
          registryConfig,
          baseUrl,
        );
        expect(card.paymentIntents).toBeDefined();
        expect(card.paymentIntents?.vocabulary).toBe('app');
        expect(card.paymentIntents?.supported).toEqual([
          'charge',
          'session',
          'upto',
        ]);
        expect(card.paymentIntents?.alignment).toBe('conceptual');
        expect(card.paymentIntents?.disclaimer.length).toBeGreaterThan(0);
        // CD-8: escrow never declared.
        expect(card.paymentIntents?.supported).not.toContain('escrow');
      });

      it('AC-4/Missing#5: flag ON but opt-in absent → field ABSENT', () => {
        process.env.APP_BRIDGE_ENABLED = 'true';
        const card = agentCardService.buildAgentCard(
          agent,
          registryConfig,
          baseUrl,
        );
        expect('paymentIntents' in card).toBe(false);
      });

      it('AC-4/Missing#5: flag ON + opt-in truthy-no-literal → field ABSENT', () => {
        process.env.APP_BRIDGE_ENABLED = 'true';
        for (const truthy of ['true', 1, 'yes', false]) {
          const a: Agent = {
            ...agent,
            metadata: { appPaymentIntents: truthy },
          };
          const card = agentCardService.buildAgentCard(
            a,
            registryConfig,
            baseUrl,
          );
          expect('paymentIntents' in card).toBe(false);
        }
      });

      it('AC-4/CD-4: flag truthy-no-literal (string, 1) does NOT enable', () => {
        const a: Agent = { ...agent, metadata: { appPaymentIntents: true } };
        for (const truthy of ['1', 'TRUE', 'yes']) {
          process.env.APP_BRIDGE_ENABLED = truthy;
          const card = agentCardService.buildAgentCard(
            a,
            registryConfig,
            baseUrl,
          );
          expect('paymentIntents' in card).toBe(false);
        }
      });

      it('AC-5/CD-2: with feature active, existing fields stay intact', () => {
        const baseline = agentCardService.buildAgentCard(
          agent,
          registryConfig,
          baseUrl,
        );
        process.env.APP_BRIDGE_ENABLED = 'true';
        const a: Agent = { ...agent, metadata: { appPaymentIntents: true } };
        const card = agentCardService.buildAgentCard(
          a,
          registryConfig,
          baseUrl,
        );
        expect(card.name).toBe(baseline.name);
        expect(card.url).toBe(baseline.url);
        expect(card.capabilities).toEqual(baseline.capabilities);
        expect(card.skills).toEqual(baseline.skills);
        expect(card.authentication).toEqual(baseline.authentication);
        expect(card.inputModes).toEqual(baseline.inputModes);
        expect(card.outputModes).toEqual(baseline.outputModes);
        expect(card.invocationNote).toBe(baseline.invocationNote);
      });
    });
  });

  // ---------- buildSelfAgentCard ----------

  describe('buildSelfAgentCard', () => {
    it('returns gateway card with correct name', () => {
      const card = agentCardService.buildSelfAgentCard('https://gw.wasiai.io');
      expect(card.name).toBe('WasiAI A2A Coordinator');
    });

    it('includes discover, compose, orchestrate skills', () => {
      const card = agentCardService.buildSelfAgentCard('https://gw.wasiai.io');
      expect(card.skills.map((s) => s.id)).toEqual([
        'discover',
        'compose',
        'orchestrate',
      ]);
    });

    // ⚠️ WKH-360 (AC-1b) — ESTE `it` decía `toEqual([])` y su INVERSIÓN es el punto
    // de la HU, no un daño colateral. La carta con `schemes: []` publicaba un agente
    // A2A que no dice con qué se le paga, y el AC exige que lo declare.
    //
    // El testigo NO se borró: se re-apuntó a la propiedad que sí tiene que valer, que
    // es que `bearer` esté SIEMPRE (el carril de agent key prepaga no está gateado por
    // nada) y que el conjunto se DERIVE del registry vivo en vez de ser una constante.
    it('WKH-360 (AC-1b): declara `bearer` siempre — ya NO son schemes vacíos', () => {
      const card = agentCardService.buildSelfAgentCard('https://gw.wasiai.io');
      expect(card.authentication.schemes).toContain('bearer');
      expect(card.authentication.schemes).not.toEqual([]);
    });

    it('WKH-360 (AC-3, CD-5): sin chain de cobro de ENTRADA, `x402` NO se lista', () => {
      // El caso es alcanzable HOY: `solana-devnet` sale con
      // `acceptsInboundPayment: false`, así que un deploy solo-Solana no tiene
      // ninguna chain de entrada. Lo que NO se hace es emitir `x402: false` ni
      // `x402: null` — el esquema simplemente no aparece (CD-5: ningún placeholder).
      const card = agentCardService.buildSelfAgentCard('https://gw.wasiai.io');
      // En esta suite no hay adapters inicializados ⇒ no hay chain de entrada.
      expect(card.authentication.schemes).not.toContain('x402');
      expect(JSON.stringify(card)).not.toContain('"x402":false');
      expect(JSON.stringify(card)).not.toContain('"x402":null');
    });

    it('WKH-360 (AC-1a/AC-1c): cada skill trae `endpoint` y `pricing`', () => {
      const card = agentCardService.buildSelfAgentCard('https://gw.wasiai.io');
      for (const skill of card.skills) {
        expect(skill.endpoint, `skill ${skill.id}`).toBeDefined();
        expect(skill.endpoint?.method, `skill ${skill.id}`).toBe('POST');
        expect(skill.pricing, `skill ${skill.id}`).toBeDefined();
      }
      // `/discover` es gratis; las dos que mueven plata declaran el MODELO y
      // apuntan al cotizador. NO hay `priceUsdc`: sería fabricar una oferta (AC-3).
      const discover = card.skills.find((s) => s.id === 'discover');
      expect(discover?.pricing).toEqual({ model: 'free' });
      const compose = card.skills.find((s) => s.id === 'compose');
      expect(compose?.pricing).toMatchObject({
        model: 'protocol-fee-on-executed-cost',
        quoteEndpoint: '/orchestrate/plan',
      });
      expect(JSON.stringify(card)).not.toContain('priceUsdc');
    });

    it('WKH-360 (AC-1): `contracting` publica el techo y los DOS headers', () => {
      const card = agentCardService.buildSelfAgentCard('https://gw.wasiai.io');
      expect(card.contracting?.depthMax).toBe(2);
      expect(card.contracting?.chainHeader).toBe('x-a2a-contracting-chain');
      expect(card.contracting?.depthHeader).toBe('x-a2a-contracting-depth');
      // CD-6: la nota best-effort sale de la MISMA constante que el body del error.
      expect(card.contracting?.bestEffortNote).toBe(
        CONTRACTING_LAYER2_BEST_EFFORT_NOTE,
      );
    });

    it('T-CARD-6 (AC-3, CD-5): NINGÚN campo nuevo de la carta vale 0 ni null', () => {
      // Barrido recursivo. Un `0` fabricado es una afirmación falsa con formato de
      // dato, y es el modo de falla que CD-5 prohíbe para toda esta HU.
      const card = agentCardService.buildSelfAgentCard('https://gw.wasiai.io');
      const offenders: string[] = [];
      const walk = (node: unknown, path: string): void => {
        if (node === null) {
          offenders.push(`${path} = null`);
          return;
        }
        if (typeof node === 'number' && node === 0) {
          offenders.push(`${path} = 0`);
          return;
        }
        if (Array.isArray(node)) {
          for (const [i, v] of node.entries()) walk(v, `${path}[${i}]`);
          return;
        }
        if (typeof node === 'object') {
          for (const [k, v] of Object.entries(
            node as Record<string, unknown>,
          )) {
            walk(v, `${path}.${k}`);
          }
        }
      };
      walk(card.contracting, 'contracting');
      for (const s of card.skills) walk(s.pricing, `skills.${s.id}.pricing`);
      walk(card.authentication, 'authentication');
      expect(offenders).toEqual([]);
    });

    it('uses baseUrl as url', () => {
      const card = agentCardService.buildSelfAgentCard('https://gw.wasiai.io');
      expect(card.url).toBe('https://gw.wasiai.io');
    });

    // ── WKH-141 — self-card gated ONLY by the global flag ──

    describe('WKH-141 — APP payment intents on self-card', () => {
      const ORIGINAL_FLAG = process.env.APP_BRIDGE_ENABLED;

      afterEach(() => {
        if (ORIGINAL_FLAG === undefined) {
          delete process.env.APP_BRIDGE_ENABLED;
        } else {
          process.env.APP_BRIDGE_ENABLED = ORIGINAL_FLAG;
        }
      });

      it('AC-4: flag OFF → self-card has no paymentIntents', () => {
        delete process.env.APP_BRIDGE_ENABLED;
        const card = agentCardService.buildSelfAgentCard(
          'https://gw.wasiai.io',
        );
        expect('paymentIntents' in card).toBe(false);
      });

      it('AC-1: flag ON → self-card declares paymentIntents (no metadata needed)', () => {
        process.env.APP_BRIDGE_ENABLED = 'true';
        const card = agentCardService.buildSelfAgentCard(
          'https://gw.wasiai.io',
        );
        expect(card.paymentIntents).toBeDefined();
        expect(card.paymentIntents?.vocabulary).toBe('app');
        expect(card.paymentIntents?.supported).toEqual([
          'charge',
          'session',
          'upto',
        ]);
        expect(card.paymentIntents?.alignment).toBe('conceptual');
        expect(card.paymentIntents?.disclaimer.length).toBeGreaterThan(0);
      });
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
