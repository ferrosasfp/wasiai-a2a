/**
 * Auth Key-Session Revoke Endpoint Tests — WKH-122
 *
 * Cubre: AC-1 (DELETE happy 200 + revoke(id, owner_ref)), AC-3 (404
 * SESSION_NOT_FOUND disclosure-safe), AC-4 (idempotente 200), AC-5
 * (sub-revocation 403 SESSION_NOT_ALLOWED, service NOT called).
 *
 * Patrón: Fastify in-process + mock de keySessionService (revoke) e
 * identityService.lookupByHash (auth de la master key).
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

vi.mock('../services/key-session.js', () => ({
  keySessionService: {
    create: vi.fn(),
    lookupByTokenHash: vi.fn(),
    getParentKey: vi.fn(),
    list: vi.fn(),
    revoke: vi.fn(),
    debitSessionAndParent: vi.fn(),
  },
  InvalidKeySessionInputError: class extends Error {},
  ScopeExceedsParentError: class extends Error {},
}));

import { identityService } from '../services/identity.js';
import { keySessionService } from '../services/key-session.js';
import { SessionNotFoundError } from '../services/security/errors.js';
import authRoutes from './auth.js';

const mockLookupByHash = vi.mocked(identityService.lookupByHash);
const mockRevoke = vi.mocked(keySessionService.revoke);

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
    ...overrides,
  };
}

describe('auth key-session revoke endpoint', () => {
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

  it('T-REVOKE-OK (AC-1/AC-7) DELETE revokes → 200 { revoked: true }, revoke(id, owner_ref)', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockRevoke.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'DELETE',
      url: '/auth/key-session/sess-1',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ revoked: true });
    expect(mockRevoke).toHaveBeenCalledWith('sess-1', 'user-1');
  });

  it('T-NOTFOUND-ROUTE (AC-3) service throws SessionNotFoundError → 404 SESSION_NOT_FOUND', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockRevoke.mockRejectedValue(new SessionNotFoundError());

    const res = await app.inject({
      method: 'DELETE',
      url: '/auth/key-session/sess-999',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error_code).toBe('SESSION_NOT_FOUND');
  });

  it('T-IDEMPOTENT-ROUTE (AC-4) already-revoked session of caller → 200 { revoked: true }', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    // Idempotente: el service resuelve void igual que en la 1ª revocación.
    mockRevoke.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'DELETE',
      url: '/auth/key-session/sess-1',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ revoked: true });
    expect(mockRevoke).toHaveBeenCalledWith('sess-1', 'user-1');
  });

  it('T-SUBSESSION (AC-5) session token authenticator → 403 SESSION_NOT_ALLOWED, revoke NOT called', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/auth/key-session/sess-1',
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('SESSION_NOT_ALLOWED');
    // El gate corta antes de auth + service.
    expect(mockRevoke).not.toHaveBeenCalled();
    expect(mockLookupByHash).not.toHaveBeenCalled();
  });
});
