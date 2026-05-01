// SPDX-License-Identifier: MIT
// src/avax-client.mjs — singleton lazy factory para viem PublicClient en Avalanche C-Chain.
// Reusable entre balance-guard, balance-check, runWithBalanceGate (MNR-CR-3, MNR-CR-4).
import { createPublicClient, http as viemHttp } from 'viem';
import { avalanche } from 'viem/chains';

let _client = null;
let _rpcUrl = null;

/**
 * Returns a memoized viem PublicClient for Avalanche C-Chain mainnet.
 * Singleton: one instance per process, reuses HTTP keep-alive.
 *
 * @param {string} rpcUrl - Avalanche C-Chain RPC URL
 * @returns {ReturnType<typeof createPublicClient>}
 */
export function getAvaxClient(rpcUrl) {
  if (!rpcUrl || typeof rpcUrl !== 'string') {
    throw new Error('AVAX_RPC_URL is required');
  }
  // Reset si el RPC URL cambia (test hooks)
  if (_client && _rpcUrl !== rpcUrl) {
    _client = null;
  }
  if (!_client) {
    _client = createPublicClient({ chain: avalanche, transport: viemHttp(rpcUrl) });
    _rpcUrl = rpcUrl;
  }
  return _client;
}

/**
 * Test-only: reset the singleton (for unit tests).
 */
export function _resetAvaxClient() {
  _client = null;
  _rpcUrl = null;
}
