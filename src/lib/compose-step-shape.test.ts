/**
 * HU-208 — `validateComposeStepShape`: el contrato "exactamente uno de
 * {agent, capability}" y la validación de `constraints`.
 *
 * Por qué importa que estos checks vivan en una función PURA y se prueben acá:
 * `routes/compose.ts` los ejecuta en `validateComposeBodyHandler`, o sea ANTES
 * del middleware de pago. Todo lo que este archivo rechaza se rechaza SIN débito.
 * Un check que se agregue al route handler en vez de acá NO hereda esa propiedad
 * (fue exactamente el bug HIGH-2 de 2026-07-26).
 *
 * Naming: T-SHAPE-01..T-SHAPE-14.
 */

import { describe, expect, it } from 'vitest';
import { validateComposeStepShape } from './compose-step-shape.js';

describe('HU-208 · validateComposeStepShape — exactamente uno de {agent, capability}', () => {
  it('T-SHAPE-01: sólo `agent` → válido (el camino de siempre)', () => {
    expect(validateComposeStepShape({ agent: 'kyc', input: {} }, 0)).toBeNull();
  });

  it('T-SHAPE-02: sólo `capability` → válido (el camino nuevo)', () => {
    expect(
      validateComposeStepShape({ capability: 'kyc-check', input: {} }, 0),
    ).toBeNull();
  });

  it('T-SHAPE-03: LOS DOS → 400 `ambiguous_step` (WAS-187 AC-3)', () => {
    // Éste es el AC que en wasiai-v2 quedó INCUMPLIDO: allá el mensaje era el
    // correcto pero el código salía como `validation_error`, así que un cliente
    // no podía distinguir esta condición de cualquier otro 400. Acá se afirma el
    // CÓDIGO, no el texto — que es lo único que un cliente puede usar.
    const err = validateComposeStepShape(
      { agent: 'kyc', capability: 'kyc-check', input: {} },
      2,
    );
    expect(err?.code).toBe('ambiguous_step');
    expect(err?.step).toBe(2);
    expect(err?.error).toContain('mutually exclusive');
  });

  it('T-SHAPE-04: NINGUNO → 400 `VALIDATION_ERROR` (código histórico preservado)', () => {
    // El código NO cambia a uno nuevo a propósito: este es literalmente el caso
    // que ya devolvía 400 antes de la HU (step sin `agent` string), así que
    // cambiarlo rompería a cualquiera que hoy discrimine por él.
    const err = validateComposeStepShape({ input: {} }, 1);
    expect(err?.code).toBe('VALIDATION_ERROR');
    expect(err?.step).toBe(1);
  });

  it('T-SHAPE-05: `agent` no-string (número) → 400, no se cuela como válido', () => {
    const err = validateComposeStepShape({ agent: 12345, input: {} }, 1);
    expect(err?.code).toBe('VALIDATION_ERROR');
  });

  it('T-SHAPE-06: string VACÍO no cuenta como declarado (ni `agent` ni `capability`)', () => {
    // Un `capability: ''` matchearía "typeof === string" pero no identifica
    // ninguna capacidad: si pasara, iría a discovery y volvería con un conjunto
    // arbitrario.
    expect(validateComposeStepShape({ agent: '', input: {} }, 0)?.code).toBe(
      'VALIDATION_ERROR',
    );
    expect(
      validateComposeStepShape({ capability: '', input: {} }, 0)?.code,
    ).toBe('VALIDATION_ERROR');
  });

  it('T-SHAPE-07: step null/undefined → 400 (no explota)', () => {
    expect(validateComposeStepShape(null, 0)?.code).toBe('VALIDATION_ERROR');
    expect(validateComposeStepShape(undefined, 0)?.code).toBe(
      'VALIDATION_ERROR',
    );
  });
});

