/**
 * ¿CUÁNTAS VECES PAGA EL OPERADOR POR CADA UNO DE LOS TRES ENDPOINTS DE
 * `/orchestrate`, Y LLEGA LA CREDENCIAL DEL CALLER HASTA EL AGENTE?
 *
 * ── LOS DOS DEFECTOS QUE ESTE ARCHIVO FIJA ──────────────────────────────
 *
 * 1. DOBLE PAGO. `compose.invokeAgent` corría dos legs de salida al mismo
 *    agente, por el mismo monto, los dos con `OPERATOR_PRIVATE_KEY`. Acá se
 *    cuentan los settles REALES —ejecutando el camino HTTP completo, no
 *    inspeccionando un `if`— para cada endpoint, con y sin agent key.
 *
 * 2. `a2aKey` QUE NUNCA LLEGABA. `services/orchestrate.ts` pasa
 *    `a2aKey: request.a2aKey` a `composeService.compose`, pero NINGUNA de las
 *    tres rutas HTTP poblaba ese campo (el único productor era el tool MCP).
 *    Como la propiedad es opcional, compilaba. Se mide por su ÚNICO efecto
 *    observable: el header `x-a2a-key` que `compose` reenvía al `invokeUrl` de
 *    un registry system-trusted. Si el route deja de derivarlo, el header
 *    desaparece del request al agente y estos tests mueren.
 *
 * ── POR QUÉ NO SE MOCKEAN LOS SERVICIOS ─────────────────────────────────
 * `routes/orchestrate.test.ts` mockea `orchestrateService` entero, así que no
 * puede ver ni un settle ni un header. Acá corren los servicios REALES
 * (orchestrate + compose + downstream-payment) y se mockean sólo los bordes:
 * la DB (budget/event/discovery/registry), el LLM (sin API key ⇒ planner
 * greedy determinista), el fetch al agente y `../adapters/registry.js`, cuyo
 * `settle` es el contador compartido por TODOS los legs.
 */

import type { FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { A2AAgentKeyRow, Agent } from '../types/index.js';

vi.hoisted(() => {
  process.env.WASIAI_DOWNSTREAM_X402 = 'true';
  delete process.env.WASIAI_DOWNSTREAM_MAINNET_ALLOW;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.FUJI_RPC_URL;
  delete process.env.KITE_RPC_URL;
});

/** EL CONTADOR — una entrada por salida de fondos del wallet del operador. */
const settles = vi.hoisted(() => ({
  list: [] as { chainKey: string; to: string; value: string }[],
}));

vi.mock('../adapters/registry.js', () => {
  const DEFAULT_CHAIN = 'kite-ozone-testnet';
  const BUNDLES: Record<string, { chainId: number; name: string }> = {
    'kite-ozone-testnet': { chainId: 2368, name: 'Kite Ozone' },
    'avalanche-fuji': { chainId: 43113, name: 'Avalanche Fuji' },
  };
  let nonce = 0;
  const makeAdapter = (chainKey: string) => ({
    vmFamily: 'evm' as const,
    supportedTokens: [{ symbol: 'USDC', address: '0xToken', decimals: 6 }],
    getToken: () => '0xToken',
    getNetwork: () => `net:${chainKey}`,
    sign: async (o: { to: string; value: string }) => {
      nonce += 1;
      return {
        xPaymentHeader: 'header',
        paymentRequest: {
          authorization: {
            from: '0xOPERATOR',
            to: o.to,
            value: o.value,
            validAfter: '0',
            validBefore: '9999999999',
            nonce: `0x${nonce.toString(16)}`,
          },
          signature: '0xSIG',
          network: `net:${chainKey}`,
        },
      };
    },
    verify: async () => ({ valid: true }),
    settle: async (p: { authorization: { to: string; value: string } }) => {
      settles.list.push({
        chainKey,
        to: p.authorization.to,
        value: p.authorization.value,
      });
      return { success: true, txHash: `0xTX${settles.list.length}` };
    },
  });
  return {
    getPaymentAdapter: (k?: string) => makeAdapter(k ?? DEFAULT_CHAIN),
    getPaymentAdapterOrUnion: (k?: string) => makeAdapter(k ?? DEFAULT_CHAIN),
    getAdaptersBundle: (k: string) =>
      BUNDLES[k] ? { chainConfig: BUNDLES[k] } : undefined,
    getInitializedChainKeys: () => Object.keys(BUNDLES),
  };
});

vi.mock('../adapters/settle-verifier.js', () => ({
  verifyDefaultChainSettle: vi.fn().mockResolvedValue({ ok: true }),
}));

// ── Middleware de auth: pass-through. `extractRawKey` es el REAL (el route lo
//    importa del MISMO módulo, y ES la pieza bajo prueba: reemplazarlo por un
//    doble volvería vacuo el test del `a2aKey`).
const nextKeyRow = vi.hoisted(
  () => ({ row: undefined }) as { row: A2AAgentKeyRow | undefined },
);
vi.mock('../middleware/a2a-key.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../middleware/a2a-key.js')>();
  return {
    ...actual,
    requirePaymentOrA2AKey: () => [
      async (request: FastifyRequest) => {
        (request as unknown as { a2aKeyRow: unknown }).a2aKeyRow =
          nextKeyRow.row;
        (request as unknown as { resolvedChainId: unknown }).resolvedChainId =
          nextKeyRow.row ? 43113 : undefined;
      },
    ],
  };
});
vi.mock('../middleware/forward-key.js', () => ({
  requireForwardKey: () => [],
}));
vi.mock('../middleware/timeout.js', () => ({
  createTimeoutHandler: () => async () => {
    /* no-op */
  },
}));
vi.mock('../middleware/rate-limit.js', () => ({
  orchestrateRateLimit: () => false,
}));
vi.mock('../middleware/backpressure.js', () => ({
  createBackpressureHandler: () => async () => {
    /* no-op */
  },
}));
vi.mock('../middleware/event-tracking.js', () => ({
  noteDownstreamSkips: vi.fn(),
}));

