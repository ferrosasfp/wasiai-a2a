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

import { ALLOWED_DISCOVER_PARAMS } from '../lib/discovery-query.js';
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
      totalAtLeast: 0,
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
      totalAtLeast: 0,
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

// ── WKH-322 · el alias `min_reputation` y el 400 por clave desconocida ──────
//
// Las dos mitades son UNA decisión: el alias sin el 400 arregla un nombre y deja
// pasar el próximo typo; el 400 sin el alias le cobra al caller una
// inconsistencia nuestra (`min_reputation` se llama así porque así se llama en
// `constraints` de `/compose`).
//
// CD-6: cada caso tiene su gemelo POST. Un guard que sólo corre en GET deja al
// otro camino aceptando basura por el mismo endpoint.
describe('WKH-322 · min_reputation y UNKNOWN_DISCOVER_PARAM', () => {
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
      totalAtLeast: 0,
      registries: [],
      sources: [],
      catalogStatus: 'complete' as const,
      excluded: {
        scope: 0,
        reputation: 4,
        trialAvailable: 0,
        standingUnavailable: false,
      },
    });
  });

  it('T-R22 (AC-1): GET `?minReputation=7` llega al service como 7 y la respuesta explica la exclusión', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/discover?minReputation=7',
    });

    expect(res.statusCode).toBe(200);
    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ minReputation: 7 }),
    );
    expect(res.json().excluded.reputation).toBe(4);
  });

  it('T-R23 (AC-1): POST `{ minReputation: 7 }` idem (simetría CD-6)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/discover',
      payload: { minReputation: 7 },
    });

    expect(res.statusCode).toBe(200);
    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ minReputation: 7 }),
    );
    expect(res.json().excluded.reputation).toBe(4);
  });

  it('T-R24 (AC-2): GET `?min_reputation=2` filtra — el service recibe 2, NO undefined', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/discover?min_reputation=2',
    });

    expect(res.statusCode).toBe(200);
    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ minReputation: 2 }),
    );
  });

  it('T-R24b (AC-2): POST `{ min_reputation: 2 }` filtra igual', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/discover',
      payload: { min_reputation: 2 },
    });

    expect(res.statusCode).toBe(200);
    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ minReputation: 2 }),
    );
  });

  it('T-R25 (AC-2): los dos nombres producen EL MISMO objeto de llamada y la misma respuesta', async () => {
    const snake = await app.inject({
      method: 'GET',
      url: '/discover?min_reputation=2',
    });
    const snakeCall = mockDiscover.mock.calls[0]?.[0];

    mockDiscover.mockClear();

    const camel = await app.inject({
      method: 'GET',
      url: '/discover?minReputation=2',
    });
    const camelCall = mockDiscover.mock.calls[0]?.[0];

    expect(snakeCall).toEqual(camelCall);
    expect(snake.statusCode).toBe(camel.statusCode);
    expect(snake.json()).toEqual(camel.json());
  });

  it('T-R25b (AC-2): idem por POST', async () => {
    const snake = await app.inject({
      method: 'POST',
      url: '/discover',
      payload: { min_reputation: 2 },
    });
    const snakeCall = mockDiscover.mock.calls[0]?.[0];

    mockDiscover.mockClear();

    const camel = await app.inject({
      method: 'POST',
      url: '/discover',
      payload: { minReputation: 2 },
    });
    const camelCall = mockDiscover.mock.calls[0]?.[0];

    expect(snakeCall).toEqual(camelCall);
    expect(snake.json()).toEqual(camel.json());
  });

  it('T-R26 (AC-2): GET `?capability=…` (singular) → 400 que NOMBRA `capabilities`, sin fanout', async () => {
    // Medido contra producción antes del fix: `?capability=remittance-payout`
    // devolvía 200 con los 23 agentes del catálogo — 23 donde el nombre correcto
    // devuelve 1 — porque la ruta leía por nombre y el singular no existía para
    // ella. El costo real fue media hora buscando el bug en el lugar equivocado,
    // así que el mensaje tiene que traer el nombre bueno.
    const res = await app.inject({
      method: 'GET',
      url: '/discover?capability=remittance-payout',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('UNKNOWN_DISCOVER_PARAM');
    expect(res.json().error).toContain("'capability'");
    expect(res.json().error).toContain('capabilities');
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it('T-R26b (AC-2): POST `{ capability: … }` → el mismo 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/discover',
      payload: { capability: 'remittance-payout' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('UNKNOWN_DISCOVER_PARAM');
    expect(res.json().error).toContain('capabilities');
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it('T-R27 (AC-2): GET `?bogusparam=zzz` → 400 (se rechaza la CLASE, no sólo los near-miss)', async () => {
    // Precondición explícita: `bogusparam` no se parece a ninguna clave real, así
    // que un guard implementado como "rechazo sólo lo que se parece a algo" lo
    // dejaría pasar.
    expect(ALLOWED_DISCOVER_PARAMS.has('bogusparam')).toBe(false);

    const res = await app.inject({
      method: 'GET',
      url: '/discover?bogusparam=zzz',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('UNKNOWN_DISCOVER_PARAM');
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it('T-R27b (AC-2): POST `{ bogusparam: … }` → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/discover',
      payload: { bogusparam: 'zzz' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('UNKNOWN_DISCOVER_PARAM');
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it('T-R28 (AC-3): GET con los dos nombres y valores distintos → 400, sin fanout', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/discover?minReputation=1&min_reputation=5',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('CONFLICTING_MIN_REPUTATION');
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it('T-R28b (AC-3): POST con los dos nombres y valores distintos → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/discover',
      payload: { minReputation: 1, min_reputation: 5 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('CONFLICTING_MIN_REPUTATION');
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it('T-R28c (AC-3): los dos nombres con el MISMO valor no son conflicto', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/discover?minReputation=5&min_reputation=5.0',
    });

    expect(res.statusCode).toBe(200);
    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ minReputation: 5 }),
    );
  });

  it('T-R29 (AC-4): con el historial ILEGIBLE, los dos nombres dan la misma respuesta fail-closed', async () => {
    // `standingUnavailable: true` = el gateway NO PUDO LEER la reputación. El
    // alias no puede ablandar el piso (p. ej. mandando 0 en vez del valor): las
    // dos ramas colapsan al mismo campo antes de salir del parser.
    mockDiscover.mockResolvedValue({
      agents: [],
      total: 0,
      totalAtLeast: 0,
      registries: [],
      sources: [],
      catalogStatus: 'complete' as const,
      excluded: {
        scope: 0,
        reputation: 3,
        trialAvailable: 0,
        standingUnavailable: true,
      },
    });

    const camel = await app.inject({
      method: 'GET',
      url: '/discover?minReputation=2',
    });
    const camelCall = mockDiscover.mock.calls[0]?.[0];
    mockDiscover.mockClear();

    const snake = await app.inject({
      method: 'GET',
      url: '/discover?min_reputation=2',
    });
    const snakeCall = mockDiscover.mock.calls[0]?.[0];

    expect(camelCall).toEqual(snakeCall);
    expect(snakeCall).toEqual(expect.objectContaining({ minReputation: 2 }));
    expect(camel.json().agents).toEqual([]);
    expect(snake.json()).toEqual(camel.json());
    expect(snake.json().excluded.standingUnavailable).toBe(true);
  });

  it('T-R29b (AC-4): idem por POST', async () => {
    mockDiscover.mockResolvedValue({
      agents: [],
      total: 0,
      totalAtLeast: 0,
      registries: [],
      sources: [],
      catalogStatus: 'complete' as const,
      excluded: {
        scope: 0,
        reputation: 3,
        trialAvailable: 0,
        standingUnavailable: true,
      },
    });

    const camel = await app.inject({
      method: 'POST',
      url: '/discover',
      payload: { minReputation: 2 },
    });
    const camelCall = mockDiscover.mock.calls[0]?.[0];
    mockDiscover.mockClear();

    const snake = await app.inject({
      method: 'POST',
      url: '/discover',
      payload: { min_reputation: 2 },
    });

    expect(mockDiscover.mock.calls[0]?.[0]).toEqual(camelCall);
    expect(snake.json()).toEqual(camel.json());
  });

  /**
   * T-R30 (AC-5) — los 10 parámetros ESCRITOS A MANO, uno por uno.
   *
   * CD-10: si este test iterara `ALLOWED_DISCOVER_PARAMS` mediría la constante
   * contra sí misma, y agregar `pepito` a la lista lo haría pasar afirmando que
   * `pepito` es un parámetro público. Los nombres de abajo se transcribieron de
   * `doc/INTEGRATION.md` y de las firmas `Querystring` / `Body` de esta ruta.
   */
  const GET_PARAMS_BY_HAND: ReadonlyArray<[string, string]> = [
    ['allowTrial', 'true'],
    ['capabilities', 'kyc'],
    ['includeInactive', 'true'],
    ['limit', '5'],
    ['maxPrice', '1'],
    ['minReputation', '10'],
    ['min_reputation', '10'],
    ['q', 'oracle'],
    ['registry', 'self-published'],
    ['verified', 'true'],
  ];

  it.each(
    GET_PARAMS_BY_HAND,
  )('T-R30 (AC-5): GET `?%s=%s` → 200 (el parámetro es público y sigue siéndolo)', async (name, value) => {
    const res = await app.inject({
      method: 'GET',
      url: `/discover?${name}=${value}`,
    });

    expect(res.statusCode).toBe(200);
    expect(mockDiscover).toHaveBeenCalled();
  });

  const POST_PARAMS_BY_HAND: ReadonlyArray<[string, unknown]> = [
    ['allowTrial', true],
    ['capabilities', 'kyc'],
    ['includeInactive', true],
    ['limit', 5],
    ['maxPrice', 1],
    ['minReputation', 10],
    ['min_reputation', 10],
    ['q', 'oracle'],
    ['registry', 'self-published'],
    ['verified', true],
  ];

  it.each(
    POST_PARAMS_BY_HAND,
  )('T-R30b (AC-5): POST `{ %s }` → 200', async (name, value) => {
    const res = await app.inject({
      method: 'POST',
      url: '/discover',
      payload: { [name as string]: value },
    });

    expect(res.statusCode).toBe(200);
    expect(mockDiscover).toHaveBeenCalled();
  });

  it('T-R31 (DT-8): la FORMA se valida antes que los VALORES', async () => {
    // Se responde un solo error por request. Una clave desconocida significa que
    // el modelo mental del caller sobre la forma de la API está equivocado;
    // contestarle un error de valor sobre OTRO parámetro lo manda a buscar al
    // lugar equivocado.
    const res = await app.inject({
      method: 'GET',
      url: '/discover?capability=x&minReputation=abc',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('UNKNOWN_DISCOVER_PARAM');
  });

  it('T-R31b (DT-8): idem por POST', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/discover',
      payload: { capability: 'x', minReputation: 'abc' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('UNKNOWN_DISCOVER_PARAM');
  });

  it("T-R32 (DT-9): POST con body array → 400 INVALID_DISCOVER_BODY (no `unknown parameter '0'`)", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/discover',
      payload: [1, 2],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_DISCOVER_BODY');
    expect(res.json().error).not.toContain("'0'");
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it('T-R35 (AR MNR-4): POST con una clave de 100 KB → 400 chico, no un 400 de 100 KB', async () => {
    // El hallazgo del AR se mide donde pasa: en el cuerpo de la respuesta.
    // `discovery-query.ts` acota el eco, y acá se verifica que la ruta lo
    // devuelve acotado — no que la función acote (eso es T-U9).
    const huge = 'a'.repeat(100_000);
    const res = await app.inject({
      method: 'POST',
      url: '/discover',
      payload: { [huge]: '1' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('UNKNOWN_DISCOVER_PARAM');
    expect(res.body.length).toBeLessThan(1000);
    expect(res.json().error).toContain('truncated');
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it('T-R35b (AR MNR-4): GET con una clave larga en el query string → el mismo 400 acotado', async () => {
    // 5000 y no 100 KB: el query string entero pasa por la línea de request, y
    // el límite de Fastify para eso es mucho más chico que el del body. El
    // punto es el mismo, y la cota que se ejercita es la misma.
    const long = 'z'.repeat(5000);
    const res = await app.inject({
      method: 'GET',
      url: `/discover?${long}=1`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('UNKNOWN_DISCOVER_PARAM');
    expect(res.body.length).toBeLessThan(1000);
    expect(res.json().error).toContain('5000 UTF-16 code units');
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it('T-R32c (CR MNR-2): POST con body PRIMITIVO → 400 INVALID_DISCOVER_BODY, no 200 con el catálogo', async () => {
    // La guarda de `toDiscoverParamBag` tiene dos mitades y sólo la del array
    // estaba testeada (T-R32). Mutante que sobrevivía: cambiar
    // `typeof raw !== 'object' || Array.isArray(raw)` por `Array.isArray(raw)`.
    // Con `5`, `Object.keys(5)` es `[]` ⇒ ninguna clave desconocida ⇒ **200 con
    // el catálogo entero**, que es exactamente la clase de bug que esta HU
    // existe para matar. Con `"ab"`, `Object.keys('ab')` es `['0','1']` ⇒
    // `unknown parameter '0'`, que es lo que DT-9 existe para evitar.
    // `doc/INTEGRATION.md:762` ya publica el comportamiento para primitivos.
    for (const payload of ['5', '"ab"', 'true']) {
      const res = await app.inject({
        method: 'POST',
        url: '/discover',
        headers: { 'content-type': 'application/json' },
        payload,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_DISCOVER_BODY');
      expect(res.json().error).not.toContain("'0'");
      expect(mockDiscover).not.toHaveBeenCalled();
    }
  });

  it('T-R32b (DT-9): POST con body `{}` sigue dando 200 (pin de discover.test.ts)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/discover',
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ minReputation: undefined }),
    );
  });

  it('T-R33 (borde): `?minReputation=1&minReputation=1` (repetido ⇒ array) → 400 INVALID_MIN_REPUTATION, como hoy', async () => {
    // Aplanar el array "para ser amable" sería adivinar cuál de los dos valores
    // quiso el caller. El nombre está en la lista blanca, así que el 400 que
    // corresponde es el de VALOR, no el de clave desconocida.
    const res = await app.inject({
      method: 'GET',
      url: '/discover?minReputation=1&minReputation=1',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_MIN_REPUTATION');
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it('T-R34 (§2.2): POST `{ query: "test" }` → 400 que nombra `q`', async () => {
    // `query` es el nombre INTERNO del campo de texto libre del tipo
    // `DiscoveryQuery`; el público es `q`. Varios call-sites de este repo lo
    // escribieron mal y nadie se enteró en meses: dos escenarios de
    // `perf-bench.mjs` llamados "empty query" y "filter category" medían la misma
    // llamada sin filtrar. Este test impide que vuelva a pasar en silencio.
    //
    // Acá NO va el conteo: se contó mal cuatro veces seguidas (4 → 6 → 8 → 10) y
    // un número dentro de un comentario no tiene quién lo obligue a envejecer
    // bien. El inventario vivo lo mantiene
    // `src/__tests__/discover-callsites.test.ts`, que barre el repo entero y se
    // pone rojo ante un call-site nuevo con una clave que la ruta rechaza.
    const res = await app.inject({
      method: 'POST',
      url: '/discover',
      payload: { query: 'test' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('UNKNOWN_DISCOVER_PARAM');
    expect(res.json().error).toContain("'query'");
    expect(res.json().error).toMatch(/(^|[ ,])q($|[ ,])/);
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it('T-R34b (§2.2): GET `?query=oracle` → el mismo 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/discover?query=oracle',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('UNKNOWN_DISCOVER_PARAM');
    expect(mockDiscover).not.toHaveBeenCalled();
  });
});
