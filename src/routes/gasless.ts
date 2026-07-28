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
 *         transfer on-chain.
 *
 * HU-192 (refund-on-failure): el "fee-on-attempt" que documentaba DT-F para el
 *         fallo POST-debit era un cobro sin contraprestación — el caller pagaba
 *         el valor completo del transfer y no recibía NINGÚN transfer. Ahora los
 *         caminos de fallo del handler reembolsan el débito step-0 (mismo
 *         mecanismo que `/compose`: `budgetService.credit*` + `refundOutbox`),
 *         con UNA excepción explícita: cuando la tx ya se broadcasteó y su
 *         suerte es desconocida (`GaslessValueDisposition = 'unknown'`) NO se
 *         reembolsa, porque el destinatario puede haber recibido los tokens
 *         (reembolsar ahí inflaría el budget). Ese caso queda con log loud para
 *         reconciliación.
 *
 *         Por qué el refund vive en el HANDLER y no en el hook `onDebitOrphaned`
 *         del middleware: esta ruta NO monta `createTimeoutHandler` (ver la
 *         cadena de preHandlers de POST /transfer) y la instancia de Fastify no
 *         configura `requestTimeout`/`connectionTimeout` (src/index.ts), así que
 *         NO existe la ventana "la reply salió antes de que el handler corriera"
 *         que motivó ese hook en `/compose`. Pasarlo acá sería código con cero
 *         hits (la falsa protección que el AR de la HU 188 ya cazó una vez).
 *         Si algún día se le agrega un timeout a esta ruta, HAY que pasar
 *         `onDebitOrphaned: (req) => refundGaslessDebit(req, 'debit-orphaned')`.
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
  type GaslessValueDisposition,
  readGaslessValueDisposition,
} from '../adapters/errors.js';
import {
  getAdaptersBundle,
  getDefaultChainKey,
  getGaslessAdapter,
  getInitializedChainKeys,
} from '../adapters/registry.js';
import type { ChainKey, GaslessAdapterStatus } from '../adapters/types.js';
import {
  estimateGaslessValueUsd,
  getGaslessDefaultCapUsd,
} from '../lib/price.js';
import { refundIdemKey, requestRefundIdemBase } from '../lib/refund-idem.js';
import { requirePaymentOrA2AKey } from '../middleware/a2a-key.js';
import { budgetService } from '../services/budget.js';
import { refundOutbox } from '../services/refund-outbox.js';

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

/** Motivo del refund — sólo para logs/outbox (auditoría post-mortem). */
type GaslessRefundReason =
  | 'not-operational' // 503: funding_state !== 'ready', el adapter no se llamó
  | 'status-failed' // status() tiró: no se intentó ningún transfer
  | 'transfer-failed'; // transfer() tiró con el valor probadamente quieto

/**
 * HU-192: credit-back del débito step-0 de `/gasless/transfer`.
 *
 * ESPEJO de `routes/compose.ts:refundComposeStep0` (misma matemática, mismas 4
 * variantes de credit, mismo encolado en `refundOutbox`), con dos diferencias
 * propias de esta ruta:
 *
 *   1. El monto debitado se lee de `request.gaslessEstimatedCostUsd` (el precio
 *      real del transfer que inyecta `gaslessCostEstimatorPreHandler`), no de
 *      `composeEstimatedCostUsd`.
 *   2. NO hay `alreadySpentUsd` que descontar: el gasless es todo-o-nada (un
 *      único transfer on-chain). El caller sólo llega acá cuando ese transfer no
 *      movió valor, así que se devuelve el débito completo. Los casos donde el
 *      valor SÍ pudo moverse se filtran ANTES (`valueDisposition === 'unknown'`)
 *      y no llaman a esta función.
 *   3. No hay `destination`: el débito del gasless nunca pasa por dest-policy
 *      (`request.composeDestination` sólo lo setea `/compose`), así que el
 *      refund usa las variantes SIN destino — simétrico al débito
 *      (`a2a-key.ts:1196`, llamada de 3 args + owner_ref).
 *
 * NO PUEDE REEMBOLSAR DE MÁS (invariantes):
 *   - Se llama SÓLO desde el route handler. Llegar al handler con `a2aKeyRow`
 *     seteado implica que el débito del middleware terminó OK: cualquier fallo
 *     de débito corta con 402/403 y el handler nunca corre.
 *   - `skipMiddlewareDebit` ⟹ el middleware no debitó ⟹ return temprano (hoy
 *     ninguna ruta gasless lo setea; es defensa por si se agrega).
 *   - Sin `a2aKeyRow` (caller x402 puro) no hubo débito de budget ⟹ no-op.
 *   - Cada camino de fallo del handler hace `return` inmediato después de
 *     llamarla, así que corre a lo sumo UNA vez por request.
 *
 * Ownership guard (CLAUDE.md): las 4 variantes reciben el `owner_ref` del caller
 * autenticado; bajo delegación/sesión se usa el refund DUAL-LEDGER simétrico al
 * débito (`debit_delegation_and_parent` / `debit_session_and_parent`), nunca
 * sólo el parent.
 *
 * Best-effort: NUNCA lanza ni cambia el status de la respuesta. Si el credit no
 * revierte nada, queda señal (log + `refundOutbox` para reintento del sweep).
 */
