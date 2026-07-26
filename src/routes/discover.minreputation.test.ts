/**
 * Discover Routes — validación de `minReputation` (fix-pack P1, hallazgo 2).
 *
 * Antes: `parseFloat('abc')` = NaN y `NaN != null` → el valor llegaba al query.
 * Con el filtro implementado eso habría dado 0 resultados con HTTP 200, o sea
 * cambiar un P1 silencioso por otro. Ahora es 400 explícito.
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

// Sólo se mockea el fanout. El validador vive en `../lib/discovery-query.js`
// (módulo leaf, NO mockeado): la validación real es lo que se testea acá.
vi.mock('../services/discovery.js', () => ({
  discoveryService: {
    discover: vi.fn().mockResolvedValue({ agents: [], total: 0 }),
    getAgent: vi.fn().mockResolvedValue(null),
  },
}));

import { discoveryService } from '../services/discovery.js';
import discoverRoutes from './discover.js';

const mockDiscover = vi.mocked(discoveryService.discover);

describe('minReputation: validación en la ruta', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();
    await app.register(discoverRoutes, { prefix: '/discover' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockDiscover.mockClear();
    mockDiscover.mockResolvedValue({ agents: [], total: 0, registries: [] });
  });

  it('T-R1: GET con minReputation válido → 200 y el valor llega al service', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/discover?minReputation=50',
    });

    expect(res.statusCode).toBe(200);
    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ minReputation: 50 }),
    );
  });

  it('T-R2: GET con minReputation no numérico → 400, NO 200-vacío', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/discover?minReputation=abc',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_MIN_REPUTATION');
    // El fanout NO se ejecuta: no se gasta un round-trip a los registries.
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it('T-R3: GET con minReputation fuera de rango → 400', async () => {
    for (const v of ['-1', '101', '1000']) {
      const res = await app.inject({
        method: 'GET',
        url: `/discover?minReputation=${v}`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_MIN_REPUTATION');
    }
  });

  it('T-R4: el mensaje del 400 explicita la escala 0-100', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/discover?minReputation=abc',
    });

    expect(res.json().error).toMatch(/0.*100/);
  });

  it('T-R5: POST con minReputation válido → 200 y el valor llega al service', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/discover',
      payload: { minReputation: 42 },
    });

    expect(res.statusCode).toBe(200);
    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ minReputation: 42 }),
    );
  });

  it('T-R6: POST con minReputation inválido → 400', async () => {
    for (const v of ['abc', -5, 200, null]) {
      mockDiscover.mockClear();
      const res = await app.inject({
        method: 'POST',
        url: '/discover',
        payload: { minReputation: v },
      });
      if (v === null) {
        // null = ausente (`!= null` es false) → no filtra, 200.
        expect(res.statusCode).toBe(200);
        continue;
      }
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_MIN_REPUTATION');
      expect(mockDiscover).not.toHaveBeenCalled();
    }
  });

  it('T-R7: sin minReputation → 200 y el service lo recibe undefined', async () => {
    const res = await app.inject({ method: 'GET', url: '/discover?limit=3' });

    expect(res.statusCode).toBe(200);
    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ minReputation: undefined }),
    );
  });
});
