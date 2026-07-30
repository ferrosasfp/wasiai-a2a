/**
 * HU-306 — el pipeline falló DESPUÉS de que alguien ya cobró on-chain.
 *
 * QUÉ SE AFIRMA ACÁ, Y QUÉ NO. Estos tests no miran "se llamó al spy": miran el EFECTO
 * sobre plata — cuánto se debitó, a qué destino, cuántas veces, y qué queda escrito de
 * forma durable cuando el dinero ya se fue y no vuelve. Un rojo se lee como una de estas
 * frases:
 *   · "hubo un pago varado y no quedó registrado en ningún lado";
 *   · "se registró un residuo donde nadie había pagado";
 *   · "un agente de la casa se cobra distinto que uno de tercero";
 *   · "anotar el residuo cambió el resultado que ve el caller".
 *
 * El harness (mocks + fixtures) es el de `compose.test.ts`, a propósito: son el mismo
 * money-path y dos dobles distintos del mismo servicio divergen.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { A2AAgentKeyRow, Agent } from '../types/index.js';

const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({
  getLogger: () => logSpy,
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
const mockSign = vi.fn();
const mockSettle = vi.fn();
vi.mock('../adapters/registry.js', () => ({
  getPaymentAdapter: (..._a: unknown[]) => ({
    sign: mockSign,
    settle: mockSettle,
    supportedTokens: [{ symbol: 'PYUSD', address: '0x0', decimals: 18 }],
  }),
}));
const mockVerifySettle = vi.fn().mockResolvedValue({ ok: true });
vi.mock('../adapters/settle-verifier.js', () => ({
  verifyDefaultChainSettle: (...a: unknown[]) => mockVerifySettle(...a),
}));
vi.mock('./discovery.js', () => ({
  discoveryService: { getAgent: vi.fn(), discover: vi.fn() },
}));
vi.mock('./event.js', () => ({
  eventService: { track: vi.fn().mockResolvedValue({}) },
}));
const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.stubGlobal('fetch', mockFetch);
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: mockFetch };
});
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
// ⚠️ Factory SIN `importOriginal`: reemplaza el módulo COMPLETO (mismo motivo y misma
// trampa que en `compose.test.ts`). Por eso la aritmética de HU-306 vive en el leaf
// `lib/stranded-payment.js`, que NADIE mockea.
vi.mock('../lib/downstream-payment.js', () => ({
  signAndSettleDownstream: vi.fn().mockResolvedValue(null),
}));
/**
 * ⚠️ PUNTO CIEGO QUE ESTE MOCK EXISTE PARA ABRIR (fix-pack AR BLOQUEANTE).
 *
 * `getStepGasOverheadUsd` FALLA-CERRADO Y TIRA en mainnet cuando no hay ni pin de env ni
 * estimación viva (`lib/gas-overhead.ts`, `GasOverheadUnavailableError`). Pero bajo test
 * `isProductionEnv()` es `false`, así que la función devuelve 0 y NUNCA tira: sin este
 * mock, el escenario "el pipeline LANZA después de que un step ya pagó" era
 * INALCANZABLE desde la suite. No es que faltara un test — no se podía escribir.
 *
 * Default 0 = comportamiento de siempre; sólo el test del throw lo cambia.
 */
const mockGasOverhead = vi.hoisted(() => vi.fn());
vi.mock('../lib/gas-overhead.js', () => ({
  getStepGasOverheadUsd: (...a: unknown[]) => mockGasOverhead(...a),
}));

import { signAndSettleDownstream } from '../lib/downstream-payment.js';
import { COMPOSE_STRANDED_PAYMENT_EVENT } from '../lib/stranded-payment.js';
import { budgetService } from './budget.js';
import { composeService } from './compose.js';
import { discoveryService } from './discovery.js';
import { eventService } from './event.js';
import { registryService } from './registry.js';
import { normalizeDestination } from './spend-policy.js';

const mockDownstream = vi.mocked(signAndSettleDownstream);
const mockDebit = vi.mocked(budgetService.debit);
const mockCredit = vi.mocked(budgetService.credit);
const mockCreditWithDest = vi.mocked(budgetService.creditWithDest);
const mockTrack = vi.mocked(eventService.track);

const EVM_PAYTO = `0x${'B'.repeat(40)}`;
const CHAIN_ID = 2368;

function makeAgent(o: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    slug: 'test-agent',
    description: 'A test agent',
    capabilities: ['test'],
    priceUsdc: 0,
    registry: 'test-registry',
    registry_id: 'test-registry',
    invokeUrl: 'https://example.com/invoke',
    invocationNote: 'Use POST /compose or POST /orchestrate on the gateway.',
    verified: false,
    status: 'active',
    // Con `priceUsdc > 0` el leg inbound firma y settlea, y `invokeAgent` EXIGE un payTo
    // (tira `No payTo address` sin él). Va en el fixture base para que un test de dinero
    // no falle por una razón que no es la que está probando.
    metadata: { payTo: EVM_PAYTO },
    ...o,
  };
}

