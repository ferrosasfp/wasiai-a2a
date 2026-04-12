/**
 * WasiAI A2A — K6 Load Test v2
 *
 * Tests all endpoints with tiered rate limiting validation.
 * Run: k6 run scripts/k6-load-test.js
 * Run with env: k6 run -e BASE_URL=http://localhost:3001 scripts/k6-load-test.js
 */

import http from 'k6/http'
import { check, group, sleep } from 'k6'
import { Rate, Trend, Counter } from 'k6/metrics'

// ── Config ─────────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || 'https://wasiai-a2a-production.up.railway.app'

// Custom metrics
const errorRate = new Rate('errors')
const rateLimited = new Counter('rate_limited_429')
const discoverDuration = new Trend('discover_duration', true)
const orchestrate402Duration = new Trend('orchestrate_402_duration', true)
const healthDuration = new Trend('health_duration', true)

// ── Scenarios ──────────────────────────────────────────────────
export const options = {
  scenarios: {
    // Smoke: does it work?
    smoke: {
      executor: 'constant-vus',
      vus: 1,
      duration: '10s',
      exec: 'smokeTest',
      startTime: '0s',
    },
    // Load: normal traffic pattern
    load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '15s', target: 5 },
        { duration: '30s', target: 10 },
        { duration: '15s', target: 0 },
      ],
      exec: 'loadTest',
      startTime: '12s',
    },
    // Spike: sudden burst
    spike: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '5s', target: 20 },
        { duration: '10s', target: 20 },
        { duration: '5s', target: 0 },
      ],
      exec: 'spikeTest',
      startTime: '75s',
    },
    // Rate limit validation: verify tiered limits work correctly
    rateLimitCheck: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      exec: 'rateLimitTest',
      startTime: '100s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<3000'],
    errors: ['rate<0.15'],
  },
}

// ── Helpers ────────────────────────────────────────────────────
const jsonHeaders = { 'Content-Type': 'application/json' }

function checkResponse(res, name, expectedStatus) {
  const ok = check(res, {
    [`${name} status ${expectedStatus}`]: (r) => r.status === expectedStatus,
    [`${name} has body`]: (r) => r.body && r.body.length > 0,
  })
  if (res.status === 429) rateLimited.add(1)
  errorRate.add(!ok)
  return ok
}

// ── Smoke Test ─────────────────────────────────────────────────
export function smokeTest() {
  group('Health & Info', () => {
    const root = http.get(`${BASE_URL}/`)
    checkResponse(root, 'GET /', 200)

    const health = http.get(`${BASE_URL}/health`)
    checkResponse(health, 'GET /health', 200)
    healthDuration.add(health.timings.duration)

    const agentCard = http.get(`${BASE_URL}/.well-known/agent.json`)
    checkResponse(agentCard, 'GET /agent.json', 200)
  })

  group('Gasless Status', () => {
    const gasless = http.get(`${BASE_URL}/gasless/status`)
    checkResponse(gasless, 'GET /gasless/status', 200)
  })

  group('Dashboard', () => {
    const dash = http.get(`${BASE_URL}/dashboard`)
    check(dash, {
      'GET /dashboard status 2xx': (r) => r.status >= 200 && r.status < 400,
    })

    const stats = http.get(`${BASE_URL}/dashboard/api/stats`)
    checkResponse(stats, 'GET /dashboard/api/stats', 200)
  })

  sleep(1)
}

// ── Load Test ──────────────────────────────────────────────────
export function loadTest() {
  group('Discovery (exempt from rate limit)', () => {
    const getDiscover = http.get(`${BASE_URL}/discover?q=price&limit=5`)
    checkResponse(getDiscover, 'GET /discover', 200)
    discoverDuration.add(getDiscover.timings.duration)

    const postDiscover = http.post(
      `${BASE_URL}/discover`,
      JSON.stringify({ capabilities: ['defi'], query: 'oracle', limit: 3 }),
      { headers: jsonHeaders }
    )
    checkResponse(postDiscover, 'POST /discover', 200)
    discoverDuration.add(postDiscover.timings.duration)
  })

  group('Orchestrate (402 — rate limited to 10/min)', () => {
    const res = http.post(
      `${BASE_URL}/orchestrate`,
      JSON.stringify({ goal: 'Get the current price of ETH', budget: 0.10 }),
      { headers: jsonHeaders }
    )
    // Accept both 402 (payment required) and 429 (rate limited)
    const ok = check(res, {
      'POST /orchestrate status 402 or 429': (r) => r.status === 402 || r.status === 429,
      'POST /orchestrate has body': (r) => r.body && r.body.length > 0,
    })
    if (res.status === 429) rateLimited.add(1)
    if (res.status === 402) orchestrate402Duration.add(res.timings.duration)
    errorRate.add(!ok)
  })

  group('Health (exempt)', () => {
    const health = http.get(`${BASE_URL}/health`)
    checkResponse(health, 'GET /health', 200)
    healthDuration.add(health.timings.duration)
  })

  sleep(0.5)
}

