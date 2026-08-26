/**
 * WKH-365 — render de la pantalla `/dashboard/tres-preguntas`.
 *
 * Ejecuta el JS inline que se le sirve al browser (extraído del propio HTML del
 * repo) dentro de un DOM mínimo y mira el HTML que produce. Cero red: `fetch` es
 * un parámetro de la función, no un global.
 *
 * Los tres puntos donde esta pantalla podría mentir:
 *  1. pintar de verde un estado que no entiende;
 *  2. dejar entrar un dato hostil de la base sin escapar;
 *  3. tener un segundo `fetch` que dispare algo que cuesta dinero.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const HTML = readFileSync(
  resolve(process.cwd(), 'src/static/dashboard-tres-preguntas.html'),
  'utf-8',
);

interface FakeEl {
  innerHTML: string;
  textContent: string;
  className: string;
  value: string;
  addEventListener: (type: string, handler: () => void) => void;
}

interface ScreenApi {
  esc: (value: unknown) => string;
  estadoDe: (card: unknown) => { clase: string; etiqueta: string };
  motivoTexto: (reason: unknown) => string;
  render: (snapshot: unknown) => void;
}

interface Screen extends ScreenApi {
  el: (id: string) => FakeEl;
  fetchStub: ReturnType<typeof vi.fn>;
}

function makeEl(): FakeEl {
  return {
    innerHTML: '',
    textContent: '',
    className: '',
    value: '',
    addEventListener: () => {
      /* no-op: el harness invoca los handlers a mano */
    },
  };
}

function loadScreen(opts?: {
  savedToken?: string;
  fetchImpl?: () => Promise<unknown>;
}): Screen {
  const script = /<script>([\s\S]*?)<\/script>/.exec(HTML)?.[1];
  if (!script)
    throw new Error('no se encontró el script inline de la pantalla');

  const els = new Map<string, FakeEl>();
  const el = (id: string): FakeEl => {
    const existing = els.get(id);
    if (existing) return existing;
    const created = makeEl();
    els.set(id, created);
    return created;
  };

  const document = { getElementById: (id: string) => el(id), body: makeEl() };
  const saved = opts?.savedToken ?? null;
  const window = {
    location: { origin: 'http://localhost:3001' },
    localStorage: {
      getItem: () => saved,
      setItem: () => {
        /* no-op */
      },
    },
  };
  const fetchStub = vi.fn(
    opts?.fetchImpl ?? (() => Promise.reject(new Error('sin stub de fetch'))),
  );

  const factory = new Function(
    'document',
    'window',
    'fetch',
    `${script}\nreturn { esc: esc, estadoDe: estadoDe, motivoTexto: motivoTexto, render: render };`,
  ) as (d: unknown, w: unknown, f: unknown) => ScreenApi;

  const api = factory(document, window, fetchStub);
  return { ...api, el, fetchStub };
}

const SNAPSHOT_OK = {
  servedAt: '2026-08-26T12:00:00.000Z',
  caja: {
    status: 'ok',
    budget: { '900001': '14.97' },
    daily_limit_usd: 2,
    daily_spent_usd: 0.03,
    daily_reset_at: '2026-08-27T00:00:00.000Z',
    is_active: true,
  },
  reputacion: {
    status: 'ok',
    agentes: [
      { slug: 'remit-fx', tasksSettled: 7, successCount: 6, failedCount: 1 },
    ],
    ventana: 'últimos 30 días',
  },
  escrows: {
    status: 'ok',
    escrows_vivos: 2,
    usdc_bloqueado: '12.5',
    otros_mints_count: 1,
    vencidos: 2,
  },
};

// ── 1. El estado desconocido nunca es verde (T-UI-1) ─────────────────────────

