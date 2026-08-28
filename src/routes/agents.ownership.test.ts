/**
 * Agents Routes — Ownership / anti-IDOR integration tests (WKH-134).
 *
 * Cubre AC-4 / DT-2 (cross-owner update/delete → 404 disclosure-safe,
 * logOwnershipMismatch, sin mutación). Usa el service REAL + supabase mockeado
 * (in-memory) + route real + middleware mockeado, para ejercitar el guard de
 * ownership end-to-end. `logOwnershipMismatch` se mockea para asertar la llamada
 * PII-safe manteniendo la clase real `OwnershipMismatchError` (instanceof).
 *
 * ── WKH-SEC-03 · QUÉ GARANTIZA ESTE ARCHIVO Y QUÉ NO ─────────────────────
 *
 * Este archivo verifica que **la consulta se escribió** (el mock registra los
 * `.eq()` en `:72`), **no que aisló**: `maybeSingle`/`single` (`:76-77`)
 * devuelven `state.row` sin importar qué columna ni qué valor se filtró.
 *
 * `T-PUB-08` y `T-PUB-09` pasan por el **pre-chequeo en JS** de
 * `src/services/agent.ts:886`, no por el filtro de la consulta. Verificado por
 * mutación: borrando `src/services/agent.ts:900` (el `.eq('owner_ref', …)` del
 * DELETE) este archivo queda **VERDE, 9/9**.
 *
 * El aislamiento por filtro de `publishedAgentService` se prueba en
 * **`src/services/agent.ownership.test.ts`**, con un falso que aplica los
 * filtros pedidos sobre una tabla con dos dueños.
 *
 * `T-143B-06` (`:211`) sí es un espía de argumento sobre el UPDATE, y ese sitio
 * no necesita más: es la razón por la que la línea del UPDATE de `agent.ts` no
 * estaba entre los sitios sin cobertura.
 *
 * El mock NO se arregla acá a propósito: cambiar el contrato de `state.eqCalls`
 * y `state.row` rompería los tests preexistentes de este archivo, incluido
 * `T-143B-06`, que depende deliberadamente de ese espía.
 */

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

// ── Estado del supabase mock (in-memory) ───────────────────────────
const { state, mockLog } = vi.hoisted(() => ({
  state: {
    row: null as Record<string, unknown> | null,
    updateCalled: false,
    updateArg: null as Record<string, unknown> | null,
    deleteCalled: false,
    eqCalls: [] as Array<[string, unknown]>,
  },
  mockLog: vi.fn(),
}));

vi.mock('../lib/supabase.js', () => {
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    select: () => builder,
    insert: () => builder,
    update: (arg: Record<string, unknown>) => {
      state.updateCalled = true;
      state.updateArg = arg;
      return builder;
    },
    delete: () => {
      state.deleteCalled = true;
      return builder;
    },
    eq: (col: string, val: unknown) => {
      state.eqCalls.push([col, val]);
      return builder;
    },
    order: () => Promise.resolve({ data: [], error: null }),
    maybeSingle: () => Promise.resolve({ data: state.row, error: null }),
    single: () => Promise.resolve({ data: state.row, error: null }),
  });
  return { supabase: { from: () => builder } };
});

// logOwnershipMismatch mockeado; OwnershipMismatchError real (instanceof).
vi.mock('../services/security/errors.js', async () => {
  const actual = await vi.importActual<
    typeof import('../services/security/errors.js')
  >('../services/security/errors.js');
  return { ...actual, logOwnershipMismatch: mockLog };
});

let currentOwner: string | null = 'tenant-B';
vi.mock('../middleware/a2a-key.js', () => ({
  requireA2AKey: () => [
    async (request: { a2aKeyRow?: { id: string; owner_ref: string } }) => {
      if (currentOwner === null) return;
      request.a2aKeyRow = { id: 'fake-key-id', owner_ref: currentOwner };
    },
  ],
}));

/**
 * 🔴 WKH-316 — este archivo usa el service REAL, así que la defense-in-depth de
 * `publish`/`update` llama a `validatePaymentBlock`. Sin este mock el registry
 * de adapters está SIN inicializar y `getAdaptersBundle` devuelve `undefined`
 * para toda chain: cualquier PATCH con `payment` moriría en el paso 3 con un 422
 * en vez de llegar al guard de dueño, y T-316-12 estaría midiendo otra cosa.
 * `importOriginal` + spread por lo de siempre: sin el spread, el resto de los
 * exports queda `undefined`.
 */
const INITIALIZED_CHAINS = ['solana-devnet', 'avalanche-fuji'];
vi.mock('../adapters/registry.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../adapters/registry.js')>();
  return {
    ...actual,
    getInitializedChainKeys: () => INITIALIZED_CHAINS,
    getAdaptersBundle: (chainKey?: string) =>
      chainKey !== undefined && INITIALIZED_CHAINS.includes(chainKey)
        ? { payment: { supportedTokens: [{ symbol: 'USDC' }] } }
        : undefined,
  };
});

