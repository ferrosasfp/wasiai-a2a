import { getLogger } from '../lib/logger.js';
import {
  classifyEvmChainId,
  findChainEnvironmentDrift,
  getCanonicalChainId,
  type LegDestination,
} from './chain-resolver.js';
import type {
  AdaptersBundle,
  AttestationAdapter,
  ChainKey,
  EvmPaymentAdapter,
  GaslessAdapter,
  IdentityBindingAdapter,
  PaymentAdapter,
} from './types.js';

const log = getLogger('registry');

/**
 * Multi-chain registry (WKH-MULTICHAIN / 086).
 *
 * Replaces the previous single-chain singleton with a `Map<ChainKey, AdaptersBundle>`.
 * Backward-compat 100%: when only `WASIAI_A2A_CHAIN=kite-ozone-testnet` is set,
 * the behaviour is byte-identical to the pre-WKH-MULTICHAIN code path (CD-2).
 *
 * - Singular env var `WASIAI_A2A_CHAIN` is still honoured (legacy).
 * - New env var `WASIAI_A2A_CHAINS` accepts a comma-separated list of slugs.
 * - When both are present, `WASIAI_A2A_CHAINS` wins and a WARNING is logged (CD-13).
 *
 * Wave 0 wires `kite-ozone-testnet` only; the avalanche-* and kite-mainnet
 * factory branches are added in later waves.
 */

const SUPPORTED_CHAINS = [
  'kite-ozone-testnet',
  'kite-mainnet',
  'avalanche-fuji',
  'avalanche-mainnet',
  'base-sepolia',
  'base-mainnet',
] as const satisfies readonly ChainKey[];

const _bundles = new Map<ChainKey, AdaptersBundle>();
let _defaultChainKey: ChainKey | null = null;
let _initialized = false;

/**
 * WKH-090 — feature-flag del cuarto rail (Tempo/MPP), default OFF (CD-1).
 * Convención `=== 'true'` (mirror `GASLESS_ENABLED`). CD-7: este es el ÚNICO
 * choke-point del gate — el resolver y el adapter NO leen esta env var.
 */
function isTempoEnabled(): boolean {
  return process.env.TEMPO_ADAPTER_ENABLED === 'true';
}

/**
 * WKH-234 — feature-flag del rail Solana, default OFF (CD-8). Convención
 * `=== 'true'` (mirror `isTempoEnabled`). Único choke-point del gate: el resolver
 * y el adapter NO leen esta env var.
 */
function isSolanaEnabled(): boolean {
  return process.env.SOLANA_ADAPTER_ENABLED === 'true';
}

/**
 * Set de chains soportadas flag-aware. Con `SOLANA_ADAPTER_ENABLED != 'true'`
 * NO agrega `solana-devnet` → byte-idéntico (CD-8). Idéntica defensa para Tempo.
 */
function getSupportedChains(): readonly ChainKey[] {
  const withTempo: readonly ChainKey[] = isTempoEnabled()
    ? [...SUPPORTED_CHAINS, 'tempo-testnet']
    : SUPPORTED_CHAINS;
  return isSolanaEnabled() ? [...withTempo, 'solana-devnet'] : withTempo;
}

function isSupportedChain(slug: string): slug is ChainKey {
  return (getSupportedChains() as readonly string[]).includes(slug);
}

