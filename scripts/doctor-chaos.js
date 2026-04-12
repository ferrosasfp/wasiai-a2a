/**
 * Doctor 6: Chaos Testing — Resilience under failure conditions
 *
 * Tests: malformed inputs, huge payloads, concurrent abuse,
 * circuit breaker behavior, graceful degradation.
 * Run: k6 run scripts/doctor-chaos.js
 */

import http from 'k6/http'
import { check, group, sleep } from 'k6'
import { Counter } from 'k6/metrics'

const BASE_URL = __ENV.BASE_URL || 'https://wasiai-a2a-production.up.railway.app'
const json = { 'Content-Type': 'application/json' }
const crashes = new Counter('server_crashes')

export const options = {
  scenarios: {
    // Serial chaos tests
    chaos: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      exec: 'chaosTests',
    },
    // Concurrent abuse
    concurrentAbuse: {
      executor: 'constant-vus',
      vus: 15,
      duration: '15s',
      exec: 'concurrentAbuse',
      startTime: '30s',
    },
    // Recovery after abuse
    recovery: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 3,
      exec: 'recoveryCheck',
      startTime: '50s',
    },
  },
  thresholds: {
    server_crashes: ['count==0'],
  },
}

function noServerCrash(res, name) {
  const ok = check(res, {
    [`${name} no 500`]: (r) => r.status < 500 || r.status === 503, // 503 backpressure is OK
  })
  if (!ok) crashes.add(1)
  return ok
}

// ── Chaos Tests (serial) ───────────────────────────────────
export function chaosTests() {

  group('Chaos: Malformed JSON', () => {
    const payloads = [
      '',
      'not-json',
      '{',
      '{"goal": }',
      '{"goal": "test", "budget": "not-a-number"}',
      'null',
      '[]',
      '{"goal": null, "budget": null}',
    ]
    payloads.forEach((p, i) => {
      const r = http.post(`${BASE_URL}/orchestrate`, p, { headers: json })
      noServerCrash(r, `malformed[${i}]`)
    })
  })

  group('Chaos: Huge payloads', () => {
    // 1MB string goal
    const huge = 'A'.repeat(1024 * 1024)
    const r1 = http.post(`${BASE_URL}/orchestrate`,
      JSON.stringify({ goal: huge, budget: 0.01 }), { headers: json })
    noServerCrash(r1, 'huge goal (1MB)')

    // 10K capabilities array
    const bigCaps = Array.from({ length: 10000 }, (_, i) => `cap-${i}`)
    const r2 = http.post(`${BASE_URL}/discover`,
      JSON.stringify({ capabilities: bigCaps, limit: 1 }), { headers: json })
    noServerCrash(r2, 'huge capabilities (10K)')

    // Deep nested JSON
    let nested = { a: 'leaf' }
    for (let i = 0; i < 100; i++) nested = { nested }
    const r3 = http.post(`${BASE_URL}/orchestrate`,
      JSON.stringify({ goal: 'test', budget: 0.01, extra: nested }), { headers: json })
    noServerCrash(r3, 'deep nested JSON (100 levels)')
  })

  group('Chaos: Wrong content types', () => {
    const types = [
      'text/plain',
      'text/html',
      'application/xml',
      'multipart/form-data',
      'application/x-www-form-urlencoded',
    ]
    types.forEach((ct) => {
      const r = http.post(`${BASE_URL}/orchestrate`, 'goal=test&budget=0.01',
        { headers: { 'Content-Type': ct } })
      noServerCrash(r, `content-type: ${ct}`)
    })
  })

  group('Chaos: HTTP method abuse', () => {
    // PUT/DELETE/PATCH on endpoints that only accept GET/POST
    const methods = ['PUT', 'DELETE', 'PATCH']
    const endpoints = ['/discover', '/orchestrate', '/health']
    methods.forEach(method => {
      endpoints.forEach(ep => {
        const r = http.request(method, `${BASE_URL}${ep}`)
        noServerCrash(r, `${method} ${ep}`)
      })
    })
  })

  group('Chaos: Header abuse', () => {
    // Huge header
    const r1 = http.get(`${BASE_URL}/health`, {
      headers: { 'X-Custom': 'A'.repeat(8000) },
    })
    noServerCrash(r1, 'huge header (8KB)')

    // Many headers
    const headers = {}
    for (let i = 0; i < 50; i++) headers[`X-Chaos-${i}`] = `value-${i}`
    const r2 = http.get(`${BASE_URL}/health`, { headers })
    noServerCrash(r2, 'many headers (50)')

    // Null bytes in header
    const r3 = http.get(`${BASE_URL}/health`, {
      headers: { 'X-Null': 'test\x00value' },
    })
    noServerCrash(r3, 'null byte in header')
  })

  group('Chaos: Unicode and encoding', () => {
    const unicodeGoals = [
      '获取 ETH 的当前价格',          // Chinese
      '🚀💰🤖 get price',               // Emoji
      '\u0000\u0001\u0002',              // Control chars
      'test\r\nX-Injected: true',        // CRLF injection
      'a'.repeat(2001),                   // Over maxLength
    ]
    unicodeGoals.forEach((goal, i) => {
      const r = http.post(`${BASE_URL}/orchestrate`,
        JSON.stringify({ goal, budget: 0.01 }), { headers: json })
      noServerCrash(r, `unicode[${i}]`)
    })
  })

  group('Chaos: Gasless edge cases', () => {
    // Transfer without body
    const r1 = http.post(`${BASE_URL}/gasless/transfer`, '', { headers: json })
    noServerCrash(r1, 'gasless transfer empty body')

    // Transfer with invalid address
    const r2 = http.post(`${BASE_URL}/gasless/transfer`,
      JSON.stringify({ to: 'not-an-address', value: '1000' }), { headers: json })
    noServerCrash(r2, 'gasless transfer invalid address')
  })
}

