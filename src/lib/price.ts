/**
 * Price helpers for gasless transfers (WKH-59 / SEC-DRAIN-1).
 *
 * Helper PURO de pricing — sin Fastify, sin Supabase, sin adapters.
 * Solo usa `process.env`. CD-15 del SDD.
 *
 * Patrón env-backed con guard/fallback equivalente a `getProtocolFeeRate`
 * (`src/services/fee-charge.ts:90-110`): se lee por request, sin cache;
 * un restart basta para aplicar un nuevo valor.
 */

import { getLogger } from './logger.js';

const log = getLogger('price');

// ── Constants ──────────────────────────────────────────────

/**
 * Decimales del token PYUSD (canonical Kite testnet, chain 2368).
 * 1 PYUSD = 10^6 wei.
 */
const PYUSD_DECIMALS = 6;

/** Default rate PYUSD → USD (1:1 por diseño del stablecoin). */
const DEFAULT_PYUSD_RATE = 1.0;

/**
 * Rango válido del rate `[MIN_PYUSD_RATE, MAX_PYUSD_RATE]`. El upper bound
 * existe para detectar configs absurdas (un rate > 100 sería un error de
 * dígitos casi seguro y haría que el cap default cierre todos los transfers).
 */
const MIN_PYUSD_RATE = 0;
const MAX_PYUSD_RATE = 100;

/** Default cap global por request (USD) para POST /gasless/transfer. */
const DEFAULT_GASLESS_CAP_USD = 10;

/**
 * Rango válido del cap `(MIN_GASLESS_CAP_USD, MAX_GASLESS_CAP_USD]`. El lower
 * bound es exclusivo: un cap de 0 cerraría TODOS los transfers (dead-letter).
 */
const MIN_GASLESS_CAP_USD = 0; // exclusive — cap > 0 obligatorio
const MAX_GASLESS_CAP_USD = 10000;

// ── Public API ─────────────────────────────────────────────

/**
 * Lee `PYUSD_USD_RATE` del env y retorna el rate aplicable. Sin cache —
 * cada llamada re-lee `process.env`, alineado con `getProtocolFeeRate`.
 *
 * Reglas:
 * - `undefined` o `''` → silent fallback `1.0`
 * - parseable y dentro de `[0, 100]` → usa el valor
 * - cualquier otro caso (NaN, Infinity, fuera de rango) → fallback `1.0`
 *   con `console.warn`
 *
 * @returns rate aplicable (1.0 por default)
 */
export function getPyusdUsdRate(): number {
  const raw = process.env.PYUSD_USD_RATE;
  if (raw === undefined || raw === '') return DEFAULT_PYUSD_RATE;

  const parsed = Number.parseFloat(raw);

  // CD-E: Number.isFinite rechaza NaN e Infinity en una sola llamada.
  if (
    !Number.isFinite(parsed) ||
    parsed < MIN_PYUSD_RATE ||
    parsed > MAX_PYUSD_RATE
  ) {
    log.warn(
      { raw, min: MIN_PYUSD_RATE, max: MAX_PYUSD_RATE },
      `Invalid PYUSD_USD_RATE (must be finite number in [${MIN_PYUSD_RATE}, ${MAX_PYUSD_RATE}]); falling back to ${DEFAULT_PYUSD_RATE}`,
    );
    return DEFAULT_PYUSD_RATE;
  }

  return parsed;
}

/**
 * Convierte una cantidad en wei (PYUSD = 6 decimals) a USD aplicando el
 * rate actual.
 *
 * Reglas (CD-10 — overflow seguro):
 * - `valueWei < 0n` → retorna `0` (defensa: bigint negativo no tiene sentido)
 * - `valueWei > Number.MAX_SAFE_INTEGER` → retorna `Number.POSITIVE_INFINITY`
 *   (NO throws; el caller decide cómo manejar overflow vía `isFinite`)
 * - caso normal → `(Number(valueWei) / 10**6) * rate`
 *
 * @param valueWei cantidad en wei (PYUSD)
 * @returns valor en USD, o `Infinity` si el bigint excede safe integer
 */
export function pyusdWeiToUsd(valueWei: bigint): number {
  if (valueWei < 0n) return 0;

  const safeMax = BigInt(Number.MAX_SAFE_INTEGER);
  if (valueWei > safeMax) return Number.POSITIVE_INFINITY;

  const valueNum = Number(valueWei);
  return (valueNum / 10 ** PYUSD_DECIMALS) * getPyusdUsdRate();
}

/**
 * Parsea un valor crudo (number | string | null | undefined) a un número
 * finito y no-negativo. Retorna 0 para cualquiera de: null, undefined, NaN,
 * Infinity, número negativo, string no parseable, string vacío.
 *
 * Safe floor de precios (WKH-57): NUNCA infla vía fallback. Es el único
 * safeguard de clamp de precios; lo reusan `discovery.ts` (registries) y
 * `services/agent.ts` (self-published, WKH-134) para blindar el read-boundary
 * contra valores negativos/no-finitos ya persistidos en DB.
 */
export function parsePriceSafe(raw: unknown): number {
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 0 ? raw : 0;
  }
  if (typeof raw === 'string') {
    if (raw === '') return 0;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }
  return 0;
}

/**
 * Lee `GASLESS_DEFAULT_CAP_USD` del env y retorna el cap global aplicable
 * a POST /gasless/transfer. Sin cache, igual que `getPyusdUsdRate`.
 *
 * Reglas:
 * - `undefined` o `''` → silent fallback `10`
 * - parseable y dentro de `(0, 10000]` → usa el valor
 * - cualquier otro caso (NaN, Infinity, ≤0, >10000) → fallback `10`
 *   con `console.warn`
 *
 * @returns cap aplicable en USD (10 por default)
 */
export function getGaslessDefaultCapUsd(): number {
  const raw = process.env.GASLESS_DEFAULT_CAP_USD;
  if (raw === undefined || raw === '') return DEFAULT_GASLESS_CAP_USD;

  const parsed = Number.parseFloat(raw);

  // Range (0, 10000] — exclusive lower bound; cap > 0 obligatorio.
  if (
    !Number.isFinite(parsed) ||
    parsed <= MIN_GASLESS_CAP_USD ||
    parsed > MAX_GASLESS_CAP_USD
  ) {
    log.warn(
      { raw, min: MIN_GASLESS_CAP_USD, max: MAX_GASLESS_CAP_USD },
      `Invalid GASLESS_DEFAULT_CAP_USD (must be finite number in (${MIN_GASLESS_CAP_USD}, ${MAX_GASLESS_CAP_USD}]); falling back to ${DEFAULT_GASLESS_CAP_USD}`,
    );
    return DEFAULT_GASLESS_CAP_USD;
  }

  return parsed;
}
