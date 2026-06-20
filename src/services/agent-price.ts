/**
 * Agent Price Resolver — WKH-59 (real-price-debit)
 *
 * Resuelve `agent.priceUsdc` desde el registry con cache in-process TTL 60s.
 * Usado por `src/routes/compose.ts` preHandler antes del middleware de debit.
 *
 * CD-8: única ubicación de esta función. NO duplicar.
 * CD-1: TypeScript strict, sin `any`.
 * DT-B: cache Map (no Redis, no existe client en el proyecto).
 * DT-G: cache negativo NO se persiste (null → no cachear; re-fetch en próximo miss).
 */
import { discoveryService } from './discovery.js';

type CacheEntry = { price: number; expiresAt: number };

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

function cacheKey(slug: string, registryName?: string): string {
  // DT-B: scoping por registry para evitar colisiones entre registries
  // con el mismo slug.
  return `${slug}::${registryName ?? '_all_'}`;
}

/**
 * Resuelve el precio USDC del agente.
 *
 * - Cache hit (TTL no expirado): retorna el precio cacheado.
 * - Cache miss / TTL expirado: llama `discoveryService.getAgent`,
 *   cachea con nuevo TTL si el agente existe, retorna el precio.
 * - Agente no existe (getAgent retorna null): retorna null SIN cachear
 *   (DT-G: no negative caching).
 * - DB error / discovery throws: propaga el error. El caller (preHandler
 *   de /compose) lo mapea a 503 REGISTRY_UNAVAILABLE.
 *
 * @param agentSlug - el slug del agente (e.g. 'kyc', 'corridor')
 * @param registryName - opcional, si no se da busca en todos los registries
 * @returns el precio en USD o null si el agente no existe
 */
export async function resolveAgentPriceUsdc(
  agentSlug: string,
  registryName?: string,
): Promise<number | null> {
  const key = cacheKey(agentSlug, registryName);
  const now = Date.now();
  const entry = cache.get(key);

  if (entry && entry.expiresAt > now) {
    return entry.price; // cache hit (AC-8: < 5ms)
  }

  // Cache miss o TTL expirado → re-fetch (AC-9)
  const agent = await discoveryService.getAgent(agentSlug, registryName);
  if (!agent) {
    // DT-G: no cachear negativos. Si el agente se registra después,
    // el próximo lookup lo encuentra sin esperar el TTL.
    return null;
  }

  const price = agent.priceUsdc;
  cache.set(key, { price, expiresAt: now + CACHE_TTL_MS });
  return price;
}

/**
 * WKH-125 BLQ-ALTO-1 (fix-pack): resuelve el destino canónico
 * `"<registry>/<slug>"` del agente del step-0 a partir del AGENTE RESUELTO por
 * discovery — NO de los campos crudos del body (`firstStep.agent` /
 * `firstStep.registry`, con `registry` opcional). Espeja la resolución que usa
 * el per-step (`compose.resolveAgent` → `discoveryService.getAgent(slug, registry)`
 * con fallback `getAgent(slug)`), de modo que step-0 y per-step produzcan el
 * MISMO string canónico (`agent.registry`/`agent.slug` de discovery) para el
 * mismo agente. Sin esto, un caller que omite `registry` deriva un destino que
 * no matchea la policy → el cap NUNCA se evalúa (cap bypass en la ruta de dinero).
 *
 * - Agente no existe (getAgent retorna null en ambos intentos): retorna null
 *   (el caller NO augmenta `composeDestination` → step-0 sigue 3-arg, back-compat).
 * - Discovery throws: propaga el error (el preHandler ya lo mapea a 503; este
 *   resolver se llama dentro del mismo try del preHandler).
 *
 * @returns `{ registry, slug }` canónicos del agente resuelto, o null.
 */
export async function resolveAgentDestination(
  agentSlug: string,
  registryName?: string,
): Promise<{ registry: string; slug: string } | null> {
  // Mismo orden de resolución que compose.resolveAgent (registry hint primero,
  // luego sin registry para tolerar case/registry omitido por el caller).
  let agent = await discoveryService.getAgent(agentSlug, registryName);
  if (!agent) agent = await discoveryService.getAgent(agentSlug);
  if (!agent) return null;
  return { registry: agent.registry, slug: agent.slug };
}

/**
 * TEST-ONLY: limpia el cache. NO importar en production code.
 * CD-13: patrón análogo a `_resetFallbackWarnDedup` en `discovery.ts:26`.
 */
export function _resetAgentPriceCache(): void {
  cache.clear();
}
