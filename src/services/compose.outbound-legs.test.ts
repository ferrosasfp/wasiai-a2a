/**
 * ¿CUÁNTAS VECES SALE PLATA DEL WALLET DEL OPERADOR POR UNA INVOCACIÓN?
 *
 * ── POR QUÉ ESTE ARCHIVO EXISTE ─────────────────────────────────────────
 * `compose.invokeAgent` tenía DOS legs de salida distintos, los dos firmados con
 * `OPERATOR_PRIVATE_KEY`, los dos por `agent.priceUsdc`, al MISMO agente:
 *
 *   · leg A — el mal llamado "sign inbound x402" (WKH-58): firmaba y settleaba en
 *     la chain DEFAULT del gateway contra `metadata.payTo ?? metadata.payment.contract`.
 *     Su gate era `priceUsdc > 0 && !a2aKey && !inboundVmUnsupported`.
 *   · leg B — el leg downstream (WKH-55, `signAndSettleDownstream`): firma y
 *     settlea en la chain que DECLARA el agente contra `agent.payment.contract`.
 *     Se llama INCONDICIONALMENTE y ni siquiera recibe `a2aKey`.
 *
 * Las dos condiciones eran COMPLEMENTARIAS, no excluyentes: un caller x402 puro
 * (sin agent key) contra un agente EVM con `payment` declarado disparaba LOS DOS.
 * Al caller se le cobraba una sola vez (`middleware/x402.ts`); el que pagaba dos
 * veces era el operador.
 *
 * ── POR QUÉ NO ALCANZABAN LAS SUITES QUE YA HABÍA ───────────────────────
 * `compose.test.ts` y `compose.stranded.test.ts` mockean
 * `../lib/downstream-payment.js` COMPLETO (`compose.test.ts:106`), así que el leg
 * B nunca corre: cuentan el leg A contra un doble del leg B. Y
 * `downstream-payment.test.ts` prueba el leg B aislado, sin `compose`. Ninguna de
 * las tres podía ver los dos legs a la vez, que es exactamente el bug.
 *
 * Acá NO se mockea `downstream-payment.js`. Se mockea UN SOLO seam —
 * `../adapters/registry.js` — y el `settle` de todos los adapters es el MISMO
 * espía. O sea: se cuentan los settles REALMENTE EJECUTADOS por el código de
 * producción, no la condición de un `if`. Cada entrada del contador dice en qué
 * chain settleó y a qué dirección, así que un settle de más se ve, y un settle de
 * MENOS (el agente sin cobrar, la dirección opuesta) también.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { A2AAgentKeyRow, Agent } from '../types/index.js';

// `DOWNSTREAM_FLAG` se lee UNA VEZ al cargar `downstream-payment.ts`: la env
// tiene que estar puesta antes de que se evalúen los imports (misma ventana que
// usa `lib/downstream-payment.solana-leg-mapping.test.ts`). El pool de vitest
// aísla por archivo.
vi.hoisted(() => {
  process.env.WASIAI_DOWNSTREAM_X402 = 'true';
  delete process.env.WASIAI_DOWNSTREAM_MAINNET_ALLOW;
  // Sin RPC configurado el pre-check de balance del leg B se saltea
  // (`BALANCE_PRECHECK_SKIPPED`) — no queremos I/O en esta suite.
  delete process.env.FUJI_RPC_URL;
  delete process.env.AVALANCHE_RPC_URL;
  delete process.env.KITE_RPC_URL;
});

const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({ getLogger: () => logSpy }));

/**
 * EL CONTADOR. Un settle = una salida de plata del wallet del operador.
 * `chainKey` es el `ChainKey` con el que se resolvió el adapter (`undefined` =
 * la chain DEFAULT del gateway, o sea `getPaymentAdapter()` sin argumento —
 * la firma exacta del leg A).
 */
const settles = vi.hoisted(() => ({
  list: [] as { chainKey: string; to: string; value: string }[],
}));

