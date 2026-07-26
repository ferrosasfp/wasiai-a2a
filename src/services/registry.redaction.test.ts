/**
 * Registry Service — Credential Redaction Tests (HIGH-1, 2026-07-26).
 *
 * Hallazgo: `GET /registries` devolvía `registryService.list()` verbatim y cada
 * fila incluía `auth.value` — una credencial outbound viva — en claro, en un
 * endpoint de lectura público. Confirmado en vivo contra producción.
 *
 * Contrato que fijan estos tests:
 *   - `list` / `get` / `register` / `update` devuelven `RegistryPublic`: NUNCA
 *     `auth`, NUNCA el valor, NUNCA un prefijo / sufijo / largo / hash de él.
 *   - En su lugar exponen `authType` (esquema declarado) y `authConfigured`
 *     (¿hay credencial guardada?), que no son material de ataque.
 *   - `getWithSecrets` / `getEnabled` SÍ devuelven la credencial: son los
 *     únicos métodos internos, para armar headers de fetch outbound.
 *   - Canario de compilación: `RegistryConfig` NO es asignable a
 *     `RegistryPublic`.
 *
 * Naming: T-RED-01..T-RED-10.
 *
 * ⚠️ El valor usado acá es INVENTADO. Nunca pegar una credencial real (ni
 * truncada) en un fixture.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegistryConfig, RegistryPublic } from '../types/index.js';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

// El service re-valida URLs (defense-in-depth WKH-62); acá no es el objeto de
// prueba, así que se aprueba todo.
vi.mock('../lib/url-validator.js', async (orig) => {
  const actual = await orig<typeof import('../lib/url-validator.js')>();
  return {
    ...actual,
    validateRegistryUrl: vi.fn().mockResolvedValue(undefined),
  };
});

import { supabase } from '../lib/supabase.js';
import { registryService, toRegistryPublic } from './registry.js';

const mockFrom = vi.mocked(supabase.from);

// ── Fixtures ────────────────────────────────────────────────

/** Credencial FALSA. Imita la forma de un token del gateway, no es una real. */
const FAKE_SECRET = 'wasi_a2a_THIS_IS_A_FAKE_TEST_TOKEN_0123456789abcdef';
const OWNER = 'tenant-A';

/** Fila cruda de Postgres (snake_case) con la credencial en claro. */
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

/**
 * Chain mock fiel al QueryBuilder de Supabase. `order` es terminal para
 * `list()`; `maybeSingle` para `get()`; `single` para INSERT/UPDATE.
 */
function chain(res: {
  order?: unknown;
  maybeSingle?: unknown;
  single?: unknown;
}) {
  const c: Record<string, unknown> = {};
  const self = () => c;
  c.select = vi.fn(self);
  c.insert = vi.fn(self);
  c.update = vi.fn(self);
  c.delete = vi.fn(self);
  c.eq = vi.fn(self);
  c.order = vi.fn(() =>
    Promise.resolve(res.order ?? { data: [], error: null }),
  );
  c.maybeSingle = vi.fn(() =>
    Promise.resolve(res.maybeSingle ?? { data: null, error: null }),
  );
  c.single = vi.fn(() =>
    Promise.resolve(res.single ?? { data: null, error: null }),
  );
  return c;
}

/**
 * Aserción central: el payload no contiene el secreto NI ninguna derivación
 * que sirva a un atacante (prefijo, sufijo, hash, largo).
 */
function expectNoSecretMaterial(payload: unknown): void {
  const json = JSON.stringify(payload);
  expect(json).not.toContain(FAKE_SECRET);
  // Prefijo/sufijo: un fragmento reduce el espacio de búsqueda del brute-force.
  expect(json).not.toContain(FAKE_SECRET.slice(0, 12));
  expect(json).not.toContain(FAKE_SECRET.slice(-12));
  // Hash: confirma un candidato offline sin costo.
  expect(json).not.toContain(
    createHash('sha256').update(FAKE_SECRET).digest('hex'),
  );
  expect(json).not.toContain(
    createHash('md5').update(FAKE_SECRET).digest('hex'),
  );
  // Largo: acota el espacio del brute-force. Campo por campo (ver abajo).
  expectNoSecretLength(payload);
}

