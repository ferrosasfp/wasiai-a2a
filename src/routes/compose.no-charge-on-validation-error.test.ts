/**
 * Compose route — HIGH-2 (2026-07-26): un `/compose` que responde 400 de
 * validación NO debe cobrar. Cobrar por trabajo no hecho.
 *
 * EL BUG: los tres checks de shape (`steps` vacío/ausente, >5 steps, un step sin
 * `agent` string) vivían SOLO en el route handler, que corre DESPUÉS de
 * `requirePaymentOrA2AKey`. O sea que el request ya había pasado por el débito y
 * se le cobraba al caller sin ejecutar nada. Peor: con `steps: []` el preHandler
 * de precio no inyectaba `composeEstimatedCostUsd`, así que el middleware caía en
 * `PLACEHOLDER_FEE_USD` y cobraba **$1 flat** por un body vacío.
 *
 * EL FIX: dirección (a) — la validación se adelanta a un preHandler
 * (`validateComposeBodyHandler`) que corre ANTES del débito. No se cobra nunca por
 * lo que no se ejecuta, y no hay ventana en la que el balance baje y suba.
 * Dirección (b) — credit-back (mecanismo de WKH-127) para los dos caminos de 504
 * que NO se pueden adelantar (el timer ya disparó cuando el débito ocurrió).
 *
 * POR QUÉ UN ARCHIVO SEPARADO: igual que `compose.no-debit-on-abort.test.ts`, el
 * hermano `compose.test.ts` moquea `requirePaymentOrA2AKey` con un pass-through
 * que NUNCA debita, así que no puede observar un cobro. Acá corre el middleware
 * REAL y se moquea SOLO la capa de datos, con un balance en memoria.
 *
 * Un test que sólo mira el status no prueba nada de esto: todas las aserciones
 * de dinero comparan el balance ANTES y DESPUÉS.
 *
 * Naming: T-NOCHARGE-01..T-NOCHARGE-15 (13..15: BLQ-MED-1, el 504 que dispara
 * antes de que el route handler exista → el credit-back NO puede vivir en el
 * handler porque Fastify no lo invoca).
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { A2AAgentKeyRow } from '../types/index.js';

// ── Structured logger mock (compose.ts + a2a-key.ts use getLogger) ──
const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({
  getLogger: () => logSpy,
}));

// ── Chain registry helpers (resolveTargetChain dependencies) ──
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

// ── Agent price service ──
vi.mock('../services/agent-price.js', () => ({
  resolveAgentPriceUsdc: vi.fn(),
  resolveAgentDestination: vi.fn().mockResolvedValue(null),
}));

vi.mock('../services/compose.js', () => ({
  composeService: { compose: vi.fn() },
}));

// ── identityService: funded, active master key with $10 on chain 2368 ──
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
  identityService: {
    lookupByHash: vi.fn().mockResolvedValue(fundedKey),
  },
}));

// ── budgetService: balance en memoria. `debit` resta, `credit` SUMA ──
// El credit tiene que mover el balance de verdad: si sólo devolviera
// `{success:true}` sin tocarlo, un test de "cobró y reembolsó" sería
// indistinguible de uno de "cobró y se lo quedó".
const budgetState = vi.hoisted(() => ({
  balance: 10,
  failNextGetBalance: false,
  // BLQ-MED-1: latencia inyectable en los dos puntos de I/O que corren DENTRO
  // del middleware de pago, para abrir la ventana en la que el timer del 504
  // dispara con el débito ya aplicado (o aplicándose) y el route handler nunca
  // llega a correr. Default 0 → el resto de la suite no cambia.
  debitLatencyMs: 0,
  getBalanceLatencyMs: 0,
}));
const sleep = vi.hoisted(
  () => (ms: number) => new Promise((r) => setTimeout(r, ms)),
);
const debitMock = vi.hoisted(() =>
  vi.fn(
    async (
      _keyId: string,
      _chainId: number,
      amountUsd: number,
    ): Promise<{ success: boolean; error?: string }> => {
      if (budgetState.debitLatencyMs > 0) {
        await sleep(budgetState.debitLatencyMs);
      }
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
      // 4º arg = `ownerRef`. Firma real de `budgetService.credit` (WKH-127 CD-10):
      // el ownership guard es obligatorio (CLAUDE.md), así que el mock lo tipa
      // para poder asertarlo.
      _ownerRef: string,
    ): Promise<{ success: boolean; reverted?: boolean }> => {
      budgetState.balance += amountUsd;
      return { success: true, reverted: true };
    },
  ),
);
const getBalanceMock = vi.hoisted(() =>
  vi.fn(async (): Promise<string> => {
    if (budgetState.getBalanceLatencyMs > 0) {
      await sleep(budgetState.getBalanceLatencyMs);
    }
    if (budgetState.failNextGetBalance) {
      budgetState.failNextGetBalance = false;
      throw new Error('PGRST connection lost');
    }
    return budgetState.balance.toFixed(2);
  }),
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

// Timeout: no-op por defecto. Las suites de 504 usan el REAL con un app aparte.
vi.mock('../middleware/timeout.js', async (orig) => {
  const actual = await orig<typeof import('../middleware/timeout.js')>();
  return {
    createTimeoutHandler: (ms: number) =>
      useRealTimeout.value
        ? actual.createTimeoutHandler(ms)
        : async (_request: FastifyRequest, _reply: FastifyReply) => {
            /* no-op */
          },
  };
});
const useRealTimeout = vi.hoisted(() => ({ value: false }));

