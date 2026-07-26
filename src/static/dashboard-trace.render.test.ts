/**
 * Render de la pantalla `/dashboard/trace` (WKH-191x) — test REAL, no un smoke.
 *
 * Ejecuta el JS inline que se sirve al browser (extraído del propio HTML del repo)
 * dentro de un DOM mínimo, y mira el HTML que produce. Cubre los tres puntos donde
 * la pantalla puede mentir:
 *
 *  1. AR MENOR-2 — ESCAPE: `esc()` tiene que escapar también las comillas, porque su
 *     salida se interpola DENTRO de atributos (`href="…"`). El `esc()` de
 *     `dashboard.html` usa el truco del text node y NO escapa comillas: si alguien
 *     lo copia de ahí, estos casos se ponen rojos.
 *  2. AR BLQ-BAJO-1b — CONTEO TRUNCADO: con `skipScanTruncated` la pantalla no puede
 *     decir "es el estado bueno" ni rotular el número como "últimas N h".
 *  3. AR MENOR-4 — REINTENTO: si promete "Reintentando cada 10 s", el intervalo tiene
 *     que quedar armado incluso cuando el primer fetch falla.
 *
 * Cero red: `fetch` y `setInterval` son parámetros de la función, no globales.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const HTML = readFileSync(
  resolve(process.cwd(), 'src/static/dashboard-trace.html'),
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
  renderHealth: (health: unknown) => void;
  renderCalls: (calls: unknown[]) => void;
}

interface Screen extends ScreenApi {
  el: (id: string) => FakeEl;
  fetchStub: ReturnType<typeof vi.fn>;
  setIntervalStub: ReturnType<typeof vi.fn>;
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

/**
 * Carga el script inline de la pantalla en un DOM mínimo.
 *
 * `savedToken` simula `localStorage`: con token, el IIFE de init dispara el primer
 * `refresh()` (que es como se abre la pantalla en la vida real).
 */
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

  const document = {
    getElementById: (id: string) => el(id),
    body: makeEl(),
  };
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
  const setIntervalStub = vi.fn(() => 1);

  const factory = new Function(
    'document',
    'window',
    'fetch',
    'setInterval',
    `${script}\nreturn { esc: esc, renderHealth: renderHealth, renderCalls: renderCalls };`,
  ) as (d: unknown, w: unknown, f: unknown, s: unknown) => ScreenApi;

  const api = factory(document, window, fetchStub, setIntervalStub);
  return { ...api, el, fetchStub, setIntervalStub };
}

const HEALTH_ZERO = {
  chains: [{ key: 'avalanche-fuji', label: 'Avalanche Fuji', isDefault: true }],
  defaultChain: 'avalanche-fuji',
  lastCrossChainSettle: null,
  skipWindowHours: 24,
  skips: [],
  skipsTotal: 0,
  skipSignalPresent: true,
  skipScanLimit: 500,
  skipScanTruncated: false,
};

// ── 1. Escape (AR MENOR-2) ───────────────────────────────────────────────────
describe('esc(): el escape de la pantalla', () => {
  it('T-ESC-1: un <script> no sale como tag', () => {
    const { esc } = loadScreen();
    const out = esc('<script>alert(1)</script>');
    expect(out).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).not.toContain('<script');
  });

  it('T-ESC-2: las COMILLAS se escapan (la salida se usa dentro de atributos)', () => {
    const { esc } = loadScreen();
    expect(esc('" onmouseover="alert(1)')).toBe(
      '&quot; onmouseover=&quot;alert(1)',
    );
    expect(esc("' onmouseover='alert(1)")).toBe(
      '&#39; onmouseover=&#39;alert(1)',
    );
  });

  it('T-ESC-3: el & se escapa PRIMERO (sin doble escape de las entidades propias)', () => {
    const { esc } = loadScreen();
    expect(esc('a & b')).toBe('a &amp; b');
    // Si el orden estuviera invertido, esto daría `&amp;lt;`.
    expect(esc('&lt;')).toBe('&amp;lt;');
  });

  it('T-ESC-4: null y undefined dan string vacío (no "null" en pantalla)', () => {
    const { esc } = loadScreen();
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });
});