// ── Spike Test ─────────────────────────────────────────────────
export function spikeTest() {
  const responses = http.batch([
    ['GET', `${BASE_URL}/health`],
    ['GET', `${BASE_URL}/discover?q=agent&limit=3`],
    ['GET', `${BASE_URL}/gasless/status`],
    ['GET', `${BASE_URL}/.well-known/agent.json`],
  ])

  responses.forEach((res, i) => {
    const names = ['health', 'discover', 'gasless', 'agent.json']
    checkResponse(res, `spike ${names[i]}`, 200)
  })

  sleep(0.2)
}

// ── Rate Limit Validation ──────────────────────────────────────
export function rateLimitTest() {
  console.log('\n--- Rate Limit Tier Validation ---')

  // Test 1: Discovery should NEVER be rate limited (exempt)
  group('Tier: /discover exempt', () => {
    let blocked = 0
    for (let i = 0; i < 20; i++) {
      const res = http.get(`${BASE_URL}/discover?q=test&limit=1`)
      if (res.status === 429) blocked++
    }
    check(null, {
      '/discover never rate limited (20 rapid calls)': () => blocked === 0,
    })
    console.log(`  /discover: ${blocked}/20 blocked (expect 0)`)
  })

  // Test 2: Health should NEVER be rate limited (exempt)
  group('Tier: /health exempt', () => {
    let blocked = 0
    for (let i = 0; i < 20; i++) {
      const res = http.get(`${BASE_URL}/health`)
      if (res.status === 429) blocked++
    }
    check(null, {
      '/health never rate limited (20 rapid calls)': () => blocked === 0,
    })
    console.log(`  /health: ${blocked}/20 blocked (expect 0)`)
  })

  // Test 3: /orchestrate should be limited to ~10/min
  group('Tier: /orchestrate limited', () => {
    let got402 = 0
    let got429 = 0
    for (let i = 0; i < 15; i++) {
      const res = http.post(
        `${BASE_URL}/orchestrate`,
        JSON.stringify({ goal: 'rate limit test', budget: 0.01 }),
        { headers: jsonHeaders }
      )
      if (res.status === 402) got402++
      if (res.status === 429) got429++
    }
    check(null, {
      '/orchestrate gets 429 after ~10 calls': () => got429 > 0,
    })
    console.log(`  /orchestrate: ${got402} x 402, ${got429} x 429 out of 15 (expect ~10 + ~5)`)
  })

  console.log('--- Rate Limit Validation Done ---\n')
}

// ── Summary ────────────────────────────────────────────────────
export function handleSummary(data) {
  const lines = [
    '\n════════════════════════════════════════════════',
    '  WasiAI A2A — K6 Load Test v2 Summary',
    '════════════════════════════════════════════════',
    `  Target: ${BASE_URL}`,
    `  Total requests: ${data.metrics.http_reqs?.values?.count || 0}`,
    `  Rate limited (429): ${data.metrics.rate_limited_429?.values?.count || 0}`,
    `  p50 latency: ${(data.metrics.http_req_duration?.values?.['p(50)'] || 0).toFixed(0)}ms`,
    `  p95 latency: ${(data.metrics.http_req_duration?.values?.['p(95)'] || 0).toFixed(0)}ms`,
    `  p99 latency: ${(data.metrics.http_req_duration?.values?.['p(99)'] || 0).toFixed(0)}ms`,
    `  Error rate: ${((data.metrics.errors?.values?.rate || 0) * 100).toFixed(1)}%`,
    '',
    '  Endpoint latency (p95):',
    `    /health:      ${(data.metrics.health_duration?.values?.['p(95)'] || 0).toFixed(0)}ms`,
    `    /discover:    ${(data.metrics.discover_duration?.values?.['p(95)'] || 0).toFixed(0)}ms`,
    `    /orchestrate: ${(data.metrics.orchestrate_402_duration?.values?.['p(95)'] || 0).toFixed(0)}ms`,
    '════════════════════════════════════════════════\n',
  ]
  console.log(lines.join('\n'))

  return {
    stdout: textSummary(data, { indent: '  ', enableColors: true }),
  }
}

import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js'
