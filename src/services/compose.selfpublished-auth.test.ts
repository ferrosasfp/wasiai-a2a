/**
 * Credencial OUTBOUND hacia agentes SELF-PUBLISHED — cableado real en
 * `composeService.invokeAgent`.
 *
 * EL AGUJERO: `agent.registry` de un self-published es el nombre SINTÉTICO
 * `'self-published'` (`types/index.ts:217-218`), que NO tiene fila en `registries`.
 * `compose.ts` buscaba la fila (`registries.find(...)` → `undefined`), armaba
 * `buildAuthHeaders(undefined)` → `{}` y salía SIN credencial: ningún agente
 * self-published podía exigir auth al gateway.
 *
 * EL RIESGO DE CERRARLO MAL: un self-published lo publica cualquier caller
 * autenticado, con una URL a un host que no controlamos. Si el gateway mandara un
 * bearer "a los self-published", le estaría filtrando el secreto a todo el que
 * publique un agente — el mismo vector que el fix C1 (audit 2026-07-01) cerró para
 * los registries auto-registrados.
 *
 * Por eso estos tests NO se conforman con "el header llega": prueban a quién NO
 * llega. El guard vive en el mapa host → secreto de la env var (que un publicador
 * no puede tocar), NO en el `registry_id` del agente (que sí puede forjar).
 *
 * `resolveSelfPublishedAuthHeaders` corre REAL acá — se monta el camino entero
 * (invokeAgent → resolución de cabeceras → ssrfFetch) y se lee lo que salió por el
 * socket, en vez de re-preguntarle a la condición al lado.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SELF_PUBLISHED_AUTH_ENV } from '../lib/self-published-auth.js';
import type { Agent, RegistryConfig } from '../types/index.js';
import { SELF_PUBLISHED_REGISTRY_NAME } from '../types/index.js';

vi.mock('../lib/logger.js', () => ({
  getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));
vi.mock('./registry.js', () => ({
  registryService: { getEnabled: vi.fn() },
  SYSTEM_OWNER_REF: 'system',
}));
vi.mock('./budget.js', () => ({
  budgetService: {
    debit: vi.fn(),
    credit: vi.fn(),
    creditWithDest: vi.fn(),
    getBalance: vi.fn(),
    registerDeposit: vi.fn(),
    recordSolanaSettleReceipt: vi.fn(),
  },
}));
vi.mock('../adapters/registry.js', () => ({
  getPaymentAdapter: () => ({
    sign: vi.fn(),
    settle: vi.fn(),
    supportedTokens: [{ symbol: 'PYUSD', address: '0x0', decimals: 18 }],
  }),
}));
vi.mock('../adapters/settle-verifier.js', () => ({
  verifyDefaultChainSettle: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('./discovery.js', () => ({
  discoveryService: { getAgent: vi.fn(), discover: vi.fn() },
}));
vi.mock('./event.js', () => ({
  eventService: { track: vi.fn().mockResolvedValue({}) },
}));
vi.mock('./llm/transform.js', () => ({
  maybeTransform: vi.fn().mockResolvedValue({
    transformedOutput: null,
    cacheHit: 'SKIPPED',
    bridgeType: 'SKIPPED',
    latencyMs: 0,
  }),
}));
vi.mock('./llm/input-retry.js', () => ({
  regenerateInputFromErrors: vi.fn().mockResolvedValue(null),
}));
vi.mock('../lib/downstream-payment.js', () => ({
  signAndSettleDownstream: vi.fn().mockResolvedValue(null),
}));

// undici-8 (#124): `ssrfFetch` llama al `fetch` de undici, no al global. Se rutean
// los dos al mismo doble para poder LEER las cabeceras que salieron.
const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.stubGlobal('fetch', mockFetch);
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: mockFetch };
});
// El guard SSRF resuelve DNS antes de salir: se apunta a una IP pública.
vi.mock('node:dns', () => ({
  promises: {
    lookup: vi
      .fn()
      .mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
  },
}));

import { composeService } from './compose.js';
import { registryService } from './registry.js';

/** Host del publicador NUESTRO: el operador lo declara en la env var. */
const OUR_HOST = 'agents.wasiai.example';
/** Host de OTRO publicador: cualquiera puede publicar un agente que apunte acá. */
const THEIR_HOST = 'attacker.example.net';
const OUR_SECRET = 'gateway-to-our-agents';
const THEIR_SECRET = 'gateway-to-their-agents';

