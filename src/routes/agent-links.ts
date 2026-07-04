/**
 * Agent Link Routes — WKH-137 (invocation links).
 *
 * Registrado bajo prefix `/agents`:
 *   POST /agents/:slug/link          — mint (auth: Agent Key MASTER, free auth).
 *   POST /agents/links/:token/redeem — redeem (público, auth por posesión del token).
 *
 * NO hay PATCH/PUT (mint-once inmutable, AC-5/CD-7). El redeem NO usa
 * requirePaymentOrA2AKey — el billing ocurre server-side dentro del service, que
 * reusa executeApprovedPlan (money-path intacto).
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { getAdaptersBundle } from '../adapters/registry.js';
import { createBackpressureHandler } from '../middleware/backpressure.js';
import { orchestrateRateLimit } from '../middleware/rate-limit.js';
import { createTimeoutHandler } from '../middleware/timeout.js';
import {
  AGENT_LINK_TOKEN_PREFIX,
  AgentLinkAlreadyUsedError,
  AgentLinkExecutionUnavailableError,
  AgentLinkExpiredError,
  AgentLinkNotFoundError,
  AgentNotFoundError,
  agentLinkService,
  InvalidAgentLinkInputError,
  PriceExceedsLinkCapError,
  SlugReservedError,
} from '../services/agent-link.js';
import type { CreateAgentLinkInput } from '../types/index.js';
import {
  KEY_SESSION_TOKEN_PREFIX,
  rawKeyFromRequest,
  resolveCallerKey,
} from './auth/parsers.js';

/**
 * Shape-validation del body del mint. Devuelve null si el shape es inválido.
 * `maxPriceUsdc` se acepta string o number → string canónico (sin pérdida; el
 * service valida decimal > 0). `ttlSeconds` opcional; si presente DEBE ser number.
 */
function parseCreateAgentLinkInput(raw: unknown): CreateAgentLinkInput | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const b = raw as Record<string, unknown>;

  let maxPriceUsdc: string;
  if (typeof b.maxPriceUsdc === 'string') {
    maxPriceUsdc = b.maxPriceUsdc;
  } else if (
    typeof b.maxPriceUsdc === 'number' &&
    Number.isFinite(b.maxPriceUsdc)
  ) {
    maxPriceUsdc = String(b.maxPriceUsdc);
  } else {
    return null;
  }

  const input: CreateAgentLinkInput = { maxPriceUsdc };
  if (b.ttlSeconds !== undefined) {
    if (typeof b.ttlSeconds !== 'number') return null;
    input.ttlSeconds = b.ttlSeconds;
  }
  return input;
}

const agentLinkRoutes: FastifyPluginAsync = async (fastify) => {
  // ─── POST /agents/:slug/link — mint (Agent Key MASTER) ──────────
  fastify.post(
    '/:slug/link',
    async (
      req: FastifyRequest<{ Params: { slug: string } }>,
      reply: FastifyReply,
    ) => {
      // CD-6: rechazar authenticators de sesión / link ANTES de resolveCallerKey
      // (que devolvería null y perdería el código exacto). Solo master mintea
      // (anti cap-bypass del session token).
      const rawKey = rawKeyFromRequest(req);
      if (
        rawKey?.startsWith(KEY_SESSION_TOKEN_PREFIX) ||
        rawKey?.startsWith(AGENT_LINK_TOKEN_PREFIX)
      ) {
        return reply.status(403).send({ error_code: 'SESSION_NOT_ALLOWED' });
      }

      // Auth (master key).
      const callerKey = await resolveCallerKey(req);
      if (!callerKey?.is_active) {
        return reply.status(403).send({ error: 'Invalid or inactive API key' });
      }

      // Shape del body (rango fino lo valida el service → INVALID_INPUT).
      const input = parseCreateAgentLinkInput(req.body);
      if (!input) {
        return reply.status(400).send({ error_code: 'INVALID_INPUT' });
      }

      // El mint es free-auth (sin middleware de pago) → resolvedChainId no está
      // seteado; se resuelve el chain por defecto del bundle (key-session.ts:119).
      const chainId =
        req.resolvedChainId ?? getAdaptersBundle()?.chainConfig.chainId;
      if (chainId === undefined) {
        fastify.log.error({}, 'agent-link mint: no chain resolved');
        return reply.status(500).send({ error_code: 'AGENT_LINK_MINT_FAILED' });
      }

      try {
        const result = await agentLinkService.mint(
          callerKey,
          req.params.slug,
          input,
          chainId,
        );
        return reply.status(201).send(result);
      } catch (err) {
        if (err instanceof InvalidAgentLinkInputError) {
          return reply.status(400).send({ error_code: 'INVALID_INPUT' });
        }
        if (err instanceof SlugReservedError) {
          return reply.status(400).send({ error_code: 'SLUG_RESERVED' });
        }
        fastify.log.error(
          {
            errorClass: err instanceof Error ? err.constructor.name : 'unknown',
          },
          'agent-link mint failed',
        );
        return reply.status(500).send({ error_code: 'AGENT_LINK_MINT_FAILED' });
      }
    },
  );

  // ─── POST /agents/links/:token/redeem — redeem (público) ────────
  fastify.post<{
    Params: { token: string };
    Body: { input?: Record<string, unknown> };
  }>(
    '/links/:token/redeem',
    {
      config: { rateLimit: orchestrateRateLimit() },
      preHandler: [
        createBackpressureHandler(),
        createTimeoutHandler(
          parseInt(process.env.TIMEOUT_ORCHESTRATE_MS ?? '120000', 10),
        ),
      ],
    },
    async (req, reply: FastifyReply) => {
      // BLQ-2: bail early if timeout already sent 504.
      if (reply.sent) return;

      const body = req.body;
      const input =
        body && typeof body.input === 'object' && body.input !== null
          ? body.input
          : {};

      try {
        const result = await agentLinkService.redeem(req.params.token, input);
        if (reply.sent) return;
        return reply
          .status(200)
          .send({ kiteTxHash: req.paymentTxHash, ...result });
      } catch (err) {
        if (err instanceof AgentLinkNotFoundError) {
          return reply.status(404).send({ error_code: 'LINK_NOT_FOUND' });
        }
        if (err instanceof AgentLinkExpiredError) {
          return reply.status(410).send({ error_code: 'LINK_EXPIRED' });
        }
        if (err instanceof AgentLinkAlreadyUsedError) {
          return reply.status(409).send({ error_code: 'LINK_ALREADY_USED' });
        }
        if (err instanceof PriceExceedsLinkCapError) {
          return reply
            .status(409)
            .send({ error_code: 'PRICE_EXCEEDS_LINK_CAP' });
        }
        if (err instanceof AgentNotFoundError) {
          return reply.status(404).send({ error_code: 'AGENT_NOT_FOUND' });
        }
        // MNR-a: execute sin cargo (fondos insuficientes / net-zero). El link se
        // reabrió (cero débito) → error claro retryable, NO un 200 ambiguo.
        if (err instanceof AgentLinkExecutionUnavailableError) {
          return reply
            .status(503)
            .send({ error_code: 'LINK_EXECUTION_UNAVAILABLE' });
        }
        fastify.log.error(
          {
            errorClass: err instanceof Error ? err.constructor.name : 'unknown',
          },
          'agent-link redeem failed',
        );
        return reply
          .status(502)
          .send({ error_code: 'AGENT_LINK_REDEEM_FAILED' });
      }
    },
  );
};

export default agentLinkRoutes;
