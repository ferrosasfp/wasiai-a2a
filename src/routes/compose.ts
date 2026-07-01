/**
 * Compose Routes — Multi-agent pipelines
 * WKH-18: Timeout preHandler, error boundary integration.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { resolveChainKey } from '../adapters/chain-resolver.js';
import { getAdaptersBundle, getDefaultChainKey } from '../adapters/registry.js';
import { getStepGasOverheadUsd } from '../lib/gas-overhead.js';
import { getLogger } from '../lib/logger.js';
import { PLACEHOLDER_FEE_USD } from '../lib/pricing-constants.js';
import { requirePaymentOrA2AKey } from '../middleware/a2a-key.js';
import { requireForwardKey } from '../middleware/forward-key.js';
import { orchestrateRateLimit } from '../middleware/rate-limit.js';
import { createTimeoutHandler } from '../middleware/timeout.js';
import {
  resolveAgentDestination,
  resolveAgentPriceUsdc,
} from '../services/agent-price.js';
import { budgetService } from '../services/budget.js';
import { composeService } from '../services/compose.js';
import {
  chargeProtocolFee,
  getProtocolFeeRate,
} from '../services/fee-charge.js';
import { receiptService } from '../services/receipt.js';
import { refundOutbox } from '../services/refund-outbox.js';
import { normalizeDestination } from '../services/spend-policy.js';
import type { ComposeStep } from '../types/index.js';

const log = getLogger('compose');

/**
 * WKH-125 BLQ-ALTO-1 (fix-pack): deriva el destino `"<registry>/<slug>"` del
 * step-0 a partir del AGENTE RESUELTO por discovery (`registry`/`slug`
 * canónicos), NO de los campos crudos del body. Así step-0 keyea idéntico al
 * per-step (`compose.ts:166` usa `normalizeDestination(${agent.registry}/${agent.slug})`)
 * y el cap por destino se evalúa aunque el caller omita `registry`. Normaliza
 * con el MISMO normalizador que la policy/ledger. Defensivo: si la normalización
 * fallara (destino vacío), devuelve undefined (no augmenta `composeDestination`
 * → step-0 sigue 3-arg, back-compat).
 */
function deriveComposeDestination(resolved: {
  registry: string;
  slug: string;
}): string | undefined {
  try {
    return normalizeDestination(`${resolved.registry}/${resolved.slug}`);
  } catch {
    return undefined;
  }
}

/**
 * G-03 (audit 2026-06-30): per-step gas overhead for the COMPOSE STEP-0.
 *
 * Steps 1..N already add the gateway's downstream-settle gas overhead in
 * `composeService` (compose.ts:155). Step-0 is debited by the a2a-key middleware
 * from `request.composeEstimatedCostUsd` — set HERE — and previously that figure
 * was the agent price WITHOUT the gas overhead, so the gateway under-recovered
 * its step-0 settle gas on mainnet. We resolve the SAME chainId the payment
 * middleware will resolve (header `x-payment-chain` > registry default) and add
 * the overhead to `composeEstimatedCostUsd`. Because the route refund
 * (compose.ts handler) reads the SAME `composeEstimatedCostUsd`, a refunded
 * step-0 returns price + gas (single source of truth preserved across all auth
 * paths). Testnet / unconfigured → 0 (identical to before).
 *
 * On mainnet WITHOUT a configured overhead in production, `getStepGasOverheadUsd`
 * throws `GasOverheadUnavailableError` (G-02 fail-closed); we let it propagate so
 * the price preHandler returns 503 (handled by the surrounding try/catch) rather
 * than silently settling step-0 with uncovered gas.
 */
async function resolveStep0GasOverheadUsd(
  request: FastifyRequest,
): Promise<number> {
  const headerRaw = request.headers['x-payment-chain'];
  const headerOverride = typeof headerRaw === 'string' ? headerRaw : undefined;
  const chainKey = resolveChainKey({ headerOverride }) ?? getDefaultChainKey();
  if (!chainKey) return 0;
  const bundle = getAdaptersBundle(chainKey);
  if (!bundle) return 0;
  return getStepGasOverheadUsd(bundle.chainConfig.chainId);
}