async function refundGaslessDebit(
  request: FastifyRequest,
  reason: GaslessRefundReason,
): Promise<void> {
  const debitedUsd = request.gaslessEstimatedCostUsd;
  const refundChainId = request.resolvedChainId;
  if (
    request.skipMiddlewareDebit ||
    !request.a2aKeyRow ||
    typeof debitedUsd !== 'number' ||
    debitedUsd <= 0 ||
    refundChainId === undefined
  ) {
    return;
  }

  // HU-194: clave del refund LÓGICO. Un solo refund de gasless por request (cada
  // camino de fallo hace `return` inmediato) ⟹ un solo slot. La MISMA clave va al
  // credit y a los DOS enqueue de abajo, así el sweep no puede acreditar de nuevo
  // un crédito que ya commiteó con la respuesta perdida.
  const idem = {
    idemKey: refundIdemKey({
      keyId: request.a2aKeyRow.id,
      chainId: refundChainId,
      operationId: requestRefundIdemBase(request),
      slot: 'gasless',
    }),
  };

  try {
    const creditRes = request.delegationContext
      ? await budgetService.creditDelegation(
          request.delegationContext.delegationId,
          request.delegationContext.ownerRef,
          request.delegationContext.keyId,
          refundChainId,
          debitedUsd,
          idem,
        )
      : request.keySessionContext
        ? await budgetService.creditSession(
            request.keySessionContext.sessionId,
            request.keySessionContext.ownerRef,
            request.keySessionContext.keyId,
            refundChainId,
            debitedUsd,
            idem,
          )
        : await budgetService.credit(
            request.a2aKeyRow.id,
            refundChainId,
            debitedUsd,
            request.a2aKeyRow.owner_ref,
            idem,
          );
    if (!creditRes.success) {
      // Sin msg crudo de PG. No cambia el status code.
      request.log.error(
        {
          keyId: request.a2aKeyRow.id,
          chainId: refundChainId,
          amountUsd: debitedUsd,
          reason,
        },
        '[gasless.refund-failed]',
      );
      // success:false ⟹ nada se aplicó ⟹ encolar para reintento confiable
      // (invariante anti-doble-refund: sólo se encola cuando NO revirtió nada).
      await refundOutbox.enqueueRefund({
        keyId: request.a2aKeyRow.id,
        chainId: refundChainId,
        amountUsd: debitedUsd,
        ownerRef: request.a2aKeyRow.owner_ref,
        destination: null,
        reason: `gasless-route.refund-failed:${reason}`,
        idemKey: idem.idemKey,
      });
      return;
    }
    request.log.info(
      {
        keyId: request.a2aKeyRow.id,
        chainId: refundChainId,
        amountUsd: debitedUsd,
        reason,
      },
      'gasless.refunded',
    );
  } catch (e) {
    // Best-effort: el fallo del refund NUNCA rompe el response.
    request.log.error(
      { detail: e instanceof Error ? e.message : String(e), reason },
      '[gasless.refund-threw]',
    );
    await refundOutbox
      .enqueueRefund({
        keyId: request.a2aKeyRow.id,
        chainId: refundChainId,
        amountUsd: debitedUsd,
        ownerRef: request.a2aKeyRow.owner_ref,
        destination: null,
        reason: `gasless-route.refund-threw:${reason}`,
        // HU-194: MISMA clave que el credit que tiró y que el `refund-failed`.
        // El `catch` no puede saber si la RPC commiteó antes de perderse la
        // respuesta; la clave hace que eso deje de importar.
        idemKey: idem.idemKey,
      })
      .catch((outboxErr) =>
        request.log.error(
          {
            detail: outboxErr instanceof Error ? outboxErr.message : 'unknown',
          },
          '[gasless.refund-outbox-threw]',
        ),
      );
  }
}

