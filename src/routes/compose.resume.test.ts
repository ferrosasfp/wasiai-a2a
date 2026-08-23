/**
 * `POST /compose/resume` — la reanudación de un pipeline suspendido (WKH-225).
 *
 * QUÉ MIDE ESTA CAPA, Y QUÉ NO. Acá el `composeService` y el
 * `suspendedRunService` son dobles: lo que se afirma es lo que el ROUTE decide
 * —el orden de los guards, el mapeo a HTTP, qué le pasa al pipeline y con qué
 * clave se cobra el fee—, no lo que hacen la base ni el pipeline. Los otros dos
 * extremos del cable viven en:
 *
 *   · `src/services/suspended-run.test.ts` — la máquina de estados y que el
 *     residuo del vencimiento se emita EXACTAMENTE UNA vez (`T-RUN-9`);
 *   · `test/wkh225-suspended-runs.migration.test.ts` — que la base levante esos
 *     errores, en ese orden, con ese literal;
 *   · `src/services/compose.suspend.test.ts` — que la traza restaurada tenga
 *     EFECTO sobre el guard anti-bucle (`T-RES-10`, `T-RES-11`).
 *
 * Ninguno solo alcanza, y decirlo es parte del control.
 *
 * Naming: T-RES-1..T-RES-12.
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
import type { A2AAgentKeyRow, ComposeResult } from '../types/index.js';

const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({ getLogger: () => logSpy }));

let nextKeyRow: Partial<A2AAgentKeyRow> | undefined;

// ⚠️ Sólo se reemplaza la AUTENTICACIÓN. `extractRawKey`, `resolveResumeCaller`
// y el resto entran REALES por `importOriginal`: un mock que re-implementara la
// resolución del caller sería un guard comparándose consigo mismo.
vi.mock('../middleware/a2a-key.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../middleware/a2a-key.js')>()),
  requireA2AKey: () => [
    async (request: FastifyRequest, _reply: FastifyReply) => {
      (request as unknown as { a2aKeyRow: unknown }).a2aKeyRow = nextKeyRow;
    },
  ],
  requirePaymentOrA2AKey: () => [
    async (request: FastifyRequest, _reply: FastifyReply) => {
      (request as unknown as { a2aKeyRow: unknown }).a2aKeyRow = nextKeyRow;
    },
  ],
}));
vi.mock('../middleware/timeout.js', () => ({
  createTimeoutHandler:
    () => async (_request: FastifyRequest, _reply: FastifyReply) => {
      /* no-op */
    },
}));
vi.mock('../middleware/rate-limit.js', () => ({
  orchestrateRateLimit: () => false,
}));
vi.mock('../services/compose.js', () => ({
  composeService: { compose: vi.fn() },
}));
vi.mock('../services/agent-price.js', () => ({
  resolveAgentPriceUsdc: vi.fn(),
  resolveAgentDestination: vi.fn(),
}));
vi.mock('../services/budget.js', () => ({
  budgetService: {
    // Fix-pack AR/BLQ-ALTO-2: el `debit` entra al doble porque ahora esta ruta
    // SÍ debita el primer step del tramo restante. Antes no existía acá, y por
    // eso ningún test de este archivo podía notar que no se llamaba.
    debit: vi.fn().mockResolvedValue({ success: true }),
    credit: vi.fn().mockResolvedValue({ success: true }),
    creditWithDest: vi.fn().mockResolvedValue({ success: true }),
    creditDelegation: vi.fn().mockResolvedValue({ success: true }),
    creditSession: vi.fn().mockResolvedValue({ success: true }),
  },
}));
vi.mock('../lib/gas-overhead.js', () => ({
  getStepGasOverheadUsd: vi.fn(async () => 0),
}));
vi.mock('../services/refund-outbox.js', () => ({
  refundOutbox: { enqueueRefund: vi.fn(async () => undefined) },
}));
vi.mock('../services/fee-charge.js', () => ({
  chargeProtocolFee: vi.fn(),
  getProtocolFeeRate: () => 0.01,
}));
vi.mock('../services/suspended-run.js', () => ({
  suspendedRunService: { claim: vi.fn(), settle: vi.fn() },
}));
// El módulo real de supabase, para poder afirmar que NO se lo toca (AC-4).
vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

