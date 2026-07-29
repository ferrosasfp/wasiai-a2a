/**
 * WKH-305 — `inputFromPrevious` a nivel SERVICE: el mapeo de un campo puntual
 * entre steps de `/compose`, y su relación con el cobro.
 *
 * ⚠️ WHY A SEPARATE FILE (mismo motivo que `compose.no-debit-on-abort.test.ts`):
 * el hermano `compose.test.ts` moquea `budgetService.debit`/`creditWithDest` como
 * spies que devuelven `{success:true}` sin mover nada, así que no puede observar
 * un COBRO — sólo una llamada. Acá el mock lleva un balance en memoria: `debit`
 * RESTA y `creditWithDest` SUMA. Los dos estilos son incompatibles en el mismo
 * archivo (el `beforeEach` del hermano re-setea la implementación en cada test).
 *
 * Por qué importa la diferencia: un `expect(mockDebit).toHaveBeenCalledWith(...)`
 * NO distingue "cobró y devolvió" de "cobró y se lo quedó". Así se escapó el bug
 * de refund de HU-208. Todo AC de dinero de esta suite compara el balance ANTES
 * vs. DESPUÉS, en las dos direcciones: que un mapeo roto NO cobre ese step, y que
 * el camino sin mapeo cobre EXACTAMENTE lo mismo que antes de la HU.
 *
 * Naming: T-MAP-01..08, 12..14, 19..22.
 */

import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { A2AAgentKeyRow, Agent, ComposeStep } from '../types/index.js';

const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({ getLogger: () => logSpy }));

vi.mock('./registry.js', () => ({
  registryService: { getEnabled: vi.fn().mockResolvedValue([]) },
  SYSTEM_OWNER_REF: 'system',
}));

// ── budgetService con BALANCE EN MEMORIA (CD-13) ──────────────────────
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
const creditWithDestMock = vi.hoisted(() =>
  vi.fn(
    async (
      _keyId: string,
      _chainId: number,
      amountUsd: number,
      _ownerRef: string,
      _destination?: string,
      _idem?: { idemKey: string | null },
    ): Promise<{ success: boolean; reverted?: boolean }> => {
      // El credit TIENE que mover el balance: si sólo devolviera `success:true`,
      // un test de "cobró y reembolsó" sería indistinguible de uno de "cobró y se
      // lo quedó".
      budgetState.balance += amountUsd;
      return { success: true, reverted: true };
    },
  ),
);
vi.mock('./budget.js', () => ({
  budgetService: {
    debit: debitMock,
    credit: vi.fn().mockResolvedValue({ success: true, reverted: true }),
    creditWithDest: creditWithDestMock,
    getBalance: vi.fn(),
    registerDeposit: vi.fn(),
    recordSolanaSettleReceipt: vi.fn(),
  },
}));

