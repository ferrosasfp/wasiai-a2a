/**
 * Auth Routes — deposit registration + public deposit configuration.
 *
 * Pure reorganization of `src/routes/auth.ts` (refactor B2, 2026-06-24).
 * POST /deposit       — Register a real, on-chain-verified deposit (WKH-35).
 * GET  /deposit-info  — Public, read-only deposit configuration.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { keccak256, stringToBytes } from 'viem';
import {
  normalizeChainSlug,
  resolveChainKey,
} from '../../adapters/chain-resolver.js';
import {
  resolveChainFamilyEnvSuffix,
  resolveMinConfirmations,
  resolveTreasury,
  verifyDeposit,
} from '../../adapters/deposit-verifier.js';
import {
  resolveEscrowContract,
  verifyEscrowDeposit,
} from '../../adapters/escrow-verifier.js';
import {
  getAdaptersBundle,
  getInitializedChainKeys,
} from '../../adapters/registry.js';
import { budgetService } from '../../services/budget.js';
import { receiptService } from '../../services/receipt.js';
import {
  DepositAlreadyCreditedError,
  OwnershipMismatchError,
} from '../../services/security/errors.js';
import type { DepositInput } from '../../types/index.js';
import { escrowEnabledForChain, resolveCallerKey } from './parsers.js';

export const depositRoutes: FastifyPluginAsync = async (fastify) => {
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

    // 5. Verificar on-chain ANTES de acreditar (AC-1 / CD-4). Selector escrow vs
    // treasury (DT-10): con ESCROW_MODE_ENABLED='true' (estricto, CD-11) se usa
    // el verifier no-custodial; default = treasury intacto (AC-8).
    const result = escrowEnabledForChain(chainKey)
      ? await verifyEscrowDeposit({
          chainKey,
          bundle,
          txHash: txHash as `0x${string}`,
          keyIdHash: keccak256(stringToBytes(callerKey.id)), // §3, VERIFY-AT-IMPL con 126a
          expectedAmountUsd: body.amount,
        })
      : await verifyDeposit({
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
      // CD-10: RPC_UNAVAILABLE o ESCROW_CONTRACT_NOT_CONFIGURED → 503; resto → 400.
      const reason = result.reason;
      const status =
        reason === 'RPC_UNAVAILABLE' ||
        reason === 'ESCROW_CONTRACT_NOT_CONFIGURED'
          ? 503
          : 400;
      return reply
        .status(status)
        .send({ error_code: reason ?? 'VERIFICATION_FAILED' });
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
      // 6b. Recibo deposit_verified (AC-11) — best-effort, NUNCA bloquea ni
      // propaga (DT-11). Aplica a AMBOS caminos (no cambia shape ni status →
      // cero regresión AC-8). `emit` es NUNCA-throw, por eso `void` sin await.
      void receiptService.emit({
        ownerRef,
        agentKeyId: callerKey.id,
        sessionId: null,
        delegationId: null,
        receiptType: 'deposit_verified',
        amountUsd: result.amountUsd,
        chainId,
        txHash,
        counterparty: null,
        orchestrationId: null,
      });
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
          // Escrow no-custodial: cuando está activo para esta cadena, el caller
          // deposita al CONTRATO (no a la treasury). Exponemos la dirección
          // (pública, nunca un secreto) para que el front sepa a dónde fondear.
          const escrowActive = escrowEnabledForChain(chainKey);
          return {
            chain_id: bundle.chainConfig.chainId,
            slug: chainKey,
            family: resolveChainFamilyEnvSuffix(chainKey),
            treasury: resolveTreasury(chainKey), // address | null (AC-4)
            escrow_mode: escrowActive,
            escrow_contract: escrowActive
              ? resolveEscrowContract(chainKey)
              : null,
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
};
