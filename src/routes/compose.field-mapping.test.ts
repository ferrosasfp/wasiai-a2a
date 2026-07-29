/**
 * WKH-305 — `inputFromPrevious` en el BORDE HTTP: un mapeo con forma inválida se
 * rechaza con 400 ANTES del middleware de pago, sin débito y sin discovery.
 *
 * ⚠️ WHY A SEPARATE FILE (mismo motivo que
 * `compose.no-charge-on-validation-error.test.ts` y
 * `compose.no-debit-on-abort.test.ts`): el hermano `compose.test.ts` moquea
 * `requirePaymentOrA2AKey` con un pass-through que NUNCA debita, así que no puede
 * observar un cobro. Acá corre el middleware REAL y se moquea SÓLO la capa de
 * datos, con un balance en memoria: `debit` RESTA y `credit` SUMA.
 *
 * Un test que sólo mire el status no prueba nada de esto: la propiedad que
 * defiende esta suite es "no se cobra por lo que no se ejecuta", y eso sólo se ve
 * comparando el balance antes vs. después.
 *
 * Naming: T-MAP-15..T-MAP-18.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { A2AAgentKeyRow } from '../types/index.js';

const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({ getLogger: () => logSpy }));

vi.mock('../adapters/chain-resolver.js', () => ({
  resolveChainKey: () => 'kite',
}));
vi.mock('../adapters/registry.js', () => ({
  getDefaultChainKey: () => 'kite',
  getInitializedChainKeys: () => ['kite'],
  getAdaptersBundle: () => ({
    chainConfig: { chainId: 2368 },
    payment: { supportedTokens: [{ symbol: 'USDC' }] },
  }),
}));

vi.mock('../services/agent-price.js', () => ({
  resolveAgentPriceUsdc: vi.fn(),
  resolveAgentDestination: vi.fn().mockResolvedValue(null),
}));

vi.mock('../services/compose.js', () => ({
  composeService: { compose: vi.fn() },
}));

const fundedKey = vi.hoisted(
  (): A2AAgentKeyRow => ({
    id: 'k1',
    owner_ref: 'o1',
    key_hash: 'hash',
    display_name: null,
    budget: { '2368': '10.00' },
    daily_limit_usd: null,
    daily_spent_usd: '0',
    daily_reset_at: new Date(Date.now() + 86_400_000).toISOString(),
    allowed_registries: null,
    allowed_agent_slugs: null,
    allowed_categories: null,
    max_spend_per_call_usd: null,
    is_active: true,
    last_used_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    erc8004_identity: null,
    kite_passport: null,
    agentkit_wallet: null,
    funding_wallet: null,
    metadata: {},
    require_signature: false,
  }),
);
vi.mock('../services/identity.js', () => ({
  isIdentityVerified: () => false,
  identityService: { lookupByHash: vi.fn().mockResolvedValue(fundedKey) },
}));

// ── budgetService: balance en memoria. `debit` RESTA, `credit` SUMA ──
const budgetState = vi.hoisted(() => ({ balance: 10 }));
const debitMock = vi.hoisted(() =>
  vi.fn(
    async (
      _keyId: string,
      _chainId: number,
      amountUsd: number,
    ): Promise<{ success: boolean; error?: string }> => {
      budgetState.balance -= amountUsd;
      return { success: true };
    },
  ),
);
const creditMock = vi.hoisted(() =>
  vi.fn(
    async (
      _keyId: string,
      _chainId: number,
      amountUsd: number,
      _ownerRef: string,
      _idem?: { idemKey: string | null },
    ): Promise<{ success: boolean; reverted?: boolean }> => {
      // El credit TIENE que mover el balance: si sólo devolviera `success:true`,
      // "cobró y reembolsó" sería indistinguible de "cobró y se lo quedó".
      budgetState.balance += amountUsd;
      return { success: true, reverted: true };
    },
  ),
);
const getBalanceMock = vi.hoisted(() =>
  vi.fn(async (): Promise<string> => budgetState.balance.toFixed(2)),
);
vi.mock('../services/budget.js', () => ({
  budgetService: {
    debit: debitMock,
    getBalance: getBalanceMock,
    credit: creditMock,
    creditWithDest: vi
      .fn()
      .mockResolvedValue({ success: true, reverted: true }),
    creditDelegation: vi
      .fn()
      .mockResolvedValue({ success: true, reverted: true }),
    creditSession: vi.fn().mockResolvedValue({ success: true, reverted: true }),
  },
}));

vi.mock('../services/receipt.js', () => ({
  receiptService: { emit: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../services/refund-outbox.js', () => ({
  refundOutbox: { enqueueRefund: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../middleware/rate-limit.js', () => ({
  orchestrateRateLimit: () => false,
}));
vi.mock('../middleware/timeout.js', () => ({
  createTimeoutHandler:
    (_ms: number) => async (_request: FastifyRequest, _reply: FastifyReply) => {
      /* no-op */
    },
}));

