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
 *
 * HIGH-1 (2026-07-26): TODAS las respuestas de este plugin son `RegistryPublic`
 * (sin `auth.value`). El `GET /` es público y devolvía la credencial outbound
 * en claro. La redacción vive en el service (`toRegistryPublic`) y el tipo
 * `RegistryPublic` hace que `tsc` rechace devolver la fila interna. Si agregás
 * un read-path acá, NO uses `registryService.getWithSecrets`/`getEnabled`:
 * `registries.redaction.test.ts` recorre todos los GET del plugin y falla si
 * alguna respuesta contiene el secreto.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { refundStep0Debit } from '../lib/step0-refund.js';
import {
  SSRFViolationError,
  validateRegistryUrl,
} from '../lib/url-validator.js';
import {
  chargedRoute,
  type PreChargeCheck,
  requireA2AKeyPresence,
} from '../middleware/charged-route.js';
import {
  registryService,
  SystemRegistryImmutableError,
} from '../services/registry.js';
import { OwnershipMismatchError } from '../services/security/errors.js';
import type { RegistryAuth, RegistrySchema } from '../types/index.js';

/**
 * HU-193: mensaje del 403 pre-cobro. IDÉNTICO al que ya devolvía el guard del
 * handler (WKH-63 fix-pack BLQ-ALTO-1), porque el contrato no cambia: lo único
 * que cambia es CUÁNDO se decide, y por lo tanto que ya no se cobre por un
 * rechazo garantizado.
 */
const A2A_KEY_REQUIRED_MESSAGE =
  'Registry mutation requires an authenticated a2a-key. The x402 anonymous path is read-only for registries.';

/**
 * HU-193: la validación de forma del POST, extraída del handler.
 *
 * Antes vivía SOLO en el handler, que corre DESPUÉS del middleware de pago: un
 * body sin `name`/`discoveryEndpoint`/`invokeEndpoint`/`schema` ya había pagado
 * ($1 de débito prepago, o un settle x402 on-chain con gas nuestro) cuando
 * recibía el 400. Es un check puro sobre el body → se adelanta.
 *
 * Función compartida (patrón `validateComposeBody`, HU-188): la usa el check
 * pre-cobro (el guard REAL) y el handler (defense-in-depth, para que un
 * reordenamiento futuro de la cadena no reabra el agujero).
 */
type PreChargeRejectionBody = { error: string };

function validateRegisterBody(body: unknown): PreChargeRejectionBody | null {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!b.name || !b.discoveryEndpoint || !b.invokeEndpoint || !b.schema) {
    return {
      error:
        'Missing required fields: name, discoveryEndpoint, invokeEndpoint, schema',
    };
  }
  return null;
}

const registerBodyCheck: PreChargeCheck = (input) => {
  const invalid = validateRegisterBody(input.body);
  return invalid ? { status: 400, body: invalid } : null;
};

/**
 * Mapea errores de ownership/system al status HTTP correcto.
 * Retorna `null` si no es un error reconocido (el caller debe re-lanzar).
 *
 * HU-193: estos dos rechazos son RESIDUO — dependen de un read a la DB y del
 * `owner_ref` del caller autenticado, así que no se pueden decidir pre-cobro. En
 * el riel prepago se reembolsa el débito step-0 (nada se entregó y nada se
 * movió: el pre-fetch del service falla ANTES de cualquier escritura). En el
 * riel x402 son inalcanzables, porque ese riel ya se rechaza pre-cobro con 403
 * `A2A_KEY_REQUIRED`.
 */