/**
 * HU-192: ¿el valor del transfer quedó probadamente quieto?
 *
 * `GaslessTransferError` lo trae explícito (los adapters lo setean en cada throw
 * site). `GaslessNotSupportedError` es el stub que tira ANTES de tocar la red.
 * Cualquier otro error es NO clasificado ⟹ `'unknown'` (fail-safe: preferimos
 * no reembolsar antes que inflar el budget del caller).
 *
 * HU-198: la lectura de la disposición se delega a `readGaslessValueDisposition`,
 * que valida por FORMA además de por `instanceof`. Motivo: `instanceof` compara
 * identidad de clase y esa identidad es por-registro-de-módulos, así que se caía
 * silenciosamente en cualquier consumidor con el grafo de módulos duplicado. Acá el
 * fallo NO era un reembolso indebido sino un reembolso OMITIDO (el default es
 * `'unknown'` = no reembolsar), o sea plata que le quedábamos debiendo al caller
 * por un transfer que probadamente no se movió. El `?? 'unknown'` conserva EXACTO
 * el fail-safe de HU-192 para el error no clasificado.
 */
function classifyGaslessFailure(err: unknown): GaslessValueDisposition {
  return readGaslessValueDisposition(err) ?? 'unknown';
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
      // HU-192: este `status()` corría FUERA de todo try. Si tiraba (RPC caído),
      // el error boundary devolvía 500 con el débito ya aplicado y sin haber
      // intentado NINGÚN transfer — el mismo cobro-sin-contraprestación que los
      // dos caminos de abajo, pero silencioso. Se reembolsa y se re-lanza para
      // NO cambiar la respuesta que ve el caller (sigue siendo el 500 del error
      // boundary).
      let status: GaslessAdapterStatus;
      try {
        status = await getGaslessAdapter(chainKey).status();
      } catch (err) {
        await refundGaslessDebit(req, 'status-failed');
        throw err;
      }
      if (status.funding_state !== 'ready') {
        // HU-192: el adapter NO se llamó ⟹ cero ambigüedad, se devuelve todo.
        await refundGaslessDebit(req, 'not-operational');
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
        // HU-192: el débito step-0 ya está aplicado. Se reembolsa SÓLO si el
        // valor quedó probadamente quieto (pre-flight, firma, gas del operador,
        // revert confirmado). Si la tx ya salió a la red y no sabemos si
        // aterrizó, reembolsar podría regalar el transfer Y el budget: se deja
        // el cobro y un log loud para reconciliar contra la cadena.
        const disposition = classifyGaslessFailure(err);
        fastify.log.error(
          {
            errorClass: err instanceof Error ? err.constructor.name : 'unknown',
            chainKey,
            valueDisposition: disposition,
          },
          'gasless transfer failed',
        );
        if (disposition === 'not-moved') {
          await refundGaslessDebit(req, 'transfer-failed');
        } else {
          req.log.error(
            {
              keyId: req.a2aKeyRow?.id ?? null,
              chainId: req.resolvedChainId ?? null,
              chainKey,
              amountUsd: req.gaslessEstimatedCostUsd ?? null,
              errorClass:
                err instanceof Error ? err.constructor.name : 'unknown',
              detail: err instanceof Error ? err.message : 'unknown',
            },
            'gasless.refund-skipped.settlement-unknown',
          );
        }
        return reply.status(500).send({ error: 'gasless transfer failed' });
      }
    },
  );
};

export default gaslessRoutes;
