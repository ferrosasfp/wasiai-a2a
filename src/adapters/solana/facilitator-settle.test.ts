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
  _resetPayoutRoutePreflight,
  ensurePayoutRouteReady,
  PAYOUT_NO_SPEND_CODES,
  payoutViaFacilitator,
  readPayoutCode,
  warmPayoutRoutePreflight,
} from './facilitator-settle.js';

const PAY_TO = 'So11111111111111111111111111111111111111112';
const SIG = '7'.repeat(64);

const savedEnv = new Map<string, string | undefined>();
const ENV_KEYS = [
  'SOLANA_FACILITATOR_URL',
  'SOLANA_FACILITATOR_API_KEY',
  'WASIAI_FACILITATOR_URL',
  'FACILITATOR_API_KEY',
  // WKH-342 — la bandera queda BORRADA en cada `beforeEach`, así que en todos los tests
  // de arriba de este archivo el sondeo de la ruta está desarmado y el `fetch` que ven
  // sigue siendo UNO, el POST, en `mock.calls[0]`. Los tests de WKH-342 la prenden
  // explícitamente.
  'SOLANA_SETTLE_VIA_FACILITATOR',
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
  // WKH-342 — el veredicto del sondeo se memoiza a nivel de módulo: sin este reset, el
  // primer test que sondea decide por los que vienen después y los conteos de `fetch`
  // dependerían del orden.
  _resetPayoutRoutePreflight();
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

  it('★ AR BLQ-3: PAYOUT_STORE_UNAVAILABLE ⇒ unknown, NO "no se gastó"', async () => {
    // Ese código responde sobre ESTE request; la pregunta del gateway es sobre el
    // INTENT. Se emite con el ledger caído (donde el intent puede estar pagado de
    // antes) y también cuando el perdedor de un CAS pierde mientras el ganador
    // transmite. Tratarlo como prueba de no-gasto dispara reembolso sobre un pago
    // que existe.
    fetchSpy.mockResolvedValue(
      jsonResponse(500, { error: { code: 'PAYOUT_STORE_UNAVAILABLE' } }),
    );
    const e = await catchPayout();
    expect(readSettleValueDisposition(e)).toBe('unknown');
    expect(PAYOUT_NO_SPEND_CODES.has('PAYOUT_STORE_UNAVAILABLE' as never)).toBe(
      false,
    );
  });

  it('★ PAYOUT_BROADCAST_UNKNOWN (código nuevo del facilitator) ⇒ unknown por default', async () => {
    // No hace falta que el gateway lo conozca: la regla de default lo pone del
    // lado seguro solo. Ésa es la propiedad que hace segura la lista cerrada.
    fetchSpy.mockResolvedValue(
      jsonResponse(502, { error: { code: 'PAYOUT_BROADCAST_UNKNOWN' } }),
    );
    expect(readSettleValueDisposition(await catchPayout())).toBe('unknown');
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

// ═══════════════════════════════════════════════════════════════════════════════
// WKH-342 — LOS TRES DESENLACES DEL SONDEO
//
// El defecto que estos tests fijan: "el facilitator me dijo que no tiene la ruta" y
// "no pude preguntarle" NO son lo mismo, y colapsarlos rompe en direcciones opuestas.
// Cuatro inputs distintos, tres desenlaces:
//   · `dedicatedRoutes: ['POST /solana/payout']` → route_registered  (T-B2)
//   · `dedicatedRoutes: []`                      → route_absent      (T-B3)
//   · el `fetch` del sondeo RECHAZA              → route_unaskable/transport_error (T-B4)
//   · 200 sin el campo                           → route_unaskable/field_absent    (T-B5)
//   · 404 sobre /supported y cuerpo no-JSON      → route_unaskable/probe_http_error
//                                                  y /body_unreadable              (T-B6)
// ═══════════════════════════════════════════════════════════════════════════════

const PROBE_URL = 'https://facilitator.test/supported';
const POST_URL = 'https://facilitator.test/solana/payout';

/** Deja correr las microtasks pendientes SIN tocar el veredicto memoizado. */
const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

/** Todas las URLs a las que se llamó, en orden. */
const calledUrls = (): string[] =>
  (fetchSpy.mock.calls as unknown[][]).map((c) => String(c[0]));

function textResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html' },
  });
}

