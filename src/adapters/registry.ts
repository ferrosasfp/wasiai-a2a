import { getLogger } from '../lib/logger.js';
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
export function getPaymentAdapterOrUnion(
  chainKey?: ChainKey,
): PaymentAdapter {
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
