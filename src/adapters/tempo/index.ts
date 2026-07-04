import type { AdaptersBundle } from '../types.js';
import { getTempoChain, getTempoNetwork, type TempoNetwork } from './chain.js';

/**
 * Tempo adapter factory (WKH-090 / HU-090).
 *
 * Patrón Base (DT-2): recibe `network` explícito por `opts` e importa los
 * módulos dinámicamente. **SIN mutación de `process.env`** (prohibido replicar
 * el anti-patrón de `kite-ozone/index.ts` — deuda `TD-NEW-KITE-PARAMS`).
 *
 * El registry dispatcher (`buildBundle()`) siempre pasa `network: 'testnet'`
 * (CD-2: Tempo es testnet-only en v1).
 */
export async function createTempoAdapters(opts?: {
  network?: TempoNetwork;
}): Promise<AdaptersBundle> {
  const network = getTempoNetwork(opts);
  const { TempoPaymentAdapter } = await import('./payment.js');
  const { TempoAttestationAdapter } = await import('./attestation.js');
  const { TempoGaslessAdapter } = await import('./gasless.js');

  const chain = getTempoChain(network);
  const chainId = chain.id;
  // V5 — explorer de Tempo testnet (verificado vía web).
  const explorerUrl =
    chain.blockExplorers?.default.url ?? 'https://explore.tempo.xyz';

  return {
    payment: new TempoPaymentAdapter({ network }),
    attestation: new TempoAttestationAdapter(chainId),
    gasless: new TempoGaslessAdapter(chainId),
    identity: null,
    chainConfig: { name: 'Tempo Testnet', chainId, explorerUrl },
  };
}
