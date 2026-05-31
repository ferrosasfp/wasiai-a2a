/**
 * WKH-113 (BASE-08) — discovery→compose chain-flow integration.
 *
 * Verifies that the real per-chain payment (emitted by the capabilities/
 * discover path) survives `resolveAgent` and reaches `signAndSettleDownstream`,
 * WITHOUT mocking `agent.payment` as a prefabricated output of resolveAgent
 * (lesson WKH-112). Instead we simulate the real getAgent↔discover divergence:
 *   - getAgent → payment.chain='avalanche'   (what the v2 endpoint hardcodes)
 *   - discover → payment.chain='base-sepolia' (what capabilities emits per-row)
 *
 * CD-8 no-op: when both endpoints agree (Avalanche/Kite) the agent is byte-
 * identical. CD-10 fail-soft: when discover does not bring the agent, the
 * getAgent payment is preserved (no Base assumption).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, RegistryConfig } from '../types/index.js';

vi.mock('./registry.js', () => ({ registryService: { getEnabled: vi.fn() } }));
vi.mock('./budget.js', () => ({
  budgetService: {
    debit: vi.fn(),
    getBalance: vi.fn(),
    registerDeposit: vi.fn(),
  },
}));
const mockSign = vi.fn();
const mockSettle = vi.fn();
vi.mock('../adapters/registry.js', () => ({
  getPaymentAdapter: () => ({ sign: mockSign, settle: mockSettle }),
}));
// CD-11: the discovery mock MUST export BOTH getAgent and discover, because
// the real compose.resolveAgent path exercised here calls discover().
vi.mock('./discovery.js', () => ({
  discoveryService: { getAgent: vi.fn(), discover: vi.fn() },
}));
vi.mock('./event.js', () => ({
  eventService: { track: vi.fn().mockResolvedValue({}) },
}));
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);
vi.mock('./llm/transform.js', () => ({
  maybeTransform: vi.fn().mockResolvedValue({
    transformedOutput: null,
    cacheHit: 'SKIPPED',
    bridgeType: 'SKIPPED',
    latencyMs: 0,
  }),
}));
vi.mock('../lib/downstream-payment.js', () => ({
  signAndSettleDownstream: vi.fn().mockResolvedValue(null),
}));

import { signAndSettleDownstream } from '../lib/downstream-payment.js';
import { composeService } from './compose.js';
import { discoveryService } from './discovery.js';
import { registryService } from './registry.js';

const mockDownstream = vi.mocked(signAndSettleDownstream);

function makeAgent(o: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    slug: 'base-pay-agent',
    description: 'A test agent',
    capabilities: ['test'],
    priceUsdc: 0,
    registry: 'test-registry',
    registry_id: 'test-registry',
    invokeUrl: 'https://example.com/invoke',
    invocationNote: 'Use POST /compose or POST /orchestrate on the gateway.',
    verified: false,
    status: 'active',
    metadata: {},
    ...o,
  };
}

function makeRegistry(o: Partial<RegistryConfig> = {}): RegistryConfig {
  return {
    id: 'reg-1',
    name: 'test-registry',
    discoveryEndpoint: 'https://example.com/discover',
    invokeEndpoint: 'https://example.com/invoke/{slug}',
    schema: { discovery: {}, invoke: { method: 'POST' } },
    enabled: true,
    createdAt: new Date(),
    ownerRef: 'system',
    ...o,
  };
}

function mockFetchOk(data: unknown = { result: 'ok' }) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => data,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(discoveryService.getAgent).mockResolvedValue(null);
  vi.mocked(discoveryService.discover).mockResolvedValue({
    agents: [],
    total: 0,
    registries: [],
  });
  mockDownstream.mockResolvedValue(null);
});

describe('WKH-113 chain-flow — discovery→compose (BASE-08)', () => {
  it('T-AC3-flow: real Base chain survives resolveAgent (getAgent=avalanche, discover=base-sepolia)', async () => {
    // getAgent emits the v2-hardcoded chain.
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(
      makeAgent({
        slug: 'base-pay-agent',
        payment: {
          method: 'x402',
          chain: 'avalanche',
          contract: '0x000000000000000000000000000000000000aBcD',
        },
      }),
    );
    // discover (capabilities) emits the real per-row chain.
    vi.mocked(discoveryService.discover).mockResolvedValueOnce({
      agents: [
        makeAgent({
          slug: 'base-pay-agent',
          payment: {
            method: 'x402',
            chain: 'base-sepolia',
            contract: '0x000000000000000000000000000000000000aBcD',
          },
        }),
      ],
      total: 1,
      registries: ['test-registry'],
    });

    const agent = await composeService.resolveAgent({
      agent: 'base-pay-agent',
      input: {},
    });

    expect(agent).not.toBeNull();
    expect(agent?.payment?.chain).toBe('base-sepolia');
  });

  it('T-AC3-flow (settle border): base-sepolia chain reaches signAndSettleDownstream via compose', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([makeRegistry()]);
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(
      makeAgent({
        slug: 'base-pay-agent',
        priceUsdc: 0,
        payment: {
          method: 'x402',
          chain: 'avalanche',
          contract: '0x000000000000000000000000000000000000aBcD',
        },
      }),
    );
    vi.mocked(discoveryService.discover).mockResolvedValueOnce({
      agents: [
        makeAgent({
          slug: 'base-pay-agent',
          priceUsdc: 0,
          payment: {
            method: 'x402',
            chain: 'base-sepolia',
            contract: '0x000000000000000000000000000000000000aBcD',
          },
        }),
      ],
      total: 1,
      registries: ['test-registry'],
    });
    mockFetchOk();

    const result = await composeService.compose({
      steps: [{ agent: 'base-pay-agent', input: { q: 'x' } }],
    });

    expect(result.success).toBe(true);
    expect(mockDownstream).toHaveBeenCalledTimes(1);
    const agentAtSettle = mockDownstream.mock.calls[0][0] as Agent;
    expect(agentAtSettle.payment?.chain).toBe('base-sepolia');
  });

  it('T-CD8a: merge no-op for avalanche (getAgent=avalanche, discover=avalanche)', async () => {
    const getAgentPayment = {
      method: 'x402',
      chain: 'avalanche',
      contract: '0x000000000000000000000000000000000000aBcD' as `0x${string}`,
    };
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(
      makeAgent({ slug: 'avax-pay-agent', payment: getAgentPayment }),
    );
    vi.mocked(discoveryService.discover).mockResolvedValueOnce({
      agents: [
        makeAgent({
          slug: 'avax-pay-agent',
          payment: {
            method: 'x402',
            chain: 'avalanche',
            contract: '0x000000000000000000000000000000000000aBcD',
          },
        }),
      ],
      total: 1,
      registries: ['test-registry'],
    });

    const agent = await composeService.resolveAgent({
      agent: 'avax-pay-agent',
      input: {},
    });

    // No cross-chain change: chain identical to the getAgent payment.
    expect(agent?.payment?.chain).toBe('avalanche');
    // CD-8 no-op: the original getAgent payment object is preserved untouched.
    expect(agent?.payment).toBe(getAgentPayment);
  });

  it('T-CD8b: merge no-op for kite (getAgent=kite-ozone-testnet, discover=kite-ozone-testnet)', async () => {
    const getAgentPayment = {
      method: 'x402',
      chain: 'kite-ozone-testnet',
      contract: '0x000000000000000000000000000000000000bEeF' as `0x${string}`,
    };
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(
      makeAgent({ slug: 'kite-pay-agent', payment: getAgentPayment }),
    );
    vi.mocked(discoveryService.discover).mockResolvedValueOnce({
      agents: [
        makeAgent({
          slug: 'kite-pay-agent',
          payment: {
            method: 'x402',
            chain: 'kite-ozone-testnet',
            contract: '0x000000000000000000000000000000000000bEeF',
          },
        }),
      ],
      total: 1,
      registries: ['test-registry'],
    });

    const agent = await composeService.resolveAgent({
      agent: 'kite-pay-agent',
      input: {},
    });

    expect(agent?.payment?.chain).toBe('kite-ozone-testnet');
    expect(agent?.payment).toBe(getAgentPayment);
  });

  it('T-CD10: discover does not bring the agent → fail-soft, keep getAgent payment (no Base assumption)', async () => {
    const getAgentPayment = {
      method: 'x402',
      chain: 'avalanche',
      contract: '0x000000000000000000000000000000000000aBcD' as `0x${string}`,
    };
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(
      makeAgent({ slug: 'avax-pay-agent', payment: getAgentPayment }),
    );
    // discover returns no agents → real is undefined.
    vi.mocked(discoveryService.discover).mockResolvedValueOnce({
      agents: [],
      total: 0,
      registries: ['test-registry'],
    });

    const agent = await composeService.resolveAgent({
      agent: 'avax-pay-agent',
      input: {},
    });

    // Fail-soft: getAgent payment preserved unchanged (no cross-chain).
    expect(agent?.payment?.chain).toBe('avalanche');
    expect(agent?.payment).toBe(getAgentPayment);
  });
});
