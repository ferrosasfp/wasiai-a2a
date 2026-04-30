// kv-mock.mjs — In-memory KV mock with `@upstash/redis` API compat (subset).
//
// Why this mock exists (CD-7): chaos and unit tests must NEVER hit a real
// Upstash REST endpoint. The MCP server uses only this subset of the Redis
// API: get / set / incr / incrby / decrby / expire / ttl / del. Lua EVAL is
// PROHIBITED (DT-I), so this mock intentionally does not implement it.
//
// Atomicity model: single-threaded JS guarantees that each method body runs
// atomically (V10.1.a). INCRBY → CAS-revert sequences in balance-guard.mjs
// are NOT atomic across calls — that's the gap real Lua EVAL would close,
// and the chaos tests are designed to surface the resulting race.
//
// Chaos hooks:
//   - failNext: counter — each call decrements; while > 0 the call throws
//     a synthetic "kv: simulated failure".
//   - slowMs: setTimeout delay before resolving (simulates Upstash latency).
//   - staleData: pre-seeded snapshot with a TTL just past expiry (used by
//     T-CH-11).
//
// Time model: TTLs are stored as ABSOLUTE expiry timestamps (Date.now() +
// ttl*1000). _advanceTime(ms) shifts a virtual offset so we can simulate
// expiry without sleeping. _purgeExpired() removes keys whose expiry is in
// the past relative to virtual-now.

const _now = () => Date.now();

export function createKvMock({ failNext = 0, slowMs = 0, staleData = null } = {}) {
  // store: key -> { value: string|number, expiresAt: number|null }
  const store = new Map();
  let _failNext = failNext;
  let _slowMs = slowMs;
  let _timeOffsetMs = 0;

  if (staleData && typeof staleData === 'object') {
    for (const [k, v] of Object.entries(staleData)) {
      // Pre-seed with expiry already past: -1ms in virtual time.
      store.set(k, { value: v, expiresAt: _now() - 1 });
    }
  }

  const virtualNow = () => _now() + _timeOffsetMs;

  function _purgeExpired(key) {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= virtualNow()) {
      store.delete(key);
      return null;
    }
    return entry;
  }

  async function _gate() {
    if (_failNext > 0) {
      _failNext -= 1;
      throw new Error('kv: simulated failure');
    }
    if (_slowMs > 0) {
      await new Promise((r) => setTimeout(r, _slowMs));
    }
  }

  return {
    async get(key) {
      await _gate();
      const entry = _purgeExpired(key);
      if (!entry) return null;
      return entry.value;
    },
    async set(key, value, opts = {}) {
      await _gate();
      // Upstash supports { ex: <seconds> } shorthand. We honour it.
      let expiresAt = null;
      if (opts && typeof opts === 'object' && typeof opts.ex === 'number') {
        expiresAt = virtualNow() + opts.ex * 1000;
      }
      store.set(key, { value, expiresAt });
      return 'OK';
    },
    async incr(key) {
      await _gate();
      const entry = _purgeExpired(key);
      const cur = entry ? Number(entry.value) || 0 : 0;
      const next = cur + 1;
      store.set(key, { value: next, expiresAt: entry?.expiresAt ?? null });
      return next;
    },
    async incrby(key, delta) {
      await _gate();
      const entry = _purgeExpired(key);
      const cur = entry ? Number(entry.value) || 0 : 0;
      const next = cur + Number(delta);
      store.set(key, { value: next, expiresAt: entry?.expiresAt ?? null });
      return next;
    },
    async decrby(key, delta) {
      await _gate();
      const entry = _purgeExpired(key);
      const cur = entry ? Number(entry.value) || 0 : 0;
      const next = cur - Number(delta);
      store.set(key, { value: next, expiresAt: entry?.expiresAt ?? null });
      return next;
    },
    async expire(key, seconds) {
      await _gate();
      const entry = store.get(key);
      if (!entry) return 0;
      entry.expiresAt = virtualNow() + Number(seconds) * 1000;
      return 1;
    },
    async ttl(key) {
      await _gate();
      const entry = _purgeExpired(key);
      if (!entry) return -2;
      if (entry.expiresAt === null) return -1;
      return Math.max(0, Math.ceil((entry.expiresAt - virtualNow()) / 1000));
    },
    async del(key) {
      await _gate();
      const had = store.has(key);
      store.delete(key);
      return had ? 1 : 0;
    },

    // Test-only escape hatches (prefixed _ → not part of @upstash/redis
    // surface). PROHIBITED to use these from production code.
    _store: store,
    _setFailNext(n) { _failNext = n; },
    _setSlowMs(n) { _slowMs = n; },
    _advanceTime(ms) { _timeOffsetMs += ms; },
    _resetTime() { _timeOffsetMs = 0; },
  };
}
