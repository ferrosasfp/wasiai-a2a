/**
 * Auth Routes — server-side key sessions (WKH-121/122/123).
 *
 * Pure reorganization of `src/routes/auth.ts` (refactor B2, 2026-06-24).
 * POST   /key-session                       — Create a server-side session key.
 * GET    /key-session                       — List the caller's key sessions.
 * DELETE /key-session/:id                   — Revoke ONE session key.
 * PATCH  /key-session/:id/require-signature — Toggle HMAC per-request signature.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { isValidUUID } from '../../lib/uuid.js';
import {
  InvalidKeySessionInputError,
  keySessionService,
  ScopeExceedsParentError,
} from '../../services/key-session.js';
import {
  SessionNotAllowedError,
  SessionNotFoundError,
  SigningSecretNotSetError,
} from '../../services/security/errors.js';
import {
  KEY_SESSION_TOKEN_PREFIX,
  parseCreateKeySessionInput,
  rawKeyFromRequest,
  resolveCallerKey,
} from './parsers.js';

export const keySessionRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /auth/key-session — Create a server-side session key (WKH-121).
   * AC-1/AC-2/AC-3/AC-12. The owner (authenticated with its MASTER key) derives
   * an ephemeral session key WITHOUT EVM signature. The opaque session token is
   * returned ONCE in the 201; only its SHA-256 hash is stored.
   */
  fastify.post(
    '/key-session',
    async (req: FastifyRequest, reply: FastifyReply) => {
      // AC-12: sub-delegation forbidden. A session token authenticator →
      // 403 SESSION_NOT_ALLOWED (detect the prefix BEFORE resolveCallerKey,
      // which would return null and lose the exact code).
      const rawKey = rawKeyFromRequest(req);
      if (rawKey?.startsWith(KEY_SESSION_TOKEN_PREFIX)) {
        // MNR-3: consumir la error class (consistencia con las demás; WKH-122
        // reusa el gate). HTTP final intacto: 403 + error_code SESSION_NOT_ALLOWED.
        const err = new SessionNotAllowedError();
        return reply.status(403).send({ error_code: err.code });
      }

      // Auth (master key).
      const callerKey = await resolveCallerKey(req);
      if (!callerKey?.is_active) {
        return reply.status(403).send({ error: 'Invalid or inactive API key' });
      }

      // Input shape validation (CD-AB-3). Rango/scope los valida el service.
      const input = parseCreateKeySessionInput(req.body);
      if (!input) {
        return reply.status(400).send({ error_code: 'INVALID_INPUT' });
      }

      try {
        const result = await keySessionService.create(callerKey, input);
        return reply.status(201).send(result);
      } catch (err) {
        if (err instanceof InvalidKeySessionInputError) {
          return reply.status(400).send({ error_code: 'INVALID_INPUT' });
        }
        if (err instanceof ScopeExceedsParentError) {
          return reply.status(400).send({ error_code: 'SCOPE_EXCEEDS_PARENT' });
        }
        fastify.log.error(
          {
            errorClass: err instanceof Error ? err.constructor.name : 'unknown',
          },
          'key-session create failed',
        );
        return reply
          .status(500)
          .send({ error_code: 'KEY_SESSION_CREATE_FAILED' });
      }
    },
  );

  /**
   * GET /auth/key-session — List the caller's key sessions (WKH-121: AC-13).
   * Ownership Guard in the service (filtered by owner_ref). Never returns tokens.
   */
  fastify.get(
    '/key-session',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const callerKey = await resolveCallerKey(req);
      if (!callerKey?.is_active) {
        return reply.status(403).send({ error: 'Invalid or inactive API key' });
      }

      // Contrato BLOQUEANTE: el body es un array plano de KeySessionListItem.
      const items = await keySessionService.list(callerKey.owner_ref);
      return reply.status(200).send(items);
    },
  );

  /**
   * DELETE /auth/key-session/:id — Revoke ONE session key (WKH-122).
   * AC-1/AC-3/AC-4/AC-5. Authenticated with the MASTER key. Sub-session tokens
   * are forbidden as authenticators (gate BEFORE resolveCallerKey). Ownership
   * mismatch / unknown id → 404 SESSION_NOT_FOUND (disclosure-safe, CD-6).
   */
  fastify.delete(
    '/key-session/:id',
    async (
      req: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      // AC-5: sub-revocation forbidden. A session token authenticator →
      // 403 SESSION_NOT_ALLOWED (detect the prefix BEFORE resolveCallerKey,
      // which would return null and lose the exact code, CD-5).
      const rawKey = rawKeyFromRequest(req);
      if (rawKey?.startsWith(KEY_SESSION_TOKEN_PREFIX)) {
        const err = new SessionNotAllowedError();
        return reply.status(403).send({ error_code: err.code });
      }

      // Auth (master key).
      const callerKey = await resolveCallerKey(req);
      if (!callerKey?.is_active) {
        return reply.status(403).send({ error: 'Invalid or inactive API key' });
      }

      // WKH-345: forma del `:id` ANTES de la capa de datos. Sin esto el valor
      // llega a una columna `uuid` y Postgres responde 22P02 → 500.
      // Va DESPUÉS del gate de prefijo de sub-sesión y del 403 de auth, a
      // propósito: un autenticador explícitamente prohibido no debe recibir
      // feedback sobre la forma del id (T-5 lo fija).
      if (!isValidUUID(req.params.id)) {
        return reply.status(400).send({ error_code: 'INVALID_INPUT' });
      }

      try {
        await keySessionService.revoke(req.params.id, callerKey.owner_ref);
        return reply.status(200).send({ revoked: true });
      } catch (err) {
        if (err instanceof SessionNotFoundError) {
          return reply.status(404).send({ error_code: 'SESSION_NOT_FOUND' });
        }
        fastify.log.error(
          {
            errorClass: err instanceof Error ? err.constructor.name : 'unknown',
          },
          'key-session revoke failed',
        );
        return reply
          .status(500)
          .send({ error_code: 'KEY_SESSION_REVOKE_FAILED' });
      }
    },
  );

  /**
   * PATCH /auth/key-session/:id/require-signature — Toggle HMAC per-request
   * signature on a session key (WKH-123, AC-10). Authenticated with the MASTER
   * key. Enabling requires `signing_secret_hash` set (only at create-time with
   * require_signature:true). Ownership mismatch / unknown id → 404
   * SESSION_NOT_FOUND (disclosure-safe).
   */
  fastify.patch(
    '/key-session/:id/require-signature',
    async (
      req: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      // Sub-session tokens forbidden as authenticators.
      const rawKey = rawKeyFromRequest(req);
      if (rawKey?.startsWith(KEY_SESSION_TOKEN_PREFIX)) {
        const err = new SessionNotAllowedError();
        return reply.status(403).send({ error_code: err.code });
      }

      const callerKey = await resolveCallerKey(req);
      if (!callerKey?.is_active) {
        return reply.status(403).send({ error: 'Invalid or inactive API key' });
      }

      const body = req.body as { require_signature?: unknown } | undefined;
      if (typeof body?.require_signature !== 'boolean') {
        return reply.status(400).send({ error_code: 'INVALID_INPUT' });
      }
      const value = body.require_signature;

      // WKH-345: forma del `:id` ANTES de la capa de datos. Va DESPUÉS de la
      // validación de body porque este handler ya responde 400 INVALID_INPUT al
      // body y más abajo 400 SIGNING_SECRET_NOT_SET: mantener el body primero
      // preserva el orden actual sin tener que decidir cuál de los dos gana.
      if (!isValidUUID(req.params.id)) {
        return reply.status(400).send({ error_code: 'INVALID_INPUT' });
      }

      try {
        await keySessionService.setRequireSignature(
          req.params.id,
          callerKey.owner_ref,
          value,
        );
        return reply.status(200).send({ ok: true, require_signature: value });
      } catch (err) {
        if (err instanceof SigningSecretNotSetError) {
          return reply
            .status(400)
            .send({ error_code: 'SIGNING_SECRET_NOT_SET' });
        }
        if (err instanceof SessionNotFoundError) {
          return reply.status(404).send({ error_code: 'SESSION_NOT_FOUND' });
        }
        fastify.log.error(
          {
            errorClass: err instanceof Error ? err.constructor.name : 'unknown',
          },
          'key-session require-signature failed',
        );
        return reply
          .status(500)
          .send({ error_code: 'REQUIRE_SIGNATURE_FAILED' });
      }
    },
  );
};