describe('T-UI-1: el default del switch de estado es GRIS', () => {
  it('un status desconocido se pinta "sin dato"', () => {
    const { estadoDe } = loadScreen();
    const e = estadoDe({ status: 'todo-bien' });
    expect(e.clase).toBe('sin-dato');
    expect(e.clase).not.toBe('ok');
    expect(e.etiqueta).toContain('sin dato');
  });

  it('un status AUSENTE se pinta "sin dato"', () => {
    const { estadoDe } = loadScreen();
    for (const card of [{}, null, undefined, { reason: 'error_db' }, 42]) {
      expect(estadoDe(card).clase).toBe('sin-dato');
    }
  });

  it('control POSITIVO: sólo `ok` da la clase verde', () => {
    const { estadoDe } = loadScreen();
    expect(estadoDe({ status: 'ok' }).clase).toBe('ok');
    expect(estadoDe({ status: 'sin_dato', reason: 'rpc_error' }).clase).toBe(
      'sin-dato',
    );
  });

  it('render con una tarjeta de status raro deja el panel gris y sin afirmar nada', () => {
    const screen = loadScreen();
    screen.render({
      ...SNAPSHOT_OK,
      escrows: { status: 'flamante', escrows_vivos: 99 },
    });

    const panel = screen.el('escrows');
    expect(panel.className).toContain('sin-dato');
    expect(panel.className).not.toContain(' ok');
    expect(panel.innerHTML).toContain('sin dato');
    expect(panel.innerHTML).not.toContain('99');
  });

  it('cada motivo de sin_dato llega a la pantalla con su texto propio', () => {
    const screen = loadScreen();
    const motivos = [
      'no_configurado',
      'no_encontrada',
      'error_db',
      'historial_ilegible',
      'rpc_no_configurado',
      'rpc_error',
      'respuesta_invalida',
    ];
    const textos = new Set<string>();
    for (const reason of motivos) {
      screen.render({
        ...SNAPSHOT_OK,
        caja: { status: 'sin_dato', reason },
      });
      const html = screen.el('caja').innerHTML;
      expect(html).not.toContain('motivo desconocido');
      textos.add(html);
    }
    // Siete motivos, siete pantallas distintas: ninguno colapsa con otro.
    expect(textos.size).toBe(motivos.length);
  });

  it('un motivo heredado de Object.prototype cae en el fallback, no en una función', () => {
    const { motivoTexto } = loadScreen();
    // `MOTIVOS[reason] ||` resolvía contra la cadena de prototipos: con
    // 'constructor' devolvía `function Object() { [native code] }` y con
    // '__proto__' un `[object Object]`, o sea basura de runtime justo en el
    // caso que el fallback existe para narrar (un `reason` fuera de la unión).
    for (const heredado of [
      'constructor',
      'toString',
      'valueOf',
      'hasOwnProperty',
      '__proto__',
    ]) {
      expect(motivoTexto(heredado)).toBe('motivo desconocido');
    }
    expect(motivoTexto('inventado')).toBe('motivo desconocido');
    // Control POSITIVO: los motivos propios siguen resolviendo.
    expect(motivoTexto('rpc_error')).toBe('el RPC no contestó');
  });

  it('un `reason` heredado tampoco filtra la función a la pantalla', () => {
    const screen = loadScreen();
    screen.render({
      ...SNAPSHOT_OK,
      caja: { status: 'sin_dato', reason: 'constructor' },
    });

    const html = screen.el('caja').innerHTML;
    expect(html).toContain('motivo desconocido');
    expect(html).not.toContain('native code');
  });
});

// ── 2. Las tres tarjetas con datos (control POSITIVO) ────────────────────────

