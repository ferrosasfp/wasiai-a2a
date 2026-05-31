/**
 * ERC-8004 identity-unified bridge — e2e (WKH-100, W7).
 *
 * Proves the bind → discover/agent-card bridge end-to-end (AC-8) + backward-compat
 * (AC-9). The REAL identity / discovery / agent-card services and the REAL
 * /auth + /agents + /discover routes run. We mock ONLY the boundaries:
 *   - supabase (stateful: bind UPDATE writes the JSONB, the resolver SELECT reads it)
 *   - the on-chain reader (ownerOf == funding_wallet, tokenURI = a URL)
 *   - registryService (so discover/getAgent return an Agent with the bound slug)
 *   - the SSRF url-validator + global fetch (so getAgent can "fetch" the agent)
 * CI-deterministic — no real network, no real DB.
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
import type { Erc8004IdentityBinding, RegistryConfig } from '../types/index.js';

// ── Stateful supabase mock ───────────────────────────────────
// One row keyed by funding_wallet/owner. bindErc8004Identity does
// `.update({ erc8004_identity }).eq('id').eq('owner_ref').select('id')`.
// resolveIdentityForSlug does `.select('erc8004_identity').not(...).eq('is_active', true)`.
let _storedBinding: Erc8004IdentityBinding | null = null;

vi.mock('../lib/supabase.js', () => {
  function makeBuilder() {
    let pendingUpdate: { erc8004_identity?: Erc8004IdentityBinding } | null =
      null;
    let isSelectIdentity = false;
    const builder: Record<string, unknown> = {
      update(payload: { erc8004_identity?: Erc8004IdentityBinding }) {
        pendingUpdate = payload;
        return builder;
      },
      select(cols: string) {
        if (cols === 'erc8004_identity') isSelectIdentity = true;
        return builder;
      },
      not() {
        return builder;
      },
      eq() {
        return builder;
      },
      // biome-ignore lint/suspicious/noThenProperty: mock mirrors PostgREST thenable
      then(resolve: (v: { data: unknown; error: unknown }) => void) {
        if (pendingUpdate?.erc8004_identity) {
          _storedBinding = pendingUpdate.erc8004_identity;
          resolve({ data: [{ id: 'key-1' }], error: null });
          return;
        }
        if (isSelectIdentity) {
          resolve({
            data: _storedBinding ? [{ erc8004_identity: _storedBinding }] : [],
            error: null,
          });
          return;
        }
        resolve({ data: null, error: null });
      },
    };
    return builder;
  }
  return { supabase: { from: vi.fn(() => makeBuilder()) } };
});

// ── Reader mock (on-chain ownerOf/tokenURI) ──────────────────
const mockVerifyOwnership = vi.fn();
const mockResolve = vi.fn();
vi.mock('../adapters/erc8004-identity.js', () => ({
  getErc8004Reader: () => ({
    verifyOwnership: mockVerifyOwnership,
    resolve: mockResolve,
  }),
}));

// ── registryService mock (discover + agent-card route) ───────
vi.mock('../services/registry.js', () => ({
  registryService: {
    getEnabled: vi.fn(),
    get: vi.fn(),
  },
}));

// ── circuit breaker (discover) ───────────────────────────────
vi.mock('../lib/circuit-breaker.js', () => ({
  getRegistryCircuitBreaker: () => ({
    execute: (fn: () => Promise<Response>) => fn(),
  }),
}));

// ── SSRF validator (let everything through in the test) ──────
vi.mock('../lib/url-validator.js', () => ({
  validateRegistryUrl: vi.fn().mockResolvedValue(undefined),
  SSRFViolationError: class SSRFViolationError extends Error {},
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import agentCardRoutes from '../routes/agent-card.js';
import authRoutes from '../routes/auth.js';
import discoverRoutes from '../routes/discover.js';
import { registryService } from '../services/registry.js';

// ── Fixtures ─────────────────────────────────────────────────
const FUNDING_WALLET = '0x1111111111111111111111111111111111111111';
const TEST_KEY = `wasi_a2a_${'b'.repeat(64)}`;
const TEST_KEY_HASH = crypto
  .createHash('sha256')
  .update(TEST_KEY)
  .digest('hex');
const BOUND_SLUG = 'foo';
const CARD_URL = 'https://cards.example/foo.json';

function makeRegistry(o: Partial<RegistryConfig> = {}): RegistryConfig {
  return {
    id: 'reg-1',
    name: 'test-registry',
    discoveryEndpoint: 'https://example.com/agents',
    invokeEndpoint: 'https://example.com/invoke/{slug}',
    agentEndpoint: 'https://example.com/agent/{slug}',
    schema: { discovery: {}, invoke: { method: 'POST' } },
    enabled: true,
    createdAt: new Date(),
    ownerRef: 'system',
    ...o,
  } as RegistryConfig;
}

function rawAgent(slug: string) {
  return {
    id: slug,
    slug,
    name: `Agent ${slug}`,
    description: 'bridge test agent',
    capabilities: ['test'],
    price: 0,
    status: 'active',
  };
}

// ── App: real auth lookup via real identity service. We stub the
// supabase lookupByHash chain by mocking identityService.lookupByHash
// directly on the real module so the caller key resolves. ──────
import { identityService } from '../services/identity.js';

describe('ERC-8004 identity-unified bridge (e2e)', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    process.env.BASE_NETWORK = 'testnet';
    app = FastifyFactory({ logger: false });
    await app.register(authRoutes, { prefix: '/auth' });
    await app.register(agentCardRoutes, { prefix: '/agents' });
    await app.register(discoverRoutes, { prefix: '/discover' });
    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    _storedBinding = null;
    mockFetch.mockReset();
    mockVerifyOwnership.mockReset();
    mockResolve.mockReset();
    vi.mocked(registryService.getEnabled).mockResolvedValue([makeRegistry()]);
    // Real identity.lookupByHash hits the mocked supabase (.eq.single → null),
    // so spy it to return the caller key row.
    vi.spyOn(identityService, 'lookupByHash').mockResolvedValue({
      id: 'key-1',
      owner_ref: 'user-1',
      key_hash: TEST_KEY_HASH,
      display_name: null,
      budget: {},
      daily_limit_usd: null,
      daily_spent_usd: '0',
      daily_reset_at: '2026-01-01T00:00:00.000Z',
      allowed_registries: null,
      allowed_agent_slugs: null,
      allowed_categories: null,
      max_spend_per_call_usd: null,
      is_active: true,
      last_used_at: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      erc8004_identity: null,
      kite_passport: null,
      agentkit_wallet: null,
      funding_wallet: FUNDING_WALLET,
      metadata: {},
    });
  });

  it('1. POST /auth/erc8004/bind with agent_slug → 200 + persists binding', async () => {
    mockVerifyOwnership.mockResolvedValue({
      ok: true,
      owner: FUNDING_WALLET as `0x${string}`,
      matches: true,
      chainId: 84532,
    });
    mockResolve.mockResolvedValue({
      ok: true,
      tokenUri: CARD_URL,
      chainId: 84532,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/erc8004/bind',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: { token_id: '42', agent_slug: BOUND_SLUG },
    });

    expect(res.statusCode).toBe(200);
    expect(_storedBinding?.agent_slug).toBe(BOUND_SLUG);
    expect(_storedBinding?.token_id).toBe('42');
    expect(_storedBinding?.chain_id).toBe(84532);
  });

  it('2. GET /agents/foo/agent-card → identity surfaced (verified:true)', async () => {
    _storedBinding = {
      token_id: '42',
      chain_id: 84532,
      agent_card_url: CARD_URL,
      owner_address: FUNDING_WALLET,
      verified_at: '2026-05-10T00:00:00.000Z',
      agent_slug: BOUND_SLUG,
    };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(rawAgent(BOUND_SLUG)),
    });

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${BOUND_SLUG}/agent-card`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().identity).toEqual({
      erc8004_token_id: '42',
      chain_id: 84532,
      verified: true,
    });
  });

  it('3. GET /discover and POST /discover → bound agent carries identity', async () => {
    _storedBinding = {
      token_id: '42',
      chain_id: 84532,
      agent_card_url: CARD_URL,
      owner_address: FUNDING_WALLET,
      verified_at: '2026-05-10T00:00:00.000Z',
      agent_slug: BOUND_SLUG,
    };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([rawAgent(BOUND_SLUG)]),
    });

    const getRes = await app.inject({ method: 'GET', url: '/discover' });
    expect(getRes.statusCode).toBe(200);
    const getAgent = getRes
      .json()
      .agents.find((a: { slug: string }) => a.slug === BOUND_SLUG);
    expect(getAgent.identity).toEqual({
      erc8004_token_id: '42',
      chain_id: 84532,
      verified: true,
    });

    const postRes = await app.inject({
      method: 'POST',
      url: '/discover',
      payload: {},
    });
    expect(postRes.statusCode).toBe(200);
    const postAgent = postRes
      .json()
      .agents.find((a: { slug: string }) => a.slug === BOUND_SLUG);
    expect(postAgent.identity.verified).toBe(true);
  });

  it('4. AC-9 backward-compat: agent without bound identity → identity ABSENT', async () => {
    _storedBinding = null; // no identity bound
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([rawAgent('bar')]),
    });

    const res = await app.inject({ method: 'GET', url: '/discover' });
    expect(res.statusCode).toBe(200);
    const agent = res
      .json()
      .agents.find((a: { slug: string }) => a.slug === 'bar');
    expect(agent.identity).toBeUndefined();
    expect('identity' in agent).toBe(false);
  });
});
