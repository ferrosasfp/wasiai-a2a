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
 *   - Auth: `requireA2AKey` (auth-only — sin fee/débito/x402) + guard
 *     `A2A_KEY_REQUIRED`. Publicar/actualizar/borrar/listar es GRATIS: el
 *     middleware autentica la a2a-key y NUNCA invoca pago (WKH-173).
 *   - Error estático al cliente (CD-10): el detalle va a `request.log.warn`.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { normalizeChainSlug } from '../adapters/chain-resolver.js';
import {
  PAYMENT_REJECTION_REASON,
  type PaymentBlockRejection,
  validatePaymentBlock,
} from '../lib/payment-spec-writer.js';
import {
  SSRFViolationError,
  validateRegistryUrl,
} from '../lib/url-validator.js';
import {
  isValidPayoutWallet,
  type WalletNamespace,
} from '../lib/wallet-format.js';
import { requireA2AKey } from '../middleware/a2a-key.js';
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

/**
 * Write-boundary guard de precio (WKH-134 BLQ-1, money-path). Un `priceUsdc`
 * negativo/no-finito publicado inflaría el débito prepago del caller vía
 * /compose + increment_a2a_key_spend. Solo se acepta un `number` finito `>= 0`.
 */
function isValidPriceUsdc(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * Write-boundary guard de `payoutWallet` (WKH-143b, money-path input).
 *
 * WKH-234: namespace-aware. La familia se resuelve desde `payoutChain` (slug) vía
 * el resolver PURO `normalizeChainSlug`: ausente → `'evm'` (byte-idéntico); un
 * slug EVM → `'evm'`; `solana-devnet` → `'solana'` (valida base58); chain
 * desconocida → inválido (AC-6). `''` / no-string / fuera de formato → inválido →
 * 422 (DT-3: NO es "unset").
 */
function isValidPayoutWalletForChain(
  v: unknown,
  payoutChain: unknown,
): v is string {
  if (typeof v !== 'string') return false;
  let ns: WalletNamespace = 'evm';
  if (typeof payoutChain === 'string') {
    const slug = normalizeChainSlug(payoutChain);
    if (slug === undefined) return false; // AC-6: chain desconocida → inválido
    ns = slug === 'solana-devnet' ? 'solana' : 'evm';
  }
  return isValidPayoutWallet(v, ns);
}

/**
 * WKH-316 — cuerpo de la respuesta 422 de un bloque `payment` rechazado.
 *
 * ⚠️ ESTA FUNCIÓN NO VALIDA NADA (CD-9). Los 7 guards viven en
 * `validatePaymentBlock` (`lib/payment-spec-writer.ts`) y en ningún otro lado;
 * acá sólo se traduce el rechazo a JSON. Re-implementar cualquiera de los
 * chequeos en este archivo está prohibido.
 *
 * El `reason` sale del mapa del módulo y es ESTÁTICO: **ninguno refleja el valor
 * recibido** (CD-8) — y AR/MNR-1 lo sacó también del LOG: se loguea sólo
 * `{ field, code }`, nunca el valor del caller (`T-316-27` / `T-316-28`).
 */
function paymentRejectionBody(
  rejection: PaymentBlockRejection,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    error: 'Invalid payment',
    error_code: rejection.code,
    field: rejection.field,
    reason: PAYMENT_REJECTION_REASON[rejection.code],
  };
  // La lista de rieles vivos sólo acompaña a AC-3, y es ACCIONABLE, no
  // disclosure: `getInitializedChainKeys()` ya sale sin auth por
  // `GET /capabilities` (`chains[].key`).
  if (rejection.code === 'PAYMENT_CHAIN_NOT_INITIALIZED') {
    body.initializedChains = rejection.initializedChains;
  }
  return body;
}

/**
 * Write-boundary guard de `referrerRef` (WKH-143b). String no-vacío tras `trim()`
 * y `<= 200` chars. El valor persistido es el trimmeado (DT-2). Opaco/inerte.
 */
function isValidReferrerRef(v: unknown): v is string {
  return (
    typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 200
  );
}

/** Filtra `capabilities` a elementos string (WKH-134 MNR-1). */
function stringCapabilities(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((c): c is string => typeof c === 'string')
    : [];
}

const agentsRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /agents — publicar un agente (AC-1).
   */
  fastify.post<{ Body: Partial<PublishAgentInput> & Record<string, unknown> }>(
    '/',
    {
      preHandler: [...requireA2AKey()],
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
        // MNR-1: `capabilities` se filtra a elementos string; si tras filtrar
        // queda vacío, cuenta como faltante (rechaza p.ej. `[123]`).
        const validCaps = stringCapabilities(body.capabilities);
        const missing: string[] = [];
        if (typeof body.name !== 'string' || body.name.trim() === '')
          missing.push('name');
        if (typeof body.agentUrl !== 'string' || body.agentUrl.trim() === '')
          missing.push('agentUrl');
        if (validCaps.length < 1) missing.push('capabilities');
        if (missing.length > 0) {
          return reply.status(400).send({
            error: 'Missing required fields',
            missing,
          });
        }

        // BLQ-1 (money-path): rechazar `priceUsdc` presente pero inválido
        // (negativo / NaN / Infinity / no-number) → 422. Un default ausente
        // se resuelve a 0 en el service.
        if (body.priceUsdc !== undefined && !isValidPriceUsdc(body.priceUsdc)) {
          request.log.warn(
            { field: 'priceUsdc' },
            'agent publish rejected: invalid priceUsdc',
          );
          return reply.status(422).send({
            error: 'Invalid priceUsdc',
            field: 'priceUsdc',
            reason: 'priceUsdc must be a finite number >= 0',
          });
        }

        // WKH-143b (money-path input): rechazar `payoutWallet` presente pero
        // inválido → 422 (mismo criterio EVM que resolveRecipients, CD-1/CD-5).
        if (
          body.payoutWallet !== undefined &&
          !isValidPayoutWalletForChain(body.payoutWallet, body.payoutChain)
        ) {
          request.log.warn(
            { field: 'payoutWallet' },
            'agent publish rejected: invalid payoutWallet',
          );
          return reply.status(422).send({
            error: 'Invalid payoutWallet',
            field: 'payoutWallet',
            reason: 'payoutWallet must be a valid EVM address',
          });
        }
        // WKH-143b: rechazar `referrerRef` presente pero inválido → 422.
        if (
          body.referrerRef !== undefined &&
          !isValidReferrerRef(body.referrerRef)
        ) {
          request.log.warn(
            { field: 'referrerRef' },
            'agent publish rejected: invalid referrerRef',
          );
          return reply.status(422).send({
            error: 'Invalid referrerRef',
            field: 'referrerRef',
            reason: 'referrerRef must be a non-empty string of <= 200 chars',
          });
        }

        // WKH-316: bloque `payment` presente pero inválido → 422. Los 7 guards
        // viven en `validatePaymentBlock` (CD-9); acá sólo se traduce.
        //
        // Nota de contrato: en el ALTA, un `payment: null` explícito NO es
        // "sin bloque" — cae en `INVALID_PAYMENT_BLOCK`. En una creación no hay
        // nada que borrar, así que aceptarlo en silencio sería inventarle un
        // significado. "Sin bloque" se dice omitiendo la key (AC-11).
        let paymentBlock: PublishAgentInput['payment'];
        if (body.payment !== undefined) {
          const result = await validatePaymentBlock(body.payment);
          if (!result.ok) {
            // AR/MNR-1: se loguea `{ field, code }` y NUNCA el valor crudo del
            // caller, igual que los 5 guards hermanos de este archivo
            // (`priceUsdc`, `payoutWallet`, `referrerRef`, `enabled`,
            // `capabilities`). `body.payment` es JSON elegido por el caller e
            // `src/index.ts` construye Fastify sin `bodyLimit` (default 1 MiB),
            // así que echarlo al log hace que la línea crezca con el input del
            // atacante — la misma clase de deuda que TD-322-4
            // (`src/lib/discovery-query.ts:219-229`). La línea es de longitud
            // acotada: `field` y `code` son literales del validador.
            request.log.warn(
              {
                field: result.rejection.field,
                code: result.rejection.code,
              },
              'agent publish rejected: invalid payment',
            );
            return reply
              .status(422)
              .send(paymentRejectionBody(result.rejection));
          }
          paymentBlock = result.block;
        }

        // CD-5: el slug se deriva server-side del `name` — cualquier `slug`
        // del body se ignora (no se pasa al service). Se arma el input SOLO
        // con los campos presentes (exactOptionalPropertyTypes: sin `undefined`).
        const input: PublishAgentInput = {
          name: body.name as string,
          agentUrl: body.agentUrl as string,
          capabilities: validCaps,
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
        // WKH-143b: captura condicional (exactOptionalPropertyTypes, CD-4).
        // referrerRef se persiste TRIMMEADO (DT-2).
        if (typeof body.payoutWallet === 'string')
          input.payoutWallet = body.payoutWallet;
        // WKH-234: contexto de familia namespace-aware (aditivo; ausente → EVM).
        if (typeof body.payoutChain === 'string')
          input.payoutChain = body.payoutChain;
        if (typeof body.referrerRef === 'string')
          input.referrerRef = body.referrerRef.trim();
        // WKH-316: lo que viaja al service es el bloque que produjo el
        // validador, NO `body.payment`. El service igual lo re-valida y vuelve a
        // producirlo (defense-in-depth), pero el route no le pasa el crudo.
        if (paymentBlock !== undefined) input.payment = paymentBlock;

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
      preHandler: [...requireA2AKey()],
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

        // BLQ-1 (money-path): rechazar `priceUsdc` presente pero inválido → 422.
        if (body.priceUsdc !== undefined && !isValidPriceUsdc(body.priceUsdc)) {
          request.log.warn(
            { field: 'priceUsdc' },
            'agent update rejected: invalid priceUsdc',
          );
          return reply.status(422).send({
            error: 'Invalid priceUsdc',
            field: 'priceUsdc',
            reason: 'priceUsdc must be a finite number >= 0',
          });
        }

        // WKH-143b (money-path input): mismos guards espejo que POST. El `body`
        // crudo fluye a update() (que persiste + trimea referrerRef); acá solo
        // se rechaza presente-inválido → 422 (CD-1/CD-5/DT-2/DT-3).
        if (
          body.payoutWallet !== undefined &&
          !isValidPayoutWalletForChain(body.payoutWallet, body.payoutChain)
        ) {
          request.log.warn(
            { field: 'payoutWallet' },
            'agent update rejected: invalid payoutWallet',
          );
          return reply.status(422).send({
            error: 'Invalid payoutWallet',
            field: 'payoutWallet',
            reason: 'payoutWallet must be a valid EVM address',
          });
        }
        if (
          body.referrerRef !== undefined &&
          !isValidReferrerRef(body.referrerRef)
        ) {
          request.log.warn(
            { field: 'referrerRef' },
            'agent update rejected: invalid referrerRef',
          );
          return reply.status(422).send({
            error: 'Invalid referrerRef',
            field: 'referrerRef',
            reason: 'referrerRef must be a non-empty string of <= 200 chars',
          });
        }

        // Baja/alta del agente: si `enabled` viene, debe ser un booleano. Un
        // `"false"` (string, truthy) o un `0` dejarían al agente al revés de lo
        // que su dueño pidió, y una baja que no da de baja es peor que no tenerla.
        if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
          request.log.warn(
            { field: 'enabled' },
            'agent update rejected: invalid enabled',
          );
          return reply.status(422).send({
            error: 'Invalid enabled',
            field: 'enabled',
            reason: 'enabled must be a boolean',
          });
        }

        // MNR-1: si `capabilities` viene, debe ser un array con >= 1 string.
        if (
          body.capabilities !== undefined &&
          stringCapabilities(body.capabilities).length < 1
        ) {
          request.log.warn(
            { field: 'capabilities' },
            'agent update rejected: invalid capabilities',
          );
          return reply.status(422).send({
            error: 'Invalid capabilities',
            field: 'capabilities',
            reason: 'capabilities must be a non-empty array of strings',
          });
        }

        // WKH-316: mismo guard espejo que POST, con UNA diferencia de contrato:
        // acá `payment: null` es la señal de BORRADO (AC-8), así que se deja
        // pasar sin validar. Ausente = "no lo toques"; objeto = reemplazar.
        //
        // ⚠️ Un caller que NO es el dueño y manda un bloque inválido recibe 422,
        // no 404: este guard corre antes que el guard de dueño, que vive adentro
        // de `update()`. Disclosure: cero — la validación depende sólo del input
        // del caller y de config que ya es pública por `GET /capabilities`.
        if (body.payment !== undefined && body.payment !== null) {
          const result = await validatePaymentBlock(body.payment);
          if (!result.ok) {
            // AR/MNR-1: sólo `{ field, code }`, nunca el crudo del caller.
            // Ver la nota extendida en el guard espejo del POST.
            request.log.warn(
              {
                field: result.rejection.field,
                code: result.rejection.code,
              },
              'agent update rejected: invalid payment',
            );
            return reply
              .status(422)
              .send(paymentRejectionBody(result.rejection));
          }
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
      preHandler: [...requireA2AKey()],
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
      preHandler: [...requireA2AKey()],
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
