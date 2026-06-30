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

/**
 * OP-11 (audit 2026-06-30): pino `redact` only masks known OBJECT PATHS — it
 * cannot catch a secret that ends up INSIDE a free-form log message string
 * (e.g. `log.info('settled tx 0x<64-hex>…')` or an error message that inlined a
 * private key / signature). This regex masks any 0x-prefixed 64-hex-char run
 * (the shape of an ECDSA signature half, a private key, or a 32-byte hash/nonce)
 * appearing in a STRING argument. Tx hashes share that shape and get masked too;
 * that is acceptable — tx hashes are also carried as structured fields elsewhere
 * (e.g. `txHash`/`tx_hash`) which remain visible for debugging.
 */
const SECRET_HEX_RE = /0x[0-9a-fA-F]{64}/g;
const SECRET_MASK = '0x[REDACTED-HEX64]';

/** Masks 0x64-hex secret patterns inside a string. Non-strings pass through. */
export function scrubSecretHex<T>(value: T): T {
  if (typeof value !== 'string') return value;
  return value.replace(SECRET_HEX_RE, SECRET_MASK) as unknown as T;
}

const rootLogger: Logger = pino({
  level: resolveLevel(),
  // Keep timestamps and standard serializers; pino serializes Error objects
  // passed as `err` into `{ type, message, stack }`, preserving error context.
  base: { service: 'wasiai-a2a' },
  // F-06: redact credential-bearing fields (see REDACT_PATHS rationale).
  redact: REDACT_PATHS,
  // OP-11: scrub 0x64-hex secret patterns from free-form string args (message +
  // any string positional arg) BEFORE they are written. `redact` (above) only
  // covers known object paths; this closes the message-string gap.
  hooks: {
    logMethod(args, method) {
      const scrubbed = args.map((a) => scrubSecretHex(a)) as typeof args;
      return method.apply(this, scrubbed);
    },
  },
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
