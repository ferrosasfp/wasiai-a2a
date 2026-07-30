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
    mockDiscover.mockResolvedValue({
      agents: [],
      total: 0,
      registries: [],
      sources: [],
      catalogStatus: 'complete',
    });
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

  // ── AR MENOR-4: `limit` también se valida (el doc prometía otra cosa) ────

  it('T-R8: GET con limit=0 → 400 (antes 200 con el catálogo COMPLETO)', async () => {
    const res = await app.inject({ method: 'GET', url: '/discover?limit=0' });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_LIMIT');
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it('T-R9: GET con limit negativo → 400 (antes 200 con total-N por el slice(0,-N))', async () => {
    const res = await app.inject({ method: 'GET', url: '/discover?limit=-3' });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_LIMIT');
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it('T-R10: GET con limit no entero → 400', async () => {
    for (const v of ['abc', '1.5', '5abc']) {
      mockDiscover.mockClear();
      const res = await app.inject({
        method: 'GET',
        url: `/discover?limit=${v}`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_LIMIT');
      expect(mockDiscover).not.toHaveBeenCalled();
    }
  });

  it('T-R11: POST con limit inválido → 400; válido → llega al service', async () => {
    for (const v of [0, -3, 1.5]) {
      mockDiscover.mockClear();
      const res = await app.inject({
        method: 'POST',
        url: '/discover',
        payload: { limit: v },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_LIMIT');
      expect(mockDiscover).not.toHaveBeenCalled();
    }

    mockDiscover.mockClear();
    const ok = await app.inject({
      method: 'POST',
      url: '/discover',
      payload: { limit: 7 },
    });
    expect(ok.statusCode).toBe(200);
    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 7 }),
    );
  });

  it('T-R12: limit válido convive con minReputation válido', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/discover?limit=5&minReputation=10',
    });

    expect(res.statusCode).toBe(200);
    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5, minReputation: 10 }),
    );
  });

  it('T-R13 (AR it3 MENOR-3): limit fuera del rango de entero seguro → 400, no llega al service', async () => {
    for (const v of ['1e21', '9007199254740993']) {
      mockDiscover.mockClear();
      const res = await app.inject({
        method: 'GET',
        url: `/discover?limit=${v}`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_LIMIT');
      // Antes llegaba al service y se reenviaba upstream como el literal
      // `'1e+21'`: un registry que rechaza el parámetro tira, el `catch` del
      // fanout degrada a `[]` y el caller recibía 200 con 0 agentes.
      expect(mockDiscover).not.toHaveBeenCalled();
    }
  });

  // ── T-14 (WKH-313 / DT-7): `allowTrial` en el borde HTTP, GET y POST ────

  it('T-R14: GET `allowTrial=true` llega al service como booleano', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/discover?minReputation=2&allowTrial=true',
    });

    expect(res.statusCode).toBe(200);
    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ minReputation: 2, allowTrial: true }),
    );
  });

  it('T-R15: POST `allowTrial: true` llega IGUAL que por GET (simetría)', async () => {
    // El POST es el que se olvida. Un flag de riesgo validado en un solo verbo deja
    // al otro camino aceptando basura por el mismo endpoint.
    const res = await app.inject({
      method: 'POST',
      url: '/discover',
      payload: { minReputation: 2, allowTrial: true },
    });

    expect(res.statusCode).toBe(200);
    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ minReputation: 2, allowTrial: true }),
    );
  });

  it('T-R16: sin `allowTrial` el service lo recibe undefined (default = no admitir)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/discover?minReputation=2',
    });

    expect(res.statusCode).toBe(200);
    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ allowTrial: undefined }),
    );
  });

  it('T-R17: `allowTrial=false` NO opta (llega undefined, no `false`)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/discover?minReputation=2&allowTrial=false',
    });

    expect(res.statusCode).toBe(200);
    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ allowTrial: undefined }),
    );
  });

  it('T-R18: GET `allowTrial=maybe` → 400 INVALID_ALLOW_TRIAL, sin fanout', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/discover?allowTrial=maybe',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_ALLOW_TRIAL');
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it('T-R19: POST `allowTrial` no booleano → 400 (validado en los DOS verbos)', async () => {
    // `'true'`/`'false'` como STRING en el body sí se aceptan, y es deliberado: el
    // parser es UNO solo para los dos verbos (DT-7 pide que parseen igual), así que
    // no puede ser sensible al verbo. La tolerancia se limita a esos dos literales
    // exactos, donde la intención no es ambigua; todo lo demás es 400.
    for (const v of ['maybe', 'TRUE', 1, 0, {}]) {
      mockDiscover.mockClear();
      const res = await app.inject({
        method: 'POST',
        url: '/discover',
        payload: { allowTrial: v },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_ALLOW_TRIAL');
      expect(mockDiscover).not.toHaveBeenCalled();
    }
  });
});

// ── T-03 (AC-3, W1) · el conjunto vacío deja de ser MUDO ────────────────
//
// Es lo único de la HU que hace visible el problema aunque la política no se
// toque, y es lo que convierte el próximo diagnóstico de 3 semanas en 3 minutos.
describe('T-03 (AC-3) · `excluded` viaja en el JSON de GET y POST', () => {
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
    mockDiscover.mockResolvedValue({
      agents: [],
      total: 0,
      registries: [],
      // Merge WKH-313 ↔ WKH-318: este doble nació en la rama del carril de estreno,
      // y 318 volvió `sources`/`catalogStatus` REQUERIDOS. El auto-merge combinó las
      // dos ramas sin que nada se pusiera rojo — la suite pasó en verde porque vitest
      // NO typechequea; lo cazó `tsc --noEmit` sobre `main` ya mergeado.
      // `sources: []` ⇒ `complete` es la misma regla que aplica el early-return de
      // producción (`buildCatalogStatus([])`): sin fuentes consultadas no hay nada
      // que pueda faltar. NO se afloja ningún tipo para que el doble pase.
      sources: [],
      catalogStatus: 'complete' as const,
      excluded: {
        scope: 1,
        reputation: 3,
        trialAvailable: 2,
        // AR fix-pack BLQ-BAJO-4: el cuarto campo del contrato. El doble lo declara
        // en vez de aflojar el tipo: si mañana se agrega otro, la ruta se entera acá.
        standingUnavailable: false,
      },
    });
  });

  it('T-R20: GET serializa `excluded.reputation` y `excluded.trialAvailable`', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/discover?minReputation=50',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().excluded).toEqual({
      scope: 1,
      reputation: 3,
      trialAvailable: 2,
      standingUnavailable: false,
    });
  });

  it('T-R21: POST serializa los MISMOS contadores', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/discover',
      payload: { minReputation: 50 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().excluded).toEqual({
      scope: 1,
      reputation: 3,
      trialAvailable: 2,
      standingUnavailable: false,
    });
  });
});
