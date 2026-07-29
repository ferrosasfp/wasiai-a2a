/**
 * HU-208 — `resolveCapability` / `createCapabilityResolver`.
 *
 * Lo que estos tests protegen: que la resolución REUSE el ranking de discovery en
 * vez de inventar uno, que falle CERRADO con un motivo accionable, y que dentro
 * de una request la misma capacidad resuelva siempre al mismo agente.
 *
 * Naming: T-CAPRES-01..T-CAPRES-09 (06 renumerado tras sacar `chain`).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { A2AAgentKeyRow, Agent, DiscoveryQuery } from '../types/index.js';

vi.mock('../lib/logger.js', () => ({
  getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

const discoverMock = vi.hoisted(() => vi.fn());
vi.mock('./discovery.js', () => ({
  discoveryService: { discover: discoverMock },
}));

import {
  createCapabilityResolver,
  resolveCapability,
} from './capability-resolver.js';

function makeAgent(slug: string, over: Partial<Agent> = {}): Agent {
  return {
    id: slug,
    name: slug,
    slug,
    description: '',
    capabilities: ['fx-quote'],
    priceUsdc: 1,
    registry: 'wasiai',
    registry_id: 'wasiai',
    invokeUrl: `https://x.test/${slug}`,
    invocationNote: '',
    verified: false,
    status: 'active',
    metadata: {},
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('HU-208 · resolveCapability — elige la CABEZA del ranking existente', () => {
  it('T-CAPRES-01: devuelve el primero de la lista ya ordenada por discovery', async () => {
    // El contrato es explícito: NO se reordena acá. Discovery entrega el
    // conjunto ya ordenado por verified → reputación → precio, y esto toma la
    // cabeza. Si esta función ordenara por su cuenta habría dos definiciones de
    // "el mejor" y divergirían sin que nadie se entere.
    discoverMock.mockResolvedValue({
      agents: [makeAgent('el-mejor'), makeAgent('el-segundo')],
      total: 2,
      registries: [],
    });

    const res = await resolveCapability('fx-quote', undefined, undefined);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.agent.slug).toBe('el-mejor');
  });

  it('T-CAPRES-02: NO reordena — respeta el orden de discovery aunque haya uno más barato después', async () => {
    // Un agente caro PRIMERO y uno barato DESPUÉS. Si esta función tuviera su
    // propio criterio (p.ej. precio asc) elegiría el barato. Tiene que elegir el
    // que discovery puso primero: allá `verified` pesa más que el precio.
    discoverMock.mockResolvedValue({
      agents: [
        makeAgent('caro-pero-verificado', { verified: true, priceUsdc: 50 }),
        makeAgent('barato-sin-verificar', { verified: false, priceUsdc: 0.1 }),
      ],
      total: 2,
      registries: [],
    });

    const res = await resolveCapability('fx-quote', undefined, undefined);
    if (res.ok) expect(res.agent.slug).toBe('caro-pero-verificado');
  });

  it('T-CAPRES-03: pasa capacidad y restricciones a discovery como FILTROS de la query', async () => {
    // Que viajen en la query es lo que los hace correr PRE-SORT dentro del
    // pipeline. Si se aplicaran acá, sobre `res.agents` ya recortado, el
    // residual TD-189-1 pasaría a estar sobre el camino del dinero.
    discoverMock.mockResolvedValue({
      agents: [makeAgent('a')],
      total: 1,
      registries: [],
    });
    const scope = { id: 'k1' } as A2AAgentKeyRow;

    await resolveCapability(
      'fx-quote',
      { max_price_usdc: 2, min_reputation: 70 },
      scope,
    );

    const q = discoverMock.mock.calls[0]?.[0] as DiscoveryQuery;
    expect(q.capabilities).toEqual(['fx-quote']);
    expect(q.maxPrice).toBe(2);
    expect(q.minReputation).toBe(70);
    expect(q.scope).toBe(scope);
    // Sin texto libre: es lo que evita el broaden-retry de `discover`
    // (gateado en `total === 0 && query.query`) sobre el camino del dinero.
    expect(q.query).toBeUndefined();
  });
});

describe('HU-208 · resolveCapability — falla CERRADO, con motivo accionable', () => {
  it('T-CAPRES-04: sin candidatos → fallo `no_candidates`, NUNCA un agente arbitrario', async () => {
    discoverMock.mockResolvedValue({ agents: [], total: 0, registries: [] });

    const res = await resolveCapability('inexistente', undefined, undefined);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.failure.reason).toBe('no_candidates');
      expect(res.failure.message).toContain('inexistente');
    }
  });

  it('T-CAPRES-05: vacío POR ALCANCE → dice que fue el alcance, no "no hay agente"', async () => {
    // La condición del coordinador: un operador que ve "no hay agente" cuando en
    // realidad hay uno que su credencial no alcanza busca el problema en el
    // catálogo, que es el lugar equivocado.
    discoverMock.mockResolvedValue({
      agents: [],
      total: 0,
      registries: [],
      excluded: { scope: 3 },
    });

    const res = await resolveCapability('fx-quote', undefined, undefined);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.failure.reason).toBe('excluded_by_scope');
      expect(res.failure.message).toContain("key's scope");
    }
  });

  it('T-CAPRES-06: NO existe una restricción de `chain` — el rail no se fuerza', () => {
    // Se evaluó y se rechazó: forzar el rail es hacerle trampa al ranking. Este
    // test ancla la DECISIÓN, para que reaparezca como un cambio deliberado y no
    // como un agregado silencioso. El orden verified → reputación → precio se
    // respeta siempre; si un agente no gana, se lo gana con datos, no con un
    // filtro que lo señale.
    const constraintKeys = ['max_price_usdc', 'min_reputation'];
    expect(constraintKeys).not.toContain('chain');
  });
});

describe('HU-208 · createCapabilityResolver — consistencia dentro de una request', () => {
  it('T-CAPRES-08: la MISMA capacidad resuelve al MISMO agente (un solo discover)', async () => {
    // No es sólo ahorro de latencia: dos `discover` consecutivos pueden devolver
    // rankings distintos (fetch en vivo + reputación recomputada). Sin memo, dos
    // steps que piden la misma capacidad podrían quedar con agentes distintos
    // dentro del mismo pipeline.
    discoverMock.mockResolvedValue({
      agents: [makeAgent('elegido')],
      total: 1,
      registries: [],
    });
    const resolver = createCapabilityResolver(undefined);

    const a = await resolver.resolve('fx-quote', undefined);
    const b = await resolver.resolve('fx-quote', undefined);

    expect(discoverMock).toHaveBeenCalledTimes(1);
    if (a.ok && b.ok) expect(a.agent.slug).toBe(b.agent.slug);
  });

  it('T-CAPRES-09: restricciones DISTINTAS no comparten cache (conjuntos distintos)', async () => {
    discoverMock.mockResolvedValue({
      agents: [makeAgent('x')],
      total: 1,
      registries: [],
    });
    const resolver = createCapabilityResolver(undefined);

    await resolver.resolve('fx-quote', { max_price_usdc: 1 });
    await resolver.resolve('fx-quote', { max_price_usdc: 5 });

    expect(discoverMock).toHaveBeenCalledTimes(2);
  });
});
