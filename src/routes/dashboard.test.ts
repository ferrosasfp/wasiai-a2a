/**
 * Dashboard Routes Tests — WKH-AUDIT-A2A
 * AC-1: prod + token ausente → 503 service_unavailable
 * AC-2: dev + token ausente → passthrough 200
 * reg:  prod + token OK → 200; token MAL → 401 (CD-5 intacto)
 * AC-3/AC-4: aserto sobre .env.example + docs naming drift
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// ── Mock event service (no DB) ──────────────────────────────
vi.mock('../services/event.js', () => ({
  eventService: {
    stats: vi.fn().mockResolvedValue({ ok: true }),
    recent: vi.fn().mockResolvedValue([]),
  },
}));

// ── WKH-189: mock arbiter service (evita cargar supabase/adapters) ──
const mockListHolds = vi.hoisted(() => vi.fn());
const mockResolveHold = vi.hoisted(() => vi.fn());
const mockIsArbiterEnabled = vi.hoisted(() => vi.fn(() => true));
vi.mock('../services/arbiter.js', () => ({
  arbiterService: {
    listHolds: (...a: unknown[]) => mockListHolds(...a),
    resolveHold: (...a: unknown[]) => mockResolveHold(...a),
  },
  isArbiterEnabled: () => mockIsArbiterEnabled(),
}));

// ── WKH-191c: mock reconciliation service + flag (evita cargar supabase/adapters) ──
const mockListPending = vi.hoisted(() => vi.fn());
const mockDriftCheck = vi.hoisted(() => vi.fn());
const mockResolveIntent = vi.hoisted(() => vi.fn());
// AR de HU-202, BLOQUEANTE 3: las dos salidas de una fila leaseada.
const mockResolveWithHop2Evidence = vi.hoisted(() => vi.fn());
const mockReleaseHop2Lease = vi.hoisted(() => vi.fn());
// HU-201 (AR BLQ-MEDIO-2): la superficie de los deposits RETENIDOS.
const mockListAmbiguous = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ rows: [], total: 0, truncated: false }),
);
const MockReconciliationError = vi.hoisted(() => {
  class ReconciliationError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.name = 'ReconciliationError';
      this.code = code;
    }
  }
  return ReconciliationError;
});
vi.mock('../services/reconciliation.js', () => ({
  reconciliationService: {
    listPending: (...a: unknown[]) => mockListPending(...a),
    driftCheck: (...a: unknown[]) => mockDriftCheck(...a),
    listAmbiguous: (...a: unknown[]) => mockListAmbiguous(...a),
    resolveIntent: (...a: unknown[]) => mockResolveIntent(...a),
    resolveWithHop2Evidence: (...a: unknown[]) =>
      mockResolveWithHop2Evidence(...a),
    releaseHop2Lease: (...a: unknown[]) => mockReleaseHop2Lease(...a),
  },
  ReconciliationError: MockReconciliationError,
}));

const mockIsEscrowSettleEnabled = vi.hoisted(() => vi.fn(() => false));
vi.mock('../adapters/escrow/debit-capture.js', () => ({
  isEscrowSettleEnabled: () => mockIsEscrowSettleEnabled(),
}));

import dashboardRoutes from './dashboard.js';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_ADMIN_TOKEN = process.env.DASHBOARD_ADMIN_TOKEN;

async function buildApp() {
  const app = Fastify();
  await app.register(dashboardRoutes, { prefix: '/dashboard' });
  await app.ready();
  return app;
}

/**
 * HU-206: la misma app, con un logger que captura los `warn`. Mismo patrón que
 * `makeCapturingLogger` en `middleware/x402.settle-unknown.test.ts`: `child()` se
 * devuelve a sí mismo para que `request.log` (que es un child) caiga en el mismo array.
 * Sirve para candar la auditoría, que es parte de la defensa de esta operación.
 */
async function buildAppWithWarnCapture(sink: Record<string, unknown>[]) {
  const logger = {
    warn: (obj: unknown) => {
      if (obj && typeof obj === 'object')
        sink.push(obj as Record<string, unknown>);
    },
    error: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    silent: () => {},
    level: 'warn',
    child() {
      return this;
    },
  } as unknown as FastifyBaseLogger;
  const app = Fastify({ loggerInstance: logger });
  await app.register(dashboardRoutes, { prefix: '/dashboard' });
  await app.ready();
  return app;
}

