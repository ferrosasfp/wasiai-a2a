/**
 * Discovery Service — Search agents across all registries
 */

import { normalizeChainSlug } from '../adapters/chain-resolver.js';
import { getRegistryCircuitBreaker } from '../lib/circuit-breaker.js';
import { getLogger } from '../lib/logger.js';
import { parsePriceSafe } from '../lib/price.js';
import { ssrfFetch } from '../lib/ssrf-dispatcher.js';
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
import { SELF_PUBLISHED_REGISTRY_NAME } from '../types/index.js';
import { publishedAgentService } from './agent.js';
import { identityService } from './identity.js';
import { registryService } from './registry.js';
import { reputationService } from './reputation.js';

const log = getLogger('discovery');

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
 * SEC-AR-2026-04-28 BLQ-MED-1 (WKH-113 DT-4/DT-5): dynamic chain validation.
 * Registry comprometido podría exponer `chain: 'avalanche'` (literal) o variantes
 * exóticas para bypassear el guard del downstream-payment. La defensa-en-profundidad
 * es rechazar cualquier chain que el resolver canónico no conozca.
 *
 * Validación (CD-1/CD-9): en lugar de un `Set` hardcodeado de slugs, se deriva
 * de `normalizeChainSlug` (el resolver puro de `../adapters/chain-resolver.js`,
 * reutilizado inbound WKH-111 y downstream WKH-112). Acepta toda chain con
 * adapter conocido (avalanche-*, kite-*, base-*, incl. chainIds numéricos);
 * rechaza slugs desconocidos (polygon/solana → registry comprometido / chain
 * exótica → undefined, defensa preservada).
 *
 * ⚠️ Salida (CD-7): la validación usa `normalizeChainSlug` SOLO para decidir
 * aceptar/rechazar. El valor de `chain` de SALIDA conserva el string legacy:
 * `avalanche-testnet`/`avalanche-mainnet` → `'avalanche'`; resto pass-through.
 * NO se devuelve el `ChainKey` del resolver (devolvería `'avalanche-fuji'` para
 * `'avalanche'`, rompiendo CD-2 y los tests existentes).
 *
 * El downstream pago real (Fuji vs C-Chain) se decide a nivel de
 * `downstream-payment.ts` mediante `WASIAI_DOWNSTREAM_NETWORK`.
 *
 * Retorna undefined si los campos críticos siguen ausentes O la chain no la
 * conoce el resolver.
 */
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

  // SEC-AR BLQ-MED-1 (WKH-113 DT-5): reject any chain the resolver does not
  // know BEFORE normalization. Dynamic validation derived from the pure
  // chain-resolver (no hardcoded slug allowlist — CD-1/CD-9). Unknown slug
  // (registry comprometido / chain exótica) → undefined, defensa preservada.
  if (normalizeChainSlug(chainRaw) === undefined) {
    return undefined;
  }

  // Normalize chain: collapse avalanche testnet/mainnet → 'avalanche' (downstream
  // guard expects canonical). Kite slugs pass through unchanged so consumers can
  // distinguish kite-ozone-testnet from kite-mainnet (different stablecoins).
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

// ─── WKH-100 FIX-PACK (BLQ-MED-1 / DT-21.2) ───────────────────────────
// Base chains we accept for an ERC-8004 declaration (mainnet / sepolia).
const ERC8004_ALLOWED_CHAINS: ReadonlySet<number> = new Set([8453, 84532]);
const TOKEN_ID_RE = /^[0-9]+$/;
// CAIP-10-like agentId: eip155:<chainId>:<registry>/<tokenId>
const CAIP_AGENT_ID_RE = /^eip155:(\d+):0x[0-9a-fA-F]{40}\/([0-9]+)$/;

/**
 * Reads the ERC-8004 identity the AGENT itself DECLARES in its AgentCard
 * (`agent.metadata` — the raw registry payload, discovery.ts mapAgent). The
 * declaration is controlled by the agent, NEVER by the caller of /bind, which
 * is what makes the badge trustless (DT-21.1). Memory-only — NO fetch / RPC
 * (CD-13 / CD-8). DEFAULT SEGURO: nothing parseable → `null` → SIN badge.
 *
 * Resolution order (DT-21.2):
 *   1. metadata.registrations[].agentId  CAIP-10 `eip155:<chainId>:<registry>/<tokenId>`
 *   2. fallback metadata.erc8004 = { token_id|tokenId, chain_id|chainId }
 *   3. fallback top-level metadata.erc8004_token_id + metadata.erc8004_chain_id
 * The FIRST entry whose chainId ∈ {8453, 84532} wins. tokenId stays a decimal
 * string (CD-11, never Number()). chainId outside the allow-set → ignored.
 */
