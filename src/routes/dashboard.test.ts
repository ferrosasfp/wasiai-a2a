/**
 * Dashboard Routes Tests — WKH-AUDIT-A2A
 * AC-1: prod + token ausente → 503 service_unavailable
 * AC-2: dev + token ausente → passthrough 200
 * reg:  prod + token OK → 200; token MAL → 401 (CD-5 intacto)
 * AC-3/AC-4: aserto sobre .env.example + docs naming drift
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
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

describe('AR-202 B3 — POST /api/reconciliation/:id/release-lease', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('T-RLR2: con token + atestación completa → delega y devuelve el outcome', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secret';
    mockReleaseHop2Lease.mockResolvedValue({ status: 'lease_released' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/api/reconciliation/i1/release-lease',
      headers: { 'x-admin-token': 'secret' },
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
    process.env.DASHBOARD_ADMIN_TOKEN = 'secret';
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/api/reconciliation/i1/release-lease',
      headers: { 'x-admin-token': 'secret' },
      payload: { resolvedBy: 'ops@wasiai' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error_code: 'ATTESTATION_REQUIRED' });
    expect(mockReleaseHop2Lease).not.toHaveBeenCalled();
    await app.close();
  });

  it('T-RLR4: sin `resolvedBy` → 400', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secret';
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/api/reconciliation/i1/release-lease',
      headers: { 'x-admin-token': 'secret' },
      payload: { note: 'n' },
    });
    expect(res.statusCode).toBe(400);
    expect(mockReleaseHop2Lease).not.toHaveBeenCalled();
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
