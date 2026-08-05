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
 * Valor de salida de `payment.chain` para el namespace avalanche.
 *
 * Fix-pack AR-profundo FIX 1(a) — la decisión se toma sobre el `ChainKey`
 * NORMALIZADO, no sobre el string crudo. El viejo
 * `chainRaw === 'avalanche-testnet' || chainRaw === 'avalanche-mainnet'` dejaba
 * escapar los alias NUMÉRICOS del namespace: `'43114'` no matcheaba, pasaba
 * crudo, y `downstream-payment.ts` lo re-normalizaba a `avalanche-mainnet`
 * mientras el literal `'avalanche-mainnet'` terminaba en Fuji. Dos destinos
 * distintos para la misma red declarada.
 *
 * Fix-pack it2 BLQ-MED-1 — ⚠️ CAMBIO INTENCIONAL DE API OBSERVABLE. La iteración
 * anterior colapsaba TODO alias mainnet a `'avalanche'` (destino Fuji). Eso
 * volvía INEJERCITABLE el opt-in `WASIAI_DOWNSTREAM_MAINNET_ALLOW=avalanche-mainnet`
 * que instruyen `README.md`, `.env.example`, `docs/networks.md` y los dos
 * runbooks: como `readPaymentSpec` es el ÚNICO productor de `Agent.payment`
 * (`discovery.mapAgent` + `agent.mapRowToAgent`), NINGÚN valor declarable por un
 * agente podía producir `chainKey='avalanche-mainnet'` en el leg. Se eliminaba un
 * control muerto y se introducía otro.
 *
 * Regla (el GATE del leg downstream es el ÚNICO choke-point que decide si
 * se puede pagar en mainnet):
 *  (1) alias MAINNET del namespace (`avalanche-mainnet`, `43114`) → sale su
 *      ChainKey real `'avalanche-mainnet'`. Un agente que declare mainnet se ve
 *      como mainnet (más honesto que mostrar `'avalanche'`) y el gate
 *      fail-CLOSED lo bloquea sin opt-in explícito.
 *  (2) todo alias TESTNET del namespace (`'avalanche'`, `'avalanche-fuji'`,
 *      `'fuji'`, `'43113'`, `'avalanche-testnet'`) es pass-through: TODOS
 *      normalizan al MISMO `ChainKey` (`avalanche-fuji`), así que NO existe
 *      divergencia de destino posible.
 *
 * ⛔ EL COLAPSO LEGACY CD-2 SE ELIMINÓ (TD-CHAIN-ALIAS-AMBIGUO). Hasta acá, el
 * literal `'avalanche-testnet'` se reescribía a `'avalanche'`. Por qué se sacó,
 * y por qué sacarlo NO rompe lo que el colapso protegía:
 *   · SU MOTIVO ORIGINAL YA NO EXISTE. Nació para alimentar el guard de WKH-55,
 *     que comparaba `chain === 'avalanche'` como LITERAL. Ese guard se reemplazó
 *     por la validación dinámica vía `normalizeChainSlug` (ver el bloque
 *     SEC-AR-2026-04-28 abajo): hoy NINGUNA comparación literal contra
 *     `'avalanche'` sobrevive en `src/`.
 *   · NO PUEDE CAMBIAR EL DESTINO DEL DINERO. `'avalanche-testnet'` y
 *     `'avalanche'` normalizan al mismo ChainKey `avalanche-fuji`
 *     (`chain-resolver.ts`), así que el leg settlea exactamente donde settleaba.
 *   · ERA ASIMÉTRICO. Sus hermanos explícitos (`'avalanche-fuji'`, `'fuji'`,
 *     `'43113'`) ya salían tal cual; `'avalanche-testnet'` era el ÚNICO slug
 *     explícito que se degradaba.
 *   · EL DAÑO REAL ERA RÍO ABAJO. `isAmbiguousChainAlias` (el clasificador que
 *     estrena la postura C) corre DESPUÉS de este reader, sobre el string ya
 *     colapsado (`downstream-payment.ts`), así que un agente que declaraba bien
 *     su entorno se contaba como ambiguo. Eso (a) sobre-cuenta la telemetría y
 *     (b) bloqueaba la SEGUNDA MITAD del plan: rechazar los alias ambiguos
 *     habría rechazado justo a los que hicieron lo correcto.
 *   · IMPACTO MEDIDO AL SACARLO: CERO. Sobre los 25 agentes del catálogo vivo
 *     (`/discover?limit=100`, 2026-08-05) NINGUNO declara `'avalanche-testnet'`
 *     — son 16 `avalanche` + 6 `avalanche-fuji` + 3 `solana-devnet`. O sea que
 *     el colapso no protegía a nadie: sólo impedía migrar hacia el slug correcto.
 *
 * Consumidores externos afectados (wasiai-v2 / Chaski / remit-*): un agente que
 * declare `avalanche-mainnet`, `43114` o `avalanche-testnet` deja de verse como
 * `'avalanche'` en `/discover`. Es el string que el agente declaró, y el bloqueo
 * del dinero pasó al gate.
 */