describe('dashboard admin-token preHandler', () => {
  beforeEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.DASHBOARD_ADMIN_TOKEN;
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.DASHBOARD_ADMIN_TOKEN;
  });

  afterAll(() => {
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_ADMIN_TOKEN === undefined)
      delete process.env.DASHBOARD_ADMIN_TOKEN;
    else process.env.DASHBOARD_ADMIN_TOKEN = ORIGINAL_ADMIN_TOKEN;
  });

  it('AC-1: prod + token ausente → 503 service_unavailable', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.DASHBOARD_ADMIN_TOKEN;
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/api/stats',
    });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.error).toBe('service_unavailable');
    expect(body.message).toBe('Dashboard API not configured');
    await app.close();
  });

  it('AC-2: dev + token ausente → passthrough 200', async () => {
    delete process.env.NODE_ENV; // non-production
    delete process.env.DASHBOARD_ADMIN_TOKEN;
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/api/stats',
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('reg: prod + token OK → 200 (passthrough)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DASHBOARD_ADMIN_TOKEN = 'secret';
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/api/stats',
      headers: { 'x-admin-token': 'secret' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('reg: prod + token MAL → 401 unauthorized (CD-5 intacto)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DASHBOARD_ADMIN_TOKEN = 'secret';
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/api/stats',
      headers: { 'x-admin-token': 'wrong' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('unauthorized');
    await app.close();
  });
});

describe('AC-3/AC-4: env + docs naming drift', () => {
  const root = process.cwd();

  it('AC-3: .env.example documents the 3 vars', () => {
    const env = readFileSync(resolve(root, '.env.example'), 'utf-8');
    expect(env).toContain('DASHBOARD_ADMIN_TOKEN');
    expect(env).toContain('DISCOVERY_REGISTRY_TIMEOUT_MS');
    expect(env).toContain('SUPABASE_SERVICE_KEY');
  });

  // AC-4 apunta a la documentación que un integrador realmente sigue, y que
  // está versionada. Antes leía dos archivos de proceso interno que salieron
  // del repo al hacerlo público: el test se caía por la ausencia del archivo,
  // no por drift, que es la peor forma de fallar (ruido que tapa la señal).
  it('AC-4: la doc versionada nombra SUPABASE_SERVICE_KEY, no la variante _ROLE_', () => {
    for (const rel of ['README.md', '.env.example']) {
      const doc = readFileSync(resolve(root, rel), 'utf-8');
      expect(doc, `${rel} debe documentar la var de runtime`).toContain(
        'SUPABASE_SERVICE_KEY',
      );
      expect(doc, `${rel} no debe usar el nombre viejo`).not.toContain(
        'SUPABASE_SERVICE_ROLE_KEY=sb_secret_',
      );
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// WKH-189 · Rutas admin de override de arb_hold (holds + resolve)
// ════════════════════════════════════════════════════════════════════
describe('WKH-189 admin arbitration routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsArbiterEnabled.mockReturnValue(true);
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.DASHBOARD_ADMIN_TOKEN;
  });

  // ── T-1 (AC-1): GET holds cross-tenant con token válido ──
  it('T-1: GET holds con token válido lista holds cross-tenant (2 owners) + total', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secret';
    mockListHolds.mockResolvedValue([
      {
        intentId: 'aaaaaaaa-0000-0000-0000-000000000001',
        chainId: 2368,
        atStakeUsd: 10,
        decision: 'hold',
        method: 'hold',
        ambiguityReason: 'proof_chain_tamper',
        createdAt: '2026-07-11T00:00:00.000Z',
      },
      {
        intentId: 'bbbbbbbb-0000-0000-0000-000000000002',
        chainId: 43113,
        atStakeUsd: 20,
        decision: 'hold',
        method: 'hold',
        ambiguityReason: 'over_cap',
        createdAt: '2026-07-11T01:00:00.000Z',
      },
    ]);
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/api/arbitrations/holds',
      headers: { 'x-admin-token': 'secret' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(2);
    expect(body.holds).toHaveLength(2);
    const ids = body.holds.map((h: { intentId: string }) => h.intentId);
    expect(ids).toContain('aaaaaaaa-0000-0000-0000-000000000001');
    expect(ids).toContain('bbbbbbbb-0000-0000-0000-000000000002');
    await app.close();
  });

  // ── T-5 (AC-5): sin X-Admin-Token → 401; servicios NO invocados ──
  it('T-5: GET/POST sin X-Admin-Token (con token configurado) → 401, servicios no invocados', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secret';
    const app = await buildApp();

    const getRes = await app.inject({
      method: 'GET',
      url: '/dashboard/api/arbitrations/holds',
    });
    expect(getRes.statusCode).toBe(401);

    const postRes = await app.inject({
      method: 'POST',
      url: '/dashboard/api/arbitrations/i1/resolve',
      payload: { decision: 'release' },
    });
    expect(postRes.statusCode).toBe(401);

    expect(mockListHolds).not.toHaveBeenCalled();
    expect(mockResolveHold).not.toHaveBeenCalled();
    await app.close();
  });

  // ── T-9 (AC-8/CD-7): flag OFF → 404 NOT_FOUND byte-idéntico, aún con token ──
  it('T-9: ARBITER_ENABLED != true → GET/POST 404 {error_code:NOT_FOUND}, incluso con token válido', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secret';
    mockIsArbiterEnabled.mockReturnValue(false);
    const app = await buildApp();

    const getRes = await app.inject({
      method: 'GET',
      url: '/dashboard/api/arbitrations/holds',
      headers: { 'x-admin-token': 'secret' },
    });
    expect(getRes.statusCode).toBe(404);
    expect(getRes.json()).toEqual({ error_code: 'NOT_FOUND' });

    const postRes = await app.inject({
      method: 'POST',
      url: '/dashboard/api/arbitrations/i1/resolve',
      headers: { 'x-admin-token': 'secret' },
      payload: { decision: 'release' },
    });
    expect(postRes.statusCode).toBe(404);
    expect(postRes.json()).toEqual({ error_code: 'NOT_FOUND' });

    expect(mockListHolds).not.toHaveBeenCalled();
    expect(mockResolveHold).not.toHaveBeenCalled();
    await app.close();
  });
});

// ════════════════════════════════════════════════════════════════════
// WKH-191c · Rutas admin del motor de reconciliación (GET read-only + POST resolve)
// ════════════════════════════════════════════════════════════════════
describe('WKH-191c reconciliation admin routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsEscrowSettleEnabled.mockReturnValue(false);
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.DASHBOARD_ADMIN_TOKEN;
  });

  // ── T-13 (AC-1/AC-8): GET read-only lista pending + drift, corre con flag OFF ──
  it('T-13: GET /api/reconciliation con token → pending + drift + flagEnabled:false (flag OFF)', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secret';
    mockIsEscrowSettleEnabled.mockReturnValue(false);
    mockListPending.mockResolvedValue([
      {
        intent_id: 'i1',
        key_id: 'k1',
        nonce: '7',
        debit_hop1_tx_hash: '0xabc',
        finalAmountUsd: '2.0',
        owner_ref: 'tenant-A',
        debit_settle_status: 'reconciliation_pending',
        hop2_attempted_at: null,
      },
    ]);
    mockDriftCheck.mockResolvedValue([
      {
        key_id: 'k1',
        sumDebitedAtomic: '3000000',
        escrowBalanceAtomic: '3500000',
        budgetUsd: '5.0',
        deltaAtomic: '500000',
        exceedsThreshold: true,
      },
    ]);
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/api/reconciliation',
      headers: { 'x-admin-token': 'secret' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.flagEnabled).toBe(false); // read-only corre con flag OFF
    expect(body.pending).toHaveLength(1);
    expect(body.drift).toHaveLength(1);
    expect(body.drift[0].exceedsThreshold).toBe(true);
    await app.close();
  });

  // ── HU-202: la edad del intento de hop 2 tiene que LLEGAR al operador ──
  //
  // El service la calcula, pero si el endpoint la recorta el operador vuelve a no poder
  // distinguir un settle EN VUELO (2 segundos) de un hop 2 parado (40 minutos): las dos
  // son `resolving_settle`. Un candado sobre el CONTRATO del endpoint, no sobre el
  // service — es lo único que el panel consume.
  it('T-202-ROUTE: GET /api/reconciliation expone `hop2_attempted_at` en cada fila pendiente', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secret';
    mockIsEscrowSettleEnabled.mockReturnValue(false);
    mockListPending.mockResolvedValue([
      {
        intent_id: 'i1',
        key_id: 'k1',
        nonce: '7',
        debit_hop1_tx_hash: '0xabc',
        finalAmountUsd: '2.0',
        owner_ref: 'tenant-A',
        debit_settle_status: 'resolving_settle',
        hop2_attempted_at: '2026-07-29T10:00:00.000Z',
      },
    ]);
    mockDriftCheck.mockResolvedValue([]);
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/api/reconciliation',
      headers: { 'x-admin-token': 'secret' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().pending[0].hop2_attempted_at).toBe(
      '2026-07-29T10:00:00.000Z',
    );
    await app.close();
  });

  // ── HU-201 (AR BLQ-MEDIO-2): el GET tiene que EXPONER los deposits retenidos ──
  //
  // Sin esto, el endurecimiento de HU-201 (un non-2xx del facilitator ya no se
  // reembolsa automáticamente) deja las filas `failed_ambiguous` sin NINGUNA
  // superficie en el camino no-escrow, que es el DEFAULT: `pending` lee la tabla de
  // firmas (sin escrow no hay fila) y `resolveIntent` corta en el gate del flag. O
  // sea que el fix cambiaba un reembolso indebido RUIDOSO por una retención
  // SILENCIOSA. El candado es sobre el CONTRATO del endpoint, no sobre el service.
  it('T-201-ROUTE: GET /api/reconciliation incluye `ambiguous` (deposits retenidos) incluso con el flag OFF', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secret';
    mockIsEscrowSettleEnabled.mockReturnValue(false);
    mockListPending.mockResolvedValue([]);
    mockDriftCheck.mockResolvedValue([]);
    mockListAmbiguous.mockResolvedValue({
      rows: [
        {
          intent_id: 'i9',
          owner_ref: 'tenant-A',
          key_id: 'k1',
          intent_type: 'session',
          status: 'failed',
          chain_id: 2368,
          pay_to: '0x2222222222222222222222222222222222222222',
          authorizedUsd: '10.00000000',
          consumedUsd: '4.00000000',
          settle_outcome: 'failed_ambiguous',
          error_message:
            'RECONCILE: settle failed WITH a broadcast hash (0xBROADCASTED): boom',
          updated_at: '2026-07-28T00:00:00.000Z',
        },
      ],
      total: 1,
      truncated: false,
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/api/reconciliation',
      headers: { 'x-admin-token': 'secret' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // El servicio se consulta AUNQUE el flag esté OFF: es el caso que cubre.
    expect(mockListAmbiguous).toHaveBeenCalled();
    expect(body.ambiguous.rows).toHaveLength(1);
    expect(body.ambiguous.total).toBe(1);
    expect(body.ambiguous.truncated).toBe(false);
    // El deposit retenido y la pista para cruzar contra la cadena llegan al operador.
    expect(body.ambiguous.rows[0].authorizedUsd).toBe('10.00000000');
    expect(body.ambiguous.rows[0].error_message).toContain('0xBROADCASTED');
    await app.close();
  });

  it('T-201-ROUTE-AUTH: la lista de deposits retenidos NO se sirve sin admin token', async () => {
    // Es cross-tenant (intents de todos los owners) y trae `owner_ref` + montos.
    process.env.DASHBOARD_ADMIN_TOKEN = 'secret';
    mockListAmbiguous.mockClear();
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/api/reconciliation',
    });
    expect(res.statusCode).toBe(401);
    expect(mockListAmbiguous).not.toHaveBeenCalled();
    await app.close();
  });

  // ── T-14 (AC-9/CD-7): POST fail-closed (503 sin env), 401 sin header, delega con token ──
  it('T-14a: POST resolve sin DASHBOARD_ADMIN_TOKEN → 503 (fail-closed, dev Y prod)', async () => {
    delete process.env.DASHBOARD_ADMIN_TOKEN;
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/api/reconciliation/i1/resolve',
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('service_unavailable');
    expect(mockResolveIntent).not.toHaveBeenCalled();
    await app.close();
  });

  it('T-14b: POST resolve con env SET pero sin X-Admin-Token → 401, servicio no invocado', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secret';
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/api/reconciliation/i1/resolve',
    });
    expect(res.statusCode).toBe(401);
    expect(mockResolveIntent).not.toHaveBeenCalled();
    await app.close();
  });

  // ── AR#2 MNR-2: `action_required` es la ÚNICA instrucción accionable que el operador
  // recibe sobre una fila con plata posiblemente duplicada, y no tenía ningún test:
  // mutarlo a `false` dejaba la suite verde, mientras el AC-13 lo declaraba evidencia.
  it('T-198-AR2-MNR2: awaiting_manual_settle_evidence viaja con la instrucción accionable', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secret';
    mockResolveIntent.mockResolvedValue({
      status: 'awaiting_manual_settle_evidence',
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/api/reconciliation/i1/resolve',
      headers: { 'x-admin-token': 'secret' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('awaiting_manual_settle_evidence');
    // La instrucción existe...
    expect(typeof body.action_required).toBe('string');
    // ...y dice las DOS cosas que el operador necesita: que NO se resolvió, y qué mirar.
    expect(body.action_required).toMatch(/NOT resolved/i);
    expect(body.action_required).toMatch(/chain/i);
    // Y advierte por qué el reconciliador no actúa solo (para que no lo fuerce).
    expect(body.action_required).toMatch(/twice/i);
    await app.close();
  });

  it('T-198-AR2-MNR2-neg: un outcome normal NO trae action_required', async () => {
    // Contra-ejemplo: si el campo saliera siempre, dejaría de señalar el caso que
    // requiere una acción fuera del panel.
    process.env.DASHBOARD_ADMIN_TOKEN = 'secret';
    mockResolveIntent.mockResolvedValue({ status: 'settled', side: 'settle' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/api/reconciliation/i1/resolve',
      headers: { 'x-admin-token': 'secret' },
    });
    expect(res.json().action_required).toBeUndefined();
    await app.close();
  });

  it('T-14c: POST resolve con token válido → delega a resolveIntent y devuelve outcome', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secret';
    mockResolveIntent.mockResolvedValue({
      status: 'settled',
      side: 'settle',
      txHash: '0xsettletx',
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/api/reconciliation/i1/resolve',
      headers: { 'x-admin-token': 'secret' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'settled',
      side: 'settle',
      txHash: '0xsettletx',
    });
    expect(mockResolveIntent).toHaveBeenCalledWith('i1');
    await app.close();
  });

  it('T-14d: POST resolve token válido, ReconciliationError(NOT_PENDING) → 409', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secret';
    mockResolveIntent.mockRejectedValue(
      new MockReconciliationError('NOT_PENDING'),
    );
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/api/reconciliation/i1/resolve',
      headers: { 'x-admin-token': 'secret' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error_code: 'NOT_PENDING' });
    await app.close();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AR de HU-202, BLOQUEANTE 3 — LOS DOS VERBOS QUE DESTRABAN UNA FILA LEASEADA.
//
// Antes del fix-pack, `/resolve` le decía al operador "resolvé con esa evidencia" y NO
// EXISTÍA NINGÚN ENDPOINT QUE LO PERMITIERA: el único remedio real era un `UPDATE` a mano
// contra producción. Estos tests candan que los verbos existan, que estén fail-closed, y
// que no acepten una atestación anónima.
// ════════════════════════════════════════════════════════════════════════════
const EV_TX =
  '0xfeedfeed0000000000000000000000000000000000000000000000000000feed';

describe('AR-202 B3 — POST /api/reconciliation/:id/hop2-evidence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('T-EVR1: sin DASHBOARD_ADMIN_TOKEN → 503 (fail-closed, igual que /resolve)', async () => {
    delete process.env.DASHBOARD_ADMIN_TOKEN;
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/api/reconciliation/i1/hop2-evidence',
      payload: { txHash: EV_TX, resolvedBy: 'ops' },
    });
    expect(res.statusCode).toBe(503);
    expect(mockResolveWithHop2Evidence).not.toHaveBeenCalled();
    await app.close();
  });

  it('T-EVR2: con token válido delega el hash y el autor al service', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secret';
    mockResolveWithHop2Evidence.mockResolvedValue({
      status: 'settled',
      txHash: EV_TX,
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/api/reconciliation/i1/hop2-evidence',
      headers: { 'x-admin-token': 'secret' },
      payload: { txHash: EV_TX, resolvedBy: 'ops@wasiai', note: 'explorer' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'settled', txHash: EV_TX });
    expect(mockResolveWithHop2Evidence).toHaveBeenCalledWith('i1', {
      txHash: EV_TX,
      resolvedBy: 'ops@wasiai',
      note: 'explorer',
    });
    await app.close();
  });

  it('T-EVR3: un `txHash` que no es un hash de 32 bytes → 400 y NUNCA llega al service', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secret';
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/api/reconciliation/i1/hop2-evidence',
      headers: { 'x-admin-token': 'secret' },
      payload: { txHash: 'nope', resolvedBy: 'ops' },
    });
    expect(res.statusCode).toBe(400);
    expect(mockResolveWithHop2Evidence).not.toHaveBeenCalled();
    await app.close();
  });

  it('T-EVR4: sin `resolvedBy` → 400 (una resolución de dinero anónima no es auditable)', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secret';
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/api/reconciliation/i1/hop2-evidence',
      headers: { 'x-admin-token': 'secret' },
      payload: { txHash: EV_TX, resolvedBy: '  ' },
    });
    expect(res.statusCode).toBe(400);
    expect(mockResolveWithHop2Evidence).not.toHaveBeenCalled();
    await app.close();
  });
});

