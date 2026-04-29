/**
 * Forward-key Middleware — Fastify preHandler hook (WKH-65)
 *
 * Optional shared-secret authentication for internal callers (e.g. wasiai-v2
 * thin proxy) calling /compose and /orchestrate from Vercel into Railway.
 *
 * Behavior (env-gated, CD-2):
 *   - WASIAI_V2_FORWARD_KEY unset/empty → factory returns [] (NOT mounted).
 *   - Header x-wasiai-forward-key absent → passthrough to next preHandler (AC-4).
 *   - Header present + value matches → passthrough (AC-2).
 *   - Header present + value differs → 401 INVALID_FORWARD_KEY (AC-3).
 *
 * Security (CD-3, AC-5):
 *   - crypto.timingSafeEqual on equal-length Buffers.
 *   - Length mismatch → compare against a same-length dummy buffer to avoid
 *     leaking the expected key length via timing; never throws.
 *
 * Logging (CD-4, DT-3, AC-6):
 *   - NEVER logs the forward key value (env or header).
 *   - When x-wasiai-source is present, logs `{ forwardSource }` at info level.
 */
import crypto from 'node:crypto';
import type {
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from 'fastify';

const FORWARD_KEY_HEADER = 'x-wasiai-forward-key';
const FORWARD_SOURCE_HEADER = 'x-wasiai-source';

/**
 * Constant-time compare two strings using crypto.timingSafeEqual without
 * leaking length information. If lengths differ, compares `received` against
 * a same-length dummy buffer (false return), so timing matches the
 * equal-length path. Never throws on length mismatch.
 */
function safeStringEquals(received: string, expected: string): boolean {
  const recvBuf = Buffer.from(received, 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');

  if (recvBuf.length !== expBuf.length) {
    // Length mismatch → constant-time compare against dummy of the SAME
    // length as the received buffer so the comparison itself doesn't throw
    // (timingSafeEqual requires equal-length inputs). Result is always false.
    const dummy = Buffer.alloc(recvBuf.length, 0);
    crypto.timingSafeEqual(recvBuf, dummy);
    return false;
  }

  return crypto.timingSafeEqual(recvBuf, expBuf);
}

/**
 * Forward-key middleware factory.
 *
 * Returns an empty array when WASIAI_V2_FORWARD_KEY is unset or empty,
 * meaning NO middleware is mounted (AC-1 / CD-2 / DT-1).
 *
 * Returns a single async preHandler when the env var is set.
 */
export function requireForwardKey(): preHandlerAsyncHookHandler[] {
  const expected = process.env.WASIAI_V2_FORWARD_KEY;

  // CD-2: completely inoperante if unset OR empty string.
  if (!expected || expected.length === 0) {
    return [];
  }

  const handler: preHandlerAsyncHookHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    // AC-6 / DT-3: log x-wasiai-source value (informational only, no auth effect).
    const sourceHeader = request.headers[FORWARD_SOURCE_HEADER];
    if (typeof sourceHeader === 'string' && sourceHeader.length > 0) {
      request.log.info({ forwardSource: sourceHeader }, 'forward-key source');
    }

    const headerValue = request.headers[FORWARD_KEY_HEADER];

    // AC-4: header absent → passthrough (does NOT reject).
    if (typeof headerValue !== 'string' || headerValue.length === 0) {
      return;
    }

    // AC-3 / AC-5 / CD-3: timingSafeEqual against expected, length-safe.
    const ok = safeStringEquals(headerValue, expected);

    if (!ok) {
      // CD-4: do NOT log the received key nor the expected value. Only the
      // boolean result is reflected via the error_code.
      request.log.warn(
        { headerPresent: true },
        'forward-key validation failed',
      );
      return reply.status(401).send({
        error: 'Invalid forward key',
        error_code: 'INVALID_FORWARD_KEY',
      });
    }

    // Match → continue to next preHandler (AC-2).
  };

  return [handler];
}
