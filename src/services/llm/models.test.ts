/**
 * Tests for LLM model/config knobs — WKH-135.
 *
 * Cubre AC-1 (single source: 8 getters), AC-3 (defaults byte-idénticos con
 * env unset), AC-4 (override efectivo + env inválido → fallback + log.warn),
 * AC-5 (presencia de las 8 vars en .env.example).
 *
 * CD-9 (test hygiene): todo test que setea `LLM_*` lo limpia en afterEach.
 * Los tests de defaults corren con `LLM_*` unset.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ─── Structured logger mock ─────────────────────────────────
// models.ts logs server-side via getLogger('llm-models'). Mock it so tests
// assert log.warn emission (object-first / message-second) on the invalid-env
// branch instead of spying on the (silent-in-test) real logger.
const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../../lib/logger.js', () => ({
  getLogger: () => logSpy,
}));

import {
  getComplexModel,
  getInputRetryMaxTokens,
  getInputRetryModel,
  getLlmTimeoutMs,
  getPlannerMaxTokens,
  getPlannerModel,
  getTransformMaxTokens,
  getTrivialModel,
} from './models.js';

const LLM_ENV_VARS = [
  'LLM_PLANNER_MODEL',
  'LLM_COMPLEX_MODEL',
  'LLM_TRIVIAL_MODEL',
  'LLM_INPUT_RETRY_MODEL',
  'LLM_TIMEOUT_MS',
  'LLM_PLANNER_MAX_TOKENS',
  'LLM_TRANSFORM_MAX_TOKENS',
  'LLM_INPUT_RETRY_MAX_TOKENS',
] as const;

afterEach(() => {
  // CD-9: limpiar todo LLM_* seteado por un test para no contaminar hermanos.
  for (const name of LLM_ENV_VARS) delete process.env[name];
  logSpy.warn.mockClear();
  logSpy.error.mockClear();
  logSpy.info.mockClear();
});

// ─── T-AC1: single source — el módulo exporta los 8 getters ──
describe('models — exports (AC-1)', () => {
  it('exposes the 8 env-driven getters', () => {
    for (const g of [
      getPlannerModel,
      getComplexModel,
      getTrivialModel,
      getInputRetryModel,
      getLlmTimeoutMs,
      getPlannerMaxTokens,
      getTransformMaxTokens,
      getInputRetryMaxTokens,
    ]) {
      expect(typeof g).toBe('function');
    }
  });

  it('a knob lives in a single place: set env → the getter reflects it', () => {
    process.env.LLM_PLANNER_MODEL = 'single-source-model';
    expect(getPlannerModel()).toBe('single-source-model');
  });
});

// ─── T-AC3a: defaults byte-idénticos con env unset (CD-5) ────
describe('models — defaults with LLM_* unset (AC-3/CD-5)', () => {
  it('returns the exact current hardcoded values', () => {
    expect(getPlannerModel()).toBe('claude-sonnet-5');
    expect(getComplexModel()).toBe('claude-sonnet-5');
    expect(getTrivialModel()).toBe('claude-haiku-4-5-20251001');
    expect(getInputRetryModel()).toBe('claude-haiku-4-5-20251001');
    expect(getLlmTimeoutMs()).toBe(30_000);
    expect(getPlannerMaxTokens()).toBe(1024);
    expect(getTransformMaxTokens()).toBe(512);
    expect(getInputRetryMaxTokens()).toBe(1024);
  });

  it('does not warn on the default path (env unset)', () => {
    getLlmTimeoutMs();
    getPlannerMaxTokens();
    getTransformMaxTokens();
    getInputRetryMaxTokens();
    expect(logSpy.warn).not.toHaveBeenCalled();
  });
});

// ─── T-AC4a: override efectivo ───────────────────────────────
describe('models — env override (AC-4)', () => {
  it('honors a model ID override', () => {
    process.env.LLM_PLANNER_MODEL = 'x';
    expect(getPlannerModel()).toBe('x');
  });

  it('honors a numeric timeout override', () => {
    process.env.LLM_TIMEOUT_MS = '5000';
    expect(getLlmTimeoutMs()).toBe(5000);
  });

  it('honors a max_tokens override', () => {
    process.env.LLM_TRANSFORM_MAX_TOKENS = '256';
    expect(getTransformMaxTokens()).toBe(256);
  });

  it('trims surrounding whitespace on a model ID', () => {
    process.env.LLM_COMPLEX_MODEL = '  spaced-model  ';
    expect(getComplexModel()).toBe('spaced-model');
  });
});

// ─── T-AC4b: env inválido → fallback + log.warn (CD-6) ───────
describe('models — invalid env falls back + warns (AC-4/CD-6)', () => {
  it('non-numeric timeout → fallback 30000 + warn', () => {
    process.env.LLM_TIMEOUT_MS = 'abc';
    expect(getLlmTimeoutMs()).toBe(30_000);
    expect(logSpy.warn).toHaveBeenCalledTimes(1);
    expect(logSpy.warn).toHaveBeenCalledWith(
      expect.objectContaining({ env: 'LLM_TIMEOUT_MS', raw: 'abc' }),
      expect.any(String),
    );
  });

  it('negative timeout → fallback 30000 + warn', () => {
    process.env.LLM_TIMEOUT_MS = '-1';
    expect(getLlmTimeoutMs()).toBe(30_000);
    expect(logSpy.warn).toHaveBeenCalledTimes(1);
  });

  it('zero timeout (below MIN) → fallback 30000 + warn', () => {
    process.env.LLM_TIMEOUT_MS = '0';
    expect(getLlmTimeoutMs()).toBe(30_000);
    expect(logSpy.warn).toHaveBeenCalledTimes(1);
  });

  it('out-of-range max_tokens → fallback + warn', () => {
    process.env.LLM_PLANNER_MAX_TOKENS = '999999999';
    expect(getPlannerMaxTokens()).toBe(1024);
    expect(logSpy.warn).toHaveBeenCalledTimes(1);
  });

  it('fractional timeout (parseInt-lax → 1ms) → fallback 30000 + warn', () => {
    // '1.5' → parseInt daría 1 (dentro de rango) → timeout de 1ms silencioso.
    // El parse estricto (^-?\d+$) lo rechaza → fallback + warn.
    process.env.LLM_TIMEOUT_MS = '1.5';
    expect(getLlmTimeoutMs()).toBe(30_000);
    expect(logSpy.warn).toHaveBeenCalledTimes(1);
  });

  it('trailing-garbage max_tokens (10abc) → fallback + warn', () => {
    process.env.LLM_PLANNER_MAX_TOKENS = '10abc';
    expect(getPlannerMaxTokens()).toBe(1024);
    expect(logSpy.warn).toHaveBeenCalledTimes(1);
  });

  it('whitespace-only model ID → default, no warn', () => {
    process.env.LLM_PLANNER_MODEL = '   ';
    expect(getPlannerModel()).toBe('claude-sonnet-5');
    expect(logSpy.warn).not.toHaveBeenCalled();
  });
});

// ─── T-AC5: .env.example documenta las 8 vars ────────────────
describe('.env.example documents the LLM knobs (AC-5)', () => {
  it('contains all 8 LLM_* env var names', () => {
    const envExamplePath = fileURLToPath(
      new URL('../../../.env.example', import.meta.url),
    );
    const contents = readFileSync(envExamplePath, 'utf8');
    for (const name of LLM_ENV_VARS) {
      expect(contents).toContain(name);
    }
  });
});
