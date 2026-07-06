/**
 * Step verification engine — unit tests (WKH-114, W0.3)
 *
 * Motor PURO rules-first (sin I/O, never-throw). Exemplar: arbiter/rules.test.ts.
 * Una assertion por rama del motor; sin mocks de red (la función es pura).
 */

import { describe, expect, it } from 'vitest';
import type {
  Agent,
  StepAcceptance,
  StepResult,
  StepVerdict,
} from '../types/index.js';
import {
  DEFAULT_AC,
  genericAcceptanceCriteria,
  summarizePipelineVerification,
  verifyStepOutput,
} from './verification.js';

/** StepResult mínimo para summarize (solo se lee `acceptance`). */
function stepWith(verdict?: StepVerdict): StepResult {
  return {
    agent: {} as Agent,
    output: {},
    costUsdc: 0,
    latencyMs: 0,
    ...(verdict
      ? { acceptance: { criteria: ['x'], verdict, method: 'rules' as const } }
      : {}),
  };
}

describe('verifyStepOutput — reglas determinísticas', () => {
  // Test 1 (AC-2)
  it('good output cumpliendo AC estructurables → pass, method rules', () => {
    const r = verifyStepOutput({ status: 'booked', confirmationId: 'ABC123' }, [
      'contains "booked"',
      'has confirmationId',
    ]);
    expect(r.verdict).toBe('pass');
    expect(r.method).toBe('rules');
    expect(r.failedCriteria).toBeUndefined();
  });

  // Test 2 (AC-2, AC-3, CD-7)
  it('empty/200-ok body (null/""/{}/[]) → fail + failedCriteria de presencia', () => {
    for (const empty of [null, undefined, '', {}, []] as unknown[]) {
      const r = verifyStepOutput(empty, ['output is present and non-empty']);
      expect(r.verdict).toBe('fail');
      expect(r.failedCriteria?.length).toBeGreaterThan(0);
      expect(r.failedCriteria?.[0]).toMatch(/present|non-empty/i);
    }
  });

  // Test 3 (AC-2, AC-3, CD-7)
  it('error field ({error}/{success:false}/{status:failed}) → fail + failedCriteria', () => {
    for (const bad of [
      { error: 'boom' },
      { success: false },
      { status: 'failed' },
    ]) {
      const r = verifyStepOutput(bad, DEFAULT_AC);
      expect(r.verdict).toBe('fail');
      expect(r.failedCriteria?.length).toBeGreaterThan(0);
    }
  });

  // Test 4 (AC-2, NC-1)
  it('no criteria (undefined) → sustituye DEFAULT_AC y evalúa', () => {
    const good = verifyStepOutput({ result: 'done' }, undefined);
    expect(good.verdict).toBe('pass');
    expect(good.method).toBe('rules');
    expect(good.criteria).toEqual(DEFAULT_AC);

    const bad = verifyStepOutput(null, undefined);
    expect(bad.verdict).toBe('fail');
    expect(bad.criteria).toEqual(DEFAULT_AC);
  });

  // Test 5 (AC-2)
  it('criterio semántico no estructurable + output válido → unverified, method rules', () => {
    const r = verifyStepOutput({ ok: true, itinerary: 'X' }, [
      'the flight was actually booked',
    ]);
    expect(r.verdict).toBe('unverified');
    expect(r.method).toBe('rules');
  });

  // Test 6b (BLQ-ALTO-1, MNR-1, CD-6): un `criteria` no-array/malformado (input
  // NO validado por el caller) NUNCA throwea. Decisión: cae a DEFAULT_AC (no se
  // spreadea un valor no-iterable), por lo que evalúa contra el baseline.
  it('criteria no-array/malformado ({length:1}/5/"foo"/{length:1,"0":"x"}) → no throw, evalúa contra DEFAULT_AC', () => {
    const malformed: unknown[] = [
      { length: 1 }, // truthy, .length>0, NO iterable (el vector del drain)
      5,
      'foo',
      { length: 1, '0': 'x' },
    ];
    for (const bad of malformed) {
      let r: StepAcceptance | undefined;
      expect(() => {
        // cast: emula el input crudo del caller (types dicen string[] pero el
        // runtime no lo garantiza — /compose y /orchestrate/execute no validan).
        r = verifyStepOutput({ result: 'done' }, bad as unknown as string[]);
      }).not.toThrow();
      // Fell back to DEFAULT_AC (baseline) → output presente y sin error → pass.
      expect(r?.verdict).toBe('pass');
      expect(r?.method).toBe('rules');
      expect(r?.criteria).toEqual(DEFAULT_AC);
    }
  });

  // Test 6c (NIT-1): `failedCriteria ⊆ criteria` — cuando una regla global
  // dispara con AC custom sin wording de presencia/error, el label baseline se
  // incluye en `criteria` retornado (invariante types/index.ts).
  it('regla global con AC custom → failedCriteria es subconjunto de criteria', () => {
    // Presence: output vacío + AC custom sin wording de presencia.
    const emptyR = verifyStepOutput(null, ['has confirmationId']);
    expect(emptyR.verdict).toBe('fail');
    expect(emptyR.failedCriteria?.length).toBeGreaterThan(0);
    for (const fc of emptyR.failedCriteria ?? []) {
      expect(emptyR.criteria).toContain(fc);
    }

    // Error: señal de error + AC custom sin wording de error.
    const errR = verifyStepOutput({ error: 'boom' }, ['has confirmationId']);
    expect(errR.verdict).toBe('fail');
    expect(errR.failedCriteria?.length).toBeGreaterThan(0);
    for (const fc of errR.failedCriteria ?? []) {
      expect(errR.criteria).toContain(fc);
    }
  });

  // Test 6d (NIT-2): literal ENTRE COMILLAS es machine-checkable (el prompt del
  // planner ahora instruye este formato). Matchea keys y valores (señal-only).
  it('contains "literal" entrecomillado → pass cuando el output lo contiene', () => {
    const r = verifyStepOutput({ status: 'ok', confirmation: 'ABC123' }, [
      'contains "confirmation"',
    ]);
    expect(r.verdict).toBe('pass');
    expect(r.method).toBe('rules');
  });

  // Test 6 (CD-6, CD-8)
  it('output circular/BigInt que rompe JSON.stringify → unverified sin throw', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    let r: ReturnType<typeof verifyStepOutput> | undefined;
    expect(() => {
      r = verifyStepOutput(circular, ['contains "x"']);
    }).not.toThrow();
    expect(r?.verdict).toBe('unverified');
    expect(r?.method).toBe('none');

    let r2: ReturnType<typeof verifyStepOutput> | undefined;
    expect(() => {
      r2 = verifyStepOutput({ v: 1n }, ['contains "v"']);
    }).not.toThrow();
    expect(r2?.verdict).toBe('unverified');
  });
});

describe('summarizePipelineVerification — precedencia', () => {
  // Test 7 (AC-5)
  it('todos pass → verified', () => {
    const r = summarizePipelineVerification([
      stepWith('pass'),
      stepWith('pass'),
    ]);
    expect(r).toBe('verified');
  });

  // Test 8 (AC-3, AC-5)
  it('≥1 fail → incomplete (gana sobre todo)', () => {
    const r = summarizePipelineVerification([
      stepWith('pass'),
      stepWith('fail'),
      stepWith('unverified'),
    ]);
    expect(r).toBe('incomplete');
  });

  // Test 9 (AC-5)
  it('mix pass+unverified sin fails → unverified', () => {
    const r = summarizePipelineVerification([
      stepWith('pass'),
      stepWith('unverified'),
    ]);
    expect(r).toBe('unverified');
  });
});

describe('genericAcceptanceCriteria', () => {
  // Test 10 (AC-1)
  it('devuelve lista no-vacía determinística (copia de DEFAULT_AC)', () => {
    const g = genericAcceptanceCriteria();
    expect(g.length).toBeGreaterThan(0);
    expect(g).toEqual(DEFAULT_AC);
    expect(g).not.toBe(DEFAULT_AC); // copia, no referencia
  });
});