describe('WKH-342 T-B1/T-B2 — el sondeo suena al arrancar y el positivo deja pasar', () => {
  beforeEach(() => {
    process.env.SOLANA_SETTLE_VIA_FACILITATOR = 'true';
  });

  it('★ T-B1 / AC-2: el arranque dispara UN GET {url}/supported, fire-and-forget', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, { chains: [], methods: [], dedicatedRoutes: [] }),
    );

    // Nada de `await ensurePayoutRouteReady()` acá: eso sondearía por su cuenta y el
    // test daría verde incluso con la llamada del warm-up borrada. Lo único que se
    // ejercita es `warmPayoutRoutePreflight()`.
    warmPayoutRoutePreflight();
    await flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(calledUrls()).toEqual([PROBE_URL]);
    expect((fetchSpy.mock.calls[0]?.[1] as RequestInit).method).toBe('GET');
  });

  it('★ T-B1b: el warm-up no puede tirar aunque el sondeo rechace (el arranque no falla por el vecino)', async () => {
    fetchSpy.mockRejectedValue(
      new Error('getaddrinfo ENOTFOUND facilitator.test'),
    );
    expect(() => warmPayoutRoutePreflight()).not.toThrow();
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('★ T-B2 / AC-2+AC-3: dedicatedRoutes CONTIENE la ruta ⇒ se hace el POST y vuelve la firma', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse(200, {
          chains: [],
          methods: [],
          dedicatedRoutes: ['POST /solana/payout'],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { signature: SIG }));

    const res = await payoutViaFacilitator(input);

    expect(res).toEqual({ signature: SIG, alreadySettled: false });
    expect(calledUrls()).toEqual([PROBE_URL, POST_URL]);
  });

  it('★ T-B2b: el veredicto positivo es route_registered, y el gate perezoso COMPARTE ese veredicto (un solo GET)', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse(200, { dedicatedRoutes: ['POST /solana/payout'] }),
      )
      .mockResolvedValue(jsonResponse(200, { signature: SIG }));

    // El warm-up sondea; el gate del leg NO vuelve a sondear.
    expect(await ensurePayoutRouteReady()).toEqual({
      state: 'route_registered',
    });
    await payoutViaFacilitator(input);

    expect(calledUrls()).toEqual([PROBE_URL, POST_URL]);
  });
});

describe('WKH-342 T-B3 — route_absent: el ÚNICO desenlace que corta', () => {
  beforeEach(() => {
    process.env.SOLANA_SETTLE_VIA_FACILITATOR = 'true';
  });

  it('★ T-B3 / AC-3: dedicatedRoutes: [] ⇒ rechazo ANTES del POST, not-sent, y NUNCA se llama /solana/payout', async () => {
    // Doble 200 con `[]`: si el gate no existiera, aparecería un segundo `fetch` contra
    // /solana/payout con esta misma respuesta y `catchPayout` vería otro error.
    fetchSpy.mockResolvedValue(jsonResponse(200, { dedicatedRoutes: [] }));

    const e = await catchPayout();

    expect(readSettleValueDisposition(e)).toBe('not-sent');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(calledUrls()).toEqual([PROBE_URL]);
    expect(calledUrls()).not.toContain(POST_URL);
  });

  it('★ T-B3b: `[]` es una RESPUESTA (route_absent), no un "no sé" — y el par que lo distingue es T-B5', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, { chains: [], methods: [], dedicatedRoutes: [] }),
    );
    const verdict = await ensurePayoutRouteReady();
    expect(verdict?.state).toBe('route_absent');
  });

  it('★ T-B3c: dedicatedRoutes con OTRAS rutas y no la nuestra ⇒ igual es route_absent', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        dedicatedRoutes: [
          'POST /solana/sponsor',
          'POST /solana/escrow/release',
        ],
      }),
    );
    const verdict = await ensurePayoutRouteReady();
    expect(verdict?.state).toBe('route_absent');
    // El detalle nombra lo que el facilitator SÍ enumeró: sin eso el operador no puede
    // distinguir "no tiene ninguna" de "tiene las otras dos".
    expect(verdict?.state === 'route_absent' ? verdict.detail : '').toContain(
      'POST /solana/sponsor',
    );
  });
});

