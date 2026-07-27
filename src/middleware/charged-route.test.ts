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
 *     impide que se cuele acá una validación de EJECUCIÓN disfrazada de forma.
 *
 * Naming: T-CR-01..T-CR-09.
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
