/**
 * Dashboard Live Trace — rutas (WKH-191x).
 *
 * AC-1: sin `DASHBOARD_ADMIN_TOKEN` → 503 en dev Y prod (FAIL-CLOSED), service intacto.
 * AC-2: con token configurado, header ausente o incorrecto → 401, service intacto.
 * AC-3: `GET /dashboard/trace` (HTML) responde sin token y NO trae datos de tenant.
 * AC-8: la pantalla no puede disparar un `/compose` (cada ejecución cuesta dinero).
 *
 * El test del gate está bajo MUTACIÓN: si se le saca el `preHandler` a
 * `/api/trace`, los casos AC-1/AC-2 se ponen rojos (verificado a mano en F3).
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

// ── Mocks de todo lo que dashboard.ts importa (cero supabase, cero adapters) ──
vi.mock('../services/event.js', () => ({
  eventService: {
    stats: vi.fn().mockResolvedValue({ ok: true }),
    recent: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../services/arbiter.js', () => ({
  arbiterService: { listHolds: vi.fn(), resolveHold: vi.fn() },
  isArbiterEnabled: () => false,
}));

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
    listPending: vi.fn(),
    driftCheck: vi.fn(),
    resolveIntent: vi.fn(),
  },
  ReconciliationError: MockReconciliationError,
}));

vi.mock('../adapters/escrow/debit-capture.js', () => ({
  isEscrowSettleEnabled: () => false,
}));

const mockSnapshot = vi.hoisted(() => vi.fn());
vi.mock('../services/trace.js', () => ({
  traceService: { snapshot: (...a: unknown[]) => mockSnapshot(...a) },
}));

import dashboardRoutes from './dashboard.js';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_ADMIN_TOKEN = process.env.DASHBOARD_ADMIN_TOKEN;

const PAYLOAD = {
  generatedAt: '2026-07-26T12:00:00.000Z',
  limit: 25,
  health: {
    chains: [],
    defaultChain: 'avalanche-fuji',
    lastCrossChainSettle: null,
    skipWindowHours: 24,
    skips: [],
    skipsTotal: 0,
    skipSignalPresent: false,
    skipScanLimit: 500,
    skipScanTruncated: false,
  },
  calls: [],
};

async function buildApp() {
  const app = Fastify();
  await app.register(dashboardRoutes, { prefix: '/dashboard' });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSnapshot.mockResolvedValue(PAYLOAD);
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

describe('AC-1: GET /dashboard/api/trace es FAIL-CLOSED sin token configurado', () => {
  it('dev (NODE_ENV ausente) + DASHBOARD_ADMIN_TOKEN ausente → 503 y NO lee datos', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/api/trace',
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('service_unavailable');
    // El punto del fail-closed: ni una query cross-tenant se ejecutó.
    expect(mockSnapshot).not.toHaveBeenCalled();
    await app.close();
  });

  it('prod + DASHBOARD_ADMIN_TOKEN ausente → 503 y NO lee datos', async () => {
    process.env.NODE_ENV = 'production';
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/api/trace',
    });
    expect(res.statusCode).toBe(503);
    expect(mockSnapshot).not.toHaveBeenCalled();
    await app.close();
  });

  it('regresión: /api/stats sigue siendo opt-in en dev (no se cambió el gate viejo)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/api/stats',
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe('AC-2: con token configurado, el header manda', () => {
  it('sin header X-Admin-Token → 401 y NO lee datos de tenant', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secreto-largo';
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/api/trace',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('unauthorized');
    expect(mockSnapshot).not.toHaveBeenCalled();
    await app.close();
  });

  it('token incorrecto (misma longitud) → 401 y NO lee datos', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secreto-largo';
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/api/trace',
      headers: { 'x-admin-token': 'secreto-corto' },
    });
    expect(res.statusCode).toBe(401);
    expect(mockSnapshot).not.toHaveBeenCalled();
    await app.close();
  });

  it('token incorrecto (otra longitud) → 401 sin lanzar', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secreto-largo';
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/api/trace',
      headers: { 'x-admin-token': 'x' },
    });
    expect(res.statusCode).toBe(401);
    expect(mockSnapshot).not.toHaveBeenCalled();
    await app.close();
  });

  it('token correcto → 200 con el snapshot', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secreto-largo';
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/api/trace',
      headers: { 'x-admin-token': 'secreto-largo' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(PAYLOAD);
    expect(mockSnapshot).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

describe('GET /dashboard/api/trace: querystring y errores', () => {
  it('pasa limit y windowHours al service', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secreto-largo';
    const app = await buildApp();
    await app.inject({
      method: 'GET',
      url: '/dashboard/api/trace?limit=5&windowHours=6',
      headers: { 'x-admin-token': 'secreto-largo' },
    });
    expect(mockSnapshot).toHaveBeenCalledWith({ limit: 5, windowHours: 6 });
    await app.close();
  });

  it('querystring basura NO viaja al service (el default manda)', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secreto-largo';
    const app = await buildApp();
    await app.inject({
      method: 'GET',
      url: '/dashboard/api/trace?limit=abc&windowHours=',
      headers: { 'x-admin-token': 'secreto-largo' },
    });
    expect(mockSnapshot).toHaveBeenCalledWith({});
    await app.close();
  });

  it('si el service falla, el cliente recibe un mensaje estático (sin detalle interno)', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secreto-largo';
    mockSnapshot.mockRejectedValue(
      new Error('permission denied for relation a2a_receipts'),
    );
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/api/trace',
      headers: { 'x-admin-token': 'secreto-largo' },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Failed to get trace' });
    expect(res.body).not.toContain('a2a_receipts');
    await app.close();
  });
});

describe('AC-3 / AC-8: la pantalla HTML', () => {
  it('responde 200 sin token y NO trae ningún dato de tenant', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard/trace' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    // El cascarón no puede tener nada del payload admin.
    expect(mockSnapshot).not.toHaveBeenCalled();
    for (const forbidden of [
      'owner_ref',
      'tenant-',
      'orchestration_id',
      '0x',
    ]) {
      expect(res.body).not.toContain(forbidden);
    }
    await app.close();
  });

  it('AC-8: el único fetch de la pantalla es al trace, y no hay POST', async () => {
    const html = readFileSync(
      resolve(process.cwd(), 'src/static/dashboard-trace.html'),
      'utf-8',
    );
    const fetches = html.match(/fetch\(/g) ?? [];
    expect(fetches).toHaveLength(1);
    expect(html).toContain("BASE + '/dashboard/api/trace'");
    // Ni un botón que ejecute un pipeline: cada ejecución real cuesta dinero.
    expect(html).not.toContain("method: 'POST'");
    expect(html).not.toContain('/compose');
    expect(html).not.toContain('/orchestrate');
  });

  it('el token viaja por header, NUNCA en la URL (los query params quedan en logs)', async () => {
    const html = readFileSync(
      resolve(process.cwd(), 'src/static/dashboard-trace.html'),
      'utf-8',
    );
    expect(html).toContain("'X-Admin-Token': token()");
    expect(html).not.toContain('token=');
  });

  it('el JS inline PARSEA (un typo en la pantalla no se ve en ningún otro test)', async () => {
    const html = readFileSync(
      resolve(process.cwd(), 'src/static/dashboard-trace.html'),
      'utf-8',
    );
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
    expect(script).toBeTruthy();
    // `new Function` compila sin ejecutar: valida sintaxis sin necesitar un DOM.
    expect(() => new Function(script ?? '')).not.toThrow();
  });

  it('la pantalla avisa cuando los datos quedaron viejos (no miente en silencio)', async () => {
    const html = readFileSync(
      resolve(process.cwd(), 'src/static/dashboard-trace.html'),
      'utf-8',
    );
    expect(html).toContain('DATOS VIEJOS');
    expect(html).toContain('markStale');
    // Auto-refresh de ~10s con marca de hora de la última actualización.
    expect(html).toContain('var REFRESH_MS = 10000;');
    expect(html).toContain('Actualizado ');
  });
});
