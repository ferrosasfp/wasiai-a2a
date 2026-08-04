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
  assertKnownDiscoverParams,
  ConflictingMinReputationError,
  InvalidAllowTrialError,
  InvalidLimitError,
  InvalidMinReputationError,
  parseAllowTrial,
  parseLimit,
  parseMinReputation,
  resolveMinReputation,
  UnknownDiscoverParamError,
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

// ── WKH-322 · el alias `min_reputation` y el rechazo de claves desconocidas ──
//
// El mismo concepto se llama `min_reputation` en `constraints` de `/compose`
// (`compose-step-shape.ts:51`) y `minReputation` en `/discover`. Antes de esta HU
// el segundo nombre era el único que filtraba y el primero se descartaba con 200.
describe('WKH-322 · resolveMinReputation (alias min_reputation)', () => {
  it('T-U1: los dos nombres producen EL MISMO valor (no hay dos parseos)', () => {
    expect(resolveMinReputation('5', undefined)).toBe(5);
    expect(resolveMinReputation(undefined, '5')).toBe(5);
    expect(resolveMinReputation('5', undefined)).toBe(
      resolveMinReputation(undefined, '5'),
    );
  });

  it('T-U2: valores distintos por los dos nombres → ConflictingMinReputationError', () => {
    // Se rechaza en vez de aplicar precedencia: con "gana el camelCase",
    // `minReputation=0` + `min_reputation=5` devolvería 0 y descartaría en
    // silencio el piso explícito del caller.
    try {
      resolveMinReputation('0', '5');
      expect.unreachable('debía lanzar');
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictingMinReputationError);
      expect((err as ConflictingMinReputationError).code).toBe(
        'CONFLICTING_MIN_REPUTATION',
      );
    }
    expect(() => resolveMinReputation(1, 5)).toThrow(
      ConflictingMinReputationError,
    );
  });

  it('T-U3: el conflicto se mide sobre los NORMALIZADOS, no sobre los crudos', () => {
    // `'5' !== 5` y `'5' !== '5.0'` como crudos: comparar así daría un conflicto
    // falso para dos formas de escribir el mismo número.
    expect(resolveMinReputation('5', 5)).toBe(5);
    expect(resolveMinReputation('5', '5.0')).toBe(5);
    expect(resolveMinReputation(5, '5')).toBe(5);
  });

  it('T-U4: vacío = ausente, no conflicto', () => {
    expect(resolveMinReputation('5', '')).toBe(5);
    expect(resolveMinReputation('', '5')).toBe(5);
    expect(resolveMinReputation('5', null)).toBe(5);
    expect(resolveMinReputation(undefined, undefined)).toBeUndefined();
  });

  it('T-U5: un valor inválido por el ALIAS da el MISMO InvalidMinReputationError', () => {
    // CD-2: `parseMinReputation` es el único validador de rango para los dos
    // nombres. Un código nuevo para el alias significaría un parseo duplicado.
    try {
      resolveMinReputation(undefined, 'abc');
      expect.unreachable('debía lanzar');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidMinReputationError);
      expect((err as InvalidMinReputationError).code).toBe(
        'INVALID_MIN_REPUTATION',
      );
    }
    expect(() => resolveMinReputation(undefined, '101')).toThrow(
      InvalidMinReputationError,
    );
  });
});

