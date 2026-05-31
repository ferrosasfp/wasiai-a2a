/**
 * Auth Routes — A2A Agent Key endpoints
 * WKH-34: Agentic Economy Primitives L3
 *
 * POST /agent-signup  — Create new agent key (AC-13)
 * POST /deposit       — Register deposit (AC-14)
 * GET  /me            — Get key status (AC-15)
 * POST /bind/:chain   — Placeholder for on-chain binding (AC-16)
 */

import crypto from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { recoverMessageAddress } from 'viem';
import { getBaseNetwork } from '../adapters/base/chain.js';
import {
  normalizeChainSlug,
  resolveChainKey,
} from '../adapters/chain-resolver.js';
import {
  resolveChainFamilyEnvSuffix,
  resolveMinConfirmations,
  resolveTreasury,
  verifyDeposit,
} from '../adapters/deposit-verifier.js';
import { getErc8004Reader } from '../adapters/erc8004-identity.js';
import {
  getAdaptersBundle,
  getInitializedChainKeys,
} from '../adapters/registry.js';
import { authSignupRateLimit } from '../middleware/rate-limit.js';
import { budgetService } from '../services/budget.js';
import { identityService, isIdentityVerified } from '../services/identity.js';
import {
  DepositAlreadyCreditedError,
  Erc8004TokenAlreadyBoundError,
  FundingWalletAlreadyBoundError,
  OwnershipMismatchError,
} from '../services/security/errors.js';
import type {
  A2AAgentKeyRow,
  CreateKeyInput,
  DepositInput,
  Erc8004IdentityBinding,
} from '../types/index.js';

// ── Funding-wallet binding (WKH-35 FIX-1) ───────────────────

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Canonical message a caller must sign to prove control of a funding wallet.
 * FIXED prefix + the caller's authenticated `key_id` (NEVER from the body) so
 * the proof is bound to a specific key and cannot be replayed across keys.
 */
function fundingWalletBindMessage(keyId: string): string {
  return `WASIAI_BIND_FUNDING_WALLET:${keyId}`;
}

// ── ERC-8004 identity binding input validation (WKH-100, DT-14) ──────────────

const TOKEN_ID_RE = /^[0-9]+$/;
const UINT256_MAX = (1n << 256n) - 1n;

/**
 * Parse + validate a token_id into a `bigint` without precision loss (CD-11).
 * Accepts a decimal string or a non-negative integer number; rejects empty,
 * non-numeric, negative or `> 2^256-1`. Returns `null` on any rejection.
 * NEVER uses `Number()` on the token_id (CD-11).
 */
function parseTokenId(raw: unknown): bigint | null {
  let s: string;
  if (typeof raw === 'string') s = raw.trim();
  else if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0)
    s = String(raw);
  else return null;
  if (s === '' || !TOKEN_ID_RE.test(s)) return null;
  let v: bigint;
  try {
    v = BigInt(s);
  } catch {
    return null;
  }
  if (v < 0n || v > UINT256_MAX) return null;
  return v;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;

// ── Helper: resolve caller key from x-a2a-key header ────────

async function resolveCallerKey(
  request: FastifyRequest,
): Promise<A2AAgentKeyRow | null> {
  // DT-2 (WKH-BEARER-FIX): Priority order: x-a2a-key > Bearer wasi_a2a_* > null
  let rawKey: string | undefined;

  const headerValue = request.headers['x-a2a-key'];
  if (headerValue && typeof headerValue === 'string') {
    rawKey = headerValue;
  } else {
    // DT-1/DT-3: case-insensitive scheme, case-sensitive prefix (same as a2a-key.ts:86-93)
    const authHeader = request.headers.authorization;
    if (authHeader && typeof authHeader === 'string') {
      const match = /^bearer\s+(.+)$/i.exec(authHeader);
      if (match?.[1].startsWith('wasi_a2a_')) {
        rawKey = match[1];
      }
    }
  }

  if (!rawKey) return null;

  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const callerKey = await identityService.lookupByHash(keyHash);
  if (callerKey) {
    // WKH-100 (AC-6/DT-17): derived transient flag, no RPC.
    callerKey.erc8004_verified = isIdentityVerified(callerKey);
  }
  return callerKey;
}

// ── Routes ──────────────────────────────────────────────────

const authRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /agent-signup — Create a new agent key (AC-13)
   */
  fastify.post(
    '/agent-signup',
    { config: { rateLimit: authSignupRateLimit() } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body as Partial<CreateKeyInput> | undefined;

      if (
        !body?.owner_ref ||
        typeof body.owner_ref !== 'string' ||
        body.owner_ref.trim() === ''
      ) {
        return reply.status(400).send({
          error: 'owner_ref is required and must be a non-empty string',
        });
      }

      try {
        const result = await identityService.createKey({
          owner_ref: body.owner_ref,
          display_name: body.display_name,
          daily_limit_usd: body.daily_limit_usd,
          allowed_registries: body.allowed_registries,
          allowed_agent_slugs: body.allowed_agent_slugs,
          allowed_categories: body.allowed_categories,
          max_spend_per_call_usd: body.max_spend_per_call_usd,
        });

        return reply.status(201).send(result);
      } catch (err) {
        fastify.log.error(
          {
            errorClass: err instanceof Error ? err.constructor.name : 'unknown',
          },
          'agent-signup failed',
        );
        return reply.status(500).send({ error: 'Failed to create agent key' });
      }
    },
  );

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
   * POST /deposit — Register a real, on-chain-verified deposit (AC-14, WKH-35).
   *
   * Verifies a confirmed ERC-20 deposit on-chain (verify-before-credit, CD-4)
   * and only then credits budget[chainId] atomically (anti-replay + ownership,
   * CD-1/CD-2). The credited chainId comes from the bundle, never the caller (CD-5).
   */
  fastify.post('/deposit', async (req: FastifyRequest, reply: FastifyReply) => {
    // 1. Auth — mismo helper que /me.
    const callerKey = await resolveCallerKey(req);
    if (!callerKey?.is_active) {
      return reply.status(403).send({ error: 'Invalid or inactive API key' });
    }
    const ownerRef = callerKey.owner_ref;

    // 2. Validar input (DepositInput).
    const body = req.body as Partial<DepositInput> | undefined;
    const txHash = body?.tx_hash;
    const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
    if (
      !body ||
      typeof body.key_id !== 'string' ||
      body.key_id.trim() === '' ||
      typeof txHash !== 'string' ||
      !TX_HASH_RE.test(txHash) ||
      typeof body.chain_id !== 'number' ||
      !Number.isFinite(body.chain_id)
    ) {
      return reply.status(400).send({ error_code: 'INVALID_INPUT' });
    }

    // 2b. Ownership pre-check (defense-in-depth, CD-1): un caller solo fondea SU key.
    if (body.key_id !== callerKey.id) {
      return reply.status(403).send({ error_code: 'OWNERSHIP_MISMATCH' });
    }

    // 3. Resolver chain + bundle (DT-5 / AC-6 / CD-5).
    const headerChain = req.headers['x-payment-chain'];
    const chainKey =
      typeof headerChain === 'string'
        ? resolveChainKey({ headerOverride: headerChain })
        : normalizeChainSlug(String(body.chain_id));
    if (!chainKey) {
      return reply.status(400).send({ error_code: 'CHAIN_NOT_SUPPORTED' });
    }
    const bundle = getAdaptersBundle(chainKey);
    if (!bundle) {
      return reply.status(400).send({ error_code: 'CHAIN_NOT_SUPPORTED' });
    }
    const chainId = bundle.chainConfig.chainId; // CD-5

    // 4. chain_id match (AC-4).
    if (body.chain_id !== chainId) {
      return reply.status(400).send({ error_code: 'CHAIN_MISMATCH' });
    }

    // 5. Verificar on-chain ANTES de acreditar (AC-1 / CD-4).
    const result = await verifyDeposit({
      chainKey,
      bundle,
      txHash: txHash as `0x${string}`,
      expectedAmountUsd: body.amount,
    });
    if (
      !result.ok ||
      result.amountUsd === undefined ||
      result.from === undefined
    ) {
      const status = result.reason === 'RPC_UNAVAILABLE' ? 503 : 400;
      return reply
        .status(status)
        .send({ error_code: result.reason ?? 'VERIFICATION_FAILED' });
    }

    // 5b. Funding-wallet gate (FIX-1, BLQ-MED-1). El treasury es compartido, así
    // que validar solo `Transfer.to` permite que un atacante front-run del
    // txHash reclame el depósito ajeno. Exigimos que el depositante
    // (Transfer.from) sea la funding wallet previamente bindeada a la key.
    if (!callerKey.funding_wallet) {
      return reply.status(403).send({ error_code: 'FUNDING_WALLET_NOT_BOUND' });
    }
    if (result.from.toLowerCase() !== callerKey.funding_wallet.toLowerCase()) {
      return reply.status(403).send({ error_code: 'FUNDING_WALLET_MISMATCH' });
    }

    // 6. Acreditar atómico (AC-3 / AC-5). NUNCA antes del verify (CD-4).
    try {
      const balance = await budgetService.registerDeposit(
        callerKey.id,
        chainId,
        result.amountUsd,
        ownerRef,
        txHash,
        result.tokenSymbol,
      );
      // 7. Respuesta (DepositResponse).
      return reply.status(200).send({ balance, chain_id: chainId });
    } catch (err) {
      if (err instanceof DepositAlreadyCreditedError) {
        return reply
          .status(409)
          .send({ error_code: 'DEPOSIT_ALREADY_CREDITED' });
      }
      if (err instanceof OwnershipMismatchError) {
        return reply.status(403).send({ error_code: 'OWNERSHIP_MISMATCH' });
      }
      fastify.log.error(
        { errorClass: err instanceof Error ? err.constructor.name : 'unknown' },
        'deposit failed',
      );
      return reply.status(500).send({ error_code: 'DEPOSIT_FAILED' });
    }
  });

  /**
   * GET /me — Get key status (AC-15)
   */
  fastify.get('/me', async (req: FastifyRequest, reply: FastifyReply) => {
    const callerKey = await resolveCallerKey(req);
    if (!callerKey?.is_active) {
      return reply.status(403).send({ error: 'Invalid or inactive API key' });
    }

    return reply.status(200).send({
      key_id: callerKey.id,
      display_name: callerKey.display_name,
      budget: callerKey.budget,
      daily_limit_usd: callerKey.daily_limit_usd,
      daily_spent_usd: callerKey.daily_spent_usd,
      daily_reset_at: callerKey.daily_reset_at,
      scoping: {
        allowed_registries: callerKey.allowed_registries,
        allowed_agent_slugs: callerKey.allowed_agent_slugs,
        allowed_categories: callerKey.allowed_categories,
        max_spend_per_call_usd: callerKey.max_spend_per_call_usd,
      },
      is_active: callerKey.is_active,
      bindings: {
        erc8004_identity: callerKey.erc8004_identity,
        kite_passport: callerKey.kite_passport,
        agentkit_wallet: callerKey.agentkit_wallet,
      },
      created_at: callerKey.created_at,
    });
  });

  /**
   * GET /deposit-info — Public, read-only deposit configuration (WKH-DEPOSIT-INFO).
   *
   * Returns one entry per initialized chain with the data a dev needs to fund
   * an Agent Key: treasury address, ERC-20 token (symbol/address/decimals) and
   * minimum confirmations. No auth, no DB, no RPC — purely env + registry data.
   *
   * CD-1: treasury/min_confirmations come from `deposit-verifier.ts` helpers
   * (single source of truth, no duplication).
   * CD-2/AC-5: NEVER serialize `OPERATOR_PRIVATE_KEY` or any secret. `treasury`
   * is only the resolved address (or `null`), never the private key.
   */
  fastify.get(
    '/deposit-info',
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const networks = getInitializedChainKeys()
        .map((chainKey) => {
          const bundle = getAdaptersBundle(chainKey);
          if (!bundle) return null;
          const token = bundle.payment.supportedTokens[0];
          if (!token) return null; // CD-3: tolerate empty supportedTokens
          return {
            chain_id: bundle.chainConfig.chainId,
            slug: chainKey,
            family: resolveChainFamilyEnvSuffix(chainKey),
            treasury: resolveTreasury(chainKey), // address | null (AC-4)
            token: {
              symbol: token.symbol,
              address: token.address,
              decimals: token.decimals,
            },
            min_confirmations: resolveMinConfirmations(chainKey),
          };
        })
        .filter((entry) => entry !== null);

      return reply.status(200).send({ networks });
    },
  );

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
        | { token_id?: unknown; agent_slug?: unknown }
        | undefined;
      const tokenId = parseTokenId(body?.token_id);
      if (tokenId === null) {
        return reply.status(400).send({ error_code: 'INVALID_INPUT' });
      }

      // 2b. agent_slug OPCIONAL (DT-20).
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
        ...(agentSlug && { agent_slug: agentSlug }), // AC-8 opt-in (DT-20)
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

  /**
   * POST /bind/:chain — Placeholder (AC-16)
   */
  fastify.post(
    '/bind/:chain',
    async (_req: FastifyRequest, reply: FastifyReply) => {
      return reply.status(501).send({
        status: 'not_implemented',
        message:
          'On-chain identity binding is planned for Fase 2. See doc/architecture/CHAIN-ADAPTIVE.md',
      });
    },
  );
};

export default authRoutes;
