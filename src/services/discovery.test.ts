/**
 * Tests for Discovery Service — verified + status filters (WKH-DISCOVER-VERIFIED)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegistryConfig } from '../types/index.js';

// ─── Structured logger mock ─────────────────────────────────
// discovery.ts logs server-side via getLogger('discovery'). Mock it so tests
// assert log emission (object-first / message-second) instead of spying on
// console. hoisted so the factory can reference it.
const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({
  getLogger: () => logSpy,
}));

// Mock registry service
vi.mock('./registry.js', () => ({
  registryService: {
    getEnabled: vi.fn(),
    get: vi.fn(),
    // HIGH-1: el filtro `query.registry` usa `getWithSecrets` (necesita
    // `auth.value` para el header outbound). `get` quedó redactado.
    getWithSecrets: vi.fn(),
  },
}));

// Mock circuit breaker
vi.mock('../lib/circuit-breaker.js', () => ({
  getRegistryCircuitBreaker: () => ({
    execute: (fn: () => Promise<Response>) => fn(),
  }),
}));

// undici-8 migration (#124): `ssrfFetch` calls undici's OWN `fetch` (not
// the Node global) so the undici-8 Agent and the fetch implementation share a
// version. Route BOTH the global stub and undici's `fetch` to the same
// `mockFetch` so the outbound-call assertions still intercept while the real
// undici `Agent` (connect-time SSRF lookup) stays intact.
const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.stubGlobal('fetch', mockFetch);
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: mockFetch };
});

// WKH-100 FIX-PACK v2: discover()/getAgent() reverse-lookup ERC-8004 identity by
// the bidirectional match (declared token crossed with a binding that declares
// operating (registry, slug)). Mock the supabase client so the REAL
// resolveIdentityForAgent runs deterministically (no network). `setIdentityRows`
// controls what the `.select('erc8004_identity').eq('is_active',true).not(...)`
// chain resolves to.
let _identityRows: Array<{ erc8004_identity: unknown }> = [];
let _identityError: unknown = null;
function setIdentityRows(rows: Array<{ erc8004_identity: unknown }>): void {
  _identityRows = rows;
  _identityError = null;
}
function setIdentityError(err: unknown): void {
  _identityError = err;
  _identityRows = [];
}

vi.mock('../lib/supabase.js', () => {
  const builder = {
    select: vi.fn(() => builder),
    not: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    // The real PostgREST query builder is a thenable (awaitable without a
    // terminal call); we mimic that here intentionally.
    // biome-ignore lint/suspicious/noThenProperty: mock mirrors PostgREST thenable
    then: (resolve: (v: { data: unknown; error: unknown }) => void): void => {
      resolve({
        data: _identityError ? null : _identityRows,
        error: _identityError,
      });
    },
  };
  return { supabase: { from: vi.fn(() => builder) } };
});

// WKH-103 (CD-15): discover() enriches computedReputation via the batch
// service. Mock reputationService so the enrichment + sort run deterministically
// without coupling to the supabase reduce. `setReputationBatch` controls the
// Map the batch resolves to; `mockComputeBatch` lets tests assert no-N+1.
//
// WKH-313: el consumidor real es ahora `computeStandingBatch` (necesita el tercer
// valor `degraded`, CD-7). El doble se DERIVA del mismo `mockComputeBatch`, así que
// los escenarios de abajo (incluido T-AC4, que mockea un rechazo) no cambian.
const mockComputeBatch = vi.fn();
vi.mock('./reputation.js', () => ({
  reputationService: {
    computeReputationBatch: (slugs: string[]) => mockComputeBatch(slugs),
    computeStandingBatch: async (slugs: string[]) => {
      const repMap = (await mockComputeBatch(slugs)) as Map<
        string,
        { tasks_settled: number }
      >;
      const standings = new Map();
      for (const [slug, reputation] of repMap) {
        standings.set(slug, {
          tasksSettled: reputation.tasks_settled,
          successCount: reputation.tasks_settled,
          failedCount: 0,
          reputation,
        });
      }
      return { degraded: false, standings };
    },
    computeReputationForAgent: vi.fn(),
  },
}));

import type { Agent, AgentReputation } from '../types/index.js';
import {
  _resetFallbackWarnDedup,
  discoveryService,
  extractDeclaredTokenId,
  parsePriceSafe,
} from './discovery.js';
import { identityService } from './identity.js';
import { registryService } from './registry.js';

function makeRep(o: Partial<AgentReputation> = {}): AgentReputation {
  return {
    score: 50,
    tasks_settled: 10,
    success_rate: 1,
    total_volume_usdc: 10,
    source: 'off-chain',
    ...o,
  };
}
function setReputationBatch(
  entries: Array<[string, AgentReputation]> = [],
): void {
  mockComputeBatch.mockResolvedValue(new Map(entries));
}

function makeRegistry(o: Partial<RegistryConfig> = {}): RegistryConfig {
  return {
    id: 'reg-1',
    name: 'test-registry',
    discoveryEndpoint: 'https://example.com/agents',
    invokeEndpoint: 'https://example.com/invoke/{slug}',
    schema: { discovery: {}, invoke: { method: 'POST' } },
    enabled: true,
    createdAt: new Date(),
    ownerRef: 'system',
    ...o,
  };
}

function makeRawAgent(
  o: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    slug: 'test-agent',
    description: 'A test agent',
    capabilities: ['test'],
    price: 0,
    reputation: 80,
    ...o,
  };
}

function setupRegistryResponse(rawAgents: Record<string, unknown>[]) {
  vi.mocked(registryService.getEnabled).mockResolvedValue([makeRegistry()]);
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(rawAgents),
  });
}

describe('discoveryService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setIdentityRows([]); // default: no bound identities
    setReputationBatch([]); // WKH-103 default: no computed reputations
  });

  describe('AC-10: default status=active filter', () => {
    it('returns only active agents by default', async () => {
      setupRegistryResponse([
        makeRawAgent({ id: 'a1', slug: 'active-1', status: 'active' }),
        makeRawAgent({ id: 'a2', slug: 'inactive-1', status: 'inactive' }),
        makeRawAgent({
          id: 'a3',
          slug: 'unreachable-1',
          status: 'unreachable',
        }),
      ]);

      const result = await discoveryService.discover({});

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0]!.slug).toBe('active-1');
      expect(result.agents[0]!.status).toBe('active');
    });
  });

  describe('AC-2: includeInactive bypasses status filter', () => {
    it('returns all agents when includeInactive=true', async () => {
      setupRegistryResponse([
        makeRawAgent({ id: 'a1', slug: 'active-1', status: 'active' }),
        makeRawAgent({ id: 'a2', slug: 'inactive-1', status: 'inactive' }),
      ]);

      const result = await discoveryService.discover({ includeInactive: true });

      expect(result.agents).toHaveLength(2);
    });
  });

  describe('AC-3: verified filter', () => {
    it('returns only verified agents when verified=true', async () => {
      setupRegistryResponse([
        makeRawAgent({ id: 'a1', slug: 'verified-1', verified: true }),
        makeRawAgent({ id: 'a2', slug: 'unverified-1', verified: false }),
      ]);

      const result = await discoveryService.discover({ verified: true });

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0]!.slug).toBe('verified-1');
      expect(result.agents[0]!.verified).toBe(true);
    });
  });

  describe('AC-5 + AC-6: mapAgent defaults', () => {
    it('defaults verified to false and status to active when absent', async () => {
      setupRegistryResponse([makeRawAgent({ id: 'a1', slug: 'bare-agent' })]);

      const result = await discoveryService.discover({});

      expect(result.agents[0]!.verified).toBe(false);
      expect(result.agents[0]!.status).toBe('active');
    });
  });

  describe('AC-7: verified-first sort tiebreaker', () => {
    it('ranks verified agents above non-verified with same reputation', async () => {
      setupRegistryResponse([
        makeRawAgent({
          id: 'a1',
          slug: 'unverified',
          verified: false,
          reputation: 90,
        }),
        makeRawAgent({
          id: 'a2',
          slug: 'verified',
          verified: true,
          reputation: 90,
        }),
      ]);

      const result = await discoveryService.discover({});

      expect(result.agents[0]!.slug).toBe('verified');
      expect(result.agents[1]!.slug).toBe('unverified');
    });
  });

  describe('WKH-55 AC-7: mapAgent propagates raw.payment to agent.payment', () => {
    it('mapAgent maps raw.payment to agent.payment when present and valid', () => {
      const registry = makeRegistry();
      const raw = {
        id: '1',
        slug: 'agent-1',
        name: 'A1',
        description: 'd',
        capabilities: ['x'],
        price: 0.5,
        status: 'active',
        payment: {
          method: 'x402',
          asset: 'USDC',
          chain: 'avalanche',
          contract: '0x000000000000000000000000000000000000aBcD',
        },
      };
      const agent = discoveryService.mapAgent(registry, raw);
      expect(agent.payment).toEqual({
        method: 'x402',
        asset: 'USDC',
        chain: 'avalanche',
        contract: '0x000000000000000000000000000000000000aBcD',
      });
    });

    it('mapAgent leaves agent.payment undefined when raw.payment is absent', () => {
      const registry = makeRegistry();
      const raw = {
        id: '1',
        slug: 'agent-1',
        name: 'A1',
        description: 'd',
        capabilities: ['x'],
        price: 0.5,
        status: 'active',
      };
      const agent = discoveryService.mapAgent(registry, raw);
      expect(agent.payment).toBeUndefined();
    });

    // 068: chain allowlist mainnet support
    // Fix-pack it2 BLQ-MED-1 — CAMBIO INTENCIONAL DE API: `avalanche-mainnet` ya
    // NO se colapsa a `'avalanche'` (que resolvía a Fuji). Se reporta lo que el
    // agente declaró; el bloqueo del dinero vive en el gate fail-CLOSED del leg
    // downstream (`WASIAI_DOWNSTREAM_MAINNET_ALLOW`), que antes era inejercitable
    // para avalanche porque ningún card podía producir ese ChainKey.
    it('mapAgent accepts chain="avalanche-mainnet" and keeps it (no mainnet collapse)', () => {
      const registry = makeRegistry();
      const raw = {
        id: '1',
        slug: 'agent-1',
        name: 'A1',
        description: 'd',
        capabilities: ['x'],
        price: 0.5,
        status: 'active',
        payment: {
          method: 'x402',
          asset: 'USDC',
          chain: 'avalanche-mainnet',
          contract: '0x000000000000000000000000000000000000aBcD',
        },
      };
      const agent = discoveryService.mapAgent(registry, raw);
      expect(agent.payment).toEqual({
        method: 'x402',
        asset: 'USDC',
        chain: 'avalanche-mainnet', // it2 BLQ-MED-1: sin colapso mainnet
        contract: '0x000000000000000000000000000000000000aBcD',
      });
    });

    it('mapAgent rejects chain outside allowlist (e.g. "polygon")', () => {
      const registry = makeRegistry();
      const raw = {
        id: '1',
        slug: 'agent-1',
        name: 'A1',
        description: 'd',
        capabilities: ['x'],
        price: 0.5,
        status: 'active',
        payment: {
          method: 'x402',
          asset: 'USDC',
          chain: 'polygon',
          contract: '0x000000000000000000000000000000000000aBcD',
        },
      };
      const agent = discoveryService.mapAgent(registry, raw);
      expect(agent.payment).toBeUndefined();
    });
  });

  // ─── WKH-MULTICHAIN AC-10 (W4): payment.chain + payment.asset exposed in /discover ──
  describe('WKH-MULTICHAIN AC-10: /discover exposes payment.chain and payment.asset', () => {
    it('returns payment.chain ("avalanche") and payment.asset ("USDC") for an Avalanche-paid agent via discover()', async () => {
      // Raw agent published with wasiai-v2 testnet shape: chain="avalanche-testnet"
      // Discovery normalizes to canonical "avalanche" via the SEC-AR allowlist.
      setupRegistryResponse([
        makeRawAgent({
          id: 'a-fuji',
          slug: 'avax-pay-agent',
          status: 'active',
          payment: {
            method: 'x402',
            chain: 'avalanche-testnet',
            asset: 'USDC',
            contract: '0x000000000000000000000000000000000000aBcD',
          },
        }),
      ]);

      const result = await discoveryService.discover({});

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0]!.payment).toBeDefined();
      // Discovery normalizes avalanche-testnet → avalanche (canonical), independent
      // of the middleware ChainKey normalizer (avalanche-fuji). See SDD R-8.
      expect(result.agents[0]!.payment?.chain).toBe('avalanche');
      expect(result.agents[0]!.payment?.asset).toBe('USDC');
      expect(result.agents[0]!.payment?.method).toBe('x402');
    });

    it('exposes payment for a Kite-paid agent (chain="kite-ozone-testnet" in discovery allowlist after WKH-AGENTSHOP-1)', async () => {
      // Post WKH-AGENTSHOP-1: Kite slugs added to ALLOWED_CHAIN_VALUES so the
      // WasiAgentShop Kite hackathon agents (lendable-*, agentshop-*) can publish
      // their payment metadata via /discover. Kite chain passes through unchanged
      // (no avalanche-style collapse) so consumers can distinguish testnet/mainnet.
      setupRegistryResponse([
        makeRawAgent({
          id: 'a-kite',
          slug: 'kite-pay-agent',
          status: 'active',
          payment: {
            method: 'x402',
            chain: 'kite-ozone-testnet',
            asset: 'PYUSD',
            contract: '0x000000000000000000000000000000000000bEeF',
          },
        }),
      ]);

      const result = await discoveryService.discover({});

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0]!.slug).toBe('kite-pay-agent');
      expect(result.agents[0]!.payment?.chain).toBe('kite-ozone-testnet');
      expect(result.agents[0]!.payment?.asset).toBe('PYUSD');
      expect(result.agents[0]!.payment?.method).toBe('x402');
    });

    it('returns payment: undefined for an agent without payment metadata in /discover output', async () => {
      // Sanity check: agents that declare no payment block don't crash and surface
      // payment: undefined cleanly in the /discover output (not a thrown error).
      setupRegistryResponse([
        makeRawAgent({
          id: 'a-free',
          slug: 'free-agent',
          status: 'active',
          // no `payment` field
        }),
      ]);

      const result = await discoveryService.discover({});

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0]!.slug).toBe('free-agent');
      expect(result.agents[0]!.payment).toBeUndefined();
    });
  });

  // ─── WKH-113 (BASE-08): dynamic chain validation via normalizeChainSlug ──
  // readPayment now derives accept/reject from the pure chain-resolver instead
  // of a hardcoded ALLOWED_CHAIN_VALUES Set (CD-1/CD-9). Output string stays
  // legacy (CD-7): avalanche-testnet/-mainnet → 'avalanche'; rest pass-through.
  describe('WKH-113: readPayment dynamic chain validation', () => {
    function makePaymentRaw(chain: string): Record<string, unknown> {
      return {
        id: '1',
        slug: 'agent-1',
        name: 'A1',
        description: 'd',
        capabilities: ['x'],
        price: 0.5,
        status: 'active',
        payment: {
          method: 'x402',
          asset: 'USDC',
          chain,
          contract: '0x000000000000000000000000000000000000aBcD',
        },
      };
    }

    it('T-AC1a: accepts chain="base-sepolia" (pass-through)', () => {
      const agent = discoveryService.mapAgent(
        makeRegistry(),
        makePaymentRaw('base-sepolia'),
      );
      expect(agent.payment?.chain).toBe('base-sepolia');
      expect(agent.payment?.method).toBe('x402');
      expect(agent.payment?.asset).toBe('USDC');
    });

    it('T-AC1b: accepts chain="avalanche-fuji" and chainId "84532" (pass-through)', () => {
      const fuji = discoveryService.mapAgent(
        makeRegistry(),
        makePaymentRaw('avalanche-fuji'),
      );
      // avalanche-fuji is NOT collapsed (only avalanche-testnet/-mainnet are).
      expect(fuji.payment?.chain).toBe('avalanche-fuji');

      const chainId = discoveryService.mapAgent(
        makeRegistry(),
        makePaymentRaw('84532'),
      );
      // chainId accepted (resolver knows 84532 → base-sepolia) and passed
      // through as the raw string '84532' (no ChainKey leaked to output, CD-7).
      expect(chainId.payment?.chain).toBe('84532');
    });

    it('T-AC2a: regression — avalanche TESTNET variants collapse to "avalanche" (CD-7, NOT avalanche-fuji); la mainnet NO colapsa (it2 BLQ-MED-1)', () => {
      const plain = discoveryService.mapAgent(
        makeRegistry(),
        makePaymentRaw('avalanche'),
      );
      expect(plain.payment?.chain).toBe('avalanche');
      expect(plain.payment?.chain).not.toBe('avalanche-fuji');

      const testnet = discoveryService.mapAgent(
        makeRegistry(),
        makePaymentRaw('avalanche-testnet'),
      );
      expect(testnet.payment?.chain).toBe('avalanche');

      // it2 BLQ-MED-1: el alias mainnet sale como su ChainKey real, así el gate
      // fail-CLOSED del leg downstream lo ve (y el opt-in por env es ejercitable).
      const mainnet = discoveryService.mapAgent(
        makeRegistry(),
        makePaymentRaw('avalanche-mainnet'),
      );
      expect(mainnet.payment?.chain).toBe('avalanche-mainnet');
      expect(mainnet.payment?.chain).not.toBe('avalanche');
    });

    it('T-AC2b: regression — kite-ozone-testnet passes through unchanged (CD-7)', () => {
      const agent = discoveryService.mapAgent(
        makeRegistry(),
        makePaymentRaw('kite-ozone-testnet'),
      );
      expect(agent.payment?.chain).toBe('kite-ozone-testnet');
    });

    // WKH-234: `solana` is now a recognized slug (→ solana-devnet), so the
    // "unknown chain" defense uses `solana-mainnet` — NOT recognized
    // (devnet-only, CD-4). A recognized Solana agent passing discovery is
    // covered by the positive W2 test.
    it('T-AC5: unknown chain (polygon/solana-mainnet) → payment undefined (defense preserved)', () => {
      const polygon = discoveryService.mapAgent(
        makeRegistry(),
        makePaymentRaw('polygon'),
      );
      expect(polygon.payment).toBeUndefined();

      const solanaMainnet = discoveryService.mapAgent(
        makeRegistry(),
        makePaymentRaw('solana-mainnet'),
      );
      expect(solanaMainnet.payment).toBeUndefined();
    });

    // WKH-234 (W2, AC-6 inverso / ruta feliz): un agente Solana-native pasa el
    // filtro de discovery una vez el resolver reconoce el slug. La lógica de
    // discovery NO cambió — solo el resolver aprendió `solana-devnet`/`solana`.
    it('T-234-W2: accepts a Solana-native agent (chain solana-devnet / solana → payment defined)', () => {
      const SOL_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
      const raw = (chain: string): Record<string, unknown> => ({
        id: '1',
        slug: 'sol-agent',
        name: 'SolAgent',
        description: 'd',
        capabilities: ['x'],
        price: 0.5,
        status: 'active',
        payment: {
          method: 'x402',
          asset: 'USDC',
          chain,
          contract: SOL_MINT, // base58 SPL mint (no 0x)
        },
      });

      const devnet = discoveryService.mapAgent(
        makeRegistry(),
        raw('solana-devnet'),
      );
      expect(devnet.payment).toBeDefined();
      expect(devnet.payment?.chain).toBe('solana-devnet');
      expect(devnet.payment?.contract).toBe(SOL_MINT);

      // `solana` alias also passes (chain string preserved as-is, CD-7).
      const alias = discoveryService.mapAgent(makeRegistry(), raw('solana'));
      expect(alias.payment).toBeDefined();
      expect(alias.payment?.chain).toBe('solana');
    });

    it('T-AC1-discover: discover() exposes payment.chain="base-sepolia" end-to-end', async () => {
      setupRegistryResponse([
        makeRawAgent({
          id: 'a-base',
          slug: 'base-pay-agent',
          status: 'active',
          payment: {
            method: 'x402',
            chain: 'base-sepolia',
            asset: 'USDC',
            contract: '0x000000000000000000000000000000000000aBcD',
          },
        }),
      ]);

      const result = await discoveryService.discover({});

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0]!.slug).toBe('base-pay-agent');
      expect(result.agents[0]!.payment?.chain).toBe('base-sepolia');
      expect(result.agents[0]!.payment?.asset).toBe('USDC');
      expect(result.agents[0]!.payment?.method).toBe('x402');
    });

    it('T-AC7: avalanche-fuji agent now has payment populated (was payment=null pre-WKH-113)', async () => {
      setupRegistryResponse([
        makeRawAgent({
          id: 'a-fuji',
          slug: 'fuji-pay-agent',
          status: 'active',
          payment: {
            method: 'x402',
            chain: 'avalanche-fuji',
            asset: 'USDC',
            contract: '0x000000000000000000000000000000000000aBcD',
          },
        }),
      ]);

      const result = await discoveryService.discover({});

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0]!.payment).toBeDefined();
      expect(result.agents[0]!.payment?.chain).toBe('avalanche-fuji');
    });
  });

  describe('AC-9: verified + includeInactive combine with AND logic', () => {
    it('returns only verified agents of all statuses', async () => {
      setupRegistryResponse([
        makeRawAgent({
          id: 'a1',
          slug: 'active-verified',
          status: 'active',
          verified: true,
        }),
        makeRawAgent({
          id: 'a2',
          slug: 'inactive-verified',
          status: 'inactive',
          verified: true,
        }),
        makeRawAgent({
          id: 'a3',
          slug: 'active-unverified',
          status: 'active',
          verified: false,
        }),
        makeRawAgent({
          id: 'a4',
          slug: 'inactive-unverified',
          status: 'inactive',
          verified: false,
        }),
      ]);

      const result = await discoveryService.discover({
        verified: true,
        includeInactive: true,
      });

      expect(result.agents).toHaveLength(2);
      expect(result.agents.every((a) => a.verified)).toBe(true);
      expect(result.agents.map((a) => a.slug).sort()).toEqual([
        'active-verified',
        'inactive-verified',
      ]);
    });
  });

  // ── WKH-100 FIX-PACK (BLQ-MED-1 / DT-21) — token-based resolver + enrich ──

  /** Builds a synthetic Agent with a chosen `metadata` for the helper tests. */
  function makeAgent(metadata?: Record<string, unknown>): Agent {
    return {
      id: 'a1',
      name: 'A',
      slug: 'a',
      description: '',
      capabilities: [],
      priceUsdc: 0,
      registry: 'r',
      registry_id: 'r',
      invokeUrl: 'https://x',
      invocationNote: '',
      verified: false,
      status: 'active',
      ...(metadata !== undefined && { metadata }),
    };
  }

  describe('DT-21: extractDeclaredTokenId', () => {
    it('CAIP-10 registrations[].agentId (Base sepolia) → { tokenId, chainId }', () => {
      const agent = makeAgent({
        registrations: [
          {
            agentId: `eip155:84532:0x${'a'.repeat(40)}/42`,
            agentRegistry: 'x',
          },
        ],
      });
      expect(extractDeclaredTokenId(agent)).toEqual({
        tokenId: '42',
        chainId: 84532,
      });
    });

    it('CAIP-10 mainnet (8453) accepted', () => {
      const agent = makeAgent({
        registrations: [{ agentId: `eip155:8453:0x${'b'.repeat(40)}/7` }],
      });
      expect(extractDeclaredTokenId(agent)).toEqual({
        tokenId: '7',
        chainId: 8453,
      });
    });

    it('fallback metadata.erc8004 = { token_id, chain_id }', () => {
      const agent = makeAgent({ erc8004: { token_id: '9', chain_id: 84532 } });
      expect(extractDeclaredTokenId(agent)).toEqual({
        tokenId: '9',
        chainId: 84532,
      });
    });

    it('fallback top-level erc8004_token_id + erc8004_chain_id', () => {
      const agent = makeAgent({
        erc8004_token_id: '11',
        erc8004_chain_id: 8453,
      });
      expect(extractDeclaredTokenId(agent)).toEqual({
        tokenId: '11',
        chainId: 8453,
      });
    });

    it('DEFAULT SEGURO: no metadata → null', () => {
      expect(extractDeclaredTokenId(makeAgent())).toBeNull();
    });

    it('DEFAULT SEGURO: empty metadata → null', () => {
      expect(extractDeclaredTokenId(makeAgent({}))).toBeNull();
    });

    it('DEFAULT SEGURO: non-numeric tokenId → null', () => {
      const agent = makeAgent({
        erc8004: { token_id: 'abc', chain_id: 84532 },
      });
      expect(extractDeclaredTokenId(agent)).toBeNull();
    });

    it('DEFAULT SEGURO: chainId outside {8453,84532} → null', () => {
      const agent = makeAgent({ erc8004: { token_id: '1', chain_id: 1 } });
      expect(extractDeclaredTokenId(agent)).toBeNull();
    });

    it('DEFAULT SEGURO: malformed CAIP-10 (no /tokenId) → null', () => {
      const agent = makeAgent({
        registrations: [{ agentId: 'eip155:84532:not-an-address' }],
      });
      expect(extractDeclaredTokenId(agent)).toBeNull();
    });

    it('CAIP-10 with disallowed chainId is skipped, fallback wins', () => {
      const agent = makeAgent({
        registrations: [{ agentId: `eip155:1:0x${'c'.repeat(40)}/5` }],
        erc8004: { token_id: '88', chain_id: 84532 },
      });
      expect(extractDeclaredTokenId(agent)).toEqual({
        tokenId: '88',
        chainId: 84532,
      });
    });

    // ── WKH-237 (DT-1a): Avalanche C-Chain (43114) + Fuji (43113) accepted ──

    it('AC-1: CAIP-10 registrations[].agentId (Avalanche C-Chain 43114) accepted', () => {
      const agent = makeAgent({
        registrations: [
          {
            agentId: `eip155:43114:0x${'d'.repeat(40)}/501`,
            agentRegistry: 'x',
          },
        ],
      });
      expect(extractDeclaredTokenId(agent)).toEqual({
        tokenId: '501',
        chainId: 43114,
      });
    });

    it('AC-1: CAIP-10 registrations[].agentId (Avalanche Fuji 43113) accepted', () => {
      const agent = makeAgent({
        registrations: [{ agentId: `eip155:43113:0x${'e'.repeat(40)}/77` }],
      });
      expect(extractDeclaredTokenId(agent)).toEqual({
        tokenId: '77',
        chainId: 43113,
      });
    });

    it('AC-1: fallback metadata.erc8004 with Avalanche C-Chain (43114) accepted', () => {
      const agent = makeAgent({
        erc8004: { token_id: '9', chain_id: 43114 },
      });
      expect(extractDeclaredTokenId(agent)).toEqual({
        tokenId: '9',
        chainId: 43114,
      });
    });

    it('AC-1: fallback metadata.erc8004 with Avalanche Fuji (43113) accepted', () => {
      const agent = makeAgent({
        erc8004: { token_id: '10', chain_id: 43113 },
      });
      expect(extractDeclaredTokenId(agent)).toEqual({
        tokenId: '10',
        chainId: 43113,
      });
    });

    it('AC-1: fallback top-level erc8004_chain_id = 43113 (Fuji) accepted', () => {
      const agent = makeAgent({
        erc8004_token_id: '12',
        erc8004_chain_id: 43113,
      });
      expect(extractDeclaredTokenId(agent)).toEqual({
        tokenId: '12',
        chainId: 43113,
      });
    });

    // AC-4 (no regression): Base 8453/84532 keep being accepted byte-identical.
    // The existing assertions above ('CAIP-10 mainnet (8453) accepted',
    // 'CAIP-10 registrations[].agentId (Base sepolia)', etc.) cover Base; the
    // two below re-assert the fallback paths side-by-side with the new
    // Avalanche cases so a future refactor can't drop Base silently.
    it('AC-4: fallback metadata.erc8004 with Base sepolia (84532) still accepted', () => {
      const agent = makeAgent({ erc8004: { token_id: '9', chain_id: 84532 } });
      expect(extractDeclaredTokenId(agent)).toEqual({
        tokenId: '9',
        chainId: 84532,
      });
    });

    it('AC-4: fallback metadata.erc8004 with Base mainnet (8453) still accepted', () => {
      const agent = makeAgent({ erc8004: { token_id: '3', chain_id: 8453 } });
      expect(extractDeclaredTokenId(agent)).toEqual({
        tokenId: '3',
        chainId: 8453,
      });
    });

    // AC-5 (edge): chains outside {8453,84532,43114,43113} stay rejected.
    it('AC-5: chainId 137 (Polygon) → null (unknown chain rejected)', () => {
      const agent = makeAgent({ erc8004: { token_id: '1', chain_id: 137 } });
      expect(extractDeclaredTokenId(agent)).toBeNull();
    });

    it('AC-5: chainId 1 (Ethereum mainnet) → null (unknown chain rejected)', () => {
      const agent = makeAgent({ erc8004: { token_id: '1', chain_id: 1 } });
      expect(extractDeclaredTokenId(agent)).toBeNull();
    });

    it('AC-5: CAIP-10 with Polygon (137) skipped, Avalanche fallback wins', () => {
      const agent = makeAgent({
        registrations: [{ agentId: `eip155:137:0x${'c'.repeat(40)}/5` }],
        erc8004: { token_id: '88', chain_id: 43113 },
      });
      expect(extractDeclaredTokenId(agent)).toEqual({
        tokenId: '88',
        chainId: 43113,
      });
    });
  });

  describe('DT-22 (MNR-1): resolveIdentityForAgent', () => {
    const anchored = (o: Record<string, unknown> = {}) => ({
      erc8004_identity: {
        token_id: '42',
        chain_id: 84532,
        agent_card_url: 'https://x',
        owner_address: '0xabc',
        verified_at: '2026-05-10T00:00:00.000Z',
        agent_registry: 'WasiAI',
        agent_slug: 'acme',
        ...o,
      },
    });

    it('full bidirectional match (token+chain+registry+slug) → verified:true', async () => {
      setIdentityRows([anchored()]);
      const r = await identityService.resolveIdentityForAgent(
        '42',
        84532,
        'WasiAI',
        'acme',
      );
      expect(r).toEqual({
        erc8004_token_id: '42',
        chain_id: 84532,
        verified: true,
      });
    });

    it('AC-2 (WKH-237): binding on Avalanche Fuji (43113) → verified:true', async () => {
      setIdentityRows([anchored({ chain_id: 43113 })]);
      const r = await identityService.resolveIdentityForAgent(
        '42',
        43113,
        'WasiAI',
        'acme',
      );
      expect(r).toEqual({
        erc8004_token_id: '42',
        chain_id: 43113,
        verified: true,
      });
    });

    it('AC-2 (WKH-237): binding on Avalanche C-Chain (43114) → verified:true', async () => {
      setIdentityRows([anchored({ chain_id: 43114 })]);
      const r = await identityService.resolveIdentityForAgent(
        '42',
        43114,
        'WasiAI',
        'acme',
      );
      expect(r).toEqual({
        erc8004_token_id: '42',
        chain_id: 43114,
        verified: true,
      });
    });

    it('AC-2neg (WKH-237/MNR-1): declara 43114 pero el binding está en 43113 → null (chain cruzada NO surfacea)', async () => {
      setIdentityRows([anchored({ chain_id: 43113 })]);
      expect(
        await identityService.resolveIdentityForAgent(
          '42',
          43114,
          'WasiAI',
          'acme',
        ),
      ).toBeNull();
    });

    it('AC-2neg (WKH-237/MNR-1): declara Avalanche (43113) sin ninguna fila de binding → null (default seguro)', async () => {
      setIdentityRows([]);
      expect(
        await identityService.resolveIdentityForAgent(
          '42',
          43113,
          'WasiAI',
          'acme',
        ),
      ).toBeNull();
    });

    it('FIX v3 (DT-23): registry_id match is STRICT (PK), slug normalized', async () => {
      // Binding stores the PK `wasiai` + slug `ACME`; the agent's registry_id is
      // the same PK and the slug is normalized on both sides. Registry is NOT
      // re-normalized (strict equality of the canonical PK → injective).
      setIdentityRows([
        anchored({ agent_registry: 'wasiai', agent_slug: 'ACME' }),
      ]);
      const r = await identityService.resolveIdentityForAgent(
        '42',
        84532,
        'wasiai',
        ' Acme  ',
      );
      expect(r?.verified).toBe(true);
    });

    it('SEC-COLLISION-MATCH (BLQ-MED-1): collided PK "wasiai-" never matches "wasiai"', async () => {
      // v2 attack: name "WasiAI " (trailing space) → PK `wasiai-`. The badge
      // cross used `.trim().toLowerCase()` so it collapsed to `wasiai` and
      // matched the victim agent (registry_id `wasiai`). With strict PK
      // equality the divergent PKs no longer collide → no badge.
      setIdentityRows([
        anchored({ agent_registry: 'wasiai-', agent_slug: 'acme' }),
      ]);
      const r = await identityService.resolveIdentityForAgent(
        '42',
        84532,
        'wasiai',
        'acme',
      );
      expect(r).toBeNull();
    });

    it('SEC-SLUG-SCOPED: same slug under a different registry_id → no badge', async () => {
      // Attacker controls registry_id `attacker-reg` and declares the victim's
      // slug. The slug only discriminates WITHIN a registry_id; distinct PKs
      // never match → no cross-registry badge inheritance.
      setIdentityRows([
        anchored({ agent_registry: 'attacker-reg', agent_slug: 'acme' }),
      ]);
      const r = await identityService.resolveIdentityForAgent(
        '42',
        84532,
        'wasiai',
        'acme',
      );
      expect(r).toBeNull();
    });

    it('SEC-INV (MNR-1): token matches but registry/slug differ → null (inverse vector fails)', async () => {
      // Victim bound token 42 declaring (WasiAI, acme). Attacker's agent
      // (WasiAI, evil) declares token 42 → must NOT inherit the badge.
      setIdentityRows([anchored()]);
      expect(
        await identityService.resolveIdentityForAgent(
          '42',
          84532,
          'WasiAI',
          'evil',
        ),
      ).toBeNull();
    });

    it('SEC-NOMATCH: token bound to (regA, slugA), agent B (regB, slugB) declares it → null', async () => {
      setIdentityRows([
        anchored({ agent_registry: 'regA', agent_slug: 'slugA' }),
      ]);
      expect(
        await identityService.resolveIdentityForAgent(
          '42',
          84532,
          'regB',
          'slugB',
        ),
      ).toBeNull();
    });

    it('SEC-LEGACY (AC-9): binding v1 without anchors → null (no badge)', async () => {
      setIdentityRows([
        {
          erc8004_identity: {
            token_id: '42',
            chain_id: 84532,
            agent_card_url: '',
            owner_address: '0xabc',
            verified_at: '2026-05-10T00:00:00.000Z',
            // no agent_registry / agent_slug (v1 binding)
          },
        },
      ]);
      expect(
        await identityService.resolveIdentityForAgent(
          '42',
          84532,
          'WasiAI',
          'acme',
        ),
      ).toBeNull();
    });

    it('no match (different token_id) → null', async () => {
      setIdentityRows([anchored({ token_id: '1' })]);
      expect(
        await identityService.resolveIdentityForAgent(
          '42',
          84532,
          'WasiAI',
          'acme',
        ),
      ).toBeNull();
    });

    it('chainId mismatch → null', async () => {
      setIdentityRows([anchored({ chain_id: 8453 })]);
      expect(
        await identityService.resolveIdentityForAgent(
          '42',
          84532,
          'WasiAI',
          'acme',
        ),
      ).toBeNull();
    });

    it('no rows → null', async () => {
      setIdentityRows([]);
      expect(
        await identityService.resolveIdentityForAgent(
          '42',
          84532,
          'WasiAI',
          'acme',
        ),
      ).toBeNull();
    });

    it('CD-2/DT-19: SELECT requests ONLY erc8004_identity (no budget/funding_wallet)', async () => {
      const { supabase } = await import('../lib/supabase.js');
      setIdentityRows([]);
      await identityService.resolveIdentityForAgent(
        '42',
        84532,
        'WasiAI',
        'acme',
      );
      const builder = vi.mocked(supabase.from).mock.results[0]?.value as {
        select: ReturnType<typeof vi.fn>;
      };
      const selectArg = builder.select.mock.calls[0]?.[0] as string;
      expect(selectArg).toBe('erc8004_identity');
      expect(selectArg).not.toContain('budget');
      expect(selectArg).not.toContain('funding_wallet');
    });

    it('DB error → null (graceful)', async () => {
      setIdentityError(new Error('db down'));
      expect(
        await identityService.resolveIdentityForAgent(
          '42',
          84532,
          'WasiAI',
          'acme',
        ),
      ).toBeNull();
    });
  });

  describe('DT-22: discover()/getAgent() enrich by bidirectional match', () => {
    // Agents from setupRegistryResponse() get registry_id: 'reg-1'
    // (makeRegistry default id). FIX v3 (DT-23): the binding must declare
    // operating (reg-1, <slug>) — the registry PK, not the display name —
    // for the badge to surface (strict PK match).
    it('SEC-MATCH: discover() sets identity when binding declares THIS agent', async () => {
      setupRegistryResponse([
        makeRawAgent({
          id: 'a1',
          slug: 'bound-agent',
          status: 'active',
          erc8004_token_id: '42',
          erc8004_chain_id: 84532,
        }),
      ]);
      setIdentityRows([
        {
          erc8004_identity: {
            token_id: '42',
            chain_id: 84532,
            agent_card_url: '',
            owner_address: '0xabc',
            verified_at: '2026-05-10T00:00:00.000Z',
            agent_registry: 'reg-1',
            agent_slug: 'bound-agent',
          },
        },
      ]);

      const result = await discoveryService.discover({});
      expect(result.agents[0]!.identity).toEqual({
        erc8004_token_id: '42',
        chain_id: 84532,
        verified: true,
      });
    });

    it('AC-2 (WKH-237): discover() surfaces verified:true for an Avalanche Fuji (43113) binding', async () => {
      setupRegistryResponse([
        makeRawAgent({
          id: 'a1',
          slug: 'remit-kyc-validator',
          status: 'active',
          erc8004_token_id: '501',
          erc8004_chain_id: 43113,
        }),
      ]);
      setIdentityRows([
        {
          erc8004_identity: {
            token_id: '501',
            chain_id: 43113,
            agent_card_url: '',
            owner_address: '0xabc',
            verified_at: '2026-05-10T00:00:00.000Z',
            agent_registry: 'reg-1',
            agent_slug: 'remit-kyc-validator',
          },
        },
      ]);

      const result = await discoveryService.discover({});
      expect(result.agents[0]!.identity).toEqual({
        erc8004_token_id: '501',
        chain_id: 43113,
        verified: true,
      });
    });

    // ── MNR-1 (AR de WKH-237) — contraparte negativa del test de arriba ──────
    // INVARIANTE DE SEGURIDAD: una DECLARACIÓN Avalanche en el AgentCard NO
    // alcanza para el badge. Sin fila de binding matcheante en
    // `a2a_agent_keys.erc8004_identity` NO se adjunta `identity`. Hoy el
    // comportamiento sale del `return null` por defecto de
    // `identity.resolveIdentityForAgent`; sin estos tests un refactor del
    // reverse-lookup podría introducir un badge falso sin romper la suite.

    it('AC-2neg (WKH-237/MNR-1): declara Avalanche Fuji (43113) SIN filas de binding → sin badge', async () => {
      setupRegistryResponse([
        makeRawAgent({
          id: 'a1',
          slug: 'remit-kyc-validator',
          status: 'active',
          erc8004_token_id: '501',
          erc8004_chain_id: 43113,
        }),
      ]);
      setIdentityRows([]); // ninguna key activa con erc8004_identity

      const result = await discoveryService.discover({});
      expect(result.agents).toHaveLength(1);
      expect(result.agents[0]!.identity).toBeUndefined();
      expect('identity' in result.agents[0]!).toBe(false);
    });

    it('AC-2neg (WKH-237/MNR-1): declara Avalanche C-Chain (43114) con binding en 43113 (chain no matchea) → sin badge', async () => {
      setupRegistryResponse([
        makeRawAgent({
          id: 'a1',
          slug: 'remit-kyc-validator',
          status: 'active',
          erc8004_token_id: '501',
          erc8004_chain_id: 43114,
        }),
      ]);
      // Token + registry + slug idénticos: lo ÚNICO que no matchea es la chain.
      // El binding de Fuji NO puede surfacear como identidad de mainnet.
      setIdentityRows([
        {
          erc8004_identity: {
            token_id: '501',
            chain_id: 43113,
            agent_card_url: '',
            owner_address: '0xabc',
            verified_at: '2026-05-10T00:00:00.000Z',
            agent_registry: 'reg-1',
            agent_slug: 'remit-kyc-validator',
          },
        },
      ]);

      const result = await discoveryService.discover({});
      expect(result.agents[0]!.identity).toBeUndefined();
    });

    it('AC-2neg (WKH-237/MNR-1): declaración CAIP-10 Avalanche válida sin binding → sin badge', async () => {
      setupRegistryResponse([
        makeRawAgent({
          id: 'a1',
          slug: 'remit-corridor-fx',
          status: 'active',
          registrations: [{ agentId: `eip155:43113:0x${'e'.repeat(40)}/77` }],
        }),
      ]);
      setIdentityRows([]);

      const result = await discoveryService.discover({});
      expect(result.agents[0]!.identity).toBeUndefined();
      expect('identity' in result.agents[0]!).toBe(false);
      // Control anti-vacuidad: la declaración CAIP-10 SÍ se parseó (el
      // reverse-lookup se consultó), o sea el "sin badge" viene del cruce contra
      // los bindings y no de una declaración descartada antes de la query.
      const { supabase } = await import('../lib/supabase.js');
      expect(vi.mocked(supabase.from)).toHaveBeenCalledWith('a2a_agent_keys');
    });

    it('AC-9: discover() leaves identity absent when agent declares nothing (skip, no query)', async () => {
      setupRegistryResponse([
        makeRawAgent({ id: 'a1', slug: 'plain-agent', status: 'active' }),
      ]);
      // Even if a binding exists in the DB, no declaration → no badge.
      setIdentityRows([
        {
          erc8004_identity: {
            token_id: '42',
            chain_id: 84532,
            agent_card_url: '',
            owner_address: '0xabc',
            verified_at: '2026-05-10T00:00:00.000Z',
            agent_registry: 'reg-1',
            agent_slug: 'plain-agent',
          },
        },
      ]);

      const result = await discoveryService.discover({});
      expect(result.agents[0]!.identity).toBeUndefined();
      expect('identity' in result.agents[0]!).toBe(false);
    });

    it('SEC-INV (MNR-1): attacker agent declares victim token V → no badge (inverse vector)', async () => {
      // The attacker controls agent (test-registry, attacker) and declares the
      // victim's public token 100 in its card. The victim's binding declares
      // operating (test-registry, victim), NOT the attacker → no badge.
      setupRegistryResponse([
        makeRawAgent({
          id: 'a1',
          slug: 'attacker',
          status: 'active',
          erc8004_token_id: '100',
          erc8004_chain_id: 84532,
        }),
      ]);
      setIdentityRows([
        {
          erc8004_identity: {
            token_id: '100',
            chain_id: 84532,
            agent_card_url: '',
            owner_address: '0xvictim',
            verified_at: '2026-05-10T00:00:00.000Z',
            agent_registry: 'reg-1',
            agent_slug: 'victim',
          },
        },
      ]);

      const result = await discoveryService.discover({});
      expect(result.agents[0]!.identity).toBeUndefined();
    });

    it('SEC-ORIG: classic slug spoof stays closed (binding declares a different agent)', async () => {
      // Agent declares token 200 but no binding for 200 declares this agent.
      setupRegistryResponse([
        makeRawAgent({
          id: 'a1',
          slug: 'victim',
          status: 'active',
          erc8004_token_id: '200',
          erc8004_chain_id: 84532,
        }),
      ]);
      // Attacker bound a DIFFERENT token (300) declaring victim's slug — must
      // be ignored (token mismatch AND the bind declares victim, not attacker).
      setIdentityRows([
        {
          erc8004_identity: {
            token_id: '300',
            chain_id: 84532,
            agent_card_url: '',
            owner_address: '0xattacker',
            verified_at: '2026-05-10T00:00:00.000Z',
            agent_registry: 'reg-1',
            agent_slug: 'victim',
          },
        },
      ]);

      const result = await discoveryService.discover({});
      expect(result.agents[0]!.identity).toBeUndefined();
    });

    it('SEC-LEGACY (AC-9): binding v1 without anchors → no badge in discover', async () => {
      setupRegistryResponse([
        makeRawAgent({
          id: 'a1',
          slug: 'bound-agent',
          status: 'active',
          erc8004_token_id: '42',
          erc8004_chain_id: 84532,
        }),
      ]);
      setIdentityRows([
        {
          erc8004_identity: {
            token_id: '42',
            chain_id: 84532,
            agent_card_url: '',
            owner_address: '0xabc',
            verified_at: '2026-05-10T00:00:00.000Z',
            // v1 binding: no agent_registry / agent_slug
          },
        },
      ]);

      const result = await discoveryService.discover({});
      expect(result.agents[0]!.identity).toBeUndefined();
    });

    it('DT-18: DB failure during enrich → agent without identity, discover NOT broken', async () => {
      setupRegistryResponse([
        makeRawAgent({
          id: 'a1',
          slug: 'plain-agent',
          status: 'active',
          erc8004_token_id: '42',
          erc8004_chain_id: 84532,
        }),
      ]);
      setIdentityError(new Error('db blew up'));

      const result = await discoveryService.discover({});
      expect(result.agents).toHaveLength(1);
      expect(result.agents[0]!.identity).toBeUndefined();
    });

    it('SEC-MATCH: getAgent() sets identity when binding declares THIS agent', async () => {
      vi.mocked(registryService.getEnabled).mockResolvedValue([
        makeRegistry({ agentEndpoint: 'https://example.com/agent/{slug}' }),
      ]);
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve(
            makeRawAgent({
              id: 'a1',
              slug: 'bound-agent',
              status: 'active',
              erc8004_token_id: '7',
              erc8004_chain_id: 84532,
            }),
          ),
      });
      setIdentityRows([
        {
          erc8004_identity: {
            token_id: '7',
            chain_id: 84532,
            agent_card_url: '',
            owner_address: '0xabc',
            verified_at: '2026-05-10T00:00:00.000Z',
            agent_registry: 'reg-1',
            agent_slug: 'bound-agent',
          },
        },
      ]);

      const agent = await discoveryService.getAgent('bound-agent');
      expect(agent?.identity).toEqual({
        erc8004_token_id: '7',
        chain_id: 84532,
        verified: true,
      });
    });
  });
});

