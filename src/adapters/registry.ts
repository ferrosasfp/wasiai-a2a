import type {
  AttestationAdapter,
  GaslessAdapter,
  IdentityBindingAdapter,
  PaymentAdapter,
} from './types.js';

let _payment: PaymentAdapter | null = null;
let _attestation: AttestationAdapter | null = null;
let _gasless: GaslessAdapter | null = null;
let _identity: IdentityBindingAdapter | null = null;
let _chainConfig: {
  name: string;
  chainId: number;
  explorerUrl: string;
} | null = null;
let _initialized = false;
const SUPPORTED_CHAINS = ['kite-ozone-testnet'] as const;
export async function initAdapters(): Promise<void> {
  const chain = process.env.WASIAI_A2A_CHAIN ?? 'kite-ozone-testnet';
  if (!SUPPORTED_CHAINS.includes(chain as (typeof SUPPORTED_CHAINS)[number]))
    throw new Error(
      `Unsupported chain '${chain}'. Supported: ${SUPPORTED_CHAINS.join(', ')}`,
    );
  if (chain === 'kite-ozone-testnet') {
    const { createKiteOzoneAdapters } = await import('./kite-ozone/index.js');
    const adapters = await createKiteOzoneAdapters();
    _payment = adapters.payment;
    _attestation = adapters.attestation;
    _gasless = adapters.gasless;
    _identity = adapters.identity;
    _chainConfig = adapters.chainConfig;
  }
  _initialized = true;
  console.log(`[Registry] Adapters initialized for chain: ${chain}`);
}
export function getPaymentAdapter(): PaymentAdapter {
  if (!_initialized || !_payment)
    throw new Error('Adapters not initialized. Call initAdapters() first.');
  return _payment;
}
export function getAttestationAdapter(): AttestationAdapter {
  if (!_initialized || !_attestation)
    throw new Error('Adapters not initialized. Call initAdapters() first.');
  return _attestation;
}
export function getGaslessAdapter(): GaslessAdapter {
  if (!_initialized || !_gasless)
    throw new Error('Adapters not initialized. Call initAdapters() first.');
  return _gasless;
}
export function getIdentityBindingAdapter(): IdentityBindingAdapter {
  if (!_initialized)
    throw new Error('Adapters not initialized. Call initAdapters() first.');
  if (!_identity)
    throw new Error(
      `IdentityBindingAdapter not implemented for ${process.env.WASIAI_A2A_CHAIN ?? 'kite-ozone-testnet'}`,
    );
  return _identity;
}
export function getChainConfig(): {
  name: string;
  chainId: number;
  explorerUrl: string;
} {
  if (!_initialized || !_chainConfig)
    throw new Error('Adapters not initialized. Call initAdapters() first.');
  return _chainConfig;
}
export function _resetRegistry(): void {
  _payment = null;
  _attestation = null;
  _gasless = null;
  _identity = null;
  _chainConfig = null;
  _initialized = false;
}
