/**
 * HU-306 (AC-5) — el indicador de que el residuo está creciendo.
 *
 * LO QUE SE AFIRMA ACÁ ES CUÁNDO SE GRITA Y CUÁNDO NO, y —sobre todo— que un fallo de la
 * base JAMÁS se escribe como "no hay nada que reportar". El otro eje que se mide es el
 * COSTO: cuántas veces se toca la base por N lecturas de `/health` (CD-19: se cuenta la
 * I/O, no se supone).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({ getLogger: () => logSpy }));

// `countStrandedExposureSince` es la ÚNICA puerta de este módulo a la base (es su único
// import de servicio). Contar sus llamadas ES contar las queries.
const mockCount = vi.hoisted(() => vi.fn());
vi.mock('./reconciliation.js', () => ({
  reconciliationService: {
    countStrandedExposureSince: (...a: unknown[]) => mockCount(...a),
  },
}));

import {
  _resetStrandedAlert,
  getStrandedHealthField,
  refreshStrandedExposure,
  STRANDED_HEALTH_FIELD,
} from './stranded-alert.js';

const THRESHOLD_ENV = 'STRANDED_EXPOSURE_ALERT_THRESHOLD_USD';
const WINDOW_ENV = 'STRANDED_EXPOSURE_ALERT_WINDOW_MIN';

/** Deja que corra el refresh disparado en segundo plano por `/health`. */
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  vi.clearAllMocks();
  _resetStrandedAlert();
  delete process.env[THRESHOLD_ENV];
  delete process.env[WINDOW_ENV];
  mockCount.mockResolvedValue({ runs: 0, exposureUsd: 0, truncated: false });
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env[THRESHOLD_ENV];
  delete process.env[WINDOW_ENV];
});

