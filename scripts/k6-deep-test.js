/**
 * WasiAI A2A — K6 Deep Load Test
 *
 * Comprehensive test: stress, soak, per-endpoint profiling, auth flow, breaking point.
 * Run: k6 run scripts/k6-deep-test.js
 * Run specific scenario: k6 run -e SCENARIO=stress scripts/k6-deep-test.js
 */

import http from 'k6/http'
import { check, group, sleep } from 'k6'
import { Rate, Trend, Counter, Gauge } from 'k6/metrics'

// ── Config ─────────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || 'https://wasiai-a2a-production.up.railway.app'

// Custom metrics per endpoint
const m = {
  errors: new Rate('errors'),
  rateLimited: new Counter('rate_limited_429'),
  backpressure503: new Counter('backpressure_503'),
  serverErrors: new Counter('server_errors_5xx'),

  // Per-endpoint latency
  healthP95: new Trend('ep_health', true),
  discoverGetP95: new Trend('ep_discover_get', true),
  discoverPostP95: new Trend('ep_discover_post', true),
  orchestrate402P95: new Trend('ep_orchestrate_402', true),
  agentCardP95: new Trend('ep_agent_card', true),
  gaslessP95: new Trend('ep_gasless_status', true),
  dashboardP95: new Trend('ep_dashboard', true),
  dashStatsP95: new Trend('ep_dashboard_stats', true),
  signupP95: new Trend('ep_auth_signup', true),
  authMeP95: new Trend('ep_auth_me', true),

  // Concurrency tracking
  peakVUs: new Gauge('peak_vus'),
}

// ── Scenarios ──────────────────────────────────────────────────
export const options = {
  scenarios: {
    // Phase 1: Warm up + per-endpoint profiling (1 VU, serial)
    profile: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 3,
      exec: 'profileEndpoints',
      startTime: '0s',
    },

    // Phase 2: Sustained load (ramp to 15 VUs, hold 2 min)
    sustained: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '15s', target: 5 },
        { duration: '15s', target: 15 },
        { duration: '120s', target: 15 },   // hold 2 min at 15 VUs
        { duration: '15s', target: 0 },
      ],
      exec: 'sustainedLoad',
      startTime: '15s',
    },

    // Phase 3: Stress — find breaking point (ramp to 40 VUs)
    stress: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 10 },
        { duration: '10s', target: 20 },
        { duration: '10s', target: 30 },
        { duration: '10s', target: 40 },   // push to 40
        { duration: '20s', target: 40 },   // hold at 40
        { duration: '10s', target: 0 },
      ],
      exec: 'stressTest',
      startTime: '185s',
    },

    // Phase 4: Auth flow E2E (signup → me → discover with key)
    authFlow: {
      executor: 'per-vu-iterations',
      vus: 3,
      iterations: 2,
      exec: 'authFlowTest',
      startTime: '260s',
    },

    // Phase 5: Discovery deep — various query combinations
    discoveryDeep: {
      executor: 'constant-vus',
      vus: 5,
      duration: '30s',
      exec: 'discoveryDeepTest',
      startTime: '275s',
    },

    // Phase 6: Spike recovery — spike then check recovery time
    spikeRecovery: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '3s', target: 30 },    // instant spike
        { duration: '5s', target: 30 },    // hold spike
        { duration: '2s', target: 0 },     // drop
        { duration: '10s', target: 1 },    // recovery — is latency back to normal?
      ],
      exec: 'spikeRecoveryTest',
      startTime: '310s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<5000'],     // relaxed for stress
    ep_health: ['p(95)<200'],
    ep_discover_get: ['p(95)<500'],
    ep_orchestrate_402: ['p(95)<300'],
    errors: ['rate<0.20'],                 // stress may push errors up
  },
}

// ── Helpers ────────────────────────────────────────────────────
const json = { 'Content-Type': 'application/json' }

function track(res, metric) {
  if (metric) metric.add(res.timings.duration)
  if (res.status === 429) m.rateLimited.add(1)
  if (res.status === 503) m.backpressure503.add(1)
  if (res.status >= 500 && res.status !== 503) m.serverErrors.add(1)
  return res
}

