/**
 * HU-203 — el lector que decide si el débito del caller se le devuelve.
 *
 * Estos tests miran la DECISIÓN, no la mecánica: `readSettleWithholding` devuelve algo
 * ⟺ NO se reembolsa. Un `undefined` de más es plata que sale dos veces de nuestro lado;
 * un `undefined` de menos deja al caller cobrado sin contraprestación. Las dos
 * direcciones están cubiertas.
 */
import { describe, expect, it } from 'vitest';
import {
  FacilitatorSettleError,
  GaslessTransferError,
} from '../adapters/errors.js';
import {
  buildSettleUnknownEvent,
  COMPOSE_SETTLE_UNKNOWN_EVENT,
  readSettleWithholding,
  SETTLE_UNKNOWN_EVENT_TYPES,
  SettleRefundWithheldError,
  withholdingFromSettleResult,
} from './settle-withholding.js';

describe('withholdingFromSettleResult — eje 1 (2xx con veredicto negativo)', () => {
  it('T-203-W1: `success:false` CON hash ⟹ se retiene', () => {
    const w = withholdingFromSettleResult(
      { success: false, txHash: '0xabc' },
      'detalle',
    );
    expect(w).toEqual({
      reason: 'broadcast-hash',
      txHash: '0xabc',
      detail: 'detalle',
    });
  });

  it('T-203-W2: `success:false` SIN hash ⟹ NO se retiene (el reembolso sigue vivo)', () => {
    // El único caso que conserva el reembolso automático: el facilitator contestó,
    // con un veredicto legible, que no settleó, y no nos dio ninguna pista.
    expect(
      withholdingFromSettleResult({ success: false, txHash: '' }, 'd'),
    ).toBeUndefined();
    expect(
      withholdingFromSettleResult({ success: false }, 'd'),
    ).toBeUndefined();
    expect(
      withholdingFromSettleResult({ success: false, txHash: '   ' }, 'd'),
    ).toBeUndefined();
  });

  it('T-203-W3: un hash con formato desconocido TAMBIÉN retiene', () => {
    // Deliberadamente asimétrico: no entender la respuesta del facilitator es lo
    // contrario de tener una prueba de que no pagó. Endurecer esto a un regex
    // `^0x[0-9a-f]{64}$` haría que un hash malformado contara como "no hubo
    // broadcast", que es justo la inferencia que esta HU borra.
    const w = withholdingFromSettleResult(
      { success: false, txHash: '5xK9…base58…' },
      'd',
    );
    expect(w?.reason).toBe('broadcast-hash');
  });

  it('T-203-W4: un settle exitoso nunca retiene', () => {
    expect(
      withholdingFromSettleResult({ success: true, txHash: '0xabc' }, 'd'),
    ).toBeUndefined();
  });
});

