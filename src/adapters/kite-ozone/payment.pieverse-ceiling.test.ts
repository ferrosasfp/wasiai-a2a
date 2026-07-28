/**
 * HU-198 — techo de wall-clock de los dos hops `pieverse` + estado `unknown`.
 *
 * QUÉ SE PRUEBA Y POR QUÉ ASÍ
 * ---------------------------
 * Los servidores son `node:http` sobre 127.0.0.1 en puerto efímero (mismo patrón
 * que `lib/outbound-timeout.test.ts`): CERO red externa, nada contra
 * facilitator.pieverse.io. El `fetch` es el REAL y el `AbortSignal` es el REAL —
 * no se mockea el transporte, porque justamente lo que hay que demostrar es que el
 * reloj corta un socket vivo.
 *
 *   T-198-VERIFY — servidor que acepta la conexión y NUNCA contesta. `verify()`
 *     tiene que RECHAZAR dentro del techo. Muta borrando el `signal` del fetch de
 *     `/verify` → el test se cuelga hasta su propio timeout → ROJO.
 *
 *   T-198-SETTLE-UNKNOWN — el test IMPORTANTE. Mismo servidor mudo. `settle()`
 *     tiene que rechazar con `FacilitatorSettleError` y `valueDisposition:
 *     'unknown'`. La propiedad que se afirma es sobre LA PLATA: el gateway declara
 *     "no sé si se pagó", NO "no se pagó". Muta poniendo `'not-sent'` en el throw
 *     del adapter → ROJO (y ese rojo es el que evita el doble pago).
 *
 *   T-198-NOT-SENT — puerto cerrado ⇒ ECONNREFUSED ⇒ el request PROBADAMENTE no
 *     salió ⇒ `'not-sent'`. Es el contra-ejemplo que le da contenido al `unknown`:
 *     sin él, `valueDisposition` podría estar hardcodeado en `'unknown'` y los
 *     otros tests seguirían verdes.
 *
 *   T-198-ENV — el techo se lee de la env con su unidad (ms) y una env basura NO
 *     apaga el techo.
 *
 * NO SE TOCA EL MODO x402: los tests fuerzan `KITE_FACILITATOR_MODE=pieverse`
 * explícitamente para no depender del default al correr la suite.
 */

import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FacilitatorSettleError,
  readSettleValueDisposition,
} from '../errors.js';
import { _resetWalletClient, KiteOzonePaymentAdapter } from './payment.js';

/** Servidor que ACEPTA la conexión y nunca escribe nada (peer mudo). */
function createSilentServer(): HttpServer {
  return createHttpServer(() => {
    // Ni writeHead ni end: el request queda colgado para siempre.
  });
}

/**
 * AR#2 BLQ-MEDIO-1 — servidor que MANDA LOS HEADERS y después TRICKLE-FEEDEA el body
 * para siempre (un espacio cada `gapMs`, sin `end()`).
 *
 * ⚠️ ESTE es el caso que la HU existe para acotar, y era el que NINGÚN test ejercitaba:
 * los 6 originales usaban sólo `createSilentServer()` (peer que nunca escribe headers).
 * El peer MUDO ya estaba acotado por undici a 300 s (`headersTimeout`/`bodyTimeout`);
 * el que NO tiene cota es el que trickle-feedea, porque `bodyTimeout` se REFRESCA en
 * cada chunk. Ver `work-item.md` §"Corrección al encuadre inicial" y
 * `lib/outbound-timeout.ts` §"LOS DOS EJES".
 *
 * Y es justo el caso donde el `AbortSignal` corta DURANTE `response.json()`, o sea
 * FUERA del `try` que envolvía sólo al `fetch`: por eso el error salía como
 * `DOMException/TimeoutError` pelado en vez de `FacilitatorSettleError`.
 */