import {
  resolveAgentDestination,
  resolveAgentPriceUsdc,
} from '../services/agent-price.js';
import { composeService } from '../services/compose.js';
// NOTE: requirePaymentOrA2AKey is NOT mocked — the REAL middleware runs.
import composeRoutes from './compose.js';

const mockResolvePrice = vi.mocked(resolveAgentPriceUsdc);
const mockResolveDest = vi.mocked(resolveAgentDestination);
const mockCompose = vi.mocked(composeService.compose);

const KEY_HEADER = { 'x-a2a-key': 'wasi_a2a_funded_master_key' };
const STEP0_PRICE = 0.5;

// ══════════════════════════════════════════════════════════════
// (a) Validación adelantada al débito
// ══════════════════════════════════════════════════════════════

describe('compose route — 400 de validación NO cobra (HIGH-2, dirección (a))', () => {
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
    budgetState.failNextGetBalance = false;
    budgetState.debitLatencyMs = 0;
    budgetState.getBalanceLatencyMs = 0;
    mockResolveDest.mockResolvedValue(null);
    mockResolvePrice.mockResolvedValue(STEP0_PRICE);
  });

  it('T-NOCHARGE-01: steps: [] → 400 y el balance NO se mueve (antes cobraba $1 flat)', async () => {
    const balanceBefore = budgetState.balance;

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: { steps: [] },
    });

    // LA ASERCIÓN DE DINERO PRIMERO. Pre-fix esto fallaba con 10 → 9: el
    // preHandler de precio no inyectaba `composeEstimatedCostUsd`, así que el
    // middleware debitaba PLACEHOLDER_FEE_USD = $1 por un body vacío.
    expect(budgetState.balance).toBe(balanceBefore);
    expect(debitMock).not.toHaveBeenCalled();
    expect(creditMock).not.toHaveBeenCalled(); // no hay nada que reembolsar

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
    expect(res.json().error).toBe('Missing or empty steps array');
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it('T-NOCHARGE-02: body sin `steps` → 400 y el balance NO se mueve (antes cobraba $1 flat)', async () => {
    const balanceBefore = budgetState.balance;

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: { maxBudget: 5 },
    });

    expect(budgetState.balance).toBe(balanceBefore);
    expect(debitMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it('T-NOCHARGE-03: 6 steps → 400 y el balance NO se mueve (antes cobraba el step-0)', async () => {
    const balanceBefore = budgetState.balance;

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: {
        steps: Array.from({ length: 6 }, (_, i) => ({
          agent: `a${i}`,
          input: {},
        })),
      },
    });

    // Pre-fix: step-0 resolvía bien → el middleware debitaba STEP0_PRICE y luego
    // el handler 400eaba sin reembolsar (el bloque de refund vive dentro de
    // `if (!result.success)`, que nunca se alcanza en un 400 de validación).
    expect(budgetState.balance).toBe(balanceBefore);
    expect(debitMock).not.toHaveBeenCalled();
    // Ni se cotizó: el 400 corre antes del preHandler de precio.
    expect(mockResolvePrice).not.toHaveBeenCalled();

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Maximum 5 steps allowed per pipeline');
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it('T-NOCHARGE-04: step final con `agent` no-string → 400 y el balance NO se mueve', async () => {
    const balanceBefore = budgetState.balance;

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: {
        steps: [
          { agent: 'a1', input: {} },
          { agent: 12345, input: {} },
        ],
      },
    });

    expect(budgetState.balance).toBe(balanceBefore);
    expect(debitMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Step 1 is missing a string 'agent' field");
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it('T-NOCHARGE-05: path x402 (sin a2a-key) — body malformado ni llega a cotizarse', async () => {
    // El caller x402 NO tiene refund inbound (el bloque de refund está gateado en
    // `request.a2aKeyRow`), así que la ÚNICA defensa posible es rechazar antes de
    // emitir el challenge. Si el 402 saliera primero y el caller pagara, el 400
    // posterior se quedaría con su plata sin forma de devolverla.
    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      payload: { steps: [] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
    expect(mockResolvePrice).not.toHaveBeenCalled();
    expect(mockCompose).not.toHaveBeenCalled();
  });

  // ── INVARIANTE: un compose que SÍ ejecuta cobra EXACTAMENTE lo mismo ──

  it('T-NOCHARGE-06 (invariante): 1 step válido → 200 y cobra el precio real del step-0, sin refund', async () => {
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
      payload: { steps: [{ agent: 'kyc', input: {} }] },
    });

    expect(res.statusCode).toBe(200);
    // El precio NO cambió: exactamente el step-0, una sola vez, sin credit-back.
    expect(debitMock).toHaveBeenCalledTimes(1);
    expect(debitMock.mock.calls[0]?.[2]).toBe(STEP0_PRICE);
    expect(creditMock).not.toHaveBeenCalled();
    expect(budgetState.balance).toBeCloseTo(balanceBefore - STEP0_PRICE, 8);
  });

  it('T-NOCHARGE-07 (invariante): 5 steps válidos (el máximo) → 200 y cobra el step-0 igual que siempre', async () => {
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
        steps: Array.from({ length: 5 }, (_, i) => ({
          agent: `a${i}`,
          input: {},
        })),
      },
    });

    // El límite es 5 INCLUSIVE: no se corrió el borde al adelantar la validación.
    expect(res.statusCode).toBe(200);
    expect(debitMock).toHaveBeenCalledTimes(1);
    expect(debitMock.mock.calls[0]?.[2]).toBe(STEP0_PRICE);
    expect(budgetState.balance).toBeCloseTo(balanceBefore - STEP0_PRICE, 8);
  });

  it('T-NOCHARGE-08 (invariante): pipeline que falla sigue reembolsando el step-0 (AUDIT A1 intacto)', async () => {
    const balanceBefore = budgetState.balance;
    mockCompose.mockResolvedValueOnce({
      success: false,
      output: null,
      steps: [],
      totalCostUsdc: 0,
      totalLatencyMs: 1,
      error: 'Step 0 failed: downstream 500',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: { steps: [{ agent: 'kyc', input: {} }] },
    });

    expect(res.statusCode).toBe(400);
    // Debitó y reembolsó → neto cero. El refactor a `refundComposeStep0` no
    // cambió la matemática.
    expect(debitMock).toHaveBeenCalledTimes(1);
    expect(creditMock).toHaveBeenCalledTimes(1);
    expect(creditMock.mock.calls[0]?.[2]).toBe(STEP0_PRICE);
    // Ownership guard (CLAUDE.md): el credit recibe el owner_ref del caller.
    expect(creditMock.mock.calls[0]?.[3]).toBe('o1');
    expect(budgetState.balance).toBeCloseTo(balanceBefore, 8);
  });

  it('T-NOCHARGE-09 (invariante): fallo parcial NO sobre-reembolsa lo ya settleado', async () => {
    const balanceBefore = budgetState.balance;
    // El step-0 SÍ settleó (su precio está en totalCostUsdc) → clamp a 0.
    mockCompose.mockResolvedValueOnce({
      success: false,
      output: null,
      steps: [],
      totalCostUsdc: STEP0_PRICE,
      totalLatencyMs: 1,
      error: 'Step 1 failed after step 0 settled',
    });

    await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: {
        steps: [
          { agent: 'a0', input: {} },
          { agent: 'a1', input: {} },
        ],
      },
    });

    expect(debitMock).toHaveBeenCalledTimes(1);
    // refundUsd = max(0, 0.5 - 0.5) = 0 → NO se reembolsa trabajo entregado.
    expect(creditMock).not.toHaveBeenCalled();
    expect(budgetState.balance).toBeCloseTo(balanceBefore - STEP0_PRICE, 8);
  });

  // ── (b3) 503 del header de budget post-débito ──

  it('T-NOCHARGE-10: getBalance falla DESPUÉS del débito → ya NO 503 con la plata tomada', async () => {
    const balanceBefore = budgetState.balance;
    budgetState.failNextGetBalance = true;
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
      payload: { steps: [{ agent: 'kyc', input: {} }] },
    });

    // Pre-fix: el read del header `x-a2a-remaining-budget` corría post-débito
    // dentro del try cuyo catch devuelve 503 SERVICE_ERROR → el caller quedaba
    // cobrado, sin ejecución, por un header de conveniencia. Ahora el header se
    // omite y el pipeline corre: el que pagó recibe lo que pagó.
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-a2a-remaining-budget']).toBeUndefined();
    expect(debitMock).toHaveBeenCalledTimes(1);
    expect(mockCompose).toHaveBeenCalledTimes(1);
    expect(budgetState.balance).toBeCloseTo(balanceBefore - STEP0_PRICE, 8);
  });
});

