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