import {
  RESUME_ENV_VAR,
  resumeTokenHash,
  signResumeToken,
} from '../lib/resume-token.js';
import { supabase } from '../lib/supabase.js';
import {
  resolveAgentDestination,
  resolveAgentPriceUsdc,
} from '../services/agent-price.js';
import { budgetService } from '../services/budget.js';
import { composeService } from '../services/compose.js';
import { chargeProtocolFee } from '../services/fee-charge.js';
import { suspendedRunService } from '../services/suspended-run.js';
import composeRoutes from './compose.js';

const mockCompose = vi.mocked(composeService.compose);
const mockClaim = vi.mocked(suspendedRunService.claim);
const mockSettle = vi.mocked(suspendedRunService.settle);
const mockFee = vi.mocked(chargeProtocolFee);
const mockFrom = vi.mocked(supabase.from);
const mockRpc = vi.mocked(supabase.rpc);
const mockDebit = vi.mocked(budgetService.debit);
const mockCredit = vi.mocked(budgetService.creditWithDest);
const mockPrice = vi.mocked(resolveAgentPriceUsdc);
const mockDest = vi.mocked(resolveAgentDestination);

const OWNER = 'owner-a';
const KEY_ID = 'key-1';
const RUN_ID = '11111111-1111-1111-1111-111111111111';
const COMPOSE_RUN_ID = '22222222-2222-2222-2222-222222222222';

const PASO_HECHO = {
  agent: { slug: 'kyc', registry: 'wasiai' },
  output: { a2a_suspend: true },
  costUsdc: 1.25,
  latencyMs: 30,
  downstreamTxHash: '0xPAID0',
};
const PASO_NUEVO = {
  agent: { slug: 'payout', registry: 'wasiai' },
  output: { ok: true },
  costUsdc: 2,
  latencyMs: 40,
};

function claimRow(over: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    owner_ref: OWNER,
    key_id: KEY_ID,
    caller_kind: 'key' as const,
    caller_id: KEY_ID,
    compose_run_id: COMPOSE_RUN_ID,
    step_index: 0,
    steps_json: [PASO_HECHO],
    last_output: { a2a_suspend: true },
    remaining_steps: [{ agent: 'payout', input: {} }],
    frozen_step_prices: null,
    total_cost_usdc: '1.25000000',
    max_budget_usdc: null,
    total_latency_ms: 30,
    contracting_chain: ['gw-a', 'gw-b', 'gw-c', 'gw-d'],
    contracting_depth: 4,
    self_host_hint: 'a2a.wasiai.io',
    chain_id: 2368,
    ...over,
  };
}

function okResult(over: Partial<ComposeResult> = {}): ComposeResult {
  return {
    success: true,
    output: { ok: true },
    steps: [PASO_NUEVO] as unknown as ComposeResult['steps'],
    totalCostUsdc: 2,
    totalLatencyMs: 40,
    ...over,
  };
}

let app: ReturnType<typeof Fastify>;
let savedSecret: string | undefined;

beforeAll(async () => {
  app = Fastify();
  await app.register(composeRoutes, { prefix: '/compose' });
  await app.ready();
});
afterAll(() => app.close());

beforeEach(() => {
  vi.clearAllMocks();
  savedSecret = process.env[RESUME_ENV_VAR];
  process.env[RESUME_ENV_VAR] = 'secreto-de-test';
  nextKeyRow = { id: KEY_ID, owner_ref: OWNER };
  // El catálogo del step restante, para el débito del "step 0" del tramo.
  mockPrice.mockResolvedValue(2);
  mockDest.mockResolvedValue({
    registry: 'wasiai',
    slug: 'payout',
    invokeUrl: 'https://agents.example/payout',
  } as never);
  mockDebit.mockResolvedValue({ success: true });
  // Default explícito: `vi.clearAllMocks()` borra las LLAMADAS pero no las
  // implementaciones, así que sin esto un `mockResolvedValue` de un test se
  // filtraba al siguiente y el orden de los casos decidía el resultado.
  mockClaim.mockResolvedValue({ ok: true, run: claimRow() as never });
  mockCompose.mockResolvedValue(okResult());
  mockSettle.mockResolvedValue({ ok: true });
  mockFee.mockResolvedValue({
    status: 'charged',
    feeUsdc: 0.0325,
  } as never);
});

