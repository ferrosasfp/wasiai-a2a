/**
 * Discovery / Agent-Card — Credential Redaction Tests (HIGH-1, 2026-07-26).
 *
 * Estos son los OTROS consumidores de las filas de `registries` con secreto:
 * `discoveryService` (fanout outbound: necesita `auth.value` para el header) y
 * `agentCardService` (solo lee `auth.type`). Ninguno debe emitir la credencial
 * en su valor de retorno, que es lo que sirven `GET /discover`,
 * `POST /discover`, `GET /discover/:slug`, `GET /capabilities` (reenvía
 * `discover()`) y `GET /agents/:slug/agent-card`.
 *
 * El registryService se moquea a propósito devolviendo filas CON el secreto:
 * así se prueba que el borde de salida no lo arrastra, aun teniéndolo a mano.
 *
 * Naming: T-DRED-01..T-DRED-05.
 *
 * ⚠️ El valor usado acá es INVENTADO. Nunca pegar una credencial real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, RegistryConfig } from '../types/index.js';
import {
  SELF_PUBLISHED_REGISTRY_ID,
  SELF_PUBLISHED_REGISTRY_NAME,
} from '../types/index.js';

vi.mock('./registry.js', () => ({
  registryService: {
    getEnabled: vi.fn(),
    get: vi.fn(),
    getWithSecrets: vi.fn(),
  },
  SYSTEM_OWNER_REF: 'system',
}));

// WKH-313: `listPublisherAnchors` devuelve `owner_ref` a propósito — el ancla se usa
// para CONTAR el cupo del carril de estreno, NUNCA para publicar (CD-10). El doble lo
// entrega poblado justamente para probar que el borde de salida no lo arrastra.
const { mockListAnchors, mockListAsAgents } = vi.hoisted(() => ({
  mockListAnchors: vi.fn(),
  mockListAsAgents: vi.fn(),
}));
vi.mock('./agent.js', () => ({
  publishedAgentService: {
    listAsAgents: (...args: unknown[]) => mockListAsAgents(...args),
    getBySlugAsAgent: vi.fn().mockResolvedValue(null),
    listPublisherAnchors: (slugs: string[]) => mockListAnchors(slugs),
  },
}));

vi.mock('./identity.js', () => ({
  identityService: {
    resolveIdentityForAgent: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('./reputation.js', () => ({
  reputationService: {
    computeReputationBatch: vi.fn().mockResolvedValue(new Map()),
    // WKH-313: el consumidor real de `attachReputations`. Sin standings y SIN
    // degradación: nadie tiene historial, la lectura funcionó.
    computeStandingBatch: vi
      .fn()
      .mockResolvedValue({ degraded: false, standings: new Map() }),
    computeReputationForAgent: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../lib/circuit-breaker.js', () => ({
  getRegistryCircuitBreaker: () => ({
    execute: (fn: () => Promise<Response>) => fn(),
  }),
}));

// undici-8 (#124): `ssrfFetch` usa el `fetch` de undici, no el global.
const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.stubGlobal('fetch', mockFetch);
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: mockFetch };
});

import { agentCardService } from './agent-card.js';
import { discoveryService } from './discovery.js';
import { registryService } from './registry.js';

/** Credencial FALSA. Imita la forma de un token del gateway, no es una real. */
const FAKE_SECRET = 'wasi_a2a_THIS_IS_A_FAKE_TEST_TOKEN_0123456789abcdef';

function secretRegistry(over: Partial<RegistryConfig> = {}): RegistryConfig {
  return {
    id: 'reg-1',
    name: 'test-registry',
    discoveryEndpoint: 'https://example.com/agents',
    invokeEndpoint: 'https://example.com/invoke/{slug}',
    agentEndpoint: 'https://example.com/agent/{slug}',
    schema: { discovery: {}, invoke: { method: 'POST' } },
    auth: { type: 'bearer', key: 'Authorization', value: FAKE_SECRET },
    enabled: true,
    createdAt: new Date('2026-07-26T00:00:00Z'),
    ownerRef: 'system',
    ...over,
  };
}

const RAW_AGENT = {
  id: 'a1',
  slug: 'a1',
  name: 'Agent 1',
  description: 'd',
  capabilities: ['kyc'],
  price: 0,
  status: 'active',
};

function expectNoSecretMaterial(payload: unknown, where: string): void {
  const json = JSON.stringify(payload);
  expect(json, `${where}: leaks the credential`).not.toContain(FAKE_SECRET);
  expect(json, `${where}: leaks a credential prefix`).not.toContain(
    FAKE_SECRET.slice(0, 12),
  );
  expect(json, `${where}: leaks a credential suffix`).not.toContain(
    FAKE_SECRET.slice(-12),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockReset();
  mockListAsAgents.mockResolvedValue([]);
});

