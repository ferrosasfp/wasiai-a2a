/**
 * HU-201 (AR BLQ-ALTO) — UN HTTP NON-2XX DEL FACILITATOR NO ES `success:false`.
 *
 * QUÉ SE CANDA Y POR QUÉ, en los CINCO caminos de settle del repo:
 *
 *   · Un HTTP non-2xx (502/504/500/4xx) tiene que salir como `FacilitatorSettleError`
 *     con `valueDisposition:'unknown'`. Antes se APLANABA a `{ success:false }` (los 4
 *     settle x402) o salía como `Error` PELADO (kite-pieverse, el modo DEFAULT). Aguas
 *     abajo, `services/payment-intent.ts` lee `success:false` como "el facilitator
 *     confirmó que no se ejecutó" ⟹ reembolsa el deposit del buyer y/o habilita el
 *     re-envío del hop 2 al seller. Un 502 no confirma nada: es el caso canónico del
 *     proxy que corta DESPUÉS del broadcast.
 *
 *   · EL CONTRA-EJEMPLO ES LA MITAD IMPORTANTE: un 2xx cuyo cuerpo canónico dice
 *     `settled:false` TIENE que seguir devolviendo `{ success:false }`. Ese es el
 *     veredicto del facilitator sobre su propio trabajo, y es la entrada legítima del
 *     reconciliador: si esto también se volviera una excepción, el seller dejaría de
 *     cobrar automáticamente en el rechazo normal y el buyer no recuperaría su deposit.
 *
 * Los 5 caminos se ejercitan en UN archivo a propósito: la propiedad es que se comportan
 * IGUAL. Cada uno vive en su propio archivo fuente, así que una mutación en cualquiera de
 * ellos pone rojo sólo su propio test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({ getLogger: () => logSpy }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { AvalanchePaymentAdapter } from './avalanche/payment.js';
import { BasePaymentAdapter } from './base/payment.js';
import {
  FacilitatorSettleError,
  readSettleValueDisposition,
} from './errors.js';
import { KiteOzonePaymentAdapter } from './kite-ozone/payment.js';
import { TempoPaymentAdapter } from './tempo/payment.js';
import type { EvmPaymentAdapter, SettleRequest } from './types.js';

const SETTLE_REQ: SettleRequest = {
  authorization: {
    from: '0x1111111111111111111111111111111111111111',
    to: '0x2222222222222222222222222222222222222222',
    value: '1000000',
    validAfter: '0',
    validBefore: '9999999999',
    nonce: `0x${'a'.repeat(64)}`,
  },
  signature: '0xSIG',
  network: 'eip155:1',
};

/** Un 502 con cuerpo: la ambigüedad post-broadcast canónica. */
function respond502(): void {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status: 502,
    json: async () => ({ error: { code: 'BAD_GATEWAY', message: 'upstream' } }),
    text: async () => 'bad gateway',
  });
}

/** El veredicto legítimo: 2xx + cuerpo canónico diciendo que no settleó. */
function respondRejected200(): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({
      settled: false,
      success: false, // forma pieverse
      error: { code: 'INSUFFICIENT_BALANCE', message: 'no balance' },
    }),
    text: async () => 'rejected',
  });
}

// [nombre del caso, archivo fuente que lo implementa, fábrica del adapter]
const X402_PATHS: [string, string, () => EvmPaymentAdapter][] = [
  [
    'base',
    'src/adapters/base/payment.ts',
    () => new BasePaymentAdapter({ network: 'testnet' }),
  ],
  [
    'avalanche',
    'src/adapters/avalanche/payment.ts',
    () => new AvalanchePaymentAdapter({ network: 'fuji' }),
  ],
  ['tempo', 'src/adapters/tempo/payment.ts', () => new TempoPaymentAdapter()],
  [
    'kite (modo x402)',
    'src/adapters/kite-ozone/payment.ts',
    () => {
      process.env.KITE_FACILITATOR_MODE = 'x402';
      return new KiteOzonePaymentAdapter();
    },
  ],
];

