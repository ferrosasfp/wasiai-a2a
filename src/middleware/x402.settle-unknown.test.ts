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
      errors.push({ obj: obj as Record<string, unknown>, msg });
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
