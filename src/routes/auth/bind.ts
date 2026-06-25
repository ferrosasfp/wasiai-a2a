/**
 * Auth Routes — on-chain identity binding placeholder (WKH-34, AC-16).
 *
 * Pure reorganization of `src/routes/auth.ts` (refactor B2, 2026-06-24).
 * POST /bind/:chain — Placeholder for on-chain binding.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

export const bindRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /bind/:chain — Placeholder (AC-16)
   */
  fastify.post(
    '/bind/:chain',
    async (_req: FastifyRequest, reply: FastifyReply) => {
      return reply.status(501).send({
        status: 'not_implemented',
        message:
          'On-chain identity binding is planned for Fase 2. See doc/architecture/CHAIN-ADAPTIVE.md',
      });
    },
  );
};
