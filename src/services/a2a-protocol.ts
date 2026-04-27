/**
 * A2A Protocol helpers — WKH-56
 *
 * Pure, side-effect-free, tree-shakeable helpers for Google A2A v1
 * Message{role, parts} interop. NEVER throw. Used by `compose.ts` to detect
 * native A2A traffic and short-circuit `maybeTransform` (fast-path).
 *
 * CD-8: tree-shakeable (no module-level side effects).
 * CD-12: never throw (return safe defaults).
 * CD-13: constructor explícito (no spread del input).
 * CD-15: anti-mutation (returns new arrays).
 * CD-16: type guards usan narrowing real (`value is A2AMessage`).
 */

import type { A2AMessage } from '../types/index.js';

/**
 * Type guard for Google A2A v1 Message{role, parts}.
 *
 * AC-5: returns true iff value is a non-null object with:
 *   - role ∈ {'agent', 'user', 'tool'}
 *   - parts is a non-empty array
 *   - every part is a non-null object with kind ∈ {'text', 'data', 'file'}
 *
 * NEVER throws. Pure function.
 */
export function isA2AMessage(value: unknown): value is A2AMessage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.role !== 'agent' && v.role !== 'user' && v.role !== 'tool') return false;
  if (!Array.isArray(v.parts) || v.parts.length === 0) return false;
  for (const p of v.parts) {
    if (typeof p !== 'object' || p === null) return false;
    const part = p as Record<string, unknown>;
    if (part.kind !== 'text' && part.kind !== 'data' && part.kind !== 'file') {
      return false;
    }
  }
  return true;
}

/**
 * Extracts inner payload of an A2A message into an array of part-payloads.
 *
 * - 'text' part → string (the .text field)
 * - 'data' part → unknown (the .data field)
 * - 'file' part → the .file sub-object
 *
 * Order preserved. Used in AC-3 to unwrap parts[0] when target is non-A2A.
 *
 * Returns a NEW array (CD-15: anti-mutation). NEVER throws (CD-12).
 */
export function extractA2APayload(msg: A2AMessage): unknown[] {
  const out: unknown[] = [];
  for (const part of msg.parts) {
    if (part.kind === 'text') {
      out.push(part.text);
    } else if (part.kind === 'data') {
      out.push(part.data);
    } else {
      out.push(part.file);
    }
  }
  return out;
}

/**
 * Wraps an arbitrary value into a minimal valid A2A Message.
 *
 * Constructor explícito (CD-13, AB-WKH-55-5):
 *   { role: 'agent', parts: [{ kind: 'data', data: data ?? null }] }
 *
 * NEVER throws (CD-12). Provided for completeness; NOT called from compose.ts
 * in WKH-56 (deferred to WKH-57 / AC-4).
 */
export function buildA2APayload(data: unknown): A2AMessage {
  return {
    role: 'agent',
    parts: [{ kind: 'data', data: data ?? null }],
  };
}
