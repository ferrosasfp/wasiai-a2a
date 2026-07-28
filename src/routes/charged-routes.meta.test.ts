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
 * ALCANCE = LA APP ENTERA (fix-pack, MENOR-1). La primera versión de este guard
 * registraba 5 plugins a mano (`registries`/`tasks`/`compose`/`orchestrate`/
 * `gasless`), así que una ruta futura que cobrara en cualquiera de los otros ~14
 * era INVISIBLE — justo el escenario para el que existe el guard. Ahora la lista
 * de plugins se DERIVA de `src/index.ts` (se parsea el fuente y se lee cada
 * `fastify.register(<plugin>, { prefix })`) y T-META-06 exige que el set escaneado
 * sea exactamente el de la app: agregar un plugin a `index.ts` sin escanearlo acá
 * ROMPE el test.
 *
 * La lista de excepciones está CONGELADA: agregar una ruta que cobre sin validar
 * rompe el test, y "arreglarlo" exige tocar esta lista a mano y justificarlo en
 * la review. Una convención documentada es exactamente lo que ya falló.
 *
 * Naming: T-META-01..T-META-06.
 */

import { readFileSync } from 'node:fs';
import Fastify, { type FastifyPluginAsync, type RouteOptions } from 'fastify';
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
// Mock PARCIAL: el módulo exporta varios rate-limiters (`authSignupRateLimit`,
// …) que los plugins nuevos del alcance ampliado importan al registrarse.
vi.mock('../middleware/rate-limit.js', async (orig) => ({
  ...(await orig<typeof import('../middleware/rate-limit.js')>()),
  orchestrateRateLimit: () => false,
  discoverRateLimit: () => false,
}));

import mcpPlugin from '../mcp/index.js';
import agentCardRoutes from './agent-card.js';
import agentLinkRoutes from './agent-links.js';
import agentsRoutes from './agents.js';
import authRoutes from './auth.js';
import capabilitiesRoutes from './capabilities.js';
import composeRoutes from './compose.js';
import dashboardRoutes from './dashboard.js';
import discoverRoutes from './discover.js';
import gaslessRoutes from './gasless.js';
import inboundRoutes from './inbound.js';
import metricsRoutes from './metrics.js';
import mockRegistryRoutes from './mock-registry.js';
import orchestrateRoutes from './orchestrate.js';
import paymentsRoutes from './payments.js';
import receiptsRoutes from './receipts.js';
import registriesRoutes from './registries.js';
import tasksRoutes from './tasks.js';
import wellKnownRoutes from './well-known.js';

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

/**
 * Rutas que cobran y declaran el opt-out `{ skip: '<motivo>' }` (fix-pack,
 * MENOR-2). CONGELADA EN VACÍO: hoy ninguna ruta usa el opt-out. La marca es
 * visible y grepeable, pero sin este congelamiento NINGÚN test la miraba, así que
 * `{ skip: 'meh' }` dejaba el guard 100% verde con cero validación. Ahora usar el
 * opt-out obliga a tocar esta lista, o sea que aparece en el diff y en la review.
 */
const SKIPPED_VALIDATION: ReadonlySet<string> = new Set<string>([]);

interface Registered {
  key: string;
  chargeIndex: number;
  validationIndex: number;
  validationDetail: string | null;
}

/**
 * Los plugins de la app, DERIVADOS de `src/index.ts` (fuente única). Se parsea el
 * fuente en vez de importarlo porque `index.ts` es el entrypoint: al importarlo
 * corre `assertRequiredEnv()`, `initAdapters()` y levanta el server.
 */
function appPluginsFromIndexSource(): Array<{
  ident: string;
  prefix: string;
}> {
  const src = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  // `fastify.register(<ident>, { prefix: '<prefix>' })`. El `{ prefix:` es lo que
  // distingue a un plugin de ruta de `register(cors, corsOptions)`.
  const re = /fastify\.register\(\s*(\w+)\s*,\s*\{\s*prefix:\s*'([^']+)'/g;
  return [...src.matchAll(re)].map((m) => ({
    ident: m[1] as string,
    prefix: m[2] as string,
  }));
}

/** ident en `index.ts` → el plugin importado acá. */
const SCANNED: Readonly<Record<string, FastifyPluginAsync>> = {
  registriesRoutes,
  discoverRoutes,
  capabilitiesRoutes,
  composeRoutes,
  orchestrateRoutes,
  paymentsRoutes,
  agentCardRoutes,
  agentsRoutes,
  agentLinkRoutes,
  inboundRoutes,
  wellKnownRoutes,
  tasksRoutes,
  dashboardRoutes,
  mockRegistryRoutes,
  gaslessRoutes,
  authRoutes,
  receiptsRoutes,
  metricsRoutes,
  mcpPlugin,
};

describe('guard estructural — cobrar exige validar antes (HU-193)', () => {
  const registered: Registered[] = [];
  const appPlugins = appPluginsFromIndexSource();

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
    // Mismos plugins y mismos prefijos que `src/index.ts`.
    for (const { ident, prefix } of appPlugins) {
      const plugin = SCANNED[ident];
      if (!plugin) continue; // T-META-06 es quien falla por esto, con el nombre.
      await app.register(plugin, { prefix });
    }
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

  it('T-META-05: el opt-out `{ skip }` está congelado (hoy: ninguna ruta)', () => {
    // Sin esto, `chargedRoute({ validate: { skip: 'meh' }, payment })` pasaba
    // T-META-01 y T-META-04 en verde con CERO validación: la marca existía y
    // nadie la miraba.
    const skipped = registered
      .filter(
        (r) => r.chargeIndex !== -1 && r.validationDetail?.startsWith('skip: '),
      )
      .map((r) => `${r.key} (${r.validationDetail})`)
      .sort();
    expect(skipped).toEqual([...SKIPPED_VALIDATION].sort());
  });

  it('T-META-06: el guard escanea EXACTAMENTE los plugins que registra la app', () => {
    // La propiedad que el founder pidió ("imposible cablear una ruta que cobre
    // sin validar") sólo vale si el guard ve toda la app. Si mañana alguien
    // registra un plugin nuevo en `index.ts`, este test falla hasta que se lo
    // agregue a `SCANNED` y quede bajo el guard.
    expect(appPlugins.length).toBeGreaterThanOrEqual(19);
    const inApp = appPlugins.map((p) => p.ident).sort();
    expect(inApp).toEqual(Object.keys(SCANNED).sort());
    // Y las rutas escaneadas incluyen plugins que NO estaban en la versión
    // original del guard (que sólo miraba 5): prueba de que el alcance creció.
    const scannedUrls = new Set(registered.map((r) => r.key));
    for (const key of [
      'POST /payments/session',
      'POST /auth/agent-signup',
      'GET /dashboard',
      'POST /agents',
      'POST /inbound/:source/tasks',
      'GET /receipts',
      'POST /mcp',
    ]) {
      expect(scannedUrls.has(key)).toBe(true);
    }
  });
});
