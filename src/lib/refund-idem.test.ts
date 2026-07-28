/**
 * HU-194: la clave del refund LÓGICO.
 *
 * Los dos errores que arruinarían el fix, uno en cada dirección:
 *   - clave DEMASIADO amplia → dos refunds legítimos distintos colapsan y el
 *     caller pierde un crédito REAL (peor que el bug original);
 *   - clave DEMASIADO angosta (p. ej. el `reason` o el nº de intento dentro) →
 *     el reintento del sweep no dedupea nada y el caller cobra dos veces.
 *
 * Naming: T-IDEM-01..T-IDEM-07.
 */

import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  REFUND_IDEM_VERSION,
  refundIdemKey,
  requestRefundIdemBase,
} from './refund-idem.js';

function makeRequest(): FastifyRequest {
  return {} as unknown as FastifyRequest;
}

const BASE = {
  keyId: 'key-1',
  chainId: 8453,
  operationId: 'op-1',
  slot: 'compose-step0',
};

describe('refundIdemKey (HU-194)', () => {
  it('T-IDEM-01: determinista — las mismas partes dan la misma clave', () => {
    // Es la condición de la dedup: el credit del call-site y el reintento del
    // sweep tienen que producir el MISMO string.
    expect(refundIdemKey(BASE)).toBe(refundIdemKey({ ...BASE }));
  });

  it('T-IDEM-02: incluye versión, key, chain, operación y slot', () => {
    expect(refundIdemKey(BASE)).toBe(
      `${REFUND_IDEM_VERSION}:key-1:8453:op-1:compose-step0`,
    );
  });

  it('T-IDEM-03: distinto slot → distinta clave (dos refunds legítimos NO colapsan)', () => {
    const d1 = refundIdemKey({ ...BASE, slot: 'compose-step:3:d1' });
    const d2 = refundIdemKey({ ...BASE, slot: 'compose-step:3:d2' });
    expect(d1).not.toBe(d2);
  });

  it('T-IDEM-04: distinta operación → distinta clave (dos débitos, dos refunds)', () => {
    expect(refundIdemKey({ ...BASE, operationId: 'op-2' })).not.toBe(
      refundIdemKey(BASE),
    );
  });

  it('T-IDEM-05: distinta key o chain → distinta clave (nunca cruza tenant ni chain)', () => {
    expect(refundIdemKey({ ...BASE, keyId: 'key-2' })).not.toBe(
      refundIdemKey(BASE),
    );
    expect(refundIdemKey({ ...BASE, chainId: 43113 })).not.toBe(
      refundIdemKey(BASE),
    );
  });
});

describe('requestRefundIdemBase (HU-194)', () => {
  it('T-IDEM-06: memoizada por request — el credit y el enqueue comparten base', () => {
    const request = makeRequest();
    expect(requestRefundIdemBase(request)).toBe(requestRefundIdemBase(request));
  });

  it('T-IDEM-07: distinta entre requests, y NO derivada de nada del caller', () => {
    // Si la base saliera de `request.id` (header `request-id`, caller-controlled)
    // un caller podría repetirla y hacer que su segundo refund legítimo se
    // descarte como duplicado. Acá dos requests "iguales" dan bases distintas.
    const a = requestRefundIdemBase(makeRequest());
    const b = requestRefundIdemBase(makeRequest());
    expect(a).not.toBe(b);
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
