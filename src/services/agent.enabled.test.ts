/**
 * Baja / alta de un agente SELF-PUBLISHED (`a2a_agents.enabled`).
 *
 * EL HUECO. La columna `enabled` ya existía y el lado LECTOR ya la respetaba
 * (`listAsAgents` / `getBySlugAsAgent` / `listPublisherAnchors` filtran
 * `.eq('enabled', true)`), pero NO tenía productor: `publish` la escribe `true`
 * y ningún camino la podía volver a `false`. Un control cableado del lado que lee
 * y sin nadie del lado que escribe. La única baja disponible era `DELETE`, que es
 * destructiva (pierde `created_at` — ancla del carril de estreno — y
 * `payout_wallet`, y libera el slug para que lo tome otro).
 *
 * DOS BARRERAS, PROBADAS POR SEPARADO. Que un agente dado de baja no aparezca en
 * `/discover` lo sostienen dos cosas independientes, y cada test acá mata una sola:
 *   1. El filtro SQL `.eq('enabled', true)` de la query.
 *   2. El `status` DERIVADO de la fila (`agent.ts:mapRowToAgent`), que
 *      `discovery.ts:449` (`filter(a => a.status === 'active')`) vuelve a chequear.
 * El doble de supabase de este archivo NO aplica los `.eq()` a los datos (devuelve
 * lo que se le setea y REGISTRA los filtros): así la barrera 1 se prueba por el
 * filtro que la query declara, y la barrera 2 se prueba de verdad, dándole al
 * mapper una fila deshabilitada — que es exactamente lo que pasaría si alguien
 * borrara el filtro SQL.
 *
 * Camino real: `discoveryService.discover()` y `getAgent()` corren REALES sobre el
 * `publishedAgentService` REAL; lo único doblado es el cliente de supabase.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: {
    /** Filas que devuelve el SELECT de lista, tal cual (sin aplicar los `.eq`). */
    listData: [] as Record<string, unknown>[],
    /** Fila que devuelve `maybeSingle`/`single`. */
    row: null as Record<string, unknown> | null,
    updateCalled: false,
    updateArg: null as Record<string, unknown> | null,
    eqCalls: [] as Array<[string, unknown]>,
  },
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
    delete: () => builder,
    in: () => builder,
    eq: (col: string, val: unknown) => {
      state.eqCalls.push([col, val]);
      return builder;
    },
    order: () => Promise.resolve({ data: state.listData, error: null }),
    maybeSingle: () => Promise.resolve({ data: state.row, error: null }),
    single: () => Promise.resolve({ data: state.row, error: null }),
  });
  return { supabase: { from: () => builder } };
});

// Sin registries federados: la única fuente de `discover()` es la local.
vi.mock('./registry.js', () => ({
  registryService: {
    get: vi.fn(),
    getEnabled: vi.fn().mockResolvedValue([]),
    getWithSecrets: vi.fn(),
  },
}));
vi.mock('./reputation.js', () => ({
  reputationService: {
    computeReputationBatch: vi.fn().mockResolvedValue(new Map()),
    computeStandingBatch: vi
      .fn()
      .mockResolvedValue({ degraded: false, standings: new Map() }),
  },
}));
vi.mock('./identity.js', () => ({
  identityService: { resolveIdentityForAgent: vi.fn().mockResolvedValue(null) },
}));

import { publishedAgentService } from './agent.js';
import { discoveryService } from './discovery.js';
import { OwnershipMismatchError } from './security/errors.js';

const OWNER_A = 'tenant-A';
const OWNER_B = 'tenant-B';

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: 'remit-fx',
    name: 'Remit FX',
    description: '',
    capabilities: ['fx'],
    agent_url: 'https://api.example/agent',
    price_usdc: 0,
    metadata: null,
    enabled: true,
    owner_ref: OWNER_A,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.listData = [];
  state.row = null;
  state.updateCalled = false;
  state.updateArg = null;
  state.eqCalls = [];
});

