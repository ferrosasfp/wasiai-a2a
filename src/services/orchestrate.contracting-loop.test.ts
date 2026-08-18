/**
 * WKH-360 · SITIO 2 del guard anti-bucle — /orchestrate*, step-0. 💰
 *
 * ── POR QUÉ ESTE SITIO EXISTE APARTE DEL SITIO 3 ────────────────────────────
 * En `/orchestrate*` el débito del step-0 NO lo hace el middleware: las tres rutas
 * lo apagan con `markSkipMiddlewareDebitHandler`, así que el ÚNICO débito del step-0
 * es el que hace ESTE service (`executeApprovedPlan`). Si el guard corriera recién
 * dentro de compose (Sitio 3), el step-0 ya estaría cobrado.
 *
 * ── POR QUÉ ESTE ARCHIVO Y NO `orchestrate.test.ts` ─────────────────────────
 * `orchestrate.test.ts` mockea `composeService.compose` completo, así que allá no se
 * puede contar el débito real. Este archivo usa el scaffold de
 * `orchestrate.billing.test.ts`: compose REAL, y sólo la capa de borde mockeada, con
 * `budgetService.debit` como espía. La aserción que importa es CERO llamadas a
 * `debit` — no el status.
 *
 * Mutante: `MUT-03` (mover el bloque a después del `if (!debitRes.success)`).
 */
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { A2AAgentKeyRow, Agent } from '../types/index.js';

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  // biome-ignore lint/complexity/useArrowFunction: new-able mock constructor
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }),
}));

vi.mock('./discovery.js', () => ({
  discoveryService: {
    discover: vi.fn(),
    getAgent: vi.fn(),
  },
}));

vi.mock('./budget.js', () => ({
  budgetService: {
    debit: vi.fn(),
    credit: vi.fn().mockResolvedValue({ success: true }),
    getBalance: vi.fn(),
    registerDeposit: vi.fn(),
  },
}));

vi.mock('./event.js', () => ({
  eventService: { track: vi.fn().mockResolvedValue({}) },
}));

vi.mock('./fee-charge.js', async () => {
  const actual =
    await vi.importActual<typeof import('./fee-charge.js')>('./fee-charge.js');
  return {
    ...actual,
    chargeProtocolFee: vi.fn().mockResolvedValue({
      status: 'skipped',
      feeUsdc: 0,
      reason: 'WALLET_UNSET',
    }),
    getProtocolFeeRate: vi.fn().mockReturnValue(0.01),
  };
});

vi.mock('./registry.js', () => ({
  registryService: { getEnabled: vi.fn().mockResolvedValue([]) },
  SYSTEM_OWNER_REF: 'system',
}));

vi.mock('../lib/downstream-payment.js', () => ({
  signAndSettleDownstream: vi.fn().mockResolvedValue(null),
}));

const mockSign = vi.fn().mockResolvedValue({
  xPaymentHeader: '0xsig',
  paymentRequest: {
    authorization: {},
    signature: '0xsig',
    network: 'avalanche-fuji',
  },
});
const mockSettle = vi
  .fn()
  .mockResolvedValue({ success: true, txHash: '0xsettled' });
vi.mock('../adapters/registry.js', () => ({
  getPaymentAdapter: () => ({ sign: mockSign, settle: mockSettle }),
}));

vi.mock('./llm/transform.js', () => ({
  maybeTransform: vi.fn().mockResolvedValue({
    transformedOutput: null,
    cacheHit: 'SKIPPED',
    bridgeType: 'SKIPPED',
    latencyMs: 0,
  }),
}));

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.stubGlobal('fetch', mockFetch);
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: mockFetch };
});

import { CONTRACTING_LOOP_DETECTED } from '../lib/contracting-chain.js';
import { budgetService } from './budget.js';
import { discoveryService } from './discovery.js';
import { orchestrateService } from './orchestrate.js';

