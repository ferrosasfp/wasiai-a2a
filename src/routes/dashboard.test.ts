/**
 * Dashboard Routes Tests — WKH-AUDIT-A2A
 * AC-1: prod + token ausente → 503 service_unavailable
 * AC-2: dev + token ausente → passthrough 200
 * reg:  prod + token OK → 200; token MAL → 401 (CD-5 intacto)
 * AC-3/AC-4: aserto sobre .env.example + docs naming drift
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// ── Mock event service (no DB) ──────────────────────────────
vi.mock('../services/event.js', () => ({
  eventService: {
    stats: vi.fn().mockResolvedValue({ ok: true }),
    recent: vi.fn().mockResolvedValue([]),
  },
}));

// ── WKH-189: mock arbiter service (evita cargar supabase/adapters) ──
const mockListHolds = vi.hoisted(() => vi.fn());
const mockResolveHold = vi.hoisted(() => vi.fn());
const mockIsArbiterEnabled = vi.hoisted(() => vi.fn(() => true));
vi.mock('../services/arbiter.js', () => ({
  arbiterService: {
    listHolds: (...a: unknown[]) => mockListHolds(...a),
    resolveHold: (...a: unknown[]) => mockResolveHold(...a),
  },
  isArbiterEnabled: () => mockIsArbiterEnabled(),
}));

import dashboardRoutes from './dashboard.js';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_ADMIN_TOKEN = process.env.DASHBOARD_ADMIN_TOKEN;

async function buildApp() {
  const app = Fastify();
  await app.register(dashboardRoutes, { prefix: '/dashboard' });
  await app.ready();
  return app;
}

describe('dashboard admin-token preHandler', () => {
  beforeEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.DASHBOARD_ADMIN_TOKEN;
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.DASHBOARD_ADMIN_TOKEN;
  });

  afterAll(() => {
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_ADMIN_TOKEN === undefined)
      delete process.env.DASHBOARD_ADMIN_TOKEN;
    else process.env.DASHBOARD_ADMIN_TOKEN = ORIGINAL_ADMIN_TOKEN;
  });

  it('AC-1: prod + token ausente → 503 service_unavailable', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.DASHBOARD_ADMIN_TOKEN;
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/api/stats',
    });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.error).toBe('service_unavailable');
    expect(body.message).toBe('Dashboard API not configured');
    await app.close();
  });

  it('AC-2: dev + token ausente → passthrough 200', async () => {
    delete process.env.NODE_ENV; // non-production
    delete process.env.DASHBOARD_ADMIN_TOKEN;
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/api/stats',
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('reg: prod + token OK → 200 (passthrough)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DASHBOARD_ADMIN_TOKEN = 'secret';
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/api/stats',
      headers: { 'x-admin-token': 'secret' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('reg: prod + token MAL → 401 unauthorized (CD-5 intacto)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DASHBOARD_ADMIN_TOKEN = 'secret';
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/api/stats',
      headers: { 'x-admin-token': 'wrong' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('unauthorized');
    await app.close();
  });
});

describe('AC-3/AC-4: env + docs naming drift', () => {
  const root = process.cwd();

  it('AC-3: .env.example documents the 3 vars', () => {
    const env = readFileSync(resolve(root, '.env.example'), 'utf-8');
    expect(env).toContain('DASHBOARD_ADMIN_TOKEN');
    expect(env).toContain('DISCOVERY_REGISTRY_TIMEOUT_MS');
    expect(env).toContain('SUPABASE_SERVICE_KEY');
  });

  it('AC-4: project-context.md references SUPABASE_SERVICE_KEY (not _ROLE_) for the runtime var', () => {
    const ctx = readFileSync(
      resolve(root, '.nexus/project-context.md'),
      'utf-8',
    );
    expect(ctx).not.toContain('SUPABASE_SERVICE_ROLE_KEY=sb_secret_');
  });

  it('AC-4: CLAUDE.md runtime var reference uses SUPABASE_SERVICE_KEY', () => {
    const claude = readFileSync(resolve(root, 'CLAUDE.md'), 'utf-8');
    expect(claude).toContain('SUPABASE_SERVICE_KEY');
  });
});

// ════════════════════════════════════════════════════════════════════
// WKH-189 · Rutas admin de override de arb_hold (holds + resolve)
// ════════════════════════════════════════════════════════════════════
describe('WKH-189 admin arbitration routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsArbiterEnabled.mockReturnValue(true);
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.DASHBOARD_ADMIN_TOKEN;
  });

  // ── T-1 (AC-1): GET holds cross-tenant con token válido ──
  it('T-1: GET holds con token válido lista holds cross-tenant (2 owners) + total', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secret';
    mockListHolds.mockResolvedValue([
      {
        intentId: 'aaaaaaaa-0000-0000-0000-000000000001',
        chainId: 2368,
        atStakeUsd: 10,
        decision: 'hold',
        method: 'hold',
        ambiguityReason: 'proof_chain_tamper',
        createdAt: '2026-07-11T00:00:00.000Z',
      },
      {
        intentId: 'bbbbbbbb-0000-0000-0000-000000000002',
        chainId: 43113,
        atStakeUsd: 20,
        decision: 'hold',
        method: 'hold',
        ambiguityReason: 'over_cap',
        createdAt: '2026-07-11T01:00:00.000Z',
      },
    ]);
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/api/arbitrations/holds',
      headers: { 'x-admin-token': 'secret' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(2);
    expect(body.holds).toHaveLength(2);
    const ids = body.holds.map((h: { intentId: string }) => h.intentId);
    expect(ids).toContain('aaaaaaaa-0000-0000-0000-000000000001');
    expect(ids).toContain('bbbbbbbb-0000-0000-0000-000000000002');
    await app.close();
  });

  // ── T-5 (AC-5): sin X-Admin-Token → 401; servicios NO invocados ──
  it('T-5: GET/POST sin X-Admin-Token (con token configurado) → 401, servicios no invocados', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secret';
    const app = await buildApp();

    const getRes = await app.inject({
      method: 'GET',
      url: '/dashboard/api/arbitrations/holds',
    });
    expect(getRes.statusCode).toBe(401);

    const postRes = await app.inject({
      method: 'POST',
      url: '/dashboard/api/arbitrations/i1/resolve',
      payload: { decision: 'release' },
    });
    expect(postRes.statusCode).toBe(401);

    expect(mockListHolds).not.toHaveBeenCalled();
    expect(mockResolveHold).not.toHaveBeenCalled();
    await app.close();
  });

  // ── T-9 (AC-8/CD-7): flag OFF → 404 NOT_FOUND byte-idéntico, aún con token ──
  it('T-9: ARBITER_ENABLED != true → GET/POST 404 {error_code:NOT_FOUND}, incluso con token válido', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secret';
    mockIsArbiterEnabled.mockReturnValue(false);
    const app = await buildApp();

    const getRes = await app.inject({
      method: 'GET',
      url: '/dashboard/api/arbitrations/holds',
      headers: { 'x-admin-token': 'secret' },
    });
    expect(getRes.statusCode).toBe(404);
    expect(getRes.json()).toEqual({ error_code: 'NOT_FOUND' });

    const postRes = await app.inject({
      method: 'POST',
      url: '/dashboard/api/arbitrations/i1/resolve',
      headers: { 'x-admin-token': 'secret' },
      payload: { decision: 'release' },
    });
    expect(postRes.statusCode).toBe(404);
    expect(postRes.json()).toEqual({ error_code: 'NOT_FOUND' });

    expect(mockListHolds).not.toHaveBeenCalled();
    expect(mockResolveHold).not.toHaveBeenCalled();
    await app.close();
  });
});
