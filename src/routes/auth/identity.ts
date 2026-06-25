/**
 * Auth Routes — ERC-8004 identity binding + resolution (WKH-100).
 *
 * Pure reorganization of `src/routes/auth.ts` (refactor B2, 2026-06-24).
 * POST /erc8004/bind               — Bind an on-chain-verified ERC-8004 identity.
 * GET  /erc8004/resolve/:token_id  — Public, read-only tokenURI resolution.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { getBaseNetwork } from '../../adapters/base/chain.js';
import { getErc8004Reader } from '../../adapters/erc8004-identity.js';
import { identityService } from '../../services/identity.js';
import { registryService } from '../../services/registry.js';
import {
  Erc8004TokenAlreadyBoundError,
  OwnershipMismatchError,
} from '../../services/security/errors.js';
import type { Erc8004IdentityBinding } from '../../types/index.js';
import {
  parseTokenId,
  REGISTRY_ID_RE,
  resolveCallerKey,
  SLUG_RE,
} from './parsers.js';

export const identityRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /erc8004/bind — Bind an on-chain-verified ERC-8004 identity to the
   * caller's Agent Key (WKH-100: AC-1/AC-3/AC-4/AC-5/AC-11/AC-12).
   *
   * The server READS the ERC-8004 IdentityRegistry (ERC-721) with viem and
   * requires `ownerOf(token_id) == funding_wallet` (CD-7/CD-10) before writing
   * the binding. It NEVER mints/signs (CD-8) and NEVER touches budget (CD-2/AC-12).
   */
  fastify.post(
    '/erc8004/bind',
    async (req: FastifyRequest, reply: FastifyReply) => {
      // 1. Auth.
      const callerKey = await resolveCallerKey(req);
      if (!callerKey?.is_active) {
        return reply.status(403).send({ error: 'Invalid or inactive API key' });
      }

      // 2. Validate token_id (DT-14 / CD-11).
      const body = req.body as
        | {
            token_id?: unknown;
            agent_slug?: unknown;
            agent_registry?: unknown;
          }
        | undefined;
      const tokenId = parseTokenId(body?.token_id);
      if (tokenId === null) {
        return reply.status(400).send({ error_code: 'INVALID_INPUT' });
      }

      // 2b. agent_slug OPCIONAL — ahora ancla de trust (MNR-1 / DT-22).
      let agentSlug: string | undefined;
      if (body?.agent_slug !== undefined) {
        if (typeof body.agent_slug !== 'string') {
          return reply.status(400).send({ error_code: 'INVALID_INPUT' });
        }
        const trimmed = body.agent_slug.trim();
        if (!SLUG_RE.test(trimmed)) {
          return reply.status(400).send({ error_code: 'INVALID_INPUT' });
        }
        agentSlug = trimmed;
      }

      // 2c. agent_registry OPCIONAL — ancla del lado binder. WKH-100 FIX v3
      // (DT-23 / BLQ-MED-1): es el PK `id` del registry (no el display name).
      // Validar contra el patrón de PK + existencia real en `registries` (read,
      // NO RPC — CD-8 OK). Esto persiste el PK canónico como ancla inmutable.
      let agentRegistry: string | undefined;
      if (body?.agent_registry !== undefined) {
        if (typeof body.agent_registry !== 'string') {
          return reply.status(400).send({ error_code: 'INVALID_INPUT' });
        }
        const trimmed = body.agent_registry.trim();
        if (!REGISTRY_ID_RE.test(trimmed)) {
          return reply.status(400).send({ error_code: 'INVALID_INPUT' });
        }
        // DT-23.3.2: rechazar PK inexistente (lectura local de `registries`).
        const reg = await registryService.get(trimmed);
        if (!reg) {
          return reply.status(400).send({ error_code: 'INVALID_INPUT' });
        }
        agentRegistry = trimmed;
      }

      // 2d. JUNTOS o NINGUNO (DT-22.7): el ancla de trust requiere AMBOS
      // (registry, slug). Solo uno → 400. Ninguno → bind sin ancla (válido,
      // sin badge, backward-compat AC-9).
      if ((agentRegistry === undefined) !== (agentSlug === undefined)) {
        return reply.status(400).send({ error_code: 'INVALID_INPUT' });
      }

      // 3. funding_wallet must be bound first — NO RPC (AC-3).
      if (!callerKey.funding_wallet) {
        return reply
          .status(400)
          .send({ error_code: 'FUNDING_WALLET_NOT_BOUND' });
      }
      const fundingWallet = callerKey.funding_wallet;

      const network = getBaseNetwork();
      const expectedChainId = network === 'mainnet' ? 8453 : 84532;

      // 4. Idempotencia (AC-5/DT-8) — SIN RPC, leyendo el row ya cargado.
      const existing = callerKey.erc8004_identity;
      if (
        existing &&
        existing.token_id === tokenId.toString() &&
        existing.chain_id === expectedChainId
      ) {
        return reply.status(409).send({ error_code: 'ERC8004_ALREADY_BOUND' });
      }

      // 5. Verify ownership on-chain (read-only).
      const reader = getErc8004Reader();
      const v = await reader.verifyOwnership({
        tokenId,
        expectedOwner: fundingWallet,
      });
      if (!v.ok) {
        switch (v.reason) {
          case 'RPC_UNAVAILABLE':
            return reply
              .status(503)
              .send({ ok: false, reason: 'RPC_UNAVAILABLE' });
          case 'REGISTRY_NOT_CONFIGURED':
            return reply
              .status(503)
              .send({ ok: false, reason: 'REGISTRY_NOT_CONFIGURED' });
          case 'TOKEN_NOT_FOUND':
            return reply
              .status(404)
              .send({ error_code: 'ERC8004_TOKEN_NOT_FOUND' });
          case 'CHAIN_MISMATCH':
            return reply
              .status(502)
              .send({ error_code: 'ERC8004_CHAIN_MISMATCH' });
          default:
            return reply
              .status(503)
              .send({ ok: false, reason: 'RPC_UNAVAILABLE' });
        }
      }
      if (!v.matches) {
        // AC-4 — SIN write.
        return reply
          .status(403)
          .send({ error_code: 'IDENTITY_OWNERSHIP_MISMATCH' });
      }

      // 6. Resolve tokenURI (best-effort — DT-15: no bloquear bind si falla).
      const r = await reader.resolve({ tokenId });
      const agentCardUrl = r.ok && r.tokenUri ? r.tokenUri : '';

      // 7. Build binding.
      const binding: Erc8004IdentityBinding = {
        token_id: tokenId.toString(), // string decimal (CD-11)
        chain_id: expectedChainId,
        agent_card_url: agentCardUrl,
        owner_address: fundingWallet.toLowerCase(),
        verified_at: new Date().toISOString(),
        // MNR-1 / DT-22: ancla de trust bidireccional. Van JUNTOS o NINGUNO
        // (validado arriba). Sin ancla → bind válido sin badge (AC-9).
        ...(agentRegistry &&
          agentSlug && {
            agent_registry: agentRegistry,
            agent_slug: agentSlug,
          }),
      };

      // 8. Persist (Ownership Guard in the service — CD-3).
      try {
        await identityService.bindErc8004Identity(
          callerKey.id,
          callerKey.owner_ref,
          binding,
        );
      } catch (err) {
        if (err instanceof OwnershipMismatchError) {
          return reply.status(403).send({ error_code: 'OWNERSHIP_MISMATCH' });
        }
        // WKH-100 FIX-PACK (BLQ-MED-1 / DT-21.6): same token already bound to
        // another active key → 409, no write.
        if (err instanceof Erc8004TokenAlreadyBoundError) {
          return reply
            .status(409)
            .send({ error_code: 'ERC8004_TOKEN_ALREADY_BOUND' });
        }
        fastify.log.error(
          {
            errorClass: err instanceof Error ? err.constructor.name : 'unknown',
          },
          'erc8004 bind failed',
        );
        return reply.status(500).send({ error_code: 'ERC8004_BIND_FAILED' });
      }

      // 9. Success.
      return reply.status(200).send({ erc8004_identity: binding });
    },
  );

  /**
   * GET /erc8004/resolve/:token_id — Public, read-only tokenURI resolution
   * (WKH-100: AC-2/AC-11). No auth (on-chain read, consistent with
   * GET /deposit-info). NEVER fetches the tokenURI server-side (CD-13, anti-SSRF).
   */
  fastify.get(
    '/erc8004/resolve/:token_id',
    async (
      req: FastifyRequest<{ Params: { token_id: string } }>,
      reply: FastifyReply,
    ) => {
      const tokenId = parseTokenId(req.params.token_id);
      if (tokenId === null) {
        return reply.status(400).send({ error_code: 'INVALID_INPUT' });
      }

      const r = await getErc8004Reader().resolve({ tokenId });
      if (!r.ok) {
        switch (r.reason) {
          case 'RPC_UNAVAILABLE':
            return reply
              .status(503)
              .send({ ok: false, reason: 'RPC_UNAVAILABLE' });
          case 'REGISTRY_NOT_CONFIGURED':
            return reply
              .status(503)
              .send({ ok: false, reason: 'REGISTRY_NOT_CONFIGURED' });
          case 'TOKEN_NOT_FOUND':
            return reply
              .status(404)
              .send({ error_code: 'ERC8004_TOKEN_NOT_FOUND' });
          case 'CHAIN_MISMATCH':
            return reply
              .status(502)
              .send({ error_code: 'ERC8004_CHAIN_MISMATCH' });
          default:
            return reply
              .status(503)
              .send({ ok: false, reason: 'RPC_UNAVAILABLE' });
        }
      }

      const tokenUri = r.tokenUri ?? '';
      // Scheme handling WITHOUT fetch (CD-13/DT-16).
      if (/^https?:\/\//i.test(tokenUri)) {
        return reply.status(200).send({
          token_id: tokenId.toString(),
          chain_id: r.chainId,
          agent_card_url: tokenUri,
          url: tokenUri,
          raw: null,
        });
      }
      const scheme = tokenUri.includes(':')
        ? tokenUri.slice(0, tokenUri.indexOf(':'))
        : '';
      return reply.status(200).send({
        token_id: tokenId.toString(),
        chain_id: r.chainId,
        agent_card_url: tokenUri,
        scheme,
      });
    },
  );
};
