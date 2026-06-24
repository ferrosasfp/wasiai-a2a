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
import { orchestrateService } from '../services/orchestrate.js';

type OrchestrateBody = {
  goal: string;
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
};

export default orchestrateRoutes;
