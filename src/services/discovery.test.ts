/**
 * Tests for Discovery Service — verified + status filters (WKH-DISCOVER-VERIFIED)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegistryConfig } from '../types/index.js';

// Mock registry service
vi.mock('./registry.js', () => ({
  registryService: {
    getEnabled: vi.fn(),
    get: vi.fn(),
  },
}));

// Mock circuit breaker
vi.mock('../lib/circuit-breaker.js', () => ({
  getRegistryCircuitBreaker: () => ({
    execute: (fn: () => Promise<Response>) => fn(),
  }),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// WKH-100 FIX-PACK: discover()/getAgent() reverse-lookup ERC-8004 identity by
// the token the agent declares. Mock the supabase client so the REAL
// resolveIdentityForToken runs deterministically (no network). `setIdentityRows`
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

import type { Agent } from '../types/index.js';
import {
  _resetFallbackWarnDedup,
  discoveryService,
  extractDeclaredTokenId,
  parsePriceSafe,
} from './discovery.js';
import { identityService } from './identity.js';
import { registryService } from './registry.js';

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
      expect(result.agents[0].slug).toBe('active-1');
      expect(result.agents[0].status).toBe('active');
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
      expect(result.agents[0].slug).toBe('verified-1');
      expect(result.agents[0].verified).toBe(true);
    });
  });

  describe('AC-5 + AC-6: mapAgent defaults', () => {
    it('defaults verified to false and status to active when absent', async () => {
      setupRegistryResponse([makeRawAgent({ id: 'a1', slug: 'bare-agent' })]);

      const result = await discoveryService.discover({});

      expect(result.agents[0].verified).toBe(false);
      expect(result.agents[0].status).toBe('active');
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

      expect(result.agents[0].slug).toBe('verified');
      expect(result.agents[1].slug).toBe('unverified');
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
    it('mapAgent accepts chain="avalanche-mainnet" and normalizes to "avalanche"', () => {
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
        chain: 'avalanche', // normalized
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
      expect(result.agents[0].payment).toBeDefined();
      // Discovery normalizes avalanche-testnet → avalanche (canonical), independent
      // of the middleware ChainKey normalizer (avalanche-fuji). See SDD R-8.
      expect(result.agents[0].payment?.chain).toBe('avalanche');
      expect(result.agents[0].payment?.asset).toBe('USDC');
      expect(result.agents[0].payment?.method).toBe('x402');
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
      expect(result.agents[0].slug).toBe('kite-pay-agent');
      expect(result.agents[0].payment?.chain).toBe('kite-ozone-testnet');
      expect(result.agents[0].payment?.asset).toBe('PYUSD');
      expect(result.agents[0].payment?.method).toBe('x402');
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
      expect(result.agents[0].slug).toBe('free-agent');
      expect(result.agents[0].payment).toBeUndefined();
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

    it('T-AC2a: regression — avalanche variants collapse to "avalanche" (CD-7, NOT avalanche-fuji)', () => {
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

      const mainnet = discoveryService.mapAgent(
        makeRegistry(),
        makePaymentRaw('avalanche-mainnet'),
      );
      expect(mainnet.payment?.chain).toBe('avalanche');
      expect(mainnet.payment?.chain).not.toBe('avalanche-fuji');
    });

    it('T-AC2b: regression — kite-ozone-testnet passes through unchanged (CD-7)', () => {
      const agent = discoveryService.mapAgent(
        makeRegistry(),
        makePaymentRaw('kite-ozone-testnet'),
      );
      expect(agent.payment?.chain).toBe('kite-ozone-testnet');
    });

    it('T-AC5: unknown chain (polygon/solana) → payment undefined (defense preserved)', () => {
      const polygon = discoveryService.mapAgent(
        makeRegistry(),
        makePaymentRaw('polygon'),
      );
      expect(polygon.payment).toBeUndefined();

      const solana = discoveryService.mapAgent(
        makeRegistry(),
        makePaymentRaw('solana'),
      );
      expect(solana.payment).toBeUndefined();
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
      expect(result.agents[0].slug).toBe('base-pay-agent');
      expect(result.agents[0].payment?.chain).toBe('base-sepolia');
      expect(result.agents[0].payment?.asset).toBe('USDC');
      expect(result.agents[0].payment?.method).toBe('x402');
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
      expect(result.agents[0].payment).toBeDefined();
      expect(result.agents[0].payment?.chain).toBe('avalanche-fuji');
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
  });

  describe('DT-21: resolveIdentityForToken', () => {
    it('match (token_id+chain_id, is_active) → { erc8004_token_id, chain_id, verified:true }', async () => {
      setIdentityRows([
        {
          erc8004_identity: {
            token_id: '42',
            chain_id: 84532,
            agent_card_url: 'https://x',
            owner_address: '0xabc',
            verified_at: '2026-05-10T00:00:00.000Z',
          },
        },
      ]);
      const r = await identityService.resolveIdentityForToken('42', 84532);
      expect(r).toEqual({
        erc8004_token_id: '42',
        chain_id: 84532,
        verified: true,
      });
    });

    it('no match (different token_id) → null', async () => {
      setIdentityRows([
        {
          erc8004_identity: {
            token_id: '1',
            chain_id: 84532,
            agent_card_url: '',
            owner_address: '0xabc',
            verified_at: '2026-05-10T00:00:00.000Z',
          },
        },
      ]);
      expect(
        await identityService.resolveIdentityForToken('42', 84532),
      ).toBeNull();
    });

    it('chainId mismatch → null', async () => {
      setIdentityRows([
        {
          erc8004_identity: {
            token_id: '42',
            chain_id: 8453,
            agent_card_url: '',
            owner_address: '0xabc',
            verified_at: '2026-05-10T00:00:00.000Z',
          },
        },
      ]);
      expect(
        await identityService.resolveIdentityForToken('42', 84532),
      ).toBeNull();
    });

    it('no rows → null', async () => {
      setIdentityRows([]);
      expect(
        await identityService.resolveIdentityForToken('42', 84532),
      ).toBeNull();
    });

    it('CD-2/DT-19: SELECT requests ONLY erc8004_identity (no budget/funding_wallet)', async () => {
      const { supabase } = await import('../lib/supabase.js');
      setIdentityRows([]);
      await identityService.resolveIdentityForToken('42', 84532);
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
        await identityService.resolveIdentityForToken('42', 84532),
      ).toBeNull();
    });
  });

  describe('DT-21: discover()/getAgent() enrich by declared token', () => {
    it('discover() sets identity when declared token is bound+verified', async () => {
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
          },
        },
      ]);

      const result = await discoveryService.discover({});
      expect(result.agents[0].identity).toEqual({
        erc8004_token_id: '42',
        chain_id: 84532,
        verified: true,
      });
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
          },
        },
      ]);

      const result = await discoveryService.discover({});
      expect(result.agents[0].identity).toBeUndefined();
      expect('identity' in result.agents[0]).toBe(false);
    });

    it('SEC anti-spoof: agent declares token V but only token T is bound → no badge', async () => {
      setupRegistryResponse([
        makeRawAgent({
          id: 'a1',
          slug: 'victim',
          status: 'active',
          erc8004_token_id: '100', // victim declares token 100
          erc8004_chain_id: 84532,
        }),
      ]);
      // Attacker bound token 200 (a different token) — victim must NOT inherit it.
      setIdentityRows([
        {
          erc8004_identity: {
            token_id: '200',
            chain_id: 84532,
            agent_card_url: '',
            owner_address: '0xattacker',
            verified_at: '2026-05-10T00:00:00.000Z',
            agent_slug: 'victim', // spoofed slug — must be IGNORED
          },
        },
      ]);

      const result = await discoveryService.discover({});
      expect(result.agents[0].identity).toBeUndefined();
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
      expect(result.agents[0].identity).toBeUndefined();
    });

    it('getAgent() sets identity when declared token is bound+verified', async () => {
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
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    _resetFallbackWarnDedup(); // CD-11: reset Set per test
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
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
    const msg = String(warnSpy.mock.calls[0][0]);
    expect(msg).toContain('v2-agent');
    expect(msg).toContain('fallback');
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
