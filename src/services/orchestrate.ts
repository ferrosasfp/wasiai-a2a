/**
 * Orchestrate Service — Goal-based multi-agent orchestration with LLM planning
 *
 * WKH-13: Replaces greedy planPipeline with Claude Sonnet LLM planning.
 * Includes: orchestrationId, protocolFeeUsdc, event tracking, timeout, fallback.
 */

import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { splitsActive } from '../config/split-config.js';
import {
  anthropicCircuitBreaker,
  CircuitOpenError,
} from '../lib/circuit-breaker.js';
import {
  CONTRACTING_LOOP_DETECTED,
  contractingErrorMessage,
  isSelfDestination,
  resolveSelfHosts,
  rollUpCascadedFee,
} from '../lib/contracting-chain.js';
import { getStepGasOverheadUsd } from '../lib/gas-overhead.js';
import { getLogger } from '../lib/logger.js';
import { PLACEHOLDER_FEE_USD } from '../lib/pricing-constants.js';
import { refundIdemKey } from '../lib/refund-idem.js';
// HU-203: la MISMA forma de evento que emite `services/compose.ts`, para que las dos
// retenciones lleguen a la misma cola de reconciliación.
import { buildSettleUnknownEvent } from '../lib/settle-withholding.js';
import type {
  Agent,
  ComposeStep,
  OrchestratePlanResult,
  OrchestrateRequest,
  OrchestrateResult,
  ResolvedComposeStep,
} from '../types/index.js';
import {
  resolveAgentDestination,
  resolveAgentPriceUsdc,
} from './agent-price.js';
import { resolveAgentSplitContext } from './agent-split-context.js';
import { budgetService } from './budget.js';
import { composeService } from './compose.js';
import { discoveryService } from './discovery.js';
import { eventService } from './event.js';
import {
  chargeProtocolFee,
  type FeeChargeParams,
  getProtocolFeeRate,
} from './fee-charge.js';
import type { SplitPartyRef } from './fee-split.js';
import {
  getLlmTimeoutMs,
  getPlannerMaxTokens,
  getPlannerModel,
} from './llm/models.js';
import { receiptService } from './receipt.js';
import { refundOutbox } from './refund-outbox.js';
import { genericAcceptanceCriteria } from './verification.js';

const log = getLogger('orchestrate');
// WKH-128: el planner ve hasta 30 agentes (antes 10). Con solo 3 demos echo
// verificados en prod, un tope de 10 empujaba a los agentes relevantes fuera de
// la ventana visible del LLM → plan vacío → fallback greedy a los demos baratos
// → settlement de agentes irrelevantes. 30 entra cómodo en el prompt y deja ver
// los agentes de negocio.
const MAX_AGENTS_IN_PROMPT = 30;

// WKH-128: agentes echo/demo triviales que NO aportan valor de negocio. En prod
// son los únicos verificados, así que el sort verified-first de discovery los
// pone arriba y desplazan a los agentes relevantes. Acá (SOLO en el candidate set
// de orchestrate — NO se toca /discover ni discovery.ts) los mandamos al fondo de
// la lista para que la ventana visible la ocupen agentes reales.
//
// Detección por slug porque no existe un flag de metadata "demo" en el Agent type
// ni en el AGENT_BLOCKLIST (que excluiría del discover entero, no es lo que
// queremos: los demos siguen siendo REACHABLE en el candidate set). Pero un plan
// hecho ENTERAMENTE de demos echo se trata como `no_relevant_agent` y NO se cobra
// (ver change 3 más abajo): nada se settlea para un echo irrelevante. Un test de
// conectividad explícito sería un opt-in futuro separado (todavía no implementado).
// Override vía env ORCHESTRATE_DEMO_SLUGS (CSV) para no hardcodear.
const DEFAULT_DEMO_SLUGS = 'base-demo,avax-demo,kite-demo';

