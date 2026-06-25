/**
 * Auth Spend-Policies Endpoint Tests — WKH-125 (KEY-CONSTRAINTS)
 *
 * Cubre: AC-1 (PUT persiste + set(callerKey, input) + 200 con la política),
 * AC-7 (GET list(key_id, owner_ref); sub-session token → 403 SESSION_NOT_ALLOWED).
 *
 * Patrón: Fastify in-process + mock de spendPolicyService e
 * identityService.lookupByHash (auth de la master key) — espejo de
 * auth.key-session.test.ts.
 */

import crypto from 'node:crypto';
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
import type { A2AAgentKeyRow, SpendPolicy } from '../types/index.js';

// ── Mocks ──────────────────────────────────────────────────

vi.mock('../services/identity.js', () => ({
  identityService: {
    createKey: vi.fn(),
    lookupByHash: vi.fn(),
    deactivate: vi.fn(),
  },
  isIdentityVerified: (row: { erc8004_identity?: unknown } | null) =>
    row?.erc8004_identity != null,
}));

vi.mock('../services/budget.js', () => ({
  budgetService: {
    getBalance: vi.fn(),
    debit: vi.fn(),
    registerDeposit: vi.fn(),
  },
}));

vi.mock('../services/registry.js', () => ({
  registryService: { get: vi.fn() },
}));

vi.mock('../services/spend-policy.js', () => ({
  spendPolicyService: {
    set: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
    hasAnyPolicy: vi.fn(),
  },
  InvalidSpendPolicyInputError: class extends Error {},
}));

import { identityService } from '../services/identity.js';
import { spendPolicyService } from '../services/spend-policy.js';
import authRoutes from './auth.js';

const mockLookupByHash = vi.mocked(identityService.lookupByHash);
const mockSet = vi.mocked(spendPolicyService.set);
const mockList = vi.mocked(spendPolicyService.list);

const MASTER_KEY = `wasi_a2a_${'a'.repeat(64)}`;
const SESSION_TOKEN = `wasi_a2a_sess_${'b'.repeat(96)}`;

function makeKeyRow(overrides: Partial<A2AAgentKeyRow> = {}): A2AAgentKeyRow {
  return {
    id: 'key-1',
    owner_ref: 'user-1',
    key_hash: crypto.createHash('sha256').update(MASTER_KEY).digest('hex'),
    display_name: null,
    budget: { '2368': '50.00' },
    daily_limit_usd: null,
    daily_spent_usd: '0',
    daily_reset_at: new Date().toISOString(),
    allowed_registries: null,
    allowed_agent_slugs: null,
    allowed_categories: null,
    max_spend_per_call_usd: null,
    is_active: true,
    last_used_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    erc8004_identity: null,
    kite_passport: null,
    agentkit_wallet: null,
    funding_wallet: null,
    metadata: {},
    require_signature: false,
    ...overrides,
  };
}

const POLICY: SpendPolicy = {
  destination: 'kite/translator',
  max_usd: '50.000000',
  window_type: 'total',
  window_secs: null,
  created_at: 'ts',
  updated_at: 'ts',
};

describe('auth spend-policies endpoints', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();
    await app.register(authRoutes, { prefix: '/auth' });
    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('AC-1: PUT persists policy → 200 with the policy, set(callerKey, input)', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockSet.mockResolvedValue(POLICY);

    const res = await app.inject({
      method: 'PUT',
      url: '/auth/keys/me/spend-policies',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
      payload: {
        destination: 'kite/translator',
        max_usd: '50',
        window_type: 'total',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(POLICY);
    // AC-7: el service recibe el callerKey (owner_ref/key_id NUNCA del body).
    const [callerKey, input] = mockSet.mock.calls[0]!;
    expect(callerKey.owner_ref).toBe('user-1');
    expect(callerKey.id).toBe('key-1');
    expect(input.destination).toBe('kite/translator');
    expect(input.window_type).toBe('total');
  });

  it('AC-1: PUT accepts the `window` alias for window_type', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockSet.mockResolvedValue({
      ...POLICY,
      window_type: 'rolling',
      window_secs: 86400,
    });

    const res = await app.inject({
      method: 'PUT',
      url: '/auth/keys/me/spend-policies',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
      payload: {
        destination: 'kite/translator',
        max_usd: '50',
        window: 'rolling',
        window_secs: 86400,
      },
    });

    expect(res.statusCode).toBe(200);
    const [, input] = mockSet.mock.calls[0]!;
    expect(input.window_type).toBe('rolling');
    expect(input.window_secs).toBe(86400);
  });

  it('PUT invalid body (no destination) → 400 INVALID_INPUT, set not called', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());

    const res = await app.inject({
      method: 'PUT',
      url: '/auth/keys/me/spend-policies',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
      payload: { max_usd: '50', window_type: 'total' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('INVALID_INPUT');
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('AC-7: GET lists policies → 200 array, list(key_id, owner_ref)', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockList.mockResolvedValue([POLICY]);

    const res = await app.inject({
      method: 'GET',
      url: '/auth/keys/me/spend-policies',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([POLICY]);
    expect(mockList).toHaveBeenCalledWith('key-1', 'user-1');
  });

  it('AC-7: sub-session token authenticator → 403 SESSION_NOT_ALLOWED, set/list NOT called', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/auth/keys/me/spend-policies',
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
      payload: {
        destination: 'kite/translator',
        max_usd: '50',
        window_type: 'total',
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('SESSION_NOT_ALLOWED');
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockLookupByHash).not.toHaveBeenCalled();
  });
});
