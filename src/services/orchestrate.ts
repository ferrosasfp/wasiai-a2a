/**
 * Orchestrate Service — Goal-based multi-agent orchestration
 *
 * WKH-13: orchestrationId, structured logs, 120s timeout, protocolFeeUsdc, attestation on-chain.
 */

import type { 
  Agent, 
  OrchestrateRequest, 
  OrchestrateResult,
  ComposeStep,
} from '../types/index.js'
import { discoveryService } from './discovery.js'
import { composeService } from './compose.js'
import { attestOrchestration, computePipelineHash } from '../lib/kite-attestation.js'

// ─── Constants ────────────────────────────────────────────────

const ORCHESTRATION_TIMEOUT_MS = 120_000

// ─── Structured log helper ────────────────────────────────────

function structuredLog(
  orchestrationId: string,
  step: string,
  detail: Record<string, unknown> = {},
): void {
  console.log(JSON.stringify({
    orchestrationId,
    step,
    timestamp: new Date().toISOString(),
    detail,
  }))
}

// ─── Service ─────────────────────────────────────────────────

export const orchestrateService = {
  /**
   * Orchestrate from a natural language goal.
   * Wraps the pipeline in a 120s timeout.
   */
  async orchestrate(request: OrchestrateRequest): Promise<OrchestrateResult> {
    const orchestrationId = crypto.randomUUID()

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(Object.assign(new Error('Orchestration timeout: exceeded 120s'), { code: 'ORCHESTRATION_TIMEOUT' })),
        ORCHESTRATION_TIMEOUT_MS,
      ),
    )

    return Promise.race([
      this._runPipeline(orchestrationId, request),
      timeoutPromise,
    ])
  },

  /**
   * Internal: runs the full orchestration pipeline.
   * Extracted for testability and clean timeout wrapping.
   */
  async _runPipeline(
    orchestrationId: string,
    request: OrchestrateRequest,
  ): Promise<OrchestrateResult> {
    const { goal, budget, preferCapabilities, maxAgents = 5 } = request

    // ── Step 1: Discover ────────────────────────────────────
    structuredLog(orchestrationId, 'discover', { query: goal })

    const discovered = await discoveryService.discover({
      query: goal,
      capabilities: preferCapabilities,
      maxPrice: budget / maxAgents,
      limit: maxAgents * 2,
    })

    if (discovered.agents.length === 0) {
      throw new Error(`No agents found for goal: ${goal}`)
    }

    structuredLog(orchestrationId, 'discover-done', { agentsFound: discovered.agents.length })

    // ── Step 2: Plan ─────────────────────────────────────────
    structuredLog(orchestrationId, 'plan', { strategy: process.env.ANTHROPIC_API_KEY ? 'llm' : 'price' })

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
        if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'MISSING_CAPABILITIES') {
          throw err
        }
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

    structuredLog(orchestrationId, 'plan-done', { stepsCount: steps.length, reasoning: reasoning.slice(0, 120) })

    // ── Step 3: Compose ──────────────────────────────────────
    structuredLog(orchestrationId, 'compose', { stepsCount: steps.length })

    const pipeline = await composeService.compose({
      steps,
      maxBudget: budget,
    })

    const protocolFeeUsdc = pipeline.totalCostUsdc * 0.01

    structuredLog(orchestrationId, 'compose-done', {
      totalCostUsdc: pipeline.totalCostUsdc,
      protocolFeeUsdc,
      success: pipeline.success,
    })

    // ── Step 4: Attest ───────────────────────────────────────
    const pipelineHash = computePipelineHash({ steps: pipeline.steps, totalCostUsdc: pipeline.totalCostUsdc })
    structuredLog(orchestrationId, 'attest', { pipelineHash })

    const attestationTxHash = (await attestOrchestration(orchestrationId, pipelineHash)) ?? undefined

    structuredLog(orchestrationId, 'done', {
      totalCostUsdc: pipeline.totalCostUsdc,
      protocolFeeUsdc,
      attestationTxHash: attestationTxHash ?? null,
    })

    // ── Result ───────────────────────────────────────────────
    return {
      orchestrationId,
      answer: pipeline.output,
      reasoning,
      steps: pipeline.steps,
      totalCostUsdc: pipeline.totalCostUsdc,
      protocolFeeUsdc,
      attestationTxHash,
      consideredAgents: discovered.agents,
    }
  },

  /**
   * Plan a pipeline from available agents (price-based fallback)
   */
  planPipeline(
    goal: string, 
    agents: Agent[], 
    budget: number, 
    maxAgents: number
  ): { steps: ComposeStep[], reasoning: string } {
    const selectedAgents: Agent[] = []
    let remainingBudget = budget

    for (const agent of agents) {
      if (agent.priceUsdc > remainingBudget) continue
      if (selectedAgents.length >= maxAgents) break

      selectedAgents.push(agent)
      remainingBudget -= agent.priceUsdc
    }

    if (selectedAgents.length === 0) {
      throw new Error(`No agents fit within budget: ${budget} USDC`)
    }

    const steps: ComposeStep[] = selectedAgents.map((agent, index) => ({
      agent: agent.slug,
      registry: agent.registry,
      input: { goal },
      passOutput: index > 0,
    }))

    const reasoning = `Selected ${selectedAgents.length} agents based on relevance to goal and budget constraints. ` +
      `Agents: ${selectedAgents.map(a => a.name).join(', ')}. ` +
      `Total estimated cost: ${selectedAgents.reduce((sum, a) => sum + a.priceUsdc, 0).toFixed(4)} USDC.`

    return { steps, reasoning }
  },
}
