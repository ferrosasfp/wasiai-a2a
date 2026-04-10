/**
 * Orchestrate Service — Goal-based multi-agent orchestration with LLM planning
 *
 * WKH-13: Replaces greedy planPipeline with Claude Sonnet LLM planning.
 * Includes: orchestrationId, protocolFeeUsdc, event tracking, timeout, fallback.
 */

import Anthropic from '@anthropic-ai/sdk'
import { anthropicCircuitBreaker, CircuitOpenError } from '../lib/circuit-breaker.js'
import type {
  Agent,
  OrchestrateRequest,
  OrchestrateResult,
  ComposeStep,
  ComposeResult,
} from '../types/index.js'
import { discoveryService } from './discovery.js'
import { composeService } from './compose.js'
import { eventService } from './event.js'

const MODEL = 'claude-sonnet-4-20250514'
const LLM_TIMEOUT_MS = 30_000
const MAX_AGENTS_IN_PROMPT = 10
const PROTOCOL_FEE_RATE = 0.01
const PRE_COMPOSE_TIMEOUT_MS = 90_000

// ─── LLM Planning ───────────────────────────────────────────

interface LlmPlanAgent {
  slug: string
  registry: string
  input: Record<string, unknown>
  reasoning: string
}

interface LlmPlanResponse {
  selectedAgents: LlmPlanAgent[]
  reasoning: string
}

/**
 * Call Claude Sonnet to plan the optimal pipeline for a goal.
 * Returns the LLM plan or null if the call fails (caller handles fallback).
 */
/** Lazily-initialized Anthropic client (singleton for connection reuse) */
let _anthropicClient: Anthropic | null = null
function getAnthropicClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return null
  if (!_anthropicClient) {
    _anthropicClient = new Anthropic({ apiKey })
  }
  return _anthropicClient
}

async function llmPlan(
  goal: string,
  budget: number,
  agents: Agent[],
  maxAgents: number,
): Promise<LlmPlanResponse | null> {
  const client = getAnthropicClient()
  if (!client) {
    console.error('[Orchestrate] ANTHROPIC_API_KEY not configured — using fallback')
    return null
  }

  const agentList = agents.slice(0, MAX_AGENTS_IN_PROMPT).map(a => ({
    slug: a.slug,
    registry: a.registry,
    name: a.name,
    description: a.description,
    capabilities: a.capabilities,
    priceUsdc: a.priceUsdc,
  }))

  const systemPrompt = [
    'You are an expert AI agent orchestrator. Given a user goal, a budget, and a list of available agents, select the optimal agents and generate an execution plan.',
    'Rules:',
    '- Select 1 or more agents (max ' + maxAgents + ') that best accomplish the goal.',
    '- Total cost of selected agents MUST NOT exceed the budget.',
    '- Order agents logically: if outputs of one feed into another, place the producer first.',
    '- For each agent, generate a specific input object with relevant fields based on the goal and agent description.',
    '- If only one agent is needed, select just one.',
    '- Respond ONLY with valid JSON, no markdown.',
  ].join('\n')

  const userPrompt = [
    `Goal: ${JSON.stringify(goal)}`,
    `Budget: ${budget} USDC`,
    `Max agents: ${maxAgents}`,
    '',
    'Available agents:',
    JSON.stringify(agentList, null, 2),
    '',
    'Respond with this JSON:',
    '{',
    '  "selectedAgents": [',
    '    { "slug": "agent-slug", "registry": "registry-name", "input": { "query": "specific input" }, "reasoning": "why selected" }',
    '  ],',
    '  "reasoning": "Overall strategy explanation"',
    '}',
  ].join('\n')

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS)

  try {
    const response = await anthropicCircuitBreaker.execute(() =>
      client.messages.create(
        {
          model: MODEL,
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        },
        { signal: controller.signal },
      ),
    )

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text)
      .join('')
      .trim()

    const parsed = JSON.parse(text) as Record<string, unknown>

    // Validate structure
    const selectedAgents = parsed['selectedAgents']
    if (!Array.isArray(selectedAgents) || selectedAgents.length === 0) {
      console.error('[Orchestrate] LLM returned empty or invalid selectedAgents')
      return null
    }

    const reasoning = typeof parsed['reasoning'] === 'string'
      ? parsed['reasoning']
      : 'LLM plan generated'

    // Runtime validation: each agent must have a string slug
    const validated = selectedAgents.filter(
      (a: Record<string, unknown>) => typeof a?.slug === 'string' && a.slug.length > 0,
    ) as LlmPlanAgent[]

    if (validated.length === 0) {
      console.error('[Orchestrate] LLM returned agents without valid slugs')
      return null
    }

    return {
      selectedAgents: validated,
      reasoning,
    }
  } catch (err) {
    // Let CircuitOpenError propagate to error boundary
    if (err instanceof CircuitOpenError) throw err
    console.error('[Orchestrate] LLM planning failed:', err instanceof Error ? err.message : err)
    return null
  } finally {
    clearTimeout(timeoutId)
  }
}

