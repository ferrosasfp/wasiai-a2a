/**
 * WKH-365 — las dos rutas del tablero de las tres preguntas.
 *
 * T-GATE-1: sin `DASHBOARD_ADMIN_TOKEN` → 503 en dev Y en prod (FAIL-CLOSED), y
 *           el service no se llamó.
 * T-GATE-2: token ausente o incorrecto → 401, service intacto.
 * T-RO-1:   ningún handler llama a algo que escriba o gaste.
 *
 * Mocks TOTALES de lo que `dashboard.ts` importa: cero Supabase, cero adapters,
 * cero red.
 */

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

vi.mock('../services/trace.js', () => ({
  traceService: { snapshot: vi.fn() },
}));

const mockTablero = vi.hoisted(() => vi.fn());
vi.mock('../services/tablero.js', () => ({
  tableroService: { snapshot: (...a: unknown[]) => mockTablero(...a) },
}));

import dashboardRoutes from './dashboard.js';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_ADMIN_TOKEN = process.env.DASHBOARD_ADMIN_TOKEN;

const SNAPSHOT = {
  servedAt: '2026-08-26T12:00:00.000Z',
  caja: {
    status: 'ok',
    budget: { '900001': '14.97' },
    daily_limit_usd: 2,
    daily_spent_usd: 0.03,
    daily_reset_at: '2026-08-27T00:00:00.000Z',
    is_active: true,
  },
  reputacion: { status: 'ok', agentes: [], ventana: 'últimos 30 días' },
  escrows: {
    status: 'ok',
    escrows_vivos: 2,
    usdc_bloqueado: '12.5',
    otros_mints_count: 0,
    vencidos: 1,
  },
};

const TODO_SIN_DATO = {
  servedAt: '2026-08-26T12:00:00.000Z',
  caja: { status: 'sin_dato', reason: 'no_configurado' },
  reputacion: { status: 'sin_dato', reason: 'historial_ilegible' },
  escrows: { status: 'sin_dato', reason: 'rpc_error' },
};

async function buildApp() {
  const app = Fastify();
  await app.register(dashboardRoutes, { prefix: '/dashboard' });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  mockTablero.mockResolvedValue(SNAPSHOT);
  delete process.env.NODE_ENV;
  delete process.env.DASHBOARD_ADMIN_TOKEN;
});

afterEach(() => {
  vi.useRealTimers();
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

// ── T-GATE-1 ─────────────────────────────────────────────────────────────────

describe('T-GATE-1: el API es FAIL-CLOSED sin token configurado', () => {
  it('dev (NODE_ENV ausente) → 503, service intacto y sin datos en el body', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/api/tres-preguntas',
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('service_unavailable');
    expect(mockTablero).not.toHaveBeenCalled();
    expect(res.body).not.toContain('budget');
    expect(res.body).not.toContain('14.97');
    await app.close();
  });

  it('prod → 503 también (el opt-in dejaría la superficie abierta en dev)', async () => {
    process.env.NODE_ENV = 'production';
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/api/tres-preguntas',
    });

    expect(res.statusCode).toBe(503);
    expect(mockTablero).not.toHaveBeenCalled();
    await app.close();
  });

  it('regresión: /api/stats sigue siendo opt-in en dev (no se tocó el gate viejo)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/api/stats',
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

// ── T-GATE-2 ─────────────────────────────────────────────────────────────────

describe('T-GATE-2: con token configurado, el header manda', () => {
  it('sin header → 401 y el service no se llamó', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secreto-largo';
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/api/tres-preguntas',
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('unauthorized');
    expect(mockTablero).not.toHaveBeenCalled();
    await app.close();
  });

  it('token incorrecto (misma longitud) → 401', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secreto-largo';
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/api/tres-preguntas',
      headers: { 'x-admin-token': 'secreto-corto' },
    });

    expect(res.statusCode).toBe(401);
    expect(mockTablero).not.toHaveBeenCalled();
    await app.close();
  });

  it('token incorrecto (otra longitud) → 401 sin lanzar', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secreto-largo';
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/api/tres-preguntas',
      headers: { 'x-admin-token': 'x' },
    });

    expect(res.statusCode).toBe(401);
    expect(mockTablero).not.toHaveBeenCalled();
    await app.close();
  });

  it('control POSITIVO: token correcto → 200 con el snapshot', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secreto-largo';
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/api/tres-preguntas',
      headers: { 'x-admin-token': 'secreto-largo' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(SNAPSHOT);
    expect(mockTablero).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('las tres fuentes sin dato siguen siendo 200 (no es un error del gateway)', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secreto-largo';
    mockTablero.mockResolvedValue(TODO_SIN_DATO);
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/api/tres-preguntas',
      headers: { 'x-admin-token': 'secreto-largo' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(TODO_SIN_DATO);
    await app.close();
  });

  it('si el service lanza → 500 con mensaje estático (sin el detalle)', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secreto-largo';
    mockTablero.mockRejectedValue(new Error('detalle-interno-secreto'));
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/api/tres-preguntas',
      headers: { 'x-admin-token': 'secreto-largo' },
    });

    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('detalle-interno-secreto');
    await app.close();
  });
});

