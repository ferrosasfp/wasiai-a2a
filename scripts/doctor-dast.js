/**
 * Doctor 2: DAST — Dynamic Application Security Testing
 *
 * Tests OWASP Top 10 attack vectors against the live API.
 * Run: k6 run scripts/doctor-dast.js
 * Run with env: k6 run -e BASE_URL=http://localhost:3001 scripts/doctor-dast.js
 */

import http from 'k6/http'
import { check, group } from 'k6'
import { Counter } from 'k6/metrics'

const BASE_URL = __ENV.BASE_URL || 'https://wasiai-a2a-production.up.railway.app'
const json = { 'Content-Type': 'application/json' }
const vulns = new Counter('vulnerabilities_found')

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    vulnerabilities_found: ['count==0'],
  },
}

export default function () {
  // ── A01: Broken Access Control ─────────────────────────
  group('A01: Broken Access Control', () => {
    // Try to access /auth/me without credentials
    const me = http.get(`${BASE_URL}/auth/me`)
    const ok1 = check(me, { 'unauthenticated /me → 403': (r) => r.status === 403 })
    if (!ok1) vulns.add(1)

    // Try to access /auth/me with fake key
    const fake = http.get(`${BASE_URL}/auth/me`, { headers: { 'x-a2a-key': 'fake_key_12345' } })
    const ok2 = check(fake, { 'fake key /me → 403': (r) => r.status === 403 })
    if (!ok2) vulns.add(1)

    // Try path traversal on discover
    const traverse = http.get(`${BASE_URL}/discover/../../../etc/passwd`)
    const ok3 = check(traverse, { 'path traversal → not 200': (r) => r.status !== 200 || !r.body.includes('root:') })
    if (!ok3) vulns.add(1)
  })

  // ── A02: Cryptographic Failures ────────────────────────
  group('A02: Cryptographic Failures', () => {
    // Signup and verify key is properly hashed (key not in /me response)
    const signup = http.post(`${BASE_URL}/auth/agent-signup`,
      JSON.stringify({ owner_ref: `dast-${Date.now()}` }), { headers: json })

    if (signup.status === 201) {
      const body = JSON.parse(signup.body)
      const key = body.key

      // /me should NOT return the raw key
      const me = http.get(`${BASE_URL}/auth/me`, { headers: { 'x-a2a-key': key } })
      if (me.status === 200) {
        const meBody = JSON.parse(me.body)
        const ok = check(null, {
          '/me does not leak raw key': () => !JSON.stringify(meBody).includes(key),
          '/me does not leak key_hash': () => !meBody.key_hash,
        })
        if (!ok) vulns.add(1)
      }
    }
  })

  // ── A03: Injection ─────────────────────────────────────
  group('A03: Injection (SQL, NoSQL, Command)', () => {
    const payloads = [
      "'; DROP TABLE a2a_agent_keys; --",
      '{"$gt": ""}',
      '$(cat /etc/passwd)',
      '`cat /etc/passwd`',
      '<script>alert(1)</script>',
      '{{7*7}}',
      '%00',
    ]

    payloads.forEach((payload, i) => {
      // In query param
      const r1 = http.get(`${BASE_URL}/discover?q=${encodeURIComponent(payload)}`)
      check(r1, {
        [`injection q[${i}] no 500`]: (r) => r.status < 500,
        [`injection q[${i}] no leak`]: (r) => !r.body.includes('/etc/passwd') && !r.body.includes('49'),
      })

      // In JSON body
      const r2 = http.post(`${BASE_URL}/auth/agent-signup`,
        JSON.stringify({ owner_ref: payload }), { headers: json })
      check(r2, {
        [`injection body[${i}] no 500`]: (r) => r.status < 500,
      })
    })
  })

  // ── A04: Insecure Design ───────────────────────────────
  group('A04: Insecure Design — Rate Limit Bypass', () => {
    // Try different IPs via X-Forwarded-For (should be ignored by untrusted proxy)
    const results = []
    for (let i = 0; i < 15; i++) {
      const r = http.post(`${BASE_URL}/orchestrate`,
        JSON.stringify({ goal: 'rate limit bypass test', budget: 0.01 }),
        { headers: { ...json, 'X-Forwarded-For': `10.0.0.${i}` } })
      results.push(r.status)
    }
    const got429 = results.filter(s => s === 429).length
    const ok = check(null, {
      'X-Forwarded-For does not bypass rate limit': () => got429 > 0,
    })
    if (!ok) vulns.add(1)
  })

  // ── A05: Security Misconfiguration ─────────────────────
  group('A05: Security Misconfiguration', () => {
    // Check for debug/stack traces in production error
    const r = http.post(`${BASE_URL}/orchestrate`,
      'not-json', { headers: json })
    const ok1 = check(r, {
      'error response has no stack trace': (r) => !r.body.includes('at ') || !r.body.includes('.ts:'),
    })
    if (!ok1) vulns.add(1)

    // Check no env vars leaked in any response
    const endpoints = ['/health', '/gasless/status', '/.well-known/agent.json', '/discover']
    endpoints.forEach(ep => {
      const r = http.get(`${BASE_URL}${ep}`)
      const ok = check(r, {
        [`${ep} no env leak`]: (r) => !r.body.includes('SUPABASE_SERVICE_KEY') &&
                                      !r.body.includes('OPERATOR_PRIVATE_KEY') &&
                                      !r.body.includes('ANTHROPIC_API_KEY'),
      })
      if (!ok) vulns.add(1)
    })
  })

  // ── A07: Auth Failures ─────────────────────────────────
  group('A07: Authentication Failures', () => {
    // Brute force signup — should be rate limited
    const results = []
    for (let i = 0; i < 10; i++) {
      const r = http.post(`${BASE_URL}/auth/agent-signup`,
        JSON.stringify({ owner_ref: `brute-${i}` }), { headers: json })
      results.push(r.status)
    }
    const got429 = results.filter(s => s === 429).length
    const ok = check(null, {
      'signup rate limited after burst': () => got429 > 0,
    })
    if (!ok) vulns.add(1)

    // JWT/Bearer with empty token
    const r = http.get(`${BASE_URL}/auth/me`, { headers: { 'Authorization': 'Bearer ' } })
    const ok2 = check(r, { 'empty bearer → 403': (r) => r.status === 403 })
    if (!ok2) vulns.add(1)

    // Bearer with non-wasi prefix
    const r2 = http.get(`${BASE_URL}/auth/me`, { headers: { 'Authorization': 'Bearer sk-fake-key-123' } })
    const ok3 = check(r2, { 'non-wasi bearer → 403': (r) => r.status === 403 })
    if (!ok3) vulns.add(1)
  })

  // ── A08: Data Integrity ────────────────────────────────
  group('A08: Data Integrity', () => {
    // Negative budget
    const r1 = http.post(`${BASE_URL}/orchestrate`,
      JSON.stringify({ goal: 'test', budget: -1 }), { headers: json })
    const ok1 = check(r1, { 'negative budget rejected': (r) => r.status === 400 })
    if (!ok1) vulns.add(1)

    // Zero budget
    const r2 = http.post(`${BASE_URL}/orchestrate`,
      JSON.stringify({ goal: 'test', budget: 0 }), { headers: json })
    const ok2 = check(r2, { 'zero budget rejected': (r) => r.status === 400 })
    if (!ok2) vulns.add(1)

    // Huge budget
    const r3 = http.post(`${BASE_URL}/orchestrate`,
      JSON.stringify({ goal: 'test', budget: 999999999 }), { headers: json })
    const ok3 = check(r3, { 'huge budget rejected': (r) => r.status === 400 })
    if (!ok3) vulns.add(1)
  })

  // ── A09: Logging & Monitoring ──────────────────────────
  group('A09: Logging & Monitoring', () => {
    // Dashboard should be accessible (proves monitoring exists)
    const r = http.get(`${BASE_URL}/dashboard/api/stats`)
    check(r, { 'monitoring endpoint exists': (r) => r.status === 200 })
  })
}

export function handleSummary(data) {
  const vulnCount = data.metrics.vulnerabilities_found?.values?.count || 0
  const lines = [
    '\n═══════════════════════════════════════════════',
    '  Doctor 2: DAST — Security Scan Results',
    '═══════════════════════════════════════════════',
    `  Target: ${BASE_URL}`,
    `  Vulnerabilities: ${vulnCount}`,
    `  Verdict: ${vulnCount === 0 ? '✅ PASS' : '❌ FAIL — review findings above'}`,
    '═══════════════════════════════════════════════\n',
  ]
  console.log(lines.join('\n'))
  return { stdout: '' }
}
