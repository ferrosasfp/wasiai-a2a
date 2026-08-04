/**
 * POST /gasless/transfer — el CHALLENGE que ve el caller x402.
 *
 * POR QUÉ ESTE ARCHIVO EXISTE. La rama x402 de `/gasless/transfer` no la
 * ejercitaba NINGÚN test: `gasless.test.ts` y `gasless.refund.test.ts` entran
 * siempre con `x-a2a-key`. Esa rama existe igual — la ruta es pública
 * (`doc/INTEGRATION.md`) y `requirePaymentOrA2AKey` delega en `requirePayment`
 * cuando no hay credencial (`middleware/a2a-key.ts:1624-1628`).
 *
 * LO QUE ESTABA MAL. `gaslessCostEstimatorPreHandler` calculaba el valor USD real
 * del transfer y lo dejaba SÓLO en `request.gaslessEstimatedCostUsd`, que lo lee
 * únicamente el débito prepago (`lib/step0-debit.ts`). El challenge x402 se arma
 * con `request.x402ChallengeAmountUsd` (`middleware/x402.ts:396-399`), que esta
 * ruta nunca seteaba ⟹ caía al default plano de 1 USD
 * (`middleware/x402.ts:285`). Con el cap por defecto en 10 USD
 * (`lib/price.ts:58`), el caller x402 pagaba 1 y el operador giraba hasta 10.
 *
 * Es la MISMA cuenta que WKH-59 cerró para la agent key (ver la cabecera de
 * `routes/gasless.ts`: "el middleware debitaba placeholder $1 ignorando el valor
 * real on-chain → drain del operator wallet"), dejada abierta en el otro riel; y
 * es literalmente el escenario que `routes/compose.ts:449-460` describe como el
 * motivo por el que compose tuvo que inyectar el monto real ("the x402 path has
 * no inbound refund … → gateway loss + undercharge").
 *
 * LOS DOS CANDADOS, en direcciones opuestas:
 *   T-X402-CH-1  el challenge NO puede quedar por DEBAJO del valor girado (drain)
 *   T-X402-CH-2  el challenge NO puede quedar por ENCIMA (el caller x402 no tiene
 *                reembolso: `lib/step0-refund.ts:12-15`, cada centavo de más es
 *                definitivo)
 *
 * Y los que fijan que el arreglo no se derrame:
 *   T-X402-CH-3  rechazo pre-cobro (cap) → `quote()` NUNCA se llama
 *   T-X402-CH-4  rechazo pre-cobro (forma) → `quote()` NUNCA se llama
 *   T-X402-CH-5  riel prepago → el challenge no participa; el débito sigue igual
 */

import crypto from 'node:crypto';
import Fastify, { type FastifyBaseLogger } from 'fastify';
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

const OWNER_REF = 'user-1';

const { budgetMock, enqueueRefundMock } = vi.hoisted(() => ({
  budgetMock: {
    getBalance: vi.fn(),
    debit: vi.fn(),
    registerDeposit: vi.fn(),
    credit: vi.fn(),
    creditWithDest: vi.fn(),
    creditDelegation: vi.fn(),
    creditSession: vi.fn(),
  },
  enqueueRefundMock: vi.fn(),
}));

vi.mock('../services/budget.js', () => ({ budgetService: budgetMock }));