/** Slugs de demos echo a deprioritizar en el candidate set de orchestrate. */
function getDemoSlugs(): Set<string> {
  return new Set(
    (process.env.ORCHESTRATE_DEMO_SLUGS ?? DEFAULT_DEMO_SLUGS)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** True si el agente es un demo echo trivial (por slug, case-insensitive). */
function isDemoAgent(agent: Agent, demoSlugs: Set<string>): boolean {
  return demoSlugs.has(agent.slug.toLowerCase());
}

/**
 * WKH-128: reordena el candidate set de orchestrate poniendo los demos echo al
 * FONDO (stable partition: conserva el orden relativo de discovery dentro de cada
 * grupo). Así los agentes relevantes ocupan la ventana visible del LLM y los
 * primeros candidatos del greedy. NO filtra: los demos siguen REACHABLE en el
 * candidate set, pero un plan compuesto sólo por demos echo se trata como
 * `no_relevant_agent` y NO se cobra (change 3). Un test de conectividad explícito
 * sería un opt-in futuro separado (todavía no implementado).
 */
function deprioritizeDemoAgents(agents: Agent[]): Agent[] {
  const demoSlugs = getDemoSlugs();
  const real: Agent[] = [];
  const demos: Agent[] = [];
  for (const a of agents) {
    if (isDemoAgent(a, demoSlugs)) demos.push(a);
    else real.push(a);
  }
  return [...real, ...demos];
}
// WKH-44 (CD-G): el PROTOCOL_FEE_RATE literal fue eliminado. Ahora se lee
// por request desde process.env vía getProtocolFeeRate() en ./fee-charge.ts.
const PRE_COMPOSE_TIMEOUT_MS = 90_000;

// ─── LLM Planning ───────────────────────────────────────────

interface LlmPlanAgent {
  slug: string;
  registry: string;
  input: Record<string, unknown>;
  reasoning: string;
  /** WKH-114 (AC-1): AC verificables emitidos por el planner en el MISMO call. */
  acceptanceCriteria?: string[];
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

/**
 * WKH-158: true iff the LLM planner is configured (Anthropic client available,
 * i.e. `ANTHROPIC_API_KEY` present). Thin proxy over `getAnthropicClient()` used
 * to discriminate a transient `llmPlan` failure (retry-able) from a permanent
 * `!client` config-absent failure (NOT retry-able → greedy directo).
 */
function plannerConfigured(): boolean {
  return getAnthropicClient() !== null;
}

/**
 * WKH-114 (AC-1/AC-7): sanea los AC emitidos por el planner LLM en el MISMO
 * call (getPlannerModel/getPlannerMaxTokens — cero LLM extra, cero literal de
 * modelo). Conserva strings no-vacíos (trim), recorta a máx 4. Devuelve null
 * si no quedó ninguno válido → el caller cae a genericAcceptanceCriteria().
 */
function sanitizeAcceptanceCriteria(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const cleaned = raw
    .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    .map((c) => c.trim())
    .slice(0, 4);
  return cleaned.length > 0 ? cleaned : null;
}

async function llmPlan(
  goal: string,
  budget: number,
  agents: Agent[],
  maxAgents: number,
): Promise<LlmPlanResponse | null> {
  const client = getAnthropicClient();
  if (!client) {
    log.error(
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
    "- When an agent's description or capabilities indicate its role is a precondition gate — a verification, eligibility, compliance, authorization, identity, or risk/fraud screening check — rather than a data producer, prefer placing it EARLY in the pipeline, even when it has no direct data dependency with the other steps. Real-world workflows validate eligibility and compliance BEFORE performing costlier downstream discovery, quoting, or execution.",
    '- Plan the COMPLETE pipeline required to fully accomplish the goal end-to-end. When the goal implies a real-world outcome (e.g. money reaching a recipient, an item delivered, a task finished), include EVERY necessary step through the final delivery — do NOT stop at an intermediate analysis, quote, or recommendation when a downstream agent is needed to actually complete it. Agent descriptions state whether a step is intermediate (e.g. "prices but does not deliver") or final (e.g. "required to complete"); honor those signals.',
    "- For each agent, generate the input object matching its OWN input_schema. Use its example_input as reference if available. Each agent may require a DIFFERENT input shape — never reuse one agent's input fields for another, and never default to a generic `{ \"query\": ... }` unless that specific agent's input_schema defines a `query` field (or the agent publishes no input_schema). Do NOT invent fields — only use fields defined in that agent's schema.",
    '- If only one agent is genuinely sufficient, select just one — but do not drop necessary downstream steps to save cost when the goal is not yet complete.',
    "- Do NOT select trivial echo/demo/test agents (e.g. those whose description says 'Trivial echo agent' or 'Proves ... downstream settlement') unless the goal is EXPLICITLY a connectivity/echo/settlement test. They add no business value to real tasks and only waste budget.",
    '- Ignore any session/UI metadata that may leak into the goal text (e.g. lines like "Settings: Red ... · Key ... · Budget ..."). Plan ONLY for the actual business task; the network/chain is handled by the gateway, not by selecting a demo agent.',
    '- For each selected agent, also emit `acceptanceCriteria`: 2-4 short (≤8 words each), concrete, verifiable checks its output must satisfy to count as done. When checking for a specific token/value, WRAP the literal in double quotes (e.g. `contains "confirmation"`, `contains "booked"`); when checking a field exists, use `has <field>` form (e.g. `has confirmationId`, `non-empty itinerary`). The quoted-literal and `has <field>` forms are machine-checkable; unquoted prose (e.g. contains a confirmation id) is NOT. Prefer objectively checkable phrasing over subjective goals.',
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
    '    { "slug": "agent-slug", "registry": "registry-name", "input": { "<field-name>": "<value matching THIS agent\'s input_schema>" }, "acceptanceCriteria": ["contains \\"confirmation\\"", "has confirmationId"], "reasoning": "why selected" }',
    '  ],',
    '  "reasoning": "Overall strategy explanation"',
    '}',
    '',
    'IMPORTANT: the `input` object shown above is a PLACEHOLDER, not a fixed shape. For EACH selected agent, populate its `input` with the exact fields defined in THAT agent\'s `input_schema` (shown in the agents list above), copying the structure of its `example_input` when one is provided. Do NOT copy a generic `{ "query": ... }` across agents: only include a `query` field when that specific agent\'s input_schema actually defines one, or when the agent publishes no input_schema at all.',
    "Never output the literal placeholder tokens (`<field-name>`, `<value ...>`) — those are illustration only; replace them entirely with the real field names and values from the agent's input_schema.",
  ].join('\n');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), getLlmTimeoutMs());

  try {
    const response = await anthropicCircuitBreaker.execute(() =>
      client.messages.create(
        {
          model: getPlannerModel(),
          max_tokens: getPlannerMaxTokens(),
          // WKH-134: Sonnet 5 runs adaptive thinking by default when `thinking`
          // is omitted (4.6 ran thinking-off). With max_tokens=1024 and a
          // JSON-only contract, adaptive thinking can consume the budget and
          // truncate the plan JSON. Pin thinking-off to preserve 4.6 behavior.
          thinking: { type: 'disabled' },
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
      log.error('[Orchestrate] LLM returned empty or invalid selectedAgents');
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
      log.error('[Orchestrate] LLM returned agents without valid slugs');
      return null;
    }

    return {
      selectedAgents: validated,
      reasoning,
    };
  } catch (err) {
    // Let CircuitOpenError propagate to error boundary
    if (err instanceof CircuitOpenError) throw err;
    log.error(
      { detail: err instanceof Error ? err.message : err },
      '[Orchestrate] LLM planning failed',
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
): { steps: ResolvedComposeStep[]; reasoning: string; cost: number } {
  const selected: Agent[] = [];
  let remaining = budget;

  for (const agent of agents) {
    if (agent.priceUsdc > remaining) continue;
    if (selected.length >= maxAgents) break;
    selected.push(agent);
    remaining -= agent.priceUsdc;
  }

  const steps: ResolvedComposeStep[] = selected.map((agent, index) => ({
    agent: agent.slug,
    registry: agent.registry,
    input: { goal },
    passOutput: index > 0,
    // WKH-114 (AC-1, DT-1(c)): greedy fallback usa AC genéricos determinísticos
    // (sin LLM). Garantiza que TODO step lleva una lista no-vacía a compose.
    acceptanceCriteria: genericAcceptanceCriteria(),
  }));

  // WKH-127 (BLQ-ALTO-1): el débito post-plan del service cubre SOLO el step-0
  // (reemplaza el placeholder $1 del middleware). Los steps 1..N los sigue
  // debitando compose (guard i>0). Por eso `cost` = precio del primer step, NO
  // la suma del plan (sumarlo duplicaría 1..N → double-charge).
  const step0Cost = selected[0]?.priceUsdc ?? 0;

  // Suma total del plan: solo para el texto de reasoning (no es base del débito).
  const totalEstimate = selected.reduce((sum, a) => sum + a.priceUsdc, 0);

  const reasoning =
    selected.length > 0
      ? `Selected ${selected.length} agents: ${selected.map((a) => a.name).join(', ')}. ` +
        `Total estimated cost: ${totalEstimate.toFixed(4)} USDC.`
      : 'No agents fit within budget.';

  return { steps, reasoning, cost: step0Cost };
}

// ─── Fallback Relevance Guard (money-path) ───────────────────
//
// El fallback greedy (activo SOLO cuando el LLM planner falló / devolvió null /
// circuit breaker abierto) selecciona agentes por PRESUPUESTO ÚNICAMENTE — cero
// relevancia con el goal. Un goal sin sentido produce así un plan 'ready' de
// agentes REALES (no-demo) que sólo entran en budget, cobrable si un cliente
// ingenuo lo ejecuta sin revisar. Este chequeo de overlap de keywords barato
// (en memoria, SIN LLM, SIN llamadas externas) corre SOLO en el path de fallback
// (usedFallback === true). El path normal del LLM juzga relevancia con su propio
// criterio semántico y su plan es AUTORITATIVO: se ejecuta tal cual (WKH-166
// removió el backstop léxico determinístico PER-STEP que corría sobre el plan del
// LLM y dropeaba steps con buen juicio del planner). El smart-drop semántico por
// embeddings vuelve con WKH-160, re-enganchando en el mismo hook point.

/** Lowercase, split por no-alfanuméricos, descarta tokens < 3 chars. */
function tokenizeForRelevance(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3),
  );
}

/**
 * WKH-152: true si `text` comparte ≥1 token evaluable (≥3 chars) con
 * `goalTokens`. `goalTokens` vacío ⇒ false. Determinístico, en memoria, sin
 * LLM/red. Mismo tokenizador y umbral (overlap ≥1) que `fallbackNoRelevance`.
 * INERTE respecto al path LLM desde WKH-166 (el plan del LLM es autoritativo);
 * queda viva + exportada como hook para WKH-160 y consumida por T-152-8.
 */
export function textOverlapsGoal(
  text: string,
  goalTokens: Set<string>,
): boolean {
  const textTokens = tokenizeForRelevance(text);
  for (const token of goalTokens) {
    if (textTokens.has(token)) return true;
  }
  return false;
}

// ─── Plan early-return → OrchestrateResult mapper (WKH-131) ──
//
// Reconstruye el OrchestrateResult EXACTO que cada early-return del orchestrate
// atómico devolvía hoy (CD-4: byte-idéntico externamente). La telemetría
// (`eventService.track`) YA se disparó dentro de planOrchestration — acá NO se
// re-dispara (CD-NEW-7: no duplicar). `pipeline.success` por planStatus sigue la
// tabla §7 del Story File.
function mapPlanEarlyReturnToOrchestrateResult(
  plan: OrchestratePlanResult,
): OrchestrateResult {
  // §7: insufficient_funds → false; no_agents → true; budget_exhausted → true;
  // no_relevant_agent → false.
  const pipelineSuccess =
    plan.planStatus === 'no_agents' || plan.planStatus === 'budget_exhausted';

  return {
    orchestrationId: plan.orchestrationId,
    answer: null,
    reasoning: plan.reasoning,
    pipeline: {
      success: pipelineSuccess,
      output: null,
      steps: [],
      totalCostUsdc: 0,
      totalLatencyMs: 0,
    },
    consideredAgents: plan.consideredAgents,
    protocolFeeUsdc: 0,
    // no-funds (insufficient_funds) es el único early-return con remainingBudgetUsd.
    ...(plan.remainingBudgetUsd !== undefined && {
      remainingBudgetUsd: plan.remainingBudgetUsd,
    }),
  };
}

// ─── Service ─────────────────────────────────────────────────

export const orchestrateService = {
  /**
   * Orchestrate from a natural language goal.
   * Uses LLM planning with fallback to greedy if LLM fails.
   *
   * WKH-131 (DT-1 Opción A): recompuesto a partir de planOrchestration +
   * executeApprovedPlan. El cuerpo de cada región se movió verbatim (CD-4).
   *
   * @param request - The orchestration request
   * @param orchestrationId - UUID generated by the route handler
   */
  async orchestrate(
    request: OrchestrateRequest,
    orchestrationId: string,
  ): Promise<OrchestrateResult> {
    const plan = await this.planOrchestration(request, orchestrationId);
    if (plan.planStatus !== 'ready') {
      // mismos OrchestrateResult que hoy; el track ya corrió en planOrchestration.
      return mapPlanEarlyReturnToOrchestrateResult(plan);
    }
    // request.maxQuotedCostUsdc === undefined → cap gate inactivo (path atómico).
    const res = await this.executeApprovedPlan(request, plan, orchestrationId);
    // El atómico nunca devuelve __quoteStale (gate inactivo). Narrowing defensivo:
    if ('__quoteStale' in res) {
      throw new Error('unreachable: cap gate inactive on atomic path');
    }
    return res;
  },

  /**
   * WKH-131 (W1.1): planning region (discover + LLM/greedy + price-resolution).
   * Cuerpo verbatim de orchestrate.ts:306-634 (atómico). Cero debit, cero compose,
   * cero settle. Cada early-return devuelve un OrchestratePlanResult con su
   * planStatus y dispara EL MISMO eventService.track de hoy (CD-5/CD-NEW-7).
   *
   * @param request - The orchestration request
   * @param orchestrationId - UUID generated by the route handler
   */
  async planOrchestration(
    request: OrchestrateRequest,
    orchestrationId: string,
  ): Promise<OrchestratePlanResult> {
    const startTime = Date.now();
    const { goal, budget, preferCapabilities, maxAgents = 5 } = request;

    // WKH-132 (DT-3): el fee ya NO se calcula sobre el budget. El guard previo
    // `feeUsdc > budget` (⟺ rate > 1) era INALCANZABLE: getProtocolFeeRate()
    // clampa el rate a [0, 0.10] (fee-charge.ts:102-112), su clamp+log.error ES
    // el fail-fast real contra un PROTOCOL_FEE_RATE corrupto. El fee real se
    // deriva post-planning del costo resuelto (AC-1); el guard cost-vs-cost
    // sobrevive en chargeProtocolFee (fee-charge.ts:167), igual que /compose.

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
      // AUDIT A3 (ALTA): `Number(bal)` de un budget JSONB no-numérico da NaN, y
      // `NaN <= 0 === false` dejaba PASAR el early-fail (un balance corrupto se
      // trataba como "con fondos"). Tratamos NaN/Infinity como saldo insuficiente.
      const n = Number(bal);
      if (!Number.isFinite(n) || n <= 0) {
        const noFundsResult: OrchestratePlanResult = {
          orchestrationId,
          planStatus: 'insufficient_funds',
          steps: [],
          costPerStep: [],
          totalCostUsdc: 0,
          protocolFeeUsdc: 0,
          maxQuotedCostUsdc: 0,
          reasoning: 'Insufficient budget for orchestration',
          consideredAgents: [],
          plannedCostUsd: 0,
          feeUsdc: 0, // WKH-132: sin steps ⇒ sin costo ⇒ sin fee
          usedFallback: false,
          debitFallback: false,
          billingKeyRow,
          discoveredAgents: [],
          remainingBudgetUsd: bal,
        };

        eventService
          .track({
            eventType: 'orchestrate_goal',
            status: 'failed',
            latencyMs: Date.now() - startTime,
            costUsdc: 0,
            goal,
            // WKH-151: pre-discovery early-return ⇒ el retry nunca pudo disparar.
            metadata: {
              orchestrationId,
              agentCount: 0,
              fallback: false,
              broadenRetryUsed: false,
              retryAgentCount: null,
            },
          })
          .catch((err) =>
            log.error({ err }, '[Orchestrate] event tracking failed'),
          );

        return noFundsResult;
      }
    }

    // Step 1: Discover relevant agents
    // Note: do NOT pass goal as query — the text filter is too strict for
    // generic agents (e.g. "Bitcoin" won't match "BlexSignal Scanner").
    // The LLM planner handles relevance matching instead.
    // WKH-128: ventana de candidatos generosa (50, espejo de compose.ts) en vez
    // de `maxAgents * 2`. Con el sort verified-first de discovery, una ventana
    // chica se llenaba de los 3 demos echo + agentshop y dejaba fuera a los
    // agentes de negocio relevantes. El filtro maxPrice/budget se mantiene igual.
    // WKH-151 (telemetría additive): marcadores del broaden-retry para el evento
    // `orchestrate_goal`. broadenRetryUsed=true sólo si el retry sin-caps disparó;
    // retryAgentCount = cuántos agentes trajo el retry (null si no hubo retry).
    let broadenRetryUsed = false;
    let retryAgentCount: number | null = null;
    let discovered = await discoveryService.discover({
      capabilities: preferCapabilities,
      maxPrice: budget / maxAgents,
      limit: 50,
    });

    // WKH-151 (AC-1/AC-7): broaden-retry. Cuando el caller manda
    // `preferCapabilities` que no matchean el nombre EXACTO de las capabilities
    // publicadas por los agentes relevantes (p.ej. Chaski vs `remit.*` en bdwv),
    // el primer discovery vuelve vacío y el early-return `no_agents` de abajo
    // corta ANTES de que el LLM planner —que hace el matching de relevancia real—
    // vea ningún candidato. Un ÚNICO retry (CD-3) sin el filtro de capabilities
    // (DT-2: `capabilities` omitido = el mismo camino que un caller que nunca
    // mandó caps, discovery.ts:311) repuebla el candidate set. CD-2: `maxPrice`
    // y `limit` se preservan idénticos — solo se remueve el filtro de caps, no se
    // relaja el precio. AC-7/CD-5: solo se reintenta si había un filtro de caps
    // que remover; si `preferCapabilities` ya venía vacío/undefined el retry sería
    // idéntico al primero → no se ejecuta (cero llamadas extra en ese caso y en el
    // happy path donde el primer discovery ya trajo agentes).
    if (discovered.agents.length === 0 && preferCapabilities?.length) {
      discovered = await discoveryService.discover({
        maxPrice: budget / maxAgents,
        limit: 50,
      });
      broadenRetryUsed = true;
      retryAgentCount = discovered.agents.length;
      log.info(
        {
          orchestrationId,
          firstPassCaps: preferCapabilities.length,
          retriedWithoutCaps: true,
          retryAgentCount: discovered.agents.length,
        },
        '[Orchestrate] discovery retry without capability filter',
      );
    }

    // AC5: No agents found — return gracefully
    if (discovered.agents.length === 0) {
      const emptyResult: OrchestratePlanResult = {
        orchestrationId,
        planStatus: 'no_agents',
        steps: [],
        costPerStep: [],
        totalCostUsdc: 0,
        protocolFeeUsdc: 0,
        maxQuotedCostUsdc: 0,
        reasoning: `No agents found for goal: "${goal}". Try broadening your search or increasing budget.`,
        consideredAgents: [],
        plannedCostUsd: 0,
        feeUsdc: 0, // WKH-132: sin steps ⇒ sin costo ⇒ sin fee
        usedFallback: false,
        debitFallback: false,
        billingKeyRow,
        discoveredAgents: [],
      };

      // Track no-agents event (fire-and-forget)
      eventService
        .track({
          eventType: 'orchestrate_goal',
          status: 'success',
          latencyMs: Date.now() - startTime,
          costUsdc: 0,
          goal,
          metadata: {
            orchestrationId,
            agentCount: 0,
            fallback: false,
            broadenRetryUsed,
            retryAgentCount,
          },
        })
        .catch((err) =>
          log.error({ err }, '[Orchestrate] event tracking failed'),
        );

      return emptyResult;
    }

    // WKH-128: candidate set para el planner (LLM + greedy) con demos echo al
    // fondo. `discovered.agents` se conserva intacto para `consideredAgents`
    // (reporte) y para los lookups por slug (Set/.find, order-independent).
    const candidateAgents = deprioritizeDemoAgents(discovered.agents);
    // WKH-128: para el no-relevant-agent fallback (change 3) necesitamos saber si
    // TODOS los candidatos visibles son demos (no hay agente real para el goal).
    const demoSlugs = getDemoSlugs();
    const hasRealCandidate = candidateAgents.some(
      (a) => !isDemoAgent(a, demoSlugs),
    );

    // Step 2: LLM Planning (with fallback)
    // HU-208: `ResolvedComposeStep[]` — las dos ramas que lo asignan (fallback
    // greedy y plan del LLM) mapean agentes YA resueltos por discovery a
    // `agent: <slug>`, así que el tipo describe lo que el código garantizaba. El
    // planner NUNCA emite steps por capacidad: `/orchestrate` ya elige el agente,
    // que es un problema distinto del de `/compose` (ver types/index.ts).
    let steps: ResolvedComposeStep[];
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

    // R-3 / OP-10 (audit 2026-06-30): when the Anthropic circuit breaker is OPEN,
    // `llmPlan` re-throws `CircuitOpenError` (which the error boundary maps to a
    // hard 503). Orchestrate already has a deterministic `greedyPlan` fallback
    // for the "LLM failed/returned null" case; an open breaker is the SAME
    // degraded-but-up situation. Catch it here and route to the greedy fallback
    // (`plan = null`) so orchestrate stays available instead of 503-ing.
    // WKH-158: retry `llmPlan` EXACTLY once on a TRANSIENT failure (timeout /
    // net / 5xx / 429 / bad JSON / empty selectedAgents → `plan === null`) before
    // falling to greedy. A PERMANENT failure is NOT retried: `!client` (no
    // ANTHROPIC_API_KEY → `plannerConfigured() === false`) and `CircuitOpenError`
    // (breaker open → `circuitOpen === true`) both break immediately to greedy.
    // Bounded to `attempt <= 1` (max 2 `llmPlan` invocations). The single `plan`
    // var carries the FINAL value into the untouched `if (plan)` below — no
    // debit/compose runs inside the loop, so no double-plan / double-charge.
    let plan: Awaited<ReturnType<typeof llmPlan>> = null;
    for (let attempt = 0; attempt <= 1; attempt++) {
      let circuitOpen = false;
      try {
        plan = await llmPlan(goal, budget, candidateAgents, maxAgents);
      } catch (err) {
        if (err instanceof CircuitOpenError) {
          log.warn(
            { orchestrationId },
            '[Orchestrate] planner circuit open — using greedy fallback',
          );
          plan = null;
          circuitOpen = true;
        } else {
          throw err;
        }
      }

      if (plan) break; // success (1st or retry) — no extra latency
      if (circuitOpen) break; // breaker open — no retry, greedy directo
      if (!plannerConfigured()) break; // !client (no API key) — no retry, greedy
      // else: transient `plan === null` with client configured — retry once
    }

    if (plan) {
      // Validate slugs against discovered agents
      const discoveredSlugs = new Set(discovered.agents.map((a) => a.slug));
      const validAgents = plan.selectedAgents.filter((a) =>
        discoveredSlugs.has(a.slug),
      );

      if (validAgents.length === 0) {
        // All LLM slugs invalid — fallback
        log.error(
          '[Orchestrate] All LLM-selected slugs are invalid — using fallback',
        );
        const fallback = greedyPlan(goal, candidateAgents, budget, maxAgents);
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
          // WKH-114 (AC-1): AC del planner LLM (mismo call) saneados; si el
          // agente no trajo AC válidos → fallback genérico determinístico.
          acceptanceCriteria:
            sanitizeAcceptanceCriteria(a.acceptanceCriteria) ??
            genericAcceptanceCriteria(),
        }));

        // WKH-127 (BLQ-ALTO-1): el débito post-plan del service cubre SOLO el
        // step-0. Los steps 1..N los debita compose (guard i>0). Por eso la base
        // del débito es el precio del primer agente budgeteado, NO `totalCost`
        // (sumar el plan duplicaría 1..N → double-charge).
        // P1 (audit 2026-07-01): resolve the step-0 price with the SAME
        // registry-aware resolver used by the /execute cap-gate and quote
        // (`resolveAgentPriceUsdc(slug, registry)`), NOT a slug-only
        // `discovered.agents.find(d => d.slug === slug)`. The slug-only lookup
        // over the un-deduped enabled-registries list could match a decoy agent
        // registered under a DIFFERENT registry with the same slug (verified /
        // reputation / price-ascending sort lets a $0.000001 decoy win the
        // `.find`), so the step-0 debit was priced off the decoy while
        // `resolveAgent` invoked the real (registry-scoped) agent —
        // quote/débito inconsistency. Keying by (slug, registry) makes the
        // billed price match the agent actually invoked.
        const step0Slug = budgetedAgents[0]?.slug;
        const step0Registry = budgetedAgents[0]?.registry;
        const step0Price =
          step0Slug !== undefined
            ? await resolveAgentPriceUsdc(step0Slug, step0Registry)
            : null;
        plannedCostUsd = step0Price ?? 0;
        reasoning = plan.reasoning;

        if (validAgents.length > budgetedAgents.length) {
          reasoning += ` (${validAgents.length - budgetedAgents.length} agents truncated due to budget)`;
        }
      }
    } else {
      // AC7: LLM failed — fallback to greedy
      const fallback = greedyPlan(goal, candidateAgents, budget, maxAgents);
      steps = fallback.steps;
      reasoning = `[FALLBACK] LLM planning failed. ${fallback.reasoning}`;
      usedFallback = true;
      plannedCostUsd = fallback.cost;
    }

    if (steps.length === 0) {
      // All agents exceed budget — return gracefully
      const noBudgetResult: OrchestratePlanResult = {
        orchestrationId,
        planStatus: 'budget_exhausted',
        steps: [],
        costPerStep: [],
        totalCostUsdc: 0,
        protocolFeeUsdc: 0,
        maxQuotedCostUsdc: 0,
        reasoning: `No agents fit within budget of ${budget} USDC. Try increasing your budget.`,
        consideredAgents: discovered.agents,
        plannedCostUsd: 0,
        feeUsdc: 0, // WKH-132: sin steps ⇒ sin costo ⇒ sin fee
        usedFallback,
        debitFallback: false,
        billingKeyRow,
        discoveredAgents: discovered.agents,
      };

      eventService
        .track({
          eventType: 'orchestrate_goal',
          status: 'success',
          latencyMs: Date.now() - startTime,
          costUsdc: 0,
          goal,
          metadata: {
            orchestrationId,
            agentCount: 0,
            fallback: usedFallback,
            broadenRetryUsed,
            retryAgentCount,
          },
        })
        .catch((err) =>
          log.error({ err }, '[Orchestrate] event tracking failed'),
        );

      return noBudgetResult;
    }

    // WKH-128 (change 3, MNR-1): no-relevant-agent guard. El gatillo es el PLAN
    // SELECCIONADO, no el candidate set. Si TODOS los steps que el planner eligió
    // son demos echo, no hay agente genuino ejecutándose para el goal —incluso si
    // existía un candidato real (caso mixto: el LLM/greedy igual eligió solo
    // demos). Históricamente esos demos baratos se settleaban on-chain (gasto
    // real) para un goal que no podían cumplir → `pipeline.success:false` con
    // dinero ya movido / caller cobrado por un echo irrelevante. Acá cortamos
    // ANTES del débito/settlement: ni se debita ni se ejecuta compose, así el
    // ledger (budget/daily/dest) queda intacto por construcción (no hubo débito
    // que reembolsar). `hasRealCandidate` ya NO gatea el guard; sólo afina el
    // mensaje (existía agente real vs sólo había demos disponibles).
    const allStepsAreDemos =
      steps.length > 0 &&
      steps.every((s) => demoSlugs.has(s.agent.toLowerCase()));

    // Relevance guard para el fallback greedy (ver helper `tokenizeForRelevance`).
    // Gatilla SOLO cuando usedFallback === true Y (el goal no tiene NINGÚN token
    // evaluable ≥3 chars — señal cero ⇒ no relevante — O NINGÚN agente que greedy
    // eligió comparte al menos 1 token con el goal, name + description + capabilities).
    // Mismo remedio que allStepsAreDemos: forzar no_relevant_agent ANTES de
    // cualquier débito/settlement. Este guard greedy es TODO-O-NADA y NO aplica al
    // path del LLM (usedFallback === false).
    //
    // WKH-166: `fallbackNoRelevance` es el ÚNICO guard de relevancia (greedy-only,
    // todo-o-nada). El plan del LLM es AUTORITATIVO — se ejecuta tal cual tras los
    // guards que NO son de relevancia léxica (slug-existe + budget-fit +
    // allStepsAreDemos). El backstop léxico PER-STEP que WKH-152/158/159/163 corrían
    // sobre el plan del LLM fue removido (dropeaba steps bien elegidos por overlap
    // léxico y rompía el flujo de remesas). El smart-drop semántico vuelve con WKH-160.
    const goalTokens = tokenizeForRelevance(goal);
    const fallbackNoRelevance =
      usedFallback &&
      (goalTokens.size === 0 ||
        !steps.some((s) => {
          const agent = discovered.agents.find(
            (a) => a.slug === s.agent && a.registry === s.registry,
          );
          if (!agent) return false;
          const agentTokens = tokenizeForRelevance(
            `${agent.name} ${agent.description} ${agent.capabilities.join(' ')}`,
          );
          for (const token of goalTokens) {
            if (agentTokens.has(token)) return true;
          }
          return false;
        }));

    if (allStepsAreDemos || fallbackNoRelevance) {
      let reasoning: string;
      if (allStepsAreDemos) {
        reasoning = hasRealCandidate
          ? 'no_relevant_agent: the selected plan consists entirely of trivial echo/demo agents even though a real agent was available; no genuinely relevant agent was executed for this goal. No agent was executed and no payment was charged.'
          : 'no_relevant_agent: no genuinely relevant agent was found for this goal (only trivial echo/demo agents are available). No agent was executed and no payment was charged.';
      } else {
        // WKH-159 (cosmetic hardening — NO logic/billing change): enrich the
        // guidance text ONLY. `fallbackNoRelevance` fires inside the greedy path,
        // where the candidate set is ALWAYS non-empty (an empty discovery already
        // returned `no_agents` earlier). So we distinguish, using data already in
        // scope, the two shapes of this rejection:
        //   - goalTokens.size > 0: the goal HAD matchable keywords AND candidate
        //     agents were discovered, but no greedy-selected agent shared a single
        //     token with it. This is the classic vocabulary/LANGUAGE mismatch
        //     (e.g. a Spanish goal vs English-documented agents) — relevant agents
        //     may well exist, so point the caller at `consideredAgents` and the
        //     manual /plan + /execute flow.
        //   - goalTokens.size === 0: the goal carried no matchable keyword at all,
        //     so there is no relevance signal to evaluate — do NOT imply a language
        //     mismatch here.
        // Neither branch alters planStatus, steps, or any billing field: still
        // `no_relevant_agent`, no debit, no compose (AC-5 / CD-1..CD-4).
        reasoning =
          goalTokens.size > 0
            ? "no_relevant_agent: the LLM planner failed and the emergency fallback found no agent whose description lexically matched the goal's keywords. This can happen with non-English or differently-worded goals even when relevant agents exist — review consideredAgents and use /orchestrate/plan + /orchestrate/execute to select an agent manually. No agent was executed and no payment was charged."
            : 'no_relevant_agent: the LLM planner failed and the emergency fallback found the goal carried no matchable keyword to evaluate relevance — no agent was executed and no payment was charged.';
      }
      const noRelevantResult: OrchestratePlanResult = {
        orchestrationId,
        planStatus: 'no_relevant_agent',
        steps: [],
        costPerStep: [],
        totalCostUsdc: 0,
        protocolFeeUsdc: 0,
        maxQuotedCostUsdc: 0,
        reasoning,
        consideredAgents: discovered.agents,
        plannedCostUsd: 0,
        feeUsdc: 0, // WKH-132: sin steps ⇒ sin costo ⇒ sin fee
        usedFallback,
        debitFallback: false,
        billingKeyRow,
        discoveredAgents: discovered.agents,
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
            agentCount: 0,
            fallback: usedFallback,
            reason: 'no_relevant_agent',
            hasRealCandidate,
            broadenRetryUsed,
            retryAgentCount,
          },
        })
        .catch((err) =>
          log.error({ err }, '[Orchestrate] event tracking failed'),
        );

      return noRelevantResult;
    }

    // AC8: Check time again before compose
    const preComposeElapsed = Date.now() - startTime;
    if (preComposeElapsed > PRE_COMPOSE_TIMEOUT_MS) {
      throw new Error(
        `Orchestration timeout: discovery + planning took ${preComposeElapsed}ms (limit: ${PRE_COMPOSE_TIMEOUT_MS}ms)`,
      );
    }

    // WKH-131 (W1.1): plan listo. costPerStep server-side por step (resolución
    // canónica vía resolveAgentPriceUsdc — el cliente NUNCA decide el precio,
    // CD-2/CD-NEW-6). totalCostUsdc es informativo (NO base del débito).
    // maxQuotedCostUsdc espeja augmentX402ChallengeAmount (cache fresco, recién
    // resuelto → forceRefresh false). Internos (plannedCostUsd/feeUsdc/usedFallback/
    // billingKeyRow/discoveredAgents) viajan a executeApprovedPlan.
    const costPerStep: number[] = [];
    for (const step of steps) {
      const price = await resolveAgentPriceUsdc(step.agent, step.registry);
      costPerStep.push(typeof price === 'number' ? price : 0);
    }
    const totalCostUsdc = costPerStep.reduce((sum, c) => sum + c, 0);
    const maxQuotedCostUsdc = await this.quoteMaxCostUsdc(steps, false);
    // WKH-132 (BLQ-MED-1 fix): protocolFeeUsdc = fee REAL cost-based =
    // round(totalCostUsdc × getProtocolFeeRate()). Reconcilia con feeRatePercent
    // por construcción (routes/orchestrate.ts). ANTES era el residual del techo
    // (maxQuotedCostUsdc − totalCostUsdc), que se inflaba por PLACEHOLDER_FEE_USD
    // en steps con price 0/no-resoluble → NO reconciliaba con feeRatePercent.
    // maxQuotedCostUsdc queda como el TECHO/cap del /execute (puede exceder
    // total+fee por el placeholder headroom). Invariante del quote (ya NO ==):
    //   maxQuotedCostUsdc ≥ totalCostUsdc + protocolFeeUsdc.
    // Budget-independent (AC-9). NO es el fee COBRADO: el charge real se deriva de
    // pipeline.totalCostUsdc dentro de executeApprovedPlan (money-path intacto).
    // El MISMO valor cost-based sirve de reserva de maxBudget en /execute (feeUsdc).
    const feeRate = getProtocolFeeRate();
    const protocolFeeUsdc = Number((totalCostUsdc * feeRate).toFixed(6));

    return {
      orchestrationId,
      planStatus: 'ready',
      steps,
      costPerStep,
      totalCostUsdc,
      protocolFeeUsdc,
      maxQuotedCostUsdc,
      reasoning,
      consideredAgents: discovered.agents,
      plannedCostUsd,
      feeUsdc: protocolFeeUsdc, // interno: reserva cost-based para maxBudget (DT-4)
      usedFallback,
      debitFallback: false,
      billingKeyRow,
      discoveredAgents: discovered.agents,
      // WKH-151: viajan a executeApprovedPlan para marcar el evento de éxito.
      broadenRetryUsed,
      retryAgentCount,
    };
  },

  /**
   * WKH-131 (W1.3): espejo línea-a-línea de augmentX402ChallengeAmount
   * (routes/compose.ts:127-178), pero sumando TODOS los steps (no step0Usd +
   * 1..N — acá no hay step-0 ya resuelto). Mismo resolveAgentPriceUsdc, mismo
   * fallback PLACEHOLDER_FEE_USD, mismo (1+rate).toFixed(6), mismo floor 1e-6.
   * CD-NEW-1. En plan: forceRefresh false (cache fresco). En execute: true
   * (cache-bust, RIESGO-2).
   */
  async quoteMaxCostUsdc(
    steps: ComposeStep[],
    forceRefresh: boolean,
  ): Promise<number> {
    let pipelineUsd = 0;
    for (const step of steps) {
      if (!step || typeof step.agent !== 'string') {
        // step malformado → over-estimate (mismo criterio que el mirror).
        pipelineUsd += PLACEHOLDER_FEE_USD;
        continue;
      }
      const price = await resolveAgentPriceUsdc(
        step.agent,
        step.registry,
        forceRefresh,
      );
      const stepUsd =
        typeof price === 'number' && price > 0 && !Number.isNaN(price)
          ? price
          : PLACEHOLDER_FEE_USD; // not-found / 0 / null / NaN
      pipelineUsd += stepUsd;
    }
    if (pipelineUsd <= 0) return 0;
    const total = Number((pipelineUsd * (1 + getProtocolFeeRate())).toFixed(6));
    if (total <= 0) {
      if (pipelineUsd > 0) return 0.000001; // floor never-undercharge
      return 0;
    }
    return total;
  },

  /**
   * WKH-131 (W1.2): execute region (price-fallback $1, debit step-0 + gas,
   * debit-fail early-return, compose, fee + receipt, credit-back WKH-127,
   * remaining, track final). Cuerpo verbatim de orchestrate.ts:636-902 (atómico).
   *
   * Cap gate (AC-3/AC-4/AC-5): solo /execute (maxQuotedCostUsdc !== undefined);
   * corre ANTES de cualquier debit/compose (CD-NEW-3/CD-NEW-4). El path atómico
   * (undefined) NO lo ejecuta → byte-idéntico (AC-10).
   *
   * Money-path disjunto (CD-NEW-2): el débito base del step-0 es
   * `plan.plannedCostUsd` (= resolveAgentPriceUsdc(steps[0]) server-side, NUNCA
   * el cap ni el costo del cliente).
   *
   * @param request - request (+ maxQuotedCostUsdc opcional para el cap gate)
   * @param plan - el OrchestratePlanResult de planOrchestration (o re-derivado
   *   server-side en /execute)
   * @param orchestrationId - UUID
   */
  async executeApprovedPlan(
    request: OrchestrateRequest & { maxQuotedCostUsdc?: number },
    plan: OrchestratePlanResult,
    orchestrationId: string,
  ): Promise<
    | OrchestrateResult
    | {
        __quoteStale: true;
        currentCostUsdc: number;
        maxQuotedCostUsdc: number;
      }
  > {
    const startTime = Date.now();
    const { goal, budget } = request;
    const { steps, usedFallback, feeUsdc } = plan;
    const reasoning = plan.reasoning;
    let plannedCostUsd = plan.plannedCostUsd;
    const feeRate = getProtocolFeeRate();

    // H1 (audit 2026-07-01): step-0 billing target. The service bills the plan's
    // step-0 post-plan for BOTH the master path AND delegation/session — compose
    // bills steps 1..N (guard i>0). `request.scopingKeyRow` is the caller's row
    // in every billable path: it equals `plan.billingKeyRow` for master, and the
    // delegation/session parent (`effectiveRow`) for delegated callers (middleware
    // a2a-key.ts:512/753). x402 has no scopingKeyRow → bills nothing.
    //
    // Before this fix the delegation/session step-0 was billed by NEITHER layer
    // on `/orchestrate*` (the middleware skips it under `skipMiddlewareDebit`, and
    // this service previously gated the post-plan debit on `plan.billingKeyRow`,
    // which is `undefined` for delegation/session) → a delegation/session caller
    // orchestrating a single-step pipeline paid $0 while the operator settled the
    // downstream agent on-chain: a repeatable money-path leak. We now debit the
    // step-0 through the DUAL-LEDGER RPC (parent budget + delegation.total_spent /
    // session.spent_usd) with a symmetric credit-back on failure, mirroring master.
    // `billsStep0` truthiness matches master's previous `billingKeyRow` gate
    // (scopingKeyRow present ⟺ master OR delegation/session; absent ⟺ x402).
    const billsStep0 = request.scopingKeyRow !== undefined;

    // Cap gate (AC-3/AC-4/AC-5) — ANTES del price-fallback y de cualquier
    // budgetService.debit o composeService.compose.
    if (request.maxQuotedCostUsdc !== undefined) {
      // CD-NEW-4: solo /execute, NO atómico.
      const currentCostUsdc = await this.quoteMaxCostUsdc(
        plan.steps,
        /* forceRefresh */ true,
      );
      if (currentCostUsdc > request.maxQuotedCostUsdc) {
        // CD-NEW-3: antes de cualquier débito.
        return {
          __quoteStale: true,
          currentCostUsdc,
          maxQuotedCostUsdc: request.maxQuotedCostUsdc,
        };
      }
    }

    // ── WKH-360 · SITIO 2 del guard de capa 1 (AC-4, step 0 de orchestrate) · 💰
    // El punto exacto NO es una elección: el comentario del cap gate de acá arriba
    // ya declara este lugar como "ANTES del price-fallback y de cualquier
    // budgetService.debit o composeService.compose". Este guard se para ahí mismo,
    // o sea antes del `budgetService.debit` del step-0 (más abajo en este método) y
    // antes del `composeService.compose`.
    //
    // POR QUÉ HACE FALTA además del Sitio 3 (el loop de compose): en /orchestrate*
    // el débito del step-0 lo hace ESTE SERVICE, no el middleware — las tres rutas
    // apagan el débito del middleware con `markSkipMiddlewareDebitHandler`. O sea
    // que para orchestrate el ÚNICO débito del step-0 es el de acá, y si el guard
    // corriera recién dentro de compose el step-0 ya estaría cobrado.
    //
    // Cubre las TRES rutas de orchestrate porque las tres desembocan en este
    // método.
    //
    // ⛔ NO se cruza `plan.discoveredAgents` contra `plan.steps[i].agent` a mano:
    // sería una SEGUNDA expresión de la resolución y divergiría en
    // /orchestrate/execute, donde los steps vienen del body del cliente. Se llama
    // la MISMA `resolveAgentDestination` que usa el Sitio 1, por step, con el mismo
    // patrón de iteración que `quoteMaxCostUsdc`.
    //
    // ─── EL COSTO REAL DE ESTE BLOQUE, MEDIDO (fix-pack CR/BLQ-BAJO-3) ────────
    // [FALSA] ⚠️ Acá decía que esto son N lookups "con cache de 60 s" — el marcador
    // [FALSA] de esta línea es para que un `grep` no confunda la cita con un claim
    // vivo (fix-pack CR/MNR-1). **Es falso**: ese cache NO cubre este camino.
    // El `Map` de `services/agent-price.ts` lo consulta ÚNICAMENTE
    // `resolveAgentPriceUsdc`; `resolveAgentDestination` llama
    // `discoveryService.getAgent` DIRECTO. Lo que cuesta cada iteración es un
    // SELECT a Supabase + **un `ssrfFetch` saliente por registry habilitado**, y
    // hasta el doble si el primer intento con `registry` no matchea (hay un segundo
    // `getAgent` sin registry). Para un plan de 5 steps: hasta 5 SELECT + 10
    // fetches, **secuenciales y antes del débito**.
    //
    // Se deja así, y no detrás de un cache nuevo, por dos razones: (a) el dato
    // tiene que ser FRESCO — el catálogo puede cambiar entre el preflight y la
    // ejecución, y un destino cacheado como ajeno es exactamente el bypass que el
    // guard existe para negar; (b) agregar un cache acá sería un segundo lector del
    // catálogo con su propia política de expiración. Lo que se corrige es la
    // AFIRMACIÓN, que decía que era barato. En `/orchestrate/execute` este lookup
    // igual YA ocurre dentro de `quoteMaxCostUsdc`.
    //
    // ─── Y SI ESTE `await` TIRA: FAIL-CLOSED, DECIDIDO (fix-pack CR/BLQ-BAJO-3) ─
    // No hay `try` a propósito. Un blip de la DB sube al catch del route, que
    // re-lanza ⇒ 5xx **sin débito y sin invocación saliente**. Es superficie de 5xx
    // nueva para el camino atómico, y se acepta: la alternativa (tragarse el error
    // y seguir) es ejecutar el pipeline sin saber si un destino somos nosotros, o
    // sea el guard apagado justo cuando la infra tiembla. Un guard que falla abierto
    // no es un guard. Testigo: `T-L1-3d`.
    //
    // El `selfHosts.length > 0` de adelante no es una optimización cosmética: sin
    // identidad conocida el guard no puede decidir nada, así que evita N lookups que
    // no cambiarían el veredicto. ⚠️ Con el `hint` de abajo ese conjunto ya NO queda
    // vacío en el camino HTTP (el `Host` de la petición siempre aporta un host), así
    // que esta rama corta es hoy el camino de los callers NO-HTTP (el tool MCP y
    // `inbound-task`), que no tienen `Host` que pasar.
    const { hosts: selfHosts } = resolveSelfHosts(request.selfHostHint);
    if (selfHosts.length > 0) {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (!step || typeof step.agent !== 'string') continue;
        const dest = await resolveAgentDestination(step.agent, step.registry);
        if (dest && isSelfDestination(dest.invokeUrl, selfHosts)) {
          log.warn(
            {
              orchestrationId,
              slug: step.agent,
              step: i,
              layer: 'direct',
              site: 'orchestrate-pre-debit',
            },
            'contracting-loop.blocked',
          );
          // Se devuelve un `OrchestrateResult` normal con el código en
          // `pipeline.errorCode`, que es el canal que este repo YA usa para "el
          // pipeline no se ejecutó y acá está el motivo" (el mapeo
          // `pipeline.errorCode === 'SCOPE_DENIED' → 403` de las dos rutas de
          // ejecución). El route agrega el 400 y el `error_code` top-level.
          //
          // Cero débito y cero compose: este `return` está ANTES de los dos.
          const loopResult: OrchestrateResult = {
            orchestrationId,
            answer: null,
            reasoning: contractingErrorMessage(CONTRACTING_LOOP_DETECTED),
            pipeline: {
              success: false,
              output: null,
              steps: [],
              totalCostUsdc: 0,
              totalLatencyMs: 0,
              error: `Step ${i}: ${contractingErrorMessage(CONTRACTING_LOOP_DETECTED)}`,
              errorCode: CONTRACTING_LOOP_DETECTED,
            },
            consideredAgents: plan.discoveredAgents,
            protocolFeeUsdc: 0,
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
                broadenRetryUsed: plan.broadenRetryUsed ?? false,
                retryAgentCount: plan.retryAgentCount ?? null,
              },
            })
            .catch((err) =>
              log.error({ err }, '[Orchestrate] event tracking failed'),
            );

          return loopResult;
        }
      }
    }

    // WKH-127 (AC-4): plannedCost 0 (todos priceUsdc===0) → fallback $1 + warn + flag.
    // El header x-debit-fallback lo setea el route leyendo result.debitFallback (CD-7).
    let debitFallback = false;
    if (billsStep0 && plannedCostUsd === 0) {
      log.warn(
        { orchestrationId, reason: 'registry-miss' },
        '[orchestrate.price.fallback]',
      );
      plannedCostUsd = PLACEHOLDER_FEE_USD;
      debitFallback = true;
    }

    // WKH-127 (AC-1/AC-3, CD-11): débito post-plan del costo real. Sólo path master
    // (billOnService); el middleware saltó el step-0 bajo skipMiddlewareDebit.
    // `debitedUsd` es la ÚNICA fuente de verdad para el refund (AC-5/AC-6/AC-7).
    let debitedUsd = 0;
    if (billsStep0 && request.scopingKeyRow && request.chainId !== undefined) {
      // Gas pass-through (audit 2026-06-25): the step-0 debit must include the
      // per-step gas overhead, consistent with compose's steps 1..N. 0 on
      // testnet / without env → identical to before. `debitedUsd` (price +
      // overhead) stays the single source of truth for the step-0 refund on
      // total failure, so a refunded step-0 returns price + gas.
      const step0GasOverhead = await getStepGasOverheadUsd(request.chainId);
      const step0DebitUsd = plannedCostUsd + step0GasOverhead;
      // H1 (audit 2026-07-01): route the step-0 debit through the SAME
      // `budgetService.debit` dispatcher compose uses per-step. Passing the
      // delegation/session context enrolls the DUAL-LEDGER RPC
      // (debit_delegation_and_parent / debit_session_and_parent → parent budget +
      // total_spent/spent_usd); when both contexts are undefined (master) it
      // routes to the master RPC exactly as before. `undefined` destination
      // mirrors the master step-0 (no dest-cap on step-0; steps 1..N carry it in
      // compose). owner_ref is the authenticated caller's (= parent for deleg/session).
      const debitRes = await budgetService.debit(
        request.scopingKeyRow.id,
        request.chainId,
        step0DebitUsd,
        request.delegationContext, // deleg → dual-ledger RPC; undefined (master) → master RPC
        request.keySessionContext, // session → dual-ledger RPC; undefined (master) → master RPC
        undefined, // destination
        request.scopingKeyRow.owner_ref, // F-04 (audit): owner_ref del caller autenticado
      );
      if (!debitRes.success) {
        // Insufficient/owner mismatch → return graceful SIN ejecutar compose (§4.5).
        const debitFailBal = await budgetService
          .getBalance(
            request.scopingKeyRow.id,
            request.chainId,
            request.scopingKeyRow.owner_ref,
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
          consideredAgents: plan.discoveredAgents,
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
              broadenRetryUsed: plan.broadenRetryUsed ?? false,
              retryAgentCount: plan.retryAgentCount ?? null,
            },
          })
          .catch((err) =>
            log.error({ err }, '[Orchestrate] event tracking failed'),
          );

        return debitFailResult;
      }
      debitedUsd = step0DebitUsd; // ÚNICA fuente de verdad para el refund (incluye gas overhead).
    }

    // Step 3: Execute pipeline. WKH-44 (AC-1): maxBudget deducido del fee.
    // WKH-61: scopingKeyRow se propaga end-to-end para que cada step del
    // pipeline aplique el check de scope contra el Agent real post-resolve.
    const pipeline = await composeService.compose({
      steps,
      maxBudget: budget - feeUsdc, // WKH-132: feeUsdc = reserva COST-BASED (no budget*rate)
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
      // Array PRESTADO por el route para los motivos INTERNOS de skip del leg
      // downstream (canal de operador). Se propaga tal cual: `/orchestrate` corre
      // el MISMO pipeline que `/compose` y su telemetría tiene que poder
      // diagnosticar lo mismo. Ausente ⇒ nadie los pidió.
      downstreamSkipCauses: request.downstreamSkipCauses,
      // WKH-303: precios CONGELADOS por un quote firmado que el caller redimió en
      // `/orchestrate/execute`. Ausente ⇒ compose debita el precio vivo, como hoy.
      frozenStepPricesUsd: request.frozenStepPricesUsd,
      // WKH-360 (AC-7): la traza de contratación entrante baja a compose, que es
      // quien la EMITE con nuestro eslabón y la profundidad incrementada. Sin esta
      // propagación, un pipeline lanzado por /orchestrate saldría con la traza VACÍA
      // y el gateway de al lado no podría cerrar el transitivo ni cooperando.
      contractingChain: request.contractingChain,
      contractingDepth: request.contractingDepth,
      // WKH-360 (fix-pack AR/CR BLQ-MED-1): y el `Host` entrante, que es lo que le
      // da identidad propia a los SITIOS 3 y 4 dentro del pipeline sin ninguna
      // configuración. Sin esta línea, un pipeline lanzado por /orchestrate corre
      // sus steps 1..N con conjunto de identidad VACÍO.
      selfHostHint: request.selfHostHint,
    });

    // WKH-132 (AC-1/DT-1): protocolFeeUsdc reportado = rate sobre el COSTO REAL
    // ejecutado (pipeline.totalCostUsdc), no el budget. Igual al fee cotizado en
    // /plan cuando el pipeline tuvo éxito total y el quote se honró (CD-6); el
    // charge de abajo está gateado por pipeline.success.
    const protocolFeeUsdc = Number(
      (pipeline.totalCostUsdc * feeRate).toFixed(6),
    );

    // Step 4: WKH-44 — best-effort transfer del fee post-compose si el
    // pipeline ejecutó OK. Cualquier fallo queda en `feeChargeError` y NO
    // rompe la respuesta 200 (CD-4).
    let feeChargeError: string | undefined;
    let feeChargeTxHash: string | undefined;
    if (pipeline.success) {
      // WKH-143 (DT-2/DT-5/CD-9/CD-1b): resolvemos el contexto de creator del
      // agente primario SOLO cuando `splitsActive()` (gate NO-throw). Con el
      // default 10000/0/0 el gate es `false` → el helper NO corre, cero query
      // extra, y `feeParams` queda EXACTAMENTE `{orchestrationId, feeBaseUsdc,
      // feeRate}` → byte-idéntico (orchestrate.test.ts:557 exact-match).
      let creator: SplitPartyRef | null = null;
      let referral: SplitPartyRef | null = null;
      if (splitsActive()) {
        const splitCtx = await resolveAgentSplitContext(
          pipeline.steps[0]?.agent,
        );
        creator = splitCtx.creator;
        referral = splitCtx.referral;
      }
      // CD-8: asignación condicional (exactOptionalPropertyTypes).
      const feeParams: FeeChargeParams = {
        orchestrationId,
        feeBaseUsdc: pipeline.totalCostUsdc, // WKH-132/DT-1: espejo compose.ts:539
        feeRate,
      };
      if (creator) feeParams.creator = creator;
      if (referral) feeParams.referral = referral;
      const feeResult = await chargeProtocolFee(feeParams);
      if (feeResult.status === 'failed') {
        feeChargeError = feeResult.error;
        log.error(
          { detail: feeResult.error },
          '[Orchestrate] fee charge failed',
        );
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
              amountUsd: feeResult.feeUsdc, // WKH-132: espejo compose.ts:559
              chainId: request.chainId ?? 0,
              txHash: feeResult.txHash ?? null,
              counterparty: process.env.WASIAI_PROTOCOL_FEE_WALLET ?? null,
              orchestrationId,
            })
            .catch((e) =>
              log.warn(
                { detail: e instanceof Error ? e.message : e },
                '[receipts] emit failed',
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
    if (billsStep0 && request.scopingKeyRow && request.chainId !== undefined) {
      let refundUsd = 0;
      if (!pipeline.success) {
        if (pipeline.totalCostUsdc === 0) {
          // AC-5 fallo total: el step-0 ni settleó → reembolsar el step-0 entero
          // (debitedUsd = precio del step-0). Arregla el incidente original.
          //
          // HU-203 GUARD 3 (de 3) — "ni settleó" es una INFERENCIA, y hay un caso en
          // que es falsa: si el settle del step 0 devolvió evidencia de broadcast (o el
          // facilitator no dio un veredicto legible), `totalCostUsdc` sigue en 0 porque
          // el step no se contabilizó, pero la plata pudo haber salido igual. `compose`
          // no puede frenar este reembolso desde adentro: el débito del step 0 no es
          // suyo (su guard `i > 0` lo excluye a propósito), lo hace y lo deshace ESTE
          // bloque. Por eso el veredicto viaja en `pipeline.settleRefundWithheld`.
          //
          // El `step === 0` es LOAD-BEARING: si el settle sin resolver fue el de un
          // step POSTERIOR, `compose` ya retuvo el débito de ese step, y el del step 0
          // es plata del caller que nunca se gastó — retenerla también sería dejarlo
          // cobrado sin contraprestación.
          const step0SettleUnknown = pipeline.settleRefundWithheld?.step === 0;
          if (step0SettleUnknown) {
            const withheld = pipeline.settleRefundWithheld;
            log.error(
              {
                orchestrationId,
                error_code: 'SETTLE_REFUND_WITHHELD',
                step: 0,
                reason: withheld?.reason,
                settleTxHash: withheld?.txHash ?? null,
                withheldUsd: debitedUsd,
                detail: pipeline.error,
              },
              '[orchestrate.settle-unknown] the step-0 settle may have executed on-chain, so its debit was NOT refunded — reconcile against the chain before returning it by hand',
            );
            eventService
              .track(
                buildSettleUnknownEvent({
                  withholding: {
                    reason: withheld?.reason ?? 'no-facilitator-answer',
                    txHash: withheld?.txHash ?? null,
                    detail: pipeline.error ?? 'step 0 settle result unknown',
                  },
                  withholder: 'orchestrate-step0',
                  withheldUsd: debitedUsd,
                  refundWithheld: true,
                  step: 0,
                  keyId: request.scopingKeyRow.id,
                  ownerRef: request.scopingKeyRow.owner_ref,
                  chainId: request.chainId,
                }),
              )
              .catch((trackErr: unknown) =>
                log.error(
                  {
                    orchestrationId,
                    detail:
                      trackErr instanceof Error ? trackErr.message : 'unknown',
                  },
                  '[orchestrate.settle-unknown] the withheld refund could not be persisted as an event — the only remaining record is the log line above',
                ),
              );
          } else {
            refundUsd = debitedUsd;
          }
        } else {
          // AC-6 parcial (CD-14): el step-0 SÍ settleó (totalCostUsdc > 0). El
          // costo real del pipeline (`totalCostUsdc`) se contabiliza SOLO con el
          // precio del agente — NO incluye el gas overhead. Para no reembolsar
          // de más, comparamos contra la porción de PRECIO del débito de step-0
          // (`plannedCostUsd`), no contra `debitedUsd` (que incluye el gas). El
          // gas overhead NO se reembolsa en un step-0 ya settleado: el gateway
          // YA gastó ese gas on-chain. Audit 2026-06-25. Clamp a 0 por seguridad.
          refundUsd = Math.max(0, plannedCostUsd - pipeline.totalCostUsdc);
        }
      }
      if (refundUsd > 0) {
        // H1 (audit 2026-07-01): SYMMETRIC credit-back to the step-0 debit above.
        // delegation/session must revert the DUAL ledger (parent budget +
        // total_spent/spent_usd) via creditDelegation/creditSession — a plain
        // master credit() would refund the parent but leave total_spent/spent_usd
        // inflated (the M1 self-DoS). No `destination` (mirror of the step-0 debit).
        // HU-194: UUID server-side de ESTA ejecución del refund. El bloque corre
        // a lo sumo una vez por `executeApprovedPlan`, así que identifica el
        // refund lógico; dos ejecuciones son dos débitos y dos refunds legítimos.
        const refundRunId = randomUUID();
        // HU-194: clave del refund LÓGICO del step-0 de esta ejecución.
        // `operationId` es un UUID server-side por ejecución (`refundRunId`), NO
        // el `orchestrationId`: ese último llega en el BODY de
        // `POST /orchestrate/execute` (`routes/orchestrate.ts`,
        // `OrchestrateExecuteBody`), o sea es caller-controlled — un caller que
        // repitiera el mismo id haría que su segundo refund (legítimo, de otro
        // débito) se descartara como duplicado.
        const idem = {
          idemKey: refundIdemKey({
            keyId: request.scopingKeyRow.id,
            chainId: request.chainId,
            operationId: refundRunId,
            slot: 'orchestrate-step0',
          }),
        };
        const creditRes = request.delegationContext
          ? await budgetService.creditDelegation(
              request.delegationContext.delegationId,
              request.delegationContext.ownerRef,
              request.delegationContext.keyId,
              request.chainId,
              refundUsd,
              idem,
            )
          : request.keySessionContext
            ? await budgetService.creditSession(
                request.keySessionContext.sessionId,
                request.keySessionContext.ownerRef,
                request.keySessionContext.keyId,
                request.chainId,
                refundUsd,
                idem,
              )
            : await budgetService.credit(
                request.scopingKeyRow.id,
                request.chainId,
                refundUsd,
                request.scopingKeyRow.owner_ref,
                idem,
              );
        if (!creditRes.success) {
          // AC-8: log estructurado + flag, sin msg crudo de PG (CD-6).
          log.error(
            {
              keyId: request.scopingKeyRow.id,
              chainId: request.chainId,
              amountUsd: refundUsd,
              orchestrationId,
            },
            '[orchestrate.refund-failed]',
          );
          refundError = true;
          // M6 (audit 2026-06-24): el refund NO aplicó nada (success:false →
          // reverted:false / 0 filas). Encolar para reintento confiable. La
          // invariante anti-doble-refund se sostiene: solo se encola cuando NADA
          // se aplicó; el retry re-credita y marca done solo si revierte de
          // verdad. Best-effort: el enqueue NUNCA rompe el response.
          // H1 (audit 2026-07-01): SOLO master. El refund-outbox acredita el
          // ledger master (parent budget) únicamente; encolar un refund de
          // delegation/session ahí NO decrementaría total_spent/spent_usd →
          // reintroduciría el skew dual-ledger (M1). Para deleg/session el flag
          // refundError + el log estructurado son la señal (best-effort), sin
          // outbox de ledger equivocado.
          if (!request.delegationContext && !request.keySessionContext) {
            await refundOutbox.enqueueRefund({
              keyId: request.scopingKeyRow.id,
              chainId: request.chainId,
              amountUsd: refundUsd,
              ownerRef: request.scopingKeyRow.owner_ref,
              reason: 'orchestrate.refund-failed',
              idemKey: idem.idemKey,
            });
          }
        }
      }

      // WKH-127: saldo post-débito (y post-refund) real — se relee DESPUÉS del
      // refund para reflejar el saldo final. El route lo escribe en el header.
      remainingBudgetUsd = await budgetService
        .getBalance(
          request.scopingKeyRow.id,
          request.chainId,
          request.scopingKeyRow.owner_ref,
        )
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
          // WKH-151: confirma en bdwv que el broaden-retry resolvió el $0.
          broadenRetryUsed: plan.broadenRetryUsed ?? false,
          retryAgentCount: plan.retryAgentCount ?? null,
        },
      })
      .catch((err) =>
        log.error({ err }, '[Orchestrate] event tracking failed'),
      );

    return {
      orchestrationId,
      answer: pipeline.output,
      reasoning,
      pipeline,
      consideredAgents: plan.discoveredAgents,
      protocolFeeUsdc,
      // WKH-360 (AC-11/AC-12): el fee de orquestación AJENO, sumado sobre los steps
      // cuyo ejecutor resultó ser a su vez un coordinador. Los dos campos quedan
      // AUSENTES si no hubo ninguno, que es el 100% del tráfico de hoy ⇒ respuesta
      // byte-idéntica. `partial` ⟺ hubo un coordinador que no declaró su monto: sin
      // ese tercer valor, un total al que le falta un sumando se leería como
      // completo. La MISMA función pura que usa `/compose`, para que las tres
      // superficies no puedan calcularlo distinto.
      ...rollUpCascadedFee(pipeline.steps.map((st) => st.coordinatorFee)),
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
