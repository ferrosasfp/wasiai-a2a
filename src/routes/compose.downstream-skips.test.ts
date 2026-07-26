/**
 * POST /compose — persistencia de los skip-codes del leg downstream (WKH-191x).
 *
 * AR BLQ-BAJO-1a: la rama de FALLO (`!result.success`) retornaba sin pasar por
 * `noteDownstreamSkips`, así que el evento de esa llamada no ganaba la clave
 * `downstreamSkips`. Consecuencia demostrable: un pipeline donde el step 1 no le
 * pudo pagar al agente (el caller recibe ese `skipped:*` EN SU RESPUESTA HTTP) y el
 * step 2 falla quedaba invisible para el contador de la pantalla, que podía mostrar
 * "0 · es el estado bueno". La API le decía una cosa al caller y la pantalla otra al
 * operador.
 *
 * Estos tests cubren las TRES salidas del handler (200, 400 y 403 SCOPE_DENIED) y
 * asertan la consistencia entre lo que viaja en el body y lo que se persiste.
 *
 * Mocks: los mismos que `compose.fee.test.ts` (cero red, cero supabase, cero dinero).
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
import type { PublicDownstreamSkipCode } from '../lib/downstream-skip-code.js';
import type {
  A2AAgentKeyRow,
  Agent,
  ComposeResult,
  StepResult,
} from '../types/index.js';

let nextKeyRow: Partial<A2AAgentKeyRow> | undefined;
vi.mock('../middleware/a2a-key.js', () => ({
  extractRawKey: (request: FastifyRequest) => {
    const headerKey = request.headers['x-a2a-key'];
    return typeof headerKey === 'string' ? headerKey : undefined;
  },
  requirePaymentOrA2AKey: () => [
    async (request: FastifyRequest, _reply: FastifyReply) => {
      (request as unknown as { a2aKeyRow: unknown }).a2aKeyRow = nextKeyRow;
    },
  ],
}));

vi.mock('../middleware/timeout.js', () => ({
  createTimeoutHandler:
    () => async (_request: FastifyRequest, _reply: FastifyReply) => {
      /* no-op */
    },
}));

vi.mock('../middleware/rate-limit.js', () => ({
  orchestrateRateLimit: () => false,
}));

vi.mock('../services/compose.js', () => ({
  composeService: { compose: vi.fn() },
}));

vi.mock('../services/agent-price.js', () => ({
  resolveAgentPriceUsdc: vi.fn(),
  resolveAgentDestination: vi.fn(),
}));

vi.mock('../services/fee-charge.js', () => ({
  chargeProtocolFee: vi.fn(),
  getProtocolFeeRate: vi.fn(() => 0.01),
}));

vi.mock('../services/receipt.js', () => ({
  receiptService: { emit: vi.fn().mockResolvedValue(undefined) },
}));

import { resolveAgentPriceUsdc } from '../services/agent-price.js';
import { composeService } from '../services/compose.js';
import { chargeProtocolFee } from '../services/fee-charge.js';
import composeRoutes from './compose.js';

const mockCompose = vi.mocked(composeService.compose);
const mockResolvePrice = vi.mocked(resolveAgentPriceUsdc);
const mockChargeFee = vi.mocked(chargeProtocolFee);

/** Step con el marcador de skip que YA viaja en la respuesta al caller. */
function skippedStep(code: PublicDownstreamSkipCode): StepResult {
  return {
    agent: { slug: 'a1', name: 'A1' } as unknown as Agent,
    output: null,
    costUsdc: 0,
    latencyMs: 1,
    downstreamSettle: `skipped:${code}`,
  };
}

function paidStep(): StepResult {
  return {
    agent: { slug: 'a2', name: 'A2' } as unknown as Agent,
    output: null,
    costUsdc: 0.01,
    latencyMs: 1,
    downstreamTxHash: '0xdeadbeef',
  };
}

