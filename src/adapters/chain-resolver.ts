/**
 * Chain resolver utility (WKH-MULTICHAIN / 086).
 *
 * Pure module — does NOT import from `./registry`. Translates header values
 * and agent manifest values into the canonical `ChainKey` slug, applying the
 * priority defined in DT-1:
 *
 *   (1) explicit header `x-payment-chain`
 *   (2) agent manifest `payment.chain`
 *   (3) default (handled by the caller — this module returns `undefined`)
 *
 * Header value format (DT-E) accepts both slugs and numeric chainIds.
 *
 * CD-19: anti-prototype-pollution — uses `Object.hasOwn()` on a record with a
 * `null` prototype so callers can pass arbitrary input safely.
 */

import type { ChainKey } from './types.js';

const SLUG_ALIASES: Record<string, ChainKey> = Object.assign(
  Object.create(null) as Record<string, ChainKey>,
  {
    // avalanche-fuji aliases
    '43113': 'avalanche-fuji',
    'avalanche-fuji': 'avalanche-fuji',
    'avalanche-testnet': 'avalanche-fuji',
    avalanche: 'avalanche-fuji',
    fuji: 'avalanche-fuji',

    // avalanche-mainnet aliases
    '43114': 'avalanche-mainnet',
    'avalanche-mainnet': 'avalanche-mainnet',

    // kite-ozone-testnet aliases
    '2368': 'kite-ozone-testnet',
    'kite-ozone-testnet': 'kite-ozone-testnet',
    'kite-testnet': 'kite-ozone-testnet',

    // kite-mainnet aliases
    '2366': 'kite-mainnet',
    'kite-mainnet': 'kite-mainnet',

    // base-mainnet aliases (DT-7: 'base' alone → mainnet, convención comunidad)
    '8453': 'base-mainnet',
    'base-mainnet': 'base-mainnet',
    base: 'base-mainnet',

    // base-sepolia aliases
    '84532': 'base-sepolia',
    'base-sepolia': 'base-sepolia',
    'base-testnet': 'base-sepolia',

    // tempo-testnet aliases (WKH-090) — estáticos (el resolver es puro, NO lee
    // el flag; CD-7). Conocer el slug NO expone el rail con flag OFF: el bundle
    // no existe → getAdaptersBundle('tempo-testnet') = undefined → guard (2)
    // devuelve CHAIN_NOT_SUPPORTED.
    '42429': 'tempo-testnet', // V1 — chainId de Tempo testnet "Moderato"
    'tempo-testnet': 'tempo-testnet',
    tempo: 'tempo-testnet',

    // solana-devnet aliases (WKH-234) — estáticos (resolver puro, NO lee el
    // flag; CD-7/CD-8). Conocer el slug NO expone el rail con flag OFF: el
    // bundle no existe → getAdaptersBundle('solana-devnet') = undefined →
    // CHAIN_NOT_SUPPORTED. Devnet-only (CD-4): sin `solana-mainnet`.
    'solana-devnet': 'solana-devnet',
    solana: 'solana-devnet',
  } satisfies Record<string, ChainKey>,
);

/**
 * VM family of a `ChainKey` — derivada del MISMO mapa de slugs canónicos, sin
 * instanciar adapters (el `vmFamily` de los adapters sigue siendo la verdad en
 * settle-time; esto es su proyección PURA para decidir *antes* de resolver un
 * bundle).
 *
 * Fix-pack AR-profundo FIX 4: el sign x402 INBOUND (`compose.invokeAgent`) es
 * EVM-only (EIP-3009 + `0x` payTo). Necesita saber si la chain DECLARADA por el
 * agente es EVM ANTES de castear el payTo a `0x${string}` — el narrowing por
 * `vmFamily` del ADAPTER no cubre ese caso (cubre la familia del adapter default
 * del gateway, no la del payTo del agente).
 *
 * `Record<ChainKey, …>` exhaustivo: agregar una chain nueva a `ChainKey` sin
 * clasificarla acá NO compila (fail-loud en build, no en runtime con dinero).
 */
export type ChainVmFamily = 'evm' | 'solana';

const CHAIN_VM_FAMILY: Record<ChainKey, ChainVmFamily> = {
  'kite-ozone-testnet': 'evm',
  'kite-mainnet': 'evm',
  'avalanche-fuji': 'evm',
  'avalanche-mainnet': 'evm',
  'base-sepolia': 'evm',
  'base-mainnet': 'evm',
  'tempo-testnet': 'evm',
  'solana-devnet': 'solana',
};

