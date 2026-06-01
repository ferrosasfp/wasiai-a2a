/**
 * Tests for Compose Service -- auth headers + x402 payment
 * 9 tests: T-1 through T-9
 */
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  A2AAgentKeyRow,
  Agent,
  RegistryConfig,
  X402PaymentRequest,
} from '../types/index.js';

vi.mock('./registry.js', () => ({ registryService: { getEnabled: vi.fn() } }));
// WKH-59 (real-price-debit): mock budget service for per-step debit tests.
// CD-14: tests below use mockResolvedValueOnce, not failNext.
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
// WKH-55: mock del modulo downstream-payment (DT-K)
vi.mock('../lib/downstream-payment.js', () => ({
  signAndSettleDownstream: vi.fn().mockResolvedValue(null),
}));

import { signAndSettleDownstream } from '../lib/downstream-payment.js';
import { budgetService } from './budget.js';
import { composeService } from './compose.js';
import { discoveryService } from './discovery.js';
import { eventService } from './event.js';
import { maybeTransform } from './llm/transform.js';
import { registryService } from './registry.js';

const mockDownstream = vi.mocked(signAndSettleDownstream);
const mockDebit = vi.mocked(budgetService.debit);

function makeAgent(o: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    slug: 'test-agent',
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
// WKH-61: helper local de keyRow para tests de scoping (no compartido con
// middleware/a2a-key.test.ts; cada archivo mantiene su propio fixture).
function makeKeyRow(overrides: Partial<A2AAgentKeyRow> = {}): A2AAgentKeyRow {
  return {
    id: 'key-id-test',
    owner_ref: 'owner-test',
    key_hash: crypto.createHash('sha256').update('test').digest('hex'),
    display_name: null,
    budget: { '2368': '10.000000' },
    daily_limit_usd: null,
    daily_spent_usd: '0.000000',
    daily_reset_at: new Date(Date.now() + 86400000).toISOString(),
    allowed_registries: null,
    allowed_agent_slugs: null,
    allowed_categories: null,
    max_spend_per_call_usd: null,
    is_active: true,
    last_used_at: null,
    created_at: '2026-04-27T00:00:00.000Z',
    updated_at: '2026-04-27T00:00:00.000Z',
    erc8004_identity: null,
    kite_passport: null,
    agentkit_wallet: null,
    funding_wallet: null,
    metadata: {},
    ...overrides,
  };
}

function mockFetchOk(data: unknown = { result: 'ok' }) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => data,
  });
}
function mockFetchError(status: number) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    json: async () => ({ error: 'fail' }),
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
  // WKH-55: default downstream mock = null (no-op)
  mockDownstream.mockResolvedValue(null);
  // WKH-59: default debit success (each per-step debit test overrides).
  mockDebit.mockResolvedValue({ success: true });
});

describe('composeService.invokeAgent', () => {
  it('T-1: includes Bearer auth header from registry', async () => {
    const registry = makeRegistry({
      auth: { type: 'bearer', key: 'Authorization', value: 'test-token' },
    });
    vi.mocked(registryService.getEnabled).mockResolvedValue([registry]);
    const agent = makeAgent({ priceUsdc: 0 });
    mockFetchOk();
    await composeService.invokeAgent(agent, { q: 'hello' });
    const callHeaders = mockFetch.mock.calls[0][1].headers as Record<
      string,
      string
    >;
    expect(callHeaders.Authorization).toBe('Bearer test-token');
    expect(callHeaders['PAYMENT-SIGNATURE']).toBeUndefined();
  });

  it('T-2: includes custom header auth from registry', async () => {
    const registry = makeRegistry({
      auth: { type: 'header', key: 'X-API-Key', value: 'abc123' },
    });
    vi.mocked(registryService.getEnabled).mockResolvedValue([registry]);
    const agent = makeAgent({ priceUsdc: 0 });
    mockFetchOk();
    await composeService.invokeAgent(agent, { q: 'hello' });
    const callHeaders = mockFetch.mock.calls[0][1].headers as Record<
      string,
      string
    >;
    expect(callHeaders['X-API-Key']).toBe('abc123');
  });

  it('T-3: generates X-Payment header and settles on success', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const mockPR: X402PaymentRequest = {
      authorization: {
        from: '0xAAA',
        to: '0xBBB',
        value: '1000000000000000000',
        validAfter: '0',
        validBefore: '9999999999',
        nonce: '0x1234',
      },
      signature: '0xSIG',
      network: 'eip155:2368',
    };
    mockSign.mockResolvedValue({
      xPaymentHeader: 'base64mock',
      paymentRequest: mockPR,
    });
    mockSettle.mockResolvedValue({ success: true, txHash: '0xDEADBEEF' });
    const agent = makeAgent({ priceUsdc: 1.0, metadata: { payTo: '0xBBB' } });
    mockFetchOk();
    const result = await composeService.invokeAgent(agent, { q: 'hello' });
    const callHeaders = mockFetch.mock.calls[0][1].headers as Record<
      string,
      string
    >;
    expect(callHeaders['PAYMENT-SIGNATURE']).toBe('base64mock');
    expect(mockSettle).toHaveBeenCalled();
    expect(result.txHash).toBe('0xDEADBEEF');
    expect(result.output).toBe('ok');
  });

  it('T-4: throws when settle fails', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    mockSign.mockResolvedValue({
      xPaymentHeader: 'base64mock',
      paymentRequest: {
        authorization: {
          from: '0xAAA',
          to: '0xBBB',
          value: '1',
          validAfter: '0',
          validBefore: '9999999999',
          nonce: '0x1234',
        },
        signature: '0xSIG',
        network: 'eip155:2368',
      },
    });
    mockSettle.mockResolvedValue({
      success: false,
      txHash: '',
      error: 'insufficient funds',
    });
    const agent = makeAgent({ priceUsdc: 1.0, metadata: { payTo: '0xBBB' } });
    mockFetchOk();
    await expect(
      composeService.invokeAgent(agent, { q: 'hello' }),
    ).rejects.toThrow('x402 settle failed');
  });

  it('T-5: does not settle when agent returns non-2xx', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    mockSign.mockResolvedValue({
      xPaymentHeader: 'base64mock',
      paymentRequest: {
        authorization: {
          from: '0xAAA',
          to: '0xBBB',
          value: '1',
          validAfter: '0',
          validBefore: '9999999999',
          nonce: '0x1234',
        },
        signature: '0xSIG',
        network: 'eip155:2368',
      },
    });
    const agent = makeAgent({ priceUsdc: 1.0, metadata: { payTo: '0xBBB' } });
    mockFetchError(500);
    await expect(
      composeService.invokeAgent(agent, { q: 'hello' }),
    ).rejects.toThrow('returned 500');
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it('T-6: invokes without auth headers when registry not found', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const agent = makeAgent({ priceUsdc: 0 });
    mockFetchOk();
    const result = await composeService.invokeAgent(agent, { q: 'hello' });
    const callHeaders = mockFetch.mock.calls[0][1].headers as Record<
      string,
      string
    >;
    expect(callHeaders['Content-Type']).toBe('application/json');
    expect(callHeaders.Authorization).toBeUndefined();
    expect(result.output).toBe('ok');
  });

  it('T-7: budget check rejects when cost exceeds maxBudget', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const agent1 = makeAgent({
      slug: 'a1',
      priceUsdc: 0.5,
      metadata: { payTo: '0xPAY' },
    });
    const agent2 = makeAgent({
      slug: 'a2',
      priceUsdc: 0.6,
      metadata: { payTo: '0xPAY' },
    });
    vi.mocked(discoveryService.getAgent)
      .mockResolvedValueOnce(agent1)
      .mockResolvedValueOnce(agent2)
      .mockResolvedValueOnce(agent2);
    mockSign.mockResolvedValue({
      xPaymentHeader: 'base64mock',
      paymentRequest: {
        authorization: {
          from: '0xAAA',
          to: '0xPAY',
          value: '1',
          validAfter: '0',
          validBefore: '9999999999',
          nonce: '0x1234',
        },
        signature: '0xSIG',
        network: 'eip155:2368',
      },
    });
    mockSettle.mockResolvedValue({ success: true, txHash: '0xTX' });
    mockFetchOk({ result: 'step1-done' });
    const result = await composeService.compose({
      steps: [
        { agent: 'a1', input: {} },
        { agent: 'a2', input: {} },
      ],
      maxBudget: 1.0,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Budget exceeded');
    expect(result.steps).toHaveLength(1);
  });

  it('T-8: throws when agent.metadata.payTo is missing', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const agent = makeAgent({ priceUsdc: 1.0, metadata: {} });
    await expect(
      composeService.invokeAgent(agent, { q: 'hello' }),
    ).rejects.toThrow('No payTo address');
  });

  it('T-9: console.log never receives private key or raw signature', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    mockSign.mockResolvedValue({
      xPaymentHeader: 'base64mock',
      paymentRequest: {
        authorization: {
          from: '0xAAA',
          to: '0xBBB',
          value: '1',
          validAfter: '0',
          validBefore: '9999999999',
          nonce: '0x1234',
        },
        signature: '0xSECRET_SIG_VALUE',
        network: 'eip155:2368',
      },
    });
    mockSettle.mockResolvedValue({ success: true, txHash: '0xTXHASH' });
    const agent = makeAgent({ priceUsdc: 1.0, metadata: { payTo: '0xBBB' } });
    mockFetchOk();
    const originalPK = process.env.OPERATOR_PRIVATE_KEY;
    process.env.OPERATOR_PRIVATE_KEY = '0xDEAD_PRIVATE_KEY_NEVER_LOG';
    try {
      await composeService.invokeAgent(agent, { q: 'hello' });
    } finally {
      process.env.OPERATOR_PRIVATE_KEY = originalPK;
    }
    for (const call of logSpy.mock.calls) {
      const logStr = call.join(' ');
      expect(logStr).not.toContain('DEAD_PRIVATE_KEY_NEVER_LOG');
      expect(logStr).not.toContain('SECRET_SIG_VALUE');
    }
    logSpy.mockRestore();
  });
});