describe('parsePriceSafe (W0 — WAS-V2-3-CLIENT helper)', () => {
  it('T-PARSE-1: number passthrough returns finite positive', () => {
    expect(parsePriceSafe(0.05)).toBe(0.05);
  });
  it('T-PARSE-2: parseable string returns parsed number', () => {
    expect(parsePriceSafe('0.05')).toBe(0.05);
  });
  it('T-PARSE-3: non-parseable string returns 0', () => {
    expect(parsePriceSafe('free')).toBe(0);
    expect(parsePriceSafe('N/A')).toBe(0);
  });
  it('T-PARSE-4: null/undefined return 0', () => {
    expect(parsePriceSafe(null)).toBe(0);
    expect(parsePriceSafe(undefined)).toBe(0);
  });
  it('T-PARSE-5: negative/NaN/Infinity return 0 (CD-7 safe floor)', () => {
    expect(parsePriceSafe(-1.0)).toBe(0);
    expect(parsePriceSafe(Number.NaN)).toBe(0);
    expect(parsePriceSafe(Number.POSITIVE_INFINITY)).toBe(0);
    expect(parsePriceSafe(Number.NEGATIVE_INFINITY)).toBe(0);
  });
  it('T-PARSE-6: empty string returns 0 (AB-WKH-53-#3 edge)', () => {
    expect(parsePriceSafe('')).toBe(0);
  });
});

