/**
 * Registries Routes — CRUD for marketplace registrations
 *
 * WKH-63 (SEC-REG-1): POST/PATCH/DELETE pasan
 * `request.a2aKeyRow.owner_ref` al service. Mapping de errores:
 *   - `OwnershipMismatchError` → 404 (disclosure-safe — no enumera ids).
 *   - `SystemRegistryImmutableError` → 403 con `'System registry is immutable'`.
 * GET sigue público (visibilidad sin cambios — no rompe discovery).
 *
 * WKH-63 fix-pack (BLQ-ALTO-1): los mutations requieren un `a2a-key`
 * autenticado. El path x402 puro (sin a2a-key) NO puede mutar registries
 * porque no aporta tenant identity — un sentinel `'x402-anonymous'` sería
 * compartido entre TODOS los payers x402 y permitiría que cualquier payer
 * con $1 USDC modifique/borre registries de otros payers (cross-tenant
 * IDOR). El guard retorna 403 `A2A_KEY_REQUIRED` antes de llegar al service.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  SSRFViolationError,
  validateRegistryUrl,
} from '../lib/url-validator.js';
import { requirePaymentOrA2AKey } from '../middleware/a2a-key.js';
import {
  registryService,
  SystemRegistryImmutableError,
} from '../services/registry.js';
import { OwnershipMismatchError } from '../services/security/errors.js';
import type { RegistryAuth, RegistrySchema } from '../types/index.js';

/**
 * Mapea errores de ownership/system al status HTTP correcto.
 * Retorna `null` si no es un error reconocido (el caller debe re-lanzar).
 */
function mapOwnershipError(
  err: unknown,
  reply: FastifyReply,
): FastifyReply | null {
  if (err instanceof OwnershipMismatchError) {
    return reply.status(404).send({ error: 'Registry not found' });
  }
  if (err instanceof SystemRegistryImmutableError) {
    return reply.status(403).send({ error: 'System registry is immutable' });
  }
  return null;
}

const registriesRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /registries
   * List all registered marketplaces
   */
  fastify.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
    const registries = await registryService.list();
    return reply.send({
      registries,
      total: registries.length,
    });
  });

  /**
   * GET /registries/:id
   * Get a specific registry
   */
  fastify.get(
    '/:id',
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const registry = await registryService.get(id);

      if (!registry) {
        return reply.status(404).send({ error: 'Registry not found' });
      }

      return reply.send(registry);
    },
  );

  /**
   * POST /registries
   * Register a new marketplace
   */
  fastify.post<{
    Body: {
      name: string;
      discoveryEndpoint: string;
      invokeEndpoint: string;
      agentEndpoint?: string;
      schema: RegistrySchema;
      auth?: RegistryAuth;
      enabled?: boolean;
    };
  }>(
    '/',
    {
      preHandler: [
        ...requirePaymentOrA2AKey({
          description: 'WasiAI Registry Management — Register marketplace',
        }),
      ],
    },
    async (request, reply: FastifyReply) => {
      try {
        const body = request.body;

        // Validate required fields
        if (
          !body.name ||
          !body.discoveryEndpoint ||
          !body.invokeEndpoint ||
          !body.schema
        ) {
          return reply.status(400).send({
            error:
              'Missing required fields: name, discoveryEndpoint, invokeEndpoint, schema',
          });
        }

        // SSRF guard (WKH-62 / CD-A5) — validate ALL outbound URLs in the
        // body BEFORE persisting. agentEndpoint is scope OUT of WKH-62
        // (validated runtime in discoveryService.getAgent).
        try {
          for (const field of [
            'discoveryEndpoint',
            'invokeEndpoint',
          ] as const) {
            try {
              await validateRegistryUrl(body[field]);
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

        // WKH-63 fix-pack (BLQ-ALTO-1): exigir a2a-key. Sin tenant identity
        // no se puede mutar registries (un sentinel 'x402-anonymous' sería
        // compartido entre todos los payers x402 → cross-tenant IDOR).
        const keyRow = request.a2aKeyRow;
        if (!keyRow) {
          return reply.status(403).send({
            error: 'a2a-key required',
            error_code: 'A2A_KEY_REQUIRED',
            message:
              'Registry mutation requires an authenticated a2a-key. The x402 anonymous path is read-only for registries.',
          });
        }
        const ownerRef = keyRow.owner_ref;

        const registry = await registryService.register(
          {
            name: body.name,
            discoveryEndpoint: body.discoveryEndpoint,
            invokeEndpoint: body.invokeEndpoint,
            agentEndpoint: body.agentEndpoint,
            schema: body.schema,
            auth: body.auth,
            enabled: body.enabled ?? true,
          },
          ownerRef,
        );

        return reply.status(201).send(registry);
      } catch (err) {
        const mapped = mapOwnershipError(err, reply);
        if (mapped) return mapped;
        return reply.status(400).send({
          error: err instanceof Error ? err.message : 'Failed to register',
        });
      }
    },
  );

  /**
   * PATCH /registries/:id
   * Update a registry
   */
  fastify.patch<{
    Params: { id: string };
    Body: Record<string, unknown>;
  }>(
    '/:id',
    {
      preHandler: [
        ...requirePaymentOrA2AKey({
          description: 'WasiAI Registry Management — Update marketplace',
        }),
      ],
    },
    async (request, reply: FastifyReply) => {
      try {
        const { id } = request.params;
        const body = request.body;

        // SSRF guard (WKH-62 / CD-A5) — validate URL fields if present in
        // the PATCH body. Other fields (name, enabled, schema) skip the
        // check.
        try {
          for (const field of [
            'discoveryEndpoint',
            'invokeEndpoint',
          ] as const) {
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

        // WKH-63 fix-pack (BLQ-ALTO-1): ver POST handler para racional.
        const keyRow = request.a2aKeyRow;
        if (!keyRow) {
          return reply.status(403).send({
            error: 'a2a-key required',
            error_code: 'A2A_KEY_REQUIRED',
            message:
              'Registry mutation requires an authenticated a2a-key. The x402 anonymous path is read-only for registries.',
          });
        }
        const ownerRef = keyRow.owner_ref;
        const registry = await registryService.update(id, body, ownerRef);
        return reply.send(registry);
      } catch (err) {
        const mapped = mapOwnershipError(err, reply);
        if (mapped) return mapped;
        return reply.status(400).send({
          error: err instanceof Error ? err.message : 'Failed to update',
        });
      }
    },
  );

  /**
   * DELETE /registries/:id
   * Delete a registry
   */
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: [
        ...requirePaymentOrA2AKey({
          description: 'WasiAI Registry Management — Delete marketplace',
        }),
      ],
    },
    async (request, reply: FastifyReply) => {
      try {
        const { id } = request.params;
        // WKH-63 fix-pack (BLQ-ALTO-1): ver POST handler para racional.
        const keyRow = request.a2aKeyRow;
        if (!keyRow) {
          return reply.status(403).send({
            error: 'a2a-key required',
            error_code: 'A2A_KEY_REQUIRED',
            message:
              'Registry mutation requires an authenticated a2a-key. The x402 anonymous path is read-only for registries.',
          });
        }
        const ownerRef = keyRow.owner_ref;
        const deleted = await registryService.delete(id, ownerRef);

        if (!deleted) {
          return reply.status(404).send({ error: 'Registry not found' });
        }

        return reply.send({ success: true });
      } catch (err) {
        const mapped = mapOwnershipError(err, reply);
        if (mapped) return mapped;
        return reply.status(400).send({
          error: err instanceof Error ? err.message : 'Failed to delete',
        });
      }
    },
  );
};

export default registriesRoutes;