describe('HU-306 · el indicador de exposición acumulada (AC-5)', () => {
  it('T-ALERT-OFF: sin umbral configurado el campo NO existe y NO se toca la base (CD-19)', async () => {
    const field = getStrandedHealthField();
    await flush();

    // Campo ausente, no `false`: el deploy que no activó la alerta tiene un /health
    // byte-idéntico al de antes de esta HU.
    expect(field).toEqual({});
    expect(STRANDED_HEALTH_FIELD in field).toBe(false);
    // Y el costo es CERO, contado: ni una query.
    expect(mockCount).not.toHaveBeenCalled();
    // Ni siquiera un refresh explícito consulta con la feature apagada.
    await refreshStrandedExposure();
    expect(mockCount).not.toHaveBeenCalled();
  });

  it('T-ALERT-BREACH: exposición por encima del umbral ⟹ true + log de alerta', async () => {
    process.env[THRESHOLD_ENV] = '10';
    mockCount.mockResolvedValue({
      runs: 40,
      exposureUsd: 12.5,
      truncated: false,
    });

    await refreshStrandedExposure();

    expect(getStrandedHealthField()).toEqual({
      [STRANDED_HEALTH_FIELD]: true,
    });
    // Segundo consumidor, gratis: la señal existe en los logs aunque el JSON de targets
    // del monitor todavía no se haya tocado.
    const alerta = logSpy.error.mock.calls.find(
      (c) =>
        (c[0] as Record<string, unknown>)?.alert ===
        'COMPOSE_STRANDED_PAYMENT_EXPOSURE_HIGH',
    );
    expect(alerta).toBeDefined();
    expect(alerta![0]).toMatchObject({
      windowMin: 60,
      thresholdUsd: 10,
      exposureUsd: 12.5,
      runs: 40,
    });
  });

  it('T-ALERT-NO-BREACH: exposición por debajo o IGUAL al umbral ⟹ false y sin log', async () => {
    process.env[THRESHOLD_ENV] = '10';
    // Igual al umbral NO es breach (la comparación es estricta y está fijada acá).
    mockCount.mockResolvedValue({
      runs: 3,
      exposureUsd: 10,
      truncated: false,
    });

    await refreshStrandedExposure();

    expect(getStrandedHealthField()).toEqual({
      [STRANDED_HEALTH_FIELD]: false,
    });
    expect(
      logSpy.error.mock.calls.some(
        (c) => (c[0] as Record<string, unknown>)?.alert !== undefined,
      ),
    ).toBe(false);
  });

  it('T-ALERT-BREACH: el log sale en la TRANSICIÓN, no una vez por minuto', async () => {
    process.env[THRESHOLD_ENV] = '10';
    mockCount.mockResolvedValue({
      runs: 40,
      exposureUsd: 12.5,
      truncated: false,
    });

    await refreshStrandedExposure();
    await refreshStrandedExposure();
    await refreshStrandedExposure();

    const alertas = logSpy.error.mock.calls.filter(
      (c) => (c[0] as Record<string, unknown>)?.alert !== undefined,
    );
    expect(alertas).toHaveLength(1);
  });

  it('T-ALERT-UNKNOWN: query que falla ⟹ "unknown" (truthy), NUNCA false', async () => {
    process.env[THRESHOLD_ENV] = '10';
    mockCount.mockRejectedValue(new Error('supabase down'));

    await refreshStrandedExposure();

    const field = getStrandedHealthField();
    expect(field).toEqual({ [STRANDED_HEALTH_FIELD]: 'unknown' });
    // La propiedad que hace que el monitor alerte: 'unknown' es TRUTHY. Un `false` acá
    // diría "no hay nada que reportar" en el único canal que existe para gritarlo.
    expect(Boolean(field[STRANDED_HEALTH_FIELD])).toBe(true);
    expect(field[STRANDED_HEALTH_FIELD]).not.toBe(false);
  });

  it('T-ALERT-UNKNOWN: nunca computado ⟹ "unknown" (no se afirma lo que no se miró)', () => {
    process.env[THRESHOLD_ENV] = '10';
    expect(getStrandedHealthField()).toEqual({
      [STRANDED_HEALTH_FIELD]: 'unknown',
    });
  });

  it('T-ALERT-UNKNOWN: un snapshot RANCIO deja de afirmarse', async () => {
    process.env[THRESHOLD_ENV] = '10';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T00:00:00.000Z'));
    mockCount.mockResolvedValue({ runs: 0, exposureUsd: 0, truncated: false });

    await refreshStrandedExposure();
    expect(getStrandedHealthField()).toEqual({
      [STRANDED_HEALTH_FIELD]: false,
    });

    // Seis minutos después (> STALE_MS) el dato ya no se sostiene: el proceso pudo estar
    // sin tráfico o los refreshes viniendo fallando.
    vi.setSystemTime(new Date('2026-07-29T00:06:00.000Z'));
    expect(getStrandedHealthField()).toEqual({
      [STRANDED_HEALTH_FIELD]: 'unknown',
    });
  });

  it('T-ALERT-LOWER-BOUND: con la lista truncada hay breach aunque la suma parcial no llegue', async () => {
    process.env[THRESHOLD_ENV] = '1000000';
    // La suma es una COTA INFERIOR cuando la ventana trae más filas que el límite. 500
    // runs varados en una hora ya es sistémico por definición: un truncamiento NUNCA
    // puede producir un `false`.
    mockCount.mockResolvedValue({
      runs: 900,
      exposureUsd: 12.5,
      truncated: true,
    });

    await refreshStrandedExposure();

    expect(getStrandedHealthField()).toEqual({
      [STRANDED_HEALTH_FIELD]: true,
    });
  });

  it('T-ALERT-WINDOW: el filtro usa la ventana CONFIGURADA, no una fija', async () => {
    process.env[THRESHOLD_ENV] = '10';
    process.env[WINDOW_ENV] = '15';
    vi.useFakeTimers();
    const now = new Date('2026-07-29T12:00:00.000Z');
    vi.setSystemTime(now);

    await refreshStrandedExposure();

    expect(mockCount).toHaveBeenCalledTimes(1);
    expect(mockCount.mock.calls[0]![0]).toBe('2026-07-29T11:45:00.000Z');

    // …y sin la env vuelve al default de 60 minutos.
    delete process.env[WINDOW_ENV];
    mockCount.mockClear();
    await refreshStrandedExposure();
    expect(mockCount.mock.calls[0]![0]).toBe('2026-07-29T11:00:00.000Z');
  });

  it('T-ALERT-CACHE: N lecturas de /health dentro del TTL ⟹ UNA sola query (CD-19)', async () => {
    process.env[THRESHOLD_ENV] = '10';

    // 50 hits seguidos, como los que pega el monitor + los health checks del hosting.
    for (let i = 0; i < 50; i++) getStrandedHealthField();
    await flush();
    for (let i = 0; i < 50; i++) getStrandedHealthField();
    await flush();

    expect(mockCount).toHaveBeenCalledTimes(1);
    // …y después del refresh el campo ya afirma algo.
    expect(getStrandedHealthField()).toEqual({
      [STRANDED_HEALTH_FIELD]: false,
    });
  });

  it('CD-10: leer el campo no espera a la base ni puede tirar aunque la query explote', async () => {
    process.env[THRESHOLD_ENV] = '10';
    mockCount.mockImplementation(() => {
      throw new Error('boom sincrónico');
    });

    // Síncrono: devuelve sin await, y no propaga la excepción del refresh de fondo.
    expect(() => getStrandedHealthField()).not.toThrow();
    await flush();
    expect(getStrandedHealthField()).toEqual({
      [STRANDED_HEALTH_FIELD]: 'unknown',
    });
  });
});
