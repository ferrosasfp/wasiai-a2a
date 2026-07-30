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
  InvalidAllowTrialError,
  InvalidLimitError,
  InvalidMinReputationError,
  parseAllowTrial,
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
 * Y el 4º, cazado en la it3 (MENOR-3), de la MISMA clase:
 *   · `limit=1e21` → `Number.isInteger` lo aceptaba ⇒ se reenviaba upstream como
 *     el literal `'1e+21'` ⇒ un registry que lo rechaza tira, el fanout degrada a
 *     `[]` ⇒ 200 con 0 agentes.
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

  it('T-L6: NO hay techo de magnitud (el over-fetch es monótono a propósito)', () => {
    expect(parseLimit('100000')).toBe(100000);
    // El borde del rango seguro sigue siendo válido: `String()` lo da plano.
    expect(parseLimit(String(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(String(Number.MAX_SAFE_INTEGER)).not.toMatch(/e/i);
  });

  /**
   * AR it3 MENOR-3 — mismo agujero de clase que el `limit=0`: `1e21` pasaba
   * `Number.isInteger`, se reenviaba upstream como el literal `'1e+21'` y un
   * registry que lo rechaza hacía que `/discover` devolviera **200 con 0 agentes**
   * (el `catch` del fanout degrada a `[]`), violando en silencio el
   * `min(limit, total)` de `doc/INTEGRATION.md`.
   */
  it('T-L8: fuera del rango de entero seguro → InvalidLimitError (antes se reenviaba como "1e+21")', () => {
    // Precondición del bug, fijada: `isInteger` lo aceptaba y `toString` daba
    // notación científica.
    expect(Number.isInteger(1e21)).toBe(true);
    expect((1e21).toString()).toBe('1e+21');

    expect(() => parseLimit('1e21')).toThrow(InvalidLimitError);
    expect(() => parseLimit(1e21)).toThrow(InvalidLimitError);
    expect(() => parseLimit(Number.MAX_SAFE_INTEGER + 2)).toThrow(
      InvalidLimitError,
    );
    expect(() => parseLimit('1e21')).toThrow(/safe integer/);
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

// ── T-14 (WKH-313 / DT-7) · parseAllowTrial ─────────────────────────────
//
// `allowTrial` es el OPT-IN a admitir un agente SIN HISTORIAL bajo el piso que el
// caller pidió, sobre el camino del dinero. Un flag así no se adivina: por eso el
// parser es explícito y no un `Boolean(raw)`.
describe('T-14 · parseAllowTrial (WKH-313)', () => {
  it('T-AT1: ausente / null / vacío → undefined (no opta: comportamiento de hoy)', () => {
    expect(parseAllowTrial(undefined)).toBeUndefined();
    expect(parseAllowTrial(null)).toBeUndefined();
    expect(parseAllowTrial('')).toBeUndefined();
  });

  it('T-AT2: `true` y `"true"` → true (GET y POST parsean IGUAL)', () => {
    // El GET trae string y el POST trae boolean: los dos tienen que llegar al
    // mismo lugar, porque los dos son el mismo endpoint.
    expect(parseAllowTrial(true)).toBe(true);
    expect(parseAllowTrial('true')).toBe(true);
  });

  it('T-AT3: `false` y `"false"` → undefined (apagarlo explícito = no optar)', () => {
    // Lo que este test canda es que `"false"` NO sea truthy. Con un `Boolean(raw)`,
    // un caller que escribe `?allowTrial=false` terminaría ACEPTANDO candidatos en
    // estreno — exactamente lo contrario de lo que pidió.
    expect(parseAllowTrial(false)).toBeUndefined();
    expect(parseAllowTrial('false')).toBeUndefined();
  });

  it.each([
    'maybe',
    '1',
    '0',
    'TRUE',
    'yes',
    'on',
    ' true',
    1,
    0,
    {},
    [],
  ])('T-AT4: %j → InvalidAllowTrialError (nunca se adivina un flag de riesgo)', (raw) => {
    expect(() => parseAllowTrial(raw)).toThrow(InvalidAllowTrialError);
  });

  it('T-AT5: el error lleva el code que la ruta mapea a 400', () => {
    try {
      parseAllowTrial('maybe');
      expect.unreachable('debía lanzar');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidAllowTrialError);
      expect((err as InvalidAllowTrialError).code).toBe('INVALID_ALLOW_TRIAL');
      expect((err as InvalidAllowTrialError).received).toBe('maybe');
    }
  });
});
