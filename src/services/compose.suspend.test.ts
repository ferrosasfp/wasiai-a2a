/**
 * WKH-225 — el step que SUSPENDE el pipeline.
 *
 * QUÉ SE AFIRMA ACÁ. No "se llamó al spy": el EFECTO sobre plata y sobre las dos
 * señales que un falso positivo arruinaría. Un rojo se lee como una de estas
 * frases:
 *   · "una suspensión normal hizo sonar la alarma de plata varada";
 *   · "el pipeline siguió cobrando steps que nadie iba a ejecutar";
 *   · "con la bandera apagada el resultado dejó de ser el de siempre";
 *   · "el guard del doble débito del step 0 desapareció".
 *
 * El harness (mocks + fixtures) es el de `compose.test.ts` / `compose.stranded.test.ts`,
 * a propósito: es el mismo money-path y dos dobles distintos del mismo servicio
 * divergen.
 *
 * Naming: T-SUSP-1..6 + los cuatro transversales.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { A2AAgentKeyRow, Agent } from '../types/index.js';

const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({ getLogger: () => logSpy }));
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
vi.mock('../lib/downstream-payment.js', () => ({
  signAndSettleDownstream: vi.fn().mockResolvedValue(null),
}));
const mockGasOverhead = vi.hoisted(() => vi.fn());
vi.mock('../lib/gas-overhead.js', () => ({
  getStepGasOverheadUsd: (...a: unknown[]) => mockGasOverhead(...a),
}));
// El único doble propio de esta HU: la persistencia del run suspendido. Lo que
// se mide acá es la DECISIÓN del pipeline, no el SQL — eso lo miden
// `suspended-run.test.ts` y el test de la migración.
vi.mock('./suspended-run.js', () => ({
  suspendedRunService: { open: vi.fn() },
}));

import { signAndSettleDownstream } from '../lib/downstream-payment.js';
import { COMPOSE_SUSPEND_ENABLED_ENV_VAR } from '../lib/resume-token.js';
import { COMPOSE_STRANDED_PAYMENT_EVENT } from '../lib/stranded-payment.js';
import { budgetService } from './budget.js';
import { composeService } from './compose.js';
import { discoveryService } from './discovery.js';
import { eventService } from './event.js';
import { registryService } from './registry.js';
import { suspendedRunService } from './suspended-run.js';

const mockDownstream = vi.mocked(signAndSettleDownstream);
const mockDebit = vi.mocked(budgetService.debit);
const mockCredit = vi.mocked(budgetService.credit);
const mockCreditWithDest = vi.mocked(budgetService.creditWithDest);
const mockTrack = vi.mocked(eventService.track);
const mockOpen = vi.mocked(suspendedRunService.open);

const HERE = dirname(fileURLToPath(import.meta.url));
const EVM_PAYTO = `0x${'B'.repeat(40)}`;
const CHAIN_ID = 2368;
const EXPIRES = '2030-01-01T00:00:00.000Z';

/** El sobre que un agente devuelve para pedir la espera. */
const SOBRE = {
  a2a_suspend: true,
  kyc_url: 'https://kyc.proveedor.test/sesion/abc123',
  session_id: 'abc123',
};

const SUSPENSION = {
  caller: { kind: 'key' as const, id: 'key-id-test' },
  ownerRef: 'owner-test',
  keyId: 'key-id-test',
};

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

function strandedEvents() {
  return mockTrack.mock.calls
    .map((c) => c[0])
    .filter((e) => e.eventType === COMPOSE_STRANDED_PAYMENT_EVENT);
}