describe('HU-208 · validateComposeStepShape — constraints', () => {
  it('T-SHAPE-08: constraints válidos junto a `capability` → OK', () => {
    expect(
      validateComposeStepShape(
        {
          capability: 'fx',
          input: {},
          constraints: { max_price_usdc: 1.5, min_reputation: 60 },
        },
        0,
      ),
    ).toBeNull();
  });

  it('T-SHAPE-09: `NaN` en una restricción numérica → 400 (port del defecto WAS-187-01 COMO ARREGLO)', () => {
    // En wasiai-v2 el guard era `!== undefined`, así que `NaN` pasaba y llegaba a
    // PostgREST como `null` → query silenciosamente incorrecta.
    //
    // Acá sería peor de diagnosticar: los filtros comparan con `<=`/`>=` y TODA
    // comparación con NaN es `false`, así que el conjunto de candidatos quedaría
    // vacío y el llamador recibiría un `no_agent_match` que culpa al catálogo
    // cuando el problema era su propio parámetro.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '5', null]) {
      expect(
        validateComposeStepShape(
          { capability: 'fx', input: {}, constraints: { max_price_usdc: bad } },
          0,
        )?.code,
      ).toBe('VALIDATION_ERROR');
      expect(
        validateComposeStepShape(
          { capability: 'fx', input: {}, constraints: { min_reputation: bad } },
          0,
        )?.code,
      ).toBe('VALIDATION_ERROR');
    }
  });

  it('T-SHAPE-10: restricción numérica negativa → 400', () => {
    expect(
      validateComposeStepShape(
        { capability: 'fx', input: {}, constraints: { max_price_usdc: -1 } },
        0,
      )?.code,
    ).toBe('VALIDATION_ERROR');
  });

  it('T-SHAPE-11: `constraints` junto a `agent` → 400 (no se ignora en silencio)', () => {
    // Sobre un agente nombrado no hay conjunto de candidatos que filtrar.
    // Aceptarlo y descartarlo sería la misma clase de bug que el NaN: el llamador
    // cree haber puesto un filtro que el servidor tira a la basura.
    const err = validateComposeStepShape(
      { agent: 'kyc', input: {}, constraints: { max_price_usdc: 1 } },
      0,
    );
    expect(err?.code).toBe('VALIDATION_ERROR');
    expect(err?.error).toContain('only applies to a');
  });

  it('T-SHAPE-12: `constraints` no-objeto → 400', () => {
    expect(
      validateComposeStepShape(
        { capability: 'fx', input: {}, constraints: [] },
        0,
      )?.code,
    ).toBe('VALIDATION_ERROR');
  });

  it('T-SHAPE-13: `constraints.chain` → 400 `unsupported constraint`, NO se ignora', () => {
    // `chain` se evaluó como restricción y se RECHAZÓ: forzar el rail es hacerle
    // trampa al ranking. Pero rechazar la FEATURE no puede significar tragarse el
    // parámetro: un llamador que lo mande creería haber fijado el rail mientras
    // el gateway elige por su cuenta. Se lo rechaza explícitamente.
    const err = validateComposeStepShape(
      { capability: 'fx', input: {}, constraints: { chain: 'solana' } },
      0,
    );
    expect(err?.code).toBe('VALIDATION_ERROR');
    expect(err?.error).toContain("unsupported constraint 'chain'");
  });

  it('T-SHAPE-14: cualquier otra clave desconocida en `constraints` → 400', () => {
    expect(
      validateComposeStepShape(
        { capability: 'fx', input: {}, constraints: { min_performance: 50 } },
        0,
      )?.error,
    ).toContain('unsupported constraint');
  });

  // ── T-14 (WKH-313 / DT-7) ──────────────────────────────────────────────
  it('T-14: `allow_trial` booleano se ACEPTA (sin él, el opt-in era inalcanzable)', () => {
    // Sin la clave en el allowlist, un caller que manda `allow_trial` recibe 400
    // `unsupported constraint` y el carril de estreno no se puede pedir por
    // /compose — o sea que el leg de payout de Chaski seguiría sin resolver.
    expect(
      validateComposeStepShape(
        { capability: 'fx', input: {}, constraints: { allow_trial: true } },
        0,
      ),
    ).toBeNull();
    expect(
      validateComposeStepShape(
        {
          capability: 'fx',
          input: {},
          constraints: { min_reputation: 2, allow_trial: false },
        },
        0,
      ),
    ).toBeNull();
  });

  it.each([
    1,
    0,
    'true',
    'false',
    'maybe',
    null,
    {},
    [],
  ])('T-14: `allow_trial: %j` (no booleano) → 400 VALIDATION_ERROR', (bad) => {
    // `validateNumericConstraint` no sirve para esta clave: aceptaría `0`/`1` y
    // rechazaría `true`. Y coercionar sería peor que rechazar: un `'false'`
    // truthy haría que el caller acepte, sin saberlo, un agente sin historial.
    const err = validateComposeStepShape(
      { capability: 'fx', input: {}, constraints: { allow_trial: bad } },
      0,
    );
    expect(err?.code).toBe('VALIDATION_ERROR');
    expect(err?.error).toContain("'allow_trial' must be a boolean");
  });
});

// ══════════════════════════════════════════════════════════════════════
// WKH-305 — forma de `inputFromPrevious` (S1..S8)
//
// Todo lo que este bloque rechaza se rechaza SIN débito y SIN discovery: es la
// misma propiedad que documenta la cabecera del archivo. Las REGLAS no viven
// acá — viven en `compose-input-mapping.ts`, que es también quien las hace
// cumplir del lado del service. Este bloque prueba que la traducción al shape
// `ComposeStepShapeError` (código + índice de step) es la correcta.
//
// Naming: T-SHAPE-15..T-SHAPE-22.
// ══════════════════════════════════════════════════════════════════════

