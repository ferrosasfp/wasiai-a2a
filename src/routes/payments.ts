/**
 * Payment Intent Routes — WKH-135 · `/payments/session/*` + `/payments/upto/*`
 *
 * Endpoints aditivos (SG-3). El prefijo `/payments` lo pone index.ts.
 *   POST /session               — abre una sesión metered (reserva el deposit).
 *   POST /session/:id/voucher   — acumula un voucher idempotente.
 *   POST /session/:id/close     — cierra + settlea min(Σvouchers, deposit) + refund.
 *   POST /upto                  — crea un intent con cap EIP-712 dual-firmado.
 *   POST /upto/:id/settle       — settlea min(cap, reportedUsage) al seller.
 *
 * Reglas: auth vía resolveCallerKey (x-a2a-key | Bearer wasi_a2a_*); ownerRef =
 * callerKey.owner_ref; intentId server-side (crypto.randomUUID, CD-1/CD-5);
 * write-boundary de todo monto money-path (CD-12, 422 si no es number finito >=0).
 */

import crypto from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { getChainConfig } from '../adapters/registry.js';
import {
  PaymentIntentError,
  paymentIntentService,
} from '../services/payment-intent.js';
import type { UptoCapTypedData } from '../types/index.js';
import { resolveCallerKey } from './auth/parsers.js';

// ── Helpers ─────────────────────────────────────────────────────

/** CD-12: monto money-path válido = number finito >= 0 (rechaza NaN/Infinity). */
function isFiniteNonNegative(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0;
}

/**
 * MNR-1: v1 sólo settlea/verifica en la default chain — el settle usa el adapter
 * y el settle-verifier de la default chain (sin `chainKey`). Aceptar un chainId
 * no-default settlearia/verificaria en la cadena EQUIVOCADA, así que se rechaza
 * en el write-boundary (fail-closed).
 */
function isDefaultChain(chainId: number): boolean {
  return chainId === getChainConfig().chainId;
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0;
}

/** Mapea PaymentIntentError.code → HTTP (tabla de errores del Story File). */
function sendPaymentError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof PaymentIntentError) {
    switch (err.code) {
      case 'INVALID_INPUT':
        return reply.status(422).send({ error_code: 'INVALID_INPUT' });
      case 'CAP_SIGNATURE_INVALID':
        return reply.status(400).send({ error_code: 'CAP_SIGNATURE_INVALID' });
      case 'OWNERSHIP_MISMATCH':
        return reply.status(403).send({ error_code: 'OWNERSHIP_MISMATCH' });
      case 'INTENT_NOT_FOUND':
        return reply.status(404).send({ error_code: 'INTENT_NOT_FOUND' });
      case 'INTENT_NOT_OPEN':
        return reply.status(409).send({ error_code: 'INTENT_NOT_OPEN' });
      case 'INSUFFICIENT_BUDGET':
        return reply.status(400).send({ error_code: 'INSUFFICIENT_BUDGET' });
      default:
        return reply.status(500).send({ error_code: 'PAYMENT_INTENT_FAILED' });
    }
  }
  // Nunca propagar el mensaje crudo (disclosure-safe).
  return reply.status(500).send({ error_code: 'PAYMENT_INTENT_FAILED' });
}

/** Valida + tipa el typed-data del cap upto (primaryType==='UptoCap'). null si inválido. */
function parseUptoTypedData(raw: unknown): UptoCapTypedData | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const td = raw as Record<string, unknown>;
  if (
    typeof td.domain !== 'object' ||
    td.domain === null ||
    typeof td.types !== 'object' ||
    td.types === null ||
    td.primaryType !== 'UptoCap' ||
    typeof td.message !== 'object' ||
    td.message === null
  ) {
    return null;
  }
  const domain = td.domain as Record<string, unknown>;
  if (
    typeof domain.name !== 'string' ||
    typeof domain.version !== 'string' ||
    typeof domain.chainId !== 'number'
  ) {
    return null;
  }
  const message = td.message as Record<string, unknown>;
  if (
    typeof message.seller_ref !== 'string' ||
    typeof message.cap !== 'string' ||
    typeof message.chain_id !== 'number' ||
    typeof message.nonce !== 'string' ||
    typeof message.expires_at !== 'number' ||
    !Number.isFinite(message.expires_at)
  ) {
    return null;
  }
  return {
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId,
    },
    types: td.types as UptoCapTypedData['types'],
    primaryType: 'UptoCap',
    message: {
      seller_ref: message.seller_ref,
      cap: message.cap,
      chain_id: message.chain_id,
      nonce: message.nonce as `0x${string}`,
      expires_at: message.expires_at,
    },
  };
}

