import { defineChain } from 'viem';
import { getLogger } from '../../lib/logger.js';

const log = getLogger('tempo');

/**
 * Tempo testnet chain registration (WKH-090 / HU-090).
 *
 * Tempo (Stripe + Paradigm, "Machine Payments Protocol") is NOT in
 * `viem/chains`, so it is defined here with `defineChain` — same pattern as
 * `kite-ozone/chain.ts`.
 *
 * [VERIFY-AT-IMPL en F3] resueltos con los parámetros oficiales de Tempo
 * testnet ("Moderato") verificados vía web:
 *   - V1 chainId    → 42429
 *   - V2 RPC URL    → https://rpc.testnet.tempo.xyz (alt: rpc.moderato.tempo.xyz)
 *   - V5 explorer   → https://explore.tempo.xyz
 * El rail ship OFF por flag (`TEMPO_ADAPTER_ENABLED` default OFF) y los tests
 * mockean `fetch`, así que estos valores no bloquean el DONE.
 */
const TEMPO_TESTNET_CHAIN_ID = 42429; // V1 — Tempo testnet "Moderato"
const TEMPO_TESTNET_RPC = 'https://rpc.testnet.tempo.xyz'; // V2
const TEMPO_TESTNET_EXPLORER = 'https://explore.tempo.xyz'; // V5

export const tempoTestnet = defineChain({
  id: TEMPO_TESTNET_CHAIN_ID,
  name: 'Tempo Testnet',
  // [VERIFY-AT-IMPL] símbolo nativo asumido 'TEMPO' — confirmar en el explorer.
  nativeCurrency: { decimals: 18, name: 'Tempo', symbol: 'TEMPO' },
  rpcUrls: {
    default: { http: [TEMPO_TESTNET_RPC] },
    public: { http: [TEMPO_TESTNET_RPC] },
  },
  blockExplorers: {
    default: { name: 'Tempo Explorer', url: TEMPO_TESTNET_EXPLORER },
  },
  testnet: true,
});

// tempo-mainnet reservado (CD-2) — NO definir en v1.

export type TempoNetwork = 'testnet';

/**
 * Resolve the active Tempo network. Priority:
 *   1. Explicit `opts.network` argument (registry factory always passes it).
 *   2. `TEMPO_NETWORK` env var.
 *   3. Fallback to 'testnet' (the only supported v1 network — CD-2).
 *
 * Warn-once ante un valor de env inválido (defensa-en-profundidad, mirror
 * `getBaseNetwork`).
 */
let _warnedTempoNetwork = false;
export function getTempoNetwork(opts?: {
  network?: TempoNetwork;
}): TempoNetwork {
  if (opts?.network) return opts.network;
  const env = process.env.TEMPO_NETWORK;
  if (
    env !== undefined &&
    env !== '' &&
    env !== 'testnet' &&
    !_warnedTempoNetwork
  ) {
    _warnedTempoNetwork = true;
    log.warn(
      { env },
      "TEMPO_NETWORK is not 'testnet' — defaulting to 'testnet'",
    );
  }
  return 'testnet';
}

export function getTempoChain(_network: TempoNetwork) {
  return tempoTestnet;
}

/** TEST-ONLY — reset warn-once flag (CD-17). */
export function _resetTempoChain(): void {
  _warnedTempoNetwork = false;
}