type ComposeBody = {
  steps: ComposeStep[];
  maxBudget?: number;
};

/**
 * WKH-59 (real-price-debit) preHandler: resuelve el precio real del primer
 * step ANTES del middleware de debit, e inyecta `request.composeEstimatedCostUsd`.
 *
 * Comportamientos:
 * - Body inválido (sin steps): retorna sin inyectar; el route handler hace 400.
 *   CD-15: NO duplicar validación de shape acá.
 * - Agente no existe: 404 AGENT_NOT_FOUND (CD-10: middleware no corre — reply.sent).
 * - Discovery throws: 503 REGISTRY_UNAVAILABLE (CD-10).
 * - priceUsdc === 0 o null: fallback $1 + warn + header (DT-C, CD-4).
 * - Happy path: inyecta `request.composeEstimatedCostUsd = price`.
 */
/**
 * WKH money-path fix: compute the REAL total an x402 caller owes for the whole
 * pipeline and inject it as `request.x402ChallengeAmountUsd` so the 402
 * challenge advertises it (instead of the flat 1 USD default). The figure is:
 *
 *   total = sum(stepPrice_i) * (1 + protocolFeeRate)
 *
 * - `stepPrice_i` reuses the SAME per-step price resolution / fallback as the
 *   compose pipeline: invalid prices (0 / null / NaN) fall back to
 *   `PLACEHOLDER_FEE_USD` (mirror of compose.ts service per-step + step-0
 *   preHandler), so the challenge never under-charges a misconfigured agent.
 * - the 1% protocol fee mirrors `chargeProtocolFee` (`fee = budget * rate`,
 *   charged post-compose on `result.totalCostUsdc`), so the challenge reflects
 *   the full amount the caller bears. No new fee math is invented.
 *
 * INVARIANT: the advertised challenge (and thus the caller's signed inbound
 * authorization, which the middleware binding check forces to be `>=` the
 * challenge, and which is what gets settled inbound) is `>= sum(stepPrice_i)`
 * — it never under-charges relative to the pipeline value, and equals the real
 * cost (no 1000x over-sign). The protocol-fee margin is additive and small
 * (rate ≤ 0.10), keeping the challenge tight.
 *
 * Best-effort: throws are caught by the caller and leave the challenge at the
 * 1 USD default (never blocks the request).
 */
