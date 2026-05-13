import type {
  AdaptersBundle,
  AttestationAdapter,
  ChainKey,
  GaslessAdapter,
  IdentityBindingAdapter,
  PaymentAdapter,
} from './types.js';

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
] as const satisfies readonly ChainKey[];

const _bundles = new Map<ChainKey, AdaptersBundle>();
let _defaultChainKey: ChainKey | null = null;
let _initialized = false;

function isSupportedChain(slug: string): slug is ChainKey {
  return (SUPPORTED_CHAINS as readonly string[]).includes(slug);
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
  if (chainKey === 'avalanche-fuji') {
    const { createAvalancheAdapters } = await import('./avalanche/index.js');
    return createAvalancheAdapters({ network: 'fuji' });
  }
  if (chainKey === 'avalanche-mainnet') {
    const { createAvalancheAdapters } = await import('./avalanche/index.js');
    return createAvalancheAdapters({ network: 'mainnet' });
  }
  // kite-mainnet is wired in W5.
  throw new Error(
    `Unsupported chain '${chainKey}'. Supported: ${SUPPORTED_CHAINS.join(', ')}`,
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
    console.warn(
      `[Registry] WARNING: both WASIAI_A2A_CHAINS and WASIAI_A2A_CHAIN are set. Using WASIAI_A2A_CHAINS=${csvRaw} (singular ignored)`,
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
      `Unsupported chain ''. Supported: ${SUPPORTED_CHAINS.join(', ')}`,
    );
  }

  // Validate every slug BEFORE instantiating any bundle (fail-fast).
  for (const slug of slugs) {
    if (!isSupportedChain(slug)) {
      throw new Error(
        `Unsupported chain '${slug}'. Supported: ${SUPPORTED_CHAINS.join(', ')}`,
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

  console.log(
    `[Registry] Adapters initialized: ${chainKeys.join(', ')}`,
  );
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

export function getPaymentAdapter(chainKey?: ChainKey): PaymentAdapter {
  return resolveBundleOrThrow(chainKey).payment;
}

export function getAttestationAdapter(
  chainKey?: ChainKey,
): AttestationAdapter {
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
