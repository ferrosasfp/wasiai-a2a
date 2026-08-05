/**
 * CHEQUEO MECÁNICO del alcance del union `DownstreamSkipCode`.
 *
 * ── LA FRASE QUE ESTO CIERRA ───────────────────────────────────────────────────
 * El docstring del union decía: "TODO valor que salga en el campo `code` de un log
 * de este módulo tiene que estar acá". Era FALSO: `AMBIGUOUS_CHAIN_ALIAS` se emite
 * en `downstream-payment.ts` (paso 4-bis) y NO está en el union — a propósito, es
 * un AVISO y el leg sigue corriendo.
 *
 * ── QUÉ AFIRMAN ESTOS TESTS ────────────────────────────────────────────────────
 *  1. Todo `code` que `downstream-payment.ts` emite es (a) un `DownstreamSkipCode`
 *     o (b) un aviso de la lista explícita de acá abajo. Un código NUEVO que no sea
 *     ninguna de las dos cosas pone esto rojo, que es lo que la frase vieja
 *     prometía sin ningún mecanismo detrás.
 *  2. La lista de avisos NO es un cajón de sastre: cada aviso tiene que estar
 *     realmente emitido en el fuente (si se borra del código, hay que borrarlo de
 *     acá).
 *  3. El union no tiene códigos muertos: cada miembro se emite de verdad.
 *  4. Un aviso NUNCA puede convertirse en el motivo de skip de una respuesta: el
 *     logger capturador filtra por el union (`isDownstreamSkipCode`).
 *
 * ── POR QUÉ ES UN SCAN DE FUENTE Y NO UN TEST DE COMPORTAMIENTO ────────────────
 * La propiedad que se quiere fijar es sobre el CATÁLOGO ("no hay un código emitido
 * que quede fuera de la taxonomía"), no sobre un camino de ejecución. Ejercitar los
 * ~30 `return null` con mocks no probaría la propiedad: probaría los caminos que
 * alguien se acordó de escribir, que es exactamente cómo se coló este agujero.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createSkipCapturingLogger,
  type DownstreamSkipCode,
  isDownstreamSkipCode,
} from './downstream-skip-code.js';

const SOURCE = readFileSync(
  fileURLToPath(new URL('./downstream-payment.ts', import.meta.url)),
  'utf8',
);

/**
 * Avisos: valores que salen en un campo `code` de un log del leg PERO no hablan
 * del intento de pago (el leg sigue corriendo y se paga normal). Quedan FUERA del
 * union a propósito — ver el docstring de `DownstreamSkipCode`.
 *
 * Agregar uno acá es una decisión, no un trámite: significa afirmar que ese código
 * NO describe la suerte del pago.
 */
const ADVISORY_CODES = ['AMBIGUOUS_CHAIN_ALIAS'] as const;

/**
 * Extrae los códigos que el fuente emite en un campo `code` de un log.
 *
 * Dos formas presentes hoy en `downstream-payment.ts`:
 *  · directa    — `code: 'SETTLE_FAILED'`
 *  · indirecta  — `const code = <ternario>` + shorthand `{ code }` en el warn.
 *
 * En la indirecta se descartan los literales que están del lado derecho de un
 * `===` (son comparaciones, p. ej. `payoutCode === 'PAYOUT_FUNDING_LOW'`), no
 * valores emitidos.
 */
function emittedCodes(source: string): string[] {
  const found = new Set<string>();
  for (const m of source.matchAll(/code:\s*'([A-Z0-9_]+)'/g)) {
    if (m[1]) found.add(m[1]);
  }
  for (const block of source.matchAll(/const code\b[\s\S]*?;/g)) {
    const withoutComparisons = block[0].replace(/===\s*'[^']*'/g, '');
    for (const m of withoutComparisons.matchAll(/'([A-Z0-9_]+)'/g)) {
      if (m[1]) found.add(m[1]);
    }
  }
  return [...found].sort();
}

describe('catálogo de códigos del leg downstream', () => {
  it('todo `code` emitido es un skip-code del union o un aviso declarado', () => {
    const emitted = emittedCodes(SOURCE);
    // Sanity del scanner: si el regex dejara de matchear, el test pasaría vacío y
    // no protegería nada (ese es el modo de falla clásico de un scan de fuente).
    expect(emitted.length).toBeGreaterThan(15);

    const unclassified = emitted.filter(
      (code) =>
        !isDownstreamSkipCode(code) &&
        !(ADVISORY_CODES as readonly string[]).includes(code),
    );
    expect(
      unclassified,
      'códigos emitidos por downstream-payment.ts que no están ni en `DownstreamSkipCode` ni en `ADVISORY_CODES`: o son skip-codes (agregalos al union, y el compilador te va a pedir su traducción pública y su acción) o son avisos que no hablan del pago (agregalos a la lista de avisos y actualizá el docstring del union)',
    ).toEqual([]);
  });

  it('la lista de avisos no acumula códigos que ya no se emiten', () => {
    const emitted = emittedCodes(SOURCE);
    for (const advisory of ADVISORY_CODES) {
      expect(emitted, `aviso declarado y no emitido: ${advisory}`).toContain(
        advisory,
      );
    }
  });

  it('el union no tiene códigos muertos: cada miembro se emite en el leg', () => {
    // Lista explícita (no derivada del fuente) para que un miembro nuevo del union
    // tenga que aparecer acá Y estar emitido.
    const members: DownstreamSkipCode[] = [
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
      'SETTLE_UNKNOWN',
      'BALANCE_PRECHECK_SKIPPED',
      'BALANCE_LOW_ON_IDEMPOTENT_REPLAY',
      'MISSING_INTENT_ID',
      'SETTLE_LEDGER_UNAVAILABLE',
    ];
    // Que la lista esté completa lo garantiza el compilador: `Record` exhaustivo.
    const complete: Record<DownstreamSkipCode, true> = Object.fromEntries(
      members.map((m) => [m, true]),
    ) as Record<DownstreamSkipCode, true>;
    expect(Object.keys(complete).length).toBe(members.length);

    const emitted = new Set(emittedCodes(SOURCE));
    for (const member of members) {
      expect(emitted, `skip-code del union sin emisor: ${member}`).toContain(
        member,
      );
    }
  });

  it('un aviso NO puede convertirse en el motivo de skip de una respuesta', () => {
    const inner = { warn: () => {}, info: () => {} };
    const logger = createSkipCapturingLogger(inner);
    logger.warn({ code: 'AMBIGUOUS_CHAIN_ALIAS' }, 'aviso');
    // El capturador filtra por el union: el aviso no queda como último skip-code,
    // así que no puede llegar a `steps[].downstreamSettle` ni a
    // `a2a_events.metadata.downstreamSkipCauses`.
    expect(logger.lastSkipCode()).toBeUndefined();
    // Contra-ejemplo: un skip-code de verdad SÍ se captura.
    logger.warn({ code: 'SETTLE_FAILED' }, 'skip real');
    expect(logger.lastSkipCode()).toBe('SETTLE_FAILED');
  });
});
