/**
 * Orchestrate Service — Goal-based multi-agent orchestration with LLM planning
 *
 * WKH-13: Replaces greedy planPipeline with Claude Sonnet LLM planning.
 * Includes: orchestrationId, protocolFeeUsdc, event tracking, timeout, fallback.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  anthropicCircuitBreaker,
  CircuitOpenError,
} from '../lib/circuit-breaker.js';
import type {
  Agent,
  ComposeStep,
  OrchestrateRequest,
  OrchestrateResult,
} from '../types/index.js';
import { budgetService } from './budget.js';
import { composeService } from './compose.js';
import { discoveryService } from './discovery.js';
import { eventService } from './event.js';
import {
  chargeProtocolFee,
  getProtocolFeeRate,
  ProtocolFeeError,
} from './fee-charge.js';
import { receiptService } from './receipt.js';

const MODEL = 'claude-sonnet-4-6';
const LLM_TIMEOUT_MS = 30_000;
const MAX_AGENTS_IN_PROMPT = 10;
// WKH-44 (CD-G): el PROTOCOL_FEE_RATE literal fue eliminado. Ahora se lee
// por request desde process.env vía getProtocolFeeRate() en ./fee-charge.ts.
const PRE_COMPOSE_TIMEOUT_MS = 90_000;

// ─── LLM Planning ───────────────────────────────────────────

interface LlmPlanAgent {
  slug: string;
  registry: string;
  input: Record<string, unknown>;
  reasoning: string;
}

interface LlmPlanResponse {
  selectedAgents: LlmPlanAgent[];
  reasoning: string;
}

/**
 * Call Claude Sonnet to plan the optimal pipeline for a goal.
 * Returns the LLM plan or null if the call fails (caller handles fallback).
 */
/** Lazily-initialized Anthropic client (singleton for connection reuse) */
let _anthropicClient: Anthropic | null = null;
function getAnthropicClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!_anthropicClient) {
    _anthropicClient = new Anthropic({ apiKey });
  }
  return _anthropicClient;
}