export function extractDeclaredTokenId(
  agent: Agent,
): { tokenId: string; chainId: number } | null {
  const meta = agent.metadata;
  if (!meta || typeof meta !== 'object') return null;

  // 1) Standard A2A/ERC-8004: metadata.registrations[].agentId (CAIP-10-like).
  const registrations = (meta as Record<string, unknown>).registrations;
  if (Array.isArray(registrations)) {
    for (const entry of registrations) {
      const decl = parseRegistrationEntry(entry);
      if (decl) return decl;
    }
  }

  // 2) Fallback: metadata.erc8004 = { token_id|tokenId, chain_id|chainId }.
  const erc8004 = (meta as Record<string, unknown>).erc8004;
  if (erc8004 && typeof erc8004 === 'object') {
    const o = erc8004 as Record<string, unknown>;
    const decl = buildDeclaration(
      o.token_id ?? o.tokenId,
      o.chain_id ?? o.chainId,
    );
    if (decl) return decl;
  }

  // 3) Fallback: top-level metadata.erc8004_token_id + erc8004_chain_id.
  const topDecl = buildDeclaration(
    (meta as Record<string, unknown>).erc8004_token_id,
    (meta as Record<string, unknown>).erc8004_chain_id,
  );
  if (topDecl) return topDecl;

  return null; // DEFAULT SEGURO — sin declaración válida, sin badge.
}

/** Parses one `registrations[]` entry (CAIP-10 agentId or destructured pair). */
function parseRegistrationEntry(
  entry: unknown,
): { tokenId: string; chainId: number } | null {
  if (!entry || typeof entry !== 'object') return null;
  const o = entry as Record<string, unknown>;

  // 2a) CAIP-10-like agentId string.
  if (typeof o.agentId === 'string') {
    const m = CAIP_AGENT_ID_RE.exec(o.agentId);
    if (m?.[1] !== undefined && m[2] !== undefined) {
      const chainId = Number.parseInt(m[1], 10);
      if (ERC8004_ALLOWED_CHAINS.has(chainId)) {
        return { tokenId: m[2], chainId };
      }
    }
  }

  // 2b) Destructured pair some registries may expose.
  return buildDeclaration(o.tokenId ?? o.token_id, o.chainId ?? o.chain_id);
}

