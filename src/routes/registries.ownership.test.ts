/**
 * Registries Routes — Ownership Integration Tests (WKH-63 / SEC-REG-1).
 *
 * Verifies the HTTP wiring:
 *   - request.a2aKeyRow.owner_ref propagates to registryService.{register,update,delete}.
 *   - OwnershipMismatchError       → 404 'Registry not found'.
 *   - SystemRegistryImmutableError → 403 'System registry is immutable'.
 *   - Same-owner happy path        → 200/201.
 *
 * Auth strategy: same as registries.ssrf.test.ts — mock the auth middleware
 * to inject `request.a2aKeyRow` directly so we can drive each test as
 * "tenant A" without standing up the full x402 / a2a-key pipeline.
 *
 * Naming: T-OWN-01..T-OWN-10.
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
import type { A2AAgentKeyRow } from '../types/index.js';

// ── Mocks (BEFORE importing the route module) ──────────────

vi.mock('../services/registry.js', async () => {
  // Preserve the real error class exports so the route handler's
  // `instanceof` checks fire when the mocked service throws.
  const actual = await vi.importActual<typeof import('../services/registry.js')>(
    '../services/registry.js',
  );
  return {
    ...actual,
    registryService: {
      list: vi.fn(),
      get: vi.fn(),
      register: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      getEnabled: vi.fn(),
    },
  };
});

// SSRF validator: pass everything (we test ownership, not SSRF).
vi.mock('../lib/url-validator.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/url-validator.js')>(
    '../lib/url-validator.js',
  );
  return {
    ...actual,
    validateRegistryUrl: vi.fn().mockResolvedValue(undefined),
  };
});

// AB-WKH-55: stub the auth middleware. We inject a fake a2aKeyRow whose
// owner_ref we control via `currentOwner` below.
let currentOwner: string | null = 'tenant-A';

vi.mock('../middleware/a2a-key.js', () => ({
  requirePaymentOrA2AKey: () => [
    async (request: { a2aKeyRow?: A2AAgentKeyRow }) => {
      if (currentOwner === null) return; // simulate x402-anonymous path
      request.a2aKeyRow = {
        id: 'fake-key-id',
        owner_ref: currentOwner,
      } as A2AAgentKeyRow;
    },
  ],
}));

import { registryService, SystemRegistryImmutableError } from '../services/registry.js';
import { OwnershipMismatchError } from '../services/security/errors.js';
import registriesRoutes from './registries.js';

const mockRegister = vi.mocked(registryService.register);
const mockUpdate = vi.mocked(registryService.update);
const mockDelete = vi.mocked(registryService.delete);

const REGISTRY_RESPONSE = {
  id: 'tenant-A-reg',
  name: 'tenant-A-reg',
  discoveryEndpoint: 'https://example.com/discover',
  invokeEndpoint: 'https://example.com/invoke',
  schema: { discovery: {}, invoke: { method: 'POST' as const } },
  enabled: true,
  createdAt: new Date(),
  ownerRef: 'tenant-A',
};

describe('registries routes — ownership integration (WKH-63 W3)', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();
    await app.register(registriesRoutes, { prefix: '/registries' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    currentOwner = 'tenant-A';
  });

  // ── POST /registries ────────────────────────────────────────────

  it('T-OWN-01: POST forwards a2aKeyRow.owner_ref to service.register', async () => {
    mockRegister.mockResolvedValueOnce(REGISTRY_RESPONSE);

    const res = await app.inject({
      method: 'POST',
      url: '/registries',
      payload: {
        name: 'tenant-A-reg',
        discoveryEndpoint: 'https://example.com/discover',
        invokeEndpoint: 'https://example.com/invoke',
        schema: { discovery: {}, invoke: { method: 'POST' } },
      },
    });

    expect(res.statusCode).toBe(201);
    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(mockRegister.mock.calls[0]?.[1]).toBe('tenant-A');
  });

  it('T-OWN-02: POST without a2aKeyRow falls back to "x402-anonymous"', async () => {
    currentOwner = null;
    mockRegister.mockResolvedValueOnce({
      ...REGISTRY_RESPONSE,
      ownerRef: 'x402-anonymous',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/registries',
      payload: {
        name: 'anon-reg',
        discoveryEndpoint: 'https://example.com/discover',
        invokeEndpoint: 'https://example.com/invoke',
        schema: { discovery: {}, invoke: { method: 'POST' } },
      },
    });

    expect(res.statusCode).toBe(201);
    expect(mockRegister.mock.calls[0]?.[1]).toBe('x402-anonymous');
  });

  // ── PATCH /registries/:id ───────────────────────────────────────

  it('T-OWN-03: PATCH on cross-tenant row → 404 "Registry not found"', async () => {
    mockUpdate.mockRejectedValueOnce(new OwnershipMismatchError());

    const res = await app.inject({
      method: 'PATCH',
      url: '/registries/reg-of-B',
      payload: { name: 'steal' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Registry not found' });
    // Service was called with the caller's owner_ref → guard ran inside.
    expect(mockUpdate.mock.calls[0]?.[2]).toBe('tenant-A');
  });

  it('T-OWN-04: PATCH on system row → 403 "System registry is immutable"', async () => {
    mockUpdate.mockRejectedValueOnce(new SystemRegistryImmutableError());

    const res = await app.inject({
      method: 'PATCH',
      url: '/registries/wasiai',
      payload: { name: 'pwn3d' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'System registry is immutable' });
  });

  it('T-OWN-05: PATCH same-owner happy path → 200', async () => {
    mockUpdate.mockResolvedValueOnce(REGISTRY_RESPONSE);

    const res = await app.inject({
      method: 'PATCH',
      url: '/registries/tenant-A-reg',
      payload: { name: 'renamed' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUpdate.mock.calls[0]?.[2]).toBe('tenant-A');
  });

  it('T-OWN-06: PATCH non-existent id → 404 (NOT 403, disclosure-safe)', async () => {
    mockUpdate.mockRejectedValueOnce(new OwnershipMismatchError());

    const res = await app.inject({
      method: 'PATCH',
      url: '/registries/never-existed',
      payload: { name: 'x' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('Registry not found');
  });

  // ── DELETE /registries/:id ──────────────────────────────────────

  it('T-OWN-07: DELETE on cross-tenant row → 404 "Registry not found"', async () => {
    mockDelete.mockRejectedValueOnce(new OwnershipMismatchError());

    const res = await app.inject({
      method: 'DELETE',
      url: '/registries/reg-of-B',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Registry not found' });
    expect(mockDelete.mock.calls[0]?.[1]).toBe('tenant-A');
  });

  it('T-OWN-08: DELETE on system row → 403 "System registry is immutable"', async () => {
    mockDelete.mockRejectedValueOnce(new SystemRegistryImmutableError());

    const res = await app.inject({
      method: 'DELETE',
      url: '/registries/wasiai',
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'System registry is immutable' });
  });

  it('T-OWN-09: DELETE same-owner happy path → 200 success', async () => {
    mockDelete.mockResolvedValueOnce(true);

    const res = await app.inject({
      method: 'DELETE',
      url: '/registries/tenant-A-reg',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    expect(mockDelete.mock.calls[0]?.[1]).toBe('tenant-A');
  });

  it('T-OWN-10: error mapping covers both error classes (no leak to 400)', async () => {
    // Multiple variations to harden against regressions: a generic Error
    // still gets the existing 400 handler, but our two domain errors hit
    // mapOwnershipError first. We exercise both via DELETE.
    mockDelete.mockRejectedValueOnce(new SystemRegistryImmutableError());
    const r1 = await app.inject({
      method: 'DELETE',
      url: '/registries/wasiai',
    });
    expect(r1.statusCode).toBe(403);

    mockDelete.mockRejectedValueOnce(new OwnershipMismatchError());
    const r2 = await app.inject({
      method: 'DELETE',
      url: '/registries/foreign',
    });
    expect(r2.statusCode).toBe(404);

    mockDelete.mockRejectedValueOnce(new Error('database down'));
    const r3 = await app.inject({
      method: 'DELETE',
      url: '/registries/anything',
    });
    expect(r3.statusCode).toBe(400);
    expect(r3.json().error).toBe('database down');
  });
});