function expectStatus(res, name, expected) {
  const ok = check(res, {
    [`${name} → ${expected}`]: (r) => r.status === expected,
  })
  m.errors.add(!ok)
  return ok
}

// ── Phase 1: Per-endpoint Profiling ────────────────────────────
export function profileEndpoints() {
  group('Profile: Health', () => {
    const r = track(http.get(`${BASE_URL}/health`), m.healthP95)
    expectStatus(r, '/health', 200)
  })

  group('Profile: Root', () => {
    const r = track(http.get(`${BASE_URL}/`), null)
    expectStatus(r, '/', 200)
  })

  group('Profile: Agent Card', () => {
    const r = track(http.get(`${BASE_URL}/.well-known/agent.json`), m.agentCardP95)
    expectStatus(r, '/agent.json', 200)
  })

  group('Profile: Gasless Status', () => {
    const r = track(http.get(`${BASE_URL}/gasless/status`), m.gaslessP95)
    expectStatus(r, '/gasless/status', 200)
  })

  group('Profile: Dashboard', () => {
    const r = track(http.get(`${BASE_URL}/dashboard`), m.dashboardP95)
    check(r, { '/dashboard 2xx': (r) => r.status >= 200 && r.status < 400 })
  })

  group('Profile: Dashboard Stats', () => {
    const r = track(http.get(`${BASE_URL}/dashboard/api/stats`), m.dashStatsP95)
    expectStatus(r, '/dashboard/api/stats', 200)
  })

  group('Profile: GET /discover', () => {
    const r = track(http.get(`${BASE_URL}/discover?q=price&limit=5`), m.discoverGetP95)
    expectStatus(r, 'GET /discover', 200)
  })

  group('Profile: POST /discover', () => {
    const r = track(
      http.post(`${BASE_URL}/discover`, JSON.stringify({ capabilities: ['defi'], limit: 3 }), { headers: json }),
      m.discoverPostP95,
    )
    expectStatus(r, 'POST /discover', 200)
  })

  group('Profile: POST /orchestrate (402)', () => {
    const r = track(
      http.post(`${BASE_URL}/orchestrate`, JSON.stringify({ goal: 'test', budget: 0.01 }), { headers: json }),
      m.orchestrate402P95,
    )
    // Accept 402 or 429 (rate limited)
    check(r, { '/orchestrate 402|429': (r) => r.status === 402 || r.status === 429 })
  })

  sleep(0.5)
}

// ── Phase 2: Sustained Load ────────────────────────────────────
export function sustainedLoad() {
  m.peakVUs.add(__VU)

  // Mix of endpoints simulating real traffic pattern:
  // 50% discovery, 20% health/status, 20% orchestrate attempt, 10% dashboard
  const roll = Math.random()

  if (roll < 0.50) {
    // Discovery — most common
    if (Math.random() < 0.5) {
      const r = track(http.get(`${BASE_URL}/discover?q=agent&limit=5`), m.discoverGetP95)
      expectStatus(r, 'GET /discover', 200)
    } else {
      const caps = ['defi', 'nlp', 'data', 'price', 'trading'][Math.floor(Math.random() * 5)]
      const r = track(
        http.post(`${BASE_URL}/discover`, JSON.stringify({ capabilities: [caps], limit: 3 }), { headers: json }),
        m.discoverPostP95,
      )
      expectStatus(r, 'POST /discover', 200)
    }
  } else if (roll < 0.70) {
    // Health + status checks
    const endpoints = ['/health', '/gasless/status', '/.well-known/agent.json']
    const ep = endpoints[Math.floor(Math.random() * endpoints.length)]
    const r = track(http.get(`${BASE_URL}${ep}`), m.healthP95)
    expectStatus(r, `GET ${ep}`, 200)
  } else if (roll < 0.90) {
    // Orchestrate (expect 402 or 429)
    const r = track(
      http.post(`${BASE_URL}/orchestrate`, JSON.stringify({ goal: 'Find a DeFi price oracle', budget: 0.10 }), { headers: json }),
      m.orchestrate402P95,
    )
    check(r, { 'orchestrate 402|429': (r) => r.status === 402 || r.status === 429 })
  } else {
    // Dashboard
    const r = track(http.get(`${BASE_URL}/dashboard/api/stats`), m.dashStatsP95)
    expectStatus(r, '/dashboard/api/stats', 200)
  }

  sleep(0.3 + Math.random() * 0.4) // 300-700ms think time
}

