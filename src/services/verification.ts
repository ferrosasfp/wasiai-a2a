/**
 * Step verification engine — WKH-114 v1 (W0.2)
 *
 * Motor **puro** rules-first (sin I/O, sin billing, sin Anthropic): dado el
 * output de un step (2xx) y sus acceptance criteria, produce un veredicto
 * `pass`/`fail`/`unverified`. Nunca throwea (CD-8): cualquier error interno
 * inesperado (p.ej. `JSON.stringify` de un output circular/BigInt, CD-6) cae a
 * `{ verdict:'unverified', method:'none' }`.
 *
 * NO importa `budgetService` (CD-1): el veredicto es SEÑAL, jamás gatea
 * débito/refund/fee. Exemplar de estilo: `src/services/arbiter/rules.ts`.
 *
 * La rama LLM-judge (`method:'llm'`) está DIFERIDA a v2 (WKH-114b) — acá el
 * seam existe en el tipo `VerificationMethod` pero NO se construye.
 */

import type {
  PipelineVerificationStatus,
  StepAcceptance,
  StepResult,
  StepVerdict,
} from '../types/index.js';

const AC_PRESENCE = 'output is present and non-empty';
const AC_NO_ERROR = 'output has no error field';

/** Baseline determinístico cuando el step no trae AC propios (NC-1). */
export const DEFAULT_AC: string[] = [AC_PRESENCE, AC_NO_ERROR];

/** Palabras que NO son nombres de campo válidos en un criterio estructurable. */
const FIELD_STOPWORDS = new Set([
  'output',
  'response',
  'result',
  'data',
  'field',
  'value',
  'body',
  'a',
  'an',
  'the',
  'no',
  'is',
  'be',
  'present',
]);

/** AC genéricos (copia) para el greedy fallback / caller sin AC (AC-1). */
export function genericAcceptanceCriteria(): string[] {
  return [...DEFAULT_AC];
}

/** true si el output NO evidencia trabajo (null/undefined/''/[]/{}), CD-7. */
function isEmptyOutput(output: unknown): boolean {
  if (output === null || output === undefined) return true;
  if (typeof output === 'string') return output.trim() === '';
  if (Array.isArray(output)) return output.length === 0;
  if (typeof output === 'object') return Object.keys(output).length === 0;
  return false; // number/boolean → presente (0/false cuentan como body real)
}

/** true si el output objeto tiene señal de error determinística (CD-7). */
function hasErrorSignal(output: unknown): boolean {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    return false;
  }
  const o = output as Record<string, unknown>;
  if (o.error) return true;
  if (Array.isArray(o.errors) && o.errors.length > 0) return true;
  if (o.success === false) return true;
  if (typeof o.status === 'string') {
    const s = o.status.toLowerCase();
    if (s === 'failed' || s === 'error') return true;
  }
  return false;
}

/** Criterio de presencia representativo de la lista (subset de `criteria`). */
function presenceLabel(criteria: string[]): string {
  return (
    criteria.find((c) => /present|non-?empty|not empty/i.test(c)) ?? AC_PRESENCE
  );
}

/** Criterio de error representativo de la lista (subset de `criteria`). */
function errorLabel(criteria: string[]): string {
  return criteria.find((c) => /error/i.test(c)) ?? AC_NO_ERROR;
}

type CriterionCheck =
  | { kind: 'contains'; needle: string }
  | { kind: 'field'; field: string }
  | { kind: 'baseline' } // cubierto por las reglas globales 2/3
  | { kind: 'undecidable' };

/**
 * Clasifica un criterio en su check estructurable. El nombre de campo se
 * extrae del string ORIGINAL (preserva casing, p.ej. `confirmationId`); los
 * keywords se matchean case-insensitive.
 */
