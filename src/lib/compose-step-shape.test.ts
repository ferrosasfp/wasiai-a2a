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
});