function makeKeyRow(overrides: Partial<A2AAgentKeyRow> = {}): A2AAgentKeyRow {
  return {
    id: 'key-id-test',
    owner_ref: 'owner-test',
    key_hash: 'hash',
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

/** Resuelve cada step por slug (el bridge re-resuelve el step siguiente — B7). */
function wireAgents(...agents: Agent[]) {
  const bySlug = new Map(agents.map((a) => [a.slug, a]));
  vi.mocked(discoveryService.getAgent).mockImplementation(
    async (slug: string) => bySlug.get(slug) ?? null,
  );
}

function mockFetchOk(data: unknown = { result: 'ok' }) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => data,
  });
}
function mockFetchError(status: number, body = '{"error":"fail"}') {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    json: async () => JSON.parse(body),
    text: async () => body,
  });
}

/** Los `track()` de residuo emitidos (la pregunta de esta HU). */
function strandedEvents() {
  return mockTrack.mock.calls
    .map((c) => c[0])
    .filter((e) => e.eventType === COMPOSE_STRANDED_PAYMENT_EVENT);
}
/** Los `compose_step` emitidos (telemetría de siempre). */
function stepEvents() {
  return mockTrack.mock.calls
    .map((c) => c[0])
    .filter((e) => e.eventType === 'compose_step' || e.eventType === undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  // ⚠️ `clearAllMocks` borra el HISTORIAL, no las implementaciones: una cola
  // `mockResolvedValueOnce` que un test no consumió (porque falló antes) se la comería
  // el test SIGUIENTE, y ese test pasaría o fallaría por el fixture de otro. Los mocks
  // con cola se resetean de verdad.
  mockFetch.mockReset();
  mockSign.mockReset();
  mockSettle.mockReset();
  mockDownstream.mockReset();
  mockVerifySettle.mockResolvedValue({ ok: true });
  vi.mocked(registryService.getEnabled).mockResolvedValue([]);
  vi.mocked(discoveryService.getAgent).mockResolvedValue(null);
  vi.mocked(discoveryService.discover).mockResolvedValue({
    agents: [],
    total: 0,
    registries: [],
    sources: [],
    catalogStatus: 'complete',
  });
  mockDownstream.mockResolvedValue(null);
  mockGasOverhead.mockResolvedValue(0); // testnet / sin config: el valor de siempre
  mockDebit.mockResolvedValue({ success: true });
  mockCredit.mockResolvedValue({ success: true, reverted: true });
  mockCreditWithDest.mockResolvedValue({ success: true, reverted: true });
  mockTrack.mockResolvedValue({} as never);
});

// ─── AC-2 / AC-8: ¿se registra el residuo, y sólo cuando lo hay? ───────────