// ─── WKH-55: Downstream x402 hook (compose service integration) ────
describe('composeService — WKH-55 downstream x402 hook', () => {
  it('does NOT propagate downstream when signAndSettleDownstream returns null (T-W3-01 / AC-1)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    mockDownstream.mockResolvedValue(null);
    const agent = makeAgent({ priceUsdc: 0, payment: undefined });
    mockFetchOk();
    const result = await composeService.invokeAgent(
      agent,
      { foo: 'bar' },
      'k1',
    );
    expect(result.downstream).toBeUndefined();
  });

  it('propagates downstreamTxHash to StepResult when downstream succeeds (T-W3-02 / AC-3)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    mockDownstream.mockResolvedValue({
      txHash: '0xabc',
      blockNumber: 1,
      settledAmount: '500000',
    });
    const agent = makeAgent({
      slug: 'ds-agent',
      priceUsdc: 0,
      payment: {
        method: 'x402',
        chain: 'avalanche',
        contract: '0x000000000000000000000000000000000000aBcD',
      },
    });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);
    mockFetchOk();

    const composeResult = await composeService.compose({
      steps: [{ agent: agent.slug, input: {} }],
    });

    expect(composeResult.success).toBe(true);
    expect(composeResult.steps[0].downstreamTxHash).toBe('0xabc');
    expect(composeResult.steps[0].downstreamBlockNumber).toBe(1);
    expect(composeResult.steps[0].downstreamSettledAmount).toBe('500000');
  });

  it('returns invoke result without downstreamTxHash when downstream fails (T-W3-03 / AC-4)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    mockDownstream.mockResolvedValue(null);
    const agent = makeAgent({ priceUsdc: 0 });
    mockFetchOk();
    const result = await composeService.invokeAgent(agent, {}, 'k1');
    expect(result.output).toBe('ok');
    expect(result.downstream).toBeUndefined();
  });

  it('sends bit-exact same fetch body as baseline when flag off (T-W3-04 / AC-12)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    mockDownstream.mockResolvedValue(null); // simula flag off / no-op
    const agent = makeAgent({ priceUsdc: 0, payment: undefined });
    const input = { task: 'translate', text: 'hola' };
    mockFetchOk();
    await composeService.invokeAgent(agent, input, 'a2a-key-1');

    // Sólo debería haber 1 llamada al marketplace (no facilitator porque downstream es no-op)
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(agent.invokeUrl);
    // AR-MNR-3: pin EXACT method + EXACT header key set when flag-off, en
    // lugar de un toMatchObject permisivo. Si compose agrega un header nuevo
    // sin actualizar este snapshot, el test falla.
    expect(init.method).toBe('POST');
    expect(Object.keys(init.headers).sort()).toEqual(
      ['Content-Type', 'x-a2a-key'].sort(),
    );
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['x-a2a-key']).toBe('a2a-key-1');
    expect(init.body).toBe(JSON.stringify(input));
  });
});

