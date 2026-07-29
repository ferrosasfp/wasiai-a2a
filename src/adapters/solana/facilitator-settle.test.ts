/**
 * WKH-302 — T-AC10: "no sé si se pagó" ≠ "no se pagó".
 *
 * `SETTLE_FAILED` significa, en el catálogo de este repo, que el leg NO se pagó:
 * dispara reembolso al buyer y/o re-envío del hop. Emitirlo sobre una disposición
 * desconocida es pagar dos veces por diseño. Estos tests fijan la LISTA CERRADA:
 * sólo los códigos que prueban que el facilitator falló antes de firmar son
 * `'not-sent'`; todo lo demás —incluido un código que no conocemos— es `'unknown'`.
 *
 * La aserción se hace sobre `readSettleValueDisposition`, que es exactamente lo que
 * lee el consumidor (`lib/downstream-payment.ts`), y no sobre el tipo de la clase:
 * el contrato aguas abajo es POR FORMA.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSettleValueDisposition } from '../errors.js';
import {
  PAYOUT_NO_SPEND_CODES,
  payoutViaFacilitator,
  readPayoutCode,
} from './facilitator-settle.js';

const PAY_TO = 'So11111111111111111111111111111111111111112';
const SIG = '7'.repeat(64);

const savedEnv = new Map<string, string | undefined>();
const ENV_KEYS = [
  'SOLANA_FACILITATOR_URL',
  'SOLANA_FACILITATOR_API_KEY',
  'WASIAI_FACILITATOR_URL',
  'FACILITATOR_API_KEY',
];

let fetchSpy: ReturnType<typeof vi.spyOn>;

const input = {
  intentId: 'run-1:0',
  payTo: PAY_TO,
  amountAtomic: '3000000',
  network: 'solana:devnet',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  const env = new Map(Object.entries(process.env));
  for (const k of ENV_KEYS) savedEnv.set(k, env.get(k));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.SOLANA_FACILITATOR_URL = 'https://facilitator.test';
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  savedEnv.clear();
  fetchSpy.mockRestore();
  vi.clearAllMocks();
});

/** Captura el error que lanza el hop (siempre lanza en el camino de error). */
async function catchPayout(): Promise<unknown> {
  try {
    await payoutViaFacilitator(input);
    throw new Error('expected payoutViaFacilitator to throw');
  } catch (e) {
    return e;
  }
}

describe('T-AC10 — disposición DESCONOCIDA (el lado seguro)', () => {
  it('★ 502 de un proxy ⇒ unknown (pudo haberse transmitido antes del corte)', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(502, { error: { code: 'BAD_GW' } }),
    );
    const e = await catchPayout();
    expect(readSettleValueDisposition(e)).toBe('unknown');
  });

  it('★ cuerpo ilegible ⇒ unknown, CUALQUIERA sea el status', async () => {
    for (const status of [200, 500, 502]) {
      fetchSpy.mockResolvedValue(
        new Response('<html>not json</html>', {
          status,
          headers: { 'content-type': 'text/html' },
        }),
      );
      const e = await catchPayout();
      expect(readSettleValueDisposition(e)).toBe('unknown');
    }
  });

  it('★ timeout / abort ⇒ unknown (el request ya había salido)', async () => {
    fetchSpy.mockRejectedValue(
      Object.assign(new Error('The operation was aborted'), {
        name: 'TimeoutError',
      }),
    );
    const e = await catchPayout();
    expect(readSettleValueDisposition(e)).toBe('unknown');
  });

  it('★ PAYOUT_IN_PROGRESS ⇒ unknown (otro intento puede estar pagando)', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(409, { error: { code: 'PAYOUT_IN_PROGRESS' } }),
    );
    const e = await catchPayout();
    expect(readSettleValueDisposition(e)).toBe('unknown');
    expect(PAYOUT_NO_SPEND_CODES.has('PAYOUT_IN_PROGRESS' as never)).toBe(
      false,
    );
  });

  it('★ PAYOUT_BROADCAST_FAILED ⇒ unknown (la tx pudo aterrizar sin confirmarse)', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(502, { error: { code: 'PAYOUT_BROADCAST_FAILED' } }),
    );
    const e = await catchPayout();
    expect(readSettleValueDisposition(e)).toBe('unknown');
    expect(PAYOUT_NO_SPEND_CODES.has('PAYOUT_BROADCAST_FAILED' as never)).toBe(
      false,
    );
  });

  it('★ un código DESCONOCIDO cae solo del lado seguro (default = unknown)', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(500, { error: { code: 'PAYOUT_SOMETHING_NEW_2027' } }),
    );
    const e = await catchPayout();
    expect(readSettleValueDisposition(e)).toBe('unknown');
  });

  it('★ non-2xx SIN código ⇒ unknown', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(500, { error: {} }));
    expect(readSettleValueDisposition(await catchPayout())).toBe('unknown');
  });

  it('★ 2xx con veredicto ilegible (sin signature) ⇒ unknown, no éxito', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { alreadySettled: false }));
    expect(readSettleValueDisposition(await catchPayout())).toBe('unknown');
  });

  it('★ 2xx con signature vacía ⇒ unknown', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { signature: '' }));
    expect(readSettleValueDisposition(await catchPayout())).toBe('unknown');
  });
});

