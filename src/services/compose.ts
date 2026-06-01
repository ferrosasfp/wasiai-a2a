/**
 * Compose Service -- Execute multi-agent pipelines
 */

import { normalizeChainSlug } from '../adapters/chain-resolver.js';
import { getPaymentAdapter } from '../adapters/registry.js';
import { hashCallerRef } from '../lib/caller-hash.js';
import { selectFacilitatorUrl } from '../lib/cdp-selector.js';
import {
  type DownstreamLogger,
  type DownstreamResult,
  signAndSettleDownstream,
} from '../lib/downstream-payment.js';
import type {
  A2AMessage,
  Agent,
  AuthzTarget,
  ComposeRequest,
  ComposeResult,
  ComposeStep,
  LLMBridgeStats,
  RegistryConfig,
  StepResult,
  X402PaymentRequest,
} from '../types/index.js';
import { extractA2APayload, isA2AMessage } from './a2a-protocol.js';
import { authzService } from './authz.js';
import { budgetService } from './budget.js';
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

/**
 * WKH-61: lee category del Agent.metadata con type-guard.
 * Retorna `undefined` si metadata.category no es un string (registries que no
 * exponen category). NO usar `agent.capabilities[0]` como proxy (CD-8).
 */
function readCategory(agent: Agent): string | undefined {
  const meta = agent.metadata as Record<string, unknown> | undefined;
  const cat = meta?.category;
  return typeof cat === 'string' ? cat : undefined;
}