// ─── WKH-56: A2A fast-path bridge (compose service integration) ────
describe('composeService.compose — WKH-56 A2A fast-path bridge', () => {
  it('T-10: A2A_PASSTHROUGH bypasses maybeTransform when output is Message + target a2aCompliant (AC-1)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const transformMock = vi.mocked(maybeTransform);
    transformMock.mockClear();

    const agent1 = makeAgent({
      slug: 'a1',
      id: 'agent-a1',
      priceUsdc: 0,
      metadata: { a2aCompliant: true },
    });
    const agent2 = makeAgent({
      slug: 'a2',
      id: 'agent-a2',
      priceUsdc: 0,
      metadata: {
        a2aCompliant: true,
        inputSchema: { type: 'object', required: ['x'] },
      },
    });
    vi.mocked(discoveryService.getAgent)
      .mockResolvedValueOnce(agent1)
      .mockResolvedValueOnce(agent2)
      .mockResolvedValueOnce(agent2);

    const a2aOutput = {
      role: 'agent',
      parts: [{ kind: 'data', data: { x: 1 } }],
    };
    mockFetchOk({ result: a2aOutput });
    mockFetchOk({ result: 'final' });

    const result = await composeService.compose({
      steps: [
        { agent: 'a1', input: {} },
        { agent: 'a2', input: {}, passOutput: true },
      ],
    });

    expect(result.success).toBe(true);
    expect(transformMock).not.toHaveBeenCalled();
    expect(result.steps[0].bridgeType).toBe('A2A_PASSTHROUGH');
    expect(result.steps[0].transformLatencyMs).toBeLessThan(50);
  });

  it('T-11: falls back to maybeTransform when isA2AMessage returns false (AC-2)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const transformMock = vi.mocked(maybeTransform);
    transformMock.mockClear();
    transformMock.mockResolvedValueOnce({
      transformedOutput: { x: 'transformed' },
      cacheHit: 'SKIPPED',
      bridgeType: 'SKIPPED',
      latencyMs: 0,
    });

    const agent1 = makeAgent({
      slug: 'a1',
      id: 'agent-a1',
      priceUsdc: 0,
    });
    const agent2 = makeAgent({
      slug: 'a2',
      id: 'agent-a2',
      priceUsdc: 0,
      metadata: {
        a2aCompliant: true,
        inputSchema: { type: 'object', required: ['x'] },
      },
    });
    vi.mocked(discoveryService.getAgent)
      .mockResolvedValueOnce(agent1)
      .mockResolvedValueOnce(agent2)
      .mockResolvedValueOnce(agent2);

    mockFetchOk({ result: { plain: 'string' } }); // NOT a Message
    mockFetchOk({ result: 'final' });

    const result = await composeService.compose({
      steps: [
        { agent: 'a1', input: {} },
        { agent: 'a2', input: {}, passOutput: true },
      ],
    });

    expect(result.success).toBe(true);
    expect(transformMock).toHaveBeenCalledTimes(1);
    expect(result.steps[0].bridgeType).toBe('SKIPPED');
  });

  it('T-12: unwraps parts[0] when output is A2A but target is non-a2aCompliant (AC-3)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const transformMock = vi.mocked(maybeTransform);
    transformMock.mockClear();
    transformMock.mockResolvedValueOnce({
      transformedOutput: { x: 1 },
      cacheHit: 'SKIPPED',
      bridgeType: 'SKIPPED',
      latencyMs: 0,
    });

    const agent1 = makeAgent({
      slug: 'a1',
      id: 'agent-a1',
      priceUsdc: 0,
    });
    const agent2 = makeAgent({
      slug: 'a2',
      id: 'agent-a2',
      priceUsdc: 0,
      // NO a2aCompliant flag — target is non-A2A
      metadata: {
        inputSchema: { type: 'object', required: ['x'] },
      },
    });
    vi.mocked(discoveryService.getAgent)
      .mockResolvedValueOnce(agent1)
      .mockResolvedValueOnce(agent2)
      .mockResolvedValueOnce(agent2);

    const a2aOutput = {
      role: 'agent',
      parts: [{ kind: 'data', data: { x: 1 } }],
    };
    mockFetchOk({ result: a2aOutput });
    mockFetchOk({ result: 'final' });

    await composeService.compose({
      steps: [
        { agent: 'a1', input: {} },
        { agent: 'a2', input: {}, passOutput: true },
      ],
    });

    expect(transformMock).toHaveBeenCalledTimes(1);
    const callArgs = transformMock.mock.calls[0];
    // 3rd arg of maybeTransform(srcId, tgtId, output, schema) is the unwrapped payload
    expect(callArgs[2]).toEqual({ x: 1 });
  });

  it('T-14: compose_step metadata includes 6 telemetry fields, llm_* null on non-LLM (WKH-57 AC-6)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const transformMock = vi.mocked(maybeTransform);
    transformMock.mockClear();
    const trackSpy = vi.mocked(eventService.track);
    trackSpy.mockClear();
    trackSpy.mockResolvedValue({} as never);

    // First subtest: LLM bridge — all 6 fields populated with real values.
    transformMock.mockResolvedValueOnce({
      transformedOutput: { x: 1 },
      cacheHit: false,
      bridgeType: 'LLM',
      latencyMs: 42,
      llm: {
        model: 'claude-haiku-4-5-20251001',
        tokensIn: 250,
        tokensOut: 60,
        retries: 0,
        costUsd: 0.000_44, // 250/1M*0.8 + 60/1M*4.0
      },
    });

    const agent1 = makeAgent({
      slug: 'a1',
      id: 'agent-a1',
      priceUsdc: 0,
    });
    const agent2 = makeAgent({
      slug: 'a2',
      id: 'agent-a2',
      priceUsdc: 0,
      metadata: {
        inputSchema: { type: 'object', required: ['x'] },
      },
    });
    vi.mocked(discoveryService.getAgent)
      .mockResolvedValueOnce(agent1)
      .mockResolvedValueOnce(agent2)
      .mockResolvedValueOnce(agent2);

    mockFetchOk({ result: { plain: 'string' } });
    mockFetchOk({ result: 'final' });

    await composeService.compose({
      steps: [
        { agent: 'a1', input: {} },
        { agent: 'a2', input: {}, passOutput: true },
      ],
    });

    // First step's event must include the 6 metadata fields with LLM values.
    const firstStepCall = trackSpy.mock.calls.find(
      (c) => c[0].agentId === 'a1',
    );
    expect(firstStepCall).toBeDefined();
    const meta1 = firstStepCall?.[0].metadata;
    expect(meta1?.bridge_type).toBe('LLM');
    expect(typeof meta1?.bridge_latency_ms).toBe('number');
    expect(meta1?.bridge_cost_usd).toBeCloseTo(0.000_44, 6);
    expect(meta1?.llm_model).toBe('claude-haiku-4-5-20251001');
    expect(meta1?.llm_tokens_in).toBe(250);
    expect(meta1?.llm_tokens_out).toBe(60);

    // Second subtest: non-LLM bridge (SKIPPED) — llm_* fields must be null.
    trackSpy.mockClear();
    transformMock.mockClear();
    transformMock.mockResolvedValueOnce({
      transformedOutput: { x: 1 },
      cacheHit: 'SKIPPED',
      bridgeType: 'SKIPPED',
      latencyMs: 0,
      // No llm field — explicitly omitted (CD-17)
    });

    const agent3 = makeAgent({
      slug: 'b1',
      id: 'agent-b1',
      priceUsdc: 0,
    });
    const agent4 = makeAgent({
      slug: 'b2',
      id: 'agent-b2',
      priceUsdc: 0,
      metadata: {
        inputSchema: { type: 'object', required: ['x'] },
      },
    });
    vi.mocked(discoveryService.getAgent)
      .mockResolvedValueOnce(agent3)
      .mockResolvedValueOnce(agent4)
      .mockResolvedValueOnce(agent4);

    mockFetchOk({ result: { x: 1 } });
    mockFetchOk({ result: 'final' });

    await composeService.compose({
      steps: [
        { agent: 'b1', input: {} },
        { agent: 'b2', input: {}, passOutput: true },
      ],
    });

    const skipStepCall = trackSpy.mock.calls.find((c) => c[0].agentId === 'b1');
    expect(skipStepCall).toBeDefined();
    const meta2 = skipStepCall?.[0].metadata;
    expect(meta2?.bridge_type).toBe('SKIPPED');
    expect(typeof meta2?.bridge_latency_ms).toBe('number');
    // AB-WKH-56-4: llm_* + bridge_cost_usd must be null (not undefined).
    expect(meta2?.bridge_cost_usd).toBeNull();
    expect(meta2?.llm_model).toBeNull();
    expect(meta2?.llm_tokens_in).toBeNull();
    expect(meta2?.llm_tokens_out).toBeNull();
  });

  it('T-13: emits compose_step event with metadata.bridge_type (AC-6)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const transformMock = vi.mocked(maybeTransform);
    transformMock.mockClear();
    const trackSpy = vi.mocked(eventService.track);
    trackSpy.mockClear();
    trackSpy.mockResolvedValue({} as never);

    const agent1 = makeAgent({
      slug: 'a1',
      id: 'agent-a1',
      priceUsdc: 0,
      metadata: { a2aCompliant: true },
    });
    const agent2 = makeAgent({
      slug: 'a2',
      id: 'agent-a2',
      priceUsdc: 0,
      metadata: { a2aCompliant: true },
    });
    vi.mocked(discoveryService.getAgent)
      .mockResolvedValueOnce(agent1)
      .mockResolvedValueOnce(agent2)
      .mockResolvedValueOnce(agent2);

    const a2aOutput = {
      role: 'agent',
      parts: [{ kind: 'data', data: { x: 1 } }],
    };
    mockFetchOk({ result: a2aOutput });
    mockFetchOk({ result: a2aOutput });

    await composeService.compose({
      steps: [
        { agent: 'a1', input: {} },
        { agent: 'a2', input: {}, passOutput: true },
      ],
    });

    // Event for first step → A2A_PASSTHROUGH
    expect(trackSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'compose_step',
        agentId: 'a1',
        metadata: expect.objectContaining({ bridge_type: 'A2A_PASSTHROUGH' }),
      }),
    );

    // Event for last step → bridge_type === null (no bridge after last step)
    const lastCall = trackSpy.mock.calls[trackSpy.mock.calls.length - 1];
    expect(lastCall[0].metadata?.bridge_type).toBeNull();
  });
});

