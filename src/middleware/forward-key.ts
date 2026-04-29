/**
 * Forward-key Middleware — Fastify preHandler hook (WKH-65)
 *
 * Optional shared-secret authentication for internal callers (e.g. wasiai-v2
 * thin proxy) calling /compose and /orchestrate from Vercel into Railway.
 *
 * Behavior (env-gated, CD-2):
 *   - WASIAI_V2_FORWARD_KEY unset/empty/whitespace/<16 chars → factory returns
 *     [] (NOT mounted).
 *   - Header x-wasiai-forward-key absent → passthrough to next preHandler (AC-4).
 *   - Header present + value matches → passthrough (AC-2).
 *   - Header present + value differs → 401 INVALID_FORWARD_KEY (AC-3).
 *
 * Security (CD-3, AC-5):
 *   - HMAC-SHA256 both inputs to a fixed 32-byte digest, then
 *     crypto.timingSafeEqual. Eliminates the length branch entirely and
 *     prevents leaking the expected secret length via timing.
 *
 * Logging (CD-4, DT-3, AC-6):
 *   - NEVER logs the forward key value (env or header).
 *   - When x-wasiai-source is present, logs `{ forwardSource }` at info level
 *     after capping at 100 chars to prevent log amplification.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from 'fastify';

const FORWARD_KEY_HEADER = 'x-wasiai-forward-key';
const FORWARD_SOURCE_HEADER = 'x-wasiai-source';
const FORWARD_SOURCE_LOG_MAX = 100;
const FORWARD_KEY_MIN_LENGTH = 16;

/**
 * Hash an arbitrary string into a fixed 32-byte digest using HMAC-SHA256.
 * The "key" is a static domain-separation tag — we are NOT authenticating
 * the input here; we just need both sides of the compare to be hashed to
 * a uniform length so the subsequent timingSafeEqual call has constant
 * time regardless of the original input lengths.
 */
function hmacDigest(input: string): Buffer {
  return createHmac('sha256', 'wasiai-forward-key-compare-v1')
    .update(input)
    .digest();
}

/**
 * Constant-time compare two strings using HMAC-SHA256 + timingSafeEqual.
 * Both paths execute exactly one HMAC + one timingSafeEqual on 32-byte
 * buffers, eliminating any length-dependent branch.
 */
function safeStringEquals(received: string, expected: string): boolean {
  return timingSafeEqual(hmacDigest(received), hmacDigest(expected));
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
  // CD-2 + MNR-2 hardening: trim whitespace and require ≥16 chars.
  // Values like "   ", "0", "false", "changeme" are rejected as misconfig.
  const expected = process.env.WASIAI_V2_FORWARD_KEY?.trim();

  if (!expected || expected.length < FORWARD_KEY_MIN_LENGTH) {
    if (expected && expected.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        '[forward-key] WASIAI_V2_FORWARD_KEY too short or whitespace-only; middleware NOT mounted',
      );
    }
    return [];
  }

  const handler: preHandlerAsyncHookHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    // AC-6 / DT-3: log x-wasiai-source value (informational only, no auth effect).
    // CR-NIT-1: cap the header value at 100 chars BEFORE logging to prevent
    // log amplification attacks (a malicious client could send a 10MB header).
    const sourceHeader = request.headers[FORWARD_SOURCE_HEADER];
    const truncatedSource =
      typeof sourceHeader === 'string' && sourceHeader.length > 0
        ? sourceHeader.slice(0, FORWARD_SOURCE_LOG_MAX)
        : null;
    if (truncatedSource) {
      request.log.info(
        { forwardSource: truncatedSource },
        'forward-key source',
      );
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
