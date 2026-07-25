/**
 * Agents Routes — Publish flow tests (WKH-134).
 *
 * Cubre AC-1/AC-3/AC-4/AC-5/AC-6 + CD-1/CD-2/CD-5/CD-10.
 *
 * Auth strategy: mock `requirePaymentOrA2AKey` para inyectar `request.a2aKeyRow`
 * (o simular el path sin key). SSRF: real `validateRegistryUrl` con `node:dns`
 * mockeado (mismo patrón que registries.ssrf.test.ts). El service se mockea por
 * método para las route-tests; T-PUB-06 usa el service REAL (vi.importActual)
 * con supabase mockeado para verificar la defense-in-depth.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// ── Hoisted spies (referenciados por los mock factories) ───────────
const { mockLookup, mockInsert } = vi.hoisted(() => ({
  mockLookup: vi.fn(),
  mockInsert: vi.fn(),
}));

vi.mock('node:dns', () => ({
  promises: { lookup: (...args: unknown[]) => mockLookup(...args) },
}));

// supabase mock — solo lo usa el service REAL en T-PUB-06.
vi.mock('../lib/supabase.js', () => {
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    select: () => builder,
    eq: () => builder,
    order: () => Promise.resolve({ data: [], error: null }),
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    insert: (...args: unknown[]) => {
      mockInsert(...args);
      return builder;
    },
    single: () => Promise.resolve({ data: {}, error: null }),
    update: () => builder,
    delete: () => builder,
  });
  return { supabase: { from: () => builder } };
});

// service mock (por método) para las route-tests.
vi.mock('../services/agent.js', async () => {
  const actual = await vi.importActual<typeof import('../services/agent.js')>(
    '../services/agent.js',
  );
  return {
    ...actual,
    publishedAgentService: {
      publish: vi.fn(),
      listAsAgents: vi.fn(),
      getBySlugAsAgent: vi.fn(),
      listMine: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      getRow: vi.fn(),
    },
  };
});

// auth middleware — inyecta a2aKeyRow (o simula ausencia con currentOwner=null).
let currentOwner: string | null = 'tenant-A';
vi.mock('../middleware/a2a-key.js', () => ({
  requireA2AKey: () => [
    async (request: { a2aKeyRow?: { id: string; owner_ref: string } }) => {
      if (currentOwner === null) return;
      request.a2aKeyRow = { id: 'fake-key-id', owner_ref: currentOwner };
    },
  ],
}));

import { publishedAgentService } from '../services/agent.js';
import agentsRoutes from './agents.js';

const mockPublish = vi.mocked(publishedAgentService.publish);
const mockUpdate = vi.mocked(publishedAgentService.update);

const PUBLIC_IP = [{ address: '93.184.216.34', family: 4 }];

const RECORD_RESPONSE = {
  slug: 'my-weather-agent',
  name: 'My Weather Agent',
  description: '',
  agentUrl: 'https://api.myweather.example/agent',
  capabilities: ['weather', 'geo'],
  priceUsdc: 0.02,
  enabled: true,
  discoverable: false,
  createdAt: new Date().toISOString(),
};

const VALID_BODY = {
  name: 'My Weather Agent',
  agentUrl: 'https://api.myweather.example/agent',
  capabilities: ['weather', 'geo'],
  priceUsdc: 0.02,
};

describe('agents routes — publish flow (WKH-134)', () => {
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
    currentOwner = 'tenant-A';
    mockLookup.mockResolvedValue(PUBLIC_IP);
  });

  afterEach(() => {
    mockLookup.mockReset();
  });

  // ── T-PUB-01 ─────────────────────────────────────────────────────
  it('T-PUB-01: publish happy-path → 201, publish called with ownerRef, returns derived slug', async () => {
    mockPublish.mockResolvedValueOnce(RECORD_RESPONSE);

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: VALID_BODY,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().slug).toBe('my-weather-agent');
    expect(mockPublish).toHaveBeenCalledTimes(1);
    // ownerRef del a2aKeyRow inyectado.
    expect(mockPublish.mock.calls[0]?.[1]).toBe('tenant-A');
  });

  // ── T-PUB-05 ─────────────────────────────────────────────────────
  it('T-PUB-05: SSRF in agentUrl (metadata IP / private / localhost / file:) → 422, publish NOT called', async () => {
    // 169.254.169.254 (link-local metadata)
    mockLookup.mockResolvedValueOnce([
      { address: '169.254.169.254', family: 4 },
    ]);
    const r1 = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { ...VALID_BODY, agentUrl: 'http://metadata.attacker.example' },
    });
    expect(r1.statusCode).toBe(422);
    expect(r1.json().error).toBe('SSRF_BLOCKED');
    expect(r1.json().field).toBe('agentUrl');

    // 10.0.0.1 (private)
    mockLookup.mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);
    const r2 = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { ...VALID_BODY, agentUrl: 'http://internal.attacker.example' },
    });
    expect(r2.statusCode).toBe(422);

    // file:///etc/passwd (bad scheme, no dns)
    const r3 = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { ...VALID_BODY, agentUrl: 'file:///etc/passwd' },
    });
    expect(r3.statusCode).toBe(422);
    expect(r3.json().field).toBe('agentUrl');

    expect(mockPublish).not.toHaveBeenCalled();
  });

  // ── T-PUB-06 (service defense-in-depth) ──────────────────────────
  it('T-PUB-06: service.publish with private IP → throws uniform error, no INSERT (CD-1)', async () => {
    const { publishedAgentService: realSvc } = await vi.importActual<
      typeof import('../services/agent.js')
    >('../services/agent.js');

    mockLookup.mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);

    await expect(
      realSvc.publish(
        {
          name: 'evil',
          agentUrl: 'http://internal.attacker.example',
          capabilities: ['x'],
        },
        'tenant-A',
      ),
    ).rejects.toThrow(/Invalid agentUrl/);

    // Nunca llegó al INSERT.
    expect(mockInsert).not.toHaveBeenCalled();
  });

  // ── T-PUB-07 ─────────────────────────────────────────────────────
  it('T-PUB-07: slug collision → 409 (no double-INSERT)', async () => {
    mockPublish.mockRejectedValueOnce(
      new Error("Agent 'my-weather-agent' already exists"),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: VALID_BODY,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('Agent already exists');
    // El slug interno NO se filtra al cliente (CD-10).
    expect(JSON.stringify(res.json())).not.toContain('my-weather-agent');
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  // ── T-PUB-10 (quickstart 2-call) ─────────────────────────────────
  it('T-PUB-10: 2-call quickstart — POST /agents publishes; doc has signup + publish curls (AC-5)', async () => {
    mockPublish.mockResolvedValueOnce(RECORD_RESPONSE);

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(201);

    const docPath = fileURLToPath(
      new URL('../../doc/QUICKSTART-PUBLISH.md', import.meta.url),
    );
    const doc = readFileSync(docPath, 'utf8');
    expect(doc).toContain('/auth/agent-signup');
    expect(doc).toContain('/agents');
    expect(doc).toContain('curl');
  });

  // ── T-PUB-11 ─────────────────────────────────────────────────────
  it('T-PUB-11: missing minimal fields → 400 listing name, agentUrl, capabilities (AC-6)', async () => {
    const empty = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().missing).toEqual(['name', 'agentUrl', 'capabilities']);

    const noCaps = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { name: 'x', agentUrl: 'https://ok.example' },
    });
    expect(noCaps.statusCode).toBe(400);
    expect(noCaps.json().missing).toEqual(['capabilities']);

    expect(mockPublish).not.toHaveBeenCalled();
  });

  // ── T-PUB-12 ─────────────────────────────────────────────────────
  it('T-PUB-12: no a2a-key → 403 A2A_KEY_REQUIRED, publish NOT called (CD-2)', async () => {
    currentOwner = null;

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: VALID_BODY,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('A2A_KEY_REQUIRED');
    expect(mockPublish).not.toHaveBeenCalled();
  });

  // ── T-PUB-13 ─────────────────────────────────────────────────────
  it('T-PUB-13: internal error never leaks err.message (CD-10)', async () => {
    // 422 SSRF body: solo error/field/reason, sin stack/category.
    const ssrf = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { ...VALID_BODY, agentUrl: 'file:///etc/passwd' },
    });
    expect(ssrf.statusCode).toBe(422);
    expect(Object.keys(ssrf.json()).sort()).toEqual([
      'error',
      'field',
      'reason',
    ]);
    expect(ssrf.json().stack).toBeUndefined();

    // 400 generic: mensaje estático, sin el detalle interno.
    mockPublish.mockRejectedValueOnce(
      new Error('supabase host db.internal down'),
    );
    const boom = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: VALID_BODY,
    });
    expect(boom.statusCode).toBe(400);
    expect(boom.json().error).toBe('Failed to publish agent');
    expect(JSON.stringify(boom.json())).not.toContain('db.internal');
  });

  // ── T-PUB-14 ─────────────────────────────────────────────────────
  it('T-PUB-14: slug from body is ignored — PK derived server-side (CD-5)', async () => {
    mockPublish.mockResolvedValueOnce(RECORD_RESPONSE);

    await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { ...VALID_BODY, slug: 'evil-override-slug' },
    });

    expect(mockPublish).toHaveBeenCalledTimes(1);
    const forwardedInput = mockPublish.mock.calls[0]?.[0];
    // El route NO reenvía `slug` al service — se deriva del `name`.
    expect(forwardedInput).not.toHaveProperty('slug');
    expect(forwardedInput?.name).toBe('My Weather Agent');
  });

  // ── T-PUB-15 (BLQ-1 money-path) ──────────────────────────────────
  it('T-PUB-15: POST priceUsdc negative → 422, publish NOT called (BLQ-1)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { ...VALID_BODY, priceUsdc: -1000 },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('Invalid priceUsdc');
    expect(res.json().field).toBe('priceUsdc');
    expect(mockPublish).not.toHaveBeenCalled();
  });

  // ── T-PUB-16 (MNR-1) ─────────────────────────────────────────────
  it('T-PUB-16: POST capabilities with only non-strings ([123]) → 400 capabilities, publish NOT called (MNR-1)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { ...VALID_BODY, capabilities: [123] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().missing).toContain('capabilities');
    expect(mockPublish).not.toHaveBeenCalled();
  });

  // ── T-PUB-17 (MNR-1 filtering) ───────────────────────────────────
  it('T-PUB-17: POST capabilities mixes strings+non-strings → forwarded filtered to strings only (MNR-1)', async () => {
    mockPublish.mockResolvedValueOnce(RECORD_RESPONSE);

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { ...VALID_BODY, capabilities: ['weather', 123, 'geo', null] },
    });

    expect(res.statusCode).toBe(201);
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish.mock.calls[0]?.[0]?.capabilities).toEqual([
      'weather',
      'geo',
    ]);
  });

  // ── T-PUB-18 (BLQ-1 PATCH money-path) ────────────────────────────
  it('T-PUB-18: PATCH priceUsdc negative → 422, update NOT called (BLQ-1)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/my-weather-agent',
      payload: { priceUsdc: -1000 },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('Invalid priceUsdc');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  // ── T-PUB-19 (MNR-1 PATCH) ───────────────────────────────────────
  it('T-PUB-19: PATCH invalid capabilities ([] or non-array) → 422, update NOT called (MNR-1)', async () => {
    const empty = await app.inject({
      method: 'PATCH',
      url: '/agents/my-weather-agent',
      payload: { capabilities: [] },
    });
    expect(empty.statusCode).toBe(422);
    expect(empty.json().error).toBe('Invalid capabilities');

    const notArray = await app.inject({
      method: 'PATCH',
      url: '/agents/my-weather-agent',
      payload: { capabilities: 'x' },
    });
    expect(notArray.statusCode).toBe(422);

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  // ── WKH-143b ──────────────────────────────────────────────────────
  const VALID_WALLET = '0x1111111111111111111111111111111111111111';

  // T-143B-01 (AC-1) — real service persists payout_wallet in the insert row.
  it('T-143B-01: POST payoutWallet valid → persisted in a2a_agents.payout_wallet (AC-1)', async () => {
    const { publishedAgentService: realSvc } = await vi.importActual<
      typeof import('../services/agent.js')
    >('../services/agent.js');

    await realSvc.publish(
      {
        name: 'Payout Agent',
        agentUrl: 'https://api.example/agent',
        capabilities: ['x'],
        payoutWallet: VALID_WALLET,
      },
      'tenant-A',
    );

    expect(mockInsert).toHaveBeenCalledTimes(1);
    const row = mockInsert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.payout_wallet).toBe(VALID_WALLET);
  });

  // T-143B-02 (AC-4) — referrerRef persisted trimmed.
  it('T-143B-02: POST referrerRef with whitespace → persisted trimmed (AC-4)', async () => {
    const { publishedAgentService: realSvc } = await vi.importActual<
      typeof import('../services/agent.js')
    >('../services/agent.js');

    await realSvc.publish(
      {
        name: 'Ref Agent',
        agentUrl: 'https://api.example/agent',
        capabilities: ['x'],
        referrerRef: '  ref-abc  ',
      },
      'tenant-A',
    );

    expect(mockInsert).toHaveBeenCalledTimes(1);
    const row = mockInsert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.referrer_ref).toBe('ref-abc');
  });

  // T-143B-03 (AC-3/CD-5/DT-3) — invalid payoutWallet → 422, no publish.
  it('T-143B-03: POST payoutWallet invalid ("", "0xshort", non-string) → 422, publish NOT called (AC-3/DT-3)', async () => {
    for (const bad of ['', '0xshort', 12345]) {
      vi.clearAllMocks();
      const res = await app.inject({
        method: 'POST',
        url: '/agents',
        payload: { ...VALID_BODY, payoutWallet: bad },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe('Invalid payoutWallet');
      expect(res.json().field).toBe('payoutWallet');
      expect(mockPublish).not.toHaveBeenCalled();
      expect(mockInsert).not.toHaveBeenCalled();
    }
  });

  // ── WKH-234 (Solana namespace-aware payout) ──────────────────────────
  const SOL_WALLET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

  // T-234-01 (AC-1) — real service persists a base58 payout_wallet when
  // payoutChain='solana-devnet' (guard EVM NO se activa).
  it('T-234-01: publish base58 payoutWallet + payoutChain solana-devnet → persisted, no throw (AC-1)', async () => {
    const { publishedAgentService: realSvc } = await vi.importActual<
      typeof import('../services/agent.js')
    >('../services/agent.js');

    await realSvc.publish(
      {
        name: 'Solana Payout Agent',
        agentUrl: 'https://api.example/agent',
        capabilities: ['x'],
        payoutWallet: SOL_WALLET,
        payoutChain: 'solana-devnet',
      },
      'tenant-A',
    );

    expect(mockInsert).toHaveBeenCalledTimes(1);
    const row = mockInsert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.payout_wallet).toBe(SOL_WALLET);
  });

  // T-234-02 (AC-1) — route accepts base58 + payoutChain solana-devnet → 201.
  it('T-234-02: POST base58 payoutWallet + payoutChain solana-devnet → 201 (guard EVM no se activa)', async () => {
    mockPublish.mockResolvedValueOnce(RECORD_RESPONSE);
    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        ...VALID_BODY,
        payoutWallet: SOL_WALLET,
        payoutChain: 'solana-devnet',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  // T-234-03 (AC-5) — base58 wallet WITHOUT payoutChain resolves EVM ns → 422.
  it('T-234-03: POST base58 payoutWallet without payoutChain (EVM ns) → 422 (AC-5)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { ...VALID_BODY, payoutWallet: SOL_WALLET },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().field).toBe('payoutWallet');
    expect(mockPublish).not.toHaveBeenCalled();
  });

  // T-234-04 (AC-6) — unknown/mainnet payoutChain → 422 (chain desconocida).
  it('T-234-04: POST payoutWallet + unknown payoutChain (solana-mainnet / garbage) → 422 (AC-6)', async () => {
    for (const chain of ['solana-mainnet', 'not-a-chain']) {
      vi.clearAllMocks();
      const res = await app.inject({
        method: 'POST',
        url: '/agents',
        payload: {
          ...VALID_BODY,
          payoutWallet: SOL_WALLET,
          payoutChain: chain,
        },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().field).toBe('payoutWallet');
      expect(mockPublish).not.toHaveBeenCalled();
    }
  });

  // T-143B-04 (AC-4/DT-2) — invalid referrerRef → 422, no publish.
  it('T-143B-04: POST referrerRef invalid (whitespace-only, >200 chars) → 422, publish NOT called (AC-4/DT-2)', async () => {
    for (const bad of ['   ', 'x'.repeat(201)]) {
      vi.clearAllMocks();
      const res = await app.inject({
        method: 'POST',
        url: '/agents',
        payload: { ...VALID_BODY, referrerRef: bad },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe('Invalid referrerRef');
      expect(res.json().field).toBe('referrerRef');
      expect(mockPublish).not.toHaveBeenCalled();
      expect(mockInsert).not.toHaveBeenCalled();
    }
  });

  // T-143B-05 (AC-8/CD-3 anti-leak) — 201 body never exposes the new columns.
  it('T-143B-05: 201 body never contains payout_wallet/referrer_ref (anti-leak, AC-8/CD-3)', async () => {
    mockPublish.mockResolvedValueOnce(RECORD_RESPONSE);

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { ...VALID_BODY, payoutWallet: VALID_WALLET, referrerRef: 'r1' },
    });

    expect(res.statusCode).toBe(201);
    const raw = JSON.stringify(res.json());
    expect(raw).not.toContain('payout_wallet');
    expect(raw).not.toContain('referrer_ref');
    expect(raw).not.toContain('payoutWallet');
    expect(raw).not.toContain('referrerRef');
  });
});
