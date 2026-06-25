/**
 * Auth Routes — EIP-712 session-key delegations (WKH-101).
 *
 * Pure reorganization of `src/routes/auth.ts` (refactor B2, 2026-06-24).
 * POST   /delegation       — Create an EIP-712 session-key delegation.
 * DELETE /delegation/:id   — Revoke a delegation.
 * GET    /delegation       — List the caller's delegations.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { delegationService } from '../../services/delegation.js';
import {
  DelegationNonceReplayError,
  DelegationSignerMismatchError,
  OwnershipMismatchError,
} from '../../services/security/errors.js';
import type { CreateDelegationInput } from '../../types/index.js';
import {
  ADDRESS_RE,
  parseDelegationPolicy,
  parseDelegationTypedData,
  rawKeyFromRequest,
  resolveCallerKey,
  SESSION_TOKEN_PREFIX,
} from './parsers.js';

export const delegationRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /auth/delegation — Create an EIP-712 session-key delegation
   * (WKH-101: AC-1/AC-2/AC-3/AC-4/AC-15).
   *
   * The owner (authenticated with its MASTER key) signs a typed-data with a
   * spending policy that authorizes an ephemeral session key. The server
   * recovers the signer with viem and requires it to equal the key's bound
   * `funding_wallet` (CD-11) before persisting. The opaque session token is
   * returned ONCE in the 201; only its SHA-256 hash is stored.
   */
  fastify.post(
    '/delegation',
    async (req: FastifyRequest, reply: FastifyReply) => {
      // CD-9/AC-15: sub-delegation forbidden. A session token authenticator →
      // 403 DELEGATION_NOT_ALLOWED (detect the prefix BEFORE resolveCallerKey,
      // which would return null and lose the exact code).
      const rawKey = rawKeyFromRequest(req);
      if (rawKey?.startsWith(SESSION_TOKEN_PREFIX)) {
        return reply.status(403).send({ error_code: 'DELEGATION_NOT_ALLOWED' });
      }

      // Auth (master key).
      const callerKey = await resolveCallerKey(req);
      if (!callerKey?.is_active) {
        return reply.status(403).send({ error: 'Invalid or inactive API key' });
      }

      // AC-2: funding_wallet must be bound first (reuse FUNDING_WALLET_NOT_BOUND).
      if (!callerKey.funding_wallet) {
        return reply
          .status(403)
          .send({ error_code: 'FUNDING_WALLET_NOT_BOUND' });
      }

      // Input validation (CD-3): policy + typed_data + signature + session_key.
      const body = req.body as
        | {
            typed_data?: unknown;
            signature?: unknown;
            session_key_address?: unknown;
            policy?: unknown;
          }
        | undefined;

      const policy = parseDelegationPolicy(body?.policy);
      if (!policy) {
        return reply.status(400).send({ error_code: 'INVALID_INPUT' });
      }
      const typedData = parseDelegationTypedData(body?.typed_data);
      if (!typedData) {
        return reply.status(400).send({ error_code: 'INVALID_INPUT' });
      }
      if (typeof body?.signature !== 'string' || body.signature.length === 0) {
        return reply.status(400).send({ error_code: 'INVALID_INPUT' });
      }
      if (
        typeof body?.session_key_address !== 'string' ||
        !ADDRESS_RE.test(body.session_key_address)
      ) {
        return reply.status(400).send({ error_code: 'INVALID_INPUT' });
      }

      const input: CreateDelegationInput = {
        typed_data: typedData,
        signature: body.signature,
        session_key_address: body.session_key_address,
        policy,
      };

      try {
        const result = await delegationService.create(callerKey, input);
        return reply.status(201).send(result);
      } catch (err) {
        if (err instanceof DelegationSignerMismatchError) {
          return reply
            .status(403)
            .send({ error_code: 'DELEGATION_SIGNER_MISMATCH' });
        }
        if (err instanceof DelegationNonceReplayError) {
          return reply
            .status(409)
            .send({ error_code: 'DELEGATION_NONCE_REPLAY' });
        }
        fastify.log.error(
          {
            errorClass: err instanceof Error ? err.constructor.name : 'unknown',
          },
          'delegation create failed',
        );
        return reply
          .status(500)
          .send({ error_code: 'DELEGATION_CREATE_FAILED' });
      }
    },
  );

  /**
   * DELETE /auth/delegation/:id — Revoke a delegation (WKH-101: AC-10/AC-12).
   * Ownership Guard in the service (filtered by id AND owner_ref).
   */
  fastify.delete(
    '/delegation/:id',
    async (
      req: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const callerKey = await resolveCallerKey(req);
      if (!callerKey?.is_active) {
        return reply.status(403).send({ error: 'Invalid or inactive API key' });
      }

      try {
        await delegationService.revoke(req.params.id, callerKey.owner_ref);
        return reply.status(200).send({ revoked: true });
      } catch (err) {
        if (err instanceof OwnershipMismatchError) {
          return reply.status(403).send({ error_code: 'OWNERSHIP_MISMATCH' });
        }
        fastify.log.error(
          {
            errorClass: err instanceof Error ? err.constructor.name : 'unknown',
          },
          'delegation revoke failed',
        );
        return reply
          .status(500)
          .send({ error_code: 'DELEGATION_REVOKE_FAILED' });
      }
    },
  );

  /**
   * GET /auth/delegation — List the caller's delegations (WKH-101: AC-11).
   * Ownership Guard in the service (filtered by owner_ref). Never returns tokens.
   */
  fastify.get(
    '/delegation',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const callerKey = await resolveCallerKey(req);
      if (!callerKey?.is_active) {
        return reply.status(403).send({ error: 'Invalid or inactive API key' });
      }

      const items = await delegationService.list(callerKey.owner_ref);
      return reply.status(200).send({ delegations: items });
    },
  );
};
