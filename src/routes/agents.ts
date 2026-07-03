/**
 * Agents Routes — Self-serve single-agent publishing (WKH-134).
 *
 * Clon estructural de `registries.ts`. Un dev individual publica UN agente
 * (URL + Agent Card mínima) que queda descubrible en /discover, sin operar un
 * marketplace entero. Se monta en el mismo prefijo `/agents` que
 * `agentCardRoutes` (Fastify soporta varios plugins por prefijo). No colisiona
 * con `GET /agents/:slug/agent-card` (método+path distintos).
 *
 * Endpoints:
 *   - POST   /agents        publicar (201/400/422/409/403)
 *   - PATCH  /agents/:slug   actualizar (200/404/422/403)
 *   - DELETE /agents/:slug   despublicar (200/404/403)
 *   - GET    /agents         listar los míos (owner-scoped)
 *
 * Seguridad reusada (NO reinventar):
 *   - SSRF: `validateRegistryUrl` write-time (CD-1). PATCH re-valida agentUrl.
 *   - Ownership/anti-IDOR: `OwnershipMismatchError` → 404 disclosure-safe (CD-3).
 *   - Auth: `requirePaymentOrA2AKey` + guard `A2A_KEY_REQUIRED` (CD-2). Publicar
 *     es GRATIS con a2a-key (sin fee/budget).
 *   - Error estático al cliente (CD-10): el detalle va a `request.log.warn`.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  SSRFViolationError,
  validateRegistryUrl,
} from '../lib/url-validator.js';
import { requirePaymentOrA2AKey } from '../middleware/a2a-key.js';
import { publishedAgentService } from '../services/agent.js';
import { OwnershipMismatchError } from '../services/security/errors.js';
import type { PublishAgentInput } from '../types/index.js';

/**
 * Mapea `OwnershipMismatchError` a 404 disclosure-safe. Réplica LOCAL del
 * helper privado de `registries.ts:35` (NO se importa — es privado de ese
 * módulo). Retorna null si no es un error reconocido (el caller re-lanza).
 */
function mapOwnershipError(
  err: unknown,
  reply: FastifyReply,
): FastifyReply | null {
  if (err instanceof OwnershipMismatchError) {
    return reply.status(404).send({ error: 'Agent not found' });
  }
  return null;
}

/** Guard `A2A_KEY_REQUIRED` (CD-2): sin a2a-key no hay tenant identity. */
function a2aKeyRequired(reply: FastifyReply): FastifyReply {
  return reply.status(403).send({
    error: 'a2a-key required',
    error_code: 'A2A_KEY_REQUIRED',
    message:
      'Publishing an agent requires an authenticated a2a-key. The x402 anonymous path cannot publish (no tenant identity).',
  });
}

const agentsRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /agents — publicar un agente (AC-1).
   */
  fastify.post<{ Body: Partial<PublishAgentInput> & Record<string, unknown> }>(
    '/',
    {
      preHandler: [
        ...requirePaymentOrA2AKey({
          description: 'WasiAI Agent Publishing — Publish agent',
        }),
      ],
    },
    async (request, reply: FastifyReply) => {
      try {
        const body = request.body;

        // SSRF guard (CD-1) — validar agentUrl ANTES de persistir. Solo si es
        // string (si falta, lo captura la validación de mínimos → 400).
        try {
          for (const field of ['agentUrl'] as const) {
            const value = body[field];
            if (typeof value !== 'string') continue;
            try {
              await validateRegistryUrl(value);
            } catch (err) {
              if (err instanceof SSRFViolationError) {
                err.field = field;
              }
              throw err;
            }
          }
        } catch (err) {
          if (err instanceof SSRFViolationError) {
            request.log.warn(
              { field: err.field, category: err.category },
              'SSRF blocked',
            );
            return reply.status(422).send({
              error: 'SSRF_BLOCKED',
              field: err.field,
              reason: err.reason,
            });
          }
          throw err;
        }

        // Guard a2a-key (CD-2) — DESPUÉS del SSRF loop, igual que registries.ts.
        const keyRow = request.a2aKeyRow;
        if (!keyRow) {
          return a2aKeyRequired(reply);
        }

        // Validar mínimos → 400 con la lista de campos faltantes (AC-6).
        const missing: string[] = [];
        if (typeof body.name !== 'string' || body.name.trim() === '')
          missing.push('name');
        if (typeof body.agentUrl !== 'string' || body.agentUrl.trim() === '')
          missing.push('agentUrl');
        if (!Array.isArray(body.capabilities) || body.capabilities.length < 1)
          missing.push('capabilities');
        if (missing.length > 0) {
          return reply.status(400).send({
            error: 'Missing required fields',
            missing,
          });
        }

        // CD-5: el slug se deriva server-side del `name` — cualquier `slug`
        // del body se ignora (no se pasa al service). Se arma el input SOLO
        // con los campos presentes (exactOptionalPropertyTypes: sin `undefined`).
        const input: PublishAgentInput = {
          name: body.name as string,
          agentUrl: body.agentUrl as string,
          capabilities: body.capabilities as string[],
        };
        if (typeof body.description === 'string')
          input.description = body.description;
        if (typeof body.priceUsdc === 'number')
          input.priceUsdc = body.priceUsdc;
        if (
          body.inputSchema &&
          typeof body.inputSchema === 'object' &&
          !Array.isArray(body.inputSchema)
        )
          input.inputSchema = body.inputSchema as Record<string, unknown>;
        if (
          body.outputSchema &&
          typeof body.outputSchema === 'object' &&
          !Array.isArray(body.outputSchema)
        )
          input.outputSchema = body.outputSchema as Record<string, unknown>;
        if (typeof body.discoverable === 'boolean')
          input.discoverable = body.discoverable;

        const record = await publishedAgentService.publish(
          input,
          keyRow.owner_ref,
        );

        return reply.status(201).send(record);
      } catch (err) {
        // Colisión de slug (AC-4) → 409 con mensaje estático (sin leak).
        if (err instanceof Error && /already exists/.test(err.message)) {
          request.log.warn({ detail: err.message }, 'agent publish collision');
          return reply.status(409).send({ error: 'Agent already exists' });
        }
        // F-05 / CD-10: mensaje estático — nunca leak de err.message (puede
        // cargar host/SQL/datum SSRF). El detalle va al log server-side.
        request.log.warn(
          { detail: err instanceof Error ? err.message : 'unknown' },
          'agent publish failed',
        );
        return reply.status(400).send({ error: 'Failed to publish agent' });
      }
    },
  );

  /**
   * PATCH /agents/:slug — actualizar (AC-4).
   */
  fastify.patch<{
    Params: { slug: string };
    Body: Record<string, unknown>;
  }>(
    '/:slug',
    {
      preHandler: [
        ...requirePaymentOrA2AKey({
          description: 'WasiAI Agent Publishing — Update agent',
        }),
      ],
    },
    async (request, reply: FastifyReply) => {
      try {
        const { slug } = request.params;
        const body = request.body;

        // SSRF guard (CD-1) — re-validar agentUrl si viene en el patch.
        try {
          for (const field of ['agentUrl'] as const) {
            const value = body[field];
            if (typeof value !== 'string') continue;
            try {
              await validateRegistryUrl(value);
            } catch (err) {
              if (err instanceof SSRFViolationError) {
                err.field = field;
              }
              throw err;
            }
          }
        } catch (err) {
          if (err instanceof SSRFViolationError) {
            request.log.warn(
              { field: err.field, category: err.category },
              'SSRF blocked',
            );
            return reply.status(422).send({
              error: 'SSRF_BLOCKED',
              field: err.field,
              reason: err.reason,
            });
          }
          throw err;
        }

        const keyRow = request.a2aKeyRow;
        if (!keyRow) {
          return a2aKeyRequired(reply);
        }

        const record = await publishedAgentService.update(
          slug,
          body,
          keyRow.owner_ref,
        );
        return reply.send(record);
      } catch (err) {
        const mapped = mapOwnershipError(err, reply);
        if (mapped) return mapped;
        // CD-10: mensaje estático; detalle a log server-side.
        request.log.warn(
          { detail: err instanceof Error ? err.message : 'unknown' },
          'agent update failed',
        );
        return reply.status(400).send({ error: 'Failed to update agent' });
      }
    },
  );

  /**
   * DELETE /agents/:slug — despublicar (AC-4).
   */
  fastify.delete<{ Params: { slug: string } }>(
    '/:slug',
    {
      preHandler: [
        ...requirePaymentOrA2AKey({
          description: 'WasiAI Agent Publishing — Delete agent',
        }),
      ],
    },
    async (request, reply: FastifyReply) => {
      try {
        const { slug } = request.params;
        const keyRow = request.a2aKeyRow;
        if (!keyRow) {
          return a2aKeyRequired(reply);
        }

        const deleted = await publishedAgentService.delete(
          slug,
          keyRow.owner_ref,
        );

        // Disclosure-safe: 404 igual que cross-owner (pre-fetch ya transformó
        // "no existe" en OwnershipMismatchError; false solo aparece en race).
        if (!deleted) {
          return reply.status(404).send({ error: 'Agent not found' });
        }

        return reply.send({ success: true });
      } catch (err) {
        const mapped = mapOwnershipError(err, reply);
        if (mapped) return mapped;
        request.log.warn(
          { detail: err instanceof Error ? err.message : 'unknown' },
          'agent delete failed',
        );
        return reply.status(400).send({ error: 'Failed to delete agent' });
      }
    },
  );

  /**
   * GET /agents — listar los agentes propios (owner-scoped).
   * NO devuelve todos: filtra por el owner_ref del caller.
   */
  fastify.get(
    '/',
    {
      preHandler: [
        ...requirePaymentOrA2AKey({
          description: 'WasiAI Agent Publishing — List own agents',
        }),
      ],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const keyRow = request.a2aKeyRow;
        if (!keyRow) {
          return a2aKeyRequired(reply);
        }

        const agents = await publishedAgentService.listMine(keyRow.owner_ref);
        return reply.send({ agents, total: agents.length });
      } catch (err) {
        request.log.warn(
          { detail: err instanceof Error ? err.message : 'unknown' },
          'agent list-mine failed',
        );
        return reply.status(400).send({ error: 'Failed to list agents' });
      }
    },
  );
};

export default agentsRoutes;
