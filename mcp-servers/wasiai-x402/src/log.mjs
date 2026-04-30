// log.mjs — JSON-line logger to stderr with key redaction (DT-L, CD-2, CD-15, AC-9, AC-16).
//
// Rules:
// - All output goes to stderr. NEVER stdout (stdout is reserved for MCP stdio JSON-RPC frames).
// - Known sensitive keys are replaced with '[REDACTED]'.
// - Long signature/header keys are truncated to 10 chars + ellipsis.
// - Recursion only descends into plain objects/arrays — primitive values pass through.
// - warnOnce de-duplicates noisy startup warnings (e.g. gateway-default fallback).

const REDACT_KEYS = new Set([
  'OPERATOR_PRIVATE_KEY',
  'privateKey',
  'pk',
  'PRIVATE_KEY',
]);

const TRUNCATE_KEYS = new Set([
  'signature',
  'xPaymentHeader',
]);

const _seenWarnOnce = new Set();

export function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (REDACT_KEYS.has(k)) {
      out[k] = '[REDACTED]';
    } else if (TRUNCATE_KEYS.has(k) && typeof v === 'string') {
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
