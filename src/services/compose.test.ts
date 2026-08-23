/**
 * Tests for Compose Service -- auth headers + x402 payment
 * 9 tests: T-1 through T-9
 */
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { A2AAgentKeyRow, Agent, RegistryConfig } from '../types/index.js';

// compose.ts logs server-side via getLogger('compose'). Mock it so tests can
// assert structured log emission (and the no-secret-leak invariant) without
// spying on console. hoisted so the mock factory can reference it.
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
  // C1 (audit 2026-07-01): compose.ts imports SYSTEM_OWNER_REF to gate the
  // x-a2a-key forward to system-trusted registries only.
  SYSTEM_OWNER_REF: 'system',
}));
// WKH-59 (real-price-debit): mock budget service for per-step debit tests.
// CD-14: tests below use mockResolvedValueOnce, not failNext.
vi.mock('./budget.js', () => ({
  budgetService: {
    debit: vi.fn(),
    credit: vi.fn(),
    creditWithDest: vi.fn(), // WKH-129
    getBalance: vi.fn(),
    registerDeposit: vi.fn(),
    recordSolanaSettleReceipt: vi.fn(), // WKH-234 fix-pack AR-BLQ-1
  },
}));
const mockSign = vi.fn();
const mockSettle = vi.fn();
// WKH-195: supportedTokens seteable por test para variar los decimals del default
// chain (patrón WKH-192 payment-intent.test.ts:29-44). Default 18d modela el
// default chain Kite de HOY → la suite preexistente queda byte-idéntica (CD-4).
const mockSupportedTokens = vi.hoisted(() => ({
  current: [{ symbol: 'PYUSD', address: '0x0', decimals: 18 }] as
    | { symbol: string; address: string; decimals: number }[]
    | undefined,
}));
vi.mock('../adapters/registry.js', () => ({
  getPaymentAdapter: (..._a: unknown[]) => ({
    sign: mockSign,
    settle: mockSettle,
    supportedTokens: mockSupportedTokens.current,
  }),
}));
// TB-01 (audit 2026-06-30): compose now re-verifies the settle on-chain via
// settle-verifier. Mock it to a pass so these tests stay focused on compose
// orchestration (the on-chain re-verification logic is covered in
// settle-verifier.test.ts). `mockVerifySettle` lets a test force a mismatch.
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
// undici-8 migration (#124): `ssrfFetch` calls undici's OWN `fetch` (not
// the Node global) so the undici-8 Agent and the fetch implementation share a
// version. Route BOTH the global stub and undici's `fetch` to the same
// `mockFetch` so the outbound-call assertions still intercept while the real
// undici `Agent` (connect-time SSRF lookup) stays intact.
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
// WKH-130: mock del helper LLM de retry. Default = null (no retry) salvo que el
// test lo setee con mockResolvedValueOnce.
vi.mock('./llm/input-retry.js', () => ({
  regenerateInputFromErrors: vi.fn().mockResolvedValue(null),
}));
// WKH-55: mock del modulo downstream-payment (DT-K)
//
// ⚠️ Factory SIN `importOriginal`: reemplaza el módulo COMPLETO. Todo export de
// `downstream-payment.js` que `compose.ts` consuma y que no esté acá queda
// `undefined` bajo test. Por eso los helpers de skip-code del fix-pack P1 viven
// en el leaf `downstream-skip-code.js` (NO mockeado) — ver
// doc/sdd/189-p1-discover-reputation-402-cap/auto-blindaje.md.
vi.mock('../lib/downstream-payment.js', () => ({
  signAndSettleDownstream: vi.fn().mockResolvedValue(null),
}));

// HU-203: la clase REAL del eje 2 (el hop sin respuesta utilizable). Se usa la de
// producción y no un doble, para que el test se rompa si el contrato del adapter cambia.
import { FacilitatorSettleError } from '../adapters/errors.js';
import { signAndSettleDownstream } from '../lib/downstream-payment.js';
import {
  type DownstreamSkipCode,
  toSkipAction,
} from '../lib/downstream-skip-code.js';
// HU-DOUBLE-PAY: la clasificación de la retención la hacen las funciones REALES
// de producción (las mismas que llamaba el leg de salida borrado). El test sólo
// elige DÓNDE se tira el error, no qué significa.
import {
  SettleRefundWithheldError,
  withholdingFromSettleResult,
} from '../lib/settle-withholding.js';
import { budgetService } from './budget.js';
import { composeService } from './compose.js';
import { discoveryService } from './discovery.js';
import { eventService } from './event.js';
import { regenerateInputFromErrors } from './llm/input-retry.js';
import { maybeTransform } from './llm/transform.js';
import { registryService } from './registry.js';

const mockDownstream = vi.mocked(signAndSettleDownstream);
const mockDebit = vi.mocked(budgetService.debit);
const mockCredit = vi.mocked(budgetService.credit);
const mockCreditWithDest = vi.mocked(budgetService.creditWithDest); // WKH-129
const mockRecordSolana = vi.mocked(budgetService.recordSolanaSettleReceipt); // WKH-234
const mockRegen = vi.mocked(regenerateInputFromErrors); // WKH-130

/**
 * payTo EVM de los fixtures del sign INBOUND (`0x` + 40 hex). Fix-pack CR-MNR-8:
 * antes este literal estaba copiado CRUDO 33 veces en el archivo (mientras el
 * equivalente Solana sí tenía constante, `SOL_PAYTO_INBOUND`). Con el guard de
 * familia del fix-pack AR-profundo FIX 4 eso es una trampa: `isValidWallet` exige
 * EXACTAMENTE 40 hex, así que una copia con 39 o 41 `B` sigue siendo un string
 * plausible pero cambia EN SILENCIO la semántica del test — de "el sign inbound
 * firma" a "el leg se saltea con reason=INVALID_PAY_TO_FORMAT" — y el test sigue
 * verde por el motivo equivocado. Con `'B'.repeat(40)` la longitud la calcula el
 * runtime y no se puede mistipear.
 */
const EVM_PAYTO = `0x${'B'.repeat(40)}`;

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
    metadata: {},
    ...o,
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
// WKH-61: helper local de keyRow para tests de scoping (no compartido con
// middleware/a2a-key.test.ts; cada archivo mantiene su propio fixture).
function makeKeyRow(overrides: Partial<A2AAgentKeyRow> = {}): A2AAgentKeyRow {
  return {
    id: 'key-id-test',
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

function mockFetchOk(data: unknown = { result: 'ok' }) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => data,
  });
}
// WKH-130: body opcional (default = comportamiento actual). Los tests de retry
// pasan el field-error body explícito; los existentes siguen llamando
// mockFetchError(status) sin cambios.
function mockFetchError(status: number, body = '{"error":"fail"}') {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    json: async () => JSON.parse(body),
    text: async () => body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // TB-01: default settle re-verification = pass (clearAllMocks wiped it).
  mockVerifySettle.mockResolvedValue({ ok: true });
  vi.mocked(discoveryService.getAgent).mockResolvedValue(null);
  vi.mocked(discoveryService.discover).mockResolvedValue({
    agents: [],
    total: 0,
    totalAtLeast: 0,
    registries: [],
    sources: [],
    catalogStatus: 'complete',
  });
  // WKH-55: default downstream mock = null (no-op)
  mockDownstream.mockResolvedValue(null);
  // WKH-59: default debit success (each per-step debit test overrides).
  mockDebit.mockResolvedValue({ success: true });
  // WKH-128: default credit (refund) success.
  // A2 (audit 2026-06-24): `reverted:true` = la RPC afectó >=1 fila (reversión
  // real). El retry adaptativo SOLO re-debita si el refund#1 revirtió de verdad.
  mockCredit.mockResolvedValue({ success: true, reverted: true });
  // WKH-129: default credit-with-dest (refund) success + reverted real.
  mockCreditWithDest.mockResolvedValue({ success: true, reverted: true });
  // WKH-130: default regen = null (no retry) salvo override por test.
  mockRegen.mockResolvedValue(null);
});

describe('composeService.invokeAgent', () => {
  it('T-1: includes Bearer auth header from registry', async () => {
    const registry = makeRegistry({
      auth: { type: 'bearer', key: 'Authorization', value: 'test-token' },
    });
    vi.mocked(registryService.getEnabled).mockResolvedValue([registry]);
    const agent = makeAgent({ priceUsdc: 0 });
    mockFetchOk();
    await composeService.invokeAgent(agent, { q: 'hello' });
    const callHeaders = mockFetch.mock.calls[0]![1]!.headers as Record<
      string,
      string
    >;
    expect(callHeaders.Authorization).toBe('Bearer test-token');
    expect(callHeaders['PAYMENT-SIGNATURE']).toBeUndefined();
  });

  it('T-2: includes custom header auth from registry', async () => {
    const registry = makeRegistry({
      auth: { type: 'header', key: 'X-API-Key', value: 'abc123' },
    });
    vi.mocked(registryService.getEnabled).mockResolvedValue([registry]);
    const agent = makeAgent({ priceUsdc: 0 });
    mockFetchOk();
    await composeService.invokeAgent(agent, { q: 'hello' });
    const callHeaders = mockFetch.mock.calls[0]![1]!.headers as Record<
      string,
      string
    >;
    expect(callHeaders['X-API-Key']).toBe('abc123');
  });

  // ── HU-DOUBLE-PAY: el candado contra la vuelta del segundo leg de salida ──
  //
  // Este archivo mockea `../lib/downstream-payment.js` completo, así que el leg
  // downstream NO corre acá; el único settle que podría verse es el del leg
  // borrado. Que `mockSign`/`mockSettle` (o sea `getPaymentAdapter()` de la
  // chain DEFAULT del gateway) queden en CERO es exactamente la afirmación de
  // que ese leg no existe. El conteo de los DOS legs a la vez —y de que el
  // agente sí cobra— vive en `compose.outbound-legs.test.ts`.
  it('T-LEGA-GONE: agente EVM pago + caller x402 → `compose` no firma ni settlea nada en la chain default', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const agent = makeAgent({
      priceUsdc: 1.0,
      metadata: { payTo: EVM_PAYTO },
      payment: { method: 'x402', chain: 'avalanche', contract: EVM_PAYTO },
    });
    mockFetchOk();

    const result = await composeService.invokeAgent(agent, { q: 'hello' });

    expect(result.output).toBe('ok');
    expect(mockSign).not.toHaveBeenCalled();
    expect(mockSettle).not.toHaveBeenCalled();
    // Y el leg downstream —el único que queda— sí se consulta.
    expect(mockDownstream).toHaveBeenCalledTimes(1);
  });

  it('T-LEGA-GONE-KEY: mismo agente CON agent key → idéntico (el camino ya no depende de cómo se autenticó el caller)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const agent = makeAgent({
      priceUsdc: 1.0,
      metadata: { payTo: EVM_PAYTO },
      payment: { method: 'x402', chain: 'avalanche', contract: EVM_PAYTO },
    });
    mockFetchOk();

    await composeService.invokeAgent(agent, { q: 'hello' }, 'wasi_a2a_k');

    expect(mockSign).not.toHaveBeenCalled();
    expect(mockSettle).not.toHaveBeenCalled();
    expect(mockDownstream).toHaveBeenCalledTimes(1);
  });

  // ── Fix-pack AR-profundo FIX 4: el payTo base58 de un agente Solana ───────
  // El guard de FAMILIA que vivía acá protegía al `viem.signTypedData` del leg
  // de salida borrado. Sin ese sign no hay nada que proteger en `invokeAgent`:
  // el payTo base58 sólo lo toca el leg downstream, que tiene su propio
  // `isValidSolanaAddress` (cubierto en `lib/downstream-payment.test.ts`).

  // ── Fix-pack it2 BLQ-BAJO-1: el guard debe mirar EL VALOR (payTo), no el proxy
  //    (la chain declarada). Los dos repros del AR: `metadata` viene del agent
  //    card COMPLETO del registry (`discovery.mapAgent` setea `metadata: raw`) y
  //    cualquier caller autenticado puede registrar un registry, así que el payTo
  //    y la chain declarada son fuentes INDEPENDIENTES.
  // TB-01 (audit 2026-06-30): a settle the facilitator reports as success but
  // that FAILS on-chain re-verification must abort the step (no trust of the
  // facilitator JSON alone).
  it('T-6: invokes without auth headers when registry not found', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const agent = makeAgent({ priceUsdc: 0 });
    mockFetchOk();
    const result = await composeService.invokeAgent(agent, { q: 'hello' });
    const callHeaders = mockFetch.mock.calls[0]![1]!.headers as Record<
      string,
      string
    >;
    expect(callHeaders['Content-Type']).toBe('application/json');
    expect(callHeaders.Authorization).toBeUndefined();
    expect(result.output).toBe('ok');
  });

  it('T-7: budget check rejects when cost exceeds maxBudget', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const agent1 = makeAgent({
      slug: 'a1',
      priceUsdc: 0.5,
      metadata: { payTo: '0xPAY' },
    });
    const agent2 = makeAgent({
      slug: 'a2',
      priceUsdc: 0.6,
      metadata: { payTo: '0xPAY' },
    });
    vi.mocked(discoveryService.getAgent)
      .mockResolvedValueOnce(agent1)
      .mockResolvedValueOnce(agent2)
      .mockResolvedValueOnce(agent2);
    mockSign.mockResolvedValue({
      xPaymentHeader: 'base64mock',
      paymentRequest: {
        authorization: {
          from: '0xAAA',
          to: '0xPAY',
          value: '1',
          validAfter: '0',
          validBefore: '9999999999',
          nonce: '0x1234',
        },
        signature: '0xSIG',
        network: 'eip155:2368',
      },
    });
    mockSettle.mockResolvedValue({ success: true, txHash: '0xTX' });
    mockFetchOk({ result: 'step1-done' });
    const result = await composeService.compose({
      steps: [
        { agent: 'a1', input: {} },
        { agent: 'a2', input: {} },
      ],
      maxBudget: 1.0,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Budget exceeded');
    expect(result.steps).toHaveLength(1);
  });

  it('T-9: structured logs never receive private key or raw signature', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    mockSign.mockResolvedValue({
      xPaymentHeader: 'base64mock',
      paymentRequest: {
        authorization: {
          from: '0xAAA',
          to: EVM_PAYTO,
          value: '1',
          validAfter: '0',
          validBefore: '9999999999',
          nonce: '0x1234',
        },
        signature: '0xSECRET_SIG_VALUE',
        network: 'eip155:2368',
      },
    });
    mockSettle.mockResolvedValue({ success: true, txHash: '0xTXHASH' });
    const agent = makeAgent({
      priceUsdc: 1.0,
      metadata: { payTo: EVM_PAYTO },
    });
    mockFetchOk();
    const originalPK = process.env.OPERATOR_PRIVATE_KEY;
    process.env.OPERATOR_PRIVATE_KEY = '0xDEAD_PRIVATE_KEY_NEVER_LOG';
    try {
      await composeService.invokeAgent(agent, { q: 'hello' });
    } finally {
      process.env.OPERATOR_PRIVATE_KEY = originalPK;
    }
    const allCalls = [
      ...logSpy.info.mock.calls,
      ...logSpy.warn.mock.calls,
      ...logSpy.error.mock.calls,
    ];
    for (const call of allCalls) {
      const logStr = JSON.stringify(call);
      expect(logStr).not.toContain('DEAD_PRIVATE_KEY_NEVER_LOG');
      expect(logStr).not.toContain('SECRET_SIG_VALUE');
    }
  });
});