const originalEnv = process.env[SELF_PUBLISHED_AUTH_ENV];

function setAuthMap(map: Record<string, string> | undefined): void {
  if (map === undefined) {
    delete process.env[SELF_PUBLISHED_AUTH_ENV];
    return;
  }
  process.env[SELF_PUBLISHED_AUTH_ENV] = JSON.stringify(map);
}

/** Agente self-published tal como lo emite `agent.ts:mapRowToAgent`. */
function selfPublishedAgent(host: string, slug = 'remit-fx'): Agent {
  return {
    id: slug,
    name: slug,
    slug,
    description: '',
    capabilities: ['fx'],
    priceUsdc: 0,
    registry: SELF_PUBLISHED_REGISTRY_NAME,
    registry_id: SELF_PUBLISHED_REGISTRY_NAME,
    invokeUrl: `https://${host}/invoke`,
    invocationNote: 'gateway',
    verified: false,
    status: 'active',
    metadata: {},
  };
}

function makeRegistry(o: Partial<RegistryConfig> = {}): RegistryConfig {
  return {
    id: 'reg-1',
    name: 'test-registry',
    discoveryEndpoint: 'https://example.com/discover',
    invokeEndpoint: 'https://example.com/invoke/{slug}',
    schema: { discovery: {}, invoke: { method: 'POST' } },
    enabled: true,
    createdAt: new Date(),
    ownerRef: 'system',
    ...o,
  };
}

/** Cabeceras con las que el gateway SALIÓ hacia el agente. */
function outboundHeaders(): Record<string, string> {
  expect(mockFetch).toHaveBeenCalledTimes(1);
  const init = mockFetch.mock.calls[0]?.[1] as {
    headers: Record<string, string>;
  };
  return init.headers;
}

beforeEach(() => {
  vi.clearAllMocks();
  setAuthMap(undefined);
  vi.mocked(registryService.getEnabled).mockResolvedValue([]);
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ result: 'ok' }),
  });
});

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env[SELF_PUBLISHED_AUTH_ENV];
  } else {
    process.env[SELF_PUBLISHED_AUTH_ENV] = originalEnv;
  }
});

