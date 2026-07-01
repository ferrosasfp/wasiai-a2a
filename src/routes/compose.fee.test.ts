/**
 * Compose Routes — Protocol Fee Integration Tests — WKH-118 FEE-COMPOSE
 *
 * Cubre el cobro best-effort del 1% protocol fee en POST /compose (espejo del
 * cobro de /orchestrate). Mocks: a2a-key/timeout/rate-limit middlewares,
 * composeService, agent-price (igual que compose.test.ts) + los DOS nuevos:
 * fee-charge.js (chargeProtocolFee/getProtocolFeeRate) y receipt.js
 * (receiptService.emit).
 *
 * Tests (≥1 por AC + regresión CD-4):
 *   - T-FEE-1 (AC-1): charged → chargeProtocolFee con request.id / totalCostUsdc / rate
 *   - T-FEE-2 (AC-2): best-effort — throw y status:'failed' NO rompen el 200
 *   - T-FEE-3 (AC-3): already-charged → no-op, sin recibo
 *   - T-FEE-4 (AC-4): skipped WALLET_UNSET → 200 sin error, sin recibo
 *   - T-FEE-5 (AC-5): success:false → NO se cobra fee
 *   - T-FEE-6 (AC-6): recibo emitido solo con charged + owner_ref; x402 puro → no recibo
 *   - T-FEE-7 (AC-7): already-charged inProgress → no-op idempotente
 *   - T-FEE-8 (CD-4): response body inalterado (sin feeChargeError/feeChargeTxHash/protocolFeeUsdc)
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
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
import type { A2AAgentKeyRow, ComposeResult } from '../types/index.js';

// ── Mock auth middleware (pass-through populating a2aKeyRow) ──
// nextKeyRow controla owner_ref/id por test; undefined = x402 puro.
let nextKeyRow: Partial<A2AAgentKeyRow> | undefined;
vi.mock('../middleware/a2a-key.js', () => ({
  requirePaymentOrA2AKey: () => [
    async (request: FastifyRequest, _reply: FastifyReply) => {
      (request as unknown as { a2aKeyRow: unknown }).a2aKeyRow = nextKeyRow;
    },
  ],
}));

// ── Mock timeout middleware (no-op) ─────────────────────────
vi.mock('../middleware/timeout.js', () => ({
  createTimeoutHandler:
    () => async (_request: FastifyRequest, _reply: FastifyReply) => {
      /* no-op */
    },
}));

// ── Mock rate-limit middleware (no-op config) ──────────────
vi.mock('../middleware/rate-limit.js', () => ({
  orchestrateRateLimit: () => false,
}));

// ── Mock composeService ─────────────────────────────────────
vi.mock('../services/compose.js', () => ({
  composeService: {
    compose: vi.fn(),
  },
}));

// ── Mock agent-price service (preHandler price resolution) ──
vi.mock('../services/agent-price.js', () => ({
  resolveAgentPriceUsdc: vi.fn(),
  resolveAgentDestination: vi.fn(),
}));

// ── NUEVO: Mock fee-charge service (WKH-118) ────────────────
vi.mock('../services/fee-charge.js', () => ({
  chargeProtocolFee: vi.fn(),
  getProtocolFeeRate: vi.fn(() => 0.01),
}));

// ── NUEVO: Mock receipt service (WKH-118 / WKH-124) ─────────
vi.mock('../services/receipt.js', () => ({
  receiptService: { emit: vi.fn().mockResolvedValue(undefined) },
}));

import { resolveAgentPriceUsdc } from '../services/agent-price.js';
import { composeService } from '../services/compose.js';
import {
  chargeProtocolFee,
  getProtocolFeeRate,
} from '../services/fee-charge.js';
import { receiptService } from '../services/receipt.js';
import composeRoutes from './compose.js';

const mockCompose = vi.mocked(composeService.compose);
const mockResolvePrice = vi.mocked(resolveAgentPriceUsdc);
const mockChargeFee = vi.mocked(chargeProtocolFee);
const mockFeeRate = vi.mocked(getProtocolFeeRate);
const mockEmit = vi.mocked(receiptService.emit);

// Flush de microtasks: el recibo es fire-and-forget (no se await-ea), así que
// la llamada a emit se registra en el próximo tick tras el inject (CD-7).
const flushMicrotasks = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

const successResult: ComposeResult = {
  success: true,
  output: 'ok',
  steps: [],
  totalCostUsdc: 0.05,
  totalLatencyMs: 5,
};

