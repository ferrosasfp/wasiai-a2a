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
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { getGaslessAdapter } from '../adapters/registry.js';
import { getGaslessDefaultCapUsd, pyusdWeiToUsd } from '../lib/price.js';
import { requirePaymentOrA2AKey } from '../middleware/a2a-key.js';

/**
 * preHandler Stage A (WKH-59): valida shape, parsea wei → bigint, computa
 * estimatedCostUsd y aplica el cap global. Inyecta el resultado en
 * `request.gaslessEstimatedCostUsd` para que requirePaymentOrA2AKey
 * (Stage B) lo use en el debit en lugar del placeholder $1.
 *
 * AC-2: bloquea con 403 PER_CALL_LIMIT si el monto excede el cap.
 * AC-6: bloquea con 400 si el body no tiene shape válido o `value` no
 *       es un bigint string.
 */
async function gaslessCostEstimatorPreHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = request.body as { to?: string; value?: string } | undefined;

  // AC-6: shape validation antes de tocar bigint.
  if (!body || typeof body.to !== 'string' || typeof body.value !== 'string') {
    reply.status(400).send({ error: 'missing required fields: to, value' });
    return;
  }

  // AC-6: parse wei → bigint (BigInt() throws SyntaxError sobre input inválido).
  let valueWei: bigint;
  try {
    valueWei = BigInt(body.value);
  } catch {
    reply
      .status(400)
      .send({ error: 'invalid value: must be a bigint string' });
    return;
  }

  // CD-10: pyusdWeiToUsd retorna Infinity sobre overflow, NO throws.
  const estimatedCostUsd = pyusdWeiToUsd(valueWei);
  const cap = getGaslessDefaultCapUsd();

  // AC-2: cap check (Infinity > cap siempre).
  if (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd > cap) {
    reply.status(403).send({
      error: 'Transfer exceeds gasless cap',
      error_code: 'PER_CALL_LIMIT',
      cap_usd: cap,
      requested_usd: Number.isFinite(estimatedCostUsd)
        ? estimatedCostUsd
        : null,
    });
    return;
  }

  // DT-C/DT-D: inyectar para Stage B (requirePaymentOrA2AKey).
  request.gaslessEstimatedCostUsd = estimatedCostUsd;
}

const gaslessRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/status',
    { config: { rateLimit: false } },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      try {
        const status = await getGaslessAdapter().status();
        return reply.send(status);
      } catch (err) {
        fastify.log.error(
          {
            errorClass: err instanceof Error ? err.constructor.name : 'unknown',
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
      const status = await getGaslessAdapter().status();
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
        const result = await getGaslessAdapter().transfer({
          to: body.to as `0x${string}`,
          value: BigInt(body.value),
        });

        // AC-7: structured success log para auditoría post-mortem.
        req.log.info(
          {
            keyId: req.a2aKeyRow?.id ?? null,
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
          },
          'gasless transfer failed',
        );
        return reply.status(500).send({ error: 'gasless transfer failed' });
      }
    },
  );
};

export default gaslessRoutes;
