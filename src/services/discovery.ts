/**
 * Discovery Service — Search agents across all registries
 */

import { getRegistryCircuitBreaker } from '../lib/circuit-breaker.js';
import {
  SSRFViolationError,
  validateRegistryUrl,
} from '../lib/url-validator.js';
import type {
  Agent,
  AgentPaymentSpec,
  AgentStatus,
  DiscoveryQuery,
  DiscoveryResult,
  RegistryConfig,
} from '../types/index.js';
import { registryService } from './registry.js';

// ─── WAS-V2-3-CLIENT (WKH-57) module-scoped warn dedup ────────────────
// Set lives for process lifetime. Reset via `_resetFallbackWarnDedup()`
// in test setUp to avoid cross-test contamination (CD-11).
const _warnedFallbackSlugs = new Set<string>();

/** TEST-ONLY: clears the dedup Set. NOT for production code paths. */
export function _resetFallbackWarnDedup(): void {
  _warnedFallbackSlugs.clear();
}

/**
 * Type guard para `agent.payment` (WKH-55).
 * Schema drift fallback for wasiai-v2 marketplace shape:
 *   - v2 expone `obj.protocol` (e.g. "x402"), pero el WKH-55 código espera `obj.method`.
 *   - v2 expone `chain` top-level (e.g. "avalanche-testnet"), pero WKH-55 lo busca en payment.
 *   - WKH-55 guard chequea `chain === "avalanche"`; normalizamos solo testnet/mainnet → avalanche.
 *
 * SEC-AR-2026-04-28 BLQ-MED-1: chain allowlist explícita.
 * Registry comprometido podría exponer `chain: 'avalanche'` (literal) o variantes
 * exóticas para bypassear el guard del downstream-payment. La defensa-en-profundidad
 * es rechazar cualquier chain que no esté en la allowlist conocida.
 *
 * Allowlist actual:
 *   - `avalanche` (canonical, post-normalization)
 *   - `avalanche-testnet` (wasiai-v2 valor cuando `chain_id=43113`)
 *   - `avalanche-mainnet` (wasiai-v2 valor cuando `chain_id=43114`)
 *
 * El downstream pago real (Fuji vs C-Chain) se decide a nivel de
 * `downstream-payment.ts` mediante `WASIAI_DOWNSTREAM_NETWORK`. Esta
 * allowlist NO discrimina: ambas variantes son aceptadas y se normalizan
 * a `avalanche`. Si el operator NO tiene downstream-network seteado a
 * mainnet, los pagos contra agentes mainnet harán skip (CHAIN_NOT_SUPPORTED
 * en el path de pago, no en discovery).
 *
 * Retorna undefined si los campos críticos siguen ausentes O chain no permitida.
 */
const ALLOWED_CHAIN_VALUES = new Set([
  'avalanche', // canonical (post-normalization)
  'avalanche-testnet', // wasiai-v2 valor cuando chain_id=43113
  'avalanche-mainnet', // wasiai-v2 valor cuando chain_id=43114
]);

function readPayment(
  raw: Record<string, unknown>,
): AgentPaymentSpec | undefined {
  const p = raw.payment;
  if (!p || typeof p !== 'object') return undefined;
  const obj = p as Record<string, unknown>;

  // method: prefer obj.method; fallback to obj.protocol (v2 schema drift)
  const methodRaw =
    typeof obj.method === 'string'
      ? obj.method
      : typeof obj.protocol === 'string'
        ? obj.protocol
        : undefined;

  // chain: prefer obj.chain; fallback to raw.chain (v2 exposes at top level)
  const chainRaw =
    typeof obj.chain === 'string'
      ? obj.chain
      : typeof raw.chain === 'string'
        ? raw.chain
        : undefined;

  if (!methodRaw || !chainRaw || typeof obj.contract !== 'string') {
    return undefined;
  }

  // SEC-AR BLQ-MED-1: reject chain outside allowlist BEFORE normalization
  if (!ALLOWED_CHAIN_VALUES.has(chainRaw)) {
    return undefined;
  }

  // Normalize chain: "avalanche-testnet" / "avalanche-mainnet" → "avalanche"
  // (downstream guard expects canonical name; el discriminator de testnet vs
  // mainnet vive a nivel de WASIAI_DOWNSTREAM_NETWORK).
  const chain =
    chainRaw === 'avalanche-testnet' || chainRaw === 'avalanche-mainnet'
      ? 'avalanche'
      : chainRaw;

  return {
    method: methodRaw,
    chain,
    contract: obj.contract as `0x${string}`,
    asset: typeof obj.asset === 'string' ? obj.asset : undefined,
  };
}

