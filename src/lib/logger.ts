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