// ── La página HTML ───────────────────────────────────────────────────────────

describe('GET /dashboard/tres-preguntas (el cascarón)', () => {
  it('responde sin token y NO trae datos de tenant', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/tres-preguntas',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('X-Admin-Token');
    expect(res.body).not.toContain('14.97');
    expect(mockTablero).not.toHaveBeenCalled();
    await app.close();
  });

  it('T-RO-1: sólo hay GET, y ningún handler llama a algo que escriba o gaste', async () => {
    const app = await buildApp();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await app.inject({
        method,
        url: '/dashboard/api/tres-preguntas',
      });
      expect(res.statusCode).toBe(404);
    }
    const html = await app.inject({
      method: 'POST',
      url: '/dashboard/tres-preguntas',
    });
    expect(html.statusCode).toBe(404);
    await app.close();
  });
});

// ── El cache por tarjeta ─────────────────────────────────────────────────────

describe('cache por tarjeta, no global', () => {
  it('una tarjeta fresca NO se vuelve a leer; el service la recibe como cacheada', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secreto-largo';
    const app = await buildApp();
    const headers = { 'x-admin-token': 'secreto-largo' };

    await app.inject({
      method: 'GET',
      url: '/dashboard/api/tres-preguntas',
      headers,
    });
    await app.inject({
      method: 'GET',
      url: '/dashboard/api/tres-preguntas',
      headers,
    });

    expect(mockTablero).toHaveBeenCalledTimes(2);
    // La primera pasada no tenía nada cacheado.
    expect(mockTablero.mock.calls[0]?.[0]).toEqual({});
    // La segunda le pasa las tres, así que ninguna fuente se vuelve a consultar.
    expect(mockTablero.mock.calls[1]?.[0]).toEqual({
      caja: SNAPSHOT.caja,
      reputacion: SNAPSHOT.reputacion,
      escrows: SNAPSHOT.escrows,
    });
    await app.close();
  });

  it('el "sin dato" se cachea MENOS que el "ok" (15 s contra 60 s)', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secreto-largo';
    mockTablero.mockResolvedValue({
      ...SNAPSHOT,
      escrows: { status: 'sin_dato', reason: 'rpc_error' },
    });
    const app = await buildApp();
    const headers = { 'x-admin-token': 'secreto-largo' };

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T12:00:00.000Z'));
    await app.inject({
      method: 'GET',
      url: '/dashboard/api/tres-preguntas',
      headers,
    });

    // A los 20 s: el sin_dato ya venció (15 s), los dos `ok` no (60 s).
    vi.setSystemTime(new Date('2026-08-26T12:00:20.000Z'));
    await app.inject({
      method: 'GET',
      url: '/dashboard/api/tres-preguntas',
      headers,
    });

    const segunda = mockTablero.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(Object.keys(segunda).sort()).toEqual(['caja', 'reputacion']);
    expect(segunda.escrows).toBeUndefined();
    vi.useRealTimers();
    await app.close();
  });

  it('N requests SIMULTÁNEAS son UNA sola lectura (el cache solo no dedupe)', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secreto-largo';
    // El service tarda: es la ventana en la que el cache todavía no se escribió
    // (se escribe DESPUÉS del await) y por la que, sin dedupe, entran las 8.
    // Se juntan TODOS los resolvers, no sólo el último: si el dedupe no está,
    // las 8 lecturas tienen que poder terminar igual, para que este test muera
    // por el `toHaveBeenCalledTimes(1)` y no por un timeout (que sería rojo
    // igual, pero no diría cuántas lecturas hubo).
    const resolvers: Array<(v: unknown) => void> = [];
    mockTablero.mockImplementation(
      () =>
        new Promise((r) => {
          resolvers.push(r);
        }),
    );
    const app = await buildApp();
    const headers = { 'x-admin-token': 'secreto-largo' };

    const enVuelo = Array.from({ length: 8 }, () =>
      app.inject({
        method: 'GET',
        url: '/dashboard/api/tres-preguntas',
        headers,
      }),
    );
    // Que las 8 hayan llegado al handler antes de que ninguna termine.
    await new Promise((r) => setTimeout(r, 0));
    const lecturasEnVuelo = resolvers.length;
    for (const r of resolvers) r(SNAPSHOT);
    const respuestas = await Promise.all(enVuelo);

    // 8 requests, UNA lectura de las tres fuentes.
    expect(lecturasEnVuelo).toBe(1);
    expect(mockTablero).toHaveBeenCalledTimes(1);
    for (const res of respuestas) {
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(SNAPSHOT);
    }
    await app.close();
  });

  it('la lectura en vuelo se limpia si RECHAZA (no queda una promesa muerta)', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secreto-largo';
    mockTablero.mockRejectedValueOnce(new Error('boom'));
    const app = await buildApp();
    const headers = { 'x-admin-token': 'secreto-largo' };

    const rota = await app.inject({
      method: 'GET',
      url: '/dashboard/api/tres-preguntas',
      headers,
    });
    expect(rota.statusCode).toBe(500);

    // Si el rechazo dejara la promesa colgada en el closure, ésta se colgaría
    // del mismo error y devolvería 500 para siempre.
    mockTablero.mockResolvedValue(SNAPSHOT);
    const sana = await app.inject({
      method: 'GET',
      url: '/dashboard/api/tres-preguntas',
      headers,
    });

    expect(sana.statusCode).toBe(200);
    expect(sana.json()).toEqual(SNAPSHOT);
    await app.close();
  });

  it('una tarjeta servida del cache NO renueva su vencimiento (el cache no es eterno)', async () => {
    process.env.DASHBOARD_ADMIN_TOKEN = 'secreto-largo';
    const app = await buildApp();
    const headers = { 'x-admin-token': 'secreto-largo' };

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T12:00:00.000Z'));
    await app.inject({
      method: 'GET',
      url: '/dashboard/api/tres-preguntas',
      headers,
    });

    // Cuatro recargas dentro de la ventana de 60 s.
    for (const s of [10, 20, 30, 50]) {
      vi.setSystemTime(new Date(`2026-08-26T12:00:${s}.000Z`));
      await app.inject({
        method: 'GET',
        url: '/dashboard/api/tres-preguntas',
        headers,
      });
    }
    // A los 61 s la entrada tiene que haber vencido igual: si cada recarga
    // hubiera pisado el `expiresAt`, acá seguiría cacheada.
    vi.setSystemTime(new Date('2026-08-26T12:01:01.000Z'));
    await app.inject({
      method: 'GET',
      url: '/dashboard/api/tres-preguntas',
      headers,
    });

    expect(mockTablero.mock.calls.at(-1)?.[0]).toEqual({});
    vi.useRealTimers();
    await app.close();
  });
});