// ─── Fallback Greedy Planner ─────────────────────────────────

function greedyPlan(
  goal: string,
  agents: Agent[],
  budget: number,
  maxAgents: number,
): { steps: ComposeStep[]; reasoning: string } {
  const selected: Agent[] = []
  let remaining = budget

  for (const agent of agents) {
    if (agent.priceUsdc > remaining) continue
    if (selected.length >= maxAgents) break
    selected.push(agent)
    remaining -= agent.priceUsdc
  }

  const steps: ComposeStep[] = selected.map((agent, index) => ({
    agent: agent.slug,
    registry: agent.registry,
    input: { goal },
    passOutput: index > 0,
  }))

  const reasoning = selected.length > 0
    ? `Selected ${selected.length} agents: ${selected.map(a => a.name).join(', ')}. ` +
      `Total estimated cost: ${selected.reduce((sum, a) => sum + a.priceUsdc, 0).toFixed(4)} USDC.`
    : 'No agents fit within budget.'

  return { steps, reasoning }
}

// ─── Service ─────────────────────────────────────────────────

export const orchestrateService = {
  /**
   * Orchestrate from a natural language goal.
   * Uses LLM planning with fallback to greedy if LLM fails.
   *
   * @param request - The orchestration request
   * @param orchestrationId - UUID generated by the route handler
   */
  async orchestrate(
    request: OrchestrateRequest,
    orchestrationId: string,
  ): Promise<OrchestrateResult> {
    const startTime = Date.now()
    const { goal, budget, preferCapabilities, maxAgents = 5 } = request

    // Step 1: Discover relevant agents
    const discovered = await discoveryService.discover({
      query: goal,
      capabilities: preferCapabilities,
      maxPrice: budget / maxAgents,
      limit: maxAgents * 2,
    })

    // AC5: No agents found — return gracefully
    if (discovered.agents.length === 0) {
      const emptyResult: OrchestrateResult = {
        orchestrationId,
        answer: null,
        reasoning: `No agents found for goal: "${goal}". Try broadening your search or increasing budget.`,
        pipeline: {
          success: true,
          output: null,
          steps: [],
          totalCostUsdc: 0,
          totalLatencyMs: 0,
        },
        consideredAgents: [],
        protocolFeeUsdc: 0,
      }

      // Track no-agents event (fire-and-forget)
      eventService.track({
        eventType: 'orchestrate_goal',
        status: 'success',
        latencyMs: Date.now() - startTime,
        costUsdc: 0,
        goal,
        metadata: { orchestrationId, agentCount: 0, fallback: false },
      }).catch(err => console.error('[Orchestrate] event tracking failed:', err))

      return emptyResult
    }

    // Step 2: LLM Planning (with fallback)
    let steps: ComposeStep[]
    let reasoning: string
    let usedFallback = false

    // AC8: Check if we still have time before compose
    const elapsedMs = Date.now() - startTime
    if (elapsedMs > PRE_COMPOSE_TIMEOUT_MS) {
      throw new Error(
        `Orchestration timeout: discovery took ${elapsedMs}ms (limit: ${PRE_COMPOSE_TIMEOUT_MS}ms)`,
      )
    }

    const plan = await llmPlan(goal, budget, discovered.agents, maxAgents)

    if (plan) {
      // Validate slugs against discovered agents
      const discoveredSlugs = new Set(discovered.agents.map(a => a.slug))
      const validAgents = plan.selectedAgents.filter(a => discoveredSlugs.has(a.slug))

      if (validAgents.length === 0) {
        // All LLM slugs invalid — fallback
        console.error('[Orchestrate] All LLM-selected slugs are invalid — using fallback')
        const fallback = greedyPlan(goal, discovered.agents, budget, maxAgents)
        steps = fallback.steps
        reasoning = `[FALLBACK] LLM selected agents not found in discovery. ${fallback.reasoning}`
        usedFallback = true
      } else {
        // Verify budget
        let totalCost = 0
        const budgetedAgents: LlmPlanAgent[] = []
        for (const a of validAgents) {
          const agent = discovered.agents.find(d => d.slug === a.slug)
          const cost = agent?.priceUsdc ?? 0
          if (totalCost + cost <= budget) {
            budgetedAgents.push(a)
            totalCost += cost
          }
        }

        steps = budgetedAgents.map((a, index) => ({
          agent: a.slug,
          registry: a.registry,
          input: a.input ?? { goal },
          passOutput: index > 0,
        }))

        reasoning = plan.reasoning

        if (validAgents.length > budgetedAgents.length) {
          reasoning += ` (${validAgents.length - budgetedAgents.length} agents truncated due to budget)`
        }
      }
    } else {
      // AC7: LLM failed — fallback to greedy
      const fallback = greedyPlan(goal, discovered.agents, budget, maxAgents)
      steps = fallback.steps
      reasoning = `[FALLBACK] LLM planning failed. ${fallback.reasoning}`
      usedFallback = true
    }

    if (steps.length === 0) {
      // All agents exceed budget — return gracefully
      const noBudgetResult: OrchestrateResult = {
        orchestrationId,
        answer: null,
        reasoning: `No agents fit within budget of ${budget} USDC. Try increasing your budget.`,
        pipeline: {
          success: true,
          output: null,
          steps: [],
          totalCostUsdc: 0,
          totalLatencyMs: 0,
        },
        consideredAgents: discovered.agents,
        protocolFeeUsdc: 0,
      }

      eventService.track({
        eventType: 'orchestrate_goal',
        status: 'success',
        latencyMs: Date.now() - startTime,
        costUsdc: 0,
        goal,
        metadata: { orchestrationId, agentCount: 0, fallback: usedFallback },
      }).catch(err => console.error('[Orchestrate] event tracking failed:', err))

      return noBudgetResult
    }

    // AC8: Check time again before compose
    const preComposeElapsed = Date.now() - startTime
    if (preComposeElapsed > PRE_COMPOSE_TIMEOUT_MS) {
      throw new Error(
        `Orchestration timeout: discovery + planning took ${preComposeElapsed}ms (limit: ${PRE_COMPOSE_TIMEOUT_MS}ms)`,
      )
    }

    // Step 3: Execute pipeline
    const pipeline = await composeService.compose({
      steps,
      maxBudget: budget,
    })

    // Step 4: Calculate protocol fee (display only, not charged)
    const protocolFeeUsdc = Number((pipeline.totalCostUsdc * PROTOCOL_FEE_RATE).toFixed(6))

    const totalLatencyMs = Date.now() - startTime

    // AC6: Track orchestrate_goal event (fire-and-forget)
    eventService.track({
      eventType: 'orchestrate_goal',
      status: pipeline.success ? 'success' : 'failed',
      latencyMs: totalLatencyMs,
      costUsdc: pipeline.totalCostUsdc,
      goal,
      metadata: {
        orchestrationId,
        agentCount: steps.length,
        fallback: usedFallback,
        protocolFeeUsdc,
      },
    }).catch(err => console.error('[Orchestrate] event tracking failed:', err))

    return {
      orchestrationId,
      answer: pipeline.output,
      reasoning,
      pipeline,
      consideredAgents: discovered.agents,
      protocolFeeUsdc,
    }
  },
}
