/**
 * Transform HMAC — WKH-60 / SEC-RCE-1 W1
 *
 * Sign + verify helpers for cached transform function bodies.
 *
 * Why: even with the VM sandbox (W0), a malicious actor with write access to
 * `kite_schema_transforms.transform_fn` (rogue admin, leaked service-role key)
 * could replace a legitimate cached fn with one designed to exfiltrate via the
 * fields it returns. The HMAC binds the cached body to a server-side secret —
 * a row whose signature does not verify is treated as miss.
 *
 * Signature is computed as HMAC-SHA256(hmacKey, transformFn) and stored as
 * lowercase hex. The schema_hash is NOT included in the signature input
 * because the row-level UNIQUE constraint already binds (source, target,
 * schema_hash) — re-binding here would force re-sign on every schema rename.
 *
 * Comparison uses `crypto.timingSafeEqual` to avoid leaking the prefix length
 * of a forged signature via wall-clock timing.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const HEX = /^[0-9a-f]{64}$/;

/**
 * Sign a transform function body with the given HMAC key.
 *
 * @param transformFn  The function body string returned by the LLM.
 * @param hmacKey      Secret key. Must be a non-empty string. The exact
 *                     entropy is the caller's responsibility; we recommend
 *                     32+ random bytes (base64 or hex).
 * @returns A 64-char lowercase hex string (HMAC-SHA256).
 */
export function signTransformFn(
  transformFn: string,
  hmacKey: string,
): string {
  if (typeof transformFn !== 'string') {
    throw new TypeError('transformFn must be a string');
  }
  if (typeof hmacKey !== 'string' || hmacKey.length === 0) {
    throw new TypeError('hmacKey must be a non-empty string');
  }
  return createHmac('sha256', hmacKey).update(transformFn).digest('hex');
}

/**
 * Constant-time verify of a transform function body against a stored
 * signature.
 *
 * @returns `true` if the signature matches; `false` otherwise — including
 *          when the signature is malformed (wrong length, non-hex chars).
 *          NEVER throws on bad input so the caller can treat any negative
 *          result as a cache miss.
 */
export function verifyTransformFn(
  transformFn: string,
  signature: string,
  hmacKey: string,
): boolean {
  if (
    typeof transformFn !== 'string' ||
    typeof signature !== 'string' ||
    typeof hmacKey !== 'string' ||
    hmacKey.length === 0
  ) {
    return false;
  }

  // Reject malformed signatures BEFORE allocating hash buffers — also avoids
  // throwing inside timingSafeEqual when the lengths differ.
  if (!HEX.test(signature)) {
    return false;
  }

  const expected = createHmac('sha256', hmacKey).update(transformFn).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  if (provided.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(expected, provided);
}