vi.mock('../services/refund-outbox.js', () => ({
  refundOutbox: {
    enqueueRefund: enqueueRefundMock,
    processRefundOutbox: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../services/identity.js', () => ({
  identityService: {
    createKey: vi.fn(),
    lookupByHash: vi.fn(),
    deactivate: vi.fn(),
  },
  isIdentityVerified: (row: { erc8004_identity?: unknown } | null) =>
    row?.erc8004_identity != null,
}));

vi.mock('../services/delegation.js', () => ({
  delegationService: {
    lookupByTokenHash: vi.fn(),
    getParentKey: vi.fn(),
    debitDelegationAndParent: vi.fn(),
  },
  exceedsPerTxLimit: vi.fn(() => false),
}));

vi.mock('../services/key-session.js', () => ({
  keySessionService: {
    lookupByTokenHash: vi.fn(),
    getParentKey: vi.fn(),
    debitSessionAndParent: vi.fn(),
  },
}));

vi.mock('../services/signed-auth.js', () => ({ verifySignedAuth: vi.fn() }));

vi.mock('../services/receipt.js', () => ({
  receiptService: { emit: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../services/event.js', () => ({
  eventService: { track: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../services/x402-nonce.js', () => ({
  checkAndRecordX402Nonce: vi.fn().mockResolvedValue({ kind: 'fresh' }),
}));

vi.mock('../adapters/settle-verifier.js', () => ({
  verifySettledTx: vi.fn().mockResolvedValue({ ok: true, warn: false }),
  rpcUnavailableResult: vi.fn(() => ({
    ok: true,
    warn: true,
    reason: 'RPC_UNAVAILABLE',
  })),
}));

const mockGaslessTransfer = vi.fn();
const mockGaslessStatus = vi.fn();
const mockVerify = vi.fn(async () => ({ valid: true }));
const mockSettle = vi.fn(async () => ({ success: true, txHash: '0xsettled' }));
/**
 * `quote(usd)` devuelve las unidades atómicas a 6 decimales. Es el ÚNICO
 * observable que dice cuánto se le está pidiendo al caller x402: lo que este mock
 * reciba es lo que termina en `accepts[0].maxAmountRequired` del 402.
 */
const mockQuote = vi.fn(async (usd: number) => ({
  amountWei: String(Math.round(usd * 1e6)),
  token: {
    symbol: 'PYUSD',
    address: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    decimals: 6,
  },
  facilitatorUrl: 'http://mock',
}));

vi.mock('../adapters/registry.js', () => {
  const bundle = {
    chainConfig: {
      name: 'eip155:2368',
      chainId: 2368,
      explorerUrl: 'https://explorer.test',
    },
    payment: {
      vmFamily: 'evm' as const,
      supportedTokens: [
        {
          symbol: 'PYUSD',
          address:
            '0x0000000000000000000000000000000000000000' as `0x${string}`,
          decimals: 6,
        },
      ],
    },
  };
  return {
    getGaslessAdapter: vi.fn(() => ({
      status: mockGaslessStatus,
      transfer: mockGaslessTransfer,
    })),
    getPaymentAdapter: vi.fn(() => ({
      name: 'mock',
      chainId: 2368,
      supportedTokens: [],
      getScheme: () => 'exact',
      getNetwork: () => 'eip155:2368',
      getToken: () => '0x0000000000000000000000000000000000000000' as const,
      getMaxTimeoutSeconds: () => 60,
      getMerchantName: () => 'WasiAI Test',
      settle: mockSettle,
      verify: mockVerify,
      quote: mockQuote,
      sign: vi.fn(),
    })),
    getChainConfig: vi.fn(() => bundle.chainConfig),
    getAttestationAdapter: vi.fn(),
    getIdentityBindingAdapter: vi.fn(),
    initAdapters: vi.fn(),
    _resetRegistry: vi.fn(),
    getAdaptersBundle: vi.fn(() => bundle),
    getInitializedChainKeys: vi.fn(() => ['kite-ozone-testnet']),
    getDefaultChainKey: vi.fn(() => 'kite-ozone-testnet'),
    acceptsInboundPayment: vi.fn(() => true),
    getInboundPaymentChainKeys: vi.fn(() => ['kite-ozone-testnet']),
  };
});

import { GaslessTransferError } from '../adapters/errors.js';
import { budgetService } from '../services/budget.js';
import { identityService } from '../services/identity.js';
import gaslessRoutes from './gasless.js';

const mockLookupByHash = vi.mocked(identityService.lookupByHash);
const mockDebit = vi.mocked(budgetService.debit);

const TEST_KEY = `wasi_a2a_${'a'.repeat(64)}`;
const TEST_KEY_HASH = crypto
  .createHash('sha256')
  .update(TEST_KEY)
  .digest('hex');
const TEST_KEY_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TEST_TO = '0x1234567890123456789012345678901234567890';

/** $5 en unidades de 6 decimales (PYUSD_USD_RATE = 1). */
const VALUE_WEI = '5000000';
const VALUE_USD = 5;
/** Lo que el default plano de `middleware/x402.ts` advertiría: 1 USD. */
const FLAT_DEFAULT_ATOMIC = '1000000';

function makeKeyRow(): A2AAgentKeyRow {
  return {
    id: TEST_KEY_ID,
    owner_ref: OWNER_REF,
    key_hash: TEST_KEY_HASH,
    display_name: 'Test Key',
    budget: { '2368': '100.000000' },
    daily_limit_usd: null,
    daily_spent_usd: '0.000000',
    daily_reset_at: new Date(Date.now() + 86400000).toISOString(),
    allowed_registries: null,
    allowed_agent_slugs: null,
    allowed_categories: null,
    max_spend_per_call_usd: null,
    is_active: true,
    last_used_at: null,
    created_at: '2026-04-06T12:00:00.000Z',
    updated_at: '2026-04-06T12:00:00.000Z',
    erc8004_identity: null,
    kite_passport: null,
    agentkit_wallet: null,
    funding_wallet: null,
    metadata: {},
    require_signature: false,
  };
}

interface ChallengeBody {
  accepts: { maxAmountRequired: string }[];
}

describe('POST /gasless/transfer — challenge x402 (riel sin reembolso)', () => {
  let app: ReturnType<typeof Fastify>;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of [
      'GASLESS_DEFAULT_CAP_USD',
      'PYUSD_USD_RATE',
      'PAYMENT_WALLET_ADDRESS',
    ]) {
      saved[k] = process.env[k];
    }
    process.env.GASLESS_DEFAULT_CAP_USD = '10';
    process.env.PYUSD_USD_RATE = '1.0';
    process.env.PAYMENT_WALLET_ADDRESS =
      '0x000000000000000000000000000000000000dEaD';

    app = Fastify();
    await app.register(gaslessRoutes, { prefix: '/gasless' });
    await app.ready();
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await app.close();
  });

  beforeEach(() => {
    mockGaslessStatus.mockResolvedValue({ funding_state: 'ready' });
    mockGaslessTransfer.mockResolvedValue({ txHash: '0xdead' });
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockDebit.mockResolvedValue({ success: true });
    budgetMock.getBalance.mockResolvedValue('95.000000');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  /**
   * CANDADO 1 — NO cobrar de MENOS.
   *
   * El caller x402 pide girar $5 desde la wallet del operador. Si el challenge
   * advertisa 1 USD, el gateway entrega 5 y cobra 1: pérdida de 4 por llamada,
   * repetible, hasta el cap. `not.toBe(FLAT_DEFAULT_ATOMIC)` es lo que muere si
   * alguien saca la inyección.
   */
  it('T-X402-CH-1: transfer de $5 sin agent key → el 402 pide $5, no el plano de $1', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/gasless/transfer',
      payload: { to: TEST_TO, value: VALUE_WEI },
    });

    expect(res.statusCode).toBe(402);
    expect(mockQuote).toHaveBeenCalledWith(VALUE_USD);
    const body = res.json() as ChallengeBody;
    expect(body.accepts[0]?.maxAmountRequired).toBe('5000000');
    expect(body.accepts[0]?.maxAmountRequired).not.toBe(FLAT_DEFAULT_ATOMIC);
    // Y nada se giró: el 402 corta antes del handler.
    expect(mockGaslessTransfer).not.toHaveBeenCalled();
  });

  /**
   * CANDADO 2 — NO cobrar de MÁS. Es el opuesto exacto del anterior y el que
   * importa más, porque en este riel el error no se puede deshacer: el pago
   * entrante es un settle on-chain y no hay saldo interno que acreditar
   * (`lib/step0-refund.ts:12-15`, `doc/INTEGRATION.md` §5.1). Un challenge
   * inflado es plata del caller que no vuelve nunca.
   *
   * Se prueba con un transfer BARATO ($0.02), donde el default plano de $1 ya
   * era un cobro 50x, y se asierta IGUALDAD (no `<=`): cualquier margen que
   * alguien agregue "por las dudas" tiene que romper este test.
   */
  it('T-X402-CH-2: transfer de $0.02 → el 402 pide exactamente $0.02 (sin margen)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/gasless/transfer',
      payload: { to: TEST_TO, value: '20000' },
    });

    expect(res.statusCode).toBe(402);
    expect(mockQuote).toHaveBeenCalledTimes(1);
    expect(mockQuote).toHaveBeenCalledWith(0.02);
    const body = res.json() as ChallengeBody;
    expect(body.accepts[0]?.maxAmountRequired).toBe('20000');
  });

  /**
   * El rechazo por cap es PRE-cobro: pasa en el estimador, antes de
   * `requirePaymentOrA2AKey`. `quote()` sin llamar prueba que ni siquiera se
   * emitió un challenge — el caller no firma nada por un pedido condenado.
   */
  it('T-X402-CH-3: monto sobre el cap → 403 PER_CALL_LIMIT y quote() nunca se llama', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/gasless/transfer',
      payload: { to: TEST_TO, value: '50000000' }, // $50 > cap $10
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error_code: 'PER_CALL_LIMIT' });
    expect(mockQuote).not.toHaveBeenCalled();
    expect(mockGaslessTransfer).not.toHaveBeenCalled();
  });

  it('T-X402-CH-4: body sin `value` → 400 y quote() nunca se llama', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/gasless/transfer',
      payload: { to: TEST_TO },
    });

    expect(res.statusCode).toBe(400);
    expect(mockQuote).not.toHaveBeenCalled();
  });

  /**
   * NO REGRESIÓN del otro riel: con `x-a2a-key`, `requirePaymentOrA2AKey` no
   * delega en `requirePayment` (a2a-key.ts:1624-1628), así que el challenge no
   * se arma y el débito sigue siendo el valor real del transfer, como antes.
   */
  it('T-X402-CH-5: con agent key el challenge no participa — debita $5 y transfiere', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/gasless/transfer',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: { to: TEST_TO, value: VALUE_WEI },
    });

    expect(res.statusCode).toBe(200);
    expect(mockQuote).not.toHaveBeenCalled();
    // Firma real de `budgetService.debit` (budget.ts:129-150): el owner_ref del
    // caller autenticado va último (ownership guard, CLAUDE.md).
    expect(mockDebit).toHaveBeenCalledWith(
      TEST_KEY_ID,
      2368,
      VALUE_USD,
      undefined,
      undefined,
      undefined,
      OWNER_REF,
    );
    expect(mockGaslessTransfer).toHaveBeenCalledTimes(1);
  });
});

