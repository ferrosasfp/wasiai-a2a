/**
 * ERC-8004 identity route tests — WKH-100 (W3/W6).
 *
 * Covers AC-1/AC-2/AC-3/AC-4/AC-5/AC-7/AC-11/AC-12 + DT-14/DT-15/DT-16 + CD-3
 * + DT-5. Mocks the on-chain reader (`getErc8004Reader`), the identity service
 * and budget (to spy that NO budget RPC fires — AC-12). CI-deterministic.
 */
import crypto from 'node:crypto';
import type Fastify from 'fastify';
import FastifyFactory from 'fastify';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// ── Mocks ───────────────────────────────────────────────────

vi.mock('../adapters/erc8004-identity.js', () => ({
  getErc8004Reader: vi.fn(),
}));

vi.mock('../adapters/registry.js', () => ({
  getAdaptersBundle: vi.fn(),
  getInitializedChainKeys: vi.fn(() => []),
}));

vi.mock('../services/identity.js', () => ({
  identityService: {
    createKey: vi.fn(),
    lookupByHash: vi.fn(),
    deactivate: vi.fn(),
    bindFundingWallet: vi.fn(),
    bindErc8004Identity: vi.fn(),
    resolveIdentityForSlug: vi.fn(),
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

import { getErc8004Reader } from '../adapters/erc8004-identity.js';
import { budgetService } from '../services/budget.js';
import { identityService } from '../services/identity.js';
import { OwnershipMismatchError } from '../services/security/errors.js';
import type { A2AAgentKeyRow, Erc8004IdentityBinding } from '../types/index.js';
import authRoutes from './auth.js';

const mockGetReader = vi.mocked(getErc8004Reader);
const mockLookupByHash = vi.mocked(identityService.lookupByHash);
const mockBindErc8004 = vi.mocked(identityService.bindErc8004Identity);
const mockRegisterDeposit = vi.mocked(budgetService.registerDeposit);
const mockDebit = vi.mocked(budgetService.debit);

const mockVerifyOwnership = vi.fn();
const mockResolve = vi.fn();

// ── Fixtures ─────────────────────────────────────────────────

const FUNDING_WALLET = '0x1111111111111111111111111111111111111111';
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
    budget: { '84532': '10.000000' },
    daily_limit_usd: '100.000000',
    daily_spent_usd: '5.000000',
    daily_reset_at: '2026-04-07T00:00:00.000Z',
    allowed_registries: null,
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
    funding_wallet: FUNDING_WALLET,
    metadata: {},
    ...overrides,
  };
}

const AUTH_HEADERS = { 'x-a2a-key': TEST_KEY };

// ── Setup ────────────────────────────────────────────────────

describe('auth ERC-8004 routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    process.env.BASE_NETWORK = 'testnet'; // expectedChainId 84532
    app = FastifyFactory();
    await app.register(authRoutes, { prefix: '/auth' });
    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetReader.mockReturnValue({
      verifyOwnership: mockVerifyOwnership,
      resolve: mockResolve,
    });
  });

  // ── POST /auth/erc8004/bind ─────────────────────────────────

  describe('POST /auth/erc8004/bind', () => {
    it('AC-1: bind OK → 200 + erc8004_identity with exact shape; service called once', async () => {
      mockLookupByHash.mockResolvedValue(makeKeyRow());
      mockVerifyOwnership.mockResolvedValue({
        ok: true,
        owner: FUNDING_WALLET as `0x${string}`,
        matches: true,
        chainId: 84532,
      });
      mockResolve.mockResolvedValue({
        ok: true,
        tokenUri: 'https://cards.example/a.json',
        chainId: 84532,
      });
      mockBindErc8004.mockImplementation(async (_k, _o, binding) => binding);

      const res = await app.inject({
        method: 'POST',
        url: '/auth/erc8004/bind',
        headers: AUTH_HEADERS,
        payload: { token_id: '42', agent_slug: 'my-agent' },
      });

      expect(res.statusCode).toBe(200);
      const binding = res.json().erc8004_identity as Erc8004IdentityBinding;
      expect(binding.token_id).toBe('42');
      expect(binding.chain_id).toBe(84532);
      expect(binding.owner_address).toBe(FUNDING_WALLET.toLowerCase());
      expect(binding.agent_card_url).toBe('https://cards.example/a.json');
      expect(binding.agent_slug).toBe('my-agent');
      expect(new Date(binding.verified_at).toISOString()).toBe(
        binding.verified_at,
      );
      expect(mockBindErc8004).toHaveBeenCalledTimes(1);
    });

    it('AC-1: bind without agent_slug → binding omits agent_slug (DT-20)', async () => {
      mockLookupByHash.mockResolvedValue(makeKeyRow());
      mockVerifyOwnership.mockResolvedValue({
        ok: true,
        matches: true,
        chainId: 84532,
      });
      mockResolve.mockResolvedValue({ ok: true, tokenUri: '', chainId: 84532 });
      mockBindErc8004.mockImplementation(async (_k, _o, b) => b);

      const res = await app.inject({
        method: 'POST',
        url: '/auth/erc8004/bind',
        headers: AUTH_HEADERS,
        payload: { token_id: '7' },
      });

      expect(res.statusCode).toBe(200);
      const binding = res.json().erc8004_identity as Erc8004IdentityBinding;
      expect(binding.agent_slug).toBeUndefined();
    });

    it('AC-3: funding_wallet null → 400 FUNDING_WALLET_NOT_BOUND; reader NOT invoked', async () => {
      mockLookupByHash.mockResolvedValue(makeKeyRow({ funding_wallet: null }));

      const res = await app.inject({
        method: 'POST',
        url: '/auth/erc8004/bind',
        headers: AUTH_HEADERS,
        payload: { token_id: '1' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error_code).toBe('FUNDING_WALLET_NOT_BOUND');
      expect(mockVerifyOwnership).not.toHaveBeenCalled();
    });

    it('AC-4: ownerOf != funding_wallet → 403 IDENTITY_OWNERSHIP_MISMATCH; no write', async () => {
      mockLookupByHash.mockResolvedValue(makeKeyRow());
      mockVerifyOwnership.mockResolvedValue({
        ok: true,
        matches: false,
        chainId: 84532,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/auth/erc8004/bind',
        headers: AUTH_HEADERS,
        payload: { token_id: '1' },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error_code).toBe('IDENTITY_OWNERSHIP_MISMATCH');
      expect(mockBindErc8004).not.toHaveBeenCalled();
    });

    it('AC-5: same token_id+chain already bound → 409 ERC8004_ALREADY_BOUND; reader NOT invoked, no overwrite', async () => {
      mockLookupByHash.mockResolvedValue(
        makeKeyRow({
          erc8004_identity: {
            token_id: '42',
            chain_id: 84532,
            agent_card_url: 'https://x',
            owner_address: FUNDING_WALLET,
            verified_at: '2026-05-01T00:00:00.000Z',
          },
        }),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/auth/erc8004/bind',
        headers: AUTH_HEADERS,
        payload: { token_id: '42' },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error_code).toBe('ERC8004_ALREADY_BOUND');
      expect(mockVerifyOwnership).not.toHaveBeenCalled();
      expect(mockBindErc8004).not.toHaveBeenCalled();
    });

    it('AC-11: reader RPC_UNAVAILABLE → 503 { ok:false, reason:RPC_UNAVAILABLE }', async () => {
      mockLookupByHash.mockResolvedValue(makeKeyRow());
      mockVerifyOwnership.mockResolvedValue({
        ok: false,
        reason: 'RPC_UNAVAILABLE',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/auth/erc8004/bind',
        headers: AUTH_HEADERS,
        payload: { token_id: '1' },
      });

      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ ok: false, reason: 'RPC_UNAVAILABLE' });
    });

    it('CD-14: reader TOKEN_NOT_FOUND → 404 ERC8004_TOKEN_NOT_FOUND', async () => {
      mockLookupByHash.mockResolvedValue(makeKeyRow());
      mockVerifyOwnership.mockResolvedValue({
        ok: false,
        reason: 'TOKEN_NOT_FOUND',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/auth/erc8004/bind',
        headers: AUTH_HEADERS,
        payload: { token_id: '99999' },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error_code).toBe('ERC8004_TOKEN_NOT_FOUND');
    });

    it('CD-14: reader CHAIN_MISMATCH → 502 ERC8004_CHAIN_MISMATCH', async () => {
      mockLookupByHash.mockResolvedValue(makeKeyRow());
      mockVerifyOwnership.mockResolvedValue({
        ok: false,
        reason: 'CHAIN_MISMATCH',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/auth/erc8004/bind',
        headers: AUTH_HEADERS,
        payload: { token_id: '1' },
      });

      expect(res.statusCode).toBe(502);
      expect(res.json().error_code).toBe('ERC8004_CHAIN_MISMATCH');
    });

    it('AC-10: reader REGISTRY_NOT_CONFIGURED → 503 { reason:REGISTRY_NOT_CONFIGURED }', async () => {
      mockLookupByHash.mockResolvedValue(makeKeyRow());
      mockVerifyOwnership.mockResolvedValue({
        ok: false,
        reason: 'REGISTRY_NOT_CONFIGURED',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/auth/erc8004/bind',
        headers: AUTH_HEADERS,
        payload: { token_id: '1' },
      });

      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({
        ok: false,
        reason: 'REGISTRY_NOT_CONFIGURED',
      });
    });

    it('DT-14: token_id non-numeric → 400 INVALID_INPUT', async () => {
      mockLookupByHash.mockResolvedValue(makeKeyRow());
      const res = await app.inject({
        method: 'POST',
        url: '/auth/erc8004/bind',
        headers: AUTH_HEADERS,
        payload: { token_id: 'abc' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error_code).toBe('INVALID_INPUT');
    });

    it('DT-14: token_id negative → 400 INVALID_INPUT', async () => {
      mockLookupByHash.mockResolvedValue(makeKeyRow());
      const res = await app.inject({
        method: 'POST',
        url: '/auth/erc8004/bind',
        headers: AUTH_HEADERS,
        payload: { token_id: '-5' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('DT-14: token_id empty → 400 INVALID_INPUT', async () => {
      mockLookupByHash.mockResolvedValue(makeKeyRow());
      const res = await app.inject({
        method: 'POST',
        url: '/auth/erc8004/bind',
        headers: AUTH_HEADERS,
        payload: { token_id: '' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('DT-14: token_id > uint256 max → 400 INVALID_INPUT', async () => {
      mockLookupByHash.mockResolvedValue(makeKeyRow());
      const tooBig = (2n ** 256n).toString();
      const res = await app.inject({
        method: 'POST',
        url: '/auth/erc8004/bind',
        headers: AUTH_HEADERS,
        payload: { token_id: tooBig },
      });
      expect(res.statusCode).toBe(400);
    });

    it('DT-14: invalid agent_slug → 400 INVALID_INPUT', async () => {
      mockLookupByHash.mockResolvedValue(makeKeyRow());
      const res = await app.inject({
        method: 'POST',
        url: '/auth/erc8004/bind',
        headers: AUTH_HEADERS,
        payload: { token_id: '1', agent_slug: 'Bad Slug!' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error_code).toBe('INVALID_INPUT');
    });

    it('DT-15: ownerOf OK but resolve fails → bind with agent_card_url=""', async () => {
      mockLookupByHash.mockResolvedValue(makeKeyRow());
      mockVerifyOwnership.mockResolvedValue({
        ok: true,
        matches: true,
        chainId: 84532,
      });
      mockResolve.mockResolvedValue({ ok: false, reason: 'RPC_UNAVAILABLE' });
      mockBindErc8004.mockImplementation(async (_k, _o, b) => b);

      const res = await app.inject({
        method: 'POST',
        url: '/auth/erc8004/bind',
        headers: AUTH_HEADERS,
        payload: { token_id: '5' },
      });

      expect(res.statusCode).toBe(200);
      const binding = res.json().erc8004_identity as Erc8004IdentityBinding;
      expect(binding.agent_card_url).toBe('');
    });

    it('DT-5: ownerOf checksummed vs funding_wallet lowercase → matches=true → bind OK', async () => {
      mockLookupByHash.mockResolvedValue(makeKeyRow());
      // Reader returns matches=true (it already lowercased both — DT-5).
      mockVerifyOwnership.mockResolvedValue({
        ok: true,
        owner: '0x1111111111111111111111111111111111111111' as `0x${string}`,
        matches: true,
        chainId: 84532,
      });
      mockResolve.mockResolvedValue({ ok: true, tokenUri: '', chainId: 84532 });
      mockBindErc8004.mockImplementation(async (_k, _o, b) => b);

      const res = await app.inject({
        method: 'POST',
        url: '/auth/erc8004/bind',
        headers: AUTH_HEADERS,
        payload: { token_id: '1' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('CD-3: service throws OwnershipMismatchError → 403 OWNERSHIP_MISMATCH', async () => {
      mockLookupByHash.mockResolvedValue(makeKeyRow());
      mockVerifyOwnership.mockResolvedValue({
        ok: true,
        matches: true,
        chainId: 84532,
      });
      mockResolve.mockResolvedValue({ ok: true, tokenUri: '', chainId: 84532 });
      mockBindErc8004.mockRejectedValue(new OwnershipMismatchError());

      const res = await app.inject({
        method: 'POST',
        url: '/auth/erc8004/bind',
        headers: AUTH_HEADERS,
        payload: { token_id: '1' },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error_code).toBe('OWNERSHIP_MISMATCH');
    });

    it('auth: missing key → 403', async () => {
      mockLookupByHash.mockResolvedValue(null);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/erc8004/bind',
        payload: { token_id: '1' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('AC-12: successful bind NEVER calls budget (no debit / registerDeposit)', async () => {
      mockLookupByHash.mockResolvedValue(makeKeyRow());
      mockVerifyOwnership.mockResolvedValue({
        ok: true,
        matches: true,
        chainId: 84532,
      });
      mockResolve.mockResolvedValue({ ok: true, tokenUri: '', chainId: 84532 });
      mockBindErc8004.mockImplementation(async (_k, _o, b) => b);

      await app.inject({
        method: 'POST',
        url: '/auth/erc8004/bind',
        headers: AUTH_HEADERS,
        payload: { token_id: '1' },
      });

      expect(mockDebit).not.toHaveBeenCalled();
      expect(mockRegisterDeposit).not.toHaveBeenCalled();
    });
  });

  // ── AC-7: GET /me surfaces the binding ──────────────────────

  describe('GET /auth/me bindings (AC-7)', () => {
    it('AC-7: row with binding → bindings.erc8004_identity includes verified_at', async () => {
      const binding: Erc8004IdentityBinding = {
        token_id: '42',
        chain_id: 84532,
        agent_card_url: 'https://cards.example/a.json',
        owner_address: FUNDING_WALLET,
        verified_at: '2026-05-10T12:00:00.000Z',
        agent_slug: 'my-agent',
      };
      mockLookupByHash.mockResolvedValue(
        makeKeyRow({ erc8004_identity: binding }),
      );

      const res = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: AUTH_HEADERS,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().bindings.erc8004_identity).toEqual(binding);
    });

    it('AC-9: row with erc8004_identity=null → bindings.erc8004_identity null', async () => {
      mockLookupByHash.mockResolvedValue(
        makeKeyRow({ erc8004_identity: null }),
      );

      const res = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: AUTH_HEADERS,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().bindings.erc8004_identity).toBeNull();
    });
  });

  // ── GET /auth/erc8004/resolve/:token_id ─────────────────────

  describe('GET /auth/erc8004/resolve/:token_id', () => {
    it('AC-2: https tokenURI → 200 { url, raw:null }', async () => {
      mockResolve.mockResolvedValue({
        ok: true,
        tokenUri: 'https://cards.example/a.json',
        chainId: 84532,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/auth/erc8004/resolve/42',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.url).toBe('https://cards.example/a.json');
      expect(body.raw).toBeNull();
      expect(body.token_id).toBe('42');
      expect(body.chain_id).toBe(84532);
    });

    it('AC-2: ipfs tokenURI → 200 { scheme:"ipfs" }', async () => {
      mockResolve.mockResolvedValue({
        ok: true,
        tokenUri: 'ipfs://QmHash',
        chainId: 84532,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/auth/erc8004/resolve/42',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().scheme).toBe('ipfs');
      expect(res.json().agent_card_url).toBe('ipfs://QmHash');
    });

    it('DT-14: invalid token_id → 400 INVALID_INPUT', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/auth/erc8004/resolve/notanumber',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error_code).toBe('INVALID_INPUT');
    });

    it('AC-11: RPC_UNAVAILABLE → 503 { ok:false, reason:RPC_UNAVAILABLE }', async () => {
      mockResolve.mockResolvedValue({ ok: false, reason: 'RPC_UNAVAILABLE' });
      const res = await app.inject({
        method: 'GET',
        url: '/auth/erc8004/resolve/42',
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ ok: false, reason: 'RPC_UNAVAILABLE' });
    });

    it('CD-14: TOKEN_NOT_FOUND → 404 ERC8004_TOKEN_NOT_FOUND', async () => {
      mockResolve.mockResolvedValue({ ok: false, reason: 'TOKEN_NOT_FOUND' });
      const res = await app.inject({
        method: 'GET',
        url: '/auth/erc8004/resolve/99999',
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error_code).toBe('ERC8004_TOKEN_NOT_FOUND');
    });
  });
});