async function mapOwnershipError(
  request: FastifyRequest,
  err: unknown,
  reply: FastifyReply,
  refundReason: string,
): Promise<FastifyReply | null> {
  if (err instanceof OwnershipMismatchError) {
    await refundStep0Debit(request, `${refundReason}:not-found`);
    return reply.status(404).send({ error: 'Registry not found' });
  }
  if (err instanceof SystemRegistryImmutableError) {
    await refundStep0Debit(request, `${refundReason}:system-immutable`);
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
      preHandler: chargedRoute({
        // HU-193: los dos rechazos que este endpoint puede decidir SIN I/O y sin
        // saber quién llama. Corren ANTES del cobro (prepago y x402).
        validate: [
          requireA2AKeyPresence(A2A_KEY_REQUIRED_MESSAGE),
          registerBodyCheck,
        ],
        payment: {
          description: 'WasiAI Registry Management — Register marketplace',
        },
      }),
    },
    async (request, reply: FastifyReply) => {
      try {
        const body = request.body;

        // HU-193: el guard REAL es `registerBodyCheck` (pre-cobro). Esto es
        // defense-in-depth con la MISMA función pura: si alguien reordena la
        // cadena de preHandlers, el body malformado sigue sin llegar al service.
        const invalidBody = validateRegisterBody(body);
        if (invalidBody) {
          return reply.status(400).send(invalidBody);
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
            // HU-193 (residuo): el guard SSRF hace I/O (resolución DNS), así que
            // NO puede correr pre-cobro — un `PreChargeCheck` es síncrono a
            // propósito, para no volver un endpoint impago en un amplificador de
            // I/O (y para no regalarle a un caller sin credencial válida un
            // oráculo de "¿este hostname resuelve, y a qué?"). Riel prepago: se
            // reembolsa (nada se persistió: el 422 corta antes del insert). Riel
            // x402: inalcanzable, ya se rechazó pre-cobro con 403.
            await refundStep0Debit(request, 'registries.post:ssrf-blocked');
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
        //
        // HU-193: el guard REAL es ahora `requireA2AKeyPresence` en la cadena
        // pre-cobro (mismo status/código/mensaje, pero SIN cobrarle el challenge
        // x402 a un pedido cuyo rechazo estaba garantizado). Esto queda como
        // defense-in-depth: `a2aKeyRow` ausente ⟺ credencial ausente, porque los
        // tres branches del middleware setean `a2aKeyRow` cuando autentican.
        const keyRow = request.a2aKeyRow;
        if (!keyRow) {
          return reply.status(403).send({
            error: 'a2a-key required',
            error_code: 'A2A_KEY_REQUIRED',
            message: A2A_KEY_REQUIRED_MESSAGE,
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
        const mapped = await mapOwnershipError(
          request,
          err,
          reply,
          'registries.post',
        );
        if (mapped) return mapped;
        // F-05 (audit 2026-06-29): static client message — never leak the raw
        // err.message (may carry internal hosts / SQL / SSRF datum). Detail is
        // logged server-side.
        request.log.warn(
          { detail: err instanceof Error ? err.message : 'unknown' },
          'registry register failed',
        );
        // HU-193 (residuo): las reglas que caen acá necesitan I/O (colisión de
        // PK contra la DB) o viven dentro del service (validación del `name`),
        // así que no se pueden adelantar sin duplicar la regla. El registry NO
        // quedó creado en ninguno de esos caminos (el pre-check y el 23505
        // abortan el insert) → devolver el débito no regala nada.
        await refundStep0Debit(request, 'registries.post:register-failed');
        return reply.status(400).send({ error: 'Failed to register registry' });
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
      preHandler: chargedRoute({
        // HU-193: el PATCH no tiene forma validable sin I/O más allá de la
        // credencial — el body es un `Partial` libre y el 422 de SSRF necesita
        // resolución DNS (ver el comentario del 422 en el POST).
        validate: [requireA2AKeyPresence(A2A_KEY_REQUIRED_MESSAGE)],
        payment: {
          description: 'WasiAI Registry Management — Update marketplace',
        },
      }),
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
            // HU-193 (residuo): ver el 422 del POST — I/O de DNS, no adelantable.
            await refundStep0Debit(request, 'registries.patch:ssrf-blocked');
            return reply.status(422).send({
              error: 'SSRF_BLOCKED',
              field: err.field,
              reason: err.reason,
            });
          }
          throw err;
        }

        // WKH-63 fix-pack (BLQ-ALTO-1): ver POST handler para racional.
        // HU-193: guard real = `requireA2AKeyPresence` pre-cobro; esto es
        // defense-in-depth.
        const keyRow = request.a2aKeyRow;
        if (!keyRow) {
          return reply.status(403).send({
            error: 'a2a-key required',
            error_code: 'A2A_KEY_REQUIRED',
            message: A2A_KEY_REQUIRED_MESSAGE,
          });
        }
        const ownerRef = keyRow.owner_ref;
        const registry = await registryService.update(id, body, ownerRef);
        return reply.send(registry);
      } catch (err) {
        const mapped = await mapOwnershipError(
          request,
          err,
          reply,
          'registries.patch',
        );
        if (mapped) return mapped;
        // F-05 (audit 2026-06-29): static client message; detail logged server-side.
        request.log.warn(
          { detail: err instanceof Error ? err.message : 'unknown' },
          'registry update failed',
        );
        // HU-193 (residuo): fallo del UPDATE contra la DB. La fila no cambió
        // (el UPDATE es atómico y falló), así que el débito se devuelve.
        await refundStep0Debit(request, 'registries.patch:update-failed');
        return reply.status(400).send({ error: 'Failed to update registry' });
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
      preHandler: chargedRoute({
        // HU-193: un DELETE no tiene cuerpo; lo único decidible sin I/O es la
        // presencia de credencial.
        validate: [requireA2AKeyPresence(A2A_KEY_REQUIRED_MESSAGE)],
        payment: {
          description: 'WasiAI Registry Management — Delete marketplace',
        },
      }),
    },
    async (request, reply: FastifyReply) => {
      try {
        const { id } = request.params;
        // WKH-63 fix-pack (BLQ-ALTO-1): ver POST handler para racional.
        // HU-193: guard real = `requireA2AKeyPresence` pre-cobro; esto es
        // defense-in-depth.
        const keyRow = request.a2aKeyRow;
        if (!keyRow) {
          return reply.status(403).send({
            error: 'a2a-key required',
            error_code: 'A2A_KEY_REQUIRED',
            message: A2A_KEY_REQUIRED_MESSAGE,
          });
        }
        const ownerRef = keyRow.owner_ref;
        const deleted = await registryService.delete(id, ownerRef);

        if (!deleted) {
          // HU-193 (residuo): race del pre-fetch (la fila desapareció entre el
          // check de ownership y el DELETE). Nada se borró → se devuelve.
          await refundStep0Debit(request, 'registries.delete:not-found');
          return reply.status(404).send({ error: 'Registry not found' });
        }

        return reply.send({ success: true });
      } catch (err) {
        const mapped = await mapOwnershipError(
          request,
          err,
          reply,
          'registries.delete',
        );
        if (mapped) return mapped;
        // F-05 (audit 2026-06-29): static client message; detail logged server-side.
        request.log.warn(
          { detail: err instanceof Error ? err.message : 'unknown' },
          'registry delete failed',
        );
        // HU-193 (residuo): fallo del DELETE contra la DB; la fila sigue ahí.
        await refundStep0Debit(request, 'registries.delete:delete-failed');
        return reply.status(400).send({ error: 'Failed to delete registry' });
      }
    },
  );
};

export default registriesRoutes;
