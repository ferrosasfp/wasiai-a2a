/**
 * WKH-313 — La POLÍTICA del carril de estreno, sin DB y sin service.
 *
 * Acá se candan las cuatro cosas que el carril NO puede perder:
 *   · la frontera exacta de `N` (T-04) y del techo `T` (T-12);
 *   · que el primer fallo ANULE el carril y no lo decremente (T-05/CD-14);
 *   · que "no pude preguntar" (`degraded`) NO sea "no tiene historial" (T-18/CD-7);
 *   · que el cupo `M` sea DETERMINISTA, incluso con `created_at` empatado (T-19/CD-15).
 *
 * Módulo leaf y funciones puras: cero mocks, cero red.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AgentStandingBatch,
  AgentStandingCounters,
} from '../types/index.js';
// AR fix-pack BLQ-MED-3: el cupo desempata por SORTEO cuando no hay `created_at`.
// La fuente se fija acá para que el reparto sea medible y no un flake.
import {
  _resetTiebreakRandomSource,
  _setTiebreakRandomSource,
} from './ranking-tiebreak.js';
import {
  classifyStanding,
  isTrialEligible,
  resolveTrialMaxAgentsPerPublisher,
  resolveTrialMaxMinReputation,
  resolveTrialMaxSettledTasks,
  selectTrialAdmitted,
  standingFor,
  type TrialCandidate,
} from './trial-standing.js';

const ORIGINAL_ENV = { ...process.env };

function counters(
  o: Partial<AgentStandingCounters> = {},
): AgentStandingCounters {
  return {
    tasksSettled: 0,
    successCount: 0,
    failedCount: 0,
    reputation: null,
    ...o,
  };
}

function batch(
  entries: Array<[string, AgentStandingCounters]>,
  degraded = false,
): AgentStandingBatch {
  return { degraded, standings: new Map(entries) };
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.TRIAL_MAX_SETTLED_TASKS;
  delete process.env.TRIAL_MAX_MIN_REPUTATION;
  delete process.env.TRIAL_MAX_AGENTS_PER_PUBLISHER;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetTiebreakRandomSource();
});

/** Fuente de sorteo determinista: entrega los valores en orden y después `1`. */
function seq(values: number[]): () => number {
  let i = 0;
  return () => values[i++] ?? 1;
}

// ── T-22 (DT-8): N, T y M son CONFIGURACIÓN, y el default es el conservador ──
describe('T-22 (DT-8) · N/T/M salen de env con default CONSERVADOR', () => {
  it('ausentes → los defaults propuestos (3 / 10 / 2), PROVISORIOS', () => {
    expect(resolveTrialMaxSettledTasks()).toBe(3);
    expect(resolveTrialMaxMinReputation()).toBe(10);
    expect(resolveTrialMaxAgentsPerPublisher()).toBe(2);
  });

  it('un valor válido se respeta (ratificar los números es config, no código)', () => {
    process.env.TRIAL_MAX_SETTLED_TASKS = '5';
    process.env.TRIAL_MAX_MIN_REPUTATION = '25';
    process.env.TRIAL_MAX_AGENTS_PER_PUBLISHER = '1';

    expect(resolveTrialMaxSettledTasks()).toBe(5);
    expect(resolveTrialMaxMinReputation()).toBe(25);
    expect(resolveTrialMaxAgentsPerPublisher()).toBe(1);
  });

  it.each([
    '',
    'abc',
    '0',
    '-1',
    'Infinity',
    '  ',
  ])('env basura (%j) → el DEFAULT: una env que falta NO apaga el control', (raw) => {
    process.env.TRIAL_MAX_SETTLED_TASKS = raw;
    process.env.TRIAL_MAX_MIN_REPUTATION = raw;
    process.env.TRIAL_MAX_AGENTS_PER_PUBLISHER = raw;

    // Lo que se está candando es la DIRECCIÓN del fallback. Un `T` que cayera a
    // Infinity o un `M` que cayera a 0 desactivarían el control en silencio.
    expect(resolveTrialMaxSettledTasks()).toBe(3);
    expect(resolveTrialMaxMinReputation()).toBe(10);
    expect(resolveTrialMaxAgentsPerPublisher()).toBe(2);
  });
});