/** Validates a (tokenId, chainId) pair into a safe declaration or null. */
function buildDeclaration(
  rawTokenId: unknown,
  rawChainId: unknown,
): { tokenId: string; chainId: number } | null {
  const tokenId =
    typeof rawTokenId === 'string'
      ? rawTokenId.trim()
      : typeof rawTokenId === 'number' && Number.isInteger(rawTokenId)
        ? String(rawTokenId)
        : null;
  if (tokenId === null || !TOKEN_ID_RE.test(tokenId)) return null;

  const chainId =
    typeof rawChainId === 'number'
      ? rawChainId
      : typeof rawChainId === 'string' && /^[0-9]+$/.test(rawChainId.trim())
        ? Number.parseInt(rawChainId.trim(), 10)
        : null;
  if (chainId === null || !ERC8004_ALLOWED_CHAINS.has(chainId)) return null;

  return { tokenId, chainId };
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

    // WKH-134: self-published agents merged con un SELECT local (sin fetch
    // outbound, sin self-fetch). Aditivo/degradable (CD-9): si el SELECT falla,
    // discover() sigue devolviendo los agentes de registries. Se incluyen solo
    // si no se filtró a otro registry (respeta `query.registry`).
    let localAgents: Agent[] = [];
    if (!query.registry || query.registry === SELF_PUBLISHED_REGISTRY_NAME) {
      try {
        localAgents = await publishedAgentService.listAsAgents();
      } catch (err) {
        log.error(
          { detail: err instanceof Error ? err.message : 'unknown' },
          'self-published agents merge failed',
        );
        localAgents = [];
      }
    }

    // NO early-return si solo hay locales (sin registries habilitados).
    if (registries.length === 0 && localAgents.length === 0) {
      return { agents: [], total: 0, registries: [] };
    }

    // First attempt: forward query.query upstream (existing behavior — DT-1).
    let result = await this.runDiscoveryPipeline(
      query,
      registries,
      localAgents,
      false,
    );

    // WKH-157 broaden-retry: a registry's own strict search backend can drop
    // free-text (`q`) matches BEFORE our permissive local substring filter ever
    // runs. If the full pipeline yields 0 agents AND a free-text query was
    // provided, retry ONCE without forwarding `q` upstream so the local filter
    // (name/description/capabilities substring) runs over the complete set.
    // Gate is `total === 0 && query.query` truthy → the planner path
    // (orchestrate.ts:520-524, capabilities-only, no `query`) NEVER triggers
    // this (money-path safe, DT-2 mirror of WKH-151). Single retry, no loop
    // (CD-3). Additive/degradable: the pipeline swallows per-registry errors
    // (CD-4), so the retry can only ever return more or the same 0.
    if (result.total === 0 && query.query) {
      log.info(
        { query: query.query },
        'discover free-text 0 results — broaden retry without upstream q',
      );
      result = await this.runDiscoveryPipeline(
        query,
        registries,
        localAgents,
        true,
      );
    }

    return result;
  },

  /**
   * WKH-157: the shared discover pipeline (fanout → merge → filters → sort →
   * limit → enrich). Extracted from `discover()` so it can run twice for the
   * free-text broaden-retry. `skipUpstreamQuery=true` omits forwarding `q` to
   * the registries (the local substring filter still runs). `localAgents` is
   * the already-fetched self-published set (no re-fetch across attempts).
   */
  async runDiscoveryPipeline(
    query: DiscoveryQuery,
    registries: RegistryConfig[],
    localAgents: Agent[],
    skipUpstreamQuery: boolean,
  ): Promise<DiscoveryResult> {
    // Query all registries in parallel
    const results = await Promise.all(
      registries.map((registry) =>
        this.queryRegistry(registry, query, skipUpstreamQuery).catch((err) => {
          // TD-sprint-security MNR-5: SSRF violations are config issues,
          // not transient errors — log them with a distinct prefix so
          // operators can grep for misconfigured registry endpoints.
          if (err instanceof SSRFViolationError) {
            log.error(
              {
                registry: registry.name,
                category: err.category,
                reason: err.reason,
              },
              'SSRF blocked',
            );
          } else {
            log.error(
              { registry: registry.name, detail: err.message },
              'Error querying registry',
            );
          }
          return [] as Agent[];
        }),
      ),
    );

    // Merge results — los locales entran ANTES del pipeline común
    // (status/verified/caps/price/rep/sort/limit) → mismo shape (CD-6).
    let allAgents = [...results.flat(), ...localAgents];

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

    // WKH-103 (DT-8/OBS-2): score batch pre-sort, 1 query (CD-12). Sin RPC
    // on-chain (CD-13). Corre sobre allAgents (pre-limit) para que la página
    // sea el top-N por reputación real.
    await this.attachReputations(allAgents);

    // Sort: verified-first (AC-7), then reputation (desc), then price (asc).
    // WKH-103 (AC-6/CD-10): lee computedReputation.score con fallback al
    // reputation upstream del registry (NO reasigna `reputation`).
    // B5 (audit 2026-06-24): `?? 0` NO captura NaN (nullish solo cubre
    // null/undefined), y `reputation` viene de `Number(...)` → puede ser NaN.
    // Un NaN en la comparación deja el sort indefinido. Number.isFinite filtra
    // NaN/Infinity además de null/undefined.
    const repValue = (x: Agent): number => {
      const rep = x.computedReputation?.score ?? x.reputation;
      return Number.isFinite(rep) ? (rep as number) : 0;
    };
    allAgents.sort((a, b) => {
      const verifiedDiff = Number(b.verified) - Number(a.verified);
      if (verifiedDiff !== 0) return verifiedDiff;
      const repDiff = repValue(b) - repValue(a);
      if (repDiff !== 0) return repDiff;
      return a.priceUsdc - b.priceUsdc;
    });

    // Apply limit
    const limited = query.limit ? allAgents.slice(0, query.limit) : allAgents;

    // WKH-100 (AC-8/DT-18): enrich batch post-limit with verified ERC-8004
    // identity. No RPC at serve-time — only the JSONB reverse-lookup (W2).
    const enriched = await this.attachIdentities(limited);

    const contributingRegistries = registries.map((r) => r.name);
    if (localAgents.length > 0) {
      contributingRegistries.push(SELF_PUBLISHED_REGISTRY_NAME);
    }

    return {
      agents: enriched,
      total: allAgents.length,
      registries: contributingRegistries,
    };
  },

  /**
   * WKH-100 FIX-PACK v2 (MNR-1 / DT-22.5): attach verified ERC-8004 identity by
   * the BIDIRECTIONAL match. Para cada agente: (i) `extractDeclaredTokenId(a)`
   * extrae el token que el agente DECLARA en su card; (ii)
   * `resolveIdentityForAgent(token, chain, a.registry, a.slug)` cruza ese token
   * contra un binding `ownerOf`-verificado QUE ADEMÁS declare operar
   * `(a.registry, a.slug)`. Sin declaración → skip sin query (MNR-1: menos
   * round-trips). DB failure para un agente → ese agente SIN identity (omitido,
   * no null — AC-9/CD-9), NUNCA rompe discover. No RPC aquí (CD-8): el verify
   * on-chain ocurrió al bindear.
   */
  async attachIdentities(agents: Agent[]): Promise<Agent[]> {
    await Promise.all(
      agents.map(async (a) => {
        const decl = extractDeclaredTokenId(a);
        if (!decl) return; // sin declaración → skip (sin badge, sin query)
        try {
          const identity = await identityService.resolveIdentityForAgent(
            decl.tokenId,
            decl.chainId,
            a.registry_id,
            a.slug,
          );
          if (identity) a.identity = identity;
        } catch {
          /* falla DB → ese agent sin identity, NO rompe discover (DT-18) */
        }
      }),
    );
    return agents;
  },

  /**
   * WKH-103 (DT-8/DT-10): enriquece computedReputation en batch con UN solo
   * query (CD-12). Sin RPC on-chain (CD-13). Fallo DB → agentes sin el campo,
   * NUNCA rompe discover (AC-4/CD-5).
   */
  async attachReputations(agents: Agent[]): Promise<Agent[]> {
    try {
      const slugs = agents.map((a) => a.slug);
      const repMap = await reputationService.computeReputationBatch(slugs);
      for (const a of agents) {
        const rep = repMap.get(a.slug);
        if (rep) a.computedReputation = rep; // omitido si no hay (CD-9)
      }
    } catch {
      /* DB fail → sin reputación, NO rompe discover (AC-4) */
    }
    return agents;
  },

  /**
   * Query a single registry
   */
  async queryRegistry(
    registry: RegistryConfig,
    query: DiscoveryQuery,
    skipUpstreamQuery = false,
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
    // WKH-157: on the broaden-retry (skipUpstreamQuery) we deliberately do NOT
    // forward `q` upstream — the local substring filter in the pipeline runs
    // over the full registry set instead.
    if (query.query && schema.queryParam && !skipUpstreamQuery) {
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
      // M2 (audit 2026-06-24): connect-time SSRF guard. `validateRegistryUrl`
      // above checks the IP at resolution-time, but plain `fetch` re-resolves
      // DNS; `ssrfFetch` revalidates the SAME resolution the socket connects to
      // (closes TOCTOU / DNS-rebinding without breaking TLS/SNI).
      return ssrfFetch(url.toString(), {
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
      // WKH-100 FIX v3 (DT-23): PK canónico del registry, sin re-normalizar.
      // Ancla del match de identidad ERC-8004 (BLQ-MED-1).
      registry_id: registry.id,
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
    // WKH-134: local-first — resolver un agente self-published sin fetch
    // outbound. Degradable (CD-9): si el SELECT falla, seguimos con el fetch
    // de registries. Se intenta solo si no se filtró a otro registry.
    if (!registryId || registryId === SELF_PUBLISHED_REGISTRY_NAME) {
      try {
        const local = await publishedAgentService.getBySlugAsAgent(slug);
        if (local) return local;
      } catch {
        /* degradación: SELECT local falló → seguir con registries */
      }
    }

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

        // M2 (audit 2026-06-24): connect-time SSRF guard on agentEndpoint
        // (re-validates the resolution the socket uses; closes TOCTOU).
        const response = await ssrfFetch(url, {
          headers: { 'Content-Type': 'application/json' },
        });

        if (response.ok) {
          const data = await response.json();
          const agent = this.mapAgent(registry, data);
          // WKH-100 FIX-PACK v2 (DT-22.5): resolve identity by the BIDIRECTIONAL
          // match — token the agent DECLARES crossed with a binding that
          // declares operating (agent.registry, agent.slug). Skip if no
          // declaration. DB failure → agent sin identity, NO rompe getAgent.
          const decl = extractDeclaredTokenId(agent);
          if (decl) {
            try {
              const identity = await identityService.resolveIdentityForAgent(
                decl.tokenId,
                decl.chainId,
                agent.registry_id,
                agent.slug,
              );
              if (identity) agent.identity = identity;
            } catch {
              // degradación (B6 audit): resolveIdentityForAgent falló (DB/red);
              // devolvemos el agent sin identity en vez de romper getAgent.
            }
          }
          return agent;
        }
      } catch {
        // degradación (B6 audit): este registry falló (fetch/SSRF/parse);
        // seguimos al siguiente registry sin romper getAgent (skip-and-continue).
      }
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
 * `parsePriceSafe` — safe floor de precios (WKH-57). Definición canónica en
 * `../lib/price.js` (helper puro, sin deps de servicios) para poder reusarla
 * en `services/agent.ts` sin ciclo de imports. Se re-exporta acá para no
 * romper los imports existentes (`discovery.test.ts`) ni el patrón de
 * registries. CD-7 safe floor: nunca infla vía fallback.
 */
export { parsePriceSafe };

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
    log.warn(
      { slug },
      'price_per_call_usdc is null for agent — using fallback "price_per_call"',
    );
  }
  return parsePriceSafe(fallback);
}