export function getChainVmFamily(chainKey: ChainKey): ChainVmFamily {
  return CHAIN_VM_FAMILY[chainKey];
}

/**
 * Namespace (red lógica) de un `ChainKey`, independiente del entorno
 * testnet/mainnet.
 *
 * Fix-pack AR-profundo FIX 1(a): el colapso legacy de `payment-spec-reader`
 * comparaba STRINGS CRUDOS (`chainRaw === 'avalanche-mainnet'`), así que el
 * alias numérico `'43114'` no matcheaba y escapaba crudo hasta
 * `downstream-payment`, que lo re-normalizaba a `avalanche-mainnet` (destino
 * DISTINTO al de los alias literales, que colapsan a `'avalanche'` → Fuji).
 * Con el namespace derivado del `ChainKey` YA normalizado, todos los alias de
 * un namespace (literales y numéricos) tienen un único destino.
 *
 * `Record<ChainKey, …>` exhaustivo por el mismo motivo que `CHAIN_VM_FAMILY`.
 */
export type ChainNamespace = 'kite' | 'avalanche' | 'base' | 'tempo' | 'solana';

const CHAIN_NAMESPACE: Record<ChainKey, ChainNamespace> = {
  'kite-ozone-testnet': 'kite',
  'kite-mainnet': 'kite',
  'avalanche-fuji': 'avalanche',
  'avalanche-mainnet': 'avalanche',
  'base-sepolia': 'base',
  'base-mainnet': 'base',
  'tempo-testnet': 'tempo',
  'solana-devnet': 'solana',
};

export function getChainNamespace(chainKey: ChainKey): ChainNamespace {
  return CHAIN_NAMESPACE[chainKey];
}

/**
 * WKH-144: canonical mainnet detection. El string `ChainKey` ES la fuente de
 * verdad (DT-1): los tres (y sólo tres) slugs mainnet — `kite-mainnet` /
 * `avalanche-mainnet` / `base-mainnet` — terminan en `-mainnet`; ningún slug
 * testnet (`kite-ozone-testnet`, `avalanche-fuji`, `base-sepolia`,
 * `tempo-testnet`, `solana-devnet`) lo hace. Ver el invariante documentado en
 * `types.ts` sobre `ChainKey`.
 *
 * Vive acá (módulo PURO, sin viem / sin registry) desde el fix-pack
 * AR-profundo FIX 1(b): además del gate fail-CLOSED del settle re-verify
 * (`settle-verifier.ts`, que la re-exporta para no duplicar el clasificador),
 * ahora la consume el gate de opt-in mainnet del leg downstream
 * (`downstream-payment.ts`), que NO puede importar `settle-verifier` sin
 * arrastrar viem + los chain-factories.
 *
 * ⚠️ LÍMITE (fix-pack it2 BLQ-ALTO-1): esto clasifica lo que el slug DECLARA, NO
 * a dónde apunta el bundle realmente. El bundle de `kite-ozone-testnet` se
 * construye SIN `opts` (`registry.ts` → `createKiteOzoneAdapters()`) y
 * `getKiteChain()` lee `KITE_NETWORK` en CALL-TIME: con `KITE_NETWORK=mainnet`
 * ese bundle apunta a chainId 2366 (Kite MAINNET) mientras el slug sigue
 * diciendo "testnet". Para decidir sobre DINERO usá
 * `classifyDestinationEnvironment()` / `findChainEnvironmentDrift()` (abajo),
 * que miran el destino REAL.
 */
export function isMainnetChainKey(chainKey: ChainKey): boolean {
  return chainKey.endsWith('-mainnet');
}

/**
 * Entorno económico de una chain: `mainnet` = dinero real.
 *
 * Fix-pack AR-profundo it2 BLQ-ALTO-1 — el gate de opt-in del leg downstream
 * clasificaba por el STRING del slug (`isMainnetChainKey`), y eso se saltea:
 * `KITE_NETWORK=mainnet` (que los dos runbooks de activación instruían) hace que
 * el bundle del slug `kite-ozone-testnet` apunte a chainId 2366 con USDC.e de
 * Kite MAINNET. Un agent card con `payment.chain: 'kite-ozone-testnet'` (o
 * `2368` / `kite-testnet`) settleaba dinero real desde el operator wallet con el
 * gate vacío. Desde este fix la clasificación se hace sobre el DESTINO REAL del
 * leg (chainId del bundle / CAIP-2 del adapter Solana).
 */
