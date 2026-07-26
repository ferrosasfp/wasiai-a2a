/**
 * Monto del challenge 402 — montos EXACTOS, sin tolerancia (fix-pack P1, hallazgo 3).
 *
 * El camino completo del monto:
 *   route preHandler → request.x402ChallengeAmountUsd
 *   → PaymentMiddlewareOptions.amountUsd
 *   → resolvePaymentRequirements (x402.ts)  → adapter.quote(amountUsd).amountWei
 *   → buildX402Response  → payload.maxAmountRequired   (VERBATIM, x402.ts)
 *
 * El bug vivía en el último eslabón real (`quote()` de cada adapter), que hacía
 * `parseUnits(amountUsd.toFixed(DECIMALS), DECIMALS)`. A 18 decimales `toFixed`
 * emite la expansión BINARIA del double, no el decimal que representa.
 *
 * Este suite ataca dos cosas:
 *   1. `quote()` de los adapters REALES (sin mock del helper) para 18 y 6 dec.
 *   2. Que `buildX402Response` propague `amountWei` a `maxAmountRequired` sin
 *      tocarlo (o sea que el fix del punto 1 llegue de verdad a la respuesta).
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/logger.js', () => ({
  getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

// El registry de adapters exige `initAdapters()` (env-dependiente). Se mockea
// SÓLO el lookup: `getPaymentAdapter` devuelve el adapter Kite REAL, así que el
// `quote()` que corre en el test del passthrough es el de producción — que es
// justamente el eslabón donde vivía el bug.
vi.mock('../adapters/registry.js', async () => {
  const { KiteOzonePaymentAdapter } = await import(
    '../adapters/kite-ozone/payment.js'
  );
  const real = new KiteOzonePaymentAdapter();
  return {
    getPaymentAdapter: () => real,
    getPaymentAdapterOrUnion: () => real,
  };
});

import { AvalanchePaymentAdapter } from '../adapters/avalanche/payment.js';
import { BasePaymentAdapter } from '../adapters/base/payment.js';
import { KiteOzonePaymentAdapter } from '../adapters/kite-ozone/payment.js';

describe('quote() — 18 decimales (la chain default, donde el artefacto pegaba)', () => {
  const adapter = new KiteOzonePaymentAdapter();

  // [usd, atómico correcto, lo que emitía el toFixed(18) anterior]
  const cases: Array<[number, string, string]> = [
    [0.03, '30000000000000000', '29999999999999999'], // −1 wei: el caso del reporte
    [0.1, '100000000000000000', '100000000000000006'], // +6 wei
    [0.29, '290000000000000000', '289999999999999980'], // −20 wei
    [1.1, '1100000000000000000', '1100000000000000089'], // +89 wei
    [1.005, '1005000000000000000', '1004999999999999893'], // −107 wei
  ];

  for (const [usd, expected, buggy] of cases) {
    it(`T-18-${usd}: quote(${usd}).amountWei === '${expected}' exacto`, async () => {
      const { amountWei } = await adapter.quote(usd);
      expect(amountWei).toBe(expected);
      expect(amountWei).not.toBe(buggy);
    });
  }

  it('T-18-round: sigue siendo un entero decimal sin signo ni punto', async () => {
    const { amountWei } = await adapter.quote(0.07);
    expect(amountWei).toMatch(/^\d+$/);
    expect(amountWei).toBe('70000000000000000');
  });

  it('T-18-decimals: el token declara 18 decimales (el monto es dimensional)', async () => {
    const q = await adapter.quote(1);
    expect(q.token.decimals).toBe(18);
    expect(q.amountWei).toBe('1000000000000000000');
  });
});

describe('quote() — 6 decimales USDC (INVARIANTE: el happy path no cambia)', () => {
  // El AR de la HU 188 exige probar que el monto cobrado en el happy path no
  // cambia. El money-path real es USDC 6-dec (Base / Avalanche): los montos de
  // abajo son los mismos que producía `parseUnits(v.toFixed(6), 6)`.
  const adapters = [
    ['base', new BasePaymentAdapter({ network: 'testnet' })],
    ['avalanche', new AvalanchePaymentAdapter({ network: 'fuji' })],
  ] as const;

  const cases: Array<[number, string]> = [
    [1, '1000000'],
    [0.03, '30000'], // el valor que a 18 dec daba −1 wei; a 6 dec siempre estuvo bien
    [0.1, '100000'],
    [0.29, '290000'],
    [1.1, '1100000'],
    [1.005, '1005000'],
    [0.001, '1000'],
    [0.000001, '1'], // 1 unidad atómica
    [400, '400000000'], // la remesa insignia
    [1234.56, '1234560000'],
  ];

  for (const [name, adapter] of adapters) {
    for (const [usd, expected] of cases) {
      it(`T-6-${name}-${usd}: quote(${usd}).amountWei === '${expected}' exacto`, async () => {
        const { amountWei } = await adapter.quote(usd);
        expect(amountWei).toBe(expected);
      });
    }

    it(`T-6-${name}-decimals: el token declara 6 decimales`, async () => {
      expect((await adapter.quote(1)).token.decimals).toBe(6);
    });
  }
});

describe('buildX402Response: maxAmountRequired = amountWei del adapter, VERBATIM', () => {
  it('T-PASS-1: el atómico de 18 dec del quote llega intacto al challenge', async () => {
    const { buildX402Response } = await import('./x402.js');
    const res = await buildX402Response(
      { description: 'test', amountUsd: 0.03 },
      'https://example.test/compose',
      'kite-ozone-testnet',
    );

    // Si el helper del monto se rompiera, ESTE número se mueve.
    expect(res.accepts[0]?.maxAmountRequired).toBe('30000000000000000');
    expect(res.x402Version).toBe(2);
  });

  it('T-PASS-2: `opts.amount` (atómico explícito) sigue teniendo precedencia', async () => {
    const { buildX402Response } = await import('./x402.js');
    const res = await buildX402Response(
      { description: 'test', amount: '7777777', amountUsd: 0.03 },
      'https://example.test/compose',
      'kite-ozone-testnet',
    );

    expect(res.accepts[0]?.maxAmountRequired).toBe('7777777');
  });

  it('T-PASS-3: sin amountUsd cae al default de 1 USD (18 dec, sin artefacto)', async () => {
    const { buildX402Response } = await import('./x402.js');
    const res = await buildX402Response(
      { description: 'test' },
      'https://example.test/compose',
      'kite-ozone-testnet',
    );

    expect(res.accepts[0]?.maxAmountRequired).toBe('1000000000000000000');
  });
});