const mockDebit = vi.mocked(budgetService.debit);
const SELF = 'gw.wasiai.example';
const CHAIN_ID = 2368;
const ENV_KEYS = ['A2A_SELF_HOSTS', 'BASE_URL', 'DISCOVERY_SSRF_ALLOWLIST'];
const saved: Record<string, string | undefined> = {};

function makeAgent(o: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-x',
    name: 'Agent X',
    slug: 'agent-x',
    description: 'multi-step pipeline agent',
    capabilities: ['step', 'pipeline', 'test'],
    priceUsdc: 0.05,
    reputation: 80,
    registry: 'wasiai',
    registry_id: 'wasiai',
    invokeUrl: 'https://otro-agente.example/invoke/agent-x',
    invocationNote: 'Use POST /compose or POST /orchestrate on the gateway.',
    verified: false,
    status: 'active',
    metadata: { payTo: '0x000000000000000000000000000000000000dEaD' },
    ...o,
  };
}

function makeKeyRow(overrides: Partial<A2AAgentKeyRow> = {}): A2AAgentKeyRow {
  return {
    id: 'k1',
    owner_ref: 'owner-test',
    key_hash: crypto.createHash('sha256').update('test').digest('hex'),
    display_name: null,
    budget: { '2368': '10.000000' },
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
    ...overrides,
  };
}

function withAgents(agents: Agent[]): void {
  vi.mocked(discoveryService.discover).mockResolvedValue({
    agents,
    total: agents.length,
    totalAtLeast: agents.length,
    registries: ['wasiai'],
    sources: [],
    catalogStatus: 'complete',
  });
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  vi.clearAllMocks();
  delete process.env.ANTHROPIC_API_KEY;
  mockDebit.mockResolvedValue({ success: true });
  vi.mocked(budgetService.getBalance).mockResolvedValue('10');
  vi.mocked(budgetService.credit).mockResolvedValue({ success: true });
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ result: 'ok' }),
  });
  process.env.DISCOVERY_SSRF_ALLOWLIST = `${SELF},otro-agente.example`;
});

