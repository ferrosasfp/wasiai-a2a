/**
 * Orchestrate Service — Goal-based multi-agent orchestration
 */

import type { 
  Agent, 
  OrchestrateRequest, 
  OrchestrateResult,
  ComposeStep,
} from '../types'
import { discoveryService } from './discovery'
import { composeService } from './compose'

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

    // Step 2: Plan pipeline (simple strategy for now)
    // TODO: Use LLM to plan optimal pipeline based on goal and available agents
    const { steps, reasoning } = this.planPipeline(
      goal, 
      discovered.agents, 
      budget, 
      maxAgents
    )

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
