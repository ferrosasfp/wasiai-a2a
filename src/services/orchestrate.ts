/**
 * Orchestrate Service — Goal-based multi-agent orchestration
 */

import type { 
  Agent, 
  OrchestrateRequest, 
  OrchestrateResult,
  ComposeStep,
} from '../types/index.js'
import { discoveryService } from './discovery.js'
import { composeService } from './compose.js'

export const orchestrateService = {
  /**
   * Orchestrate from a natural language goal
   */
  async orchestrate(request: OrchestrateRequest): Promise<OrchestrateResult> {
    const { goal, budget, preferCapabilities, maxAgents = 5 } = request

    // Step 1: Discover relevant agents
    const discovered = await discoveryService.discover({
      query: goal,
      capabilities: preferCapabilities,
      maxPrice: budget / maxAgents,  // Rough per-agent budget
      limit: maxAgents * 2,  // Get more than needed for selection
    })

    if (discovered.agents.length === 0) {
      throw new Error(`No agents found for goal: ${goal}`)
    }

    // Step 2: Plan pipeline — LLM con fallback a precio
    let steps: ComposeStep[]
    let reasoning: string

    const useLLM = !!process.env.ANTHROPIC_API_KEY
    if (useLLM) {
      try {
        const { planOrchestration } = await import('./llm/planner.js')
        const result = await planOrchestration(goal, discovered.agents, budget, maxAgents)

        if ('error' in result && result.error === 'missing_capabilities') {
          throw Object.assign(new Error('Cannot build pipeline: missing capabilities'), {
            code: 'MISSING_CAPABILITIES',
            missingCapabilities: result.missingCapabilities,
          })
        }

        const planSuccess = result as { steps: ComposeStep[]; reasoning: string }
        steps = planSuccess.steps
        reasoning = planSuccess.reasoning
      } catch (err: unknown) {
        // Propagar errores de capacidades faltantes
        if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'MISSING_CAPABILITIES') {
          throw err
        }
        // Fallback silencioso para errores técnicos
        console.warn('[Orchestrate] LLM planner failed, falling back to price strategy:', (err as Error).message)
        const fallback = this.planPipeline(goal, discovered.agents, budget, maxAgents)
        steps = fallback.steps
        reasoning = fallback.reasoning
      }
    } else {
      const fallback = this.planPipeline(goal, discovered.agents, budget, maxAgents)
      steps = fallback.steps
      reasoning = fallback.reasoning
    }

    // Step 3: Execute pipeline
    const pipeline = await composeService.compose({
      steps,
      maxBudget: budget,
    })

    // Step 4: Return result
    return {
      answer: pipeline.output,
      reasoning,
      pipeline,
      consideredAgents: discovered.agents,
    }
  },

  /**
   * Plan a pipeline from available agents
   * 
   * Simple strategy: select top N agents within budget
   * TODO: Replace with LLM-based planning
   */
  planPipeline(
    goal: string, 
    agents: Agent[], 
    budget: number, 
    maxAgents: number
  ): { steps: ComposeStep[], reasoning: string } {
    const selectedAgents: Agent[] = []
    let remainingBudget = budget

    // Select agents that fit budget
    for (const agent of agents) {
      if (agent.priceUsdc > remainingBudget) continue
      if (selectedAgents.length >= maxAgents) break

      selectedAgents.push(agent)
      remainingBudget -= agent.priceUsdc
    }

    if (selectedAgents.length === 0) {
      throw new Error(`No agents fit within budget: ${budget} USDC`)
    }

    // Create steps
    const steps: ComposeStep[] = selectedAgents.map((agent, index) => ({
      agent: agent.slug,
      registry: agent.registry,
      input: index === 0 
        ? { goal } 
        : { goal },  // Each step gets the original goal
      passOutput: index > 0,  // Pass output from previous step
    }))

    const reasoning = `Selected ${selectedAgents.length} agents based on relevance to goal and budget constraints. ` +
      `Agents: ${selectedAgents.map(a => a.name).join(', ')}. ` +
      `Total estimated cost: ${selectedAgents.reduce((sum, a) => sum + a.priceUsdc, 0).toFixed(4)} USDC.`

    return { steps, reasoning }
  },
}