function classifyCriterion(raw: string): CriterionCheck {
  const c = raw.toLowerCase().trim();

  // Baseline (evaluado por las reglas globales non-empty / error-field):
  if (c.includes('error')) return { kind: 'baseline' };
  if (
    /^(output|response|result|the response)?\s*(is\s+)?(present|non-?empty|not empty)/.test(
      c,
    ) ||
    c.includes('present and non-empty')
  ) {
    return { kind: 'baseline' };
  }

  // Contains: cualquier token entrecomillado → el output debe contenerlo.
  // NIT-2: el match `contains` corre sobre `JSON.stringify(output)` (ver
  // verifyStepOutput paso 4), por lo que también matchea KEYS del objeto, no
  // sólo valores. Es señal-only (nunca gatea billing, CD-1) → aceptable. Sólo
  // se dispara con literal ENTRE COMILLAS: `contains xyz` sin comillas es
  // undecidable (el prompt del planner instruye a emitir el literal citado).
  const quoted = raw.match(/["'`]([^"'`]+)["'`]/);
  if (quoted?.[1]) return { kind: 'contains', needle: quoted[1] };

  // Field: has <field> / non-empty <field> / field <field> / <field> present.
  const fieldMatch =
    raw.match(/non-?empty\s+([A-Za-z_][A-Za-z0-9_]*)/i) ??
    raw.match(/\bhas\s+(?:a\s+|an\s+)?([A-Za-z_][A-Za-z0-9_]*)/i) ??
    raw.match(/\bfield\s+([A-Za-z_][A-Za-z0-9_]*)/i) ??
    raw.match(/([A-Za-z_][A-Za-z0-9_]*)\s+(?:is\s+)?present/i);
  if (fieldMatch?.[1] && !FIELD_STOPWORDS.has(fieldMatch[1].toLowerCase())) {
    return { kind: 'field', field: fieldMatch[1] };
  }

  return { kind: 'undecidable' };
}

/** true si `field` existe en el output objeto y su valor es no-vacío. */
function fieldNonEmpty(output: unknown, field: string): boolean {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    return false;
  }
  const val = (output as Record<string, unknown>)[field];
  return !isEmptyOutput(val);
}

/**
 * Evalúa el output de un step contra sus AC. Orden EXACTO (el primero que
 * matchea gana):
 *   1. NC-1 sustitución de default — sin criteria → DEFAULT_AC (method rules).
 *   2. Global non-empty (CD-7) — output vacío → fail (criterio de presencia).
 *   3. Global error-field (CD-7) — señal de error → fail (criterio de error).
 *   4. Por-criterio estructurable (contains/field) best-effort; los no
 *      estructurables (semánticos) quedan UNDECIDABLE.
 *   5. Resolución: algún fail → fail; ≥1 undecidable sin fails → unverified;
 *      todos evaluables pasan → pass.
 * Todo bajo guard try/catch (CD-6/CD-8): cualquier throw → unverified/none.
 */
export function verifyStepOutput(
  output: unknown,
  criteria: string[] | undefined,
): StepAcceptance {
  // 1. NC-1: sustitución de default (copia defensiva). BLQ-ALTO-1: la
  // normalización DEBE ser never-throw y type-safe (CD-6 "validate ≠ parse").
  // `criteria` viene del caller SIN validar (compose.ts / orchestrate/execute
  // no lo tipan a runtime), así que un objeto truthy no-iterable como
  // `{length:1}` haría `[...criteria]` lanzar `TypeError: not iterable` FUERA
  // del try → propaga a finishSuccessfulStep → catch del money-path →
  // refundStepDebit() reembolsa un step ya settleado (drain del gateway).
  // `Array.isArray` garantiza que el spread SOLO corre sobre un array real;
  // cualquier `criteria` no-array/malformado cae a DEFAULT_AC sin spreadear
  // algo no-iterable.
  const effective =
    Array.isArray(criteria) && criteria.length > 0
      ? [...criteria]
      : [...DEFAULT_AC];

  try {
    // 2. Global — non-empty output (CD-7).
    if (isEmptyOutput(output)) {
      const label = presenceLabel(effective);
      // NIT-1: mantener el invariante `failedCriteria ⊆ criteria`
      // (types/index.ts StepAcceptance.failedCriteria). Si la regla global
      // dispara con AC custom sin wording de presencia, `label` es el baseline
      // sintético (AC_PRESENCE) ausente de `effective`; se agrega a la lista
      // retornada para que el subconjunto se cumpla de verdad.
      return {
        criteria: effective.includes(label) ? effective : [...effective, label],
        verdict: 'fail',
        method: 'rules',
        failedCriteria: [label],
      };
    }

    // 3. Global — error field (CD-7).
    if (hasErrorSignal(output)) {
      const label = errorLabel(effective);
      // NIT-1: idem — asegura `failedCriteria ⊆ criteria` cuando la regla de
      // error global dispara con AC custom sin wording de error.
      return {
        criteria: effective.includes(label) ? effective : [...effective, label],
        verdict: 'fail',
        method: 'rules',
        failedCriteria: [label],
      };
    }

    // 4. Por-criterio estructurable.
    const checks = effective.map((raw) => ({
      raw,
      check: classifyCriterion(raw),
    }));
    // JSON.stringify sólo cuando hace falta (contains) → guard CD-6 vía catch.
    const serialized = checks.some((x) => x.check.kind === 'contains')
      ? JSON.stringify(output)
      : null;

    const failed: string[] = [];
    let anyUndecidable = false;
    for (const { raw, check } of checks) {
      if (check.kind === 'baseline') continue; // cubierto por reglas 2/3
      if (check.kind === 'undecidable') {
        anyUndecidable = true;
        continue;
      }
      if (check.kind === 'contains') {
        const ok = Boolean(
          serialized?.toLowerCase().includes(check.needle.toLowerCase()),
        );
        if (!ok) failed.push(raw);
        continue;
      }
      // check.kind === 'field'
      if (!fieldNonEmpty(output, check.field)) failed.push(raw);
    }

    // 5. Resolución del veredicto.
    if (failed.length > 0) {
      return {
        criteria: effective,
        verdict: 'fail',
        method: 'rules',
        failedCriteria: failed,
      };
    }
    if (anyUndecidable) {
      return { criteria: effective, verdict: 'unverified', method: 'rules' };
    }
    return { criteria: effective, verdict: 'pass', method: 'rules' };
  } catch {
    // CD-6/CD-8: never-throw. Cualquier error interno → unverified/none.
    return { criteria: effective, verdict: 'unverified', method: 'none' };
  }
}

/**
 * Resume el veredicto por-step a nivel pipeline (AC-5). Precedencia:
 *   - algún `fail` → 'incomplete'.
 *   - todos los steps con acceptance son `pass` → 'verified'.
 *   - en otro caso (≥1 `unverified`, sin fails) → 'unverified'.
 */
export function summarizePipelineVerification(
  results: StepResult[],
): PipelineVerificationStatus {
  const verdicts = results
    .map((r) => r.acceptance?.verdict)
    .filter((v): v is StepVerdict => v !== undefined);
  if (verdicts.some((v) => v === 'fail')) return 'incomplete';
  if (verdicts.length > 0 && verdicts.every((v) => v === 'pass')) {
    return 'verified';
  }
  return 'unverified';
}