async function augmentX402ChallengeAmount(
  request: FastifyRequest,
  steps: ComposeStep[],
  step0Usd: number,
): Promise<void> {
  // step-0 price is already resolved by the caller (reused as-is, no extra
  // discovery call → preserves the single-resolution contract for 1-step
  // pipelines). Steps 1..N are resolved here.
  let pipelineUsd = step0Usd;
  for (let i = 1; i < steps.length; i++) {
    const step = steps[i];
    if (!step || typeof step.agent !== 'string') {
      // BLQ-MEDIO-1 fix (layer 1 — defense in depth): a malformed step must NOT
      // early-return. Early-returning left `x402ChallengeAmountUsd` unset, so the
      // middleware fell back to quote(1) = 1 USDC. But composeService settles the
      // 0..i-1 downstream prefix before failing on the not-found step, and the
      // x402 path has no inbound refund (the refund block is gated on
      // `request.a2aKeyRow`). Net: caller pays 1 USDC inbound while the gateway
      // pays sum(prefix prices) downstream → gateway loss + undercharge. Instead
      // we OVER-estimate the malformed step as PLACEHOLDER_FEE_USD (the same
      // over-estimate already used for not-found / 0 / NaN prices) and keep
      // summing, so the challenge ends >= the real pipeline cost. The route
      // handler also hard-rejects such bodies with 400 (layer 2) so this path is
      // only ever reached defensively.
      pipelineUsd += PLACEHOLDER_FEE_USD;
      continue;
    }
    const price = await resolveAgentPriceUsdc(step.agent, step.registry);
    // Mirror the per-step fallback: agent-not-found / 0 / null / NaN → placeholder.
    const stepUsd =
      typeof price === 'number' && price > 0 && !Number.isNaN(price)
        ? price
        : PLACEHOLDER_FEE_USD;
    pipelineUsd += stepUsd;
  }
  if (pipelineUsd <= 0) return;
  // Add the 1% protocol fee the caller ultimately bears (mirror chargeProtocolFee).
  const total = Number((pipelineUsd * (1 + getProtocolFeeRate())).toFixed(6));
  // MNR-2 fix: guard on the FINAL atomic value, not the pre-fee `pipelineUsd`.
  // `total` can round to 0 at 6dp even when `pipelineUsd > 0` (sub-microdollar
  // pipeline). Never advertise 0: when `total > 0` rounds below 1 atomic unit,
  // floor the challenge to >= 1 atomic (1e-6 USD) so the 402 always demands a
  // positive amount and the never-undercharge invariant holds.
  if (total <= 0) {
    if (pipelineUsd > 0) {
      // pipelineUsd > 0 but rounded to 0 at 6dp → floor to 1 atomic unit.
      request.x402ChallengeAmountUsd = 0.000001;
    }
    return;
  }
  request.x402ChallengeAmountUsd = total;
}