describe('invokeAgent — credencial outbound a agentes self-published', () => {
  it('POSITIVO: agente self-published en un host DECLARADO → viaja su Bearer', async () => {
    setAuthMap({ [OUR_HOST]: OUR_SECRET });

    await composeService.invokeAgent(selfPublishedAgent(OUR_HOST), {
      amount: 1,
    });

    expect(outboundHeaders().Authorization).toBe(`Bearer ${OUR_SECRET}`);
  });

  it('NEGATIVO: con la variable AUSENTE ningún self-published recibe credencial (default inerte)', async () => {
    await composeService.invokeAgent(selfPublishedAgent(OUR_HOST), {});

    const headers = outboundHeaders();
    expect(headers.Authorization).toBeUndefined();
    // Byte-idéntico al comportamiento previo al fix: sólo Content-Type.
    expect(Object.keys(headers)).toEqual(['Content-Type']);
  });

  it('NEGATIVO: un self-published AJENO no recibe credencial aunque el mapa esté configurado', async () => {
    // El operador declaró SU host. Otro publicador publica un agente que apunta a
    // su propio servidor: no puede cosechar el secreto por el sólo hecho de ser
    // self-published.
    setAuthMap({ [OUR_HOST]: OUR_SECRET });

    await composeService.invokeAgent(
      selfPublishedAgent(THEIR_HOST, 'agente-de-otro'),
      {},
    );

    const headers = outboundHeaders();
    expect(headers.Authorization).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain(OUR_SECRET);
  });

  it('AISLAMIENTO ENTRE DUEÑOS: cada host declarado recibe SU secreto, nunca el del otro', async () => {
    setAuthMap({ [OUR_HOST]: OUR_SECRET, [THEIR_HOST]: THEIR_SECRET });

    await composeService.invokeAgent(selfPublishedAgent(OUR_HOST), {});
    expect(outboundHeaders().Authorization).toBe(`Bearer ${OUR_SECRET}`);

    mockFetch.mockClear();
    await composeService.invokeAgent(
      selfPublishedAgent(THEIR_HOST, 'otro'),
      {},
    );
    const headers = outboundHeaders();
    expect(headers.Authorization).toBe(`Bearer ${THEIR_SECRET}`);
    expect(JSON.stringify(headers)).not.toContain(OUR_SECRET);
  });

  it('NEGATIVO: un destino http:// declarado NO recibe el secreto (nunca en claro)', async () => {
    setAuthMap({ [OUR_HOST]: OUR_SECRET });
    const agent = selfPublishedAgent(OUR_HOST);
    agent.invokeUrl = `http://${OUR_HOST}/invoke`;

    await composeService.invokeAgent(agent, {});

    expect(outboundHeaders().Authorization).toBeUndefined();
  });

  it('C1 SIGUE EN PIE: la a2a-key del CALLER nunca viaja a un self-published, ni al host declarado', async () => {
    setAuthMap({ [OUR_HOST]: OUR_SECRET });

    await composeService.invokeAgent(
      selfPublishedAgent(OUR_HOST),
      {},
      'victim-a2a-key',
    );

    const headers = outboundHeaders();
    // El secreto DEL GATEWAY sí; el bearer DEL CALLER no.
    expect(headers.Authorization).toBe(`Bearer ${OUR_SECRET}`);
    expect(headers['x-a2a-key']).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain('victim-a2a-key');
  });

  it('EL registry_id NO ES EL GUARD: un agente federado que lo FORJA a self-published no cosecha el secreto', async () => {
    // `'self-published'` no tiene fila propia en `registries`, así que cualquier
    // caller autenticado puede `POST /registries` con ese nombre y hacer que sus
    // agentes federados salgan con ese `registry_id`. Si el guard fuera el
    // `registry_id`, esto alcanzaría para robar la credencial.
    setAuthMap({ [OUR_HOST]: OUR_SECRET });
    vi.mocked(registryService.getEnabled).mockResolvedValue([
      makeRegistry({
        name: SELF_PUBLISHED_REGISTRY_NAME,
        ownerRef: 'attacker-owner-ref',
      }),
    ]);
    const forged = selfPublishedAgent(THEIR_HOST, 'forjado');

    await composeService.invokeAgent(forged, {}, 'victim-a2a-key');

    const headers = outboundHeaders();
    expect(headers.Authorization).toBeUndefined();
    expect(headers['x-a2a-key']).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain(OUR_SECRET);
  });

  it('ALCANCE: un agente FEDERADO normal no cambia, aunque su host esté en el mapa', async () => {
    // El camino federado queda byte-idéntico: su credencial sigue saliendo (o no)
    // de la fila de `registries`, nunca del mapa self-published.
    setAuthMap({ [OUR_HOST]: OUR_SECRET });
    vi.mocked(registryService.getEnabled).mockResolvedValue([makeRegistry()]);
    const federated = selfPublishedAgent(OUR_HOST, 'federado');
    federated.registry = 'test-registry';
    federated.registry_id = 'test-registry';

    await composeService.invokeAgent(federated, {});

    const headers = outboundHeaders();
    expect(headers.Authorization).toBeUndefined();
    expect(Object.keys(headers)).toEqual(['Content-Type']);
  });
});
