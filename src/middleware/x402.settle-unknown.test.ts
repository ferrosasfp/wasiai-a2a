/**
 * HU-198 — settle INBOUND de resultado desconocido (`valueDisposition: 'unknown'`).
 *
 * EL CASO: el techo de wall-clock corta el hop `/settle` al facilitator. Abortar el
 * HTTP NO cancela el broadcast, así que la plata del CALLER pudo haber salido y el
 * gateway no lo sabe. Encima el nonce inbound ya quedó registrado antes del settle
 * (anti-replay), así que un reintento del mismo header da `X402_REPLAY`: si nadie
 * mira este caso, el caller queda pagando sin servicio.
 *
 * LAS DOS PROPIEDADES QUE SE AFIRMAN (sobre la plata, no sobre las llamadas):
 *   1. NO se otorga acceso. Sin confirmación no se puede servir el recurso, y eso
 *      no cambia respecto de hoy (402).
 *   2. El caso NO queda indistinguible de un rechazo del facilitator: sale un log
 *      de nivel error con `error_code: 'X402_SETTLE_UNKNOWN'`, que es la señal
 *      alertable para ir a reconciliar contra la cadena.
 *
 * El CONTRA-EJEMPLO (settle que tira un Error común) es lo que le da contenido a la
 * propiedad 2: si el código emitiera la señal para cualquier throw, no distinguiría
 * nada. Ese test exige que el 402 siga saliendo SIN la señal.
 *
 * Harness clonado de `x402.settle-reverify.test.ts`. El logger se inyecta como
 * instancia (`loggerInstance`) cuyo `child()` se devuelve a sí mismo, así que lo
 * que loguea `request.log` cae en el mismo spy.
 */

import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FacilitatorSettleError } from '../adapters/errors.js';

const KITE_TOKEN = '0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e';

const kiteAdapter = {
  verify: vi.fn().mockResolvedValue({ valid: true }),
  settle: vi.fn().mockResolvedValue({ txHash: '0xdeadbeef', success: true }),
  getToken: vi.fn().mockReturnValue(KITE_TOKEN),
  getNetwork: vi.fn().mockReturnValue('eip155:2368'),
  getScheme: vi.fn().mockReturnValue('exact'),
  getMerchantName: vi.fn().mockReturnValue('wasiai-a2a-test'),
  getMaxTimeoutSeconds: vi.fn().mockReturnValue(300),
  quote: vi.fn().mockResolvedValue({
    amountWei: '1000000000000000000',
    token: { symbol: 'KITE', address: KITE_TOKEN, decimals: 18 },
    facilitatorUrl: 'http://mock',
  }),
};

function bundleFor(chainId: number) {
  return {
    chainConfig: { chainId },
    payment: {
      vmFamily: 'evm',
      supportedTokens: [{ address: KITE_TOKEN, decimals: 18 }],
    },
  };
}

vi.mock('../adapters/registry.js', () => ({
  getPaymentAdapter: () => kiteAdapter,
  getAdaptersBundle: (chainKey?: string) =>
    chainKey === 'kite-ozone-testnet' ? bundleFor(2368) : undefined,
  getInitializedChainKeys: () => ['kite-ozone-testnet'],
  getDefaultChainKey: () => 'kite-ozone-testnet',
}));

const mockNonceInsert = vi.fn().mockResolvedValue({ data: null, error: null });
vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: vi.fn(() => ({ insert: (...a: unknown[]) => mockNonceInsert(...a) })),
    rpc: vi.fn(),
  },
}));

// AR BLQ-MEDIO-3: el registro durable del unknown va por el seam canónico
// `eventService.track` (fire-and-forget). Se mockea para poder afirmar el CONTENIDO de
// la fila persistida, no sólo que "se llamó a algo".
const mockTrack = vi.fn().mockResolvedValue({ id: 'evt-1' });
vi.mock('../services/event.js', () => ({
  eventService: { track: (...a: unknown[]) => mockTrack(...a) },
}));

