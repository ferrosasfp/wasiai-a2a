/**
 * WKH-57 DT-B (CD-7): Returns deterministic JSON of `value`: keys sorted
 * alphabetically, recursive. Pure. Never throws for JSON-serializable input.
 * (AB-WKH-55-4.)
 */

import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    // primitives + null. JSON.stringify(undefined) === undefined, fall back to 'null'.
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) =>
      `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
  );
  return `{${parts.join(',')}}`;
}

/** SHA-256 hex truncado a 16 chars del canonicalJson. Pure. */
export function schemaHash(
  schema: Record<string, unknown> | undefined,
): string {
  if (!schema) return 'no-schema';
  return createHash('sha256')
    .update(canonicalJson(schema))
    .digest('hex')
    .slice(0, 16);
}
