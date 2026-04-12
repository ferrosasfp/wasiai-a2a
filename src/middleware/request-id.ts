/**
 * Request ID Middleware — UUID v4 generation + x-request-id header
 * WKH-18: Hardening — AC-10
 */

import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';

/** Generate a UUID v4 request ID — pass to Fastify({ genReqId }) */
export const genReqId = () => crypto.randomUUID();

/** Register onSend hook to add x-request-id header to ALL responses */
export function registerRequestIdHook(fastify: FastifyInstance): void {
  fastify.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
}
