/**
 * Compose Service -- Execute multi-agent pipelines
 */
import type { Agent, ComposeRequest, ComposeResult, ComposeStep, StepResult, RegistryConfig, X402PaymentRequest } from '../types/index.js'
import { discoveryService } from './discovery.js'
import { registryService } from './registry.js'
import { getPaymentAdapter } from '../adapters/registry.js'
import { maybeTransform } from './llm/transform.js'
import { eventService } from './event.js'

function buildAuthHeaders(registry: RegistryConfig | undefined): Record<string, string> {
  const headers: Record<string, string> = {}
  if (!registry?.auth?.value) return headers
  switch (registry.auth.type) {
    case 'header': headers[registry.auth.key] = registry.auth.value; break
    case 'bearer': headers['Authorization'] = `Bearer ${registry.auth.value}`; break
  }
  return headers
}

export const composeService = {
  async compose(request: ComposeRequest): Promise<ComposeResult> {
    const { steps, maxBudget } = request
    const results: StepResult[] = []
    let totalCost = 0
    let totalLatency = 0
    let lastOutput: unknown = null
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]
      const agent = await this.resolveAgent(step)
      if (!agent) return { success: false, output: null, steps: results, totalCostUsdc: totalCost, totalLatencyMs: totalLatency, error: `Agent not found: ${step.agent}` }
      if (maxBudget && totalCost + agent.priceUsdc > maxBudget) return { success: false, output: null, steps: results, totalCostUsdc: totalCost, totalLatencyMs: totalLatency, error: `Budget exceeded: would need ${totalCost + agent.priceUsdc}, max is ${maxBudget}` }
      const input = step.passOutput && lastOutput ? { ...step.input, previousOutput: lastOutput } : step.input
      const startTime = Date.now()
      try {
        const { output, txHash } = await this.invokeAgent(agent, input)
        const latencyMs = Date.now() - startTime
        const result: StepResult = { agent, output, costUsdc: agent.priceUsdc, latencyMs, txHash }
        results.push(result)
        eventService.track({ eventType: 'compose_step', agentId: agent.slug, agentName: agent.name, registry: agent.registry, status: 'success', latencyMs, costUsdc: agent.priceUsdc, txHash }).catch(err => console.error('[Compose] event tracking failed:', err))
        totalCost += agent.priceUsdc
        totalLatency += latencyMs
        lastOutput = output
        if (i < steps.length - 1) {
          const nextStep = steps[i + 1]
          const nextAgent = await this.resolveAgent(nextStep)
          const inputSchema = nextAgent?.metadata?.inputSchema as Record<string, unknown> | undefined
          if (inputSchema) {
            try {
              const tr = await maybeTransform(agent.id, nextAgent!.id, lastOutput, inputSchema)
              result.cacheHit = tr.cacheHit
              result.transformLatencyMs = tr.latencyMs
              lastOutput = tr.transformedOutput
            } catch (transformErr) { console.error(`[Compose] Transform failed at step ${i}:`, transformErr) }
          }
        }
      } catch (err) {
        eventService.track({ eventType: 'compose_step', agentId: agent?.slug, agentName: agent?.name, registry: agent?.registry, status: 'failed', latencyMs: Date.now() - startTime, costUsdc: 0 }).catch(trackErr => console.error('[Compose] event tracking failed:', trackErr))
        return { success: false, output: null, steps: results, totalCostUsdc: totalCost, totalLatencyMs: totalLatency, error: `Step ${i} failed: ${err instanceof Error ? err.message : String(err)}` }
      }
    }
    return { success: true, output: lastOutput, steps: results, totalCostUsdc: totalCost, totalLatencyMs: totalLatency }
  },
  async resolveAgent(step: ComposeStep): Promise<Agent | null> {
    const agent = await discoveryService.getAgent(step.agent, step.registry)
    if (agent) return agent
    const result = await discoveryService.discover({ query: step.agent, limit: 1, registry: step.registry })
    return result.agents[0] ?? null
  },
  async invokeAgent(agent: Agent, input: Record<string, unknown>): Promise<{ output: unknown; txHash?: string }> {
    const registries = await registryService.getEnabled()
    const registry = registries.find((r: RegistryConfig) => r.name === agent.registry)
    const authHeaders = buildAuthHeaders(registry)
    let paymentRequest: X402PaymentRequest | undefined
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...authHeaders }
    if (agent.priceUsdc > 0) {
      const payTo = agent.metadata?.payTo as string | undefined
      if (!payTo) throw new Error(`No payTo address for agent ${agent.slug} — agent metadata must include payTo`)
      const valueWei = String(BigInt(Math.round(agent.priceUsdc * 1e6)) * BigInt(1e12))
      const result = await getPaymentAdapter().sign({ to: payTo as `0x${string}`, value: valueWei })
      headers['X-Payment'] = result.xPaymentHeader
      paymentRequest = result.paymentRequest
    }
    const response = await fetch(agent.invokeUrl, { method: 'POST', headers, body: JSON.stringify({ input }) })
    if (!response.ok) throw new Error(`Agent ${agent.slug} returned ${response.status}`)
    const data = await response.json() as Record<string, unknown>
    const output = data.result ?? data
    let txHash: string | undefined
    if (paymentRequest) {
      const settleResult = await getPaymentAdapter().settle({ authorization: paymentRequest.authorization, signature: paymentRequest.signature, network: paymentRequest.network ?? '' })
      if (!settleResult.success) throw new Error(`x402 settle failed for ${agent.slug}: ${settleResult.error ?? 'unknown'}`)
      txHash = settleResult.txHash
      console.log(`[Compose] x402 settled for ${agent.slug} — txHash: ${txHash}`)
    }
    return { output, txHash }
  },
}