// ─── WKH-55: Downstream x402 hook (compose service integration) ────
describe('composeService — WKH-55 downstream x402 hook', () => {
  it('does NOT propagate downstream when signAndSettleDownstream returns null (T-W3-01 / AC-1)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    mockDownstream.mockResolvedValue(null);
    const agent = makeAgent({ priceUsdc: 0, payment: undefined });
    mockFetchOk();
    const result = await composeService.invokeAgent(
      agent,
      { foo: 'bar' },
      'k1',
    );
    expect(result.downstream).toBeUndefined();
  });

  // ── Fix-pack P1 (hallazgo 4): la señal del skip llega a la RESPUESTA ────
  // Antes, cuando un leg se salteaba el motivo quedaba SÓLO en los logs y la
  // respuesta HTTP no decía nada.

  it('T-P1-4-compose-a: leg salteado → steps[].downstreamSettle = "skipped:<code público>"', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    // El mock de signAndSettleDownstream devuelve null Y loguea el code por el
    // logger que recibe — igual que el módulo real en sus 25 caminos de skip.
    mockDownstream.mockImplementation(async (_agent, logger) => {
      logger.warn({ code: 'NO_PAYMENT_FIELD' }, '[Downstream] sin payment');
      return null;
    });
    const agent = makeAgent({ slug: 'skip-agent', priceUsdc: 0 });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);
    mockFetchOk();

    const result = await composeService.compose({
      steps: [{ agent: agent.slug, input: {} }],
    });

    expect(result.success).toBe(true);
    expect(result.steps[0]!.downstreamSettle).toBe('skipped:NO_PAYMENT_FIELD');
    // Mutuamente excluyente con el caso exitoso.
    expect(result.steps[0]!.downstreamTxHash).toBeUndefined();
  });

  it('T-P1-4-compose-b (FUGA): un code interno sensible sale GENERICIZADO en la respuesta', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    // INSUFFICIENT_BALANCE revelaría que la hot wallet del operador está seca.
    mockDownstream.mockImplementation(async (_agent, logger) => {
      logger.warn({ code: 'INSUFFICIENT_BALANCE' }, '[Downstream] sin fondos');
      return null;
    });
    const agent = makeAgent({ slug: 'skip-agent-2', priceUsdc: 0 });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);
    mockFetchOk();

    const result = await composeService.compose({
      steps: [{ agent: agent.slug, input: {} }],
    });

    expect(result.steps[0]!.downstreamSettle).toBe('skipped:UNAVAILABLE');
    // El código interno NO aparece en ningún lugar de la respuesta.
    expect(JSON.stringify(result)).not.toContain('INSUFFICIENT_BALANCE');
  });

  it('T-P1-4-compose-c: skip SIN code logueado → sin campo (no se inventa un motivo)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    mockDownstream.mockResolvedValue(null);
    const agent = makeAgent({ slug: 'skip-agent-3', priceUsdc: 0 });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);
    mockFetchOk();

    const result = await composeService.compose({
      steps: [{ agent: agent.slug, input: {} }],
    });

    expect(result.steps[0]!.downstreamSettle).toBeUndefined();
  });

  // ── Canal de OPERADOR: el motivo INTERNO del skip ────────────────────────
  //
  // EL HALLAZGO: "el código de skip colapsa 4 causas distintas en
  // `NOT_CONFIGURED`: la telemetría no permite diagnosticar por qué no se pagó".
  // Verificado y cierto — `FLAG_OFF`, `CHAIN_ENVIRONMENT_DRIFT`,
  // `MAINNET_NOT_ALLOWED` y `MISSING_INTENT_ID` salen todas como `NOT_CONFIGURED`,
  // y ese código público era lo único que llegaba a `a2a_events`.
  //
  // El motivo interno viaja ahora por un array PRESTADO por el route (input, no
  // campo del resultado) para que no pueda salir por HTTP ni por accidente.

  it('T-CAUSA-compose-a: el motivo INTERNO llega al array prestado, no genericizado', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    // `CHAIN_ENVIRONMENT_DRIFT` es una de las cuatro que el público colapsa. Es la
    // que más importa: significa que NUESTRA config está rota, o sea alguien se
    // tiene que levantar. Indistinguible de `FLAG_OFF` en el canal viejo.
    mockDownstream.mockImplementation(async (_agent, logger) => {
      logger.warn(
        { code: 'CHAIN_ENVIRONMENT_DRIFT' },
        '[Downstream] config incoherente',
      );
      return null;
    });
    const agent = makeAgent({ slug: 'drift-agent', priceUsdc: 0 });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);
    mockFetchOk();

    const downstreamSkipCauses: DownstreamSkipCode[] = [];
    const result = await composeService.compose({
      steps: [{ agent: agent.slug, input: {} }],
      downstreamSkipCauses,
    });

    // (1) el caller sigue viendo el código genericizado, byte-idéntico a antes…
    expect(result.steps[0]!.downstreamSettle).toBe('skipped:NOT_CONFIGURED');
    // (2) …y el operador ve la causa real.
    expect(downstreamSkipCauses).toEqual(['CHAIN_ENVIRONMENT_DRIFT']);
    // (3) el código interno NO viaja en el resultado, que es lo que se serializa.
    expect(JSON.stringify(result)).not.toContain('CHAIN_ENVIRONMENT_DRIFT');
  });

  it('T-CAUSA-compose-b: dos causas que el público colapsa llegan SEPARADAS', async () => {
    // Es la prueba del hallazgo en el camino real: dos steps, dos causas con dos
    // dueños distintos (nadie actúa vs. decisión de dinero), y el caller ve dos
    // veces el mismo `NOT_CONFIGURED`.
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const codes = ['FLAG_OFF', 'MAINNET_NOT_ALLOWED'] as const;
    let call = 0;
    mockDownstream.mockImplementation(async (_agent, logger) => {
      logger.warn({ code: codes[call++] }, '[Downstream] skip');
      return null;
    });
    const a1 = makeAgent({ slug: 'c1', priceUsdc: 0 });
    const a2 = makeAgent({ slug: 'c2', priceUsdc: 0 });
    vi.mocked(discoveryService.getAgent)
      .mockResolvedValueOnce(a1)
      .mockResolvedValueOnce(a2)
      .mockResolvedValueOnce(a2);
    mockFetchOk();
    mockFetchOk();

    const downstreamSkipCauses: DownstreamSkipCode[] = [];
    const result = await composeService.compose({
      steps: [
        { agent: 'c1', input: {} },
        { agent: 'c2', input: {} },
      ],
      downstreamSkipCauses,
    });

    // Lo que el caller ve: dos veces lo MISMO. Ese es el colapso, y se mantiene.
    expect(result.steps.map((s) => s.downstreamSettle)).toEqual([
      'skipped:NOT_CONFIGURED',
      'skipped:NOT_CONFIGURED',
    ]);
    // Lo que el operador ve: dos causas distintas, en orden de ejecución.
    expect(downstreamSkipCauses).toEqual(['FLAG_OFF', 'MAINNET_NOT_ALLOWED']);
    expect(new Set(downstreamSkipCauses.map(toSkipAction)).size).toBe(2);
  });

  it('T-CAUSA-compose-c: sin array prestado, el comportamiento es idéntico al de antes', async () => {
    // El canal es opt-in: un caller que no lo pide (el tool MCP, por ejemplo) no
    // paga nada y no cambia ni un byte de su respuesta.
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    mockDownstream.mockImplementation(async (_agent, logger) => {
      logger.warn({ code: 'FLAG_OFF' }, '[Downstream] flag off');
      return null;
    });
    const agent = makeAgent({ slug: 'sin-sink', priceUsdc: 0 });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);
    mockFetchOk();

    const result = await composeService.compose({
      steps: [{ agent: 'sin-sink', input: {} }],
    });

    expect(result.steps[0]!.downstreamSettle).toBe('skipped:NOT_CONFIGURED');
  });

  it('T-CAUSA-compose-d: un leg que SÍ se pagó no ensucia el canal', async () => {
    // El array acumula sólo legs NO pagados. Si se llenara con los códigos de
    // observabilidad que NO cortan (`BALANCE_PRECHECK_SKIPPED`), el operador
    // contaría como problema un leg que pagó bien.
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    mockDownstream.mockImplementation(async (_agent, logger) => {
      logger.warn({ code: 'BALANCE_PRECHECK_SKIPPED' }, '[Downstream] sin RPC');
      return { txHash: '0xok', blockNumber: 7, settledAmount: '1' };
    });
    const agent = makeAgent({ slug: 'pago-ok', priceUsdc: 0 });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);
    mockFetchOk();

    const downstreamSkipCauses: DownstreamSkipCode[] = [];
    const result = await composeService.compose({
      steps: [{ agent: 'pago-ok', input: {} }],
      downstreamSkipCauses,
    });

    expect(result.steps[0]!.downstreamTxHash).toBe('0xok');
    expect(downstreamSkipCauses).toEqual([]);
  });

  it('propagates downstreamTxHash to StepResult when downstream succeeds (T-W3-02 / AC-3)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    mockDownstream.mockResolvedValue({
      txHash: '0xabc',
      blockNumber: 1,
      settledAmount: '500000',
    });
    const agent = makeAgent({
      slug: 'ds-agent',
      priceUsdc: 0,
      payment: {
        method: 'x402',
        chain: 'avalanche',
        contract: '0x000000000000000000000000000000000000aBcD',
      },
    });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);
    mockFetchOk();

    const composeResult = await composeService.compose({
      steps: [{ agent: agent.slug, input: {} }],
    });

    expect(composeResult.success).toBe(true);
    expect(composeResult.steps[0]!.downstreamTxHash).toBe('0xabc');
    expect(composeResult.steps[0]!.downstreamBlockNumber).toBe(1);
    expect(composeResult.steps[0]!.downstreamSettledAmount).toBe('500000');
  });

  it('returns invoke result without downstreamTxHash when downstream fails (T-W3-03 / AC-4)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    mockDownstream.mockResolvedValue(null);
    const agent = makeAgent({ priceUsdc: 0 });
    mockFetchOk();
    const result = await composeService.invokeAgent(agent, {}, 'k1');
    expect(result.output).toBe('ok');
    expect(result.downstream).toBeUndefined();
  });

  it('C1 (audit 2026-07-01): forwards x-a2a-key ONLY to a SYSTEM-trusted registry (WKH-58 contract, now conditional)', async () => {
    // The agent belongs to a system-trusted registry (ownerRef === 'system').
    // Its invokeUrl is platform-controlled, so forwarding the caller's bearer is
    // safe — this is the legitimate Pieverse/system path.
    const systemRegistry = makeRegistry({
      name: 'test-registry',
      ownerRef: 'system',
    });
    vi.mocked(registryService.getEnabled).mockResolvedValue([systemRegistry]);
    mockDownstream.mockResolvedValue(null); // simula flag off / no-op
    const agent = makeAgent({ priceUsdc: 0, payment: undefined });
    const input = { task: 'translate', text: 'hola' };
    mockFetchOk();
    await composeService.invokeAgent(agent, input, 'a2a-key-1');

    // Sólo debería haber 1 llamada al marketplace (no facilitator porque downstream es no-op)
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe(agent.invokeUrl);
    // AR-MNR-3: pin EXACT method + EXACT header key set. C1 (audit): the bearer
    // is forwarded here because the registry is system-trusted.
    expect(init.method).toBe('POST');
    expect(Object.keys(init.headers).sort()).toEqual(
      ['Content-Type', 'x-a2a-key'].sort(),
    );
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['x-a2a-key']).toBe('a2a-key-1');
    expect(init.body).toBe(JSON.stringify(input));
  });

  it('C1 (audit 2026-07-01): does NOT forward x-a2a-key to a NON-system (auto-registered) registry — closes the credential-theft vector', async () => {
    // An attacker self-registers a registry (ownerRef = their own owner_ref, not
    // 'system') with an invokeUrl to their server. The caller's raw bearer must
    // NEVER reach it.
    const attackerRegistry = makeRegistry({
      name: 'test-registry',
      ownerRef: 'attacker-owner-ref',
    });
    vi.mocked(registryService.getEnabled).mockResolvedValue([attackerRegistry]);
    mockDownstream.mockResolvedValue(null);
    const agent = makeAgent({ priceUsdc: 0, payment: undefined });
    const input = { task: 'translate', text: 'hola' };
    mockFetchOk();
    await composeService.invokeAgent(agent, input, 'victim-a2a-key');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0]!;
    // The bearer is ABSENT — the attacker's server never receives the victim key.
    expect(init.headers['x-a2a-key']).toBeUndefined();
    expect(Object.keys(init.headers).sort()).toEqual(['Content-Type'].sort());
    expect(init.body).toBe(JSON.stringify(input));
  });

  it('C1 (audit 2026-07-01): does NOT forward x-a2a-key when the registry is unknown (no matching enabled registry)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    mockDownstream.mockResolvedValue(null);
    const agent = makeAgent({ priceUsdc: 0, payment: undefined });
    const input = { task: 'translate', text: 'hola' };
    mockFetchOk();
    await composeService.invokeAgent(agent, input, 'a2a-key-1');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0]!;
    expect(init.headers['x-a2a-key']).toBeUndefined();
    expect(Object.keys(init.headers).sort()).toEqual(['Content-Type'].sort());
  });
});

// ─── WKH-56: A2A fast-path bridge (compose service integration) ────
describe('composeService.compose — WKH-56 A2A fast-path bridge', () => {
  it('T-10: A2A_PASSTHROUGH bypasses maybeTransform when output is Message + target a2aCompliant (AC-1)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const transformMock = vi.mocked(maybeTransform);
    transformMock.mockClear();

    const agent1 = makeAgent({
      slug: 'a1',
      id: 'agent-a1',
      priceUsdc: 0,
      metadata: { a2aCompliant: true },
    });
    const agent2 = makeAgent({
      slug: 'a2',
      id: 'agent-a2',
      priceUsdc: 0,
      metadata: {
        a2aCompliant: true,
        inputSchema: { type: 'object', required: ['x'] },
      },
    });
    vi.mocked(discoveryService.getAgent)
      .mockResolvedValueOnce(agent1)
      .mockResolvedValueOnce(agent2)
      .mockResolvedValueOnce(agent2);

    const a2aOutput = {
      role: 'agent',
      parts: [{ kind: 'data', data: { x: 1 } }],
    };
    mockFetchOk({ result: a2aOutput });
    mockFetchOk({ result: 'final' });

    const result = await composeService.compose({
      steps: [
        { agent: 'a1', input: {} },
        { agent: 'a2', input: {}, passOutput: true },
      ],
    });

    expect(result.success).toBe(true);
    expect(transformMock).not.toHaveBeenCalled();
    expect(result.steps[0]!.bridgeType).toBe('A2A_PASSTHROUGH');
    expect(result.steps[0]!.transformLatencyMs).toBeLessThan(50);
  });

  it('T-11: falls back to maybeTransform when isA2AMessage returns false (AC-2)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const transformMock = vi.mocked(maybeTransform);
    transformMock.mockClear();
    transformMock.mockResolvedValueOnce({
      transformedOutput: { x: 'transformed' },
      cacheHit: 'SKIPPED',
      bridgeType: 'SKIPPED',
      latencyMs: 0,
    });

    const agent1 = makeAgent({
      slug: 'a1',
      id: 'agent-a1',
      priceUsdc: 0,
    });
    const agent2 = makeAgent({
      slug: 'a2',
      id: 'agent-a2',
      priceUsdc: 0,
      metadata: {
        a2aCompliant: true,
        inputSchema: { type: 'object', required: ['x'] },
      },
    });
    vi.mocked(discoveryService.getAgent)
      .mockResolvedValueOnce(agent1)
      .mockResolvedValueOnce(agent2)
      .mockResolvedValueOnce(agent2);

    mockFetchOk({ result: { plain: 'string' } }); // NOT a Message
    mockFetchOk({ result: 'final' });

    const result = await composeService.compose({
      steps: [
        { agent: 'a1', input: {} },
        { agent: 'a2', input: {}, passOutput: true },
      ],
    });

    expect(result.success).toBe(true);
    expect(transformMock).toHaveBeenCalledTimes(1);
    expect(result.steps[0]!.bridgeType).toBe('SKIPPED');
  });

  it('T-12: unwraps parts[0] when output is A2A but target is non-a2aCompliant (AC-3)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const transformMock = vi.mocked(maybeTransform);
    transformMock.mockClear();
    transformMock.mockResolvedValueOnce({
      transformedOutput: { x: 1 },
      cacheHit: 'SKIPPED',
      bridgeType: 'SKIPPED',
      latencyMs: 0,
    });

    const agent1 = makeAgent({
      slug: 'a1',
      id: 'agent-a1',
      priceUsdc: 0,
    });
    const agent2 = makeAgent({
      slug: 'a2',
      id: 'agent-a2',
      priceUsdc: 0,
      // NO a2aCompliant flag — target is non-A2A
      metadata: {
        inputSchema: { type: 'object', required: ['x'] },
      },
    });
    vi.mocked(discoveryService.getAgent)
      .mockResolvedValueOnce(agent1)
      .mockResolvedValueOnce(agent2)
      .mockResolvedValueOnce(agent2);

    const a2aOutput = {
      role: 'agent',
      parts: [{ kind: 'data', data: { x: 1 } }],
    };
    mockFetchOk({ result: a2aOutput });
    mockFetchOk({ result: 'final' });

    await composeService.compose({
      steps: [
        { agent: 'a1', input: {} },
        { agent: 'a2', input: {}, passOutput: true },
      ],
    });

    expect(transformMock).toHaveBeenCalledTimes(1);
    const callArgs = transformMock.mock.calls[0]!;
    // 3rd arg of maybeTransform(srcId, tgtId, output, schema) is the unwrapped payload
    expect(callArgs[2]).toEqual({ x: 1 });
  });

  it('T-14: compose_step metadata includes 6 telemetry fields, llm_* null on non-LLM (WKH-57 AC-6)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const transformMock = vi.mocked(maybeTransform);
    transformMock.mockClear();
    const trackSpy = vi.mocked(eventService.track);
    trackSpy.mockClear();
    trackSpy.mockResolvedValue({} as never);

    // First subtest: LLM bridge — all 6 fields populated with real values.
    transformMock.mockResolvedValueOnce({
      transformedOutput: { x: 1 },
      cacheHit: false,
      bridgeType: 'LLM',
      latencyMs: 42,
      llm: {
        model: 'claude-haiku-4-5-20251001',
        tokensIn: 250,
        tokensOut: 60,
        retries: 0,
        costUsd: 0.000_44, // 250/1M*0.8 + 60/1M*4.0
      },
    });

    const agent1 = makeAgent({
      slug: 'a1',
      id: 'agent-a1',
      priceUsdc: 0,
    });
    const agent2 = makeAgent({
      slug: 'a2',
      id: 'agent-a2',
      priceUsdc: 0,
      metadata: {
        inputSchema: { type: 'object', required: ['x'] },
      },
    });
    vi.mocked(discoveryService.getAgent)
      .mockResolvedValueOnce(agent1)
      .mockResolvedValueOnce(agent2)
      .mockResolvedValueOnce(agent2);

    mockFetchOk({ result: { plain: 'string' } });
    mockFetchOk({ result: 'final' });

    await composeService.compose({
      steps: [
        { agent: 'a1', input: {} },
        { agent: 'a2', input: {}, passOutput: true },
      ],
    });

    // First step's event must include the 6 metadata fields with LLM values.
    const firstStepCall = trackSpy.mock.calls.find(
      (c) => c[0].agentId === 'a1',
    );
    expect(firstStepCall).toBeDefined();
    const meta1 = firstStepCall?.[0].metadata;
    expect(meta1?.bridge_type).toBe('LLM');
    expect(typeof meta1?.bridge_latency_ms).toBe('number');
    expect(meta1?.bridge_cost_usd).toBeCloseTo(0.000_44, 6);
    expect(meta1?.llm_model).toBe('claude-haiku-4-5-20251001');
    expect(meta1?.llm_tokens_in).toBe(250);
    expect(meta1?.llm_tokens_out).toBe(60);

    // Second subtest: non-LLM bridge (SKIPPED) — llm_* fields must be null.
    trackSpy.mockClear();
    transformMock.mockClear();
    transformMock.mockResolvedValueOnce({
      transformedOutput: { x: 1 },
      cacheHit: 'SKIPPED',
      bridgeType: 'SKIPPED',
      latencyMs: 0,
      // No llm field — explicitly omitted (CD-17)
    });

    const agent3 = makeAgent({
      slug: 'b1',
      id: 'agent-b1',
      priceUsdc: 0,
    });
    const agent4 = makeAgent({
      slug: 'b2',
      id: 'agent-b2',
      priceUsdc: 0,
      metadata: {
        inputSchema: { type: 'object', required: ['x'] },
      },
    });
    vi.mocked(discoveryService.getAgent)
      .mockResolvedValueOnce(agent3)
      .mockResolvedValueOnce(agent4)
      .mockResolvedValueOnce(agent4);

    mockFetchOk({ result: { x: 1 } });
    mockFetchOk({ result: 'final' });

    await composeService.compose({
      steps: [
        { agent: 'b1', input: {} },
        { agent: 'b2', input: {}, passOutput: true },
      ],
    });

    const skipStepCall = trackSpy.mock.calls.find((c) => c[0].agentId === 'b1');
    expect(skipStepCall).toBeDefined();
    const meta2 = skipStepCall?.[0].metadata;
    expect(meta2?.bridge_type).toBe('SKIPPED');
    expect(typeof meta2?.bridge_latency_ms).toBe('number');
    // AB-WKH-56-4: llm_* + bridge_cost_usd must be null (not undefined).
    expect(meta2?.bridge_cost_usd).toBeNull();
    expect(meta2?.llm_model).toBeNull();
    expect(meta2?.llm_tokens_in).toBeNull();
    expect(meta2?.llm_tokens_out).toBeNull();
  });

  it('T-13: emits compose_step event with metadata.bridge_type (AC-6)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const transformMock = vi.mocked(maybeTransform);
    transformMock.mockClear();
    const trackSpy = vi.mocked(eventService.track);
    trackSpy.mockClear();
    trackSpy.mockResolvedValue({} as never);

    const agent1 = makeAgent({
      slug: 'a1',
      id: 'agent-a1',
      priceUsdc: 0,
      metadata: { a2aCompliant: true },
    });
    const agent2 = makeAgent({
      slug: 'a2',
      id: 'agent-a2',
      priceUsdc: 0,
      metadata: { a2aCompliant: true },
    });
    vi.mocked(discoveryService.getAgent)
      .mockResolvedValueOnce(agent1)
      .mockResolvedValueOnce(agent2)
      .mockResolvedValueOnce(agent2);

    const a2aOutput = {
      role: 'agent',
      parts: [{ kind: 'data', data: { x: 1 } }],
    };
    mockFetchOk({ result: a2aOutput });
    mockFetchOk({ result: a2aOutput });

    await composeService.compose({
      steps: [
        { agent: 'a1', input: {} },
        { agent: 'a2', input: {}, passOutput: true },
      ],
    });

    // Event for first step → A2A_PASSTHROUGH
    expect(trackSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'compose_step',
        agentId: 'a1',
        metadata: expect.objectContaining({ bridge_type: 'A2A_PASSTHROUGH' }),
      }),
    );

    // Event for last step → bridge_type === null (no bridge after last step)
    const lastCall = trackSpy.mock.calls[trackSpy.mock.calls.length - 1]!;
    expect(lastCall[0].metadata?.bridge_type).toBeNull();
  });
});