async function buildBundle(chainKey: ChainKey): Promise<AdaptersBundle> {
  if (chainKey === 'kite-ozone-testnet') {
    const { createKiteOzoneAdapters } = await import('./kite-ozone/index.js');
    const adapters = await createKiteOzoneAdapters();
    return {
      payment: adapters.payment,
      attestation: adapters.attestation,
      gasless: adapters.gasless,
      identity: adapters.identity,
      chainConfig: adapters.chainConfig,
    };
  }
  if (chainKey === 'kite-mainnet') {
    // W5 wiring — `createKiteOzoneAdapters({ network: 'mainnet' })` activates
    // the Kite mainnet path via DT-I (temporary `process.env.KITE_NETWORK`
    // mutation inside the factory, restored in `finally`). See TD-NEW-KITE-PARAMS.
    const { createKiteOzoneAdapters } = await import('./kite-ozone/index.js');
    const adapters = await createKiteOzoneAdapters({ network: 'mainnet' });
    return {
      payment: adapters.payment,
      attestation: adapters.attestation,
      gasless: adapters.gasless,
      identity: adapters.identity,
      chainConfig: adapters.chainConfig,
    };
  }
  if (chainKey === 'avalanche-fuji') {
    const { createAvalancheAdapters } = await import('./avalanche/index.js');
    return createAvalancheAdapters({ network: 'fuji' });
  }
  if (chainKey === 'avalanche-mainnet') {
    const { createAvalancheAdapters } = await import('./avalanche/index.js');
    return createAvalancheAdapters({ network: 'mainnet' });
  }
  if (chainKey === 'base-sepolia') {
    const { createBaseAdapters } = await import('./base/index.js');
    return createBaseAdapters({ network: 'testnet' });
  }
  if (chainKey === 'base-mainnet') {
    const { createBaseAdapters } = await import('./base/index.js');
    return createBaseAdapters({ network: 'mainnet' });
  }
  if (chainKey === 'tempo-testnet') {
    // WKH-090 — cuarto rail (testnet-only, flag-gated en getSupportedChains()).
    const { createTempoAdapters } = await import('./tempo/index.js');
    return createTempoAdapters({ network: 'testnet' });
  }
  if (chainKey === 'solana-devnet') {
    // WKH-234 — rail Solana (devnet-only, flag-gated en getSupportedChains()).
    // Con flag OFF el slug nunca pasa el fail-fast de initAdapters → el bundle
    // no se construye → CHAIN_NOT_SUPPORTED (defensa idéntica a Tempo).
    const { createSolanaAdapters } = await import('./solana/index.js');
    return createSolanaAdapters({ network: 'devnet' });
  }
  throw new Error(
    `Unsupported chain '${chainKey}'. Supported: ${getSupportedChains().join(', ')}`,
  );
}

/**
 * Remediación HONESTA para activar Kite mainnet (fix-pack it2 MNR-3).
 *
 * Verificado con probe de factories REALES (2026-07-26), no con el mock:
 *  - `WASIAI_A2A_CHAINS=kite-mainnet` + `KITE_NETWORK=mainnet` → coherente
 *    (`chainConfig.chainId` 2366 Y `adapter.chainId` 2366, token USDC.e).
 *  - `WASIAI_A2A_CHAINS=kite-mainnet` SIN `KITE_NETWORK` → `chainConfig` dice
 *    2366 pero el ADAPTER reporta 2368 y `getToken()` devuelve el PYUSD de
 *    TESTNET: el `finally` de `createKiteOzoneAdapters` ya restauró la env y
 *    `getKiteChain()` la lee en CALL-TIME (TD-NEW-KITE-PARAMS). El hint anterior
 *    ("agregá el slug 'kite-mainnet' en vez de setear KITE_NETWORK") producía
 *    exactamente ese bundle roto.
 *  - los DOS slugs Kite en el mismo proceso NO tienen configuración coherente
 *    posible (con `KITE_NETWORK=mainnet` el slug testnet apunta a 2366 y el
 *    arranque LANZA; sin ella el bundle `kite-mainnet` queda con adapter
 *    testnet). Es el límite que TD-NEW-KITE-PARAMS levanta.
 *
 * `WASIAI_A2A_CHAINS` (`registry.ts`), `KITE_NETWORK` (`kite-ozone/chain.ts`) y
 * `KITE_MAINNET_RPC_URL` (`kite-ozone/payment.ts`, `deposit-verifier.ts`,
 * `gas-overhead.ts`) son envs REALES: las lee `src/`. La retirada
 * `WASIAI_DOWNSTREAM_NETWORK` no la lee nadie y NO se menciona acá.
 */
const KITE_MAINNET_REMEDIATION =
  `To run Kite mainnet set BOTH 'WASIAI_A2A_CHAINS=kite-mainnet' (with NO Kite ` +
  `*testnet* slug in the CSV) AND 'KITE_NETWORK=mainnet': the Kite adapter reads ` +
  `KITE_NETWORK at CALL-TIME (TD-NEW-KITE-PARAMS), so the slug alone only fixes ` +
  `chainConfig and leaves the adapter on testnet PYUSD. Running kite-ozone-testnet ` +
  `and kite-mainnet in the SAME process is not supported.`;