function resolveAvalancheOutputChain(
  chainKey: ChainKey,
  chainRaw: string,
): string {
  if (getChainNamespace(chainKey) !== 'avalanche') return chainRaw;
  return isMainnetChainKey(chainKey) ? chainKey : chainRaw; // (1) / (2)
}

/**
 * Type guard para `agent.payment` (WKH-55).
 * Schema drift fallback for wasiai-v2 marketplace shape:
 *   - v2 expone `obj.protocol` (e.g. "x402"), pero el WKH-55 código espera `obj.method`.
 *   - v2 expone `chain` top-level (e.g. "avalanche-testnet"), pero WKH-55 lo busca en payment.
 *   - el guard de WKH-55 comparaba `chain === "avalanche"` como LITERAL, y por eso
 *     este lector colapsaba `avalanche-testnet` → `avalanche`. Ese guard ya no
 *     existe (lo reemplazó la validación dinámica de acá abajo) y el colapso se
 *     eliminó con él (TD-CHAIN-ALIAS-AMBIGUO, ver `resolveAvalancheOutputChain`).
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
 * aceptar/rechazar. El valor de `chain` de SALIDA es pass-through del string
 * declarado, con UNA sola excepción (ver `resolveAvalancheOutputChain`): los
 * alias MAINNET del namespace avalanche salen como su ChainKey
 * `'avalanche-mainnet'` (it2 BLQ-MED-1).
 *
 * Fix-pack it2 BLQ-MED-1: este módulo NO decide más si un pago mainnet es
 * permisible — sólo reporta con fidelidad lo que el agente declaró. El ÚNICO
 * choke-point que decide es el gate fail-CLOSED del leg downstream
 * (`downstream-payment.ts`, `WASIAI_DOWNSTREAM_MAINNET_ALLOW` + clasificación
 * por el DESTINO REAL). Colapsar los alias mainnet a `'avalanche'` (iteración
 * anterior) volvía inejercitable ese opt-in para avalanche: como este lector es
 * el ÚNICO productor de `Agent.payment` (`discovery.mapAgent` +
 * `agent.mapRowToAgent`), ningún valor declarable podía producir
 * `chainKey='avalanche-mainnet'` en el leg.
 *
 * La chain del leg downstream sigue siendo agent-controlled por diseño (el
 * agente declara dónde le pagan); habilitar un settle a una chain MAINNET exige
 * el opt-in explícito por env del gate.
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

  // Salida: pass-through del string declarado. La ÚNICA reescritura es que un
  // alias MAINNET de avalanche sale como su ChainKey real, decidido sobre el
  // `ChainKey` NORMALIZADO (fix-pack AR-profundo FIX 1a + it2 BLQ-MED-1 — ver
  // `resolveAvalancheOutputChain`). Kite/Base/Tempo/Solana pass through unchanged
  // so consumers can distinguish kite-ozone-testnet de kite-mainnet (different
  // stablecoins) — cada uno de esos alias ya tiene un destino único.
  const chain = resolveAvalancheOutputChain(chainKey, chainRaw);

  return {
    method: methodRaw,
    chain,
    contract: obj.contract,
    asset: typeof obj.asset === 'string' ? obj.asset : undefined,
  };
}