describe('WKH-305 · validateComposeStepShape — forma de `inputFromPrevious`', () => {
  const base = { agent: 'payout', input: { method: 'yape' } };

  it('T-SHAPE-15 (S1): sin `inputFromPrevious` sigue devolviendo null', () => {
    // Retrocompatibilidad: el campo es opcional y su ausencia no activa nada.
    expect(validateComposeStepShape(base, 1)).toBeNull();
  });

  it('T-SHAPE-16 (S1 positivo): un mapeo BIEN formado en un step > 0 pasa', () => {
    expect(
      validateComposeStepShape(
        { ...base, inputFromPrevious: { quoteId: 'quoteId' } },
        1,
      ),
    ).toBeNull();
  });

  it('T-SHAPE-17 (S2): no-objeto o array → VALIDATION_ERROR con el step correcto', () => {
    for (const bad of [[], 'quoteId', 42, null]) {
      const err = validateComposeStepShape(
        { ...base, inputFromPrevious: bad },
        2,
      );
      expect(err?.code).toBe('VALIDATION_ERROR');
      expect(err?.step).toBe(2);
      expect(err?.error).toContain('Step 2:');
      expect(err?.error).toContain('non-array object');
    }
  });

  it('T-SHAPE-18 (S3): `{}` se rechaza y 9 entradas también', () => {
    // Un mapeo que no mapea nada es un error del llamador, no un no-op: mismo
    // criterio que `constraints.chain` unas líneas más arriba.
    expect(
      validateComposeStepShape({ ...base, inputFromPrevious: {} }, 1)?.error,
    ).toContain('at least one');

    const nine = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`d${i}`, `s${i}`]),
    );
    expect(
      validateComposeStepShape({ ...base, inputFromPrevious: nine }, 1)?.error,
    ).toContain('at most 8 entries');
  });

  it('T-SHAPE-19 (S4): clave o valor no-string, vacío o >128 chars → 400', () => {
    const long = 'x'.repeat(129);
    for (const bad of [{ d: 42 }, { d: '' }, { d: long }, { [long]: 's' }]) {
      const err = validateComposeStepShape(
        { ...base, inputFromPrevious: bad },
        1,
      );
      expect(err?.code).toBe('VALIDATION_ERROR');
      expect(err?.error).toContain('non-empty strings');
    }
  });

  it('T-SHAPE-20 (S5): `__proto__`/`constructor`/`prototype` → 400, como clave y como valor', () => {
    for (const bad of ['__proto__', 'constructor', 'prototype']) {
      // Como clave: `JSON.parse` porque un literal `{__proto__: x}` no crea una
      // propiedad propia y el guard no llegaría a evaluarse.
      expect(
        validateComposeStepShape(
          { ...base, inputFromPrevious: JSON.parse(`{"${bad}":"quoteId"}`) },
          1,
        )?.error,
      ).toContain('reserved property name');
      expect(
        validateComposeStepShape(
          { ...base, inputFromPrevious: { safe: bad } },
          1,
        )?.error,
      ).toContain('reserved property name');
    }
  });

  it('T-SHAPE-21 (S6): destino `previousOutput` → 400 (es de `passOutput`)', () => {
    // Si se permitiera, habría dos escritores del mismo campo y el ganador
    // dependería del orden del spread.
    expect(
      validateComposeStepShape(
        { ...base, inputFromPrevious: { previousOutput: 'quoteId' } },
        1,
      )?.error,
    ).toContain("cannot target 'previousOutput'");
  });

  it('T-SHAPE-22 (S7): destino que YA existe en `step.input` → 400', () => {
    // El valor del llamador nunca se descarta en silencio.
    const err = validateComposeStepShape(
      {
        agent: 'payout',
        input: { quoteId: 'el-mio' },
        inputFromPrevious: { quoteId: 'quoteId' },
      },
      1,
    );
    expect(err?.code).toBe('VALIDATION_ERROR');
    expect(err?.error).toContain('already present');
  });

  it('T-SHAPE-23 (S8): mapeo declarado en el step 0 → 400 (no hay step anterior)', () => {
    const err = validateComposeStepShape(
      { ...base, inputFromPrevious: { quoteId: 'quoteId' } },
      0,
    );
    expect(err?.code).toBe('VALIDATION_ERROR');
    expect(err?.step).toBe(0);
    expect(err?.error).toContain('not allowed on step 0');
  });
});