describe('WKH-342 T-B4/T-B5/T-B6 — route_unaskable: "no pude preguntar" DEJA PASAR', () => {
  beforeEach(() => {
    process.env.SOLANA_SETTLE_VIA_FACILITATOR = 'true';
  });

  it('★ T-B4 / AC-4(i): el sondeo RECHAZA (socket hang up / ETIMEDOUT) ⇒ transport_error, y el POST SÍ se hace', async () => {
    // ⚠️ El doble RECHAZA. NO devuelve un 404: un 404 es una RESPUESTA y no prueba el
    // tercer desenlace. Éste es el único input del archivo que ejercita el `catch` del
    // `fetch` del sondeo.
    fetchSpy
      .mockRejectedValueOnce(
        Object.assign(new Error('socket hang up'), {
          cause: { code: 'ETIMEDOUT' },
        }),
      )
      .mockResolvedValue(jsonResponse(200, { signature: SIG }));

    const verdict = await ensurePayoutRouteReady();
    expect(verdict).toEqual({
      state: 'route_unaskable',
      reason: 'transport_error',
      detail: expect.stringContaining('socket hang up'),
    });

    // Y el leg NO se bloquea: el POST real sale y lo decide la respuesta real.
    const res = await payoutViaFacilitator(input);
    expect(res.signature).toBe(SIG);
    expect(calledUrls()).toEqual([PROBE_URL, POST_URL]);
  });

  it('★ T-B4b / AC-4(i): un sondeo que rechaza NO le impide al leg fallar por su propio mérito', async () => {
    // Control de que el "deja pasar" no es "deja pasar como éxito": la disposición sigue
    // saliendo de la respuesta REAL del POST, no del sondeo.
    fetchSpy
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValue(
        jsonResponse(503, { error: { code: 'PAYOUT_FUNDING_LOW' } }),
      );

    const e = await catchPayout();
    expect(readSettleValueDisposition(e)).toBe('not-sent');
    expect(readPayoutCode(e)).toBe('PAYOUT_FUNDING_LOW');
    expect(calledUrls()).toEqual([PROBE_URL, POST_URL]);
  });

  it('★ T-B5 / AC-4(ii): 200 SANO SIN dedicatedRoutes (facilitator viejo) ⇒ field_absent, y el POST se hace', async () => {
    // El input es un `/supported` de ANTES de la mitad A: forma completa y correcta, sin
    // el campo nuevo. La ausencia NO es "no está la ruta".
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse(200, { chains: [], methods: ['eip3009'] }),
      )
      .mockResolvedValue(jsonResponse(200, { signature: SIG }));

    const verdict = await ensurePayoutRouteReady();
    expect(verdict?.state).toBe('route_unaskable');
    expect(
      verdict?.state === 'route_unaskable' ? verdict.reason : undefined,
    ).toBe('field_absent');

    const res = await payoutViaFacilitator(input);
    expect(res.signature).toBe(SIG);
    expect(calledUrls()).toEqual([PROBE_URL, POST_URL]);
  });

  it('★ T-B5b / AC-4(ii): `dedicatedRoutes: null` y `dedicatedRoutes: "POST /solana/payout"` NO son arrays ⇒ field_absent', async () => {
    // `Array.isArray`, nunca truthiness: un string que CONTIENE el id tampoco alcanza.
    for (const value of [null, 'POST /solana/payout', 42, {}]) {
      _resetPayoutRoutePreflight();
      fetchSpy.mockResolvedValue(jsonResponse(200, { dedicatedRoutes: value }));
      const verdict = await ensurePayoutRouteReady();
      expect(
        verdict?.state === 'route_unaskable' ? verdict.reason : verdict?.state,
      ).toBe('field_absent');
    }
  });

  it('★ T-B6 / AC-4: 404 sobre /supported ⇒ probe_http_error (NO route_absent) — el candado contra el proxy', async () => {
    // Un 404 lo puede emitir cualquier intermediario. Mapearlo a `route_absent` cortaría
    // los pagos por un proxy mal configurado, con el facilitator sano del otro lado.
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(404, { error: { code: 'NOT_FOUND' } }),
    );

    const verdict = await ensurePayoutRouteReady();
    expect(verdict?.state).toBe('route_unaskable');
    expect(
      verdict?.state === 'route_unaskable' ? verdict.reason : undefined,
    ).toBe('probe_http_error');
    expect(verdict?.state).not.toBe('route_absent');
  });

  it('★ T-B6b / AC-4: 200 con cuerpo no-JSON ⇒ body_unreadable, también route_unaskable', async () => {
    fetchSpy.mockResolvedValueOnce(
      textResponse(200, '<html>gateway splash page</html>'),
    );

    const verdict = await ensurePayoutRouteReady();
    expect(verdict?.state).toBe('route_unaskable');
    expect(
      verdict?.state === 'route_unaskable' ? verdict.reason : undefined,
    ).toBe('body_unreadable');
  });

  it('★ T-B6c: un ARRAY como cuerpo es body_unreadable, no field_absent', async () => {
    // En un array `body.dedicatedRoutes` es `undefined`, y leerlo como "campo ausente"
    // le atribuiría al facilitator una respuesta que no dio.
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, ['POST /solana/payout']));
    const verdict = await ensurePayoutRouteReady();
    expect(
      verdict?.state === 'route_unaskable' ? verdict.reason : verdict?.state,
    ).toBe('body_unreadable');
  });

  it('★ T-B6d: los cuatro motivos de route_unaskable dejan pasar al POST — ninguno bloquea un leg', async () => {
    const cases: Array<[UnaskableReasonName, () => void]> = [
      [
        'transport_error',
        () => fetchSpy.mockRejectedValueOnce(new Error('boom')),
      ],
      [
        'probe_http_error',
        () => fetchSpy.mockResolvedValueOnce(jsonResponse(500, {})),
      ],
      [
        'body_unreadable',
        () => fetchSpy.mockResolvedValueOnce(textResponse(200, 'not json')),
      ],
      [
        'field_absent',
        () => fetchSpy.mockResolvedValueOnce(jsonResponse(200, {})),
      ],
    ];

    for (const [expectedReason, arm] of cases) {
      _resetPayoutRoutePreflight();
      fetchSpy.mockReset();
      arm();
      fetchSpy.mockResolvedValue(jsonResponse(200, { signature: SIG }));

      const verdict = await ensurePayoutRouteReady();
      expect(
        verdict?.state === 'route_unaskable' ? verdict.reason : verdict?.state,
      ).toBe(expectedReason);

      // El leg pasa. Si alguien colapsa cualquiera de los cuatro en `route_absent`,
      // esto tira y el `calledUrls()` de abajo no llega a tener el POST.
      const res = await payoutViaFacilitator(input);
      expect(res.signature).toBe(SIG);
      expect(calledUrls()).toContain(POST_URL);
    }
  });
});

