import type { PricedModel } from './pricing.js';

/**
 * WKH-57 DT-A: selector cost-aware.
 * - 'claude-haiku-4-5-20251001' for trivial schemas.
 * - 'claude-sonnet-4-6'         for complex schemas (>=5 required, nested object, oneOf/anyOf/allOf).
 *
 * Pure. Never throws for any input shape (defensive). (CD-10/CD-12, AB-WKH-55-4.)
 */
export function selectModel(
  schema: Record<string, unknown> | undefined,
): PricedModel {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return 'claude-haiku-4-5-20251001';
  }

  const required = Array.isArray(schema.required) ? schema.required : [];
  if (required.length >= 5) return 'claude-sonnet-4-6';

  if ('oneOf' in schema || 'anyOf' in schema || 'allOf' in schema) {
    return 'claude-sonnet-4-6';
  }

  const props = schema.properties;
  if (props && typeof props === 'object' && props !== null) {
    for (const v of Object.values(props as Record<string, unknown>)) {
      if (
        v &&
        typeof v === 'object' &&
        (v as Record<string, unknown>).type === 'object'
      ) {
        return 'claude-sonnet-4-6';
      }
    }
  }

  return 'claude-haiku-4-5-20251001';
}
