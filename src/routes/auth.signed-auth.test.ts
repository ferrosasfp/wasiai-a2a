/**
 * Auth Signed-Auth Endpoint Tests — WKH-123
 *
 * Cubre:
 *  - AC-10: PATCH /agent-key/:id/require-signature (owner≠ → 403; require_signature
 *    true sin funding_wallet → 400 FUNDING_WALLET_NOT_BOUND), PATCH
 *    /key-session/:id/require-signature (owner≠/unknown → 404 SESSION_NOT_FOUND;
 *    require_signature true sin signing_secret_hash → 400 SIGNING_SECRET_NOT_SET).
 *  - AC-11: POST /key-session require_signature:true → 201 con signing_secret una
 *    vez; GET list NO lo expone.
 *
 * Patrón: Fastify in-process + mock de identityService/keySessionService.
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
    setRequireSignature: vi.fn(),
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
    setRequireSignature: vi.fn(),
  },
  InvalidKeySessionInputError: class extends Error {},
  ScopeExceedsParentError: class extends Error {},
}));

import { identityService } from '../services/identity.js';
import { keySessionService } from '../services/key-session.js';
import {
  OwnershipMismatchError,
  SessionNotFoundError,
  SigningSecretNotSetError,
} from '../services/security/errors.js';
import authRoutes from './auth.js';

const mockLookupByHash = vi.mocked(identityService.lookupByHash);
const mockSetReqSig = vi.mocked(identityService.setRequireSignature);
const mockSessionCreate = vi.mocked(keySessionService.create);
const mockSessionList = vi.mocked(keySessionService.list);
const mockSessionSetReqSig = vi.mocked(keySessionService.setRequireSignature);

const MASTER_KEY = `wasi_a2a_${'a'.repeat(64)}`;
const SESSION_TOKEN = `wasi_a2a_sess_${'b'.repeat(96)}`;
const FUNDING_WALLET = '0x1111111111111111111111111111111111111111';

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

describe('auth signed-auth endpoints (WKH-123)', () => {
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

  // ── PATCH /agent-key/:id/require-signature (AC-10 / AC-9) ──

  it('AC-10 master: enable with bound funding_wallet → 200 { ok, require_signature }', async () => {
    mockLookupByHash.mockResolvedValue(
      makeKeyRow({ funding_wallet: FUNDING_WALLET }),
    );
    mockSetReqSig.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'PATCH',
      url: '/auth/agent-key/key-1/require-signature',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
      payload: { require_signature: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, require_signature: true });
    expect(mockSetReqSig).toHaveBeenCalledWith('key-1', 'user-1', true);
  });

  it('AC-9 master: enable without funding_wallet → 400 FUNDING_WALLET_NOT_BOUND, service NOT called', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow({ funding_wallet: null }));

    const res = await app.inject({
      method: 'PATCH',
      url: '/auth/agent-key/key-1/require-signature',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
      payload: { require_signature: true },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('FUNDING_WALLET_NOT_BOUND');
    expect(mockSetReqSig).not.toHaveBeenCalled();
  });

  it('AC-10 master: :id != callerKey.id → 403 OWNERSHIP_MISMATCH, service NOT called', async () => {
    mockLookupByHash.mockResolvedValue(
      makeKeyRow({ id: 'key-1', funding_wallet: FUNDING_WALLET }),
    );

    const res = await app.inject({
      method: 'PATCH',
      url: '/auth/agent-key/other-key/require-signature',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
      payload: { require_signature: true },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('OWNERSHIP_MISMATCH');
    expect(mockSetReqSig).not.toHaveBeenCalled();
  });

  it('AC-10 master: service OwnershipMismatchError → 403 OWNERSHIP_MISMATCH', async () => {
    mockLookupByHash.mockResolvedValue(
      makeKeyRow({ funding_wallet: FUNDING_WALLET }),
    );
    mockSetReqSig.mockRejectedValue(new OwnershipMismatchError());

    const res = await app.inject({
      method: 'PATCH',
      url: '/auth/agent-key/key-1/require-signature',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
      payload: { require_signature: true },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('OWNERSHIP_MISMATCH');
  });

  it('master: non-boolean body → 400 INVALID_INPUT', async () => {
    mockLookupByHash.mockResolvedValue(
      makeKeyRow({ funding_wallet: FUNDING_WALLET }),
    );

    const res = await app.inject({
      method: 'PATCH',
      url: '/auth/agent-key/key-1/require-signature',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
      payload: { require_signature: 'yes' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('INVALID_INPUT');
    expect(mockSetReqSig).not.toHaveBeenCalled();
  });

  it('master: session token authenticator → 403 (sub-session forbidden)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/auth/agent-key/key-1/require-signature',
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
      payload: { require_signature: true },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('OWNERSHIP_MISMATCH');
    expect(mockSetReqSig).not.toHaveBeenCalled();
  });

  // ── PATCH /key-session/:id/require-signature (AC-10) ──────

  it('AC-10 session: enable → 200, service called with (id, owner_ref, value)', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockSessionSetReqSig.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'PATCH',
      url: '/auth/key-session/sess-1/require-signature',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
      payload: { require_signature: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, require_signature: true });
    expect(mockSessionSetReqSig).toHaveBeenCalledWith('sess-1', 'user-1', true);
  });

  it('AC-10 session: owner≠/unknown → 404 SESSION_NOT_FOUND (disclosure-safe)', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockSessionSetReqSig.mockRejectedValue(new SessionNotFoundError());

    const res = await app.inject({
      method: 'PATCH',
      url: '/auth/key-session/sess-x/require-signature',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
      payload: { require_signature: true },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error_code).toBe('SESSION_NOT_FOUND');
  });

  it('AC-10 session: enable without signing_secret_hash → 400 SIGNING_SECRET_NOT_SET', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockSessionSetReqSig.mockRejectedValue(new SigningSecretNotSetError());

    const res = await app.inject({
      method: 'PATCH',
      url: '/auth/key-session/sess-1/require-signature',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
      payload: { require_signature: true },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('SIGNING_SECRET_NOT_SET');
  });

  it('session: non-boolean body → 400 INVALID_INPUT', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());

    const res = await app.inject({
      method: 'PATCH',
      url: '/auth/key-session/sess-1/require-signature',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('INVALID_INPUT');
    expect(mockSessionSetReqSig).not.toHaveBeenCalled();
  });

  // ── POST /key-session require_signature (AC-11) ───────────

  it('AC-11: POST key-session require_signature:true → 201 with signing_secret once', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockSessionCreate.mockResolvedValue({
      session_id: 'sess-1',
      session_token: `${SESSION_TOKEN}`,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      scope: {
        max_budget_usd: '10.00',
        allowed_registries: null,
        allowed_agent_slugs: null,
        allowed_categories: null,
      },
      signing_secret: 'c'.repeat(64),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/key-session',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
      payload: {
        ttl_seconds: 3600,
        max_budget_usd: '10.00',
        require_signature: true,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.signing_secret).toBe('c'.repeat(64));
    // El input require_signature llega al service.
    expect(mockSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'key-1' }),
      expect.objectContaining({ require_signature: true }),
    );
  });

  it('AC-11: POST key-session require_signature non-boolean → 400 INVALID_INPUT', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());

    const res = await app.inject({
      method: 'POST',
      url: '/auth/key-session',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
      payload: {
        ttl_seconds: 3600,
        max_budget_usd: '10.00',
        require_signature: 'yes',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('INVALID_INPUT');
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it('AC-11: GET key-session list NEVER exposes signing_secret', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockSessionList.mockResolvedValue([
      {
        session_id: 'sess-1',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        max_budget_usd: '10.00',
        spent: '0',
        status: 'active',
        scope: {
          allowed_registries: null,
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
    expect(JSON.stringify(res.json())).not.toContain('signing_secret');
  });
});
