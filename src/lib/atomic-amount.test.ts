/**
 * `usdToAtomicUnits` — conversión USD → unidades atómicas (fix-pack P1, hallazgo 3).
 *
 * El bug: los 5 adapters hacían `parseUnits(amountUsd.toFixed(DECIMALS), DECIMALS)`.
 * `toFixed(18)` no emite el decimal que el double representa, emite su expansión
 * BINARIA, así que el monto del challenge 402 salía con un artefacto de float en
 * las chains de 18 decimales (la default, Kite/PYUSD).
 *
 * Montos EXACTOS, sin tolerancia: un monto de dinero no se assertea con `toBeCloseTo`.
 */

import { parseUnits } from 'viem';
import { describe, expect, it } from 'vitest';
import { usdToAtomicUnits } from './atomic-amount.js';

/** El camino viejo (`toFixed` → `parseUnits`), para comparar contra él. */
function legacyToFixedPath(v: number, decimals: number): string {
  return parseUnits(v.toFixed(decimals), decimals).toString();
}

describe('usdToAtomicUnits — 18 decimales (la chain default: el bug)', () => {
  // Tabla medida PRE-FIX con `parseUnits(v.toFixed(18), 18)`. La 3ª columna es
  // lo que se advertía en el challenge 402; la 2ª es lo correcto.
  const cases: Array<[number, string, string]> = [
    // usd     esperado (correcto)      lo que emitía toFixed(18)
    [0.03, '30000000000000000', '29999999999999999'], // −1 wei (el "1 wei" del reporte)
    [0.1, '100000000000000000', '100000000000000006'], // +6
    [0.2, '200000000000000000', '200000000000000011'], // +11
    [0.29, '290000000000000000', '289999999999999980'], // −20
    [0.35, '350000000000000000', '349999999999999978'], // −22
    [1.1, '1100000000000000000', '1100000000000000089'], // +89
    [2.9, '2900000000000000000', '2899999999999999911'], // −89
    [1.005, '1005000000000000000', '1004999999999999893'], // −107
    [0.07, '70000000000000000', '70000000000000007'], // +7
    [1.15, '1150000000000000000', '1149999999999999911'], // −89
  ];

  for (const [usd, expected, buggy] of cases) {
    it(`T-18-${usd}: ${usd} USD → ${expected} (no ${buggy})`, () => {
      expect(usdToAtomicUnits(usd, 18)).toBe(expected);
      expect(usdToAtomicUnits(usd, 18)).not.toBe(buggy);
    });
  }

  it('T-18-exactos: los valores que ya salían bien siguen saliendo bien', () => {
    expect(usdToAtomicUnits(1, 18)).toBe('1000000000000000000');
    expect(usdToAtomicUnits(0.5, 18)).toBe('500000000000000000');
    expect(usdToAtomicUnits(0.001, 18)).toBe('1000000000000000');
    expect(usdToAtomicUnits(0, 18)).toBe('0');
  });
});

describe('usdToAtomicUnits — 6 decimales (USDC: el money-path que NO debe cambiar)', () => {
  it('T-6-1: montos USDC exactos', () => {
    expect(usdToAtomicUnits(1, 6)).toBe('1000000');
    expect(usdToAtomicUnits(0.03, 6)).toBe('30000');
    expect(usdToAtomicUnits(0.1, 6)).toBe('100000');
    expect(usdToAtomicUnits(1.005, 6)).toBe('1005000');
    expect(usdToAtomicUnits(0.000001, 6)).toBe('1'); // 1 unidad atómica
    expect(usdToAtomicUnits(0, 6)).toBe('0');
  });

  it('T-6-2 (INVARIANTE): idéntico a `toFixed(6)` en 200k floats aleatorios', () => {
    // El monto cobrado en el happy path (USDC, 6 dec) NO cambia. Esta es la
    // prueba del invariante que exigió el AR de la HU 188: el fix sólo mueve
    // montos en tokens de > 6 decimales.
    let diffs = 0;
    for (let i = 0; i < 200_000; i++) {
      const v = Math.random() * 100;
      if (usdToAtomicUnits(v, 6) !== legacyToFixedPath(v, 6)) diffs++;
    }
    expect(diffs).toBe(0);
  });

  it('T-6-3 (INVARIANTE): idéntico a `toFixed(6)` en los precios reales del catálogo', () => {
    const realPrices = [
      0.001, 0.002, 0.005, 0.01, 0.02, 0.03, 0.05, 0.1, 0.15, 0.2, 0.25, 0.5,
      0.75, 1, 1.5, 2, 2.5, 3, 5, 10, 0.0001, 0.0025, 0.0075, 400, 1234.56,
    ];
    for (const p of realPrices) {
      expect(usdToAtomicUnits(p, 6)).toBe(legacyToFixedPath(p, 6));
    }
  });
});

describe('usdToAtomicUnits — notación científica (el motivo por el que existía el toFixed)', () => {
  it('T-SCI-1: sub-atómicos en notación científica NO lanzan (parseUnits sí lo haría)', () => {
    // `String(1e-7)` es '1e-7' y `parseUnits('1e-7', 6)` LANZA
    // ("Number `1e-7` is not a valid decimal number"). El helper expande el
    // exponente a decimal plano antes de llamar a parseUnits.
    expect(() => usdToAtomicUnits(1e-7, 6)).not.toThrow();
    expect(() => parseUnits(String(1e-7), 6)).toThrow(/not a valid decimal/);
    expect(usdToAtomicUnits(1e-7, 6)).toBe('0'); // redondea a la grilla del token
    expect(usdToAtomicUnits(1e-7, 18)).toBe('100000000000');
    expect(usdToAtomicUnits(1e-21, 18)).toBe('0');
  });

  it('T-SCI-2: exponente positivo grande', () => {
    expect(usdToAtomicUnits(1e21, 6)).toBe('1000000000000000000000000000');
    expect(usdToAtomicUnits(1.5e21, 6)).toBe('1500000000000000000000000000');
  });

  it('T-SCI-3: inputs patológicos se comportan EXACTAMENTE como antes del fix', () => {
    // Deliberado: el scope de este fix es el artefacto de float. Cambiar el
    // comportamiento en NaN/Infinity/negativos ampliaría el blast radius sobre
    // el money-path, así que se preserva byte-idéntico al camino `toFixed`.
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(() => usdToAtomicUnits(bad, 18)).toThrow(/not a valid decimal/);
      expect(() => legacyToFixedPath(bad, 18)).toThrow(/not a valid decimal/);
    }
    // Negativo: mismo atómico negativo que antes (TD-189-3 — agujero
    // PREEXISTENTE del guard de binding inbound, no introducido por este fix).
    expect(usdToAtomicUnits(-1, 6)).toBe('-1000000');
    expect(usdToAtomicUnits(-1, 6)).toBe(legacyToFixedPath(-1, 6));
    expect(usdToAtomicUnits(-0.5, 6)).toBe(legacyToFixedPath(-0.5, 6));
    expect(usdToAtomicUnits(-1e-7, 6)).toBe('0');
  });
});

describe('usdToAtomicUnits — otras precisiones de token', () => {
  it('T-DEC: 9 (SOL-like) y 0 decimales', () => {
    expect(usdToAtomicUnits(0.03, 9)).toBe('30000000');
    expect(usdToAtomicUnits(1.5, 9)).toBe('1500000000');
    expect(usdToAtomicUnits(3, 0)).toBe('3');
    expect(usdToAtomicUnits(3.7, 0)).toBe('4'); // redondea a la grilla
  });
});