// ⚠️ El `saved` de arriba se ESCRIBÍA y no se leía nunca (fix-pack CR/MNR-3):
// este archivo borra tres envs en su `beforeEach` y, sin este `afterEach`, se las
// deja borradas al resto del proceso. Calibrado por el CR: con la config actual de
// vitest (un fork por archivo) no hay fuga, así que el impacto de HOY es CERO — con
// `--no-isolate` sí la hay. Se restaura igual: el aislamiento es del runner, no de
// este archivo, y depender de la config del runner para no contaminar es depender de
// algo que este archivo no controla.
afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('WKH-360 SITIO 2 — /orchestrate: el corte ocurre ANTES del débito del step-0', () => {
  it('T-L1-3 (AC-4, CD-3): un step propio en el plan → CERO llamadas a debit', async () => {
    process.env.A2A_SELF_HOSTS = SELF;
    const selfAgent = makeAgent({
      slug: 'self-loop',
      id: 'id-self',
      invokeUrl: `https://${SELF}/compose`,
    });
    withAgents([selfAgent]);
    // El guard llama `resolveAgentDestination`, que resuelve por `getAgent`.
    vi.mocked(discoveryService.getAgent).mockResolvedValue(selfAgent);

    const result = await orchestrateService.orchestrate(
      {
        goal: 'multi-step pipeline',
        budget: 5.0,
        maxAgents: 1,
        scopingKeyRow: makeKeyRow(),
        chainId: CHAIN_ID,
      },
      'orch-loop-1',
    );

    // ── EL DINERO. En orchestrate el step-0 lo debita ESTE service, así que
    // "cero llamadas" es la afirmación de que se cortó antes de cobrar.
    expect(mockDebit).not.toHaveBeenCalled();
    // Y no se emitió ninguna invocación saliente.
    expect(mockFetch).not.toHaveBeenCalled();

    expect(result.pipeline.success).toBe(false);
    expect(result.pipeline.errorCode).toBe(CONTRACTING_LOOP_DETECTED);
  });

  it('T-L1-3b (CD-15): destino propio con punto final y mayúsculas → cero débitos', async () => {
    process.env.A2A_SELF_HOSTS = SELF;
    const selfAgent = makeAgent({
      slug: 'self-dot',
      id: 'id-dot',
      invokeUrl: `https://${SELF.toUpperCase()}./compose`,
    });
    withAgents([selfAgent]);
    vi.mocked(discoveryService.getAgent).mockResolvedValue(selfAgent);

    const result = await orchestrateService.orchestrate(
      {
        goal: 'multi-step pipeline',
        budget: 5.0,
        maxAgents: 1,
        scopingKeyRow: makeKeyRow(),
        chainId: CHAIN_ID,
      },
      'orch-loop-2',
    );

    expect(mockDebit).not.toHaveBeenCalled();
    expect(result.pipeline.errorCode).toBe(CONTRACTING_LOOP_DETECTED);
  });

  /**
   * ⚠️ TESTIGO del fix-pack AR/CR BLQ-MED-1 para el SITIO 2.
   *
   * Sin `hint`, el conjunto de identidad de este método salía de las envs, y con
   * las dos ausentes el gate `if (selfHosts.length > 0)` **se salteaba el bloque
   * entero**: el step-0 de las TRES rutas de `/orchestrate*` quedaba sin guard de
   * dinero, y en orchestrate ese débito lo hace ESTE service (las tres rutas apagan
   * el del middleware con `markSkipMiddlewareDebitHandler`). O sea que no había
   * ningún otro que lo cubriera.
   *
   * ⛔ NO setear `A2A_SELF_HOSTS` en este `it`: con la env puesta pasa también sin
   * el fix y deja de medir nada.
   */
  it('T-L1-3c (AC-4, CD-3): SIN las dos envs, el `Host` entrante corta antes del débito', async () => {
    expect(process.env.A2A_SELF_HOSTS).toBeUndefined();
    expect(process.env.BASE_URL).toBeUndefined();
    const selfAgent = makeAgent({
      slug: 'self-loop',
      id: 'id-self',
      invokeUrl: `https://${SELF}/compose`,
    });
    withAgents([selfAgent]);
    vi.mocked(discoveryService.getAgent).mockResolvedValue(selfAgent);

    const result = await orchestrateService.orchestrate(
      {
        goal: 'multi-step pipeline',
        budget: 5.0,
        maxAgents: 1,
        scopingKeyRow: makeKeyRow(),
        chainId: CHAIN_ID,
        // Lo único que cambia: el route pasa el `Host` de la petición.
        selfHostHint: SELF,
      },
      'orch-loop-1c',
    );

    // ── EL DINERO PRIMERO ──────────────────────────────────────────────────
    expect(mockDebit).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.pipeline.errorCode).toBe(CONTRACTING_LOOP_DETECTED);
  });

  /**
   * La OTRA arista del Sitio 2 que el CR marcó sin cubrir (CR/BLQ-BAJO-3): el
   * `await resolveAgentDestination` del guard no está en ningún `try`. La decisión
   * es FAIL-CLOSED y ahora está escrita en el código; esto la mide.
   *
   * Lo que importa no es el status —el route lo convierte en 5xx— sino que el
   * fallo ocurra con CERO plata movida y CERO invocación saliente. Un guard que
   * ante un blip de DB siguiera de largo estaría ejecutando el pipeline sin saber
   * si un destino somos nosotros.
   */
  it('T-L1-3d: si el lookup del guard TIRA, no se debita ni se emite nada (fail-closed)', async () => {
    const agent = makeAgent({ slug: 'a1', id: 'id1' });
    withAgents([agent]);
    vi.mocked(discoveryService.getAgent).mockRejectedValue(
      new Error('supabase unavailable'),
    );

    await expect(
      orchestrateService.orchestrate(
        {
          goal: 'multi-step pipeline',
          budget: 5.0,
          maxAgents: 1,
          scopingKeyRow: makeKeyRow(),
          chainId: CHAIN_ID,
          selfHostHint: SELF,
        },
        'orch-loop-1d',
      ),
    ).rejects.toThrow('supabase unavailable');

    expect(mockDebit).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('T-L1+8 (AC-8, CD-7): plan de agentes AJENOS → corre y SÍ debita', async () => {
    // El gemelo positivo. Sin esto, los dos de arriba no distinguen "el guard
    // corta el bucle" de "rompí /orchestrate".
    process.env.A2A_SELF_HOSTS = SELF;
    const a1 = makeAgent({ slug: 'a1', id: 'id1', priceUsdc: 0.01 });
    const a2 = makeAgent({ slug: 'a2', id: 'id2', priceUsdc: 0.02 });
    withAgents([a1, a2]);
    vi.mocked(discoveryService.getAgent).mockImplementation(
      async (slug: string) => (slug === 'a1' ? a1 : slug === 'a2' ? a2 : null),
    );

    const result = await orchestrateService.orchestrate(
      {
        goal: 'multi-step pipeline',
        budget: 5.0,
        maxAgents: 2,
        scopingKeyRow: makeKeyRow(),
        chainId: CHAIN_ID,
      },
      'orch-loop-3',
    );

    expect(result.pipeline.success).toBe(true);
    expect(result.pipeline.errorCode).toBeUndefined();
    // step-0 del service + step 1 de compose = 2 débitos.
    expect(mockDebit).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('T-L1+9 (AC-8): SIN identidad configurada NI hint, /orchestrate corre igual y no hace lookups extra', async () => {
    // El `selfHosts.length > 0` de adelante del guard deja el camino
    // byte-idéntico al de hoy cuando no hay NADA de identidad: ni un lookup de más.
    //
    // ⚠️ Desde el fix-pack (AR/CR BLQ-MED-1) esta rama ya NO es el camino HTTP: los
    // routes pasan `selfHostHint`. ⛔ "Los routes" es un CONJUNTO DE CALL-SITES y
    // enumeró mal una vez: `POST /agents/links/:token/redeem` entra por HTTP y no
    // bajaba el hint (AR-it2/BLQ-MED-1). Hoy lo enumera `T-HINT-CALLSITES`
    // (`src/lib/contracting-chain.test.ts`), que se cae cuando aparece uno nuevo.
    // Lo que este `it` congela hoy es el camino NO-HTTP — el tool MCP
    // (`src/mcp/tools/orchestrate.ts`) y `services/inbound-task.ts`, que llaman al
    // service sin `FastifyRequest` y por lo tanto sin `Host` que pasar. ⛔ Para
    // ESOS dos caminos el guard sigue dependiendo de `BASE_URL`/`A2A_SELF_HOSTS`, y
    // eso es residual declarado, no cobertura.
    const a1 = makeAgent({ slug: 'a1', id: 'id1', priceUsdc: 0.01 });
    withAgents([a1]);
    vi.mocked(discoveryService.getAgent).mockResolvedValue(null);

    const result = await orchestrateService.orchestrate(
      {
        goal: 'multi-step pipeline',
        budget: 5.0,
        maxAgents: 1,
        scopingKeyRow: makeKeyRow(),
        chainId: CHAIN_ID,
      },
      'orch-loop-4',
    );

    expect(result.pipeline.success).toBe(true);
    // Sin identidad, el guard no llamó a `resolveAgentDestination` ni una vez:
    // `getAgent` sólo lo invoca el camino de siempre (resolveAgent de compose).
    expect(mockDebit).toHaveBeenCalledTimes(1);
  });
});
