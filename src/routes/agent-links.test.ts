/**
 * Agent Link Routes — integration tests (WKH-137).
 *
 * Cubre: T2 mint rechaza session token (403 SESSION_NOT_ALLOWED), T8 redeem
 * token inexistente (404 LINK_NOT_FOUND), T15 (AC-5) no existe mutación
 * (PATCH sobre link → 404). Middlewares (timeout/rate-limit/backpressure) y
 * parsers/service mockeados.
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

// ── Mock middlewares (no-ops) ───────────────────────────────
vi.mock('../middleware/timeout.js', () => ({
  createTimeoutHandler: () => async () => {
    /* no-op */
  },
}));
vi.mock('../middleware/rate-limit.js', () => ({
  orchestrateRateLimit: () => false,
}));
vi.mock('../middleware/backpressure.js', () => ({
  createBackpressureHandler: () => async () => {
    /* no-op */
  },
}));

// ── Mock adapters registry (chainId por defecto) ────────────
vi.mock('../adapters/registry.js', () => ({
  getAdaptersBundle: () => ({ chainConfig: { chainId: 2368 } }),
}));

// ── Mocks hoisted (referenciables dentro de las factories de vi.mock) ──
const { mockResolveCallerKey, mockRawKeyFromRequest, mockMint, mockRedeem } =
  vi.hoisted(() => ({
    mockResolveCallerKey: vi.fn(),
    mockRawKeyFromRequest: vi.fn(),
    mockMint: vi.fn(),
    mockRedeem: vi.fn(),
  }));

// ── Mock parsers (auth) — mantiene KEY_SESSION_TOKEN_PREFIX real ──
vi.mock('./auth/parsers.js', async (importActual) => {
  const actual = await importActual<typeof import('./auth/parsers.js')>();
  return {
    ...actual,
    resolveCallerKey: (...a: unknown[]) => mockResolveCallerKey(...a),
    rawKeyFromRequest: (...a: unknown[]) => mockRawKeyFromRequest(...a),
  };
});

// ── Mock service (métodos) — mantiene error classes + prefix reales ──
vi.mock('../services/agent-link.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../services/agent-link.js')>();
  return {
    ...actual,
    agentLinkService: { mint: mockMint, redeem: mockRedeem },
  };
});

import { AgentLinkNotFoundError } from '../services/agent-link.js';
import agentLinkRoutes from './agent-links.js';

let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
  app = Fastify();
  await app.register(agentLinkRoutes, { prefix: '/agents' });
  await app.ready();
});

afterAll(() => app.close());

beforeEach(() => {
  vi.clearAllMocks();
  mockRawKeyFromRequest.mockReturnValue(undefined);
});

// ── T2 — mint rechaza session token ──
describe('mint auth gate (CD-6)', () => {
  it('T2: authenticator de sesión → 403 SESSION_NOT_ALLOWED', async () => {
    mockRawKeyFromRequest.mockReturnValue('wasi_a2a_sess_deadbeef');
    const res = await app.inject({
      method: 'POST',
      url: '/agents/kyc/link',
      payload: { maxPriceUsdc: '1' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('SESSION_NOT_ALLOWED');
    expect(mockResolveCallerKey).not.toHaveBeenCalled();
    expect(mockMint).not.toHaveBeenCalled();
  });

  it('T2b: authenticator con prefijo link → 403 SESSION_NOT_ALLOWED', async () => {
    mockRawKeyFromRequest.mockReturnValue('wasi_a2a_link_deadbeef');
    const res = await app.inject({
      method: 'POST',
      url: '/agents/kyc/link',
      payload: { maxPriceUsdc: '1' },
    });
    expect(res.statusCode).toBe(403);
    expect(mockMint).not.toHaveBeenCalled();
  });
});

// ── T8 — redeem token inexistente → 404 ──
describe('redeem HTTP mapping (AC-4)', () => {
  it('T8: token inexistente → 404 LINK_NOT_FOUND', async () => {
    mockRedeem.mockRejectedValue(new AgentLinkNotFoundError());
    const res = await app.inject({
      method: 'POST',
      url: '/agents/links/sometoken/redeem',
      payload: { input: {} },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error_code).toBe('LINK_NOT_FOUND');
  });
});

// ── T15 — AC-5: no existe endpoint de mutación (PATCH/PUT) ──
describe('mint-once inmutable (AC-5, CD-7)', () => {
  it('T15: PATCH sobre un link → 404 (no hay ruta de mutación)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/kyc/link',
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('T15b: PUT sobre un link → 404 (no hay ruta de mutación)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/agents/kyc/link',
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });
});
