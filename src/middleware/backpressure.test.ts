/**
 * Backpressure Tests — WKH-18 Hardening — AC-7
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import Fastify from 'fastify'
import { genReqId, registerRequestIdHook } from './request-id.js'
import { registerErrorBoundary } from './error-boundary.js'
import { createBackpressureHandler, getInFlightCount, resetInFlightCount } from './backpressure.js'

describe('backpressure middleware', () => {
  beforeEach(() => {
    resetInFlightCount()
  })

  it('AC-7: requests within limit are accepted', async () => {
    const app = Fastify({ genReqId })
    registerRequestIdHook(app)
    registerErrorBoundary(app)

    app.post('/test', {
      preHandler: createBackpressureHandler({ max: 5 }),
    }, async () => ({ ok: true }))
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/test',
    })

    expect(response.statusCode).toBe(200)
    await app.close()
  })

  it('AC-7: requests exceeding max get 503 BACKPRESSURE', async () => {
    const resolvers: (() => void)[] = []
    const app = Fastify({ genReqId })
    registerRequestIdHook(app)
    registerErrorBoundary(app)

    app.post('/orchestrate', {
      preHandler: createBackpressureHandler({ max: 2 }),
    }, async () => {
      await new Promise<void>((resolve) => {
        resolvers.push(resolve)
      })
      return { ok: true }
    })
    await app.ready()

    // Fire 2 slow requests (they will block in the handler)
    const p1 = app.inject({ method: 'POST', url: '/orchestrate' })
    const p2 = app.inject({ method: 'POST', url: '/orchestrate' })

    // Wait briefly for preHandlers to execute and increment counter
    await new Promise(r => setTimeout(r, 50))

    // 3rd request should be rejected (counter is at 2)
    const response3 = await app.inject({ method: 'POST', url: '/orchestrate' })

    expect(response3.statusCode).toBe(503)
    const body = response3.json()
    expect(body.code).toBe('BACKPRESSURE')
    expect(body.error).toBe('Service overloaded')
    expect(body.requestId).toBeDefined()

    // Clean up: resolve all slow handlers
    for (const resolve of resolvers) resolve()
    await Promise.allSettled([p1, p2])
    await app.close()
  })

  it('AC-7: getInFlightCount returns current count', () => {
    resetInFlightCount()
    expect(getInFlightCount()).toBe(0)
  })

  it('AC-7: counter decrements after request completes', async () => {
    const app = Fastify({ genReqId })
    registerRequestIdHook(app)
    registerErrorBoundary(app)

    app.post('/test', {
      preHandler: createBackpressureHandler({ max: 10 }),
    }, async () => ({ ok: true }))
    await app.ready()

    resetInFlightCount()
    await app.inject({ method: 'POST', url: '/test' })

    // After completion, counter should be back to 0
    // Note: inject() completes the full request cycle
    expect(getInFlightCount()).toBe(0)
    await app.close()
  })
})
