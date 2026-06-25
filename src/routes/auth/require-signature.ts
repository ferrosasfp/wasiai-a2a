/**
 * Auth Routes — master-key per-request signature toggle (WKH-123).
 *
 * Pure reorganization of `src/routes/auth.ts` (refactor B2, 2026-06-24).
 * PATCH /agent-key/:id/require-signature — Toggle EIP-712 per-request signature.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { identityService } from '../../services/identity.js';
import { OwnershipMismatchError } from '../../services/security/errors.js';
import {
  KEY_SESSION_TOKEN_PREFIX,
  rawKeyFromRequest,
  resolveCallerKey,
  SESSION_TOKEN_PREFIX,
} from './parsers.js';

export const requireSignatureRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * PATCH /auth/agent-key/:id/require-signature — Toggle EIP-712 per-request
   * signature on the caller's MASTER key (WKH-123, AC-10). Authenticated with
   * the master key. `:id` must equal `callerKey.id` (defense-in-depth). Enabling
   * requires a bound `funding_wallet` (AC-9 surface). Ownership Guard in the
   * service (UPDATE filtered by id + owner_ref).
   */
  fastify.patch(
    '/agent-key/:id/require-signature',
    async (
      req: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      // Sub-session/delegation tokens forbidden as authenticators.
      const rawKey = rawKeyFromRequest(req);
      if (
        rawKey?.startsWith(KEY_SESSION_TOKEN_PREFIX) ||
        rawKey?.startsWith(SESSION_TOKEN_PREFIX)
      ) {
        return reply.status(403).send({ error_code: 'OWNERSHIP_MISMATCH' });
      }

      const callerKey = await resolveCallerKey(req);
      if (!callerKey?.is_active) {
        return reply.status(403).send({ error: 'Invalid or inactive API key' });
      }

      // Defense-in-depth: el id del path debe ser la key autenticada.
      if (req.params.id !== callerKey.id) {
        return reply.status(403).send({ error_code: 'OWNERSHIP_MISMATCH' });
      }

      const body = req.body as { require_signature?: unknown } | undefined;
      if (typeof body?.require_signature !== 'boolean') {
        return reply.status(400).send({ error_code: 'INVALID_INPUT' });
      }
      const value = body.require_signature;

      // AC-9: activar firma requiere un funding_wallet bindeado.
      if (value === true && !callerKey.funding_wallet) {
        return reply
          .status(400)
          .send({ error_code: 'FUNDING_WALLET_NOT_BOUND' });
      }

      try {
        await identityService.setRequireSignature(
          callerKey.id,
          callerKey.owner_ref,
          value,
        );
        return reply.status(200).send({ ok: true, require_signature: value });
      } catch (err) {
        if (err instanceof OwnershipMismatchError) {
          return reply.status(403).send({ error_code: 'OWNERSHIP_MISMATCH' });
        }
        fastify.log.error(
          {
            errorClass: err instanceof Error ? err.constructor.name : 'unknown',
          },
          'agent-key require-signature failed',
        );
        return reply
          .status(500)
          .send({ error_code: 'REQUIRE_SIGNATURE_FAILED' });
      }
    },
  );
};
