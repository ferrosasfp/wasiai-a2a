import { getComplexModel, getTrivialModel } from './models.js';

/**
 * WKH-57 DT-A: selector cost-aware.
 * - trivial model (default 'claude-haiku-4-5-20251001') for trivial schemas.
 * - complex model (default 'claude-sonnet-5')           for complex schemas (>=5 required, nested object, oneOf/anyOf/allOf).
 *
 * WKH-135: model IDs are env-driven (llm/models.ts); the branching thresholds
 * (WKH-57) are unchanged — only the returned literals became getters.
 *
 * Pure. Never throws for any input shape (defensive). (CD-10/CD-12, AB-WKH-55-4.)
 */
export function selectModel(
  schema: Record<string, unknown> | undefined,
): string {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return getTrivialModel();
  }

  const required = Array.isArray(schema.required) ? schema.required : [];
  if (required.length >= 5) return getComplexModel();

  if ('oneOf' in schema || 'anyOf' in schema || 'allOf' in schema) {
    return getComplexModel();
  }

  const props = schema.properties;
  if (props && typeof props === 'object' && props !== null) {
    for (const v of Object.values(props as Record<string, unknown>)) {
      if (
        v &&
        typeof v === 'object' &&
        (v as Record<string, unknown>).type === 'object'
      ) {
        return getComplexModel();
      }
    }
  }

  return getTrivialModel();
}