export type ChainEnvironment = 'mainnet' | 'testnet';

/**
 * chainIds EVM que el gateway sabe clasificar. Unión de LITERALES a propósito:
 * `EVM_CHAIN_ENVIRONMENT` es exhaustivo sobre ella, así que agregar un chainId
 * nuevo obliga a clasificarlo (mainnet vs testnet) o NO COMPILA.
 */
export type KnownEvmChainId =
  | 2368 // KiteAI testnet (Ozone)
  | 2366 // KiteAI mainnet
  | 43113 // Avalanche Fuji
  | 43114 // Avalanche C-Chain
  | 84532 // Base Sepolia
  | 8453 // Base
  | 42429; // Tempo testnet (Moderato)

const EVM_CHAIN_ENVIRONMENT: Record<KnownEvmChainId, ChainEnvironment> = {
  2368: 'testnet',
  2366: 'mainnet',
  43113: 'testnet',
  43114: 'mainnet',
  84532: 'testnet',
  8453: 'mainnet',
  42429: 'testnet',
};

/**
 * chainId EVM canónico de cada `ChainKey` (o `'non-evm'` para los rails cuyo
 * `chainConfig.chainId` es un sentinel sintético — Solana, DT-8).
 *
 * Doble forzado en tiempo de compilación:
 *  1. `Record<ChainKey, …>` → agregar una chain nueva a `ChainKey` sin declarar
 *     su chainId acá no compila.
 *  2. el valor debe ser de `KnownEvmChainId` → declarar un chainId que nadie
 *     clasificó en `EVM_CHAIN_ENVIRONMENT` tampoco compila.
 *
 * Es el antídoto a "una lista suelta que alguien olvida actualizar": no existe
 * camino para agregar una chain y dejarla sin clasificar.
 */
const CANONICAL_CHAIN_ID: Record<ChainKey, KnownEvmChainId | 'non-evm'> = {
  'kite-ozone-testnet': 2368,
  'kite-mainnet': 2366,
  'avalanche-fuji': 43113,
  'avalanche-mainnet': 43114,
  'base-sepolia': 84532,
  'base-mainnet': 8453,
  'tempo-testnet': 42429,
  'solana-devnet': 'non-evm',
};

/**
 * chainId EVM que el bundle de `chainKey` DEBERÍA tener (`'non-evm'` para
 * Solana). Sirve para reportar el drift con el número esperado.
 */
export function getCanonicalChainId(
  chainKey: ChainKey,
): KnownEvmChainId | 'non-evm' {
  return CANONICAL_CHAIN_ID[chainKey];
}

/**
 * Clasifica un chainId EVM REAL. Un chainId DESCONOCIDO se clasifica como
 * `mainnet` (FAIL-CLOSED): si nadie lo clasificó, tratarlo como dinero real
 * exige opt-in explícito en vez de settlear a ciegas.
 */
export function classifyEvmChainId(chainId: number): ChainEnvironment {
  return Object.hasOwn(EVM_CHAIN_ENVIRONMENT, chainId)
    ? EVM_CHAIN_ENVIRONMENT[chainId as KnownEvmChainId]
    : 'mainnet';
}

/**
 * Referencia CAIP-2 de Solana MAINNET-BETA (genesis hash truncado a 32 chars).
 * El rail Solana es devnet-only (CD-4 de WKH-234): NO existe `solana-mainnet`,
 * así que el slug no puede declarar mainnet — la única forma de terminar en
 * dinero real es que `SOLANA_CAIP2_CHAIN_ID` / `SOLANA_RPC_URL` apunten a
 * mainnet-beta. Se clasifica por DENYLIST (no allowlist) a propósito: un
 * cluster devnet/localnet con un CAIP-2 exótico NO debe bloquearse por sorpresa.
 *
 * ⚠️ DEUDA EXPLÍCITA — `TD-SOLANA-CAIP2-DENYLIST` (`MULTI-CHAIN.md` §10). Esta
 * denylist es fail-OPEN: un CAIP-2 desconocido cae en `testnet`, o sea que el
 * gate de mainnet del leg lo deja pasar sin opt-in. Es aceptable HOY sólo por
 * tres condiciones simultáneas: (a) el valor no es agent-controlled (sale de
 * `SOLANA_CAIP2_CHAIN_ID`, env-only), (b) el rail Solana está flag-gated OFF y
 * (c) NO existe un ChainKey `solana-mainnet` (CD-4 de WKH-234), así que ningún
 * slug puede declarar mainnet.
 *
 * CONDICIÓN DE REACTIVACIÓN (pasa a ALLOWLIST fail-CLOSED, obligatorio): en
 * cuanto exista un ChainKey `solana-mainnet` **o** el rail Solana salga de flag
 * OFF. Ahí esta función empieza a decidir sobre dinero real y el cluster local
 * (`solana-test-validator`, genesis propio ⇒ CAIP-2 desconocido) pasa a ser una
 * excepción explícita por env, no el default.
 */