// ─── WAS-V2-3-CLIENT (WKH-57): integration — fallback unblocks downstream ─
describe('composeService — WAS-V2-3-CLIENT integration (WKH-57)', () => {
  it('T-INT-01: triggers downstream Fuji USDC settle when priceUsdc is resolved via v2 fallback (AC-4)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    mockDownstream.mockResolvedValue({
      txHash: '0xfeeb',
      blockNumber: 42,
      settledAmount: '50000', // 0.05 USDC in atomic units (6-dec)
    });
    // Simulate the OUTPUT of mapAgent post-fallback: priceUsdc resolved
    // from price_per_call when price_per_call_usdc was null.
    const agent = makeAgent({
      slug: 'v2-fallback-agent',
      priceUsdc: 0.05,
      payment: {
        method: 'x402',
        chain: 'avalanche',
        contract: '0x000000000000000000000000000000000000aBcD',
      },
      metadata: { payTo: '0x000000000000000000000000000000000000aBcD' },
    });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);
    // Self-contained upstream x402 mocks (AR BLQ-MED-1): clearAllMocks resets
    // call history but NOT mockResolvedValue implementations from prior tests.
    mockSign.mockResolvedValueOnce({
      xPaymentHeader: 'mockheader',
      paymentRequest: {
        authorization: {
          from: '0xA',
          to: '0xB',
          value: '50000',
          validAfter: '0',
          validBefore: '9999999999',
          nonce: '0x1234',
        },
        signature: '0xSIG',
        network: 'eip155:2368',
      },
    });
    mockSettle.mockResolvedValueOnce({ success: true, txHash: '0xUPSTREAM' });
    mockFetchOk();

    const result = await composeService.compose({
      steps: [{ agent: agent.slug, input: { q: 'x' } }],
    });

    expect(result.success).toBe(true);
    // AC-4: downstream path executed (vs current bug where priceUsdc=0 skips it)
    expect(mockDownstream).toHaveBeenCalledTimes(1);
    expect(result.steps[0]!.downstreamTxHash).toBe('0xfeeb');
  });

  it('T-INT-02: payTo falls back to metadata.payment.contract when top-level payTo missing (WAS-V2-3-CLIENT-2)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    mockDownstream.mockResolvedValue({
      txHash: '0xfeeb',
      blockNumber: 42,
      settledAmount: '1000', // 0.001 USDC in atomic units (6-dec)
    });
    // v2 schema drift: marketplace exposes payTo via payment.contract (nested),
    // NOT via top-level metadata.payTo. Compose must fall back transparently.
    const agent = makeAgent({
      slug: 'wasi-chainlink-price',
      priceUsdc: 0.001,
      payment: {
        method: 'x402',
        chain: 'avalanche',
        contract: '0xC01DEF0ca66b86E9F8655dc202347F1cf104b7A7',
      },
      metadata: {
        payment: {
          protocol: 'x402',
          price: 0.001,
          currency: 'USDC',
          settlement: 'wasiai-native',
          contract: '0xC01DEF0ca66b86E9F8655dc202347F1cf104b7A7',
        },
        // NOTE: no top-level payTo — must resolve from payment.contract
      },
    });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);
    // Self-contained upstream x402 mocks (mirrors T-INT-01 pattern)
    mockSign.mockResolvedValueOnce({
      xPaymentHeader: 'mockheader',
      paymentRequest: {
        authorization: {
          from: '0xA',
          to: '0xC01DEF0ca66b86E9F8655dc202347F1cf104b7A7',
          value: '1000',
          validAfter: '0',
          validBefore: '9999999999',
          nonce: '0x1234',
        },
        signature: '0xSIG',
        network: 'eip155:43113',
      },
    });
    mockSettle.mockResolvedValueOnce({ success: true, txHash: '0xUPSTREAM' });
    mockFetchOk();

    const result = await composeService.compose({
      steps: [{ agent: agent.slug, input: { q: 'price' } }],
    });

    expect(result.success).toBe(true);
    // Downstream Fuji USDC settle fired end-to-end via fallback payTo
    expect(mockDownstream).toHaveBeenCalledTimes(1);
    expect(result.steps[0]!.downstreamTxHash).toBe('0xfeeb');
  });
});

