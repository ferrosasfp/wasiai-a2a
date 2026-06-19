/**
 * Auth Key-Session Endpoint Tests — WKH-121 (server-side session keys)
 *
 * Cubre: AC-1 (POST happy 201 + token plano solo en respuesta), AC-2
 * (SCOPE_EXCEEDS_PARENT), AC-3 (TTL → INVALID_INPUT), AC-12 (sub-delegation 403
 * SESSION_NOT_ALLOWED), AC-13 (GET list con status derivado).
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

vi.mock('../services/delegation.js', () => ({
  delegationService: {
    verifyTypedData: vi.fn(),
    create: vi.fn(),
    lookupByTokenHash: vi.fn(),
    getParentKey: vi.fn(),
    list: vi.fn(),
    revoke: vi.fn(),
    debitDelegationAndParent: vi.fn(),
  },
  exceedsPerTxLimit: vi.fn(),
}));

// El handler importa keySessionService + las error classes ScopeExceedsParentError
// / InvalidKeySessionInputError. Mockeamos sólo el service y reusamos las clases
// REALES (instanceof debe coincidir en el catch del handler).
vi.mock('../services/key-session.js', async () => {
  const actual = await vi.importActual<
    typeof import('../services/key-session.js')
  >('../services/key-session.js');
  return {
    ...actual,
    keySessionService: {
      create: vi.fn(),
      lookupByTokenHash: vi.fn(),
      getParentKey: vi.fn(),
      list: vi.fn(),
      debitSessionAndParent: vi.fn(),
    },
  };
});

import { identityService } from '../services/identity.js';
import {
  InvalidKeySessionInputError,
  keySessionService,
  ScopeExceedsParentError,
} from '../services/key-session.js';
import authRoutes from './auth.js';

const mockLookupByHash = vi.mocked(identityService.lookupByHash);
const mockCreate = vi.mocked(keySessionService.create);
const mockList = vi.mocked(keySessionService.list);

const MASTER_KEY = `wasi_a2a_${'a'.repeat(64)}`;

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

function validBody() {
  return {
    ttl_seconds: 3600,
    max_budget_usd: '10.00',
  };
}

describe('auth key-session endpoints', () => {
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

  // ── POST /auth/key-session ──

  it('T-CREATE-1 (AC-1) creates session → 201 with session_token + scope (token only here)', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    const token = `wasi_a2a_sess_${'b'.repeat(96)}`;
    mockCreate.mockResolvedValue({
      session_id: 'sess-1',
      session_token: token,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      scope: {
        max_budget_usd: '10.00',
        allowed_registries: null,
        allowed_agent_slugs: null,
        allowed_categories: null,
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/key-session',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
      payload: validBody(),
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.session_id).toBe('sess-1');
    expect(body.session_token).toBe(token);
    expect(body.scope.max_budget_usd).toBe('10.00');
    // create recibió la parentKey autenticada (owner_ref de la key, no del body).
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'key-1', owner_ref: 'user-1' }),
      expect.objectContaining({ ttl_seconds: 3600, max_budget_usd: '10.00' }),
    );
  });

  it('T-SCOPE-1 (AC-2) SCOPE_EXCEEDS_PARENT from service → 400', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockCreate.mockRejectedValue(new ScopeExceedsParentError());

    const res = await app.inject({
      method: 'POST',
      url: '/auth/key-session',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
      payload: { ...validBody(), allowed_registries: ['evil'] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('SCOPE_EXCEEDS_PARENT');
  });

  it('T-TTL-1 (AC-3) ttl_seconds <= 0 → 400 INVALID_INPUT, 0 creates', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockCreate.mockRejectedValue(new InvalidKeySessionInputError());

    const res = await app.inject({
      method: 'POST',
      url: '/auth/key-session',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
      payload: { ttl_seconds: 0, max_budget_usd: '10.00' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('INVALID_INPUT');
  });

  it('T-TTL-1 (AC-3) ttl_seconds > SESSION_MAX_TTL_SECONDS → 400 INVALID_INPUT', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockCreate.mockRejectedValue(new InvalidKeySessionInputError());

    const res = await app.inject({
      method: 'POST',
      url: '/auth/key-session',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
      payload: { ttl_seconds: 999999, max_budget_usd: '10.00' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('INVALID_INPUT');
  });

  it('T-TTL-1 (AC-3) ttl_seconds non-integer → 400 INVALID_INPUT (shape, no create)', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());

    const res = await app.inject({
      method: 'POST',
      url: '/auth/key-session',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
      payload: { ttl_seconds: 1.5, max_budget_usd: '10.00' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('INVALID_INPUT');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('invalid input (missing max_budget_usd) → 400 INVALID_INPUT, 0 creates', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());

    const res = await app.inject({
      method: 'POST',
      url: '/auth/key-session',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
      payload: { ttl_seconds: 3600 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('INVALID_INPUT');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('T-SUBDELEG (AC-12) sess token authenticator → 403 SESSION_NOT_ALLOWED, 0 creates', async () => {
    const sessToken = `wasi_a2a_sess_${'c'.repeat(96)}`;
    const res = await app.inject({
      method: 'POST',
      url: '/auth/key-session',
      headers: { authorization: `Bearer ${sessToken}` },
      payload: validBody(),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('SESSION_NOT_ALLOWED');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockLookupByHash).not.toHaveBeenCalled();
  });

  it('POST without a valid master key → 403', async () => {
    mockLookupByHash.mockResolvedValue(null);
    const res = await app.inject({
      method: 'POST',
      url: '/auth/key-session',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
      payload: validBody(),
    });
    expect(res.statusCode).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // ── GET /auth/key-session ──

  it('T-LIST (AC-13) GET lists sessions with derived status + scope', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockList.mockResolvedValue([
      {
        session_id: 'sess-1',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        max_budget_usd: '10.00',
        spent: '1.00',
        status: 'active',
        scope: {
          allowed_registries: ['a'],
          allowed_agent_slugs: null,
          allowed_categories: null,
        },
      },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/auth/key-session',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Contrato BLOQUEANTE: array plano.
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].status).toBe('active');
    expect(body[0].scope.allowed_registries).toEqual(['a']);
    expect(mockList).toHaveBeenCalledWith('user-1');
  });

  it('GET without a valid key → 403', async () => {
    mockLookupByHash.mockResolvedValue(null);
    const res = await app.inject({
      method: 'GET',
      url: '/auth/key-session',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
