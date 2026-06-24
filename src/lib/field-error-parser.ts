/**
 * Field-error parser — WKH-130 (W1)
 *
 * Pure function that extracts the names of missing/invalid fields from the
 * `Error.message` thrown by compose's invokeAgent when an upstream agent
 * returns a 4xx with a parseable body. The message format is:
 *   `Agent <slug> returned <status>: <body_truncado_300>`
 * (see compose.ts invokeAgent, the `response.ok === false` branch).
 *
 * Contract (CD-10):
 *  - Pure: no I/O.
 *  - NEVER throws for ANY input — any internal exception degrades to `null`.
 *  - Only 4xx are considered (5xx / no-status → null).
 *  - Returns a non-empty `string[]` of field names, or `null` if nothing
 *    parseable was found.
 */

/**
 * Parses the field names an upstream agent flagged as missing/invalid.
 *
 * @param errorMessage the raw `Error.message` from compose's catch.
 * @returns `string[]` (≥1 field name) or `null` when nothing is parseable.
 */
export function parseFieldErrors(errorMessage: string): string[] | null {
  try {
    // ── Step 1: status guard — only 4xx are retry-eligible.
    const statusMatch = /returned (\d{3})/.exec(errorMessage);
    if (!statusMatch) return null;
    const status = Number.parseInt(statusMatch[1], 10);
    if (status < 400 || status >= 500) return null;

    // ── Step 2: extract the JSON object substring (first `{` … last `}`).
    const firstBrace = errorMessage.indexOf('{');
    const lastBrace = errorMessage.lastIndexOf('}');
    let parsed: Record<string, unknown> | null = null;
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const jsonSlice = errorMessage.slice(firstBrace, lastBrace + 1);
      try {
        const candidate = JSON.parse(jsonSlice);
        if (
          typeof candidate === 'object' &&
          candidate !== null &&
          !Array.isArray(candidate)
        ) {
          parsed = candidate as Record<string, unknown>;
        }
      } catch {
        // truncated / malformed JSON → fall through to free-text parsing.
        parsed = null;
      }
    }

    // ── Step 3: Zod shape (`details.fieldErrors`).
    if (parsed) {
      const details = parsed.details as Record<string, unknown> | undefined;
      const fieldErrors = details?.fieldErrors as
        | Record<string, unknown>
        | undefined;
      if (
        fieldErrors &&
        typeof fieldErrors === 'object' &&
        !Array.isArray(fieldErrors)
      ) {
        const keys = Object.keys(fieldErrors).filter((k) => {
          const msgs = fieldErrors[k];
          return Array.isArray(msgs) && msgs.length > 0;
        });
        if (keys.length > 0) return keys;
      }
    }

    // ── Step 4: free-text shape.
    const freeText =
      parsed && typeof parsed.error === 'string'
        ? parsed.error
        : parsed && typeof parsed.message === 'string'
          ? parsed.message
          : errorMessage;

    const tokens = extractFieldsFromText(freeText);
    if (tokens.length > 0) return tokens;

    // ── Step 5: nothing parseable.
    return null;
  } catch {
    // CD-10: never throw — any unexpected failure degrades to null.
    return null;
  }
}

const IDENTIFIER_RE = /^[A-Za-z0-9_]+$/;

/**
 * Extracts field tokens from a free-text error string. Two shapes:
 *  - list form: `"a, b, c required"` → tokens preceding `required`.
 *  - single form: `"field X is required"` / `"X is required"` /
 *    `"missing field X"` → captures `X`.
 * Tokens are trimmed and filtered to plain identifiers (`[A-Za-z0-9_]+`).
 */
function extractFieldsFromText(text: string): string[] {
  // Single-field patterns first (more specific).
  const singlePatterns = [
    /(?:field\s+)([A-Za-z0-9_]+)\s+is\s+required/i,
    /missing\s+field\s+([A-Za-z0-9_]+)/i,
    /^([A-Za-z0-9_]+)\s+is\s+required/i,
  ];
  for (const re of singlePatterns) {
    const m = re.exec(text);
    if (m?.[1] && IDENTIFIER_RE.test(m[1])) return [m[1]];
  }

  // List form: "<tokens> required". Take the segment before `required`.
  const requiredIdx = text.toLowerCase().indexOf('required');
  if (requiredIdx !== -1) {
    const head = text.slice(0, requiredIdx);
    const tokens = head
      .split(/,|\band\b/i)
      .map((t) => t.trim())
      .filter((t) => t.length > 0 && IDENTIFIER_RE.test(t));
    if (tokens.length > 0) return tokens;
  }

  return [];
}