// ── 2. Render con datos hostiles ──────────────────────────────────────────────
describe('render: datos hostiles de la DB no ejecutan nada', () => {
  const hostileCall = {
    id: 'req-1',
    at: '2026-07-26T12:00:00.000Z',
    correlation: 'full',
    endpoint: '<img src=x onerror=alert(1)>',
    method: 'POST',
    status: 'success',
    httpStatus: 200,
    latencyMs: 10,
    // El identificador del caller es un dato de tenant: nunca es de confianza.
    ownerRef: 'tenant" onload="alert(1)',
    legs: [
      {
        receiptId: 'rc-1',
        at: '2026-07-26T12:00:00.000Z',
        receiptType: 'budget_debit',
        amountUsd: '0.03000000',
        ownerRef: 'tenant" onload="alert(1)',
        paidOn: { key: null, label: '<b>Fuji</b>' },
        collectedOn: { key: null, label: 'Solana' },
        crossChain: true,
        txHash: 'abc',
        // Un explorer mal configurado también entra por acá.
        explorerTxUrl: 'https://x.test/tx/abc" onclick="alert(1)',
        isCallerDebit: true,
      },
    ],
    skips: [
      { code: 'SETTLE_FAILED', count: 1, meaning: '<script>alert(1)</script>' },
    ],
    crossChain: true,
    fee: null,
  };

  /**
   * ¿Quedó un handler inline (`onclick=…`) que el BROWSER vaya a ejecutar?
   *
   * Primero se vacían los valores de atributo entre comillas (`="…"` → `=""`): un
   * `onclick=` que vive DENTRO de un valor es texto inerte, porque el escape convirtió
   * la comilla del dato en `&quot;` y el valor nunca se cerró antes de tiempo. Lo que
   * queda después de vaciarlos es la estructura real del tag, y ahí un handler sólo
   * puede aparecer si el dato logró salirse del atributo.
   */
  function hasInlineHandler(html: string): boolean {
    const structure = html.replace(/="[^"]*"/g, '=""');
    return /<[a-z]+[^>]*\son[a-z]+\s*=/i.test(structure);
  }

  it('T-XSS-1: ni un tag ni un handler inline sobrevive al render de una llamada', () => {
    const screen = loadScreen();
    screen.renderCalls([hostileCall]);
    const html = screen.el('calls').innerHTML;

    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<b>');
    expect(hasInlineHandler(html)).toBe(false);
    // Y el dato SÍ se ve, escapado (no se borra en silencio).
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('tenant&quot; onload=&quot;alert(1)');
  });

  it('T-XSS-2: el href queda cerrado (la comilla del dato no abre un atributo)', () => {
    const screen = loadScreen();
    screen.renderCalls([hostileCall]);
    const html = screen.el('calls').innerHTML;
    const href = /href="([^"]*)"/.exec(html)?.[1] ?? '';
    // Todo el valor hostil quedó DENTRO del atributo, con la comilla escapada.
    expect(href).toContain('&quot; onclick=&quot;alert(1)');
  });

  it('T-XSS-3: el nombre de una red hostil tampoco escapa en el panel de salud', () => {
    const screen = loadScreen();
    screen.renderHealth({
      ...HEALTH_ZERO,
      chains: [
        { key: 'x', label: '<img src=x onerror=alert(1)>', isDefault: true },
      ],
    });
    const html = screen.el('health').innerHTML;
    expect(html).not.toContain('<img');
    expect(hasInlineHandler(html)).toBe(false);
  });
});