/**
 * Fix-pack AR-profundo it2 BLQ-ALTO-1 — defensa en profundidad: FAIL-LOUD al
 * arrancar si el destino REAL de un bundle contradice el mainnet-ness que su
 * ChainKey DECLARA.
 *
 * El caso real: `KITE_NETWORK=mainnet` (lo instruían los runbooks de activación)
 * + `kite-ozone-testnet` en el CSV. El bundle de ese slug se construye SIN
 * `opts` (`createKiteOzoneAdapters()`) y `getKiteChain()` lee `KITE_NETWORK` en
 * call-time ⇒ un slug que dice "testnet" apuntando a chainId 2366 (Kite MAINNET,
 * USDC.e). Esa incoherencia rompía DOS gates de dinero a la vez: el opt-in
 * mainnet del leg downstream (clasificaba por slug) y el fail-CLOSED del settle
 * re-verify de WKH-144 (mismo clasificador ⇒ fail-OPEN sobre un settle mainnet
 * real). Un slug que miente sobre su entorno tiene que ROMPER EL ARRANQUE, no
 * pagar con dinero real en silencio.
 *
 * Activación real de Kite mainnet: ver `KITE_MAINNET_REMEDIATION` arriba (exige
 * el slug `kite-mainnet` Y `KITE_NETWORK=mainnet`, sin slug Kite testnet).
 *
 * it2 MNR-3 (segundo chequeo) — DRIFT INVERSO `chainConfig` ↔ adapter: el gate
 * de dinero del leg downstream clasifica por `bundle.chainConfig.chainId`, pero
 * quien firma y settlea es el ADAPTER, y el adapter de Kite resuelve su chain
 * (chainId, token, dominio EIP-712) leyendo `KITE_NETWORK` en CALL-TIME. Con
 * `WASIAI_A2A_CHAINS=kite-mainnet` y `KITE_NETWORK` ausente el proceso arranca
 * sin drift de slug detectable (`chainConfig.chainId` 2366) mientras el adapter
 * reporta 2368 con el PYUSD de testnet.
 *
 * La severidad se decide POR DIRECCIÓN, no por "hay mismatch":
 *  - adapter MAINNET con `chainConfig` TESTNET ⇒ **THROW**. Es un agujero de
 *    dinero real: el gate del leg clasifica `chainConfig` (testnet ⇒ pasa sin
 *    opt-in) y el adapter firma en mainnet. Hoy NINGÚN factory produce esta
 *    combinación (el registry nunca pasa `{network:'testnet'}`); es defensa para
 *    el próximo adapter que lea env en call-time, y se documenta como tal —
 *    no como un control que hoy proteja algo alcanzable.
 *  - cualquier otro mismatch (el caso REAL de Kite: `chainConfig` mainnet +
 *    adapter testnet) ⇒ **log.error y sigue arrancando**. La dirección es segura
 *    (el gate lo trata como mainnet y exige opt-in; el dinero sería testnet) y
 *    convertirlo en throw volvería NO-ARRANCABLE una config que hoy arranca
 *    (p.ej. un CSV con los dos slugs Kite, que no puedo verificar contra el
 *    Railway de prod desde acá). Un rail roto en silencio se arregla haciéndolo
 *    ruidoso, no tirando el gateway abajo. Fix de fondo: TD-NEW-KITE-PARAMS.
 */
