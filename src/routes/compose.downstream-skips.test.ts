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
import {
  type DownstreamSkipCode,
  type PublicDownstreamSkipCode,
  toPublicSkipCode,
} from '../lib/downstream-skip-code.js';
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
  // WKH-225: `routes/compose.ts` registra además `POST /compose/resume`, cuya
  // cadena de preHandlers usa `requireA2AKey` (autentica SIN debitar: el
  // step-0 del run original ya se cobró). Este doble tiene que exportarlo o el
  // plugin no registra y la suite entera se cae al arrancar. Mismo
  // pass-through que el de arriba: no afirma nada nuevo.
  requireA2AKey: () => [
    async (request: FastifyRequest, _reply: FastifyReply) => {
      (request as unknown as { a2aKeyRow: unknown }).a2aKeyRow = nextKeyRow;
    },
  ],
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
  /** Idem, para el canal de OPERADOR (motivos INTERNOS, admin-only). */
  let persistedCauses: DownstreamSkipCode[] | undefined;

  beforeAll(async () => {
    app = Fastify();
    await app.register(composeRoutes, { prefix: '/compose' });
    // Espejo de lo que hace `registerEventTracking`: leer el request DESPUÉS de
    // que la respuesta salió. Si el handler no lo setea, acá llega undefined.
    app.addHook('onResponse', async (request: FastifyRequest) => {
      persisted = request.downstreamSkips;
      persistedCauses = request.downstreamSkipCauses;
    });
    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    vi.clearAllMocks();
    persisted = undefined;
    persistedCauses = undefined;
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

  it('T-SKIP-UNKNOWN (WKH-308): `SETTLE_UNKNOWN` llega al CALLER sin colapsarse', async () => {
    // ⚠️ POR QUÉ ESTE TEST EXISTE. La tabla `PUBLIC_SKIP_CODE` mapea
    // `SETTLE_UNKNOWN → SETTLE_UNKNOWN` (verbatim, sin genericizar) y su comentario
    // PROHÍBE colapsarlo en `SETTLE_FAILED`, porque eso volvería a afirmarle al caller
    // que el leg no se pagó — justo lo que no sabemos. Pero esa prohibición sólo estaba
    // candada por el unitario de la tabla: colapsarla compilaba limpio y ningún test de
    // nivel consumidor se ponía rojo.
    //
    // Desde WKH-308 este código es también el vehículo del rail Solana, así que su
    // superficie subió. Acá se afirma la propiedad que importa: **que el caller lo
    // reciba**.
    //
    // El código se pasa por `toPublicSkipCode` A PROPÓSITO en vez de escribir el
    // literal: es lo que hace que el test recorra el mapeo y muera si alguien lo
    // colapsa.
    const publicCode = toPublicSkipCode('SETTLE_UNKNOWN');
    mockCompose.mockResolvedValueOnce({
      success: true,
      output: 'ok',
      steps: [skippedStep(publicCode), paidStep()],
      totalCostUsdc: 0.01,
      totalLatencyMs: 2,
    });

    const res = await inject();

    expect(res.statusCode).toBe(200);
    // (1) el caller lo ve en el cuerpo de su respuesta…
    expect(res.body).toContain('skipped:SETTLE_UNKNOWN');
    expect(res.body).not.toContain('skipped:SETTLE_FAILED');
    // (2) …y queda en el evento durable, que es lo que mira el operador.
    expect(persisted).toEqual(['SETTLE_UNKNOWN']);
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

  // ── Canal de OPERADOR: el motivo INTERNO del skip ────────────────────────
  //
  // EL HALLAZGO: el código público colapsa CUATRO causas internas en
  // `NOT_CONFIGURED` (`FLAG_OFF`, `CHAIN_ENVIRONMENT_DRIFT`,
  // `MAINNET_NOT_ALLOWED`, `MISSING_INTENT_ID`) y ese código era lo ÚNICO que
  // llegaba a `a2a_events`, así que la telemetría no podía distinguir "no pasa
  // nada" de "hay un deploy roto".
  //
  // Acá se prueba el CABLEADO del route, que es lo que ningún test de la tabla
  // puede probar: que el array prestado llega al pipeline, que lo que el pipeline
  // escribe termina en el request (de donde el hook lo persiste), y que NUNCA sale
  // por el cuerpo de la respuesta.

  it('T-CAUSA-route-a: el motivo interno llega al request y NO al cuerpo HTTP', async () => {
    // El mock escribe en el array que el ROUTE prestó — o sea que este test muere
    // si el route deja de prestarlo o si deja de pasarlo a `noteDownstreamSkips`.
    mockCompose.mockImplementationOnce(async (req) => {
      req.downstreamSkipCauses?.push('CHAIN_ENVIRONMENT_DRIFT');
      return {
        success: true,
        output: 'ok',
        steps: [skippedStep('NOT_CONFIGURED'), paidStep()],
        totalCostUsdc: 0.01,
        totalLatencyMs: 2,
      };
    });

    const res = await inject();

    expect(res.statusCode).toBe(200);
    // (1) el caller recibe el código genericizado, como siempre…
    expect(res.json().steps[0].downstreamSettle).toBe('skipped:NOT_CONFIGURED');
    // (2) …y NO el interno. Es la fuga que el mapeo público existe para evitar.
    expect(res.body).not.toContain('CHAIN_ENVIRONMENT_DRIFT');
    expect(res.body).not.toContain('downstreamSkipCauses');
    // (3) el operador SÍ lo ve, en el canal que la pantalla lee.
    expect(persistedCauses).toEqual(['CHAIN_ENVIRONMENT_DRIFT']);
    // (4) el canal público sigue diciendo lo de siempre.
    expect(persisted).toEqual(['NOT_CONFIGURED']);
  });

  it('T-CAUSA-route-b: la rama de FALLO también deja el motivo interno', async () => {
    // Espejo exacto de T-SKIP-400: la rama `!result.success` retorna por otro
    // `reply.send`, y ya se olvidó una vez de los skips públicos (AR BLQ-BAJO-1a).
    mockCompose.mockImplementationOnce(async (req) => {
      req.downstreamSkipCauses?.push('MISSING_INTENT_ID');
      return {
        success: false,
        output: null,
        steps: [skippedStep('NOT_CONFIGURED')],
        totalCostUsdc: 0,
        totalLatencyMs: 2,
        error: 'step 2 failed',
      };
    });

    const res = await inject();

    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('MISSING_INTENT_ID');
    expect(persistedCauses).toEqual(['MISSING_INTENT_ID']);
  });

  it('T-CAUSA-route-c: sin skips, el canal interno es un array VACÍO, no ausencia', () => {
    // Distinción que sostiene el tercer valor de la pantalla: `[]` es "se miró y no
    // hubo", ausente es "esta ruta no reporta". Se afirma con el pipeline exitoso
    // del test T-SKIP-200 de arriba, que no pushea nada.
    expect(
      Array.isArray(persistedCauses) || persistedCauses === undefined,
    ).toBe(true);
  });

  it('T-CAUSA-route-d: pipeline SIN skips → causas vacías, no ausentes', async () => {
    mockCompose.mockResolvedValueOnce({
      success: true,
      output: 'ok',
      steps: [paidStep()],
      totalCostUsdc: 0.01,
      totalLatencyMs: 2,
    });

    const res = await inject();

    expect(res.statusCode).toBe(200);
    expect(persistedCauses).toEqual([]);
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