afterEach(() => {
  // El secreto se restaura de verdad: un test que lo deja puesto le cambia el
  // entorno al siguiente archivo del mismo worker.
  if (savedSecret === undefined) delete process.env[RESUME_ENV_VAR];
  else process.env[RESUME_ENV_VAR] = savedSecret;
});

function mint(over: { runId?: string; ttlSeconds?: number } = {}): string {
  const signed = signResumeToken({
    runId: over.runId ?? RUN_ID,
    caller: { kind: 'key', id: KEY_ID },
    ttlSeconds: over.ttlSeconds ?? 3600,
  });
  return (signed as { token: string }).token;
}

function resume(token: unknown) {
  return app.inject({
    method: 'POST',
    url: '/compose/resume',
    headers: { 'x-a2a-key': 'wasi_a2a_test' },
    payload: { token },
  });
}

// ─── AC-4 · la firma antes que la base ────────────────────────────────────

describe('AC-4 · el orden: firma, después payload, después base', () => {
  it('T-RES-12: una firma inválida da 400 y NO toca la base', async () => {
    const token = mint();
    const roto = `${token.slice(0, -2)}zz`;

    const res = await resume(roto);

    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('RESUME_INVALID');
    // 🔴 El orden ES el criterio de aceptación. Sin esto sólo se probaría el
    // código de error, que sigue siendo el mismo con el orden invertido.
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it('un body sin token, o con token que no es string, da 400 sin tocar nada', async () => {
    for (const malo of [undefined, '', 42, {}, null]) {
      vi.clearAllMocks();
      const res = await resume(malo);
      expect(res.statusCode).toBe(400);
      expect(res.json().error_code).toBe('RESUME_INVALID');
      expect(mockClaim).not.toHaveBeenCalled();
    }
  });

  it('un token de OTRO caller no verifica, y tampoco toca la base', async () => {
    const ajeno = signResumeToken({
      runId: RUN_ID,
      caller: { kind: 'key', id: 'key-de-otro' },
      ttlSeconds: 3600,
    });
    const res = await resume((ajeno as { token: string }).token);
    expect(res.statusCode).toBe(400);
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it('sin secreto configurado, ningún resume se acepta (fail-closed)', async () => {
    const token = mint();
    delete process.env[RESUME_ENV_VAR];
    const res = await resume(token);
    expect(res.statusCode).toBe(400);
    expect(mockClaim).not.toHaveBeenCalled();
    process.env[RESUME_ENV_VAR] = 'secreto-de-test';
  });

  it('el claim busca por el HASH del token, nunca por el token', async () => {
    const token = mint();
    mockClaim.mockResolvedValue({ ok: true, run: claimRow() as never });
    await resume(token);
    expect(mockClaim).toHaveBeenCalledWith(resumeTokenHash(token), OWNER);
    expect(mockClaim.mock.calls[0]?.[0]).not.toBe(token);
  });
});

// ─── AC-5 / AC-6 / AC-7 · el mapeo de los desenlaces ──────────────────────

describe('los cuatro desenlaces del claim, y su HTTP', () => {
  it('T-RES-1 (AC-5): el segundo resume del mismo token da 409 RUN_ALREADY_USED', async () => {
    const token = mint();
    // El doble APLICA el status-gate: el primero consume, el segundo no.
    let usado = false;
    mockClaim.mockImplementation(async () => {
      if (usado) return { ok: false, reason: 'already_used' } as never;
      usado = true;
      return { ok: true, run: claimRow() } as never;
    });

    const primero = await resume(token);
    expect(primero.statusCode).toBe(200);

    const segundo = await resume(token);
    expect(segundo.statusCode).toBe(409);
    expect(segundo.json().error_code).toBe('RUN_ALREADY_USED');
  });

  it('T-RES-2 (AC-5): en el segundo intento el pipeline NO corre', async () => {
    mockClaim.mockResolvedValue({ ok: false, reason: 'already_used' } as never);
    const res = await resume(mint());
    expect(res.statusCode).toBe(409);
    expect(mockCompose).not.toHaveBeenCalled();
    expect(mockSettle).not.toHaveBeenCalled();
    expect(mockFee).not.toHaveBeenCalled();
  });

  it('T-RES-3 (AC-6): un dueño ajeno recibe un 404 BYTE-IDÉNTICO al de un run inexistente', async () => {
    // Los dos casos llegan acá como el MISMO `reason`, porque el RPC levanta el
    // mismo literal. Comparar el body ENTERO —y no el status— es lo que hace
    // falsable "disclosure-safe": un campo que apareciera en uno solo de los
    // dos le diría al atacante que el run existe.
    mockClaim.mockResolvedValue({ ok: false, reason: 'not_found' } as never);

    const ajeno = await resume(mint());
    const inexistente = await resume(mint({ runId: 'no-existe' }));

    expect(ajeno.statusCode).toBe(404);
    expect(inexistente.statusCode).toBe(404);
    const a = ajeno.json();
    const b = inexistente.json();
    delete a.requestId;
    delete b.requestId;
    expect(a).toEqual(b);
    expect(a).toEqual({ error_code: 'RUN_NOT_FOUND' });
    expect(JSON.stringify(a)).not.toContain('OWNERSHIP');
  });

  it('T-RES-4 (AC-7): un run vencido da 410 RUN_EXPIRED', async () => {
    mockClaim.mockResolvedValue({ ok: false, reason: 'expired' } as never);
    const res = await resume(mint());
    expect(res.statusCode).toBe(410);
    expect(res.json().error_code).toBe('RUN_EXPIRED');
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it('T-RES-4b: un token VENCIDO igual llega a la base — es ahí donde se marca `expired`', async () => {
    // ⚠️ El `exp` del token es un fast-fail, NO la autoridad. Cortar acá
    // ahorraría una consulta y perdería el único momento en que la fila puede
    // pasar a `expired` y dejar constancia del pago varado.
    const vencido = signResumeToken({
      runId: RUN_ID,
      caller: { kind: 'key', id: KEY_ID },
      ttlSeconds: 181,
      nowMs: Date.now() - 1_000_000,
    });
    mockClaim.mockResolvedValue({ ok: false, reason: 'expired' } as never);
    const res = await resume((vencido as { token: string }).token);
    expect(mockClaim).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(410);
  });

  it('una base caída da 503, no un 404 que mentiría "no existe"', async () => {
    mockClaim.mockResolvedValue({ ok: false, reason: 'unavailable' } as never);
    const res = await resume(mint());
    expect(res.statusCode).toBe(503);
    expect(res.json().error_code).toBe('RESUME_UNAVAILABLE');
  });

  it('ningún body de error lleva el token ni el artefacto (CD-8)', async () => {
    const token = mint();
    for (const reason of [
      'not_found',
      'expired',
      'already_used',
      'unavailable',
    ] as const) {
      mockClaim.mockResolvedValue({ ok: false, reason } as never);
      const res = await resume(token);
      expect(res.body).not.toContain(token);
      expect(res.body).not.toContain('kyc.proveedor');
    }
    // Y tampoco los logs.
    const logueado = JSON.stringify(logSpy.warn.mock.calls);
    expect(logueado).not.toContain(token);
  });
});

// ─── AC-8 · continuar desde el step siguiente ─────────────────────────────

describe('AC-8 · se ejecuta la COLA, y se devuelve el pipeline ENTERO', () => {
  beforeEach(() => {
    mockClaim.mockResolvedValue({ ok: true, run: claimRow() as never });
  });

  it('T-RES-8: al pipeline sólo le llegan los steps que faltan', async () => {
    await resume(mint());

    expect(mockCompose).toHaveBeenCalledTimes(1);
    const arg = mockCompose.mock.calls[0]?.[0];
    // Los steps 0..i ya se invocaron, se settlearon y se debitaron:
    // re-ejecutarlos sería cobrarlos dos veces.
    expect(arg?.steps).toEqual([{ agent: 'payout', input: {} }]);
    expect(arg?.chainId).toBe(2368);
    expect(arg?.scopingKeyRow?.id).toBe(KEY_ID);
  });

  it('T-RES-8b: la respuesta incluye los steps YA completados, no sólo la cola', async () => {
    const res = await resume(mint());

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // ⚠️ El ARRAY COMPLETO, no su `.length`: comparar el largo dejaría pasar
    // una lista con los steps equivocados.
    expect(body.steps).toEqual([PASO_HECHO, PASO_NUEVO]);
    // Y los agregados son la SUMA de las dos mitades.
    expect(body.totalCostUsdc).toBeCloseTo(1.25 + 2, 8);
    expect(body.totalLatencyMs).toBe(30 + 40);
    expect(body.runId).toBe(RUN_ID);
  });

  it('T-RES-9 (CD-17): la traza anti-bucle se RESTAURA de la fila, no se reinicia', async () => {
    await resume(mint());
    const arg = mockCompose.mock.calls[0]?.[0];
    // ⛔ Arrancar con `depth: 0` sería reiniciar el contador del guard a pedido
    // de quien reanuda. El efecto de estos tres campos se mide en
    // `compose.suspend.test.ts` (T-RES-10 / T-RES-11); acá se mide el cable.
    expect(arg?.contractingDepth).toBe(4);
    expect(arg?.contractingChain).toEqual(['gw-a', 'gw-b', 'gw-c', 'gw-d']);
    expect(arg?.selfHostHint).toBe('a2a.wasiai.io');
  });

  it('un run reanudado NO vuelve a autorizar la suspensión (límite del corte A)', async () => {
    await resume(mint());
    expect(mockCompose.mock.calls[0]?.[0]?.suspension).toBeUndefined();
  });

  it('la fila se cierra `resumed` al completar y `failed` al fallar', async () => {
    await resume(mint());
    expect(mockSettle).toHaveBeenCalledWith(RUN_ID, OWNER, 'resumed', null);

    vi.clearAllMocks();
    mockClaim.mockResolvedValue({ ok: true, run: claimRow() as never });
    mockSettle.mockResolvedValue({ ok: true });
    mockCompose.mockResolvedValue(
      okResult({ success: false, error: 'Step 0 failed: boom' }),
    );
    const res = await resume(mint());
    expect(res.statusCode).toBe(400);
    // ⛔ `failed`, NO `reopen`: acá ya corrieron débitos e invocaciones de los
    // steps restantes, y reabrir después de un débito ambiguo es ofrecer un
    // segundo cobro.
    expect(mockSettle).toHaveBeenCalledWith(
      RUN_ID,
      OWNER,
      'failed',
      'Step 0 failed: boom',
    );
  });
});

// ─── CD-18 · el fee, una sola vez en toda la vida del run ─────────────────

describe('CD-18 · el fee de protocolo', () => {
  beforeEach(() => {
    mockClaim.mockResolvedValue({ ok: true, run: claimRow() as never });
  });

  it('T-RES-FEE-1: la clave de idempotencia es `compose_run_id`, NUNCA el `request.id`', async () => {
    const res = await resume(mint());

    expect(mockFee).toHaveBeenCalledTimes(1);
    const params = mockFee.mock.calls[0]?.[0];
    // 🔴 ÉSTE es el testigo del doble cobro. El `request.id` del `/compose` que
    // suspendió y el de este POST son DISTINTOS: con cualquiera de los dos, un
    // run que se suspende y se reanuda pagaría el fee dos veces.
    expect(params?.orchestrationId).toBe(COMPOSE_RUN_ID);
    expect(params?.orchestrationId).not.toBe(res.json().requestId);
  });

  it('T-RES-FEE-2: la base es el total ACUMULADO, no el de esta mitad', async () => {
    await resume(mint());
    // El caller ejecutó UN pipeline, no dos.
    expect(mockFee.mock.calls[0]?.[0]?.feeBaseUsdc).toBeCloseTo(3.25, 8);
  });

  it('T-RES-FEE-3: si el pipeline falla, el fee NO se cobra', async () => {
    mockCompose.mockResolvedValue(okResult({ success: false, error: 'boom' }));
    const res = await resume(mint());
    expect(res.statusCode).toBe(400);
    expect(mockFee).not.toHaveBeenCalled();
  });

  it('T-RES-FEE-4: un fallo del cobro NUNCA rompe el 200 — queda `unknown`', async () => {
    // "No pude preguntar" ≠ "no pasó": la disposición es DESCONOCIDA y el monto
    // se OMITE en vez de reportarse como cero.
    mockFee.mockResolvedValue({ status: 'failed', error: 'x' } as never);
    const res = await resume(mint());
    expect(res.statusCode).toBe(200);
    expect(res.json().protocolFeeStatus).toBe('unknown');
    expect(res.json().protocolFeeUsdc).toBeUndefined();

    mockFee.mockRejectedValue(new Error('boom'));
    const res2 = await resume(mint());
    expect(res2.statusCode).toBe(200);
    expect(res2.json().protocolFeeStatus).toBe('unknown');
  });
});

// ─── El 202 del /compose que suspendió ────────────────────────────────────

describe('POST /compose · el 202 cuando el pipeline queda esperando', () => {
  function compose(payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload,
    });
  }

  it('T-RES-202: devuelve 202 con el sobre y el token, y NO cobra el fee', async () => {
    mockCompose.mockResolvedValue(
      okResult({
        steps: [PASO_HECHO] as unknown as ComposeResult['steps'],
        totalCostUsdc: 1.25,
        totalLatencyMs: 30,
        suspended: {
          runId: RUN_ID,
          step: 0,
          artifact: { a2a_suspend: true, kyc_url: 'https://kyc.test/s/1' },
          expiresAt: '2030-01-01T00:00:00.000Z',
          state: 'input-required',
        },
        resumeToken: 'v1.payload.firma',
      }),
    );

    const res = await compose({ steps: [{ agent: 'kyc', input: {} }] });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.suspended.state).toBe('input-required');
    expect(body.suspended.runId).toBe(RUN_ID);
    // ⛔ CD-21: el artefacto sale TAL CUAL.
    expect(body.suspended.artifact).toEqual({
      a2a_suspend: true,
      kyc_url: 'https://kyc.test/s/1',
    });
    expect(body.resumeToken).toBe('v1.payload.firma');
    // 🔴 CD-18: el fee NO se cobra en el 202. Ese bloque idempotiza por
    // `request.id`, y el POST /compose/resume llega con OTRO: se cobraría una
    // vez sobre el pipeline PARCIAL y otra al reanudar.
    expect(mockFee).not.toHaveBeenCalled();
  });

  it('T-RES-202b: un suspendido NO es un fallo — no cae en la rama de 400/402/403', async () => {
    mockCompose.mockResolvedValue(
      okResult({
        suspended: {
          runId: RUN_ID,
          step: 0,
          artifact: {},
          expiresAt: '2030-01-01T00:00:00.000Z',
          state: 'input-required',
        },
        resumeToken: 't',
      }),
    );
    const res = await compose({ steps: [{ agent: 'kyc', input: {} }] });
    expect(res.statusCode).toBe(202);
    expect(res.json().error).toBeUndefined();
    expect(res.json().errorCode).toBeUndefined();
  });

  it('un TTL fuera de rango se rechaza con 400 ANTES de invocar nada', async () => {
    const res = await compose({
      steps: [{ agent: 'kyc', input: {} }],
      suspendTtlSeconds: 5,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('INVALID_SUSPEND_TTL');
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it('con la bandera apagada, `/compose` no construye la autorización de suspender', async () => {
    mockCompose.mockResolvedValue(okResult());
    await compose({ steps: [{ agent: 'kyc', input: {} }] });
    expect(mockCompose.mock.calls[0]?.[0]?.suspension).toBeUndefined();
  });

  it('con la bandera encendida y un caller bindeable, SÍ la construye', async () => {
    const guardado = process.env.COMPOSE_SUSPEND_ENABLED;
    process.env.COMPOSE_SUSPEND_ENABLED = 'true';
    try {
      mockCompose.mockResolvedValue(okResult());
      await compose({
        steps: [{ agent: 'kyc', input: {} }],
        suspendTtlSeconds: 600,
      });
      expect(mockCompose.mock.calls[0]?.[0]?.suspension).toEqual({
        caller: { kind: 'key', id: KEY_ID },
        ownerRef: OWNER,
        keyId: KEY_ID,
        ttlSeconds: 600,
      });
    } finally {
      if (guardado === undefined) delete process.env.COMPOSE_SUSPEND_ENABLED;
      else process.env.COMPOSE_SUSPEND_ENABLED = guardado;
    }
  });

  it('🔴 R-2 · con la bandera encendida pero SIN caller bindeable, no se construye', async () => {
    // `resolveResumeCaller` devuelve `null` para un caller x402 puro / anónimo.
    // Sin credencial exacta no hay a qué atar el token, y un token que puede
    // redimir cualquiera no es una credencial. Ese pipeline nunca suspende.
    const guardado = process.env.COMPOSE_SUSPEND_ENABLED;
    process.env.COMPOSE_SUSPEND_ENABLED = 'true';
    nextKeyRow = undefined;
    try {
      mockCompose.mockResolvedValue(okResult());
      await compose({ steps: [{ agent: 'kyc', input: {} }] });
      expect(mockCompose.mock.calls[0]?.[0]?.suspension).toBeUndefined();
    } finally {
      if (guardado === undefined) delete process.env.COMPOSE_SUSPEND_ENABLED;
      else process.env.COMPOSE_SUSPEND_ENABLED = guardado;
    }
  });
});

// ─── fix-pack AR/BLQ-ALTO-2 · el débito del primer step del tramo ─────────
//
// ⚠️ ESTA CAPA MIDE LO QUE EL ROUTE DECIDE. Que la CONSERVACIÓN se cumpla —N
// steps ejecutados ⇒ N débitos— corriendo el bucle de verdad lo mide
// `src/__tests__/e2e/compose-flow.test.ts` (P0-3), que monta el
// `composeService` REAL detrás de esta misma ruta. Los dos hacen falta: acá se
// ve el monto, el destino y el ORDEN; allá se ve que no falte ninguno.

describe('fix-pack AR/BLQ-ALTO-2 · el tramo reanudado cobra su propio step 0', () => {
  it('T-RES-13: se debita UNA vez, ANTES de compose(), con precio+destino+owner del caller', async () => {
    mockClaim.mockResolvedValue({ ok: true, run: claimRow() as never });

    await resume(mint());

    expect(mockDebit).toHaveBeenCalledTimes(1);
    expect(mockDebit).toHaveBeenCalledWith(
      KEY_ID,
      2368,
      2, // precio vivo del primer `remaining_step` (+0 de gas overhead)
      undefined,
      undefined,
      'wasiai/payout',
      OWNER, // Ownership Guard: el owner_ref del caller AUTENTICADO
    );
    // 🔴 EL ORDEN. Cobrar después de ejecutar sería fee-on-delivery, y este
    // repo debita antes del invoke en todos sus caminos.
    const ordenDebito = mockDebit.mock.invocationCallOrder[0] ?? 0;
    const ordenCompose = mockCompose.mock.invocationCallOrder[0] ?? 0;
    expect(ordenDebito).toBeLessThan(ordenCompose);
  });

  it('T-RES-14 (WKH-303): el precio CONGELADO del step 0 del tramo gana sobre el vivo', async () => {
    // Los precios llegan YA re-indexados contra `remaining_steps` (fix-pack
    // BLQ-BAJO-1), así que el índice 0 de acá es el primer step restante.
    mockClaim.mockResolvedValue({
      ok: true,
      run: claimRow({ frozen_step_prices: [0.5] }) as never,
    });

    await resume(mint());

    expect(mockDebit.mock.calls[0]?.[2]).toBe(0.5);
    // Y el pipeline recibe el MISMO array, sin re-indexar de nuevo.
    expect(mockCompose.mock.calls[0]?.[0]?.frozenStepPricesUsd).toEqual([0.5]);
  });

  it('T-RES-15: un agente que el catálogo no resuelve NO se debita (el pipeline lo 404ea)', async () => {
    mockDest.mockResolvedValue(null as never);

    await resume(mint());

    expect(mockDebit).not.toHaveBeenCalled();
    // Y no se inventa un refund de algo que nunca se debitó.
    expect(mockCredit).not.toHaveBeenCalled();
  });

  it('T-RES-16: si el catálogo o el oráculo de gas TIRAN, es 503 y el run se REABRE', async () => {
    mockPrice.mockRejectedValue(new Error('registry down'));

    const res = await resume(mint());

    expect(res.statusCode).toBe(503);
    expect(res.json().error_code).toBe('REGISTRY_UNAVAILABLE');
    expect(mockDebit).not.toHaveBeenCalled();
    expect(mockCompose).not.toHaveBeenCalled();
    // 🔴 `reopen`, NO `failed`: es un guard PRE-débito y nada se tocó, así que
    // el mismo token tiene que seguir sirviendo cuando el catálogo vuelva.
    // Con `failed` el run quedaría muerto y la plata de la primera mitad,
    // varada, por una caída transitoria de un servicio de lectura.
    expect(mockSettle).toHaveBeenCalledWith(RUN_ID, OWNER, 'reopen', null);
  });

  it('T-RES-17: un débito RECHAZADO cierra el run como `failed` y no ejecuta el pipeline', async () => {
    mockDebit.mockResolvedValue({
      success: false,
      error: 'DEST_CAP_EXCEEDED',
    });

    const res = await resume(mint());

    expect(res.statusCode).toBe(402);
    expect(res.json().errorCode).toBe('DEST_CAP_EXCEEDED');
    expect(mockCompose).not.toHaveBeenCalled();
    // `failed` y no `reopen`: ya se pidió un débito, y la doctrina de este repo
    // reserva `reopen` para lo que corre ANTES de cualquier débito.
    expect(mockSettle).toHaveBeenCalledWith(
      RUN_ID,
      OWNER,
      'failed',
      expect.stringContaining('DEST_CAP_EXCEEDED'),
    );
    // Nada que devolver: el débito rechazado no aplicó nada.
    expect(mockCredit).not.toHaveBeenCalled();
  });

  it('T-RES-18: sin `chain_id` en la fila no se debita — simetría con la primera mitad', async () => {
    // El pipeline original tampoco debitó ninguno de sus steps sin cadena
    // resuelta (`chainId !== undefined` es precondición del guard del bucle).
    mockClaim.mockResolvedValue({
      ok: true,
      run: claimRow({ chain_id: null }) as never,
    });

    await resume(mint());

    expect(mockDebit).not.toHaveBeenCalled();
  });

  it('T-RES-19 (BLQ-MED-1): el techo del caller y lo YA gastado viajan al pipeline', async () => {
    mockClaim.mockResolvedValue({
      ok: true,
      run: claimRow({ max_budget_usdc: '7.50000000' }) as never,
    });

    await resume(mint());

    const arg = mockCompose.mock.calls[0]?.[0];
    expect(arg?.maxBudget).toBe(7.5);
    // 🔴 Los DOS lados. Con el techo pero sin `preSpentUsd`, el guard seguiría
    // comparando contra la mitad y el techo valdría el doble.
    expect(arg?.preSpentUsd).toBeCloseTo(1.25, 6);
  });

  it('T-RES-20: sin techo declarado, `maxBudget` NO se inventa (queda ausente)', async () => {
    await resume(mint());
    const arg = mockCompose.mock.calls[0]?.[0];
    expect(arg?.maxBudget).toBeUndefined();
    expect('maxBudget' in (arg ?? {})).toBe(false);
  });

  it('T-RES-21 (MNR-2/MNR-8): la credencial cruda y el array de skips viajan al tramo', async () => {
    await resume(mint());
    const arg = mockCompose.mock.calls[0]?.[0];
    // La primera mitad del MISMO run mandaba `x-a2a-key` a los registries
    // system-trusted; el tramo reanudado tiene que mandarlo igual.
    expect(arg?.a2aKey).toBe('wasi_a2a_test');
    // Y el array PRESTADO de los motivos internos de skip: sin él, el tramo
    // reanudado perdía la telemetría que la primera mitad sí anotaba.
    expect(Array.isArray(arg?.downstreamSkipCauses)).toBe(true);
  });
});
