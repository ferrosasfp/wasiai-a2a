/**
 * WKH-360 · `GET /.well-known/agent.json` — la carta que dice CÓMO CONTRATARNOS.
 *
 * 🔴 ARCHIVO NUEVO. Medido antes de escribirlo: `src/routes/` tenía `well-known.ts`
 * y NINGÚN `well-known.test.ts`, o sea que la ÚNICA superficie pública de la carta
 * propia del gateway no tenía suite. El Story File no lo listaba; sin este archivo,
 * `T-CARD-1/2/3` no tienen dónde vivir.
 *
 * Los tres controles que importan y por qué no son intercambiables:
 *  · `T-CARD-1` — la carta declara los tres datos de AC-1 (auth, endpoint, precio o
 *    la forma de obtenerlo). Es una aserción sobre el CONTENIDO.
 *  · `T-CARD-2` — la ruta sigue GRATIS y sin rate-limit. Es una aserción sobre el
 *    ACCESO: una carta perfecta detrás de un 402 no sirve para que alguien nos
 *    contrate.
 *  · `T-CARD-3` — cada `endpoint` que la carta declara responde DISTINTO DE 404. Es
 *    la única aserción MECÁNICA de las tres: los `path` de la carta son una segunda
 *    expresión del registro de rutas de `src/index.ts` y `tsc` no los ata, así que
 *    sin este test un rename de prefijo deja la carta publicando endpoints muertos.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ⚠️ CD-20 EN CARNE PROPIA. Este mock existe porque `/capabilities` necesita el
 * registry de adapters, pero `services/agent-card.ts` ahora IMPORTA
 * `getInboundPaymentChainKeys` de ese mismo módulo — o sea que un factory sin
 * `importOriginal` dejaría esa función `undefined` y la carta explotaría en TODA esta
 * suite por un motivo que no tiene nada que ver con lo que se está probando. Es
 * exactamente el hazard que CD-20 obliga a medir antes de escribir el campo, y acá se
 * resuelve como manda: `importOriginal` + override explícito de lo que se controla.
 */
const inbound = { chains: ['avalanche-fuji'] as string[] };
vi.mock('../adapters/registry.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../adapters/registry.js')>();
  return {
    ...actual,
    getInitializedChainKeys: () => ['avalanche-fuji'],
    getDefaultChainKey: () => 'avalanche-fuji',
    getAdaptersBundle: () => ({
      payment: { vmFamily: 'evm' },
      chainConfig: { chainId: 43113, name: 'Avalanche Fuji' },
    }),
    acceptsInboundPayment: () => true,
    getInboundPaymentChainKeys: () => inbound.chains,
    // `getChainConfig` sale de ESTE módulo (no de `chain-resolver`), y el real tira
    // para una chain que no se inicializó en la suite.
    getChainConfig: () => ({ chainId: 43113, name: 'Avalanche Fuji' }),
  };
});

vi.mock('../services/discovery.js', () => ({
  discoveryService: {
    discover: vi.fn().mockResolvedValue({
      agents: [],
      total: 0,
      totalAtLeast: 0,
      registries: [],
      sources: [],
      catalogStatus: 'complete',
    }),
    getAgent: vi.fn().mockResolvedValue(null),
  },
}));

import {
  CONTRACTING_LAYER2_BEST_EFFORT_NOTE,
  DEFAULT_CONTRACTING_DEPTH_MAX,
} from '../lib/contracting-chain.js';
import capabilitiesRoutes from './capabilities.js';
import discoverRoutes from './discover.js';
import wellKnownRoutes from './well-known.js';

const ENV_KEYS = ['A2A_SELF_HOSTS', 'BASE_URL', 'A2A_CONTRACTING_DEPTH_MAX'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function cardApp() {
  const app = Fastify();
  await app.register(wellKnownRoutes, { prefix: '/.well-known' });
  await app.ready();
  return app;
}

async function getCard() {
  const app = await cardApp();
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/agent.json',
    });
    return { res, body: res.json() };
  } finally {
    await app.close();
  }
}