vi.mock('../services/discovery.js', () => ({
  discoveryService: { discover: vi.fn(), getAgent: vi.fn() },
}));
vi.mock('../services/registry.js', () => ({
  registryService: { getEnabled: vi.fn() },
  SYSTEM_OWNER_REF: 'system',
}));
vi.mock('../services/event.js', () => ({
  eventService: { track: vi.fn().mockResolvedValue({}) },
}));
vi.mock('../services/receipt.js', () => ({
  receiptService: { emit: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../services/refund-outbox.js', () => ({
  refundOutbox: {
    enqueueRefund: vi.fn().mockResolvedValue(undefined),
    processRefundOutbox: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../services/budget.js', () => ({
  budgetService: {
    debit: vi.fn().mockResolvedValue({ success: true }),
    credit: vi.fn().mockResolvedValue({ success: true, reverted: true }),
    creditWithDest: vi
      .fn()
      .mockResolvedValue({ success: true, reverted: true }),
    creditDelegation: vi
      .fn()
      .mockResolvedValue({ success: true, reverted: true }),
    creditSession: vi.fn().mockResolvedValue({ success: true, reverted: true }),
    getBalance: vi.fn().mockResolvedValue('100'),
    registerDeposit: vi.fn(),
    recordSolanaSettleReceipt: vi.fn(),
  },
}));
vi.mock('../services/fee-charge.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../services/fee-charge.js')>();
  return {
    ...actual,
    chargeProtocolFee: vi
      .fn()
      .mockResolvedValue({ status: 'skipped', feeUsdc: 0, reason: 'UNSET' }),
    getProtocolFeeRate: vi.fn().mockReturnValue(0.01),
  };
});
vi.mock('../services/llm/transform.js', () => ({
  maybeTransform: vi.fn().mockResolvedValue({
    transformedOutput: null,
    cacheHit: 'SKIPPED',
    bridgeType: 'SKIPPED',
    latencyMs: 0,
  }),
}));
vi.mock('../services/llm/input-retry.js', () => ({
  regenerateInputFromErrors: vi.fn().mockResolvedValue(null),
}));

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.stubGlobal('fetch', mockFetch);
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: mockFetch };
});

import { registerErrorBoundary } from '../middleware/error-boundary.js';
import { genReqId, registerRequestIdHook } from '../middleware/request-id.js';
import { discoveryService } from '../services/discovery.js';
import { registryService } from '../services/registry.js';
import orchestrateRoutes from './orchestrate.js';

const PAY_TO = `0x${'B'.repeat(40)}`;
const RAW_KEY = 'wasi_a2a_testkey';

