import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import agentCardRoutes from './agent-card.js';
import wellKnownRoutes from './well-known.js';

vi.mock('../services/discovery.js', () => ({
  discoveryService: {
    getAgent: vi.fn(),
  },
}));

vi.mock('../services/registry.js', () => ({
  registryService: {
    getEnabled: vi.fn(),
  },
}));

import { discoveryService } from '../services/discovery.js';
import { registryService } from '../services/registry.js';

const mockGetAgent = vi.mocked(discoveryService.getAgent);
const mockGetEnabled = vi.mocked(registryService.getEnabled);

describe('agent-card routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();
    await app.register(agentCardRoutes, { prefix: '/agents' });
    await app.register(wellKnownRoutes, { prefix: '/.well-known' });
    await app.ready();
  });

  afterAll(() => app.close());

  describe('GET /agents/:slug/agent-card', () => {
    it('returns 200 with valid AgentCard for existing agent', async () => {
      mockGetAgent.mockResolvedValue({
        slug: 'my-agent',
        name: 'My Agent',
        description: 'Does things',
        capabilities: ['chat'],
        registry: 'test-registry',
        id: 'a1',
        priceUsdc: 0,
        invokeUrl: 'https://example.com',
        invocationNote:
          'Use POST /compose or POST /orchestrate on the gateway.',
        verified: false,
        status: 'active',
      });

      mockGetEnabled.mockResolvedValue([
        {
          name: 'test-registry',
          id: 'r1',
          auth: { type: 'bearer', key: 'Authorization', value: 'x' },
          discoveryEndpoint: '',
          invokeEndpoint: '',
          schema: { discovery: {}, invoke: { method: 'POST' } },
          enabled: true,
          createdAt: new Date(),
          ownerRef: 'system',
        },
      ]);

      const res = await app.inject({
        method: 'GET',
        url: '/agents/my-agent/agent-card',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.name).toBe('My Agent');
      expect(body.url).toContain('/agents/my-agent');
      expect(body.skills).toHaveLength(1);
      expect(body.authentication.schemes).toEqual(['bearer']);
    });

    it('returns 404 when agent not found', async () => {
      mockGetAgent.mockResolvedValue(null);

      const res = await app.inject({
        method: 'GET',
        url: '/agents/nonexistent/agent-card',
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Agent not found' });
    });

    it('passes ?registry query param to discoveryService', async () => {
      mockGetAgent.mockResolvedValue(null);

      await app.inject({
        method: 'GET',
        url: '/agents/x/agent-card?registry=my-reg',
      });

      expect(mockGetAgent).toHaveBeenCalledWith('x', 'my-reg');
    });

    // ── WKH-106 (BASE-03) — Bazaar discovery + opt-in + 422 mapping ──

    describe('WKH-106 — Bazaar discovery', () => {
      const validInputSchema = {
        type: 'object',
        properties: { query: { type: 'string' } },
      };
      const validOutputSchema = {
        type: 'object',
        properties: { result: { type: 'string' } },
      };

      const registryWithBearer = {
        name: 'test-registry',
        id: 'r1',
        auth: { type: 'bearer' as const, key: 'Authorization', value: 'x' },
        discoveryEndpoint: '',
        invokeEndpoint: '',
        schema: { discovery: {}, invoke: { method: 'POST' as const } },
        enabled: true,
        createdAt: new Date(),
        ownerRef: 'system',
      };

      it('AC-1: surfaces inputSchema/outputSchema when discoverable=true', async () => {
        mockGetAgent.mockResolvedValue({
          slug: 'disc-agent',
          name: 'Discoverable Agent',
          description: 'Bazaar-indexed agent',
          capabilities: ['chat'],
          registry: 'test-registry',
          id: 'd1',
          priceUsdc: 0,
          invokeUrl: 'https://example.com',
          invocationNote: 'Use POST /compose',
          verified: false,
          status: 'active',
          metadata: {
            discoverable: true,
            inputSchema: validInputSchema,
            outputSchema: validOutputSchema,
          },
        });
        mockGetEnabled.mockResolvedValue([registryWithBearer]);

        const res = await app.inject({
          method: 'GET',
          url: '/agents/disc-agent/agent-card',
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.inputSchema).toEqual(validInputSchema);
        expect(body.outputSchema).toEqual(validOutputSchema);
      });

      it('AC-3: omits schemas when discoverable=false', async () => {
        mockGetAgent.mockResolvedValue({
          slug: 'optout-agent',
          name: 'Opt-out Agent',
          description: '',
          capabilities: [],
          registry: 'test-registry',
          id: 'o1',
          priceUsdc: 0,
          invokeUrl: 'https://example.com',
          invocationNote: '',
          verified: false,
          status: 'active',
          metadata: {
            discoverable: false,
            inputSchema: validInputSchema,
            outputSchema: validOutputSchema,
          },
        });
        mockGetEnabled.mockResolvedValue([registryWithBearer]);

        const res = await app.inject({
          method: 'GET',
          url: '/agents/optout-agent/agent-card',
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.inputSchema).toBeUndefined();
        expect(body.outputSchema).toBeUndefined();
      });

      it('AC-3: omits schemas when discoverable is absent (default opt-out)', async () => {
        mockGetAgent.mockResolvedValue({
          slug: 'default-agent',
          name: 'Default Agent',
          description: '',
          capabilities: [],
          registry: 'test-registry',
          id: 'd1',
          priceUsdc: 0,
          invokeUrl: 'https://example.com',
          invocationNote: '',
          verified: false,
          status: 'active',
          metadata: { inputSchema: validInputSchema },
        });
        mockGetEnabled.mockResolvedValue([registryWithBearer]);

        const res = await app.inject({
          method: 'GET',
          url: '/agents/default-agent/agent-card',
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.inputSchema).toBeUndefined();
      });

      it('AC-4 / CD-7: returns 422 with error_code on malformed inputSchema', async () => {
        mockGetAgent.mockResolvedValue({
          slug: 'bad-schema-agent',
          name: 'Bad Schema',
          description: '',
          capabilities: [],
          registry: 'test-registry',
          id: 'b1',
          priceUsdc: 0,
          invokeUrl: 'https://example.com',
          invocationNote: '',
          verified: false,
          status: 'active',
          metadata: {
            discoverable: true,
            inputSchema: { type: 'definitely-not-valid' },
          },
        });
        mockGetEnabled.mockResolvedValue([registryWithBearer]);

        const res = await app.inject({
          method: 'GET',
          url: '/agents/bad-schema-agent/agent-card',
        });
        expect(res.statusCode).toBe(422);
        const body = res.json();
        expect(body.error_code).toBe('BAZAAR_SCHEMA_INVALID');
        expect(body.field).toBe('inputSchema');
        expect(body.error).toContain('inputSchema');
      });

      it('AC-4: 422 identifies outputSchema when only outputSchema is bad', async () => {
        mockGetAgent.mockResolvedValue({
          slug: 'bad-out-agent',
          name: 'Bad Out',
          description: '',
          capabilities: [],
          registry: 'test-registry',
          id: 'b2',
          priceUsdc: 0,
          invokeUrl: 'https://example.com',
          invocationNote: '',
          verified: false,
          status: 'active',
          metadata: {
            discoverable: true,
            inputSchema: { type: 'object' },
            outputSchema: 'not-an-object',
          },
        });
        mockGetEnabled.mockResolvedValue([registryWithBearer]);

        const res = await app.inject({
          method: 'GET',
          url: '/agents/bad-out-agent/agent-card',
        });
        expect(res.statusCode).toBe(422);
        const body = res.json();
        expect(body.error_code).toBe('BAZAAR_SCHEMA_INVALID');
        expect(body.field).toBe('outputSchema');
      });

      it('CD-1: malformed schema with discoverable=false → 200 (no validation)', async () => {
        // Opt-out short-circuits validation — bad schemas are ignored.
        mockGetAgent.mockResolvedValue({
          slug: 'optout-bad-agent',
          name: 'Opt-out Bad',
          description: '',
          capabilities: [],
          registry: 'test-registry',
          id: 'b3',
          priceUsdc: 0,
          invokeUrl: 'https://example.com',
          invocationNote: '',
          verified: false,
          status: 'active',
          metadata: {
            discoverable: false,
            inputSchema: { type: 'invalid' },
          },
        });
        mockGetEnabled.mockResolvedValue([registryWithBearer]);

        const res = await app.inject({
          method: 'GET',
          url: '/agents/optout-bad-agent/agent-card',
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.inputSchema).toBeUndefined();
      });
    });
  });

  describe('GET /.well-known/agent.json', () => {
    it('returns 200 with gateway self AgentCard', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/.well-known/agent.json',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.name).toBe('WasiAI A2A Gateway');
      expect(body.skills.map((s: { id: string }) => s.id)).toEqual([
        'discover',
        'compose',
        'orchestrate',
      ]);
      expect(body.authentication.schemes).toEqual([]);
    });
  });
});
