/**
 * Gasless Routes (WKH-29 + WKH-38) -- chain-adaptive gasless transfers.
 * WKH-54: POST /transfer now requires authentication (was publicly callable,
 *         a drain vector while the gasless module is funded).
 * WKH-59: cost estimation preHandler — calcula USD del transfer ANTES del
 *         debit del A2A key. Antes el middleware debitaba placeholder $1
 *         ignorando el valor real on-chain → cualquier holder de un key con
 *         $1 de budget podía drain el operator wallet.
 *
 *         DT-F (idempotencia post-tx): si el debit del key falla, el código
 *         retorna 403 ANTES de llamar al gasless adapter, así que NO hay
 *         transfer on-chain. Si el adapter falla DESPUÉS del debit, el debit
 *         queda — comportamiento "fee-on-attempt" deliberado, igual que el
 *         resto del middleware (Stripe-style: charge first, deliver after).
 *
 * WKH-138 (gasless multichain): la chain se resuelve UNA vez en el preHandler A
 *         vía el header `x-payment-chain` (mirror EXACTO de x402.ts:198-234) y
 *         se persiste en `request.gaslessChainKey`. El cost estimator, el gate
 *         `funding_state` y el handler usan ESA chainKey (anti-TOCTOU, CD-3).
 *         El estimador es chain-aware: Kite → PYUSD, Avalanche/Base → USDC
 *         6-dec (CD-1). Sin header, el flujo Kite (default) es byte-idéntico
 *         (CD-4).
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { resolveChainKey } from '../adapters/chain-resolver.js';
import {
  getAdaptersBundle,
  getDefaultChainKey,
  getGaslessAdapter,
  getInitializedChainKeys,
} from '../adapters/registry.js';
import type { ChainKey } from '../adapters/types.js';
import {
  estimateGaslessValueUsd,
  getGaslessDefaultCapUsd,
} from '../lib/price.js';
import { requirePaymentOrA2AKey } from '../middleware/a2a-key.js';

/**
 * Resuelve la chain destino a partir SOLO del header `x-payment-chain`
 * (mirror EXACTO de x402.ts:198-234). NUNCA lee `request.body` (CD-3).
 *
 * Devuelve la `ChainKey` resuelta, o `undefined` tras haber enviado la reply de
 * error (400 CHAIN_NOT_SUPPORTED / 500 REGISTRY_NOT_INITIALIZED). El caller
 * DEBE cortar el lifecycle (`return`) si recibe `undefined`.
 */
function resolveGaslessChainKey(
  request: FastifyRequest,
  reply: FastifyReply,
): ChainKey | undefined {
  const headerRaw = request.headers['x-payment-chain'];
  const headerOverride = typeof headerRaw === 'string' ? headerRaw : undefined;

  let chainKey = resolveChainKey({ headerOverride });
  if (!chainKey) {
    if (headerOverride !== undefined) {
      // Header present but unrecognised → 400, never silent default.
      reply.status(400).send({
        error_code: 'CHAIN_NOT_SUPPORTED',
        error: `Chain '${headerOverride}' is not a recognized slug or chainId`,
      });
      return undefined;
    }
    // Header absent → fall back to registry default (hoy Kite).
    chainKey = getDefaultChainKey() ?? undefined;
    if (!chainKey) {
      reply.status(500).send({
        error_code: 'REGISTRY_NOT_INITIALIZED',
        error: 'No chains initialized in registry',
      });
      return undefined;
    }
  }

  if (!getAdaptersBundle(chainKey)) {
    // recognised slug but not present in the initialised registry.
    reply.status(400).send({
      error_code: 'CHAIN_NOT_SUPPORTED',
      error: `Chain '${chainKey}' is not initialized. Initialized: ${getInitializedChainKeys().join(', ')}`,
    });
    return undefined;
  }

  return chainKey;
}

/**
 * preHandler Stage A (WKH-59 + WKH-138): resuelve la chain (mirror x402),
 * valida shape, parsea wei → bigint, computa estimatedCostUsd chain-aware y
 * aplica el cap global. Persiste `request.gaslessChainKey` y
 * `request.gaslessEstimatedCostUsd` para Stage B (requirePaymentOrA2AKey) y el
 * handler.
 *
 * AC-2: bloquea con 403 PER_CALL_LIMIT si el monto excede el cap (o es !finite).
 * AC-6: bloquea con 400 si el body no tiene shape válido o `value` no es bigint.
 */
async function gaslessCostEstimatorPreHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // CD-3: resolver la chain UNA vez, SOLO desde el header, y persistir.
  const chainKey = resolveGaslessChainKey(request, reply);
  if (!chainKey) return; // reply ya enviada (400/500).
  request.gaslessChainKey = chainKey;

  const body = request.body as { to?: string; value?: string } | undefined;

  // AC-6: shape validation antes de tocar bigint.
  if (!body || typeof body.to !== 'string' || typeof body.value !== 'string') {
    return reply
      .status(400)
      .send({ error: 'missing required fields: to, value' });
  }

  // AC-6: parse wei → bigint (BigInt() throws SyntaxError sobre input inválido).
  let valueWei: bigint;
  try {
    valueWei = BigInt(body.value);
  } catch {
    return reply
      .status(400)
      .send({ error: 'invalid value: must be a bigint string' });
  }

  // CD-1: estimador chain-aware. Retorna +Infinity fail-closed (NO throws).
  const estimatedCostUsd = estimateGaslessValueUsd(chainKey, valueWei);
  const cap = getGaslessDefaultCapUsd();

  // AC-2: cap check (Infinity > cap siempre).
  if (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd > cap) {
    return reply.status(403).send({
      error: 'Transfer exceeds gasless cap',
      error_code: 'PER_CALL_LIMIT',
      cap_usd: cap,
      requested_usd: Number.isFinite(estimatedCostUsd)
        ? estimatedCostUsd
        : null,
    });
  }

  // DT-C/DT-D: inyectar para Stage B (requirePaymentOrA2AKey).
  request.gaslessEstimatedCostUsd = estimatedCostUsd;
}

const gaslessRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/status',
    { config: { rateLimit: false } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // WKH-138: chain-aware. Resuelve la chain SOLO desde el header.
      const chainKey = resolveGaslessChainKey(req, reply);
      if (!chainKey) return; // reply ya enviada (400/500).
      try {
        const status = await getGaslessAdapter(chainKey).status();
        return reply.send(status);
      } catch (err) {
        fastify.log.error(
          {
            errorClass: err instanceof Error ? err.constructor.name : 'unknown',
            chainKey,
          },
          'gasless status failed',
        );
        return reply.status(500).send({ error: 'gasless status failed' });
      }
    },
  );

  fastify.post(
    '/transfer',
    {
      preHandler: [
        gaslessCostEstimatorPreHandler,
        ...requirePaymentOrA2AKey({
          description:
            'WasiAI Gasless Transfer — on-chain transfer from operator wallet',
        }),
      ],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // CD-3: usar la chainKey resuelta+persistida en el preHandler A.
      const chainKey = req.gaslessChainKey;
      const status = await getGaslessAdapter(chainKey).status();
      if (status.funding_state !== 'ready') {
        return reply.status(503).send({
          error: 'gasless_not_operational',
          message: `Gasless module is not operational (funding_state: ${status.funding_state})`,
          documentation:
            'https://github.com/ferrosasfp/wasiai-a2a/blob/main/doc/architecture/CHAIN-ADAPTIVE.md',
        });
      }
      // body shape ya fue validado por gaslessCostEstimatorPreHandler.
      const body = req.body as { to: string; value: string };
      try {
        const result = await getGaslessAdapter(chainKey).transfer({
          to: body.to as `0x${string}`,
          value: BigInt(body.value),
        });

        // AC-7: structured success log para auditoría post-mortem.
        req.log.info(
          {
            keyId: req.a2aKeyRow?.id ?? null,
            chainKey: chainKey ?? null,
            estimatedCostUsd: req.gaslessEstimatedCostUsd ?? null,
            actualValueWei: body.value,
            to: body.to,
            txHash: result.txHash ?? null,
          },
          'gasless transfer executed',
        );

        return reply.send(result);
      } catch (err) {
        fastify.log.error(
          {
            errorClass: err instanceof Error ? err.constructor.name : 'unknown',
            chainKey,
          },
          'gasless transfer failed',
        );
        return reply.status(500).send({ error: 'gasless transfer failed' });
      }
    },
  );
};

export default gaslessRoutes;
