// `readPayoutRouteHealth` — el lector SÍNCRONO que `/health` publica como
// `solanaPayoutRoute`. Cinco estados, y lo que estos tests defienden es que NO se
// fusionen: un carril apagado y un sondeo que nunca terminó tienen que leerse distinto,
// porque piden acciones opuestas (uno es configuración, el otro es esperar o investigar).
//
// Archivo aparte del `facilitator-settle.test.ts` grande a propósito: ese tiene su propia
// coreografía de envs en un `beforeEach` de módulo, y meter estos casos ahí obligaría a
// pelearla en cada uno.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetPayoutRoutePreflight,
  ensurePayoutRouteReady,
  readPayoutRouteHealth,
} from './facilitator-settle.js';

const URL_ENVS = [
  'SOLANA_FACILITATOR_URL',
  'WASIAI_FACILITATOR_URL',
  'BASE_FACILITATOR_URL',
  'CDP_FACILITATOR_URL',
] as const;

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  delete process.env.SOLANA_SETTLE_VIA_FACILITATOR;
  for (const k of URL_ENVS) delete process.env[k];
  _resetPayoutRoutePreflight();
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SOLANA_SETTLE_VIA_FACILITATOR;
  for (const k of URL_ENVS) delete process.env[k];
  _resetPayoutRoutePreflight();
});

describe('readPayoutRouteHealth — los cinco estados no se fusionan', () => {
  it('T-H1: bandera apagada ⇒ rail_off, y NO sondea', () => {
    process.env.SOLANA_FACILITATOR_URL = 'https://facilitator.test';

    expect(readPayoutRouteHealth()).toEqual({ state: 'rail_off' });
    // Lo central del contrato: el handler de /health es síncrono y no puede salir a la red.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('T-H2: bandera encendida SIN url ⇒ rail_off (el mismo criterio que ensurePayoutRouteReady)', () => {
    process.env.SOLANA_SETTLE_VIA_FACILITATOR = 'true';

    expect(readPayoutRouteHealth()).toEqual({ state: 'rail_off' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('★ T-H3: armado pero sin veredicto ⇒ not_probed_yet, DISTINTO de rail_off', () => {
    process.env.SOLANA_SETTLE_VIA_FACILITATOR = 'true';
    process.env.SOLANA_FACILITATOR_URL = 'https://facilitator.test';

    const salida = readPayoutRouteHealth();

    expect(salida).toEqual({ state: 'not_probed_yet' });
    // La aserción que da sentido al test: si alguien colapsara los dos casos en un solo
    // literal, ESTA línea se pone roja. Sin ella el test pasaría con la fusión hecha.
    expect(salida.state).not.toBe('rail_off');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('T-H4: con veredicto route_registered ⇒ lo devuelve con probedAt, sin volver a sondear', async () => {
    process.env.SOLANA_SETTLE_VIA_FACILITATOR = 'true';
    process.env.SOLANA_FACILITATOR_URL = 'https://facilitator.test';
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        chains: [],
        methods: [],
        dedicatedRoutes: ['POST /solana/payout'],
      }),
    );

    await ensurePayoutRouteReady();
    const llamadasTrasSondeo = fetchSpy.mock.calls.length;

    const salida = readPayoutRouteHealth();

    expect(salida.state).toBe('route_registered');
    // `probedAt` tiene que ser una fecha REAL, no un placeholder: se publica para que
    // quien lo lea decida si el veredicto le sirve o ya es viejo.
    expect('probedAt' in salida && typeof salida.probedAt === 'string').toBe(
      true,
    );
    if ('probedAt' in salida) {
      expect(Number.isNaN(Date.parse(salida.probedAt))).toBe(false);
    }
    // Leer el health NO agrega ni un fetch.
    expect(fetchSpy.mock.calls.length).toBe(llamadasTrasSondeo);
  });

  it('★ T-H5: un route_unaskable conserva su razón (no se degrada a un booleano)', async () => {
    process.env.SOLANA_SETTLE_VIA_FACILITATOR = 'true';
    process.env.SOLANA_FACILITATOR_URL = 'https://facilitator.test';
    // 200 sano SIN el campo `dedicatedRoutes` ⇒ field_absent, que es "no pude preguntar",
    // no "la ruta no está". Perder la razón le saca al operador la acción a tomar.
    fetchSpy.mockResolvedValue(jsonResponse(200, { chains: [], methods: [] }));

    await ensurePayoutRouteReady();
    const salida = readPayoutRouteHealth();

    expect(salida.state).toBe('route_unaskable');
    expect('reason' in salida && salida.reason).toBe('field_absent');
  });
});
