/**
 * Compose Routes — Multi-agent pipelines
 * WKH-18: Timeout preHandler, error boundary integration.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { resolveChainKey } from '../adapters/chain-resolver.js';
import { getAdaptersBundle, getDefaultChainKey } from '../adapters/registry.js';
import { splitsActive } from '../config/split-config.js';
import { MAX_COMPOSE_STEPS } from '../lib/compose-limits.js';
import { getStepGasOverheadUsd } from '../lib/gas-overhead.js';
import { getLogger } from '../lib/logger.js';
import { PLACEHOLDER_FEE_USD } from '../lib/pricing-constants.js';
import {
  extractRawKey,
  requirePaymentOrA2AKey,
} from '../middleware/a2a-key.js';
import { noteDownstreamSkips } from '../middleware/event-tracking.js';
import { requireForwardKey } from '../middleware/forward-key.js';
import { orchestrateRateLimit } from '../middleware/rate-limit.js';
import { createTimeoutHandler } from '../middleware/timeout.js';
import {
  resolveAgentDestination,
  resolveAgentPriceUsdc,
} from '../services/agent-price.js';
import { resolveAgentSplitContext } from '../services/agent-split-context.js';
import { budgetService } from '../services/budget.js';
import { composeService } from '../services/compose.js';
import {
  chargeProtocolFee,
  type FeeChargeParams,
  getProtocolFeeRate,
} from '../services/fee-charge.js';
import type { SplitPartyRef } from '../services/fee-split.js';
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

/** Body del 400 de validación de shape (sin `requestId`, que lo agrega el caller). */
type ComposeValidationError = {
  error: string;
  code: 'VALIDATION_ERROR';
};

/**
 * HIGH-2 (2026-07-26): validación de SHAPE del body, extraída del route handler.
 *
 * Los tres checks vivían SOLO en el handler, que corre DESPUÉS de
 * `requirePaymentOrA2AKey` — así que un `/compose` que respondía 400 ya había
 * pasado por el débito y se le cobraba al caller sin ejecutar nada. El comentario
 * original de `badStepIndex` incluso lo admitía: "This runs AFTER the payment
 * middleware, but a 400 here is the failure mode we want".
 *
 * Ninguno de los tres depende de nada que produzca el middleware de auth/débito
 * (`request.a2aKeyRow`, `resolvedChainId`, `composeEstimatedCostUsd`): son puras
 * funciones del body. Por eso se pueden ADELANTAR al débito (dirección (a)) en
 * lugar de reembolsar después (dirección (b)) — no se cobra nunca por lo que no
 * se ejecuta, sin ventana en la que el balance baja y sube.
 *
 * Función pura y compartida: la usa el preHandler `validateComposeBodyHandler`
 * (pre-débito, el guard real) y el route handler (defense-in-depth, para que un
 * reordenamiento futuro de la cadena de preHandlers no reabra el agujero de
 * input no validado que cerró BLQ-MEDIO-1).
 */
function validateComposeBody(steps: unknown): ComposeValidationError | null {
  if (!steps || !Array.isArray(steps) || steps.length === 0) {
    return { error: 'Missing or empty steps array', code: 'VALIDATION_ERROR' };
  }

  // AR it3 MENOR-2: el `5` es una constante compartida (`lib/compose-limits.ts`).
  // Era un literal acá y OTRO literal en `adapters/solana/payment.ts`, donde
  // multiplica la cota estimada de wall-clock de un run (y de ahí sale el TTL del
  // dedup de settles): subir este número desalineaba el TTL en silencio.
  if (steps.length > MAX_COMPOSE_STEPS) {
    return {
      error: `Maximum ${MAX_COMPOSE_STEPS} steps allowed per pipeline`,
      code: 'VALIDATION_ERROR',
    };
  }

  // BLQ-MEDIO-1: rechazar el pipeline entero si CUALQUIER step no trae un
  // `agent` string. Antes sólo se validaba el step-0 (en el preHandler de
  // precio), así que un step final malformado llegaba a composeService, que
  // settlea el prefijo válido 0..i-1 antes de fallar en el step malo.
  const badStepIndex = (steps as { agent?: unknown }[]).findIndex(
    (s) => !s || typeof s.agent !== 'string',
  );
  if (badStepIndex !== -1) {
    return {
      error: `Step ${badStepIndex} is missing a string 'agent' field`,
      code: 'VALIDATION_ERROR',
    };
  }

  return null;
}