function makeV2RawAgent(
  o: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'v2-agent-1',
    slug: 'v2-agent',
    name: 'V2 Agent',
    description: 'descr',
    capabilities: ['x'],
    status: 'active',
    ...o,
  };
}

function makeV2Registry(): RegistryConfig {
  return makeRegistry({
    schema: {
      discovery: {
        agentMapping: { price: 'price_per_call_usdc' },
      },
      invoke: { method: 'POST' },
    },
  });
}

describe('mapAgent — v2 schema drift fallback (WAS-V2-3-CLIENT)', () => {
  const warnSpy = logSpy.warn;
  beforeEach(() => {
    _resetFallbackWarnDedup(); // CD-11: reset Set per test
    warnSpy.mockClear();
  });
  afterEach(() => {
    warnSpy.mockClear();
  });

  it('T-fallback-numeric: takes price_per_call when canonical is null (AC-1)', () => {
    const reg = makeV2Registry();
    const raw = makeV2RawAgent({
      price_per_call_usdc: null,
      price_per_call: 0.05,
    });
    const agent = discoveryService.mapAgent(reg, raw);
    expect(agent.priceUsdc).toBe(0.05);
  });

  it('T-fallback-undefined-canonical: takes price_per_call when canonical absent (AC-1)', () => {
    const reg = makeV2Registry();
    const raw = makeV2RawAgent({ price_per_call: 0.1 });
    const agent = discoveryService.mapAgent(reg, raw);
    expect(agent.priceUsdc).toBe(0.1);
  });

  it('T-canonical-wins: canonical numeric wins over populated fallback (AC-2)', () => {
    const reg = makeV2Registry();
    const raw = makeV2RawAgent({
      price_per_call_usdc: 0.2,
      price_per_call: 0.99,
    });
    const agent = discoveryService.mapAgent(reg, raw);
    expect(agent.priceUsdc).toBe(0.2);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('T-canonical-zero-wins: canonical 0 wins over fallback (AC-2 edge / CD-2)', () => {
    const reg = makeV2Registry();
    const raw = makeV2RawAgent({
      price_per_call_usdc: 0,
      price_per_call: 0.05,
    });
    const agent = discoveryService.mapAgent(reg, raw);
    expect(agent.priceUsdc).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('T-both-null: both null returns 0 with no warn (AC-3)', () => {
    const reg = makeV2Registry();
    const raw = makeV2RawAgent({
      price_per_call_usdc: null,
      price_per_call: null,
    });
    const agent = discoveryService.mapAgent(reg, raw);
    expect(agent.priceUsdc).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('T-fallback-string-parseable: parses string fallback (AC-5 happy)', () => {
    const reg = makeV2Registry();
    const raw = makeV2RawAgent({
      price_per_call_usdc: null,
      price_per_call: '0.05',
    });
    const agent = discoveryService.mapAgent(reg, raw);
    expect(agent.priceUsdc).toBe(0.05);
  });

  it('T-fallback-string-non-parseable: non-parseable returns 0 (AC-5 sad)', () => {
    const reg = makeV2Registry();
    const raw = makeV2RawAgent({
      price_per_call_usdc: null,
      price_per_call: 'free',
    });
    const agent = discoveryService.mapAgent(reg, raw);
    expect(agent.priceUsdc).toBe(0);
  });

  it('T-warn-emitted-on-fallback: emits 1 warn referencing slug (AC-6)', () => {
    const reg = makeV2Registry();
    const raw = makeV2RawAgent({
      price_per_call_usdc: null,
      price_per_call: 0.05,
    });
    discoveryService.mapAgent(reg, raw);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // object-first / message-second: slug lives in the structured context,
    // the human message references the fallback.
    expect(warnSpy.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ slug: 'v2-agent' }),
    );
    expect(String(warnSpy.mock.calls[0]![1])).toContain('fallback');
  });

  it('T-warn-once-per-slug: same slug fallback called twice → 1 warn (AC-6 dedup)', () => {
    const reg = makeV2Registry();
    const raw = makeV2RawAgent({
      price_per_call_usdc: null,
      price_per_call: 0.05,
    });
    discoveryService.mapAgent(reg, raw);
    discoveryService.mapAgent(reg, raw);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

// ── WKH-103: reputation enrichment in /discover (W2 + W4) ──────────────────
describe('discover — reputation enrichment (WKH-103)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setIdentityRows([]);
    setReputationBatch([]);
  });

  // T-AC1: discover enriches computedReputation from the batch, no RPC.
  it('T-AC1: enriches computedReputation from the batch (off-chain, no RPC)', async () => {
    setupRegistryResponse([
      makeRawAgent({ id: 'a1', slug: 'agent-1', status: 'active' }),
    ]);
    setReputationBatch([['agent-1', makeRep({ score: 77 })]]);

    const result = await discoveryService.discover({});

    expect(result.agents[0]!.computedReputation?.score).toBe(77);
    expect(result.agents[0]!.computedReputation?.source).toBe('off-chain');
  });

  // T-AC6: sort uses computedReputation.score desc, falls back to upstream.
  it('T-AC6: sort ranks by computedReputation.score desc within verified tier', async () => {
    setupRegistryResponse([
      makeRawAgent({
        id: 'a1',
        slug: 'low',
        verified: true,
        reputation: 99, // upstream high, but computed wins
      }),
      makeRawAgent({
        id: 'a2',
        slug: 'high',
        verified: true,
        reputation: 1,
      }),
    ]);
    setReputationBatch([
      ['low', makeRep({ score: 10 })],
      ['high', makeRep({ score: 90 })],
    ]);

    const result = await discoveryService.discover({});

    expect(result.agents[0]!.slug).toBe('high');
    expect(result.agents[1]!.slug).toBe('low');
  });

  it('T-AC6 fallback: agents without computed score fall back to upstream reputation', async () => {
    setupRegistryResponse([
      makeRawAgent({ id: 'a1', slug: 'no-score', reputation: 80 }),
      makeRawAgent({ id: 'a2', slug: 'has-score', reputation: 5 }),
    ]);
    // only has-score gets a computed score, below the upstream of no-score
    setReputationBatch([['has-score', makeRep({ score: 10 })]]);

    const result = await discoveryService.discover({});

    // no-score uses upstream 80, beats has-score computed 10
    expect(result.agents[0]!.slug).toBe('no-score');
  });

  // B5 (audit 2026-06-24): un agente con reputation no numérica/ausente
  // (Number(undefined)=NaN) NO debe romper el sort. `?? 0` no captura NaN;
  // Number.isFinite sí → ese agente ordena como 0, detrás del que sí tiene rep.
  it('B5: agent with non-numeric/absent reputation sorts as 0 without breaking the sort', async () => {
    setupRegistryResponse([
      // reputation ausente → mapAgent hace Number(undefined) = NaN
      makeRawAgent({ id: 'a1', slug: 'nan-rep', reputation: undefined }),
      makeRawAgent({ id: 'a2', slug: 'real-rep', reputation: 50 }),
      // reputation string no parseable → NaN también
      makeRawAgent({ id: 'a3', slug: 'str-rep', reputation: 'high' }),
    ]);
    setReputationBatch([]); // sin computed scores → cae al upstream reputation

    const result = await discoveryService.discover({});

    // El agente con reputation real (50) queda primero; los NaN ordenan como 0.
    expect(result.agents[0]!.slug).toBe('real-rep');
    // El sort no rompe: los 3 agentes están presentes.
    expect(result.agents.map((a) => a.slug).sort()).toEqual([
      'nan-rep',
      'real-rep',
      'str-rep',
    ]);
  });

  // T-AC4: batch throws → discover responds without the field, no 5xx.
  it('T-AC4: computeReputationBatch throwing does not break discover', async () => {
    setupRegistryResponse([
      makeRawAgent({ id: 'a1', slug: 'agent-1', status: 'active' }),
    ]);
    mockComputeBatch.mockRejectedValue(new Error('db down'));

    const result = await discoveryService.discover({});

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]!.computedReputation).toBeUndefined();
  });

  // T-NO-N+1 (e2e): N agents → computeReputationBatch called ONCE with all slugs.
  it('T-NO-N+1: batch is called exactly once with all slugs regardless of N', async () => {
    setupRegistryResponse([
      makeRawAgent({ id: 'a1', slug: 's1', status: 'active' }),
      makeRawAgent({ id: 'a2', slug: 's2', status: 'active' }),
      makeRawAgent({ id: 'a3', slug: 's3', status: 'active' }),
    ]);
    setReputationBatch([]);

    await discoveryService.discover({});

    expect(mockComputeBatch).toHaveBeenCalledTimes(1);
    expect(mockComputeBatch).toHaveBeenCalledWith(['s1', 's2', 's3']);
  });

  // T-BACKWARD (e2e): no events → no computedReputation, shape intact.
  it('T-BACKWARD: agents without reputation have no computedReputation key', async () => {
    setupRegistryResponse([
      makeRawAgent({ id: 'a1', slug: 'agent-1', status: 'active' }),
    ]);
    setReputationBatch([]);

    const result = await discoveryService.discover({});

    expect('computedReputation' in result.agents[0]!).toBe(false);
  });
});

// ── WKH-157: free-text (q) broaden-retry ───────────────────────────────
// When a registry forwards `q` to its own strict search backend, relevant
// agents can be dropped before the permissive local substring filter runs.
// discover() retries ONCE without forwarding q upstream — gated on
// `total === 0 && query.query` truthy so the planner path (capabilities-only,
// no `query`) never triggers it (money-path safe, mirror of WKH-151).
describe('discover — free-text broaden-retry (WKH-157)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setIdentityRows([]);
    setReputationBatch([]);
  });

  // Registry whose schema forwards `q` upstream (queryParam configured), so the
  // first attempt actually appends `q` to the fetch URL.
  function makeSearchRegistry(): RegistryConfig {
    return makeRegistry({
      schema: {
        discovery: { queryParam: 'q' },
        invoke: { method: 'POST' },
      },
    });
  }

  function urlHasQ(input: unknown): boolean {
    return new URL(String(input)).searchParams.has('q');
  }

  it('AC-1: 0 upstream with q but a local substring match → retry without upstream q recovers the agent; queryRegistry called 2x (2nd without q)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([
      makeSearchRegistry(),
    ]);
    const spy = vi.spyOn(discoveryService, 'queryRegistry');
    // Fetch branches on whether `q` was forwarded: with q the registry's strict
    // backend drops everything; without q it returns the full set, which the
    // local substring filter then narrows to the sentiment match.
    mockFetch.mockImplementation((input: unknown) => {
      if (urlHasQ(input)) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve([
            makeRawAgent({
              id: 's1',
              slug: 'sentiment-analyzer',
              name: 'Sentiment Analyzer',
              capabilities: ['sentiment'],
              status: 'active',
            }),
            makeRawAgent({
              id: 'o1',
              slug: 'weather-bot',
              name: 'Weather Bot',
              capabilities: ['weather'],
              status: 'active',
            }),
          ]),
      });
    });

    const result = await discoveryService.discover({ query: 'sentiment' });

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]!.slug).toBe('sentiment-analyzer');
    // 1 registry × 2 attempts = 2 queryRegistry calls; the retry passes
    // skipUpstreamQuery=true.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]![2]).toBe(false);
    expect(spy.mock.calls[1]![2]).toBe(true);
    // The second fetch omits the q param entirely.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(urlHasQ(mockFetch.mock.calls[0]![0])).toBe(true);
    expect(urlHasQ(mockFetch.mock.calls[1]![0])).toBe(false);
    // Retry telemetry (AC-7).
    expect(logSpy.info).toHaveBeenCalledTimes(1);
  });

  it('AC-2: q returns ≥1 agent on the first attempt → NO retry (1 queryRegistry call)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([
      makeSearchRegistry(),
    ]);
    const spy = vi.spyOn(discoveryService, 'queryRegistry');
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          makeRawAgent({
            id: 's1',
            slug: 'sentiment-analyzer',
            name: 'Sentiment Analyzer',
            capabilities: ['sentiment'],
            status: 'active',
          }),
        ]),
    });

    const result = await discoveryService.discover({ query: 'sentiment' });

    expect(result.agents).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(logSpy.info).not.toHaveBeenCalled();
  });

  it('AC-4 (planner path): discover({capabilities,maxPrice,limit}) with 0 result does NOT retry (no query.query)', async () => {
    // Exactly the shape orchestrate.ts:520-524 passes — no `query` field.
    vi.mocked(registryService.getEnabled).mockResolvedValue([
      makeSearchRegistry(),
    ]);
    const spy = vi.spyOn(discoveryService, 'queryRegistry');
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          makeRawAgent({
            id: 't1',
            slug: 'translator',
            name: 'Translator',
            capabilities: ['translation'],
            status: 'active',
          }),
        ]),
    });

    const result = await discoveryService.discover({
      capabilities: ['image-generation'],
      maxPrice: 1,
      limit: 5,
    });

    expect(result.agents).toHaveLength(0);
    // No query.query → gate never fires, even though the result is 0.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(logSpy.info).not.toHaveBeenCalled();
  });

  it('AC-3: retry also 0 → returns the empty result (agents:[], total:0) with exactly one retry (no loop)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([
      makeSearchRegistry(),
    ]);
    const spy = vi.spyOn(discoveryService, 'queryRegistry');
    mockFetch.mockImplementation((input: unknown) => {
      if (urlHasQ(input)) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      // Retry: registry returns agents, but none match the free-text.
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve([
            makeRawAgent({
              id: 'w1',
              slug: 'weather-bot',
              name: 'Weather Bot',
              capabilities: ['weather'],
              status: 'active',
            }),
          ]),
      });
    });

    const result = await discoveryService.discover({
      query: 'nonexistent-capability',
    });

    expect(result.agents).toHaveLength(0);
    expect(result.total).toBe(0);
    // Exactly one retry — CD-3: no loop.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(logSpy.info).toHaveBeenCalledTimes(1);
  });

  // NIT-2 (CR): AC-1 above returns a single agent, so the verified-first →
  // reputation → price sort is never exercised ON the retried path (only on the
  // direct path via the WKH-103 sort tests). This asserts the sort — the same
  // extracted block — actually runs INSIDE runDiscoveryPipeline when called with
  // skipUpstreamQuery=true. Genuinely discriminant: the expected order is the
  // INVERSE of both insertion order and price, so a no-op/trivial sort would
  // fail. price is inversely correlated with verified (the verified agents are
  // the pricey ones) → the only thing that can produce the asserted order is the
  // verified-first → reputation(desc) → price sort running on the retry result.
  it('NIT-2: retry path applies verified-first → reputation → price sort (≥2 agents, order inverse to insertion/price)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([
      makeSearchRegistry(),
    ]);
    const spy = vi.spyOn(discoveryService, 'queryRegistry');
    // First attempt (q forwarded) → strict backend drops everything. Retry
    // (no q) → returns the full set in an order that is WRONG for the sort:
    // the cheapest, highest-reputation agent is unverified and listed first.
    mockFetch.mockImplementation((input: unknown) => {
      if (urlHasQ(input)) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve([
            // Insertion-first, cheapest, best upstream rep — but UNVERIFIED,
            // so the sort must push it LAST.
            makeRawAgent({
              id: 'u1',
              slug: 'budget-unverified',
              name: 'Budget Payments',
              capabilities: ['payments'],
              status: 'active',
              verified: false,
              price: 1,
              reputation: 99,
            }),
            // Verified but LOWER reputation → must land 2nd (behind the
            // higher-rep verified agent) despite equal price.
            makeRawAgent({
              id: 'v2',
              slug: 'premium-lowrep',
              name: 'Premium Payments B',
              capabilities: ['payments'],
              status: 'active',
              verified: true,
              price: 100,
              reputation: 10,
            }),
            // Verified + HIGHEST reputation → must land 1st despite being the
            // priciest and listed last.
            makeRawAgent({
              id: 'v1',
              slug: 'premium-hirep',
              name: 'Premium Payments A',
              capabilities: ['payments'],
              status: 'active',
              verified: true,
              price: 100,
              reputation: 80,
            }),
          ]),
      });
    });

    const result = await discoveryService.discover({ query: 'pay' });

    // Retry fired: 2 queryRegistry calls, 2nd with skipUpstreamQuery=true; the
    // 2nd fetch omits q.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]![2]).toBe(false);
    expect(spy.mock.calls[1]![2]).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(urlHasQ(mockFetch.mock.calls[1]![0])).toBe(false);
    expect(logSpy.info).toHaveBeenCalledTimes(1);

    // The sort ran INSIDE the retried runDiscoveryPipeline: verified-first, then
    // reputation desc, then price asc — the exact inverse of insertion order.
    expect(result.agents).toHaveLength(3);
    expect(result.agents.map((a) => a.slug)).toEqual([
      'premium-hirep', // verified + rep 80
      'premium-lowrep', // verified + rep 10
      'budget-unverified', // unverified (last despite cheapest + rep 99)
    ]);
    expect(result.agents[0]!.verified).toBe(true);
    expect(result.agents[2]!.verified).toBe(false);
  });
});