import { buildEoaPaymentHeader } from '../__tests__/fixtures/passport-shape.js';
import { requirePayment } from './x402.js';

const SERVER_WALLET = '0x000000000000000000000000000000000000dEaD';
const KITE_VALUE = '1000000000000000000';

interface LogCall {
  obj: Record<string, unknown>;
  msg?: string;
}

function makeCapturingLogger(): {
  logger: FastifyBaseLogger;
  errors: LogCall[];
} {
  const errors: LogCall[] = [];
  const record = (obj: unknown, msg?: string) => {
    if (obj && typeof obj === 'object') {
      // `exactOptionalPropertyTypes`: un `msg: undefined` EXPLÍCITO no es lo mismo
      // que la propiedad ausente, así que se omite en vez de setearla undefined.
      errors.push({
        obj: obj as Record<string, unknown>,
        ...(msg === undefined ? {} : { msg }),
      });
    }
  };
  const logger = {
    error: (obj: unknown, msg?: string) => record(obj, msg),
    warn: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    silent: () => {},
    level: 'error',
    // `request.log` es un child del logger de la app: devolverse a sí mismo hace
    // que el spy vea TODO lo que loguea el handler.
    child() {
      return this;
    },
  } as unknown as FastifyBaseLogger;
  return { logger, errors };
}

function buildApp(logger: FastifyBaseLogger) {
  const app = Fastify({ loggerInstance: logger });
  app.post(
    '/test',
    { preHandler: requirePayment({ description: 'test' }) },
    async (request: FastifyRequest, reply: FastifyReply) =>
      reply.send({ paid: request.paymentVerified }),
  );
  return app;
}

async function callWithSettleRejection(rejection: unknown) {
  const { logger, errors } = makeCapturingLogger();
  const app = buildApp(logger);
  await app.ready();
  try {
    kiteAdapter.settle.mockRejectedValueOnce(rejection);
    const { headers } = buildEoaPaymentHeader({
      to: SERVER_WALLET,
      value: KITE_VALUE,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { ...headers, 'x-payment-chain': 'kite-ozone-testnet' },
      payload: {},
    });
    return { res, errors };
  } finally {
    await app.close();
  }
}

