/**
 * `refundStep0Debit` — HU-193: los invariantes que impiden REEMBOLSAR DE MÁS.
 *
 * Inflar el budget es peor que el bug original, así que cada guard tiene su test:
 * riel x402 (no hay saldo interno), ruta que no debitó (`resolvedChainId` sin
 * setear, que es la firma de los middlewares auth-only), `skipMiddlewareDebit`,
 * doble llamada, y el ruteo dual-ledger bajo delegación/sesión (un `credit` a
 * secas dejaría el contador de la credencial inflado → self-DoS).
 *
 * También el camino de fallo: si el credit no revierte NADA, se encola en el
 * outbox para el sweep (y sólo en ese caso, o el refund se aplicaría dos veces).
 *
 * Naming: T-SR-01..T-SR-10.
 */

import type { FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { A2AAgentKeyRow } from '../types/index.js';

const creditMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ success: true, reverted: true }),
);
const creditWithDestMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ success: true, reverted: true }),
);
const creditDelegationMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ success: true, reverted: true }),
);
const creditSessionMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ success: true, reverted: true }),
);
vi.mock('../services/budget.js', () => ({
  budgetService: {
    credit: creditMock,
    creditWithDest: creditWithDestMock,
    creditDelegation: creditDelegationMock,
    creditSession: creditSessionMock,
  },
}));

const enqueueRefundMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
vi.mock('../services/refund-outbox.js', () => ({
  refundOutbox: { enqueueRefund: enqueueRefundMock },
}));

import { refundStep0Debit } from './step0-refund.js';

const keyRow = { id: 'k1', owner_ref: 'o1' } as A2AAgentKeyRow;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/**
 * Request mínimo: sólo los campos que el helper lee. `Record<string, unknown>`
 * (y no `Partial<FastifyRequest>`) porque con `exactOptionalPropertyTypes` un
 * override a `undefined` no es asignable, y justamente los guards que hay que
 * probar son "campo ausente".
 */
function makeRequest(over: Record<string, unknown> = {}): FastifyRequest {
  return {
    a2aKeyRow: keyRow,
    resolvedChainId: 2368,
    log,
    ...over,
  } as unknown as FastifyRequest;
}

describe('refundStep0Debit (HU-193)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    creditMock.mockResolvedValue({ success: true, reverted: true });
  });

  it('T-SR-01: master key → credita el monto step-0 ($1) con el owner_ref del caller', async () => {
    await refundStep0Debit(makeRequest(), 'test:case');
    // Ownership guard (CLAUDE.md): el 4º arg es el owner_ref del caller.
    expect(creditMock).toHaveBeenCalledWith('k1', 2368, 1, 'o1');
    expect(enqueueRefundMock).not.toHaveBeenCalled();
  });

  it('T-SR-02: riel x402 (sin a2aKeyRow) → NO acredita nada', async () => {
    // El caller x402 pagó on-chain: no hay saldo interno que sumar. Acreditar acá
    // sería regalar plata al dueño de una key que no participó del request.
    await refundStep0Debit(makeRequest({ a2aKeyRow: undefined }), 'test:x402');
    expect(creditMock).not.toHaveBeenCalled();
  });

  it('T-SR-03: sin `resolvedChainId` (ruta que NO debitó) → NO acredita nada', async () => {
    // `resolvedChainId` lo setea SÓLO un branch de pago. Un middleware auth-only
    // (`requireA2AKey`) autentica sin debitar: sin este guard, un refund ahí
    // INFLARÍA el budget.
    await refundStep0Debit(
      makeRequest({ resolvedChainId: undefined }),
      'test:no-debit',
    );
    expect(creditMock).not.toHaveBeenCalled();
  });

  it('T-SR-04: `skipMiddlewareDebit` → NO acredita nada', async () => {
    await refundStep0Debit(
      makeRequest({ skipMiddlewareDebit: true }),
      'test:skip',
    );
    expect(creditMock).not.toHaveBeenCalled();
  });

  it('T-SR-05: dos llamadas en el mismo request → un solo credit', async () => {
    const request = makeRequest();
    await refundStep0Debit(request, 'test:first');
    await refundStep0Debit(request, 'test:second');
    expect(creditMock).toHaveBeenCalledTimes(1);
  });

  it('T-SR-06: bajo DELEGACIÓN → credit dual-ledger, nunca `credit` a secas', async () => {
    await refundStep0Debit(
      makeRequest({
        delegationContext: {
          delegationId: 'd1',
          ownerRef: 'o1',
          keyId: 'k1',
          maxAmountPerTx: '5.00',
        },
      }),
      'test:delegation',
    );
    expect(creditDelegationMock).toHaveBeenCalledWith(
      'd1',
      'o1',
      'k1',
      2368,
      1,
    );
    expect(creditMock).not.toHaveBeenCalled();
  });

  it('T-SR-07: bajo KEY-SESSION → credit dual-ledger de sesión', async () => {
    await refundStep0Debit(
      makeRequest({
        keySessionContext: { sessionId: 's1', ownerRef: 'o1', keyId: 'k1' },
      }),
      'test:session',
    );
    expect(creditSessionMock).toHaveBeenCalledWith('s1', 'o1', 'k1', 2368, 1);
    expect(creditMock).not.toHaveBeenCalled();
  });

  it('T-SR-08: con destino (dest-policy) → `creditWithDest`, simétrico al débito', async () => {
    await refundStep0Debit(
      makeRequest({ composeDestination: '0xdest' }),
      'test:dest',
    );
    expect(creditWithDestMock).toHaveBeenCalledWith(
      'k1',
      2368,
      1,
      'o1',
      '0xdest',
    );
    expect(creditMock).not.toHaveBeenCalled();
  });

  it('T-SR-09: credit que no revierte nada → se encola en el outbox', async () => {
    creditMock.mockResolvedValueOnce({ success: false, reverted: false });
    await refundStep0Debit(makeRequest(), 'test:failed');
    expect(enqueueRefundMock).toHaveBeenCalledWith({
      keyId: 'k1',
      chainId: 2368,
      amountUsd: 1,
      ownerRef: 'o1',
      destination: null,
      reason: 'test:failed:refund-failed',
    });
  });

  it('T-SR-10: si el credit lanza, no propaga y encola para el sweep', async () => {
    creditMock.mockRejectedValueOnce(new Error('PGRST down'));
    await expect(
      refundStep0Debit(makeRequest(), 'test:threw'),
    ).resolves.toBeUndefined();
    expect(enqueueRefundMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'test:threw:refund-threw' }),
    );
  });
});