const SOLANA_MAINNET_CAIP2_REFERENCE = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

export function classifySolanaCaip2(caip2ChainId: string): ChainEnvironment {
  const ref = caip2ChainId.trim().replace(/^solana:/i, '');
  if (ref.startsWith(SOLANA_MAINNET_CAIP2_REFERENCE)) return 'mainnet';
  return ref.toLowerCase().includes('mainnet') ? 'mainnet' : 'testnet';
}

/**
 * Destino REAL de un leg, con el id AUTORITATIVO de cada familia:
 *  - EVM    → `chainId` (el de `bundle.chainConfig`, el mismo que firma/settlea).
 *  - Solana → `caip2ChainId` del adapter (el `chainConfig.chainId` de Solana es
 *             un sentinel sintético env-driven, NO autoritativo — DT-8).
 * Unión discriminada: es imposible pasar el id de la familia equivocada.
 */
export type LegDestination =
  | { vmFamily: 'evm'; chainId: number }
  | { vmFamily: 'solana'; caip2ChainId: string };

/**
 * Entorno del DESTINO REAL del leg (no del slug). Es la función que deben usar
 * todos los gates que deciden sobre dinero.
 */
export function classifyDestinationEnvironment(
  destination: LegDestination,
): ChainEnvironment {
  return destination.vmFamily === 'evm'
    ? classifyEvmChainId(destination.chainId)
    : classifySolanaCaip2(destination.caip2ChainId);
}

/**
 * ¿El destino REAL del bundle contradice el mainnet-ness que DECLARA su slug?
 *
 * Un slug que dice `-testnet` apuntando a un chainId mainnet (o al revés) es una
 * configuración INCOHERENTE: `registry.initAdapters` rompe al arrancar y el gate
 * del leg downstream la bloquea sin opt-in posible (el opt-in se expresa por
 * slug, y un slug que miente no puede ser la llave de nada).
 */
export function findChainEnvironmentDrift(input: {
  chainKey: ChainKey;
  destination: LegDestination;
}): { declared: ChainEnvironment; actual: ChainEnvironment } | undefined {
  const declared: ChainEnvironment = isMainnetChainKey(input.chainKey)
    ? 'mainnet'
    : 'testnet';
  const actual = classifyDestinationEnvironment(input.destination);
  return declared === actual ? undefined : { declared, actual };
}

/**
 * Normalizes a raw header / manifest value into a `ChainKey`.
 *
 * Returns `undefined` for any unknown input. Total — never throws, never
 * returns the default silently (callers MUST decide what to do on undefined).
 */
export function normalizeChainSlug(raw: string): ChainKey | undefined {
  if (typeof raw !== 'string') return undefined;
  const key = raw.trim().toLowerCase();
  if (key.length === 0) return undefined;
  return Object.hasOwn(SLUG_ALIASES, key) ? SLUG_ALIASES[key] : undefined;
}

/**
 * Resolves the priority chain (header > manifest > undefined). Caller is
 * responsible for falling back to the registry default when the result is
 * `undefined` AND the header was absent — see CD-14.
 *
 * If `headerOverride` is present but unrecognized, the function returns
 * `undefined` (caller MUST treat as 400 CHAIN_NOT_SUPPORTED — do NOT silently
 * fall through to the manifest or default).
 */
export function resolveChainKey(input: {
  headerOverride?: string | undefined;
  agentManifestChain?: string | undefined;
}): ChainKey | undefined {
  if (typeof input.headerOverride === 'string') {
    return normalizeChainSlug(input.headerOverride);
  }
  if (typeof input.agentManifestChain === 'string') {
    return normalizeChainSlug(input.agentManifestChain);
  }
  return undefined;
}