describe('HU-198: settle inbound con resultado desconocido', () => {
  const ORIGINAL_WALLET = process.env.KITE_WALLET_ADDRESS;

  beforeEach(() => {
    vi.clearAllMocks();
    kiteAdapter.verify.mockResolvedValue({ valid: true });
    kiteAdapter.settle.mockResolvedValue({
      txHash: '0xdeadbeef',
      success: true,
    });
    mockNonceInsert.mockResolvedValue({ data: null, error: null });
    process.env.KITE_WALLET_ADDRESS = SERVER_WALLET;
  });

  afterEach(() => {
    if (ORIGINAL_WALLET === undefined) delete process.env.KITE_WALLET_ADDRESS;
    else process.env.KITE_WALLET_ADDRESS = ORIGINAL_WALLET;
  });

  it('T-198-INBOUND-UNKNOWN: settle unknown → 402 sin acceso + señal alertable X402_SETTLE_UNKNOWN', async () => {
    const { res, errors } = await callWithSettleRejection(
      new FacilitatorSettleError(
        'Facilitator network error on settle: The operation was aborted due to timeout',
        'unknown',
      ),
    );

    // Propiedad 1: sin confirmación NO se sirve el recurso.
    expect(res.statusCode).toBe(402);
    expect(res.json()).not.toEqual({ paid: true });

    // Propiedad 2: el caso queda marcado para que alguien lo mire. Sin esto, el
    // caller pagó (posiblemente) y el incidente se pierde entre los 402 normales.
    const unknownLog = errors.find(
      (e) => e.obj.error_code === 'X402_SETTLE_UNKNOWN',
    );
    expect(unknownLog).toBeDefined();
    expect(unknownLog?.obj.valueDisposition).toBe('unknown');
    // El log tiene que decir la consecuencia de dinero, no sólo "falló".
    expect(String(unknownLog?.msg)).toMatch(/may have executed on-chain/);
  });

  // ── AR BLQ-MEDIO-3: el caller NO puede recibir "tu pago falló" ──
  it('T-198-AR-INBOUND-MSG: el 402 del unknown NO dice "settlement failed" y avisa de no reintentar', async () => {
    // La contradicción que el AR marcó: el lado outbound de esta HU distingue "no se
    // pagó" de "puede haberse pagado" (`downstream-skip-code.ts`), y el inbound le
    // afirmaba al caller lo primero sobre SU plata. Y el aviso de no reintentar es
    // material: el nonce ya quedó registrado, así que el reintento da X402_REPLAY.
    const { res } = await callWithSettleRejection(
      new FacilitatorSettleError('aborted due to timeout', 'unknown'),
    );

    const body = JSON.stringify(res.json());
    expect(body).toMatch(/UNKNOWN/);
    expect(body).toMatch(/may or may not have executed/);
    expect(body).toMatch(/Do NOT retry with the same payment header/);
    // Y NO la frase que afirma que no se cobró.
    expect(body).not.toMatch(/Payment settlement failed/);
  });

  it('T-198-AR-INBOUND-MSG-plain: un rechazo normal SIGUE diciendo "settlement failed"', async () => {
    // Contra-ejemplo: el mensaje nuevo es SÓLO para el unknown. Si se aplicara a todo,
    // dejaría de distinguir nada (y perdería la promesa correcta del caso rechazado).
    const { res } = await callWithSettleRejection(
      new Error('facilitator rejected the payload'),
    );
    const body = JSON.stringify(res.json());
    expect(body).toMatch(/Payment settlement failed/);
    expect(body).not.toMatch(/may or may not have executed/);
  });

  it('T-198-AR-INBOUND-EVENT: el unknown deja una fila DURABLE (a2a_event) con el nonce', async () => {
    // Un log no es una superficie de reconciliación. El lado outbound recibió estado
    // durable + listPending(); el inbound se quedaba sólo con el log, sobre la plata del
    // caller. El nonce es la clave para cruzarlo contra la cadena.
    mockTrack.mockClear();
    await callWithSettleRejection(
      new FacilitatorSettleError('aborted due to timeout', 'unknown'),
    );

    expect(mockTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'x402_settle_unknown',
        status: 'failed',
        metadata: expect.objectContaining({
          error_code: 'X402_SETTLE_UNKNOWN',
          valueDisposition: 'unknown',
          authorizationNonce: expect.any(String),
        }),
      }),
    );
  });

  it('T-198-AR-INBOUND-EVENT-plain: un rechazo normal NO persiste el evento', async () => {
    mockTrack.mockClear();
    await callWithSettleRejection(
      new Error('facilitator rejected the payload'),
    );
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('T-198-AR-INBOUND-EVENT-throws: si el insert del evento falla, el rechazo queda MANEJADO y el 402 sale completo', async () => {
    // AR#2 BLQ-BAJO-2(b): la versión anterior sólo afirmaba `statusCode===402`, que NO
    // cambia con ni sin `.catch()` — así que borrar el `.catch()` dejaba la suite verde.
    // Y la regresión real es grave: sin `.catch()` el rechazo de `track()` es un
    // `unhandledRejection`, y en Node ≥15 eso TUMBA EL PROCESO por default
    // (`--unhandled-rejections=throw`). O sea que el candado de "la telemetría no puede
    // cambiar la respuesta de un money-path" no detectaba la peor consecuencia posible
    // de esa línea: que se caiga el gateway entero.
    //
    // Ahora se afirman las TRES cosas: (1) el rechazo fue MANEJADO (se observa el
    // `unhandledRejection` del proceso), (2) quedó el log de la pérdida de telemetría, y
    // (3) el body del 402 llegó COMPLETO con el mensaje de unknown.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      mockTrack.mockClear();
      mockTrack.mockRejectedValueOnce(new Error('relation does not exist'));
      const { res, errors } = await callWithSettleRejection(
        new FacilitatorSettleError('aborted due to timeout', 'unknown'),
      );

      // (3) la respuesta del money-path no se degradó.
      expect(res.statusCode).toBe(402);
      expect(JSON.stringify(res.json())).toMatch(
        /may or may not have executed/,
      );

      // (2) la pérdida de telemetría dejó rastro propio: es la prueba POSITIVA de que
      // alguien atrapó el rechazo (un `.catch()` ausente no loguea nada).
      expect(
        errors.find(
          (e) => e.obj.error_code === 'X402_SETTLE_UNKNOWN_EVENT_FAILED',
        ),
      ).toBeDefined();

      // (1) y el proceso no quedó con un rechazo sin manejar. Se da una vuelta de
      // microtask+macrotask para que el `unhandledRejection` de Node alcance a emitirse
      // si el `.catch()` no existiera.
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('T-198-INBOUND-PLAIN: un settle que tira un Error común NO emite la señal (sigue siendo un 402 normal)', async () => {
    // Contra-ejemplo: le da contenido al test de arriba. Si la señal se emitiera
    // para cualquier throw, dejaría de significar "puede haber plata en el aire".
    const { res, errors } = await callWithSettleRejection(
      new Error('facilitator rejected the payload'),
    );

    expect(res.statusCode).toBe(402);
    expect(
      errors.find((e) => e.obj.error_code === 'X402_SETTLE_UNKNOWN'),
    ).toBeUndefined();
  });

  it('T-198-INBOUND-NOT-SENT: not-sent tampoco emite la señal (probado que no hubo request)', async () => {
    const { res, errors } = await callWithSettleRejection(
      new FacilitatorSettleError('ECONNREFUSED', 'not-sent'),
    );

    expect(res.statusCode).toBe(402);
    expect(
      errors.find((e) => e.obj.error_code === 'X402_SETTLE_UNKNOWN'),
    ).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// HU-201 (AR BLQ-MEDIO-1) — EL SEGUNDO EJE DEL MISMO ENDPOINT.
//
// Los tests de arriba cubren el eje "el hop NO contestó" (throw). Este es el otro: el
// facilitator CONTESTÓ 2xx con `success:false` PERO CON un txHash — el camino pieverse,
// que devuelve la respuesta verbatim. Antes se le respondía al caller "Payment
// settlement failed" TENIENDO EL HASH EN LA MANO, sin log alertable y sin evento
// durable: se le afirmaba que no se le cobró.
//
// Por qué importa más acá que en el outbound: es plata del CALLER, en el endpoint más
// expuesto, y el nonce inbound ya quedó quemado antes del settle, así que el reintento
// del mismo header da X402_REPLAY. Paga y no tiene dónde reclamar.
// ════════════════════════════════════════════════════════════════════════════
describe('HU-201: settle inbound `success:false` CON evidencia de broadcast', () => {
  const ORIGINAL_WALLET = process.env.KITE_WALLET_ADDRESS;
  const EVIDENCE = '0xBROADCASTEDBUTREJECTED';

  beforeEach(() => {
    vi.clearAllMocks();
    kiteAdapter.verify.mockResolvedValue({ valid: true });
    mockNonceInsert.mockResolvedValue({ data: null, error: null });
    process.env.KITE_WALLET_ADDRESS = SERVER_WALLET;
  });

  afterEach(() => {
    if (ORIGINAL_WALLET === undefined) delete process.env.KITE_WALLET_ADDRESS;
    else process.env.KITE_WALLET_ADDRESS = ORIGINAL_WALLET;
  });

  /** Igual que `callWithSettleRejection` pero con un settle que RESUELVE. */
  async function callWithSettleResult(result: {
    txHash: string;
    success: boolean;
    error?: string;
  }) {
    const { logger, errors } = makeCapturingLogger();
    const app = buildApp(logger);
    await app.ready();
    try {
      kiteAdapter.settle.mockResolvedValueOnce(result);
      const { headers } = buildEoaPaymentHeader({
        to: SERVER_WALLET,
        value: KITE_VALUE,
      });
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers: { ...headers, 'x-payment-chain': 'kite-ozone-testnet' },
        payload: {},
      });
      return { res, errors };
    } finally {
      await app.close();
    }
  }

  it('T-201-INBOUND-UNKNOWN: `success:false` CON hash → 402 sin acceso + señal alertable X402_SETTLE_UNKNOWN (antes: 402 mudo)', async () => {
    const { res, errors } = await callWithSettleResult({
      txHash: EVIDENCE,
      success: false,
      error: 'reverted after broadcast',
    });

    // Propiedad 1 (sin cambios): sin confirmación NO se sirve el recurso.
    expect(res.statusCode).toBe(402);
    expect(res.json()).not.toEqual({ paid: true });

    // Propiedad 2 (la que faltaba): el caso deja de ser indistinguible de un rechazo.
    const unknownLog = errors.find(
      (e) => e.obj.error_code === 'X402_SETTLE_UNKNOWN',
    );
    expect(unknownLog).toBeDefined();
    expect(unknownLog?.obj.valueDisposition).toBe('unknown');
    // Y el hash viaja en el log: es LA clave para cruzar contra la cadena.
    expect(unknownLog?.obj.settleTxHash).toBe(EVIDENCE);
  });

  it('T-201-INBOUND-MSG: el 402 NO le dice al caller "settlement failed" y le entrega el hash', async () => {
    const { res } = await callWithSettleResult({
      txHash: EVIDENCE,
      success: false,
      error: 'reverted after broadcast',
    });

    const body = JSON.stringify(res.json());
    expect(body).toMatch(/UNKNOWN/);
    expect(body).toMatch(/may or may not have executed/);
    expect(body).toMatch(/Do NOT retry with the same payment header/);
    // El caller se lleva la evidencia y puede mirar la cadena sin depender de nosotros.
    expect(body).toContain(EVIDENCE);
    // Y NO la frase que afirma que no se le cobró.
    expect(body).not.toMatch(/Payment settlement failed/);
  });

  it('T-201-INBOUND-EVENT: deja una fila DURABLE (a2a_event) con el hash Y el nonce', async () => {
    mockTrack.mockClear();
    await callWithSettleResult({
      txHash: EVIDENCE,
      success: false,
      error: 'reverted after broadcast',
    });

    expect(mockTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'x402_settle_unknown',
        status: 'failed',
        metadata: expect.objectContaining({
          error_code: 'X402_SETTLE_UNKNOWN',
          valueDisposition: 'unknown',
          settleTxHash: EVIDENCE,
          authorizationNonce: expect.any(String),
        }),
      }),
    );
  });

  // ── LOS CONTRA-EJEMPLOS: sin estos, mandar TODO rechazo al canal unknown pasaría
  //    verde y el caller dejaría de recibir el diagnóstico correcto de su rechazo.

  it('T-201-INBOUND-CONTRA: `success:false` SIN hash sigue siendo un rechazo normal (mensaje "settlement failed", sin señal, sin evento)', async () => {
    mockTrack.mockClear();
    const { res, errors } = await callWithSettleResult({
      txHash: '',
      success: false,
      error: 'insufficient balance',
    });

    expect(res.statusCode).toBe(402);
    const body = JSON.stringify(res.json());
    expect(body).toMatch(/Payment settlement failed/);
    expect(body).not.toMatch(/may or may not have executed/);
    expect(
      errors.find((e) => e.obj.error_code === 'X402_SETTLE_UNKNOWN'),
    ).toBeUndefined();
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('T-201-INBOUND-CONTRA-OK: un settle EXITOSO no toca ninguno de los dos canales', async () => {
    mockTrack.mockClear();
    const { errors } = await callWithSettleResult({
      txHash: '0xdeadbeef',
      success: true,
    });

    expect(
      errors.find((e) => e.obj.error_code === 'X402_SETTLE_UNKNOWN'),
    ).toBeUndefined();
    expect(mockTrack).not.toHaveBeenCalled();
  });
});