function assertChainEnvironmentCoherent(
  chainKey: ChainKey,
  bundle: AdaptersBundle,
): void {
  const destination: LegDestination =
    bundle.payment.vmFamily === 'solana'
      ? { vmFamily: 'solana', caip2ChainId: bundle.payment.caip2ChainId }
      : { vmFamily: 'evm', chainId: bundle.chainConfig.chainId };
  const drift = findChainEnvironmentDrift({ chainKey, destination });
  if (drift) {
    const actualId =
      destination.vmFamily === 'evm'
        ? String(destination.chainId)
        : destination.caip2ChainId;
    throw new Error(
      `Incoherent chain config for '${chainKey}': the slug declares ${drift.declared} ` +
        `but its bundle points to a ${drift.actual} destination (${actualId}; expected ` +
        `${String(getCanonicalChainId(chainKey))}). Refusing to start — a testnet slug ` +
        `settling on mainnet spends real money and defeats the WKH-144 fail-closed gate. ` +
        `${KITE_MAINNET_REMEDIATION}`,
    );
  }

  // Drift INVERSO (it2 MNR-3): el adapter que firma no coincide con el
  // `chainConfig` que el gate de mainnet clasifica. Sólo EVM: el
  // `chainConfig.chainId` de Solana es un sentinel sintético (DT-8) y su
  // adapter no expone `chainId` — ese rail ya se cubre por CAIP-2 arriba.
  if (bundle.payment.vmFamily !== 'evm') return;
  const configChainId = bundle.chainConfig.chainId;
  const adapterChainId = bundle.payment.chainId;
  if (adapterChainId === configChainId) return;

  if (
    classifyEvmChainId(adapterChainId) === 'mainnet' &&
    classifyEvmChainId(configChainId) === 'testnet'
  ) {
    throw new Error(
      `Incoherent chain config for '${chainKey}': chainConfig.chainId is ` +
        `${String(configChainId)} (testnet) but its payment adapter signs on ` +
        `${String(adapterChainId)} (MAINNET). Refusing to start — the downstream ` +
        `mainnet gate classifies chainConfig, so this bundle would spend real ` +
        `money while being guarded as testnet. ${KITE_MAINNET_REMEDIATION}`,
    );
  }

  log.error(
    {
      chainKey,
      code: 'ADAPTER_CHAIN_ID_DRIFT',
      chainConfigChainId: configChainId,
      adapterChainId,
      remediation: KITE_MAINNET_REMEDIATION,
    },
    `[Registry] chain '${chainKey}' is MISCONFIGURED: chainConfig says ${String(configChainId)} but its payment adapter signs on ${String(adapterChainId)} — this rail pays on the wrong chain (money-safe direction: the mainnet gate classifies chainConfig)`,
  );
}

export async function initAdapters(): Promise<void> {
  const csvRaw = process.env.WASIAI_A2A_CHAINS;
  const legacyRaw = process.env.WASIAI_A2A_CHAIN;

  // CD-13: conflict warning if both env vars are present.
  if (
    typeof csvRaw === 'string' &&
    csvRaw.length > 0 &&
    typeof legacyRaw === 'string' &&
    legacyRaw.length > 0
  ) {
    log.warn(
      { chains: csvRaw },
      'both WASIAI_A2A_CHAINS and WASIAI_A2A_CHAIN are set. Using WASIAI_A2A_CHAINS (singular ignored)',
    );
  }

  const raw =
    typeof csvRaw === 'string' && csvRaw.length > 0
      ? csvRaw
      : typeof legacyRaw === 'string' && legacyRaw.length > 0
        ? legacyRaw
        : 'kite-ozone-testnet';

  const slugs = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);

  if (slugs.length === 0) {
    throw new Error(
      `Unsupported chain ''. Supported: ${getSupportedChains().join(', ')}`,
    );
  }

  // Validate every slug BEFORE instantiating any bundle (fail-fast).
  for (const slug of slugs) {
    if (!isSupportedChain(slug)) {
      throw new Error(
        `Unsupported chain '${slug}'. Supported: ${getSupportedChains().join(', ')}`,
      );
    }
  }

  // De-dup preserving order — first occurrence wins for default selection.
  const chainKeys: ChainKey[] = [];
  for (const slug of slugs) {
    if (isSupportedChain(slug) && !chainKeys.includes(slug)) {
      chainKeys.push(slug);
    }
  }

  for (const chainKey of chainKeys) {
    const bundle = await buildBundle(chainKey);
    // it2 BLQ-ALTO-1: fail-loud ANTES de registrar el bundle (un bundle
    // incoherente nunca queda alcanzable por el money-path).
    assertChainEnvironmentCoherent(chainKey, bundle);
    _bundles.set(chainKey, bundle);
  }

  _defaultChainKey = chainKeys[0] ?? null;
  _initialized = true;

  log.info({ chainKeys }, 'Adapters initialized');
}

function assertInitialized(): void {
  if (!_initialized) {
    throw new Error('Adapters not initialized. Call initAdapters() first.');
  }
}