describe('readSettleWithholding — los dos ejes en un solo lector', () => {
  it('T-203-R1: el error del eje 1 se lee y conserva el hash', () => {
    const err = new SettleRefundWithheldError({
      reason: 'broadcast-hash',
      txHash: '0xdead',
      detail: 'boom',
    });
    expect(readSettleWithholding(err)).toEqual({
      reason: 'broadcast-hash',
      txHash: '0xdead',
      detail: 'boom',
    });
  });

  it('T-203-R2: `FacilitatorSettleError` con `unknown` ⟹ se retiene', () => {
    const w = readSettleWithholding(
      new FacilitatorSettleError('HTTP 502 on /settle', 'unknown'),
    );
    expect(w?.reason).toBe('no-facilitator-answer');
    expect(w?.txHash).toBeNull();
  });

  it('T-203-R3: `FacilitatorSettleError` con `not-sent` ⟹ NO se retiene', () => {
    // `'not-sent'` sólo se emite ante una señal que PRUEBA que no hubo request. Esa
    // prueba es lo que mantiene vivo el reembolso legítimo.
    expect(
      readSettleWithholding(
        new FacilitatorSettleError('ENOTFOUND', 'not-sent'),
      ),
    ).toBeUndefined();
  });

  it('T-203-R4: se lee por FORMA, no por `instanceof` (registros de módulos distintos)', () => {
    // Una suite con `vi.resetModules()` + `import()` dinámico ve OTRA copia de la
    // clase. Si la decisión de dinero dependiera de la identidad de clase, ese caso
    // colapsaría al camino de "falló" ⟹ reembolso indebido. Cazado con un test rojo en
    // HU-198, no en teoría.
    const foreignWithheld = Object.assign(new Error('boom'), {
      name: 'SettleRefundWithheldError',
      withholding: {
        reason: 'broadcast-hash',
        txHash: '0xdead',
        detail: 'boom',
      },
    });
    expect(readSettleWithholding(foreignWithheld)?.txHash).toBe('0xdead');

    const foreignTransport = Object.assign(new Error('cut'), {
      name: 'FacilitatorSettleError',
      valueDisposition: 'unknown',
    });
    expect(readSettleWithholding(foreignTransport)?.reason).toBe(
      'no-facilitator-answer',
    );
  });

  it('T-203-R5: un payload con la forma rota NO retiene', () => {
    // Un objeto que dice llamarse como el error pero cuyo `reason` no es del dominio
    // no puede emitir el veredicto: retendría plata a partir de algo que no
    // entendimos.
    const broken = Object.assign(new Error('x'), {
      name: 'SettleRefundWithheldError',
      withholding: { reason: 'whatever', txHash: '0x1', detail: 'd' },
    });
    expect(readSettleWithholding(broken)).toBeUndefined();
  });

  it('T-203-R6: los errores NO relacionados no retienen', () => {
    // El guard tiene que ser estrecho. Un agente que devuelve 502, un SSRF bloqueado o
    // un error de gasless son steps sin valor entregado: se reembolsan como siempre.
    expect(readSettleWithholding(new Error('Agent x returned 502'))).toBe(
      undefined,
    );
    expect(readSettleWithholding(undefined)).toBeUndefined();
    expect(readSettleWithholding('boom')).toBeUndefined();
    expect(readSettleWithholding({ name: 'Whatever' })).toBeUndefined();
    // Un error del OTRO eje (gasless) tampoco: tiene su propio punto de reembolso en
    // `routes/gasless.ts` y su propio vocabulario.
    expect(
      readSettleWithholding(
        new GaslessTransferError('avalanche', 'boom', 'unknown'),
      ),
    ).toBeUndefined();
  });
});

describe('buildSettleUnknownEvent — la forma de la fila que alguien va a mirar', () => {
  it('T-203-E1: lleva el hash, el monto retenido y las claves para cruzarlo', () => {
    const ev = buildSettleUnknownEvent({
      withholding: {
        reason: 'broadcast-hash',
        txHash: '0xdead',
        detail: 'boom',
      },
      withholder: 'compose-step:1:d1',
      withheldUsd: 0.05,
      refundWithheld: true,
      agentSlug: 'corridor',
      step: 1,
      keyId: 'k1',
      ownerRef: 'owner-1',
      chainId: 2368,
    });
    expect(ev.eventType).toBe(COMPOSE_SETTLE_UNKNOWN_EVENT);
    expect(ev.status).toBe('failed');
    expect(ev.txHash).toBe('0xdead');
    expect(ev.costUsdc).toBe(0.05);
    expect(ev.metadata.refund_withheld).toBe(true);
    expect(ev.metadata.withholder).toBe('compose-step:1:d1');
    expect(ev.metadata.key_id).toBe('k1');
    expect(ev.metadata.owner_ref).toBe('owner-1');
    expect(ev.metadata.chain_id).toBe(2368);
  });

  it('T-203-E2: sin hash, el campo `tx_hash` se OMITE (no se inventa un string)', () => {
    const ev = buildSettleUnknownEvent({
      withholding: {
        reason: 'no-facilitator-answer',
        txHash: null,
        detail: 'cut',
      },
      withholder: 'orchestrate-step0',
      withheldUsd: 1,
      refundWithheld: true,
    });
    expect(ev.txHash).toBeUndefined();
    expect(ev.metadata.settle_tx_hash).toBeNull();
  });

  it('T-203-E3: la familia de `event_type` incluye el eje inbound de HU-201', () => {
    // `x402_settle_unknown` se escribía desde HU-201 pero NO lo listaba nadie. Si
    // alguien lo saca de acá, esas filas vuelven a ser plata retenida invisible.
    expect(SETTLE_UNKNOWN_EVENT_TYPES).toContain('x402_settle_unknown');
    expect(SETTLE_UNKNOWN_EVENT_TYPES).toContain(COMPOSE_SETTLE_UNKNOWN_EVENT);
  });
});
