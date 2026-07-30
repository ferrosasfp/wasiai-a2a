/**
 * Discovery Service — Search agents across all registries
 */

// HU-208: lector ÚNICO de `category`, compartido con `services/compose.ts` (el
// que HACE CUMPLIR el alcance). Ver lib/agent-category.ts.
import { readAgentCategory } from '../lib/agent-category.js';
import { getRegistryCircuitBreaker } from '../lib/circuit-breaker.js';
// Fix-pack P1 AR BLQ-BAJO-1: el over-fetch vive en un módulo LEAF porque
// `services/compose.ts` también necesita el límite del pool y las suites que
// mockean este service completo dejarían el export en `undefined`.
import { resolveUpstreamFetchLimit } from '../lib/discovery-fetch-limit.js';
// WKH-318: el vocabulario de la honestidad del catálogo vive en un módulo LEAF
// por la MISMA razón que `discovery-fetch-limit.js` (ver su docstring): las
// suites que mockean este service completo dejarían un export nuevo en
// `undefined`, y `routes/compose.ts` necesita estas funciones.
import {
  buildCatalogStatus,
  classifyFetchFailure,
  RegistryHttpError,
} from '../lib/discovery-sources.js';
import { getLogger } from '../lib/logger.js';
import { readPaymentSpec } from '../lib/payment-spec-reader.js';
import { parsePriceSafe } from '../lib/price.js';
// HU-208: desempate aleatorio del ranking. Módulo LEAF (fuente inyectable para
// que los tests no dependan de `Math.random`).
import { assignTiebreaks, compareTiebreak } from '../lib/ranking-tiebreak.js';
import { ssrfFetch } from '../lib/ssrf-dispatcher.js';
import {
  SSRFViolationError,
  validateRegistryUrl,
} from '../lib/url-validator.js';
import type {
  Agent,
  AgentStatus,
  DiscoveryQuery,
  DiscoveryResult,
  DiscoverySource,
  RegistryConfig,
  RegistryFetchOutcome,
} from '../types/index.js';
import { SELF_PUBLISHED_REGISTRY_NAME } from '../types/index.js';
import { publishedAgentService } from './agent.js';
// HU-208: `authz.ts` es una hoja pura (sólo `import type`), así que no hay ciclo.
import { authzService } from './authz.js';
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

// ─── WKH-241: el lector del payment spec vive en un módulo leaf ────────
// `readPayment` (ex líneas 71-119) se movió TAL CUAL a
// `../lib/payment-spec-reader.js` (`readPaymentSpec`) para compartir el MISMO
// choke-point con el mapper de agentes self-published (`agent.ts`
// `mapRowToAgent`) — un solo validador de chain (CD-1/AC-4), sin ciclo de
// módulos (`discovery.ts` ya importa `agent.ts`, DT-1). Comportamiento y
// salida byte-idénticos para los registries externos (CD-2).

// ─── WKH-100 FIX-PACK (BLQ-MED-1 / DT-21.2) ───────────────────────────
// Chains we accept for an ERC-8004 declaration surfaced through /discover:
// Base mainnet/sepolia (8453/84532) + Avalanche C-Chain/Fuji (43114/43113).
//
// WKH-237 (DT-1a): this is SOLELY the discovery accept-set — it gates which
// chainId a DECLARED identity (metadata.registrations[]/metadata.erc8004) and
// the JSONB reverse-lookup (resolveIdentityForAgent) may carry. It does NOT
// enable on-chain bind/verify on Avalanche: `POST /erc8004/bind`
// (src/routes/auth/identity.ts + src/adapters/erc8004-identity.ts) stays
// Base-only by design in this HU. Extending the bind route to Avalanche
// (new multi-chain reader + ERC8004_REGISTRY_ADDRESS_AVALANCHE_* env vars +
// a deployed IdentityRegistry) is WKH-237b / Scope OUT. Do NOT assume a badge
// here implies an Avalanche on-chain bind path exists.
const ERC8004_ALLOWED_CHAINS: ReadonlySet<number> = new Set([
  8453, 84532, 43114, 43113,
]);
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
 * The FIRST entry whose chainId ∈ {8453, 84532, 43114, 43113} wins (WKH-237).
 * tokenId stays a decimal string (CD-11, never Number()). chainId outside the
 * allow-set → ignored.
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