describe('HU-201 · settle: HTTP non-2xx ≠ success:false', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.KITE_FACILITATOR_MODE;
  });
  afterEach(() => {
    delete process.env.KITE_FACILITATOR_MODE;
  });

  for (const [name, sourceFile, make] of X402_PATHS) {
    describe(`${name} — ${sourceFile}`, () => {
      it('T-201-HTTP: un 502 NO devuelve success:false — tira FacilitatorSettleError con valueDisposition "unknown"', async () => {
        const adapter = make();
        respond502();

        const err = await adapter
          .settle({ ...SETTLE_REQ })
          .catch((e: unknown) => e);

        // Lo que NO puede pasar: que salga como un resultado y no como un error.
        // Un `{ success:false }` acá reembolsa al buyer aguas abajo.
        expect(err).toBeInstanceOf(FacilitatorSettleError);
        expect(readSettleValueDisposition(err)).toBe('unknown');
        expect((err as Error).message).toMatch(/HTTP 502/);
      });

      it('T-201-HTTP-CONTRA: un 200 con `settled:false` SIGUE devolviendo success:false (el veredicto legítimo del facilitator)', async () => {
        const adapter = make();
        respondRejected200();

        const result = await adapter.settle({ ...SETTLE_REQ });

        // Sigue siendo un RESULTADO, no una excepción: es lo que mantiene vivo el
        // refund al buyer y el re-envío del hop 2 al seller.
        expect(result.success).toBe(false);
        expect(result.error).toBe('no balance');
        // Y sin txHash ⟹ `hasBroadcastEvidence` lo deja `unequivocal`.
        expect(result.txHash).toBe('');
      });

      it('T-201-HTTP-BODY: un body que no parsea también es unknown', async () => {
        const adapter = make();
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 500,
          json: async () => {
            throw new SyntaxError('Unexpected token');
          },
          text: async () => 'not json',
        });

        const err = await adapter
          .settle({ ...SETTLE_REQ })
          .catch((e: unknown) => e);

        expect(readSettleValueDisposition(err)).toBe('unknown');
      });
    });
  }

  // ── El 5º camino: kite en modo pieverse = EL DEFAULT DE PRODUCCIÓN ──
  //
  // `KITE_FACILITATOR_MODE` sin setear ⟹ pieverse (`.env.example`: "current
  // production path"). Acá el non-2xx NUNCA se aplanó a `success:false` — salía como
  // `Error` PELADO, que es peor de otra forma: `readSettleValueDisposition() ===
  // undefined`, así que `middleware/x402.ts` y `lib/downstream-payment.ts` lo trataban
  // como un settle fallido más, sin superficie de reconciliación (el MISMO colapso que
  // HU-198 arregló para el abort del techo de wall-clock).
  describe('kite (modo pieverse, el DEFAULT) — src/adapters/kite-ozone/payment.ts', () => {
    it('T-201-HTTP-PIEVERSE: un 502 tira FacilitatorSettleError con valueDisposition "unknown" (antes: Error pelado, sin disposición)', async () => {
      const adapter = new KiteOzonePaymentAdapter();
      respond502();

      const err = await adapter
        .settle({ ...SETTLE_REQ })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(FacilitatorSettleError);
      expect(readSettleValueDisposition(err)).toBe('unknown');
      expect((err as Error).message).toMatch(/HTTP 502/);
    });

    it('T-201-HTTP-PIEVERSE-CONTRA: un 200 con `success:false` SIGUE devolviendo un resultado, no una excepción', async () => {
      const adapter = new KiteOzonePaymentAdapter();
      respondRejected200();

      const result = await adapter.settle({ ...SETTLE_REQ });

      expect(result.success).toBe(false);
    });

    it('T-201-PIEVERSE-HASH: el txHash de un `success:false` se devuelve VERBATIM (es la evidencia de broadcast que lee payment-intent)', async () => {
      // El caso #1 del BLQ-ALTO: el facilitator contesta 200 con `success:false` PERO
      // con un hash. Si el adapter lo normalizara a '' acá, `hasBroadcastEvidence`
      // no tendría nada que leer y el buyer se reembolsaría con el seller pagado.
      const adapter = new KiteOzonePaymentAdapter();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: false,
          txHash: '0xBROADCASTED',
          error: 'reverted after broadcast',
        }),
        text: async () => 'x',
      });

      const result = await adapter.settle({ ...SETTLE_REQ });

      expect(result.success).toBe(false);
      expect(result.txHash).toBe('0xBROADCASTED');
    });
  });
});
