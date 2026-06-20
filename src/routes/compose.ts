/**
 * Compose Routes — Multi-agent pipelines
 * WKH-18: Timeout preHandler, error boundary integration.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { requirePaymentOrA2AKey } from '../middleware/a2a-key.js';
import { requireForwardKey } from '../middleware/forward-key.js';
import { orchestrateRateLimit } from '../middleware/rate-limit.js';
import { createTimeoutHandler } from '../middleware/timeout.js';
import {
  resolveAgentDestination,
  resolveAgentPriceUsdc,
} from '../services/agent-price.js';
import { composeService } from '../services/compose.js';
import { normalizeDestination } from '../services/spend-policy.js';
import type { ComposeStep } from '../types/index.js';

/**
 * WKH-125 BLQ-ALTO-1 (fix-pack): deriva el destino `"<registry>/<slug>"` del
 * step-0 a partir del AGENTE RESUELTO por discovery (`registry`/`slug`
 * canónicos), NO de los campos crudos del body. Así step-0 keyea idéntico al
 * per-step (`compose.ts:166` usa `normalizeDestination(${agent.registry}/${agent.slug})`)
 * y el cap por destino se evalúa aunque el caller omita `registry`. Normaliza
 * con el MISMO normalizador que la policy/ledger. Defensivo: si la normalización
 * fallara (destino vacío), devuelve undefined (no augmenta `composeDestination`
 * → step-0 sigue 3-arg, back-compat).
 */
function deriveComposeDestination(resolved: {
  registry: string;
  slug: string;
}): string | undefined {
  try {
    return normalizeDestination(`${resolved.registry}/${resolved.slug}`);
  } catch {
    return undefined;
  }
}

type ComposeBody = {
  steps: ComposeStep[];
  maxBudget?: number;
};

/**
 * WKH-59 (real-price-debit) preHandler: resuelve el precio real del primer
 * step ANTES del middleware de debit, e inyecta `request.composeEstimatedCostUsd`.
 *
 * Comportamientos:
 * - Body inválido (sin steps): retorna sin inyectar; el route handler hace 400.
 *   CD-15: NO duplicar validación de shape acá.
 * - Agente no existe: 404 AGENT_NOT_FOUND (CD-10: middleware no corre — reply.sent).
 * - Discovery throws: 503 REGISTRY_UNAVAILABLE (CD-10).
 * - priceUsdc === 0 o null: fallback $1 + warn + header (DT-C, CD-4).
 * - Happy path: inyecta `request.composeEstimatedCostUsd = price`.
 */
async function resolveComposePriceHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = request.body as { steps?: ComposeStep[] } | undefined;

  // CD-15: shape validation la hace el route handler (líneas 40-58 originales).
  if (!body?.steps || !Array.isArray(body.steps) || body.steps.length === 0) {
    return;
  }

  const firstStep = body.steps[0];
  if (!firstStep || typeof firstStep.agent !== 'string') {
    return;
  }

  try {
    const price = await resolveAgentPriceUsdc(
      firstStep.agent,
      firstStep.registry,
    );

    if (price === null) {
      // AC-3: agente no existe → 404, NO debit. CD-10: middleware short-circuited.
      reply.status(404).send({
        error: `Agent not found: ${firstStep.agent}`,
        error_code: 'AGENT_NOT_FOUND',
      });
      return;
    }

    // WKH-125 BLQ-ALTO-1 (fix-pack): resolver el destino canónico desde el
    // AGENTE RESUELTO por discovery (no del body crudo). Espeja la resolución
    // del per-step → step-0 keyea idéntico → el cap se evalúa aunque el caller
    // omita `registry`. `price !== null` ya garantiza que el agente existe.
    const resolved = await resolveAgentDestination(
      firstStep.agent,
      firstStep.registry,
    );
    const composeDestination = resolved
      ? deriveComposeDestination(resolved)
      : undefined;

    if (price === 0) {
      // AC-4 / DT-C: priceUsdc = 0 más probable config error que agente gratis.
      // CD-4: fallback honesto con warn + header.
      request.log.warn(
        {
          reason: 'registry-miss',
          slug: firstStep.agent,
          registry: firstStep.registry ?? null,
        },
        'compose-price.fallback',
      );
      reply.header('x-debit-fallback', 'registry-miss');
      request.composeEstimatedCostUsd = 1.0;
      // WKH-125: el destino del step-0 (el middleware no lee body, CD-7).
      request.composeDestination = composeDestination;
      return;
    }

    // Happy path AC-1
    request.composeEstimatedCostUsd = price;
    // WKH-125: el destino del step-0 (el middleware no lee body, CD-7).
    request.composeDestination = composeDestination;
  } catch (err) {
    // AC-5: error de DB o discovery → 503 REGISTRY_UNAVAILABLE, NO debit.
    // CD-6: NO incluir owner_ref ni nada sensible en el log.
    request.log.error(
      {
        err: err instanceof Error ? err.message : 'unknown',
        slug: firstStep.agent,
      },
      'compose-price.registry-unavailable',
    );
    reply.status(503).send({
      error: 'Registry temporarily unavailable',
      error_code: 'REGISTRY_UNAVAILABLE',
    });
    return;
  }
}

const composeRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: ComposeBody }>(
    '/',
    {
      config: { rateLimit: orchestrateRateLimit() },
      preHandler: [
        // WKH-65: forward-key (optional, env-gated) runs BEFORE timeout/payment.
        // Returns [] when WASIAI_V2_FORWARD_KEY is unset → no-op spread.
        ...requireForwardKey(),
        createTimeoutHandler(
          parseInt(process.env.TIMEOUT_COMPOSE_MS ?? '180000', 10),
        ),
        // WKH-59 (real-price-debit) DT-E: resolver precio ANTES del middleware
        // de debit para inyectar request.composeEstimatedCostUsd y manejar
        // 404 AGENT_NOT_FOUND / 503 REGISTRY_UNAVAILABLE.
        resolveComposePriceHandler,
        ...requirePaymentOrA2AKey({
          description:
            'WasiAI Compose Service — Multi-agent pipeline execution',
        }),
      ],
    },
    async (request, reply: FastifyReply) => {
      const body = request.body;

      if (
        !body.steps ||
        !Array.isArray(body.steps) ||
        body.steps.length === 0
      ) {
        return reply.status(400).send({
          error: 'Missing or empty steps array',
          code: 'VALIDATION_ERROR',
          requestId: request.id,
        });
      }

      if (body.steps.length > 5) {
        return reply.status(400).send({
          error: 'Maximum 5 steps allowed per pipeline',
          code: 'VALIDATION_ERROR',
          requestId: request.id,
        });
      }

      // BLQ-2: bail early if timeout already sent 504
      if (reply.sent) return;

      // WKH-58 fix-pack: propagate x-a2a-key header to service so compose
      // can skip Pieverse inbound x402 (broken upstream WKH-45) when caller
      // already paid via a2a-key (middleware debited budget per-call).
      const a2aKeyHeader = request.headers['x-a2a-key'];
      const a2aKey =
        typeof a2aKeyHeader === 'string' ? a2aKeyHeader : undefined;
      const result = await composeService.compose({
        steps: body.steps,
        maxBudget: body.maxBudget,
        a2aKey,
        // WKH-61: propagar el row del caller para scoping per-step
        scopingKeyRow: request.a2aKeyRow,
        // WKH-101 (DT-11): contexto de delegación para el débito per-step.
        delegationContext: request.delegationContext,
        // WKH-121 (BLQ-ALTO-1): contexto de key-session (poblado por el
        // middleware en a2a-key.ts) para que el cap de sesión se respete en
        // los steps 1..N. Espejo de delegationContext.
        keySessionContext: request.keySessionContext,
        // WKH-59 (real-price-debit) DT-D: chainId del MISMO bundle (CD-12)
        // para debit per-step (steps 2..N) atómico en composeService.
        chainId: request.resolvedChainId,
        // WKH-59 BLQ-MED-1 fix: Pino logger es estructuralmente compatible
        // con DownstreamLogger (warn/info con shape (obj, msg)). Permite que
        // el warn `compose-price.fallback per-step` salga al pino transport
        // configurado en server.ts (vs console.warn raw).
        logger: request.log,
      });

      // BLQ-2: bail early if timeout fired during compose
      if (reply.sent) return;

      if (!result.success) {
        // WKH-61: errorCode='SCOPE_DENIED' → 403; default 400 (preserva legacy).
        // WKH-125 (AC-2): errorCode='DEST_CAP_EXCEEDED' → 402 (cap por destino
        // excedido mid-pipeline; el budget NO se decrementó).
        let status = 400;
        if (result.errorCode === 'SCOPE_DENIED') {
          status = 403;
        } else if (result.errorCode === 'DEST_CAP_EXCEEDED') {
          status = 402;
        }
        return reply.status(status).send({
          ...result,
          requestId: request.id,
        });
      }

      const kiteTxHash = request.paymentTxHash;
      return reply.send({ kiteTxHash, ...result });
    },
  );
};

export default composeRoutes;