describe('WKH-322 · assertKnownDiscoverParams', () => {
  it('T-U6: el mensaje NOMBRA la clave mala y ENUMERA las aceptadas', () => {
    // Un 400 que no dice el nombre correcto convierte un typo de un carácter en
    // media hora de búsqueda: eso es lo que costó `capability` (singular), que
    // devolvía el catálogo entero con 200.
    try {
      assertKnownDiscoverParams({ capability: 'remittance-payout' });
      expect.unreachable('debía lanzar');
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownDiscoverParamError);
      expect((err as UnknownDiscoverParamError).code).toBe(
        'UNKNOWN_DISCOVER_PARAM',
      );
      expect((err as UnknownDiscoverParamError).received).toBe('capability');
      const msg = (err as UnknownDiscoverParamError).message;
      expect(msg).toContain("'capability'");
      expect(msg).toContain('capabilities');
      expect(msg).toContain('minReputation');
      expect(msg).toContain('min_reputation');
      expect(msg).toContain('q');
    }
  });

  it('T-U7: un objeto vacío y una clave aceptada no lanzan', () => {
    // Nombres escritos a mano a propósito (CD-10): iterar
    // `ALLOWED_DISCOVER_PARAMS` acá mediría la constante contra sí misma y
    // agregar `pepito` a la lista haría pasar el test. La enumeración exhaustiva
    // de los 10 parámetros vive en `T-R30`, contra la ruta y también a mano.
    expect(() => assertKnownDiscoverParams({})).not.toThrow();
    expect(() =>
      assertKnownDiscoverParams({ capabilities: 'kyc', min_reputation: '2' }),
    ).not.toThrow();
  });

  it('T-U9 (AR MNR-4): el eco del nombre está acotado — una clave enorme no vuelve entera', () => {
    // El nombre lo elige el caller y `POST /discover` acepta hasta 1 MiB de
    // body (Fastify sin `bodyLimit`). Sin cota, una clave de 100 KB devolvía un
    // 400 de 100 KB y escribía una línea de log del tamaño del ataque.
    const huge = 'a'.repeat(100_000);
    try {
      assertKnownDiscoverParams({ [huge]: '1' });
      expect.unreachable('debía lanzar');
    } catch (err) {
      const msg = (err as UnknownDiscoverParamError).message;
      // La cota se afirma en caracteres CONCRETOS, no derivándola de la
      // constante: `MAX_ECHOED_PARAM_NAME_LENGTH` es lo que se está verificando.
      expect(msg).toContain(`'${'a'.repeat(64)}'`);
      expect(msg).not.toContain('a'.repeat(65));
      // El mensaje entero queda en el orden de los cientos de bytes, no de los
      // cientos de KB (la enumeración de los 10 aceptados es lo más largo).
      expect(msg.length).toBeLessThan(500);
      // La excepción SÍ conserva el nombre completo: lo que se acota es lo que
      // viaja al caller, no lo que la app tiene disponible.
      expect((err as UnknownDiscoverParamError).received).toBe(huge);
    }
  });

  it('T-U9b (AR MNR-4): cuando trunca lo DICE, con el largo original', () => {
    // Va separado de T-U9 a propósito, para que dos mutantes distintos tengan
    // firmas de muerte distintas: "no truncar" mata T-U9 y este; "truncar en
    // silencio" mata sólo este. Con los dos asertos en el mismo `it` los dos
    // mutantes morían igual y no se podían distinguir.
    const huge = 'a'.repeat(100_000);
    try {
      assertKnownDiscoverParams({ [huge]: '1' });
      expect.unreachable('debía lanzar');
    } catch (err) {
      const msg = (err as UnknownDiscoverParamError).message;
      expect(msg).toContain('truncated');
      expect(msg).toContain('100000 characters');
    }
  });

  it('T-U10 (AR MNR-4): un nombre de largo normal NO se trunca ni se anota', () => {
    // El borde importa: si la cota mordiera nombres plausibles, el 400 dejaría
    // de servir para lo único que existe — que el caller reconozca su typo.
    // 64 exactos: el último largo que pasa entero.
    const exactly64 = 'b'.repeat(64);
    for (const name of ['capabilty', 'min_reputacion', exactly64]) {
      try {
        assertKnownDiscoverParams({ [name]: '1' });
        expect.unreachable('debía lanzar');
      } catch (err) {
        const msg = (err as UnknownDiscoverParamError).message;
        expect(msg).toContain(`'${name}'`);
        expect(msg).not.toContain('truncated');
      }
    }
  });

  it('T-U8: el mensaje es determinista pero NO promete "la primera que escribió el caller"', () => {
    // Gotcha de JS: las claves con forma de índice entero se enumeran primero.
    // Este test canda que el docstring no afirme un orden que el lenguaje no da.
    try {
      assertKnownDiscoverParams({ capability: 'b', 1: 'a' });
      expect.unreachable('debía lanzar');
    } catch (err) {
      expect((err as UnknownDiscoverParamError).received).toBe('1');
    }
  });
});