async function llmPlan(
  goal: string,
  budget: number,
  agents: Agent[],
  maxAgents: number,
): Promise<LlmPlanResponse | null> {
  const client = getAnthropicClient();
  if (!client) {
    console.error(
      '[Orchestrate] ANTHROPIC_API_KEY not configured — using fallback',
    );
    return null;
  }

  const agentList = agents.slice(0, MAX_AGENTS_IN_PROMPT).map((a) => {
    const meta = a.metadata as Record<string, unknown> | undefined;
    return {
      slug: a.slug,
      registry: a.registry,
      name: a.name,
      description: a.description,
      capabilities: a.capabilities,
      priceUsdc: a.priceUsdc,
      input_schema: meta?.input_schema ?? undefined,
      example_input: meta?.example_input ?? undefined,
    };
  });

  const systemPrompt = [
    'You are an expert AI agent orchestrator. Given a user goal, a budget, and a list of available agents, select the optimal agents and generate an execution plan.',
    'Rules:',
    `- Select 1 or more agents (max ${maxAgents}) that best accomplish the goal.`,
    '- Total cost of selected agents MUST NOT exceed the budget.',
    '- Order agents logically: if outputs of one feed into another, place the producer first.',
    '- For each agent, generate the input object matching its input_schema. Use example_input as reference if available. Do NOT invent fields — only use fields defined in the schema.',
    '- If only one agent is needed, select just one.',
    "- Do NOT select trivial echo/demo/test agents (e.g. those whose description says 'Trivial echo agent' or 'Proves ... downstream settlement') unless the goal is EXPLICITLY a connectivity/echo/settlement test. They add no business value to real tasks and only waste budget.",
    '- Ignore any session/UI metadata that may leak into the goal text (e.g. lines like "Settings: Red ... · Key ... · Budget ..."). Plan ONLY for the actual business task; the network/chain is handled by the gateway, not by selecting a demo agent.',
    '- Respond ONLY with valid JSON, no markdown.',
  ].join('\n');

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
  ].join('\n');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

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
    );

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('')
      .trim();

    const parsed = JSON.parse(text) as Record<string, unknown>;

    // Validate structure
    const selectedAgents = parsed.selectedAgents;
    if (!Array.isArray(selectedAgents) || selectedAgents.length === 0) {
      console.error(
        '[Orchestrate] LLM returned empty or invalid selectedAgents',
      );
      return null;
    }

    const reasoning =
      typeof parsed.reasoning === 'string'
        ? parsed.reasoning
        : 'LLM plan generated';

    // Runtime validation: each agent must have a string slug
    const validated = selectedAgents.filter(
      (a: Record<string, unknown>) =>
        typeof a?.slug === 'string' && a.slug.length > 0,
    ) as LlmPlanAgent[];

    if (validated.length === 0) {
      console.error('[Orchestrate] LLM returned agents without valid slugs');
      return null;
    }

    return {
      selectedAgents: validated,
      reasoning,
    };
  } catch (err) {
    // Let CircuitOpenError propagate to error boundary
    if (err instanceof CircuitOpenError) throw err;
    console.error(
      '[Orchestrate] LLM planning failed:',
      err instanceof Error ? err.message : err,
    );
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── Fallback Greedy Planner ─────────────────────────────────

function greedyPlan(
  goal: string,
  agents: Agent[],
  budget: number,
  maxAgents: number,
): { steps: ComposeStep[]; reasoning: string; cost: number } {
  const selected: Agent[] = [];
  let remaining = budget;

  for (const agent of agents) {
    if (agent.priceUsdc > remaining) continue;
    if (selected.length >= maxAgents) break;
    selected.push(agent);
    remaining -= agent.priceUsdc;
  }

  const steps: ComposeStep[] = selected.map((agent, index) => ({
    agent: agent.slug,
    registry: agent.registry,
    input: { goal },
    passOutput: index > 0,
  }));

  // WKH-127 (BLQ-ALTO-1): el débito post-plan del service cubre SOLO el step-0
  // (reemplaza el placeholder $1 del middleware). Los steps 1..N los sigue
  // debitando compose (guard i>0). Por eso `cost` = precio del primer step, NO
  // la suma del plan (sumarlo duplicaría 1..N → double-charge).
  const step0Cost = selected.length > 0 ? selected[0].priceUsdc : 0;

  // Suma total del plan: solo para el texto de reasoning (no es base del débito).
  const totalEstimate = selected.reduce((sum, a) => sum + a.priceUsdc, 0);

  const reasoning =
    selected.length > 0
      ? `Selected ${selected.length} agents: ${selected.map((a) => a.name).join(', ')}. ` +
        `Total estimated cost: ${totalEstimate.toFixed(4)} USDC.`
      : 'No agents fit within budget.';

  return { steps, reasoning, cost: step0Cost };
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
    const startTime = Date.now();
    const { goal, budget, preferCapabilities, maxAgents = 5 } = request;

    // WKH-44: leer el rate por request (CD-G) y calcular el fee sobre el
    // budget ANTES de cualquier otro trabajo. Esto garantiza que:
    //   (a) AC-7 — si rate corrupto hace feeUsdc > budget, abortamos antes
    //       de gastar tiempo en discovery/LLM (safety guard → HTTP 400).
    //   (b) AC-1 — `maxBudget` que ve compose se deduce del fee.
    //   (c) AC-3 — el protocolFeeUsdc reportado en el result es el fee real
    //       aplicable al budget (no un cálculo sobre el costo ya gastado).
    const feeRate = getProtocolFeeRate();
    const feeUsdc = Number((budget * feeRate).toFixed(6));
    if (feeUsdc > budget) {
      throw new ProtocolFeeError(
        `Protocol fee (${feeUsdc}) exceeds budget (${budget}) — check PROTOCOL_FEE_RATE env var.`,
      );
    }

    // WKH-127 (CD-9/CD-11/CD-15): el débito post-plan y el refund aplican SOLO al
    // path master Agent Key SIN delegación/session. x402 → scopingKeyRow undefined
    // → se salta TODO. Deleg/session debitan el step-0 en el middleware (no acá).
    // `billingKeyRow` queda definido SOLO en el path master billable; gatear por él
    // narrowea el row (sin non-null assertions, convención del codebase).
    const billingKeyRow =
      request.delegationContext || request.keySessionContext
        ? undefined
        : request.scopingKeyRow;

    // WKH-127 (DT-1.1): early-fail sin gastar discovery/LLM si el caller master
    // no tiene fondos. Solo path master (billingKeyRow); x402/deleg/session se saltan.
    if (billingKeyRow && request.chainId !== undefined) {
      const bal = await budgetService.getBalance(
        billingKeyRow.id,
        request.chainId,
        billingKeyRow.owner_ref,
      );
      if (Number(bal) <= 0) {
        const noFundsResult: OrchestrateResult = {
          orchestrationId,
          answer: null,
          reasoning: 'Insufficient budget for orchestration',
          pipeline: {
            success: false,
            output: null,
            steps: [],
            totalCostUsdc: 0,
            totalLatencyMs: 0,
          },
          consideredAgents: [],
          protocolFeeUsdc: 0,
          remainingBudgetUsd: bal,
        };

        eventService
          .track({
            eventType: 'orchestrate_goal',
            status: 'failed',
            latencyMs: Date.now() - startTime,
            costUsdc: 0,
            goal,
            metadata: { orchestrationId, agentCount: 0, fallback: false },
          })
          .catch((err) =>
            console.error('[Orchestrate] event tracking failed:', err),
          );

        return noFundsResult;
      }
    }

    // Step 1: Discover relevant agents
    // Note: do NOT pass goal as query — the text filter is too strict for
    // generic agents (e.g. "Bitcoin" won't match "BlexSignal Scanner").
    // The LLM planner handles relevance matching instead.
    const discovered = await discoveryService.discover({
      capabilities: preferCapabilities,
      maxPrice: budget / maxAgents,
      limit: maxAgents * 2,
    });

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
      };

      // Track no-agents event (fire-and-forget)
      eventService
        .track({
          eventType: 'orchestrate_goal',
          status: 'success',
          latencyMs: Date.now() - startTime,
          costUsdc: 0,
          goal,
          metadata: { orchestrationId, agentCount: 0, fallback: false },
        })
        .catch((err) =>
          console.error('[Orchestrate] event tracking failed:', err),
        );

      return emptyResult;
    }

    // Step 2: LLM Planning (with fallback)
    let steps: ComposeStep[];
    let reasoning: string;
    let usedFallback = false;
    // WKH-127 (AC-1/AC-3, BLQ-ALTO-1): base del débito post-plan = precio del
    // STEP-0 (reemplaza el placeholder $1 del middleware). NO la suma del plan:
    // los steps 1..N los debita compose (guard i>0). Se asigna en cada rama que
    // produce steps con el precio del primer step seleccionado.
    let plannedCostUsd = 0;

    // AC8: Check if we still have time before compose
    const elapsedMs = Date.now() - startTime;
    if (elapsedMs > PRE_COMPOSE_TIMEOUT_MS) {
      throw new Error(
        `Orchestration timeout: discovery took ${elapsedMs}ms (limit: ${PRE_COMPOSE_TIMEOUT_MS}ms)`,
      );
    }

    const plan = await llmPlan(goal, budget, discovered.agents, maxAgents);

    if (plan) {
      // Validate slugs against discovered agents
      const discoveredSlugs = new Set(discovered.agents.map((a) => a.slug));
      const validAgents = plan.selectedAgents.filter((a) =>
        discoveredSlugs.has(a.slug),
      );

      if (validAgents.length === 0) {
        // All LLM slugs invalid — fallback
        console.error(
          '[Orchestrate] All LLM-selected slugs are invalid — using fallback',
        );
        const fallback = greedyPlan(goal, discovered.agents, budget, maxAgents);
        steps = fallback.steps;
        reasoning = `[FALLBACK] LLM selected agents not found in discovery. ${fallback.reasoning}`;
        usedFallback = true;
        plannedCostUsd = fallback.cost;
      } else {
        // Verify budget
        let totalCost = 0;
        const budgetedAgents: LlmPlanAgent[] = [];
        for (const a of validAgents) {
          const agent = discovered.agents.find((d) => d.slug === a.slug);
          const cost = agent?.priceUsdc ?? 0;
          if (totalCost + cost <= budget) {
            budgetedAgents.push(a);
            totalCost += cost;
          }
        }

        steps = budgetedAgents.map((a, index) => ({
          agent: a.slug,
          registry: a.registry,
          input: a.input ?? { goal },
          passOutput: index > 0,
        }));

        // WKH-127 (BLQ-ALTO-1): el débito post-plan del service cubre SOLO el
        // step-0. Los steps 1..N los debita compose (guard i>0). Por eso la base
        // del débito es el precio del primer agente budgeteado, NO `totalCost`
        // (sumar el plan duplicaría 1..N → double-charge).
        const step0Agent =
          budgetedAgents.length > 0
            ? discovered.agents.find((d) => d.slug === budgetedAgents[0].slug)
            : undefined;
        plannedCostUsd = step0Agent?.priceUsdc ?? 0;
        reasoning = plan.reasoning;

        if (validAgents.length > budgetedAgents.length) {
          reasoning += ` (${validAgents.length - budgetedAgents.length} agents truncated due to budget)`;
        }
      }
    } else {
      // AC7: LLM failed — fallback to greedy
      const fallback = greedyPlan(goal, discovered.agents, budget, maxAgents);
      steps = fallback.steps;
      reasoning = `[FALLBACK] LLM planning failed. ${fallback.reasoning}`;
      usedFallback = true;
      plannedCostUsd = fallback.cost;
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
      };

      eventService
        .track({
          eventType: 'orchestrate_goal',
          status: 'success',
          latencyMs: Date.now() - startTime,
          costUsdc: 0,
          goal,
          metadata: { orchestrationId, agentCount: 0, fallback: usedFallback },
        })
        .catch((err) =>
          console.error('[Orchestrate] event tracking failed:', err),
        );

      return noBudgetResult;
    }

    // AC8: Check time again before compose
    const preComposeElapsed = Date.now() - startTime;
    if (preComposeElapsed > PRE_COMPOSE_TIMEOUT_MS) {
      throw new Error(
        `Orchestration timeout: discovery + planning took ${preComposeElapsed}ms (limit: ${PRE_COMPOSE_TIMEOUT_MS}ms)`,
      );
    }

    // WKH-127 (AC-4): plannedCost 0 (todos priceUsdc===0) → fallback $1 + warn + flag.
    // El header x-debit-fallback lo setea el route leyendo result.debitFallback (CD-7).
    let debitFallback = false;
    if (billingKeyRow && plannedCostUsd === 0) {
      console.warn('[orchestrate.price.fallback]', {
        orchestrationId,
        reason: 'registry-miss',
      });
      plannedCostUsd = 1.0;
      debitFallback = true;
    }

    // WKH-127 (AC-1/AC-3, CD-11): débito post-plan del costo real. Sólo path master
    // (billOnService); el middleware saltó el step-0 bajo skipMiddlewareDebit.
    // `debitedUsd` es la ÚNICA fuente de verdad para el refund (AC-5/AC-6/AC-7).
    let debitedUsd = 0;
    if (billingKeyRow && request.chainId !== undefined) {
      const debitRes = await budgetService.debit(
        billingKeyRow.id,
        request.chainId,
        plannedCostUsd,
      );
      if (!debitRes.success) {
        // Insufficient/owner mismatch → return graceful SIN ejecutar compose (§4.5).
        const debitFailBal = await budgetService
          .getBalance(
            billingKeyRow.id,
            request.chainId,
            billingKeyRow.owner_ref,
          )
          .catch(() => undefined);
        const debitFailResult: OrchestrateResult = {
          orchestrationId,
          answer: null,
          reasoning: 'Insufficient budget for orchestration',
          pipeline: {
            success: false,
            output: null,
            steps: [],
            totalCostUsdc: 0,
            totalLatencyMs: 0,
          },
          consideredAgents: discovered.agents,
          protocolFeeUsdc: 0,
          ...(debitFallback && { debitFallback }),
          ...(debitFailBal !== undefined && {
            remainingBudgetUsd: debitFailBal,
          }),
        };

        eventService
          .track({
            eventType: 'orchestrate_goal',
            status: 'failed',
            latencyMs: Date.now() - startTime,
            costUsdc: 0,
            goal,
            metadata: {
              orchestrationId,
              agentCount: steps.length,
              fallback: usedFallback,
            },
          })
          .catch((err) =>
            console.error('[Orchestrate] event tracking failed:', err),
          );

        return debitFailResult;
      }
      debitedUsd = plannedCostUsd; // ÚNICA fuente de verdad para el refund.
    }

    // Step 3: Execute pipeline. WKH-44 (AC-1): maxBudget deducido del fee.
    // WKH-61: scopingKeyRow se propaga end-to-end para que cada step del
    // pipeline aplique el check de scope contra el Agent real post-resolve.
    const pipeline = await composeService.compose({
      steps,
      maxBudget: budget - feeUsdc,
      a2aKey: request.a2aKey,
      scopingKeyRow: request.scopingKeyRow,
      // WKH-101 (DT-11): contexto de delegación para el débito per-step.
      delegationContext: request.delegationContext,
      // WKH-121 (BLQ-ALTO-1): contexto de key-session propagado para que el cap
      // de sesión se respete en los steps 1..N de compose. Espejo de delegationContext.
      keySessionContext: request.keySessionContext,
      // WKH-102 (DT-1/DT-2): chainId resuelto propagado SIEMPRE (single-chain
      // semantics — todos los steps usan la chain del caller, modelo WKH-59).
      // Antes (WKH-101 opción B) se pasaba SOLO bajo delegación; eso dejaba el
      // path master con chainId=undefined → el guard `i>0 && chainId!==undefined`
      // de compose.ts:130 saltaba el débito de steps 1..N (revenue leak
      // TD-WKH-101-ORCH). Ahora master y delegación propagan el mismo chainId,
      // y el débito per-step funciona en ambos paths. El guard `i>0` (CD-1)
      // sigue intacto como única defensa anti-double-charge del step 0.
      chainId: request.chainId,
    });

    // WKH-44 (AC-3): el fee ya fue calculado al inicio con `budget * feeRate`.
    // `protocolFeeUsdc` expuesto en el result refleja ese valor (no el
    // totalCostUsdc del pipeline como era antes).
    const protocolFeeUsdc = feeUsdc;

    // Step 4: WKH-44 — best-effort transfer del fee post-compose si el
    // pipeline ejecutó OK. Cualquier fallo queda en `feeChargeError` y NO
    // rompe la respuesta 200 (CD-4).
    let feeChargeError: string | undefined;
    let feeChargeTxHash: string | undefined;
    if (pipeline.success) {
      const feeResult = await chargeProtocolFee({
        orchestrationId,
        budgetUsdc: budget,
        feeRate,
      });
      if (feeResult.status === 'failed') {
        feeChargeError = feeResult.error;
        console.error('[Orchestrate] fee charge failed:', feeResult.error);
      } else if (
        feeResult.status === 'charged' ||
        feeResult.status === 'already-charged'
      ) {
        feeChargeTxHash = feeResult.txHash;
        // WKH-124 (AC-1): emit protocol_fee receipt when the fee was charged.
        // Lineage lives on the call-site row `request.scopingKeyRow` (owner_ref +
        // id); the fee wallet is the counterparty (read from env here). Best-effort
        // fire-and-forget (CD-B): a failure NEVER interrupts the orchestrate return
        // (CD-1). Guard: without owner_ref → no emit (CD-D).
        if (
          feeResult.status === 'charged' &&
          request.scopingKeyRow?.owner_ref
        ) {
          receiptService
            .emit({
              ownerRef: request.scopingKeyRow.owner_ref,
              agentKeyId: request.scopingKeyRow.id,
              sessionId: null,
              delegationId: null,
              receiptType: 'protocol_fee',
              amountUsd: feeUsdc,
              chainId: request.chainId ?? 0,
              txHash: feeResult.txHash ?? null,
              counterparty: process.env.WASIAI_PROTOCOL_FEE_WALLET ?? null,
              orchestrationId,
            })
            .catch((e) =>
              console.warn(
                '[receipts] emit failed',
                e instanceof Error ? e.message : e,
              ),
            );
        }
      }
      // 'skipped' → no error, no txHash → ambos undefined (wallet unset).
    }

    // WKH-127 (DT-3): credit-back post-compose. Solo master Agent Key (CD-9/CD-15:
    // x402 y deleg/session no entran). CD-2: solo si el pipeline NO tuvo éxito —
    // un pipeline exitoso NUNCA recibe refund (no revenue leak).
    let refundError: boolean | undefined;
    let remainingBudgetUsd: string | undefined;
    if (billingKeyRow && request.chainId !== undefined) {
      let refundUsd = 0;
      if (!pipeline.success) {
        if (pipeline.totalCostUsdc === 0) {
          // AC-5 fallo total: el step-0 ni settleó → reembolsar el step-0 entero
          // (debitedUsd = precio del step-0). Arregla el incidente original.
          refundUsd = debitedUsd;
        } else {
          // AC-6 parcial (CD-14): si el step-0 settleó, totalCostUsdc ≥ debitedUsd
          // (debitedUsd = precio del step-0, incluido en el costo real) → 0. No se
          // reembolsa un step-0 ya entregado. Clamp a 0 por seguridad.
          refundUsd = Math.max(0, debitedUsd - pipeline.totalCostUsdc);
        }
      }
      if (refundUsd > 0) {
        const creditRes = await budgetService.credit(
          billingKeyRow.id,
          request.chainId,
          refundUsd,
          billingKeyRow.owner_ref,
        );
        if (!creditRes.success) {
          // AC-8: log estructurado + flag, sin msg crudo de PG (CD-6).
          console.error('[orchestrate.refund-failed]', {
            keyId: billingKeyRow.id,
            chainId: request.chainId,
            amountUsd: refundUsd,
            orchestrationId,
          });
          refundError = true;
        }
      }

      // WKH-127: saldo post-débito (y post-refund) real — se relee DESPUÉS del
      // refund para reflejar el saldo final. El route lo escribe en el header.
      remainingBudgetUsd = await budgetService
        .getBalance(billingKeyRow.id, request.chainId, billingKeyRow.owner_ref)
        .catch(() => undefined);
    }

    const totalLatencyMs = Date.now() - startTime;

    // AC6: Track orchestrate_goal event (fire-and-forget)
    eventService
      .track({
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
      })
      .catch((err) =>
        console.error('[Orchestrate] event tracking failed:', err),
      );

    return {
      orchestrationId,
      answer: pipeline.output,
      reasoning,
      pipeline,
      consideredAgents: discovered.agents,
      protocolFeeUsdc,
      // WKH-44: spread condicional — solo aparecen en el body si hay valor.
      ...(feeChargeError !== undefined && { feeChargeError }),
      ...(feeChargeTxHash !== undefined && { feeChargeTxHash }),
      // WKH-127: refundError/debitFallback/remainingBudgetUsd condicionales.
      ...(refundError !== undefined && { refundError }),
      ...(debitFallback && { debitFallback }),
      ...(remainingBudgetUsd !== undefined && { remainingBudgetUsd }),
    };
  },
};
