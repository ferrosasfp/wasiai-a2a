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
 * TEST-ONLY: limpia el cache. NO importar en production code.
 * CD-13: patrón análogo a `_resetFallbackWarnDedup` en `discovery.ts:26`.
 */
export function _resetAgentPriceCache(): void {
  cache.clear();
}
