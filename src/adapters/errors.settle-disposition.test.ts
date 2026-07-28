/**
 * HU-198 — clasificación y lectura de `SettleValueDisposition`.
 *
 * Estos son los dos helpers de los que depende la decisión "no sé si se pagó" vs
 * "no se pagó", así que se testean por SEPARADO del adapter: el test del adapter
 * (`kite-ozone/payment.pieverse-ceiling.test.ts`) prueba el extremo real contra un
 * servidor node:http, y este prueba la tabla de clasificación completa, incluidos
 * los casos que un servidor local no puede producir a demanda (cause anidada).
 */

import { describe, expect, it } from 'vitest';
import {
  classifySettleTransportError,
  FacilitatorSettleError,
  readSettleValueDisposition,
} from './errors.js';

describe('classifySettleTransportError', () => {
  it('T-CLS-timeout: el abort del techo NO prueba nada sobre la plata → unknown', () => {
    // Es EXACTAMENTE el error que produce `AbortSignal.timeout`. Cae a unknown a
    // propósito: cuando el reloj se cumplió, el request ya había salido.
    const err = new DOMException(
      'The operation was aborted due to timeout',
      'TimeoutError',
    );
    expect(classifySettleTransportError(err)).toBe('unknown');
  });

  it('T-CLS-abort: AbortError → unknown', () => {
    expect(
      classifySettleTransportError(new DOMException('aborted', 'AbortError')),
    ).toBe('unknown');
  });

  for (const code of [
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'ERR_INVALID_URL',
  ]) {
    it(`T-CLS-not-sent-${code}: prueba que no hubo request → not-sent`, () => {
      // undici anida el error real en `cause`, así que el código NO está en el
      // error de arriba: el walk de la cadena es el que lo encuentra.
      const err = Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('boom'), { code }),
      });
      expect(classifySettleTransportError(err)).toBe('not-sent');
    });
  }

  it('T-CLS-nested: encuentra el código a 3 niveles de cause', () => {
    const deep = Object.assign(new Error('l3'), { code: 'ECONNREFUSED' });
    const mid = Object.assign(new Error('l2'), { cause: deep });
    const top = Object.assign(new TypeError('fetch failed'), { cause: mid });
    expect(classifySettleTransportError(top)).toBe('not-sent');
  });

  it('T-CLS-default-unknown: un socket cortado a mitad NO es not-sent', () => {
    // `UND_ERR_SOCKET` / "terminated" ocurre DESPUÉS de mandar el request: el
    // facilitator pudo haber broadcasteado. Si alguien agregara este código a la
    // lista de not-sent, este test se pone rojo — y ese rojo evita un doble pago.
    const err = Object.assign(new TypeError('terminated'), {
      cause: Object.assign(new Error('other side closed'), {
        code: 'UND_ERR_SOCKET',
      }),
    });
    expect(classifySettleTransportError(err)).toBe('unknown');
  });

  it('T-CLS-basura: null / string / objeto sin code → unknown (nunca not-sent por defecto)', () => {
    expect(classifySettleTransportError(null)).toBe('unknown');
    expect(classifySettleTransportError('boom')).toBe('unknown');
    expect(classifySettleTransportError({})).toBe('unknown');
    expect(classifySettleTransportError(new Error('plain'))).toBe('unknown');
  });

  it('T-CLS-ciclo: una cadena de cause circular no cuelga', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b') as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(classifySettleTransportError(a)).toBe('unknown');
  });
});

describe('readSettleValueDisposition', () => {
  it('T-READ-instanceof: lee la disposición del error real', () => {
    expect(
      readSettleValueDisposition(new FacilitatorSettleError('x', 'unknown')),
    ).toBe('unknown');
    expect(
      readSettleValueDisposition(new FacilitatorSettleError('x', 'not-sent')),
    ).toBe('not-sent');
  });

  it('T-READ-cross-registry: lee la disposición de una COPIA de la clase de otro registro de módulos', () => {
    // Simula lo que pasa cuando un consumidor se carga con vi.resetModules() +
    // import() dinámico: misma forma, OTRA identidad de clase. Con un `instanceof`
    // pelado esto devolvía undefined y la decisión de dinero se caía al camino de
    // "falló" — el colapso que este tipo existe para evitar. Cazado en rojo, no en
    // teoría.
    const foreign = Object.assign(new Error('timeout'), {
      name: 'FacilitatorSettleError',
      valueDisposition: 'unknown',
    });
    expect(foreign instanceof FacilitatorSettleError).toBe(false);
    expect(readSettleValueDisposition(foreign)).toBe('unknown');
  });

  it('T-READ-no-impostor: un error con otro name NO aporta disposición', () => {
    const impostor = Object.assign(new Error('x'), {
      name: 'SomeOtherError',
      valueDisposition: 'unknown',
    });
    expect(readSettleValueDisposition(impostor)).toBeUndefined();
  });

  it('T-READ-valor-invalido: name correcto pero disposición fuera del dominio → undefined', () => {
    const bogus = Object.assign(new Error('x'), {
      name: 'FacilitatorSettleError',
      valueDisposition: 'totally-fine',
    });
    expect(readSettleValueDisposition(bogus)).toBeUndefined();
  });

  it('T-READ-otros-errores: un Error común o basura no aporta disposición', () => {
    expect(readSettleValueDisposition(new Error('plain'))).toBeUndefined();
    expect(readSettleValueDisposition(null)).toBeUndefined();
    expect(readSettleValueDisposition('boom')).toBeUndefined();
  });
});
