/**
 * Auth Routes — destination spend policies (WKH-125).
 *
 * Pure reorganization of `src/routes/auth.ts` (refactor B2, 2026-06-24).
 * PUT    /keys/me/spend-policies               — Set (upsert) a destination cap.
 * GET    /keys/me/spend-policies               — List the caller's caps.
 * DELETE /keys/me/spend-policies/:destination  — Remove ONE destination cap.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  OwnershipMismatchError,
  SessionNotAllowedError,
} from '../../services/security/errors.js';
import {
  InvalidSpendPolicyInputError,
  spendPolicyService,
} from '../../services/spend-policy.js';
import {
  KEY_SESSION_TOKEN_PREFIX,
  parseSpendPolicyInput,
  rawKeyFromRequest,
  resolveCallerKey,
} from './parsers.js';

export const spendPolicyRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * PUT /auth/keys/me/spend-policies — Set (upsert) a destination spend cap for
   * the caller's MASTER key (WKH-125, AC-1/AC-7). Authenticated with the master
   * key (sub-session tokens forbidden as authenticators). Ownership Guard in the
   * service (owner_ref/key_id taken from callerKey). Invalid input → 400; ok 200.
   */
  fastify.put(
    '/keys/me/spend-policies',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const rawKey = rawKeyFromRequest(req);
      if (rawKey?.startsWith(KEY_SESSION_TOKEN_PREFIX)) {
        const err = new SessionNotAllowedError();
        return reply.status(403).send({ error_code: err.code });
      }

      const callerKey = await resolveCallerKey(req);
      if (!callerKey?.is_active) {
        return reply.status(403).send({ error: 'Invalid or inactive API key' });
      }

      const input = parseSpendPolicyInput(req.body);
      if (!input) {
        return reply.status(400).send({ error_code: 'INVALID_INPUT' });
      }

      try {
        const policy = await spendPolicyService.set(callerKey, input);
        return reply.status(200).send(policy);
      } catch (err) {
        if (err instanceof InvalidSpendPolicyInputError) {
          return reply.status(400).send({ error_code: 'INVALID_INPUT' });
        }
        if (err instanceof OwnershipMismatchError) {
          return reply.status(403).send({ error_code: 'OWNERSHIP_MISMATCH' });
        }
        fastify.log.error(
          {
            errorClass: err instanceof Error ? err.constructor.name : 'unknown',
          },
          'spend-policy set failed',
        );
        return reply
          .status(500)
          .send({ error_code: 'SPEND_POLICY_SET_FAILED' });
      }
    },
  );

  /**
   * GET /auth/keys/me/spend-policies — List the caller's destination spend caps
   * (WKH-125, AC-7). Ownership Guard in the service (key_id + owner_ref).
   */
  fastify.get(
    '/keys/me/spend-policies',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const rawKey = rawKeyFromRequest(req);
      if (rawKey?.startsWith(KEY_SESSION_TOKEN_PREFIX)) {
        const err = new SessionNotAllowedError();
        return reply.status(403).send({ error_code: err.code });
      }

      const callerKey = await resolveCallerKey(req);
      if (!callerKey?.is_active) {
        return reply.status(403).send({ error: 'Invalid or inactive API key' });
      }

      const policies = await spendPolicyService.list(
        callerKey.id,
        callerKey.owner_ref,
      );
      return reply.status(200).send(policies);
    },
  );

  /**
   * DELETE /auth/keys/me/spend-policies/:destination — Remove ONE destination
   * spend cap (WKH-125, AC-7). Ownership Guard in the service. Unknown /
   * cross-owner destination → 404 disclosure-safe.
   */
  fastify.delete(
    '/keys/me/spend-policies/:destination',
    async (
      req: FastifyRequest<{ Params: { destination: string } }>,
      reply: FastifyReply,
    ) => {
      const rawKey = rawKeyFromRequest(req);
      if (rawKey?.startsWith(KEY_SESSION_TOKEN_PREFIX)) {
        const err = new SessionNotAllowedError();
        return reply.status(403).send({ error_code: err.code });
      }

      const callerKey = await resolveCallerKey(req);
      if (!callerKey?.is_active) {
        return reply.status(403).send({ error: 'Invalid or inactive API key' });
      }

      try {
        await spendPolicyService.delete(
          callerKey.id,
          callerKey.owner_ref,
          decodeURIComponent(req.params.destination),
        );
        return reply.status(200).send({ deleted: true });
      } catch (err) {
        if (err instanceof InvalidSpendPolicyInputError) {
          return reply.status(400).send({ error_code: 'INVALID_INPUT' });
        }
        if (err instanceof OwnershipMismatchError) {
          // Disclosure-safe: NO revela si el destino existe para otro owner.
          return reply
            .status(404)
            .send({ error_code: 'SPEND_POLICY_NOT_FOUND' });
        }
        fastify.log.error(
          {
            errorClass: err instanceof Error ? err.constructor.name : 'unknown',
          },
          'spend-policy delete failed',
        );
        return reply
          .status(500)
          .send({ error_code: 'SPEND_POLICY_DELETE_FAILED' });
      }
    },
  );
};