// HU-206: credenciales de prueba, generadas acá. NUNCA valores reales.
const PANEL_TOKEN = 'test-panel-token-206';
const RELEASE_TOKEN = 'test-release-token-206-distinct';
/** Las dos credenciales que exige `release-lease` a partir de HU-206. */
const BOTH_CREDS = {
  'x-admin-token': PANEL_TOKEN,
  'x-reconciliation-release-token': RELEASE_TOKEN,
};

describe('AR-202 B3 — POST /api/reconciliation/:id/release-lease', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RECONCILIATION_RELEASE_TOKEN = RELEASE_TOKEN;
  });

  afterEach(() => {
    delete process.env.RECONCILIATION_RELEASE_TOKEN;
  });

  it('T-RLR1: sin DASHBOARD_ADMIN_TOKEN → 503 (fail-closed)', async () => {
    delete process.env.DASHBOARD_ADMIN_TOKEN;
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/api/reconciliation/i1/release-lease',
      payload: { resolvedBy: 'ops', note: 'n' },
    });
    expect(res.statusCode).toBe(503);
    expect(mockReleaseHop2Lease).not.toHaveBeenCalled();
    await app.close();
  });

  it('T-RLR2: con LAS DOS credenciales + atestación completa → delega y devuelve el outcome', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = PANEL_TOKEN;
    mockReleaseHop2Lease.mockResolvedValue({ status: 'lease_released' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/api/reconciliation/i1/release-lease',
      headers: BOTH_CREDS,
      payload: { resolvedBy: 'ops@wasiai', note: 'no transfer on chain' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'lease_released' });
    expect(mockReleaseHop2Lease).toHaveBeenCalledWith('i1', {
      resolvedBy: 'ops@wasiai',
      note: 'no transfer on chain',
    });
    await app.close();
  });

  it('T-RLR3: sin `note` → 400. Es LA única operación que vuelve pagable una fila sin prueba: sin motivo registrado es el `UPDATE` a mano con otro nombre', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = PANEL_TOKEN;
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/api/reconciliation/i1/release-lease',
      headers: BOTH_CREDS,
      payload: { resolvedBy: 'ops@wasiai' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error_code: 'ATTESTATION_REQUIRED' });
    expect(mockReleaseHop2Lease).not.toHaveBeenCalled();
    await app.close();
  });

  it('T-RLR4: sin `resolvedBy` → 400', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = PANEL_TOKEN;
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/api/reconciliation/i1/release-lease',
      headers: BOTH_CREDS,
      payload: { note: 'n' },
    });
    expect(res.statusCode).toBe(400);
    expect(mockReleaseHop2Lease).not.toHaveBeenCalled();
    await app.close();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// HU-206 — LA OPERACIÓN SIN PRUEBA EXIGE UNA CREDENCIAL PROPIA.
