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

vi.mock('./registry.js', () => ({
  registryService: {
    getEnabled: vi.fn(),
    get: vi.fn(),
    getWithSecrets: vi.fn(),
  },
  SYSTEM_OWNER_REF: 'system',
}));

vi.mock('./agent.js', () => ({
  publishedAgentService: {
    listAsAgents: vi.fn().mockResolvedValue([]),
    getBySlugAsAgent: vi.fn().mockResolvedValue(null),
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
