/**
 * Environment helpers (WKH-AUDIT-A2A-CLEANUP)
 *
 * Centralizes the `NODE_ENV === 'production'` check that was previously
 * duplicated across src/index.ts and src/routes/dashboard.ts.
 *
 * CD-4: this is a FUNCTION (not a module constant) so the check is evaluated
 * at runtime on each call — preserving the existing security semantics
 * (dashboard fail-closed, CORS restrictive) that depend on the env value at
 * request/registration time, not at import time.
 */

import { classifyDepositMinimumEnv } from './deposit-minimum.js';

/**
 * Returns true when the process is running in production.
 *
 * Normalizes `NODE_ENV` with `.trim().toLowerCase()` so values like
 * `'Production'` or `' production '` are still recognized. Behavior-preserving
 * for the nominal `'production'` value.
 */
export function isProduction(): boolean {
  return process.env.NODE_ENV?.trim().toLowerCase() === 'production';
}

/**
 * H3 (audit 2026-07-01): parse the `TRUST_PROXY` env var into a value Fastify's
 * `trustProxy` option accepts. Mirrors the `wasiai-facilitator` fix.
 *
 * Behind Railway's edge proxy the TCP peer Fastify sees is the proxy, not the
 * real client. Without `trustProxy`, `request.ip` (the default rate-limit key)
 * collapses to a single shared bucket for ALL external callers → an
 * unauthenticated attacker can exhaust the per-IP limiters (`orchestrateRateLimit`,
 * `authSignupRateLimit`, the global limiter) and DoS `/orchestrate`, `/compose`
 * and `/auth/agent-signup` for everyone. Setting `trustProxy` makes Fastify
 * resolve `request.ip` from `X-Forwarded-For` so the limiter buckets per real
 * client IP.
 *
 * Accepted `TRUST_PROXY` values:
 *  - unset / '' → `false` (DEFAULT: unchanged behavior; opt-in per deploy).
 *  - 'true' / 'false' → boolean.
 *  - an integer (e.g. '1') → number of proxy hops to trust.
 *  - a comma-separated list (e.g. '10.0.0.0/8,127.0.0.1') → string[] of trusted
 *    IPs / subnets / the literal 'loopback'/'linklocal'/'uniquelocal'.
 *  - any other single string → passed through (single IP/subnet/keyword).
 *
 * NOTE: on Railway, `TRUST_PROXY=true` is the recommended value (single edge
 * hop, X-Forwarded-For is set by the trusted platform proxy).
 */
export function parseTrustProxy(
  raw: string | undefined,
): boolean | number | string | string[] {
  if (raw === undefined) return false;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return false;
  const lower = trimmed.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  // Integer hop count (e.g. "1", "2"). Must be the WHOLE value.
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  // Comma-separated list of IPs / subnets / keywords.
  if (trimmed.includes(',')) {
    return trimmed
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  // Single IP / subnet / keyword (e.g. 'loopback').
  return trimmed;
}

/**
 * F-08 (audit 2026-06-29): boot-time assertion that the secrets the service
 * cannot function without are present IN PRODUCTION. Without this, a missing
 * `SUPABASE_SERVICE_KEY` / operator key surfaces as a confusing runtime failure
 * deep in a request (or, worse, a silent fallback) instead of failing loudly at
 * boot. No-op outside production so local/test runs stay frictionless.
 *
 * Throws an `Error` listing ALL missing vars (not just the first) so an operator
 * fixes the env in one pass. Call ONCE at process start, before binding.
 */
/**
 * Fix-pack AR 2026-07-31: que un minimo de deposito MAL ESCRITO no apague el camino
 * de deposito en silencio.
 *
 * QUE PASABA ANTES: `A2A_DEPOSIT_MIN_USDC='1,5'` (coma), `'1 USDC'` o `'1.0000001'`
 * (sub-grilla) no matchean el patron del guard, asi que `resolveDepositMinimumMicroUsd()`
 * devuelve `null` y TODO deposito se rechaza con 503. El proceso arrancaba normal y la
 * primera noticia era el 503 del primer depositante.
 *
 * POR QUE NO ALCANZA `assertRequiredEnv()`: esa funcion solo chequea PRESENCIA. `'1,5'`
 * esta presente y no vacia, asi que agregar el nombre a esa lista NO lo atrapa. El unico
 * chequeo que sirve es EVALUAR el valor con la misma funcion que usa el guard.
 *
 * LAS DOS CAUSAS SE TRATAN DISTINTO A PROPOSITO:
 *  - MAL ESCRITA (presente pero ilegible) -> THROW, en cualquier NODE_ENV. Es el caso en
 *    el que el operador CREE tener un minimo puesto; ademas es un typo que se arregla en
 *    segundos y, al no bootear, la revision anterior sigue sirviendo.
 *  - AUSENTE -> warning ruidoso, no throw. Un deploy sin la env ya venia funcionando asi
 *    (con los depositos cerrados) y el gateway hace muchas cosas que no son depositar:
 *    voltear TODO el servicio por una env del camino de deposito seria un radio de
 *    explosion mayor que el problema. Se avisa, fuerte, y se sigue.
 *
 * Devuelve el texto del warning cuando la env esta AUSENTE (para que el llamador lo
 * loguee con el logger ya construido) y `null` cuando esta configurada.
 */
export function assertDepositMinimumEnv(): string | null {
  const status = classifyDepositMinimumEnv();
  if (status.state === 'configured') return null;
  if (status.state === 'invalid') {
    throw new Error(
      `A2A_DEPOSIT_MIN_USDC esta MAL ESCRITA (valor recibido: "${status.raw}"). ` +
        'La variable ESTA presente, asi que no es un olvido: es el valor lo que el ' +
        'gateway no puede leer, y con el ilegible NINGUN deposito acredita en NINGUNA ' +
        'cadena (503 DEPOSIT_MINIMUM_NOT_CONFIGURED). Formato aceptado: decimal plano ' +
        'positivo, hasta 6 decimales (la grilla de USDC), por ejemplo "1", "1.0" o ' +
        '"2.5". Se rechazan: coma decimal ("1,5"), unidades pegadas ("1 USDC"), ' +
        'notacion cientifica ("1e6"), negativos, y el cero (un minimo de cero es el ' +
        'guard apagado). Ver .env.example. Se rechaza el arranque para no quedar con ' +
        'los depositos cerrados y sin aviso.',
    );
  }
  return (
    'A2A_DEPOSIT_MIN_USDC NO ESTA CONFIGURADA (la variable falta o esta vacia). ' +
    'El guard de minimo es fail-closed: mientras siga asi, NINGUN deposito acredita ' +
    'en NINGUNA cadena y cada intento devuelve 503 DEPOSIT_MINIMUM_NOT_CONFIGURED. ' +
    'GET /auth/deposit-info lo publica como deposits_enabled=false para no invitar a ' +
    'mandar plata que nadie puede acreditar. Setea la variable (por ejemplo ' +
    'A2A_DEPOSIT_MIN_USDC=1) para abrir el camino de deposito. Ver .env.example.'
  );
}

export function assertRequiredEnv(): void {
  if (!isProduction()) return;
  const required = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_KEY',
    'OPERATOR_PRIVATE_KEY',
  ];
  const missing = required.filter((name) => {
    const v = process.env[name];
    return v === undefined || v.trim().length === 0;
  });
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s) in production: ${missing.join(
        ', ',
      )}`,
    );
  }
}
