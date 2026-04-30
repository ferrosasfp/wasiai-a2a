// log.mjs — JSON-line logger to stderr with key redaction (DT-L, CD-2, CD-15, AC-9, AC-16).
//
// Rules:
// - All output goes to stderr. NEVER stdout (stdout is reserved for MCP stdio JSON-RPC frames).
// - Known sensitive keys are replaced with '[REDACTED]'.
// - Signature keys are truncated to 4 chars + ellipsis (BLQ-3 fix-pack iter 1):
//   16 bits is too short for fingerprint correlation but enough to spot
//   duplicate envelopes in logs. xPaymentHeader stays at 10+ellipsis (long
//   structured base64; not signature material).
// - Recursion only descends into plain objects/arrays — primitive values pass through.
// - warnOnce de-duplicates noisy startup warnings (e.g. gateway-default fallback).

const REDACT_KEYS = new Set([
  'OPERATOR_PRIVATE_KEY',
  'privateKey',
  'pk',
  'PRIVATE_KEY',
]);

// xPaymentHeader: long structured base64 envelope (not signature material) → 10 chars.
const TRUNCATE_KEYS_LONG = new Set([
  'xPaymentHeader',
]);

// signature: 65-byte secp256k1 — 4 chars (16 bits) is enough to detect
// duplicate envelopes in logs but too short for fingerprint correlation
// across sessions (BLQ-3 fix-pack iter 1).
const TRUNCATE_KEYS_SHORT = new Set([
  'signature',
]);

const _seenWarnOnce = new Set();

export function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (REDACT_KEYS.has(k)) {
      out[k] = '[REDACTED]';
    } else if (TRUNCATE_KEYS_SHORT.has(k) && typeof v === 'string') {
      out[k] = v.length > 4 ? v.slice(0, 4) + '…' : v;
    } else if (TRUNCATE_KEYS_LONG.has(k) && typeof v === 'string') {
      out[k] = v.length > 10 ? v.slice(0, 10) + '…' : v;
    } else if (v && typeof v === 'object') {
      out[k] = redact(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function emit(level, event, fields) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...redact(fields ?? {}),
  });
  // DT-L: stderr only.
  process.stderr.write(line + '\n');
}

export function info(event, fields) { emit('info', event, fields); }
export function warn(event, fields) { emit('warn', event, fields); }
export function error(event, fields) { emit('error', event, fields); }

export function warnOnce(key, event, fields) {
  if (_seenWarnOnce.has(key)) return;
  _seenWarnOnce.add(key);
  warn(event, fields);
}

export function resetWarnOnce() { _seenWarnOnce.clear(); }
