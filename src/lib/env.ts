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