vi.mock('../lib/operator-address.js', () => ({
  resolveOperatorAddress: () => Promise.resolve(null),
}));

import agentsRoutes from './agents.js';

const OWNER_A_ROW = {
  slug: 'a-owned-agent',
  name: 'A Owned Agent',
  description: '',
  capabilities: ['x'],
  agent_url: 'https://a.example/agent',
  price_usdc: 0,
  metadata: null,
  enabled: true,
  owner_ref: 'tenant-A',
  created_at: new Date().toISOString(),
};

describe('agents routes — ownership / anti-IDOR (WKH-134)', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();
    await app.register(agentsRoutes, { prefix: '/agents' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    currentOwner = 'tenant-B';
    state.row = { ...OWNER_A_ROW };
    state.updateCalled = false;
    state.updateArg = null;
    state.deleteCalled = false;
    state.eqCalls = [];
  });

  // ── T-PUB-08 ─────────────────────────────────────────────────────
  it('T-PUB-08: owner B PATCH slug of owner A → 404, logOwnershipMismatch, UPDATE not run', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/a-owned-agent',
      payload: { name: 'stolen' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Agent not found' });

    expect(mockLog).toHaveBeenCalledTimes(1);
    expect(mockLog.mock.calls[0]?.[0]).toMatchObject({
      op: 'agentPublishUpdate',
      resourceId: 'a-owned-agent',
      callerOwnerRef: 'tenant-B',
      actualOwnerRef: 'tenant-A',
    });
    // Ninguna mutación se ejecutó (el guard corta antes del UPDATE).
    expect(state.updateCalled).toBe(false);
  });

  // ── T-PUB-09 ─────────────────────────────────────────────────────
  it('T-PUB-09: owner B DELETE slug of owner A → 404, logOwnershipMismatch, DELETE not run', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/agents/a-owned-agent',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Agent not found' });

    expect(mockLog).toHaveBeenCalledTimes(1);
    expect(mockLog.mock.calls[0]?.[0]).toMatchObject({
      op: 'agentPublishDelete',
      resourceId: 'a-owned-agent',
      callerOwnerRef: 'tenant-B',
      actualOwnerRef: 'tenant-A',
    });
    expect(state.deleteCalled).toBe(false);
  });

  // ── WKH-143b ──────────────────────────────────────────────────────
  const VALID_WALLET = '0x1111111111111111111111111111111111111111';

  // T-143B-06 (AC-2) — owner PATCHes own slug with payoutWallet → 200, guarded.
  it('T-143B-06: owner PATCH own slug with payoutWallet → 200, UPDATE ran under owner_ref guard, only payout_wallet touched (AC-2)', async () => {
    currentOwner = 'tenant-A'; // matches OWNER_A_ROW.owner_ref

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/a-owned-agent',
      payload: { payoutWallet: VALID_WALLET },
    });

    expect(res.statusCode).toBe(200);
    expect(state.updateCalled).toBe(true);
    // Ownership guard aplicado: el UPDATE filtró por owner_ref del caller.
    expect(state.eqCalls).toContainEqual(['owner_ref', 'tenant-A']);
    // Solo el campo del body entró al updateRow — nada más se tocó.
    expect(state.updateArg).toEqual({ payout_wallet: VALID_WALLET });
    expect(mockLog).not.toHaveBeenCalled();
  });

  // T-143B-07 (AC-3/CD-5) — owner PATCH with invalid payoutWallet → 422.
  it('T-143B-07: owner PATCH invalid payoutWallet → 422, UPDATE not run (AC-3/CD-5)', async () => {
    currentOwner = 'tenant-A';

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/a-owned-agent',
      payload: { payoutWallet: '0xshort' },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('Invalid payoutWallet');
    expect(state.updateCalled).toBe(false);
  });

  // T-143B-08 (AC-6/CD-2) — owner B PATCH slug of owner A with payout/referrer → 404.
  it('T-143B-08: owner B PATCH slug of owner A with payoutWallet/referrerRef → 404, no mutation, logOwnershipMismatch (AC-6/CD-2)', async () => {
    currentOwner = 'tenant-B';

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/a-owned-agent',
      payload: { payoutWallet: VALID_WALLET, referrerRef: 'r-abc' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Agent not found' });
    expect(state.updateCalled).toBe(false);
    expect(state.updateArg).toBeNull();
    expect(mockLog).toHaveBeenCalledTimes(1);
    expect(mockLog.mock.calls[0]?.[0]).toMatchObject({
      op: 'agentPublishUpdate',
      resourceId: 'a-owned-agent',
      callerOwnerRef: 'tenant-B',
      actualOwnerRef: 'tenant-A',
    });
  });

  // ── Baja / alta del agente (`enabled`) ────────────────────────────
  //
  // La baja es una MUTACIÓN DE ESTADO, así que pasa por el mismo guard anti-IDOR
  // que el resto del PATCH: sin el filtro por `owner_ref` cualquiera podría sacar
  // de circulación el agente de otro. Se ejercita por la ruta real (HTTP → route →
  // service → supabase) para que lo que se prueba sea el camino, no la condición.

  it('BAJA — el dueño da de baja su agente → 200, UPDATE bajo el guard de owner_ref, sólo enabled tocado', async () => {
    currentOwner = 'tenant-A'; // coincide con OWNER_A_ROW.owner_ref

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/a-owned-agent',
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(200);
    expect(state.updateCalled).toBe(true);
    expect(state.eqCalls).toContainEqual(['owner_ref', 'tenant-A']);
    expect(state.updateArg).toEqual({ enabled: false });
    expect(mockLog).not.toHaveBeenCalled();
  });

  it('ALTA — el dueño lo vuelve a habilitar → 200 (la baja es reversible)', async () => {
    currentOwner = 'tenant-A';
    state.row = { ...OWNER_A_ROW, enabled: false };

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/a-owned-agent',
      payload: { enabled: true },
    });

    expect(res.statusCode).toBe(200);
    expect(state.updateArg).toEqual({ enabled: true });
    expect(state.eqCalls).toContainEqual(['owner_ref', 'tenant-A']);
  });

  it('BAJA CRUZADA — owner B da de baja el agente de owner A → 404, sin mutación, logOwnershipMismatch', async () => {
    currentOwner = 'tenant-B';

    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/a-owned-agent',
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Agent not found' });
    // El agente de A sigue en pie: no corrió ningún UPDATE.
    expect(state.updateCalled).toBe(false);
    expect(state.updateArg).toBeNull();
    expect(mockLog).toHaveBeenCalledTimes(1);
    expect(mockLog.mock.calls[0]?.[0]).toMatchObject({
      op: 'agentPublishUpdate',
      resourceId: 'a-owned-agent',
      callerOwnerRef: 'tenant-B',
      actualOwnerRef: 'tenant-A',
    });
  });

  it('BAJA con `enabled` no booleano → 422, UPDATE no corre', async () => {
    currentOwner = 'tenant-A';

    for (const bad of ['false', 0, 1, null]) {
      state.updateCalled = false;
      const res = await app.inject({
        method: 'PATCH',
        url: '/agents/a-owned-agent',
        payload: { enabled: bad },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe('Invalid enabled');
      expect(state.updateCalled).toBe(false);
    }
  });

  // ── WKH-316 · el bloque `payment` en el PATCH ────────────────────

  const SOL_PAYTO = 'So11111111111111111111111111111111111111112';
  const VALID_PAYMENT = {
    method: 'x402',
    chain: 'solana-devnet',
    contract: SOL_PAYTO,
    asset: 'USDC',
  };

  it('T-316-12 · AC-7: owner B PATCH payment sobre el agente de A → 404, y CERO update', async () => {
    // ⚠️ Lo que este test prueba, y lo que NO. Prueba que el bloque `payment`
    // VÁLIDO no le abre a un no-dueño una puerta que los otros campos no le
    // abren: sigue saliendo por `OwnershipMismatchError` → 404 disclosure-safe,
    // sin tocar la fila. NO prueba aislamiento por filtro — el mock de este
    // archivo devuelve `state.row` sin mirar los `.eq()` (ver el docblock de
    // arriba). El aislamiento vive en `src/services/agent.ownership.test.ts`.
    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/a-owned-agent',
      payload: { payment: VALID_PAYMENT },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('Agent not found');
    expect(state.updateCalled).toBe(false);
    expect(mockLog).toHaveBeenCalledTimes(1);
  });

  it('T-316-12 (gemelo): el MISMO PATCH lo hace el dueño → 200 y el update corre', async () => {
    // Sin este gemelo, un `return 404` incondicional en el PATCH pasaría el test
    // de arriba (CD-A4).
    currentOwner = 'tenant-A';
    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/a-owned-agent',
      payload: { payment: VALID_PAYMENT },
    });

    expect(res.statusCode).toBe(200);
    expect(state.updateCalled).toBe(true);
    expect(mockLog).not.toHaveBeenCalled();
  });

  it('el 422 del bloque inválido GANA sobre el 404 de dueño, y no toca la fila', async () => {
    // Consecuencia declarada del diseño: el guard del route corre ANTES que el
    // guard de dueño, que vive dentro de `update()`. Un no-dueño con un bloque
    // inválido recibe 422, no 404. Disclosure: cero — la respuesta depende sólo
    // de su propio input y de config ya pública por `GET /capabilities`.
    const res = await app.inject({
      method: 'PATCH',
      url: '/agents/a-owned-agent',
      payload: { payment: { ...VALID_PAYMENT, chain: 'polygon' } },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error_code).toBe('INVALID_PAYMENT_CHAIN');
    expect(state.updateCalled).toBe(false);
  });
});
