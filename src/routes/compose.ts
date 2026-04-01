/**
 * Compose Routes — Multi-agent pipelines
 */

import { Hono } from 'hono'
import { composeService } from '../services/compose'

const app = new Hono()

/**
 * POST /compose
 * Execute a multi-agent pipeline
 * 
 * Body:
 * {
 *   "steps": [
 *     { "agent": "agent-slug", "registry": "wasiai", "input": {...}, "passOutput": false },
 *     { "agent": "another-agent", "input": {...}, "passOutput": true }
 *   ],
 *   "maxBudget": 0.50
 * }
 */
app.post('/', async (c) => {
  try {
    const body = await c.req.json()
    
    if (!body.steps || !Array.isArray(body.steps) || body.steps.length === 0) {
      return c.json({ error: 'Missing or empty steps array' }, 400)
    }

    if (body.steps.length > 5) {
      return c.json({ error: 'Maximum 5 steps allowed per pipeline' }, 400)
    }

    const result = await composeService.compose({
      steps: body.steps,
      maxBudget: body.maxBudget,
    })

    if (!result.success) {
      return c.json(result, 400)
    }

    return c.json(result)
  } catch (err) {
    return c.json({ 
      error: err instanceof Error ? err.message : 'Compose failed' 
    }, 500)
  }
})

export default app
