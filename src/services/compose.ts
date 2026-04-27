/**
 * Compose Service -- Execute multi-agent pipelines
 */

import { getPaymentAdapter } from '../adapters/registry.js';
import {
  type DownstreamLogger,
  type DownstreamResult,
  signAndSettleDownstream,
} from '../lib/downstream-payment.js';
import type {
  A2AMessage,
  Agent,
  ComposeRequest,
  ComposeResult,
  ComposeStep,
  LLMBridgeStats,
  RegistryConfig,
  StepResult,
  X402PaymentRequest,
} from '../types/index.js';
import { extractA2APayload, isA2AMessage } from './a2a-protocol.js';
import { discoveryService } from './discovery.js';
import { eventService } from './event.js';
import { maybeTransform } from './llm/transform.js';
import { registryService } from './registry.js';

function buildAuthHeaders(
  registry: RegistryConfig | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!registry?.auth?.value) return headers;
  switch (registry.auth.type) {
    case 'header':
      headers[registry.auth.key] = registry.auth.value;
      break;
    case 'bearer':
      headers.Authorization = `Bearer ${registry.auth.value}`;
      break;
  }
  return headers;
}

export const composeService = {
  async compose(request: ComposeRequest): Promise<ComposeResult> {
    const { steps, maxBudget, a2aKey } = request;
    const results: StepResult[] = [];
    let totalCost = 0;
    let totalLatency = 0;
    let lastOutput: unknown = null;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const agent = await this.resolveAgent(step);
      if (!agent)
        return {
          success: false,
          output: null,
          steps: results,
          totalCostUsdc: totalCost,
          totalLatencyMs: totalLatency,
          error: `Agent not found: ${step.agent}`,
        };
      if (maxBudget && totalCost + agent.priceUsdc > maxBudget)
        return {
          success: false,
          output: null,
          steps: results,
          totalCostUsdc: totalCost,
          totalLatencyMs: totalLatency,
          error: `Budget exceeded: would need ${totalCost + agent.priceUsdc}, max is ${maxBudget}`,
        };
      const input =
        step.passOutput && lastOutput
          ? { ...step.input, previousOutput: lastOutput }
          : step.input;
      const startTime = Date.now();
      try {
        const { output, txHash, downstream } = await this.invokeAgent(
          agent,
          input,
          a2aKey,
        );
        const latencyMs = Date.now() - startTime;
        const result: StepResult = {
          agent,
          output,
          costUsdc: agent.priceUsdc,
          latencyMs,
          txHash,
          ...(downstream && {
            downstreamTxHash: downstream.txHash,
            downstreamBlockNumber: downstream.blockNumber,
            downstreamSettledAmount: downstream.settledAmount,
          }),
        };
        results.push(result);
        totalCost += agent.priceUsdc;
        totalLatency += latencyMs;
        lastOutput = output;
        if (i < steps.length - 1) {
          const nextStep = steps[i + 1];
          const nextAgent = await this.resolveAgent(nextStep);
          const inputSchema = nextAgent?.metadata?.inputSchema as
            | Record<string, unknown>
            | undefined;
          // ── WKH-56: A2A fast-path bridge resolution ──
          // DT-4: target a2aCompliant requires strict literal `true`
          // (truthy values like 'yes' / 1 do NOT activate the fast-path).
          const targetA2A = nextAgent?.metadata?.a2aCompliant === true;
          const outputIsA2A = isA2AMessage(lastOutput);
          const bridgeStart = Date.now();
          try {
            if (outputIsA2A && targetA2A) {
              // AC-1: A2A → A2A passthrough. NO maybeTransform call.
              result.bridgeType = 'A2A_PASSTHROUGH';
              result.transformLatencyMs = Date.now() - bridgeStart;
              // lastOutput UNCHANGED (CD-15: anti-mutation)
            } else {
              // AC-3 unwrap: A2A output but target is non-A2A → use parts[0].
              // AC-2 fallback: non-A2A output → maybeTransform actual flow.
              const payloadForTransform =
                outputIsA2A && !targetA2A
                  ? (extractA2APayload(lastOutput as A2AMessage)[0] ??
                    lastOutput)
                  : lastOutput;
              if (inputSchema && nextAgent) {
                const tr = await maybeTransform(
                  agent.id,
                  nextAgent.id,
                  payloadForTransform,
                  inputSchema,
                );
                result.cacheHit = tr.cacheHit; // legacy, DT-3
                result.bridgeType = tr.bridgeType; // nuevo, DT-3
                result.transformLatencyMs = tr.latencyMs;
                // WKH-57: telemetría LLM presente solo si bridgeType==='LLM'.
                // CD-17: omitir el campo en non-LLM (no setear como null).
                if (tr.llm) {
                  result.transformLLM = tr.llm;
                }
                lastOutput = tr.transformedOutput;
              } else if (outputIsA2A && !targetA2A) {
                // Schema-less + A2A output unwrapped: surface unwrapped payload
                // to next step but mark bridge as SKIPPED (no transform ran).
                lastOutput = payloadForTransform;
                result.bridgeType = 'SKIPPED';
                result.transformLatencyMs = Date.now() - bridgeStart;
              }
            }
          } catch (transformErr) {
            console.error(
              `[Compose] Transform failed at step ${i}:`,
              transformErr,
            );
          }
        }
        // ── WKH-56 (W3): emit compose_step event AFTER bridge resolved.
        // ── WKH-57 (W4): metadata extendida con 6 campos de telemetría
        //    (bridge + LLM). Constructor explícito (AB-WKH-55-5), todos los
        //    campos opcionales con `?? null` (AB-WKH-56-4 / CD-15).
        const llm: LLMBridgeStats | undefined = result.transformLLM;
        eventService
          .track({
            eventType: 'compose_step',
            agentId: agent.slug,
            agentName: agent.name,
            registry: agent.registry,
            status: 'success',
            latencyMs,
            costUsdc: agent.priceUsdc,
            txHash,
            metadata: {
              bridge_type: result.bridgeType ?? null,
              bridge_latency_ms: result.transformLatencyMs ?? null,
              bridge_cost_usd: llm?.costUsd ?? null,
              llm_model: llm?.model ?? null,
              llm_tokens_in: llm?.tokensIn ?? null,
              llm_tokens_out: llm?.tokensOut ?? null,
            },
          })
          .catch((err) =>
            console.error('[Compose] event tracking failed:', err),
          );
      } catch (err) {
        eventService
          .track({
            eventType: 'compose_step',
            agentId: agent?.slug,
            agentName: agent?.name,
            registry: agent?.registry,
            status: 'failed',
            latencyMs: Date.now() - startTime,
            costUsdc: 0,
          })
          .catch((trackErr) =>
            console.error('[Compose] event tracking failed:', trackErr),
          );
        return {
          success: false,
          output: null,
          steps: results,
          totalCostUsdc: totalCost,
          totalLatencyMs: totalLatency,
          error: `Step ${i} failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    return {
      success: true,
      output: lastOutput,
      steps: results,
      totalCostUsdc: totalCost,
      totalLatencyMs: totalLatency,
    };
  },
  async resolveAgent(step: ComposeStep): Promise<Agent | null> {
    // Try with registry hint first, then without (LLM may pass wrong case)
    const agent = await discoveryService.getAgent(step.agent, step.registry);
    if (agent) return agent;
    const agentNoRegistry = await discoveryService.getAgent(step.agent);
    if (agentNoRegistry) return agentNoRegistry;
    // Fallback: fetch all agents and match by slug directly
    const result = await discoveryService.discover({ limit: 50 });
    return result.agents.find((a) => a.slug === step.agent) ?? null;
  },
  async invokeAgent(
    agent: Agent,
    input: Record<string, unknown>,
    a2aKey?: string,
    logger?: DownstreamLogger,
  ): Promise<{
    output: unknown;
    txHash?: string;
    downstream?: DownstreamResult;
  }> {
    const registries = await registryService.getEnabled();
    const registry = registries.find(
      (r: RegistryConfig) => r.name === agent.registry,
    );
    const authHeaders = buildAuthHeaders(registry);
    let paymentRequest: X402PaymentRequest | undefined;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...authHeaders,
    };
    if (a2aKey) {
      headers['x-a2a-key'] = a2aKey;
    }
    if (agent.priceUsdc > 0) {
      // WAS-V2-3-CLIENT-2: schema drift fallback for payTo (mirrors price_per_call fallback in discovery)
      // canonical: agent.metadata.payTo  ←  preferred (kite registry)
      // fallback:  agent.metadata.payment.contract  ←  wasiai-v2 marketplace exposes payTo here
      const meta = agent.metadata as Record<string, unknown> | undefined;
      const canonicalPayTo =
        typeof meta?.payTo === 'string' ? meta.payTo : undefined;
      const fallbackPayment = meta?.payment as
        | Record<string, unknown>
        | undefined;
      const fallbackPayTo =
        typeof fallbackPayment?.contract === 'string'
          ? fallbackPayment.contract
          : undefined;
      const payTo = canonicalPayTo ?? fallbackPayTo;
      if (!payTo)
        throw new Error(
          `No payTo address for agent ${agent.slug} — neither metadata.payTo nor metadata.payment.contract present`,
        );
      const valueWei = String(
        BigInt(Math.round(agent.priceUsdc * 1e6)) * BigInt(1e12),
      );
      const result = await getPaymentAdapter().sign({
        to: payTo as `0x${string}`,
        value: valueWei,
      });
      headers['PAYMENT-SIGNATURE'] = result.xPaymentHeader;
      paymentRequest = result.paymentRequest;
    }
    const response = await fetch(agent.invokeUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    });
    if (!response.ok)
      throw new Error(`Agent ${agent.slug} returned ${response.status}`);
    const data = (await response.json()) as Record<string, unknown>;
    const output = data.result ?? data;
    let txHash: string | undefined;
    if (paymentRequest) {
      const settleResult = await getPaymentAdapter().settle({
        authorization: paymentRequest.authorization,
        signature: paymentRequest.signature,
        network: paymentRequest.network ?? '',
      });
      if (!settleResult.success)
        throw new Error(
          `x402 settle failed for ${agent.slug}: ${settleResult.error ?? 'unknown'}`,
        );
      txHash = settleResult.txHash;
      console.log(
        `[Compose] x402 settled for ${agent.slug} — txHash: ${txHash}`,
      );
    }

    // ─── WKH-55: Downstream x402 hook (AC-1..AC-10) ──────────────────
    // Defensive logger fallback: si el caller no pasó uno, usamos console.
    const effectiveLogger: DownstreamLogger = logger ?? {
      warn: (obj: unknown, _msg?: string) => console.warn('[Downstream]', obj),
      info: (obj: unknown, _msg?: string) => console.log('[Downstream]', obj),
    };
    const downstream = await signAndSettleDownstream(agent, effectiveLogger);

    return { output, txHash, ...(downstream && { downstream }) };
  },
};