/**
 * SEGUNDA MITAD — el caller x402 YA PAGÓ (settle inbound OK) y ahora el handler
 * decide su suerte. Es la rama que ningún test recorría hasta el final.
 *
 * QUÉ SE FIJA ACÁ, y por qué NO es un reembolso. En este riel el reembolso no
 * existe y NO se puede fabricar con lo que hay: el cobro entrante es un settle
 * on-chain contra la wallet del caller, que no tiene saldo interno con nosotros.
 * `lib/step0-refund.ts:12-15` lo dice explícito ("no se inventa un refund
 * on-chain") y `doc/INTEGRATION.md` §5.1 ya lo publica en el contrato, nombrando
 * a `POST /gasless/transfer`. El mecanismo que sí existe —
 * `refundGaslessDebit` — es un CRÉDITO DE BUDGET y está gateado en
 * `request.a2aKeyRow` (`routes/gasless.ts`), o sea que para este caller es un
 * no-op por construcción.
 *
 * Entonces lo que estos tests cierran es el riesgo OPUESTO: que alguien lea
 * "x402 no reembolsa" como un bug y cablee el crédito igual. Un credit sin
 * `a2aKeyRow` no le devolvería nada al caller x402 (no tiene ledger) — le
 * acreditaría a OTRO, o dejaría una fila de outbox con un keyId basura. Cada
 * `not.toHaveBeenCalled()` de acá abajo es ese candado.
 *
 * Los tres desenlaces, explícitos:
 *   T-X402-EXEC-1  transfer OK          → 200, cero maquinaria de refund
 *   T-X402-EXEC-2  falla PROBADA        → 500, sin crédito y sin outbox
 *   T-X402-EXEC-3  503 not-operational  → sin crédito y sin outbox
 *   T-X402-EXEC-4  INDETERMINADO        → sin crédito, PERO con la señal de
 *                                         reconciliación (no se publica como
 *                                         "no se pagó")
 */
