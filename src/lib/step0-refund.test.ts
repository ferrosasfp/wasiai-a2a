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
    // HU-194: el 5º arg es la clave del refund LÓGICO (dedup DB-level).
    expect(creditMock).toHaveBeenCalledWith('k1', 2368, 1, 'o1', {
      idemKey: expect.any(String),
    });
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
      {
        idemKey: expect.any(String),
      },
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
    expect(creditSessionMock).toHaveBeenCalledWith('s1', 'o1', 'k1', 2368, 1, {
      idemKey: expect.any(String),
    });
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
      { idemKey: expect.any(String) },
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
      idemKey: expect.any(String),
    });
  });

  it('T-SR-11: si además el outbox lanza, tampoco propaga (best-effort de punta a punta)', async () => {
    creditMock.mockRejectedValueOnce(new Error('PGRST down'));
    enqueueRefundMock.mockRejectedValueOnce(new Error('outbox down'));
    // Un fallo del rastro de auditoría NUNCA puede romper la respuesta al caller.
    await expect(
      refundStep0Debit(makeRequest(), 'test:both-down'),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalled();
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

  // ── HU-194: la clave de idempotencia ────────────────────────
  //
  // El agujero que se cierra: el credit COMMITEA y su respuesta se pierde
  // (socket reset / timeout post-commit) → el `catch` encola → el sweep
  // reintenta → el caller cobra DOS VECES. La única forma de que el sweep pueda
  // dedupear es que la clave que va al credit sea EXACTAMENTE la que va al
  // outbox. Si divergen, la dedup no protege nada y el bug vuelve en silencio.
  it('T-SR-12: la clave que se encola es LA MISMA que la del credit que lanzó', async () => {
    creditMock.mockRejectedValueOnce(new Error('socket hang up'));
    await refundStep0Debit(makeRequest(), 'test:lost-response');

    const creditIdem = creditMock.mock.calls[0]?.[4] as
      | { idemKey: string }
      | undefined;
    const enqueued = enqueueRefundMock.mock.calls[0]?.[0] as
      | { idemKey: string }
      | undefined;
    expect(creditIdem?.idemKey).toBeTruthy();
    expect(enqueued?.idemKey).toBe(creditIdem?.idemKey);
  });

  it('T-SR-13: dos requests distintos → claves DISTINTAS (son dos refunds legítimos)', async () => {
    creditMock.mockRejectedValue(new Error('socket hang up'));
    await refundStep0Debit(makeRequest(), 'test:req-a');
    await refundStep0Debit(makeRequest(), 'test:req-b');

    const a = (enqueueRefundMock.mock.calls[0]?.[0] as { idemKey: string })
      .idemKey;
    const b = (enqueueRefundMock.mock.calls[1]?.[0] as { idemKey: string })
      .idemKey;
    // Cada request dejó su PROPIO débito: colapsarlos perdería un crédito real.
    expect(a).not.toBe(b);
  });

  it('T-SR-14: los dos caminos de fallo del MISMO refund comparten clave', async () => {
    // `refund-failed` (success:false) y `refund-threw` (excepción) son el MISMO
    // refund lógico visto de dos maneras. Si el `reason` entrara en la clave,
    // darían claves distintas y el sweep podría acreditar dos veces.
    creditMock.mockResolvedValueOnce({ success: false, reverted: false });
    const reqA = makeRequest();
    await refundStep0Debit(reqA, 'test:same');
    const failedKey = (
      enqueueRefundMock.mock.calls[0]?.[0] as { idemKey: string }
    ).idemKey;

    // Mismo request no puede refundear dos veces (T-SR-05), así que se compara
    // contra la clave que el credit recibió: es la que viajaría en el `catch`.
    const creditIdem = creditMock.mock.calls[0]?.[4] as { idemKey: string };
    expect(failedKey).toBe(creditIdem.idemKey);
  });
});