vi.mock('../adapters/registry.js', () => ({
  getPaymentAdapter: (..._a: unknown[]) => ({
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
vi.mock('../lib/downstream-payment.js', () => ({
  signAndSettleDownstream: vi.fn().mockResolvedValue(null),
}));
vi.mock('./refund-outbox.js', () => ({
  refundOutbox: { enqueueRefund: vi.fn().mockResolvedValue(undefined) },
}));

import { signAndSettleDownstream } from '../lib/downstream-payment.js';
import { composeService } from './compose.js';
import { discoveryService } from './discovery.js';
import { regenerateInputFromErrors } from './llm/input-retry.js';
import { maybeTransform } from './llm/transform.js';

const mockRegen = vi.mocked(regenerateInputFromErrors);
/**
 * EL PAGO AL AGENTE. `signAndSettleDownstream` es el leg que le manda la plata al
 * agente invocado; contarlo es contar pagos reales, no "se llamó a una función".
 * A diferencia del débito del caller, este pago NO se reembolsa: si sale, salió.
 */
const mockDownstreamPay = vi.mocked(signAndSettleDownstream);

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

function mockAgentsBySlug(agents: Record<string, Agent>) {
  vi.mocked(discoveryService.getAgent).mockImplementation(
    async (slug: string, _registry?: string) => agents[slug] ?? null,
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

/** El body REAL que recibió el agente del step `n` (no un spy de argumentos). */
function bodySentToAgent(n: number): Record<string, unknown> {
  const init = mockFetch.mock.calls[n]?.[1] as { body?: string } | undefined;
  return JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
}

/** Corre un pipeline con la credencial master y el chain de siempre. */
function runPipeline(steps: ComposeStep[]) {
  return composeService.compose({
    steps: steps as Parameters<typeof composeService.compose>[0]['steps'],
    scopingKeyRow: makeKeyRow(),
    chainId: 2368,
    a2aKey: 'wasi_a2a_test',
  });
}

const P0 = 0.001;
const P1 = 0.05;
const P2 = 0.02;

beforeEach(() => {
  vi.clearAllMocks();
  // ⚠️ `clearAllMocks` limpia las LLAMADAS, no la cola de `mockResolvedValueOnce`.
  // Un test que encola una respuesta y NO la consume (p. ej. el que prueba que el
  // retry NO ocurre) se la deja al test siguiente y le corre todas las respuestas
  // un lugar. `mockReset` es lo único que vacía la cola.
  mockFetch.mockReset();
  mockRegen.mockReset();
  mockRegen.mockResolvedValue(null);
  budgetState.balance = 10;
  debitMock.mockImplementation(async (_k, _c, amountUsd: number) => {
    budgetState.balance -= amountUsd;
    return { success: true };
  });
  creditWithDestMock.mockImplementation(
    async (_k, _c, amountUsd: number, _o) => {
      budgetState.balance += amountUsd;
      return { success: true, reverted: true };
    },
  );
  vi.mocked(discoveryService.getAgent).mockResolvedValue(null);
  vi.mocked(discoveryService.discover).mockResolvedValue({
    agents: [],
    total: 0,
    registries: [],
  });
  mockRegen.mockResolvedValue(null);
  vi.mocked(maybeTransform).mockResolvedValue({
    transformedOutput: null,
    cacheHit: 'SKIPPED',
    bridgeType: 'SKIPPED',
    latencyMs: 0,
  });
});

// ══════════════════════════════════════════════════════════════
// AC-1 — el campo llega al agente
// ══════════════════════════════════════════════════════════════

describe('WKH-305 · AC-1: el campo mapeado llega al agente', () => {
  it('T-MAP-01: el body del step 1 lleva el `quoteId` que emitió el step 0', () => {
    mockAgentsBySlug({
      fx: makeAgent({ slug: 'fx', priceUsdc: P0 }),
      payout: makeAgent({ slug: 'payout', priceUsdc: P1, id: 'agent-2' }),
    });
    mockFetchOk({ quoteId: 'q-1', rate: 3.7 });
    mockFetchOk({ result: 'paid' });

    return runPipeline([
      { agent: 'fx', input: { corridor: 'US-PE', amountUsd: 400 } },
      {
        agent: 'payout',
        input: { method: 'yape' },
        inputFromPrevious: { quoteId: 'quoteId' },
      },
    ]).then((result) => {
      expect(result.success).toBe(true);
      // El body REAL que viajó al agente, no un spy: AC-1 se prueba sobre lo que
      // el agente efectivamente recibió.
      expect(bodySentToAgent(1)).toEqual({ method: 'yape', quoteId: 'q-1' });
    });
  });

  it('T-MAP-02 (CD-5): ni `step.input` ni la salida anterior se mutan', async () => {
    mockAgentsBySlug({
      fx: makeAgent({ slug: 'fx', priceUsdc: P0 }),
      payout: makeAgent({ slug: 'payout', priceUsdc: P1, id: 'agent-2' }),
    });
    const prevOutput = { quoteId: 'q-1', rate: 3.7 };
    mockFetchOk(prevOutput);
    mockFetchOk({ result: 'paid' });

    const stepInput = { method: 'yape' };
    const steps: ComposeStep[] = [
      { agent: 'fx', input: {} },
      {
        agent: 'payout',
        input: stepInput,
        inputFromPrevious: { quoteId: 'quoteId' },
      },
    ];

    await runPipeline(steps);

    // El input declarado sigue SIN la clave que el gateway agregó.
    expect(stepInput).toEqual({ method: 'yape' });
    expect(Object.hasOwn(stepInput, 'quoteId')).toBe(false);
    // Y la salida del step 0, tal cual la devolvió el agente.
    expect(prevOutput).toEqual({ quoteId: 'q-1', rate: 3.7 });
  });

  it('T-MAP-22 (§5.4): `passOutput` y el mapeo COEXISTEN', async () => {
    mockAgentsBySlug({
      fx: makeAgent({ slug: 'fx', priceUsdc: P0 }),
      payout: makeAgent({ slug: 'payout', priceUsdc: P1, id: 'agent-2' }),
    });
    mockFetchOk({ quoteId: 'q-1', rate: 3.7 });
    mockFetchOk({ result: 'paid' });

    const result = await runPipeline([
      { agent: 'fx', input: {} },
      {
        agent: 'payout',
        input: { method: 'yape' },
        passOutput: true,
        inputFromPrevious: { quoteId: 'quoteId' },
      },
    ]);

    expect(result.success).toBe(true);
    // El objeto entero bajo `previousOutput` Y el campo promovido a primer nivel.
    expect(bodySentToAgent(1)).toEqual({
      method: 'yape',
      previousOutput: { quoteId: 'q-1', rate: 3.7 },
      quoteId: 'q-1',
    });
  });
});

// ══════════════════════════════════════════════════════════════
// AC-2 — un mapeo irresoluble falla ANTES de cobrar y de invocar
// ══════════════════════════════════════════════════════════════

describe('WKH-305 · AC-2: el mapeo irresoluble aborta el step, pre-cobro y pre-invoke', () => {
  function twoStepWithMapping(prevOutput: unknown) {
    mockAgentsBySlug({
      fx: makeAgent({ slug: 'fx', priceUsdc: P0 }),
      payout: makeAgent({ slug: 'payout', priceUsdc: P1, id: 'agent-2' }),
    });
    mockFetchOk(prevOutput);
    // A propósito NO se encola una 2ª respuesta: si el step 1 se invocara, el
    // fetch devolvería `undefined` y el test fallaría en vez de pasar por azar.
    return runPipeline([
      { agent: 'fx', input: {} },
      {
        agent: 'payout',
        input: { method: 'yape' },
        inputFromPrevious: { quoteId: 'quoteId' },
      },
    ]);
  }

  it('T-MAP-03: clave ausente en la salida previa → SOURCE_FIELD_MISSING y el agente NO se invoca', async () => {
    const result = await twoStepWithMapping({ rate: 3.7 });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('INPUT_MAPPING_FAILED');
    expect(result.inputMappingFailure).toEqual({
      step: 1,
      reason: 'SOURCE_FIELD_MISSING',
      field: 'quoteId',
      source: 'quoteId',
    });
    // Conteo de llamadas: sólo el step 0 salió a la red.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // Y el texto nombra step, campo y origen (sin obligar a parsearlo).
    expect(result.error).toContain('Step 1 input mapping failed');
    expect(result.error).toContain('quoteId');
  });

  it('T-MAP-04: salida previa `null` → PREVIOUS_OUTPUT_NOT_OBJECT', async () => {
    // El `null` NO llega crudo del agente (`invokeAgent` hace `data.result ??
    // data`, así que un body `null` muere en el step 0): llega por el BRIDGE.
    // Cuando el agente siguiente declara `inputSchema`, `lastOutput` pasa a ser
    // `maybeTransform().transformedOutput`, que puede ser `null`. §5.4: el mapeo
    // lee `lastOutput` DESPUÉS del bridge, o sea exactamente el mismo objeto que
    // `passOutput` habría inyectado.
    mockAgentsBySlug({
      fx: makeAgent({ slug: 'fx', priceUsdc: P0 }),
      payout: makeAgent({
        slug: 'payout',
        priceUsdc: P1,
        id: 'agent-2',
        metadata: { inputSchema: { type: 'object' } },
      }),
    });
    mockFetchOk({ quoteId: 'q-1' });
    vi.mocked(maybeTransform).mockResolvedValueOnce({
      transformedOutput: null,
      cacheHit: false,
      bridgeType: 'LLM',
      latencyMs: 1,
    });

    const result = await runPipeline([
      { agent: 'fx', input: {} },
      {
        agent: 'payout',
        input: { method: 'yape' },
        inputFromPrevious: { quoteId: 'quoteId' },
      },
    ]);

    expect(result.inputMappingFailure?.reason).toBe(
      'PREVIOUS_OUTPUT_NOT_OBJECT',
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('T-MAP-05: salida previa ARRAY → PREVIOUS_OUTPUT_NOT_OBJECT', async () => {
    const result = await twoStepWithMapping([{ quoteId: 'q-1' }]);
    expect(result.inputMappingFailure?.reason).toBe(
      'PREVIOUS_OUTPUT_NOT_OBJECT',
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  const A2A_MSG = {
    kind: 'message',
    role: 'agent',
    parts: [{ kind: 'text', text: 'q-1' }],
    messageId: 'm1',
  };

  it('T-MAP-06: salida previa `A2AMessage` → falla con un código estable, sin lanzar y sin invocar', async () => {
    // §5.4: NO se re-implementa `isA2AMessage` en el resolvedor. El mapeo lee
    // `lastOutput` DESPUÉS del bridge, así que el `reason` depende de qué dejó el
    // bridge — y las DOS posibilidades son códigos estables de AC-2. Acá el
    // agente siguiente NO es `a2aCompliant` y no declara `inputSchema`, así que
    // el bridge DESENVUELVE el mensaje a su parte de texto (un primitivo).
    const result = await twoStepWithMapping(A2A_MSG);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('INPUT_MAPPING_FAILED');
    expect(result.inputMappingFailure?.reason).toBe(
      'PREVIOUS_OUTPUT_NOT_OBJECT',
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('T-MAP-06b: si el bridge deja el `A2AMessage` entero (passthrough A2A→A2A) → SOURCE_FIELD_MISSING', async () => {
    // La otra rama de §5.4: con el target `a2aCompliant:true` el bridge hace
    // passthrough y `lastOutput` SIGUE siendo el mensaje, que es un objeto plano
    // con `kind`/`parts`. `quoteId` no está entre sus claves ⇒ falla por la vía
    // normal, sin una rama especial por tipo de payload.
    mockAgentsBySlug({
      fx: makeAgent({ slug: 'fx', priceUsdc: P0 }),
      payout: makeAgent({
        slug: 'payout',
        priceUsdc: P1,
        id: 'agent-2',
        metadata: { a2aCompliant: true },
      }),
    });
    mockFetchOk(A2A_MSG);

    const result = await runPipeline([
      { agent: 'fx', input: {} },
      {
        agent: 'payout',
        input: { method: 'yape' },
        inputFromPrevious: { quoteId: 'quoteId' },
      },
    ]);

    expect(result.errorCode).toBe('INPUT_MAPPING_FAILED');
    expect(result.inputMappingFailure?.reason).toBe('SOURCE_FIELD_MISSING');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('T-MAP-21 (DT-6): un mapeo MALFORMADO que no pasó por la ruta falla pre-débito', async () => {
    // El schema de `POST /orchestrate/execute` no declara
    // `additionalProperties:false`, así que ajv NO remueve el campo: un
    // `inputFromPrevious` malformado puede llegar acá sin haber pasado nunca por
    // `validateComposeBodyHandler`. Por eso el resolvedor revalida la forma.
    mockAgentsBySlug({
      fx: makeAgent({ slug: 'fx', priceUsdc: P0 }),
      payout: makeAgent({ slug: 'payout', priceUsdc: P1, id: 'agent-2' }),
    });
    mockFetchOk({ quoteId: 'q-1' });

    const balanceBefore = budgetState.balance;
    const result = await runPipeline([
      { agent: 'fx', input: {} },
      {
        agent: 'payout',
        input: {},
        // Forma inválida: un array no puede expresar destino→origen.
        inputFromPrevious: ['quoteId'] as unknown as Record<string, string>,
      },
    ]);

    expect(result.success).toBe(false);
    expect(result.inputMappingFailure?.reason).toBe('INVALID_MAPPING_SHAPE');
    // Fail-closed: el step 1 no se cobró ni se invocó.
    expect(budgetState.balance).toBe(balanceBefore);
    expect(debitMock).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ══════════════════════════════════════════════════════════════
// DINERO — las dos direcciones (CD-13)
// ══════════════════════════════════════════════════════════════

describe('WKH-305 · DINERO: un mapeo roto no cobra ese step, y el camino bueno cobra igual', () => {
  /** 3 steps; el mapeo del step 2 apunta a una clave que el step 1 no emite. */
  function threeStepsBrokenAtTwo() {
    mockAgentsBySlug({
      kyc: makeAgent({ slug: 'kyc', priceUsdc: P0 }),
      fx: makeAgent({ slug: 'fx', priceUsdc: P1, id: 'agent-2' }),
      payout: makeAgent({ slug: 'payout', priceUsdc: P2, id: 'agent-3' }),
    });
    mockFetchOk({ ok: true });
    mockFetchOk({ rate: 3.7 }); // el step 1 NO emite `quoteId`
    return runPipeline([
      { agent: 'kyc', input: {} },
      { agent: 'fx', input: {} },
      {
        agent: 'payout',
        input: { method: 'yape' },
        inputFromPrevious: { quoteId: 'quoteId' },
      },
    ]);
  }

  it('T-MAP-07 (CD-2 · DINERO): el balance final = inicial − precio(step 1); el step 2 no movió un centavo', async () => {
    const balanceBefore = budgetState.balance;

    const result = await threeStepsBrokenAtTwo();

    // LA ASERCIÓN DE DINERO PRIMERO, y sobre el NÚMERO: "no se llamó a debit" no
    // alcanza para distinguir "no cobró" de "cobró y devolvió".
    expect(budgetState.balance).toBeCloseTo(balanceBefore - P1, 10);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('INPUT_MAPPING_FAILED');
    // El step 0 lo debita el middleware; el service sólo debitó el step 1.
    expect(debitMock).toHaveBeenCalledTimes(1);
    expect(debitMock).toHaveBeenCalledWith(
      'k1',
      2368,
      P1,
      undefined,
      undefined,
      'test-registry/fx',
      'owner-test',
    );
  });

  it('T-MAP-08 (AC-5 · DINERO): los steps buenos quedan intactos y NO se reembolsan', async () => {
    const result = await threeStepsBrokenAtTwo();

    // Los steps 0..i-1 entregaron valor: su cobro se queda donde está.
    expect(result.steps).toHaveLength(2);
    expect(result.totalCostUsdc).toBeCloseTo(P0 + P1, 10);
    // CERO reembolsos: un fallo de mapeo del step 2 no puede devolver plata de
    // los steps que sí corrieron.
    expect(creditWithDestMock).not.toHaveBeenCalled();
  });

  it('T-MAP-13 (AC-4 · DINERO, la otra dirección): sin mapeo, 3 steps OK, el balance se mueve EXACTAMENTE p1+p2', async () => {
    mockAgentsBySlug({
      kyc: makeAgent({ slug: 'kyc', priceUsdc: P0 }),
      fx: makeAgent({ slug: 'fx', priceUsdc: P1, id: 'agent-2' }),
      payout: makeAgent({ slug: 'payout', priceUsdc: P2, id: 'agent-3' }),
    });
    mockFetchOk({ ok: true });
    mockFetchOk({ rate: 3.7 });
    mockFetchOk({ result: 'paid' });

    const balanceBefore = budgetState.balance;

    const result = await runPipeline([
      { agent: 'kyc', input: {} },
      { agent: 'fx', input: {} },
      { agent: 'payout', input: {} },
    ]);

    expect(result.success).toBe(true);
    // El reordenamiento del débito no puede haber cambiado un centavo.
    expect(budgetState.balance).toBeCloseTo(balanceBefore - (P1 + P2), 10);
    // Mismo destino canónico y mismo chainId que antes de la HU.
    expect(debitMock).toHaveBeenNthCalledWith(
      1,
      'k1',
      2368,
      P1,
      undefined,
      undefined,
      'test-registry/fx',
      'owner-test',
    );
    expect(debitMock).toHaveBeenNthCalledWith(
      2,
      'k1',
      2368,
      P2,
      undefined,
      undefined,
      'test-registry/payout',
      'owner-test',
    );
    expect(creditWithDestMock).not.toHaveBeenCalled();
  });

  it('T-MAP-14 (CD-18): un pipeline sin mapeo hace la MISMA cantidad de llamadas de I/O', async () => {
    // Assert de I/O, no sólo de efecto: "no agrega costo" se prueba contando las
    // llamadas, porque una llamada de más al ledger es plata aunque el balance
    // final coincida.
    mockAgentsBySlug({
      kyc: makeAgent({ slug: 'kyc', priceUsdc: P0 }),
      fx: makeAgent({ slug: 'fx', priceUsdc: P1, id: 'agent-2' }),
      payout: makeAgent({ slug: 'payout', priceUsdc: P2, id: 'agent-3' }),
    });
    mockFetchOk({ ok: true });
    mockFetchOk({ rate: 3.7 });
    mockFetchOk({ result: 'paid' });

    await runPipeline([
      { agent: 'kyc', input: {} },
      { agent: 'fx', input: {} },
      { agent: 'payout', input: {} },
    ]);

    expect(debitMock).toHaveBeenCalledTimes(2); // steps 1 y 2 (el 0 es del middleware)
    expect(creditWithDestMock).toHaveBeenCalledTimes(0);
    expect(mockFetch).toHaveBeenCalledTimes(3); // una invocación por step
  });

  it('T-MAP-12 (AC-4 / CD-3): sin mapeo ni `passOutput`, el agente recibe `step.input` POR LA MISMA REFERENCIA', async () => {
    mockAgentsBySlug({ kyc: makeAgent({ slug: 'kyc', priceUsdc: P0 }) });
    mockFetchOk({ ok: true });

    const stepInput = { corridor: 'US-PE' };
    const spy = vi.spyOn(composeService, 'invokeAgent');

    await runPipeline([{ agent: 'kyc', input: stepInput }]);

    // `toBe`: ni copia ni allocación nueva. Es lo que garantiza que un pipeline
    // sin mapeo corre byte-idéntico a como corría antes de la HU.
    expect(spy.mock.calls[0]?.[1]).toBe(stepInput);
    spy.mockRestore();
  });
});

// ══════════════════════════════════════════════════════════════
// AC-7 — el retry adaptativo re-aplica el mapeo
// ══════════════════════════════════════════════════════════════

describe('WKH-305 · AC-7: el retry adaptativo re-aplica el mapeo antes del re-débito', () => {
  /**
   * Encola el step 0 (OK, emite `quoteId`) y el primer intento del step 1 (400
   * con field-errors → refund d1 + retry adaptativo). ⚠️ La respuesta del
   * RE-INVOKE se encola DESPUÉS de llamar a esto: `mockResolvedValueOnce` es una
   * cola FIFO y el orden de encolado ES el orden de las respuestas.
   */
  function queueStep0AndFailedAttempt(flaggedField = 'amount') {
    mockAgentsBySlug({
      fx: makeAgent({ slug: 'fx', priceUsdc: P0 }),
      payout: makeAgent({ slug: 'payout', priceUsdc: P1, id: 'agent-2' }),
    });
    mockFetchOk({ quoteId: 'q-real', rate: 3.7 });
    // `flaggedField` = el campo que el AGENTE señala como problemático. Default
    // `amount` (ajeno al mapeo) = el camino de retry de siempre.
    mockFetchError(
      400,
      JSON.stringify({ fieldErrors: { [flaggedField]: ['required'] } }),
    );
  }

  function runRetryPipeline() {
    return runPipeline([
      { agent: 'fx', input: {} },
      {
        agent: 'payout',
        input: { method: 'yape' },
        inputFromPrevious: { quoteId: 'quoteId' },
      },
    ]);
  }

  it('T-MAP-19: si el LLM borra el campo mapeado, el re-invoke IGUAL lo lleva, con el valor del step anterior', async () => {
    // El input que se RE-INVOCA no es el que se mapeó: es el que devolvió el
    // modelo. Sin la re-aplicación, el agente recibiría un body sin `quoteId`
    // (o con uno inventado) y el caller pagaría un retry destinado a fallar.
    queueStep0AndFailedAttempt();
    mockRegen.mockResolvedValueOnce({ method: 'yape', amount: 42 });
    mockFetchOk({ result: 'paid' }); // el re-invoke sale bien

    const result = await runRetryPipeline();

    expect(result.success).toBe(true);
    const retryBody = bodySentToAgent(2);
    expect(retryBody.quoteId).toBe('q-real');
    expect(retryBody.amount).toBe(42); // lo que el LLM sí arregló, respetado
  });

  it('T-MAP-19b: si el LLM INVENTA un valor para el campo mapeado, gana el del step anterior', async () => {
    // Que un modelo de lenguaje decida el identificador de cotización de una
    // remesa es inaceptable: lo emitió otro agente, no es un texto completable.
    queueStep0AndFailedAttempt();
    mockRegen.mockResolvedValueOnce({
      method: 'yape',
      amount: 42,
      quoteId: 'q-INVENTADO-POR-EL-LLM',
    });
    mockFetchOk({ result: 'paid' });

    await runRetryPipeline();

    expect(bodySentToAgent(2).quoteId).toBe('q-real');
  });

  it('T-MAP-20 (CD-2 · DINERO): 1 solo débito activo; si el retry falla, el balance vuelve al valor previo al step', async () => {
    queueStep0AndFailedAttempt();
    mockRegen.mockResolvedValueOnce({ method: 'yape', amount: 42 });
    mockFetchError(502); // el re-invoke falla en el agente

    const balanceBefore = budgetState.balance;
    const result = await runRetryPipeline();

    expect(result.success).toBe(false);
    // Débito original + re-débito = 2 llamadas; refund d1 + refund d2 = 2
    // créditos. El neto es cero: nunca hubo más de un débito activo a la vez.
    expect(debitMock).toHaveBeenCalledTimes(2);
    expect(creditWithDestMock).toHaveBeenCalledTimes(2);
    expect(budgetState.balance).toBeCloseTo(balanceBefore, 10);
  });

  // ── CR MNR-2: el retry condenado a repetir el valor mapeado ──────────────
  //
  // El caso real: el agente rechaza el `quoteId` porque VENCIÓ. El LLM regenera
  // uno nuevo, el mapeo lo PISA con el mismo de siempre (AC-7), y el re-invoke
  // manda exactamente el valor que el agente acaba de rechazar. El reintento
  // está garantizado a fallar antes de empezar — y no sale gratis: el débito del
  // caller vuelve, pero el pago downstream al agente ya salió y no se revierte.

  it('T-MAP-23 (CR MNR-2 · DINERO): si el agente rechaza un campo QUE EL MAPEO PUEBLA, no hay retry ni segundo pago', async () => {
    queueStep0AndFailedAttempt('quoteId'); // el agente señala el campo MAPEADO
    // Si el retry corriera, el LLM devolvería esto y el mapeo lo pisaría con
    // 'q-real' — el mismo valor que el agente rechazó.
    mockRegen.mockResolvedValueOnce({ method: 'yape', quoteId: 'q-nuevo' });
    mockFetchOk({ result: 'paid' }); // encolado A PROPÓSITO: no debe consumirse

    const balanceBefore = budgetState.balance;
    const result = await runRetryPipeline();

    expect(result.success).toBe(false);
    // ── DINERO: el ledger del caller hace UN solo viaje, no dos.
    // Sin el guard son 2 débitos + 2 créditos: cada re-débito consume y libera
    // el cap por destino, y el neto sólo vuelve a cero si el refund del retry
    // TAMBIÉN revierte. Un viaje de dinero que no podía terminar bien.
    expect(debitMock).toHaveBeenCalledTimes(1);
    expect(creditWithDestMock).toHaveBeenCalledTimes(1);
    expect(budgetState.balance).toBeCloseTo(balanceBefore, 10);
    // ── Ni siquiera se llamó al LLM: el guard corre ANTES de regenerar.
    expect(mockRegen).not.toHaveBeenCalled();
    // ── El agente se invocó 2 veces, no 3 (la 3ª respuesta quedó sin consumir).
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // ── PAGOS AL AGENTE: uno solo, el del step 0.
    // ⚠️ Honestidad sobre qué prueba esta línea: HOY vale 1 con guard y sin él,
    // porque el intento condenado responde 400 y `invokeAgent` LANZA antes de
    // llegar al leg de pago downstream (que sólo corre tras un 2xx). O sea que
    // por sí sola NO discrimina, y no se la cuenta como la evidencia del guard
    // —esa es el débito de arriba—. Está como candado de regresión: T-MAP-24
    // muestra que un retry que SÍ llega a 2xx paga de verdad, así que si alguien
    // hiciera que el intento condenado alcance el leg de pago, ese segundo settle
    // (que no se reembolsa) aparecería acá.
    expect(mockDownstreamPay).toHaveBeenCalledTimes(1);
  });

  it('T-MAP-24 (CR MNR-2, la otra dirección): un campo problemático AJENO al mapeo sigue reintentando como hoy', async () => {
    // El guard tiene que ser una intersección, no un interruptor: con mapeo
    // declarado pero un campo señalado que el mapeo NO puebla, el retry
    // adaptativo funciona igual que antes de esta corrección.
    queueStep0AndFailedAttempt('amount'); // NO es clave destino del mapeo
    mockRegen.mockResolvedValueOnce({ method: 'yape', amount: 42 });
    mockFetchOk({ result: 'paid' });

    const result = await runRetryPipeline();

    expect(result.success).toBe(true);
    // Hubo retry: 2 débitos (original + retry) y 3 invocaciones del agente.
    expect(mockRegen).toHaveBeenCalledTimes(1);
    expect(debitMock).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    // PAGOS AL AGENTE: 2 — el step 0 y el RE-INVOKE, que llegó a 2xx. El primer
    // intento del step 1 (400) no pagó: `invokeAgent` lanza antes del leg de
    // pago. Esto es lo que hace concreto el costo del retry condenado de
    // T-MAP-23: un reintento que llega a 2xx paga de verdad, y ese pago no
    // se reembolsa.
    expect(mockDownstreamPay).toHaveBeenCalledTimes(2);
    // Y el campo mapeado viajó igual en el re-invoke (AC-7 intacto).
    expect(bodySentToAgent(2).quoteId).toBe('q-real');
  });

  it('T-MAP-20b (CD-3): sin mapeo declarado, el camino del retry queda byte-idéntico', async () => {
    mockAgentsBySlug({
      fx: makeAgent({ slug: 'fx', priceUsdc: P0 }),
      payout: makeAgent({ slug: 'payout', priceUsdc: P1, id: 'agent-2' }),
    });
    mockFetchOk({ quoteId: 'q-real' });
    mockFetchError(400, '{"fieldErrors":{"amount":["required"]}}');
    const regenerated = { method: 'yape', amount: 42 };
    mockRegen.mockResolvedValueOnce(regenerated);
    mockFetchOk({ result: 'paid' });

    const spy = vi.spyOn(composeService, 'invokeAgent');

    const result = await runPipeline([
      { agent: 'fx', input: {} },
      { agent: 'payout', input: { method: 'yape' } }, // SIN inputFromPrevious
    ]);

    expect(result.success).toBe(true);
    // calls: 0 = step 0, 1 = step 1 (1er intento), 2 = step 1 (RE-INVOKE).
    // MISMA REFERENCIA del objeto que devolvió el LLM: sin mapeo declarado el
    // resolvedor no alloca nada nuevo (R2).
    expect(spy.mock.calls[2]?.[1]).toBe(regenerated);
    spy.mockRestore();
  });
});