// ── classifyStanding ────────────────────────────────────────────────────
describe('classifyStanding · los tres estados derivados', () => {
  it('0 liquidadas y 0 fallos → newcomer (elegible)', () => {
    expect(classifyStanding(counters())).toBe('newcomer');
  });

  it('T-04 (AC-4) FRONTERA de N: N-1 sigue en el carril, N ya es `scored`', () => {
    const n = resolveTrialMaxSettledTasks(); // 3
    expect(classifyStanding(counters({ tasksSettled: n - 1 }))).toBe(
      'newcomer',
    );
    expect(classifyStanding(counters({ tasksSettled: n }))).toBe('scored');
    expect(classifyStanding(counters({ tasksSettled: n + 1 }))).toBe('scored');
  });

  it('T-05 (AC-5/CD-14): el PRIMER fallo ANULA el carril — no lo decrementa', () => {
    // Con 0 liquidadas.
    expect(classifyStanding(counters({ failedCount: 1 }))).toBe('penalized');
    // Y con 2 liquidadas dentro del carril TAMPOCO le "quedan N-1".
    expect(
      classifyStanding(counters({ tasksSettled: 2, failedCount: 1 })),
    ).toBe('penalized');
    // Anulación, no decremento: 5 fallos no es "peor" que 1, es el mismo estado.
    expect(
      classifyStanding(counters({ tasksSettled: 2, failedCount: 5 })),
    ).toBe('penalized');
  });

  it('el que YA salió del carril se juzga por su score real, no vuelve a entrar', () => {
    const n = resolveTrialMaxSettledTasks();
    expect(
      classifyStanding(counters({ tasksSettled: n, failedCount: 3 })),
    ).toBe('scored');
  });

  it('N se toma de la env (`classifyStanding` no hardcodea 3)', () => {
    process.env.TRIAL_MAX_SETTLED_TASKS = '1';
    expect(classifyStanding(counters({ tasksSettled: 1 }))).toBe('scored');
    expect(classifyStanding(counters({ tasksSettled: 0 }))).toBe('newcomer');
  });
});

// ── isTrialEligible: EL ÚNICO predicado (CD-8) ──────────────────────────
describe('isTrialEligible · el único predicado de admisión (CD-8)', () => {
  it('newcomer + piso bajo el techo → elegible', () => {
    expect(isTrialEligible(counters(), 2)).toBe(true);
  });

  it('T-12 (AC-10) FRONTERA del techo T: `min = T` admite, `min = T+1` NO', () => {
    const t = resolveTrialMaxMinReputation(); // 10
    expect(isTrialEligible(counters(), t)).toBe(true);
    expect(isTrialEligible(counters(), t + 1)).toBe(false);
  });

  it('T-12 bis: el techo sale de la env (nada de 10 hardcodeado)', () => {
    process.env.TRIAL_MAX_MIN_REPUTATION = '4';
    expect(isTrialEligible(counters(), 4)).toBe(true);
    expect(isTrialEligible(counters(), 5)).toBe(false);
  });

  it('T-05: `penalized` NO es elegible ni con el piso más bajo posible', () => {
    expect(isTrialEligible(counters({ failedCount: 1 }), 1)).toBe(false);
  });

  it('T-04: el que ya salió del carril por éxito NO es elegible', () => {
    const n = resolveTrialMaxSettledTasks();
    expect(isTrialEligible(counters({ tasksSettled: n }), 2)).toBe(false);
    expect(isTrialEligible(counters({ tasksSettled: n - 1 }), 2)).toBe(true);
  });

  it('T-10/T-18 (CD-7): `unknown` NUNCA es elegible — fail-closed', () => {
    // El caso más importante del set: si esto devolviera `true`, "no pude
    // preguntar por el historial" admitiría a cualquiera bajo el piso.
    expect(isTrialEligible('unknown', 1)).toBe(false);
    expect(isTrialEligible('unknown', 0)).toBe(false);
  });
});