// ─── WKH-61: scoping per step (composeService.compose) ───────────────────
describe('composeService.compose — WKH-61 scoping per step', () => {
  beforeEach(() => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
  });

  it('T-SCOPE-1 (AC-1): registry match → success', async () => {
    const agent = makeAgent({
      slug: 'wasiai-x',
      registry: 'wasiai',
      priceUsdc: 0,
    });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);
    mockFetchOk({ result: 'ok' });

    const result = await composeService.compose({
      steps: [{ agent: 'wasiai-x', input: {} }],
      scopingKeyRow: makeKeyRow({ allowed_registries: ['wasiai'] }),
    });

    expect(result.success).toBe(true);
    expect(result.errorCode).toBeUndefined();
    expect(result.steps).toHaveLength(1);
  });

  it('T-SCOPE-2 (AC-2): registry mismatch → SCOPE_DENIED, agent NOT invoked', async () => {
    const agent = makeAgent({
      slug: 'other-x',
      registry: 'other',
      priceUsdc: 0,
    });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);

    const result = await composeService.compose({
      steps: [{ agent: 'other-x', input: {} }],
      scopingKeyRow: makeKeyRow({ allowed_registries: ['wasiai'] }),
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SCOPE_DENIED');
    expect(result.scopeDeniedTarget?.registry).toBe('other');
    expect(result.scopeDeniedTarget?.agent_slug).toBe('other-x');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('T-SCOPE-3 (AC-3): slug mismatch → SCOPE_DENIED', async () => {
    const agent = makeAgent({
      slug: 'other-slug',
      registry: 'wasiai',
      priceUsdc: 0,
    });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);

    const result = await composeService.compose({
      steps: [{ agent: 'other-slug', input: {} }],
      scopingKeyRow: makeKeyRow({ allowed_agent_slugs: ['allowed-slug'] }),
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SCOPE_DENIED');
    expect(result.scopeDeniedTarget?.agent_slug).toBe('other-slug');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('T-SCOPE-4 (AC-4): category mismatch → SCOPE_DENIED', async () => {
    const agent = makeAgent({
      slug: 'social-bot',
      registry: 'wasiai',
      priceUsdc: 0,
      metadata: { category: 'social' },
    });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);

    const result = await composeService.compose({
      steps: [{ agent: 'social-bot', input: {} }],
      scopingKeyRow: makeKeyRow({ allowed_categories: ['defi'] }),
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SCOPE_DENIED');
    expect(result.scopeDeniedTarget?.category).toBe('social');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('T-SCOPE-5 (AC-5): allowed_*=null → no scope check, success path', async () => {
    const agent = makeAgent({
      slug: 'any',
      registry: 'whatever',
      priceUsdc: 0,
    });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);
    mockFetchOk({ result: 'done' });

    const result = await composeService.compose({
      steps: [{ agent: 'any', input: {} }],
      scopingKeyRow: makeKeyRow({
        allowed_registries: null,
        allowed_agent_slugs: null,
        allowed_categories: null,
      }),
    });

    expect(result.success).toBe(true);
    expect(result.errorCode).toBeUndefined();
  });

  it('T-SCOPE-6 (AC-6): check evaluates real agent.registry, not step.registry hint', async () => {
    // Step pide registry='wasiai', pero discovery resuelve un Agent
    // con registry='other' (drift / fallback). El scope check debe denegar
    // contra el registry REAL del agent, no el hint del step.
    const agent = makeAgent({
      slug: 'mismatched',
      registry: 'other',
      priceUsdc: 0,
    });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);

    const result = await composeService.compose({
      steps: [{ agent: 'mismatched', registry: 'wasiai', input: {} }],
      scopingKeyRow: makeKeyRow({ allowed_registries: ['wasiai'] }),
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SCOPE_DENIED');
    expect(result.scopeDeniedTarget?.registry).toBe('other');
  });

  it('T-SCOPE-7 (AC-7): step 1 fails scope → step 2 NOT invoked', async () => {
    const ok = makeAgent({ slug: 's0', registry: 'wasiai', priceUsdc: 0 });
    const denied = makeAgent({
      slug: 's1',
      registry: 'other',
      priceUsdc: 0,
    });
    vi.mocked(discoveryService.getAgent)
      .mockResolvedValueOnce(ok)
      .mockResolvedValueOnce(ok) // for next-step bridge resolution after step 0
      .mockResolvedValueOnce(denied);
    mockFetchOk({ result: 'step0-done' });

    const result = await composeService.compose({
      steps: [
        { agent: 's0', input: {} },
        { agent: 's1', input: {} },
      ],
      scopingKeyRow: makeKeyRow({ allowed_registries: ['wasiai'] }),
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SCOPE_DENIED');
    expect(result.steps).toHaveLength(1);
    // Solo step 0 disparó fetch; step 1 abortado antes de invokeAgent.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('T-SCOPE-8 (corner): allowed_categories=defi but agent has no metadata.category → SCOPE_DENIED', async () => {
    const agent = makeAgent({
      slug: 'no-cat',
      registry: 'wasiai',
      priceUsdc: 0,
      metadata: {}, // ningún campo category
    });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);

    const result = await composeService.compose({
      steps: [{ agent: 'no-cat', input: {} }],
      scopingKeyRow: makeKeyRow({ allowed_categories: ['defi'] }),
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SCOPE_DENIED');
    // category undefined → omitida del scopeDeniedTarget (CD anti-undefined-in-JSON)
    expect(result.scopeDeniedTarget?.category).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('T-SCOPE-9 (CD-13): scopingKeyRow=undefined → check skipped, x402 path intact', async () => {
    const agent = makeAgent({
      slug: 'any',
      registry: 'restricted',
      priceUsdc: 0,
    });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);
    mockFetchOk({ result: 'done' });

    // NO scopingKeyRow → check NO se ejecuta (path x402)
    const result = await composeService.compose({
      steps: [{ agent: 'any', input: {} }],
    });

    expect(result.success).toBe(true);
    expect(result.errorCode).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// WKH-59 (real-price-debit) AC-2: multi-step debit for steps 2..N
// CD-11: guard `i > 0` is the ONLY defense against double-debiting step 0
//   (step 0 is debited by the middleware via composeEstimatedCostUsd).
// CD-14: NO failNext — only mockResolvedValueOnce chained.
// ─────────────────────────────────────────────────────────────────────

describe('composeService.compose — WKH-59 multi-step debit (AC-2)', () => {
  // Helper: route discoveryService.getAgent by slug for deterministic
  // resolveAgent + lookahead behavior in multi-step pipelines.
  function mockAgentsBySlug(agents: Record<string, Agent>) {
    vi.mocked(discoveryService.getAgent).mockImplementation(
      async (slug: string, _registry?: string) => agents[slug] ?? null,
    );
  }

  it('T-COMPOSE-DEBIT-1 should debit step 1 (i=1) via budgetService.debit', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({
      slug: 'corridor',
      priceUsdc: 0.05,
      id: 'agent-2',
    });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk({ result: 'r1' });
    mockFetchOk({ result: 'r2' });

    const keyRow = makeKeyRow({ id: 'k1' });

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(true);
    // Only step 1 is debited via service (step 0 is the middleware's job).
    expect(mockDebit).toHaveBeenCalledTimes(1);
    // WKH-101 (DT-11): compose now passes request.delegationContext as the 4th
    // arg; master-key path → undefined (CD-5 backward-compat).
    // WKH-121 (BLQ-ALTO-1): 5th arg = request.keySessionContext (undefined → no session).
    expect(mockDebit).toHaveBeenCalledWith(
      'k1',
      2368,
      0.05,
      undefined,
      undefined,
      'test-registry/corridor',
      'owner-test', // F-04 (audit): threaded caller owner_ref
    );
  });

  // ── WKH-234 fix-pack AR-BLQ-1: threading compose → ledger (AC-8) ──────
  // Test de INTEGRACIÓN (no un unit del debit aislado): corre el pipeline real
  // de compose; cuando el settle DOWNSTREAM de un leg fue Solana
  // (signAndSettleDownstream retorna `nonEvmSettle`), compose DEBE registrar el
  // CAIP-2 + firma base58 en el ledger vía `budgetService.recordSolanaSettleReceipt`,
  // reusando el `owner_ref` del caller (CD-1/AC-9). Un leg EVM NO lo dispara.
  const SOL_CAIP2_INTEG = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
  const SOL_SIG_INTEG = '5'.repeat(64); // firma base58 (opaca)

  it('T-234-AC8-INTEG: solana downstream leg → compose records settle_caip2 + signature in the ledger (reuses ownerRef)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk({ result: 'r1' }); // step 0 invoke
    mockFetchOk({ result: 'r2' }); // step 1 invoke
    // step 0 downstream = none; step 1 downstream settled on Solana.
    mockDownstream.mockReset();
    mockDownstream.mockResolvedValueOnce(null);
    mockDownstream.mockResolvedValueOnce({
      txHash: SOL_SIG_INTEG,
      // Fix-pack AR-profundo FIX 3: el fixture ahora declara el monto REALMENTE
      // settleado (0.05 USDC 6-dec = 50000 atómico) — el que el ledger debe
      // registrar. La aserción de `amountUsd` NO cambia (0.05): antes coincidía
      // por casualidad con `stepDebitedUsd` porque este test pone el leg Solana
      // en el step 1 (el único índice donde el bug no aparecía); ahora viene del
      // recibo. El caso del step 0 lo cubre T-FIX3-STEP0.
      //
      // Fix-pack CR-MNR-1: el CAIP-2 y el monto viajan en UN campo anidado
      // (`nonEvmSettle`), no en dos opcionales sueltos — el fixture ya no puede
      // representar "CAIP-2 sin monto", que era el estado que reintroducía el bug.
      settledAmount: '50000',
      nonEvmSettle: { caip2: SOL_CAIP2_INTEG, amountUsd: 0.05 },
    });

    const keyRow = makeKeyRow({ id: 'k1', owner_ref: 'owner-test' });

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(true);
    // Runtime registration of the CAIP-2 + signature happened (this is the exact
    // path the AR flagged as a false-green — no runtime call before the fix).
    expect(mockRecordSolana).toHaveBeenCalledTimes(1);
    expect(mockRecordSolana).toHaveBeenCalledWith({
      keyId: 'k1',
      ownerRef: 'owner-test', // reused caller owner_ref (CD-1/AC-9)
      chainId: 2368,
      amountUsd: 0.05, // = nonEvmSettle.amountUsd (monto REAL settleado on-chain)
      settleCaip2: SOL_CAIP2_INTEG,
      settleSignature: SOL_SIG_INTEG,
    });
  });

  // ── Fix-pack AR-profundo FIX 3: el step 0 (caso MÁS común) ────────────────
  // El único test de AC-8 ponía el leg Solana en el step 1 — el único índice
  // donde el bug no aparecía. Con el leg en el step 0, `stepDebitedUsd` es 0 por
  // construcción (el debit per-step está gateado por `i > 0`; el step 0 lo debita
  // el middleware), así que el ledger emitía `amount_usd = 0` junto a una
  // `settle_signature` base58 REAL: la reconciliación cruzaba $0 contra una
  // transferencia real.
  it('T-FIX3-STEP0: leg Solana en el step 0 → el ledger registra el monto REAL settleado, NO 0', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const only = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    mockAgentsBySlug({ kyc: only });
    mockFetchOk({ result: 'r1' });
    // Compose de UN step: el leg Solana ES el step 0.
    mockDownstream.mockReset();
    mockDownstream.mockResolvedValueOnce({
      txHash: SOL_SIG_INTEG,
      settledAmount: '1000', // 0.001 USDC (6-dec)
      nonEvmSettle: { caip2: SOL_CAIP2_INTEG, amountUsd: 0.001 },
    });

    const keyRow = makeKeyRow({ id: 'k1', owner_ref: 'owner-test' });

    const result = await composeService.compose({
      steps: [{ agent: 'kyc', input: {} }],
      scopingKeyRow: keyRow,
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(true);
    // El step 0 NO pasa por budgetService.debit (lo debita el middleware) →
    // `stepDebitedUsd` sigue siendo 0. El recibo NO debe heredar ese 0.
    expect(mockDebit).not.toHaveBeenCalled();
    expect(mockRecordSolana).toHaveBeenCalledTimes(1);
    expect(mockRecordSolana).toHaveBeenCalledWith({
      keyId: 'k1',
      ownerRef: 'owner-test',
      chainId: 2368,
      amountUsd: 0.001, // ← antes del fix: 0
      settleCaip2: SOL_CAIP2_INTEG,
      settleSignature: SOL_SIG_INTEG,
    });
    const recorded = mockRecordSolana.mock.calls[0]?.[0];
    expect(recorded?.amountUsd).not.toBe(0);
  });

  it('T-234-AC8-INTEG-b: EVM downstream leg → NO ledger CAIP-2 record (column stays NULL, byte-identical)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk({ result: 'r1' });
    mockFetchOk({ result: 'r2' });
    // Both legs settled on EVM (no `nonEvmSettle` on the downstream result).
    mockDownstream.mockReset();
    mockDownstream.mockResolvedValue({
      txHash: '0xdeadbeef',
      settledAmount: '50000',
    });

    const keyRow = makeKeyRow({ id: 'k1', owner_ref: 'owner-test' });

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(true);
    // EVM legs never touch the Solana settle receipt path (AC-4 byte-identity).
    expect(mockRecordSolana).not.toHaveBeenCalled();
  });

  it('T-COMPOSE-DEBIT-2 should debit steps 1 and 2 in a 3-step pipeline', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({
      slug: 'corridor',
      priceUsdc: 0.05,
      id: 'agent-2',
    });
    const a3 = makeAgent({
      slug: 'cashout',
      priceUsdc: 0.01,
      id: 'agent-3',
    });
    mockAgentsBySlug({ kyc: a1, corridor: a2, cashout: a3 });
    mockFetchOk();
    mockFetchOk();
    mockFetchOk();

    const keyRow = makeKeyRow({ id: 'k1' });

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
        { agent: 'cashout', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(true);
    expect(mockDebit).toHaveBeenCalledTimes(2);
    // WKH-101 (DT-11): 4th arg = request.delegationContext (undefined → master path).
    // WKH-121 (BLQ-ALTO-1): 5th arg = request.keySessionContext (undefined → no session).
    expect(mockDebit).toHaveBeenNthCalledWith(
      1,
      'k1',
      2368,
      0.05,
      undefined,
      undefined,
      'test-registry/corridor',
      'owner-test', // F-04 (audit): threaded caller owner_ref
    );
    expect(mockDebit).toHaveBeenNthCalledWith(
      2,
      'k1',
      2368,
      0.01,
      undefined,
      undefined,
      'test-registry/cashout',
      'owner-test', // F-04 (audit): threaded caller owner_ref
    );
  });

  // WKH-128: si un step se debitó (fee-on-attempt) y luego falla la invocación,
  // el débito per-step se reembolsa (el caller no pagó un step sin valor).
  it('T-COMPOSE-REFUND-1 refunds the per-step debit when the step fails after debiting', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk(); // step 0 OK
    mockFetchError(502); // step 1 falla la invocación

    const keyRow = makeKeyRow({ id: 'k1', owner_ref: 'owner-test' });

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Step 1 failed');
    // WKH-129: se debitó el step 1 (0.05) vía debit_with_dest_policy (tenía destination)
    // → se reembolsa vía creditWithDest con el MISMO destination canónico, MISMO monto.
    expect(mockDebit).toHaveBeenCalledTimes(1);
    expect(mockCreditWithDest).toHaveBeenCalledTimes(1);
    expect(mockCreditWithDest).toHaveBeenCalledWith(
      'k1',
      2368,
      0.05,
      'owner-test',
      'test-registry/corridor', // normalizeDestination(`${registry}/${slug}`) del agente del step
      { idemKey: expect.any(String) }, // HU-194
    );
    // el path 4-arg (credit) NO se usa cuando hay destination.
    expect(mockCredit).not.toHaveBeenCalled();
  });

  // WKH-129 (CD-10): invariante de no-pérdida — el refund per-step revierte EXACTAMENTE
  // el monto debitado (ni más ni menos) y con el destination del débito.
  it('T-COMPOSE-REFUND-DEST-2 refund amount equals debit amount for the same step', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk(); // step 0 OK
    mockFetchError(502); // step 1 falla la invocación

    const keyRow = makeKeyRow({ id: 'k1', owner_ref: 'owner-test' });

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(false);
    // el monto debitado del step que falló == el monto refundado (3er arg de ambas calls).
    const debitAmount = mockDebit.mock.calls[0]![2];
    const refundAmount = mockCreditWithDest.mock.calls[0]![2];
    expect(refundAmount).toBe(debitAmount);
    expect(refundAmount).toBe(0.05);
    // y mismo destination en débito (6º arg de debit) y refund (5º arg de creditWithDest).
    expect(mockDebit.mock.calls[0]![5]).toBe('test-registry/corridor');
    expect(mockCreditWithDest.mock.calls[0]![4]).toBe('test-registry/corridor');
  });

  // M3 (audit 2026-06-24): el destino canónico del step se resuelve UNA sola vez
  // (`stepDestination`) y se propaga al débito Y a su refund. Asertamos que el arg
  // `destination` del débito (6º de debit) y el del refund (5º de creditWithDest)
  // son EXACTAMENTE el MISMO string — no dos derivaciones que podrían divergir.
  it('M3 step 1..N that fails → débito and refund use the IDENTICAL destination string', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk(); // step 0 OK
    mockFetchError(502); // step 1 falla la invocación tras debitar

    const keyRow = makeKeyRow({ id: 'k1', owner_ref: 'owner-test' });

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(false);
    expect(mockDebit).toHaveBeenCalledTimes(1);
    expect(mockCreditWithDest).toHaveBeenCalledTimes(1);
    const debitDestination = mockDebit.mock.calls[0]![5];
    const refundDestination = mockCreditWithDest.mock.calls[0]![4];
    // Identidad estricta: misma fuente única → mismo string byte a byte.
    expect(refundDestination).toBe(debitDestination);
    expect(debitDestination).toBe('test-registry/corridor');
  });

  // M3 (audit 2026-06-24): el destino sale del AGENTE RESUELTO (agent.registry/
  // agent.slug), NO del registry hint del body. Si el caller pasa un hint que
  // difiere pero resuelve al mismo agente, débito y refund DEBEN seguir usando
  // el MISMO destino canónico (el del agente resuelto), nunca el hint.
  it('M3 registry hint differs but resolves to same agent → débito and refund share the canonical destination', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    // El agente resuelto tiene registry canónico 'test-registry', distinto del
    // hint 'wrong-hint' que pasa el caller. mockAgentsBySlug ignora el hint y
    // devuelve el agente por slug (espeja la resolución real por slug).
    const a2 = makeAgent({
      slug: 'corridor',
      priceUsdc: 0.05,
      id: 'agent-2',
      registry: 'test-registry',
    });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk(); // step 0 OK
    mockFetchError(502); // step 1 falla tras debitar

    const keyRow = makeKeyRow({ id: 'k1', owner_ref: 'owner-test' });

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        // hint divergente — NO debe filtrarse al destino del cap.
        { agent: 'corridor', registry: 'wrong-hint', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(false);
    const debitDestination = mockDebit.mock.calls[0]![5];
    const refundDestination = mockCreditWithDest.mock.calls[0]![4];
    // El destino canónico es el del agente resuelto, no el hint 'wrong-hint'.
    expect(debitDestination).toBe('test-registry/corridor');
    expect(refundDestination).toBe(debitDestination);
    expect(refundDestination).not.toContain('wrong-hint');
  });

  // M3 (audit 2026-06-24): retry adaptativo — el re-débito del retry usa el MISMO
  // destino canónico que el débito original y su refund. Asegura que las 3 capas
  // (débito, refund#1, re-débito del retry) comparten la única fuente.
  it('M3 adaptive retry re-debit uses the same canonical destination as the original debit', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk(); // step 0 OK
    // step 1 falla con field-errors → dispara el retry (4xx con missing fields).
    mockFetchError(400, '{"error":"missing required field: amount"}');
    // El re-invoke del retry también falla (no importa el resultado, solo el
    // destino de los débitos).
    mockFetchError(502);
    // LLM regenera input → habilita el retry path.
    mockRegen.mockResolvedValue({ amount: 100 });

    const keyRow = makeKeyRow({ id: 'k1', owner_ref: 'owner-test' });

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(false);
    // Dos débitos: el original (call 0) y el re-débito del retry (call 1).
    expect(mockDebit).toHaveBeenCalledTimes(2);
    const originalDebitDest = mockDebit.mock.calls[0]![5];
    const retryDebitDest = mockDebit.mock.calls[1]![5];
    expect(retryDebitDest).toBe(originalDebitDest);
    expect(originalDebitDest).toBe('test-registry/corridor');
    // Y cada refund usa ese mismo destino canónico.
    for (const call of mockCreditWithDest.mock.calls) {
      expect(call[4]).toBe('test-registry/corridor');
    }
  });

  // A2 (audit 2026-06-24): si el refund#1 NO revirtió de verdad (la RPC afectó 0
  // filas → `reverted:false`), el retry adaptativo NO debe re-debitar. Asegura que
  // hay UN SOLO débito (el original), nunca un segundo: evita el doble consumo del
  // dest-cap. El step falla con el error original.
  it('A2 adaptive retry does NOT re-debit when refund#1 did not revert (reverted:false)', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk(); // step 0 OK
    // step 1 falla con field-errors → sería elegible para retry.
    mockFetchError(400, '{"error":"missing required field: amount"}');
    // LLM regeneraría input (el retry path estaría habilitado SI el refund hubiera
    // revertido). No debe llegar a re-invocar.
    mockRegen.mockResolvedValue({ amount: 100 });
    // El refund#1 corre pero NO revierte (0 filas → reverted:false).
    mockCreditWithDest.mockResolvedValue({
      success: false,
      error: 'REFUND_NOT_REVERTED',
      reverted: false,
    });

    const keyRow = makeKeyRow({ id: 'k1', owner_ref: 'owner-test' });

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(false);
    // UN SOLO débito (el original del step 1). NUNCA un segundo (re-debit del retry).
    expect(mockDebit).toHaveBeenCalledTimes(1);
    // El LLM no debió siquiera invocarse (el gate refund1ok corta antes).
    expect(mockRegen).not.toHaveBeenCalled();
  });

  // WKH-128: el step-0 NO lo debita compose (es del middleware/service), así que
  // si el step-0 falla, compose NO reembolsa (no hay stepDebitedUsd>0).
  it('T-COMPOSE-REFUND-2 does NOT refund when step 0 fails (compose never debited it)', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    mockAgentsBySlug({ kyc: a1 });
    mockFetchError(502); // step 0 falla

    const keyRow = makeKeyRow({ id: 'k1', owner_ref: 'owner-test' });

    const result = await composeService.compose({
      steps: [{ agent: 'kyc', input: {} }],
      scopingKeyRow: keyRow,
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(false);
    expect(mockDebit).not.toHaveBeenCalled();
    expect(mockCredit).not.toHaveBeenCalled();
    expect(mockCreditWithDest).not.toHaveBeenCalled(); // WKH-129
  });

  // WKH-128: bajo delegación, el refund per-step NO aplica (revertir contadores
  // de delegación queda fuera de scope, igual que WKH-127). El débito ocurre vía
  // el RPC de delegación; compose no llama credit() (evita revertir solo el budget
  // master y dejar el contador de delegación inconsistente).
  it('T-COMPOSE-REFUND-3 does NOT credit under delegation (out of scope)', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk(); // step 0 OK
    mockFetchError(502); // step 1 falla

    const keyRow = makeKeyRow({ id: 'k1', owner_ref: 'owner-test' });

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
      delegationContext: {
        delegationId: 'del-1',
        ownerRef: 'owner-test',
        keyId: 'k1',
        maxAmountPerTx: '5.00',
      },
    });

    expect(result.success).toBe(false);
    expect(mockCredit).not.toHaveBeenCalled();
    expect(mockCreditWithDest).not.toHaveBeenCalled(); // WKH-129
  });

  // WKH-101 T8b (AC-8 MULTI-STEP): under delegation, the per-step debit routes
  // the delegationContext as the 4th arg. When max_total is hit mid-pipeline,
  // compose cuts AT THAT STEP — later steps are neither debited nor invoked.
  it('T8b multi-step total limit under delegation cuts at the exceeding step', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    const a3 = makeAgent({ slug: 'cashout', priceUsdc: 0.01, id: 'agent-3' });
    mockAgentsBySlug({ kyc: a1, corridor: a2, cashout: a3 });
    mockFetchOk(); // step 0 invoked
    mockFetchOk(); // step 1 invoked (debit succeeds)
    mockFetchOk(); // step 2 fetch — must NOT be consumed (cut before invoke)

    const delegationContext = {
      delegationId: 'del-1',
      ownerRef: 'user-1',
      keyId: 'k1',
      maxAmountPerTx: '5.00',
    };

    // step 1 debit OK, step 2 debit hits the total limit (atomic RPC mapping).
    mockDebit.mockReset();
    mockDebit.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({
      success: false,
      error: 'DELEGATION_TOTAL_LIMIT_EXCEEDED',
    });

    const keyRow = makeKeyRow({ id: 'k1' });

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
        { agent: 'cashout', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
      delegationContext,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('DELEGATION_TOTAL_LIMIT_EXCEEDED');
    // Cut a mitad: solo 2 débitos (steps 1 y 2); el step 2 NO se ejecuta.
    expect(mockDebit).toHaveBeenCalledTimes(2);
    expect(mockDebit).toHaveBeenNthCalledWith(
      1,
      'k1',
      2368,
      0.05,
      delegationContext,
      undefined,
      'test-registry/corridor',
      'owner-test', // F-04 (audit): threaded caller owner_ref
    );
    expect(mockDebit).toHaveBeenNthCalledWith(
      2,
      'k1',
      2368,
      0.01,
      delegationContext,
      undefined,
      'test-registry/cashout',
      'owner-test', // F-04 (audit): threaded caller owner_ref
    );
    // step 0 + step 1 invoked (2 fetches); step 2 fetch NOT consumed.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // results contiene solo los steps ejecutados (0 y 1).
    expect(result.steps.length).toBe(2);
  });

  it('T-COMPOSE-DEBIT-3 should abort pipeline when step 1 debit fails (insufficient)', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({
      slug: 'corridor',
      priceUsdc: 0.05,
      id: 'agent-2',
    });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk({ result: 'r1' });
    // Override default: first debit fails.
    mockDebit.mockReset();
    mockDebit.mockResolvedValueOnce({
      success: false,
      error: 'insufficient',
    });

    const keyRow = makeKeyRow({ id: 'k1' });

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Step 1 debit failed');
    expect(result.error).toContain('insufficient');
    // step 0 fetch occurred, step 1 fetch did NOT (debit aborted pre-invoke).
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // DT-H: NOT a SCOPE_DENIED error.
    expect(result.errorCode).toBeUndefined();
  });

  it('T-COMPOSE-DEBIT-4 should skip debit when scopingKeyRow is undefined (x402 path)', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({
      slug: 'corridor',
      priceUsdc: 0.05,
      id: 'agent-2',
    });
    const a3 = makeAgent({
      slug: 'cashout',
      priceUsdc: 0.01,
      id: 'agent-3',
    });
    mockAgentsBySlug({ kyc: a1, corridor: a2, cashout: a3 });
    mockFetchOk();
    mockFetchOk();
    mockFetchOk();

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
        { agent: 'cashout', input: {} },
      ],
      // No scopingKeyRow → x402 path → per-step debit MUST be skipped.
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(true);
    expect(mockDebit).not.toHaveBeenCalled();
  });

  it('T-COMPOSE-DEBIT-5 should skip debit when chainId is undefined', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({
      slug: 'corridor',
      priceUsdc: 0.05,
      id: 'agent-2',
    });
    const a3 = makeAgent({
      slug: 'cashout',
      priceUsdc: 0.01,
      id: 'agent-3',
    });
    mockAgentsBySlug({ kyc: a1, corridor: a2, cashout: a3 });
    mockFetchOk();
    mockFetchOk();
    mockFetchOk();

    const keyRow = makeKeyRow({ id: 'k1' });

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
        { agent: 'cashout', input: {} },
      ],
      scopingKeyRow: keyRow,
      // chainId intentionally omitted → defensive skip.
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(true);
    expect(mockDebit).not.toHaveBeenCalled();
  });

  it('T-COMPOSE-DEBIT-6 should NOT debit step 0 in service (anti-double-debit guard)', async () => {
    // CD-11: el step 0 NUNCA es debitado por el service — el middleware
    // ya lo debitó vía request.composeEstimatedCostUsd.
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({
      slug: 'corridor',
      priceUsdc: 0.05,
      id: 'agent-2',
    });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk();
    mockFetchOk();

    const keyRow = makeKeyRow({ id: 'k1' });

    await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    // Verify NO debit call carries step 0's priceUsdc (0.001) — that's the
    // middleware's responsibility. Service-level debits MUST be steps 1..N.
    for (const call of mockDebit.mock.calls) {
      expect(call[2]).not.toBe(0.001);
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // BLQ-MED-1 fix: fallback honesto para priceUsdc=0/null en steps 2..N.
  // AC-4 / CD-4. Mismo patrón que el preHandler de step 0
  // (src/routes/compose.ts:90-104), replicado en el service.
  // ─────────────────────────────────────────────────────────────────────

  it('T-COMPOSE-DEBIT-7 should debit step 1 with $1.00 fallback when priceUsdc===0 (BLQ-MED-1)', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    // step 1 agent has priceUsdc=0 (registry config error or "free" agent).
    // Service MUST fallback to $1.00 (NOT debit $0).
    const a2 = makeAgent({
      slug: 'free-bug',
      priceUsdc: 0,
      id: 'agent-2',
    });
    mockAgentsBySlug({ kyc: a1, 'free-bug': a2 });
    mockFetchOk();
    mockFetchOk();

    const keyRow = makeKeyRow({ id: 'k1' });

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'free-bug', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(true);
    expect(mockDebit).toHaveBeenCalledTimes(1);
    // amount === 1.0 (fallback), NOT 0
    expect(mockDebit).toHaveBeenCalledWith(
      'k1',
      2368,
      1.0,
      undefined,
      undefined,
      'test-registry/free-bug',
      'owner-test', // F-04 (audit): threaded caller owner_ref
    );
  });

  it('T-COMPOSE-DEBIT-8 should emit warn log with reason=registry-miss when priceUsdc===0 (BLQ-MED-1)', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({
      slug: 'free-bug',
      priceUsdc: 0,
      id: 'agent-2',
    });
    mockAgentsBySlug({ kyc: a1, 'free-bug': a2 });
    mockFetchOk();
    mockFetchOk();

    const keyRow = makeKeyRow({ id: 'k1' });
    // Inject DownstreamLogger-compatible logger (Pino shape).
    const warnSpy = vi.fn();
    const logger = { warn: warnSpy, info: vi.fn() };

    await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'free-bug', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
      logger,
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'registry-miss',
        slug: 'free-bug',
        step: 1,
      }),
      'compose-price.fallback per-step',
    );
  });

  it('T-COMPOSE-DEBIT-9 should apply same fallback when priceUsdc is null/non-number (BLQ-MED-1)', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    // priceUsdc=null is invalid per Agent type, but defensive code must
    // handle it (registry returns malformed data). Cast via unknown to
    // bypass TS guard for this defensive scenario.
    const a2 = makeAgent({
      slug: 'null-price',
      id: 'agent-2',
    });
    (a2 as unknown as { priceUsdc: number | null }).priceUsdc = null;
    mockAgentsBySlug({ kyc: a1, 'null-price': a2 });
    mockFetchOk();
    mockFetchOk();

    const keyRow = makeKeyRow({ id: 'k1' });
    const warnSpy = vi.fn();
    const logger = { warn: warnSpy, info: vi.fn() };

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'null-price', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
      logger,
    });

    expect(result.success).toBe(true);
    expect(mockDebit).toHaveBeenCalledTimes(1);
    // typeof null !== 'number' → fallback $1
    expect(mockDebit).toHaveBeenCalledWith(
      'k1',
      2368,
      1.0,
      undefined,
      undefined,
      'test-registry/null-price',
      'owner-test', // F-04 (audit): threaded caller owner_ref
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'registry-miss',
        slug: 'null-price',
        step: 1,
      }),
      'compose-price.fallback per-step',
    );
  });

  // WKH-142 (T4 / AC-3): per-step con priceUsdc negativo → mismo fallback honesto
  // (PLACEHOLDER_FEE_USD, NUNCA un débito negativo) + warn reason='registry-miss'.
  it('T4 (AC-3) per-step negative priceUsdc → fallback debit (never negative) + registry-miss warn', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({
      slug: 'neg-price',
      priceUsdc: -1,
      id: 'agent-2',
    });
    mockAgentsBySlug({ kyc: a1, 'neg-price': a2 });
    mockFetchOk();
    mockFetchOk();

    const keyRow = makeKeyRow({ id: 'k1' });
    const warnSpy = vi.fn();
    const logger = { warn: warnSpy, info: vi.fn() };

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'neg-price', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
      logger,
    });

    expect(result.success).toBe(true);
    expect(mockDebit).toHaveBeenCalledTimes(1);
    // priceUsdc < 0 → isInvalid → fallback $1 (NUNCA el -1 negativo).
    expect(mockDebit).toHaveBeenCalledWith(
      'k1',
      2368,
      1.0,
      undefined,
      undefined,
      'test-registry/neg-price',
      'owner-test',
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'registry-miss',
        slug: 'neg-price',
        step: 1,
      }),
      'compose-price.fallback per-step',
    );
  });

  // WKH-142 (T9 / no-regresión): per-step con priceUsdc POSITIVO legítimo sigue
  // debitando el precio real (no el fallback) y NO emite el warn registry-miss.
  it('T9 no-regression: positive per-step priceUsdc debits the real price, no fallback', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({
      slug: 'paid',
      priceUsdc: 1.0,
      id: 'agent-2',
    });
    mockAgentsBySlug({ kyc: a1, paid: a2 });
    mockFetchOk();
    mockFetchOk();

    const keyRow = makeKeyRow({ id: 'k1' });
    const warnSpy = vi.fn();
    const logger = { warn: warnSpy, info: vi.fn() };

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'paid', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
      logger,
    });

    expect(result.success).toBe(true);
    expect(mockDebit).toHaveBeenCalledTimes(1);
    // priceUsdc 1.0 válido → debita el precio real (no el fallback).
    expect(mockDebit).toHaveBeenCalledWith(
      'k1',
      2368,
      1.0,
      undefined,
      undefined,
      'test-registry/paid',
      'owner-test',
    );
    // NO se emite el warn registry-miss para un precio válido.
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'registry-miss' }),
      'compose-price.fallback per-step',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// WKH-121 (BLQ-ALTO-1 / MNR-1): T-SESS-MULTISTEP