beforeEach(() => {
  vi.clearAllMocks();
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
    totalAtLeast: 0,
    registries: [],
    sources: [],
    catalogStatus: 'complete',
  });
  mockDownstream.mockResolvedValue(null);
  mockGasOverhead.mockResolvedValue(0);
  mockDebit.mockResolvedValue({ success: true });
  mockCredit.mockResolvedValue({ success: true, reverted: true });
  mockCreditWithDest.mockResolvedValue({ success: true, reverted: true });
  mockTrack.mockResolvedValue({} as never);
  mockOpen.mockResolvedValue({
    ok: true,
    runId: 'run-abc',
    token: 'v1.payload.firma',
    expiresAt: EXPIRES,
  });
});

// ─── AC-1 / AC-2: suspender no es fallar ──────────────────────────────────

describe('WKH-225 · la suspensión no es un fallo (AC-1)', () => {
  it('T-SUSP-1: el resultado NO es `success:false`', async () => {
    wireAgents(makeAgent({ slug: 'kyc' }));
    mockFetchOk(SOBRE);

    const result = await composeService.compose({
      steps: [{ agent: 'kyc', input: {} }],
      suspension: SUSPENSION,
    });

    expect(result.success).not.toBe(false);
    expect(result.success).toBe(true);
    expect(result.suspended).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  it('T-SUSP-2: CERO eventos de residuo — y el step anterior SÍ había pagado on-chain', async () => {
    // 🔴 LA PREMISA ES EL TEST. Sin un `downstreamTxHash` real en un step
    // anterior, `collectStrandedSteps` devuelve `[]` y este caso pasaría en
    // verde AUNQUE la suspensión emitiera residuo: sería el camino feliz
    // ejercitando el agujero.
    const a1 = makeAgent({ slug: 'fx' });
    const a2 = makeAgent({ slug: 'kyc', id: 'agent-2' });
    wireAgents(a1, a2);
    mockDownstream.mockResolvedValueOnce({
      txHash: '0xDOWN0',
      blockNumber: 7,
      settledAmount: '20000',
    });
    mockFetchOk({ result: 'step0' });
    mockFetchOk(SOBRE);

    const result = await composeService.compose({
      steps: [
        { agent: 'fx', input: {} },
        { agent: 'kyc', input: {} },
      ],
      scopingKeyRow: makeKeyRow(),
      chainId: CHAIN_ID,
      suspension: SUSPENSION,
    });

    // La premisa, medida: el step 0 pagó DE VERDAD.
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]?.downstreamTxHash).toBe('0xDOWN0');
    // Y aun así: cero residuo. Ésa es la propiedad.
    expect(strandedEvents()).toHaveLength(0);
    expect(result.suspended?.step).toBe(1);
  });

  it('T-SUSP-3 (AC-2): la fila persiste el estado mínimo, campo por campo', async () => {
    const a1 = makeAgent({ slug: 'fx' });
    const a2 = makeAgent({ slug: 'kyc', id: 'agent-2' });
    const a3 = makeAgent({ slug: 'payout', id: 'agent-3' });
    wireAgents(a1, a2, a3);
    mockFetchOk({ result: 'step0' });
    mockFetchOk(SOBRE);

    await composeService.compose({
      steps: [
        { agent: 'fx', input: {} },
        { agent: 'kyc', input: {} },
        { agent: 'payout', input: {} },
      ],
      scopingKeyRow: makeKeyRow(),
      chainId: CHAIN_ID,
      contractingChain: ['gw-a'],
      contractingDepth: 3,
      selfHostHint: 'a2a.wasiai.io',
      suspension: { ...SUSPENSION, ttlSeconds: 7200 },
    });

    expect(mockOpen).toHaveBeenCalledTimes(1);
    const arg = mockOpen.mock.calls[0]?.[0];
    // ⚠️ Campo por campo, NO un `toMatchObject` parcial: un parcial deja de ver
    // exactamente el campo que alguien deje de mandar mañana.
    expect(arg?.ownerRef).toBe('owner-test');
    expect(arg?.keyId).toBe('key-id-test');
    expect(arg?.caller).toEqual({ kind: 'key', id: 'key-id-test' });
    expect(arg?.stepIndex).toBe(1);
    expect(arg?.steps).toHaveLength(2);
    expect(arg?.remainingSteps).toEqual([{ agent: 'payout', input: {} }]);
    expect(arg?.chainId).toBe(CHAIN_ID);
    expect(arg?.ttlSeconds).toBe(7200);
    // 🔴 CD-17: los tres de la traza anti-bucle.
    expect(arg?.contractingChain).toEqual(['gw-a']);
    expect(arg?.contractingDepth).toBe(3);
    expect(arg?.selfHostHint).toBe('a2a.wasiai.io');
    // Y el `compose_run_id`, que es la clave de idempotencia del fee.
    expect(typeof arg?.composeRunId).toBe('string');
    expect((arg?.composeRunId ?? '').length).toBeGreaterThan(10);
  });

  it('T-SUSP-4 (AC-2): la respuesta trae artefacto, runId y vencimiento', async () => {
    wireAgents(makeAgent({ slug: 'kyc' }));
    mockFetchOk(SOBRE);

    const result = await composeService.compose({
      steps: [{ agent: 'kyc', input: {} }],
      suspension: SUSPENSION,
    });

    expect(result.suspended).toEqual({
      runId: 'run-abc',
      step: 0,
      // ⛔ CD-21: el artefacto es lo que devolvió el agente, TAL CUAL. Ni una
      // clave menos, ni una más, ni reescrita.
      artifact: SOBRE,
      expiresAt: EXPIRES,
      state: 'input-required',
    });
    expect(result.resumeToken).toBe('v1.payload.firma');
  });
});