// ── Phase 3: Stress Test ───────────────────────────────────────
export function stressTest() {
  m.peakVUs.add(__VU)

  // Hammer mix — heavier than sustained
  const responses = http.batch([
    ['GET', `${BASE_URL}/health`],
    ['GET', `${BASE_URL}/discover?q=stress&limit=3`],
    ['GET', `${BASE_URL}/gasless/status`],
  ])

  responses.forEach((r) => track(r, null))

  check(responses[0], { 'stress /health 200': (r) => r.status === 200 })
  check(responses[1], { 'stress /discover 200': (r) => r.status === 200 })
  check(responses[2], { 'stress /gasless 200': (r) => r.status === 200 })

  // Also try orchestrate under stress
  const orch = track(
    http.post(`${BASE_URL}/orchestrate`, JSON.stringify({ goal: 'stress test', budget: 0.01 }), { headers: json }),
    m.orchestrate402P95,
  )
  check(orch, { 'stress orchestrate 402|429|503': (r) => [402, 429, 503].includes(r.status) })

  sleep(0.1)
}

// ── Phase 4: Auth Flow E2E ─────────────────────────────────────
export function authFlowTest() {
  const ownerRef = `k6-load-test-${__VU}-${__ITER}-${Date.now()}`

  group('Auth: Signup', () => {
    const r = track(
      http.post(
        `${BASE_URL}/auth/agent-signup`,
        JSON.stringify({ owner_ref: ownerRef, display_name: `K6 Test Agent ${__VU}` }),
        { headers: json },
      ),
      m.signupP95,
    )

    if (r.status === 201) {
      const body = JSON.parse(r.body)
      check(r, {
        'signup returns key': () => body.key && body.key.startsWith('wasi_a2a_'),
        'signup returns key_id': () => !!body.key_id,
      })

      // Use the key for /auth/me
      const key = body.key
      group('Auth: /me with key', () => {
        const me = track(
          http.get(`${BASE_URL}/auth/me`, { headers: { 'x-a2a-key': key } }),
          m.authMeP95,
        )
        check(me, {
          '/me returns 200': (r) => r.status === 200,
          '/me has display_name': (r) => {
            try { return JSON.parse(r.body).display_name === `K6 Test Agent ${__VU}` } catch { return false }
          },
        })
      })

      // Test Bearer auth
      group('Auth: /me with Bearer', () => {
        const me = track(
          http.get(`${BASE_URL}/auth/me`, { headers: { 'Authorization': `Bearer ${key}` } }),
          m.authMeP95,
        )
        check(me, {
          '/me Bearer returns 200': (r) => r.status === 200,
        })
      })
    } else if (r.status === 429) {
      // Rate limited signup — expected under load
      m.rateLimited.add(1)
    } else {
      m.errors.add(true)
    }
  })

  sleep(1)
}

// ── Phase 5: Discovery Deep ────────────────────────────────────
export function discoveryDeepTest() {
  const queries = [
    { q: 'price oracle', caps: ['defi'] },
    { q: 'sentiment analysis', caps: ['nlp'] },
    { q: 'data pipeline', caps: ['data'] },
    { q: 'trading bot', caps: ['trading', 'defi'] },
    { q: '', caps: [] },  // empty query — should return all
    { q: 'a'.repeat(100), caps: [] },  // long query
  ]

  const query = queries[Math.floor(Math.random() * queries.length)]

  // GET variant
  group('Discovery: GET with params', () => {
    let url = `${BASE_URL}/discover?limit=10`
    if (query.q) url += `&q=${encodeURIComponent(query.q)}`
    if (query.caps.length) url += `&capabilities=${query.caps.join(',')}`

    const r = track(http.get(url), m.discoverGetP95)
    check(r, {
      'discover GET 200': (r) => r.status === 200,
      'discover returns agents array': (r) => {
        try { return Array.isArray(JSON.parse(r.body).agents) } catch { return false }
      },
    })
  })

  // POST variant
  group('Discovery: POST with body', () => {
    const body = { limit: 10 }
    if (query.q) body.query = query.q
    if (query.caps.length) body.capabilities = query.caps

    const r = track(
      http.post(`${BASE_URL}/discover`, JSON.stringify(body), { headers: json }),
      m.discoverPostP95,
    )
    check(r, {
      'discover POST 200': (r) => r.status === 200,
      'discover POST has total': (r) => {
        try { return typeof JSON.parse(r.body).total === 'number' } catch { return false }
      },
    })
  })

  // Edge: discover specific slug
  group('Discovery: by slug', () => {
    const r = track(http.get(`${BASE_URL}/discover/nonexistent-agent`), null)
    check(r, { 'discover slug 404': (r) => r.status === 404 })
  })

  sleep(0.3)
}