describe('discoveryService — no arrastra la credencial del registry (HIGH-1)', () => {
  it('T-DRED-01: discover() sin filtro — `registries` son nombres, no configs', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([secretRegistry()]);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([RAW_AGENT]),
    });

    const result = await discoveryService.discover({});

    expect(result.agents).toHaveLength(1);
    expect(result.registries).toEqual(['test-registry']);
    expectNoSecretMaterial(result, 'discover()');
  });

  it('T-DRED-02: discover({registry}) usa getWithSecrets y no lo devuelve', async () => {
    vi.mocked(registryService.getWithSecrets).mockResolvedValue(
      secretRegistry(),
    );
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([RAW_AGENT]),
    });

    const result = await discoveryService.discover({ registry: 'reg-1' });

    // El path filtrado necesita el secreto para autenticar el fetch outbound…
    expect(registryService.getWithSecrets).toHaveBeenCalledWith('reg-1');
    expect(registryService.get).not.toHaveBeenCalled();
    // …y aun así no sale en la respuesta.
    expectNoSecretMaterial(result, 'discover({registry})');
  });

  it('T-DRED-03: el header outbound SÍ lleva la credencial (el test no es vacuo)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([secretRegistry()]);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([RAW_AGENT]),
    });

    await discoveryService.discover({});

    // Contra-prueba: la credencial se usa (Bearer), solo no se publica. Si esto
    // se rompiera, T-DRED-01/02 pasarían por vacuidad.
    const init = mockFetch.mock.calls[0]?.[1] as
      | { headers?: Record<string, string> }
      | undefined;
    expect(init?.headers?.Authorization).toBe(`Bearer ${FAKE_SECRET}`);
  });

  it('T-DRED-04: getAgent(slug, registry) devuelve un Agent sin la credencial', async () => {
    vi.mocked(registryService.getWithSecrets).mockResolvedValue(
      secretRegistry(),
    );
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(RAW_AGENT),
    });

    const agent = await discoveryService.getAgent('a1', 'reg-1');

    expect(agent?.slug).toBe('a1');
    expectNoSecretMaterial(agent, 'getAgent()');
  });
});

describe('agentCardService — solo el esquema de auth, nunca el valor (HIGH-1)', () => {
  it('T-DRED-05: buildAgentCard expone schemes, no la credencial', () => {
    const agent: Agent = {
      id: 'a1',
      name: 'Agent 1',
      slug: 'a1',
      description: 'd',
      capabilities: ['kyc'],
      priceUsdc: 0,
      registry: 'test-registry',
      registry_id: 'reg-1',
      invokeUrl: 'https://example.com/invoke/a1',
      invocationNote: '',
      verified: false,
      status: 'active',
    };

    const card = agentCardService.buildAgentCard(
      agent,
      secretRegistry(),
      'https://gateway.example',
    );

    expect(card.authentication.schemes).toEqual(['bearer']);
    expectNoSecretMaterial(card, 'buildAgentCard()');
  });
});

// ── T-16 (WKH-313 / CD-10) · el ancla de publicación no se publica ──────
//
// El carril de estreno LEE `a2a_agents.owner_ref` para contar el cupo por
// publicador. Ese dato es de la misma familia que la credencial del registry: se usa
// server-side y no sale. Y la clasificación de standing tampoco: publicar
// `penalized` sería una letra escarlata sin contrato (DT-6).
describe('T-16 (CD-10) · ni `owner_ref` ni el standing salen en la respuesta', () => {
  const FAKE_OWNER_REF = 'owner-ref-9f3c-DO-NOT-SURFACE';

  it('T-DRED-06: el admitido por estreno trae `trial` y NADA del ancla ni del standing', async () => {
    // El agente es SELF-PUBLISHED a propósito: su ancla es el `owner_ref` de la
    // fila, así que sin la siembra de abajo NO se lo admite. Eso hace que la
    // aserción "el escenario está armado" sea de verdad load-bearing — con un
    // agente federado el ancla sería el `registry_id` y se admitiría igual, o sea
    // que el `owner_ref` nunca entraría al camino y este test mediría aire.
    vi.mocked(registryService.getEnabled).mockResolvedValue([secretRegistry()]);
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
    mockListAsAgents.mockResolvedValue([
      {
        id: 'a1',
        name: 'Agent 1',
        slug: 'a1',
        description: 'd',
        capabilities: ['kyc'],
        priceUsdc: 0,
        registry: SELF_PUBLISHED_REGISTRY_NAME,
        registry_id: SELF_PUBLISHED_REGISTRY_ID,
        invokeUrl: 'https://example.com/invoke/a1',
        invocationNote: '',
        verified: false,
        status: 'active',
        metadata: {},
      } satisfies Agent,
    ]);
    mockListAnchors.mockResolvedValue({
      degraded: false,
      anchors: new Map([
        ['a1', { ownerRef: FAKE_OWNER_REF, createdAt: '2026-01-01T00:00:00Z' }],
      ]),
    });

    const result = await discoveryService.discover({
      minReputation: 2,
      allowTrial: true,
    });

    // El escenario está armado: el agente SÍ fue admitido por el carril.
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]?.trial?.granted).toBe(true);

    const json = JSON.stringify(result);
    expect(json, 'leaks the publisher anchor').not.toContain(FAKE_OWNER_REF);
    expect(json, 'leaks owner_ref as a key').not.toContain('owner_ref');
    expect(json, 'leaks ownerRef as a key').not.toContain('ownerRef');
    // La clasificación de standing NO es campo público de `Agent` (DT-6).
    for (const leaked of [
      'penalized',
      'newcomer',
      'scored',
      'tasksSettled',
      'failedCount',
      'successCount',
      'degraded',
    ]) {
      expect(json, `leaks the standing internals: ${leaked}`).not.toContain(
        leaked,
      );
    }
    expectNoSecretMaterial(result, 'discover({allowTrial})');
  });
});
