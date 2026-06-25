/**
 * Auth Routes — funding-wallet + Kite passport binding.
 *
 * Pure reorganization of `src/routes/auth.ts` (refactor B2, 2026-06-24).
 * POST /funding-wallet  — Bind a funding wallet with proof of control (WKH-35).
 * POST /bind-passport   — Bind a Kite Agent Passport address (WKH-117, gated).
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { recoverMessageAddress } from 'viem';
import { identityService } from '../../services/identity.js';
import {
  FundingWalletAlreadyBoundError,
  OwnershipMismatchError,
} from '../../services/security/errors.js';
import {
  ADDRESS_RE,
  fundingWalletBindMessage,
  resolveCallerKey,
} from './parsers.js';

export const fundingWalletRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /funding-wallet — Bind a funding wallet to the caller's key with
   * proof of control (WKH-35 FIX-1, BLQ-MED-1).
   *
   * The caller signs the canonical message `WASIAI_BIND_FUNDING_WALLET:<key_id>`
   * (key_id derived from the authenticated key, NEVER the body). We recover the
   * signer with viem and require it to equal the claimed wallet. On success the
   * wallet is stored (lowercase) on the caller's key (UPDATE filtered by
   * id + owner_ref — Ownership Guard). Subsequent /deposit calls require
   * Transfer.from == funding_wallet.
   */
  fastify.post(
    '/funding-wallet',
    async (req: FastifyRequest, reply: FastifyReply) => {
      // 1. Auth — mismo helper que /me y /deposit.
      const callerKey = await resolveCallerKey(req);
      if (!callerKey?.is_active) {
        return reply.status(403).send({ error: 'Invalid or inactive API key' });
      }

      // 2. Validar input. key_id y owner_ref salen del caller, NUNCA del body.
      const body = req.body as
        | { wallet?: unknown; signature?: unknown }
        | undefined;
      const wallet = body?.wallet;
      const signature = body?.signature;
      if (
        typeof wallet !== 'string' ||
        !ADDRESS_RE.test(wallet) ||
        typeof signature !== 'string' ||
        signature.trim() === ''
      ) {
        return reply.status(400).send({ error_code: 'INVALID_INPUT' });
      }

      // 3. Verificar la firma con viem: recuperar el firmante del mensaje
      // canónico (derivado del key_id autenticado) y exigir match con `wallet`.
      let recovered: `0x${string}`;
      try {
        recovered = await recoverMessageAddress({
          message: fundingWalletBindMessage(callerKey.id),
          signature: signature as `0x${string}`,
        });
      } catch {
        return reply
          .status(403)
          .send({ error_code: 'FUNDING_WALLET_PROOF_INVALID' });
      }
      if (recovered.toLowerCase() !== wallet.toLowerCase()) {
        return reply
          .status(403)
          .send({ error_code: 'FUNDING_WALLET_PROOF_INVALID' });
      }

      // 4. Persistir (UPDATE filtrado por id + owner_ref — Ownership Guard).
      try {
        const fundingWallet = await identityService.bindFundingWallet(
          callerKey.id,
          callerKey.owner_ref,
          wallet,
        );
        return reply.status(200).send({ funding_wallet: fundingWallet });
      } catch (err) {
        if (err instanceof FundingWalletAlreadyBoundError) {
          return reply
            .status(409)
            .send({ error_code: 'FUNDING_WALLET_ALREADY_BOUND' });
        }
        if (err instanceof OwnershipMismatchError) {
          return reply.status(403).send({ error_code: 'OWNERSHIP_MISMATCH' });
        }
        fastify.log.error(
          {
            errorClass: err instanceof Error ? err.constructor.name : 'unknown',
          },
          'funding-wallet bind failed',
        );
        return reply
          .status(500)
          .send({ error_code: 'FUNDING_WALLET_BIND_FAILED' });
      }
    },
  );

  /**
   * POST /bind-passport — Bind a Kite Agent Passport address to the caller's
   * key (WKH-117, AC-8). Gate-at-mount (DT-8): the route only exists when
   * `PASSPORT_BINDING_ENABLED === 'true'`; otherwise callers get a natural 404
   * (no exposed surface). The key_id + owner_ref come from the authenticated
   * caller, NEVER the body (Ownership Guard / CD-3). `kite_passport` is stored
   * as `{ address (lowercase), bound_at }` and stays read-only on every
   * auth/debit path (AC-9).
   */
  if (process.env.PASSPORT_BINDING_ENABLED === 'true') {
    fastify.post(
      '/bind-passport',
      async (req: FastifyRequest, reply: FastifyReply) => {
        // 1. Auth — mismo helper que /me, /deposit y /funding-wallet.
        const callerKey = await resolveCallerKey(req);
        if (!callerKey?.is_active) {
          return reply
            .status(403)
            .send({ error: 'Invalid or inactive API key' });
        }

        // 2. Validar input. key_id y owner_ref salen del caller, NUNCA del body.
        const body = req.body as
          | { passportAddress?: unknown; keyId?: unknown }
          | undefined;
        const passportAddress = body?.passportAddress;
        if (
          typeof passportAddress !== 'string' ||
          !ADDRESS_RE.test(passportAddress)
        ) {
          return reply.status(400).send({ error_code: 'INVALID_INPUT' });
        }

        // 2b. Defense-in-depth (CD-3): si el body trae keyId, debe ser el del
        // caller autenticado. El keyId autoritativo es callerKey.id (no el body).
        if (body?.keyId !== undefined && body.keyId !== callerKey.id) {
          return reply.status(403).send({ error_code: 'OWNERSHIP_MISMATCH' });
        }

        // 3. Persistir (UPDATE filtrado por id + owner_ref — Ownership Guard).
        try {
          const kitePassport = await identityService.bindPassport(
            callerKey.id,
            callerKey.owner_ref,
            passportAddress,
          );
          return reply.status(200).send({ kite_passport: kitePassport });
        } catch (err) {
          if (err instanceof OwnershipMismatchError) {
            return reply.status(403).send({ error_code: 'OWNERSHIP_MISMATCH' });
          }
          fastify.log.error(
            {
              errorClass:
                err instanceof Error ? err.constructor.name : 'unknown',
            },
            'bind-passport failed',
          );
          return reply.status(500).send({ error_code: 'PASSPORT_BIND_FAILED' });
        }
      },
    );
  }
};
