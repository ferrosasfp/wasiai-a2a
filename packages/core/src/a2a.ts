/**
 * WasiAI A2A Protocol - Main Client
 * 
 * The A2A class is the main entry point for using the protocol.
 * It orchestrates discovery, composition, and payments across
 * any combination of registry and payment adapters.
 */

import type {
  Agent,
  RegistryAdapter,
  PaymentAdapter,
  DiscoveryQuery,
  DiscoveryResult,
  PipelineStep,
  ComposeOptions,
  ComposeResult,
  StepResult,
  PipelineContext,
  OrchestrateRequest,
  OrchestrateResult,
  PaymentAuth,
} from './types'

import {
  A2AError,
  DiscoveryError,
  InvocationError,
  BudgetExceededError,
} from './types'

// ============================================================
// CONFIGURATION
// ============================================================

export interface A2AConfig {
  /** Registry adapter(s) for agent discovery */
  registry: RegistryAdapter | RegistryAdapter[]
  
  /** Payment adapter for settlements */
  payments?: PaymentAdapter
  
  /** Default options for compose operations */
  defaultComposeOptions?: Partial<ComposeOptions>
  
  /** Enable debug logging */
  debug?: boolean
}

// ============================================================
// MAIN CLASS
// ============================================================

export class A2A {
  private registries: RegistryAdapter[]
  private payments?: PaymentAdapter
  private defaultComposeOptions: Partial<ComposeOptions>
  private debug: boolean

  constructor(config: A2AConfig) {
    this.registries = Array.isArray(config.registry) 
      ? config.registry 
      : [config.registry]
    
    this.payments = config.payments
    this.defaultComposeOptions = config.defaultComposeOptions ?? {}
    this.debug = config.debug ?? false
  }

  // ==========================================================
  // DISCOVERY
  // ==========================================================

  /**
   * Discover agents across all configured registries
   */
  async discover(query: DiscoveryQuery): Promise<DiscoveryResult> {
    this.log('discover', query)
    
    const results = await Promise.all(
      this.registries.map(registry => 
        registry.discover(query).catch(err => {
          this.log('discover error', { registry: registry.name, error: err.message })
          return { agents: [], total: 0, query } as DiscoveryResult
        })
      )
    )

    // Merge results from all registries
    const allAgents = results.flatMap(r => r.agents)
    const total = results.reduce((sum, r) => sum + r.total, 0)

    // Sort by reputation (descending) then by price (ascending)
    const sortedAgents = allAgents.sort((a, b) => {
      const repDiff = (b.reputation ?? 0) - (a.reputation ?? 0)
      if (repDiff !== 0) return repDiff
      return a.priceUsdc - b.priceUsdc
    })

    // Apply limit if specified
    const limitedAgents = query.limit 
      ? sortedAgents.slice(0, query.limit)
      : sortedAgents

    return {
      agents: limitedAgents,
      total,
      query,
    }
  }

  /**
   * Get a specific agent by ID or slug
   */
  async getAgent(idOrSlug: string): Promise<Agent | null> {
    this.log('getAgent', idOrSlug)
    
    for (const registry of this.registries) {
      const agent = await registry.getAgent(idOrSlug).catch(() => null)
      if (agent) return agent
    }
    
    return null
  }

  // ==========================================================
  // COMPOSITION
  // ==========================================================

  /**
   * Compose and execute a multi-agent pipeline
   */
  async compose(
    steps: PipelineStep[],
    options?: ComposeOptions
  ): Promise<ComposeResult> {
    const opts = { ...this.defaultComposeOptions, ...options }
    this.log('compose', { steps: steps.length, options: opts })

    const context: PipelineContext = {
      results: {},
      originalInput: steps[0]?.input ?? {},
      totalCostUsdc: 0,
      totalLatencyMs: 0,
    }

    const stepResults: StepResult[] = []
    let lastOutput: unknown = null

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]
      
      // Check condition
      if (step.condition && !step.condition(context)) {
        this.log('step skipped', { index: i, agent: step.agent })
        continue
      }

      // Resolve agent
      const agent = await this.resolveAgent(step.agent)
      if (!agent) {
        const error = new DiscoveryError(`Agent not found: ${step.agent}`)
        if (opts.stopOnError !== false) {
          return this.failedResult(stepResults, context, error)
        }
        continue
      }

      // Check budget
      if (opts.maxBudget && context.totalCostUsdc + agent.priceUsdc > opts.maxBudget) {
        const error = new BudgetExceededError(
          context.totalCostUsdc + agent.priceUsdc,
          opts.maxBudget
        )
        if (opts.stopOnError !== false) {
          return this.failedResult(stepResults, context, error)
        }
        continue
      }

      // Resolve input (handle $prev references)
      const input = this.resolveInput(step.input, context, lastOutput)

      // Dry run - skip actual invocation
      if (opts.dryRun) {
        const mockResult: StepResult = {
          agent,
          output: { dryRun: true },
          costUsdc: agent.priceUsdc,
          latencyMs: agent.avgLatencyMs ?? 0,
        }
        stepResults.push(mockResult)
        context.results[i] = mockResult
        context.totalCostUsdc += agent.priceUsdc
        continue
      }

