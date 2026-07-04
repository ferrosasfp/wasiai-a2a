/**
 * Agents Routes — Ownership / anti-IDOR integration tests (WKH-134).
 *
 * Cubre AC-4 / DT-2 (cross-owner update/delete → 404 disclosure-safe,
 * logOwnershipMismatch, sin mutación). Usa el service REAL + supabase mockeado
 * (in-memory) + route real + middleware mockeado, para ejercitar el guard de
 * ownership end-to-end. `logOwnershipMismatch` se mockea para asertar la llamada
 * PII-safe manteniendo la clase real `OwnershipMismatchError` (instanceof).
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

// ── Estado del supabase mock (in-memory) ───────────────────────────
const { state, mockLog } = vi.hoisted(() => ({
  state: {
    row: null as Record<string, unknown> | null,
    updateCalled: false,
    deleteCalled: false,
    eqCalls: [] as Array<[string, unknown]>,
  },
  mockLog: vi.fn(),
}));

vi.mock('../lib/supabase.js', () => {
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    select: () => builder,
    insert: () => builder,
    update: () => {
      state.updateCalled = true;
      return builder;
    },
    delete: () => {
      state.deleteCalled = true;
      return builder;
    },
    eq: (col: string, val: unknown) => {
      state.eqCalls.push([col, val]);
      return builder;
    },
    order: () => Promise.resolve({ data: [], error: null }),
    maybeSingle: () => Promise.resolve({ data: state.row, error: null }),
    single: () => Promise.resolve({ data: state.row, error: null }),
  });
  return { supabase: { from: () => builder } };
});

// logOwnershipMismatch mockeado; OwnershipMismatchError real (instanceof).
vi.mock('../services/security/errors.js', async () => {
  const actual = await vi.importActual<
    typeof import('../services/security/errors.js')
  >('../services/security/errors.js');
  return { ...actual, logOwnershipMismatch: mockLog };
});

let currentOwner: string | null = 'tenant-B';
vi.mock('../middleware/a2a-key.js', () => ({
  requirePaymentOrA2AKey: () => [
    async (request: { a2aKeyRow?: { id: string; owner_ref: string } }) => {
      if (currentOwner === null) return;
      request.a2aKeyRow = { id: 'fake-key-id', owner_ref: currentOwner };
    },
  ],
}));

import agentsRoutes from './agents.js';

const OWNER_A_ROW = {
  slug: 'a-owned-agent',
  name: 'A Owned Agent',
  description: '',
  capabilities: ['x'],
  agent_url: 'https://a.example/agent',
  price_usdc: 0,
  metadata: null,
  enabled: true,
  owner_ref: 'tenant-A',
  created_at: new Date().toISOString(),
};

describe('agents routes — ownership / anti-IDOR (WKH-134)', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();
    await app.register(agentsRoutes, { prefix: '/agents' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    currentOwner = 'tenant-B';
    state.row = { ...OWNER_A_ROW };
    state.updateCalled = false;
    state.deleteCalled = false;
    state.eqCalls = [];
  });

  // ── T-PUB-08 ─────────────────────────────────────────────────────
  it('T-PUB-08: owner B PATCH slug of owner A → 404, logOwnershipMismatch, UPDATE not run', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/a-owned-agent',
      payload: { name: 'stolen' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Agent not found' });

    expect(mockLog).toHaveBeenCalledTimes(1);
    expect(mockLog.mock.calls[0]?.[0]).toMatchObject({
      op: 'agentPublishUpdate',
      resourceId: 'a-owned-agent',
      callerOwnerRef: 'tenant-B',
      actualOwnerRef: 'tenant-A',
    });
    // Ninguna mutación se ejecutó (el guard corta antes del UPDATE).
    expect(state.updateCalled).toBe(false);
  });

  // ── T-PUB-09 ─────────────────────────────────────────────────────
  it('T-PUB-09: owner B DELETE slug of owner A → 404, logOwnershipMismatch, DELETE not run', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/agents/a-owned-agent',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Agent not found' });

    expect(mockLog).toHaveBeenCalledTimes(1);
    expect(mockLog.mock.calls[0]?.[0]).toMatchObject({
      op: 'agentPublishDelete',
      resourceId: 'a-owned-agent',
      callerOwnerRef: 'tenant-B',
      actualOwnerRef: 'tenant-A',
    });
    expect(state.deleteCalled).toBe(false);
  });
});
