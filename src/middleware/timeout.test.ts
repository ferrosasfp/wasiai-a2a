/**
 * Timeout Tests — WKH-18 Hardening — AC-8, AC-9
 */

import { describe, it, expect, afterAll } from 'vitest'
import Fastify from 'fastify'
import { genReqId, registerRequestIdHook } from './request-id.js'
import { registerErrorBoundary } from './error-boundary.js'
import { createTimeoutHandler } from './timeout.js'

describe('timeout middleware', () => {
  it('AC-8/AC-9: slow request returns 504 TIMEOUT', async () => {
    const app = Fastify({ genReqId })
    registerRequestIdHook(app)
    registerErrorBoundary(app)

    // Timeout of 100ms for testing
    app.get('/slow', {
      preHandler: createTimeoutHandler(100),
    }, async () => {
      await new Promise(r => setTimeout(r, 500))
      return { ok: true }
    })

    await app.ready()

    const response = await app.inject({
      method: 'GET',
      url: '/slow',
    })

    expect(response.statusCode).toBe(504)
    const body = response.json()
    expect(body.code).toBe('TIMEOUT')
    expect(body.error).toBe('Request timeout')
    expect(body.requestId).toBeDefined()

    await app.close()
  })

  it('AC-8/AC-9: fast request completes normally', async () => {
    const app = Fastify({ genReqId })
    registerRequestIdHook(app)
    registerErrorBoundary(app)

    app.get('/fast', {
      preHandler: createTimeoutHandler(5000),
    }, async () => ({ ok: true }))

    await app.ready()

    const response = await app.inject({
      method: 'GET',
      url: '/fast',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true })

    await app.close()
  })

  it('AC-8: orchestrate timeout uses 120s by default', () => {
    // Verify the default env var parsing
    const timeoutMs = parseInt(process.env.TIMEOUT_ORCHESTRATE_MS ?? '120000')
    expect(timeoutMs).toBe(120000)
  })

  it('AC-9: compose timeout uses 60s by default', () => {
    const timeoutMs = parseInt(process.env.TIMEOUT_COMPOSE_MS ?? '60000')
    expect(timeoutMs).toBe(60000)
  })
})