      // Get payment authorization if available
      let payment: PaymentAuth | undefined
      if (this.payments && agent.metadata?.payeeAddress) {
        payment = await this.payments.authorize(
          agent.metadata.payeeAddress as string,
          agent.priceUsdc,
          agent.name
        )
      }

      // Invoke the agent
      const startTime = Date.now()
      try {
        const registry = this.findRegistryForAgent(agent)
        const result = await registry.invoke(agent, input, payment)
        
        result.latencyMs = Date.now() - startTime
        stepResults.push(result)
        context.results[i] = result
        context.totalCostUsdc += result.costUsdc
        context.totalLatencyMs += result.latencyMs
        
        // Apply transform if specified
        lastOutput = step.transform 
          ? step.transform(result.output)
          : result.output

        this.log('step completed', { 
          index: i, 
          agent: agent.slug, 
          cost: result.costUsdc,
          latency: result.latencyMs 
        })

      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        this.log('step failed', { index: i, agent: agent.slug, error: error.message })
        
        if (opts.stopOnError !== false) {
          return this.failedResult(stepResults, context, error)
        }
      }
    }

    return {
      output: lastOutput,
      steps: stepResults,
      totalCostUsdc: context.totalCostUsdc,
      totalLatencyMs: context.totalLatencyMs,
      success: true,
    }
  }

  // ==========================================================
  // ORCHESTRATION
  // ==========================================================

  /**
   * Orchestrate from a natural language goal
   * 
   * This is the highest-level API. Given a goal and budget,
   * the system discovers relevant agents, composes a pipeline,
   * and returns a synthesized answer.
   */
  async orchestrate(request: OrchestrateRequest): Promise<OrchestrateResult> {
    this.log('orchestrate', request)

    // Step 1: Discover relevant agents
    const discoveryQuery: DiscoveryQuery = {
      query: request.goal,
      capabilities: request.preferCapabilities,
      maxPrice: request.budget / (request.maxAgents ?? 5), // Rough budget per agent
      limit: request.maxAgents ?? 10,
    }

    const discovered = await this.discover(discoveryQuery)
    
    if (discovered.agents.length === 0) {
      throw new DiscoveryError('No agents found for goal', { goal: request.goal })
    }

    // Step 2: Plan the pipeline
    // For now, simple sequential execution
    // TODO: Use LLM to plan optimal pipeline
    const steps = this.planPipeline(discovered.agents, request)

    // Step 3: Execute
    const pipeline = await this.compose(steps, {
      maxBudget: request.budget,
    })

    // Step 4: Synthesize answer
    // TODO: Use LLM to synthesize final answer from step outputs
    const answer = pipeline.output

    return {
      answer,
      pipeline,
      consideredAgents: discovered.agents,
      reasoning: `Selected ${steps.length} agents based on capabilities and budget`,
    }
  }

  // ==========================================================
  // HELPERS
  // ==========================================================

  private async resolveAgent(idOrSlug: string | Agent): Promise<Agent | null> {
    if (typeof idOrSlug === 'object') return idOrSlug
    return this.getAgent(idOrSlug)
  }

  private findRegistryForAgent(agent: Agent): RegistryAdapter {
    const registry = this.registries.find(r => r.name === agent.registry)
    if (!registry) {
      throw new A2AError(
        `Registry not found for agent: ${agent.registry}`,
        'REGISTRY_NOT_FOUND'
      )
    }
    return registry
  }

  private resolveInput(
    input: Record<string, unknown>,
    context: PipelineContext,
    lastOutput: unknown
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {}
    
    for (const [key, value] of Object.entries(input)) {
      if (value === '$prev.output') {
        resolved[key] = lastOutput
      } else if (typeof value === 'string' && value.startsWith('$step.')) {
        const match = value.match(/\$step\.(\d+)\.output/)
        if (match) {
          const stepIndex = parseInt(match[1], 10)
          resolved[key] = context.results[stepIndex]?.output
        } else {
          resolved[key] = value
        }
      } else {
        resolved[key] = value
      }
    }
    
    return resolved
  }

  private planPipeline(agents: Agent[], request: OrchestrateRequest): PipelineStep[] {
    // Simple strategy: use top N agents sequentially
    // Each agent's output becomes context for the next
    const budget = request.budget
    let remaining = budget
    const steps: PipelineStep[] = []

    for (const agent of agents) {
      if (agent.priceUsdc > remaining) continue
      
      steps.push({
        agent: agent.id,
        input: steps.length === 0 
          ? { goal: request.goal, ...(request.context ?? {}) }
          : { input: '$prev.output', goal: request.goal },
      })
      
      remaining -= agent.priceUsdc
      
      if (steps.length >= (request.maxAgents ?? 5)) break
    }

    return steps
  }

  private failedResult(
    steps: StepResult[],
    context: PipelineContext,
    error: Error
  ): ComposeResult {
    return {
      output: null,
      steps,
      totalCostUsdc: context.totalCostUsdc,
      totalLatencyMs: context.totalLatencyMs,
      success: false,
      error,
    }
  }

  private log(event: string, data?: unknown): void {
    if (this.debug) {
      console.log(`[A2A] ${event}`, data ? JSON.stringify(data, null, 2) : '')
    }
  }
}