// ══════════════════════════════════════════════════════════════
// (b) Credit-back en los 504 que no se pueden adelantar
// ══════════════════════════════════════════════════════════════

describe('compose route — 504 de timeout post-débito reembolsa (HIGH-2, dirección (b))', () => {
  let app: ReturnType<typeof Fastify>;
  const ORIGINAL_TIMEOUT = process.env.TIMEOUT_COMPOSE_MS;

  beforeAll(async () => {
    // Timeout REAL de 1ms: el timer dispara el 504 mientras los preHandlers
    // (lentos, ver abajo) siguen corriendo — igual que en producción cuando un
    // compose real excede el budget de tiempo DESPUÉS de que el débito ocurrió.
    useRealTimeout.value = true;
    process.env.TIMEOUT_COMPOSE_MS = '1';
    app = Fastify();
    await app.register(composeRoutes, { prefix: '/compose' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    useRealTimeout.value = false;
    if (ORIGINAL_TIMEOUT === undefined) delete process.env.TIMEOUT_COMPOSE_MS;
    else process.env.TIMEOUT_COMPOSE_MS = ORIGINAL_TIMEOUT;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    budgetState.balance = 10;
    budgetState.failNextGetBalance = false;
    budgetState.debitLatencyMs = 0;
    budgetState.getBalanceLatencyMs = 0;
    mockResolveDest.mockResolvedValue(null);
  });

  afterEach(() => {
    mockResolvePrice.mockReset();
    mockCompose.mockReset();
  });

  /**
   * `app.inject` resuelve cuando la respuesta se ENVÍA — y el 504 lo envía el
   * timer, no el handler. El handler sigue corriendo después (es exactamente el
   * caso que estamos probando), así que el credit-back ocurre DESPUÉS de que
   * `inject` volvió. Hay que esperarlo explícitamente: un assert inmediato mide
   * un estado intermedio y da un falso negativo.
   */
  function composeAfter(
    ms: number,
    totalCostUsdc: number,
  ): { done: Promise<void> } {
    let markDone: () => void = () => undefined;
    const done = new Promise<void>((r) => {
      markDone = r;
    });
    mockCompose.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            resolve({
              success: true,
              output: 'ok',
              steps: [],
              totalCostUsdc,
              totalLatencyMs: ms,
            });
            markDone();
          }, ms),
        ),
    );
    return { done };
  }

  /** Drena microtasks + immediates para que el await del refund termine. */
  async function flush(): Promise<void> {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setImmediate(r));
    }
  }

  /**
   * BLQ-MED-1: el refund del débito HUÉRFANO ocurre dentro del middleware, que
   * sigue corriendo cuando `inject` ya volvió con el 504. `flush()` no alcanza
   * (la ventana la abre un `setTimeout` de verdad), así que se espera por la
   * CONDICIÓN. Si el fix se remueve, esto expira y el test se pone rojo con el
   * balance real en el mensaje.
   */
  async function waitFor(
    predicate: () => boolean,
    what: string,
    timeoutMs = 3000,
  ): Promise<void> {
    const started = Date.now();
    while (!predicate()) {
      if (Date.now() - started > timeoutMs) {
        throw new Error(
          `waitFor timeout: ${what} (balance=${budgetState.balance}, debits=${debitMock.mock.calls.length}, credits=${creditMock.mock.calls.length})`,
        );
      }
      await sleep(5);
    }
  }

  it('T-NOCHARGE-11: 504 mientras corre compose → se debita y se reembolsa (neto cero)', async () => {
    const balanceBefore = budgetState.balance;
    mockResolvePrice.mockResolvedValue(STEP0_PRICE);
    // compose tarda lo suficiente para que el timer de 1ms dispare el 504 antes.
    // `totalCostUsdc: 0` ⟹ nada se settleó → se reembolsa el step-0 entero.
    const { done } = composeAfter(60, 0);

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: { steps: [{ agent: 'kyc', input: {} }] },
    });

    expect(res.statusCode).toBe(504);
    await done;
    await flush();

    // El débito ocurrió y el credit-back lo revirtió: neto cero para el caller,
    // que recibió un timeout y ningún valor.
    expect(debitMock).toHaveBeenCalledTimes(1);
    expect(creditMock).toHaveBeenCalledTimes(1);
    expect(creditMock.mock.calls[0]?.[2]).toBe(STEP0_PRICE);
    expect(creditMock.mock.calls[0]?.[3]).toBe('o1'); // ownership guard
    expect(budgetState.balance).toBeCloseTo(balanceBefore, 8);
  });

  it('T-NOCHARGE-12: 504 con settle parcial NO reembolsa lo entregado', async () => {
    const balanceBefore = budgetState.balance;
    mockResolvePrice.mockResolvedValue(STEP0_PRICE);
    // El step-0 SÍ settleó antes del timeout.
    const { done } = composeAfter(60, STEP0_PRICE);

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: { steps: [{ agent: 'kyc', input: {} }] },
    });

    expect(res.statusCode).toBe(504);
    await done;
    await flush();

    expect(debitMock).toHaveBeenCalledTimes(1);
    // max(0, 0.5 - 0.5) = 0 → el trabajo entregado se sigue cobrando.
    expect(creditMock).not.toHaveBeenCalled();
    expect(budgetState.balance).toBeCloseTo(balanceBefore - STEP0_PRICE, 8);
  });

  // ── BLQ-MED-1: el 504 que dispara ANTES de que el handler exista ──
  //
  // Los dos tests de arriba cubren el 504 que dispara MIENTRAS compose corre —
  // ahí el route handler ya estaba en ejecución, así que su `if (reply.sent)`
  // podía reaccionar. La ventana que faltaba es la otra: cuando el timer manda
  // el 504 durante el débito (o durante el read del header que va justo después),
  // Fastify NO invoca el handler (`handle-request.js:132`), así que TODO
  // credit-back que viva en el handler es código inalcanzable y el caller queda
  // cobrado por un pipeline que jamás corrió. El AR lo midió: `debit=1 credit=0`,
  // balance 10 → 9.5.
  //
  // Estos dos tests assertan el BALANCE (antes/después), no el status.

  it('T-NOCHARGE-13 (BLQ-MED-1): 504 MIENTRAS se debita → el handler no corre y el débito se devuelve', async () => {
    const balanceBefore = budgetState.balance;
    mockResolvePrice.mockResolvedValue(STEP0_PRICE);
    // El RPC de débito tarda 40ms con TIMEOUT_COMPOSE_MS=1: el 504 sale mientras
    // el débito está en vuelo (repro AR-P3).
    budgetState.debitLatencyMs = 40;

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: { steps: [{ agent: 'kyc', input: {} }] },
    });

    expect(res.statusCode).toBe(504);

    await waitFor(
      () => creditMock.mock.calls.length > 0,
      'el credit-back del débito huérfano nunca ocurrió',
    );
    await flush();

    // El débito SÍ se aplicó (si no, el test sería vacuo)...
    expect(debitMock).toHaveBeenCalledTimes(1);
    expect(debitMock.mock.calls[0]?.[2]).toBe(STEP0_PRICE);
    // ...el route handler NUNCA corrió (esto es lo que hacía inalcanzable el
    // credit-back anterior)...
    expect(mockCompose).not.toHaveBeenCalled();
    // ...y aun así el caller termina con su plata intacta.
    expect(creditMock).toHaveBeenCalledTimes(1);
    expect(creditMock.mock.calls[0]?.[2]).toBe(STEP0_PRICE);
    expect(creditMock.mock.calls[0]?.[3]).toBe('o1'); // ownership guard
    expect(budgetState.balance).toBeCloseTo(balanceBefore, 8);
  });

  it('T-NOCHARGE-14 (BLQ-MED-1): 504 en el read del header POST-débito → mismo credit-back', async () => {
    const balanceBefore = budgetState.balance;
    mockResolvePrice.mockResolvedValue(STEP0_PRICE);
    // Débito instantáneo, pero el `getBalance` del header
    // `x-a2a-remaining-budget` (post-débito) tarda 40ms → el 504 sale con el
    // débito YA aplicado (repro AR-P2). Segunda ventana, mismo dueño del fix.
    budgetState.getBalanceLatencyMs = 40;

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: { steps: [{ agent: 'kyc', input: {} }] },
    });

    expect(res.statusCode).toBe(504);

    await waitFor(
      () => creditMock.mock.calls.length > 0,
      'el credit-back del débito huérfano nunca ocurrió (ventana del header)',
    );
    await flush();

    expect(debitMock).toHaveBeenCalledTimes(1);
    expect(mockCompose).not.toHaveBeenCalled();
    expect(creditMock).toHaveBeenCalledTimes(1);
    expect(creditMock.mock.calls[0]?.[2]).toBe(STEP0_PRICE);
    expect(creditMock.mock.calls[0]?.[3]).toBe('o1');
    expect(budgetState.balance).toBeCloseTo(balanceBefore, 8);
  });

  it('T-NOCHARGE-15 (BLQ-MED-1, anti-doble-refund): 504 pre-débito NO acredita nada', async () => {
    // Contra-prueba del riesgo espejo: un refund que corra "por si acaso" en un
    // hook de respuesta inflaría el budget cuando NUNCA se debitó. Acá el 504
    // sale durante el preHandler de precio (antes del middleware de pago), así
    // que Fastify saltea el middleware entero: ni débito ni credit.
    // El AR ya había refutado la fila del mapa que decía que este caso cobraba.
    mockResolvePrice.mockImplementation(async () => {
      await sleep(40);
      return STEP0_PRICE;
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: { steps: [{ agent: 'kyc', input: {} }] },
    });

    expect(res.statusCode).toBe(504);
    await flush();
    await sleep(60);
    await flush();

    expect(debitMock).not.toHaveBeenCalled();
    expect(creditMock).not.toHaveBeenCalled();
    expect(budgetState.balance).toBe(10);
  });
});