// ─── WAS-V2-3-CLIENT (WKH-57): integration — fallback unblocks downstream ─
describe('composeService — WAS-V2-3-CLIENT integration (WKH-57)', () => {
  it('T-INT-01: triggers downstream Fuji USDC settle when priceUsdc is resolved via v2 fallback (AC-4)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    mockDownstream.mockResolvedValue({
      txHash: '0xfeeb',
      blockNumber: 42,
      settledAmount: '50000', // 0.05 USDC in atomic units (6-dec)
    });
    // Simulate the OUTPUT of mapAgent post-fallback: priceUsdc resolved
    // from price_per_call when price_per_call_usdc was null.
    const agent = makeAgent({
      slug: 'v2-fallback-agent',
      priceUsdc: 0.05,
      payment: {
        method: 'x402',
        chain: 'avalanche',
        contract: '0x000000000000000000000000000000000000aBcD',
      },
      metadata: { payTo: '0x000000000000000000000000000000000000aBcD' },
    });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);
    // Self-contained upstream x402 mocks (AR BLQ-MED-1): clearAllMocks resets
    // call history but NOT mockResolvedValue implementations from prior tests.
    mockSign.mockResolvedValueOnce({
      xPaymentHeader: 'mockheader',
      paymentRequest: {
        authorization: {
          from: '0xA',
          to: '0xB',
          value: '50000',
          validAfter: '0',
          validBefore: '9999999999',
          nonce: '0x1234',
        },
        signature: '0xSIG',
        network: 'eip155:2368',
      },
    });
    mockSettle.mockResolvedValueOnce({ success: true, txHash: '0xUPSTREAM' });
    mockFetchOk();

    const result = await composeService.compose({
      steps: [{ agent: agent.slug, input: { q: 'x' } }],
    });

    expect(result.success).toBe(true);
    // AC-4: downstream path executed (vs current bug where priceUsdc=0 skips it)
    expect(mockDownstream).toHaveBeenCalledTimes(1);
    expect(result.steps[0].downstreamTxHash).toBe('0xfeeb');
  });

  it('T-INT-02: payTo falls back to metadata.payment.contract when top-level payTo missing (WAS-V2-3-CLIENT-2)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    mockDownstream.mockResolvedValue({
      txHash: '0xfeeb',
      blockNumber: 42,
      settledAmount: '1000', // 0.001 USDC in atomic units (6-dec)
    });
    // v2 schema drift: marketplace exposes payTo via payment.contract (nested),
    // NOT via top-level metadata.payTo. Compose must fall back transparently.
    const agent = makeAgent({
      slug: 'wasi-chainlink-price',
      priceUsdc: 0.001,
      payment: {
        method: 'x402',
        chain: 'avalanche',
        contract: '0xC01DEF0ca66b86E9F8655dc202347F1cf104b7A7',
      },
      metadata: {
        payment: {
          protocol: 'x402',
          price: 0.001,
          currency: 'USDC',
          settlement: 'wasiai-native',
          contract: '0xC01DEF0ca66b86E9F8655dc202347F1cf104b7A7',
        },
        // NOTE: no top-level payTo — must resolve from payment.contract
      },
    });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);
    // Self-contained upstream x402 mocks (mirrors T-INT-01 pattern)
    mockSign.mockResolvedValueOnce({
      xPaymentHeader: 'mockheader',
      paymentRequest: {
        authorization: {
          from: '0xA',
          to: '0xC01DEF0ca66b86E9F8655dc202347F1cf104b7A7',
          value: '1000',
          validAfter: '0',
          validBefore: '9999999999',
          nonce: '0x1234',
        },
        signature: '0xSIG',
        network: 'eip155:43113',
      },
    });
    mockSettle.mockResolvedValueOnce({ success: true, txHash: '0xUPSTREAM' });
    mockFetchOk();

    const result = await composeService.compose({
      steps: [{ agent: agent.slug, input: { q: 'price' } }],
    });

    expect(result.success).toBe(true);
    // Downstream Fuji USDC settle fired end-to-end via fallback payTo
    expect(mockDownstream).toHaveBeenCalledTimes(1);
    expect(result.steps[0].downstreamTxHash).toBe('0xfeeb');
  });
});