describe('update(enabled) — la baja que faltaba', () => {
  it('POSITIVO: el dueño da de baja su agente → el UPDATE escribe enabled:false', async () => {
    state.row = row();

    await publishedAgentService.update('remit-fx', { enabled: false }, OWNER_A);

    expect(state.updateCalled).toBe(true);
    // Sólo el campo pedido: la baja no arrastra ningún otro cambio.
    expect(state.updateArg).toEqual({ enabled: false });
  });

  it('POSITIVO: el dueño puede volver a darlo de alta (la baja es REVERSIBLE, a diferencia de DELETE)', async () => {
    state.row = row({ enabled: false });

    await publishedAgentService.update('remit-fx', { enabled: true }, OWNER_A);

    expect(state.updateArg).toEqual({ enabled: true });
  });

  it('OWNERSHIP: el UPDATE de la baja filtra por owner_ref además del slug', async () => {
    state.row = row();

    await publishedAgentService.update('remit-fx', { enabled: false }, OWNER_A);

    // Sin este filtro la baja sería un IDOR: el cliente de supabase usa la
    // SERVICE_KEY (BYPASSRLS), así que el guard vive acá o no vive.
    expect(state.eqCalls).toContainEqual(['owner_ref', OWNER_A]);
    expect(state.eqCalls).toContainEqual(['slug', 'remit-fx']);
  });

  it('OWNERSHIP CRUZADO: un dueño NO puede dar de baja el agente de otro', async () => {
    state.row = row({ owner_ref: OWNER_A });

    await expect(
      publishedAgentService.update('remit-fx', { enabled: false }, OWNER_B),
    ).rejects.toBeInstanceOf(OwnershipMismatchError);

    // Ninguna mutación corrió: el guard corta ANTES del UPDATE.
    expect(state.updateCalled).toBe(false);
    expect(state.updateArg).toBeNull();
  });

  it('OWNERSHIP CRUZADO: un agente inexistente se rechaza igual que uno ajeno (disclosure-safe)', async () => {
    state.row = null;

    await expect(
      publishedAgentService.update('no-existe', { enabled: false }, OWNER_B),
    ).rejects.toBeInstanceOf(OwnershipMismatchError);
    expect(state.updateCalled).toBe(false);
  });

  it('NEGATIVO: un `enabled` que no es booleano se rechaza, sin UPDATE', async () => {
    // `"false"` es un string TRUTHY: persistirlo dejaría al agente al revés de lo
    // que su dueño pidió, que es peor que no tener baja.
    for (const bad of ['false', 0, 1, null, {}]) {
      state.row = row();
      state.updateCalled = false;
      await expect(
        publishedAgentService.update(
          'remit-fx',
          { enabled: bad as unknown as boolean },
          OWNER_A,
        ),
      ).rejects.toThrow(/Invalid enabled/);
      expect(state.updateCalled).toBe(false);
    }
  });
});

describe('efecto de la baja — /discover y elegibilidad en /compose', () => {
  it('BARRERA 1: la query de discovery declara el filtro enabled=true', async () => {
    state.listData = [row()];

    await publishedAgentService.listAsAgents();

    expect(state.eqCalls).toContainEqual(['enabled', true]);
  });

  it('BARRERA 1: la resolución por slug (la que usa /compose) declara el mismo filtro', async () => {
    state.row = row();

    await publishedAgentService.getBySlugAsAgent('remit-fx');

    expect(state.eqCalls).toContainEqual(['enabled', true]);
    // Y la fila deshabilitada no es resoluble → /compose no la puede elegir.
    state.eqCalls = [];
    state.row = null; // lo que devuelve el SELECT filtrado para una fila de baja
    expect(await publishedAgentService.getBySlugAsAgent('remit-fx')).toBeNull();
  });

  it('BARRERA 2: una fila dada de baja que igual llega al mapper sale como INACTIVE', async () => {
    // Es el escenario de "alguien borró el filtro SQL": el mapper no debe
    // anunciar como ACTIVO a un agente que la fila dice que está de baja.
    state.listData = [row({ enabled: false })];

    const agents = await publishedAgentService.listAsAgents();

    expect(agents[0]?.status).toBe('inactive');
  });

  it('BARRERA 2, CAMINO REAL: un agente de baja NO aparece en /discover aunque la query lo devuelva', async () => {
    state.listData = [row({ slug: 'de-baja', enabled: false })];

    const result = await discoveryService.discover({ limit: 10 });

    expect(result.agents.map((a) => a.slug)).not.toContain('de-baja');
    expect(result.agents).toHaveLength(0);
  });

  it('POSITIVO, CAMINO REAL: un agente activo SÍ aparece en /discover (la baja no rompe el caso normal)', async () => {
    state.listData = [row({ slug: 'activo', enabled: true })];

    const result = await discoveryService.discover({ limit: 10 });

    expect(result.agents.map((a) => a.slug)).toContain('activo');
    expect(result.agents[0]?.status).toBe('active');
  });

  it('CAMINO REAL: con dos agentes, la baja saca SÓLO al de baja', async () => {
    state.listData = [
      row({ slug: 'activo', enabled: true }),
      row({ slug: 'de-baja', enabled: false }),
    ];

    const result = await discoveryService.discover({ limit: 10 });

    expect(result.agents.map((a) => a.slug)).toEqual(['activo']);
  });
});