describe('T-AC10 — disposición DEFINIDA (sabemos que no se gastó)', () => {
  it('★ cada código de la lista cerrada ⇒ not-sent + payoutCode legible', async () => {
    for (const code of PAYOUT_NO_SPEND_CODES) {
      fetchSpy.mockResolvedValue(jsonResponse(400, { error: { code } }));
      const e = await catchPayout();
      expect(readSettleValueDisposition(e)).toBe('not-sent');
      expect(readPayoutCode(e)).toBe(code);
    }
  });

  it('★ PAYOUT_FUNDING_LOW ⇒ not-sent (se traduce a INSUFFICIENT_BALANCE aguas abajo)', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(503, { error: { code: 'PAYOUT_FUNDING_LOW' } }),
    );
    const e = await catchPayout();
    expect(readSettleValueDisposition(e)).toBe('not-sent');
    expect(readPayoutCode(e)).toBe('PAYOUT_FUNDING_LOW');
  });

  it('★ sin URL configurada ⇒ not-sent y NO se hace ningún fetch', async () => {
    delete process.env.SOLANA_FACILITATOR_URL;
    const e = await catchPayout();
    expect(readSettleValueDisposition(e)).toBe('not-sent');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('★ ECONNREFUSED ⇒ not-sent (no se estableció el intercambio)', async () => {
    fetchSpy.mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED'), {
        cause: { code: 'ECONNREFUSED' },
      }),
    );
    expect(readSettleValueDisposition(await catchPayout())).toBe('not-sent');
  });
});

describe('contrato de forma y camino feliz', () => {
  it('★ el error de payout se lee por FORMA: name === FacilitatorSettleError', async () => {
    // Contra-intuitivo a propósito: la subclase usa el nombre del PADRE para que
    // `readSettleValueDisposition` la reconozca aunque `instanceof` falle (otra
    // copia del módulo bajo `vi.resetModules()`).
    fetchSpy.mockResolvedValue(
      jsonResponse(503, { error: { code: 'PAYOUT_FUNDING_LOW' } }),
    );
    const e = (await catchPayout()) as Error;
    expect(e.name).toBe('FacilitatorSettleError');
    // Control: un objeto plano con la misma forma también se lee — eso prueba que
    // la lectura NO depende de la identidad de clase.
    expect(
      readSettleValueDisposition({
        name: 'FacilitatorSettleError',
        valueDisposition: 'unknown',
      }),
    ).toBe('unknown');
  });

  it('2xx con firma ⇒ resultado, y alreadySettled se propaga', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, { signature: SIG, alreadySettled: true }),
    );
    const res = await payoutViaFacilitator(input);
    expect(res).toEqual({ signature: SIG, alreadySettled: true });
  });

  it('manda el Bearer cuando hay API key', async () => {
    process.env.SOLANA_FACILITATOR_API_KEY = 'k-123';
    fetchSpy.mockResolvedValue(jsonResponse(200, { signature: SIG }));
    await payoutViaFacilitator(input);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer k-123');
  });

  it('readPayoutCode devuelve undefined para un error cualquiera', () => {
    expect(readPayoutCode(new Error('x'))).toBeUndefined();
    expect(readPayoutCode(null)).toBeUndefined();
  });
});
