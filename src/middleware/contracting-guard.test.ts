/**
 * WKH-360 · CAPA 2 — la matriz de validación del preHandler inbound.
 *
 * Este archivo cubre QUÉ decide el middleware y con QUÉ shape lo contesta. Lo que
 * NO cubre —y que se mide en `routes/compose.contracting-loop.test.ts`— es el
 * ORDEN respecto del dinero: acá se monta una app mínima que no tiene middleware de
 * débito, así que un verde de este archivo no dice nada sobre si se cobró.
 *
 * El orden de los seis pasos es NORMATIVO (CD-16) y por eso hay `it` dedicados a la
 * PRECEDENCIA entre pasos, no sólo al veredicto de cada uno: dos pasos que aplican a
 * la vez tienen que resolverse en un orden fijo, o el código de error que el caller
 * recibe depende de detalles de implementación.
 */

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONTRACTING_CHAIN_HEADER,
  CONTRACTING_CHAIN_MALFORMED,
  CONTRACTING_DEPTH_EXCEEDED,
  CONTRACTING_DEPTH_HEADER,
  CONTRACTING_DEPTH_MALFORMED,
  CONTRACTING_LAYER2_BEST_EFFORT_NOTE,
  CONTRACTING_LOOP_DETECTED,
} from '../lib/contracting-chain.js';
import { contractingGuardHandler } from './contracting-guard.js';

const SELF = 'gw.wasiai.example';
const ENV_KEYS = ['A2A_SELF_HOSTS', 'BASE_URL', 'A2A_CONTRACTING_DEPTH_MAX'];
const saved: Record<string, string | undefined> = {};

