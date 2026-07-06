/**
 * Inbound Adapter Routes — WKH-115.
 *
 * Registrado bajo prefix `/inbound`:
 *   POST /inbound/:source/tasks — ingesta push/webhook autenticada por HMAC.
 *
 * La fuente firma `HMAC-SHA256(secret, "<timestamp>.<rawBody>")` (hex) y manda
 * `x-wasiai-timestamp` + `x-wasiai-signature`. El route captura el body CRUDO
 * (para el HMAC) vía un content-type parser ENCAPSULADO a este plugin (CD-7:
 * Fastify encapsula parsers añadidos dentro de un plugin sin `fastify-plugin` →
 * NO afecta a otros routes como /orchestrate). Autentica, ingiere in-process y
 * mapea el resultado a HTTP.
 *
 * Exemplar: src/routes/agent-links.ts (route delgado + preHandler + error→HTTP).
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { createBackpressureHandler } from '../middleware/backpressure.js';
import { orchestrateRateLimit } from '../middleware/rate-limit.js';
import { createTimeoutHandler } from '../middleware/timeout.js';
import {
  InboundSourceMisconfiguredError,
  InvalidInboundPayloadError,
  inboundTaskService,
} from '../services/inbound-task.js';

const inboundRoutes: FastifyPluginAsync = async (fastify) => {
  // Content-type parser raw-body ENCAPSULADO al plugin (CD-7). Stashea el body
  // crudo en `req.rawBody` (Buffer) y luego parsea el JSON normal. Fastify
  // encapsula este parser porque el plugin NO usa `fastify-plugin` → NO se
  // filtra a /orchestrate ni a ningún otro route (verificado por test).
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      (req as FastifyRequest & { rawBody?: Buffer }).rawBody = body as Buffer;
      try {
        const buf = body as Buffer;
        done(null, buf.length ? JSON.parse(buf.toString('utf8')) : {});
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // ─── POST /inbound/:source/tasks — ingesta autenticada ──────────
  fastify.post<{ Params: { source: string } }>(
    '/:source/tasks',
    {
      config: { rateLimit: orchestrateRateLimit() },
      preHandler: [
        createBackpressureHandler(),
        createTimeoutHandler(
          parseInt(process.env.TIMEOUT_ORCHESTRATE_MS ?? '120000', 10),
        ),
      ],
    },
    async (
      req: FastifyRequest<{ Params: { source: string } }>,
      reply: FastifyReply,
    ) => {
      // Bail early si el timeout ya envió 504.
      if (reply.sent) return;

      const { source } = req.params;
      const rawBody =
        (req as FastifyRequest & { rawBody?: Buffer }).rawBody ??
        Buffer.alloc(0);
      const timestamp = req.headers['x-wasiai-timestamp'];
      const signature = req.headers['x-wasiai-signature'];

      // CD-6: auth ANTES de tocar DB o invocar orchestrate. Header ausente /
      // no-string → 401 (mismo código que firma inválida; no filtra la causa).
      if (typeof timestamp !== 'string' || typeof signature !== 'string') {
        return reply.status(401).send({ error_code: 'UNAUTHORIZED' });
      }

      const cfg = inboundTaskService.verifySourceAuth(
        source,
        rawBody,
        timestamp,
        signature,
      );
      if (!cfg) {
        return reply.status(401).send({ error_code: 'UNAUTHORIZED' });
      }

      try {
        const result = await inboundTaskService.ingest(source, cfg, req.body);
        if (reply.sent) return;
        return reply.status(200).send(result);
      } catch (err) {
        if (err instanceof InvalidInboundPayloadError) {
          return reply.status(400).send({ error_code: 'INVALID_PAYLOAD' });
        }
        if (err instanceof InboundSourceMisconfiguredError) {
          return reply
            .status(500)
            .send({ error_code: 'INBOUND_SOURCE_MISCONFIGURED' });
        }
        fastify.log.error(
          {
            errorClass: err instanceof Error ? err.constructor.name : 'unknown',
          },
          'inbound ingest failed',
        );
        return reply.status(500).send({ error_code: 'INBOUND_FAILED' });
      }
    },
  );
};

export default inboundRoutes;
