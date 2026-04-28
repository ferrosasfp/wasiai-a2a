/**
 * Registries Routes — Write-time SSRF Guard Tests (WKH-62 W2).
 *
 * Verifies that POST /registries and PATCH /registries/:id reject SSRF
 * URLs in `discoveryEndpoint`/`invokeEndpoint` BEFORE persisting (CD-A5).
 *
 * Auth strategy: per AB-WKH-55, mock `requirePaymentOrA2AKey` to return a
 * no-op preHandler so the test bypasses the x402 flow. This keeps the
 * SSRF guard the only behaviour under test.
 *
 * Coverage matrix (T-REG-01..T-REG-08):
 *   01  POST 169.254.169.254 in discoveryEndpoint   → 422 SSRF_BLOCKED
 *   02  POST 10.0.0.1 in invokeEndpoint              → 422, field=invokeEndpoint
 *   03  POST happy path (both public)                → 201, register called
 *   04  POST file:///etc/passwd                      → 422, field=discoveryEndpoint
 *   05  PATCH localhost in discoveryEndpoint         → 422, update NOT called
 *   06  PATCH name-only (no URL fields)              → 200, update called
 *   07  PATCH valid invokeEndpoint                   → 200, update called
 *   08  POST body 422 has NO `stack` field (CD-2)
 */

import Fastify from 'fastify';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// ── Mocks (must be set BEFORE importing the route module) ──────────

const mockLookup = vi.fn();
vi.mock('node:dns', () => ({
  promises: {
    lookup: (...args: unknown[]) => mockLookup(...args),
  },
}));

