/**
 * Discovery Routes — Search agents across registries
 */

import { Hono } from 'hono'
import { discoveryService } from '../services/discovery'

const app = new Hono()

/**
 * GET /discover
 * Search agents across all registered marketplaces
 * 
 * Query params:
 * - capabilities: comma-separated list of capabilities
 * - q: free text search
 * - maxPrice: maximum price per call in USDC
 * - minReputation: minimum reputation score (0-1)
 * - limit: max results
 * - registry: filter to specific registry
 */
app.get('/', async (c) => {
  const query = c.req.query()
  
  const result = await discoveryService.discover({
    capabilities: query.capabilities?.split(',').map(s => s.trim()),
    query: query.q,
    maxPrice: query.maxPrice ? parseFloat(query.maxPrice) : undefined,
    minReputation: query.minReputation ? parseFloat(query.minReputation) : undefined,
    limit: query.limit ? parseInt(query.limit) : undefined,
    registry: query.registry,
  })

  return c.json(result)
})

/**
 * GET /discover/:slug
 * Get a specific agent by slug
 */
app.get('/:slug', async (c) => {
  const slug = c.req.param('slug')
  const registry = c.req.query('registry')
  
  const agent = await discoveryService.getAgent(slug, registry)
  
  if (!agent) {
    return c.json({ error: 'Agent not found' }, 404)
  }
  
  return c.json(agent)
})

export default app
