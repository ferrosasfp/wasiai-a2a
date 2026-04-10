import type { PaymentAdapter, AttestationAdapter, GaslessAdapter, IdentityBindingAdapter } from '../types.js'
import { initClient } from './client.js'
import { kiteTestnet } from './chain.js'

export interface KiteOzoneAdapters {
  payment: PaymentAdapter
  attestation: AttestationAdapter
  gasless: GaslessAdapter
  identity: IdentityBindingAdapter | null
  chainConfig: { name: string; chainId: number; explorerUrl: string }
}

export async function createKiteOzoneAdapters(): Promise<KiteOzoneAdapters> {
  await initClient()
  const { KiteOzonePaymentAdapter } = await import('./payment.js')
  const { KiteOzoneGaslessAdapter } = await import('./gasless.js')
  const { KiteOzoneAttestationAdapter } = await import('./attestation.js')
  return {
    payment: new KiteOzonePaymentAdapter(),
    attestation: new KiteOzoneAttestationAdapter(),
    gasless: new KiteOzoneGaslessAdapter(),
    identity: null,
    chainConfig: { name: kiteTestnet.name, chainId: kiteTestnet.id, explorerUrl: kiteTestnet.blockExplorers.default.url },
  }
}
