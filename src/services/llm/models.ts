/**
 * LLM model/config knobs — centralized, env-driven (WKH-135).
 *
 * Single source of truth for the Claude model IDs, request timeout and
 * `max_tokens` used by the /orchestrate planner, the schema-transform bridge
 * and the input-retry helper. Previously these literals were duplicated across
 * 4 call-sites.
 *
 * Defaults are byte-identical to the previous hardcoded values: with every
 * `LLM_*` env var unset the behavior is exactly the current one.
 *
 * The getters mirror `getProtocolFeeRate()` (fee-charge.ts) and
 * `parseOverheadEnv()` (gas-overhead.ts): parse → validate range → fallback →
 * `log.warn` → NEVER throw. They read env by call (no module cache), so a
 * Railway restart applies a new value without re-import.
 */
import { getLogger } from '../../lib/logger.js';

const log = getLogger('llm-models');

// Defaults = valores hardcodeados HOY (CD-5). Fuente de verdad: el código actual.
const DEFAULT_PLANNER_MODEL = 'claude-sonnet-5';
const DEFAULT_COMPLEX_MODEL = 'claude-sonnet-5';
const DEFAULT_TRIVIAL_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_INPUT_RETRY_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_LLM_TIMEOUT_MS = 30_000;
const DEFAULT_PLANNER_MAX_TOKENS = 1024;
const DEFAULT_TRANSFORM_MAX_TOKENS = 512;
const DEFAULT_INPUT_RETRY_MAX_TOKENS = 1024;

// Rango de sanidad para los knobs numéricos (evita 0/negativo/NaN/absurdos).
const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 600_000; // 10 min
const MIN_MAX_TOKENS = 1;
const MAX_MAX_TOKENS = 200_000; // límite SDK

/** Model ID: string no-vacío. Vacío/undefined → default. Nunca throw. */
function readModelEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim();
}

/** Int positivo en [min,max]. NaN/Infinity/fuera de rango → fallback + warn. */
function readIntEnv(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const trimmed = raw.trim();
  // Parse estricto: solo enteros base-10 (rechaza '1.5', '10abc', '1e3', '0x10').
  // parseInt es laxo y aceptaría prefijos válidos → timeout/token silenciosamente
  // truncado. El rango [min,max] ya rechaza 0/negativos.
  const parsed = /^-?\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    log.warn(
      { env: name, raw, min, max, fallback },
      'Invalid LLM config env (must be integer in range); falling back to default',
    );
    return fallback;
  }
  return parsed;
}

// Model IDs (env override directo)
export function getPlannerModel(): string {
  return readModelEnv('LLM_PLANNER_MODEL', DEFAULT_PLANNER_MODEL);
}
export function getComplexModel(): string {
  return readModelEnv('LLM_COMPLEX_MODEL', DEFAULT_COMPLEX_MODEL);
}
export function getTrivialModel(): string {
  return readModelEnv('LLM_TRIVIAL_MODEL', DEFAULT_TRIVIAL_MODEL);
}
export function getInputRetryModel(): string {
  return readModelEnv('LLM_INPUT_RETRY_MODEL', DEFAULT_INPUT_RETRY_MODEL);
}

// Timeout único compartido por planner/transform/input-retry (hoy los 3 = 30_000)
export function getLlmTimeoutMs(): number {
  return readIntEnv(
    'LLM_TIMEOUT_MS',
    DEFAULT_LLM_TIMEOUT_MS,
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );
}

// max_tokens por call-site (distintos hoy: 1024 / 512 / 1024)
export function getPlannerMaxTokens(): number {
  return readIntEnv(
    'LLM_PLANNER_MAX_TOKENS',
    DEFAULT_PLANNER_MAX_TOKENS,
    MIN_MAX_TOKENS,
    MAX_MAX_TOKENS,
  );
}
export function getTransformMaxTokens(): number {
  return readIntEnv(
    'LLM_TRANSFORM_MAX_TOKENS',
    DEFAULT_TRANSFORM_MAX_TOKENS,
    MIN_MAX_TOKENS,
    MAX_MAX_TOKENS,
  );
}
export function getInputRetryMaxTokens(): number {
  return readIntEnv(
    'LLM_INPUT_RETRY_MAX_TOKENS',
    DEFAULT_INPUT_RETRY_MAX_TOKENS,
    MIN_MAX_TOKENS,
    MAX_MAX_TOKENS,
  );
}
