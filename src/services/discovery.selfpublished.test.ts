/**
 * Discovery Service — self-published merge tests (WKH-134).
 *
 * Cubre AC-2 / CD-6: los agentes self-published entran a `discover()` con el
 * MISMO shape `Agent` y pasan por el pipeline común (sort/limit); `getAgent()`
 * los resuelve local-first sin fetch outbound.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types/index.js';
import { SELF_PUBLISHED_REGISTRY_ID } from '../types/index.js';

vi.mock('./registry.js', () => ({
  registryService: {
    get: vi.fn(),
    getEnabled: vi.fn().mockResolvedValue([]),
    // HIGH-1: ver discovery.test.ts — el filtro por registry usa getWithSecrets.
    getWithSecrets: vi.fn(),
  },
}));

vi.mock('./agent.js', () => ({
  publishedAgentService: {
    listAsAgents: vi.fn(),
    getBySlugAsAgent: vi.fn(),
  },
}));

vi.mock('./reputation.js', () => ({
  reputationService: {
    computeReputationBatch: vi.fn().mockResolvedValue(new Map()),
    // WKH-313: el consumidor real de `attachReputations`. Sin standings y SIN
    // degradación: nadie tiene historial, la lectura funcionó.
    computeStandingBatch: vi
      .fn()
      .mockResolvedValue({ degraded: false, standings: new Map() }),
  },
}));

vi.mock('./identity.js', () => ({
  identityService: {
    resolveIdentityForAgent: vi.fn().mockResolvedValue(null),
  },
}));

import { publishedAgentService } from './agent.js';
import { discoveryService } from './discovery.js';
import { registryService } from './registry.js';

const mockListAsAgents = vi.mocked(publishedAgentService.listAsAgents);
const mockGetBySlug = vi.mocked(publishedAgentService.getBySlugAsAgent);
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

describe('discovery — self-published merge (WKH-134)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEnabled.mockResolvedValue([]);
  });

  // ── T-PUB-02 ─────────────────────────────────────────────────────
  it('T-PUB-02: discover() includes the self-published agent with full Agent shape (AC-2/CD-6)', async () => {
    mockListAsAgents.mockResolvedValueOnce([SELF_AGENT]);

    const result = await discoveryService.discover({ limit: 5 });

    expect(result.total).toBe(1);
    expect(result.agents).toHaveLength(1);
    const a = result.agents[0];
    // Mismo shape que un agente de marketplace (todos los campos Agent).
    expect(a).toMatchObject({
      id: 'my-weather-agent',
      name: 'My Weather Agent',
      slug: 'my-weather-agent',
      description: 'Forecasts',
      capabilities: ['weather', 'geo'],
      priceUsdc: 0.02,
      registry_id: SELF_PUBLISHED_REGISTRY_ID,
      invokeUrl: 'https://api.myweather.example/agent',
      verified: false,
      status: 'active',
    });
    expect(result.registries).toContain(SELF_PUBLISHED_REGISTRY_ID);

    // Sobrevive el pipeline común (sort + limit + text filter).
    mockListAsAgents.mockResolvedValueOnce([SELF_AGENT]);
    const filtered = await discoveryService.discover({
      limit: 1,
      query: 'weather',
    });
    expect(filtered.agents).toHaveLength(1);
    expect(filtered.agents[0]?.slug).toBe('my-weather-agent');
  });

  // ── T-PUB-03 ─────────────────────────────────────────────────────
  it('T-PUB-03: getAgent(slug) resolves the local agent without outbound fetch (AC-2)', async () => {
    mockGetBySlug.mockResolvedValueOnce(SELF_AGENT);

    const agent = await discoveryService.getAgent('my-weather-agent');

    expect(agent).not.toBeNull();
    expect(agent?.slug).toBe('my-weather-agent');
    expect(agent?.registry_id).toBe(SELF_PUBLISHED_REGISTRY_ID);
    // Local-first: se retorna antes de iterar registries (sin fetch outbound).
    expect(mockGetEnabled).not.toHaveBeenCalled();
  });
});