// ── Plugin ──────────────────────────────────────────────────────

export const paymentsRoutes: FastifyPluginAsync = async (fastify) => {
  // ── POST /session — abre una sesión metered (reserva el deposit) ──
  fastify.post('/session', async (req: FastifyRequest, reply: FastifyReply) => {
    const callerKey = await resolveCallerKey(req);
    if (!callerKey?.is_active) {
      return reply.status(403).send({ error: 'Invalid or inactive API key' });
    }
    const b = (req.body ?? {}) as Record<string, unknown>;

    // Write-boundary (CD-12).
    if (
      !isNonEmptyString(b.keyId) ||
      !isNonEmptyString(b.sellerRef) ||
      !isNonEmptyString(b.payTo) ||
      typeof b.chainId !== 'number' ||
      !Number.isInteger(b.chainId) ||
      !isFiniteNonNegative(b.depositUsd)
    ) {
      return reply.status(422).send({ error_code: 'INVALID_INPUT' });
    }
    // MNR-1: sólo la default chain (evita settlear/verificar en la equivocada).
    if (!isDefaultChain(b.chainId)) {
      return reply.status(422).send({ error_code: 'CHAIN_NOT_SUPPORTED' });
    }
    let ttlSeconds: number | undefined;
    if (b.ttlSeconds !== undefined) {
      if (typeof b.ttlSeconds !== 'number' || !Number.isInteger(b.ttlSeconds)) {
        return reply.status(422).send({ error_code: 'INVALID_INPUT' });
      }
      ttlSeconds = b.ttlSeconds;
    }

    const intentId = crypto.randomUUID(); // CD-1/CD-5: server-side, nunca del cliente.
    try {
      const result = await paymentIntentService.openSession({
        intentId,
        keyId: b.keyId,
        ownerRef: callerKey.owner_ref,
        buyerWallet: callerKey.funding_wallet,
        sellerRef: b.sellerRef,
        payTo: b.payTo,
        chainId: b.chainId,
        depositUsd: b.depositUsd,
        ...(ttlSeconds !== undefined && { ttlSeconds }),
      });
      return reply.status(201).send({
        intentId: result.intentId,
        intentType: 'session',
        expiresAt: result.expiresAt,
      });
    } catch (err) {
      fastify.log.error(
        { errorClass: err instanceof Error ? err.constructor.name : 'unknown' },
        'openSession failed',
      );
      return sendPaymentError(reply, err);
    }
  });

  // ── POST /session/:id/voucher — acumula un voucher idempotente ──
  fastify.post(
    '/session/:id/voucher',
    async (
      req: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const callerKey = await resolveCallerKey(req);
      if (!callerKey?.is_active) {
        return reply.status(403).send({ error: 'Invalid or inactive API key' });
      }
      const b = (req.body ?? {}) as Record<string, unknown>;

      if (!isNonEmptyString(b.voucherId) || !isFiniteNonNegative(b.amountUsd)) {
        return reply.status(422).send({ error_code: 'INVALID_INPUT' });
      }

      try {
        const result = await paymentIntentService.addVoucher({
          intentId: req.params.id,
          ownerRef: callerKey.owner_ref,
          voucherId: b.voucherId,
          amountUsd: b.amountUsd,
        });
        return reply.status(200).send(result);
      } catch (err) {
        fastify.log.error(
          {
            errorClass: err instanceof Error ? err.constructor.name : 'unknown',
          },
          'addVoucher failed',
        );
        return sendPaymentError(reply, err);
      }
    },
  );

  // ── POST /session/:id/close — cierra + settlea + refund ──
  fastify.post(
    '/session/:id/close',
    async (
      req: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const callerKey = await resolveCallerKey(req);
      if (!callerKey?.is_active) {
        return reply.status(403).send({ error: 'Invalid or inactive API key' });
      }

      try {
        const outcome = await paymentIntentService.closeSession(
          req.params.id,
          callerKey.owner_ref,
        );
        return reply.status(200).send({
          status: outcome.status,
          txHash: outcome.txHash,
          consumedUsd: outcome.consumedUsd ?? 0,
          residualUsd: outcome.residualUsd ?? 0,
        });
      } catch (err) {
        fastify.log.error(
          {
            errorClass: err instanceof Error ? err.constructor.name : 'unknown',
          },
          'closeSession failed',
        );
        return sendPaymentError(reply, err);
      }
    },
  );

  // ── POST /upto — crea un intent con cap EIP-712 dual-firmado ──
  fastify.post('/upto', async (req: FastifyRequest, reply: FastifyReply) => {
    const callerKey = await resolveCallerKey(req);
    if (!callerKey?.is_active) {
      return reply.status(403).send({ error: 'Invalid or inactive API key' });
    }
    const b = (req.body ?? {}) as Record<string, unknown>;

    // Write-boundary (CD-12).
    if (
      !isNonEmptyString(b.keyId) ||
      !isNonEmptyString(b.sellerRef) ||
      !isNonEmptyString(b.payTo) ||
      typeof b.chainId !== 'number' ||
      !Number.isInteger(b.chainId) ||
      !isFiniteNonNegative(b.capUsd) ||
      !isNonEmptyString(b.capSignature) ||
      !isNonEmptyString(b.capNonce)
    ) {
      return reply.status(422).send({ error_code: 'INVALID_INPUT' });
    }
    // MNR-1: sólo la default chain (evita settlear/verificar en la equivocada).
    if (!isDefaultChain(b.chainId)) {
      return reply.status(422).send({ error_code: 'CHAIN_NOT_SUPPORTED' });
    }
    const typedData = parseUptoTypedData(b.typedData);
    if (!typedData) {
      return reply.status(422).send({ error_code: 'INVALID_INPUT' });
    }
    // El cap upto se ancla al funding_wallet; sin él no se puede verificar la firma.
    if (!callerKey.funding_wallet) {
      return reply.status(400).send({ error_code: 'CAP_SIGNATURE_INVALID' });
    }

    const intentId = crypto.randomUUID(); // CD-1/CD-5.
    try {
      const result = await paymentIntentService.createUpto({
        intentId,
        keyId: b.keyId,
        ownerRef: callerKey.owner_ref,
        buyerWallet: callerKey.funding_wallet,
        sellerRef: b.sellerRef,
        payTo: b.payTo,
        chainId: b.chainId,
        capUsd: b.capUsd,
        capSignature: b.capSignature,
        capNonce: b.capNonce,
        typedData,
      });
      return reply.status(201).send({
        intentId: result.intentId,
        intentType: 'upto',
        expiresAt: result.expiresAt,
      });
    } catch (err) {
      fastify.log.error(
        { errorClass: err instanceof Error ? err.constructor.name : 'unknown' },
        'createUpto failed',
      );
      return sendPaymentError(reply, err);
    }
  });

  // ── POST /upto/:id/settle — settlea min(cap, reportedUsage) ──
  fastify.post(
    '/upto/:id/settle',
    async (
      req: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const callerKey = await resolveCallerKey(req);
      if (!callerKey?.is_active) {
        return reply.status(403).send({ error: 'Invalid or inactive API key' });
      }
      const b = (req.body ?? {}) as Record<string, unknown>;

      if (!isFiniteNonNegative(b.reportedUsageUsd)) {
        return reply.status(422).send({ error_code: 'INVALID_INPUT' });
      }

      try {
        const outcome = await paymentIntentService.settleUpto(
          req.params.id,
          callerKey.owner_ref,
          b.reportedUsageUsd,
        );
        return reply.status(200).send({
          status: outcome.status,
          txHash: outcome.txHash,
          chargedUsd: outcome.finalAmountUsd,
          cappedAt: outcome.cappedAt ?? false,
        });
      } catch (err) {
        fastify.log.error(
          {
            errorClass: err instanceof Error ? err.constructor.name : 'unknown',
          },
          'settleUpto failed',
        );
        return sendPaymentError(reply, err);
      }
    },
  );
};

export default paymentsRoutes;
