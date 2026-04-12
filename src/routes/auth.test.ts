/**
 * Auth Routes Integration Tests — WKH-34
 * Tests: AC-13 (agent-signup), AC-14 (deposit), AC-15 (me), AC-16 (bind)
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
import type { A2AAgentKeyRow } from '../types/index.js';
import authRoutes from './auth.js';

// ── Mock services ───────────────────────────────────────────

vi.mock('../services/identity.js', () => ({
  identityService: {
    createKey: vi.fn(),
    lookupByHash: vi.fn(),
    deactivate: vi.fn(),
  },
}));

vi.mock('../services/budget.js', () => ({
  budgetService: {
    getBalance: vi.fn(),
    debit: vi.fn(),
    registerDeposit: vi.fn(),
  },
}));

import { identityService } from '../services/identity.js';

const mockCreateKey = vi.mocked(identityService.createKey);
const mockLookupByHash = vi.mocked(identityService.lookupByHash);

// ── Helpers ─────────────────────────────────────────────────

const TEST_KEY = `wasi_a2a_${'a'.repeat(64)}`;
const TEST_KEY_HASH = crypto
  .createHash('sha256')
  .update(TEST_KEY)
  .digest('hex');
const TEST_KEY_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeKeyRow(overrides: Partial<A2AAgentKeyRow> = {}): A2AAgentKeyRow {
  return {
    id: TEST_KEY_ID,
    owner_ref: 'user-1',
    key_hash: TEST_KEY_HASH,
    display_name: 'Test Key',
    budget: { '2368': '10.000000' },
    daily_limit_usd: '100.000000',
    daily_spent_usd: '5.000000',
    daily_reset_at: '2026-04-07T00:00:00.000Z',
    allowed_registries: ['kite'],
    allowed_agent_slugs: null,
    allowed_categories: null,
    max_spend_per_call_usd: '10.000000',
    is_active: true,
    last_used_at: null,
    created_at: '2026-04-06T12:00:00.000Z',
    updated_at: '2026-04-06T12:00:00.000Z',
    erc8004_identity: null,
    kite_passport: null,
    agentkit_wallet: null,
    metadata: {},
    ...overrides,
  };
}

// ── Setup ───────────────────────────────────────────────────

describe('auth routes', () => {
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

  // ── POST /auth/agent-signup (AC-13) ───────────────────────

  it('POST /auth/agent-signup with valid body returns 201 + key + key_id', async () => {
    mockCreateKey.mockResolvedValue({
      key: TEST_KEY,
      key_id: TEST_KEY_ID,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/agent-signup',
      payload: { owner_ref: 'user-1', display_name: 'My Agent' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.key).toBe(TEST_KEY);
    expect(body.key_id).toBe(TEST_KEY_ID);
  });

  it('POST /auth/agent-signup missing owner_ref returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/agent-signup',
      payload: { display_name: 'No Owner' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('owner_ref');
  });

  it('POST /auth/agent-signup empty owner_ref returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/agent-signup',
      payload: { owner_ref: '  ' },
    });

    expect(res.statusCode).toBe(400);
  });

  // ── POST /auth/deposit (AC-14, BLQ-5: disabled until on-chain verification) ──

  it('POST /auth/deposit returns 501 — disabled until on-chain verification (BLQ-5)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/deposit',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {
        key_id: TEST_KEY_ID,
        chain_id: 2368,
        token: 'PYUSD',
        amount: '10.00',
        tx_hash: '0xabc123',
      },
    });

    expect(res.statusCode).toBe(501);
    const body = res.json();
    expect(body.error).toBe('deposit_verification_pending');
    expect(body.message).toContain('PaymentAdapter.verify()');
  });

  // ── GET /auth/me (AC-15) ──────────────────────────────────

  it('GET /auth/me with valid key returns 200 + full status object', async () => {
    const keyRow = makeKeyRow();
    mockLookupByHash.mockResolvedValue(keyRow);

    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { 'x-a2a-key': TEST_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.key_id).toBe(TEST_KEY_ID);
    expect(body.display_name).toBe('Test Key');
    expect(body.budget).toEqual({ '2368': '10.000000' });
    expect(body.daily_limit_usd).toBe('100.000000');
    expect(body.daily_spent_usd).toBe('5.000000');
    expect(body.scoping.allowed_registries).toEqual(['kite']);
    expect(body.scoping.max_spend_per_call_usd).toBe('10.000000');
    expect(body.is_active).toBe(true);
    expect(body.bindings).toEqual({
      erc8004_identity: null,
      kite_passport: null,
      agentkit_wallet: null,
    });
    expect(body.created_at).toBe('2026-04-06T12:00:00.000Z');
  });

  it('GET /auth/me with invalid key returns 403', async () => {
    mockLookupByHash.mockResolvedValue(null);

    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { 'x-a2a-key': 'wasi_a2a_bad' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('GET /auth/me with inactive key returns 403', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow({ is_active: false }));

    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { 'x-a2a-key': TEST_KEY },
    });

    expect(res.statusCode).toBe(403);
  });

  // ── GET /auth/me with Bearer auth (WKH-BEARER-FIX AC-4, AC-5) ──

  it('GET /auth/me with Authorization: Bearer wasi_a2a_* returns 200 (AC-4)', async () => {
    const keyRow = makeKeyRow();
    mockLookupByHash.mockResolvedValue(keyRow);

    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.key_id).toBe(TEST_KEY_ID);
  });

  it('GET /auth/me with Authorization: Bearer non_wasi_token returns 403 (AC-5)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: 'Bearer non_wasi_token_abc123' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('GET /auth/me with both x-a2a-key and Bearer prefers x-a2a-key (AC-2)', async () => {
    const keyRow = makeKeyRow();
    mockLookupByHash.mockResolvedValue(keyRow);

    const otherKey = `wasi_a2a_${'b'.repeat(64)}`;

    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: {
        'x-a2a-key': TEST_KEY,
        authorization: `Bearer ${otherKey}`,
      },
    });

    expect(res.statusCode).toBe(200);
    // Verify lookupByHash was called with the hash of TEST_KEY (x-a2a-key), not otherKey
    expect(mockLookupByHash).toHaveBeenCalledWith(TEST_KEY_HASH);
  });

  // ── POST /auth/bind/:chain (AC-16) ────────────────────────

  it('POST /auth/bind/:chain returns 501 with not_implemented', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/bind/kite',
    });

    expect(res.statusCode).toBe(501);
    const body = res.json();
    expect(body.status).toBe('not_implemented');
    expect(body.message).toContain('Fase 2');
  });
});
