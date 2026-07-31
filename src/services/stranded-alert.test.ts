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
  describeStrandedThresholdStartup,
  getStrandedHealthField,
  getStrandedThresholdUsd,
  refreshStrandedExposure,
  STRANDED_HEALTH_FIELD,
  STRANDED_THRESHOLD_ENV,
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

  it('T-ALERT-OFF: un umbral 0 o negativo NO enciende la alerta (AR MENOR-3)', async () => {
    // Invariante que el docstring del módulo declara y que nada candaba: un `0` NO se
    // acepta como "alertar siempre" — sería un canal gritando en cada request, o sea un
    // canal que se aprende a ignorar. Un negativo es directamente un typo.
    for (const raw of ['0', '-1', '-0.5', 'abc', 'NaN', '   ']) {
      _resetStrandedAlert();
      mockCount.mockClear();
      process.env[THRESHOLD_ENV] = raw;

      const field = getStrandedHealthField();
      await flush();
      await refreshStrandedExposure();

      expect(field).toEqual({});
      expect(mockCount).not.toHaveBeenCalled();
    }
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

/**
 * Fix-pack observabilidad 2026-07-31 — el aviso de arranque del UMBRAL.
 *
 * LO QUE SE AFIRMA ACÁ. Que el arranque distingue TRES estados y que el número que
 * imprime es EL MISMO que usa el camino de alerta. La segunda parte es la que importa: un
 * arranque que dice `19` mientras la alerta usa otro número es un log que MIENTE, y eso es
 * peor que no tener log. Por eso el valor no se afirma por separado, se ATA contra el
 * `thresholdUsd` que sale del log de alerta real.
 *
 * NADA DE ESTO CAMBIA LA POLÍTICA: con la env ausente la alerta sigue apagada, y eso
 * también se afirma acá para que un cambio de comportamiento no se cuele como
 * "observabilidad".
 */
describe('fix-pack 2026-07-31 · el arranque dice en qué estado quedó el umbral', () => {
  const alertaDelLog = () =>
    logSpy.error.mock.calls.find(
      (c) =>
        (c[0] as Record<string, unknown>)?.alert ===
        'COMPOSE_STRANDED_PAYMENT_EXPOSURE_HIGH',
    );

  it('el nombre de la env que se reporta es el que se lee de verdad', () => {
    // Sin esto, el aviso podría estar mirando una variable que no existe y decir siempre
    // "ausente" con toda la razón del mundo.
    expect(STRANDED_THRESHOLD_ENV).toBe(THRESHOLD_ENV);
    expect(describeStrandedThresholdStartup().setting).toBe(THRESHOLD_ENV);
  });

  it.each([
    undefined,
    '',
    '   ',
  ])('AUSENTE (%s): se dice que la alerta está apagada A PROPÓSITO, y NO como un error', (raw) => {
    if (raw === undefined) delete process.env[THRESHOLD_ENV];
    else process.env[THRESHOLD_ENV] = raw;

    const report = describeStrandedThresholdStartup();

    expect(report.state).toBe('unset');
    // Colapsar esto con "ilegible" sería exactamente el error que el aviso corrige: un
    // grito por una alerta que nadie encendió entrena al operador a ignorar el log.
    expect(report.level).toBe('info');
    expect(report.level).not.toBe('warn');
    expect(report.value).toBe('(unset)');
    expect(report.message).toMatch(/NO ESTA CONFIGURADA/);
    expect(report.message).toMatch(/APAGADA a proposito/);
    expect(report.message).toMatch(/NO ES UN ERROR/);
    // Y ninguno de los textos del caso ilegible aparece acá.
    expect(report.message).not.toMatch(/ILEGIBLE/);
    expect(report.message).not.toContain('⚠️');
  });

  it.each([
    undefined,
    '',
    '   ',
  ])('AUSENTE (%s): la POLÍTICA no cambia — la alerta sigue sin sonar y sin tocar la base', async (raw) => {
    if (raw === undefined) delete process.env[THRESHOLD_ENV];
    else process.env[THRESHOLD_ENV] = raw;

    describeStrandedThresholdStartup();
    const field = getStrandedHealthField();
    await flush();
    await refreshStrandedExposure();

    expect(field).toEqual({});
    expect(mockCount).not.toHaveBeenCalled();
    expect(alertaDelLog()).toBeUndefined();
  });

  it.each([
    '1O',
    'abc',
    'NaN',
    '0',
    '-1',
    '1,5',
    '19 USD',
    'Infinity',
  ])('ILEGIBLE (%s): se GRITA, con el valor crudo, y NUNCA se reporta como ausente', (raw) => {
    process.env[THRESHOLD_ENV] = raw;

    const report = describeStrandedThresholdStartup();

    expect(report.state).toBe('unreadable');
    expect(report.state).not.toBe('unset');
    // Es el estado que amerita el grito: la env está puesta y no hace nada.
    expect(report.level).toBe('warn');
    expect(report.message).toContain('⚠️');
    expect(report.message).toMatch(/ILEGIBLE/);
    // El valor crudo va en el mensaje Y en el campo estructurado: sin verlo, el operador
    // no puede distinguir `1O` de `10` mirando el log.
    expect(report.value).toBe(raw);
    expect(report.message).toContain(raw);
    // Y el texto del caso ausente NO sirve para este caso.
    expect(report.message).not.toMatch(/NO ESTA CONFIGURADA/);
    expect(report.message).not.toMatch(/NO ES UN ERROR/);
  });

  it.each([
    '1O',
    'abc',
    '0',
    '-1',
  ])('ILEGIBLE (%s): y el grito está justificado — la alerta efectivamente NO suena', async (raw) => {
    process.env[THRESHOLD_ENV] = raw;
    // 999999 varados en la ventana: si el umbral se leyera, esto sería breach seguro.
    mockCount.mockResolvedValue({
      runs: 900,
      exposureUsd: 999_999,
      truncated: true,
    });

    const report = describeStrandedThresholdStartup();
    await refreshStrandedExposure();

    expect(report.state).toBe('unreadable');
    // El síntoma que el aviso viene a delatar: silencio total, idéntico al de "no hay
    // nada que alertar". El aviso de arranque es la ÚNICA señal que queda.
    expect(getStrandedThresholdUsd()).toBeNull();
    expect(mockCount).not.toHaveBeenCalled();
    expect(alertaDelLog()).toBeUndefined();
    expect(getStrandedHealthField()).toEqual({});
  });

  it('PUESTA Y LEGIBLE: con el 19 que hay en producción, el arranque imprime 19', () => {
    process.env[THRESHOLD_ENV] = '19';

    const report = describeStrandedThresholdStartup();

    expect(report.state).toBe('active');
    expect(report.level).toBe('info');
    expect(report.value).toBe(19);
    expect(report.message).toContain('19');
    expect(report.message).toMatch(/ACTIVA/);
    // No es un grito: la config está bien. Gritar acá sería ruido que se aprende a ignorar.
    expect(report.message).not.toContain('⚠️');
    expect(report.message).not.toMatch(/ILEGIBLE|NO ESTA CONFIGURADA/);
  });

  it.each([
    '19',
    '12.5',
    '0.75',
    '1000',
    '  19  ',
    '0.000001',
  ])('ATADO (%s): el número que imprime el arranque es EL MISMO que usa la alerta', async (raw) => {
    process.env[THRESHOLD_ENV] = raw;
    const report = describeStrandedThresholdStartup();

    // Se hace sonar la alerta de verdad y se lee el umbral que USÓ.
    mockCount.mockResolvedValue({
      runs: 7,
      exposureUsd: Number(raw) + 1_000,
      truncated: false,
    });
    await refreshStrandedExposure();

    const alerta = alertaDelLog();
    expect(alerta).toBeDefined();
    const usadoPorLaAlerta = (alerta![0] as Record<string, unknown>)
      .thresholdUsd;

    // (a) el campo estructurado del log de arranque
    expect(report.value).toBe(usadoPorLaAlerta);
    // (b) y el número que el operador va a LEER en el texto. Si el arranque dice 19 y la
    // alerta usa 13, el log miente y es peor que no tenerlo.
    expect(report.message).toContain(String(usadoPorLaAlerta));
    // (c) y las dos cosas son la misma lectura de env, no dos parseos paralelos.
    expect(report.value).toBe(getStrandedThresholdUsd());
  });

  it('los tres estados son distinguibles entre sí: ningún texto sirve para otro caso', () => {
    delete process.env[THRESHOLD_ENV];
    const ausente = describeStrandedThresholdStartup();
    process.env[THRESHOLD_ENV] = '1O';
    const ilegible = describeStrandedThresholdStartup();
    process.env[THRESHOLD_ENV] = '19';
    const activa = describeStrandedThresholdStartup();

    expect(new Set([ausente.state, ilegible.state, activa.state]).size).toBe(3);
    expect(
      new Set([ausente.message, ilegible.message, activa.message]).size,
    ).toBe(3);
    // El único que grita es el que tiene la env puesta sin efecto.
    expect([ausente.level, ilegible.level, activa.level]).toEqual([
      'info',
      'warn',
      'info',
    ]);
    // Y el valor reportado nunca es el mismo tipo de dato por casualidad.
    expect(ausente.value).toBe('(unset)');
    expect(ilegible.value).toBe('1O');
    expect(activa.value).toBe(19);
  });

  it('el aviso de arranque no toca la base: es config, se evalúa una vez y no cuesta I/O', async () => {
    for (const raw of ['19', '1O', '']) {
      process.env[THRESHOLD_ENV] = raw;
      describeStrandedThresholdStartup();
    }
    await flush();
    expect(mockCount).not.toHaveBeenCalled();
  });
});
