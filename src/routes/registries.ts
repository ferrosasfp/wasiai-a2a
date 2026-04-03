/**
 * Registries Routes — CRUD for marketplace registrations
 */

import { Hono } from 'hono'
import { registryService } from '../services/registry.js'

const app = new Hono()

/**
 * GET /registries
 * List all registered marketplaces
 */
app.get('/', (c) => {
  const registries = registryService.list()
  return c.json({
    registries,
    total: registries.length,
  })
})

/**
 * GET /registries/:id
 * Get a specific registry
 */
app.get('/:id', (c) => {
  const id = c.req.param('id')
  const registry = registryService.get(id)
  
  if (!registry) {
    return c.json({ error: 'Registry not found' }, 404)
  }
  
  return c.json(registry)
})

/**
 * POST /registries
 * Register a new marketplace
 */
app.post('/', async (c) => {
  try {
    const body = await c.req.json()
    
    // Validate required fields
    if (!body.name || !body.discoveryEndpoint || !body.invokeEndpoint || !body.schema) {
      return c.json({ 
        error: 'Missing required fields: name, discoveryEndpoint, invokeEndpoint, schema' 
      }, 400)
    }

    const registry = registryService.register({
      name: body.name,
      discoveryEndpoint: body.discoveryEndpoint,
      invokeEndpoint: body.invokeEndpoint,
      agentEndpoint: body.agentEndpoint,
      schema: body.schema,
      auth: body.auth,
      enabled: body.enabled ?? true,
    })

    return c.json(registry, 201)
  } catch (err) {
    return c.json({ 
      error: err instanceof Error ? err.message : 'Failed to register' 
    }, 400)
  }
})

/**
 * PATCH /registries/:id
 * Update a registry
 */
app.patch('/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req.json()
    
    const registry = registryService.update(id, body)
    return c.json(registry)
  } catch (err) {
    return c.json({ 
      error: err instanceof Error ? err.message : 'Failed to update' 
    }, 400)
  }
})

/**
 * DELETE /registries/:id
 * Delete a registry
 */
app.delete('/:id', (c) => {
  try {
    const id = c.req.param('id')
    const deleted = registryService.delete(id)
    
    if (!deleted) {
      return c.json({ error: 'Registry not found' }, 404)
    }
    
    return c.json({ success: true })
  } catch (err) {
    return c.json({ 
      error: err instanceof Error ? err.message : 'Failed to delete' 
    }, 400)
  }
})

export default app