describe('render: las tres tarjetas', () => {
  it('la caja muestra saldo, gastado y techo', () => {
    const screen = loadScreen();
    screen.render(SNAPSHOT_OK);

    const html = screen.el('caja').innerHTML;
    expect(screen.el('caja').className).toContain('ok');
    expect(html).toContain('14.97');
    expect(html).toContain('0.03');
  });

  it('una key desactivada se muestra como ADVERTENCIA, no como sin dato', () => {
    const screen = loadScreen();
    screen.render({
      ...SNAPSHOT_OK,
      caja: { ...SNAPSHOT_OK.caja, is_active: false },
    });

    const panel = screen.el('caja');
    expect(panel.className).toContain('ok');
    expect(panel.innerHTML).toContain('DESACTIVADA');
  });

  // ── La caja con columnas NULL: ninguna celda puede salir VACÍA ──────────────
  //
  // `daily_spent_usd`, `daily_limit_usd`, `daily_reset_at` e `is_active` son
  // nullables en la base, y `esc()` mapea null a string vacío. La tarjeta salía
  // VERDE con las tres celdas en blanco, o sea con «0», «sin configurar» y «el
  // render se rompió» indistinguibles.
  const CAJA_TODO_NULL = {
    status: 'ok',
    budget: {},
    daily_limit_usd: null,
    daily_spent_usd: null,
    daily_reset_at: null,
    is_active: null,
  };

  it('las columnas NULL de la fila NO se pintan como celdas vacías', () => {
    const screen = loadScreen();
    screen.render({ ...SNAPSHOT_OK, caja: CAJA_TODO_NULL });

    const html = screen.el('caja').innerHTML;
    // Ninguna celda de VALOR sale vacía.
    expect(html).not.toContain('<span></span>');
    // Y cada una dice por qué está vacía.
    expect(html.match(/la fila viene en NULL/g)).toHaveLength(3);
  });

  it('CERO y NULL se ven DISTINTO (que es el punto entero de la tarjeta)', () => {
    const conCero = loadScreen();
    conCero.render({
      ...SNAPSHOT_OK,
      caja: { ...CAJA_TODO_NULL, daily_spent_usd: 0 },
    });
    const conNull = loadScreen();
    conNull.render({ ...SNAPSHOT_OK, caja: CAJA_TODO_NULL });

    const htmlCero = conCero.el('caja').innerHTML;
    const htmlNull = conNull.el('caja').innerHTML;

    expect(htmlCero).toContain('<span>gastado hoy</span><span>0</span>');
    expect(htmlNull).not.toContain('<span>gastado hoy</span><span>0</span>');
    expect(htmlCero).not.toBe(htmlNull);
  });

  it('`is_active` en NULL avisa: nadie afirmó que la key esté activa', () => {
    const screen = loadScreen();
    screen.render({ ...SNAPSHOT_OK, caja: CAJA_TODO_NULL });

    const html = screen.el('caja').innerHTML;
    expect(html).toContain('no dice si la key está activa');
    // No se cae al lado optimista: no dice que esté desactivada NI la presenta
    // como activa sin más.
    expect(html).not.toContain('DESACTIVADA');
  });

  it('control POSITIVO: con `is_active` en true no hay ningún aviso', () => {
    const screen = loadScreen();
    screen.render(SNAPSHOT_OK);

    const html = screen.el('caja').innerHTML;
    expect(html).not.toContain('aviso');
  });

  // ── La tarjeta 2 no puede mentir en verde ──────────────────────────────────
  //
  // El estado ESTACIONARIO de este sistema: la sonda del money-path llama al
  // agente 24 veces por día desde UNA sola key, así que el contador capeado por
  // caller satura en el tope la primera semana y se queda ahí mientras `ok`
  // sigue subiendo. La pantalla mostraba «liquidadas 5 · ok 501» con el chip
  // VERDE, bajo un encabezado que prometía una ventana de 30 días que ninguno
  // de los tres números respeta.
  const REPUTACION_SATURADA = {
    status: 'ok',
    ventana: 'últimos 30 días',
    agentes: [
      { slug: 'remit-fx', tasksSettled: 5, successCount: 501, failedCount: 0 },
    ],
  };

  it('la ventana NO se presenta como el alcance de los contadores', () => {
    const screen = loadScreen();
    screen.render({ ...SNAPSHOT_OK, reputacion: REPUTACION_SATURADA });

    const html = screen.el('reputacion').innerHTML;
    // El rótulo viejo encabezaba la TABLA de contadores con la ventana.
    expect(html).not.toContain('Ventana: últimos 30 días');
    // El nuevo dice qué acota la ventana (quiénes entran) y qué no (los números).
    expect(html).toContain('Universo');
    expect(html).toContain('últimos 30 días');
    expect(html).toContain('NO se acotan');
    expect(html).toContain('historial completo');
  });

  it('«liquidadas» dice que tiene tope, así que 5 contra 501 no es un tablero roto', () => {
    const screen = loadScreen();
    screen.render({ ...SNAPSHOT_OK, reputacion: REPUTACION_SATURADA });

    const panel = screen.el('reputacion');
    // Sigue siendo una tarjeta con datos: el arreglo es el rótulo, no el número.
    expect(panel.className).toContain('ok');
    expect(panel.innerHTML).toContain('>5<');
    expect(panel.innerHTML).toContain('>501<');
    // El encabezado desnudo era la mentira: publicaba el contador anti-Sybil
    // como si fuera la cuenta de tasks liquidadas.
    expect(panel.innerHTML).not.toContain('<th>liquidadas</th>');
    expect(panel.innerHTML).toContain('tope por caller');
    expect(panel.innerHTML).toContain('anti-Sybil');
  });

  it('reputación con lista vacía dice "sin actividad", no "sin dato"', () => {
    const screen = loadScreen();
    screen.render({
      ...SNAPSHOT_OK,
      reputacion: { status: 'ok', agentes: [], ventana: 'últimos 30 días' },
    });

    const panel = screen.el('reputacion');
    expect(panel.className).toContain('ok');
    expect(panel.innerHTML).toContain('Sin actividad');
  });

  it('escrows con `vencidos` en null lo dice con motivo y NO muestra un cero', () => {
    const screen = loadScreen();
    screen.render({
      ...SNAPSHOT_OK,
      escrows: {
        status: 'ok',
        escrows_vivos: 2,
        usdc_bloqueado: '12.5',
        otros_mints_count: 0,
        vencidos: null,
        vencidos_reason: 'rpc_error',
      },
    });

    const html = screen.el('escrows').innerHTML;
    expect(html).toContain('12.5');
    expect(html).toContain('el RPC no contestó');
    expect(html).toContain('No es cero');
    expect(html).not.toMatch(/vencidos[^<]*<\/span><span>0</);
  });

  it('las tres tarjetas se pintan independientes: una gris no arrastra a las otras', () => {
    const screen = loadScreen();
    screen.render({
      ...SNAPSHOT_OK,
      escrows: { status: 'sin_dato', reason: 'rpc_error' },
    });

    expect(screen.el('caja').className).toContain('ok');
    expect(screen.el('reputacion').className).toContain('ok');
    expect(screen.el('escrows').className).toContain('sin-dato');
  });
});