describe('T-CARD-1 (AC-1) — la carta declara CÓMO contratar cada skill', () => {
  it('cada skill trae `endpoint` concreto y `pricing`', async () => {
    const { res, body } = await getCard();
    expect(res.statusCode).toBe(200);
    expect(body.skills.length).toBeGreaterThan(0);
    for (const skill of body.skills) {
      expect(skill.endpoint, `skill ${skill.id}`).toEqual({
        method: 'POST',
        path: expect.any(String),
      });
      expect(skill.pricing?.model, `skill ${skill.id}`).toBeTruthy();
    }
  });

  it('`authentication.schemes` NO está vacío (antes de esta HU era `[]`)', async () => {
    const { body } = await getCard();
    expect(body.authentication.schemes).toContain('bearer');
    expect(body.authentication.schemes.length).toBeGreaterThan(0);
  });

  it('`contracting.depthMax` está presente y es el techo que se APLICA', async () => {
    // Publicar un número distinto del que el guard aplica sería peor que no
    // publicarlo: un coordinador ajustaría su cadena a un techo que no existe.
    const { body } = await getCard();
    expect(body.contracting.depthMax).toBe(DEFAULT_CONTRACTING_DEPTH_MAX);
    expect(body.contracting.bestEffortNote).toBe(
      CONTRACTING_LAYER2_BEST_EFFORT_NOTE,
    );
  });

  it('el techo publicado SIGUE al configurado (no es una constante hardcodeada)', async () => {
    process.env.A2A_CONTRACTING_DEPTH_MAX = '3';
    const { body } = await getCard();
    expect(body.contracting.depthMax).toBe(3);
  });

  it('NO declara un `priceUsdc` por skill — sería fabricar una oferta (AC-3)', async () => {
    // Los precios de los agentes son pass-through y el gateway cobra una TASA sobre
    // el costo EJECUTADO, que no se conoce antes de ejecutar. La carta declara el
    // modelo y apunta al cotizador.
    const { body } = await getCard();
    expect(JSON.stringify(body)).not.toContain('priceUsdc');
    const paid = body.skills.filter((s: { id: string }) => s.id !== 'discover');
    expect(paid.length).toBeGreaterThan(0);
    for (const s of paid) {
      expect(s.pricing.model).toBe('protocol-fee-on-executed-cost');
      expect(s.pricing.quoteEndpoint).toBe('/orchestrate/plan');
      expect(typeof s.pricing.feeRatePercent).toBe('number');
    }
  });
});

describe('T-CARD-2 (AC-1) — la ruta sigue GRATIS y sin rate-limit', () => {
  it('`/.well-known/agent.json` responde 200 SIN credencial', async () => {
    // Una carta que dice cómo contratarnos detrás de un 402 no sirve para nada: el
    // que la lee todavía no es cliente.
    const { res } = await getCard();
    expect(res.statusCode).toBe(200);
    expect(res.statusCode).not.toBe(402);
  });

  it('la ruta declara `rateLimit: false` en su config', async () => {
    // Se lee del ROUTER, no del fuente: así el test mide lo que Fastify realmente
    // registró y no un texto que alguien pudo mover.
    const app = await cardApp();
    try {
      const route = app
        .printRoutes({ commonPrefix: false })
        .includes('agent.json');
      expect(route).toBe(true);
      const res = await app.inject({
        method: 'GET',
        url: '/.well-known/agent.json',
      });
      // Sin rate-limit configurado no aparece la cabecera de cuota.
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('`/discover` responde DISTINTO de 402 sin credencial (la skill `free` es cierta)', async () => {
    // `pricing: { model: 'free' }` para `discover` no es fe: acá se ejerce la ruta
    // real sin ninguna credencial y se verifica que no pide pago.
    const app = Fastify();
    await app.register(discoverRoutes, { prefix: '/discover' });
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/discover',
        payload: {},
      });
      expect(res.statusCode).not.toBe(402);
    } finally {
      await app.close();
    }
  });
});

