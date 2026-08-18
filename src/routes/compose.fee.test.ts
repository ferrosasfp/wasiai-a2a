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
  // C2 (audit 2026-07-01): routes/compose.ts imports extractRawKey.
  extractRawKey: (request: FastifyRequest) => {
    const headerKey = request.headers['x-a2a-key'];
    if (typeof headerKey === 'string') return headerKey;
    const auth = request.headers.authorization;
    if (typeof auth === 'string') {
      const m = /^bearer\s+(.+)$/i.exec(auth);
      if (m?.[1]?.startsWith('wasi_a2a_')) return m[1];
    }
    return undefined;
  },
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

  // ⚠️ T-FEE-8 — WKH-360 INVIRTIÓ UNA DE SUS TRES ASERCIONES, Y ESO ES EL PUNTO.
  // Este `it` afirmaba que el 200 de `/compose` NO trae `protocolFeeUsdc`. AC-10 de
  // WKH-360 exige justamente lo contrario: el fee de protocolo de ESTE gateway tiene
  // que ser VISIBLE — el comentario de `routes/compose.ts` que declaraba lo opuesto
  // se reescribió por CD-21 en el mismo commit, y ése era el hueco #3 de la HU.
  //
  // ⚠️ Este párrafo NO reproduce la frase vieja textual A PROPÓSITO: el control de
  // CD-21 es un `grep` sobre `src/`, y una cita verbatim —aunque sea histórica— lo
  // deja con un hit y un auditor futuro no puede distinguir la cita del claim vivo.
  //
  // Las otras DOS aserciones se quedan y NO son cosmética:
  //  · `feeChargeError` ausente — el cobro sigue siendo best-effort y su error NO
  //    contamina el 200.
  //  · `feeChargeTxHash` ausente — ⛔ el hash de la transferencia del fee NO se
  //    serializa NUNCA: publicarlo expone el movimiento de la wallet de plataforma.
  //    El caller necesita el MONTO, no el hash. Esta línea es la que lo guarda.
  it('T-FEE-8 (CD-4 + WKH-360 AC-10): charged → SÍ el monto, NUNCA el txHash del fee', async () => {
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
    // ⛔ el hash NO sale, ni con este nombre ni con ninguno.
    expect(body).not.toHaveProperty('feeChargeTxHash');
    expect(JSON.stringify(body)).not.toContain('0xfee');
    // WKH-360 (AC-10): el MONTO sí sale, y con el status que lo califica.
    expect(body.protocolFeeUsdc).toBe(0.005);
    expect(body.protocolFeeStatus).toBe('charged');
    expect(typeof body.feeRatePercent).toBe('number');
    // El body es { kiteTxHash, ...result } — success intacto.
    expect(body.success).toBe(true);
    expect(body.totalCostUsdc).toBe(0.05);
  });

  // ── WKH-360 · AC-10 / CD-5 · los tres estados del fee PROPIO ──────────────
  /**
   * ⚠️ TESTIGO ÚNICO DE `MUT-14`. Medido: reportar `feeResult.feeUsdc` en la rama
   * `skipped` deja la suite completa en **1 solo rojo, y es éste**
   * (MEDIDO: exit=1, 1 rojos, en `1015f90`).
   *
   * O sea que **cambiarle el input lo apaga igual que borrarlo** (CD-22): si este
   * `it` deja de montar el caso `skipped`, nada más en el repo distingue "publicó el
   * monto calculado como si se hubiera cobrado" de "omitió el monto". Y esa
   * distinción es exactamente CD-5: el `feeUsdc` de un `skipped` es el monto
   * CALCULADO Y NO COBRADO, así que publicarlo es una afirmación falsa con formato
   * de dato.
   */
  it('T-FEE-2wkh (AC-10, CD-5): skipped(WALLET_UNSET) → not_charged y monto AUSENTE', async () => {
    // El `feeUsdc` que trae un `skipped` es el monto CALCULADO y NO COBRADO.
    // Reportarlo como cobrado sería una afirmación falsa con formato de dato.
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
    const body = res.json();
    expect(body.protocolFeeStatus).toBe('not_charged');
    expect(body).not.toHaveProperty('protocolFeeUsdc');
  });

  it('T-FEE-3wkh (AC-10, CD-5): failed → `unknown`, NO `not_charged`, y monto AUSENTE', async () => {
    // "No pude preguntar" ≠ "no pasó". Un HTTP que falla no prueba que la
    // transferencia no se transmitió — por eso este camino importa
    // `hasBroadcastEvidence`. La disposición es DESCONOCIDA: el tercer valor.
    mockChargeFee.mockResolvedValueOnce({
      status: 'failed',
      feeUsdc: 0.005,
      error: 'rpc down',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { steps: [{ agent: 'a1', input: {} }] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.protocolFeeStatus).toBe('unknown');
    expect(body.protocolFeeStatus).not.toBe('not_charged');
    expect(body).not.toHaveProperty('protocolFeeUsdc');
  });

  it('T-FEE-6wkh (AC-8, CD-7): agente NORMAL → los dos campos de cascada AUSENTES', async () => {
    // El gemelo positivo de AC-11: los 25 agentes de prod no emiten
    // `protocolFeeStatus`, así que la respuesta no gana NI UNA clave de cascada.
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

    const body = res.json();
    expect(body).not.toHaveProperty('cascadedOrchestrationFeeUsdc');
    expect(body).not.toHaveProperty('cascadedOrchestrationFeeStatus');
    // y ningún step ganó `coordinatorFee`
    for (const st of body.steps ?? []) {
      expect(st).not.toHaveProperty('coordinatorFee');
    }
  });

  // ── WKH-360 · AC-12 ────────────────────────────────────────────────────
  it('el conjunto de claves de la línea base es SUBCONJUNTO del nuevo, con los mismos valores', async () => {
    // La línea base son las claves que el 200 de `/compose` publicaba ANTES de esta
    // HU. Están escritas a mano a propósito: son el contrato ya publicado, así que
    // derivarlas del código de hoy haría que el test se moviera junto con una
    // regresión en vez de cazarla.
    const BASELINE = {
      kiteTxHash: undefined as unknown,
      success: true,
      output: 'ok',
      steps: [] as unknown[],
      totalCostUsdc: 0.05,
      totalLatencyMs: 5,
    };

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

    // (a) NINGUNA clave vieja desapareció…
    for (const key of Object.keys(BASELINE)) {
      if (key === 'kiteTxHash') continue; // sólo presente con pago x402
      expect(Object.keys(body), `se perdió la clave "${key}"`).toContain(key);
    }
    // (b) …y las que tenían valor conocido lo conservan IGUAL.
    expect(body.success).toBe(BASELINE.success);
    expect(body.output).toBe(BASELINE.output);
    expect(body.totalCostUsdc).toBe(BASELINE.totalCostUsdc);
    expect(body.totalLatencyMs).toBe(BASELINE.totalLatencyMs);
    // (c) y lo que se agregó es exactamente lo declarado por AC-10.
    expect(body.protocolFeeStatus).toBe('charged');
    expect(body.protocolFeeUsdc).toBe(0.005);
  });
});