/**
 * HIGH-2 preHandler: corre ANTES de `resolveComposePriceHandler` y por lo tanto
 * ANTES de `requirePaymentOrA2AKey`. Un body malformado se rechaza con el MISMO
 * 400 de siempre, pero sin débito y sin la llamada de discovery del step-0.
 *
 * Idiom Fastify 5 (igual que los paths 404/503 del preHandler de precio):
 * `return reply.status(...).send(...)` aborta el lifecycle de preHandlers.
 */
async function validateComposeBodyHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = request.body as { steps?: unknown } | undefined;
  const invalid = validateComposeBody(body?.steps);
  if (invalid) {
    return reply.status(400).send({ ...invalid, requestId: request.id });
  }
}

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
/**
 * MNR-2 (AR HIGH-2): `export` SOLO para test. El guard de layer 1 (step
 * malformado → sobre-estimación) es inalcanzable vía HTTP desde que
 * `validateComposeBodyHandler` (layer 0) rechaza esos bodies pre-pago, así que la
 * única forma de probarlo — y de que no se rompa en silencio — es llamar la
 * función directo. La lógica NO cambió (invariante de precio del AR).
 */
export async function augmentX402ChallengeAmount(
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
      //
      // HIGH-2 (2026-07-26): `validateComposeBodyHandler` (layer 0) ahora rechaza
      // este body con 400 ANTES de este preHandler, con la MISMA condición
      // (`!step || typeof step.agent !== 'string'`) → esta rama es inalcanzable
      // vía HTTP. Se CONSERVA como defense in depth: si alguien reordena la cadena
      // de preHandlers, la sobre-estimación sigue siendo el fallback seguro.
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

/**
 * HIGH-2 (2026-07-26): credit-back del débito step-0, extraído del bloque que
 * vivía inline en la rama `!result.success` del handler (AUDIT A1). Se extrae SIN
 * cambiar la matemática ni los `reason` del outbox, para poder reusarlo en los
 * OTROS caminos que cobraban sin entregar nada:
 *
 *   1. `!result.success` — el caso original (comportamiento byte-idéntico).
 *   2. Débito HUÉRFANO — el 504 disparó durante el débito (o durante el read del
 *      header de budget que va justo después) y el route handler NUNCA se invoca.
 *      Se llama desde el middleware vía el hook `onDebitOrphaned` (BLQ-MED-1),
 *      NO desde el handler: `alreadySpentUsd = 0` → se reembolsa el step-0
 *      entero, porque el pipeline no arrancó.
 *   3. `reply.sent` DESPUÉS de compose — el 504 disparó mientras compose corría;
 *      se pasa `result.totalCostUsdc` para NO reembolsar lo que sí se settleó.
 *
 * Los tres son mutuamente excluyentes: (2) sólo corre cuando `reply.sent` ya era
 * true al terminar el middleware, y en ese caso Fastify saltea el handler, así
 * que (1) y (3) no pueden ejecutarse. No hay doble refund posible.
 *
 * Precedente: WKH-127 (`orchestrate.ts:1304`) — mismo mecanismo (`budgetService
 * .credit` / `creditWithDest` / `creditDelegation` / `creditSession` + encolado
 * en `refundOutbox` cuando el refund no revirtió nada). NO se inventa un
 * mecanismo nuevo.
 *
 * `alreadySpentUsd` es el costo REAL ya settleado del pipeline: el refund es
 * `max(0, debitedUsd - alreadySpentUsd)`, así que nunca reembolsa de más.
 *
 * Ownership guard (CLAUDE.md): todas las variantes de credit reciben el
 * `owner_ref` del caller autenticado (`request.a2aKeyRow.owner_ref` o el del
 * contexto de delegación/sesión), nunca sólo el `keyId`.
 *
 * Best-effort: NUNCA lanza ni cambia el status de la respuesta.
 */
async function refundComposeStep0(
  request: FastifyRequest,
  alreadySpentUsd: number,
): Promise<void> {
  // Sólo el path a2a-key con débito real; x402 puro no debita budget.
  const debitedUsd = request.composeEstimatedCostUsd;
  const refundChainId = request.resolvedChainId;
  if (
    !request.a2aKeyRow ||
    typeof debitedUsd !== 'number' ||
    debitedUsd <= 0 ||
    refundChainId === undefined
  ) {
    return;
  }

  const refundUsd = Math.max(0, debitedUsd - alreadySpentUsd);
  if (refundUsd <= 0) return;

  try {
    // M3 (auditoría): el destino del refund DEBE matchear el del débito.
    // El step-0 lo debitó el middleware con `request.composeDestination`
    // (destino canónico resuelto por el preHandler). Reusamos ESE destino
    // exacto vía creditWithDest (revierte también el dest-cap ledger). Si
    // no hay destino fiable, usamos credit (sin dest-policy) para no romper
    // el cap por destino.
    //
    // M1 (audit 2026-07-01): el débito step-0 bajo delegación/sesión es
    // DUAL-LEDGER (debit_delegation_and_parent / debit_session_and_parent
    // incrementan `total_spent`/`spent_usd` ADEMÁS del parent). Este
    // bloque NO estaba gateado por contexto → refundeaba sólo el parent
    // (credit/creditWithDest) y dejaba `total_spent`/`spent_usd` inflado
    // (self-DoS de la credencial). Ahora enrutamos al refund DUAL-LEDGER
    // simétrico al débito cuando hay delegación/sesión; el path master
    // (sin contexto) conserva credit/creditWithDest INTACTO.
    const creditRes = request.delegationContext
      ? await budgetService.creditDelegation(
          request.delegationContext.delegationId,
          request.delegationContext.ownerRef,
          request.delegationContext.keyId,
          refundChainId,
          refundUsd,
          request.composeDestination,
        )
      : request.keySessionContext
        ? await budgetService.creditSession(
            request.keySessionContext.sessionId,
            request.keySessionContext.ownerRef,
            request.keySessionContext.keyId,
            refundChainId,
            refundUsd,
            request.composeDestination,
          )
        : request.composeDestination
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
    await refundOutbox
      .enqueueRefund({
        keyId: request.a2aKeyRow.id,
        chainId: refundChainId,
        amountUsd: refundUsd,
        ownerRef: request.a2aKeyRow.owner_ref,
        destination: request.composeDestination ?? null,
        reason: 'compose-route.refund-threw',
      })
      .catch((outboxErr) =>
        log.error(
          {
            detail: outboxErr instanceof Error ? outboxErr.message : 'unknown',
          },
          '[compose.refund-outbox-threw]',
        ),
      );
  }
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
        // HIGH-2 (2026-07-26): validación de shape ANTES del preHandler de precio
        // y por lo tanto ANTES del débito. Un body malformado ya no se cobra (ni
        // el precio real del step-0, ni el $1 de PLACEHOLDER_FEE_USD que se
        // aplicaba cuando `steps` venía vacío y el preHandler de precio no
        // inyectaba `composeEstimatedCostUsd`).
        validateComposeBodyHandler,
        // WKH-59 (real-price-debit) DT-E: resolver precio ANTES del middleware
        // de debit para inyectar request.composeEstimatedCostUsd y manejar
        // 404 AGENT_NOT_FOUND / 503 REGISTRY_UNAVAILABLE.
        resolveComposePriceHandler,
        ...requirePaymentOrA2AKey(
          {
            description:
              'WasiAI Compose Service — Multi-agent pipeline execution',
          },
          {
            // BLQ-MED-1 (AR HIGH-2): credit-back del débito HUÉRFANO. Si el 504
            // del `createTimeoutHandler` sale mientras el middleware debita (o
            // mientras lee el header de budget post-débito), Fastify NO invoca
            // este route handler (`handle-request.js:132`), así que un
            // `if (reply.sent)` dentro del handler era código inalcanzable: el
            // caller quedaba cobrado por un pipeline que jamás corrió. El
            // middleware llama este hook en el único punto donde el débito está
            // confirmado aplicado y todavía es reversible.
            // `alreadySpentUsd = 0`: el pipeline no arrancó, nada se settleó.
            onDebitOrphaned: (request) => refundComposeStep0(request, 0),
          },
        ),
      ],
    },
    async (request, reply: FastifyReply) => {
      const body = request.body;

      // HIGH-2: el guard REAL corre pre-débito en `validateComposeBodyHandler`.
      // Esto es defense-in-depth (BLQ-MEDIO-1 layer 2): si alguien reordena la
      // cadena de preHandlers, el pipeline malformado sigue sin llegar a
      // composeService (que settlearía el prefijo válido 0..i-1 antes de fallar
      // en el step malo). Mismo body de respuesta, misma función pura.
      const invalidBody = validateComposeBody(body.steps);
      if (invalidBody) {
        return reply.status(400).send({
          ...invalidBody,
          requestId: request.id,
        });
      }

      // BLQ-MED-1 (AR HIGH-2): acá vivía un `if (reply.sent) { refund; return }`
      // para el 504 pre-compose. Era CÓDIGO INALCANZABLE — Fastify no invoca el
      // handler cuando la reply ya salió (`fastify/lib/handle-request.js:132`
      // `preHandlerCallback` → `if (reply.sent) return`), y el AR lo confirmó con
      // coverage sobre la suite completa (0 hits). Se BORRÓ en vez de dejarlo
      // como falsa protección: ese caso lo cubre ahora el hook `onDebitOrphaned`
      // que se le pasa a `requirePaymentOrA2AKey` (ver la cadena de preHandlers),
      // que corre DENTRO del middleware, con el débito ya confirmado.
      // El `if (reply.sent)` de ABAJO (post-compose) SÍ es alcanzable: ahí el
      // handler ya estaba corriendo cuando el timer disparó.

      // WKH-58 fix-pack: propagate the a2a credential to the service so compose
      // can skip Pieverse inbound x402 (broken upstream WKH-45) when caller
      // already paid via a2a-key (middleware debited budget per-call).
      //
      // C2 (audit 2026-07-01): derive the a2a key with the SAME extraction the
      // auth middleware uses (x-a2a-key OR `Authorization: Bearer wasi_a2a_*`).
      // Previously this read ONLY `x-a2a-key`, so a caller authenticated via
      // `Authorization: Bearer` (whose budget WAS debited, scopingKeyRow set)
      // looked un-keyed to compose → `invokeAgent` took the operator-signed
      // EIP-3009 branch (`!a2aKey`) and leaked a redeemable authorization to the
      // downstream agent. Deriving consistently with the real auth keeps such a
      // caller on the prepaid path (no operator signature).
      const a2aKey = extractRawKey(request);
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
      // HIGH-2: el 504 se envió mientras compose corría; el débito step-0 sigue
      // aplicado y la respuesta que ve el caller es un timeout. Se reembolsa con
      // la MISMA fórmula que la rama de fallo — `result.totalCostUsdc` asegura
      // que lo ya settleado NO se reembolsa (nunca se devuelve trabajo entregado).
      if (reply.sent) {
        await refundComposeStep0(request, result.totalCostUsdc);
        return;
      }

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
        //
        // HIGH-2 (2026-07-26): el bloque se movió a `refundComposeStep0` SIN
        // cambiar la matemática ni los `reason` del outbox, para reusarlo en los
        // dos caminos de 504 que también cobraban sin entregar nada.
        await refundComposeStep0(request, result.totalCostUsdc);

        // WKH-61: errorCode='SCOPE_DENIED' → 403; default 400 (preserva legacy).
        // WKH-125 (AC-2): errorCode='DEST_CAP_EXCEEDED' → 402 (cap por destino
        // excedido mid-pipeline; el budget NO se decrementó).
        let status = 400;
        if (result.errorCode === 'SCOPE_DENIED') {
          status = 403;
        } else if (result.errorCode === 'DEST_CAP_EXCEEDED') {
          status = 402;
        }
        // WKH-191x (AR BLQ-BAJO-1a): esta rama TAMBIÉN tiene que dejar los skips
        // en el evento. Un pipeline puede saltear el pago del step 1 (el caller
        // recibe ese `skipped:*` en su respuesta) y fallar en el step 2: sin esta
        // línea el skip viajaba al caller pero NO quedaba en `a2a_events`, así que
        // el contador de la pantalla lo ignoraba y podía mostrar "0, estado bueno"
        // sobre datos incompletos. Espejo de orchestrate.ts (que ya cubre su 403).
        // Escritura en memoria, sin await, sin I/O: no puede lanzar ni cambiar el
        // status, el body ni un centavo del refund de arriba.
        noteDownstreamSkips(request, result.steps);
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
        // WKH-143 (DT-2/DT-5/CD-9/CD-1b): resolvemos el creator del agente
        // primario SOLO cuando `splitsActive()` (gate NO-throw). Con el default
        // 10000/0/0 el gate es `false` → cero query extra y `feeParams` idéntico
        // al actual (byte-idéntico).
        let creator: SplitPartyRef | null = null;
        let referral: SplitPartyRef | null = null;
        if (splitsActive()) {
          const splitCtx = await resolveAgentSplitContext(
            result.steps[0]?.agent,
          );
          creator = splitCtx.creator;
          referral = splitCtx.referral;
        }
        // CD-8: asignación condicional (exactOptionalPropertyTypes).
        const feeParams: FeeChargeParams = {
          orchestrationId: request.id,
          feeBaseUsdc: result.totalCostUsdc,
          feeRate: getProtocolFeeRate(),
        };
        if (creator) feeParams.creator = creator;
        if (referral) feeParams.referral = referral;
        const feeResult = await chargeProtocolFee(feeParams);
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
      // WKH-191x: retiene los skip-codes PÚBLICOS del pipeline para que el evento
      // los persista (`a2a_events.metadata.downstreamSkips`). Aditivo puro: NO lee
      // ni cambia nada del money-path, sólo copia lo que ya viaja en el response.
      noteDownstreamSkips(request, result.steps);
      return reply.send({ kiteTxHash, ...result });
    },
  );
};

export default composeRoutes;