import {
  resolveAgentDestination,
  resolveAgentPriceUsdc,
} from '../services/agent-price.js';
import { composeService } from '../services/compose.js';
// NOTE: requirePaymentOrA2AKey NO está mockeado — corre el middleware REAL.
import composeRoutes from './compose.js';

const mockResolvePrice = vi.mocked(resolveAgentPriceUsdc);
const mockResolveDest = vi.mocked(resolveAgentDestination);
const mockCompose = vi.mocked(composeService.compose);

const KEY_HEADER = { 'x-a2a-key': 'wasi_a2a_funded_master_key' };
const STEP0_PRICE = 0.5;

describe('WKH-305 · POST /compose — un mapeo malformado es 400 PRE-COBRO', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();
    await app.register(composeRoutes, { prefix: '/compose' });
    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    vi.clearAllMocks();
    budgetState.balance = 10;
    debitMock.mockImplementation(async (_k, _c, amountUsd: number) => {
      budgetState.balance -= amountUsd;
      return { success: true };
    });
    creditMock.mockImplementation(async (_k, _c, amountUsd: number) => {
      budgetState.balance += amountUsd;
      return { success: true, reverted: true };
    });
    getBalanceMock.mockImplementation(async () =>
      budgetState.balance.toFixed(2),
    );
    mockResolveDest.mockResolvedValue(null);
    mockResolvePrice.mockResolvedValue(STEP0_PRICE);
  });

  it('T-MAP-15 (AC-6): `inputFromPrevious` malformado → 400 y el balance NO se mueve', async () => {
    const balanceBefore = budgetState.balance;

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: {
        steps: [
          { agent: 'fx', input: {} },
          { agent: 'payout', input: {}, inputFromPrevious: ['quoteId'] },
        ],
      },
    });

    // LA ASERCIÓN DE DINERO PRIMERO.
    expect(budgetState.balance).toBe(balanceBefore);
    expect(debitMock).not.toHaveBeenCalled();
    expect(creditMock).not.toHaveBeenCalled(); // no hay nada que reembolsar
    // Ni se cotizó: el 400 corre antes del preHandler de precio (y de discovery).
    expect(mockResolvePrice).not.toHaveBeenCalled();

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
    expect(res.json().error).toContain('Step 1:');
    expect(res.json().error).toContain('non-array object');
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it('T-MAP-16 (AC-6 · S8): mapeo declarado en el step 0 → 400 pre-cobro', async () => {
    // No hay step anterior. Es detectable en el body, así que se rechaza acá en
    // vez de dejarlo morir mid-pipeline con el step 0 ya cobrado.
    const balanceBefore = budgetState.balance;

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: {
        steps: [
          { agent: 'fx', input: {}, inputFromPrevious: { quoteId: 'quoteId' } },
          { agent: 'payout', input: {} },
        ],
      },
    });

    expect(budgetState.balance).toBe(balanceBefore);
    expect(debitMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('not allowed on step 0');
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it('T-MAP-17 (AC-6 · S7): destino que ya existe en `step.input` → 400 pre-cobro', async () => {
    // El valor del llamador nunca se descarta en silencio: si el gateway lo
    // pisara, el caller creería haber mandado un `quoteId` que nunca viajó.
    const balanceBefore = budgetState.balance;

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: {
        steps: [
          { agent: 'fx', input: {} },
          {
            agent: 'payout',
            input: { quoteId: 'el-mio' },
            inputFromPrevious: { quoteId: 'quoteId' },
          },
        ],
      },
    });

    expect(budgetState.balance).toBe(balanceBefore);
    expect(debitMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('already present');
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it('T-MAP-15b (invariante AC-4): un mapeo BIEN formado NO altera el cobro del step 0', async () => {
    // La contracara obligatoria: el guard nuevo no puede rechazar de más ni
    // cambiar un centavo del camino feliz.
    const balanceBefore = budgetState.balance;
    mockCompose.mockResolvedValueOnce({
      success: true,
      output: 'ok',
      steps: [],
      totalCostUsdc: STEP0_PRICE,
      totalLatencyMs: 1,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: {
        steps: [
          { agent: 'fx', input: {} },
          {
            agent: 'payout',
            input: { method: 'yape' },
            inputFromPrevious: { quoteId: 'quoteId' },
          },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(debitMock).toHaveBeenCalledTimes(1);
    expect(debitMock.mock.calls[0]?.[2]).toBe(STEP0_PRICE);
    expect(creditMock).not.toHaveBeenCalled();
    expect(budgetState.balance).toBeCloseTo(balanceBefore - STEP0_PRICE, 8);
    // Y el campo llegó INTACTO al service (ajv no lo removió por el camino).
    expect(mockCompose.mock.calls[0]?.[0]?.steps[1]?.inputFromPrevious).toEqual(
      {
        quoteId: 'quoteId',
      },
    );
  });

  it('T-MAP-18 (AC-5 · DINERO, ruta): mapeo roto mid-pipeline → 400 y el step 0 NO se reembolsa de más', async () => {
    // El mapeo del step 1 es válido de FORMA (pasa el borde) pero irresoluble en
    // ejecución. El service devuelve `INPUT_MAPPING_FAILED` con lo ya cobrado y
    // entregado por el step 0 en `totalCostUsdc`, y el route reembolsa
    // ÚNICAMENTE la diferencia: `max(0, estimado - totalCostUsdc)` = 0.
    const balanceBefore = budgetState.balance;
    mockCompose.mockResolvedValueOnce({
      success: false,
      output: null,
      steps: [],
      totalCostUsdc: STEP0_PRICE, // el step 0 SÍ settleó: entregó valor
      totalLatencyMs: 1,
      error: "Step 1 input mapping failed: field 'quoteId' is not present …",
      errorCode: 'INPUT_MAPPING_FAILED',
      inputMappingFailure: {
        step: 1,
        reason: 'SOURCE_FIELD_MISSING',
        field: 'quoteId',
        source: 'quoteId',
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: {
        steps: [
          { agent: 'fx', input: {} },
          {
            agent: 'payout',
            input: {},
            inputFromPrevious: { quoteId: 'quoteId' },
          },
        ],
      },
    });

    // CD-11: 400 por el `default` del mapeo de status. NO una rama nueva.
    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe('INPUT_MAPPING_FAILED');
    expect(res.json().inputMappingFailure).toEqual({
      step: 1,
      reason: 'SOURCE_FIELD_MISSING',
      field: 'quoteId',
      source: 'quoteId',
    });

    // DINERO: se cobró el step 0 y NO se le devolvió nada, porque entregó valor.
    // Reembolsarlo sería regalar el trabajo que el step 0 sí hizo.
    expect(debitMock).toHaveBeenCalledTimes(1);
    expect(creditMock).not.toHaveBeenCalled();
    expect(budgetState.balance).toBeCloseTo(balanceBefore - STEP0_PRICE, 8);
  });

  it('T-MAP-18b (AC-5 · DINERO, ruta): si el step 0 NO entregó valor, se reembolsa entero', async () => {
    // La otra mitad del contrato de `refundComposeStep0`: con `totalCostUsdc: 0`
    // el step 0 ni settleó, así que su débito vuelve completo. El fallo de mapeo
    // no puede dejar al caller pagando por un pipeline que no entregó nada.
    const balanceBefore = budgetState.balance;
    mockCompose.mockResolvedValueOnce({
      success: false,
      output: null,
      steps: [],
      totalCostUsdc: 0,
      totalLatencyMs: 1,
      error: 'Step 1 input mapping failed: …',
      errorCode: 'INPUT_MAPPING_FAILED',
      inputMappingFailure: { step: 1, reason: 'PREVIOUS_OUTPUT_NOT_OBJECT' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: {
        steps: [
          { agent: 'fx', input: {} },
          {
            agent: 'payout',
            input: {},
            inputFromPrevious: { quoteId: 'quoteId' },
          },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(debitMock).toHaveBeenCalledTimes(1);
    expect(creditMock).toHaveBeenCalledTimes(1);
    expect(creditMock.mock.calls[0]?.[2]).toBe(STEP0_PRICE);
    expect(budgetState.balance).toBeCloseTo(balanceBefore, 8);
  });
});
