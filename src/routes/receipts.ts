/**
 * Receipt routes — WKH-124 KEY-RECEIPTS
 *
 * GET /receipts            — list the caller's receipts (AC-7, Ownership Guard).
 * GET /receipts/:id        — fetch one (404 disclosure-safe if cross-owner, AC-8).
 * GET /receipts/:id/verify — recompute hash + report tamper (AC-4/AC-5/AC-8).
 *
 * Auth mirrors `resolveCallerKey` from auth.ts (x-a2a-key > Bearer wasi_a2a_*).
 * Ownership Guard lives in the service (`.eq('owner_ref', ...)`, CD-3).
 */

import crypto from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { isValidUUID } from '../lib/uuid.js';
import { identityService, isIdentityVerified } from '../services/identity.js';
import { receiptService } from '../services/receipt.js';
import type { A2AAgentKeyRow } from '../types/index.js';

/**
 * Resolve the caller's master key from the request (WKH-124, same precedence as
 * auth.ts: x-a2a-key > Bearer wasi_a2a_*). Returns null if no valid key.
 */
async function resolveCallerKey(
  request: FastifyRequest,
): Promise<A2AAgentKeyRow | null> {
  let rawKey: string | undefined;

  const headerValue = request.headers['x-a2a-key'];
  if (headerValue && typeof headerValue === 'string') {
    rawKey = headerValue;
  } else {
    const authHeader = request.headers.authorization;
    if (authHeader && typeof authHeader === 'string') {
      const match = /^bearer\s+(.+)$/i.exec(authHeader);
      if (match?.[1]?.startsWith('wasi_a2a_')) {
        rawKey = match[1];
      }
    }
  }

  if (!rawKey) return null;

  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const callerKey = await identityService.lookupByHash(keyHash);
  if (callerKey) {
    callerKey.erc8004_verified = isIdentityVerified(callerKey);
  }
  return callerKey;
}

const receiptsRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /receipts — only the caller's receipts (AC-7).
   */
  fastify.get('/', async (req: FastifyRequest, reply: FastifyReply) => {
    const callerKey = await resolveCallerKey(req);
    if (!callerKey?.is_active) {
      return reply.status(403).send({ error: 'Invalid or inactive API key' });
    }

    const receipts = await receiptService.list(callerKey.owner_ref);
    return reply.status(200).send({ receipts });
  });

  /**
   * GET /receipts/:id — one receipt; 404 disclosure-safe if cross-owner (AC-8).
   */
  fastify.get(
    '/:id',
    async (
      req: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const callerKey = await resolveCallerKey(req);
      if (!callerKey?.is_active) {
        return reply.status(403).send({ error: 'Invalid or inactive API key' });
      }

      // WKH-345: forma del `:id` ANTES de la capa de datos. Sin esto el valor
      // llega a una columna `uuid` y Postgres responde 22P02 → 500. Va DESPUÉS
      // del 403 de auth: a quien no probó ser un caller válido no se le da
      // feedback de forma.
      if (!isValidUUID(req.params.id)) {
        return reply.status(400).send({ error_code: 'INVALID_INPUT' });
      }

      const receipt = await receiptService.getById(
        req.params.id,
        callerKey.owner_ref,
      );
      if (!receipt) {
        return reply.status(404).send({ error_code: 'RECEIPT_NOT_FOUND' });
      }
      return reply.status(200).send({ receipt });
    },
  );

  /**
   * GET /receipts/:id/verify — recompute + compare (AC-4/AC-5). 404 cross-owner
   * (AC-8). NEVER exposes the secret (CD-4); 200 with {valid:true/false} if owned.
   */
  fastify.get(
    '/:id/verify',
    async (
      req: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const callerKey = await resolveCallerKey(req);
      if (!callerKey?.is_active) {
        return reply.status(403).send({ error: 'Invalid or inactive API key' });
      }

      // WKH-345: forma del `:id` ANTES de la capa de datos (ver GET /:id).
      if (!isValidUUID(req.params.id)) {
        return reply.status(400).send({ error_code: 'INVALID_INPUT' });
      }

      // Disclosure-safe: a cross-owner / unknown id → 404 (AC-8). getById is the
      // single source of the ownership check (same `.eq('owner_ref', ...)`).
      const receipt = await receiptService.getById(
        req.params.id,
        callerKey.owner_ref,
      );
      if (!receipt) {
        return reply.status(404).send({ error_code: 'RECEIPT_NOT_FOUND' });
      }

      const result = await receiptService.verify(
        req.params.id,
        callerKey.owner_ref,
      );
      return reply.status(200).send(result);
    },
  );
};

export default receiptsRoutes;