describe('compose routes — WKH-118 protocol fee', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();
    await app.register(composeRoutes, { prefix: '/compose' });
    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    vi.clearAllMocks();
    nextKeyRow = { id: 'k1', owner_ref: 'o1' };
    mockResolvePrice.mockResolvedValue(0.001);
    mockFeeRate.mockReturnValue(0.01);
    mockEmit.mockResolvedValue(undefined);
    // Default: compose succeeds; el fee se cobra OK.
    mockCompose.mockResolvedValue(successResult);
    mockChargeFee.mockResolvedValue({
      status: 'charged',
      feeUsdc: 0.005,
      txHash: '0xfee',
    });
  });

  // T-FEE-1 (AC-1): cobro con request.id, totalCostUsdc, feeRate.
  it('T-FEE-1 (AC-1): charged → chargeProtocolFee con request.id, totalCostUsdc y feeRate', async () => {
    mockCompose.mockResolvedValueOnce({ ...successResult, totalCostUsdc: 0.5 });
    mockChargeFee.mockResolvedValueOnce({
      status: 'charged',
      feeUsdc: 0.005,
      txHash: '0xfee',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { steps: [{ agent: 'a1', input: {} }] },
    });

    expect(res.statusCode).toBe(200);
    expect(mockChargeFee).toHaveBeenCalledTimes(1);
    expect(mockChargeFee).toHaveBeenCalledWith(
      expect.objectContaining({
        feeBaseUsdc: 0.5,
        feeRate: 0.01,
        orchestrationId: expect.any(String),
      }),
    );
    // CD-B: el orchestrationId es request.id (UUID de Fastify), string no vacío.
    const arg = mockChargeFee.mock.calls[0]?.[0];
    expect(arg?.orchestrationId).toBeTruthy();
    expect(typeof arg?.orchestrationId).toBe('string');
  });

  // T-FEE-2 (AC-2 best-effort): throw y status:'failed' NO rompen el 200.
  it('T-FEE-2a (AC-2): chargeProtocolFee throw → 200, body intacto', async () => {
    mockChargeFee.mockRejectedValueOnce(new Error('boom'));

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { steps: [{ agent: 'a1', input: {} }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(res.json()).not.toHaveProperty('feeChargeError');
  });

  it('T-FEE-2b (AC-2): status:failed → 200, body intacto', async () => {
    mockChargeFee.mockResolvedValueOnce({
      status: 'failed',
      feeUsdc: 0.005,
      error: 'settle failed',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { steps: [{ agent: 'a1', input: {} }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(res.json()).not.toHaveProperty('feeChargeError');
    expect(mockEmit).not.toHaveBeenCalled();
  });

  // T-FEE-3 (AC-3): already-charged → no-op, sin recibo.
  it('T-FEE-3 (AC-3): already-charged → 200, sin error, sin recibo', async () => {
    mockChargeFee.mockResolvedValueOnce({
      status: 'already-charged',
      feeUsdc: 0.005,
      txHash: '0xprev',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { steps: [{ agent: 'a1', input: {} }] },
    });

    await flushMicrotasks();
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('feeChargeError');
    // already-charged NO es 'charged' → no emite recibo.
    expect(mockEmit).not.toHaveBeenCalled();
  });

  // T-FEE-4 (AC-4): skipped WALLET_UNSET → 200 sin error, sin recibo.
  it('T-FEE-4 (AC-4): skipped WALLET_UNSET → 200, sin error, sin recibo', async () => {
    mockChargeFee.mockResolvedValueOnce({
      status: 'skipped',
      feeUsdc: 0.005,
      reason: 'WALLET_UNSET',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { steps: [{ agent: 'a1', input: {} }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('feeChargeError');
    expect(mockEmit).not.toHaveBeenCalled();
  });

  // T-FEE-5 (AC-5): success:false → NO se cobra fee.
  it('T-FEE-5 (AC-5): compose success:false → chargeProtocolFee NO llamado', async () => {
    mockCompose.mockResolvedValueOnce({
      success: false,
      output: null,
      steps: [],
      totalCostUsdc: 0,
      totalLatencyMs: 1,
      error: 'Budget exceeded',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { steps: [{ agent: 'a1', input: {} }] },
    });

    expect(res.statusCode).toBe(400);
    expect(mockChargeFee).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  // T-FEE-6 (AC-6): recibo solo con charged + owner_ref; x402 puro → no recibo.
  it('T-FEE-6a (AC-6): charged + owner_ref → emite recibo protocol_fee', async () => {
    nextKeyRow = { id: 'k1', owner_ref: 'o1' };
    mockChargeFee.mockResolvedValueOnce({
      status: 'charged',
      feeUsdc: 0.005,
      txHash: '0xfee',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { steps: [{ agent: 'a1', input: {} }] },
    });

    await flushMicrotasks();
    expect(res.statusCode).toBe(200);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        receiptType: 'protocol_fee',
        ownerRef: 'o1',
        agentKeyId: 'k1',
        amountUsd: 0.005,
        orchestrationId: expect.any(String),
      }),
    );
  });

  it('T-FEE-6b (AC-6): x402 puro (sin a2aKeyRow) → charged sin recibo', async () => {
    nextKeyRow = undefined;
    mockChargeFee.mockResolvedValueOnce({
      status: 'charged',
      feeUsdc: 0.005,
      txHash: '0xfee',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { steps: [{ agent: 'a1', input: {} }] },
    });

    await flushMicrotasks();
    expect(res.statusCode).toBe(200);
    // El fee igual se cobró, pero sin owner_ref → no recibo.
    expect(mockChargeFee).toHaveBeenCalledTimes(1);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  // T-FEE-7 (AC-7): already-charged inProgress → no-op idempotente.
  it('T-FEE-7 (AC-7): already-charged inProgress → 200, no-op, sin doble efecto', async () => {
    mockChargeFee.mockResolvedValueOnce({
      status: 'already-charged',
      feeUsdc: 0.005,
      txHash: '0xprev',
      inProgress: true,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { steps: [{ agent: 'a1', input: {} }] },
    });

    await flushMicrotasks();
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('feeChargeError');
    expect(mockEmit).not.toHaveBeenCalled();
  });

  // T-FEE-8 (CD-4 regresión): response body inalterado.
  it('T-FEE-8 (CD-4): charged → response sin feeChargeError/feeChargeTxHash/protocolFeeUsdc', async () => {
    mockChargeFee.mockResolvedValueOnce({
      status: 'charged',
      feeUsdc: 0.005,
      txHash: '0xfee',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { steps: [{ agent: 'a1', input: {} }] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).not.toHaveProperty('feeChargeError');
    expect(body).not.toHaveProperty('feeChargeTxHash');
    expect(body).not.toHaveProperty('protocolFeeUsdc');
    // El body es { kiteTxHash, ...result } — success intacto.
    expect(body.success).toBe(true);
    expect(body.totalCostUsdc).toBe(0.05);
  });
});