// ── Concurrent Abuse ───────────────────────────────────────
export function concurrentAbuse() {
  // 15 VUs hammering different endpoints simultaneously
  const roll = Math.random()

  if (roll < 0.3) {
    const r = http.post(`${BASE_URL}/orchestrate`,
      JSON.stringify({ goal: 'concurrent chaos', budget: 0.01 }), { headers: json })
    noServerCrash(r, 'concurrent orchestrate')
  } else if (roll < 0.6) {
    const r = http.get(`${BASE_URL}/discover?q=chaos&limit=1`)
    noServerCrash(r, 'concurrent discover')
  } else {
    const r = http.post(`${BASE_URL}/auth/agent-signup`,
      JSON.stringify({ owner_ref: `chaos-${__VU}-${Date.now()}` }), { headers: json })
    noServerCrash(r, 'concurrent signup')
  }

  sleep(0.1)
}

// ── Recovery Check ─────────────────────────────────────────
export function recoveryCheck() {
  group('Recovery: Post-abuse health', () => {
    const health = http.get(`${BASE_URL}/health`)
    check(health, { 'health 200 after abuse': (r) => r.status === 200 })

    const discover = http.get(`${BASE_URL}/discover?q=recovery&limit=1`)
    check(discover, { 'discover 200 after abuse': (r) => r.status === 200 })

    const agentCard = http.get(`${BASE_URL}/.well-known/agent.json`)
    check(agentCard, { 'agent.json 200 after abuse': (r) => r.status === 200 })
  })
  sleep(1)
}

export function handleSummary(data) {
  const crashCount = data.metrics.server_crashes?.values?.count || 0
  const totalReqs = data.metrics.http_reqs?.values?.count || 0
  const lines = [
    '\n═══════════════════════════════════════════════',
    '  Doctor 6: Chaos Test Results',
    '═══════════════════════════════════════════════',
    `  Target: ${BASE_URL}`,
    `  Total requests: ${totalReqs}`,
    `  Server crashes (5xx): ${crashCount}`,
    `  Verdict: ${crashCount === 0 ? '✅ PASS — server survived chaos' : '❌ FAIL — server crashed under chaos'}`,
    '═══════════════════════════════════════════════\n',
  ]
  return { stdout: lines.join('\n') + '\n' }
}
