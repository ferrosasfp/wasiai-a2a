/**
 * Señal de skip del leg downstream (fix-pack P1, hallazgo 4).
 *
 * Cubre las tres piezas:
 *   1. El mapeo interno → público, incluida la REVISIÓN DE FUGA de información.
 *   2. El decorador de logger que captura el código sin tocar el money-path.
 *   3. Que `FLAG_OFF` (logueado una vez por proceso) igual se reporte SIEMPRE.
 */

import { describe, expect, it, vi } from 'vitest';
import type { DownstreamLogger } from '../types/index.js';
import {
  createSkipCapturingLogger,
  type DownstreamSkipCode,
  describePublicSkipCode,
  isPublicSkipCode,
  noteSkip,
  PUBLIC_SKIP_CODES,
  type PublicDownstreamSkipCode,
  parseSkippedMarker,
  toPublicSkipCode,
} from './downstream-skip-code.js';

/** Todos los skip-codes internos. Si se agrega uno, este array tiene que crecer. */
const ALL_CODES: DownstreamSkipCode[] = [
  'FLAG_OFF',
  'NO_PAYMENT_FIELD',
  'METHOD_NOT_SUPPORTED',
  'CHAIN_NOT_SUPPORTED',
  'CHAIN_ENVIRONMENT_DRIFT',
  'MAINNET_NOT_ALLOWED',
  'INVALID_PAY_TO_FORMAT',
  'ZERO_PAY_TO',
  'INVALID_PRICE',
  'INSUFFICIENT_BALANCE',
  'BALANCE_READ_FAILED',
  'SIGNING_FAILED',
  'VERIFY_FAILED',
  'SETTLE_FAILED',
  'BALANCE_PRECHECK_SKIPPED',
  'BALANCE_LOW_ON_IDEMPOTENT_REPLAY',
];

const PUBLIC_VOCABULARY: PublicDownstreamSkipCode[] = [
  'NO_PAYMENT_FIELD',
  'METHOD_NOT_SUPPORTED',
  'CHAIN_NOT_SUPPORTED',
  'INVALID_PAY_TO_FORMAT',
  'ZERO_PAY_TO',
  'INVALID_PRICE',
  'SETTLE_FAILED',
  'NOT_CONFIGURED',
  'UNAVAILABLE',
];