export const discoveryService = {
  /**
   * Discover agents across all enabled registries
   */
  async discover(query: DiscoveryQuery): Promise<DiscoveryResult> {
    const registries = query.registry
      ? ([await registryService.get(query.registry)].filter(
          Boolean,
        ) as RegistryConfig[])
      : await registryService.getEnabled();

    if (registries.length === 0) {
      return { agents: [], total: 0, registries: [] };
    }

    // Query all registries in parallel
    const results = await Promise.all(
      registries.map((registry) =>
        this.queryRegistry(registry, query).catch((err) => {
          // TD-sprint-security MNR-5: SSRF violations are config issues,
          // not transient errors — log them with a distinct prefix so
          // operators can grep for misconfigured registry endpoints.
          if (err instanceof SSRFViolationError) {
            console.error(
              `[Discovery] SSRF blocked for ${registry.name} (${err.category}):`,
              err.reason,
            );
          } else {
            console.error(
              `[Discovery] Error querying ${registry.name}:`,
              err.message,
            );
          }
          return [] as Agent[];
        }),
      ),
    );

    // Merge results
    let allAgents = results.flat();

    // Blocklist: exclude known-broken or mock agents (env-configurable)
    const blocklist = (process.env.AGENT_BLOCKLIST ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (blocklist.length > 0) {
      allAgents = allAgents.filter(
        (a) => !blocklist.includes(a.slug.toLowerCase()),
      );
    }

    // Filter by status: default to active-only unless includeInactive=true (AC-1, AC-2)
    if (!query.includeInactive) {
      allAgents = allAgents.filter((a) => a.status === 'active');
    }

    // Filter by verified if requested (AC-3, AC-9: AND logic with status filter)
    if (query.verified === true) {
      allAgents = allAgents.filter((a) => a.verified === true);
    }

    // Local post-fetch filters (upstream may not support all filter params)
    if (query.capabilities?.length) {
      const caps = query.capabilities.map((c) => c.toLowerCase());
      allAgents = allAgents.filter(
        (a) =>
          a.capabilities.some((ac) => caps.includes(ac.toLowerCase())) ||
          caps.some((c) => a.description.toLowerCase().includes(c)),
      );
    }
    if (query.query) {
      const q = query.query.toLowerCase();
      allAgents = allAgents.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q) ||
          a.capabilities.some((c) => c.toLowerCase().includes(q)),
      );
    }
    if (query.maxPrice != null) {
      const maxPrice = query.maxPrice;
      allAgents = allAgents.filter((a) => a.priceUsdc <= maxPrice);
    }

    // Sort: verified-first (AC-7), then reputation (desc), then price (asc)
    allAgents.sort((a, b) => {
      const verifiedDiff = Number(b.verified) - Number(a.verified);
      if (verifiedDiff !== 0) return verifiedDiff;
      const repDiff = (b.reputation ?? 0) - (a.reputation ?? 0);
      if (repDiff !== 0) return repDiff;
      return a.priceUsdc - b.priceUsdc;
    });

    // Apply limit
    const limited = query.limit ? allAgents.slice(0, query.limit) : allAgents;

    return {
      agents: limited,
      total: allAgents.length,
      registries: registries.map((r) => r.name),
    };
  },

  /**
   * Query a single registry
   */
  async queryRegistry(
    registry: RegistryConfig,
    query: DiscoveryQuery,
  ): Promise<Agent[]> {
    // SSRF guard (WKH-62) — validate before any fetch (CD-A3: outside
    // circuit breaker scope so SSRF attempts don't pollute breaker stats).
    // We validate the raw discoveryEndpoint, NOT url.toString(), because
    // url has query params appended below.
    await validateRegistryUrl(registry.discoveryEndpoint);

    const url = new URL(registry.discoveryEndpoint);
    const schema = registry.schema.discovery;

    // Map query params based on registry schema
    if (query.capabilities?.length && schema.capabilityParam) {
      url.searchParams.set(
        schema.capabilityParam,
        query.capabilities.join(','),
      );
    }
    if (query.query && schema.queryParam) {
      url.searchParams.set(schema.queryParam, query.query);
    }
    if (query.limit && schema.limitParam) {
      url.searchParams.set(schema.limitParam, query.limit.toString());
    }
    if (query.maxPrice && schema.maxPriceParam) {
      url.searchParams.set(schema.maxPriceParam, query.maxPrice.toString());
    }

    // Build headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add auth if configured
    if (registry.auth?.type === 'header' && registry.auth.value) {
      headers[registry.auth.key] = registry.auth.value;
    } else if (registry.auth?.type === 'bearer' && registry.auth.value) {
      headers.Authorization = `Bearer ${registry.auth.value}`;
    }

    const cb = getRegistryCircuitBreaker(registry.name);
    const timeoutMs = parseInt(
      process.env.DISCOVERY_REGISTRY_TIMEOUT_MS ?? '5000',
      10,
    );
    const response = await cb.execute(() => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      return fetch(url.toString(), {
        headers,
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
    });

    if (!response.ok) {
      throw new Error(`Registry ${registry.name} returned ${response.status}`);
    }

    const data = await response.json();

    // Extract agents array using path
    const agentsData = schema.agentsPath
      ? getNestedValue(data, schema.agentsPath)
      : data;

    if (!Array.isArray(agentsData)) {
      return [];
    }

    // Map to standard Agent format
    return agentsData.map((raw) => this.mapAgent(registry, raw));
  },

  /**
   * Map raw API response to standard Agent format
   */
  mapAgent(registry: RegistryConfig, raw: Record<string, unknown>): Agent {
    const mapping = registry.schema.discovery.agentMapping ?? {};

    const slug = String(getNestedValue(raw, mapping.slug ?? 'slug') ?? raw.id);
    const invokeUrl = registry.invokeEndpoint
      .replace('{slug}', slug)
      .replace('{agentId}', String(raw.id ?? slug));

    return {
      id: String(getNestedValue(raw, mapping.id ?? 'id') ?? ''),
      name: String(getNestedValue(raw, mapping.name ?? 'name') ?? ''),
      slug,
      description: String(
        getNestedValue(raw, mapping.description ?? 'description') ?? '',
      ),
      capabilities: toArray(
        getNestedValue(raw, mapping.capabilities ?? 'capabilities'),
      ),
      priceUsdc: resolvePriceWithFallback(raw, mapping.price ?? 'price', slug),
      reputation: Number(
        getNestedValue(raw, mapping.reputation ?? 'reputation') ?? undefined,
      ),
      verified: Boolean(
        getNestedValue(raw, mapping.verified ?? 'verified') ?? false,
      ),
      status: toAgentStatus(getNestedValue(raw, mapping.status ?? 'status')),
      registry: registry.name,
      invokeUrl,
      invocationNote:
        'The invokeUrl is an internal reference. To invoke this agent, use POST /compose or POST /orchestrate on the WasiAI A2A gateway.',
      metadata: raw,
      payment: readPayment(raw),
    };
  },

  /**
   * Get a specific agent by slug
   */
  async getAgent(slug: string, registryId?: string): Promise<Agent | null> {
    const registries = registryId
      ? ([await registryService.get(registryId)].filter(
          Boolean,
        ) as RegistryConfig[])
      : await registryService.getEnabled();

    for (const registry of registries) {
      try {
        if (!registry.agentEndpoint) continue;

        const url = registry.agentEndpoint
          .replace('{slug}', slug)
          .replace('{agentId}', slug);

        // SSRF guard (WKH-62) — runtime check on agentEndpoint before
        // outbound fetch. agentEndpoint is NOT validated at write-time
        // (scope OUT of WKH-62) so we MUST validate here. Skip this
        // registry on SSRF violation and try the next one (preserves the
        // existing skip-and-continue pattern in the empty catch below).
        try {
          await validateRegistryUrl(url);
        } catch (err) {
          if (err instanceof SSRFViolationError) continue;
          throw err;
        }

        const response = await fetch(url, {
          headers: { 'Content-Type': 'application/json' },
        });

        if (response.ok) {
          const data = await response.json();
          return this.mapAgent(registry, data);
        }
      } catch {}
    }

    return null;
  },
};

