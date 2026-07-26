/**
 * Payment Spec Reader — WKH-241 · lector compartido de `payment` declarado.
 *
 * Módulo LEAF: importa SOLO `normalizeChainSlug` (`../adapters/chain-resolver.js`,
 * resolver puro) + el tipo `AgentPaymentSpec` (import type, borrado en runtime).
 * CERO imports de servicios — `discovery.ts` ya importa `publishedAgentService`
 * de `agent.ts` (`discovery.ts:23`), así que exportar el lector desde
 * `discovery.ts` habría creado un ciclo de módulos (WKH-241 DT-1). Mismo patrón
 * leaf que `wallet-format.ts` / `chain-resolver.ts` / `price.ts`.
 *
 * Es el ÚNICO choke-point que derive `Agent.payment` (WKH-241 CD-1/AC-4):
 * lo consumen el mapper de registries EXTERNOS (`discovery.ts` `mapAgent`) y el
 * mapper de agentes SELF-PUBLISHED (`agent.ts` `mapRowToAgent`). Prohibido un
 * segundo validador paralelo de chain/formato.
 *
 * La función se movió TAL CUAL desde `discovery.ts` (`readPayment`, líneas 71-119
 * pre-WKH-241) — mismo comportamiento, mismos guards, misma normalización.
 */

import {
  getChainNamespace,
  isMainnetChainKey,
  normalizeChainSlug,
} from '../adapters/chain-resolver.js';
import type { ChainKey } from '../adapters/types.js';
import type { AgentPaymentSpec } from '../types/index.js';

/**
 * Fix-pack AR-profundo FIX 1(a) — ¿este alias colapsa al slug legacy
 * `'avalanche'`?
 *
 * La decisión se toma sobre el `ChainKey` NORMALIZADO, no sobre el string crudo.
 * El viejo `chainRaw === 'avalanche-testnet' || chainRaw === 'avalanche-mainnet'`
 * dejaba escapar los alias NUMÉRICOS del namespace: `'43114'` no matcheaba,
 * pasaba crudo, y `downstream-payment.ts` lo re-normalizaba a
 * `avalanche-mainnet` (DINERO REAL) mientras el literal `'avalanche-mainnet'`
 * terminaba en Fuji. Dos destinos distintos para la misma red declarada.
 *
 * Regla:
 *  (1) TODO alias que resuelva a la MAINNET del namespace avalanche (literal
 *      `avalanche-mainnet` o numérico `43114`) colapsa a `'avalanche'`, cuyo
 *      destino es Fuji. Cierra el bypass.
 *  (2) El literal legacy `'avalanche-testnet'` sigue colapsando (byte-identidad
 *      CD-2). El resto de los alias testnet (`'avalanche'`, `'avalanche-fuji'`,
 *      `'fuji'`, `'43113'`) sigue pass-through: TODOS normalizan al MISMO
 *      `ChainKey` (`avalanche-fuji`) que `'avalanche'`, así que NO existe
 *      divergencia de destino posible — y el string crudo se sigue exponiendo
 *      tal cual en `/discover` (cambiarlo sería un cambio de API observable para
 *      los consumidores externos, fuera del objetivo del fix).
 */
function collapsesToLegacyAvalanche(
  chainKey: ChainKey,
  chainRaw: string,
): boolean {
  if (getChainNamespace(chainKey) !== 'avalanche') return false;
  if (isMainnetChainKey(chainKey)) return true; // (1)
  return chainRaw === 'avalanche-testnet'; // (2)
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
 * adapter conocido (avalanche-*, kite-*, base-*, solana-devnet, incl. chainIds
 * numéricos); rechaza slugs desconocidos (polygon/solana-mainnet → registry
 * comprometido / chain exótica → undefined, defensa preservada).
 *
 * ⚠️ Salida (CD-7): la validación usa `normalizeChainSlug` SOLO para decidir
 * aceptar/rechazar. El valor de `chain` de SALIDA conserva el string legacy:
 * todo el namespace `avalanche` → `'avalanche'`; resto pass-through. NO se
 * devuelve el `ChainKey` del resolver (devolvería `'avalanche-fuji'` para
 * `'avalanche'`, rompiendo CD-2 y los tests existentes).
 *
 * Fix-pack AR-profundo FIX 1(a): el colapso ahora es NAMESPACE-AWARE sobre el
 * `ChainKey` ya normalizado (`getChainNamespace`), NO sobre el string crudo. El
 * viejo `chainRaw === 'avalanche-mainnet' || chainRaw === 'avalanche-testnet'`
 * dejaba escapar los alias NUMÉRICOS del mismo namespace (`'43114'`, `'43113'`)
 * y el alias `'fuji'`: pasaban crudos y `downstream-payment.ts` los
 * re-normalizaba a un destino DISTINTO del de los alias literales — `'43114'`
 * terminaba en `avalanche-mainnet` (dinero real) mientras
 * `'avalanche-mainnet'` terminaba en Fuji. Ahora TODOS los alias del namespace
 * comparten un único destino.
 *
 * La chain del leg downstream sigue siendo agent-controlled por diseño (el
 * agente declara dónde le pagan); el opt-in explícito por env que habilita un
 * settle a una chain MAINNET vive en `downstream-payment.ts`
 * (`WASIAI_DOWNSTREAM_MAINNET_ALLOW`, fail-closed).
 *
 * Retorna undefined si los campos críticos siguen ausentes O la chain no la
 * conoce el resolver.
 *
 * WKH-241 (DT-3): NO valida el FORMATO de `contract` (pass-through, CD-4). El
 * guard de forma vive en settle-time (`validatePayTo` /
 * `isValidSolanaAddress`, `downstream-payment.ts`), que rechaza un payTo
 * malformado con skip-code SIN mover fondos — duplicarlo acá no agrega
 * seguridad y rompería la byte-identidad del mapper de registries externos.
 *
 * @param raw objeto que CONTIENE la key `payment` (el agent card raw de un
 *   registry externo, o el `metadata` JSONB de un agente self-published).
 *   El fallback de `chain` top-level se lee de `raw.chain`.
 */
export function readPaymentSpec(
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
  const chainKey = normalizeChainSlug(chainRaw);
  if (chainKey === undefined) {
    return undefined;
  }

  // Normalize chain: collapse legacy → 'avalanche' (downstream guard expects
  // canonical), decidido sobre el `ChainKey` NORMALIZADO (fix-pack AR-profundo
  // FIX 1a — ver `collapsesToLegacyAvalanche`). Kite/Base pass through unchanged
  // so consumers can distinguish kite-ozone-testnet de kite-mainnet (different
  // stablecoins) — cada uno de esos alias ya tiene un destino único.
  const chain = collapsesToLegacyAvalanche(chainKey, chainRaw)
    ? 'avalanche'
    : chainRaw;

  return {
    method: methodRaw,
    chain,
    contract: obj.contract,
    asset: typeof obj.asset === 'string' ? obj.asset : undefined,
  };
}
