import type {
  AttestationAdapter,
  GaslessAdapter,
  IdentityBindingAdapter,
  PaymentAdapter,
} from '../types.js';
import { getKiteChain } from './chain.js';
import { initClient } from './client.js';

export interface KiteOzoneAdapters {
  payment: PaymentAdapter;
  attestation: AttestationAdapter;
  gasless: GaslessAdapter;
  identity: IdentityBindingAdapter | null;
  chainConfig: { name: string; chainId: number; explorerUrl: string };
}

/**
 * Factory for the Kite Ozone adapter bundle.
 *
 * `opts.network` (optional) — when set to `'mainnet'`, the factory
 * **temporarily mutates** `process.env.KITE_NETWORK` to `'mainnet'` for the
 * duration of the synchronous init path (until the bundle is built), then
 * **restores** the previous value in `finally` — including `delete` when the
 * caller had no prior value set.
 *
 * This pattern is DT-I (story-file §3) — explicitly authorized under CD-3 as
 * an additive interface change. It is a **temporary** workaround because
 * `chain.ts`/`payment.ts` read `KITE_NETWORK` from `process.env` at call time;
 * cleanup is tracked as `TD-NEW-KITE-PARAMS` (see `doc/architecture/MULTI-CHAIN.md`
 * §8 Open items), which will refactor those modules to receive `network` as an
 * explicit parameter so the env mutation can be removed entirely.
 *
 * CD-2 invariant: when `opts` is absent (or `opts.network` is `undefined`),
 * the function behaves byte-identically to the pre-W5 implementation —
 * no env mutation, no try/finally side effects observable to the caller.
 */
export async function createKiteOzoneAdapters(
  opts?: { network?: 'testnet' | 'mainnet' },
): Promise<KiteOzoneAdapters> {
  // DT-I: temporary mutation of KITE_NETWORK confined to this factory.
  // TD-NEW-KITE-PARAMS tracks cleanup (chain.ts/payment.ts should receive
  // `network` as an explicit parameter so env mutation can be removed).
  const hadPrevNetwork = Object.prototype.hasOwnProperty.call(
    process.env,
    'KITE_NETWORK',
  );
  const prevNetwork = process.env.KITE_NETWORK;
  const shouldMutate = opts?.network !== undefined;
  if (shouldMutate) {
    process.env.KITE_NETWORK = opts!.network;
  }
  try {
    await initClient();
    const { KiteOzonePaymentAdapter } = await import('./payment.js');
    const { KiteOzoneGaslessAdapter } = await import('./gasless.js');
    const { KiteOzoneAttestationAdapter } = await import('./attestation.js');
    const chain = getKiteChain();
    return {
      payment: new KiteOzonePaymentAdapter(),
      attestation: new KiteOzoneAttestationAdapter(),
      gasless: new KiteOzoneGaslessAdapter(),
      identity: null,
      chainConfig: {
        name: chain.name,
        chainId: chain.id,
        explorerUrl: chain.blockExplorers.default.url,
      },
    };
  } finally {
    if (shouldMutate) {
      if (hadPrevNetwork) {
        process.env.KITE_NETWORK = prevNetwork as string;
      } else {
        delete process.env.KITE_NETWORK;
      }
    }
  }
}