type UnaskableReasonName =
  | 'transport_error'
  | 'probe_http_error'
  | 'body_unreadable'
  | 'field_absent';

describe('WKH-342 T-B8 / AC-5 — con la bandera apagada el sondeo NO existe', () => {
  it('★ T-B8: bandera ausente / false / TRUE / 1 / yes / "" ⇒ CERO fetch del sondeo, en el warm-up y en el gate', async () => {
    // `Boolean(process.env.X)` en vez de `=== 'true'` mandaría a la red a cinco de estos
    // seis valores. Y `'TRUE'` está a propósito: la comparación es por literal exacta,
    // igual que `assertFacilitatorPayoutConfigured` y que la ramificación de `settle()`.
    const values: Array<string | undefined> = [
      undefined,
      'false',
      'TRUE',
      '1',
      'yes',
      '',
    ];

    for (const value of values) {
      _resetPayoutRoutePreflight();
      fetchSpy.mockReset();
      if (value === undefined) delete process.env.SOLANA_SETTLE_VIA_FACILITATOR;
      else process.env.SOLANA_SETTLE_VIA_FACILITATOR = value;

      warmPayoutRoutePreflight();
      await flush();
      expect(fetchSpy).not.toHaveBeenCalled();

      // El gate perezoso tampoco: devuelve `null` ("no se sondeó"), que NO es un
      // veredicto sobre la ruta.
      expect(await ensurePayoutRouteReady()).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  });

  it('★ T-B8b / AC-5: con la bandera ON pero SIN URL, el gate tampoco sondea (esa decisión ya la tomó el guard de arranque)', async () => {
    process.env.SOLANA_SETTLE_VIA_FACILITATOR = 'true';
    delete process.env.SOLANA_FACILITATOR_URL;

    expect(await ensurePayoutRouteReady()).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();

    // Y el leg sigue muriendo por donde moría antes de WKH-342: 'not-sent', sin fetch.
    const e = await catchPayout();
    expect(readSettleValueDisposition(e)).toBe('not-sent');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('★ T-B8c: con la bandera ON el POST del leg lleva el sondeo DELANTE, no en lugar de él', async () => {
    // Control positivo de T-B8: sin esto, los `not.toHaveBeenCalled()` de arriba también
    // pasarían si el sondeo no existiera en ningún caso.
    process.env.SOLANA_SETTLE_VIA_FACILITATOR = 'true';
    // `mockImplementation` y no `mockResolvedValue`: el cuerpo de un `Response` se lee
    // UNA sola vez, así que reusar el mismo objeto para el sondeo y para el POST le daría
    // al segundo un cuerpo consumido (medido: 'no JSON body'). Cada llamada necesita su
    // propio `Response`.
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(200, {
          dedicatedRoutes: ['POST /solana/payout'],
          signature: SIG,
        }),
      ),
    );
    await payoutViaFacilitator(input);
    expect(calledUrls()).toEqual([PROBE_URL, POST_URL]);
  });
});

describe('WKH-342 T-B10 / AC-6 — el sondeo NO fabrica una disposición de pago', () => {
  it('★ T-B10: PAYOUT_NO_SPEND_CODES es el MISMO conjunto — el sondeo no agregó ni quitó un código', async () => {
    // Comparación de CONJUNTO contra la lista escrita a mano, no contra sí misma.
    expect([...PAYOUT_NO_SPEND_CODES].sort()).toEqual(
      [
        'INVALID_AMOUNT',
        'INVALID_PAYLOAD',
        'NETWORK_MISMATCH',
        'PAYOUT_BROADCAST_EXPIRED',
        'PAYOUT_DAILY_CAP',
        'PAYOUT_FUNDING_LOW',
        'PAYOUT_INTENT_CONFLICT',
        'PAYOUT_NOT_ENABLED',
        'PAYOUT_RATE_LIMITED',
        'PAYOUT_RPC_UNAVAILABLE',
      ].sort(),
    );
    expect(PAYOUT_NO_SPEND_CODES.size).toBe(10);
    // Ningún código nuevo con pinta de sondeo se colÓ en la lista de "no se gastó".
    for (const code of PAYOUT_NO_SPEND_CODES) {
      expect(code).not.toMatch(/ROUTE|PROBE|SUPPORTED|UNASKABLE/i);
    }
  });

  it('★ T-B10b / AC-6: NINGÚN veredicto del sondeo devuelve un resultado — route_absent LANZA y los unaskable no resuelven solos', async () => {
    process.env.SOLANA_SETTLE_VIA_FACILITATOR = 'true';

    // (a) route_absent: lanza. No devuelve un `{ signature }` sintético ni un
    //     `success: false` inventado a partir de una respuesta del facilitator.
    //     ⚠️ El `rejects.toThrow()` solo NO alcanza: sin el gate, el POST sale y también
    //     tira (por otro motivo). Lo que fija el desenlace es la DISPOSICIÓN + que no
    //     haya habido POST.
    fetchSpy.mockImplementation(() =>
      Promise.resolve(jsonResponse(200, { dedicatedRoutes: [] })),
    );
    const absentErr = await catchPayout();
    expect(readSettleValueDisposition(absentErr)).toBe('not-sent');
    expect(calledUrls()).not.toContain(POST_URL);

    // (b) route_unaskable sobre un 404 del sondeo: el leg NO se resuelve por el sondeo.
    //     El único que puede resolverlo es el POST real, y acá su 404 sigue cayendo en
    //     'unknown' — la decisión de HU-201, intacta.
    _resetPayoutRoutePreflight();
    fetchSpy.mockReset();
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(404, {}))
      .mockResolvedValue(jsonResponse(404, {}));
    const e = await catchPayout();
    expect(readSettleValueDisposition(e)).toBe('unknown');
    expect(readPayoutCode(e)).toBeUndefined();
  });

  it('★ T-B10c / AC-6: el error de route_absent se lee POR FORMA como los demás (name del padre)', async () => {
    process.env.SOLANA_SETTLE_VIA_FACILITATOR = 'true';
    fetchSpy.mockImplementation(() =>
      Promise.resolve(jsonResponse(200, { dedicatedRoutes: [] })),
    );
    const e = (await catchPayout()) as Error;
    expect(e.name).toBe('FacilitatorSettleError');
    // Y es EL error del gate, no el que produciría el POST si el gate no existiera: la
    // disposición es 'not-sent' y el mensaje nombra la ruta que falta.
    expect(readSettleValueDisposition(e)).toBe('not-sent');
    expect(e.message).toContain('does not serve POST /solana/payout');
    // Y NO trae `payoutCode`: no hubo código del facilitator sobre este pago porque no
    // hubo pago. Inventarle uno sería fabricar una disposición.
    expect(readPayoutCode(e)).toBeUndefined();
  });
});