// ── standingFor: ausencia ≠ degradado (T-18 / CD-7) ─────────────────────
describe('T-18 (CD-7) · standingFor distingue AUSENCIA de DEGRADACIÓN', () => {
  it('`degraded: false` + slug ausente → contadores en CERO (newcomer legítimo)', () => {
    const st = standingFor('nadie', batch([]));

    expect(st).toEqual({
      tasksSettled: 0,
      successCount: 0,
      failedCount: 0,
      reputation: null,
    });
    expect(st !== 'unknown' && classifyStanding(st)).toBe('newcomer');
  });

  it('`degraded: true` → `unknown`, incluso para un slug que SÍ está en el Map', () => {
    // Con `degraded: true` el Map no autoriza NADA: ni por ausencia ni por
    // presencia. Un `standings.get(slug)` crudo perdería exactamente esto.
    const b = batch([['tiene-datos', counters({ tasksSettled: 1 })]], true);

    expect(standingFor('tiene-datos', b)).toBe('unknown');
    expect(standingFor('no-esta', b)).toBe('unknown');
  });

  it('`degraded: false` + slug presente → sus contadores reales', () => {
    const c = counters({ tasksSettled: 2, successCount: 2, failedCount: 1 });

    expect(standingFor('x', batch([['x', c]]))).toEqual(c);
  });
});

