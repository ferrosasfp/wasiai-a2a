/**
 * Clasificación por ACCIÓN de los skip-codes del leg downstream.
 *
 * ── EL HALLAZGO QUE ESTO CIERRA ────────────────────────────────────────────────
 * "El código de skip colapsa 4 causas distintas en `NOT_CONFIGURED`: la telemetría
 * no permite diagnosticar por qué no se pagó."
 *
 * Verificado y CIERTO: `PUBLIC_SKIP_CODE` mapea CUATRO códigos internos —
 * `FLAG_OFF`, `CHAIN_ENVIRONMENT_DRIFT`, `MAINNET_NOT_ALLOWED` y
 * `MISSING_INTENT_ID` — al mismo `NOT_CONFIGURED`, y ese código público es lo
 * ÚNICO que llega a `a2a_events.metadata` y de ahí a `/dashboard/trace`.
 *
 * ── QUÉ SE ARREGLÓ Y QUÉ NO ────────────────────────────────────────────────────
 * NO se tocó el vocabulario público, a propósito: para el CALLER las cuatro causas
 * llevan a la MISMA acción ("el gateway no pagó ese leg y no es algo que yo pueda
 * arreglar"), o sea que colapsarlas es correcto por el criterio de la acción, y
 * separarlas sólo le filtraría qué flag, qué allow-list y qué config nuestra está
 * rota. Lo que se agregó es el canal de OPERADOR, donde las cuatro llevan a cuatro
 * personas distintas haciendo cuatro cosas distintas.
 *
 * ── QUÉ AFIRMAN ESTOS TESTS ────────────────────────────────────────────────────
 *  1. Las cuatro causas colapsadas tienen CUATRO acciones DISTINTAS entre sí.
 *  2. El vocabulario público NO cambió (las cuatro siguen siendo `NOT_CONFIGURED`).
 *  3. Los TERCEROS VALORES no se reparten: "no pude leer el balance" no es "la
 *     wallet está seca", y "no sé si se pagó" no es "no se pagó".
 *  4. Cada acción dice quién actúa y qué hace (si no, la separación no sirve).
 */

import { describe, expect, it } from 'vitest';
import {
  DOWNSTREAM_SKIP_ACTIONS,
  type DownstreamSkipAction,
  type DownstreamSkipCode,
  describeSkipActionNext,
  describeSkipActionOwner,
  isDownstreamSkipAction,
  isDownstreamSkipCode,
  PUBLIC_SKIP_CODES,
  toPublicSkipCode,
  toSkipAction,
} from './downstream-skip-code.js';

/**
 * Las CUATRO causas del hallazgo. Se escriben acá como literales A PROPÓSITO: si
 * alguien saca una del mapeo a `NOT_CONFIGURED`, el test de abajo lo dice en vez
 * de derivar la lista del mismo mapeo que está bajo prueba (un guard que se
 * compara consigo mismo no prueba nada).
 */
const COLAPSADAS_EN_NOT_CONFIGURED = [
  'FLAG_OFF',
  'CHAIN_ENVIRONMENT_DRIFT',
  'MAINNET_NOT_ALLOWED',
  'MISSING_INTENT_ID',
] as const satisfies readonly DownstreamSkipCode[];

describe('skip-codes · el colapso en NOT_CONFIGURED, medido', () => {
  it('T-CAUSA-1: son EXACTAMENTE cuatro los códigos internos que caen en NOT_CONFIGURED', () => {
    // El conteo del hallazgo se verifica, no se asume. Si mañana alguien agrega un
    // quinto código genericizado sin decidir su acción, este número cambia y el
    // test obliga a mirarlo.
    const caenEnNotConfigured = (
      [
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
      ] as const satisfies readonly DownstreamSkipCode[]
    ).filter((code) => toPublicSkipCode(code) === 'NOT_CONFIGURED');

    expect(caenEnNotConfigured).toHaveLength(4);
    expect([...caenEnNotConfigured].sort()).toEqual(
      [...COLAPSADAS_EN_NOT_CONFIGURED].sort(),
    );
  });

  it('T-CAUSA-2: el contrato PÚBLICO no se movió — las cuatro siguen colapsadas para el caller', () => {
    // Es una afirmación deliberada, no una omisión: el caller no puede actuar
    // sobre ninguna de las cuatro, así que separárselas sólo filtraría estado
    // nuestro. La separación vive en el canal de operador.
    for (const code of COLAPSADAS_EN_NOT_CONFIGURED) {
      expect(toPublicSkipCode(code)).toBe('NOT_CONFIGURED');
    }
    // …y el vocabulario público no ganó códigos nuevos.
    expect([...PUBLIC_SKIP_CODES].sort()).toEqual(
      [
        'CHAIN_NOT_SUPPORTED',
        'INVALID_PAY_TO_FORMAT',
        'INVALID_PRICE',
        'METHOD_NOT_SUPPORTED',
        'NOT_CONFIGURED',
        'NO_PAYMENT_FIELD',
        'SETTLE_FAILED',
        'SETTLE_UNKNOWN',
        'UNAVAILABLE',
        'ZERO_PAY_TO',
      ].sort(),
    );
  });

  it('T-CAUSA-3: las cuatro tienen CUATRO acciones distintas entre sí', () => {
    const acciones = COLAPSADAS_EN_NOT_CONFIGURED.map(toSkipAction);
    expect(new Set(acciones).size).toBe(4);
  });

  it('T-CAUSA-4: cada una lleva a la acción que le corresponde, nombrada', () => {
    // El detalle importa porque es lo que separa a las personas: nadie actúa por
    // un flag apagado, pero una config incoherente es un incidente.
    expect(toSkipAction('FLAG_OFF')).toBe('NONE_SETTLE_DISABLED');
    expect(toSkipAction('CHAIN_ENVIRONMENT_DRIFT')).toBe('OPERATOR_FIX_CONFIG');
    expect(toSkipAction('MAINNET_NOT_ALLOWED')).toBe(
      'OPERATOR_DECIDE_MAINNET_OPT_IN',
    );
    expect(toSkipAction('MISSING_INTENT_ID')).toBe('OPERATOR_FIX_CODE');
  });

  it('T-CAUSA-5: "nadie actúa" no comparte acción con ninguna de las que SÍ requieren acción', () => {
    // La distinción que hace útil todo esto: si `FLAG_OFF` compartiera acción con
    // cualquier otra, el operador volvería a no poder decir si tiene que
    // levantarse o no.
    const flagOff = toSkipAction('FLAG_OFF');
    for (const code of COLAPSADAS_EN_NOT_CONFIGURED) {
      if (code === 'FLAG_OFF') continue;
      expect(toSkipAction(code)).not.toBe(flagOff);
    }
  });
});