function resolveBundleOrThrow(chainKey?: ChainKey): AdaptersBundle {
  assertInitialized();
  const key = chainKey ?? _defaultChainKey;
  if (!key) {
    throw new Error('Adapters not initialized. Call initAdapters() first.');
  }
  const bundle = _bundles.get(key);
  if (!bundle) {
    throw new Error('Adapters not initialized. Call initAdapters() first.');
  }
  return bundle;
}

/**
 * EVM-only payment accessor (WKH-234). The overwhelming majority of call-sites
 * (x402 middleware, fee-*, payment-intent, deposit route, sign flows) are
 * EVM-exclusive and read EVM-only surface (`getToken`, `sign`, `chainId`).
 *
 * Post WKH-234 `PaymentAdapter` is a discriminated union
 * (`EvmPaymentAdapter | SolanaPaymentAdapter`). This accessor narrows via the
 * `vmFamily` discriminant and returns the EVM surface — byte-identical for the
 * 7 EVM chains (the throw branch is unreachable for them). The Solana rail is
 * reached via `getPaymentAdapterOrUnion()` and narrowed at the two settle
 * choke-points (downstream-payment / compose, W4).
 */
export function getPaymentAdapter(chainKey?: ChainKey): EvmPaymentAdapter {
  const payment = resolveBundleOrThrow(chainKey).payment;
  if (payment.vmFamily !== 'evm') {
    throw new Error(
      `getPaymentAdapter: resolved a non-EVM (${payment.vmFamily}) adapter — use the vmFamily-aware settle path`,
    );
  }
  return payment;
}

/**
 * VM-agnostic payment accessor (WKH-234) — returns the discriminated union so
 * the caller can narrow by `vmFamily`. Used only by the settle choke-points
 * that must handle both EVM and Solana legs (downstream-payment / compose).
 */
export function getPaymentAdapterOrUnion(chainKey?: ChainKey): PaymentAdapter {
  return resolveBundleOrThrow(chainKey).payment;
}

export function getAttestationAdapter(chainKey?: ChainKey): AttestationAdapter {
  return resolveBundleOrThrow(chainKey).attestation;
}

export function getGaslessAdapter(chainKey?: ChainKey): GaslessAdapter {
  return resolveBundleOrThrow(chainKey).gasless;
}

export function getIdentityBindingAdapter(
  chainKey?: ChainKey,
): IdentityBindingAdapter {
  const bundle = resolveBundleOrThrow(chainKey);
  if (!bundle.identity) {
    const key = chainKey ?? _defaultChainKey ?? 'unknown';
    throw new Error(`IdentityBindingAdapter not implemented for ${key}`);
  }
  return bundle.identity;
}

export function getChainConfig(chainKey?: ChainKey): {
  name: string;
  chainId: number;
  explorerUrl: string;
} {
  return resolveBundleOrThrow(chainKey).chainConfig;
}

/**
 * Explicit accessor that does NOT throw on miss — returns `undefined`
 * if `chainKey` is not initialized. Use this in middleware where the
 * caller wants to distinguish "uninitialized" from runtime errors.
 *
 * If no `chainKey` is provided, falls back to the default chain.
 * Returns `undefined` if the registry was never initialized.
 */
export function getAdaptersBundle(
  chainKey?: ChainKey,
): AdaptersBundle | undefined {
  if (!_initialized) return undefined;
  const key = chainKey ?? _defaultChainKey;
  if (!key) return undefined;
  return _bundles.get(key);
}

/**
 * Returns the list of chain keys currently initialized in the registry,
 * in the same order they appeared in the configuration CSV.
 */
export function getInitializedChainKeys(): ChainKey[] {
  return [..._bundles.keys()];
}

/**
 * Returns the default chain key (first entry of the CSV), or `null` if
 * the registry has not been initialized.
 */
export function getDefaultChainKey(): ChainKey | null {
  return _defaultChainKey;
}

/**
 * TEST-ONLY — clears the registry state so each test can call
 * `initAdapters()` again with different env vars. CD-17.
 */
export function _resetRegistry(): void {
  _bundles.clear();
  _defaultChainKey = null;
  _initialized = false;
}