// El cap max_budget_usd de la session key debe respetarse en TODOS los steps
// del pipeline (1..N), no solo en el step 0 (que lo debita el middleware).
// Antes del fix, compose pasaba el 5º arg keySessionContext como `undefined`
// → budget.debit caía a la ruta master (increment_a2a_key_spend directo) →
// el cap de la sesión se ignoraba y un token filtrado drenaba el parent vía
// multi-step. Este UNIT prueba la propagación del 5º arg por la cadena.
// ─────────────────────────────────────────────────────────────────────────
describe('composeService.compose — WKH-121 key-session multi-step (T-SESS-MULTISTEP)', () => {
  function mockAgentsBySlug(agents: Record<string, Agent>) {
    vi.mocked(discoveryService.getAgent).mockImplementation(
      async (slug: string, _registry?: string) => agents[slug] ?? null,
    );
  }

  const keySessionContext = {
    sessionId: 'sess-1',
    ownerRef: 'owner-test',
    keyId: 'k1',
  };

  // (a) El cap de sesión se aplica en cada step i>0: budgetService.debit recibe
  //     keySessionContext (NO undefined) como 5º arg para todos los steps.
  it('T-SESS-MULTISTEP (a) propaga keySessionContext como 5º arg en cada step i>0', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    const a3 = makeAgent({ slug: 'cashout', priceUsdc: 0.01, id: 'agent-3' });
    mockAgentsBySlug({ kyc: a1, corridor: a2, cashout: a3 });
    mockFetchOk();
    mockFetchOk();
    mockFetchOk();

    const keyRow = makeKeyRow({ id: 'k1' });

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
        { agent: 'cashout', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
      keySessionContext,
    });

    expect(result.success).toBe(true);
    // step 0 lo debita el middleware; acá solo steps 1 y 2.
    expect(mockDebit).toHaveBeenCalledTimes(2);
    // 5º arg = keySessionContext (definido), NO undefined → ruta RPC de sesión.
    expect(mockDebit).toHaveBeenNthCalledWith(
      1,
      'k1',
      2368,
      0.05,
      undefined,
      keySessionContext,
      'test-registry/corridor',
      'owner-test', // F-04 (audit): threaded caller owner_ref
    );
    expect(mockDebit).toHaveBeenNthCalledWith(
      2,
      'k1',
      2368,
      0.01,
      undefined,
      keySessionContext,
      'test-registry/cashout',
      'owner-test', // F-04 (audit): threaded caller owner_ref
    );
  });

  // (b) Cap agotado a mitad de camino: compose corta en el step k y NO debita
  //     ni invoca los steps > k.
  it('T-SESS-MULTISTEP (b) corta el pipeline cuando el cap de sesión se agota a mitad', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    const a3 = makeAgent({ slug: 'cashout', priceUsdc: 0.01, id: 'agent-3' });
    mockAgentsBySlug({ kyc: a1, corridor: a2, cashout: a3 });
    mockFetchOk(); // step 0 invoked
    mockFetchOk(); // step 1 invoked (debit succeeds)
    mockFetchOk(); // step 2 fetch — must NOT be consumed (cut before invoke)

    // step 1 debit OK; step 2 debit agota el cap de la sesión (RPC mapping).
    mockDebit.mockReset();
    mockDebit.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({
      success: false,
      error: 'SESSION_BUDGET_EXHAUSTED',
    });

    const keyRow = makeKeyRow({ id: 'k1' });

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
        { agent: 'cashout', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
      keySessionContext,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('SESSION_BUDGET_EXHAUSTED');
    // Cut a mitad: solo 2 débitos (steps 1 y 2); step 2 NO se ejecuta.
    expect(mockDebit).toHaveBeenCalledTimes(2);
    expect(mockDebit).toHaveBeenNthCalledWith(
      1,
      'k1',
      2368,
      0.05,
      undefined,
      keySessionContext,
      'test-registry/corridor',
      'owner-test', // F-04 (audit): threaded caller owner_ref
    );
    expect(mockDebit).toHaveBeenNthCalledWith(
      2,
      'k1',
      2368,
      0.01,
      undefined,
      keySessionContext,
      'test-registry/cashout',
      'owner-test', // F-04 (audit): threaded caller owner_ref
    );
    // step 0 + step 1 invoked (2 fetches); step 2 fetch NOT consumed.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.steps.length).toBe(2);
  });

  // (c) Anti-regresión WKH-101: bajo delegationContext (y keySessionContext
  //     undefined) la cadena vieja sigue idéntica — 4º arg delegationContext,
  //     5º arg undefined.
  it('T-SESS-MULTISTEP (c) anti-regresión: delegationContext intacto, keySessionContext undefined', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk();
    mockFetchOk();

    const delegationContext = {
      delegationId: 'del-1',
      ownerRef: 'owner-test',
      keyId: 'k1',
      maxAmountPerTx: '5.00',
    };

    const keyRow = makeKeyRow({ id: 'k1' });

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
      delegationContext,
      // keySessionContext deliberadamente ausente (undefined).
    });

    expect(result.success).toBe(true);
    expect(mockDebit).toHaveBeenCalledTimes(1);
    // 4º arg = delegationContext (cadena WKH-101 intacta); 5º arg = undefined.
    expect(mockDebit).toHaveBeenCalledWith(
      'k1',
      2368,
      0.05,
      delegationContext,
      undefined,
      'test-registry/corridor',
      'owner-test', // F-04 (audit): threaded caller owner_ref
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// WKH-106 (BASE-03) — selector telemetry on Base settle path.
//
// The Base adapter itself already honors CDP_FACILITATOR_URL via its own
// env-var fallback chain (src/adapters/base/payment.ts:163-170). The compose
// integration logs the selector decision so AC-2 / AC-5 / AC-7 are
// observable from the compose layer. These tests verify the log line
// is emitted only when the agent's manifest declares a Base chain.
// ─────────────────────────────────────────────────────────────────────────
// ─── WKH-104 (TD-SYBIL): caller_ref_hash emission in compose_step ─────────
describe('composeService.compose — caller_ref_hash emission (WKH-104)', () => {
  const TEST_SECRET = 'wkh104-compose-test-secret';
  let prevSecret: string | undefined;

  beforeEach(() => {
    prevSecret = process.env.REPUTATION_CALLER_HMAC_SECRET;
    process.env.REPUTATION_CALLER_HMAC_SECRET = TEST_SECRET;
  });
  afterEach(() => {
    if (prevSecret === undefined)
      delete process.env.REPUTATION_CALLER_HMAC_SECRET;
    else process.env.REPUTATION_CALLER_HMAC_SECRET = prevSecret;
  });

  function expectedHash(ownerRef: string): string {
    return crypto
      .createHmac('sha256', TEST_SECRET)
      .update(ownerRef)
      .digest('hex');
  }

  it('T-SYBIL-1: success compose_step → metadata.caller_ref_hash === HMAC(owner_ref) (AC-9)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const trackSpy = vi.mocked(eventService.track);
    trackSpy.mockResolvedValue({} as never);
    const agent = makeAgent({ slug: 's1', id: 'agent-s1', priceUsdc: 0 });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: 'ok' }),
    });

    await composeService.compose({
      steps: [{ agent: 's1', input: {} }],
      scopingKeyRow: makeKeyRow({ owner_ref: 'owner-sybil-A' }),
    });

    const call = trackSpy.mock.calls.find((c) => c[0].agentId === 's1');
    expect(call).toBeDefined();
    expect(call?.[0].status).toBe('success');
    expect(call?.[0].metadata?.caller_ref_hash).toBe(
      expectedHash('owner-sybil-A'),
    );
    // privacidad (CD-5): el owner_ref crudo NUNCA aparece en metadata.
    expect(JSON.stringify(call?.[0].metadata)).not.toContain('owner-sybil-A');
  });

  it('T-SYBIL-2: failed compose_step → metadata.caller_ref_hash present (AC-9)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const trackSpy = vi.mocked(eventService.track);
    trackSpy.mockResolvedValue({} as never);
    const agent = makeAgent({ slug: 'f1', id: 'agent-f1', priceUsdc: 0 });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);
    // Reset any queued once-values from prior tests; force every fetch to fail
    // so invokeAgent throws → failed branch (no queue-pollution dependency).
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'fail' }),
    });

    await composeService.compose({
      steps: [{ agent: 'f1', input: {} }],
      scopingKeyRow: makeKeyRow({ owner_ref: 'owner-sybil-B' }),
    });

    const call = trackSpy.mock.calls.find(
      (c) => c[0].agentId === 'f1' && c[0].status === 'failed',
    );
    expect(call).toBeDefined();
    expect(call?.[0].metadata?.caller_ref_hash).toBe(
      expectedHash('owner-sybil-B'),
    );
    expect(JSON.stringify(call?.[0].metadata)).not.toContain('owner-sybil-B');
  });

  it('T-SYBIL-3: anonymous (no scopingKeyRow) → caller_ref_hash null (AC-10/AC-12)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const trackSpy = vi.mocked(eventService.track);
    trackSpy.mockResolvedValue({} as never);
    const agent = makeAgent({ slug: 'x1', id: 'agent-x1', priceUsdc: 0 });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: 'ok' }),
    });

    await composeService.compose({
      steps: [{ agent: 'x1', input: {} }],
      // no scopingKeyRow → x402 anónimo
    });

    const call = trackSpy.mock.calls.find((c) => c[0].agentId === 'x1');
    expect(call).toBeDefined();
    expect(call?.[0].metadata?.caller_ref_hash).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// WKH-130 (adaptive input-retry): el catch reintenta UNA vez cuando un step
