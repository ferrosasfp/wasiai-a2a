/**
 * WKH-305 — unit del leaf `compose-input-mapping.ts`.
 *
 * Módulo PURO: cero mocks a propósito. Todo lo que este archivo prueba es
 * observable sin tocar red, DB ni budget, y por eso puede afirmarse con
 * `toBe`/`toEqual` sobre referencias concretas en vez de sobre spies.
 *
 * Objetivo de cobertura: 100% de líneas y ramas. Un módulo sin dependencias no
 * tiene excusa para tener una rama sin visitar.
 *
 * Naming: T-MAP-09..T-MAP-11 son los del Story File; T-MAP-L* son los casos por
 * regla (S2..S8, R2/R4/R5/R6), cada uno con su positivo y su negativo.
 */

import { describe, expect, it } from 'vitest';
import {
  applyMappingTo,
  checkMappingShape,
  MAX_INPUT_MAPPING_ENTRIES,
  MAX_INPUT_MAPPING_KEY_LEN,
  mappingOwnsAnyField,
  resolveStepInput,
  validateInputMappingShape,
} from './compose-input-mapping.js';

// ══════════════════════════════════════════════════════════════
// Los tres del Story File
// ══════════════════════════════════════════════════════════════

describe('WKH-305 · el mapeo NO es un lenguaje de expresiones (AC-3)', () => {
  it('T-MAP-09: un `.` en la clave de origen es un CARÁCTER, no un separador', () => {
    // El único trabajo de este test en la vida: probar que NO hay traversal.
    // Si alguien "mejora" el resolvedor con un `source.split('.').reduce(...)`,
    // esto se pone rojo. Un dot-path convertiría el mapeo en un mini-lenguaje
    // sobre datos de un tercero, que es exactamente lo que CD-1 prohíbe.
    const res = applyMappingTo({}, { x: 'a.b' }, { a: { b: 1 } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure.reason).toBe('SOURCE_FIELD_MISSING');
    expect(res.failure.source).toBe('a.b');
  });

  it('T-MAP-09b: una clave que SÍ se llama "a.b" literalmente sí resuelve', () => {
    // La contracara: el `.` no está prohibido, simplemente no significa nada.
    const res = applyMappingTo({}, { x: 'a.b' }, JSON.parse('{"a.b": 7}'));
    expect(res).toEqual({ ok: true, input: { x: 7 } });
  });
});

describe('WKH-305 · anti prototype-pollution (AC-3 / CD-6)', () => {
  it('T-MAP-10: `__proto__`, `constructor` y `prototype` se rechazan como clave Y como valor', () => {
    for (const bad of ['__proto__', 'constructor', 'prototype']) {
      // Como CLAVE destino. `JSON.parse` (y no un object literal) porque un
      // literal `{__proto__: x}` NO crea una propiedad propia: crearía un test
      // que pasa sin ejercitar el guard.
      const asKey = checkMappingShape(
        JSON.parse(`{"${bad}": "quoteId"}`),
        undefined,
      );
      expect(asKey?.detail).toContain('reserved property name');

      // Como VALOR (clave de origen).
      const asValue = checkMappingShape({ safe: bad }, undefined);
      expect(asValue?.detail).toContain('reserved property name');
    }
  });

  it('T-MAP-10b: un `__proto__` en la salida anterior no contamina Object.prototype', () => {
    const prev = JSON.parse('{"__proto__": {"polluted": 1}, "quoteId": "q-1"}');
    const res = applyMappingTo({}, { quoteId: 'quoteId' }, prev);
    expect(res).toEqual({ ok: true, input: { quoteId: 'q-1' } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).quoteId).toBeUndefined();
  });

  it('T-MAP-10c: el lookup usa Object.hasOwn, no `in` (no camina el prototipo)', () => {
    // `toString` existe en el prototipo de cualquier objeto: con `in` esto
    // resolvería y le mandaría una FUNCIÓN al agente. Con `hasOwn`, falla.
    const res = applyMappingTo({}, { x: 'toString' }, { quoteId: 'q-1' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure.reason).toBe('SOURCE_FIELD_MISSING');
  });
});

describe('WKH-305 · cardinalidad y forma de las entradas (AC-3)', () => {
  it('T-MAP-11: 8 entradas se aceptan, 9 se rechazan, `{}` se rechaza', () => {
    const eight = Object.fromEntries(
      Array.from({ length: MAX_INPUT_MAPPING_ENTRIES }, (_, i) => [
        `d${i}`,
        `s${i}`,
      ]),
    );
    expect(checkMappingShape(eight, {})).toBeNull();

    const nine = { ...eight, dExtra: 'sExtra' };
    expect(checkMappingShape(nine, {})?.detail).toContain('at most 8 entries');

    // `{}` NO es un no-op: un mapeo que no mapea nada es un error del llamador.
    expect(checkMappingShape({}, {})?.detail).toContain('at least one');
  });

  it('T-MAP-11b: valor no-string, vacío o >128 chars → rechazado', () => {
    const long = 'x'.repeat(MAX_INPUT_MAPPING_KEY_LEN + 1);
    const atLimit = 'x'.repeat(MAX_INPUT_MAPPING_KEY_LEN);

    expect(checkMappingShape({ d: 42 }, {})?.detail).toContain('non-empty');
    expect(checkMappingShape({ d: null }, {})?.detail).toContain('non-empty');
    expect(checkMappingShape({ d: '' }, {})?.detail).toContain('non-empty');
    expect(checkMappingShape({ d: long }, {})?.detail).toContain('non-empty');
    expect(checkMappingShape({ [long]: 's' }, {})?.detail).toContain(
      'non-empty',
    );
    // Exactamente en el límite: válido (el tope es inclusivo).
    expect(checkMappingShape({ [atLimit]: atLimit }, {})).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════
// Reglas de FORMA S2..S8
// ══════════════════════════════════════════════════════════════

describe('WKH-305 · reglas de forma S1..S8', () => {
  it('T-MAP-L01 (S1): ausente → null, no activa nada', () => {
    expect(checkMappingShape(undefined, { a: 1 })).toBeNull();
    expect(validateInputMappingShape({ agent: 'a', input: {} }, 1)).toBeNull();
  });

  it('T-MAP-L02 (S2): array, null y primitivos se rechazan; objeto plano se acepta', () => {
    expect(checkMappingShape([['a', 'b']], {})?.detail).toContain(
      'non-array object',
    );
    expect(checkMappingShape(null, {})?.detail).toContain('non-array object');
    expect(checkMappingShape('quoteId', {})?.detail).toContain(
      'non-array object',
    );
    expect(checkMappingShape(7, {})?.detail).toContain('non-array object');
    expect(checkMappingShape({ quoteId: 'quoteId' }, {})).toBeNull();
  });

  it('T-MAP-L03 (S6): `previousOutput` como destino se rechaza; como ORIGEN se acepta', () => {
    const err = checkMappingShape({ previousOutput: 'quoteId' }, {});
    expect(err?.detail).toContain("cannot target 'previousOutput'");
    expect(err?.field).toBe('previousOutput');
    // Como clave de ORIGEN no hay dos escritores: es un campo más de la salida.
    expect(checkMappingShape({ prev: 'previousOutput' }, {})).toBeNull();
  });

  it('T-MAP-L04 (S7): destino que ya existe en `step.input` se rechaza', () => {
    const err = checkMappingShape({ quoteId: 'quoteId' }, { quoteId: 'mine' });
    expect(err?.detail).toContain("is already present in this step's 'input'");
    expect(err?.field).toBe('quoteId');
    // Otro destino sobre el mismo input: válido.
    expect(checkMappingShape({ rate: 'rate' }, { quoteId: 'mine' })).toBeNull();
  });

  it('T-MAP-L05 (S7): sólo cuenta como colisión una clave PROPIA del input', () => {
    // `toString` está en el prototipo, no en el input del llamador: no hay nada
    // que pisar. Con un `in` esto sería un 400 espurio.
    expect(checkMappingShape({ toString: 'x' }, { a: 1 })).toBeNull();
  });

  it('T-MAP-L06 (S8): mapeo en el step 0 se rechaza; en el step 1 se acepta', () => {
    const step = { agent: 'a', input: {}, inputFromPrevious: { q: 'q' } };
    expect(validateInputMappingShape(step, 0)?.message).toContain(
      'not allowed on step 0',
    );
    expect(validateInputMappingShape(step, 1)).toBeNull();
  });

  it('T-MAP-L07: `validateInputMappingShape` propaga detail + field del leaf', () => {
    const out = validateInputMappingShape(
      {
        agent: 'a',
        input: { quoteId: 'mine' },
        inputFromPrevious: { quoteId: 'quoteId' },
      },
      1,
    );
    expect(out?.field).toBe('quoteId');
    expect(out?.message).toContain('already present');
    // El mensaje NO trae prefijo de step: lo antepone `compose-step-shape.ts`.
    expect(out?.message.startsWith('Step')).toBe(false);
  });

  it('T-MAP-L08: un step no-objeto no es asunto de este validador', () => {
    // Lo rechaza `validateComposeStepShape` con su propio mensaje histórico.
    expect(validateInputMappingShape(null, 1)).toBeNull();
    expect(validateInputMappingShape('nope', 1)).toBeNull();
  });

  it('T-MAP-L09: un problema de forma SIN field no inventa la propiedad', () => {
    // `exactOptionalPropertyTypes`: `field` se omite, no se pone en `undefined`.
    const out = validateInputMappingShape(
      { agent: 'a', input: {}, inputFromPrevious: {} },
      1,
    );
    expect(out).not.toBeNull();
    expect(Object.hasOwn(out as object, 'field')).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════
// Reglas de RESOLUCIÓN R1..R6
// ══════════════════════════════════════════════════════════════

describe('WKH-305 · resolveStepInput — R1 (base) idéntica a la de siempre', () => {
  it('T-MAP-L10 (R1/R2): sin passOutput y sin mapeo → la MISMA referencia de step.input', () => {
    const input = { a: 1 };
    const res = resolveStepInput({ input }, { quoteId: 'q-1' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input).toBe(input); // toBe: ni copia ni allocación nueva
  });

  it('T-MAP-L11 (R1): con passOutput y lastOutput truthy → base con `previousOutput`', () => {
    const prev = { quoteId: 'q-1' };
    const res = resolveStepInput({ input: { a: 1 }, passOutput: true }, prev);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input).toEqual({ a: 1, previousOutput: prev });
    expect(res.input.previousOutput).toBe(prev); // verbatim, sin clonar
  });

  it('T-MAP-L12 (R1): passOutput con lastOutput FALSY → sin `previousOutput` (truthiness intacta)', () => {
    // El truthiness es el de siempre: `null`, `0`, `''` y `false` NO inyectan.
    // Cambiarlo por `!= null` alteraría el body downstream de pipelines vivos.
    for (const falsy of [null, undefined, 0, '', false]) {
      const input = { a: 1 };
      const res = resolveStepInput({ input, passOutput: true }, falsy);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.input).toBe(input);
    }
  });

  it('T-MAP-L13 (R3): la forma se revalida en el service, no sólo en la ruta', () => {
    // Fail-closed: `/orchestrate/execute` no pasa por `validateComposeBody`.
    const res = resolveStepInput(
      {
        input: {},
        inputFromPrevious: 'quoteId' as unknown as Record<string, string>,
      },
      { quoteId: 'q-1' },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure.reason).toBe('INVALID_MAPPING_SHAPE');
  });

  it('T-MAP-L14 (R3/S7): el service TAMBIÉN hace cumplir S7 sobre `step.input`', () => {
    const res = resolveStepInput(
      { input: { quoteId: 'mine' }, inputFromPrevious: { quoteId: 'quoteId' } },
      { quoteId: 'q-1' },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure.reason).toBe('INVALID_MAPPING_SHAPE');
    expect(res.failure.field).toBe('quoteId');
  });

  it('T-MAP-L15 (§5.4): `passOutput` y el mapeo COEXISTEN', () => {
    const prev = { quoteId: 'q-1', rate: 3.7 };
    const res = resolveStepInput(
      {
        input: { method: 'yape' },
        passOutput: true,
        inputFromPrevious: { quoteId: 'quoteId' },
      },
      prev,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input).toEqual({
      method: 'yape',
      previousOutput: prev,
      quoteId: 'q-1',
    });
  });
});

describe('WKH-305 · applyMappingTo — R2..R6', () => {
  it('T-MAP-L16 (R2): sin mapeo devuelve la base POR LA MISMA REFERENCIA', () => {
    const base = { a: 1 };
    const res = applyMappingTo(base, undefined, { quoteId: 'q-1' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input).toBe(base);
  });

  it('T-MAP-L17 (R4): `null`, `undefined`, array y primitivo → PREVIOUS_OUTPUT_NOT_OBJECT', () => {
    for (const prev of [null, undefined, [1, 2], 'q-1', 42, true]) {
      const res = applyMappingTo({}, { quoteId: 'quoteId' }, prev);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.failure.reason).toBe('PREVIOUS_OUTPUT_NOT_OBJECT');
    }
  });

  it('T-MAP-L18 (R4): un `A2AMessage` es un objeto plano → falla por SOURCE_FIELD_MISSING', () => {
    // §5.4: NO se re-implementa `isA2AMessage` en el resolvedor. Los dos casos de
    // AC-2 quedan cubiertos sin ramas especiales por tipo de payload.
    const res = applyMappingTo(
      {},
      { quoteId: 'quoteId' },
      { kind: 'message', parts: [{ kind: 'text', text: 'hola' }] },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure.reason).toBe('SOURCE_FIELD_MISSING');
  });

  it('T-MAP-L19 (R5): `undefined` presente cuenta como AUSENTE', () => {
    // `hasOwn` es true pero el valor es `undefined`: sin este guard viajaría una
    // clave fantasma en el body del agente. JSON nunca produce `undefined`, así
    // que sólo puede venir de un objeto JS interno.
    const prev: Record<string, unknown> = { quoteId: undefined };
    const res = applyMappingTo({}, { quoteId: 'quoteId' }, prev);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure.reason).toBe('SOURCE_FIELD_MISSING');
    expect(res.failure.field).toBe('quoteId');
    expect(res.failure.source).toBe('quoteId');
  });

  it('T-MAP-L20 (R5): `null` es un valor PRESENTE y SE MAPEA', () => {
    // El gateway no inventa la semántica "null no cuenta" sobre datos de un
    // tercero: la clave existe. El residual (un `quoteId:null` que llega al
    // agente y falla pagando) es el lado "requiere ejecutar" de la frontera y es
    // residuo declarado de WKH-306.
    const res = applyMappingTo({}, { quoteId: 'quoteId' }, { quoteId: null });
    expect(res).toEqual({ ok: true, input: { quoteId: null } });
  });

  it('T-MAP-L21 (R6): el valor se copia VERBATIM, misma referencia, sin coercionar', () => {
    const nested = { deep: { a: [1, 2] } };
    const res = applyMappingTo(
      {},
      { payload: 'obj', n: 'num', b: 'bool' },
      {
        obj: nested,
        num: 0,
        bool: false,
      },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input.payload).toBe(nested); // misma referencia, sin clonar
    expect(res.input.n).toBe(0); // sin stringificar
    expect(res.input.b).toBe(false);
  });

  it('T-MAP-L22 (R6/CD-5): ni `base` ni `lastOutput` se mutan', () => {
    const base = { method: 'yape' };
    const prev = { quoteId: 'q-1' };
    const res = applyMappingTo(base, { quoteId: 'quoteId' }, prev);
    expect(base).toEqual({ method: 'yape' }); // sin la clave nueva
    expect(prev).toEqual({ quoteId: 'q-1' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input).not.toBe(base); // objeto NUEVO
    expect(res.input).toEqual({ method: 'yape', quoteId: 'q-1' });
  });

  it('T-MAP-L23 (R6): el mapeado GANA sobre una clave homónima de la base', () => {
    // Es lo que hace posible AC-7: en el retry la base es el input que devolvió
    // el LLM, que ya lleva el campo — y el valor autoritativo es el del step
    // anterior, no el que el modelo haya inventado.
    const res = applyMappingTo(
      { quoteId: 'inventado-por-el-LLM' },
      { quoteId: 'quoteId' },
      { quoteId: 'q-real' },
    );
    expect(res).toEqual({ ok: true, input: { quoteId: 'q-real' } });
  });

  it('T-MAP-L24: varias entradas se resuelven todas, y la PRIMERA que falla manda', () => {
    const ok = applyMappingTo(
      {},
      { quoteId: 'quoteId', rate: 'rate' },
      { quoteId: 'q-1', rate: 3.7 },
    );
    expect(ok).toEqual({ ok: true, input: { quoteId: 'q-1', rate: 3.7 } });

    const bad = applyMappingTo(
      {},
      { quoteId: 'quoteId', rate: 'rate' },
      { quoteId: 'q-1' },
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.failure.source).toBe('rate');
  });

  it('T-MAP-L26 (CR MNR-2): `mappingOwnsAnyField` es la intersección campos-señalados ∩ destinos', () => {
    const mapping = { quoteId: 'quoteId', rate: 'fxRate' };
    // Positivo: el agente señala un campo que el mapeo PUEBLA ⇒ el retry
    // repetiría el mismo valor rechazado ⇒ no se reintenta.
    expect(mappingOwnsAnyField(mapping, ['quoteId'])).toBe(true);
    expect(mappingOwnsAnyField(mapping, ['amount', 'rate'])).toBe(true);
    // Negativo: ningún campo señalado es destino ⇒ el retry sigue teniendo
    // sentido y corre como siempre.
    expect(mappingOwnsAnyField(mapping, ['amount'])).toBe(false);
    // El lado ORIGEN no cuenta: `fxRate` es de dónde se lee, no lo que el
    // agente ve. Si el agente se queja de `fxRate`, no es el campo que
    // escribimos nosotros.
    expect(mappingOwnsAnyField(mapping, ['fxRate'])).toBe(false);
    // Sin mapeo o sin campos ⇒ nunca bloquea el retry (CD-3: byte-idéntico).
    expect(mappingOwnsAnyField(undefined, ['quoteId'])).toBe(false);
    expect(mappingOwnsAnyField(mapping, [])).toBe(false);
    expect(mappingOwnsAnyField(mapping, null)).toBe(false);
    expect(mappingOwnsAnyField(mapping, undefined)).toBe(false);
  });

  it('T-MAP-L27 (CD-6): `mappingOwnsAnyField` usa hasOwn, no hereda del prototipo', () => {
    // Con `in`, un agente que señalara `constructor` o `toString` bloquearía el
    // retry de CUALQUIER step con mapeo, aunque el mapeo no toque ese campo.
    const mapping = { quoteId: 'quoteId' };
    expect(mappingOwnsAnyField(mapping, ['constructor'])).toBe(false);
    expect(mappingOwnsAnyField(mapping, ['toString'])).toBe(false);
    expect(mappingOwnsAnyField(mapping, ['hasOwnProperty'])).toBe(false);
  });

  it('T-MAP-L25: el orden de chequeo es forma → lastOutput → entrada', () => {
    // Un mapeo malformado sobre una salida que TAMPOCO es objeto reporta el
    // problema de forma, no el de la salida: el body del llamador es lo primero
    // que puede arreglar.
    const res = applyMappingTo({}, {} as Record<string, string>, null);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure.reason).toBe('INVALID_MAPPING_SHAPE');
  });
});