describe('POST /compose — skips del leg downstream en el evento', () => {
  let app: ReturnType<typeof Fastify>;
  /** Lo que el hook onResponse leería para persistir en `a2a_events.metadata`. */
  let persisted: PublicDownstreamSkipCode[] | undefined;

  beforeAll(async () => {
    app = Fastify();
    await app.register(composeRoutes, { prefix: '/compose' });
    // Espejo de lo que hace `registerEventTracking`: leer el request DESPUÉS de
    // que la respuesta salió. Si el handler no lo setea, acá llega undefined.
    app.addHook('onResponse', async (request: FastifyRequest) => {
      persisted = request.downstreamSkips;
    });
    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    vi.clearAllMocks();
    persisted = undefined;
    nextKeyRow = { id: 'k1', owner_ref: 'o1' };
    mockResolvePrice.mockResolvedValue(0.001);
    mockChargeFee.mockResolvedValue({
      status: 'skipped',
      feeUsdc: 0,
      reason: 'WALLET_UNSET',
    });
  });

  function inject() {
    return app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: {
        steps: [
          { agent: 'a1', input: {} },
          { agent: 'a2', input: {} },
        ],
      },
    });
  }

  it('T-SKIP-200: pipeline exitoso con un skip → el código queda en el request', async () => {
    mockCompose.mockResolvedValueOnce({
      success: true,
      output: 'ok',
      steps: [skippedStep('NO_PAYMENT_FIELD'), paidStep()],
      totalCostUsdc: 0.01,
      totalLatencyMs: 2,
    });

    const res = await inject();
    expect(res.statusCode).toBe(200);
    expect(persisted).toEqual(['NO_PAYMENT_FIELD']);
  });

  it('T-SKIP-400 (AR BLQ-BAJO-1a): pipeline FALLIDO con un skip → también se persiste', async () => {
    // El repro exacto del AR: step 1 sin payment field (skip que el caller ve en
    // su respuesta) y step 2 que falla (400).
    const failed: ComposeResult = {
      success: false,
      output: null,
      steps: [skippedStep('NO_PAYMENT_FIELD')],
      totalCostUsdc: 0,
      totalLatencyMs: 2,
      error: 'step 2 failed',
    };
    mockCompose.mockResolvedValueOnce(failed);

    const res = await inject();
    expect(res.statusCode).toBe(400);
    // Lo que el caller VE en el body...
    expect(res.json().steps[0].downstreamSettle).toBe(
      'skipped:NO_PAYMENT_FIELD',
    );
    // ...es exactamente lo que la pantalla del operador va a contar.
    expect(persisted).toEqual(['NO_PAYMENT_FIELD']);
  });

  it('T-SKIP-403: la rama SCOPE_DENIED tampoco pierde los skips', async () => {
    mockCompose.mockResolvedValueOnce({
      success: false,
      output: null,
      steps: [skippedStep('SETTLE_FAILED')],
      totalCostUsdc: 0,
      totalLatencyMs: 2,
      error: 'scope denied',
      errorCode: 'SCOPE_DENIED',
    });

    const res = await inject();
    expect(res.statusCode).toBe(403);
    expect(persisted).toEqual(['SETTLE_FAILED']);
  });

  it('T-SKIP-VACIO: pipeline fallido SIN skips → array vacío, no ausencia de señal', async () => {
    mockCompose.mockResolvedValueOnce({
      success: false,
      output: null,
      steps: [paidStep()],
      totalCostUsdc: 0.01,
      totalLatencyMs: 2,
      error: 'boom',
    });

    const res = await inject();
    expect(res.statusCode).toBe(400);
    expect(persisted).toEqual([]);
  });

  it('T-SKIP-COBRO: la rama de fallo NO cobra fee (el instrumento no tocó el dinero)', async () => {
    mockCompose.mockResolvedValueOnce({
      success: false,
      output: null,
      steps: [skippedStep('NO_PAYMENT_FIELD')],
      totalCostUsdc: 0,
      totalLatencyMs: 2,
      error: 'boom',
    });

    await inject();
    expect(mockChargeFee).not.toHaveBeenCalled();
  });
});