// ─── AC-3: lo que NO se toca de los steps posteriores ─────────────────────

describe('WKH-225 · los steps posteriores no se cobran ni se invocan (AC-3)', () => {
  it('T-SUSP-5: cuatro espías, cuatro `not.toHaveBeenCalled` para el step 2', async () => {
    const a1 = makeAgent({ slug: 'fx', priceUsdc: 1 });
    const a2 = makeAgent({ slug: 'kyc', id: 'agent-2', priceUsdc: 1 });
    const a3 = makeAgent({ slug: 'payout', id: 'agent-3', priceUsdc: 1 });
    wireAgents(a1, a2, a3);
    mockFetchOk({ result: 'step0' });
    mockFetchOk(SOBRE);

    const result = await composeService.compose({
      steps: [
        { agent: 'fx', input: {} },
        { agent: 'kyc', input: {} },
        { agent: 'payout', input: {} },
      ],
      scopingKeyRow: makeKeyRow(),
      chainId: CHAIN_ID,
      suspension: SUSPENSION,
    });

    expect(result.suspended?.step).toBe(1);
    // 1. El débito per-step corrió UNA sola vez (el step 1). El step 0 lo
    //    debita el middleware, y el step 2 no existe todavía.
    expect(mockDebit).toHaveBeenCalledTimes(1);
    // 2. Se invocó a dos agentes, nunca al tercero.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const invocados = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(invocados.filter((u) => u.includes('example.com'))).toHaveLength(2);
    // 3. Ningún settle downstream para el step que no corrió.
    expect(mockDownstream).toHaveBeenCalledTimes(2);
    // 4. Cero créditos: no se reembolsa nada, porque nada falló.
    expect(mockCredit).not.toHaveBeenCalled();
    expect(mockCreditWithDest).not.toHaveBeenCalled();
  });

  it('si la persistencia falla, el pipeline CORTA — no sigue cobrando', async () => {
    mockOpen.mockResolvedValue({ ok: false, reason: 'write_failed' });
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 1 });
    const a2 = makeAgent({ slug: 'payout', id: 'agent-2', priceUsdc: 1 });
    wireAgents(a1, a2);
    mockFetchOk(SOBRE);

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'payout', input: {} },
      ],
      scopingKeyRow: makeKeyRow(),
      chainId: CHAIN_ID,
      suspension: SUSPENSION,
    });

    expect(result.success).toBe(false);
    expect(result.suspended).toBeUndefined();
    // ⛔ La unión de `errorCode` NO gana un miembro por esto: cae en el
    // `default → 400` del route, igual que el guard de presupuesto.
    expect(result.errorCode).toBeUndefined();
    expect(result.error).toContain('could not be persisted');
    // Y el step 1 no se invocó.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ─── AC-9: con la bandera apagada, exactamente como hoy ───────────────────