// ── Phase 6: Spike Recovery ────────────────────────────────────
export function spikeRecoveryTest() {
  m.peakVUs.add(__VU)

  const r = track(http.get(`${BASE_URL}/health`), m.healthP95)
  check(r, { 'spike-recovery /health 200': (r) => r.status === 200 })

  const d = track(http.get(`${BASE_URL}/discover?q=test&limit=1`), m.discoverGetP95)
  check(d, { 'spike-recovery /discover 200': (r) => r.status === 200 })

  sleep(0.1)
}

// ── Summary ────────────────────────────────────────────────────
export function handleSummary(data) {
  const g = (key) => data.metrics[key]?.values || {}

  const lines = [
    '',
    '╔═══════════════════════════════════════════════════════════════╗',
    '║        WasiAI A2A — K6 Deep Load Test Results                ║',
    '╠═══════════════════════════════════════════════════════════════╣',
    `║  Target:     ${BASE_URL}`,
    `║  Duration:   ${((data.state?.testRunDurationMs || 0) / 1000).toFixed(0)}s`,
    `║  Requests:   ${g('http_reqs').count || 0}  (${(g('http_reqs').rate || 0).toFixed(1)} req/s)`,
    `║  Errors:     ${((g('errors').rate || 0) * 100).toFixed(2)}%`,
    `║  429s:       ${g('rate_limited_429').count || 0}`,
    `║  503s:       ${g('backpressure_503').count || 0}`,
    `║  5xx:        ${g('server_errors_5xx').count || 0}`,
    '╠═══════════════════════════════════════════════════════════════╣',
    '║  LATENCY (ms)          p50      p90      p95      p99   max ║',
    '╠═══════════════════════════════════════════════════════════════╣',
    fmtRow('Global',          g('http_req_duration')),
    fmtRow('/health',         g('ep_health')),
    fmtRow('GET /discover',   g('ep_discover_get')),
    fmtRow('POST /discover',  g('ep_discover_post')),
    fmtRow('/orchestrate',    g('ep_orchestrate_402')),
    fmtRow('/agent.json',     g('ep_agent_card')),
    fmtRow('/gasless/status', g('ep_gasless_status')),
    fmtRow('/dashboard',      g('ep_dashboard')),
    fmtRow('/dashboard/stats',g('ep_dashboard_stats')),
    fmtRow('/auth/signup',    g('ep_auth_signup')),
    fmtRow('/auth/me',        g('ep_auth_me')),
    '╠═══════════════════════════════════════════════════════════════╣',
    '║  THRESHOLDS                                                  ║',
    '╠═══════════════════════════════════════════════════════════════╣',
  ]

  for (const [name, th] of Object.entries(data.metrics)) {
    if (th.thresholds) {
      for (const [rule, passed] of Object.entries(th.thresholds)) {
        lines.push(`║  ${passed.ok ? '✅' : '❌'} ${name}: ${rule}`)
      }
    }
  }

  lines.push('╚═══════════════════════════════════════════════════════════════╝')
  lines.push('')

  console.log(lines.join('\n'))

  return {
    stdout: textSummary(data, { indent: '  ', enableColors: true }),
  }
}

function fmtRow(name, vals) {
  if (!vals || !vals['p(50)']) return `║  ${name.padEnd(18)} (no data)`
  const p = (k) => (vals[k] || 0).toFixed(0).padStart(7)
  return `║  ${name.padEnd(18)} ${p('p(50)')} ${p('p(90)')} ${p('p(95)')} ${p('p(99)')} ${p('max')}`
}

import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js'
