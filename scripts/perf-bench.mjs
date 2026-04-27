#!/usr/bin/env node
/**
 * Performance benchmark for wasiai-a2a-production endpoints.
 * Measures p50/p95/p99 latency and throughput for read-only paths.
 * Does NOT exercise paid paths (no /compose with x402).
 */
const A2A_URL = 'https://wasiai-a2a-production.up.railway.app';

const SCENARIOS = [
  { name: 'GET /health',                    method: 'GET',  path: '/health',                          n: 100 },
  { name: 'POST /discover (empty query)',   method: 'POST', path: '/discover',                        n: 50, body: { query: '', limit: 10 } },
  { name: 'POST /discover (filter category)', method: 'POST', path: '/discover',                      n: 50, body: { query: 'price', limit: 5 } },
  { name: 'GET /agents (list)',             method: 'GET',  path: '/agents?limit=10',                 n: 50 },
  { name: 'GET /agents/{id}/agent-card',    method: 'GET',  path: '/agents/wasi-chainlink-price/agent-card', n: 50 },
];

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function runScenario(s) {
  const latencies = [];
  let errors = 0;
  let nonOk = 0;
  const startedAll = Date.now();
  for (let i = 0; i < s.n; i++) {
    const startedAt = Date.now();
    try {
      const res = await fetch(`${A2A_URL}${s.path}`, {
        method: s.method,
        headers: s.body ? { 'Content-Type': 'application/json' } : {},
        body: s.body ? JSON.stringify(s.body) : undefined,
      });
      const elapsed = Date.now() - startedAt;
      latencies.push(elapsed);
      if (!res.ok) nonOk++;
      // drain body to be fair
      await res.text();
    } catch (e) {
      errors++;
    }
  }
  const totalElapsed = (Date.now() - startedAll) / 1000;
  return {
    name: s.name,
    n: s.n,
    errors,
    nonOk,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    min: Math.min(...latencies),
    max: Math.max(...latencies),
    rps: (latencies.length / totalElapsed).toFixed(1),
  };
}

console.log(`=== Performance benchmark: ${A2A_URL} ===\n`);
const results = [];
for (const s of SCENARIOS) {
  console.log(`Running ${s.name} (n=${s.n})...`);
  results.push(await runScenario(s));
}

console.log('\n┌─────────────────────────────────────────┬─────┬───────┬─────┬─────┬─────┬─────┬─────┬──────┐');
console.log('│ Scenario                                │  N  │ Errs  │ p50 │ p95 │ p99 │ min │ max │ rps  │');
console.log('├─────────────────────────────────────────┼─────┼───────┼─────┼─────┼─────┼─────┼─────┼──────┤');
for (const r of results) {
  const errs = r.errors > 0 ? `${r.errors}E` : (r.nonOk > 0 ? `${r.nonOk}!` : '0');
  console.log(`│ ${r.name.padEnd(40)}│ ${String(r.n).padStart(3)} │ ${errs.padStart(5)} │ ${String(r.p50).padStart(3)} │ ${String(r.p95).padStart(3)} │ ${String(r.p99).padStart(3)} │ ${String(r.min).padStart(3)} │ ${String(r.max).padStart(3)} │ ${r.rps.padStart(4)} │`);
}
console.log('└─────────────────────────────────────────┴─────┴───────┴─────┴─────┴─────┴─────┴─────┴──────┘');
console.log('\nLatencies in ms. Errs: 0=ok, NE=N errors (network), N!=N non-2xx responses.');
