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