describe('skip-codes · los TERCEROS VALORES no se reparten', () => {
  it('T-TERCERO-1: "no pude leer el balance" NO es "la wallet está seca"', () => {
    // `INSUFFICIENT_BALANCE` es un hecho MEDIDO ⇒ recargar. `BALANCE_READ_FAILED` y
    // `BALANCE_PRECHECK_SKIPPED` son "no se sabe cuánto hay" ⇒ averiguar. Tratarlos
    // igual haría recargar por las dudas cada vez que un RPC parpadea, y escondería
    // el RPC caído. Los tres colapsan en `UNAVAILABLE` para el caller.
    expect(toSkipAction('INSUFFICIENT_BALANCE')).toBe('OPERATOR_FUND_WALLET');
    expect(toSkipAction('BALANCE_READ_FAILED')).toBe(
      'OPERATOR_BALANCE_UNKNOWN',
    );
    expect(toSkipAction('BALANCE_PRECHECK_SKIPPED')).toBe(
      'OPERATOR_BALANCE_UNKNOWN',
    );
    expect(toSkipAction('BALANCE_READ_FAILED')).not.toBe(
      toSkipAction('INSUFFICIENT_BALANCE'),
    );
    // …y los tres SÍ comparten código público, que es el colapso que se corrige.
    expect(toPublicSkipCode('INSUFFICIENT_BALANCE')).toBe('UNAVAILABLE');
    expect(toPublicSkipCode('BALANCE_READ_FAILED')).toBe('UNAVAILABLE');
  });

  it('T-TERCERO-2: "no sé si se pagó" NO es "no se pagó"', () => {
    // `SETTLE_LEDGER_UNAVAILABLE` se genericiza a `UNAVAILABLE` para el caller y
    // ahí pierde su naturaleza: es el MISMO estado que `SETTLE_UNKNOWN` (el leg
    // puede estar pagado). La acción es mirar la cadena, NUNCA reintentar a ciegas.
    expect(toSkipAction('SETTLE_UNKNOWN')).toBe('RECONCILE_ON_CHAIN');
    expect(toSkipAction('SETTLE_LEDGER_UNAVAILABLE')).toBe(
      'RECONCILE_ON_CHAIN',
    );
    expect(toSkipAction('SETTLE_FAILED')).toBe('INVESTIGATE_PAYMENT_REJECTED');
    expect(toSkipAction('SETTLE_LEDGER_UNAVAILABLE')).not.toBe(
      toSkipAction('SETTLE_FAILED'),
    );
  });
});

describe('skip-codes · la tabla de acciones es usable', () => {
  const TODOS = [
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
  ] as const satisfies readonly DownstreamSkipCode[];

  it('T-ACCION-1: todo código interno clasifica en una acción del vocabulario', () => {
    for (const code of TODOS) {
      const action = toSkipAction(code);
      expect(isDownstreamSkipAction(action)).toBe(true);
      expect(DOWNSTREAM_SKIP_ACTIONS).toContain(action);
    }
  });

  it('T-ACCION-2: toda acción dice QUIÉN actúa y QUÉ hace', () => {
    // Sin estas dos frases la separación es un código más que hay que ir a buscar
    // al fuente, o sea que no resuelve el problema que la motivó.
    for (const action of DOWNSTREAM_SKIP_ACTIONS) {
      expect(describeSkipActionOwner(action).length).toBeGreaterThan(0);
      expect(describeSkipActionNext(action).length).toBeGreaterThan(0);
    }
  });

  it('T-ACCION-3: toda acción declarada es alcanzable desde algún código', () => {
    // Una acción sin ningún código que la produzca es texto muerto que la pantalla
    // nunca mostraría.
    const alcanzables = new Set<DownstreamSkipAction>(TODOS.map(toSkipAction));
    for (const action of DOWNSTREAM_SKIP_ACTIONS) {
      expect(alcanzables).toContain(action);
    }
  });

  it('T-ACCION-4: los type-guards rechazan basura y códigos del otro vocabulario', () => {
    expect(isDownstreamSkipCode('FLAG_OFF')).toBe(true);
    // Código PÚBLICO, no interno: no debe pasar por el guard interno.
    expect(isDownstreamSkipCode('NOT_CONFIGURED')).toBe(false);
    expect(isDownstreamSkipCode('constructor')).toBe(false);
    expect(isDownstreamSkipCode(null)).toBe(false);
    expect(isDownstreamSkipAction('constructor')).toBe(false);
    expect(isDownstreamSkipAction('FLAG_OFF')).toBe(false);
    expect(describeSkipActionOwner('nada')).toBe('');
    expect(describeSkipActionNext(42)).toBe('');
  });
});
