/**
 * Compose Service — Execute multi-agent pipelines
 */

import type { 
  Agent, 
  ComposeRequest, 
  ComposeResult, 
  ComposeStep, 
  StepResult 
} from '../types/index.js'
import { discoveryService } from './discovery.js'

export const composeService = {
  /**
   * Execute a composed pipeline
   */
  async compose(request: ComposeRequest): Promise<ComposeResult> {
    const { steps, maxBudget } = request
    const results: StepResult[] = []
    let totalCost = 0
    let totalLatency = 0
    let lastOutput: unknown = null

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]

      // Resolve agent
      const agent = await this.resolveAgent(step)
      if (!agent) {
        return {
          success: false,
          output: null,
          steps: results,
          totalCostUsdc: totalCost,
          totalLatencyMs: totalLatency,
          error: `Agent not found: ${step.agent}`,
        }
      }

      // Check budget
      if (maxBudget && totalCost + agent.priceUsdc > maxBudget) {
        return {
          success: false,
          output: null,
          steps: results,
          totalCostUsdc: totalCost,
          totalLatencyMs: totalLatency,
          error: `Budget exceeded: would need ${totalCost + agent.priceUsdc}, max is ${maxBudget}`,
        }
      }

      // Prepare input
      const input = step.passOutput && lastOutput
        ? { ...step.input, previousOutput: lastOutput }
        : step.input

      // Invoke agent
      const startTime = Date.now()
      try {
        const output = await this.invokeAgent(agent, input)
        const latencyMs = Date.now() - startTime

        const result: StepResult = {
          agent,
          output,
          costUsdc: agent.priceUsdc,
          latencyMs,
        }

        results.push(result)
        totalCost += agent.priceUsdc
        totalLatency += latencyMs
        lastOutput = output

      } catch (err) {
        return {
          success: false,
          output: null,
          steps: results,
          totalCostUsdc: totalCost,
          totalLatencyMs: totalLatency,
          error: `Step ${i} failed: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    }

    return {
      success: true,
      output: lastOutput,
      steps: results,
      totalCostUsdc: totalCost,
      totalLatencyMs: totalLatency,
    }
  },

  /**
   * Resolve agent from step
   */
  async resolveAgent(step: ComposeStep): Promise<Agent | null> {
    // Try to get directly by slug
    const agent = await discoveryService.getAgent(step.agent, step.registry)
    if (agent) return agent

    // Try discovery
    const result = await discoveryService.discover({
      query: step.agent,
      limit: 1,
      registry: step.registry,
    })

    return result.agents[0] ?? null
  },

  /**
   * Invoke an agent
   */
  async invokeAgent(agent: Agent, input: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(agent.invokeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // TODO: Add auth header based on registry config
        // TODO: Add x402 payment header for Kite
      },
      body: JSON.stringify({ input }),
    })

    if (!response.ok) {
      throw new Error(`Agent ${agent.slug} returned ${response.status}`)
    }

    const data = await response.json()
    return data.result ?? data
  },
}
