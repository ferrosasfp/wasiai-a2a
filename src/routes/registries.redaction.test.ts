/**
 * Registries Routes — Credential Redaction Tests (HIGH-1, 2026-07-26).
 *
 * `GET /registries` es público (sin auth) y devolvía `registryService.list()`
 * verbatim, con `auth.value` — credencial outbound viva — en claro en el body.
 *
 * A diferencia de `services/registry.redaction.test.ts`, acá el service es EL
 * REAL (solo se moquea `lib/supabase.js`), así que se ejercita el camino
 * completo route → service → fila de Postgres con el secreto.
 *
 * T-RRED-05 es el guard genérico: recorre TODOS los GET que el plugin registra
 * (vía el hook `onRoute`, no una lista hardcodeada) y falla si cualquiera
 * devuelve material del secreto. Un read-path nuevo que use `getWithSecrets`
 * o `getEnabled` sin pasar por `toRegistryPublic()` rompe este test sin que
 * nadie tenga que acordarse de agregarlo a la suite.
 *
 * Naming: T-RRED-01..T-RRED-06.
 *
 * ⚠️ El valor usado acá es INVENTADO. Nunca pegar una credencial real.
 */
import { createHash } from 'node:crypto';
import Fastify, { type RouteOptions } from 'fastify';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// ── Mocks (BEFORE importing the route module) ──────────────

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

// SSRF validator: acá se prueba redacción, no validación de URLs.
vi.mock('../lib/url-validator.js', async (orig) => {
  const actual = await orig<typeof import('../lib/url-validator.js')>();
  return {
    ...actual,
    validateRegistryUrl: vi.fn().mockResolvedValue(undefined),
  };
});

const OWNER = 'tenant-A';

// AB-WKH-55: inyectar `a2aKeyRow` para que POST/PATCH pasen el guard de auth
// sin levantar el pipeline x402 completo.
vi.mock('../middleware/a2a-key.js', () => ({
  requirePaymentOrA2AKey: () => [
    async (request: { a2aKeyRow?: { id: string; owner_ref: string } }) => {
      request.a2aKeyRow = { id: 'fake-key-id', owner_ref: OWNER };
    },
  ],
  // HU-193: ver el mismo mock en registries.ssrf.test.ts.
  extractRawKeyFromHeaders: () => 'wasi_a2a_fake',
}));

import { supabase } from '../lib/supabase.js';
import registriesRoutes from './registries.js';

const mockFrom = vi.mocked(supabase.from);

// ── Fixtures ────────────────────────────────────────────────

/** Credencial FALSA. Imita la forma de un token del gateway, no es una real. */
const FAKE_SECRET = 'wasi_a2a_THIS_IS_A_FAKE_TEST_TOKEN_0123456789abcdef';

function secretRow(over: Record<string, unknown> = {}) {
  return {
    id: 'reg-1',
    name: 'reg-1',
    discovery_endpoint: 'https://example.com/discover',
    invoke_endpoint: 'https://example.com/invoke',
    agent_endpoint: null,
    schema: { discovery: {}, invoke: { method: 'POST' as const } },
    auth: { type: 'bearer', key: 'Authorization', value: FAKE_SECRET },
    enabled: true,
    created_at: '2026-07-26T00:00:00Z',
    owner_ref: OWNER,
    ...over,
  };
}

/** `maybeSingle` configurable por test (register necesita null, el resto la fila). */
let maybeSingleData: unknown = secretRow();

function chain(): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  const self = () => c;
  c.select = vi.fn(self);
  c.insert = vi.fn(self);
  c.update = vi.fn(self);
  c.delete = vi.fn(self);
  c.eq = vi.fn(self);
  c.order = vi.fn(() => Promise.resolve({ data: [secretRow()], error: null }));
  c.maybeSingle = vi.fn(() =>
    Promise.resolve({ data: maybeSingleData, error: null }),
  );
  c.single = vi.fn(() => Promise.resolve({ data: secretRow(), error: null }));
  return c;
}

/** Todos los escalares del body parseado, con su path, para asertar por campo. */
function* scalarEntries(
  value: unknown,
  path = '$',
): Generator<[string, unknown]> {
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      yield* scalarEntries(item, `${path}[${i}]`);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      yield* scalarEntries(item, `${path}.${key}`);
    }
    return;
  }
  yield [path, value];
}

/**
 * MNR-3 (AR HIGH-2): el largo se compara CAMPO POR CAMPO.
 *
 * `expect(body).not.toContain(String(FAKE_SECRET.length))` rompía con cualquier
 * campo futuro que contuviera "51" (un precio, un timestamp, un id) y encima con
 * el mensaje engañoso "leaks the credential length". Lo prohibido de verdad es un
 * CAMPO cuyo valor sea el largo, o un valor enmascarado del MISMO largo que el
 * secreto (que filtra el largo igual).
 */
function expectNoSecretLength(body: string, where: string): void {
  const len = FAKE_SECRET.length;
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    // Un body no-JSON (p.ej. vacío) se juzga como un único valor string.
    payload = body;
  }
  for (const [path, value] of scalarEntries(payload)) {
    if (typeof value === 'number') {
      expect(value, `${where} ${path}: is the credential length`).not.toBe(len);
    }
    if (typeof value === 'string') {
      expect(value, `${where} ${path}: is the credential length`).not.toBe(
        String(len),
      );
      expect(
        value.length,
        `${where} ${path}: has exactly the credential length (mask?)`,
      ).not.toBe(len);
    }
  }
}

