/**
 * Security Headers Middleware — X-Content-Type-Options + X-Frame-Options + HSTS
 * WKH-QG-HEADERS: AC-1, AC-2
 * WKH-SEC-01: AC-3 (Strict-Transport-Security)
 */

import type { FastifyInstance } from 'fastify';

const HSTS_VALUE = 'max-age=31536000; includeSubDomains; preload';

/** Register onSend hook to add security headers to ALL responses */
export function registerSecurityHeaders(fastify: FastifyInstance): void {
  fastify.addHook('onSend', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('strict-transport-security', HSTS_VALUE);
  });
}