/** App mínima: el preHandler bajo prueba + un handler que dice qué quedó en el request. */
async function makeApp() {
  const app = Fastify();
  app.post(
    '/x',
    { preHandler: [contractingGuardHandler] },
    async (request, reply) =>
      reply.send({
        reached: true,
        chain: request.contractingChain,
        depth: request.contractingDepth,
      }),
  );
  await app.ready();
  return app;
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.A2A_SELF_HOSTS = SELF;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function post(headers: Record<string, string>) {
  const app = await makeApp();
  try {
    return await app.inject({
      method: 'POST',
      url: '/x',
      headers,
      payload: {},
    });
  } finally {
    await app.close();
  }
}

describe('CAPA 2 — bucle transitivo por la traza (AC-5)', () => {
  it('T-L2-1: la cadena nos contiene → 400 CONTRACTING_LOOP_DETECTED con layer "chain"', async () => {
    const res = await post({ [CONTRACTING_CHAIN_HEADER]: SELF });
    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe(CONTRACTING_LOOP_DETECTED);
    expect(res.json().layer).toBe('chain');
  });

  it('T-L2-2 (CD-6): el BODY del error trae la nota best-effort TEXTUAL', async () => {
    // No es adorno: sin esta nota, un coordinador que recibe el rechazo leería que
    // los bucles transitivos están cerrados. Y sale de la CONSTANTE del leaf, así
    // que el texto que emite el código y el que asserta este test no pueden
    // divergir — si alguien reescribe uno, el otro se mueve con él.
    const res = await post({ [CONTRACTING_CHAIN_HEADER]: SELF });
    expect(res.json().note).toBe(CONTRACTING_LAYER2_BEST_EFFORT_NOTE);
    // y la nota dice lo que tiene que decir
    expect(res.json().note).toContain('BEST-EFFORT');
    expect(res.json().note).toContain('reenvie');
  });

  it('T-L2-3 (CD-15): `otro-gw, <SELF>., tercero` → rechazo por MEMBRESÍA (no por forma)', async () => {
    // Mayúsculas Y punto final Y espacios después de la coma. El código tiene que
    // ser el de BUCLE: si saliera CHAIN_MALFORMED, el rechazo vendría del paso de
    // forma y este `it` no probaría nada sobre la canonicalización de los eslabones.
    const res = await post({
      [CONTRACTING_CHAIN_HEADER]: `otro-gw.example, ${SELF.toUpperCase()}., tercero.example`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe(CONTRACTING_LOOP_DETECTED);
  });

  it('T-L2+1 (AC-8, CD-7): cadena de TERCEROS con depth bajo el techo → PASA', async () => {
    const res = await post({
      [CONTRACTING_CHAIN_HEADER]: 'otro-gw.example',
      [CONTRACTING_DEPTH_HEADER]: '1',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reached).toBe(true);
    expect(res.json().chain).toEqual(['otro-gw.example']);
    expect(res.json().depth).toBe(1);
  });

  it('T-L2+2 (AC-8): SIN ninguno de los dos headers → PASA (el 100% del tráfico de hoy)', async () => {
    const res = await post({});
    expect(res.statusCode).toBe(200);
    expect(res.json().chain).toEqual([]);
    expect(res.json().depth).toBe(0);
  });
});

describe('CAPA 2 — largo, conteo y forma de la cadena (CD-16, pasos 1-3)', () => {
  it('T-CHAIN-1: header de 8192 caracteres → 400 CONTRACTING_CHAIN_MALFORMED', async () => {
    const res = await post({ [CONTRACTING_CHAIN_HEADER]: 'a'.repeat(8192) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe(CONTRACTING_CHAIN_MALFORMED);
  });

  it('T-CHAIN-2: 400 elementos válidos → rechazo por CONTEO', async () => {
    // Con techo 2 el máximo de eslabones es 3. Estos 400 elementos son cada uno un
    // hostname válido, así que el paso de FORMA los aceptaría: el que corta es el
    // conteo (y con techo 2 el largo corta primero, por eso se sube el techo).
    process.env.A2A_CONTRACTING_DEPTH_MAX = '64';
    const res = await post({
      [CONTRACTING_CHAIN_HEADER]: Array.from(
        { length: 400 },
        () => 'a.com',
      ).join(','),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe(CONTRACTING_CHAIN_MALFORMED);
    expect(res.json().reason).toContain('400');
  });

  it('T-CHAIN-3: un eslabón basura al lado de los válidos → rechazo, NO se ignora', async () => {
    const res = await post({
      [CONTRACTING_CHAIN_HEADER]: 'otro-gw.example,https://basura',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe(CONTRACTING_CHAIN_MALFORMED);
  });

  it('T-CHAIN-4: un header REPETIDO llega JOINEADO con ", " y se parsea como cadena de 2', async () => {
    // ⚠️ ESTE `it` empezó afirmando lo contrario ("un header repetido llega como
    // `string[]` y eso es ausencia") y la MEDICIÓN lo desmintió. Con un socket
    // crudo, dos veces el mismo header:
    //
    //   x-a2a-contracting-chain: a.example
    //   x-a2a-contracting-chain: b.example
    //   ⇒ req.headers['x-a2a-contracting-chain'] === 'a.example, b.example'  (STRING)
    //
    // Node JOINEA los duplicados con `', '` para casi todos los headers; el
    // `string[]` es de `set-cookie` y un puñado más. O sea que en este header la
    // rama `string[]` del patrón `pick` es DEFENSIVA y no el caso real (se cubre en
    // la unidad: `contracting-chain.test.ts` → T-U-DEPTH-7).
    //
    // Consecuencia que importa: la forma joineada trae un ESPACIO después de la
    // coma, así que el `trim()` por elemento del paso 3 es lo que hace que un
    // header repetido legítimo se lea bien en vez de rechazarse por forma. Y no
    // debilita nada: un atacante que repita el header para esconder nuestro eslabón
    // consigue `'otro, <SELF>'`, que con trim cae por MEMBRESÍA y sin trim caía por
    // FORMA — rechazado en los dos casos, pero con trim el código es el correcto.
    //
    // `app.inject` reproduce esa misma semántica (junta el array), así que este
    // `it` mide lo que pasa en producción.
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/x',
        headers: { [CONTRACTING_CHAIN_HEADER]: ['a.example', 'b.example'] },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().chain).toEqual(['a.example', 'b.example']);
    } finally {
      await app.close();
    }
  });

  it('T-CHAIN-5: repetir el header para esconder NUESTRO eslabón no funciona', async () => {
    // El vector de la nota de arriba, montado: el atacante manda el header dos
    // veces esperando que el parser pierda el segundo valor.
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/x',
        headers: { [CONTRACTING_CHAIN_HEADER]: ['otro-gw.example', SELF] },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error_code).toBe(CONTRACTING_LOOP_DETECTED);
    } finally {
      await app.close();
    }
  });
});

describe('CAPA 2 — la profundidad y el techo (AC-6, CD-14)', () => {
  it('T-DEPTH-1: depth "2" con techo default 2 → 400 CONTRACTING_DEPTH_EXCEEDED', async () => {
    // El corte es `>=`: EN el techo ya se rechaza. Con `>` pasaría exactamente el
    // nivel del techo, que es un nivel entero de fan-out (×5) sin cota.
    const res = await post({ [CONTRACTING_DEPTH_HEADER]: '2' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe(CONTRACTING_DEPTH_EXCEEDED);
    expect(res.json().depth).toBe(2);
    expect(res.json().depthMax).toBe(2);
  });

  it('T-DEPTH-1b: depth "1" con techo default 2 → PASA (gemelo positivo del techo)', async () => {
    const res = await post({ [CONTRACTING_DEPTH_HEADER]: '1' });
    expect(res.statusCode).toBe(200);
  });

  it('T-DEPTH-2 (CD-14): depth "1e9" → DEPTH_MALFORMED, NO pasa como 1', async () => {
    // `parseInt('1e9',10) === 1` (medido). Con parseInt esto pasaría como el primer
    // salto, o sea un guard que aplaude.
    const res = await post({ [CONTRACTING_DEPTH_HEADER]: '1e9' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe(CONTRACTING_DEPTH_MALFORMED);
  });

  it('T-DEPTH-3 (CD-14): depth "" → DEPTH_MALFORMED, NO pasa como 0', async () => {
    // `Number('') === 0` (medido). Degradarlo a 0 sería un RESETEO del contador a
    // pedido de un tercero, que es el ataque y no un accidente.
    const res = await post({ [CONTRACTING_DEPTH_HEADER]: '' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe(CONTRACTING_DEPTH_MALFORMED);
  });

  it('T-DEPTH-4 (CD-14): " 2", "2abc", "0x10" y "1000" → los CUATRO rechazados', async () => {
    const cases = [' 2', '2abc', '0x10', '1000'];
    expect(cases).toHaveLength(4);
    for (const raw of cases) {
      const res = await post({ [CONTRACTING_DEPTH_HEADER]: raw });
      expect(res.statusCode, `depth=${JSON.stringify(raw)}`).toBe(400);
      expect(res.json().error_code, `depth=${JSON.stringify(raw)}`).toBe(
        CONTRACTING_DEPTH_MALFORMED,
      );
    }
  });

  it('T-DEPTH-5: techo ILEGIBLE → cae al default del CÓDIGO, no a "sin techo"', async () => {
    process.env.A2A_CONTRACTING_DEPTH_MAX = 'abc';
    const res = await post({ [CONTRACTING_DEPTH_HEADER]: '2' });
    // Con `?? Infinity` esto sería un 200 y el techo no existiría.
    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe(CONTRACTING_DEPTH_EXCEEDED);
    expect(res.json().depthMax).toBe(2);
  });

  it('T-DEPTH-6: techo AUSENTE → default del código (2), no "sin techo"', async () => {
    delete process.env.A2A_CONTRACTING_DEPTH_MAX;
    const res = await post({ [CONTRACTING_DEPTH_HEADER]: '2' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe(CONTRACTING_DEPTH_EXCEEDED);
  });

  it('T-DEPTH-7: un techo configurado MÁS ALTO se respeta', async () => {
    process.env.A2A_CONTRACTING_DEPTH_MAX = '3';
    const res = await post({ [CONTRACTING_DEPTH_HEADER]: '2' });
    expect(res.statusCode).toBe(200);
  });
});

describe('CAPA 2 — la PRECEDENCIA entre pasos es normativa (CD-16)', () => {
  it('T-ORDER-1: el LARGO gana sobre la MEMBRESÍA', async () => {
    // La cadena CONTIENE nuestro host y además excede el largo. Tiene que salir
    // CHAIN_MALFORMED: si saliera LOOP, el chequeo de largo corre DESPUÉS del split
    // y ya materializamos el arreglo que el tercero pidió.
    const res = await post({
      [CONTRACTING_CHAIN_HEADER]: `${SELF},${'a'.repeat(8192)}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe(CONTRACTING_CHAIN_MALFORMED);
  });

  it('T-ORDER-2: la FORMA de la cadena gana sobre la profundidad ilegible', async () => {
    const res = await post({
      [CONTRACTING_CHAIN_HEADER]: 'https://basura',
      [CONTRACTING_DEPTH_HEADER]: '1e9',
    });
    expect(res.json().error_code).toBe(CONTRACTING_CHAIN_MALFORMED);
  });

  it('T-ORDER-3: la MEMBRESÍA gana sobre el TECHO', async () => {
    // Los dos aplican. El que hay que reportar es el bucle, que es el hallazgo
    // accionable; el techo sólo dice "muy profundo".
    const res = await post({
      [CONTRACTING_CHAIN_HEADER]: SELF,
      [CONTRACTING_DEPTH_HEADER]: '2',
    });
    expect(res.json().error_code).toBe(CONTRACTING_LOOP_DETECTED);
  });
});

describe('CAPA 2 — el guard no filtra el header del tercero al log', () => {
  it('T-LOG-1: un header de 8 KB no se copia al log (sale el TAMAÑO)', async () => {
    // Un tercero controla ese valor y el warn se emite POR PETICIÓN: copiarlo
    // verbatim es amplificación de volumen de logs con un solo `curl`.
    const app = Fastify();
    const logged: unknown[] = [];
    app.addHook('onRequest', async (request) => {
      request.log.warn = ((obj: unknown) => {
        logged.push(obj);
      }) as typeof request.log.warn;
    });
    app.post('/x', { preHandler: [contractingGuardHandler] }, async (_q, r) =>
      r.send({ ok: true }),
    );
    await app.ready();
    try {
      const blob = 'a'.repeat(8192);
      await app.inject({
        method: 'POST',
        url: '/x',
        headers: { [CONTRACTING_CHAIN_HEADER]: blob },
        payload: {},
      });
      expect(logged.length).toBeGreaterThan(0);
      const serialized = JSON.stringify(logged);
      expect(serialized).not.toContain(blob);
      // pero SÍ el dato que un operador necesita para diagnosticar
      expect(serialized).toContain('8192');
    } finally {
      await app.close();
    }
  });
});
