/**
 * GUARD ESTRUCTURAL (HU-193): ninguna ruta que COBRE puede registrarse sin una
 * validación de forma ANTES del cobro.
 *
 * POR QUÉ UN TEST Y NO SÓLO TIPOS: `chargedRoute` hace obligatorio declarar
 * `validate`, pero `requirePaymentOrA2AKey` sigue exportado y `/compose`,
 * `/orchestrate` y `/gasless` lo llaman directo (no se migran en esta HU). Mientras
 * ese bypass exista, el compilador no puede cerrar el agujero. Este test sí: recorre
 * las rutas REALMENTE registradas (hook `onRoute`, no una lista hardcodeada, igual
 * que `registries.redaction.test.ts:T-RRED-05`) y falla si alguna tiene un handler
 * marcado `CHARGES_CALLER` sin un `PRE_CHARGE_VALIDATION` antes en la cadena.
 *
 * La lista de excepciones está CONGELADA: agregar una ruta que cobre sin validar
 * rompe el test, y "arreglarlo" exige tocar esta lista a mano y justificarlo en
 * la review. Una convención documentada es exactamente lo que ya falló.
 *
 * Naming: T-META-01..T-META-04.
 */

import Fastify, { type RouteOptions } from 'fastify';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  chargesCaller,
  preChargeValidationDetail,
} from '../middleware/charge-brand.js';

// Sólo se necesita que los plugins REGISTREN sus rutas; ningún request se
// ejecuta. Se moquea la capa de datos para que importar los módulos no intente
// abrir conexiones.
vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));
vi.mock('../middleware/rate-limit.js', () => ({
  orchestrateRateLimit: () => false,
  discoverRateLimit: () => false,
}));

import composeRoutes from './compose.js';
import gaslessRoutes from './gasless.js';
import orchestrateRoutes from './orchestrate.js';
import registriesRoutes from './registries.js';
import tasksRoutes from './tasks.js';

/**
 * Rutas que HOY cobran sin validación pre-cobro declarada vía `chargedRoute`.
 * Congelada a propósito. Para sacar una de acá hay que migrarla al componente
 * (ver el work-item de HU-193, sección "qué falta para migrar el resto").
 *
 * NOTA sobre `/compose`: sí valida el shape del body antes del cobro
 * (`validateComposeBodyHandler`, HU-188), pero con un preHandler propio en vez del
 * componente, así que no lleva la marca. Está en la lista como deuda de MIGRACIÓN,
 * no como agujero de validación.
 */
const LEGACY_UNVALIDATED: ReadonlySet<string> = new Set([
  'POST /compose',
  'POST /orchestrate',
  'POST /orchestrate/plan',
  'POST /orchestrate/execute',
  'POST /gasless/transfer',
]);

interface Registered {
  key: string;
  chargeIndex: number;
  validationIndex: number;
  validationDetail: string | null;
}

describe('guard estructural — cobrar exige validar antes (HU-193)', () => {
  const registered: Registered[] = [];

  beforeAll(async () => {
    const app = Fastify();
    app.addHook('onRoute', (route: RouteOptions) => {
      const handlers = (
        Array.isArray(route.preHandler)
          ? route.preHandler
          : route.preHandler
            ? [route.preHandler]
            : []
      ) as unknown[];
      const chargeIndex = handlers.findIndex((h) => chargesCaller(h));
      const validationIndex = handlers.findIndex(
        (h) => preChargeValidationDetail(h) !== null,
      );
      const methods = Array.isArray(route.method)
        ? route.method
        : [route.method];
      for (const method of methods) {
        registered.push({
          key: `${method} ${route.url}`,
          chargeIndex,
          validationIndex,
          validationDetail:
            validationIndex === -1
              ? null
              : preChargeValidationDetail(handlers[validationIndex]),
        });
      }
    });
    await app.register(registriesRoutes, { prefix: '/registries' });
    await app.register(tasksRoutes, { prefix: '/tasks' });
    await app.register(composeRoutes, { prefix: '/compose' });
    await app.register(orchestrateRoutes, { prefix: '/orchestrate' });
    await app.register(gaslessRoutes, { prefix: '/gasless' });
    await app.ready();
    await app.close();
  });

  it('T-META-01: toda ruta que cobra tiene validación pre-cobro (salvo la deuda congelada)', () => {
    const offenders = registered
      .filter((r) => r.chargeIndex !== -1 && r.validationIndex === -1)
      .map((r) => r.key)
      .filter((key) => !LEGACY_UNVALIDATED.has(key));
    expect(offenders).toEqual([]);
  });

  it('T-META-02: la validación va ANTES del cobro en la cadena, nunca después', () => {
    const misordered = registered
      .filter(
        (r) =>
          r.chargeIndex !== -1 &&
          r.validationIndex !== -1 &&
          r.validationIndex > r.chargeIndex,
      )
      .map((r) => r.key);
    expect(misordered).toEqual([]);
  });

  it('T-META-03: las 8 rutas del alcance de HU-193 están cubiertas por el componente', () => {
    const covered = registered
      .filter((r) => r.chargeIndex !== -1 && r.validationIndex !== -1)
      .map((r) => r.key)
      .sort();
    // Los `HEAD` no se declaran: Fastify los registra solo como hermanos de cada
    // `GET` (`exposeHeadRoutes`), con la MISMA cadena de preHandlers. Vale la pena
    // dejarlos a la vista: un `HEAD /tasks` también cobra $1 (dato para la
    // discusión de precio de los GET, ver el work-item).
    expect(covered).toEqual([
      'DELETE /registries/:id',
      'GET /tasks',
      'GET /tasks/:id',
      'HEAD /tasks',
      'HEAD /tasks/',
      'HEAD /tasks/:id',
      'PATCH /registries/:id',
      'PATCH /tasks/:id',
      'PATCH /tasks/:id/status',
      'POST /registries',
      'POST /tasks',
    ]);
  });

  it('T-META-04: la deuda de migración es exactamente la congelada (ni más ni menos)', () => {
    // Si una ruta legacy se migra, este test obliga a sacarla de la lista (queda
    // en evidencia el avance). Si aparece una NUEVA ruta que cobra sin validar,
    // T-META-01 falla primero.
    const unvalidated = registered
      .filter((r) => r.chargeIndex !== -1 && r.validationIndex === -1)
      .map((r) => r.key)
      .sort();
    expect(unvalidated).toEqual([...LEGACY_UNVALIDATED].sort());
  });
});