// (i>0, path master) falla con 4xx-con-field-errors parseables. Anti-doble
// cobro: refund#1 SIEMPRE antes del re-debit (CD-1). Invariante neto (CD-13).
// ─────────────────────────────────────────────────────────────────────────
describe('composeService.compose — WKH-130 adaptive input-retry', () => {
  function mockAgentsBySlug(agents: Record<string, Agent>) {
    vi.mocked(discoveryService.getAgent).mockImplementation(
      async (slug: string, _registry?: string) => agents[slug] ?? null,
    );
  }
  // body 422 con field-errors Zod (parser → ['senderName']).
  const FIELD_ERR_BODY =
    '{"error":"invalid_input","details":{"fieldErrors":{"senderName":["Required"]}}}';

  // Σdébitos − Σrefunds (incluye credit y creditWithDest).
  function netSpend(): number {
    const debits = mockDebit.mock.calls.reduce(
      (s, c) => s + (c[2] as number),
      0,
    );
    const refunds =
      mockCreditWithDest.mock.calls.reduce((s, c) => s + (c[2] as number), 0) +
      mockCredit.mock.calls.reduce((s, c) => s + (c[2] as number), 0);
    return debits - refunds;
  }

  beforeEach(() => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
  });

  // AC-5 / T-RETRY-HAPPY: path feliz → 0 LLM calls, 0 overhead.
  it('T-RETRY-HAPPY: 2xx pipeline → regen NOT called', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk();
    mockFetchOk();

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
      ],
      scopingKeyRow: makeKeyRow({ id: 'k1' }),
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(true);
    expect(mockRegen).not.toHaveBeenCalled();
  });

  // AC-1 / T-RETRY-OK: retry exitoso → cobra 1 vez (neto = stepDebitedUsd).
  it('T-RETRY-OK: 422+fields → regen → 200; charges once; net = stepDebitedUsd', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk(); // step 0 OK
    mockFetchError(422, FIELD_ERR_BODY); // step 1 falla (4xx con fields)
    mockFetchOk({ result: 'retry-done' }); // re-invoke 2xx
    mockRegen.mockResolvedValueOnce({ q: 'x', senderName: 'Ana' });

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: { q: 'x' } },
      ],
      scopingKeyRow: makeKeyRow({ id: 'k1', owner_ref: 'owner-test' }),
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(true);
    expect(mockRegen).toHaveBeenCalledTimes(1);
    // 2 débitos (1er intento + retry), 1 refund (del 1er débito).
    expect(mockDebit).toHaveBeenCalledTimes(2);
    expect(mockCreditWithDest).toHaveBeenCalledTimes(1);
    expect(mockCredit).not.toHaveBeenCalled();
    // CD-13: invariante neto = stepDebitedUsd (0.05).
    expect(netSpend()).toBeCloseTo(0.05, 9);
  });

  // AC-6 / T-RETRY-ORDER: anti-doble-cobro — debit#1 < refund#1 < debit#2.
  it('T-RETRY-ORDER: debit#1 < refund#1 < debit#2 (no two active debits)', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk();
    mockFetchError(422, FIELD_ERR_BODY);
    mockFetchOk({ result: 'retry-done' });
    mockRegen.mockResolvedValueOnce({ q: 'x', senderName: 'Ana' });

    await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: { q: 'x' } },
      ],
      scopingKeyRow: makeKeyRow({ id: 'k1', owner_ref: 'owner-test' }),
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    const debit1 = mockDebit.mock.invocationCallOrder[0]!;
    const refund1 = mockCreditWithDest.mock.invocationCallOrder[0]!;
    const debit2 = mockDebit.mock.invocationCallOrder[1]!;
    expect(debit1).toBeLessThan(refund1);
    expect(refund1).toBeLessThan(debit2);
  });

  // AC-2 / T-RETRY-FAIL: retry falla → 2 débitos + 2 refunds, neto 0.
  it('T-RETRY-FAIL: 422+fields → regen → 500; 2 debits + 2 refunds; net = 0', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk();
    mockFetchError(422, FIELD_ERR_BODY); // 1er intento falla
    mockFetchError(500); // re-invoke falla
    mockRegen.mockResolvedValueOnce({ q: 'x', senderName: 'Ana' });

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: { q: 'x' } },
      ],
      scopingKeyRow: makeKeyRow({ id: 'k1', owner_ref: 'owner-test' }),
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('after retry');
    expect(result.error).toContain('returned 422');
    expect(result.error).toContain('returned 500');
    expect(mockDebit).toHaveBeenCalledTimes(2);
    expect(mockCreditWithDest).toHaveBeenCalledTimes(2);
    // CD-13: neto 0 (caller no paga nada).
    expect(netSpend()).toBeCloseTo(0, 9);
  });

  // CD-1 fix-pack (AR/CR obs): si el refund#1 FALLA, el retry NO procede
  // (no re-debit) → queda 1 solo débito, nunca 2 activos (peor caso pre-WKH-130).
  it('T-RETRY-REFUND1-FAILS: refund#1 fails → no retry, no re-debit (single debit stands)', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk(); // step 0 ok
    mockFetchError(422, FIELD_ERR_BODY); // step 1 falla con field-errors
    // el refund#1 del step 1 falla (credit RPC devuelve success:false)
    mockCreditWithDest.mockResolvedValueOnce({
      success: false,
      error: 'REFUND_FAILED',
    });

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: { q: 'x' } },
      ],
      scopingKeyRow: makeKeyRow({ id: 'k1', owner_ref: 'owner-test' }),
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(false);
    // Lo CRÍTICO: el retry NO procedió porque el refund#1 falló →
    //   - regen NUNCA se llamó (no se intentó regenerar input),
    //   - solo 1 débito (el original, NO se re-debitó) → nunca 2 débitos activos,
    //   - 1 solo intento de refund.
    // Peor caso real = 1 débito sin reembolso efectivo (= pre-WKH-130), nunca 2x.
    // (netSpend() no aplica acá: cuenta la LLAMADA a credit como refund aunque el
    //  RPC haya devuelto success:false — mide calls, no el movimiento real.)
    expect(mockRegen).not.toHaveBeenCalled();
    expect(mockDebit).toHaveBeenCalledTimes(1);
    expect(mockCreditWithDest).toHaveBeenCalledTimes(1);
  });

  // AC-3 / T-5XX-NO-RETRY: 5xx no reintenta.
  it('T-5XX-NO-RETRY: 500 → regen 0 calls; 1 refund; failure', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk();
    mockFetchError(500);

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
      ],
      scopingKeyRow: makeKeyRow({ id: 'k1', owner_ref: 'owner-test' }),
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(false);
    expect(mockRegen).not.toHaveBeenCalled();
    expect(mockCreditWithDest).toHaveBeenCalledTimes(1); // refund WKH-129 existente
    expect(mockDebit).toHaveBeenCalledTimes(1);
  });

  // AC-4 / T-4XX-NOFIELDS: 4xx sin field-errors no reintenta.
  it('T-4XX-NOFIELDS: 400 "Bad Request" → regen 0 calls', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk();
    mockFetchError(400, 'Bad Request');

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
      ],
      scopingKeyRow: makeKeyRow({ id: 'k1', owner_ref: 'owner-test' }),
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(false);
    expect(mockRegen).not.toHaveBeenCalled();
    expect(mockDebit).toHaveBeenCalledTimes(1);
    expect(mockCreditWithDest).toHaveBeenCalledTimes(1); // refund existente
  });

  // AC-7 / T-MAX-1: 2º 4xx tras retry no dispara un 3º.
  it('T-MAX-1: 422 → regen → 422 again → only 1 regen, 1 re-invoke, failure', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk(); // step 0
    mockFetchError(422, FIELD_ERR_BODY); // 1er intento
    mockFetchError(422, FIELD_ERR_BODY); // re-invoke también 422 (no 3er intento)
    mockRegen.mockResolvedValueOnce({ q: 'x', senderName: 'Ana' });

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: { q: 'x' } },
      ],
      scopingKeyRow: makeKeyRow({ id: 'k1', owner_ref: 'owner-test' }),
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(false);
    // CD-2: una sola regeneración, un solo re-invoke.
    expect(mockRegen).toHaveBeenCalledTimes(1);
    // step0 fetch + 1er intento + 1 re-invoke = 3 fetches (no 4º).
    expect(mockFetch).toHaveBeenCalledTimes(3);
    // 2 débitos, 2 refunds (neto 0).
    expect(mockDebit).toHaveBeenCalledTimes(2);
    expect(mockCreditWithDest).toHaveBeenCalledTimes(2);
  });

  // AC-8 / T-NON-4XX: error no-HTTP (SSRF/network) no entra al retry.
  it('T-NON-4XX: SSRF/network error → regen 0 calls; refund existente', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk(); // step 0 OK
    mockFetch.mockRejectedValueOnce(new Error('network ECONNRESET')); // step 1

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
      ],
      scopingKeyRow: makeKeyRow({ id: 'k1', owner_ref: 'owner-test' }),
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(false);
    expect(mockRegen).not.toHaveBeenCalled();
    expect(mockCreditWithDest).toHaveBeenCalledTimes(1);
  });

  // HU-194 (T-194-D1): el step con retry fallido produce DOS refunds legítimos —
  // el del primer débito y el del débito del retry — y sus claves de idempotencia
  // tienen que ser DISTINTAS. Si se colapsaran, la dedup DB-level descartaría el
  // segundo crédito y el caller perdería dinero REAL (un débito sin devolver).
  it('T-194-D1: refund del 1er débito y del débito del retry → claves de idempotencia DISTINTAS', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk();
    mockFetchError(422, FIELD_ERR_BODY); // 1er intento del step 1 → refund d1
    mockFetchError(500); // el retry también falla → refund d2
    mockRegen.mockResolvedValueOnce({ q: 'x', senderName: 'Ana' });

    await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: { q: 'x' } },
      ],
      scopingKeyRow: makeKeyRow({ id: 'k1', owner_ref: 'owner-test' }),
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    // Dos débitos reembolsados = dos créditos reales.
    expect(mockCreditWithDest).toHaveBeenCalledTimes(2);
    const first = mockCreditWithDest.mock.calls[0]?.[5] as { idemKey: string };
    const second = mockCreditWithDest.mock.calls[1]?.[5] as { idemKey: string };
    expect(first.idemKey).toBeTruthy();
    expect(second.idemKey).toBeTruthy();
    expect(first.idemKey).not.toBe(second.idemKey);
    // Y los slots dicen CUÁL refund es cada uno (auditable en la DB).
    expect(first.idemKey.endsWith(':d1')).toBe(true);
    expect(second.idemKey.endsWith(':d2')).toBe(true);
  });

  // HU-194 (T-194-D2): dos EJECUCIONES del mismo pipeline son dos débitos y dos
  // refunds legítimos → claves distintas (el `composeRunId` es por ejecución).
  it('T-194-D2: dos ejecuciones del mismo step → claves de idempotencia DISTINTAS', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    const run = async (): Promise<void> => {
      mockFetchOk();
      mockFetchError(500);
      await composeService.compose({
        steps: [
          { agent: 'kyc', input: {} },
          { agent: 'corridor', input: { q: 'x' } },
        ],
        scopingKeyRow: makeKeyRow({ id: 'k1', owner_ref: 'owner-test' }),
        chainId: 2368,
        a2aKey: 'wasi_a2a_test',
      });
    };
    await run();
    await run();

    expect(mockCreditWithDest).toHaveBeenCalledTimes(2);
    const a = mockCreditWithDest.mock.calls[0]?.[5] as { idemKey: string };
    const b = mockCreditWithDest.mock.calls[1]?.[5] as { idemKey: string };
    expect(a.idemKey).not.toBe(b.idemKey);
  });

  // AC-9 / T-OBS: telemetría — flags retried / retry_failed + log.
  it('T-OBS: success → metadata.retried; fail → metadata.retry_failed + [compose.retry]', async () => {
    const trackSpy = vi.mocked(eventService.track);

    // (a) retry exitoso → metadata.retried:true en el evento success.
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk();
    mockFetchError(422, FIELD_ERR_BODY);
    mockFetchOk({ result: 'retry-done' });
    mockRegen.mockResolvedValueOnce({ q: 'x', senderName: 'Ana' });

    await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: { q: 'x' } },
      ],
      scopingKeyRow: makeKeyRow({ id: 'k1', owner_ref: 'owner-test' }),
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    const okEvent = trackSpy.mock.calls.find(
      (c) => c[0].agentId === 'corridor' && c[0].status === 'success',
    );
    expect(okEvent?.[0].metadata?.retried).toBe(true);

    // (b) retry fallido → metadata.retry_failed:true + log [compose.retry].
    trackSpy.mockClear();
    logSpy.error.mockClear();
    mockFetchOk();
    mockFetchError(422, FIELD_ERR_BODY);
    mockFetchError(500);
    mockRegen.mockResolvedValueOnce({ q: 'x', senderName: 'Ana' });

    await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: { q: 'x' } },
      ],
      scopingKeyRow: makeKeyRow({ id: 'k1', owner_ref: 'owner-test' }),
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    const failEvent = trackSpy.mock.calls.find(
      (c) => c[0].status === 'failed' && c[0].metadata?.retry_failed === true,
    );
    expect(failEvent).toBeDefined();
    // log.error is called object-first, message-second: the '[compose.retry]'
    // marker is the second positional arg.
    const retryLog = logSpy.error.mock.calls.find((c) =>
      String(c[1]).includes('[compose.retry]'),
    );
    expect(retryLog).toBeDefined();
  });

  // CD-6 / T-DELEG-NO-RETRY: bajo delegación/sesión no reintenta.
  it('T-DELEG-NO-RETRY: delegationContext + 422+fields → regen 0 calls (no refund under delegation)', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk();
    mockFetchError(422, FIELD_ERR_BODY);

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
      ],
      scopingKeyRow: makeKeyRow({ id: 'k1', owner_ref: 'owner-test' }),
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
      delegationContext: {
        delegationId: 'del-1',
        ownerRef: 'owner-test',
        keyId: 'k1',
        maxAmountPerTx: '5.00',
      },
    });

    expect(result.success).toBe(false);
    // CD-6: delegación NUNCA reintenta.
    expect(mockRegen).not.toHaveBeenCalled();
    // WKH-128: bajo delegación no hay refund (out of scope).
    expect(mockCredit).not.toHaveBeenCalled();
    expect(mockCreditWithDest).not.toHaveBeenCalled();
  });

  it('T-SESS-NO-RETRY: keySessionContext + 422+fields → regen 0 calls', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk();
    mockFetchError(422, FIELD_ERR_BODY);

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
      ],
      scopingKeyRow: makeKeyRow({ id: 'k1', owner_ref: 'owner-test' }),
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
      keySessionContext: {
        sessionId: 'sess-1',
        ownerRef: 'owner-test',
        keyId: 'k1',
      },
    });

    expect(result.success).toBe(false);
    expect(mockRegen).not.toHaveBeenCalled();
  });
});

