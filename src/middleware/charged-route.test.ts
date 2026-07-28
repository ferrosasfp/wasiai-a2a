/**
 * `chargedRoute` — HU-193: el componente que hace IMPOSIBLE cablear una ruta que
 * cobra sin declarar su validación de forma.
 *
 * Lo que se prueba acá es la PROPIEDAD ESTRUCTURAL, no un endpoint concreto:
 *   • la validación corre ANTES del middleware de pago (si rechaza, el cobro no
 *     se ejecuta nunca);
 *   • el orden de los checks es el declarado (gana el primero que rechaza);
 *   • un opt-out tiene que estar FIRMADO (`{ skip: '<motivo>' }`) y queda visible
 *     en la marca del handler;
 *   • un `PreChargeCheck` NO puede ver estado de auth ni de cobro: recibe
 *     `PreChargeInput` (body/params/query/headers) y nada más. Eso es lo que
 *     impide que se cuele acá una validación de EJECUCIÓN disfrazada de forma;
 *   • un `PreChargeCheck` NO puede MUTAR lo que recibe (fix-pack, MENOR-2 del
 *     AR): `readonly` protege el binding, no el objeto, así que sin la vista
 *     inmutable un check podía reescribir el body que el handler valida y manda
 *     al service.
 *
 * Naming: T-CR-01..T-CR-12.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { markChargesCaller } from './charge-brand.js';

// El middleware de pago se reemplaza por un handler-espía MARCADO como cobrador:
// esta suite mide el ORDEN y la OBLIGATORIEDAD, no el cobro real (eso lo miden
// `routes/registries.no-charge-before-validating.test.ts` y su par de `/tasks`,
// con el middleware real y el balance/`settle` de verdad).
const paymentSpy = vi.hoisted(() => vi.fn());
vi.mock('./a2a-key.js', async (orig) => {
  const actual = await orig<typeof import('./a2a-key.js')>();
  return {
    ...actual,
    requirePaymentOrA2AKey: () => [
      markChargesCaller(async (_req: FastifyRequest, _rep: FastifyReply) => {
        paymentSpy();
      }),
    ],
  };
});

import { chargesCaller, preChargeValidationDetail } from './charge-brand.js';
import {
  chargedRoute,
  type PreChargeCheck,
  type PreChargeInput,
  requireA2AKeyPresence,
} from './charged-route.js';

const PAYMENT = { description: 'test' };

function buildApp(preHandler: ReturnType<typeof chargedRoute>) {
  const app = Fastify();
  app.post(
    '/t/:id',
    { preHandler },
    async (_request: FastifyRequest, reply: FastifyReply) =>
      reply.send({ ran: true }),
  );
  return app;
}

describe('chargedRoute (HU-193)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('T-CR-01: un check que rechaza corta ANTES del cobro (el middleware de pago no corre)', async () => {
    const app = buildApp(
      chargedRoute({
        validate: [() => ({ status: 400, body: { error: 'nope' } })],
        payment: PAYMENT,
      }),
    );
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/t/1',
        payload: {},
      });
      expect(paymentSpy).not.toHaveBeenCalled(); // LA aserción de la HU
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'nope' });
    } finally {
      await app.close();
    }
  });

  it('T-CR-02: gana el PRIMER check que rechaza (orden declarado)', async () => {
    const second = vi.fn(() => ({ status: 422, body: { error: 'second' } }));
    const app = buildApp(
      chargedRoute({
        validate: [() => ({ status: 403, body: { error: 'first' } }), second],
        payment: PAYMENT,
      }),
    );
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/t/1',
        payload: {},
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'first' });
      expect(second).not.toHaveBeenCalled();
      expect(paymentSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('T-CR-03: si todos los checks pasan, el cobro y el handler corren', async () => {
    const app = buildApp(
      chargedRoute({ validate: [() => null], payment: PAYMENT }),
    );
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/t/1',
        payload: {},
      });
      expect(paymentSpy).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ran: true });
    } finally {
      await app.close();
    }
  });

  it('T-CR-04: el opt-out `{ skip }` queda FIRMADO en la marca del handler', async () => {
    const chain = chargedRoute({
      validate: { skip: 'no hay nada validable sin I/O' },
      payment: PAYMENT,
    });
    // La justificación viaja en la marca, así que el guard estructural
    // (`routes/charged-routes.meta.test.ts`) puede imprimirla y el opt-out no
    // puede ser silencioso.
    expect(preChargeValidationDetail(chain[0])).toBe(
      'skip: no hay nada validable sin I/O',
    );
  });

  it('T-CR-05: la cadena es [validación, cobro] y ambas quedan marcadas', async () => {
    const chain = chargedRoute({ validate: [() => null], payment: PAYMENT });
    expect(chain).toHaveLength(2);
    expect(preChargeValidationDetail(chain[0])).toBe('1 check(s)');
    expect(chargesCaller(chain[0])).toBe(false);
    expect(chargesCaller(chain[1])).toBe(true);
    expect(preChargeValidationDetail(chain[1])).toBeNull();
  });

  it('T-CR-06: el check sólo recibe body/params/query/headers (no estado de auth)', async () => {
    let seen: PreChargeInput | undefined;
    const spyCheck: PreChargeCheck = (input) => {
      seen = input;
      return null;
    };
    const app = buildApp(
      chargedRoute({ validate: [spyCheck], payment: PAYMENT }),
    );
    await app.ready();
    try {
      await app.inject({
        method: 'POST',
        url: '/t/42?q=1',
        headers: { 'x-a2a-key': 'wasi_a2a_x' },
        payload: { hello: 'world' },
      });
      expect(Object.keys(seen ?? {}).sort()).toEqual([
        'body',
        'headers',
        'params',
        'query',
      ]);
      expect(seen?.body).toEqual({ hello: 'world' });
      expect(seen?.params).toEqual({ id: '42' });
      expect(seen?.query).toEqual({ q: '1' });
      // Nada de `a2aKeyRow` / `resolvedChainId` / `log`: un check no puede
      // depender de lo que produce el middleware de auth/pago.
      expect(
        (seen as unknown as Record<string, unknown>).a2aKeyRow,
      ).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  // ── El input es INMUTABLE (fix-pack MENOR-2) ─────────────────
  // El AR probó que un check podía hacer
  // `(input.body as Record<string, unknown>).injected = 'MUTATED'` y el HANDLER
  // veía el cuerpo mutado. Un check "puro" que reescribe lo que el handler valida
  // después es un footgun serio: reintroduce input no validado en el service.

  /** Handler que DEVUELVE el body que le llegó (para ver si fue mutado). */
  function buildEchoApp(preHandler: ReturnType<typeof chargedRoute>) {
    const app = Fastify();
    app.post(
      '/t/:id',
      { preHandler },
      async (request: FastifyRequest, reply: FastifyReply) =>
        reply.send({ body: request.body }),
    );
    return app;
  }

  it('T-CR-10: un check que intenta mutar el body lanza y NO se cobra', async () => {
    const app = buildEchoApp(
      chargedRoute({
        validate: [
          (input) => {
            (input.body as Record<string, unknown>).injected = 'MUTATED';
            return null;
          },
        ],
        payment: PAYMENT,
      }),
    );
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/t/1',
        payload: { hello: 'world' },
      });
      // El TypeError muere en el preHandler de VALIDACIÓN, o sea antes del
      // cobro: un check con bug no le cuesta plata al caller.
      expect(paymentSpy).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(500);
    } finally {
      await app.close();
    }
  });

  it('T-CR-11: la mutación no llega al handler ni siquiera si el check la traga', async () => {
    const attempts: string[] = [];
    const app = buildEchoApp(
      chargedRoute({
        validate: [
          (input) => {
            const body = input.body as Record<string, unknown>;
            for (const [name, mutate] of [
              ['set', () => (body.injected = 'MUTATED')],
              [
                'nested-set',
                () =>
                  ((body.nested as Record<string, unknown>).deep = 'MUTATED'),
              ],
              ['delete', () => delete body.hello],
              [
                'defineProperty',
                () => Object.defineProperty(body, 'sneaky', { value: 1 }),
              ],
              [
                'params',
                () => ((input.params as Record<string, unknown>).id = 'x'),
              ],
              [
                'query',
                () => ((input.query as Record<string, unknown>).q = 'x'),
              ],
              [
                'input-field',
                () => ((input as unknown as Record<string, unknown>).body = {}),
              ],
              ['setPrototypeOf', () => Object.setPrototypeOf(body, null)],
            ] as Array<[string, () => unknown]>) {
              try {
                mutate();
                attempts.push(`${name}:PASSED`);
              } catch {
                attempts.push(`${name}:BLOCKED`);
              }
            }
            // Lectura normal: la vista inmutable NO rompe leer valores anidados.
            return (body.nested as Record<string, unknown>).deep === 'original'
              ? null
              : { status: 400, body: { error: 'read-broken' } };
          },
        ],
        payment: PAYMENT,
      }),
    );
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/t/1?q=1',
        payload: { hello: 'world', nested: { deep: 'original' } },
      });
      expect(attempts).toEqual([
        'set:BLOCKED',
        'nested-set:BLOCKED',
        'delete:BLOCKED',
        'defineProperty:BLOCKED',
        'params:BLOCKED',
        'query:BLOCKED',
        'input-field:BLOCKED',
        'setPrototypeOf:BLOCKED',
      ]);
      // LA aserción: el handler ve el body ORIGINAL, sin `injected` ni `sneaky`.
      expect(res.statusCode).toBe(200);
      expect(res.json().body).toEqual({
        hello: 'world',
        nested: { deep: 'original' },
      });
      expect(paymentSpy).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('T-CR-12: la vista inmutable no cambia lo que el check VE (lecturas intactas)', async () => {
    let seen: Record<string, unknown> | undefined;
    const app = buildEchoApp(
      chargedRoute({
        validate: [
          (input) => {
            const body = input.body as Record<string, unknown>;
            seen = {
              typeofBody: typeof body,
              keys: Object.keys(body),
              isArrayMessages: Array.isArray(body.messages),
              spread: { ...body },
              json: JSON.stringify(body),
              headerKey: input.headers['x-a2a-key'],
            };
            return null;
          },
        ],
        payment: PAYMENT,
      }),
    );
    await app.ready();
    try {
      await app.inject({
        method: 'POST',
        url: '/t/1',
        headers: { 'x-a2a-key': 'wasi_a2a_x' },
        payload: { messages: [{ role: 'user' }], n: 1 },
      });
      expect(seen).toEqual({
        typeofBody: 'object',
        keys: ['messages', 'n'],
        isArrayMessages: true,
        spread: { messages: [{ role: 'user' }], n: 1 },
        json: '{"messages":[{"role":"user"}],"n":1}',
        headerKey: 'wasi_a2a_x',
      });
    } finally {
      await app.close();
    }
  });

  // ── requireA2AKeyPresence ────────────────────────────────────

  const presence = requireA2AKeyPresence('msg-de-prueba');
  const input = (headers: Record<string, string>): PreChargeInput => ({
    body: undefined,
    params: {},
    query: {},
    headers,
  });

  it('T-CR-07: sin credencial → 403 A2A_KEY_REQUIRED con el mensaje de la ruta', () => {
    expect(presence(input({}))).toEqual({
      status: 403,
      body: {
        error: 'a2a-key required',
        error_code: 'A2A_KEY_REQUIRED',
        message: 'msg-de-prueba',
      },
    });
  });

  it('T-CR-08: con `x-a2a-key` o `Authorization: Bearer wasi_a2a_*` → pasa', () => {
    expect(presence(input({ 'x-a2a-key': 'wasi_a2a_k' }))).toBeNull();
    expect(presence(input({ authorization: 'Bearer wasi_a2a_k' }))).toBeNull();
    // Case-insensitive en el esquema (mismo criterio que `extractRawKey`).
    expect(presence(input({ authorization: 'bearer wasi_a2a_k' }))).toBeNull();
  });

  it('T-CR-09: un Bearer que NO es una a2a-key no cuenta como credencial', () => {
    // Mismo criterio que el middleware: si esto pasara, el request caería al
    // riel x402 y volveríamos a cobrar por un rechazo garantizado.
    expect(presence(input({ authorization: 'Bearer github_pat_x' }))).toEqual({
      status: 403,
      body: {
        error: 'a2a-key required',
        error_code: 'A2A_KEY_REQUIRED',
        message: 'msg-de-prueba',
      },
    });
  });
});
