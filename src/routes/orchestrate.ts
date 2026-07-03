/**
 * Orchestrate Routes — Goal-based orchestration with LLM planning
 *
 * WKH-13: orchestrationId generated here (not in service),
 * passed to service, always available for response/error.
 * WKH-18: Backpressure + timeout preHandlers, structured logging, error boundary.
 */

import crypto from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { requirePaymentOrA2AKey } from '../middleware/a2a-key.js';
import { createBackpressureHandler } from '../middleware/backpressure.js';
import { requireForwardKey } from '../middleware/forward-key.js';
import { orchestrateRateLimit } from '../middleware/rate-limit.js';
import { createTimeoutHandler } from '../middleware/timeout.js';
import { resolveAgentPriceUsdc } from '../services/agent-price.js';
import { getProtocolFeeRate } from '../services/fee-charge.js';
import { orchestrateService } from '../services/orchestrate.js';
import type { ComposeStep, OrchestratePlanResult } from '../types/index.js';

type OrchestrateBody = {
  goal: string;
  budget: number;
  preferCapabilities?: string[];
  maxAgents?: number;
};

// WKH-131 (HU-128): body de POST /orchestrate/execute. El cliente reenvía el
// plan aprobado (orchestrationId + steps) y el cap (maxQuotedCostUsdc). Los
// precios del cliente NO se reciben — el route los re-resuelve server-side (CD-2).
type OrchestrateExecuteBody = {
  orchestrationId: string;
  steps: ComposeStep[];
  maxQuotedCostUsdc: number;
  budget: number;
  preferCapabilities?: string[];
  maxAgents?: number;
};

/**
 * WKH-127 (CD-8): marca skip ANTES del middleware de débito. orchestrate debita
 * el costo real post-plan en el service (Opción B); el middleware NO debe debitar
 * el placeholder $1. El flag se respeta SOLO en el path master del middleware
 * (deleg/session lo ignoran — CD-9).
 */
async function markSkipMiddlewareDebitHandler(
  request: FastifyRequest,
): Promise<void> {
  request.skipMiddlewareDebit = true;
}

const orchestrateRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: OrchestrateBody }>(
    '/',
    {
      config: { rateLimit: orchestrateRateLimit() },
      schema: {
        body: {
          type: 'object',
          required: ['goal', 'budget'],
          properties: {
            goal: { type: 'string', minLength: 1, maxLength: 2000 },
            budget: { type: 'number', exclusiveMinimum: 0, maximum: 100000 },
            maxAgents: { type: 'integer', minimum: 1, maximum: 20 },
            preferCapabilities: {
              type: 'array',
              items: { type: 'string', maxLength: 100 },
              maxItems: 20,
            },
          },
        },
      },
      preHandler: [
        // WKH-65: forward-key (optional, env-gated) runs BEFORE backpressure/timeout/payment.
        // Returns [] when WASIAI_V2_FORWARD_KEY is unset → no-op spread.
        ...requireForwardKey(),
        createBackpressureHandler(),
        createTimeoutHandler(
          parseInt(process.env.TIMEOUT_ORCHESTRATE_MS ?? '120000', 10),
        ),
        // WKH-127 (CD-8): marca skip ANTES del middleware de débito.
        markSkipMiddlewareDebitHandler,
        ...requirePaymentOrA2AKey({
          description:
            'WasiAI Orchestration Service — Goal-based AI agent orchestration',
        }),
      ],
    },
    async (request, reply: FastifyReply) => {
      const orchestrationId = crypto.randomUUID();

      try {
        const body = request.body;

        request.log.info({ orchestrationId }, 'Orchestration started');

        // BLQ-2: bail early if timeout already sent 504
        if (reply.sent) return;

        const result = await orchestrateService.orchestrate(
          {
            goal: body.goal.trim(),
            budget: body.budget,
            preferCapabilities: body.preferCapabilities,
            maxAgents: body.maxAgents,
            // WKH-61: propagar el row del caller para scoping per-step en compose
            scopingKeyRow: request.a2aKeyRow,
            // WKH-101 (DT-11): contexto de delegación propagado a compose.
            delegationContext: request.delegationContext,
            // WKH-121 (BLQ-ALTO-1): contexto de key-session propagado a compose
            // para que el cap de sesión se respete en los steps 1..N. Espejo de
            // delegationContext.
            keySessionContext: request.keySessionContext,
            // WKH-104 (TD-COMMENT): chainId resuelto y propagado para TODOS los
            // callers (master keys y sesiones delegadas), para que el débito
            // per-step de steps 1..N use el chainId del bundle resuelto en el
            // middleware. Desde WKH-102 ya no es exclusivo de delegación.
            chainId: request.resolvedChainId,
          },
          orchestrationId,
        );

        // BLQ-2: bail early if timeout fired during orchestration
        if (reply.sent) return;

        const kiteTxHash = request.paymentTxHash;
        // WKH-61: pipeline.errorCode === 'SCOPE_DENIED' → 403 (legacy 200 path).
        // TD-WKH-61-2: la limpieza completa del mapeo `pipeline.success===false`
        // → 4xx queda fuera de scope; solo agregamos el branch SCOPE_DENIED.
        const status = result.pipeline.errorCode === 'SCOPE_DENIED' ? 403 : 200;
        // WKH-127 (AC-4): el service decidió el fallback $1 → seteamos el header acá
        // (el service no recibe reply, CD-7).
        if (result.debitFallback) {
          reply.header('x-debit-fallback', 'registry-miss');
        }
        // WKH-127: saldo post-débito (y post-refund) real — el middleware lo saltó
        // bajo skipMiddlewareDebit, así que lo escribe el route con el valor del service.
        if (result.remainingBudgetUsd !== undefined) {
          reply.header('x-a2a-remaining-budget', result.remainingBudgetUsd);
        }
        return reply.status(status).send({ kiteTxHash, ...result });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Orchestration failed';
        request.log.error(
          { orchestrationId, err: message },
          'Orchestration failed',
        );
        // Attach orchestrationId to the error for the error boundary
        const wrappedErr = err instanceof Error ? err : new Error(message);
        (wrappedErr as Error & { orchestrationId?: string }).orchestrationId =
          orchestrationId;
        throw wrappedErr;
      }
    },
  );

  // ─── WKH-131: POST /orchestrate/plan ──────────────────────────
  // discover + LLM/greedy planning + price-resolution. Cero debit, cero compose,
  // cero settle (CD-1). Devuelve un quote (maxQuotedCostUsdc) + planStatus.
  // preHandlers IDÉNTICOS a `/` (CD-7/AC-12) — incluido markSkipMiddlewareDebit.
  fastify.post<{ Body: OrchestrateBody }>(
    '/plan',
    {
      config: { rateLimit: orchestrateRateLimit() },
      schema: {
        body: {
          type: 'object',
          required: ['goal', 'budget'],
          properties: {
            goal: { type: 'string', minLength: 1, maxLength: 2000 },
            budget: { type: 'number', exclusiveMinimum: 0, maximum: 100000 },
            maxAgents: { type: 'integer', minimum: 1, maximum: 20 },
            preferCapabilities: {
              type: 'array',
              items: { type: 'string', maxLength: 100 },
              maxItems: 20,
            },
          },
        },
      },
      preHandler: [
        ...requireForwardKey(),
        createBackpressureHandler(),
        createTimeoutHandler(
          parseInt(process.env.TIMEOUT_ORCHESTRATE_MS ?? '120000', 10),
        ),
        // WKH-127 (CD-8): marca skip ANTES del middleware de débito (idéntico a `/`).
        markSkipMiddlewareDebitHandler,
        ...requirePaymentOrA2AKey({
          description:
            'WasiAI Orchestration Service — Goal-based AI agent orchestration (plan)',
        }),
      ],
    },
    async (request, reply: FastifyReply) => {
      const orchestrationId = crypto.randomUUID();

      try {
        const body = request.body;

        request.log.info({ orchestrationId }, 'Orchestration plan started');

        // BLQ-2: bail early if timeout already sent 504
        if (reply.sent) return;

        const plan = await orchestrateService.planOrchestration(
          {
            goal: body.goal.trim(),
            budget: body.budget,
            preferCapabilities: body.preferCapabilities,
            maxAgents: body.maxAgents,
            scopingKeyRow: request.a2aKeyRow,
            delegationContext: request.delegationContext,
            keySessionContext: request.keySessionContext,
            chainId: request.resolvedChainId,
          },
          orchestrationId,
        );

        if (reply.sent) return;

        // WKH-132 (fee transparency, AC-1/DT-2): tasa explícita del protocol fee,
        // derivada de la ÚNICA fuente de verdad getProtocolFeeRate() (fee-charge.ts)
        // — la MISMA que produce protocolFeeUsdc, nunca recalculada ni hardcodeada
        // (CD-1). Se expresa en porcentaje (getProtocolFeeRate() * 100, ej. 1 = 1%).
        // Refleja el rate EFECTIVO post-clamp del env (AC-5), nunca el crudo inválido.
        // Solo en planStatus 'ready' (hubo pipeline con fee); en los early-returns
        // protocolFeeUsdc es 0 y feeRatePercent se OMITE para no reportar un fee
        // "cobrado" engañoso sin pipeline (AC-2). Aditivo, no rompe compat (CD-4).
        const feeRatePercent =
          plan.planStatus === 'ready'
            ? Number((getProtocolFeeRate() * 100).toFixed(6))
            : undefined;

        // Solo los campos PÚBLICOS del OrchestratePlanResult (pick). Los internos
        // (plannedCostUsd, feeUsdc, billingKeyRow, discoveredAgents, etc.) NO se
        // serializan al cliente. Sin débito → sin header x-a2a-remaining-budget.
        // feeRatePercent undefined → JSON.stringify lo omite (AC-2).
        return reply.status(200).send({
          orchestrationId: plan.orchestrationId,
          planStatus: plan.planStatus,
          steps: plan.steps,
          costPerStep: plan.costPerStep,
          totalCostUsdc: plan.totalCostUsdc,
          protocolFeeUsdc: plan.protocolFeeUsdc,
          feeRatePercent,
          maxQuotedCostUsdc: plan.maxQuotedCostUsdc,
          reasoning: plan.reasoning,
          consideredAgents: plan.consideredAgents,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Orchestration plan failed';
        request.log.error(
          { orchestrationId, err: message },
          'Orchestration plan failed',
        );
        const wrappedErr = err instanceof Error ? err : new Error(message);
        (wrappedErr as Error & { orchestrationId?: string }).orchestrationId =
          orchestrationId;
        throw wrappedErr;
      }
    },
  );

  // ─── WKH-131: POST /orchestrate/execute ───────────────────────
  // Recibe el plan aprobado (steps) + el cap (maxQuotedCostUsdc). Re-resuelve los
  // precios server-side (cache-bust), rechaza 409 QUOTE_STALE si el precio drifteó
  // por encima del cap; si no, ejecuta el pipeline real idéntico al atómico.
  // markSkipMiddlewareDebitHandler OBLIGATORIO (CD-NEW-5: anti double-charge $1).
  fastify.post<{ Body: OrchestrateExecuteBody }>(
    '/execute',
    {
      config: { rateLimit: orchestrateRateLimit() },
      schema: {
        body: {
          type: 'object',
          required: ['orchestrationId', 'steps', 'maxQuotedCostUsdc', 'budget'],
          properties: {
            orchestrationId: { type: 'string', minLength: 1 },
            steps: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                required: ['agent', 'input'],
                properties: {
                  agent: { type: 'string', minLength: 1 },
                  registry: { type: 'string' },
                  input: { type: 'object' },
                  passOutput: { type: 'boolean' },
                },
              },
            },
            maxQuotedCostUsdc: { type: 'number', minimum: 0 },
            budget: { type: 'number', exclusiveMinimum: 0, maximum: 100000 },
            maxAgents: { type: 'integer', minimum: 1, maximum: 20 },
            preferCapabilities: {
              type: 'array',
              items: { type: 'string', maxLength: 100 },
              maxItems: 20,
            },
          },
        },
      },
      preHandler: [
        ...requireForwardKey(),
        createBackpressureHandler(),
        createTimeoutHandler(
          parseInt(process.env.TIMEOUT_ORCHESTRATE_MS ?? '120000', 10),
        ),
        // WKH-127/CD-NEW-5 (RIESGO-4): OBLIGATORIO — el service debita el step-0
        // post-plan; sin skip el middleware debitaría el placeholder $1 (double-charge).
        markSkipMiddlewareDebitHandler,
        ...requirePaymentOrA2AKey({
          description:
            'WasiAI Orchestration Service — Goal-based AI agent orchestration (execute)',
        }),
      ],
    },
    async (request, reply: FastifyReply) => {
      // BLQ-MED-1 (AR fix): el orchestrationId interno (clave de idempotencia del
      // fee, de débito y de telemetría) se GENERA server-side, igual que el
      // atómico (L90) y /plan (L197). NUNCA se usa el id que manda el cliente como
      // clave de billing: reusarlo permitiría replay del pipeline real cobrando el
      // protocol fee una sola vez (chargeProtocolFee → already-charged) → revenue
      // leak. Cada llamada a /execute produce un id único → cada ejecución cobra
      // su fee. El id del plan que envía el cliente queda SOLO como correlación.
      const orchestrationId = crypto.randomUUID();
      // Correlación plan→execute para analytics (NO se usa para billing/fee/idempotencia).
      const planId = request.body.orchestrationId;

      try {
        const body = request.body;

        request.log.info(
          { orchestrationId, planId },
          'Orchestration execute started',
        );

        // BLQ-2: bail early if timeout already sent 504
        if (reply.sent) return;

        // Re-derivación del plan server-side (CD-2/CD-NEW-6): los precios del
        // cliente se IGNORAN. costPerStep se re-resuelve con resolveAgentPriceUsdc;
        // plannedCostUsd (base del débito step-0) = precio de steps[0] server-side
        // (NUNCA de costPerStep del cliente). WKH-132: feeUsdc = totalCostUsdc * rate
        // (cost-based); sólo seedea la reserva maxBudget, no el fee cobrado.
        const steps = body.steps;
        const costPerStep: number[] = [];
        for (const step of steps) {
          const price = await resolveAgentPriceUsdc(step.agent, step.registry);
          costPerStep.push(typeof price === 'number' ? price : 0);
        }
        // CD-NEW-6: base del débito step-0 server-side (resolveAgentPriceUsdc),
        // NO costPerStep[0] re-usado del cliente — se vuelve a leer del step real.
        // `steps` tiene minItems:1 por schema → step0 siempre definido (guard sin
        // non-null assertion, convención del codebase).
        const step0 = steps[0];
        const step0Price = step0
          ? await resolveAgentPriceUsdc(step0.agent, step0.registry)
          : null;
        const plannedCostUsd = typeof step0Price === 'number' ? step0Price : 0;
        const feeRate = getProtocolFeeRate();
        const totalCostUsdc = costPerStep.reduce((sum, c) => sum + c, 0);
        // WKH-132: base del fee = costo real resuelto server-side, NO budget.
        // Sólo seedea plan.feeUsdc (reserva maxBudget); el fee REALMENTE cobrado
        // se deriva de pipeline.totalCostUsdc dentro de executeApprovedPlan.
        const feeUsdc = Number((totalCostUsdc * feeRate).toFixed(6));

        // WKH-127 (CD-9/CD-11/CD-15): billingKeyRow solo en el path master Agent Key
        // SIN delegación/session (espejo del atómico).
        const billingKeyRow =
          request.delegationContext || request.keySessionContext
            ? undefined
            : request.a2aKeyRow;

        const plan: OrchestratePlanResult = {
          // server-side execution-id (clave de idempotencia/fee/débito).
          orchestrationId,
          planStatus: 'ready',
          steps,
          costPerStep,
          totalCostUsdc,
          protocolFeeUsdc: feeUsdc,
          maxQuotedCostUsdc: body.maxQuotedCostUsdc,
          reasoning: 'execute: plan re-derived server-side',
          consideredAgents: [],
          plannedCostUsd,
          feeUsdc,
          usedFallback: false,
          debitFallback: false,
          billingKeyRow,
          discoveredAgents: [],
        };

        const result = await orchestrateService.executeApprovedPlan(
          {
            goal: '',
            budget: body.budget,
            preferCapabilities: body.preferCapabilities,
            maxAgents: body.maxAgents,
            scopingKeyRow: request.a2aKeyRow,
            delegationContext: request.delegationContext,
            keySessionContext: request.keySessionContext,
            chainId: request.resolvedChainId,
            // gate AC-3: el cap aprobado por el cliente.
            maxQuotedCostUsdc: body.maxQuotedCostUsdc,
          },
          plan,
          orchestrationId,
        );

        if (reply.sent) return;

        // AC-3/AC-5: precio drifteó por encima del cap → 409 QUOTE_STALE, cero debit.
        if ('__quoteStale' in result) {
          return reply.status(409).send({
            error_code: 'QUOTE_STALE',
            currentCostUsdc: result.currentCostUsdc,
            maxQuotedCostUsdc: result.maxQuotedCostUsdc,
          });
        }

        const kiteTxHash = request.paymentTxHash;
        // Mismo mapeo de status/headers que `/` (CD-6).
        const status = result.pipeline.errorCode === 'SCOPE_DENIED' ? 403 : 200;
        if (result.debitFallback) {
          reply.header('x-debit-fallback', 'registry-miss');
        }
        if (result.remainingBudgetUsd !== undefined) {
          reply.header('x-a2a-remaining-budget', result.remainingBudgetUsd);
        }
        return reply.status(status).send({ kiteTxHash, ...result });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Orchestration execute failed';
        request.log.error(
          { orchestrationId, planId, err: message },
          'Orchestration execute failed',
        );
        const wrappedErr = err instanceof Error ? err : new Error(message);
        (wrappedErr as Error & { orchestrationId?: string }).orchestrationId =
          orchestrationId;
        throw wrappedErr;
      }
    },
  );
};

export default orchestrateRoutes;