/** Todos los escalares del payload, con su path, para asertar por campo. */
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
  if (value instanceof Date) {
    yield [path, value.toISOString()];
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
 * MNR-3 (AR HIGH-2): el largo del secreto se compara CAMPO POR CAMPO, no como
 * substring del body serializado.
 *
 * `expect(json).not.toContain(String(FAKE_SECRET.length))` fallaba con cualquier
 * campo futuro que contuviera "51" (un precio, un timestamp, un id) y encima con
 * el mensaje engañoso "leaks the credential length" — un falso positivo
 * esperando a ocurrir. Lo que hay que prohibir es un CAMPO que sea el largo
 * (`authValueLength: 51`) o un valor enmascarado con el MISMO largo que el
 * secreto (`authValue: '*'.repeat(51)`, que filtra el largo igual).
 */
function expectNoSecretLength(payload: unknown): void {
  const len = FAKE_SECRET.length;
  for (const [path, value] of scalarEntries(payload)) {
    if (typeof value === 'number') {
      expect(value, `${path}: es el largo de la credencial`).not.toBe(len);
    }
    if (typeof value === 'string') {
      expect(value, `${path}: es el largo de la credencial`).not.toBe(
        String(len),
      );
      expect(
        value.length,
        `${path}: tiene exactamente el largo de la credencial (¿máscara?)`,
      ).not.toBe(len);
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Read-paths redactados ───────────────────────────────────

describe('registryService — read-paths redactados (HIGH-1)', () => {
  it('T-RED-01: list() no devuelve auth.value ni derivaciones', async () => {
    mockFrom.mockReturnValue(
      chain({ order: { data: [secretRow()], error: null } }) as never,
    );

    const result = await registryService.list();

    expect(result).toHaveLength(1);
    expectNoSecretMaterial(result);
    expect(result[0]).not.toHaveProperty('auth');
  });

  it('T-RED-02: list() expone authType + authConfigured en lugar del secreto', async () => {
    mockFrom.mockReturnValue(
      chain({ order: { data: [secretRow()], error: null } }) as never,
    );

    const [registry] = await registryService.list();

    expect(registry?.authType).toBe('bearer');
    expect(registry?.authConfigured).toBe(true);
    // Los campos funcionales siguen intactos (no rompemos consumidores).
    expect(registry?.id).toBe('reg-1');
    expect(registry?.discoveryEndpoint).toBe('https://example.com/discover');
    // MNR-5: `ownerRef` NO sale por el path público (identificador de tenant en
    // un endpoint sin auth). La fila interna sí lo trae — ver T-RED-11.
    expect(registry).not.toHaveProperty('ownerRef');
    expect(JSON.stringify(registry)).not.toContain(OWNER);
  });

  it('T-RED-03: get() no devuelve auth.value ni derivaciones', async () => {
    mockFrom.mockReturnValue(
      chain({ maybeSingle: { data: secretRow(), error: null } }) as never,
    );

    const result = await registryService.get('reg-1');

    expect(result).toBeDefined();
    expectNoSecretMaterial(result);
    expect(result).not.toHaveProperty('auth');
    expect(result?.authType).toBe('bearer');
    expect(result?.authConfigured).toBe(true);
  });

  it('T-RED-04: register() echo-back redactado (201 body)', async () => {
    // 1ª llamada: pre-check de colisión de PK (get → maybeSingle null).
    mockFrom.mockReturnValueOnce(
      chain({ maybeSingle: { data: null, error: null } }) as never,
    );
    // 2ª llamada: insert().select().single() → fila persistida con secreto.
    mockFrom.mockReturnValueOnce(
      chain({ single: { data: secretRow(), error: null } }) as never,
    );

    const result = await registryService.register(
      {
        name: 'reg-1',
        discoveryEndpoint: 'https://example.com/discover',
        invokeEndpoint: 'https://example.com/invoke',
        schema: { discovery: {}, invoke: { method: 'POST' } },
        auth: { type: 'bearer', key: 'Authorization', value: FAKE_SECRET },
        enabled: true,
      },
      OWNER,
    );

    expectNoSecretMaterial(result);
    expect(result).not.toHaveProperty('auth');
    expect(result.authConfigured).toBe(true);
  });

  it('T-RED-05: update() no re-emite la credencial que el caller no tocó', async () => {
    // 1ª llamada: pre-fetch de ownership (get → maybeSingle con la fila).
    mockFrom.mockReturnValueOnce(
      chain({ maybeSingle: { data: secretRow(), error: null } }) as never,
    );
    // 2ª llamada: update().eq().eq().select().single().
    mockFrom.mockReturnValueOnce(
      chain({
        single: { data: secretRow({ name: 'renamed' }), error: null },
      }) as never,
    );

    const result = await registryService.update(
      'reg-1',
      { name: 'renamed' },
      OWNER,
    );

    expect(result.name).toBe('renamed');
    expectNoSecretMaterial(result);
    expect(result).not.toHaveProperty('auth');
  });
});

// ── Escape hatch interno (deliberado, no HTTP) ──────────────

describe('registryService — getWithSecrets/getEnabled son los únicos con secreto', () => {
  it('T-RED-06: getWithSecrets() SÍ devuelve auth.value (fetch outbound)', async () => {
    mockFrom.mockReturnValue(
      chain({ maybeSingle: { data: secretRow(), error: null } }) as never,
    );

    const result = await registryService.getWithSecrets('reg-1');

    // Deliberado: sin esto `discovery.fetchFromRegistry` no puede autenticar.
    // El contrato es que este valor NUNCA llega a `reply.send()` — lo garantiza
    // el tipo `RegistryPublic` (ver T-RED-10) + `registries.redaction.test.ts`.
    expect(result?.auth?.value).toBe(FAKE_SECRET);
  });

  it('T-RED-07: getEnabled() SÍ devuelve auth.value (fanout outbound)', async () => {
    mockFrom.mockReturnValue(
      chain({ order: { data: [secretRow()], error: null } }) as never,
    );

    const result = await registryService.getEnabled();

    expect(result[0]?.auth?.value).toBe(FAKE_SECRET);
  });
});

// ── Mapper ──────────────────────────────────────────────────

describe('toRegistryPublic — mapper obligatorio', () => {
  function config(over: Partial<RegistryConfig> = {}): RegistryConfig {
    return {
      id: 'reg-1',
      name: 'reg-1',
      discoveryEndpoint: 'https://example.com/discover',
      invokeEndpoint: 'https://example.com/invoke',
      schema: { discovery: {}, invoke: { method: 'POST' } },
      enabled: true,
      createdAt: new Date('2026-07-26T00:00:00Z'),
      ownerRef: OWNER,
      ...over,
    };
  }

  it('T-RED-08: authConfigured=false cuando hay auth.type pero no value', () => {
    const result = toRegistryPublic(
      config({ auth: { type: 'header', key: 'x-api-key' } }),
    );

    expect(result.authType).toBe('header');
    expect(result.authConfigured).toBe(false);
    expect(result).not.toHaveProperty('auth');
  });

  it('T-RED-09: sin auth → authType ausente y authConfigured=false', () => {
    const result = toRegistryPublic(config());

    expect(result.authType).toBeUndefined();
    expect(result.authConfigured).toBe(false);
  });

  it('T-RED-09b: las claves de salida están en un allowlist cerrado', () => {
    // Si alguien agrega un campo nuevo al tipo público, este test lo obliga a
    // pasar por acá y decidir explícitamente que NO es material de ataque.
    const result = toRegistryPublic(
      config({
        agentEndpoint: 'https://example.com/agent/{slug}',
        auth: { type: 'bearer', key: 'Authorization', value: FAKE_SECRET },
      }),
    );

    expect(Object.keys(result).sort()).toEqual(
      [
        'agentEndpoint',
        'authConfigured',
        'authType',
        'createdAt',
        'discoveryEndpoint',
        'enabled',
        'id',
        'invokeEndpoint',
        'name',
        'schema',
      ].sort(),
    );
    // MNR-5: explícito, porque era el campo que se dropeó.
    expect(Object.keys(result)).not.toContain('ownerRef');
  });

  it('T-RED-11 (MNR-5): la fila INTERNA sí trae ownerRef (el guard no es vacuo)', () => {
    // Contra-prueba de T-RED-02/09b: si `RegistryConfig` dejara de traer
    // `ownerRef`, los asserts de "no sale" pasarían por vacuidad y los guards de
    // ownership de `update`/`delete` estarían leyendo `undefined === undefined`.
    expect(config().ownerRef).toBe(OWNER);
  });

  it('T-RED-10: canario de compilación — RegistryConfig NO es asignable a RegistryPublic', () => {
    const internal: RegistryConfig = config({
      auth: { type: 'bearer', key: 'Authorization', value: FAKE_SECRET },
    });

    // @ts-expect-error HIGH-1: si este error DESAPARECE, `RegistryPublic` dejó
    // de bloquear el leak por construcción (alguien relajó `auth?: never` o
    // `authConfigured`). NO silenciar: arreglar el tipo en types/index.ts.
    const leaked: RegistryPublic = internal;

    // El canario real es el `@ts-expect-error` (tsc falla si sobra). En runtime
    // solo confirmamos que sin el mapper el secreto viajaría.
    expect(JSON.stringify(leaked)).toContain(FAKE_SECRET);
    expect(JSON.stringify(toRegistryPublic(internal))).not.toContain(
      FAKE_SECRET,
    );
  });
});