describe('toPublicSkipCode — mapeo interno → público', () => {
  it('T-MAP-1: todo código interno mapea a algo del vocabulario público', () => {
    for (const code of ALL_CODES) {
      expect(PUBLIC_VOCABULARY).toContain(toPublicSkipCode(code));
    }
  });

  it('T-MAP-2: los códigos de la DECLARACIÓN DEL AGENTE salen verbatim', () => {
    // El caller ya ve estos datos en /discover: no hay nada que ocultar y son
    // accionables para el operador del agente.
    expect(toPublicSkipCode('NO_PAYMENT_FIELD')).toBe('NO_PAYMENT_FIELD');
    expect(toPublicSkipCode('METHOD_NOT_SUPPORTED')).toBe(
      'METHOD_NOT_SUPPORTED',
    );
    expect(toPublicSkipCode('CHAIN_NOT_SUPPORTED')).toBe('CHAIN_NOT_SUPPORTED');
    expect(toPublicSkipCode('INVALID_PAY_TO_FORMAT')).toBe(
      'INVALID_PAY_TO_FORMAT',
    );
    expect(toPublicSkipCode('ZERO_PAY_TO')).toBe('ZERO_PAY_TO');
    expect(toPublicSkipCode('INVALID_PRICE')).toBe('INVALID_PRICE');
    expect(toPublicSkipCode('SETTLE_FAILED')).toBe('SETTLE_FAILED');
  });

  it('T-MAP-3 (FUGA): la CONFIG DEL GATEWAY nunca sale verbatim', () => {
    // FLAG_OFF revela el estado de un feature flag.
    expect(toPublicSkipCode('FLAG_OFF')).toBe('NOT_CONFIGURED');
    // CHAIN_ENVIRONMENT_DRIFT es, por definición, un bug de config NUESTRO:
    // revela si el gateway apunta a testnet mientras publica mainnet.
    expect(toPublicSkipCode('CHAIN_ENVIRONMENT_DRIFT')).toBe('NOT_CONFIGURED');
    // MAINNET_NOT_ALLOWED permitiría enumerar la allow-list sondeando.
    expect(toPublicSkipCode('MAINNET_NOT_ALLOWED')).toBe('NOT_CONFIGURED');
  });

  it('T-MAP-4 (FUGA): el WALLET / las CLAVES del operador nunca salen verbatim', () => {
    // INSUFFICIENT_BALANCE revelaría que la hot wallet del operador está seca en
    // ese rail: inteligencia operativa directa para cronometrar un abuso.
    expect(toPublicSkipCode('INSUFFICIENT_BALANCE')).toBe('UNAVAILABLE');
    expect(toPublicSkipCode('BALANCE_READ_FAILED')).toBe('UNAVAILABLE');
    expect(toPublicSkipCode('BALANCE_PRECHECK_SKIPPED')).toBe('UNAVAILABLE');
    expect(toPublicSkipCode('BALANCE_LOW_ON_IDEMPOTENT_REPLAY')).toBe(
      'UNAVAILABLE',
    );
    // SIGNING_FAILED revelaría que OPERATOR_PRIVATE_KEY falta o es inválida.
    expect(toPublicSkipCode('SIGNING_FAILED')).toBe('UNAVAILABLE');
    // VERIFY_FAILED es el facilitator rechazando NUESTRA firma: detalle interno.
    expect(toPublicSkipCode('VERIFY_FAILED')).toBe('SETTLE_FAILED');
  });

  it('T-MAP-5 (FUGA): ningún código público nombra una env var, una address ni un rail', () => {
    const forbidden = [
      'WASIAI',
      'OPERATOR',
      'PRIVATE_KEY',
      'RPC',
      'MAINNET',
      'TESTNET',
      'FLAG',
      'ENV',
      'DRIFT',
      'BALANCE',
      'FACILITATOR',
      '0x',
    ];
    for (const code of ALL_CODES) {
      const pub = toPublicSkipCode(code);
      for (const bad of forbidden) {
        expect(
          pub.includes(bad),
          `el código público "${pub}" (de "${code}") contiene "${bad}"`,
        ).toBe(false);
      }
    }
  });

  it('T-MAP-6: el vocabulario público es MÁS CHICO que el interno (hay genericización real)', () => {
    const distinct = new Set(ALL_CODES.map(toPublicSkipCode));
    expect(distinct.size).toBeLessThan(ALL_CODES.length);
    expect([...distinct].sort()).toEqual([...PUBLIC_VOCABULARY].sort());
  });
});

