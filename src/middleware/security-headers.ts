/**
 * Security Headers Middleware — X-Content-Type-Options + X-Frame-Options
 * WKH-QG-HEADERS: AC-1, AC-2
 */

import type { FastifyInstance } from 'fastify';

/** Register onSend hook to add security headers to ALL responses */
export function registerSecurityHeaders(fastify: FastifyInstance): void {
  fastify.addHook('onSend', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
  });
}