describe('WKH-342 T-B11 — memoización, single-flight y TTL doble (300 s / 60 s)', () => {
  beforeEach(() => {
    process.env.SOLANA_SETTLE_VIA_FACILITATOR = 'true';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('★ T-B11: 3 llamadas CONCURRENTES ⇒ UN solo GET /supported', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, { dedicatedRoutes: ['POST /solana/payout'] }),
    );

    const verdicts = await Promise.all([
      ensurePayoutRouteReady(),
      ensurePayoutRouteReady(),
      ensurePayoutRouteReady(),
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(verdicts).toEqual([
      { state: 'route_registered' },
      { state: 'route_registered' },
      { state: 'route_registered' },
    ]);
  });

  it('★ T-B11b: un route_registered SE RE-SONDEA pasados los 300 s — el facilitator redespliega solo', async () => {
    // Es el "queda stale" del work-item, hecho test. Cachear el positivo para siempre
    // dejaría a este proceso creyendo por siempre que la ruta está.
    vi.useFakeTimers();
    // Un `Response` nuevo por llamada: acá hay DOS sondeos y el cuerpo de un `Response`
    // se lee una sola vez.
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(200, { dedicatedRoutes: ['POST /solana/payout'] }),
      ),
    );

    expect((await ensurePayoutRouteReady())?.state).toBe('route_registered');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // A los 299 s todavía vale el cache.
    vi.advanceTimersByTime(299_000);
    await ensurePayoutRouteReady();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // A los 301 s se vuelve a preguntar, y la respuesta sigue siendo legible (si el
    // segundo sondeo leyera un cuerpo consumido, esto sería `route_unaskable`).
    vi.advanceTimersByTime(2_000);
    expect((await ensurePayoutRouteReady())?.state).toBe('route_registered');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('★ T-B11c: un route_absent se re-sondea pasados los 60 s (y el positivo NO, a los 60 s)', async () => {
    vi.useFakeTimers();
    fetchSpy.mockResolvedValue(jsonResponse(200, { dedicatedRoutes: [] }));

    expect((await ensurePayoutRouteReady())?.state).toBe('route_absent');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(59_000);
    await ensurePayoutRouteReady();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    // El facilitator ahora sí la tiene: el re-sondeo lo ve, y con un TTL infinito para
    // el negativo esto quedaría apagado hasta el próximo deploy.
    fetchSpy.mockResolvedValue(
      jsonResponse(200, { dedicatedRoutes: ['POST /solana/payout'] }),
    );
    expect((await ensurePayoutRouteReady())?.state).toBe('route_registered');
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Y a partir de acá el POSITIVO aguanta los mismos 60 s sin re-sondear: los dos TTL
    // son distintos, no un solo número.
    vi.advanceTimersByTime(61_000);
    await ensurePayoutRouteReady();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('★ T-B11d: un route_unaskable también expira a los 60 s (no deja el "no sé" pegado)', async () => {
    vi.useFakeTimers();
    fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse(200, {})));

    expect((await ensurePayoutRouteReady())?.state).toBe('route_unaskable');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(61_000);
    expect((await ensurePayoutRouteReady())?.state).toBe('route_unaskable');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