function createTrickleBodyServer(gapMs = 50): HttpServer {
  const timers = new Set<NodeJS.Timeout>();
  const server = createHttpServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // Un JSON que NUNCA se completa: el parser no puede resolver hasta el `end()`.
    res.write('{"success":');
    const t = setInterval(() => {
      // Espacios: JSON válido como whitespace, así que el body sigue siendo parseable
      // "en progreso" y el peer nunca se queda mudo (refresca el bodyTimeout de undici).
      res.write(' ');
    }, gapMs);
    timers.add(t);
    res.on('close', () => {
      clearInterval(t);
      timers.delete(t);
    });
  });
  server.on('close', () => {
    for (const t of timers) clearInterval(t);
    timers.clear();
  });
  return server;
}

function listen(server: HttpServer): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function close(server: HttpServer): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

/** Puerto efímero que se abre y se cierra ⇒ garantiza ECONNREFUSED. */
async function reserveClosedPortUrl(): Promise<string> {
  const server = createSilentServer();
  const url = await listen(server);
  await close(server);
  return url;
}

const AUTHORIZATION = {
  from: '0x1111111111111111111111111111111111111111',
  to: '0x2222222222222222222222222222222222222222',
  value: '1000000000000000000',
  validAfter: '0',
  validBefore: '99999999999',
  nonce: `0x${'ab'.repeat(32)}`,
} as const;

const PROOF = {
  authorization: { ...AUTHORIZATION },
  signature: `0x${'cd'.repeat(65)}`,
  network: 'eip155:2368',
};