vi.mock('../adapters/registry.js', () => {
  const DEFAULT_CHAIN = 'kite-ozone-testnet';
  const BUNDLES: Record<string, { chainId: number; name: string }> = {
    'kite-ozone-testnet': { chainId: 2368, name: 'Kite Ozone' },
    'avalanche-fuji': { chainId: 43113, name: 'Avalanche Fuji' },
    'avalanche-mainnet': { chainId: 43114, name: 'Avalanche C-Chain' },
  };
  let nonce = 0;
  const makeAdapter = (chainKey: string) => ({
    vmFamily: 'evm' as const,
    supportedTokens: [
      { symbol: 'USDC', address: '0xToken', decimals: 6 as number },
    ],
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
    settle: async (p: {
      authorization: { to: string; value: string };
    }): Promise<{ success: boolean; txHash: string }> => {
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

vi.mock('./registry.js', () => ({
  registryService: { getEnabled: vi.fn().mockResolvedValue([]) },
  SYSTEM_OWNER_REF: 'system',
}));
vi.mock('./discovery.js', () => ({
  discoveryService: { getAgent: vi.fn(), discover: vi.fn() },
}));
vi.mock('./event.js', () => ({
  eventService: { track: vi.fn().mockResolvedValue({}) },
}));
vi.mock('./budget.js', () => ({
  budgetService: {
    debit: vi.fn().mockResolvedValue({ success: true }),
    credit: vi.fn().mockResolvedValue({ success: true, reverted: true }),
    creditWithDest: vi
      .fn()
      .mockResolvedValue({ success: true, reverted: true }),
    getBalance: vi.fn(),
    registerDeposit: vi.fn(),
    recordSolanaSettleReceipt: vi.fn(),
  },
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

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.stubGlobal('fetch', mockFetch);
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: mockFetch };
});

import { composeService } from './compose.js';
import { discoveryService } from './discovery.js';

/** payTo EVM válido (0x + 40 hex) — el mismo criterio que `isValidWallet`. */
const PAY_TO = `0x${'B'.repeat(40)}`;
/** Segundo payTo EVM, para el caso "los dos legs NO apuntan al mismo lado". */
const OTHER_PAY_TO = `0x${'C'.repeat(40)}`;
const SOL_PAY_TO = 'So11111111111111111111111111111111111111112';

function makeAgent(o: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    slug: 'test-agent',
    description: 'A test agent',
    capabilities: ['test'],
    priceUsdc: 0.05,
    registry: 'test-registry',
    registry_id: 'test-registry',
    invokeUrl: 'https://example.com/invoke',
    invocationNote: 'Use POST /compose or POST /orchestrate on the gateway.',
    verified: false,
    status: 'active',
    metadata: {},
    ...o,
  };
}

/** Agente EVM "normal": declara `payment` y expone el mismo payTo por metadata. */
function makeEvmAgent(o: Partial<Agent> = {}): Agent {
  return makeAgent({
    payment: { method: 'x402', chain: 'avalanche', contract: PAY_TO },
    metadata: { payTo: PAY_TO },
    ...o,
  });
}

function makeKeyRow(): A2AAgentKeyRow {
  return {
    id: 'key-id-test',
    owner_ref: 'owner-test',
    key_hash: 'h',
    display_name: null,
    budget: { '43113': '10.000000' },
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

function mockFetchOk(data: unknown = { result: 'ok' }) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => data,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  settles.list = [];
  delete process.env.WASIAI_DOWNSTREAM_MAINNET_ALLOW;
  vi.mocked(discoveryService.getAgent).mockResolvedValue(null);
  vi.mocked(discoveryService.discover).mockResolvedValue({
    agents: [],
    total: 0,
    totalAtLeast: 0,
    registries: [],
    sources: [],
    catalogStatus: 'complete',
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('salidas del wallet del operador por invocación (settles CONTADOS)', () => {
  it('T-LEG-1: caller x402 puro (sin agent key) + agente EVM → UN solo settle de salida', async () => {
    const agent = makeEvmAgent();
    mockFetchOk();

    await composeService.invokeAgent(agent, { q: 'hola' });

    // El repro del bug daba 2: uno en la chain DEFAULT del gateway (leg A) y
    // otro en la chain del agente (leg B), mismo `to`, mismo `value`.
    expect(settles.list).toHaveLength(1);
    expect(settles.list[0]?.chainKey).toBe('avalanche-fuji');
    expect(settles.list[0]?.to).toBe(PAY_TO);
  });

  it('T-LEG-2: caller CON agent key + agente EVM → UN solo settle (idéntico al x402 puro)', async () => {
    const agent = makeEvmAgent();
    mockFetchOk();

    await composeService.invokeAgent(agent, { q: 'hola' }, 'wasi_a2a_abc');

    expect(settles.list).toHaveLength(1);
    expect(settles.list[0]?.chainKey).toBe('avalanche-fuji');
    expect(settles.list[0]?.to).toBe(PAY_TO);
  });

  it('T-LEG-3 (dirección opuesta): el agente COBRA — ningún caso termina con CERO settles', async () => {
    for (const key of [undefined, 'wasi_a2a_abc']) {
      settles.list = [];
      mockFetchOk();
      await composeService.invokeAgent(makeEvmAgent(), { q: 'x' }, key);
      expect(settles.list.length).toBeGreaterThan(0);
      expect(settles.list[0]?.to).toBe(PAY_TO);
      expect(settles.list[0]?.value).toBe('50000'); // 0.05 USDC, 6 decimales
    }
  });

  it('T-LEG-4: el settle que queda es el de la chain DECLARADA por el agente, no el de la default del gateway', async () => {
    const agent = makeEvmAgent();
    mockFetchOk();

    await composeService.invokeAgent(agent, { q: 'hola' });

    expect(settles.list.map((s) => s.chainKey)).toEqual(['avalanche-fuji']);
    expect(settles.list.map((s) => s.chainKey)).not.toContain(
      'kite-ozone-testnet',
    );
  });

  it('T-LEG-5 (los dos legs NO apuntaban al mismo lado): `metadata.payTo` ≠ `payment.contract` → se paga UNA vez, al payTo DECLARADO', async () => {
    // El leg A resolvía `metadata.payTo ?? metadata.payment.contract` y el leg B
    // `agent.payment.contract`: cuando difieren, el operador pagaba a DOS
    // direcciones por una sola invocación.
    const agent = makeEvmAgent({
      payment: { method: 'x402', chain: 'avalanche', contract: PAY_TO },
      metadata: { payTo: OTHER_PAY_TO },
    });
    mockFetchOk();

    await composeService.invokeAgent(agent, { q: 'hola' });

    expect(settles.list).toHaveLength(1);
    expect(settles.list[0]?.to).toBe(PAY_TO);
    expect(settles.list.map((s) => s.to)).not.toContain(OTHER_PAY_TO);
  });

  it('T-LEG-6: el gate fail-CLOSED de mainnet corta la ÚNICA salida que queda (antes el leg A pagaba igual, sin gate)', async () => {
    const agent = makeEvmAgent({
      payment: {
        method: 'x402',
        chain: 'avalanche-mainnet',
        contract: PAY_TO,
      },
    });
    mockFetchOk();

    await composeService.invokeAgent(agent, { q: 'hola' });

    expect(settles.list).toHaveLength(0);
    // El leg downstream loguea a través del `effectiveLogger` de compose, que
    // envuelve el objeto en `{ obj }` (`compose.ts`, fallback de logger).
    expect(logSpy.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        obj: expect.objectContaining({ code: 'MAINNET_NOT_ALLOWED' }),
      }),
      expect.any(String),
    );
  });

  it('T-LEG-7: con el opt-in explícito, mainnet settlea — UNA vez', async () => {
    process.env.WASIAI_DOWNSTREAM_MAINNET_ALLOW = 'avalanche-mainnet';
    const agent = makeEvmAgent({
      payment: {
        method: 'x402',
        chain: 'avalanche-mainnet',
        contract: PAY_TO,
      },
    });
    mockFetchOk();

    await composeService.invokeAgent(agent, { q: 'hola' });

    expect(settles.list).toHaveLength(1);
    expect(settles.list[0]?.chainKey).toBe('avalanche-mainnet');
  });

  it('T-LEG-8: agente NO-EVM (Solana) → el camino sigue igual que hoy: cero settles EVM y el leg se resuelve por su rail', async () => {
    const agent = makeEvmAgent({
      payment: {
        method: 'x402',
        chain: 'solana-devnet',
        contract: SOL_PAY_TO,
      },
      metadata: { payTo: SOL_PAY_TO },
    });
    mockFetchOk();

    const result = await composeService.invokeAgent(agent, { q: 'hola' });

    // El rail Solana no está inicializado en esta suite (`getAdaptersBundle`
    // devuelve undefined) → CHAIN_NOT_SUPPORTED, exactamente como hoy.
    expect(result.output).toBe('ok');
    expect(settles.list).toHaveLength(0);
    expect(logSpy.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        obj: expect.objectContaining({ code: 'CHAIN_NOT_SUPPORTED' }),
      }),
      expect.any(String),
    );
  });

  it('T-LEG-9: agente gratis (priceUsdc = 0) → cero settles, invocación normal', async () => {
    const agent = makeEvmAgent({ priceUsdc: 0 });
    mockFetchOk();

    const result = await composeService.invokeAgent(agent, { q: 'hola' });

    expect(result.output).toBe('ok');
    expect(settles.list).toHaveLength(0);
  });

  it('T-LEG-10 (end-to-end por `compose`): un pipeline de un step paga UNA vez, con y sin agent key', async () => {
    for (const key of [undefined, 'wasi_a2a_abc']) {
      settles.list = [];
      const agent = makeEvmAgent();
      vi.mocked(discoveryService.getAgent).mockResolvedValue(agent);
      mockFetchOk();

      const res = await composeService.compose({
        steps: [{ agent: agent.slug, input: { q: 'x' } }],
        ...(key ? { a2aKey: key, scopingKeyRow: makeKeyRow() } : {}),
      });

      expect(res.success).toBe(true);
      expect(settles.list).toHaveLength(1);
      expect(settles.list[0]?.to).toBe(PAY_TO);
    }
  });
});