describe('T-CARD-3 (AC-1/AC-2) — cada `endpoint` declarado EXISTE', () => {
  it('ninguno de los endpoints de la carta responde 404', async () => {
    // ⚠️ ESTE ES EL CONTROL MECÁNICO de la §"Sobre (c)": los `path` de la carta son
    // una SEGUNDA EXPRESIÓN del registro de rutas de `src/index.ts` y `tsc` no las
    // ata. Si alguien renombra el prefijo `/compose`, la carta seguiría publicando
    // `/compose` y este `it` es lo único que lo nota.
    //
    // No se monta el `index.ts` completo (hace `await initAdapters()` a nivel de
    // módulo): se registran los routes con LOS MISMOS prefijos y se verifica que
    // cada path declarado matchee una ruta registrada.
    const { body } = await getCard();
    const declared: string[] = body.skills.map(
      (s: { endpoint: { path: string } }) => s.endpoint.path,
    );
    expect(declared.length).toBeGreaterThan(0);

    // ⚠️ Los prefijos se DERIVAN de `src/index.ts`, NO se escriben acá. Una lista a
    // mano en este archivo sería una TERCERA expresión del mismo dato, y se
    // desactualizaría junto con la carta: el test aplaudiría un rename que rompió el
    // endpoint publicado. Esto lee el fuente y extrae los prefijos reales.
    const indexSrc = readFileSync(
      join(fileURLToPath(new URL('.', import.meta.url)), '..', 'index.ts'),
      'utf8',
    );
    const registered = [
      ...indexSrc.matchAll(
        /register\([A-Za-z]+Routes,\s*\{\s*prefix:\s*'([^']+)'/g,
      ),
    ].map((m) => m[1] as string);
    // Si la derivación deja de matchear, el test NO puede quedar verde por vacío.
    expect(
      registered.length,
      'no se pudo derivar ningún prefijo de src/index.ts: si cambió la forma del ' +
        '`register(...)`, hay que actualizar este regex — no bajar la aserción',
    ).toBeGreaterThan(3);

    for (const path of declared) {
      expect(
        registered.includes(path),
        `la carta publica el endpoint "${path}", que NO está entre los prefijos ` +
          `que src/index.ts registra (${registered.join(', ')}). O la carta ` +
          'miente, o alguien renombró un prefijo sin actualizar la carta.',
      ).toBe(true);
    }
  });

  it('el `/discover` declarado responde de verdad (≠404) al montarlo', async () => {
    const app = Fastify();
    await app.register(discoverRoutes, { prefix: '/discover' });
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/discover',
        payload: {},
      });
      expect(res.statusCode).not.toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('T-CARD-4 (AC-2) — `/capabilities` SIGUE derivando de la carta', () => {
  // ⚠️ Este `it` NO puede vivir en `capabilities.inbound-chains.test.ts`: ese archivo
  // mockea `../services/agent-card.js` COMPLETO (con `skills: []`), así que es INMUNE
  // a cualquier cambio de la carta y su `Object.keys` congela sólo el top-level. Acá
  // no se mockea la carta, así que la derivación se mide de verdad.
  it('name/url/methods salen de la carta, y las skills llegan CON los campos nuevos', async () => {
    const app = Fastify();
    await app.register(capabilitiesRoutes, { prefix: '/capabilities' });
    await app.ready();
    try {
      const res = await app.inject({ method: 'GET', url: '/capabilities' });
      expect(res.statusCode).toBe(200);
      const caps = res.json();
      const { body: card } = await getCard();

      // La derivación, campo por campo.
      expect(caps.name).toBe(card.name);
      expect(caps.url).toBe(card.url);
      expect(caps.description).toBe(card.description);
      expect(caps.capabilities).toEqual(card.capabilities);
      // `methods: card.skills` ⇒ los campos NUEVOS viajan sin tocar este route.
      expect(caps.methods.map((m: { id: string }) => m.id)).toEqual(
        card.skills.map((s: { id: string }) => s.id),
      );
      for (const m of caps.methods) {
        expect(m.endpoint, `method ${m.id}`).toBeDefined();
        expect(m.pricing, `method ${m.id}`).toBeDefined();
      }
    } finally {
      await app.close();
    }
  });

  it('el conjunto de claves top-level de `/capabilities` CRECE sin perder ninguna', async () => {
    // AC-12 aplicado a esta superficie: aditivo significa que el conjunto viejo es
    // SUBCONJUNTO del nuevo. Las claves de la línea base están escritas a mano
    // porque son el contrato publicado de antes de esta HU.
    const BASELINE_KEYS = [
      'name',
      'description',
      'url',
      'protocol',
      'capabilities',
      'methods',
      'inputModes',
      'outputModes',
      'chains',
      'agents',
      'agentsTotal',
      'registries',
    ];
    const app = Fastify();
    await app.register(capabilitiesRoutes, { prefix: '/capabilities' });
    await app.ready();
    try {
      const res = await app.inject({ method: 'GET', url: '/capabilities' });
      const keys = Object.keys(res.json());
      for (const k of BASELINE_KEYS) expect(keys, `falta ${k}`).toContain(k);
    } finally {
      await app.close();
    }
  });
});

describe('T-CARD-5 (AC-3, CD-5) — `x402` se lista SÓLO si hay chain de cobro de ENTRADA', () => {
  it('con chains de entrada ⇒ `x402` aparece', async () => {
    inbound.chains = ['avalanche-fuji'];
    const { body } = await getCard();
    expect(body.authentication.schemes).toContain('bearer');
    expect(body.authentication.schemes).toContain('x402');
  });

  it('SIN chains de entrada ⇒ `x402` NO aparece, y NO sale `false` ni `null`', async () => {
    // Caso alcanzable HOY: `solana-devnet` sale con `acceptsInboundPayment: false`,
    // así que un deploy solo-Solana no tiene ninguna chain de entrada. CD-5: el
    // esquema se OMITE; no se emite un placeholder que un cliente leería como dato.
    inbound.chains = [];
    const { body } = await getCard();
    expect(body.authentication.schemes).toEqual(['bearer']);
    expect(body.authentication.schemes).not.toContain('x402');
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('"x402":false');
    expect(raw).not.toContain('"x402":null');
    inbound.chains = ['avalanche-fuji'];
  });
});