// B7 (audit 2026-06-24): discover() se cachea POR compose() — no se repite el
// discovery completo en cada step. resolveAgent llama discover ~1 vez por step
// (hidratación de payment); con N steps el loop hace ~2N-1 resolveAgent calls.
// Con el cache compartido, discover se invoca UNA sola vez por pipeline.
describe('composeService.compose — discover cache (B7)', () => {
  it('calls discoveryService.discover once for a multi-step pipeline, not once per resolveAgent', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);

    const agent1 = makeAgent({ slug: 'a1', priceUsdc: 0.1 });
    const agent2 = makeAgent({ slug: 'a2', priceUsdc: 0.1 });
    // resolveAgent se invoca 3x en un pipeline de 2 steps
    // (step0 main, step0 lookahead, step1 main).
    vi.mocked(discoveryService.getAgent)
      .mockResolvedValueOnce(agent1)
      .mockResolvedValueOnce(agent2)
      .mockResolvedValueOnce(agent2);
    // discover devuelve los agentes (path de hidratación de payment.chain).
    vi.mocked(discoveryService.discover).mockResolvedValue({
      agents: [agent1, agent2],
      total: 2,
      totalAtLeast: 2,
      registries: [],
      sources: [],
      catalogStatus: 'complete',
    });
    mockFetchOk({ result: 'step1' });
    mockFetchOk({ result: 'step2' });

    await composeService.compose({
      steps: [
        { agent: 'a1', input: {} },
        { agent: 'a2', input: {} },
      ],
      maxBudget: 1.0,
    });

    // Sin cache serían 3 (una por resolveAgent). Con cache: 1.
    expect(vi.mocked(discoveryService.discover)).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Gas pass-through (audit 2026-06-25): the per-step caller debit includes the
// gateway gas overhead ON MAINNET, but the agent still receives EXACTLY
// priceUsdc downstream. Testnet / no-env → identical behaviour.
// ─────────────────────────────────────────────────────────────────────
describe('composeService.compose — gas overhead pass-through', () => {
  const BASE_MAINNET = 8453;
  const KITE_TESTNET = 2368;
  let savedFlat: string | undefined;

  function mockAgentsBySlug(agents: Record<string, Agent>) {
    vi.mocked(discoveryService.getAgent).mockImplementation(
      async (slug: string, _registry?: string) => agents[slug] ?? null,
    );
  }

  beforeEach(() => {
    // global beforeEach clears mock implementations; restore the registry list
    // explicitly so invokeAgent's registries.find never throws, and re-pin the
    // retry-regen mock to null so no leaked field-error retry fires.
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    mockRegen.mockReset();
    mockRegen.mockResolvedValue(null);
    mockFetch.mockReset();
    savedFlat = process.env.STEP_GAS_OVERHEAD_USD;
    delete process.env.STEP_GAS_OVERHEAD_USD;
  });
  afterEach(() => {
    if (savedFlat === undefined) delete process.env.STEP_GAS_OVERHEAD_USD;
    else process.env.STEP_GAS_OVERHEAD_USD = savedFlat;
  });

  it('mainnet + env → step debits priceUsdc + overhead, agent settle gets only priceUsdc', async () => {
    process.env.STEP_GAS_OVERHEAD_USD = '0.02';
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk();
    mockFetchOk();

    const keyRow = makeKeyRow({ id: 'k1' });
    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: BASE_MAINNET,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(true);
    // step 1 debited price (0.05) + overhead (0.02) = 0.07.
    expect(mockDebit).toHaveBeenCalledTimes(1);
    expect(mockDebit).toHaveBeenCalledWith(
      'k1',
      BASE_MAINNET,
      0.07,
      undefined,
      undefined,
      'test-registry/corridor',
      'owner-test', // F-04 (audit): threaded caller owner_ref
    );
    // CRITICAL: downstream settle still receives the corridor agent with
    // priceUsdc=0.05 — NEVER the gas-inclusive 0.07 (the overhead is gateway
    // margin, never settled to the agent).
    const corridorCall = mockDownstream.mock.calls.find(
      (c) => (c[0] as Agent).slug === 'corridor',
    );
    expect(corridorCall).toBeDefined();
    expect((corridorCall![0] as Agent).priceUsdc).toBe(0.05);
    for (const call of mockDownstream.mock.calls) {
      // no downstream settle ever sees the gas-inclusive amount.
      expect((call[0] as Agent).priceUsdc).not.toBe(0.07);
    }
  });

  it('testnet + env → step debits only priceUsdc (overhead gated off)', async () => {
    process.env.STEP_GAS_OVERHEAD_USD = '0.02';
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk();
    mockFetchOk();

    const keyRow = makeKeyRow({ id: 'k1' });
    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: KITE_TESTNET,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(true);
    expect(mockDebit).toHaveBeenCalledWith(
      'k1',
      KITE_TESTNET,
      0.05, // no overhead on testnet
      undefined,
      undefined,
      'test-registry/corridor',
      'owner-test', // F-04 (audit): threaded caller owner_ref
    );
  });

  it('mainnet without env → step debits only priceUsdc (default 0)', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk();
    mockFetchOk();

    const keyRow = makeKeyRow({ id: 'k1' });
    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: BASE_MAINNET,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(true);
    expect(mockDebit).toHaveBeenCalledWith(
      'k1',
      BASE_MAINNET,
      0.05,
      undefined,
      undefined,
      'test-registry/corridor',
      'owner-test', // F-04 (audit): threaded caller owner_ref
    );
  });

  it('mainnet step fails after debit → refund returns priceUsdc + overhead', async () => {
    process.env.STEP_GAS_OVERHEAD_USD = '0.02';
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk(); // step 0 OK
    mockFetchError(502); // step 1 fails after debit

    const keyRow = makeKeyRow({ id: 'k1', owner_ref: 'owner-test' });
    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: BASE_MAINNET,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(false);
    // refund must return the FULL debited amount (price + overhead = 0.07).
    expect(mockCreditWithDest).toHaveBeenCalledTimes(1);
    expect(mockCreditWithDest).toHaveBeenCalledWith(
      'k1',
      BASE_MAINNET,
      0.07,
      'owner-test',
      'test-registry/corridor',
      { idemKey: expect.any(String) }, // HU-194
    );
  });
});

// ─── WKH-114: step verification wiring (AC-2/3/4/5/6, CD-1/CD-4/CD-8) ────
describe('composeService — WKH-114 step verification', () => {
  // Test 11 (AC-4): acceptance es aditivo; el shape base del StepResult no cambia.
  it('adds StepResult.acceptance without altering the base shape', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const agent = makeAgent({ slug: 'v-agent', priceUsdc: 0 });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);
    mockFetchOk({ result: 'work-done' });

    const result = await composeService.compose({
      steps: [{ agent: agent.slug, input: {} }],
    });

    expect(result.success).toBe(true);
    const step = result.steps[0]!;
    // Base shape intacto (AC-4): campos existentes sin cambios.
    expect(step.agent).toBe(agent);
    expect(step.output).toBe('work-done');
    expect(step.costUsdc).toBe(0);
    expect(typeof step.latencyMs).toBe('number');
    // Campo aditivo presente con veredicto.
    expect(step.acceptance).toBeDefined();
    expect(step.acceptance?.verdict).toBe('pass');
    expect(step.acceptance?.method).toBe('rules');
  });

  // Test 12 (AC-5): verificationStatus aditivo y distinto de success.
  it('exposes pipeline verificationStatus additive & distinct from success', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const agent = makeAgent({ slug: 'v-agent-2', priceUsdc: 0 });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);
    mockFetchOk({ result: { status: 'ok', value: 42 } });

    const result = await composeService.compose({
      steps: [{ agent: agent.slug, input: {} }],
    });

    expect(result.success).toBe(true); // sigue boolean idéntico
    expect(result.verificationStatus).toBe('verified'); // todos pass
  });

  // Test 13 (AC-6, CD-1): un AC-fail NO altera billing (sin refund por AC).
  it('AC-fail step does NOT alter billing (no refund, cost intact)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const agent = makeAgent({ slug: 'v-agent-3', priceUsdc: 0 });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);
    // 2xx pero el body evidencia error → verdict fail (Chaski-$0, CD-7).
    mockFetchOk({ result: { error: 'agent said no work done' } });

    const result = await composeService.compose({
      steps: [{ agent: agent.slug, input: {} }],
    });

    // El step invocó 2xx: el pipeline sigue success; el AC-fail es señal.
    expect(result.success).toBe(true);
    expect(result.steps[0]!.acceptance?.verdict).toBe('fail');
    expect(result.verificationStatus).toBe('incomplete');
    // CD-1/AC-6: el veredicto NO disparó refund ni cambió el costo.
    expect(mockCredit).not.toHaveBeenCalled();
    expect(mockCreditWithDest).not.toHaveBeenCalled();
    expect(result.totalCostUsdc).toBe(0);
  });

  // Test 14 (CD-4, CD-8): verificación no-pass NO aborta el pipeline ni refunda.
  it('non-pass verdict (unverified) does not abort pipeline nor trigger refund', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    const agent = makeAgent({ slug: 'v-agent-4', priceUsdc: 0 });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);
    mockFetchOk({ result: { ok: true } });

    const result = await composeService.compose({
      // Criterio semántico no estructurable → verdict 'unverified' (CD-8).
      steps: [
        {
          agent: agent.slug,
          input: {},
          acceptanceCriteria: ['the flight was actually booked'],
        },
      ],
    });

    expect(result.success).toBe(true); // pipeline no abortado
    expect(result.steps[0]!.acceptance?.verdict).toBe('unverified');
    expect(mockCredit).not.toHaveBeenCalled();
  });

  // Test 15 (BLQ-ALTO-1): un `acceptanceCriteria` MALFORMADO (`{length:1}` —
  // objeto truthy no-iterable, JSON válido NO validado por /compose ni
  // /orchestrate/execute) en un step DEBITADO (i>=1) que respondió 2xx + settleó
  // NO debe reventar el verificador. Pre-fix `[...criteria]` lanzaba TypeError
  // FUERA del try → propagaba a finishSuccessfulStep → catch del money-path
  // (compose.ts:300) → refundStepDebit() (compose.ts:404) reembolsaba un step
  // ya settleado (drain: mockCreditWithDest). Post-fix: Array.isArray descarta
  // el input malformado → DEFAULT_AC, sin throw, sin refund.
  it('malformed acceptanceCriteria on a settled DEBITED step does NOT abort nor refund (drain closed)', async () => {
    // 8453 = Base mainnet: activa el débito per-step del servicio (steps 1..N).
    const CHAIN_ID = 8453;
    const a1 = makeAgent({ slug: 'step0', priceUsdc: 0 });
    const a2 = makeAgent({ slug: 'step1', priceUsdc: 0.05, id: 'agent-2' });
    vi.mocked(discoveryService.getAgent).mockImplementation(
      async (slug: string) =>
        slug === 'step0' ? a1 : slug === 'step1' ? a2 : null,
    );
    mockFetchOk({ result: 'step0-done' }); // step 0: 2xx + settle OK
    mockFetchOk({ result: 'step1-done' }); // step 1: 2xx + settle OK (debited)

    const keyRow = makeKeyRow({ id: 'k1', owner_ref: 'owner-test' });
    const result = await composeService.compose({
      steps: [
        { agent: 'step0', input: {} },
        // `acceptanceCriteria` con shape inválido (cast: emula el body crudo del
        // caller — el tipo dice string[] pero el runtime no lo garantiza).
        {
          agent: 'step1',
          input: {},
          acceptanceCriteria: { length: 1 } as unknown as string[],
        },
      ],
      scopingKeyRow: keyRow,
      chainId: CHAIN_ID,
      a2aKey: 'wasi_a2a_test',
    });

    // El pipeline NO abortó por el verificador.
    expect(result.success).toBe(true);
    // El step debitado settleó y su campo aditivo quedó presente
    // (evaluado contra DEFAULT_AC, no un throw).
    expect(result.steps[1]!.acceptance).toBeDefined();
    // CD-1: el verificador NO disparó refund del step ya settleado (drain
    // cerrado). Pre-fix esto era `toHaveBeenCalled` = reembolso indebido.
    expect(mockCredit).not.toHaveBeenCalled();
    expect(mockCreditWithDest).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// HU-203 — un `success:false` del facilitator NO autoriza a devolverle la plata
// al caller.
//
// LO QUE MIDEN ESTOS TESTS ES LA PLATA, no las llamadas internas: la pregunta
// es "¿se reembolsó el débito del step, sí o no?", y la respuesta se lee en
// `budgetService.creditWithDest` / `budgetService.credit`, que son los dos
// únicos caminos por los que el budget vuelve al caller.
//
// LAS DOS DIRECCIONES IMPORTAN Y ESTÁN CUBIERTAS. Retener de menos deja al
// agente cobrado on-chain y al caller reembolsado (la plata sale dos veces de
// nuestro lado). Retener de más deja al caller cobrado por un step que no le
// entregó nada. Por eso hay un test espejo para cada guard: uno con evidencia
// (no se reembolsa) y uno sin evidencia (se reembolsa igual que siempre).
//
// LA FORMA DEL SETUP NO ES ARBITRARIA. `scopingKeyRow` presente + `a2aKey`
// AUSENTE es exactamente lo que arma `POST /orchestrate`
// (`routes/orchestrate.ts` propaga `request.a2aKeyRow` pero NUNCA setea
// `a2aKey`), y es la única combinación en la que coexisten las dos mitades del
// bug: el settle inbound firmado por el operador (`!a2aKey`) y el débito
// per-step reembolsable (`scopingKeyRow`). Con la forma de `POST /compose`
// (ambos presentes) el settle ni siquiera corre.
// ════════════════════════════════════════════════════════════════════════════
/**
 * HU-203 compose — refund vs evidencia de broadcast.
 *
 * ⚠️ HU-DOUBLE-PAY — DE DÓNDE SALE HOY EL ERROR QUE ESTOS TESTS CLASIFICAN.
 * Hasta el borrado del segundo leg de salida, el error lo producía el
 * `adapter.settle()` de ESE leg dentro de `invokeAgent`, y por eso estos tests
 * lo inyectaban con `mockSettle`. Ese leg ya no existe, así que el error se
 * inyecta AHORA en el borde donde `compose()` lo lee: el `throw` de
 * `composeService.invokeAgent`.
 *
 * QUÉ SIGUE MIDIENDO ESTO, DICHO SIN ADORNOS: la CLASIFICACIÓN
 * (`withholdingFromSettleResult` / `readSettleWithholding`, funciones de
 * producción, no re-implementadas acá) y la DECISIÓN DE DINERO que compose toma
 * con ella (reembolsar o retener, anotar el evento durable, no reintentar).
 *
 * QUÉ **NO** MIDE, y hay que decirlo porque el verde de acá no lo cubre: que
 * exista un productor vivo de esos errores. Hoy NO lo hay —
 * `signAndSettleDownstream` no tira nunca (CD-7 de WKH-55) y el otro leg se
 * borró—, así que este camino de compose está sin productor. Es deuda
 * declarada, `TD-203-NO-PRODUCER`: o vuelve a haber un leg que tire acá, o la
 * retención se saca junto con `ComposeResult.settleRefundWithheld` y el evento
 * `compose_settle_unknown`. Sacarla ahora era un diff aparte (toca `orchestrate`,
 * `reconciliation` y el dashboard) y no hacía falta para cerrar el doble pago.
 */
describe('HU-203 compose — refund vs evidencia de broadcast', () => {
  function mockAgentsBySlug(agents: Record<string, Agent>) {
    vi.mocked(discoveryService.getAgent).mockImplementation(
      async (slug: string, _registry?: string) => agents[slug] ?? null,
    );
  }

  /** Los dos agentes del pipeline. */
  function twoPaidAgents() {
    const a1 = makeAgent({
      slug: 'kyc',
      priceUsdc: 0.001,
      metadata: { payTo: EVM_PAYTO },
    });
    const a2 = makeAgent({
      slug: 'corridor',
      priceUsdc: 0.05,
      id: 'agent-2',
      metadata: { payTo: EVM_PAYTO },
    });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
  }

  /**
   * Inyecta un `throw` en la N-ésima INVOCACIÓN de `invokeAgent` (0-based, y
   * cuenta también los re-invokes del retry adaptativo). El resto de las
   * invocaciones pasan por la implementación REAL, así que el pipeline, los
   * débitos y los eventos son los de producción.
   */
  function throwOnInvocation(nth: number, err: unknown): void {
    const real = composeService.invokeAgent.bind(composeService);
    let seen = -1;
    vi.spyOn(composeService, 'invokeAgent').mockImplementation(
      async (...args: Parameters<typeof composeService.invokeAgent>) => {
        seen += 1;
        if (seen === nth) throw err;
        return real(...args);
      },
    );
  }

  /** Cuántas veces se invocó un agente (incluye los re-invokes del retry). */
  function invocations(): number {
    return vi.mocked(composeService.invokeAgent).mock.calls.length;
  }

  /**
   * El error del EJE 1 tal como lo construía el settle borrado: la retención la
   * decide `withholdingFromSettleResult` (producción), no el test.
   */
  function settleResultError(
    settleResult: { success: boolean; txHash?: string; error?: string },
    agentSlug: string,
  ): Error {
    const detail = `x402 settle failed for ${agentSlug}: ${settleResult.error ?? 'unknown'}`;
    const withholding = withholdingFromSettleResult(
      settleResult,
      `${detail} — the facilitator returned a broadcast tx hash (${settleResult.txHash}), so the payment may have executed on-chain`,
    );
    return withholding
      ? new SettleRefundWithheldError(withholding)
      : new Error(detail);
  }

  /** La forma de `/orchestrate`: con key row (débito per-step), SIN `a2aKey`. */
  function runTwoStepPipeline() {
    return composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
      ],
      scopingKeyRow: makeKeyRow({ id: 'k1', owner_ref: 'owner-test' }),
      chainId: 2368,
    });
  }

  /** Suma TODO lo que volvió al budget del caller, por cualquiera de los dos caminos. */
  function refundedUsd(): number {
    const withDest = mockCreditWithDest.mock.calls.reduce(
      (acc, call) => acc + (call[2] as number),
      0,
    );
    const plain = mockCredit.mock.calls.reduce(
      (acc, call) => acc + (call[2] as number),
      0,
    );
    return withDest + plain;
  }

  beforeEach(() => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    twoPaidAgents();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── EJE 1: `2xx { success:false, txHash }` ───────────────────────────────

  it('T-203-A1-NO-REFUND: un `success:false` CON txHash NO devuelve el débito del step', async () => {
    mockFetchOk({ result: 'r1' }); // step 0 invoca ok
    // Step 1: el facilitator dice que no settleó, PERO nos da un hash de broadcast.
    throwOnInvocation(
      1,
      settleResultError(
        {
          success: false,
          txHash: '0xBROADCASTED',
          error: 'insufficient funds',
        },
        'corridor',
      ),
    );

    const result = await runTwoStepPipeline();

    expect(result.success).toBe(false);
    // LO QUE IMPORTA: el débito del step 1 (0.05) NO volvió al caller.
    expect(refundedUsd()).toBe(0);
    expect(mockCreditWithDest).not.toHaveBeenCalled();
    expect(mockCredit).not.toHaveBeenCalled();
    // Y el veredicto viaja para que `orchestrate` no reembolse el step 0.
    expect(result.settleRefundWithheld).toEqual({
      step: 1,
      reason: 'broadcast-hash',
      txHash: '0xBROADCASTED',
    });
  });

  it('T-203-A1-STILL-REFUNDS: un `success:false` SIN txHash sigue devolviendo el débito', async () => {
    // El contra-ejemplo, y es la mitad que evita la sobre-corrección: el
    // facilitator contestó, con un veredicto legible, que NO settleó, y no nos
    // dio ningún hash. Ese es el único caso que conserva el reembolso
    // automático; si también lo retuviéramos, el caller quedaría cobrado por un
    // step que probadamente no se ejecutó.
    mockFetchOk({ result: 'r1' });
    throwOnInvocation(
      1,
      settleResultError(
        { success: false, txHash: '', error: 'insufficient funds' },
        'corridor',
      ),
    );

    const result = await runTwoStepPipeline();

    expect(result.success).toBe(false);
    expect(refundedUsd()).toBe(0.05);
    expect(mockCreditWithDest).toHaveBeenCalledTimes(1);
    expect(mockCreditWithDest.mock.calls[0]?.[2]).toBe(0.05);
    expect(result.settleRefundWithheld).toBeUndefined();
  });

  it('T-203-A1-WHITESPACE: un txHash que es sólo espacios no es evidencia — se reembolsa', async () => {
    // `hasBroadcastEvidence` exige un string NO VACÍO tras `trim()`. Un
    // facilitator que rellena el campo con `'   '` no nos dio ninguna pista, y
    // tratarlo como evidencia retendría plata sin ningún motivo.
    mockFetchOk({ result: 'r1' });
    throwOnInvocation(
      1,
      settleResultError({ success: false, txHash: '   ' }, 'corridor'),
    );

    const result = await runTwoStepPipeline();

    expect(result.success).toBe(false);
    expect(refundedUsd()).toBe(0.05);
  });

  // ── EJE 2: el hop sin respuesta utilizable ───────────────────────────────

  it('T-203-A2-NO-REFUND: `FacilitatorSettleError` con `unknown` NO devuelve el débito', async () => {
    // Este eje NO lo cubre el fix de los adapters de HU-201. Antes, un HTTP
    // non-2xx se aplanaba a `success:false` y terminaba en el mismo `throw` que
    // el eje 1; desde HU-201 llega TIPADO, pero si `compose` no lee su
    // `valueDisposition` el resultado es idéntico: reembolso indebido.
    mockFetchOk({ result: 'r1' });
    throwOnInvocation(
      1,
      new FacilitatorSettleError(
        'Facilitator returned HTTP 502 on /settle',
        'unknown',
      ),
    );

    const result = await runTwoStepPipeline();

    expect(result.success).toBe(false);
    expect(refundedUsd()).toBe(0);
    expect(result.settleRefundWithheld).toEqual({
      step: 1,
      reason: 'no-facilitator-answer',
      txHash: null,
    });
  });

  it('T-203-A2-STILL-REFUNDS: `FacilitatorSettleError` con `not-sent` SÍ devuelve el débito', async () => {
    // `'not-sent'` sólo se emite ante una señal que PRUEBA que no hubo request
    // (DNS que no resuelve, conexión rechazada, URL inválida). Esa prueba es
    // justamente lo que mantiene vivo el reembolso legítimo: si acá también
    // retuviéramos, un facilitator mal configurado dejaría a TODOS los callers
    // cobrados por steps que nunca salieron.
    mockFetchOk({ result: 'r1' });
    throwOnInvocation(
      1,
      new FacilitatorSettleError(
        'Facilitator network error on settle: getaddrinfo ENOTFOUND',
        'not-sent',
      ),
    );

    const result = await runTwoStepPipeline();

    expect(result.success).toBe(false);
    expect(refundedUsd()).toBe(0.05);
    expect(result.settleRefundWithheld).toBeUndefined();
  });

  it('T-203-A2-CROSS-REGISTRY: el error se lee por FORMA, no por `instanceof`', async () => {
    // Un consumidor cargado con `vi.resetModules()` + `import()` dinámico ve
    // OTRA copia de la clase y el `instanceof` da `false`. Si la decisión de
    // dinero dependiera de la identidad de clase, ese caso colapsaría al camino
    // de "falló" ⟹ reembolso indebido. Se simula con un objeto que tiene la
    // FORMA pero no la clase.
    const foreign = Object.assign(
      new Error('Facilitator returned HTTP 504 on /settle'),
      { name: 'FacilitatorSettleError', valueDisposition: 'unknown' },
    );
    mockFetchOk({ result: 'r1' });
    throwOnInvocation(1, foreign);

    const result = await runTwoStepPipeline();

    expect(result.success).toBe(false);
    expect(refundedUsd()).toBe(0);
  });

  // ── El resto de los fallos NO cambia de comportamiento ───────────────────

  it('T-203-UNRELATED: un 502 del AGENTE (sin settle) sigue reembolsando', async () => {
    // El guard tiene que ser estrecho: sólo mira los fallos de settle. Un
    // agente que devuelve 502 es un step sin valor entregado y sin ninguna
    // posibilidad de haber pagado — se reembolsa como siempre.
    mockFetchOk({ result: 'r1' });
    mockFetchError(502);

    const result = await runTwoStepPipeline();

    expect(result.success).toBe(false);
    expect(refundedUsd()).toBe(0.05);
    expect(result.settleRefundWithheld).toBeUndefined();
  });

  // ── La superficie: no reembolsar en silencio sería peor que reembolsar ───

  it('T-203-SURFACE: la retención deja un evento durable con el hash y el monto', async () => {
    mockFetchOk({ result: 'r1' });
    throwOnInvocation(
      1,
      settleResultError(
        { success: false, txHash: '0xBROADCASTED' },
        'corridor',
      ),
    );

    await runTwoStepPipeline();

    const withheldEvent = vi
      .mocked(eventService.track)
      .mock.calls.map((c) => c[0])
      .find((e) => e.eventType === 'compose_settle_unknown');
    expect(withheldEvent).toBeDefined();
    // El hash es la clave con la que un humano cruza contra la cadena…
    expect(withheldEvent?.txHash).toBe('0xBROADCASTED');
    // …y el monto es lo que hay que devolver a mano si la tx no aterrizó.
    expect(withheldEvent?.costUsdc).toBe(0.05);
    expect(withheldEvent?.metadata?.refund_withheld).toBe(true);
    expect(withheldEvent?.metadata?.key_id).toBe('k1');
    expect(withheldEvent?.metadata?.owner_ref).toBe('owner-test');
  });

  it('T-203-SURFACE-STEP0: el step 0 no retiene nada acá, pero tampoco desaparece', async () => {
    // El débito del step 0 lo hace y lo deshace `orchestrate`, no `compose` (el
    // guard `i > 0`). Compose no tiene nada que retener, pero el settle sin
    // resolver se anota igual: un caso que no se reembolsa y que nadie lista es
    // plata retenida en silencio.
    throwOnInvocation(
      0,
      settleResultError({ success: false, txHash: '0xSTEP0BROADCAST' }, 'kyc'),
    );

    const result = await runTwoStepPipeline();

    expect(result.success).toBe(false);
    expect(result.settleRefundWithheld).toEqual({
      step: 0,
      reason: 'broadcast-hash',
      txHash: '0xSTEP0BROADCAST',
    });
    const withheldEvent = vi
      .mocked(eventService.track)
      .mock.calls.map((c) => c[0])
      .find((e) => e.eventType === 'compose_settle_unknown');
    expect(withheldEvent?.metadata?.refund_withheld).toBe(false);
    expect(withheldEvent?.txHash).toBe('0xSTEP0BROADCAST');
  });

  // ── GUARD 2: el retry adaptativo ─────────────────────────────────────────

  it('T-203-RETRY-NO-REFUND: si el settle del RE-INVOKE pudo salir, el retry-débito NO vuelve', async () => {
    // Guard propio (no una consecuencia del primero): acá el settle que pudo
    // salir es el del RE-INVOKE, o sea un débito distinto sobre una tx
    // distinta. El primer intento falló limpio (400 con field-errors, sin
    // settle) y por eso se reembolsó; el segundo no.
    mockFetchOk({ result: 'r1' });
    // Step 1, intento 1: 400 con field-errors → refund d1 + retry.
    mockFetchError(400, '{"fieldErrors":{"amount":["required"]}}');
    mockRegen.mockResolvedValueOnce({ amount: 42 });
    // Step 1, intento 2 (invocación #2): el settle vuelve con hash de broadcast.
    throwOnInvocation(
      2,
      settleResultError(
        { success: false, txHash: '0xRETRYBROADCAST' },
        'corridor',
      ),
    );

    const result = await runTwoStepPipeline();

    expect(result.success).toBe(false);
    // Se debitó dos veces (el original + el del retry) y volvió UNA sola: la
    // del primer intento, que falló sin tocar el facilitator.
    expect(mockDebit).toHaveBeenCalledTimes(2);
    expect(refundedUsd()).toBe(0.05);
    expect(mockCreditWithDest).toHaveBeenCalledTimes(1);
    const withheldEvent = vi
      .mocked(eventService.track)
      .mock.calls.map((c) => c[0])
      .find((e) => e.eventType === 'compose_settle_unknown');
    expect(withheldEvent?.metadata?.withholder).toBe('compose-step:1:d2');
  });

  it('T-203-RETRY-STILL-REFUNDS: si el RE-INVOKE falla sin evidencia, los DOS débitos vuelven', async () => {
    mockFetchOk({ result: 'r1' });
    mockFetchError(400, '{"fieldErrors":{"amount":["required"]}}');
    mockRegen.mockResolvedValueOnce({ amount: 42 });
    mockFetchError(502); // el re-invoke falla en el agente, sin settle

    const result = await runTwoStepPipeline();

    expect(result.success).toBe(false);
    expect(mockDebit).toHaveBeenCalledTimes(2);
    expect(refundedUsd()).toBe(0.1); // 0.05 (d1) + 0.05 (d2)
    expect(mockCreditWithDest).toHaveBeenCalledTimes(2);
  });

  it('T-203-NO-RETRY-AFTER-WITHHOLD: con evidencia de broadcast el step NO se reintenta', async () => {
    // El retry re-debita y RE-INVOCA al agente, o sea que dispararía un SEGUNDO
    // settle sobre un step que quizá ya se pagó. El error del settle retenido
    // trae, a propósito, un cuerpo con field-errors parseables: sin el guard,
    // `willRetry` sería true y el pipeline reintentaría.
    mockFetchOk({ result: 'r1' });
    throwOnInvocation(
      1,
      settleResultError(
        {
          success: false,
          txHash: '0xBROADCASTED',
          error:
            'Agent corridor returned 400: {"fieldErrors":{"amount":["required"]}}',
        },
        'corridor',
      ),
    );
    mockRegen.mockResolvedValueOnce({ amount: 42 });

    await runTwoStepPipeline();

    // Un solo débito (el original) y DOS invocaciones en total (step 0 + step 1
    // sin retry): no hubo re-invoke ni re-debit.
    expect(mockDebit).toHaveBeenCalledTimes(1);
    expect(invocations()).toBe(2);
    expect(refundedUsd()).toBe(0);
    expect(mockRegen).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════
// WKH-305 (W1) — CARACTERIZACIÓN del reordenamiento del débito
//
// W1 mueve la construcción del `input` del step de DESPUÉS del bloque de débito
// a ANTES. Es una conmutación de dos bloques que no comparten datos ni efectos:
// el `input` se calcula sólo con `step.input`/`step.passOutput`/`lastOutput`, y
// el bloque de débito sólo lee el precio del agente y el gas overhead. Estos
// tres tests CONGELAN esa afirmación en las tres cosas que un reordenamiento mal
// hecho rompería: cuánta plata se mueve, cuánta vuelve, y qué objeto exacto
// recibe el agente.
//
// Un `toHaveBeenCalledWith` no alcanzaría: no distingue "cobró y devolvió" de
// "cobró y se lo quedó". Por eso el mock de `debit`/`creditWithDest` mueve un
// balance en memoria y las aserciones comparan el número antes vs. después.
// ══════════════════════════════════════════════════════════════════════

describe('WKH-305 (W1) · caracterización: el reordenamiento no mueve un centavo', () => {
  // Helper local IDÉNTICO al del describe de WKH-59: se replica en vez de mover
  // el original para no tocar una línea de un test preexistente.
  function mockAgentsBySlug(agents: Record<string, Agent>) {
    vi.mocked(discoveryService.getAgent).mockImplementation(
      async (slug: string, _registry?: string) => agents[slug] ?? null,
    );
  }

  // Ledger en memoria: `debit` RESTA y `creditWithDest` SUMA de verdad.
  // `debitLatencyMs` abre a voluntad la ventana de tiempo que ocupa el débito.
  // Default 0 ⇒ el resto del bloque no cambia.
  const ledger = { balance: 10, debitLatencyMs: 0 };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeEach(() => {
    ledger.balance = 10;
    ledger.debitLatencyMs = 0;
    // Explícito, no heredado: sin esto el bloque depende de que algún test
    // ANTERIOR haya dejado seteado `getEnabled` (`clearAllMocks` limpia las
    // llamadas, no las implementaciones), y correr un solo `it` con `-t` falla.
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    mockDebit.mockImplementation(
      async (_keyId: string, _chainId: number, amountUsd: number) => {
        if (ledger.debitLatencyMs > 0) await sleep(ledger.debitLatencyMs);
        ledger.balance -= amountUsd;
        return { success: true };
      },
    );
    mockCreditWithDest.mockImplementation(
      async (
        _keyId: string,
        _chainId: number,
        amountUsd: number,
        _ownerRef: string,
      ) => {
        ledger.balance += amountUsd;
        return { success: true, reverted: true };
      },
    );
  });

  it('T-MAP-C1: 3 steps sin mapeo — el balance se mueve EXACTAMENTE precio(step1)+precio(step2)', async () => {
    const a0 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a1 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    const a2 = makeAgent({ slug: 'payout', priceUsdc: 0.02, id: 'agent-3' });
    mockAgentsBySlug({ kyc: a0, corridor: a1, payout: a2 });
    mockFetchOk({ result: 'r0' });
    mockFetchOk({ result: 'r1' });
    mockFetchOk({ result: 'r2' });

    const balanceBefore = ledger.balance;

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
        { agent: 'payout', input: {} },
      ],
      scopingKeyRow: makeKeyRow({ id: 'k1' }),
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(true);
    // LA ASERCIÓN DE DINERO PRIMERO. El step 0 lo debita el middleware, no el
    // service (guard `i > 0`), así que sólo se mueven los steps 1 y 2.
    expect(ledger.balance).toBeCloseTo(balanceBefore - (0.05 + 0.02), 10);
    // Y el destino canónico y el chainId de cada débito, sin cambios.
    expect(mockDebit).toHaveBeenCalledTimes(2);
    expect(mockDebit).toHaveBeenNthCalledWith(
      1,
      'k1',
      2368,
      0.05,
      undefined,
      undefined,
      'test-registry/corridor',
      'owner-test',
    );
    expect(mockDebit).toHaveBeenNthCalledWith(
      2,
      'k1',
      2368,
      0.02,
      undefined,
      undefined,
      'test-registry/payout',
      'owner-test',
    );
    expect(mockCreditWithDest).not.toHaveBeenCalled();
  });

  it('T-MAP-C2: fallo post-invoke en el step 1 — el refund devuelve TODO lo debitado', async () => {
    // El fallo ocurre INVOCANDO, o sea del lado "requiere ejecutar" de la
    // frontera: el débito ya pasó y el hook de refund tiene que devolverlo
    // exactamente igual que antes del reordenamiento.
    const a0 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a1 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    mockAgentsBySlug({ kyc: a0, corridor: a1 });
    mockFetchOk({ result: 'r0' });
    mockFetchError(502); // el step 1 falla en el agente, sin field-errors

    const balanceBefore = ledger.balance;

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
      ],
      scopingKeyRow: makeKeyRow({ id: 'k1' }),
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(false);
    // Bajó y volvió a subir: el balance final es idéntico al inicial.
    expect(ledger.balance).toBeCloseTo(balanceBefore, 10);
    expect(mockDebit).toHaveBeenCalledTimes(1);
    expect(mockCreditWithDest).toHaveBeenCalledTimes(1);
    expect(mockCreditWithDest).toHaveBeenCalledWith(
      'k1',
      2368,
      0.05,
      'owner-test',
      'test-registry/corridor',
      expect.objectContaining({ idemKey: expect.any(String) }),
    );
  });

  it('T-MAP-C3: sin `passOutput`, el objeto que llega a invokeAgent es la MISMA referencia de step.input', async () => {
    // `toBe`, no `toEqual`: el camino sin mapeo no alloca nada nuevo. Si alguien
    // "normalizara" el input con un spread incondicional, esto se pone rojo — y
    // ese spread sería un cambio de comportamiento silencioso para cualquier
    // agente que dependa de la identidad del objeto.
    const a0 = makeAgent({ slug: 'kyc', priceUsdc: 0 });
    mockAgentsBySlug({ kyc: a0 });
    mockFetchOk({ result: 'r0' });

    const stepInput = { corridor: 'US-PE', amountUsd: 400 };
    const spy = vi.spyOn(composeService, 'invokeAgent');

    const result = await composeService.compose({
      steps: [{ agent: 'kyc', input: stepInput }],
      scopingKeyRow: makeKeyRow({ id: 'k1' }),
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(true);
    expect(spy.mock.calls[0]?.[1]).toBe(stepInput);
    spy.mockRestore();
  });

  it('T-MAP-C4: el `latencyMs` del step NO incluye el tiempo del débito', async () => {
    // Este test existe porque la MUTACIÓN lo pidió: subir el cronómetro
    // (`const startTime = Date.now()`) arriba del bloque de débito no ponía
    // rojo NINGÚN test del repo. O sea que la métrica de latencia por step del
    // money-path no estaba protegida por nada, y cualquiera podía cambiarla sin
    // enterarse.
    //
    // No es una micro-optimización: `latencyMs` es lo que se reporta al caller y
    // lo que viaja al evento `compose_step`. Si pasara a incluir el débito,
    // TODOS los steps con débito per-step medirían de golpe otra cosa con el
    // mismo nombre — un cambio silencioso de métrica en el money-path, no una
    // medición "más precisa".
    //
    // El cronómetro tiene que arrancar donde arranca el trabajo que se le
    // atribuye al agente: justo antes de invocarlo.
    //
    // ── POR QUÉ RELOJ VIRTUAL Y NO UN UMBRAL DE MILISEGUNDOS ──────────────
    // La versión anterior dormía 150 ms de verdad y afirmaba `latencyMs < 150`.
    // Eso no mide dónde arranca el cronómetro: mide si la máquina es más rápida
    // que el sleep. Bajo carga, la invocación del agente tardó 216 ms y el test
    // se puso rojo sin que nada estuviera mal (CI, 2026-07-29). Un test flaky
    // destruye la señal igual que un CI siempre rojo.
    //
    // La propiedad real es QUÉ QUEDA ADENTRO DE LA MEDICIÓN, no cuántos
    // milisegundos son. Así que el débito ya no DUERME: ADELANTA un reloj que
    // este test controla. Nada más lo mueve, y entonces:
    //   · cronómetro DESPUÉS del débito ⟹ latencyMs === 0   (lo correcto)
    //   · cronómetro ANTES  del débito ⟹ latencyMs === 150  (la mutación)
    // Dos valores exactos y separados, sin depender de la carga de la máquina.
    const DEBIT_MS = 150;
    const a0 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a1 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    mockAgentsBySlug({ kyc: a0, corridor: a1 });
    mockFetchOk({ result: 'r0' });
    mockFetchOk({ result: 'r1' });

    // Reloj congelado: sólo avanza cuando el débito lo adelanta.
    let virtualNowMs = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => virtualNowMs);
    // Doble del débito LOCAL a este test (no toca el del `beforeEach`, que otros
    // ~117 tests de este archivo comparten).
    mockDebit.mockImplementation(
      async (_keyId: string, _chainId: number, amountUsd: number) => {
        virtualNowMs += DEBIT_MS; // el débito consume tiempo, sin dormir
        ledger.balance -= amountUsd;
        return { success: true };
      },
    );

    try {
      const wallClockStart = Date.now();
      const result = await composeService.compose({
        steps: [
          { agent: 'kyc', input: {} },
          { agent: 'corridor', input: {} },
        ],
        scopingKeyRow: makeKeyRow({ id: 'k1' }),
        chainId: 2368,
        a2aKey: 'wasi_a2a_test',
      });
      const wallClockMs = Date.now() - wallClockStart;

      expect(result.success).toBe(true);
      // El step 1 es el único con débito per-step (el 0 lo debita el middleware),
      // así que es el único donde la diferencia es observable.
      expect(mockDebit).toHaveBeenCalledTimes(1);
      // Exacto, no un umbral: nada más que el débito mueve este reloj, así que
      // cualquier valor distinto de 0 es tiempo del débito que se coló adentro.
      expect(result.steps[1]?.latencyMs).toBe(0);
      // ── EL FIXTURE ESTÁ ARMADO ──────────────────────────────────────────
      // El reloj de la llamada COMPLETA sí tiene que incluir el débito: es la
      // prueba de que el doble lo adelantó de verdad. Sin esto, un débito que no
      // consumiera tiempo dejaría la aserción de arriba verde por el motivo
      // equivocado (no porque el cronómetro esté bien puesto, sino porque no
      // había nada que medir).
      //
      // Ojo con la tentación de asertar esto sobre `result.totalLatencyMs`: ESA
      // suma los `latencyMs` por step, todos medidos desde el cronómetro
      // post-débito, así que jamás puede incluir el tiempo del débito y la
      // comparación sería vacua (no puede fallar por construcción).
      expect(wallClockMs).toBe(DEBIT_MS);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
