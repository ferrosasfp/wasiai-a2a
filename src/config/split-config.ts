/**
 * Split Config — WKH-136 · Fee splits en basis points (plataforma/creador/referral)
 *
 * Lee la config GLOBAL server-side de bps desde `process.env`
 * (`SPLIT_BPS_PLATFORM` / `SPLIT_BPS_CREATOR` / `SPLIT_BPS_REFERRAL`) por request,
 * SIN cache — un restart aplica el cambio (patrón `getProtocolFeeRate`,
 * `fee-charge.ts:100-121`, y `getPyusdUsdRate`, `price.ts:59-79`).
 *
 * Reglas críticas (SDD §5):
 *   - SG-1: config global env server-side. NUNCA per-request (CD-6: un split
 *     libre en el body = robo del cut de plataforma).
 *   - CD-1/CD-7 (AC-2): fail-CLOSED. Cada valor DEBE ser un entero finito en
 *     `[0, 10000]` y la suma DEBE ser exactamente 10000. Una config corrupta
 *     RECHAZA el cobro (`SplitConfigError`, HTTP 400) — a diferencia del rate,
 *     que hace fallback silencioso, acá el fee NO se cobra parcial.
 *   - Defaults: PLATFORM=10000, CREATOR=0, REFERRAL=0 ⇒ Σ=10000 ⇒ 100%
 *     plataforma ⇒ 1 leg ⇒ byte-idéntico a hoy (WKH-44/132).
 */

/**
 * Config de splits ya validada (Σ == 10000, cada bps entero en [0, 10000]).
 */
export interface SplitConfig {
  platformBps: number;
  creatorBps: number;
  referralBps: number;
}

/**
 * Error de validación de la config de splits (fail-CLOSED, AC-2). Fastify usa
 * `statusCode` en la serialización → HTTP 400. Espejo exacto de
 * `ProtocolFeeError` (`fee-charge.ts:63-69`).
 */
export class SplitConfigError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'SplitConfigError';
  }
}

const TOTAL_BPS = 10000;
const MIN_BPS = 0;

const DEFAULT_PLATFORM_BPS = 10000;
const DEFAULT_CREATOR_BPS = 0;
const DEFAULT_REFERRAL_BPS = 0;

/**
 * Parsea un valor crudo de bps: `undefined`/`''` → default; caso contrario
 * DEBE ser un entero finito en `[0, 10000]` (CD-7). Cualquier otro caso
 * (NaN, no-entero, negativo, > 10000, no parseable) → `SplitConfigError`
 * (fail-CLOSED — NO fallback silencioso).
 */
function parseBps(
  raw: string | undefined,
  name: string,
  fallback: number,
): number {
  if (raw === undefined || raw === '') return fallback;

  const parsed = Number.parseInt(raw, 10);

  // CD-7: entero finito en rango. `Number.parseInt('12.5')` → 12 (trunca), por
  // eso comparamos contra el string original para rechazar no-enteros/basura.
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_BPS ||
    parsed > TOTAL_BPS ||
    String(parsed) !== raw.trim()
  ) {
    throw new SplitConfigError(
      `Invalid ${name} (${raw}): must be an integer in [${MIN_BPS}, ${TOTAL_BPS}].`,
    );
  }

  return parsed;
}

/**
 * Lee la config de bps de `process.env` (sin cache) y la valida fail-CLOSED.
 *
 * @throws {SplitConfigError} si algún bps es inválido o la suma ≠ 10000.
 * @returns la config validada (default `10000/0/0` si el env está sin setear).
 */
export function getSplitConfig(): SplitConfig {
  const platformBps = parseBps(
    process.env.SPLIT_BPS_PLATFORM,
    'SPLIT_BPS_PLATFORM',
    DEFAULT_PLATFORM_BPS,
  );
  const creatorBps = parseBps(
    process.env.SPLIT_BPS_CREATOR,
    'SPLIT_BPS_CREATOR',
    DEFAULT_CREATOR_BPS,
  );
  const referralBps = parseBps(
    process.env.SPLIT_BPS_REFERRAL,
    'SPLIT_BPS_REFERRAL',
    DEFAULT_REFERRAL_BPS,
  );

  if (platformBps + creatorBps + referralBps !== TOTAL_BPS) {
    throw new SplitConfigError(
      `Split bps must sum to exactly ${TOTAL_BPS} (got platform=${platformBps} + creator=${creatorBps} + referral=${referralBps} = ${platformBps + creatorBps + referralBps}).`,
    );
  }

  return { platformBps, creatorBps, referralBps };
}
