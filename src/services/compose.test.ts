/**
 * Tests for Compose Service -- auth headers + x402 payment
 * 9 tests: T-1 through T-9
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Agent,
  RegistryConfig,
  X402PaymentRequest,
} from '../types/index.js';

vi.mock('./registry.js', () => ({ registryService: { getEnabled: vi.fn() } }));
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
import { composeService } from './compose.js';
import { discoveryService } from './discovery.js';
import { eventService } from './event.js';
import { maybeTransform } from './llm/transform.js';
import { registryService } from './registry.js';

const mockDownstream = vi.mocked(signAndSettleDownstream);

function makeAgent(o: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    slug: 'test-agent',
    description: 'A test agent',
    capabilities: ['test'],
    priceUsdc: 0,
    registry: 'test-registry',
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
    const result = await composeService.invokeAgent(agent, { foo: 'bar' }, 'k1');
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
