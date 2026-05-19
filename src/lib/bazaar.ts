/**
 * Bazaar Discovery Extension factory (WKH-106 BASE-03).
 *
 * Wraps the `@x402/extensions/bazaar` SDK so the rest of the codebase can:
 *   1. Validate that an agent's manifest-declared `inputSchema` / `outputSchema`
 *      are syntactically valid JSON Schema objects (AC-4 / CD-7).
 *   2. Produce a discovery extension object suitable for inclusion in x402
 *      payment requirements when an agent on a Base chain opts in to
 *      Bazaar discovery (AC-6 / CD-1).
 *
 * IMPORTANT — API DEVIATION FROM WORK-ITEM:
 *   The work-item assumed `@x402/extensions/bazaar` exposed a Fastify
 *   middleware. The actual SDK exposes pure builder / validator functions
 *   instead. See `doc/sdd/090-wkh-106-bazaar-extension/auto-blindaje.md`
 *   for the reasoning. This factory encapsulates the SDK so the rest of
 *   the codebase stays decoupled from the actual shape.
 *
 * Encapsulation goals:
 *   - Allow tree-shaking when discoverable agents are absent.
 *   - Keep the SDK import in one place so future SDK upgrades have a
 *     single touch-point.
 *   - Provide a typed `BazaarSchemaError` callers can map to HTTP 422.
 */

import { Ajv } from 'ajv';
import {
  type DeclareBodyDiscoveryExtensionConfig,
  type DeclareMcpDiscoveryExtensionConfig,
  type DeclareQueryDiscoveryExtensionConfig,
  declareDiscoveryExtension,
  type DiscoveryExtension,
  validateDiscoveryExtension,
} from '@x402/extensions/bazaar';

/**
 * Input config for `buildBazaarDiscoveryExtension`.
 *
 * NOTE on SDK typing: the SDK's exported `DeclareDiscoveryExtensionInput`
 * applies `DistributiveOmit<..., 'method'>` which strips the `method`
 * discriminator from the type even though the runtime function REQUIRES
 * `method` for HTTP configs (see SDK README examples). We re-export the
 * underlying config types directly so callers can pass `method` without
 * a type cast.
 */
export type BazaarDeclareConfig =
  | DeclareQueryDiscoveryExtensionConfig
  | DeclareBodyDiscoveryExtensionConfig
  | DeclareMcpDiscoveryExtensionConfig;

/**
 * Thrown when the agent's manifest declares `discoverable: true` but the
 * `inputSchema` or `outputSchema` field is structurally invalid.
 *
 * Route handlers MUST map this to HTTP 422 (CD-7). The `field` property
 * identifies which schema failed validation so the error response can
 * point the dev at the right manifest property.
 */
export class BazaarSchemaError extends Error {
  readonly field: 'inputSchema' | 'outputSchema' | 'manifest';
  readonly details: string[];

  constructor(
    field: 'inputSchema' | 'outputSchema' | 'manifest',
    message: string,
    details: string[] = [],
  ) {
    super(message);
    this.name = 'BazaarSchemaError';
    this.field = field;
    this.details = details;
  }
}

// AJV singleton — strict:false to accept both draft-7 and draft-2020-12
// declared by manifest authors. The SDK envelope itself uses draft-2020-12
// (see `@x402/extensions/bazaar` `$schema` constants), but the inner
// `inputSchema` declared by the agent dev is free-form.
const _ajv = new Ajv({ strict: false, allErrors: true });

/**
 * Validates a raw JSON Schema object by attempting to compile it.
 *
 * AJV `compile()` throws if the schema is malformed (e.g. invalid `type`,
 * unknown keyword without strict:false, references unresolvable, etc.).
 *
 * @returns array of human-readable errors. Empty array = schema is valid.
 */
function compileOrCollectErrors(
  schema: Record<string, unknown>,
): string[] {
  try {
    _ajv.compile(schema);
    return [];
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
}

/**
 * Validates that the manifest's `inputSchema` / `outputSchema` fields are
 * syntactically valid JSON Schema objects.
 *
 * Throws `BazaarSchemaError` if either schema fails. Callers route this
 * to HTTP 422 (CD-7).
 *
 * NOTE: this validates the SHAPE of the JSON Schema (i.e. that it compiles).
 * It does NOT exercise the schema against any sample input.
 */
export function validateAgentSchemas(input: {
  inputSchema?: unknown;
  outputSchema?: unknown;
}): void {
  if (input.inputSchema !== undefined) {
    if (
      typeof input.inputSchema !== 'object' ||
      input.inputSchema === null ||
      Array.isArray(input.inputSchema)
    ) {
      throw new BazaarSchemaError(
        'inputSchema',
        'inputSchema must be a JSON Schema object',
      );
    }
    const errors = compileOrCollectErrors(
      input.inputSchema as Record<string, unknown>,
    );
    if (errors.length > 0) {
      throw new BazaarSchemaError(
        'inputSchema',
        `inputSchema is not a valid JSON Schema: ${errors[0]}`,
        errors,
      );
    }
  }

  if (input.outputSchema !== undefined) {
    if (
      typeof input.outputSchema !== 'object' ||
      input.outputSchema === null ||
      Array.isArray(input.outputSchema)
    ) {
      throw new BazaarSchemaError(
        'outputSchema',
        'outputSchema must be a JSON Schema object',
      );
    }
    const errors = compileOrCollectErrors(
      input.outputSchema as Record<string, unknown>,
    );
    if (errors.length > 0) {
      throw new BazaarSchemaError(
        'outputSchema',
        `outputSchema is not a valid JSON Schema: ${errors[0]}`,
        errors,
      );
    }
  }
}

/**
 * Builds a Bazaar discovery extension object from an agent manifest.
 *
 * The output is a `Record<string, DiscoveryExtension>` whose key is the
 * canonical Bazaar extension identifier (`BAZAAR`). This object can be
 * attached to x402 PaymentRequirements `extensions` when the agent's
 * upstream server returns a 402 response (AC-6).
 *
 * NOTE: in the current wasiai-a2a architecture, the gateway itself does
 * NOT serve 402 responses for agent invocations (the agent's own server
 * does). This factory is provided so:
 *   1. Tests can verify the extension is well-formed.
 *   2. Future work that mounts the gateway as a Bazaar-aware resource
 *      server (e.g. for the self-hosted facilitator) can reuse it.
 *
 * Throws `BazaarSchemaError` if the SDK's own validation rejects the
 * generated extension.
 */
export function buildBazaarDiscoveryExtension(
  config: BazaarDeclareConfig,
): Record<string, DiscoveryExtension> {
  // Cast to SDK's narrow input type (which omits `method` via DistributiveOmit).
  // The runtime requires `method` for HTTP configs — see SDK examples.
  const extensionRecord = declareDiscoveryExtension(
    config as Parameters<typeof declareDiscoveryExtension>[0],
  );

  // Each value in the record is a DiscoveryExtension; validate them all
  // before returning so consumers get a consistent fail-fast contract.
  for (const ext of Object.values(extensionRecord)) {
    const result = validateDiscoveryExtension(ext);
    if (!result.valid) {
      throw new BazaarSchemaError(
        'manifest',
        'Bazaar discovery extension failed SDK validation',
        result.errors ?? [],
      );
    }
  }

  return extensionRecord;
}
