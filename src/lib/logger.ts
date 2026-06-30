/**
 * Structured logging (audit: console.* migration)
 *
 * A small pino-based logger so service-layer code emits structured logs with
 * consistent levels and context instead of ad-hoc `console.*`. pino is already
 * present as Fastify's logging engine (transitive dep), so this adds no new
 * runtime dependency.
 *
 * Usage:
 *   import { getLogger } from '../lib/logger.js';
 *   const log = getLogger('budget');
 *   log.error({ keyId, err }, 'master debit failed');
 *   log.warn({ orchestrationId }, 'price fallback');
 *
 * The object-first / message-second shape matches pino's API and preserves the
 * structured context that the previous `console.error('[budget] msg', { ... })`
 * calls carried (the object becomes queryable fields instead of an inlined
 * string blob).
 *
 * Level is controlled by LOG_LEVEL (default 'info'). In test (NODE_ENV=test or
 * VITEST) the logger is silent so unit tests stay quiet and deterministic —
 * this mirrors the fact that the previous console.* output was incidental, not
 * asserted by the suite.
 */

import pino, { type Logger } from 'pino';

/**
 * F-06 (audit 2026-06-29): redaction paths shared by BOTH the service-layer
 * pino logger (below) and the Fastify request logger (`src/index.ts`). Without
 * these, a logged request (`req.headers`) or any object carrying a secret field
 * would emit credentials in plaintext. Pino replaces matched paths with
 * `[Redacted]`. Exported so the Fastify logger reuses the SAME list (no drift).
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-payment"]',
  'req.headers["x-a2a-key"]',
  '*.privateKey',
  '*.serviceKey',
  '*.secret',
  '*.signature',
];

function resolveLevel(): string {
  const explicit = process.env.LOG_LEVEL?.trim();
  if (explicit) return explicit;
  const env = process.env.NODE_ENV?.trim().toLowerCase();
  if (env === 'test' || process.env.VITEST) return 'silent';
  return 'info';
}

const rootLogger: Logger = pino({
  level: resolveLevel(),
  // Keep timestamps and standard serializers; pino serializes Error objects
  // passed as `err` into `{ type, message, stack }`, preserving error context.
  base: { service: 'wasiai-a2a' },
  // F-06: redact credential-bearing fields (see REDACT_PATHS rationale).
  redact: REDACT_PATHS,
});

/**
 * Returns a named child logger. The `name` becomes a structured field so logs
 * are filterable per module (replaces the old `[budget]` / `[Compose]` string
 * prefixes).
 */
export function getLogger(name: string): Logger {
  return rootLogger.child({ module: name });
}

export { rootLogger as logger };
