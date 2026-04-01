/**
 * Orchestrate Routes — Goal-based orchestration
 */

import { Hono } from 'hono'
import { orchestrateService } from '../services/orchestrate'

const app = new Hono()

/**
 * POST /orchestrate
 * Execute goal-based orchestration
 * 
 * Body:
 * {
 *   "goal": "Analyze token 0xABC and tell me if it's safe to buy",
 *   "budget": 0.50,
 *   "preferCapabilities": ["token-analysis", "risk-assessment"],
 *   "maxAgents": 3
 * }
 */
app.post('/', async (c) => {
  try {
    const body = await c.req.json()
    
    if (!body.goal) {
      return c.json({ error: 'Missing required field: goal' }, 400)
    }

    if (!body.budget || body.budget <= 0) {
      return c.json({ error: 'Missing or invalid budget' }, 400)
    }

    const result = await orchestrateService.orchestrate({
      goal: body.goal,
      budget: body.budget,
      preferCapabilities: body.preferCapabilities,
      maxAgents: body.maxAgents,
    })

    return c.json(result)
  } catch (err) {
    return c.json({ 
      error: err instanceof Error ? err.message : 'Orchestration failed' 
    }, 500)
  }
})

export default app
