/**
 * Compose Service — Execute multi-agent pipelines
 */

import type {
  Agent,
  ComposeRequest,
  ComposeResult,
  ComposeStep,
  StepResult,
  RegistryConfig,
  X402PaymentRequest,
} from '../types/index.js'
import { discoveryService } from './discovery.js'
import { registryService } from './registry.js'
import { signX402Authorization } from '../lib/x402-signer.js'
import { settlePayment } from '../middleware/x402.js'
import { maybeTransform } from './llm/transform.js'
import { eventService } from './event.js'

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Construye headers de autenticación basados en el RegistryConfig.
 * Patrón extraído de discovery.ts:queryRegistry.
 */
function buildAuthHeaders(registry: RegistryConfig | undefined): Record<string, string> {
  const headers: Record<string, string> = {}

  if (!registry?.auth?.value) return headers

  switch (registry.auth.type) {
    case 'header':
      headers[registry.auth.key] = registry.auth.value
      break
    case 'bearer':
      headers['Authorization'] = `Bearer ${registry.auth.value}`
      break
    // 'query' no aplica a POST invocations — skip
  }

  return headers
}

// ─── Service ─────────────────────────────────────────────────

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
        const { output, txHash } = await this.invokeAgent(agent, input)
        const latencyMs = Date.now() - startTime

        const result: StepResult = {
          agent,
          output,
          costUsdc: agent.priceUsdc,
          latencyMs,
          txHash,
        }

        results.push(result)

        // Track event (fire-and-forget) — WKH-27
        eventService.track({
          eventType: 'compose_step',
          agentId: agent.slug,
          agentName: agent.name,
          registry: agent.registry,
          status: 'success',
          latencyMs,
          costUsdc: agent.priceUsdc,
          txHash,
        }).catch(err => console.error('[Compose] event tracking failed:', err))

        totalCost += agent.priceUsdc
        totalLatency += latencyMs
        lastOutput = output

        // Schema transform — if there's a next step with inputSchema
        if (i < steps.length - 1) {
          const nextStep = steps[i + 1]
          const nextAgent = await this.resolveAgent(nextStep)
          const inputSchema = nextAgent?.metadata?.inputSchema as Record<string, unknown> | undefined
          if (inputSchema) {
            try {
              const tr = await maybeTransform(
                agent.id,
                nextAgent!.id,
                lastOutput,
                inputSchema,
              )
              result.cacheHit = tr.cacheHit
              result.transformLatencyMs = tr.latencyMs
              lastOutput = tr.transformedOutput
            } catch (transformErr) {
              console.error(`[Compose] Transform failed at step ${i}:`, transformErr)
              // Non-blocking: pass output as-is if transform fails
            }
          }
        }

      } catch (err) {
        // Track failed event (fire-and-forget) — WKH-27
        eventService.track({
          eventType: 'compose_step',
          agentId: agent?.slug,
          agentName: agent?.name,
          registry: agent?.registry,
          status: 'failed',
          latencyMs: Date.now() - startTime,
          costUsdc: 0,
        }).catch(trackErr => console.error('[Compose] event tracking failed:', trackErr))

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
   * Invoke an agent with auth headers + x402 payment
   */
  async invokeAgent(
    agent: Agent,
    input: Record<string, unknown>,
  ): Promise<{ output: unknown; txHash?: string }> {
    // 1. Resolver RegistryConfig (CD-2)
    const registries = await registryService.getEnabled()
    const registry = registries.find((r: RegistryConfig) => r.name === agent.registry)

    // 2. Auth headers
    const authHeaders = buildAuthHeaders(registry)

    // 3. Build headers
    let paymentRequest: X402PaymentRequest | undefined
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...authHeaders,
    }

    // 4. x402 payment header (proactive, sin roundtrip 402)
    if (agent.priceUsdc > 0) {
      // CD-9: payTo MUST come from agent.metadata — NO fallback
      const payTo = agent.metadata?.payTo as string | undefined
      if (!payTo) {
        throw new Error(
          `No payTo address for agent ${agent.slug} — agent metadata must include payTo`,
        )
      }

      // USDC → wei (6 decimals USDC × 1e12 = 18 decimals wei) (CD-8)
      const valueWei = String(BigInt(Math.round(agent.priceUsdc * 1e6)) * BigInt(1e12))

      const result = await signX402Authorization({
        to: payTo as `0x${string}`,
        value: valueWei,
      })
      headers['X-Payment'] = result.xPaymentHeader
      paymentRequest = result.paymentRequest
    }

    // 5. Invoke
    const response = await fetch(agent.invokeUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ input }),
    })

    if (!response.ok) {
      throw new Error(`Agent ${agent.slug} returned ${response.status}`)
    }

    const data = await response.json() as Record<string, unknown>
    const output = data.result ?? data

    // 6. Settle on-chain (CD-5: solo si pago Y 2xx)
    let txHash: string | undefined
    if (paymentRequest) {
      const settleResult = await settlePayment(paymentRequest)
      if (!settleResult.success) {
        throw new Error(
          `x402 settle failed for ${agent.slug}: ${settleResult.error ?? 'unknown'}`,
        )
      }
      txHash = settleResult.txHash
      // CD-1: solo logear txHash, nunca signature ni payment decoded
      console.log(`[Compose] x402 settled for ${agent.slug} — txHash: ${txHash}`)
    }

    return { output, txHash }
  },
}