function makeAgent(): Agent {
  return {
    id: 'agent-1',
    name: 'Summarizer',
    slug: 'summarizer-v1',
    // El planner greedy elige por solapamiento léxico con el goal.
    description: 'summarize documents fast',
    capabilities: ['summarize'],
    priceUsdc: 0.05,
    reputation: 90,
    registry: 'wasiai',
    registry_id: 'wasiai',
    invokeUrl: 'https://example.com/invoke/summarizer-v1',
    invocationNote: 'Use POST /compose or POST /orchestrate on the gateway.',
    verified: true,
    status: 'active',
    // ⚠️ `metadata` es el agent card CRUDO (`discovery.mapAgent` hace
    // `metadata: raw`), así que trae el bloque `payment` completo. NO es
    // decorativo: el leg de salida BORRADO resolvía su destino de
    // `metadata.payTo ?? metadata.payment.contract`. Con `metadata: {}` este
    // fixture no tenía payTo alcanzable y el leg no habría disparado NUNCA —
    // o sea que los conteos de settle de abajo habrían dado 1 incluso con el
    // bug presente, y el test sería verde por el motivo equivocado. Lo cazó la
    // mutación (revertir el fix y ver morir un test), no la lectura.
    metadata: {
      payment: { protocol: 'x402', chain: 'avalanche', contract: PAY_TO },
    },
    payment: { method: 'x402', chain: 'avalanche', contract: PAY_TO },
  };
}

function makeKeyRow(): A2AAgentKeyRow {
  return {
    id: 'k1',
    owner_ref: 'owner-test',
    key_hash: 'hash',
    display_name: null,
    budget: { '43113': '100.000000' },
    daily_limit_usd: null,
    daily_spent_usd: '0.000000',
    daily_reset_at: new Date(Date.now() + 86400000).toISOString(),
    allowed_registries: null,
    allowed_agent_slugs: null,
    allowed_categories: null,
    max_spend_per_call_usd: null,
    is_active: true,
    last_used_at: null,
    created_at: '2026-04-27T00:00:00.000Z',
    updated_at: '2026-04-27T00:00:00.000Z',
    erc8004_identity: null,
    kite_passport: null,
    agentkit_wallet: null,
    funding_wallet: null,
    metadata: {},
    require_signature: false,
  };
}

async function buildApp() {
  const app = Fastify({ genReqId, logger: false });
  registerRequestIdHook(app);
  registerErrorBoundary(app);
  await app.register(orchestrateRoutes, { prefix: '/orchestrate' });
  await app.ready();
  return app;
}

/** Headers del request al AGENTE (el `invokeUrl`), no los del caller. */
function agentRequestHeaders(): Record<string, string> | undefined {
  const call = mockFetch.mock.calls.find((c) =>
    String(c[0]).includes('/invoke/'),
  );
  return call?.[1]?.headers as Record<string, string> | undefined;
}

const GOAL = 'summarize documents fast';

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockReset();
  settles.list = [];
  nextKeyRow.row = undefined;
  const agent = makeAgent();
  vi.mocked(discoveryService.discover).mockResolvedValue({
    agents: [agent],
    total: 1,
    totalAtLeast: 1,
    registries: ['wasiai'],
    sources: [],
    catalogStatus: 'complete',
  });
  vi.mocked(discoveryService.getAgent).mockResolvedValue(agent);
  // Registry SYSTEM-TRUSTED: es la condición que habilita el forward del
  // `x-a2a-key` en `compose.invokeAgent` (C1, auditoría 2026-07-01).
  vi.mocked(registryService.getEnabled).mockResolvedValue([
    {
      id: 'reg-1',
      name: 'wasiai',
      discoveryEndpoint: 'https://example.com/discover',
      invokeEndpoint: 'https://example.com/invoke/{slug}',
      schema: { discovery: {}, invoke: { method: 'POST' } },
      enabled: true,
      createdAt: new Date(),
      ownerRef: 'system',
    },
  ]);
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ result: 'ok' }),
    text: async () => '{"result":"ok"}',
  });
});

