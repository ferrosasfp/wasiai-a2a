/**
 * Validación de `minReputation` (fix-pack P1, hallazgo 2).
 *
 * Cierra el modo de falla que NO estaba en el reporte: `parseFloat('abc')` es
 * `NaN` y `NaN != null` es `true`, así que un valor basura llegaba al
 * `DiscoveryQuery`. Con el filtro implementado eso daría 0 resultados con HTTP
 * 200 — cambiar un P1 silencioso por otro.
 */

import { describe, expect, it } from 'vitest';
import {
  InvalidMinReputationError,
  parseMinReputation,
} from './discovery-query.js';

describe('parseMinReputation', () => {
  it('T-V1: ausente/vacío → undefined (no filtra)', () => {
    expect(parseMinReputation(undefined)).toBeUndefined();
    expect(parseMinReputation(null)).toBeUndefined();
    expect(parseMinReputation('')).toBeUndefined();
  });

  it('T-V2: valores válidos del rango 0-100 (string del query y number del body)', () => {
    expect(parseMinReputation('0')).toBe(0);
    expect(parseMinReputation('50')).toBe(50);
    expect(parseMinReputation('100')).toBe(100);
    expect(parseMinReputation('72.5')).toBe(72.5);
    expect(parseMinReputation(60)).toBe(60);
    expect(parseMinReputation(0)).toBe(0);
  });

  it('T-V3: no numérico → InvalidMinReputationError (antes producía NaN silencioso)', () => {
    expect(() => parseMinReputation('abc')).toThrow(InvalidMinReputationError);
    expect(() => parseMinReputation(Number.NaN)).toThrow(
      InvalidMinReputationError,
    );
    // `Number('12abc')` es NaN — `parseFloat` habría devuelto 12 y aceptado basura.
    expect(() => parseMinReputation('12abc')).toThrow(
      InvalidMinReputationError,
    );
    expect(() => parseMinReputation({})).toThrow(InvalidMinReputationError);
  });

  it('T-V4: fuera de rango → InvalidMinReputationError', () => {
    expect(() => parseMinReputation('-1')).toThrow(InvalidMinReputationError);
    expect(() => parseMinReputation('101')).toThrow(InvalidMinReputationError);
    expect(() => parseMinReputation(-0.0001)).toThrow(
      InvalidMinReputationError,
    );
    expect(() => parseMinReputation(Number.POSITIVE_INFINITY)).toThrow(
      InvalidMinReputationError,
    );
  });

  it('T-V5: el error lleva el code que la ruta mapea a 400 y el valor recibido', () => {
    try {
      parseMinReputation('abc');
      expect.unreachable('debía lanzar');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidMinReputationError);
      expect((err as InvalidMinReputationError).code).toBe(
        'INVALID_MIN_REPUTATION',
      );
      expect((err as InvalidMinReputationError).received).toBe('abc');
    }
  });

  it('T-V6: el mensaje explicita la escala 0-100 (el JSDoc de la ruta decía 0-1 y era falso)', () => {
    expect(() => parseMinReputation('0.5x')).toThrow(/between 0 and 100/);
  });
});
