/**
 * Tests for Mock Registry endpoint
 * WKH-32: Verifica que GET /mock-registry/agents funciona correctamente
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify from 'fastify'
import mockRegistryRoutes from '../routes/mock-registry.js'

const fastify = Fastify()

beforeAll(async () => {
  await fastify.register(mockRegistryRoutes, { prefix: '/mock-registry/agents' })
  await fastify.ready()
})

afterAll(async () => {
  await fastify.close()
})

describe('GET /mock-registry/agents', () => {
  it('returns 200 with agents array containing at least 3 agents', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/mock-registry/agents',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{ agents: unknown[] }>()
    expect(body).toHaveProperty('agents')
    expect(Array.isArray(body.agents)).toBe(true)
    expect(body.agents.length).toBeGreaterThanOrEqual(3)
  })

  it('each agent has required fields: id, name, slug, description, tags, price_per_call_usdc', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/mock-registry/agents',
    })

    const { agents } = response.json<{
      agents: Array<{
        id: string
        name: string
        slug: string
        description: string
        tags: string[]
        price_per_call_usdc: number
        reputation_score: number
      }>
    }>()

    for (const agent of agents) {
      expect(agent).toHaveProperty('id')
      expect(agent).toHaveProperty('name')
      expect(agent).toHaveProperty('slug')
      expect(agent).toHaveProperty('description')
      expect(agent).toHaveProperty('tags')
      expect(agent).toHaveProperty('price_per_call_usdc')
      expect(agent).toHaveProperty('reputation_score')
      expect(Array.isArray(agent.tags)).toBe(true)
      expect(typeof agent.price_per_call_usdc).toBe('number')
    }
  })

  it('agents have varied capabilities (tags)', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/mock-registry/agents',
    })

    const { agents } = response.json<{ agents: Array<{ tags: string[] }> }>()

    // Collect all unique tags across all agents
    const allTags = new Set(agents.flatMap((a) => a.tags))
    // Must have at least 3 different capability tags across all agents
    expect(allTags.size).toBeGreaterThanOrEqual(3)
  })

  it('DocuSynth agent is present with correct data', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/mock-registry/agents',
    })

    const { agents } = response.json<{ agents: Array<{ slug: string; name: string }> }>()
    const docusynth = agents.find((a) => a.slug === 'docusynth')
    expect(docusynth).toBeDefined()
    expect(docusynth?.name).toBe('DocuSynth')
  })

  it('LinguaFlow agent is present', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/mock-registry/agents',
    })

    const { agents } = response.json<{ agents: Array<{ slug: string }> }>()
    const linguaflow = agents.find((a) => a.slug === 'linguaflow')
    expect(linguaflow).toBeDefined()
  })

  it('DataPulse agent is present with highest price', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/mock-registry/agents',
    })

    const { agents } = response.json<{
      agents: Array<{ slug: string; price_per_call_usdc: number }>
    }>()
    const datapulse = agents.find((a) => a.slug === 'datapulse')
    expect(datapulse).toBeDefined()
    expect(datapulse?.price_per_call_usdc).toBe(0.05)
  })

  it('filters by q query param', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/mock-registry/agents?q=translation',
    })

    const { agents } = response.json<{ agents: Array<{ slug: string }> }>()
    expect(agents.length).toBeGreaterThanOrEqual(1)
    expect(agents.find((a) => a.slug === 'linguaflow')).toBeDefined()
  })

  it('filters by tag query param', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/mock-registry/agents?tag=analytics',
    })

    const { agents } = response.json<{ agents: Array<{ slug: string }> }>()
    expect(agents.length).toBeGreaterThanOrEqual(1)
    expect(agents.find((a) => a.slug === 'datapulse')).toBeDefined()
  })

  it('respects limit query param', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/mock-registry/agents?limit=1',
    })

    const { agents } = response.json<{ agents: unknown[] }>()
    expect(agents.length).toBe(1)
  })
})