vi.mock('../services/registry.js', () => ({
  registryService: {
    list: vi.fn(),
    get: vi.fn(),
    register: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

// AB-WKH-55: mock the auth middleware so the x402 fallback never runs.
// WKH-63 fix-pack (BLQ-ALTO-1): inject a fake a2aKeyRow so the new
// `a2a-key required` guard pasa y los tests SSRF mantienen su contrato
// (verifican el guard SSRF, no el guard de auth).
vi.mock('../middleware/a2a-key.js', () => ({
  requirePaymentOrA2AKey: () => [
    async (request: { a2aKeyRow?: { id: string; owner_ref: string } }) => {
      request.a2aKeyRow = { id: 'fake-key-id', owner_ref: 'tenant-ssrf' };
    },
  ],
}));

import { registryService } from '../services/registry.js';
import registriesRoutes from './registries.js';

const ORIGINAL_ENV = { ...process.env };

const mockRegister = vi.mocked(registryService.register);
const mockUpdate = vi.mocked(registryService.update);

describe('registries routes — write-time SSRF guard (WKH-62 W2)', () => {
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
    mockLookup.mockReset();
    vi.clearAllMocks();
    delete process.env.DISCOVERY_SSRF_ALLOWLIST;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  // ── POST /registries ─────────────────────────────────────────────

  it('T-REG-01: POST with discoveryEndpoint resolving to 169.254.169.254 → 422', async () => {
    mockLookup.mockResolvedValueOnce([
      { address: '169.254.169.254', family: 4 },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/registries',
      payload: {
        name: 'evil-reg',
        discoveryEndpoint: 'http://metadata.attacker.example/discover',
        invokeEndpoint: 'https://example.com/invoke',
        schema: { discovery: {}, invoke: { method: 'POST' } },
      },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe('SSRF_BLOCKED');
    expect(body.field).toBe('discoveryEndpoint');
    expect(body.reason).toContain('169.254.169.254');
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('T-REG-02: POST with valid discoveryEndpoint + private invokeEndpoint → 422, field=invokeEndpoint', async () => {
    mockLookup
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]) // discovery: public
      .mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]); // invoke: private

    const res = await app.inject({
      method: 'POST',
      url: '/registries',
      payload: {
        name: 'mixed-reg',
        discoveryEndpoint: 'https://example.com/discover',
        invokeEndpoint: 'http://internal.attacker.example/invoke',
        schema: { discovery: {}, invoke: { method: 'POST' } },
      },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe('SSRF_BLOCKED');
    expect(body.field).toBe('invokeEndpoint');
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('T-REG-03: POST happy path (both endpoints public) → 201, register called', async () => {
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    mockRegister.mockResolvedValueOnce({
      id: 'good',
      name: 'good',
      discoveryEndpoint: 'https://example.com/discover',
      invokeEndpoint: 'https://example.com/invoke',
      schema: { discovery: {}, invoke: { method: 'POST' } },
      enabled: true,
      createdAt: new Date(),
      ownerRef: 'tenant-A',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/registries',
      payload: {
        name: 'good',
        discoveryEndpoint: 'https://example.com/discover',
        invokeEndpoint: 'https://example.com/invoke',
        schema: { discovery: {}, invoke: { method: 'POST' } },
      },
    });

    expect(res.statusCode).toBe(201);
    expect(mockRegister).toHaveBeenCalledTimes(1);
  });

  it('T-REG-04: POST with file:///etc/passwd → 422, field=discoveryEndpoint', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/registries',
      payload: {
        name: 'file-reg',
        discoveryEndpoint: 'file:///etc/passwd',
        invokeEndpoint: 'https://example.com/invoke',
        schema: { discovery: {}, invoke: { method: 'POST' } },
      },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe('SSRF_BLOCKED');
    expect(body.field).toBe('discoveryEndpoint');
    // reason carries category-specific datum (here: the protocol)
    expect(body.reason).toContain('file:');
    expect(mockRegister).not.toHaveBeenCalled();
  });

  // ── PATCH /registries/:id ────────────────────────────────────────

  it('T-REG-05: PATCH with discoveryEndpoint=http://localhost → 422, update NOT called', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/registries/some-id',
      payload: {
        discoveryEndpoint: 'http://localhost/discover',
      },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe('SSRF_BLOCKED');
    expect(body.field).toBe('discoveryEndpoint');
    expect(body.reason).toContain('localhost');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('T-REG-06: PATCH with only name (no URL fields) → 200, update called', async () => {
    mockUpdate.mockResolvedValueOnce({
      id: 'some-id',
      name: 'renamed',
      discoveryEndpoint: 'https://example.com/discover',
      invokeEndpoint: 'https://example.com/invoke',
      schema: { discovery: {}, invoke: { method: 'POST' } },
      enabled: true,
      createdAt: new Date(),
      ownerRef: 'tenant-A',
    });

    const res = await app.inject({
      method: 'PATCH',
      url: '/registries/some-id',
      payload: { name: 'renamed' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    // WKH-63: update toma un 3er `ownerRef` arg desde request.a2aKeyRow.
    // WKH-63 fix-pack (BLQ-ALTO-1): el sentinel 'x402-anonymous' se eliminó.
    // El mock de auth ahora inyecta `a2aKeyRow` con `owner_ref='tenant-ssrf'`.
    expect(mockUpdate).toHaveBeenCalledWith(
      'some-id',
      { name: 'renamed' },
      'tenant-ssrf',
    );
  });

  it('T-REG-07: PATCH with valid invokeEndpoint → 200, update called', async () => {
    mockLookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    mockUpdate.mockResolvedValueOnce({
      id: 'some-id',
      name: 'r',
      discoveryEndpoint: 'https://example.com/discover',
      invokeEndpoint: 'https://valid.com/invoke',
      schema: { discovery: {}, invoke: { method: 'POST' } },
      enabled: true,
      createdAt: new Date(),
      ownerRef: 'tenant-A',
    });

    const res = await app.inject({
      method: 'PATCH',
      url: '/registries/some-id',
      payload: { invokeEndpoint: 'https://valid.com/invoke' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  // ── CD-2: 422 body must NOT leak stack trace ─────────────────────

  it('T-REG-08: 422 body never contains `stack` field (CD-2)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/registries',
      payload: {
        name: 'leak-test',
        discoveryEndpoint: 'http://localhost/x',
        invokeEndpoint: 'https://example.com/invoke',
        schema: { discovery: {}, invoke: { method: 'POST' } },
      },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    // Allow only the documented contract: error, field, reason.
    expect(Object.keys(body).sort()).toEqual(['error', 'field', 'reason']);
    expect(body.stack).toBeUndefined();
    expect(body.category).toBeUndefined();
  });
});
