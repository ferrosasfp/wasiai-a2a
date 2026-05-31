/**
 * Auth Delegation Endpoint Tests — WKH-101 (Fase 2)
 *
 * Cubre: AC-1 (POST happy 201), AC-2 (FUNDING_WALLET_NOT_BOUND), AC-10 (DELETE
 * revoke + OWNERSHIP_MISMATCH), AC-11 (GET list), AC-15/CD-9 (sub-delegation 403).
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

import { delegationService } from '../services/delegation.js';
import { identityService } from '../services/identity.js';
import {
  DelegationNonceReplayError,
  DelegationSignerMismatchError,
  OwnershipMismatchError,
} from '../services/security/errors.js';
import authRoutes from './auth.js';

const mockLookupByHash = vi.mocked(identityService.lookupByHash);
const mockCreate = vi.mocked(delegationService.create);
const mockRevoke = vi.mocked(delegationService.revoke);
const mockList = vi.mocked(delegationService.list);

const MASTER_KEY = `wasi_a2a_${'a'.repeat(64)}`;
const SESSION_KEY_ADDR = '0xdef0000000000000000000000000000000000002';
const FUNDING_WALLET = '0xabc0000000000000000000000000000000000001';

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
    funding_wallet: FUNDING_WALLET,
    metadata: {},
    ...overrides,
  };
}

function validBody() {
  const policy = {
    max_amount_per_tx: '0.50',
    max_total_amount: '100.00',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    allowed_chains: [] as number[],
    allowed_agent_slugs: [] as string[],
    allowed_registries: [] as string[],
  };
  return {
    signature: `0x${'11'.repeat(65)}`,
    session_key_address: SESSION_KEY_ADDR,
    policy,
    typed_data: {
      domain: { name: 'WasiAI-a2a Delegation', version: '1', chainId: 2368 },
      types: {
        Delegation: [{ name: 'session_key', type: 'address' }],
      },
      primaryType: 'Delegation',
      message: {
        session_key: SESSION_KEY_ADDR,
        policy,
        nonce: `0x${'00'.repeat(32)}`,
      },
    },
  };
}

describe('auth delegation endpoints', () => {
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

  // ── POST /auth/delegation ──

  it('T1 (AC-1) creates delegation → 201 with session_token + policy', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockCreate.mockResolvedValue({
      delegation_id: 'del-1',
      session_token: `wasi_a2a_session_${'b'.repeat(96)}`,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      policy: validBody().policy,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/delegation',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
      payload: validBody(),
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.delegation_id).toBe('del-1');
    expect(body.session_token).toMatch(/^wasi_a2a_session_/);
  });

  it('T2 (AC-2) funding_wallet null → 403 FUNDING_WALLET_NOT_BOUND, 0 creates', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow({ funding_wallet: null }));

    const res = await app.inject({
      method: 'POST',
      url: '/auth/delegation',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
      payload: validBody(),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('FUNDING_WALLET_NOT_BOUND');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('T3 (AC-3) signer mismatch from service → 403 DELEGATION_SIGNER_MISMATCH', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockCreate.mockRejectedValue(new DelegationSignerMismatchError());

    const res = await app.inject({
      method: 'POST',
      url: '/auth/delegation',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
      payload: validBody(),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('DELEGATION_SIGNER_MISMATCH');
  });

  it('T4 (AC-4) nonce replay from service → 409 DELEGATION_NONCE_REPLAY', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockCreate.mockRejectedValue(new DelegationNonceReplayError());

    const res = await app.inject({
      method: 'POST',
      url: '/auth/delegation',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
      payload: validBody(),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error_code).toBe('DELEGATION_NONCE_REPLAY');
  });

  it('T16 (AC-15/CD-9) session token authenticator → 403 DELEGATION_NOT_ALLOWED, 0 creates', async () => {
    const sessionToken = `wasi_a2a_session_${'c'.repeat(96)}`;
    const res = await app.inject({
      method: 'POST',
      url: '/auth/delegation',
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: validBody(),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('DELEGATION_NOT_ALLOWED');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockLookupByHash).not.toHaveBeenCalled();
  });

  it('invalid input (bad policy) → 400 INVALID_INPUT', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    const bad = validBody();
    // @ts-expect-error intentionally invalid policy shape
    bad.policy.max_amount_per_tx = 123;

    const res = await app.inject({
      method: 'POST',
      url: '/auth/delegation',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
      payload: bad,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('INVALID_INPUT');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // ── DELETE /auth/delegation/:id ──

  it('T11 (AC-10) DELETE revokes → 200 { revoked: true }', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockRevoke.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'DELETE',
      url: '/auth/delegation/del-1',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ revoked: true });
    expect(mockRevoke).toHaveBeenCalledWith('del-1', 'user-1');
  });

  it('T13 (AC-12) DELETE on foreign delegation → 403 OWNERSHIP_MISMATCH', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockRevoke.mockRejectedValue(new OwnershipMismatchError());

    const res = await app.inject({
      method: 'DELETE',
      url: '/auth/delegation/del-999',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('OWNERSHIP_MISMATCH');
  });

  // ── GET /auth/delegation ──

  it('T12 (AC-11) GET lists caller delegations with status', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockList.mockResolvedValue([
      {
        delegation_id: 'del-1',
        session_key_address: SESSION_KEY_ADDR,
        policy: validBody().policy,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        total_spent: '1.00',
        revoked_at: null,
        status: 'active',
      },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/auth/delegation',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().delegations).toHaveLength(1);
    expect(res.json().delegations[0].status).toBe('active');
    expect(mockList).toHaveBeenCalledWith('user-1');
  });

  it('GET without a valid key → 403', async () => {
    mockLookupByHash.mockResolvedValue(null);
    const res = await app.inject({
      method: 'GET',
      url: '/auth/delegation',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