// ── 3. XSS (T-UI-XSS) ────────────────────────────────────────────────────────

describe('T-UI-XSS: esc()', () => {
  it('un <script> no sale como tag', () => {
    const { esc } = loadScreen();
    const out = esc('<script>alert(1)</script>');
    expect(out).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).not.toContain('<script');
  });

  it('las COMILLAS se escapan (la salida se interpola dentro de atributos)', () => {
    const { esc } = loadScreen();
    expect(esc('" onmouseover="alert(1)')).toBe(
      '&quot; onmouseover=&quot;alert(1)',
    );
    expect(esc("' onmouseover='alert(1)")).toBe(
      '&#39; onmouseover=&#39;alert(1)',
    );
  });

  it('el & se escapa PRIMERO (sin doble escape de las entidades propias)', () => {
    const { esc } = loadScreen();
    expect(esc('a & b')).toBe('a &amp; b');
    expect(esc('&lt;')).toBe('&amp;lt;');
  });

  it('null y undefined dan string vacío', () => {
    const { esc } = loadScreen();
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });

  it('un slug hostil de la base no ejecuta nada', () => {
    const screen = loadScreen();
    screen.render({
      ...SNAPSHOT_OK,
      reputacion: {
        status: 'ok',
        ventana: 'últimos 30 días',
        agentes: [
          {
            slug: '<img src=x onerror=alert(1)>',
            tasksSettled: 1,
            successCount: 1,
            failedCount: 0,
          },
        ],
      },
    });

    const html = screen.el('reputacion').innerHTML;
    // El slug hostil NO aparece verbatim: sus delimitadores están escapados, así
    // que el navegador lo lee como texto y no como un tag con un handler.
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

// ── 4. Un solo endpoint, ningún disparador (T-UI-2) ──────────────────────────

describe('T-UI-2: la pantalla no puede disparar nada que cueste', () => {
  it('hay EXACTAMENTE un `fetch(` en el HTML, y va al GET del tablero', async () => {
    expect(HTML.match(/fetch\s*\(/g)).toHaveLength(1);

    const screen = loadScreen({
      savedToken: 'secreto',
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => SNAPSHOT_OK,
        }),
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = screen.fetchStub.mock.calls[0] as [
      string,
      { method?: string; headers: Record<string, string> },
    ];
    expect(url).toBe('http://localhost:3001/dashboard/api/tres-preguntas');
    // Sin `method` es GET.
    expect(init.method).toBeUndefined();
    expect(init.headers['X-Admin-Token']).toBe('secreto');
  });

  it('el HTML no nombra ningún endpoint que gaste', () => {
    for (const prohibido of [
      '/compose',
      '/orchestrate',
      '/settle',
      '/payments',
    ]) {
      expect(HTML).not.toContain(prohibido);
    }
  });

  it('no hay refresco automático: ni setInterval ni setTimeout en la pantalla', () => {
    expect(HTML).not.toContain('setInterval');
    expect(HTML).not.toContain('setTimeout');
  });

  it('sin token no se llama al API', async () => {
    const screen = loadScreen({ fetchImpl: () => Promise.resolve({}) });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.fetchStub).not.toHaveBeenCalled();
  });

  it('el HTML servido no trae ni un dato de tenant', () => {
    const cuerpo = HTML.slice(HTML.indexOf('<body>'), HTML.indexOf('<script>'));
    for (const prohibido of [
      'owner_ref',
      'budget',
      'key_id',
      'usdc_bloqueado',
    ]) {
      expect(cuerpo).not.toContain(prohibido);
    }
  });
});