describe('HU-306 · el pago varado queda registrado (AC-2)', () => {
  it('T-STRAND-EMIT-01: step 0 pagó downstream y el step 1 falla ⟹ EXACTAMENTE un evento de residuo', async () => {
    const a1 = makeAgent({ slug: 'a1' });
    const a2 = makeAgent({ slug: 'a2', id: 'agent-2' });
    wireAgents(a1, a2);
    // El step 0 settlea downstream de verdad (hash + monto atómico); el 1 no llega.
    mockDownstream.mockResolvedValueOnce({
      txHash: '0xDOWN0',
      blockNumber: 7,
      settledAmount: '20000',
    });
    mockFetchOk({ result: 'step0' });
    mockFetchError(500);

    const result = await composeService.compose({
      steps: [
        { agent: 'a1', input: {} },
        { agent: 'a2', input: {} },
      ],
    });

    expect(result.success).toBe(false);
    // La premisa del test: el step 0 REALMENTE pagó on-chain. Sin esto, el resto
    // afirmaría sobre un escenario que no está armado (CD-22).
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.downstreamTxHash).toBe('0xDOWN0');

    const stranded = strandedEvents();
    expect(stranded).toHaveLength(1);
    expect(stranded[0]!.status).toBe('failed');
    expect(stranded[0]!.txHash).toBe('0xDOWN0');
  });

  it('T-STRAND-EMIT-05: el pipeline que LANZA después de un pago también registra (AR BLOQUEANTE)', async () => {
    // El caso que la HU se perdía entera: `executePipeline` corre trabajo real FUERA del
    // try por-step (`resolveAgent`, `getStepGasOverheadUsd`, `budgetService.debit`), y
    // `getStepGasOverheadUsd` TIRA a propósito en mainnet sin configurar. Con el throw
    // propagándose, el registro del residuo nunca corría: plata afuera, cero eventos,
    // cero filas, cero aporte a la alerta.
    const a1 = makeAgent({ slug: 'g1' });
    const a2 = makeAgent({ slug: 'g2', id: 'agent-2' });
    wireAgents(a1, a2);
    mockDownstream.mockResolvedValueOnce({
      txHash: '0xDOWN0',
      blockNumber: 7,
      settledAmount: '20000',
    });
    mockFetchOk({ result: 'step0' });
    // El step 0 resuelve su overhead normal; el step 1 se topa con el fail-closed.
    mockGasOverhead
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(
        new Error('gas overhead unavailable for chain 43114'),
      );

    await expect(
      composeService.compose({
        steps: [
          { agent: 'g1', input: {} },
          { agent: 'g2', input: {} },
        ],
        scopingKeyRow: makeKeyRow(),
        chainId: CHAIN_ID,
      }),
      // El error SIGUE PROPAGÁNDOSE tal cual: el registro observa, no cambia el contrato
      // con el caller (que hoy mapea ese throw a su propia respuesta).
    ).rejects.toThrow('gas overhead unavailable');

    // …y el pago del step 0 quedó registrado igual.
    const stranded = strandedEvents();
    expect(stranded).toHaveLength(1);
    expect(stranded[0]!.txHash).toBe('0xDOWN0');
    const md = stranded[0]!.metadata as Record<string, unknown>;
    expect(md.failed_step_index).toBe(1);
    expect(md.paid_steps as unknown[]).toHaveLength(1);
    // el mensaje del error que rompió el run queda en la fila, para el que reconcilia
    expect(md.error).toContain('gas overhead unavailable');
  });

  it('T-STRAND-EMIT-05b (control): el MISMO fixture fallando por la vía normal registra igual', async () => {
    // Control del test de arriba: si este no pasara, la diferencia entre los dos no
    // sería el camino del throw sino el fixture.
    const a1 = makeAgent({ slug: 'g1' });
    const a2 = makeAgent({ slug: 'g2', id: 'agent-2' });
    wireAgents(a1, a2);
    mockDownstream.mockResolvedValueOnce({
      txHash: '0xDOWN0',
      blockNumber: 7,
      settledAmount: '20000',
    });
    mockFetchOk({ result: 'step0' });
    mockFetchError(500);

    const result = await composeService.compose({
      steps: [
        { agent: 'g1', input: {} },
        { agent: 'g2', input: {} },
      ],
      scopingKeyRow: makeKeyRow(),
      chainId: CHAIN_ID,
    });

    expect(result.success).toBe(false);
    expect(strandedEvents()).toHaveLength(1);
  });

  it('T-STRAND-EMIT-06: si LANZA sin que nadie hubiera pagado, no se registra nada', async () => {
    // La otra cara de AC-10: el throw no puede inventar un residuo donde no lo hay.
    const a1 = makeAgent({ slug: 'h1' });
    wireAgents(a1);
    mockGasOverhead.mockRejectedValueOnce(
      new Error('gas overhead unavailable'),
    );

    await expect(
      composeService.compose({
        steps: [{ agent: 'h1', input: {} }],
        scopingKeyRow: makeKeyRow(),
        chainId: CHAIN_ID,
      }),
    ).rejects.toThrow('gas overhead unavailable');

    expect(strandedEvents()).toHaveLength(0);
  });

  it('T-STRAND-EMIT-02: falla el step 0 y NADIE pagó ⟹ CERO eventos de residuo', async () => {
    const a1 = makeAgent({ slug: 'solo' });
    wireAgents(a1);
    mockFetchError(500);

    const result = await composeService.compose({
      steps: [{ agent: 'solo', input: {} }],
    });

    expect(result.success).toBe(false);
    expect(result.steps).toHaveLength(0);
    expect(strandedEvents()).toHaveLength(0);
  });

  it('T-STRAND-EMIT-03: pipeline exitoso ⟹ CERO eventos de residuo', async () => {
    const a1 = makeAgent({ slug: 'ok1' });
    wireAgents(a1);
    mockDownstream.mockResolvedValueOnce({
      txHash: '0xOK',
      blockNumber: 1,
      settledAmount: '10000',
    });
    mockFetchOk();

    const result = await composeService.compose({
      steps: [{ agent: 'ok1', input: {} }],
    });

    expect(result.success).toBe(true);
    expect(strandedEvents()).toHaveLength(0);
  });

  it('T-STRAND-EMIT-04: el corte por DÉBITO FALLIDO (un return, no una excepción) también registra', async () => {
    // Este es el test que justifica la envoltura: el pipeline no siempre sale por un
    // throw. Acá sale por un `return { success:false }` en medio del loop, y el residuo
    // se registra igual porque el choke point mira el RESULTADO, no el camino.
    const a1 = makeAgent({ slug: 'p1', priceUsdc: 0.02 });
    const a2 = makeAgent({ slug: 'p2', id: 'agent-2', priceUsdc: 0.03 });
    wireAgents(a1, a2);
    mockDownstream.mockResolvedValueOnce({
      txHash: '0xPAID0',
      blockNumber: 3,
      settledAmount: '20000',
    });
    mockSign.mockResolvedValue({
      xPaymentHeader: 'h',
      paymentRequest: {
        authorization: {
          from: '0xA',
          to: EVM_PAYTO,
          value: '1',
          validAfter: '0',
          validBefore: '9999999999',
          nonce: '0x1',
        },
        signature: '0xSIG',
        network: 'eip155:2368',
      },
    });
    mockSettle.mockResolvedValue({ success: true, txHash: '0xIN0' });
    mockFetchOk({ result: 'step0' });
    // El step 1 nunca se invoca: su débito falla ANTES.
    mockDebit.mockResolvedValueOnce({
      success: false,
      error: 'insufficient budget',
    });

    const result = await composeService.compose({
      steps: [
        { agent: 'p1', input: {} },
        { agent: 'p2', input: {} },
      ],
      scopingKeyRow: makeKeyRow(),
      chainId: CHAIN_ID,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('debit failed');
    expect(strandedEvents()).toHaveLength(1);
  });
});

// ─── AC-3: el registro alcanza para reconciliar ───────────────────────────

describe('HU-306 · qué dice la anotación durable (AC-3)', () => {
  it('T-STRAND-FIELDS: run, step que falló y los steps que pagaron, con el monto atómico VERBATIM', async () => {
    const a1 = makeAgent({
      slug: 'pagador',
      priceUsdc: 0.02,
      // Cadena EVM a propósito: con una cadena declarada NO-EVM el leg inbound no firma
      // (`declaredVmUnsupported` en `invokeAgent`) y este step tendría una sola
      // evidencia. Acá se quieren LAS DOS, para fijar cuál manda en `tx_hash`.
      payment: {
        method: 'x402',
        chain: 'avalanche',
        contract: EVM_PAYTO,
      },
    });
    const a2 = makeAgent({ slug: 'roto', id: 'agent-2' });
    wireAgents(a1, a2);
    mockDownstream.mockResolvedValueOnce({
      txHash: '0xDOWN0',
      blockNumber: 9,
      settledAmount: '20000',
    });
    mockSign.mockResolvedValue({
      xPaymentHeader: 'h',
      paymentRequest: {
        authorization: {
          from: '0xA',
          to: EVM_PAYTO,
          value: '1',
          validAfter: '0',
          validBefore: '9999999999',
          nonce: '0x1',
        },
        signature: '0xSIG',
        network: 'eip155:2368',
      },
    });
    mockSettle.mockResolvedValue({ success: true, txHash: '0xIN0' });
    mockFetchOk({ result: 'step0' });
    mockFetchError(500);

    await composeService.compose({
      steps: [
        { agent: 'pagador', input: {} },
        { agent: 'roto', input: {} },
      ],
    });

    const [ev] = strandedEvents();
    expect(ev).toBeDefined();
    const md = ev!.metadata as Record<string, unknown>;
    expect(typeof md.compose_run_id).toBe('string');
    expect(md.failed_step_index).toBe(1);
    const paid = md.paid_steps as Record<string, unknown>[];
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({
      step: 0,
      agent_slug: 'pagador',
      registry: 'test-registry',
      chain: 'avalanche',
      cost_usdc: 0.02,
      settled_atomic: '20000', // atómico, SIN convertir a USD
      // con las dos evidencias manda el hash DOWNSTREAM (el pago AL agente); el inbound
      // del mismo step queda igual de recuperable por `compose_run_id`.
      tx_hash: '0xDOWN0',
      evidence: 'both',
    });
    // EL step que falló NO está en la lista: su residuo, si lo hubiera, es la otra
    // pregunta (`compose_settle_unknown`). Incluirlo inflaría la exposición reportada.
    expect(paid.some((p) => p.step === 1)).toBe(false);
    expect(md.stranded_usd).toBe(ev!.costUsdc);
  });

  it('T-STRAND-JOIN: el compose_step del MISMO run lleva ese run id y su agent_id', async () => {
    const a1 = makeAgent({ slug: 'j1' });
    const a2 = makeAgent({ slug: 'j2', id: 'agent-2' });
    wireAgents(a1, a2);
    mockDownstream.mockResolvedValueOnce({
      txHash: '0xJOIN',
      blockNumber: 1,
      settledAmount: '10000',
    });
    mockFetchOk();
    mockFetchError(500);

    await composeService.compose({
      steps: [
        { agent: 'j1', input: {} },
        { agent: 'j2', input: {} },
      ],
    });

    const [stranded] = strandedEvents();
    const runId = (stranded!.metadata as Record<string, unknown>)
      .compose_run_id as string;
    expect(runId).toBeTruthy();

    // La fila del residuo NO nombra agente a propósito; el culpable se recupera acá.
    const success = stepEvents().find((e) => e.status === 'success');
    expect(success).toBeDefined();
    expect((success!.metadata as Record<string, unknown>).compose_run_id).toBe(
      runId,
    );
    expect(success!.agentId).toBe('j1');
    expect((success!.metadata as Record<string, unknown>).step).toBe(0);

    // …y el evento del step que ROMPIÓ el pipeline lleva el mismo id y su agente.
    const failed = stepEvents().find((e) => e.status === 'failed');
    expect(failed).toBeDefined();
    expect((failed!.metadata as Record<string, unknown>).compose_run_id).toBe(
      runId,
    );
    expect(failed!.agentId).toBe('j2');
    expect((failed!.metadata as Record<string, unknown>).step).toBe(1);
  });

  it('T-STRAND-INBOUND: un step pagado SÓLO por el settle inbound también cuenta (AC-8)', async () => {
    // Camino x402 anónimo: no hay débito per-step, y el hash inbound ES un pago real al
    // payTo del agente. Contar sólo el downstream subestimaría el residuo justo acá.
    const a1 = makeAgent({
      slug: 'inbound-only',
      priceUsdc: 0.05,
      metadata: { payTo: EVM_PAYTO },
    });
    const a2 = makeAgent({ slug: 'siguiente', id: 'agent-2' });
    wireAgents(a1, a2);
    mockDownstream.mockResolvedValue(null); // el leg downstream NO settleó
    mockSign.mockResolvedValueOnce({
      xPaymentHeader: 'h',
      paymentRequest: {
        authorization: {
          from: '0xA',
          to: EVM_PAYTO,
          value: '50000',
          validAfter: '0',
          validBefore: '9999999999',
          nonce: '0x9',
        },
        signature: '0xSIG',
        network: 'eip155:2368',
      },
    });
    mockSettle.mockResolvedValueOnce({ success: true, txHash: '0xINBOUND' });
    mockFetchOk({ result: 'step0' });
    mockFetchError(500);

    const result = await composeService.compose({
      steps: [
        { agent: 'inbound-only', input: {} },
        { agent: 'siguiente', input: {} },
      ],
    });

    // Premisa: hubo hash inbound y NO hubo downstream.
    expect(result.steps[0]!.txHash).toBe('0xINBOUND');
    expect(result.steps[0]!.downstreamTxHash).toBeUndefined();

    const [ev] = strandedEvents();
    expect(ev).toBeDefined();
    const paid = (ev!.metadata as Record<string, unknown>).paid_steps as Record<
      string,
      unknown
    >[];
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({
      evidence: 'inbound',
      tx_hash: '0xINBOUND',
    });
  });
});

// ─── AC-9 / AC-10: anotar el residuo no puede cambiar nada ────────────────

describe('HU-306 · observar no cambia lo observado (AC-9, AC-10)', () => {
  it('T-STRAND-TRACK-THROWS: si no se puede persistir, el caller recibe el MISMO resultado', async () => {
    const a1 = makeAgent({ slug: 't1' });
    const a2 = makeAgent({ slug: 't2', id: 'agent-2' });
    wireAgents(a1, a2);
    mockDownstream.mockResolvedValueOnce({
      txHash: '0xTX',
      blockNumber: 1,
      settledAmount: '10000',
    });
    mockFetchOk();
    mockFetchError(500);
    // TODOS los track rechazan (el de telemetría y el del residuo).
    mockTrack.mockRejectedValue(new Error('supabase down'));

    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    let result: Awaited<ReturnType<typeof composeService.compose>>;
    try {
      result = await composeService.compose({
        steps: [
          { agent: 't1', input: {} },
          { agent: 't2', input: {} },
        ],
      });
      // una vuelta del event loop para que una rejection sin manejar aflore
      await new Promise((r) => setImmediate(r));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(unhandled).toHaveLength(0);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Step 1 failed');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.downstreamTxHash).toBe('0xTX');
    // el fallo quedó en el log, que es el único registro que queda
    expect(logSpy.error).toHaveBeenCalled();
  });

  it('T-STRAND-TRACK-THROWS-SYNC: la telemetría del residuo NO puede reemplazar el error del caller (AR MR-4b)', async () => {
    // POR QUÉ ESTE TEST EXISTE Y EL DE ARRIBA NO ALCANZA. `T-STRAND-TRACK-THROWS` usa
    // `mockRejectedValue`, o sea una PROMESA rechazada, que se la come el `.catch()`
    // interno: el `try` externo de `recordStrandedRunIfAny` nunca se ejercita. Con
    // `track` lanzando SINCRÓNICAMENTE, en cambio, el `.catch()` ni llega a existir y la
    // excepción sube por el camino del throw — donde, sin el blindaje, REEMPLAZARÍA el
    // error original del pipeline por uno de telemetría. Es el daño exacto que el
    // docstring de esa función dice estar evitando, en el camino del dinero.
    const a1 = makeAgent({ slug: 's1' });
    const a2 = makeAgent({ slug: 's2', id: 'agent-2' });
    wireAgents(a1, a2);
    mockDownstream.mockResolvedValueOnce({
      txHash: '0xPAGADO',
      blockNumber: 3,
      settledAmount: '20000',
    });
    mockFetchOk({ result: 'step0' });
    // El pipeline se va por excepción DESPUÉS de que el step 0 pagó.
    mockGasOverhead
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(new Error('GAS_ORIGINAL'));
    // ⚠️ EL DETALLE QUE HACE FUNCIONAR EL ESCENARIO: el track del step 0 tiene que
    // RESOLVER; sólo el SEGUNDO —el del residuo— lanza, y lanza sincrónicamente.
    mockTrack.mockResolvedValueOnce({} as never).mockImplementationOnce(() => {
      throw new Error('TELEMETRIA_SINCRONA');
    });

    let capturado: unknown;
    try {
      await composeService.compose({
        steps: [
          { agent: 's1', input: {} },
          { agent: 's2', input: {} },
        ],
        scopingKeyRow: makeKeyRow(),
        chainId: CHAIN_ID,
      });
      throw new Error('debía lanzar');
    } catch (err) {
      capturado = err;
    }

    // El caller recibe SU error, no el de la telemetría.
    expect((capturado as Error).message).toContain('GAS_ORIGINAL');
    expect((capturado as Error).message).not.toContain('TELEMETRIA_SINCRONA');
    // …y el fallo de telemetría quedó en el log, que es donde tiene que quedar.
    expect(logSpy.error).toHaveBeenCalled();
    // Premisa del escenario: el track del residuo se INTENTÓ (si no, el test estaría
    // verde por no haber llegado nunca a la línea que se quiere proteger).
    expect(mockTrack).toHaveBeenCalledTimes(2);
  });

  it('T-STRAND-BYTE-IDENTICO: un pipeline exitoso emite lo MISMO que antes de la HU (CD-19)', async () => {
    const a1 = makeAgent({ slug: 'b1', priceUsdc: 0.02 });
    const a2 = makeAgent({ slug: 'b2', id: 'agent-2', priceUsdc: 0.03 });
    wireAgents(a1, a2);
    mockSign.mockResolvedValue({
      xPaymentHeader: 'h',
      paymentRequest: {
        authorization: {
          from: '0xA',
          to: EVM_PAYTO,
          value: '1',
          validAfter: '0',
          validBefore: '9999999999',
          nonce: '0x1',
        },
        signature: '0xSIG',
        network: 'eip155:2368',
      },
    });
    mockSettle.mockResolvedValue({ success: true, txHash: '0xIN' });
    mockFetchOk();
    mockFetchOk();

    const result = await composeService.compose({
      steps: [
        { agent: 'b1', input: {} },
        { agent: 'b2', input: {} },
      ],
      scopingKeyRow: makeKeyRow(),
      chainId: CHAIN_ID,
    });

    expect(result.success).toBe(true);
    // Se cuenta la I/O, no sólo el efecto: exactamente un evento por step y ninguno más.
    expect(mockTrack).toHaveBeenCalledTimes(2);
    expect(strandedEvents()).toHaveLength(0);
    // el débito per-step sigue siendo uno solo (el step 0 lo cobra el middleware).
    expect(mockDebit).toHaveBeenCalledTimes(1);
  });
});

// ─── AC-1: el techo por pipeline (entregado y APAGADO) ────────────────────

describe('HU-306 · el techo de exposición por pipeline (AC-1)', () => {
  const CEILING_ENV = 'PIPELINE_EXPOSURE_CEILING_USD';

  afterEach(() => {
    delete process.env[CEILING_ENV];
  });

  it('T-CEILING-01: con el techo configurado, el step que lo excedería NO debita y NO invoca', async () => {
    // Lo que se mide es DINERO Y LLAMADAS, no el status: el guard corta ANTES del débito
    // y ANTES del invoke, así que ni se cobra ni se le pide nada al agente.
    process.env[CEILING_ENV] = '0.05';
    const a1 = makeAgent({ slug: 'c1', priceUsdc: 0.02 });
    const a2 = makeAgent({ slug: 'c2', id: 'agent-2', priceUsdc: 0.09 });
    wireAgents(a1, a2);
    mockSign.mockResolvedValue({
      xPaymentHeader: 'h',
      paymentRequest: {
        authorization: {
          from: '0xA',
          to: EVM_PAYTO,
          value: '1',
          validAfter: '0',
          validBefore: '9999999999',
          nonce: '0x1',
        },
        signature: '0xSIG',
        network: 'eip155:2368',
      },
    });
    mockSettle.mockResolvedValue({ success: true, txHash: '0xIN' });
    mockFetchOk({ result: 'step0' }); // sólo el step 0 llega a invocarse

    const result = await composeService.compose({
      steps: [
        { agent: 'c1', input: {} },
        { agent: 'c2', input: {} },
      ],
      scopingKeyRow: makeKeyRow(),
      chainId: CHAIN_ID,
    });

    // ⚠️ ORDEN DELIBERADO (fix-pack CR MENOR-5): las aserciones de DINERO van PRIMERO.
    // Con el assert del mensaje adelante, un mutante que rompe el techo mataba el test
    // por el texto del error y las dos afirmaciones que de verdad importan —que no se
    // debitó y que no se invocó— NUNCA llegaban a ejecutarse. Un test de dinero tiene
    // que morir en la línea del dinero.
    expect(mockDebit).not.toHaveBeenCalled();
    // una sola llamada saliente, la del step 0: el step 1 no se invocó
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.steps).toHaveLength(1);
    expect(result.error).toContain('gateway pipeline exposure ceiling');
  });

  it('T-CEILING-02: SIN el techo configurado, el pipeline caro corre y el mensaje es el de siempre', async () => {
    // El techo se entrega SIN SETEAR a propósito. Con la env ausente, el comportamiento y
    // el string del error son los de antes de esta HU, carácter por carácter.
    const a1 = makeAgent({ slug: 'd1', priceUsdc: 0.6 });
    const a2 = makeAgent({ slug: 'd2', id: 'agent-2', priceUsdc: 0.6 });
    wireAgents(a1, a2);
    mockSign.mockResolvedValue({
      xPaymentHeader: 'h',
      paymentRequest: {
        authorization: {
          from: '0xA',
          to: EVM_PAYTO,
          value: '1',
          validAfter: '0',
          validBefore: '9999999999',
          nonce: '0x1',
        },
        signature: '0xSIG',
        network: 'eip155:2368',
      },
    });
    mockSettle.mockResolvedValue({ success: true, txHash: '0xIN' });
    mockFetchOk();
    mockFetchOk();

    // (a) sin `maxBudget` NI techo: el pipeline caro corre entero.
    const libre = await composeService.compose({
      steps: [
        { agent: 'd1', input: {} },
        { agent: 'd2', input: {} },
      ],
    });
    expect(libre.success).toBe(true);

    // (b) con `maxBudget` y SIN techo: el mensaje es EXACTAMENTE el histórico — sin la
    //     coletilla del techo, que es lo que distingue quién ató el presupuesto.
    mockFetchOk();
    const acotado = await composeService.compose({
      steps: [
        { agent: 'd1', input: {} },
        { agent: 'd2', input: {} },
      ],
      maxBudget: 1.0,
    });
    expect(acotado.success).toBe(false);
    expect(acotado.error).toBe('Budget exceeded: would need 1.2, max is 1');
    expect(acotado.error).not.toContain('ceiling');
  });

  it('T-CEILING-02b: `maxBudget: 0` sigue significando "sin límite"', async () => {
    const a1 = makeAgent({ slug: 'e1', priceUsdc: 5 });
    wireAgents(a1);
    mockSign.mockResolvedValue({
      xPaymentHeader: 'h',
      paymentRequest: {
        authorization: {
          from: '0xA',
          to: EVM_PAYTO,
          value: '1',
          validAfter: '0',
          validBefore: '9999999999',
          nonce: '0x1',
        },
        signature: '0xSIG',
        network: 'eip155:2368',
      },
    });
    mockSettle.mockResolvedValue({ success: true, txHash: '0xIN' });
    mockFetchOk();

    const result = await composeService.compose({
      steps: [{ agent: 'e1', input: {} }],
      maxBudget: 0,
    });

    expect(result.success).toBe(true);
  });
});

// ─── AC-6 / AC-7: neutralidad y solo-lectura ──────────────────────────────

describe('HU-306 · el cobro no distingue de quién es el agente (AC-6)', () => {
  it('T-NEUTRALITY-01: agente de la casa y de tercero ⟹ MISMO débito, misma cantidad, mismo destino canónico', async () => {
    async function runWith(step1: Agent): Promise<{
      calls: unknown[][];
      dest: unknown;
    }> {
      vi.clearAllMocks();
      mockDebit.mockResolvedValue({ success: true });
      mockCredit.mockResolvedValue({ success: true, reverted: true });
      mockCreditWithDest.mockResolvedValue({ success: true, reverted: true });
      mockTrack.mockResolvedValue({} as never);
      mockDownstream.mockResolvedValue(null);
      vi.mocked(registryService.getEnabled).mockResolvedValue([]);
      vi.mocked(discoveryService.discover).mockResolvedValue({
        agents: [],
        total: 0,
        registries: [],
        sources: [],
        catalogStatus: 'complete',
      });
      const step0 = makeAgent({ slug: 'entrada', priceUsdc: 0.02 });
      wireAgents(step0, step1);
      mockSign.mockResolvedValue({
        xPaymentHeader: 'h',
        paymentRequest: {
          authorization: {
            from: '0xA',
            to: EVM_PAYTO,
            value: '1',
            validAfter: '0',
            validBefore: '9999999999',
            nonce: '0x1',
          },
          signature: '0xSIG',
          network: 'eip155:2368',
        },
      });
      mockSettle.mockResolvedValue({ success: true, txHash: '0xIN' });
      mockFetchOk();
      mockFetchOk();
      await composeService.compose({
        steps: [
          { agent: 'entrada', input: {} },
          { agent: step1.slug, input: {} },
        ],
        scopingKeyRow: makeKeyRow(),
        chainId: CHAIN_ID,
      });
      const calls = mockDebit.mock.calls as unknown[][];
      return { calls, dest: calls[0]?.[5] };
    }

    // Mismo precio, mismo pipeline: lo ÚNICO que cambia es de quién es el agente.
    const casa = makeAgent({
      slug: 'remit-corridor-fx',
      id: 'casa',
      registry: 'wasiai',
      priceUsdc: 0.07,
    });
    const tercero = makeAgent({
      slug: 'third-party-fx',
      id: 'tercero',
      registry: 'otro-registry',
      priceUsdc: 0.07,
    });

    const houseRun = await runWith(casa);
    const thirdRun = await runWith(tercero);

    // (a) misma CANTIDAD de débitos
    expect(houseRun.calls).toHaveLength(1);
    expect(thirdRun.calls).toHaveLength(1);
    // (b) mismo MONTO — el precio del agente, sin recargo ni descuento por dueño
    expect(houseRun.calls[0]![2]).toBe(0.07);
    expect(thirdRun.calls[0]![2]).toBe(thirdRun.calls[0]![2]);
    expect(houseRun.calls[0]![2]).toBe(thirdRun.calls[0]![2]);
    // (c) mismo criterio de DESTINO: `registry/slug` normalizado, sin caso especial.
    //     Los strings difieren porque son agentes distintos; lo que no puede diferir es
    //     la REGLA con que se derivan.
    expect(houseRun.dest).toBe(
      normalizeDestination('wasiai/remit-corridor-fx'),
    );
    expect(thirdRun.dest).toBe(
      normalizeDestination('otro-registry/third-party-fx'),
    );
    // (d) el resto de los argumentos del débito (key, chain, contextos, owner) idénticos
    const stripDest = (c: unknown[]) => c.filter((_, i) => i !== 5);
    expect(stripDest(houseRun.calls[0]!)).toEqual(
      stripDest(thirdRun.calls[0]!),
    );
  });

  it('T-NEUTRALITY-02: el código de producción no tiene saldos, recargas ni liquidación diferida', () => {
    // Guard ESTRUCTURAL contra el pivote de esta HU (el encargo original pedía prepago
    // para los agentes de la casa; se descartó porque sería una ventaja estructural).
    // Idiom del repo: se escanea TODO `src/` y las apariciones históricas quedan en una
    // lista CONGELADA — una nueva, en cualquier archivo, rompe el test.
    const HERE = dirname(fileURLToPath(import.meta.url));
    const SRC = join(HERE, '..');
    const FORBIDDEN = /prepaid|prepay|topup|deferredsettlement/i;
    /**
     * Apariciones PREEXISTENTES, congeladas. Las tres describen la agent key que ya
     * existe (un budget que el CALLER carga para pagarse a sí mismo sus llamadas), no un
     * saldo a favor de un AGENTE ni una liquidación diferida hacia él. Sacar una de acá
     * exige tocar esta lista a mano y justificarlo en la review.
     */
    const FROZEN: ReadonlySet<string> = new Set([
      'routes/compose.ts',
      'middleware/x402.ts',
    ]);

    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '__tests__' || entry.name === 'node_modules')
            continue;
          out.push(...walk(full));
        } else if (
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.test.ts')
        ) {
          out.push(full);
        }
      }
      return out;
    }

    const offenders = walk(SRC)
      .filter((f) => FORBIDDEN.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC.length + 1));

    expect([...offenders].sort()).toEqual([...FROZEN].sort());
  });

  it('T-READONLY-02: registrar un residuo NO mueve un centavo más', async () => {
    const a1 = makeAgent({ slug: 'r1', priceUsdc: 0.02 });
    const a2 = makeAgent({ slug: 'r2', id: 'agent-2', priceUsdc: 0.03 });
    wireAgents(a1, a2);
    mockDownstream.mockResolvedValueOnce({
      txHash: '0xPAID',
      blockNumber: 2,
      settledAmount: '20000',
    });
    mockSign.mockResolvedValue({
      xPaymentHeader: 'h',
      paymentRequest: {
        authorization: {
          from: '0xA',
          to: EVM_PAYTO,
          value: '1',
          validAfter: '0',
          validBefore: '9999999999',
          nonce: '0x1',
        },
        signature: '0xSIG',
        network: 'eip155:2368',
      },
    });
    mockSettle.mockResolvedValue({ success: true, txHash: '0xIN' });
    mockFetchOk();
    mockFetchError(500);

    await composeService.compose({
      steps: [
        { agent: 'r1', input: {} },
        { agent: 'r2', input: {} },
      ],
      scopingKeyRow: makeKeyRow(),
      chainId: CHAIN_ID,
    });

    // Premisa: SÍ se registró un residuo (si no, el test no probaría nada).
    expect(strandedEvents()).toHaveLength(1);
    // El movimiento de dinero es el de siempre: un débito per-step (el del step 1) y su
    // reembolso best-effort porque ese step falló. Ni un crédito extra por el registro.
    expect(mockDebit).toHaveBeenCalledTimes(1);
    expect(
      mockCredit.mock.calls.length + mockCreditWithDest.mock.calls.length,
    ).toBe(1);
  });
});