//
// El agujero: `DASHBOARD_ADMIN_TOKEN` abría por igual las lecturas cross-tenant, la
// resolución CON evidencia verificada on-chain (`hop2-evidence`) y la ATESTACIÓN SIN
// prueba (`release-lease`, que devuelve la fila al reconciliador y éste REENVÍA EL
// PAGO). O sea: el token que se presta para mirar métricas alcanzaba para habilitar un
// pago sin evidencia. Estos tests candan la separación y, sobre todo, candan que el
// camino verificable NO haya pagado fricción por ella.
// ════════════════════════════════════════════════════════════════════════════
describe('HU-206 — release-lease exige RECONCILIATION_RELEASE_TOKEN además del token de panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NODE_ENV;
    delete process.env.DASHBOARD_ADMIN_TOKEN;
    delete process.env.RECONCILIATION_RELEASE_TOKEN;
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.DASHBOARD_ADMIN_TOKEN;
    delete process.env.RECONCILIATION_RELEASE_TOKEN;
  });

  it('T-206-1 (EL test): con el token de panel VÁLIDO y sin la credencial nueva, release-lease es RECHAZADA mientras hop2-evidence y las lecturas siguen funcionando', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DASHBOARD_ADMIN_TOKEN = PANEL_TOKEN;
    delete process.env.RECONCILIATION_RELEASE_TOKEN;
    mockResolveWithHop2Evidence.mockResolvedValue({ status: 'settled' });
    const app = await buildApp();

    // (a) la operación SIN prueba: cerrada.
    const release = await app.inject({
      method: 'POST',
      url: '/dashboard/api/reconciliation/i1/release-lease',
      headers: { 'x-admin-token': PANEL_TOKEN },
      payload: { resolvedBy: 'ops@wasiai', note: 'looked at the explorer' },
    });
    expect(release.statusCode).toBe(503);
    expect(release.json().error).toBe('service_unavailable');
    expect(mockReleaseHop2Lease).not.toHaveBeenCalled();

    // (b) la operación VERIFICADA on-chain: intacta con el mismo token de panel.
    const evidence = await app.inject({
      method: 'POST',
      url: '/dashboard/api/reconciliation/i1/hop2-evidence',
      headers: { 'x-admin-token': PANEL_TOKEN },
      payload: { txHash: EV_TX, resolvedBy: 'ops@wasiai' },
    });
    expect(evidence.statusCode).toBe(200);
    expect(mockResolveWithHop2Evidence).toHaveBeenCalledTimes(1);

    // (c) las lecturas: intactas.
    const stats = await app.inject({
      method: 'GET',
      url: '/dashboard/api/stats',
      headers: { 'x-admin-token': PANEL_TOKEN },
    });
    expect(stats.statusCode).toBe(200);
    const recon = await app.inject({
      method: 'GET',
      url: '/dashboard/api/reconciliation',
      headers: { 'x-admin-token': PANEL_TOKEN },
    });
    expect(recon.statusCode).toBe(200);

    await app.close();
  });

  it('T-206-2: credencial nueva CONFIGURADA pero el header manda un valor incorrecto → 401 y el service ni se toca', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DASHBOARD_ADMIN_TOKEN = PANEL_TOKEN;
    process.env.RECONCILIATION_RELEASE_TOKEN = RELEASE_TOKEN;
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/api/reconciliation/i1/release-lease',
      headers: {
        'x-admin-token': PANEL_TOKEN,
        'x-reconciliation-release-token': 'wrong-value-same-length-padding',
      },
      payload: { resolvedBy: 'ops@wasiai', note: 'n' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('unauthorized');
    expect(mockReleaseHop2Lease).not.toHaveBeenCalled();
    await app.close();
  });

  it('T-206-3: credencial nueva configurada y el header AUSENTE → 401 (el token de panel solo no alcanza)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DASHBOARD_ADMIN_TOKEN = PANEL_TOKEN;
    process.env.RECONCILIATION_RELEASE_TOKEN = RELEASE_TOKEN;
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/api/reconciliation/i1/release-lease',
      headers: { 'x-admin-token': PANEL_TOKEN },
      payload: { resolvedBy: 'ops@wasiai', note: 'n' },
    });
    expect(res.statusCode).toBe(401);
    expect(mockReleaseHop2Lease).not.toHaveBeenCalled();
    await app.close();
  });

  it('T-206-4: la credencial nueva NO reemplaza al token de panel — sin `x-admin-token` sigue siendo 401', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DASHBOARD_ADMIN_TOKEN = PANEL_TOKEN;
    process.env.RECONCILIATION_RELEASE_TOKEN = RELEASE_TOKEN;
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/api/reconciliation/i1/release-lease',
      headers: { 'x-reconciliation-release-token': RELEASE_TOKEN },
      payload: { resolvedBy: 'ops@wasiai', note: 'n' },
    });
    expect(res.statusCode).toBe(401);
    expect(mockReleaseHop2Lease).not.toHaveBeenCalled();
    await app.close();
  });

  it('T-206-5: las dos variables con el MISMO valor → 503. Dos nombres para una sola credencial no separan privilegios', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DASHBOARD_ADMIN_TOKEN = PANEL_TOKEN;
    process.env.RECONCILIATION_RELEASE_TOKEN = PANEL_TOKEN;
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/api/reconciliation/i1/release-lease',
      headers: {
        'x-admin-token': PANEL_TOKEN,
        'x-reconciliation-release-token': PANEL_TOKEN,
      },
      payload: { resolvedBy: 'ops@wasiai', note: 'n' },
    });
    expect(res.statusCode).toBe(503);
    expect(mockReleaseHop2Lease).not.toHaveBeenCalled();
    await app.close();
  });

  it('T-206-6: con LAS DOS credenciales correctas la operación funciona (la separación no la rompe)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DASHBOARD_ADMIN_TOKEN = PANEL_TOKEN;
    process.env.RECONCILIATION_RELEASE_TOKEN = RELEASE_TOKEN;
    mockReleaseHop2Lease.mockResolvedValue({ status: 'lease_released' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/api/reconciliation/i1/release-lease',
      headers: BOTH_CREDS,
      payload: { resolvedBy: 'ops@wasiai', note: 'no transfer on chain' },
    });
    expect(res.statusCode).toBe(200);
    expect(mockReleaseHop2Lease).toHaveBeenCalledWith('i1', {
      resolvedBy: 'ops@wasiai',
      note: 'no transfer on chain',
    });
    await app.close();
  });

  // ── DESARROLLO LOCAL ──────────────────────────────────────────────────────
  // El passthrough dev del gate OPT-IN (`requireAdminToken`, lecturas de WKH-54) NO se
  // hereda acá: atar la operación sin prueba a `NODE_ENV` convierte un deploy con la
  // variable sin setear en una habilitación silenciosa. Lo que sí se preserva es que el
  // dev local siga andando configurando las variables.
  // T-206-7a AÍSLA el gate nuevo: el token de panel se configura Y se manda, así que
  // `requireAdminTokenStrict` pasa y el 503 sólo puede venir de `requireReleaseLeaseToken`.
  // Sin esa aislación el test pasaba igual con un `if (!isProduction()) return;` metido en
  // el gate nuevo (mutación M6 sobrevivía): el 503 lo daba el gate de panel y tapaba todo.
  it('T-206-7a: en dev (NODE_ENV sin setear), con el token de panel VÁLIDO y sin la credencial nueva → 503. No hay passthrough dev en la operación sin prueba', async () => {
    delete process.env.NODE_ENV;
    process.env.DASHBOARD_ADMIN_TOKEN = PANEL_TOKEN;
    delete process.env.RECONCILIATION_RELEASE_TOKEN;
    const app = await buildApp();
    const release = await app.inject({
      method: 'POST',
      url: '/dashboard/api/reconciliation/i1/release-lease',
      headers: { 'x-admin-token': PANEL_TOKEN },
      payload: { resolvedBy: 'ops@wasiai', note: 'n' },
    });
    expect(release.statusCode).toBe(503);
    expect(release.json().error).toBe('service_unavailable');
    expect(mockReleaseHop2Lease).not.toHaveBeenCalled();
    await app.close();
  });

  it('T-206-7b: en dev y sin NINGUNA variable, release-lease sigue CERRADA mientras las lecturas conservan su passthrough dev (AC-2 de WKH-54 intacto)', async () => {
    delete process.env.NODE_ENV;
    delete process.env.DASHBOARD_ADMIN_TOKEN;
    delete process.env.RECONCILIATION_RELEASE_TOKEN;
    const app = await buildApp();

    const release = await app.inject({
      method: 'POST',
      url: '/dashboard/api/reconciliation/i1/release-lease',
      payload: { resolvedBy: 'ops@wasiai', note: 'n' },
    });
    expect(release.statusCode).toBe(503);
    expect(mockReleaseHop2Lease).not.toHaveBeenCalled();

    const stats = await app.inject({
      method: 'GET',
      url: '/dashboard/api/stats',
    });
    expect(stats.statusCode).toBe(200);

    await app.close();
  });

  it('T-206-8: en dev, con las dos variables configuradas, la operación funciona igual que en prod (el desarrollo local no se rompe)', async () => {
    delete process.env.NODE_ENV;
    process.env.DASHBOARD_ADMIN_TOKEN = PANEL_TOKEN;
    process.env.RECONCILIATION_RELEASE_TOKEN = RELEASE_TOKEN;
    mockReleaseHop2Lease.mockResolvedValue({ status: 'lease_released' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/api/reconciliation/i1/release-lease',
      headers: BOTH_CREDS,
      payload: { resolvedBy: 'ops@wasiai', note: 'n' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('T-206-9: el uso de la credencial de mayor privilegio queda auditado con autor, motivo e intent', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DASHBOARD_ADMIN_TOKEN = PANEL_TOKEN;
    process.env.RECONCILIATION_RELEASE_TOKEN = RELEASE_TOKEN;
    mockReleaseHop2Lease.mockResolvedValue({ status: 'not_leased' });
    const warned: Record<string, unknown>[] = [];
    const app = await buildAppWithWarnCapture(warned);
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/api/reconciliation/i9/release-lease',
      headers: BOTH_CREDS,
      payload: { resolvedBy: 'ops@wasiai', note: 'explorer shows no transfer' },
    });
    expect(res.statusCode).toBe(200);
    // `not_leased` no deja rastro en el service: el del route es el ÚNICO registro de
    // quién ejerció la credencial. Por eso se audita el INTENTO, no sólo el efecto.
    const entry = warned.find(
      (w) => w.audit === 'ESCROW_HOP2_LEASE_RELEASE_REQUESTED',
    );
    expect(entry).toBeDefined();
    expect(entry?.resolvedBy).toBe('ops@wasiai');
    expect(entry?.note).toBe('explorer shows no transfer');
    expect(entry?.intentId).toBe('i9');
    await app.close();
  });

  it('T-206-10: un intento con token de panel válido y sin la credencial nueva queda registrado (es el patrón de escalada que esto separa)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DASHBOARD_ADMIN_TOKEN = PANEL_TOKEN;
    delete process.env.RECONCILIATION_RELEASE_TOKEN;
    const warned: Record<string, unknown>[] = [];
    const app = await buildAppWithWarnCapture(warned);
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/api/reconciliation/i1/release-lease',
      headers: { 'x-admin-token': PANEL_TOKEN },
      payload: { resolvedBy: 'ops@wasiai', note: 'n' },
    });
    expect(res.statusCode).toBe(503);
    expect(warned.some((w) => w.audit === 'RELEASE_LEASE_NOT_CONFIGURED')).toBe(
      true,
    );
    await app.close();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// HU-207 — LA ESCRITURA DE ARBITRAJE NO PUEDE ABRIRSE POR UNA VARIABLE AUSENTE.
//
// `POST /api/arbitrations/:intentId/resolve` resuelve una retención con release/refund/
// split: `arbiterService.resolveHold` termina en `executeArbitration`, que settlea al
// seller o reembolsa al buyer. Estaba detrás del gate OPT-IN de WKH-54, que sólo cierra
// cuando `NODE_ENV` dice EXACTAMENTE `production`: en cualquier despliegue sin
// `DASHBOARD_ADMIN_TOKEN` y sin ese `NODE_ENV` —un staging, un preview, un servicio
// recién creado— cualquiera podía mover ese dinero. Producción estaba configurada, así
// que no fue un incidente: fue una protección que dependía de acertar dos variables en
// cada entorno nuevo.
//
// Estos tests candan las DOS mitades, porque cada una sin la otra es una trampa: que la
// escritura esté cerrada sin secreto, y que las LECTURAS conserven su passthrough dev
// (cerrarlas también dejaría los tests verdes y trabaría el desarrollo local sin cerrar
// ninguna transferencia).
// ════════════════════════════════════════════════════════════════════════════
describe('HU-207 — POST /api/arbitrations/:id/resolve es fail-closed (dev Y prod)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NODE_ENV;
    delete process.env.DASHBOARD_ADMIN_TOKEN;
    mockIsArbiterEnabled.mockReturnValue(true);
    mockListHolds.mockResolvedValue([]);
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.DASHBOARD_ADMIN_TOKEN;
  });

  it('T-207-1 (EL test): en dev y sin DASHBOARD_ADMIN_TOKEN, resolver una retención es 503 y el árbitro NI SE LLAMA, mientras las lecturas siguen sirviendo', async () => {
    delete process.env.NODE_ENV; // no-producción: el caso que el opt-in dejaba pasar
    delete process.env.DASHBOARD_ADMIN_TOKEN;
    const app = await buildApp();

    // (a) la escritura que mueve dinero: cerrada.
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/api/arbitrations/i1/resolve',
      payload: { decision: 'release' },
    });
    // Se afirma PRIMERO lo que de verdad importa: que el money-path no se haya tocado.
    // Un 503 devuelto DESPUÉS de settlear seguiría siendo un pago hecho por un anónimo,
    // y con el gate opt-in este request LLEGABA a `resolveHold` (la mutación lo probó).
    expect(mockResolveHold).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('service_unavailable');

    // (b) las lecturas conservan su passthrough dev (AC-2 de WKH-54 intacto).
    const stats = await app.inject({
      method: 'GET',
      url: '/dashboard/api/stats',
    });
    expect(stats.statusCode).toBe(200);
    const holds = await app.inject({
      method: 'GET',
      url: '/dashboard/api/arbitrations/holds',
    });
    expect(holds.statusCode).toBe(200);
    expect(mockListHolds).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('T-207-2: en producción y sin la variable → 503 (el fail-closed que ya había, sin regresión)', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.DASHBOARD_ADMIN_TOKEN;
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/api/arbitrations/i1/resolve',
      payload: { decision: 'release' },
    });
    expect(res.statusCode).toBe(503);
    expect(mockResolveHold).not.toHaveBeenCalled();
    await app.close();
  });

  it('T-207-3: variable configurada y header ausente → 401, el árbitro no se llama', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secret';
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/api/arbitrations/i1/resolve',
      payload: { decision: 'release' },
    });
    expect(res.statusCode).toBe(401);
    expect(mockResolveHold).not.toHaveBeenCalled();
    await app.close();
  });

  // Contra-ejemplo OBLIGATORIO: sin esto, cablear el endpoint a 503 permanente (o
  // borrarlo) dejaba toda la sección verde. El endpoint tiene que seguir RESOLVIENDO.
  it('T-207-4: con el token válido delega en resolveHold y devuelve el outcome (el panel sigue funcionando)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DASHBOARD_ADMIN_TOKEN = 'secret';
    mockResolveHold.mockResolvedValue({
      decision: 'split',
      method: 'admin_override',
      status: 'settled',
      settleUsd: 6,
      residualUsd: 4,
      txHash: '0xarbtx',
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/api/arbitrations/i7/resolve',
      headers: { 'x-admin-token': 'secret' },
      payload: { decision: 'split', splitPct: 60, resolvedBy: 'ops@wasiai' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      decision: 'split',
      method: 'admin_override',
      status: 'settled',
      settleUsd: 6,
      residualUsd: 4,
      txHash: '0xarbtx',
    });
    expect(mockResolveHold).toHaveBeenCalledWith('i7', {
      decision: 'split',
      splitPct: 60,
      resolvedBy: 'ops@wasiai',
      note: null,
    });
    await app.close();
  });

  it('T-207-5: en dev, con la variable configurada, resolver funciona igual que en prod (el desarrollo local no se rompe)', async () => {
    delete process.env.NODE_ENV;
    process.env.DASHBOARD_ADMIN_TOKEN = 'secret';
    mockResolveHold.mockResolvedValue({
      decision: 'release',
      method: 'admin_override',
      status: 'settled',
      settleUsd: 10,
      residualUsd: 0,
      txHash: '0xdevtx',
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/api/arbitrations/i1/resolve',
      headers: { 'x-admin-token': 'secret' },
      payload: { decision: 'release' },
    });
    expect(res.statusCode).toBe(200);
    expect(mockResolveHold).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// HU-207 · GUARD ESTRUCTURAL — el inventario de escrituras se revisa SOLO.
//
// El bug no fue teclear el gate equivocado una vez: fue que nada miraba la relación
// "esto escribe ⟹ esto no puede abrirse sin secreto". Una convención en un comentario
// ya falló. Este test recorre las rutas REALMENTE registradas por el plugin (hook
// `onRoute`, no una lista escrita a mano, mismo patrón que `charged-routes.meta.test.ts`)
// y exige, sin ninguna env configurada y en desarrollo, que TODA ruta que no sea de
// lectura responda 503. Una escritura futura pegada al gate opt-in rompe acá, aunque
// nadie se acuerde de esta HU.
//
// Es un guard de COMPORTAMIENTO, no de nombres: no le pregunta a la ruta qué preHandler
// declara (eso se puede renombrar y seguir abierto), le manda el request que un
// desconocido mandaría.
// ════════════════════════════════════════════════════════════════════════════
describe('HU-207 — guard estructural: ninguna escritura del panel se sirve sin secreto', () => {
  const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

  async function registeredRoutes(): Promise<
    Array<{ method: string; url: string }>
  > {
    const collected: Array<{ method: string; url: string }> = [];
    const app = Fastify();
    app.addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method)
        ? route.method
        : [route.method];
      for (const method of methods) collected.push({ method, url: route.url });
    });
    await app.register(dashboardRoutes, { prefix: '/dashboard' });
    await app.ready();
    await app.close();
    return collected;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NODE_ENV;
    delete process.env.DASHBOARD_ADMIN_TOKEN;
    delete process.env.RECONCILIATION_RELEASE_TOKEN;
    mockIsArbiterEnabled.mockReturnValue(true);
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.DASHBOARD_ADMIN_TOKEN;
    delete process.env.RECONCILIATION_RELEASE_TOKEN;
  });

  it('T-207-META-1: en dev y sin ninguna variable, TODA ruta no-GET del panel responde 503 y ningún service se invoca', async () => {
    const routes = await registeredRoutes();
    const writes = routes.filter((r) => !READ_METHODS.has(r.method));
    // Si el plugin dejara de registrar escrituras, este guard se volvería vacuo y verde.
    expect(writes.length).toBeGreaterThan(0);

    const app = await buildApp();
    const openings: string[] = [];
    for (const { method, url } of writes) {
      const res = await app.inject({
        method: method as 'POST',
        // `/:intentId` → un id cualquiera: el gate corre ANTES de mirar el parámetro.
        url: url.replace(/\/:[^/]+/g, '/i1'),
        payload: {},
      });
      if (res.statusCode !== 503)
        openings.push(`${method} ${url} → ${res.statusCode}`);
    }
    expect(openings).toEqual([]);

    // Ningún money-path tocado por esos requests anónimos.
    for (const spy of [
      mockResolveHold,
      mockResolveIntent,
      mockResolveWithHop2Evidence,
      mockReleaseHop2Lease,
    ]) {
      expect(spy).not.toHaveBeenCalled();
    }
    await app.close();
  });

  it('T-207-META-2: en las MISMAS condiciones, la lectura del panel sigue abierta en dev (no se cerró de más)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/api/stats',
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe('AR-202 B3 — /resolve deja de nombrar una acción inexistente', () => {
  it('T-AR1: `awaiting_manual_settle_evidence` nombra los DOS endpoints que sí existen', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secret';
    mockResolveIntent.mockResolvedValue({
      status: 'awaiting_manual_settle_evidence',
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/api/reconciliation/i1/resolve',
      headers: { 'x-admin-token': 'secret' },
    });
    const action = String(res.json().action_required);
    expect(action).toContain('hop2-evidence');
    expect(action).toContain('release-lease');
    await app.close();
  });
});