describe('createSkipCapturingLogger', () => {
  function spyLogger() {
    return {
      warn: vi.fn<(obj: unknown, msg?: string) => void>(),
      info: vi.fn<(obj: unknown, msg?: string) => void>(),
    } satisfies DownstreamLogger;
  }

  it('T-CAP-1: sin logs, no hay código', () => {
    const cap = createSkipCapturingLogger(spyLogger());
    expect(cap.lastSkipCode()).toBeUndefined();
  });

  it('T-CAP-2: captura el code de un warn y de un info', () => {
    const cap = createSkipCapturingLogger(spyLogger());
    cap.warn({ agentSlug: 'a', code: 'SETTLE_FAILED' }, 'msg');
    expect(cap.lastSkipCode()).toBe('SETTLE_FAILED');

    const cap2 = createSkipCapturingLogger(spyLogger());
    cap2.info({ agentSlug: 'a', code: 'NO_PAYMENT_FIELD' }, 'msg');
    expect(cap2.lastSkipCode()).toBe('NO_PAYMENT_FIELD');
  });

  it('T-CAP-3: NO altera el log — delega al logger interno tal cual', () => {
    const inner = spyLogger();
    const cap = createSkipCapturingLogger(inner);
    const payload = { agentSlug: 'a', code: 'SETTLE_FAILED' };
    cap.warn(payload, 'el mensaje');
    cap.info(payload, 'otro');

    expect(inner.warn).toHaveBeenCalledWith(payload, 'el mensaje');
    expect(inner.info).toHaveBeenCalledWith(payload, 'otro');
  });

  it('T-CAP-4: gana el ÚLTIMO — un código de observabilidad no tapa el terminal', () => {
    // BALANCE_PRECHECK_SKIPPED NO corta el leg; si después el settle falla, el
    // motivo que el caller tiene que ver es el terminal.
    const cap = createSkipCapturingLogger(spyLogger());
    cap.info({ code: 'BALANCE_PRECHECK_SKIPPED' }, 'obs');
    cap.warn({ code: 'SETTLE_FAILED' }, 'terminal');
    expect(cap.lastSkipCode()).toBe('SETTLE_FAILED');
  });

  it('T-CAP-5: ignora payloads sin code o con un code desconocido', () => {
    const cap = createSkipCapturingLogger(spyLogger());
    cap.warn({ agentSlug: 'a' }, 'sin code');
    cap.warn({ code: 'ALGO_QUE_NO_EXISTE' }, 'code raro');
    cap.warn('no es un objeto', 'string');
    cap.warn(null, 'null');
    expect(cap.lastSkipCode()).toBeUndefined();
  });

  it('T-CAP-6: `noteSkip` registra en un logger capturador y es no-op en uno común', () => {
    const cap = createSkipCapturingLogger(spyLogger());
    noteSkip(cap, 'FLAG_OFF');
    expect(cap.lastSkipCode()).toBe('FLAG_OFF');

    // Un logger sin sink no debe explotar (el fallback de compose.ts es así).
    const plain = spyLogger();
    expect(() => noteSkip(plain, 'FLAG_OFF')).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════
// WKH-191x · vocabulario público en runtime (lo consume /dashboard/trace)
// ════════════════════════════════════════════════════════════════════
describe('WKH-191x: vocabulario público runtime', () => {
  it('T-PUB-1: PUBLIC_SKIP_CODES es exactamente el vocabulario público', () => {
    expect([...PUBLIC_SKIP_CODES].sort()).toEqual(
      [...PUBLIC_VOCABULARY].sort(),
    );
  });

  it('T-PUB-2: todo código público tiene una explicación de una línea', () => {
    for (const code of PUBLIC_SKIP_CODES) {
      const meaning = describePublicSkipCode(code);
      expect(meaning.length).toBeGreaterThan(10);
      // Sin em dashes (preferencia de estilo del founder).
      expect(meaning).not.toContain('—');
    }
  });

  it('T-PUB-3 (AC-6): un código INTERNO no pasa el guard público', () => {
    // Estos cuatro son internos: revelan flags, allow-list de mainnet o el
    // estado de la hot wallet del operador. La pantalla NO los debe mostrar.
    for (const internal of [
      'FLAG_OFF',
      'MAINNET_NOT_ALLOWED',
      'INSUFFICIENT_BALANCE',
      'SIGNING_FAILED',
    ]) {
      expect(isPublicSkipCode(internal)).toBe(false);
      expect(describePublicSkipCode(internal)).toBe('');
    }
  });

  it('T-PUB-4: el guard rechaza basura y propiedades heredadas del prototipo', () => {
    expect(isPublicSkipCode(undefined)).toBe(false);
    expect(isPublicSkipCode(42)).toBe(false);
    expect(isPublicSkipCode('')).toBe(false);
    expect(isPublicSkipCode('toString')).toBe(false);
    expect(isPublicSkipCode('constructor')).toBe(false);
  });

  it('T-PUB-5: parseSkippedMarker lee el marcador que escribe compose.ts', () => {
    expect(parseSkippedMarker('skipped:SETTLE_FAILED')).toBe('SETTLE_FAILED');
    expect(parseSkippedMarker('skipped:NOT_CONFIGURED')).toBe('NOT_CONFIGURED');
  });

  it('T-PUB-6: parseSkippedMarker NO acepta un código interno ni otro formato', () => {
    expect(parseSkippedMarker('skipped:INSUFFICIENT_BALANCE')).toBeNull();
    expect(parseSkippedMarker('SETTLE_FAILED')).toBeNull();
    expect(parseSkippedMarker('skipped:')).toBeNull();
    expect(parseSkippedMarker(null)).toBeNull();
    expect(parseSkippedMarker({ code: 'SETTLE_FAILED' })).toBeNull();
  });
});