// Helper: Get nested value from object using dot notation
function getNestedValue(obj: unknown, path: string): unknown {
  return path.split('.').reduce((current, key) => {
    if (current && typeof current === 'object' && key in current) {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

// Helper: Convert raw value to AgentStatus, defaulting to "active" (AC-6)
const VALID_STATUSES: ReadonlySet<string> = new Set([
  'active',
  'inactive',
  'unreachable',
]);

function toAgentStatus(value: unknown): AgentStatus {
  const s = typeof value === 'string' ? value.toLowerCase() : '';
  return VALID_STATUSES.has(s) ? (s as AgentStatus) : 'active';
}

// Helper: Convert value to array
function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return value.split(',').map((s) => s.trim());
  return [];
}

// ─── WAS-V2-3-CLIENT (WKH-57): defensive fallback for v2 schema drift ──

/** Field name used as fallback when registry's canonical price path is null/undefined. */
const V2_PRICE_FALLBACK_FIELD = 'price_per_call' as const;

/**
 * Parses a raw value (number | string | null | undefined) into a finite,
 * non-negative number. Returns 0 for any of: null, undefined, NaN, Infinity,
 * negative number, non-parseable string, empty string.
 *
 * Pattern: mirrors `getProtocolFeeRate` in fee-charge.ts (Number.parseFloat
 * + Number.isFinite). CD-7 safe floor applies — never inflate via fallback.
 */
export function parsePriceSafe(raw: unknown): number {
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 0 ? raw : 0;
  }
  if (typeof raw === 'string') {
    if (raw === '') return 0;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }
  return 0;
}

/**
 * Resolves agent.priceUsdc from a raw response, with v2 schema-drift fallback.
 *
 * - If `canonicalPath` is populated (even with 0), returns parsePriceSafe(canonical).
 *   This preserves CD-2 backward-compat: explicit 0 from canonical wins.
 * - Else attempts to read V2_PRICE_FALLBACK_FIELD ('price_per_call').
 * - When the fallback IS taken (i.e. canonical was null/undefined AND fallback was
 *   present), emits exactly one console.warn per slug per process (CD-3 + DT-B).
 *
 * @param raw  Raw registry response object.
 * @param canonicalPath  Path configured by registry (e.g. 'price_per_call_usdc').
 * @param slug  Agent slug for log dedup.
 */
function resolvePriceWithFallback(
  raw: Record<string, unknown>,
  canonicalPath: string,
  slug: string,
): number {
  const canonical = getNestedValue(raw, canonicalPath);
  if (canonical !== null && canonical !== undefined) {
    return parsePriceSafe(canonical);
  }
  const fallback = getNestedValue(raw, V2_PRICE_FALLBACK_FIELD);
  if (fallback === null || fallback === undefined) return 0;
  if (!_warnedFallbackSlugs.has(slug)) {
    _warnedFallbackSlugs.add(slug);
    console.warn(
      `[Discovery] price_per_call_usdc is null for agent "${slug}" — using fallback "price_per_call"`,
    );
  }
  return parsePriceSafe(fallback);
}