/** El body no contiene el secreto NI prefijo / sufijo / hash / largo. */
function expectNoSecretMaterial(body: string, where: string): void {
  expect(body, `${where}: leaks the credential`).not.toContain(FAKE_SECRET);
  expect(body, `${where}: leaks a credential prefix`).not.toContain(
    FAKE_SECRET.slice(0, 12),
  );
  expect(body, `${where}: leaks a credential suffix`).not.toContain(
    FAKE_SECRET.slice(-12),
  );
  expect(body, `${where}: leaks a credential hash`).not.toContain(
    createHash('sha256').update(FAKE_SECRET).digest('hex'),
  );
  expectNoSecretLength(body, where);
}

// ── Suite ───────────────────────────────────────────────────

describe('registries routes — credential redaction (HIGH-1)', () => {
  let app: ReturnType<typeof Fastify>;
  /** Rutas realmente registradas por el plugin (no una lista hardcodeada). */
  const registered: { method: string; url: string }[] = [];

  beforeAll(async () => {
    app = Fastify();
    app.addHook('onRoute', (route: RouteOptions) => {
      const methods = Array.isArray(route.method)
        ? route.method
        : [route.method];
      for (const method of methods) registered.push({ method, url: route.url });
    });
    await app.register(registriesRoutes, { prefix: '/registries' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    maybeSingleData = secretRow();
    mockFrom.mockImplementation(() => chain() as never);
  });

  it('T-RRED-01: GET /registries (público) no devuelve la credencial', async () => {
    const res = await app.inject({ method: 'GET', url: '/registries' });

    expect(res.statusCode).toBe(200);
    expectNoSecretMaterial(res.body, 'GET /registries');
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.registries[0]).not.toHaveProperty('auth');
    // Reemplazo útil, no material de ataque.
    expect(body.registries[0].authType).toBe('bearer');
    expect(body.registries[0].authConfigured).toBe(true);
    // MNR-5: `GET /registries` es PÚBLICO (sin auth) → tampoco puede enumerar
    // qué tenant registró qué marketplace (`types/index.ts` WKH-141/CD-6).
    expect(body.registries[0]).not.toHaveProperty('ownerRef');
    expect(res.body, 'GET /registries leaks the owner_ref').not.toContain(
      OWNER,
    );
  });

  it('T-RRED-02: GET /registries/:id no devuelve la credencial', async () => {
    const res = await app.inject({ method: 'GET', url: '/registries/reg-1' });

    expect(res.statusCode).toBe(200);
    expectNoSecretMaterial(res.body, 'GET /registries/:id');
    expect(res.json()).not.toHaveProperty('auth');
    expect(res.json().authConfigured).toBe(true);
  });

  it('T-RRED-03: POST /registries (201 echo-back) no devuelve la credencial', async () => {
    maybeSingleData = null; // pre-check de colisión de PK: no existe

    const res = await app.inject({
      method: 'POST',
      url: '/registries',
      payload: {
        name: 'reg-1',
        discoveryEndpoint: 'https://example.com/discover',
        invokeEndpoint: 'https://example.com/invoke',
        schema: { discovery: {}, invoke: { method: 'POST' } },
        auth: { type: 'bearer', key: 'Authorization', value: FAKE_SECRET },
      },
    });

    expect(res.statusCode).toBe(201);
    expectNoSecretMaterial(res.body, 'POST /registries');
    expect(res.json()).not.toHaveProperty('auth');
  });

  it('T-RRED-04: PATCH /registries/:id no re-emite la credencial no tocada', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/registries/reg-1',
      payload: { name: 'renamed' },
    });

    expect(res.statusCode).toBe(200);
    expectNoSecretMaterial(res.body, 'PATCH /registries/:id');
    expect(res.json()).not.toHaveProperty('auth');
  });

  it('T-RRED-05: guard genérico — NINGÚN GET del plugin devuelve el secreto', async () => {
    const gets = registered.filter((r) => r.method === 'GET');

    // Sanity: si el hook dejó de capturar rutas, el barrido sería vacuo y
    // pasaría siempre. Hoy son GET / y GET /:id.
    expect(gets.length).toBeGreaterThanOrEqual(2);

    for (const route of gets) {
      // Sustituir cualquier param por un id que el mock resuelve.
      const url = route.url.replace(/:[^/]+/g, 'reg-1');
      const res = await app.inject({ method: 'GET', url });

      // El barrido no juzga el status (una ruta futura puede 404-ear); juzga
      // que el body nunca contenga material del secreto.
      expectNoSecretMaterial(res.body, `GET ${route.url}`);
    }
  });

  it('T-RRED-06: el mock de supabase SÍ trae el secreto (el test no es vacuo)', () => {
    // Contra-prueba: si el fixture dejara de traer la credencial, todos los
    // asserts de arriba pasarían por vacuidad.
    expect(JSON.stringify(secretRow())).toContain(FAKE_SECRET);
  });
});