async function resolveComposePriceHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = request.body as { steps?: ComposeStep[] } | undefined;

  // CD-15: shape validation la hace el route handler (líneas 40-58 originales).
  if (!body?.steps || !Array.isArray(body.steps) || body.steps.length === 0) {
    return;
  }

  const firstStep = body.steps[0];
  if (!firstStep || typeof firstStep.agent !== 'string') {
    return;
  }

  try {
    const price = await resolveAgentPriceUsdc(
      firstStep.agent,
      firstStep.registry,
    );

    if (price === null) {
      // AC-3: agente no existe → 404, NO debit. CD-10: middleware short-circuited.
      // Fastify 5 idiom: `return reply...` para abortar el preHandler lifecycle
      // ANTES del middleware de debit (requirePaymentOrA2AKey). El `return reply`
      // explícito hace que el código matchee el comentario "NO debit / middleware
      // short-circuited" sin depender del bare-return.
      return reply.status(404).send({
        error: `Agent not found: ${firstStep.agent}`,
        error_code: 'AGENT_NOT_FOUND',
      });
    }

    // WKH-125 BLQ-ALTO-1 (fix-pack): resolver el destino canónico desde el
    // AGENTE RESUELTO por discovery (no del body crudo). Espeja la resolución
    // del per-step → step-0 keyea idéntico → el cap se evalúa aunque el caller
    // omita `registry`. `price !== null` ya garantiza que el agente existe.
    const resolved = await resolveAgentDestination(
      firstStep.agent,
      firstStep.registry,
    );
    const composeDestination = resolved
      ? deriveComposeDestination(resolved)
      : undefined;

    if (price === 0 && resolved === null) {
      // MONEY-PATH FIX (compose-404-budget-drain): `resolveAgentPriceUsdc`
      // returns 0 (NOT null) for a slug whose lenient `getAgent` lookup yields a
      // ghost agent (empty/200 body → priceUsdc parsed as 0), so the
      // `price === null → 404` guard above is BYPASSED and the registry-miss
      // placeholder branch below would debit PLACEHOLDER_FEE_USD ($1) for an
      // agent that does NOT exist. The handler (composeService.resolveAgent) then
      // 404s — leaving the caller charged $1 for a 404 (self-overcharge / budget
      // drain). The authoritative existence signal is `resolved`
      // (`resolveAgentDestination`), which mirrors the SAME
      // `getAgent(slug,registry) → getAgent(slug)` chain the pipeline uses to
      // decide existence: `resolved === null` ⟺ the pipeline would 404. So when
      // the price is 0 AND the agent does not resolve, we 404 HERE — BEFORE the
      // debit middleware — instead of taking the placeholder fallback. The
      // placeholder fallback below is preserved ONLY for `price === 0 &&
      // resolved !== null` (a genuine EXISTING agent with a misconfigured price
      // 0 — CD-4 registry-miss honest fallback). `return reply...` aborts the
      // preHandler chain before `requirePaymentOrA2AKey` (same Fastify-5 idiom
      // as the `price === null` and 503 paths above/below → NO debit).
      return reply.status(404).send({
        error: `Agent not found: ${firstStep.agent}`,
        error_code: 'AGENT_NOT_FOUND',
      });
    }

    if (price === 0) {
      // AC-4 / DT-C: priceUsdc = 0 más probable config error que agente gratis.
      // CD-4: fallback honesto con warn + header. Llegamos acá SOLO con
      // `resolved !== null` (el guard de arriba ya 404eó el caso ghost), i.e.
      // un agente que EXISTE pero tiene el precio mal configurado en 0.
      request.log.warn(
        {
          reason: 'registry-miss',
          slug: firstStep.agent,
          registry: firstStep.registry ?? null,
        },
        'compose-price.fallback',
      );
      reply.header('x-debit-fallback', 'registry-miss');
      // G-03 (audit 2026-06-30): step-0 debit must include the per-step gas
      // overhead (consistent with steps 1..N and orchestrate step-0). 0 on
      // testnet / without env. Same chain the payment middleware resolves.
      const step0GasOverhead = await resolveStep0GasOverheadUsd(request);
      request.composeEstimatedCostUsd = PLACEHOLDER_FEE_USD + step0GasOverhead;
      // WKH-125: el destino del step-0 (el middleware no lee body, CD-7).
      request.composeDestination = composeDestination;
      // WKH money-path fix: still advertise the real pipeline cost (step-0 used
      // the placeholder; steps 1..N add their own prices).
      await augmentX402ChallengeAmount(
        request,
        body.steps,
        PLACEHOLDER_FEE_USD,
      ).catch((e) => {
        request.log.warn(
          { err: e instanceof Error ? e.message : 'unknown' },
          'compose.x402-challenge-amount.skip',
        );
      });
      return;
    }

    // Happy path AC-1. G-03 (audit 2026-06-30): add the step-0 per-step gas
    // overhead (consistent with steps 1..N / orchestrate step-0). 0 on testnet /
    // without env → identical to before. Same chain the payment middleware
    // resolves; refund reads the SAME field → price + gas refunded on failure.
    const step0GasOverhead = await resolveStep0GasOverheadUsd(request);
    request.composeEstimatedCostUsd = price + step0GasOverhead;
    // WKH-125: el destino del step-0 (el middleware no lee body, CD-7).
    request.composeDestination = composeDestination;

    // WKH money-path fix: compute the REAL total the x402 caller owes for the
    // whole pipeline so the 402 challenge advertises it (vs the flat 1 USD
    // default). This augmented field is consumed ONLY by the x402 fallback
    // (middleware/x402.ts → x402ChallengeAmountUsd); the prepaid a2a-key path
    // keeps using `composeEstimatedCostUsd` (step-0) for its per-step debit, so
    // it is UNAFFECTED. Reuses the already-resolved step-0 `price` (no extra
    // discovery call). Best-effort: any failure here leaves the challenge at the
    // 1 USD default (never blocks the request, CD-15 shape rules unchanged).
    await augmentX402ChallengeAmount(request, body.steps, price).catch((e) => {
      request.log.warn(
        { err: e instanceof Error ? e.message : 'unknown' },
        'compose.x402-challenge-amount.skip',
      );
    });
  } catch (err) {
    // AC-5: error de DB o discovery → 503 REGISTRY_UNAVAILABLE, NO debit.
    // CD-6: NO incluir owner_ref ni nada sensible en el log.
    request.log.error(
      {
        err: err instanceof Error ? err.message : 'unknown',
        slug: firstStep.agent,
      },
      'compose-price.registry-unavailable',
    );
    // Fastify 5 idiom: `return reply...` aborta el preHandler lifecycle ANTES
    // del middleware de debit (mismo motivo que el path 404).
    return reply.status(503).send({
      error: 'Registry temporarily unavailable',
      error_code: 'REGISTRY_UNAVAILABLE',
    });
  }
}

const composeRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: ComposeBody }>(
    '/',
    {
      config: { rateLimit: orchestrateRateLimit() },
      preHandler: [
        // WKH-65: forward-key (optional, env-gated) runs BEFORE timeout/payment.
        // Returns [] when WASIAI_V2_FORWARD_KEY is unset → no-op spread.
        ...requireForwardKey(),
        createTimeoutHandler(
          parseInt(process.env.TIMEOUT_COMPOSE_MS ?? '180000', 10),
        ),
        // WKH-59 (real-price-debit) DT-E: resolver precio ANTES del middleware
        // de debit para inyectar request.composeEstimatedCostUsd y manejar
        // 404 AGENT_NOT_FOUND / 503 REGISTRY_UNAVAILABLE.
        resolveComposePriceHandler,
        ...requirePaymentOrA2AKey({
          description:
            'WasiAI Compose Service — Multi-agent pipeline execution',
        }),
      ],
    },
    async (request, reply: FastifyReply) => {
      const body = request.body;

      if (
        !body.steps ||
        !Array.isArray(body.steps) ||
        body.steps.length === 0
      ) {
        return reply.status(400).send({
          error: 'Missing or empty steps array',
          code: 'VALIDATION_ERROR',
          requestId: request.id,
        });
      }

      if (body.steps.length > 5) {
        return reply.status(400).send({
          error: 'Maximum 5 steps allowed per pipeline',
          code: 'VALIDATION_ERROR',
          requestId: request.id,
        });
      }

      // BLQ-MEDIO-1 fix (layer 2 — close the unvalidated-input gap): reject the
      // whole pipeline when ANY step lacks a string `agent`. Previously only
      // step-0 was validated (by the price preHandler), so a malformed trailing
      // step (e.g. non-string `agent`) reached composeService, which settles the
      // valid 0..i-1 prefix downstream before failing on the bad step. On the
      // x402 path there is no inbound refund, so the gateway eats the prefix cost.
      // Rejecting up-front guarantees a malformed pipeline NEVER settles a partial
      // prefix. This runs AFTER the payment middleware, but a 400 here is the
      // failure mode we want (no compose call, no downstream settle).
      const badStepIndex = body.steps.findIndex(
        (s) => !s || typeof s.agent !== 'string',
      );
      if (badStepIndex !== -1) {
        return reply.status(400).send({
          error: `Step ${badStepIndex} is missing a string 'agent' field`,
          code: 'VALIDATION_ERROR',
          requestId: request.id,
        });
      }

      // BLQ-2: bail early if timeout already sent 504
      if (reply.sent) return;

      // WKH-58 fix-pack: propagate x-a2a-key header to service so compose
      // can skip Pieverse inbound x402 (broken upstream WKH-45) when caller
      // already paid via a2a-key (middleware debited budget per-call).
      const a2aKeyHeader = request.headers['x-a2a-key'];
      const a2aKey =
        typeof a2aKeyHeader === 'string' ? a2aKeyHeader : undefined;
      const result = await composeService.compose({
        steps: body.steps,
        maxBudget: body.maxBudget,
        a2aKey,
        // WKH-61: propagar el row del caller para scoping per-step
        scopingKeyRow: request.a2aKeyRow,
        // WKH-101 (DT-11): contexto de delegación para el débito per-step.
        delegationContext: request.delegationContext,
        // WKH-121 (BLQ-ALTO-1): contexto de key-session (poblado por el
        // middleware en a2a-key.ts) para que el cap de sesión se respete en
        // los steps 1..N. Espejo de delegationContext.
        keySessionContext: request.keySessionContext,
        // WKH-59 (real-price-debit) DT-D: chainId del MISMO bundle (CD-12)
        // para debit per-step (steps 2..N) atómico en composeService.
        chainId: request.resolvedChainId,
        // WKH-59 BLQ-MED-1 fix: Pino logger es estructuralmente compatible
        // con DownstreamLogger (warn/info con shape (obj, msg)). Permite que
        // el warn `compose-price.fallback per-step` salga al pino transport
        // configurado en server.ts (vs console.warn raw).
        logger: request.log,
      });

      // BLQ-2: bail early if timeout fired during compose
      if (reply.sent) return;

      if (!result.success) {
        // AUDIT A1 (ALTA, money-path): el middleware (path a2a-key) PRE-debitó el
        // step-0 (`request.composeEstimatedCostUsd`), pero hasta ahora la rama de
        // fallo devolvía el error SIN reembolsarlo (compose.ts:142 deja
        // stepDebitedUsd=0 para i===0, así que el refund per-step del service es
        // no-op para el step-0). Cobro sin contraprestación. Mirror EXACTO de
        // orchestrate.ts:644 — refund best-effort que NUNCA rompe el response:
        //   refundUsd = max(0, composeEstimatedCostUsd - result.totalCostUsdc)
        //   - step-0 falló  → totalCostUsdc=0  → reembolsa el step-0 entero.
        //   - step-0 settleó (su precio ya está en totalCostUsdc) → clamp a 0.
        // Solo aplica al path a2a-key con débito real (x402 puro no debita budget).
        const debitedUsd = request.composeEstimatedCostUsd;
        const refundChainId = request.resolvedChainId;
        if (
          request.a2aKeyRow &&
          typeof debitedUsd === 'number' &&
          debitedUsd > 0 &&
          refundChainId !== undefined
        ) {
          const refundUsd = Math.max(0, debitedUsd - result.totalCostUsdc);
          if (refundUsd > 0) {
            try {
              // M3 (auditoría): el destino del refund DEBE matchear el del débito.
              // El step-0 lo debitó el middleware con `request.composeDestination`
              // (destino canónico resuelto por el preHandler). Reusamos ESE destino
              // exacto vía creditWithDest (revierte también el dest-cap ledger). Si
              // no hay destino fiable, usamos credit (sin dest-policy) para no romper
              // el cap por destino.
              const creditRes = request.composeDestination
                ? await budgetService.creditWithDest(
                    request.a2aKeyRow.id,
                    refundChainId,
                    refundUsd,
                    request.a2aKeyRow.owner_ref,
                    request.composeDestination,
                  )
                : await budgetService.credit(
                    request.a2aKeyRow.id,
                    refundChainId,
                    refundUsd,
                    request.a2aKeyRow.owner_ref,
                  );
              if (!creditRes.success) {
                // CD-6: sin msg crudo de PG. No cambia el status code.
                log.error(
                  {
                    keyId: request.a2aKeyRow.id,
                    chainId: refundChainId,
                    amountUsd: refundUsd,
                    requestId: request.id,
                  },
                  '[compose.refund-failed]',
                );
                // M6 (audit 2026-06-24): success:false ⟹ reverted:false / 0
                // filas (nada se aplicó). Encolar para reintento confiable.
                // Invariante anti-doble-refund: solo se encola cuando NADA se
                // aplicó. Best-effort: no rompe el response.
                await refundOutbox.enqueueRefund({
                  keyId: request.a2aKeyRow.id,
                  chainId: refundChainId,
                  amountUsd: refundUsd,
                  ownerRef: request.a2aKeyRow.owner_ref,
                  destination: request.composeDestination ?? null,
                  reason: 'compose-route.refund-failed',
                });
              }
            } catch (e) {
              // Best-effort: el fallo del refund NUNCA rompe el response.
              log.error(
                { detail: e instanceof Error ? e.message : String(e) },
                '[compose.refund-threw]',
              );
              // M6: el credit tiró antes de aplicar nada → encolar para reintento.
              await refundOutbox.enqueueRefund({
                keyId: request.a2aKeyRow.id,
                chainId: refundChainId,
                amountUsd: refundUsd,
                ownerRef: request.a2aKeyRow.owner_ref,
                destination: request.composeDestination ?? null,
                reason: 'compose-route.refund-threw',
              });
            }
          }
        }

        // WKH-61: errorCode='SCOPE_DENIED' → 403; default 400 (preserva legacy).
        // WKH-125 (AC-2): errorCode='DEST_CAP_EXCEEDED' → 402 (cap por destino
        // excedido mid-pipeline; el budget NO se decrementó).
        let status = 400;
        if (result.errorCode === 'SCOPE_DENIED') {
          status = 403;
        } else if (result.errorCode === 'DEST_CAP_EXCEEDED') {
          status = 402;
        }
        return reply.status(status).send({
          ...result,
          requestId: request.id,
        });
      }

      // WKH-118: best-effort 1% protocol fee post-compose (espejo orchestrate.ts:437-482).
      // Idempotencia por request.id; base = result.totalCostUsdc. NUNCA rompe el 200
      // (CD-1): todo error queda en variables locales + console. El response NO cambia (CD-4).
      // CD-4: feeChargeTxHash NO se declara — en compose (a diferencia de
      // orchestrate) ningún campo de fee se serializa en el response, así que la
      // variable quedaría asignada-pero-no-leída (biome noUnusedVariables). El
      // txHash que necesita el recibo se lee de `feeResult.txHash` directamente.
      let feeChargeError: string | undefined;
      try {
        const feeResult = await chargeProtocolFee({
          orchestrationId: request.id,
          feeBaseUsdc: result.totalCostUsdc,
          feeRate: getProtocolFeeRate(),
        });
        if (feeResult.status === 'failed') {
          feeChargeError = feeResult.error;
          log.error({ detail: feeResult.error }, 'fee charge failed');
        } else if (
          feeResult.status === 'charged' ||
          feeResult.status === 'already-charged'
        ) {
          // WKH-124: emit protocol_fee receipt SOLO si charged + owner_ref presente.
          // Fire-and-forget (CD-6/CD-7): su fallo/latencia NUNCA afecta el 200.
          if (feeResult.status === 'charged' && request.a2aKeyRow?.owner_ref) {
            receiptService
              .emit({
                ownerRef: request.a2aKeyRow.owner_ref,
                agentKeyId: request.a2aKeyRow.id,
                sessionId: null,
                delegationId: null,
                receiptType: 'protocol_fee',
                amountUsd: feeResult.feeUsdc,
                chainId: request.resolvedChainId ?? 0,
                txHash: feeResult.txHash ?? null,
                counterparty: process.env.WASIAI_PROTOCOL_FEE_WALLET ?? null,
                orchestrationId: request.id,
              })
              .catch((e) =>
                log.warn(
                  { detail: e instanceof Error ? e.message : e },
                  '[receipts] emit failed',
                ),
              );
          }
        }
        // 'skipped' → ambos undefined (wallet unset) — sin error, sin recibo (AC-4).
      } catch (e) {
        // R-1: chargeProtocolFee puede throw ProtocolFeeError (feeUsdc > budget).
        // Con feeRate ≤ 0.10 es prácticamente imposible, pero capturamos para
        // blindar CD-1 al 100%. La respuesta 200 procede igual.
        feeChargeError = e instanceof Error ? e.message : String(e);
        log.error({ detail: feeChargeError }, 'fee charge threw');
      }

      const kiteTxHash = request.paymentTxHash;
      return reply.send({ kiteTxHash, ...result });
    },
  );
};

export default composeRoutes;