// ── T-19 (CD-15): el cupo M es DETERMINISTA ─────────────────────────────
describe('T-19 (CD-15) · cupo M por publicador, determinista', () => {
  function cand(
    slug: string,
    anchor: string,
    createdAt?: string,
  ): TrialCandidate {
    return createdAt === undefined
      ? { slug, anchor }
      : { slug, anchor, createdAt };
  }

  it('T-11 (AC-10): 5 candidatos del mismo ancla y M=2 → los 2 más ANTIGUOS', () => {
    // El arreglo va en orden DISTINTO al de `created_at`, para que el orden del
    // arreglo no sea por casualidad la respuesta correcta.
    const cands = [
      cand('e', 'owner-1', '2026-05-05T00:00:00Z'),
      cand('c', 'owner-1', '2026-03-03T00:00:00Z'),
      cand('a', 'owner-1', '2026-01-01T00:00:00Z'),
      cand('d', 'owner-1', '2026-04-04T00:00:00Z'),
      cand('b', 'owner-1', '2026-02-02T00:00:00Z'),
    ];

    expect([...selectTrialAdmitted(cands, 2)].sort()).toEqual(['a', 'b']);
  });

  it('el cupo es POR ANCLA: dos publicadores tienen M cada uno', () => {
    const cands = [
      cand('o1-a', 'owner-1', '2026-01-01T00:00:00Z'),
      cand('o1-b', 'owner-1', '2026-02-02T00:00:00Z'),
      cand('o1-c', 'owner-1', '2026-03-03T00:00:00Z'),
      cand('o2-a', 'owner-2', '2026-01-01T00:00:00Z'),
      cand('o2-b', 'owner-2', '2026-02-02T00:00:00Z'),
    ];

    expect([...selectTrialAdmitted(cands, 1)].sort()).toEqual(['o1-a', 'o2-a']);
  });

  it('T-19: con `created_at` EMPATADO el orden del ARREGLO no decide (CD-15)', () => {
    // Lo que CD-15 prohíbe es que decida cómo se concatenaron las fuentes en
    // discovery. Con la fuente del sorteo FIJADA por slug, el resultado tiene que
    // ser el mismo en 50 permutaciones del mismo conjunto.
    const same = '2026-06-06T00:00:00Z';
    const base = [
      cand('zeta', 'owner-1', same),
      cand('alfa', 'owner-1', same),
      cand('mika', 'owner-1', same),
    ];
    // Sorteo fijado: `mika` saca el número más bajo. Se elige a propósito el que NO
    // es ni el primero del arreglo ni el `slug` menor — si ganara `alfa`, estaría
    // decidiendo el nombre; si ganara `zeta`, el arreglo.
    const draw = new Map([
      ['zeta', 0.9],
      ['alfa', 0.5],
      ['mika', 0.1],
    ]);

    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const permuted = [...base];
      // Rotación + swap determinista: recorre varias permutaciones sin RNG.
      permuted.push(...permuted.splice(0, i % permuted.length));
      if (i % 2 === 0) permuted.reverse();

      // La fuente se consume EN EL ORDEN del arreglo permutado, así que el valor se
      // ata al slug (y no a la posición) para que el escenario mida el desempate.
      let seq = 0;
      _setTiebreakRandomSource(
        () => draw.get(permuted[seq++]?.slug ?? '') ?? 1,
      );

      const admitted = selectTrialAdmitted(permuted, 1);
      expect(admitted.size).toBe(1);
      seen.add([...admitted][0] as string);
    }

    expect([...seen]).toEqual(['mika']);
  });

  it('AR BLQ-MED-3: sin `createdAt` (federados) el cupo se SORTEA — el nombre no es prioridad permanente', () => {
    // El hallazgo: todo federado entra sin `created_at`, así que el desempate caía
    // siempre en `slug` ascendente y los 2 cupos del registry se los quedaban, de
    // forma PERMANENTE, los dos slugs lexicográficamente menores. Bastaba llamarse
    // `aaa-...`. Acá se canda lo contrario: con el sorteo, el `slug` menor PIERDE.
    const cands = [
      cand('aaa-agent', 'registry:reg-1'),
      cand('m-agent', 'registry:reg-1'),
      cand('z-agent', 'registry:reg-1'),
    ];
    _setTiebreakRandomSource(seq([0.9, 0.4, 0.2]));

    expect([...selectTrialAdmitted(cands, 1)]).toEqual(['z-agent']);
  });

  it('AR BLQ-MED-3: a lo largo de varias corridas, CADA elegible del ancla puede entrar', () => {
    // La propiedad que compra el sorteo no es "gana otro", es que NINGUNO queda
    // excluido para siempre. Con un desempate fijo (slug, o el hash del slug) los
    // dos de abajo no entrarían jamás, por muchas requests que pasen.
    const cands = [
      cand('aaa-agent', 'registry:reg-1'),
      cand('m-agent', 'registry:reg-1'),
      cand('z-agent', 'registry:reg-1'),
    ];
    const winners = new Set<string>();
    for (const draw of [
      [0.1, 0.5, 0.9],
      [0.9, 0.1, 0.5],
      [0.5, 0.9, 0.1],
    ]) {
      _setTiebreakRandomSource(seq(draw));
      winners.add([...selectTrialAdmitted(cands, 1)][0] as string);
    }

    expect([...winners].sort()).toEqual(['aaa-agent', 'm-agent', 'z-agent']);
  });

  it('el que TIENE `created_at` va antes que el que no lo tiene (no se mezclan criterios)', () => {
    // Escenario defensivo: hoy un ancla es homogénea (o toda self-published, o toda
    // federada). Si algún día se mezclaran, el dato REAL de antigüedad manda sobre
    // el sorteo, y el sorteo no puede desplazar a quien tiene fecha.
    const cands = [
      cand('sorteado', 'owner-1'),
      cand('con-fecha', 'owner-1', '2026-09-09T00:00:00Z'),
    ];
    _setTiebreakRandomSource(seq([0.01, 0.99]));

    expect([...selectTrialAdmitted(cands, 1)]).toEqual(['con-fecha']);
  });

  it('sorteo EMPATADO (fuente constante) → sigue habiendo orden total, y lo cierra el `slug`', () => {
    // Rama inalcanzable con `Math.random`, pero un comparador que devolviera 0 le
    // devolvería la decisión al orden del arreglo — que es lo que CD-15 prohíbe.
    const cands = [
      cand('zzz', 'registry:reg-1'),
      cand('aaa', 'registry:reg-1'),
    ];
    _setTiebreakRandomSource(() => 0.5);

    expect([...selectTrialAdmitted(cands, 1)]).toEqual(['aaa']);
    expect([...selectTrialAdmitted([...cands].reverse(), 1)]).toEqual(['aaa']);
  });

  it('M sale de la env; con menos candidatos que M entran todos', () => {
    process.env.TRIAL_MAX_AGENTS_PER_PUBLISHER = '1';
    const cands = [
      cand('a', 'owner-1', '2026-01-01T00:00:00Z'),
      cand('b', 'owner-1', '2026-02-02T00:00:00Z'),
    ];

    expect([...selectTrialAdmitted(cands)]).toEqual(['a']);
    expect([...selectTrialAdmitted([cands[0] as TrialCandidate], 2)]).toEqual([
      'a',
    ]);
  });

  it('sin candidatos → Set vacío (nadie entra por defecto)', () => {
    expect(selectTrialAdmitted([]).size).toBe(0);
  });
});