// ─── Fix-pack P1 (hallazgo 2): `minReputation` ─────────────────────────
// El parámetro se aceptaba en GET/POST /discover, viajaba en el DiscoveryQuery
// y NUNCA se leía acá: no filtraba nada. Un caller creía estar pidiendo agentes
// con reputación mínima y recibía cualquiera.
//
// Se implementa (hay fuente real y YA cableada en este mismo path: el score
// off-chain 0-100 de `reputationService.computeReputationBatch`, adjuntado
// pre-limit por `attachReputations` — costo del filtro: 0 queries nuevas).
//
// La VALIDACIÓN del parámetro vive en `../lib/discovery-query.js` (módulo leaf),
// no acá: los tests de la ruta mockean este service completo, así que un export
// nuevo del service que la ruta consuma quedaría `undefined` en esos tests.

export const discoveryService = {
  /**
   * Discover agents across all enabled registries
   */
  async discover(query: DiscoveryQuery): Promise<DiscoveryResult> {
    // HIGH-1: `getWithSecrets` (no `get`) porque `fetchFromRegistry` necesita
    // `auth.value` para armar el header outbound. El RegistryConfig NUNCA sale
    // en la respuesta: `DiscoveryResult.registries` es `string[]` (nombres).
    const registries = query.registry
      ? ([await registryService.getWithSecrets(query.registry)].filter(
          Boolean,
        ) as RegistryConfig[])
      : await registryService.getEnabled();

    // WKH-134: self-published agents merged con un SELECT local (sin fetch
    // outbound, sin self-fetch). Aditivo/degradable (CD-9): si el SELECT falla,
    // discover() sigue devolviendo los agentes de registries. Se incluyen solo
    // si no se filtró a otro registry (respeta `query.registry`).
    // ── WKH-318 (AR BLQ-2): la fuente local también rinde cuentas ──────────
    //
    // El `catch` degradaba a `localAgents = []` y la fila de `self-published` se
    // empujaba sólo si había agentes. O sea: un SELECT caído era INDISTINGUIBLE
    // de "no hay agentes self-published", y el catálogo se declaraba `complete`
    // igual. Es la misma mentira que esta HU mata del lado federado, del lado
    // local — y encima sobre la fuente que carga los tres agentes del money-path
    // de Chaski.
    //
    // `null` = no se la consultó (el caller filtró a otro registry): no es una
    // fuente de esta query y no debe aparecer en `sources`.
    let localAgents: Agent[] = [];
    let localSource: DiscoverySource | null = null;
    if (!query.registry || query.registry === SELF_PUBLISHED_REGISTRY_NAME) {
      try {
        localAgents = await publishedAgentService.listAsAgents();
        // `state: 'ok'` con evidencia, no por defecto: `listAsAgents()` es un
        // SELECT sin `limit` ni cursor (`services/agent.ts:429-440`), así que
        // devuelve TODO lo que hay. La completitud está probada por construcción.
        localSource = {
          name: SELF_PUBLISHED_REGISTRY_NAME,
          state: 'ok',
          rows: localAgents.length,
        };
      } catch (err) {
        log.error(
          { detail: err instanceof Error ? err.message : 'unknown' },
          'self-published agents merge failed',
        );
        // CD-9: se sigue degradando — un SELECT caído no tumba discover(). Lo
        // que cambia es que ahora se DECLARA en vez de desaparecer.
        localAgents = [];
        const failure = classifyFetchFailure(err);
        localSource = {
          name: SELF_PUBLISHED_REGISTRY_NAME,
          state: 'failed',
          rows: null,
          failure,
        };
        log.warn(
          {
            error_code: 'REGISTRY_SOURCE_FAILED',
            registry: SELF_PUBLISHED_REGISTRY_NAME,
            failure,
          },
          '[discovery.source-failed] a registry could not be queried; the catalog is partial',
        );
      }
    }

    // NO early-return si solo hay locales (sin registries habilitados).
    if (registries.length === 0 && localAgents.length === 0) {
      // WKH-318: sin fuentes, `complete` — no hay nada que haya fallado ni nada
      // cuya completitud haya quedado sin probar. "No tengo a quién preguntarle"
      // no es "no pude preguntar".
      //
      // Pero si la fuente local SÍ se consultó y se cayó, su fila viaja igual:
      // este early-return también se alcanza cuando el SELECT falló y no hay
      // registries, y ahí el catálogo es `partial`, no `complete`.
      //
      // CR MNR-A: el roll-up sale de `buildCatalogStatus`, NUNCA de un literal.
      // Dos expresiones de la misma regla divergen (CD-11), y ésta era la única
      // línea de producción nueva sin cobertura.
      const sources = localSource ? [localSource] : [];
      return {
        agents: [],
        total: 0,
        registries: [],
        sources,
        catalogStatus: buildCatalogStatus(sources),
      };
    }

    // First attempt: forward query.query upstream (existing behavior — DT-1).
    let result = await this.runDiscoveryPipeline(
      query,
      registries,
      localAgents,
      false,
      localSource,
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
        localSource,
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
   *
   * WKH-318 (AR BLQ-2): `localSource` es CÓMO le fue a ese SELECT — `null` si no
   * se lo consultó. Viaja aparte de `localAgents` porque un array vacío no puede
   * distinguir "no hay agentes locales" de "no pude leerlos", que es justo la
   * distinción que esta HU existe para no perder. Se pasa igual en el
   * broaden-retry: es el MISMO fetch local, así que su estado es el mismo.
   */
  async runDiscoveryPipeline(
    query: DiscoveryQuery,
    registries: RegistryConfig[],
    localAgents: Agent[],
    skipUpstreamQuery: boolean,
    localSource: DiscoverySource | null = null,
  ): Promise<DiscoveryResult> {
    // Query all registries in parallel
    const outcomes = await Promise.all(
      registries.map((registry) =>
        this.queryRegistry(registry, query, skipUpstreamQuery)
          .then((outcome) => ({ registry, outcome }))
          .catch((err) => {
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
            // WKH-318: el fallo deja de ser MUDO. Antes se degradaba a `[]` y la
            // respuesta seguía afirmando que este registro contribuyó — el bug
            // de esta HU. Ahora viaja como `failed`/`rows:null` hasta el caller,
            // y además queda un warn estructurado grepeable.
            const failure = classifyFetchFailure(err);
            log.warn(
              {
                error_code: 'REGISTRY_SOURCE_FAILED',
                registry: registry.name,
                failure,
              },
              '[discovery.source-failed] a registry could not be queried; the catalog is partial',
            );
            // CD-4: la excepción se sigue degradando — un registro caído NO
            // tumba /discover. Lo que cambia es que ahora se DECLARA.
            const outcome: RegistryFetchOutcome = {
              agents: [],
              state: 'failed',
              rows: null,
              failure,
            };
            return { registry, outcome };
          }),
      ),
    );

    // Merge results — los locales entran ANTES del pipeline común
    // (status/verified/caps/price/rep/sort/limit) → mismo shape (CD-6).
    let allAgents = [
      ...outcomes.flatMap((o) => o.outcome.agents),
      ...localAgents,
    ];

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

    // ── HU-208: filtro de CANDIDATURA (alcance del llamador) ───────────────
    //
    // ⚠️ POR QUÉ VIVE ACÁ Y NO EN `/compose`. Está en el bloque PRE-SORT a
    // propósito. El `slice` del page size (más abajo) corre DESPUÉS del sort, así
    // que sobre una lista ya ordenada sólo puede sacar elementos de la COLA:
    // `sorted.slice(0, N)[0] === sorted[0]` para todo N >= 1. Mientras el filtro
    // corra ANTES del sort, el ganador del ranking es invariante al recorte y el
    // residual TD-189-1 (documentado abajo, en el `slice`) NO alcanza a la
    // resolución por capacidad. Si este filtro se moviera aguas ABAJO del
    // recorte —p.ej. filtrando en el resolver sobre la página ya cortada— un
    // candidato válido podría quedar fuera de la ventana y la precondición de ese
    // residual pasaría a estar encima del camino del dinero. NO MOVER.
    //
    // ⚠️ NO agregar acá un filtro por CHAIN (ni por ningún otro atributo que
    // sirva para señalar un agente concreto). Se evaluó y se RECHAZÓ: forzar el
    // rail es hacerle trampa al ranking. El orden verified → reputación → precio
    // se respeta SIEMPRE; si el agente que queremos no gana, el arreglo es del
    // lado de los datos (que se gane la reputación), no del lado del código.
    // `maxPrice` y `minReputation` sí son legítimos: son restricciones del que
    // pide, no una forma de elegir un agente concreto por la puerta de atrás.
    let excludedByScope = 0;

    if (query.scope) {
      // HU-208 (port de WAS-187 AC-7): un agente que la credencial del llamador
      // estructuralmente NO puede invocar no es un candidato. No es un fallback
      // silencioso: es definir bien el conjunto. Que "el mejor" sea relativo al
      // llamador es correcto — distintos llamadores tienen legítimamente
      // distintos candidatos.
      //
      // Se llama a `authzService.checkScoping`, la MISMA función que después hace
      // cumplir el alcance en `composeService.compose`. Con dos predicados
      // distintos el selector podría elegir un agente que el ejecutor rechaza, y
      // el llamador comería un 403 sobre un agente que nunca nombró.
      //
      // NO se le pasa `estimated_cost_usd`, así que el check de
      // `max_spend_per_call_usd` (rama 4 de checkScoping) queda fuera: ese límite
      // lo hace cumplir el middleware de pago y el llamador tiene
      // `constraints.max_price_usdc` para expresar su techo. Filtrar acá por él
      // sería una restricción que nadie pidió.
      const scope = query.scope;
      const before = allAgents.length;
      allAgents = allAgents.filter(
        (a) =>
          authzService.checkScoping(scope, {
            registry: a.registry,
            agent_slug: a.slug,
            category: readAgentCategory(a),
          }).allowed,
      );
      excludedByScope = before - allAgents.length;
    }

    // WKH-103 (DT-8/OBS-2): score batch pre-sort, 1 query (CD-12). Sin RPC
    // on-chain (CD-13). Corre sobre allAgents (pre-limit) para que la página
    // sea el top-N por reputación real.
    await this.attachReputations(allAgents);

    // ── Fix-pack P1 (hallazgo 2): `minReputation` filtra DE VERDAD ──────
    // Corre acá: después de `attachReputations` (necesita el score) y ANTES del
    // sort/limit, así que también alimenta `total` (matches reales) y la página
    // se llena con los que SÍ pasan el filtro.
    //
    // Filtra SÓLO `computedReputation.score` (off-chain, 0-100, derivado de
    // tasks efectivamente liquidadas con cap anti-sybil por caller) y NO usa el
    // fallback `?? a.reputation` que sí usa el `repValue` del sort de abajo.
    // Intencional: `agent.reputation` lo AUTO-REPORTA el registry en la card
    // (`mapAgent`, `Number(raw.reputation)`) en una escala indefinida — un filtro
    // de calidad cuyo valor lo controla la parte que se está filtrando no filtra
    // nada (basta declarar `reputation: 100`). Ordenar con un dato auto-reportado
    // es cosmético; FILTRAR con él es una falsa garantía. Por eso el filtro es
    // deliberadamente MÁS estricto que el sort, que queda intacto.
    //
    // FAIL-SAFE: sin score computado (0 tasks liquidadas, o batch degradado a
    // Map vacío) el agente cuenta 0 → queda EXCLUIDO si `minReputation > 0`. Un
    // agente sin historial no se cuela por un filtro de calidad.
    if (query.minReputation != null) {
      const min = query.minReputation;
      allAgents = allAgents.filter((a) => {
        const score = a.computedReputation?.score;
        return (Number.isFinite(score) ? (score as number) : 0) >= min;
      });
    }

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
    // HU-208: desempate ALEATORIO cuando los TRES criterios se agotan.
    //
    // Antes ganaba el orden del arreglo, que sale de cómo se concatenaron las
    // fuentes (`results.flat()` + self-published): un sesgo posicional invisible
    // por el cual, entre agentes idénticos en identidad, reputación y precio,
    // siempre ganaba el mismo — repartiendo ingresos por un accidente de
    // implementación. Dos agentes empatados merecen la misma chance.
    //
    // El valor se asigna UNA vez por agente ANTES de ordenar (nunca dentro del
    // comparador: un `cmp` no determinista deja el resultado del sort INDEFINIDO
    // por especificación). Así el orden sigue siendo total y estable dentro de la
    // request. Ver `lib/ranking-tiebreak.ts` — la fuente es inyectable para que
    // los tests no se vuelvan flakes.
    const tiebreaks = assignTiebreaks(allAgents);
    allAgents.sort((a, b) => {
      const verifiedDiff = Number(b.verified) - Number(a.verified);
      if (verifiedDiff !== 0) return verifiedDiff;
      const repDiff = repValue(b) - repValue(a);
      if (repDiff !== 0) return repDiff;
      const priceDiff = a.priceUsdc - b.priceUsdc;
      if (priceDiff !== 0) return priceDiff;
      return compareTiebreak(tiebreaks, a, b);
    });

    // Apply limit (PAGE SIZE — post-filtro, post-sort). Fix-pack P1: el fetch
    // upstream usa su propio over-fetch (`resolveUpstreamFetchLimit`), así que
    // acá hay candidatos de sobra para llenar la página.
    //
    // Lo que este `slice` NO garantiza (AR it3 BLQ-BAJO-1): que conserve todo lo
    // que el fetch trajo. Es GLOBAL sobre la concatenación de todas las fuentes
    // (:293) mientras el over-fetch es POR REGISTRY, así que si la unión supera la
    // ventana, el ranking decide qué queda dentro de la página y hay filas
    // fetcheadas que se descartan (afecta al pool por-slug de `/compose`, no a
    // `total`, que es pre-slice). Residual TD-189-1.
    const limited = query.limit ? allAgents.slice(0, query.limit) : allAgents;

    // WKH-100 (AC-8/DT-18): enrich batch post-limit with verified ERC-8004
    // identity. No RPC at serve-time — only the JSONB reverse-lookup (W2).
    const enriched = await this.attachIdentities(limited);

    // ── WKH-318: `registries` = las fuentes que APORTARON FILAS ────────────
    //
    // Antes era `registries.map(r => r.name)`: la lista de fuentes CONFIGURADAS.
    // Una fuente que devolvía 400 y se degradaba a `[]` aparecía igual — la
    // respuesta afirmaba haberla consultado. Medido en producción: `?limit=50`
    // devolvía 3 agentes (los 3 self-published) y `["WasiAI","self-published"]`.
    //
    // "Aportó filas" = filas DEVUELTAS POR EL FETCH, antes de los filtros
    // locales. Es, literalmente, la misma regla que las líneas de abajo ya
    // aplicaban SÓLO a los self-published: acá se generaliza, no se inventa una
    // segunda. Contarlo post-filtro haría que una query selectiva
    // (`?capabilities=remit.quote`, medida: 0 agentes) reportara fuentes
    // desaparecidas y el caller leyera degradación donde sólo hubo un filtro.
    const sources: DiscoverySource[] = outcomes.map(({ registry, outcome }) => {
      const source: DiscoverySource = {
        name: registry.name,
        state: outcome.state,
        rows: outcome.rows,
      };
      if (outcome.failure) source.failure = outcome.failure;
      if (outcome.truncationEvidence) {
        source.truncationEvidence = outcome.truncationEvidence;
      }
      return source;
    });
    // WKH-318 (AR BLQ-2): la fila local entra por HABERSE CONSULTADO, no por
    // haber traído filas. El gate viejo (`localAgents.length > 0`) escondía dos
    // casos distintos detrás del mismo silencio: el SELECT que falló y el que
    // devolvió cero. Ahora `null` significa una sola cosa — no se la consultó,
    // porque el caller filtró a otro registry.
    if (localSource) {
      sources.push(localSource);
    }

    const contributingRegistries = sources
      .filter((s) => (s.rows ?? 0) > 0)
      .map((s) => s.name);

    return {
      agents: enriched,
      // CONTRATO (fix-pack P1, hallazgo 1): `total` = matches TOTALES de los
      // filtros, PRE-`limit` → es el denominador de paginación, por lo que
      // `total >= agents.length` cuando hay `limit`. NO es el tamaño de la
      // página. Antes del fix este número venía de un pool ya truncado por el
      // registry upstream, así que SUBESTIMABA los matches (mentía en magnitud,
      // no en semántica).
      total: allAgents.length,
      registries: contributingRegistries,
      // WKH-318: el detalle POR FUENTE y su roll-up. Aditivos: no se quita ni se
      // re-tipa ningún campo previo.
      sources,
      catalogStatus: buildCatalogStatus(sources),
      // HU-208: cuántos candidatos descartó el filtro de candidatura. Sin esto
      // un conjunto vacío es indistinguible de "no existe tal capacidad", y un
      // operador buscaría el problema en el catálogo cuando en realidad hay un
      // agente que su credencial no alcanza. Es la contrapartida de filtrar:
      // nada se elige a escondidas y nada se descarta a escondidas.
      excluded: { scope: excludedByScope },
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
  ): Promise<RegistryFetchOutcome> {
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
    // Fix-pack P1 (hallazgo 1): se manda el OVER-FETCH, no el page size del
    // caller. El gate `query.limit &&` se preserva a propósito: sin `limit` del
    // caller seguimos sin mandar `limitParam` (comportamiento byte-idéntico al
    // de hoy) — imponer un cap donde antes no había ninguno sería reintroducir
    // el mismo bug de clase "esconder agentes" en el path sin `limit`.
    // WKH-318: el límite EFECTIVAMENTE enviado, para poder detectar `page_full`.
    // `undefined` ⇒ no se mandó ninguno (camino sin `limit` del caller, CD-5/CD-8).
    let sentLimit: number | undefined;
    if (query.limit && schema.limitParam) {
      sentLimit = resolveUpstreamFetchLimit(query.limit);
      url.searchParams.set(schema.limitParam, sentLimit.toString());
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

    // WKH-318: mismo `throw`, mismo mensaje, MISMO LUGAR (fuera de `cb.execute`).
    // Sólo gana un `name` para que el fanout pueda clasificarlo como
    // `http_error` sin parsear texto. La semántica del circuit breaker NO cambia
    // en esta HU (TD-318-1): un 400 sostenido sigue sin abrir nada.
    if (!response.ok) {
      throw new RegistryHttpError(registry.name, response.status);
    }

    const data = await response.json();

    // Extract agents array using path
    const agentsData = schema.agentsPath
      ? getNestedValue(data, schema.agentsPath)
      : data;

    // WKH-318 (CD-14): un payload que no es un array NO es "le pregunté y no
    // tiene". Es "respondió algo que no entiendo" ⇒ `failed` / `rows: null`.
    // Antes esto devolvía `[]` y era indistinguible de un catálogo vacío.
    if (!Array.isArray(agentsData)) {
      return {
        agents: [],
        state: 'failed',
        rows: null,
        failure: 'bad_payload',
      };
    }

    const agents = agentsData.map((raw) => this.mapAgent(registry, raw));

    // ── WKH-318 (DT-8 + AR BLQ-1): la completitud se PRUEBA, no se supone ──
    //
    // Que la fuente haya contestado NO dice si trajo todo. Hay que buscar
    // evidencia, y puede apuntar para cualquiera de los dos lados — o no existir.
    //
    // FUENTE 1 (EXACTA) — el registro declaró `nextCursorPath`:
    //   · cursor con valor      ⇒ hay más filas          → `truncated`/`cursor`
    //   · cursor vacío/nulo     ⇒ él mismo dice "no hay más" → completitud PROBADA
    //   · la clave NO viene     ⇒ no dijo nada           → sin evidencia
    //   Gana sobre la heurística: si el registro declara que no hay más, una
    //   página justo llena es coincidencia, no truncamiento.
    //
    // FUENTE 2 (HEURÍSTICA, sólo si no hubo declaración exacta) — se envió límite:
    //   · llegaron >= las pedidas ⇒ la página se llenó    → `truncated`/`page_full`
    //   · llegaron menos          ⇒ no se llenó, no quedó nada afuera → PROBADA
    //   Su único error posible es sobre-declarar truncamiento (catálogo justo del
    //   tamaño del cap), que es el lado SEGURO.
    //
    // SIN NINGUNA DE LAS DOS no hay evidencia OBTENIBLE, y el estado es
    // `unverified` — NO `ok`. Es el caso real de producción: el registro `wasiai`
    // se siembra sin `nextCursorPath` y `/capabilities` llama a `discover({})`
    // sin `limit`, así que tampoco se manda `limitParam`. Devolver `ok` ahí
    // publicaba `catalogStatus: 'complete'` sobre 20 de 22 agentes: cambiaba una
    // mentira por otra, que es textualmente lo que esta HU se comprometió a no
    // hacer.
    let truncationEvidence: 'cursor' | 'page_full' | undefined;
    let completenessProven = false;

    if (schema.nextCursorPath) {
      const cursor = getNestedValue(data, schema.nextCursorPath);
      if (cursor) {
        // Cualquier valor con contenido es un cursor. Los centinelas falsy
        // (`null`, `''`, `0`, `false`) son la forma habitual de decir "no hay
        // más" y NO se leen como truncamiento (AR MNR-G: con el `!== null`
        // anterior, un `0` o un `false` forzaban `truncated`).
        truncationEvidence = 'cursor';
      } else if (cursor !== undefined) {
        // AUSENTE no es NULO: un registro que dice "no hay más" manda la clave
        // en nulo; uno que no la manda no dijo nada, y suponerle completitud
        // sería inventarle una declaración que nunca hizo.
        completenessProven = true;
      }
    }

    if (!truncationEvidence && !completenessProven && sentLimit !== undefined) {
      if (agents.length >= sentLimit) {
        truncationEvidence = 'page_full';
      } else {
        completenessProven = true;
      }
    }

    if (truncationEvidence) {
      return {
        agents,
        state: 'truncated',
        rows: agents.length,
        truncationEvidence,
      };
    }
    return {
      agents,
      state: completenessProven ? 'ok' : 'unverified',
      rows: agents.length,
    };
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
      // WKH-241: mismo lector compartido que `agent.ts` (CD-1/AC-4).
      payment: readPaymentSpec(raw),
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

    // HIGH-1: ver `discover()` — el fetch outbound necesita `auth.value`. El
    // valor de retorno de `getAgent` es un `Agent`, nunca el RegistryConfig.
    const registries = registryId
      ? ([await registryService.getWithSecrets(registryId)].filter(
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
