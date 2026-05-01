// rpc-mock.mjs — viem-compat readContract mock for ERC-20 balanceOf.
//
// Returns BIGINT (CD-19 / V10.1.b) — viem's real `readContract` for
// `balanceOf(address)` returns bigint, not number. Tests that pass `1000n`
// or `400_000n` rely on this contract.
//
// Chaos hooks:
//   - failNext: throw on next N calls (simulates Avalanche RPC down).
//   - slowMs: delay before resolving (simulates RPC latency).
//   - rateLimit429: throw a synthetic "429 too many requests" each call.
//
// Address awareness: T-CS-01 stress test runs many calls against the SAME
// operator address — the mock returns `balance` regardless of args. That is
// intentional: the balance-guard claim is what enforces serialization, not
// the RPC.

export function createRpcMock({
  balance = 1_000_000n,
  failNext = 0,
  slowMs = 0,
  rateLimit429 = false,
} = {}) {
  let _failNext = failNext;

  const calls = [];

  return {
    // viem PublicClient.readContract surface — we accept whatever shape
    // balance-guard.mjs passes and return the bigint balance.
    async readContract(args) {
      calls.push(args);
      if (slowMs > 0) await new Promise((r) => setTimeout(r, slowMs));
      if (rateLimit429) {
        const e = new Error('rpc: rate limited (429)');
        e.status = 429;
        throw e;
      }
      if (_failNext > 0) {
        _failNext -= 1;
        throw new Error('rpc: simulated failure');
      }
      // We honour functionName for a tiny bit of self-documentation.
      if (args?.functionName !== 'balanceOf') {
        throw new Error(`rpc-mock: unexpected functionName ${args?.functionName}`);
      }
      return balance;
    },

    // For block-number assertions in chaos tests.
    async getBlockNumber() {
      if (slowMs > 0) await new Promise((r) => setTimeout(r, slowMs));
      return 12345678n;
    },

    // Test-only state inspection.
    _calls: calls,
    _setFailNext(n) { _failNext = n; },
  };
}
