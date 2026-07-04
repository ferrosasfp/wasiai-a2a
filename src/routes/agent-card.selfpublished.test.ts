/**
 * Agent Card Route — self-published fallback tests (WKH-134).
 *
 * Cubre AC-2 / DT-5: `GET /agents/:slug/agent-card` para un agente
 * self-published construye un `RegistryConfig` sintético (auth vacío →
 * `schemes: []`) en vez de buscar en `registries`, y devuelve un AgentCard
 * A2A válido (200) sin tocar `registryService.getEnabled()`.
 */

import Fastify from 'fastify';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { Agent } from '../types/index.js';
import { SELF_PUBLISHED_REGISTRY_ID } from '../types/index.js';

vi.mock('../services/discovery.js', async () => {
  const actual = await vi.importActual<
    typeof import('../services/discovery.js')
  >('../services/discovery.js');
  return {
    ...actual,
    discoveryService: { ...actual.discoveryService, getAgent: vi.fn() },
  };
});

vi.mock('../services/registry.js', () => ({
  registryService: { getEnabled: vi.fn().mockResolvedValue([]) },
}));

vi.mock('../services/reputation.js', () => ({
  reputationService: {
    computeReputationForAgent: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../services/identity.js', () => ({
  identityService: {
    resolveIdentityForAgent: vi.fn().mockResolvedValue(null),
  },
}));

import { discoveryService } from '../services/discovery.js';
import { registryService } from '../services/registry.js';
import agentCardRoutes from './agent-card.js';

const mockGetAgent = vi.mocked(discoveryService.getAgent);
const mockGetEnabled = vi.mocked(registryService.getEnabled);

const SELF_AGENT: Agent = {
  id: 'my-weather-agent',
  name: 'My Weather Agent',
  slug: 'my-weather-agent',
  description: 'Forecasts',
  capabilities: ['weather', 'geo'],
  priceUsdc: 0.02,
  registry: SELF_PUBLISHED_REGISTRY_ID,
  registry_id: SELF_PUBLISHED_REGISTRY_ID,
  invokeUrl: 'https://api.myweather.example/agent',
  invocationNote:
    'The invokeUrl is an internal reference. To invoke this agent, use POST /compose or POST /orchestrate on the WasiAI A2A gateway.',
  verified: false,
  status: 'active',
  metadata: {},
};

describe('agent-card route — self-published fallback (WKH-134)', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();
    await app.register(agentCardRoutes, { prefix: '/agents' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEnabled.mockResolvedValue([]);
  });

  // ── T-PUB-04 ─────────────────────────────────────────────────────
  it('T-PUB-04: GET /agents/:slug/agent-card for self-published → 200 valid card, synthetic RegistryConfig (schemes: [])', async () => {
    mockGetAgent.mockResolvedValueOnce(SELF_AGENT);

    const res = await app.inject({
      method: 'GET',
      url: '/agents/my-weather-agent/agent-card',
    });

    expect(res.statusCode).toBe(200);
    const card = res.json();
    expect(card.name).toBe('My Weather Agent');
    expect(card.url).toContain('my-weather-agent');
    expect(card.skills).toHaveLength(2);
    // RegistryConfig sintético con auth vacío → schemes vacío.
    expect(card.authentication.schemes).toEqual([]);
    // DT-5: NO se buscó en `registries` (path sintético).
    expect(mockGetEnabled).not.toHaveBeenCalled();
  });
});