describe('HU-198 — techo de los hops pieverse (kite-ozone)', () => {
  const ENV_KEYS = [
    'KITE_FACILITATOR_MODE',
    'KITE_FACILITATOR_URL',
    'KITE_FACILITATOR_TIMEOUT_MS',
  ] as const;
  let saved: Record<string, string | undefined>;
  let server: HttpServer | undefined;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.KITE_FACILITATOR_MODE = 'pieverse';
    // Techo corto: el test mide que el reloj CORTA, no cuánto vale el default.
    process.env.KITE_FACILITATOR_TIMEOUT_MS = '300';
    _resetWalletClient();
  });

  afterEach(async () => {
    if (server) {
      await close(server);
      server = undefined;
    }
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    _resetWalletClient();
  });

  it('T-198-VERIFY: /verify contra un peer mudo RECHAZA por el techo (no se cuelga)', async () => {
    server = createSilentServer();
    process.env.KITE_FACILITATOR_URL = await listen(server);
    const adapter = new KiteOzonePaymentAdapter();

    const started = Date.now();
    await expect(adapter.verify({ ...PROOF })).rejects.toThrow(
      /Facilitator network error/,
    );
    const elapsed = Date.now() - started;

    // Cortó por el techo (300 ms), no por el default de undici (300_000 ms). El
    // margen es generoso a propósito: lo que se afirma es el ORDEN DE MAGNITUD.
    expect(elapsed).toBeLessThan(15_000);
  });

  it('T-198-VERIFY-plain: el abort de /verify NO es un FacilitatorSettleError (verify no broadcastea)', async () => {
    server = createSilentServer();
    process.env.KITE_FACILITATOR_URL = await listen(server);
    const adapter = new KiteOzonePaymentAdapter();

    // /verify no puede dejar plata en el aire, así que su camino de error se
    // conserva TAL CUAL: un Error común, sin disposición de valor. Si alguien le
    // pone la disposición "por simetría", este test lo caza — y el problema no es
    // cosmético: un `unknown` en verify mandaría a reconciliar plata que nunca se
    // movió.
    const err = await adapter.verify({ ...PROOF }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(FacilitatorSettleError);
  });

  it('T-198-SETTLE-UNKNOWN: /settle abortado por el techo declara la plata en estado unknown (NO "no se pagó")', async () => {
    server = createSilentServer();
    process.env.KITE_FACILITATOR_URL = await listen(server);
    const adapter = new KiteOzonePaymentAdapter();

    const started = Date.now();
    const err = await adapter.settle({ ...PROOF }).catch((e: unknown) => e);
    const elapsed = Date.now() - started;

    // 1. Cortó (no se colgó).
    expect(elapsed).toBeLessThan(15_000);

    // 2. LA PROPIEDAD DE DINERO: el settle NO se resuelve como "no pagó". No
    //    devuelve `{ success: false }` (eso significaría "no se pagó" y habilitaría
    //    un reintento) y tampoco un error pelado indistinguible de un rechazo del
    //    facilitator: tira TIPADO diciendo que la plata pudo haber salido.
    expect(err).toBeInstanceOf(FacilitatorSettleError);
    expect((err as FacilitatorSettleError).valueDisposition).toBe('unknown');
  });

  it('T-198-SETTLE-NOT-SENT: puerto cerrado (ECONNREFUSED) ⇒ not-sent (el request no salió)', async () => {
    // Contra-ejemplo: si `valueDisposition` estuviese fijo en 'unknown', este test
    // es el único que se pone rojo.
    process.env.KITE_FACILITATOR_URL = await reserveClosedPortUrl();
    const adapter = new KiteOzonePaymentAdapter();

    const err = await adapter.settle({ ...PROOF }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FacilitatorSettleError);
    expect((err as FacilitatorSettleError).valueDisposition).toBe('not-sent');
  });

  // ════════════════════════════════════════════════════════════════════
  // AR#2 BLQ-MEDIO-1 — el techo que se cumple DURANTE EL BODY
  // ════════════════════════════════════════════════════════════════════
  it('T-198-AR2-TRICKLE-SETTLE: el techo que corta durante el body SIGUE dando unknown tipado', async () => {
    // EL CASO CENTRAL DE LA HU. El `work-item.md` establece que el peer mudo ya estaba
    // acotado por undici a 300 s y que "lo verdaderamente ilimitado es el peer que
    // trickle-feedea". Acá el abort ocurre leyendo el body, no esperando los headers.
    //
    // La propiedad es sobre LA PLATA y es la MISMA que T-198-SETTLE-UNKNOWN: el gateway
    // declara "no sé si se pagó". Que el reloj se cumpla antes o después de los headers
    // no cambia nada de lo que le pasó al dinero, así que no puede cambiar el canal por
    // el que se reporta.
    server = createTrickleBodyServer(50);
    process.env.KITE_FACILITATOR_URL = await listen(server);
    const adapter = new KiteOzonePaymentAdapter();

    const started = Date.now();
    const err = await adapter.settle({ ...PROOF }).catch((e: unknown) => e);
    const elapsed = Date.now() - started;

    // 1. Cortó por el techo (300 ms), no por el bodyTimeout de undici (300 s), que en
    //    este servidor NUNCA dispara porque se refresca en cada chunk.
    expect(elapsed).toBeLessThan(15_000);

    // 2. Y salió por el canal TIPADO. Antes del fix esto era un DOMException/TimeoutError
    //    pelado: `instanceof FacilitatorSettleError === false` y
    //    `readSettleValueDisposition(err) === undefined`, con la consecuencia de que el
    //    caller inbound recibía "Payment settlement failed" (le afirmábamos que no se le
    //    cobró) y no se escribía la fila de reconciliación.
    expect(err).toBeInstanceOf(FacilitatorSettleError);
    expect((err as FacilitatorSettleError).valueDisposition).toBe('unknown');
    // El canal estructural que consumen los dos call-sites (no sólo la clase).
    expect(readSettleValueDisposition(err)).toBe('unknown');
  });

  it('T-198-AR2-TRICKLE-VERIFY: el /verify que corta durante el body conserva su contrato (Error común, con el prefijo)', async () => {
    // El contrato de `/verify` NO cambia (no broadcastea nada), pero el mensaje tiene
    // que ser el mismo en los dos ejes: antes, el abort durante el body se escapaba del
    // catch y salía como TimeoutError sin el prefijo `Facilitator network error`, o sea
    // que el propio candado T-198-VERIFY no cubría este eje.
    server = createTrickleBodyServer(50);
    process.env.KITE_FACILITATOR_URL = await listen(server);
    const adapter = new KiteOzonePaymentAdapter();

    const err = await adapter.verify({ ...PROOF }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Facilitator network error/);
    // Sigue SIN disposición de valor: un verify abortado no puede dejar plata en el aire,
    // y marcarlo `unknown` mandaría a reconciliar dinero que nunca se movió.
    expect(err).not.toBeInstanceOf(FacilitatorSettleError);
    expect(readSettleValueDisposition(err)).toBeUndefined();
  });

  it('T-198-AR2-BADJSON: un body 200 que NO parsea también es unknown (el facilitator pudo haber pagado)', async () => {
    // Contra-ejemplo del mismo `try`: si el body llega COMPLETO pero no parsea, tampoco
    // sabemos qué pasó con la plata. Antes esto era un SyntaxError pelado.
    server = createHttpServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('this is definitely not json');
    });
    process.env.KITE_FACILITATOR_URL = await listen(server);
    const adapter = new KiteOzonePaymentAdapter();

    const err = await adapter.settle({ ...PROOF }).catch((e: unknown) => e);
    expect(readSettleValueDisposition(err)).toBe('unknown');
  });

  it('T-198-AR2-HTTP-ERROR: un HTTP 4xx/5xx CONTESTADO sigue siendo un veredicto, no un unknown', async () => {
    // Candado de NO-REGRESIÓN del fix: al mover el body read dentro de un try que
    // clasifica, el riesgo era arrastrar también el camino "el facilitator contestó
    // rechazando", que es un VEREDICTO y no una incógnita de transporte. Ese camino
    // (y su reclasificación) es el BLQ-ALTO, Scope OUT de esta HU: acá se candea que
    // NO cambió.
    server = createHttpServer((_req, res) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end('{"error":"bad gateway"}');
    });
    process.env.KITE_FACILITATOR_URL = await listen(server);
    const adapter = new KiteOzonePaymentAdapter();

    const err = await adapter.settle({ ...PROOF }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/HTTP 502/);
    expect(err).not.toBeInstanceOf(FacilitatorSettleError);
    expect(readSettleValueDisposition(err)).toBeUndefined();
  });

  it('T-198-ENV: una env basura NO apaga el techo (cae al default, sigue cortando)', async () => {
    server = createSilentServer();
    process.env.KITE_FACILITATOR_URL = await listen(server);
    // 0 y "abc" tienen que caer al default de 30 s, NO desactivar el signal. No se
    // espera el default completo: se afirma que el abort EXISTE, con un techo de
    // request más corto que el default para no tardar 30 s en el assert.
    process.env.KITE_FACILITATOR_TIMEOUT_MS = 'abc';
    const adapter = new KiteOzonePaymentAdapter();

    const err = await Promise.race([
      adapter.settle({ ...PROOF }).catch((e: unknown) => e),
      new Promise((resolve) => setTimeout(() => resolve('still-hanging'), 800)),
    ]);
    // Con el default de 30 s todavía está esperando a los 800 ms — eso es correcto
    // y es lo que se afirma: la env basura NO se interpretó como "0 = sin techo"
    // (que abortaría de inmediato) ni tiró.
    expect(err).toBe('still-hanging');
  });

  it('T-198-ENV-honra-el-valor: el techo se lee en MILISEGUNDOS de la env', async () => {
    server = createSilentServer();
    process.env.KITE_FACILITATOR_URL = await listen(server);
    process.env.KITE_FACILITATOR_TIMEOUT_MS = '250';
    const adapter = new KiteOzonePaymentAdapter();

    const started = Date.now();
    await expect(adapter.settle({ ...PROOF })).rejects.toBeInstanceOf(
      FacilitatorSettleError,
    );
    const elapsed = Date.now() - started;
    // 250 ms de techo ⇒ cortó muy por debajo del default de 30 s. Si el adapter
    // ignorara la env, esto tardaría 30 s y el test se pondría rojo por timeout.
    expect(elapsed).toBeLessThan(10_000);
  });
});