// ── 3. Conteo truncado (AR BLQ-BAJO-1b) ──────────────────────────────────────
describe('conteo de skips: la pantalla no afirma lo que no leyó', () => {
  it('T-TRUNC-1: sin truncar y con cero skips → "es el estado bueno" y rótulo por horas', () => {
    const screen = loadScreen();
    screen.renderHealth(HEALTH_ZERO);
    const html = screen.el('health').innerHTML;
    expect(html).toContain('Pagos salteados (últimas 24 h)');
    expect(html).toContain('Es el estado bueno');
    expect(html).not.toContain('CONTEO INCOMPLETO');
  });

  it('T-TRUNC-2: truncado con cero skips → NO dice "estado bueno" y avisa el alcance real', () => {
    const screen = loadScreen();
    screen.renderHealth({ ...HEALTH_ZERO, skipScanTruncated: true });
    const html = screen.el('health').innerHTML;
    // El criterio: puede decir "incompleto", no puede decir "todo bien".
    expect(html).not.toContain('Es el estado bueno');
    expect(html).toContain('0 en lo revisado');
    expect(html).toContain(
      'Pagos salteados (últimas 500 llamadas, no toda la ventana)',
    );
    expect(html).toContain('CONTEO INCOMPLETO');
    expect(html).toContain('500 llamadas más recientes');
  });

  it('T-TRUNC-3: truncado CON skips → el total sigue rotulado como incompleto', () => {
    const screen = loadScreen();
    screen.renderHealth({
      ...HEALTH_ZERO,
      skipScanTruncated: true,
      skipsTotal: 3,
      skips: [{ code: 'SETTLE_FAILED', count: 3, meaning: 'no se confirmó' }],
    });
    const html = screen.el('health').innerHTML;
    expect(html).toContain('CONTEO INCOMPLETO');
    expect(html).toContain('SETTLE_FAILED');
  });

  it('T-TRUNC-4: el rótulo usa el límite del payload, no un 500 escrito a mano', () => {
    const screen = loadScreen();
    screen.renderHealth({
      ...HEALTH_ZERO,
      skipScanLimit: 50,
      skipScanTruncated: true,
    });
    const html = screen.el('health').innerHTML;
    expect(html).toContain('últimas 50 llamadas');
    expect(html).not.toContain('500');
  });

  it('T-TRUNC-5: sin señal en los datos sigue diciendo "sin datos" (no un cero)', () => {
    const screen = loadScreen();
    screen.renderHealth({ ...HEALTH_ZERO, skipSignalPresent: false });
    const html = screen.el('health').innerHTML;
    expect(html).toContain('sin datos');
    expect(html).not.toContain('Es el estado bueno');
  });
});

// ── 4. Reintento tras un fetch fallido (AR MENOR-4) ──────────────────────────
describe('markStale: la pantalla reintenta de verdad', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('T-RETRY-1: gateway caído al abrir → avisa DATOS VIEJOS y arma el intervalo', async () => {
    const screen = loadScreen({
      savedToken: 'token-guardado',
      fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    await flush();

    expect(screen.fetchStub).toHaveBeenCalledTimes(1);
    expect(screen.el('refresh-state').textContent).toContain('DATOS VIEJOS');
    expect(screen.el('refresh-state').textContent).toContain('Reintentando');
    // Antes el intervalo se armaba SOLO tras un fetch exitoso: la pantalla
    // prometía reintentar y quedaba muerta.
    expect(screen.setIntervalStub).toHaveBeenCalledTimes(1);
  });

  it('T-RETRY-2: respuesta 500 → también queda reintentando', async () => {
    const screen = loadScreen({
      savedToken: 'token-guardado',
      fetchImpl: () => Promise.resolve({ status: 500, ok: false }),
    });
    await flush();
    expect(screen.el('refresh-state').textContent).toContain('DATOS VIEJOS');
    expect(screen.setIntervalStub).toHaveBeenCalledTimes(1);
  });

  it('T-RETRY-3: un 401 NO arma polling (no se arregla solo, y no promete reintento)', async () => {
    const screen = loadScreen({
      savedToken: 'token-malo',
      fetchImpl: () => Promise.resolve({ status: 401, ok: false }),
    });
    await flush();
    expect(screen.el('refresh-state').textContent).toContain('Token inválido');
    expect(screen.el('refresh-state').textContent).not.toContain(
      'Reintentando',
    );
    expect(screen.setIntervalStub).not.toHaveBeenCalled();
  });

  it('T-RETRY-4: fetch OK → renderiza y arma un ÚNICO intervalo', async () => {
    const screen = loadScreen({
      savedToken: 'token-bueno',
      fetchImpl: () =>
        Promise.resolve({
          status: 200,
          ok: true,
          json: () => Promise.resolve({ health: HEALTH_ZERO, calls: [] }),
        }),
    });
    await flush();
    expect(screen.el('refresh-state').textContent).toContain('Actualizado');
    expect(screen.setIntervalStub).toHaveBeenCalledTimes(1);
    expect(screen.el('health').innerHTML).toContain('Redes conectadas');
  });
});