export const composeService = {
  async compose(request: ComposeRequest): Promise<ComposeResult> {
    const { steps, maxBudget, a2aKey, scopingKeyRow, chainId, logger } =
      request;
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
      // WKH-61: scoping check post-resolve, pre-invoke. Skip si caller es x402
      // (sin keyRow). Aborta el pipeline antes del budget-check para evitar
      // evaluar costo de agentes que la key no puede invocar.
      if (scopingKeyRow) {
        const target: AuthzTarget = {
          registry: agent.registry,
          agent_slug: agent.slug,
          category: readCategory(agent),
        };
        const scope = authzService.checkScoping(scopingKeyRow, target);
        if (!scope.allowed) {
          return {
            success: false,
            output: null,
            steps: results,
            totalCostUsdc: totalCost,
            totalLatencyMs: totalLatency,
            error: `Step ${i} denied by scope: ${scope.reason ?? 'SCOPE_DENIED'}`,
            errorCode: 'SCOPE_DENIED',
            scopeDeniedTarget: {
              registry: agent.registry,
              agent_slug: agent.slug,
              ...(target.category !== undefined && {
                category: target.category,
              }),
            },
          };
        }
      }
      if (maxBudget && totalCost + agent.priceUsdc > maxBudget)
        return {
          success: false,
          output: null,
          steps: results,
          totalCostUsdc: totalCost,
          totalLatencyMs: totalLatency,
          error: `Budget exceeded: would need ${totalCost + agent.priceUsdc}, max is ${maxBudget}`,
        };
      // WKH-59 (real-price-debit) AC-2: steps 2..N debit atómico via
      // budgetService.debit (PG function increment_a2a_key_spend — CD-2).
      //
      // CD-11: guard `i > 0` es la ÚNICA defensa contra double-debit del
      // step 0 (que ya fue debitado por el middleware via
      // request.composeEstimatedCostUsd). NO REMOVER. AR/CR debe verificar
      // que esta línea sobrevive en futuras HUs.
      //
      // Skip defensivo: si no hay scopingKeyRow (path x402) o chainId
      // (defensive), el debit per-step no aplica. Comportamiento de
      // "fee-on-attempt" consistente con gasless (debit antes de
      // invokeAgent).
      if (i > 0 && scopingKeyRow && chainId !== undefined) {
        // WKH-59 BLQ-MED-1 fix (CD-4 / AC-4): fallback honesto si priceUsdc
        // del agente es 0, null, NaN, o no es un number (config error en el
        // registry). Mismo patrón que el preHandler de step 0 en
        // `src/routes/compose.ts:63-77`, replicado per-step.
        // NOTA OPERACIONAL: NO podemos setear el header
        // `x-debit-fallback: registry-miss` acá — la response ya está en
        // pipeline (los steps 0 corrieron). Esa señal queda exclusiva del
        // preHandler de step 0; en steps 2..N la observabilidad vive en el
        // warn log estructurado (reason='registry-miss', slug, step=i).
        const isInvalid =
          typeof agent.priceUsdc !== 'number' ||
          agent.priceUsdc === 0 ||
          Number.isNaN(agent.priceUsdc);
        const debitAmount = isInvalid ? 1.0 : agent.priceUsdc;

        if (isInvalid) {
          const warn = logger?.warn?.bind(logger) ?? console.warn;
          warn(
            {
              reason: 'registry-miss',
              slug: agent.slug,
              step: i,
            },
            'compose-price.fallback per-step',
          );
        }

        const debitResult = await budgetService.debit(
          scopingKeyRow.id,
          chainId,
          debitAmount,
          request.delegationContext, // WKH-101 (DT-11): enruta al RPC atómico bajo delegación
        );
        if (!debitResult.success) {
          // DT-H: mid-pipeline debit failure → ComposeResult.error.
          // NO setear errorCode='SCOPE_DENIED' (eso es 403). Route handler
          // mapea a 400 (default), no a 402/403.
          return {
            success: false,
            output: null,
            steps: results,
            totalCostUsdc: totalCost,
            totalLatencyMs: totalLatency,
            error: `Step ${i} debit failed: ${debitResult.error ?? 'insufficient budget'}`,
          };
        }
      }
      const input =
        step.passOutput && lastOutput
          ? { ...step.input, previousOutput: lastOutput }
          : step.input;
      const startTime = Date.now();
      // WKH-104 (TD-SYBIL): hash HMAC del caller para anti-sybil sin exponer
      // el owner_ref crudo (CD-5/CD-6). null si caller anónimo (x402).
      const callerRefHash = hashCallerRef(scopingKeyRow?.owner_ref);
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
                // WKH-60: propagate caller's owner_ref so the L2 cache is
                // scoped per-tenant (cross-tenant cache poisoning blocked).
                // When the caller is anonymous (x402, no scopingKeyRow),
                // ownerRef stays undefined and maybeTransform runs in
                // never-cache mode for L2 (L1 still works in-process).
                const ownerRef = scopingKeyRow?.owner_ref;
                const tr = await maybeTransform(
                  agent.id,
                  nextAgent.id,
                  payloadForTransform,
                  inputSchema,
                  ownerRef,
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
              caller_ref_hash: callerRefHash,
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
            metadata: { caller_ref_hash: callerRefHash },
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
    let agent = await discoveryService.getAgent(step.agent, step.registry);
    if (!agent) agent = await discoveryService.getAgent(step.agent);

    // WKH-113 (BASE-08): the real per-chain payment lives in the
    // capabilities/discover path (getAgent v2 hardcodes chain=avalanche, H14;
    // capabilities emits a.chain per-row, H15). Hydrate payment from discover
    // so the real ChainKey survives to signAndSettleDownstream (CD-5/CD-10).
    if (!agent) {
      // Fallback: fetch all agents and match by slug directly. Resolved via
      // discover → already carries the real chain. No re-query (anti latency).
      const result = await discoveryService.discover({ limit: 50 });
      return result.agents.find((a) => a.slug === step.agent) ?? null;
    }

    // Resolved via getAgent → hydrate payment.chain from the path with the
    // real chain (only when it differs — no-op for Avalanche/Kite, CD-8).
    // CD-10 fail-soft: if discover does not bring the agent, real?.payment is
    // falsy → keep getAgent's payment (no Base assumption, no cross-chain).
    const real = (await discoveryService.discover({ limit: 50 })).agents.find(
      (a) => a.slug === agent.slug,
    );
    if (real?.payment?.chain && real.payment.chain !== agent.payment?.chain) {
      agent.payment = real.payment; // adopt the full payment of the real-chain path
    }
    return agent;
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
    // WKH-58: only sign inbound x402 when caller paid via x402 (no a2aKey).
    // a2a-key path: middleware already debited per-call budget, no inbound
    // settle needed. Pieverse /v2/settle (HTTP 500 since 2026-04-13) is the
    // legacy path for x402 callers only. Downstream Fuji USDC settle (WKH-55)
    // still runs for both paths via signAndSettleDownstream below.
    if (agent.priceUsdc > 0 && !a2aKey) {
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
      // WKH-106 (BASE-03): emit selector decision telemetry when settle
      // is on Base chain. The Base adapter itself already honors
      // CDP_FACILITATOR_URL via its own env-var fallback chain (see
      // src/adapters/base/payment.ts:163-170), but logging the selector
      // result here gives observability for AC-2 / AC-5 / AC-7 and lets
      // compose-layer integration tests assert the decision was taken.
      //
      // Selector is invoked ONLY when the agent's manifest declares a
      // Base chain (CD-5 — Kite/Avalanche untouched). Pure function call:
      // no env mutation, no I/O.
      const manifestChain = agent.payment?.chain;
      const chainKey = manifestChain
        ? normalizeChainSlug(manifestChain)
        : undefined;
      if (chainKey?.startsWith('base-')) {
        const meta = agent.metadata as Record<string, unknown> | undefined;
        const manifestFacilitatorUrl =
          typeof meta?.facilitatorUrl === 'string'
            ? meta.facilitatorUrl
            : undefined;
        const selectedUrl = selectFacilitatorUrl({
          chainKey,
          cdpFacilitatorUrl: process.env.CDP_FACILITATOR_URL,
          agentManifestFacilitatorUrl: manifestFacilitatorUrl,
        });
        // Structured log — easy to grep in production + drives smoke tests.
        // Does NOT include the CDP key itself — only the URL host pattern.
        console.log(
          `[Compose] Base settle facilitator selector — chainKey=${chainKey} selected=${selectedUrl ?? '<adapter-default>'} cdpEnvSet=${typeof process.env.CDP_FACILITATOR_URL === 'string' && process.env.CDP_FACILITATOR_URL.length > 0}`,
        );
      }

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