describe('WKH-225 · con la suspensión apagada nada cambia (AC-9)', () => {
  it('T-SUSP-6a: `request.suspension` ausente ⇒ el sobre NI SE MIRA', async () => {
    wireAgents(makeAgent({ slug: 'kyc' }));
    mockFetchOk(SOBRE);

    const result = await composeService.compose({
      steps: [{ agent: 'kyc', input: {} }],
    });

    expect(mockOpen).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.suspended).toBeUndefined();
    // 🔴 Las CLAVES, no sólo la ausencia de `suspended`. Es lo que hace
    // falsable "cero claves nuevas": un campo aditivo que se colara con valor
    // `undefined` igual aparecería acá.
    expect(Object.keys(result).sort()).toEqual([
      'output',
      'steps',
      'success',
      'totalCostUsdc',
      'totalLatencyMs',
      'verificationStatus',
    ]);
    // Y el output es el sobre tal cual, tratado como salida normal.
    expect(result.output).toEqual(SOBRE);
  });

  it('T-SUSP-6b: la bandera sólo enciende con el string exacto `true`', async () => {
    const { isComposeSuspendEnabled } = await import('../lib/resume-token.js');
    const guardado = process.env[COMPOSE_SUSPEND_ENABLED_ENV_VAR];
    try {
      for (const valor of ['', 'TRUE', '1', 'yes', 'True', 'false', ' true']) {
        process.env[COMPOSE_SUSPEND_ENABLED_ENV_VAR] = valor;
        expect(isComposeSuspendEnabled()).toBe(false);
      }
      delete process.env[COMPOSE_SUSPEND_ENABLED_ENV_VAR];
      expect(isComposeSuspendEnabled()).toBe(false);
      process.env[COMPOSE_SUSPEND_ENABLED_ENV_VAR] = 'true';
      expect(isComposeSuspendEnabled()).toBe(true);
    } finally {
      if (guardado === undefined) {
        delete process.env[COMPOSE_SUSPEND_ENABLED_ENV_VAR];
      } else {
        process.env[COMPOSE_SUSPEND_ENABLED_ENV_VAR] = guardado;
      }
    }
  });

  it('un output normal con la suspensión ENCENDIDA sigue siendo un output normal', async () => {
    wireAgents(makeAgent({ slug: 'kyc' }));
    mockFetchOk({ result: 'todo bien', a2a_suspend: false });

    const result = await composeService.compose({
      steps: [{ agent: 'kyc', input: {} }],
      suspension: SUSPENSION,
    });

    expect(mockOpen).not.toHaveBeenCalled();
    expect(result.suspended).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it('el discriminante es ESTRICTO: `"true"`, `1` y `"yes"` no suspenden', async () => {
    for (const valor of ['true', 1, 'yes', {}, null]) {
      vi.clearAllMocks();
      mockOpen.mockResolvedValue({
        ok: true,
        runId: 'run-abc',
        token: 't',
        expiresAt: EXPIRES,
      });
      wireAgents(makeAgent({ slug: 'kyc' }));
      mockFetchOk({ a2a_suspend: valor });
      const result = await composeService.compose({
        steps: [{ agent: 'kyc', input: {} }],
        suspension: SUSPENSION,
      });
      expect(mockOpen).not.toHaveBeenCalled();
      expect(result.suspended).toBeUndefined();
    }
  });
});

// ─── Los transversales ────────────────────────────────────────────────────

describe('WKH-225 · los controles transversales', () => {
  it('T-SUSP-CALLSITE: `services/orchestrate.ts` no sabe qué es una suspensión', async () => {
    // ⚠️ Se lee EL FUENTE DE ORCHESTRATE, no este archivo. Un
    // `expect(self.includes(...))` sobre el propio test nunca podría fallar.
    // Que `/orchestrate` no pueda suspender es ESTRUCTURAL: sin construir el
    // campo `suspension` del request, el lector del sobre no corre nunca.
    const src = readFileSync(join(HERE, 'orchestrate.ts'), 'utf8');
    expect(src.length).toBeGreaterThan(1000);
    expect(src).not.toContain('suspension');
    expect(src).not.toContain('suspendIfEnvelope');
    expect(src).not.toContain('suspendedRunService');
  });

  it('T-SUSP-GUARD571 (CD-7): el guard del doble débito del step 0 sobrevive', async () => {
    // ⚠️ ANCLA POR CONTENIDO, NO POR NÚMERO DE LÍNEA. Esta HU insertó líneas
    // por encima y el número se movió; el texto es lo que no se puede mover.
    const src = readFileSync(join(HERE, 'compose.ts'), 'utf8');
    const GUARD = 'if (i > 0 && scopingKeyRow && chainId !== undefined) {';
    expect(src).toContain(GUARD);
    // Una sola vez: dos copias serían dos guards que pueden divergir.
    expect(src.split(GUARD).length - 1).toBe(1);
    // Y su comentario, que es lo que le explica al próximo por qué no se toca.
    expect(src).toContain(
      'guard `i > 0` es la ÚNICA defensa contra double-debit del',
    );
    expect(src).toContain('NO REMOVER');
  });

  it('T-SUSP-NOERRCODE: la unión de `errorCode` sigue teniendo 5 miembros', async () => {
    const src = readFileSync(join(HERE, '..', 'types', 'index.ts'), 'utf8');
    const bloque = src.slice(
      src.indexOf('  errorCode?:\n'),
      src.indexOf("    | 'CONTRACTING_DEPTH_EXCEEDED';") + 40,
    );
    const miembros = [...bloque.matchAll(/\|\s*'([A-Z_]+)'/g)].map((m) => m[1]);
    expect(miembros).toEqual([
      'SCOPE_DENIED',
      'DEST_CAP_EXCEEDED',
      'INPUT_MAPPING_FAILED',
      'CONTRACTING_LOOP_DETECTED',
      'CONTRACTING_DEPTH_EXCEEDED',
    ]);
  });

  it('T-SUSP-IMPOSSIBLE: ningún camino devuelve `{success:false, suspended}`', async () => {
    // El estado `{success:true, suspended}` NO es un imposible mal modelado: ES
    // el estado suspendido. El imposible es el otro, y se mide sobre los dos
    // desenlaces que el lector del sobre puede producir.
    wireAgents(makeAgent({ slug: 'kyc' }));

    mockFetchOk(SOBRE);
    const feliz = await composeService.compose({
      steps: [{ agent: 'kyc', input: {} }],
      suspension: SUSPENSION,
    });
    expect(feliz.success && feliz.suspended !== undefined).toBe(true);

    vi.clearAllMocks();
    mockOpen.mockResolvedValue({ ok: false, reason: 'no_secret' });
    mockDownstream.mockResolvedValue(null);
    mockGasOverhead.mockResolvedValue(0);
    mockTrack.mockResolvedValue({} as never);
    wireAgents(makeAgent({ slug: 'kyc' }));
    mockFetchOk(SOBRE);
    const fallado = await composeService.compose({
      steps: [{ agent: 'kyc', input: {} }],
      suspension: SUSPENSION,
    });
    expect(fallado.success).toBe(false);
    expect(fallado.suspended).toBeUndefined();
    expect(fallado.resumeToken).toBeUndefined();
  });
});