/** Los 3 endpoints, cada uno con su body mínimo. */
const ENDPOINTS: {
  name: string;
  url: string;
  body: Record<string, unknown>;
  /** `/plan` cotiza; no invoca ni paga. */
  pays: boolean;
}[] = [
  {
    name: 'POST /orchestrate',
    url: '/orchestrate',
    body: { goal: GOAL, budget: 5 },
    pays: true,
  },
  {
    name: 'POST /orchestrate/plan',
    url: '/orchestrate/plan',
    body: { goal: GOAL, budget: 5 },
    pays: false,
  },
  {
    name: 'POST /orchestrate/execute',
    url: '/orchestrate/execute',
    body: {
      orchestrationId: 'plan-1',
      steps: [
        { agent: 'summarizer-v1', registry: 'wasiai', input: { q: 'x' } },
      ],
      maxQuotedCostUsdc: 5,
      budget: 5,
    },
    pays: true,
  },
];

describe('los 3 endpoints de /orchestrate — settles CONTADOS end-to-end', () => {
  for (const ep of ENDPOINTS) {
    for (const withKey of [false, true]) {
      const label = withKey ? 'CON agent key' : 'x402 puro (sin agent key)';

      it(`${ep.name} · ${label} → ${ep.pays ? 'UN' : 'CERO'} settle de salida`, async () => {
        if (withKey) nextKeyRow.row = makeKeyRow();
        const app = await buildApp();

        const res = await app.inject({
          method: 'POST',
          url: ep.url,
          headers: withKey ? { 'x-a2a-key': RAW_KEY } : {},
          payload: ep.body,
        });
        await app.close();

        expect(res.statusCode).toBe(200);
        expect(settles.list).toHaveLength(ep.pays ? 1 : 0);
        if (ep.pays) {
          // Y el que queda es el del riel que DECLARA el agente.
          expect(settles.list[0]?.chainKey).toBe('avalanche-fuji');
          expect(settles.list[0]?.to).toBe(PAY_TO);
          expect(settles.list[0]?.value).toBe('50000'); // 0.05 USDC · 6 dec
        }
      });
    }
  }

  // ── Dirección opuesta: el agente COBRA ───────────────────────────────────
  it('el agente cobra por los dos endpoints que ejecutan, con y sin agent key — nunca CERO', async () => {
    for (const ep of ENDPOINTS.filter((e) => e.pays)) {
      for (const withKey of [false, true]) {
        settles.list = [];
        nextKeyRow.row = withKey ? makeKeyRow() : undefined;
        const app = await buildApp();
        const res = await app.inject({
          method: 'POST',
          url: ep.url,
          headers: withKey ? { 'x-a2a-key': RAW_KEY } : {},
          payload: ep.body,
        });
        await app.close();
        expect(res.statusCode).toBe(200);
        expect(settles.list.length).toBeGreaterThan(0);
        expect(settles.list[0]?.to).toBe(PAY_TO);
      }
    }
  });
});

describe('la credencial del caller llega al agente por los 3 endpoints', () => {
  // El `a2aKey` de `OrchestrateRequest` tenía CERO productores HTTP: el header
  // `x-a2a-key` nunca salía hacia el agente por ninguna de las tres rutas.
  for (const ep of ENDPOINTS.filter((e) => e.pays)) {
    it(`${ep.name} · con agent key → el agente recibe el header x-a2a-key`, async () => {
      nextKeyRow.row = makeKeyRow();
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: ep.url,
        headers: { 'x-a2a-key': RAW_KEY },
        payload: ep.body,
      });
      await app.close();

      expect(res.statusCode).toBe(200);
      expect(agentRequestHeaders()?.['x-a2a-key']).toBe(RAW_KEY);
    });

    it(`${ep.name} · con Authorization: Bearer wasi_a2a_* → misma extracción que el middleware`, async () => {
      // C2 (auditoría 2026-07-01): leer SÓLO `x-a2a-key` dejaba a un caller
      // autenticado por Bearer viéndose como anónimo. `extractRawKey` es la
      // fuente única; si el route volviera a leer el header a mano, esto muere.
      nextKeyRow.row = makeKeyRow();
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: ep.url,
        headers: { authorization: `Bearer ${RAW_KEY}` },
        payload: ep.body,
      });
      await app.close();

      expect(res.statusCode).toBe(200);
      expect(agentRequestHeaders()?.['x-a2a-key']).toBe(RAW_KEY);
    });

    it(`${ep.name} · caller x402 (sin credencial) → NO se inventa ningún x-a2a-key`, async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: ep.url,
        headers: {},
        payload: ep.body,
      });
      await app.close();

      expect(res.statusCode).toBe(200);
      expect(agentRequestHeaders()?.['x-a2a-key']).toBeUndefined();
    });
  }
});
