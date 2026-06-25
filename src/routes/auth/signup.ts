/**
 * Auth Routes — agent signup (WKH-34, AC-13).
 *
 * Pure reorganization of `src/routes/auth.ts` (refactor B2, 2026-06-24).
 * POST /agent-signup — Create a new agent key.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { keccak256, stringToBytes } from 'viem';
import { authSignupRateLimit } from '../../middleware/rate-limit.js';
import { identityService } from '../../services/identity.js';
import type { CreateKeyInput } from '../../types/index.js';

export const signupRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /agent-signup — Create a new agent key (AC-13)
   */
  fastify.post(
    '/agent-signup',
    { config: { rateLimit: authSignupRateLimit() } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body as Partial<CreateKeyInput> | undefined;

      if (
        !body?.owner_ref ||
        typeof body.owner_ref !== 'string' ||
        body.owner_ref.trim() === ''
      ) {
        return reply.status(400).send({
          error: 'owner_ref is required and must be a non-empty string',
        });
      }

      try {
        const result = await identityService.createKey({
          owner_ref: body.owner_ref,
          display_name: body.display_name,
          daily_limit_usd: body.daily_limit_usd,
          allowed_registries: body.allowed_registries,
          allowed_agent_slugs: body.allowed_agent_slugs,
          allowed_categories: body.allowed_categories,
          max_spend_per_call_usd: body.max_spend_per_call_usd,
        });

        // key_id_hash: el bytes32 que el contrato escrow usa como keyId
        // (keccak256(stringToBytes(key_id))). Lo exponemos para que el front
        // pueda depositar al escrow sin re-implementar keccak en JS.
        return reply.status(201).send({
          ...result,
          key_id_hash: keccak256(stringToBytes(result.key_id)),
        });
      } catch (err) {
        fastify.log.error(
          {
            errorClass: err instanceof Error ? err.constructor.name : 'unknown',
          },
          'agent-signup failed',
        );
        return reply.status(500).send({ error: 'Failed to create agent key' });
      }
    },
  );
};