describe('POST /gasless/transfer — el caller x402 ya pagó y el handler falla', () => {
  let app: ReturnType<typeof Fastify>;
  const saved: Record<string, string | undefined> = {};
  /** Líneas de `log.error` del request, para poder afirmar la señal de reconciliación. */
  let errorLogs: Record<string, unknown>[];

  const PAY_TO = '0x000000000000000000000000000000000000dEaD';

  /** Header `x-payment` que satisface binding + verify + nonce + settle. */
  function xPaymentHeader(valueAtomic: string): string {
    return Buffer.from(
      JSON.stringify({
        authorization: {
          to: PAY_TO,
          value: valueAtomic,
          nonce: `0x${'11'.repeat(32)}`,
        },
        signature: `0x${'22'.repeat(65)}`,
        network: 'eip155:2368',
      }),
    ).toString('base64');
  }

  async function payAndTransfer(): Promise<ReturnType<typeof app.inject>> {
    return app.inject({
      method: 'POST',
      url: '/gasless/transfer',
      // Sin `x-a2a-key`: riel x402 puro.
      headers: { 'x-payment': xPaymentHeader(VALUE_WEI) },
      payload: { to: TEST_TO, value: VALUE_WEI },
    });
  }

  beforeAll(async () => {
    for (const k of [
      'GASLESS_DEFAULT_CAP_USD',
      'PYUSD_USD_RATE',
      'PAYMENT_WALLET_ADDRESS',
    ]) {
      saved[k] = process.env[k];
    }
    process.env.GASLESS_DEFAULT_CAP_USD = '10';
    process.env.PYUSD_USD_RATE = '1.0';
    process.env.PAYMENT_WALLET_ADDRESS = PAY_TO;

    errorLogs = [];
    const noop = (): void => {};
    const capture: FastifyBaseLogger = {
      level: 'error',
      fatal: noop,
      error: (obj: unknown) => {
        if (obj && typeof obj === 'object') {
          errorLogs.push(obj as Record<string, unknown>);
        }
      },
      warn: noop,
      info: noop,
      debug: noop,
      trace: noop,
      silent: noop,
      child: () => capture,
    } as unknown as FastifyBaseLogger;
    app = Fastify({ loggerInstance: capture });
    await app.register(gaslessRoutes, { prefix: '/gasless' });
    await app.ready();
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await app.close();
  });

  beforeEach(() => {
    errorLogs = [];
    mockGaslessStatus.mockResolvedValue({ funding_state: 'ready' });
    mockGaslessTransfer.mockResolvedValue({ txHash: '0xdead' });
    mockVerify.mockResolvedValue({ valid: true });
    mockSettle.mockResolvedValue({ success: true, txHash: '0xsettled' });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  /** Ningún camino de crédito, en ninguna de sus 4 variantes, ni el outbox. */
  function expectNoRefundMachinery(): void {
    expect(budgetMock.credit).not.toHaveBeenCalled();
    expect(budgetMock.creditWithDest).not.toHaveBeenCalled();
    expect(budgetMock.creditDelegation).not.toHaveBeenCalled();
    expect(budgetMock.creditSession).not.toHaveBeenCalled();
    expect(enqueueRefundMock).not.toHaveBeenCalled();
  }

  /**
   * EL CANDADO MÁS IMPORTANTE. El transfer SALIÓ: el caller recibió exactamente
   * lo que pagó. Cualquier crédito acá es pagar dos veces.
   */
  it('T-X402-EXEC-1: el transfer tiene ÉXITO → 200 y NO se reembolsa nada', async () => {
    const res = await payAndTransfer();

    expect(res.statusCode).toBe(200);
    expect(mockSettle).toHaveBeenCalledTimes(1);
    expect(mockGaslessTransfer).toHaveBeenCalledTimes(1);
    // Y el débito prepago tampoco corrió: este caller no tiene budget.
    expect(mockDebit).not.toHaveBeenCalled();
    expectNoRefundMachinery();
  });

  /**
   * Falla PROBADA (`not-moved`): el valor quedó quieto. En el riel prepago esto
   * dispara el crédito (`gasless.refund.test.ts` T-192-2). Acá NO hay nada que
   * acreditar — y lo que se fija es que no se intente igual contra un ledger que
   * no es del caller. El residuo está publicado en `doc/INTEGRATION.md` §5.1.
   */
  it('T-X402-EXEC-2: falla PROBADA (not-moved) → 500, y no hay crédito ni fila de outbox', async () => {
    mockGaslessTransfer.mockRejectedValue(
      new GaslessTransferError(
        'kite-testnet',
        'sign failed: no operator key',
        'not-moved',
      ),
    );

    const res = await payAndTransfer();

    expect(res.statusCode).toBe(500);
    expect(mockSettle).toHaveBeenCalledTimes(1); // el caller SÍ pagó
    expectNoRefundMachinery();
  });

  it('T-X402-EXEC-3: 503 gasless_not_operational → tampoco hay crédito ni outbox', async () => {
    mockGaslessStatus.mockResolvedValue({ funding_state: 'unfunded' });

    const res = await payAndTransfer();

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('gasless_not_operational');
    expect(mockGaslessTransfer).not.toHaveBeenCalled();
    expectNoRefundMachinery();
  });

  /**
   * INDETERMINADO (`unknown`): la tx pudo haber aterrizado. Acá el desenlace es
   * el MISMO que en los otros dos —no hay reembolso posible— pero el motivo es
   * distinto y no puede quedar mudo: se exige la señal de reconciliación
   * (`gasless.refund-skipped.settlement-unknown`), la misma que el riel prepago.
   * Es la regla de este repo: "no pude comprobarlo" nunca se publica como "no se
   * pagó", y nunca muere sin dejar dónde mirarlo.
   */
  it('T-X402-EXEC-4: INDETERMINADO (unknown) → sin crédito, PERO con señal de reconciliación', async () => {
    mockGaslessTransfer.mockRejectedValue(
      new GaslessTransferError(
        'kite-testnet',
        'broadcast sent, receipt timed out',
        'unknown',
      ),
    );

    const res = await payAndTransfer();

    expect(res.statusCode).toBe(500);
    expectNoRefundMachinery();
    // El caso ambiguo deja rastro: se nombra la disposición, no se lo archiva
    // como un fallo cualquiera.
    expect(errorLogs.some((l) => l.valueDisposition === 'unknown')).toBe(true);
  });
});