// ─── WKH-61: scoping per step (composeService.compose) ───────────────────
describe('composeService.compose — WKH-61 scoping per step', () => {
  beforeEach(() => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
  });

  it('T-SCOPE-1 (AC-1): registry match → success', async () => {
    const agent = makeAgent({
      slug: 'wasiai-x',
      registry: 'wasiai',
      priceUsdc: 0,
    });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);
    mockFetchOk({ result: 'ok' });

    const result = await composeService.compose({
      steps: [{ agent: 'wasiai-x', input: {} }],
      scopingKeyRow: makeKeyRow({ allowed_registries: ['wasiai'] }),
    });

    expect(result.success).toBe(true);
    expect(result.errorCode).toBeUndefined();
    expect(result.steps).toHaveLength(1);
  });

  it('T-SCOPE-2 (AC-2): registry mismatch → SCOPE_DENIED, agent NOT invoked', async () => {
    const agent = makeAgent({
      slug: 'other-x',
      registry: 'other',
      priceUsdc: 0,
    });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);

    const result = await composeService.compose({
      steps: [{ agent: 'other-x', input: {} }],
      scopingKeyRow: makeKeyRow({ allowed_registries: ['wasiai'] }),
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SCOPE_DENIED');
    expect(result.scopeDeniedTarget?.registry).toBe('other');
    expect(result.scopeDeniedTarget?.agent_slug).toBe('other-x');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('T-SCOPE-3 (AC-3): slug mismatch → SCOPE_DENIED', async () => {
    const agent = makeAgent({
      slug: 'other-slug',
      registry: 'wasiai',
      priceUsdc: 0,
    });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);

    const result = await composeService.compose({
      steps: [{ agent: 'other-slug', input: {} }],
      scopingKeyRow: makeKeyRow({ allowed_agent_slugs: ['allowed-slug'] }),
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SCOPE_DENIED');
    expect(result.scopeDeniedTarget?.agent_slug).toBe('other-slug');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('T-SCOPE-4 (AC-4): category mismatch → SCOPE_DENIED', async () => {
    const agent = makeAgent({
      slug: 'social-bot',
      registry: 'wasiai',
      priceUsdc: 0,
      metadata: { category: 'social' },
    });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);

    const result = await composeService.compose({
      steps: [{ agent: 'social-bot', input: {} }],
      scopingKeyRow: makeKeyRow({ allowed_categories: ['defi'] }),
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SCOPE_DENIED');
    expect(result.scopeDeniedTarget?.category).toBe('social');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('T-SCOPE-5 (AC-5): allowed_*=null → no scope check, success path', async () => {
    const agent = makeAgent({
      slug: 'any',
      registry: 'whatever',
      priceUsdc: 0,
    });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);
    mockFetchOk({ result: 'done' });

    const result = await composeService.compose({
      steps: [{ agent: 'any', input: {} }],
      scopingKeyRow: makeKeyRow({
        allowed_registries: null,
        allowed_agent_slugs: null,
        allowed_categories: null,
      }),
    });

    expect(result.success).toBe(true);
    expect(result.errorCode).toBeUndefined();
  });

  it('T-SCOPE-6 (AC-6): check evaluates real agent.registry, not step.registry hint', async () => {
    // Step pide registry='wasiai', pero discovery resuelve un Agent
    // con registry='other' (drift / fallback). El scope check debe denegar
    // contra el registry REAL del agent, no el hint del step.
    const agent = makeAgent({
      slug: 'mismatched',
      registry: 'other',
      priceUsdc: 0,
    });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);

    const result = await composeService.compose({
      steps: [{ agent: 'mismatched', registry: 'wasiai', input: {} }],
      scopingKeyRow: makeKeyRow({ allowed_registries: ['wasiai'] }),
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SCOPE_DENIED');
    expect(result.scopeDeniedTarget?.registry).toBe('other');
  });

  it('T-SCOPE-7 (AC-7): step 1 fails scope → step 2 NOT invoked', async () => {
    const ok = makeAgent({ slug: 's0', registry: 'wasiai', priceUsdc: 0 });
    const denied = makeAgent({
      slug: 's1',
      registry: 'other',
      priceUsdc: 0,
    });
    vi.mocked(discoveryService.getAgent)
      .mockResolvedValueOnce(ok)
      .mockResolvedValueOnce(ok) // for next-step bridge resolution after step 0
      .mockResolvedValueOnce(denied);
    mockFetchOk({ result: 'step0-done' });

    const result = await composeService.compose({
      steps: [
        { agent: 's0', input: {} },
        { agent: 's1', input: {} },
      ],
      scopingKeyRow: makeKeyRow({ allowed_registries: ['wasiai'] }),
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SCOPE_DENIED');
    expect(result.steps).toHaveLength(1);
    // Solo step 0 disparó fetch; step 1 abortado antes de invokeAgent.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('T-SCOPE-8 (corner): allowed_categories=defi but agent has no metadata.category → SCOPE_DENIED', async () => {
    const agent = makeAgent({
      slug: 'no-cat',
      registry: 'wasiai',
      priceUsdc: 0,
      metadata: {}, // ningún campo category
    });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);

    const result = await composeService.compose({
      steps: [{ agent: 'no-cat', input: {} }],
      scopingKeyRow: makeKeyRow({ allowed_categories: ['defi'] }),
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SCOPE_DENIED');
    // category undefined → omitida del scopeDeniedTarget (CD anti-undefined-in-JSON)
    expect(result.scopeDeniedTarget?.category).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('T-SCOPE-9 (CD-13): scopingKeyRow=undefined → check skipped, x402 path intact', async () => {
    const agent = makeAgent({
      slug: 'any',
      registry: 'restricted',
      priceUsdc: 0,
    });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);
    mockFetchOk({ result: 'done' });

    // NO scopingKeyRow → check NO se ejecuta (path x402)
    const result = await composeService.compose({
      steps: [{ agent: 'any', input: {} }],
    });

    expect(result.success).toBe(true);
    expect(result.errorCode).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// WKH-59 (real-price-debit) AC-2: multi-step debit for steps 2..N
// CD-11: guard `i > 0` is the ONLY defense against double-debiting step 0
//   (step 0 is debited by the middleware via composeEstimatedCostUsd).
// CD-14: NO failNext — only mockResolvedValueOnce chained.
// ─────────────────────────────────────────────────────────────────────

describe('composeService.compose — WKH-59 multi-step debit (AC-2)', () => {
  // Helper: route discoveryService.getAgent by slug for deterministic
  // resolveAgent + lookahead behavior in multi-step pipelines.
  function mockAgentsBySlug(agents: Record<string, Agent>) {
    vi.mocked(discoveryService.getAgent).mockImplementation(
      async (slug: string, _registry?: string) => agents[slug] ?? null,
    );
  }

  it('T-COMPOSE-DEBIT-1 should debit step 1 (i=1) via budgetService.debit', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({
      slug: 'corridor',
      priceUsdc: 0.05,
      id: 'agent-2',
    });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk({ result: 'r1' });
    mockFetchOk({ result: 'r2' });

    const keyRow = makeKeyRow({ id: 'k1' });

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(true);
    // Only step 1 is debited via service (step 0 is the middleware's job).
    expect(mockDebit).toHaveBeenCalledTimes(1);
    // WKH-101 (DT-11): compose now passes request.delegationContext as the 4th
    // arg; master-key path → undefined (CD-5 backward-compat).
    expect(mockDebit).toHaveBeenCalledWith('k1', 2368, 0.05, undefined);
  });

  it('T-COMPOSE-DEBIT-2 should debit steps 1 and 2 in a 3-step pipeline', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({
      slug: 'corridor',
      priceUsdc: 0.05,
      id: 'agent-2',
    });
    const a3 = makeAgent({
      slug: 'cashout',
      priceUsdc: 0.01,
      id: 'agent-3',
    });
    mockAgentsBySlug({ kyc: a1, corridor: a2, cashout: a3 });
    mockFetchOk();
    mockFetchOk();
    mockFetchOk();

    const keyRow = makeKeyRow({ id: 'k1' });

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
        { agent: 'cashout', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(true);
    expect(mockDebit).toHaveBeenCalledTimes(2);
    // WKH-101 (DT-11): 4th arg = request.delegationContext (undefined → master path).
    expect(mockDebit).toHaveBeenNthCalledWith(1, 'k1', 2368, 0.05, undefined);
    expect(mockDebit).toHaveBeenNthCalledWith(2, 'k1', 2368, 0.01, undefined);
  });

  // WKH-101 T8b (AC-8 MULTI-STEP): under delegation, the per-step debit routes
  // the delegationContext as the 4th arg. When max_total is hit mid-pipeline,
  // compose cuts AT THAT STEP — later steps are neither debited nor invoked.
  it('T8b multi-step total limit under delegation cuts at the exceeding step', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    const a3 = makeAgent({ slug: 'cashout', priceUsdc: 0.01, id: 'agent-3' });
    mockAgentsBySlug({ kyc: a1, corridor: a2, cashout: a3 });
    mockFetchOk(); // step 0 invoked
    mockFetchOk(); // step 1 invoked (debit succeeds)
    mockFetchOk(); // step 2 fetch — must NOT be consumed (cut before invoke)

    const delegationContext = {
      delegationId: 'del-1',
      ownerRef: 'user-1',
      keyId: 'k1',
      maxAmountPerTx: '5.00',
    };

    // step 1 debit OK, step 2 debit hits the total limit (atomic RPC mapping).
    mockDebit.mockReset();
    mockDebit.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({
      success: false,
      error: 'DELEGATION_TOTAL_LIMIT_EXCEEDED',
    });

    const keyRow = makeKeyRow({ id: 'k1' });

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
        { agent: 'cashout', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
      delegationContext,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('DELEGATION_TOTAL_LIMIT_EXCEEDED');
    // Cut a mitad: solo 2 débitos (steps 1 y 2); el step 2 NO se ejecuta.
    expect(mockDebit).toHaveBeenCalledTimes(2);
    expect(mockDebit).toHaveBeenNthCalledWith(
      1,
      'k1',
      2368,
      0.05,
      delegationContext,
    );
    expect(mockDebit).toHaveBeenNthCalledWith(
      2,
      'k1',
      2368,
      0.01,
      delegationContext,
    );
    // step 0 + step 1 invoked (2 fetches); step 2 fetch NOT consumed.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // results contiene solo los steps ejecutados (0 y 1).
    expect(result.steps.length).toBe(2);
  });

  it('T-COMPOSE-DEBIT-3 should abort pipeline when step 1 debit fails (insufficient)', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({
      slug: 'corridor',
      priceUsdc: 0.05,
      id: 'agent-2',
    });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk({ result: 'r1' });
    // Override default: first debit fails.
    mockDebit.mockReset();
    mockDebit.mockResolvedValueOnce({
      success: false,
      error: 'insufficient',
    });

    const keyRow = makeKeyRow({ id: 'k1' });

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Step 1 debit failed');
    expect(result.error).toContain('insufficient');
    // step 0 fetch occurred, step 1 fetch did NOT (debit aborted pre-invoke).
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // DT-H: NOT a SCOPE_DENIED error.
    expect(result.errorCode).toBeUndefined();
  });

  it('T-COMPOSE-DEBIT-4 should skip debit when scopingKeyRow is undefined (x402 path)', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({
      slug: 'corridor',
      priceUsdc: 0.05,
      id: 'agent-2',
    });
    const a3 = makeAgent({
      slug: 'cashout',
      priceUsdc: 0.01,
      id: 'agent-3',
    });
    mockAgentsBySlug({ kyc: a1, corridor: a2, cashout: a3 });
    mockFetchOk();
    mockFetchOk();
    mockFetchOk();

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
        { agent: 'cashout', input: {} },
      ],
      // No scopingKeyRow → x402 path → per-step debit MUST be skipped.
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(true);
    expect(mockDebit).not.toHaveBeenCalled();
  });

  it('T-COMPOSE-DEBIT-5 should skip debit when chainId is undefined', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({
      slug: 'corridor',
      priceUsdc: 0.05,
      id: 'agent-2',
    });
    const a3 = makeAgent({
      slug: 'cashout',
      priceUsdc: 0.01,
      id: 'agent-3',
    });
    mockAgentsBySlug({ kyc: a1, corridor: a2, cashout: a3 });
    mockFetchOk();
    mockFetchOk();
    mockFetchOk();

    const keyRow = makeKeyRow({ id: 'k1' });

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
        { agent: 'cashout', input: {} },
      ],
      scopingKeyRow: keyRow,
      // chainId intentionally omitted → defensive skip.
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(true);
    expect(mockDebit).not.toHaveBeenCalled();
  });

  it('T-COMPOSE-DEBIT-6 should NOT debit step 0 in service (anti-double-debit guard)', async () => {
    // CD-11: el step 0 NUNCA es debitado por el service — el middleware
    // ya lo debitó vía request.composeEstimatedCostUsd.
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({
      slug: 'corridor',
      priceUsdc: 0.05,
      id: 'agent-2',
    });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk();
    mockFetchOk();

    const keyRow = makeKeyRow({ id: 'k1' });

    await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    // Verify NO debit call carries step 0's priceUsdc (0.001) — that's the
    // middleware's responsibility. Service-level debits MUST be steps 1..N.
    for (const call of mockDebit.mock.calls) {
      expect(call[2]).not.toBe(0.001);
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // BLQ-MED-1 fix: fallback honesto para priceUsdc=0/null en steps 2..N.
  // AC-4 / CD-4. Mismo patrón que el preHandler de step 0
  // (src/routes/compose.ts:63-77), replicado en el service.
  // ─────────────────────────────────────────────────────────────────────

  it('T-COMPOSE-DEBIT-7 should debit step 1 with $1.00 fallback when priceUsdc===0 (BLQ-MED-1)', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    // step 1 agent has priceUsdc=0 (registry config error or "free" agent).
    // Service MUST fallback to $1.00 (NOT debit $0).
    const a2 = makeAgent({
      slug: 'free-bug',
      priceUsdc: 0,
      id: 'agent-2',
    });
    mockAgentsBySlug({ kyc: a1, 'free-bug': a2 });
    mockFetchOk();
    mockFetchOk();

    const keyRow = makeKeyRow({ id: 'k1' });

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'free-bug', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(true);
    expect(mockDebit).toHaveBeenCalledTimes(1);
    // amount === 1.0 (fallback), NOT 0
    expect(mockDebit).toHaveBeenCalledWith('k1', 2368, 1.0, undefined);
  });

  it('T-COMPOSE-DEBIT-8 should emit warn log with reason=registry-miss when priceUsdc===0 (BLQ-MED-1)', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({
      slug: 'free-bug',
      priceUsdc: 0,
      id: 'agent-2',
    });
    mockAgentsBySlug({ kyc: a1, 'free-bug': a2 });
    mockFetchOk();
    mockFetchOk();

    const keyRow = makeKeyRow({ id: 'k1' });
    // Inject DownstreamLogger-compatible logger (Pino shape).
    const warnSpy = vi.fn();
    const logger = { warn: warnSpy, info: vi.fn() };

    await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'free-bug', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
      logger,
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'registry-miss',
        slug: 'free-bug',
        step: 1,
      }),
      'compose-price.fallback per-step',
    );
  });

  it('T-COMPOSE-DEBIT-9 should apply same fallback when priceUsdc is null/non-number (BLQ-MED-1)', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    // priceUsdc=null is invalid per Agent type, but defensive code must
    // handle it (registry returns malformed data). Cast via unknown to
    // bypass TS guard for this defensive scenario.
    const a2 = makeAgent({
      slug: 'null-price',
      id: 'agent-2',
    });
    (a2 as unknown as { priceUsdc: number | null }).priceUsdc = null;
    mockAgentsBySlug({ kyc: a1, 'null-price': a2 });
    mockFetchOk();
    mockFetchOk();

    const keyRow = makeKeyRow({ id: 'k1' });
    const warnSpy = vi.fn();
    const logger = { warn: warnSpy, info: vi.fn() };

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'null-price', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
      logger,
    });

    expect(result.success).toBe(true);
    expect(mockDebit).toHaveBeenCalledTimes(1);
    // typeof null !== 'number' → fallback $1
    expect(mockDebit).toHaveBeenCalledWith('k1', 2368, 1.0, undefined);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'registry-miss',
        slug: 'null-price',
        step: 1,
      }),
      'compose-price.fallback per-step',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// WKH-106 (BASE-03) — selector telemetry on Base settle path.
//
// The Base adapter itself already honors CDP_FACILITATOR_URL via its own
// env-var fallback chain (src/adapters/base/payment.ts:163-170). The compose
// integration logs the selector decision so AC-2 / AC-5 / AC-7 are
// observable from the compose layer. These tests verify the log line
// is emitted only when the agent's manifest declares a Base chain.
// ─────────────────────────────────────────────────────────────────────────
describe('composeService — WKH-106 BASE-03 selector telemetry', () => {
  const ORIGINAL_CDP_ENV = process.env.CDP_FACILITATOR_URL;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  function getLogLines(): string[] {
    // logSpy.mock.calls is typed loosely as `unknown[][]`; we know each
    // call is `(message: unknown, ...rest: unknown[])` so coerce to string.
    return logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
  }

  afterEach(() => {
    logSpy.mockRestore();
    if (ORIGINAL_CDP_ENV === undefined) {
      delete process.env.CDP_FACILITATOR_URL;
    } else {
      process.env.CDP_FACILITATOR_URL = ORIGINAL_CDP_ENV;
    }
  });

  it('AC-2: logs CDP URL as selected when chain=base-mainnet and env is set', async () => {
    process.env.CDP_FACILITATOR_URL = 'https://x402.org/facilitator';
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const mockPR: X402PaymentRequest = {
      authorization: {
        from: '0xAAA',
        to: '0xBBB',
        value: '1000000',
        validAfter: '0',
        validBefore: '9999999999',
        nonce: '0x1234',
      },
      signature: '0xSIG',
      network: 'eip155:8453',
    };
    mockSign.mockResolvedValue({
      xPaymentHeader: 'base64mock',
      paymentRequest: mockPR,
    });
    mockSettle.mockResolvedValue({ success: true, txHash: '0xDEADBEEF' });
    const agent = makeAgent({
      priceUsdc: 1.0,
      metadata: { payTo: '0xBBB' },
      payment: {
        method: 'x402',
        chain: 'base-mainnet',
        contract: '0xBBB',
      },
    });
    mockFetchOk();
    await composeService.invokeAgent(agent, { q: 'hello' });

    const logCalls = getLogLines();
    const selectorLog = logCalls.find((l: string) =>
      l.includes('Base settle facilitator selector'),
    );
    expect(selectorLog).toBeDefined();
    expect(selectorLog).toContain('chainKey=base-mainnet');
    expect(selectorLog).toContain('selected=https://x402.org/facilitator');
    expect(selectorLog).toContain('cdpEnvSet=true');
  });

  it('AC-5: logs adapter-default fallback when env unset (base-sepolia)', async () => {
    delete process.env.CDP_FACILITATOR_URL;
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const mockPR: X402PaymentRequest = {
      authorization: {
        from: '0xAAA',
        to: '0xBBB',
        value: '1000000',
        validAfter: '0',
        validBefore: '9999999999',
        nonce: '0x1234',
      },
      signature: '0xSIG',
      network: 'eip155:84532',
    };
    mockSign.mockResolvedValue({
      xPaymentHeader: 'base64mock',
      paymentRequest: mockPR,
    });
    mockSettle.mockResolvedValue({ success: true, txHash: '0xCAFE' });
    const agent = makeAgent({
      priceUsdc: 0.5,
      metadata: { payTo: '0xBBB' },
      payment: {
        method: 'x402',
        chain: 'base-sepolia',
        contract: '0xBBB',
      },
    });
    mockFetchOk();
    await composeService.invokeAgent(agent, { q: 'hi' });

    const logCalls = getLogLines();
    const selectorLog = logCalls.find((l: string) =>
      l.includes('Base settle facilitator selector'),
    );
    expect(selectorLog).toBeDefined();
    expect(selectorLog).toContain('chainKey=base-sepolia');
    expect(selectorLog).toContain('selected=<adapter-default>');
    expect(selectorLog).toContain('cdpEnvSet=false');
  });

  it('AC-7 / CD-5: does NOT log selector when chain is Kite (unaffected)', async () => {
    process.env.CDP_FACILITATOR_URL = 'https://x402.org/facilitator';
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const mockPR: X402PaymentRequest = {
      authorization: {
        from: '0xAAA',
        to: '0xBBB',
        value: '1000000',
        validAfter: '0',
        validBefore: '9999999999',
        nonce: '0x1234',
      },
      signature: '0xSIG',
      network: 'eip155:2368',
    };
    mockSign.mockResolvedValue({
      xPaymentHeader: 'base64mock',
      paymentRequest: mockPR,
    });
    mockSettle.mockResolvedValue({ success: true, txHash: '0xKITE' });
    const agent = makeAgent({
      priceUsdc: 0.1,
      metadata: { payTo: '0xBBB' },
      payment: {
        method: 'x402',
        chain: 'kite-testnet',
        contract: '0xBBB',
      },
    });
    mockFetchOk();
    await composeService.invokeAgent(agent, { q: 'hi' });

    const logCalls = getLogLines();
    const selectorLog = logCalls.find((l: string) =>
      l.includes('Base settle facilitator selector'),
    );
    expect(selectorLog).toBeUndefined();
  });

  it('AC-7 / CD-5: does NOT log selector when chain is Avalanche (unaffected)', async () => {
    process.env.CDP_FACILITATOR_URL = 'https://x402.org/facilitator';
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const mockPR: X402PaymentRequest = {
      authorization: {
        from: '0xAAA',
        to: '0xBBB',
        value: '1000000',
        validAfter: '0',
        validBefore: '9999999999',
        nonce: '0x1234',
      },
      signature: '0xSIG',
      network: 'eip155:43113',
    };
    mockSign.mockResolvedValue({
      xPaymentHeader: 'base64mock',
      paymentRequest: mockPR,
    });
    mockSettle.mockResolvedValue({ success: true, txHash: '0xFUJI' });
    const agent = makeAgent({
      priceUsdc: 0.1,
      metadata: { payTo: '0xBBB' },
      payment: {
        method: 'x402',
        chain: 'avalanche-fuji',
        contract: '0xBBB',
      },
    });
    mockFetchOk();
    await composeService.invokeAgent(agent, { q: 'hi' });

    const logCalls = getLogLines();
    const selectorLog = logCalls.find((l: string) =>
      l.includes('Base settle facilitator selector'),
    );
    expect(selectorLog).toBeUndefined();
  });

  it('honors agent manifest facilitatorUrl when CDP env is absent', async () => {
    delete process.env.CDP_FACILITATOR_URL;
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const mockPR: X402PaymentRequest = {
      authorization: {
        from: '0xAAA',
        to: '0xBBB',
        value: '1000000',
        validAfter: '0',
        validBefore: '9999999999',
        nonce: '0x1234',
      },
      signature: '0xSIG',
      network: 'eip155:8453',
    };
    mockSign.mockResolvedValue({
      xPaymentHeader: 'base64mock',
      paymentRequest: mockPR,
    });
    mockSettle.mockResolvedValue({ success: true, txHash: '0xMAN' });
    const agent = makeAgent({
      priceUsdc: 1.0,
      metadata: {
        payTo: '0xBBB',
        facilitatorUrl: 'https://custom.facilitator.example.com',
      },
      payment: {
        method: 'x402',
        chain: 'base-mainnet',
        contract: '0xBBB',
      },
    });
    mockFetchOk();
    await composeService.invokeAgent(agent, { q: 'hello' });

    const logCalls = getLogLines();
    const selectorLog = logCalls.find((l: string) =>
      l.includes('Base settle facilitator selector'),
    );
    expect(selectorLog).toBeDefined();
    expect(selectorLog).toContain(
      'selected=https://custom.facilitator.example.com',
    );
  });
});

// ─── WKH-104 (TD-SYBIL): caller_ref_hash emission in compose_step ─────────
describe('composeService.compose — caller_ref_hash emission (WKH-104)', () => {
  const TEST_SECRET = 'wkh104-compose-test-secret';
  let prevSecret: string | undefined;

  beforeEach(() => {
    prevSecret = process.env.REPUTATION_CALLER_HMAC_SECRET;
    process.env.REPUTATION_CALLER_HMAC_SECRET = TEST_SECRET;
  });
  afterEach(() => {
    if (prevSecret === undefined)
      delete process.env.REPUTATION_CALLER_HMAC_SECRET;
    else process.env.REPUTATION_CALLER_HMAC_SECRET = prevSecret;
  });

  function expectedHash(ownerRef: string): string {
    return crypto
      .createHmac('sha256', TEST_SECRET)
      .update(ownerRef)
      .digest('hex');
  }

  it('T-SYBIL-1: success compose_step → metadata.caller_ref_hash === HMAC(owner_ref) (AC-9)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const trackSpy = vi.mocked(eventService.track);
    trackSpy.mockResolvedValue({} as never);
    const agent = makeAgent({ slug: 's1', id: 'agent-s1', priceUsdc: 0 });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: 'ok' }),
    });

    await composeService.compose({
      steps: [{ agent: 's1', input: {} }],
      scopingKeyRow: makeKeyRow({ owner_ref: 'owner-sybil-A' }),
    });

    const call = trackSpy.mock.calls.find((c) => c[0].agentId === 's1');
    expect(call).toBeDefined();
    expect(call?.[0].status).toBe('success');
    expect(call?.[0].metadata?.caller_ref_hash).toBe(
      expectedHash('owner-sybil-A'),
    );
    // privacidad (CD-5): el owner_ref crudo NUNCA aparece en metadata.
    expect(JSON.stringify(call?.[0].metadata)).not.toContain('owner-sybil-A');
  });

  it('T-SYBIL-2: failed compose_step → metadata.caller_ref_hash present (AC-9)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const trackSpy = vi.mocked(eventService.track);
    trackSpy.mockResolvedValue({} as never);
    const agent = makeAgent({ slug: 'f1', id: 'agent-f1', priceUsdc: 0 });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);
    // Reset any queued once-values from prior tests; force every fetch to fail
    // so invokeAgent throws → failed branch (no queue-pollution dependency).
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'fail' }),
    });

    await composeService.compose({
      steps: [{ agent: 'f1', input: {} }],
      scopingKeyRow: makeKeyRow({ owner_ref: 'owner-sybil-B' }),
    });

    const call = trackSpy.mock.calls.find(
      (c) => c[0].agentId === 'f1' && c[0].status === 'failed',
    );
    expect(call).toBeDefined();
    expect(call?.[0].metadata?.caller_ref_hash).toBe(
      expectedHash('owner-sybil-B'),
    );
    expect(JSON.stringify(call?.[0].metadata)).not.toContain('owner-sybil-B');
  });

  it('T-SYBIL-3: anonymous (no scopingKeyRow) → caller_ref_hash null (AC-10/AC-12)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const trackSpy = vi.mocked(eventService.track);
    trackSpy.mockResolvedValue({} as never);
    const agent = makeAgent({ slug: 'x1', id: 'agent-x1', priceUsdc: 0 });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: 'ok' }),
    });

    await composeService.compose({
      steps: [{ agent: 'x1', input: {} }],
      // no scopingKeyRow → x402 anónimo
    });

    const call = trackSpy.mock.calls.find((c) => c[0].agentId === 'x1');
    expect(call).toBeDefined();
    expect(call?.[0].metadata?.caller_ref_hash).toBeNull();
  });
});
