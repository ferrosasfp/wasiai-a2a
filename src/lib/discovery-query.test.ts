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
  InvalidLimitError,
  InvalidMinReputationError,
  parseLimit,
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

/**
 * AR MENOR-4 — `limit` quedó sin validar mientras `doc/INTEGRATION.md` (agregado
 * en este mismo fix-pack) promete «exactly `min(limit, total)` agents». Los tres
 * modos degenerados MEDIDOS contra el código pre-fix, que el contrato del doc
 * contradecía en silencio:
 *   · `limit=0`  → falsy ⇒ ni `limitParam` upstream ni `slice` ⇒ devolvía TODO.
 *   · `limit=-3` → `slice(0,-3)` ⇒ devolvía `total-3`.
 *   · `limit=abc` → `parseInt` NaN ⇒ falsy ⇒ devolvía TODO.
 */
describe('parseLimit (AR MENOR-4)', () => {
  it('T-L1: ausente/vacío → undefined (sin page size: todos los matches)', () => {
    expect(parseLimit(undefined)).toBeUndefined();
    expect(parseLimit(null)).toBeUndefined();
    expect(parseLimit('')).toBeUndefined();
  });

  it('T-L2: enteros >= 1 (string del query y number del body)', () => {
    expect(parseLimit('1')).toBe(1);
    expect(parseLimit('5')).toBe(5);
    expect(parseLimit('500')).toBe(500);
    expect(parseLimit(20)).toBe(20);
  });

  it('T-L3: 0 → InvalidLimitError (antes devolvía el catálogo COMPLETO)', () => {
    expect(() => parseLimit('0')).toThrow(InvalidLimitError);
    expect(() => parseLimit(0)).toThrow(InvalidLimitError);
  });

  it('T-L4: negativo → InvalidLimitError (antes `slice(0,-3)` devolvía total-3)', () => {
    expect(() => parseLimit('-3')).toThrow(InvalidLimitError);
    expect(() => parseLimit(-1)).toThrow(InvalidLimitError);
  });

  it('T-L5: no numérico / no entero → InvalidLimitError', () => {
    expect(() => parseLimit('abc')).toThrow(InvalidLimitError);
    expect(() => parseLimit('5abc')).toThrow(InvalidLimitError);
    expect(() => parseLimit('1.5')).toThrow(InvalidLimitError);
    expect(() => parseLimit(Number.NaN)).toThrow(InvalidLimitError);
    expect(() => parseLimit(Number.POSITIVE_INFINITY)).toThrow(
      InvalidLimitError,
    );
    expect(() => parseLimit({})).toThrow(InvalidLimitError);
  });

  it('T-L6: NO hay techo (el over-fetch es monótono a propósito)', () => {
    expect(parseLimit('100000')).toBe(100000);
  });

  it('T-L7: el error lleva el code que la ruta mapea a 400', () => {
    try {
      parseLimit('0');
      expect.unreachable('debía lanzar');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidLimitError);
      expect((err as InvalidLimitError).code).toBe('INVALID_LIMIT');
      expect((err as InvalidLimitError).received).toBe('0');
    }
  });
});
