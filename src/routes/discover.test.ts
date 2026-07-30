/**
 * Discover Routes Rate-Limit Tests — WKH-AUDIT-A2A
 * AC-5: /discover ahora hereda el rate-limit global (ya no rateLimit:false).
 *       N+1 requests → 429 con body.code === 'RATE_LIMIT_EXCEEDED' (CD-6).
 *
 * CD-10: registerErrorBoundary ANTES de registerRateLimit (el rate-limit
 *        plugin THROWS el Error; el error-boundary lo convierte en respuesta).
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
import { registerErrorBoundary } from '../middleware/error-boundary.js';
import { registerRateLimit } from '../middleware/rate-limit.js';
import { genReqId, registerRequestIdHook } from '../middleware/request-id.js';

// Mock service: no fanout real.
vi.mock('../services/discovery.js', () => ({
  discoveryService: {
    discover: vi.fn().mockResolvedValue({ agents: [], total: 0 }),
    getAgent: vi.fn().mockResolvedValue(null),
  },
}));

import { discoveryService } from '../services/discovery.js';
import discoverRoutes from './discover.js';

const mockDiscover = vi.mocked(discoveryService.discover);
const mockGetAgent = vi.mocked(discoveryService.getAgent);

describe('AC-5: /discover rate-limit', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    process.env.RATE_LIMIT_MAX = '3';
    process.env.RATE_LIMIT_WINDOW_MS = '60000';

    app = Fastify({ genReqId });
    registerRequestIdHook(app);
    registerErrorBoundary(app); // CD-10: ANTES de rate-limit
    await registerRateLimit(app);
    await app.register(discoverRoutes, { prefix: '/discover' });
    await app.ready();
  });

  afterAll(async () => {
    delete process.env.RATE_LIMIT_MAX;
    delete process.env.RATE_LIMIT_WINDOW_MS;
    await app.close();
  });

  it('GET within limit → 200', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: 'GET', url: '/discover' });
      expect(res.statusCode).toBe(200);
    }
  });

  it('GET exceeding limit → 429 with body.code RATE_LIMIT_EXCEEDED (CD-6)', async () => {
    // 4th request from the same default IP exceeds max=3.
    const res = await app.inject({ method: 'GET', url: '/discover' });
    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe('RATE_LIMIT_EXCEEDED');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Audit 2026-06-24 (P1-4): discover route behaviour — GET list, POST with
// filters, GET /:slug 404, registry-failure degradation, empty query.
// rate-limit disabled here so we exercise the route logic, not the limiter.
// ─────────────────────────────────────────────────────────────────────

describe('discover route — behaviour (P1-4)', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    process.env.RATE_LIMIT_MAX = '1000';
    process.env.RATE_LIMIT_WINDOW_MS = '60000';
    app = Fastify({ genReqId });
    registerRequestIdHook(app);
    registerErrorBoundary(app);
    await registerRateLimit(app);
    await app.register(discoverRoutes, { prefix: '/discover' });
    await app.ready();
  });

  afterAll(async () => {
    delete process.env.RATE_LIMIT_MAX;
    delete process.env.RATE_LIMIT_WINDOW_MS;
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockDiscover.mockResolvedValue({
      agents: [],
      total: 0,
      registries: [],
      sources: [],
      catalogStatus: 'complete',
    });
    mockGetAgent.mockResolvedValue(null);
  });

  it('P1-4: GET /discover → 200 with the service result passed through', async () => {
    mockDiscover.mockResolvedValueOnce({
      agents: [
        {
          id: 'a1',
          name: 'KYC',
          slug: 'kyc',
          description: 'kyc',
          capabilities: ['kyc'],
          priceUsdc: 0.01,
          registry: 'wasiai',
          registry_id: 'wasiai',
          invokeUrl: 'https://example.com/invoke',
          invocationNote: 'use /compose',
          verified: true,
          status: 'active',
          metadata: {},
        },
      ],
      total: 1,
      registries: ['wasiai'],
      sources: [],
      catalogStatus: 'complete',
    });

    const res = await app.inject({ method: 'GET', url: '/discover' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
    expect(res.json().agents[0].slug).toBe('kyc');
  });

  it('P1-4: GET /discover parses query params (capabilities CSV, maxPrice, registry filter)', async () => {
    await app.inject({
      method: 'GET',
      url: '/discover?capabilities=kyc,%20payments&maxPrice=0.5&registry=wasiai&verified=true',
    });

    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilities: ['kyc', 'payments'],
        maxPrice: 0.5,
        registry: 'wasiai',
        verified: true,
      }),
    );
  });

  it('P1-4: POST /discover applies the registry filter from the JSON body', async () => {
    await app.inject({
      method: 'POST',
      url: '/discover',
      payload: { q: 'remit', registry: 'wasiai-agentshop', maxPrice: 1.5 },
    });

    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'remit',
        registry: 'wasiai-agentshop',
        maxPrice: 1.5,
      }),
    );
  });

  it('P1-4: POST /discover normalizes capabilities given as a CSV string', async () => {
    await app.inject({
      method: 'POST',
      url: '/discover',
      payload: { capabilities: 'kyc, payments' },
    });

    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ capabilities: ['kyc', 'payments'] }),
    );
  });

  it('P1-4: POST /discover normalizes capabilities given as a string array', async () => {
    await app.inject({
      method: 'POST',
      url: '/discover',
      payload: { capabilities: ['kyc', ' payments '] },
    });

    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ capabilities: ['kyc', 'payments'] }),
    );
  });

  it('P1-4: POST /discover with an empty body → 200, service called with all-undefined filters', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/discover',
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({
        query: undefined,
        registry: undefined,
        capabilities: undefined,
      }),
    );
  });

  it('P1-4: GET /discover/:slug for an unknown slug → 404 with an error body', async () => {
    mockGetAgent.mockResolvedValueOnce(null);

    const res = await app.inject({ method: 'GET', url: '/discover/ghost' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('Agent not found');
    expect(mockGetAgent).toHaveBeenCalledWith('ghost', undefined);
  });

  it('P1-4: GET /discover/:slug for an existing agent → 200 with the agent', async () => {
    mockGetAgent.mockResolvedValueOnce({
      id: 'a1',
      name: 'KYC',
      slug: 'kyc',
      description: 'kyc',
      capabilities: ['kyc'],
      priceUsdc: 0.01,
      registry: 'wasiai',
      registry_id: 'wasiai',
      invokeUrl: 'https://example.com/invoke',
      invocationNote: 'use /compose',
      verified: true,
      status: 'active',
      metadata: {},
    });

    const res = await app.inject({
      method: 'GET',
      url: '/discover/kyc?registry=wasiai',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().slug).toBe('kyc');
    // registry hint forwarded to the service.
    expect(mockGetAgent).toHaveBeenCalledWith('kyc', 'wasiai');
  });

  it('P1-4: registry-level degradation — service returns a partial result (some registries down) → 200, no 500', async () => {
    // discoveryService swallows a failing remote registry and returns the
    // agents from the registries that DID respond, plus the surviving registry
    // list. The route must pass that through as a normal 200 (no 500 leak).
    mockDiscover.mockResolvedValueOnce({
      agents: [
        {
          id: 'a1',
          name: 'KYC',
          slug: 'kyc',
          description: 'kyc',
          capabilities: ['kyc'],
          priceUsdc: 0.01,
          registry: 'wasiai',
          registry_id: 'wasiai',
          invokeUrl: 'https://example.com/invoke',
          invocationNote: 'use /compose',
          verified: false,
          status: 'active',
          metadata: {},
        },
      ],
      total: 1,
      // a remote registry failed to respond → omitted from the surviving list.
      registries: ['wasiai'],
      sources: [],
      catalogStatus: 'complete',
    });

    const res = await app.inject({ method: 'GET', url: '/discover' });
    expect(res.statusCode).toBe(200);
    expect(res.json().registries).toEqual(['wasiai']);
    expect(res.json().total).toBe(1);
  });
});
