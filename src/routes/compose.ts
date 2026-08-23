/**
 * Compose Routes — Multi-agent pipelines
 * WKH-18: Timeout preHandler, error boundary integration.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { resolveChainKey } from '../adapters/chain-resolver.js';
import { getAdaptersBundle, getDefaultChainKey } from '../adapters/registry.js';
import { splitsActive } from '../config/split-config.js';
import { MAX_COMPOSE_STEPS } from '../lib/compose-limits.js';
import {
  type ComposeStepShapeError,
  validateComposeStepShape,
} from '../lib/compose-step-shape.js';
import {
  CONTRACTING_LOOP_DETECTED,
  contractingErrorMessage,
  isSelfDestination,
  resolveSelfHosts,
  rollUpCascadedFee,
} from '../lib/contracting-chain.js';
import type { DownstreamSkipCode } from '../lib/downstream-skip-code.js';
import { getStepGasOverheadUsd } from '../lib/gas-overhead.js';
import { getLogger } from '../lib/logger.js';
import { PLACEHOLDER_FEE_USD } from '../lib/pricing-constants.js';
import { refundIdemKey, requestRefundIdemBase } from '../lib/refund-idem.js';
import {
  isComposeSuspendEnabled,
  resolveResumeCaller,
  resolveSuspendTtlSeconds,
  resumeTokenHash,
  SUSPEND_MIN_TTL_SECONDS,
  suspendMaxTtlSeconds,
  verifyResumeToken,
} from '../lib/resume-token.js';
// HU-208: fuente ÚNICA del monto del débito step-0, compartida con el middleware
// que lo debita. Ver el comentario en `refundComposeStep0`.
import { resolveStep0DebitUsd } from '../lib/step0-debit.js';
import {
  extractRawKey,
  requireA2AKey,
  requirePaymentOrA2AKey,
} from '../middleware/a2a-key.js';
import { contractingGuardHandler } from '../middleware/contracting-guard.js';
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
import { resolveCallerScope } from '../services/caller-scope.js';
import {
  createCapabilityResolver,
  logCapabilityChoice,
} from '../services/capability-resolver.js';
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
import { suspendedRunService } from '../services/suspended-run.js';
import type {
  ComposeStep,
  ResolvedComposeStep,
  ResumeCaller,
  StepResult,
} from '../types/index.js';

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
  /**
   * WKH-225: cuánto tiempo puede quedar esperando un step suspendido, en
   * segundos. Opcional; ausente ⇒ el máximo configurado, que es lo normal
   * (el caller no sabe cuánto va a tardar la persona).
   *
   * Fuera de rango se rechaza con 400 ANTES de tocar nada: recortarlo en
   * silencio le devolvería un `expiresAt` que no pidió.
   */
  suspendTtlSeconds?: number;
};

/** WKH-225: body del `POST /compose/resume`. El token va acá, NO en el path. */
type ResumeBody = {
  token?: unknown;
};

/**
 * Body del 400 de validación de shape (sin `requestId`, que lo agrega el caller).
 *
 * HU-208: el shape por-step (incluido el código `ambiguous_step` de WAS-187 AC-3)
 * vive en `lib/compose-step-shape.ts`; este alias mantiene el nombre que ya usaba
 * el archivo.
 */
type ComposeValidationError = ComposeStepShapeError;

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

  // BLQ-MEDIO-1: rechazar el pipeline entero si CUALQUIER step tiene shape
  // inválido. Antes sólo se validaba el step-0 (en el preHandler de precio), así
  // que un step final malformado llegaba a composeService, que settlea el prefijo
  // válido 0..i-1 antes de fallar en el step malo.
  //
  // HU-208: el criterio por-step se movió a `lib/compose-step-shape.ts` porque
  // dejó de ser un `typeof s.agent !== 'string'`: ahora un step vale si trae
  // `agent` O `capability`, EXACTAMENTE uno de los dos. Los dos juntos son
  // `ambiguous_step` (400); ninguno conserva el `VALIDATION_ERROR` histórico.
  for (let i = 0; i < steps.length; i++) {
    const stepError = validateComposeStepShape((steps as unknown[])[i], i);
    if (stepError) return stepError;
  }

  return null;
}

/**
 * HU-208 — guard de "nada se ejecuta sin resolver", capa de runtime.
 *
 * `ComposeRequest.steps` es `ResolvedComposeStep[]`, así que el compilador ya
 * impide entregarle a `composeService.compose` un step por capacidad. Esto es la
 * red de abajo: comprueba en runtime que el arreglo que se va a EJECUTAR tiene
 * todos los `agent` resueltos.
 *
 * Es inalcanzable por construcción (si `resolveComposeCapabilitiesHandler` corrió,
 * todos están resueltos; si el body no traía capacidades, ya venían resueltos).
 * Existe para el caso en que alguien reordene la cadena de preHandlers y saque al
 * resolver de en medio: sin este chequeo, un step con `capability` llegaría al
 * ejecutor con `agent: undefined` y moriría recién a mitad del pipeline —
 * después de haber settleado el prefijo 0..i-1.
 */
function findUnresolvedStepIndex(steps: ComposeStep[]): number {
  return steps.findIndex((s) => !s || typeof s.agent !== 'string');
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
 * HU-208 — MEDICIÓN de la deriva de precio entre la cotización y el cobro.
 *
 * Qué residual mide y cuál NO. La resolución por capacidad se fija UNA sola vez
 * (`resolveComposeCapabilitiesHandler`), así que la IDENTIDAD del agente no puede
 * cambiar entre el 402/débito y la ejecución. Lo que sí puede cambiar es el
 * PRECIO del agente ya fijado: se cotiza con `resolveAgentPriceUsdc` (cache de
 * 60s) y se cobra con el `priceUsdc` que trae el agente re-leído en
 * `composeService.resolveAgent`.
 *
 * Ese residual EXISTE HOY para todo llamador que nombra su agente.
 *
 * ⚠️ ESTO NO ES LA SOLUCIÓN, ES INSTRUMENTACIÓN INTERINA. La solución acordada es
 * CONGELAR la cotización por 10 minutos: una alarma avisa DESPUÉS de que alguien
 * pagó de más, un precio congelado hace que no pueda pasar. El congelamiento
 * requiere almacenamiento durable entre requests (el 402 y la ejecución son dos
 * requests distintos, y en este repo no hay Redis — ver `agent-price.ts` y
 * `reputation.ts`), así que está pendiente de una decisión de storage.
 *
 * Mientras tanto esto mide: hasta ahora nadie sabía si el residual ocurría alguna
 * vez. El dato dice si el congelamiento es urgente o rutinario. Cuando el
 * congelamiento aterrice, esta función debería quedar como verificación de que la
 * ventana congelada se está respetando (deltas esperados = 0), NO borrarse.
 *
 * Lo que NO se hizo, y por qué: pinear el precio del `discover` obligaría a que
 * los steps por capacidad cobren desde una fuente distinta de la de los steps
 * nombrados (el `agentEndpoint` de `getAgent`). Dos fuentes de precio es el mismo
 * error de clase que dos definiciones de "el mejor agente".
 *
 * Best-effort puro: no toca el dinero, no cambia la respuesta, nunca lanza.
 */
function reportComposePriceDrift(
  request: FastifyRequest,
  result: { steps: { agent: { slug: string }; costUsdc: number }[] },
): void {
  try {
    const quoted = request.composeQuotedPricesUsd;
    if (!quoted) return;
    for (let i = 0; i < result.steps.length; i++) {
      const step = result.steps[i];
      const quotedUsd = quoted[i];
      if (!step || typeof quotedUsd !== 'number') continue;
      const chargedUsd = step.costUsdc;
      if (typeof chargedUsd !== 'number' || chargedUsd === quotedUsd) continue;
      log.warn(
        {
          error_code: 'COMPOSE_PRICE_DRIFT',
          step: i,
          agent: step.agent.slug,
          quotedUsd,
          chargedUsd,
          deltaUsd: Number((chargedUsd - quotedUsd).toFixed(6)),
          requestId: request.id,
        },
        '[compose.price-drift] the price quoted to the caller does not match the price charged for this step',
      );
    }
  } catch {
    /* la telemetría NUNCA puede romper una respuesta del money-path */
  }
}

/**
 * HU-208 preHandler: resuelve los steps declarados por CAPACIDAD a un agente
 * concreto, y deja el pipeline resuelto en `request.composeResolvedSteps`.
 *
 * ─── DÓNDE CORRE Y POR QUÉ EXACTAMENTE ACÁ ──────────────────────────────
 * Va DESPUÉS de `validateComposeBodyHandler` (shape) y ANTES de
 * `resolveComposePriceHandler`, o sea antes de `requirePaymentOrA2AKey`. Las tres
 * consecuencias, todas necesarias:
 *
 *  1. EL DESCUBRIMIENTO ES GRATIS. Nada de lo que corre antes del middleware de
 *     pago debita ni settlea, así que resolver acá no le cuesta nada al llamador
 *     — ni siquiera cuando la resolución falla.
 *
 *  2. EL 402 / EL DÉBITO COTIZAN EL PIPELINE REAL. `resolveComposePriceHandler`
 *     ve un arreglo donde TODOS los steps traen un slug concreto, así que el
 *     precio del step-0, el destino canónico y el monto del challenge x402 salen
 *     del agente que efectivamente se va a ejecutar. Ese handler no necesitó UN
 *     SOLO cambio de lógica de precio: para él, un step resuelto por capacidad es
 *     indistinguible de uno que el llamador nombró.
 *
 *  3. SE RESUELVE UNA SOLA VEZ. `composeService` recibe el arreglo YA resuelto y
 *     su `resolveAgent` sólo busca por slug. Si la resolución por capacidad
 *     corriera también allá, correría DESPUÉS de cotizar y DESPUÉS de debitar el
 *     step-0, sobre entradas de ranking que cambian solas (fetch en vivo a los
 *     registries + `computeReputationBatch`): podría elegir otro agente y el
 *     llamador habría pagado por un pipeline y recibido otro.
 *
 * ─── BACK-COMPAT ────────────────────────────────────────────────────────
 * Si NINGÚN step trae `capability`, este handler no hace absolutamente nada: ni
 * lookup de alcance, ni discovery, ni escribe `composeResolvedSteps`. Un llamador
 * de los de hoy recorre exactamente el mismo código que antes de esta HU.
 *
 * ─── FALLA CERRADO ──────────────────────────────────────────────────────
 * Una capacidad que no resuelve corta acá con 422 `no_agent_match` (WAS-187 AC-4)
 * vía `return reply...`, el MISMO idiom Fastify-5 que los caminos 404/503 de
 * abajo: aborta la cadena de preHandlers ANTES del middleware de pago, así que no
 * se debita nada y `composeService` ni se invoca. NUNCA se elige un agente
 * arbitrario ni se ejecuta un pipeline a medias.
 */
async function resolveComposeCapabilitiesHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = request.body as { steps?: ComposeStep[] } | undefined;
  const steps = body?.steps;
  if (!steps || !Array.isArray(steps) || steps.length === 0) return;

  // Gate de back-compat: sin capacidades no se toca nada (cero queries extra).
  if (!steps.some((s) => typeof s?.capability === 'string')) return;

  // El alcance de la credencial NO está disponible todavía (lo resuelve el
  // middleware de pago, que corre después), así que se lee acá en modo
  // solo-lectura. Ver `services/caller-scope.ts`: no autoriza nada, sólo recorta
  // el conjunto de candidatos; el alcance se sigue haciendo cumplir en
  // `composeService.compose`.
  const scope = await resolveCallerScope(request);
  const resolver = createCapabilityResolver(scope);

  const resolved: ResolvedComposeStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue; // el shape ya se validó en el preHandler anterior.

    if (typeof step.capability !== 'string') {
      // Step nombrado por el llamador: pasa TAL CUAL. `validateComposeStepShape`
      // ya garantizó que trae un `agent` string.
      resolved.push(step as ResolvedComposeStep);
      continue;
    }

    const outcome = await resolver.resolve(step.capability, step.constraints);
    if (!outcome.ok) {
      // WAS-187 AC-4. El `reason` viaja aparte del mensaje para que un cliente
      // pueda distinguir "no existe" de "tu credencial no lo alcanza" sin
      // parsear texto.
      return reply.status(422).send({
        error: outcome.failure.message,
        code: 'no_agent_match',
        reason: outcome.failure.reason,
        capability: step.capability,
        step: i,
        requestId: request.id,
      });
    }

    logCapabilityChoice(step.capability, outcome.agent, String(request.id));

    // Se fija el slug Y el registry CANÓNICOS del agente resuelto (no los del
    // body): es lo que hace que el step keyee igual en el precio, en el destino
    // del cap y en la resolución del ejecutor. `capability` se conserva para que
    // la procedencia quede en la respuesta vía `resolvedFrom`.
    resolved.push({
      ...step,
      agent: outcome.agent.slug,
      registry: outcome.agent.registry,
      resolvedFrom: { capability: step.capability },
    });
  }

  request.composeResolvedSteps = resolved;
}

/**
 * HU-208: el pipeline que se va a cotizar y ejecutar. Es el resuelto si hubo
 * capacidades; si no, el del body (byte-idéntico al comportamiento previo).
 *
 * Un solo lector compartido por el preHandler de precio y el route handler: si
 * cada uno eligiera el arreglo por su cuenta, se podría cotizar sobre uno y
 * ejecutar el otro.
 */
function readComposeSteps(request: FastifyRequest): ComposeStep[] {
  const body = request.body as { steps?: ComposeStep[] } | undefined;
  return request.composeResolvedSteps ?? body?.steps ?? [];
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
  // HU-208: se retiene el precio cotizado POR STEP para poder compararlo después
  // contra el realmente cobrado (`reportComposePriceDrift`). Puramente aditivo:
  // no participa de ninguna suma ni de ninguna decisión de dinero.
  const quoted: number[] = [step0Usd];
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
      quoted.push(PLACEHOLDER_FEE_USD);
      continue;
    }
    const price = await resolveAgentPriceUsdc(step.agent, step.registry);
    // Mirror the per-step fallback: agent-not-found / 0 / null / NaN → placeholder.
    const stepUsd =
      typeof price === 'number' && price > 0 && !Number.isNaN(price)
        ? price
        : PLACEHOLDER_FEE_USD;
    pipelineUsd += stepUsd;
    quoted.push(stepUsd);
  }
  request.composeQuotedPricesUsd = quoted;
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
  //
  // HU-208: el monto sale de `resolveStep0DebitUsd`, la MISMA función con la que
  // el middleware calculó el débito (invariante #4 de `lib/step0-refund.ts`).
  // Antes se leía `request.composeEstimatedCostUsd` directo, y eso DIVERGÍA del
  // débito real: cuando el preHandler de precio no llega a inyectar ese campo, el
  // middleware igual debita `PLACEHOLDER_FEE_USD` ($1) por el fallback de
  // `resolveStep0DebitUsd` — pero este refund veía `undefined` y no devolvía
  // NADA. O sea, cobrado por nada. `step0-debit.ts` se creó justamente para que
  // débito y crédito no puedan calcularse por separado; compose era el único que
  // seguía calculándolo por su cuenta.
  //
  // Con el campo inyectado (el 99.99% de los requests) el valor es idéntico al
  // de antes: `resolveStep0DebitUsd` devuelve `composeEstimatedCostUsd` cuando es
  // un número. Y nunca puede reembolsar de más, porque es exactamente lo que se
  // debitó.
  const debitedUsd = resolveStep0DebitUsd(request);
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

  // HU-194: clave del refund LÓGICO del step-0. Slot propio (`compose-step0`),
  // distinto de los slots per-step de `services/compose.ts`: son refunds
  // legítimos DISTINTOS de la misma request y no deben colapsarse. La MISMA
  // clave va al credit y a los dos enqueue, así el reintento del sweep no
  // acredita de nuevo un crédito que ya commiteó.
  const idem = {
    idemKey: refundIdemKey({
      keyId: request.a2aKeyRow.id,
      chainId: refundChainId,
      operationId: requestRefundIdemBase(request),
      slot: 'compose-step0',
    }),
  };

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
          idem,
          request.composeDestination,
        )
      : request.keySessionContext
        ? await budgetService.creditSession(
            request.keySessionContext.sessionId,
            request.keySessionContext.ownerRef,
            request.keySessionContext.keyId,
            refundChainId,
            refundUsd,
            idem,
            request.composeDestination,
          )
        : request.composeDestination
          ? await budgetService.creditWithDest(
              request.a2aKeyRow.id,
              refundChainId,
              refundUsd,
              request.a2aKeyRow.owner_ref,
              request.composeDestination,
              idem,
            )
          : await budgetService.credit(
              request.a2aKeyRow.id,
              refundChainId,
              refundUsd,
              request.a2aKeyRow.owner_ref,
              idem,
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
        idemKey: idem.idemKey,
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
        // HU-194: MISMA clave que el credit que tiró (el error puede ser del
        // read de la respuesta, no de la acción) y que el `refund-failed`.
        idemKey: idem.idemKey,
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
  // HU-208: se cotiza sobre el pipeline RESUELTO, no sobre el body crudo. Es lo
  // que hace que el precio del step-0 (el que se debita), el destino canónico del
  // cap y el monto del challenge x402 correspondan al agente que efectivamente se
  // va a ejecutar. Sin capacidades, `readComposeSteps` devuelve `body.steps` y
  // este handler se comporta byte-idéntico a antes.
  const steps = readComposeSteps(request);

  // CD-15: shape validation la hace el route handler (líneas 40-58 originales).
  if (steps.length === 0) {
    return;
  }

  const firstStep = steps[0];
  if (!firstStep || typeof firstStep.agent !== 'string') {
    return;
  }
  const firstAgent = firstStep.agent;

  try {
    const price = await resolveAgentPriceUsdc(firstAgent, firstStep.registry);

    if (price === null) {
      // AC-3: agente no existe → 404, NO debit. CD-10: middleware short-circuited.
      // Fastify 5 idiom: `return reply...` para abortar el preHandler lifecycle
      // ANTES del middleware de debit (requirePaymentOrA2AKey). El `return reply`
      // explícito hace que el código matchee el comentario "NO debit / middleware
      // short-circuited" sin depender del bare-return.
      return reply.status(404).send({
        error: `Agent not found: ${firstAgent}`,
        error_code: 'AGENT_NOT_FOUND',
      });
    }

    // WKH-125 BLQ-ALTO-1 (fix-pack): resolver el destino canónico desde el
    // AGENTE RESUELTO por discovery (no del body crudo). Espeja la resolución
    // del per-step → step-0 keyea idéntico → el cap se evalúa aunque el caller
    // omita `registry`. `price !== null` ya garantiza que el agente existe.
    const resolved = await resolveAgentDestination(
      firstAgent,
      firstStep.registry,
    );
    const composeDestination = resolved
      ? deriveComposeDestination(resolved)
      : undefined;

    // ── WKH-360 · SITIO 1 del guard de capa 1 (AC-4, step 0) · 💰 ────────────
    // ESTE guard corta ANTES DEL DINERO, y por eso vive acá y no en el route
    // handler: este preHandler está en el array en la posición ANTERIOR a
    // `...requirePaymentOrA2AKey(`, que es EL DÉBITO del step-0 de /compose
    // (`src/middleware/a2a-key.ts`). El `return reply...` aborta el preHandler
    // lifecycle antes de ese middleware — el mismo idiom que los tres hermanos de
    // este handler (`AGENT_NOT_FOUND` ×2 y `REGISTRY_UNAVAILABLE`), y por el mismo
    // motivo que el comentario del guard de `price === null` ya explica.
    //
    // El step-0 NO lo cubre el guard del loop de `executePipeline`: para cuando el
    // service existe, el middleware ya cobró. Y NO se pone en
    // `augmentX402ChallengeAmount` aunque ésa ya recorra los steps 1..N
    // pre-débito, porque sus DOS call-sites la envuelven en `.catch()`: un guard
    // dentro de un bloque best-effort es un guard que se puede tragar.
    //
    // El conjunto de identidad de ESTE sitio lleva `hint`: es el único de los
    // cuatro donde hay un `FastifyRequest`, y `request.hostname` (fastify 5, sin
    // puerto) es el host por el que entró la petición. CON `A2A_SELF_HOSTS` o
    // `BASE_URL` puestas, agrandar el conjunto sólo produce MÁS rechazos (ver la
    // monotonía en `lib/contracting-chain.ts`). ⛔ Sin esas dos envs el caller no
    // agranda el conjunto: lo DEFINE, y con un `Host` ilegible lo VACÍA y este
    // guard vuelve al estado inerte (AR-it2/BLQ-MED-2, testigo `T-L1-2e`).
    const { hosts: selfHosts } = resolveSelfHosts(request.hostname);
    if (resolved && isSelfDestination(resolved.invokeUrl, selfHosts)) {
      request.log.warn(
        {
          slug: firstAgent,
          registry: firstStep.registry ?? null,
          layer: 'direct',
          site: 'compose-price-prehandler',
        },
        'contracting-loop.blocked',
      );
      return reply.status(400).send({
        error: contractingErrorMessage(CONTRACTING_LOOP_DETECTED),
        error_code: CONTRACTING_LOOP_DETECTED,
        layer: 'direct',
      });
    }
    if (resolved && !resolved.invokeUrl) {
      // TRAMPA 1: producción no puede producirlo (`Agent.invokeUrl` es requerido
      // en el tipo, así que el chequeo es por FALSY y no por `=== undefined`, que
      // tsc rechazaría como comparación imposible), un factory de `vi.mock` sí.
      // Se loguea el slug, NUNCA la URL.
      request.log.warn(
        { slug: firstAgent },
        'contracting-loop.destination-unreadable',
      );
    }

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
        error: `Agent not found: ${firstAgent}`,
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
          slug: firstAgent,
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
        steps,
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
    await augmentX402ChallengeAmount(request, steps, price).catch((e) => {
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
        slug: firstAgent,
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

/**
 * WKH-225 — la autorización para que ESTE pipeline pueda suspender, o `null`.
 *
 * Dos condiciones, las dos necesarias:
 *
 *  1. la bandera es el string EXACTO `'true'` (`isComposeSuspendEnabled`);
 *  2. el caller es BINDEABLE — `resolveResumeCaller` devuelve `null` para un
 *     caller x402 puro o anónimo. Sin credencial exacta no hay a qué atar el
 *     token de reanudación, y un token que puede redimir cualquiera no es una
 *     credencial. Ese pipeline se comporta exactamente como hoy.
 *
 * ⚠️ `frozenPricesExpireAtMs` NO SE POBLA ACÁ, Y NO ES UN OLVIDO. El único
 * productor de precios congelados es `/orchestrate/execute` (WKH-303), y
 * `/orchestrate` no puede suspender: no construye este campo. O sea que hoy
 * ningún run suspendido lleva precios congelados, y el `LEAST` del trigger
 * queda inerte por falta de entrada, no por falta de código. El día que un
 * quote llegue por acá, el recorte ya está del lado de Postgres.
 */
function buildSuspensionAuthz(
  request: FastifyRequest,
  ttlSeconds: number | undefined,
): {
  caller: ResumeCaller;
  ownerRef: string;
  keyId: string;
  ttlSeconds?: number;
} | null {
  if (!isComposeSuspendEnabled()) return null;
  const caller = resolveResumeCaller(request);
  if (caller === null) return null;
  const keyRow = request.a2aKeyRow;
  if (!keyRow) return null;
  return {
    caller,
    ownerRef: keyRow.owner_ref,
    keyId: keyRow.id,
    // CD-9 (exactOptionalPropertyTypes): NO poner `ttlSeconds: undefined`.
    ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
  };
}

/**
 * 🔴 FIX-PACK AR/BLQ-ALTO-2 — EL DÉBITO DEL PRIMER STEP DEL TRAMO REANUDADO.
 *
 * ── EL AGUJERO QUE CIERRA
 *
 * `executePipeline` SIEMPRE arranca en `i = 0`, y su débito per-step está detrás
 * de `if (i > 0 && …)` (CD-11/CD-7) porque en `/compose` el índice 0 lo debita el
 * middleware de pago. En la reanudación NO hay middleware que lo debite:
 * `requireA2AKey` es "SIN débito" y lo dice en su propio docblock
 * (`src/middleware/a2a-key.ts`). Resultado medido: el primer step del tramo
 * restante se ejecutaba, `signAndSettleDownstream` le pagaba al agente desde el
 * wallet del operador, `totalCost` lo sumaba y el fee de protocolo se cobraba
 * sobre esa base — y `budgetService.debit` NUNCA se llamaba. Un step gratis por
 * reanudación, repetible a voluntad con un agente propio que devuelva
 * `{a2a_suspend:true}` como step 0.
 *
 * ── LA OPCIÓN QUE SE ELIGIÓ, Y POR QUÉ NO LA OTRA
 *
 * El AR ofrecía dos: (i) re-usar `requirePaymentOrA2AKey` con un preHandler que
 * inyecte `composeEstimatedCostUsd`, o (ii) debitar explícitamente en el
 * handler. Se eligió (ii), y (i) es **estructuralmente imposible acá**: para
 * saber cuál es el primer step restante hay que CLAIMEAR el run, y el claim
 * necesita el `owner_ref` del caller autenticado (CD-4), que lo puebla el propio
 * middleware de auth. Un preHandler de precio tendría que consultar la base
 * ANTES de saber quién pregunta, que es justo lo que AC-4 prohíbe. `/compose`
 * puede hacerlo porque su primer step viene en el body.
 *
 * ⛔ EL GUARD `i > 0` DE `services/compose.ts` NO SE TOCA (CD-7): sigue
 * byte-idéntico. Este débito vive AFUERA del bucle, exactamente como el del
 * middleware para `/compose`.
 *
 * ── LO QUE SE ESPEJA DE `/compose`, LÍNEA POR LÍNEA
 *
 * 🔒 ESTAS CINCO VIÑETAS SON CINCO ASERCIONES, no prosa (fix-pack CR/CR-3):
 * `test/wkh225-resume-step0-mirrors-compose.test.ts` las verifica en los DOS
 * lados en cada `npm test`. Una lista mantenida a mano es cierta el día que se
 * escribe y se vuelve falsa sin que nadie la edite; ésta se pone roja. Si sacás
 * una viñeta de acá, sacá su entrada de allá en el MISMO commit — y al revés.
 * Lo que el guardián NO mide (valores, y una divergencia que conserve los
 * símbolos) está escrito en su docblock; leelo antes de apoyarte en su verde.
 *
 *  · el precio y el destino salen del MISMO par que usa `resolveComposePriceHandler`
 *    (`resolveAgentPriceUsdc` + `resolveAgentDestination` + `deriveComposeDestination`),
 *    así el string del cap por destino coincide byte a byte entre débito y refund;
 *  · el gas overhead per-step se suma igual que en el step-0 y en los steps 1..N;
 *  · el precio CONGELADO gana sobre el vivo cuando existe (WKH-303), y llega ya
 *    re-indexado desde la fila (fix-pack BLQ-BAJO-1);
 *  · el fallback honesto `PLACEHOLDER_FEE_USD` para un precio 0 de un agente que
 *    SÍ existe (CD-4), y NADA de débito para un agente que no resuelve — ése lo
 *    404ea el pipeline sin haber cobrado;
 *  · y los tres campos del `request` (`resolvedChainId`, `composeEstimatedCostUsd`,
 *    `composeDestination`) se setean SÓLO si el débito se aplicó, porque son lo
 *    que `refundComposeStep0` lee. Setearlos antes dejaría a `resolveStep0DebitUsd`
 *    devolviendo `PLACEHOLDER_FEE_USD` ($1) y el refund devolvería plata que
 *    nunca se debitó — el mismo bug con el signo cambiado.
 */
type ResumeStep0Debit =
  | { ok: true; debitedUsd: number }
  /** Pre-débito: no se pudo cotizar. NADA se tocó ⇒ el run puede reabrirse. */
  | { ok: false; reason: 'unresolvable' }
  /**
   * El débito se PIDIÓ y `budgetService.debit` devolvió `success: false`.
   *
   * ⚠️ ESO NO DICE «nada aplicado» — acá lo decía, y era una certeza que el
   * shape no da (fix-pack AR/MNR-10). En las CUATRO rutas de
   * `budgetService.debit` el fallo sale por un canal que mezcla el rechazo con
   * el no-sé: las de sesión y delegación desde la cola de un `catch`, y las dos
   * master desde el `error` de `supabase.rpc`, que trae también los fallos de
   * TRANSPORTE. Un rechazo por saldo y un timeout POSTERIOR al commit de la RPC
   * producen el MISMO valor. Lo único que este `reason` afirma es que **la base
   * no confirmó el débito**; la disposición puede ser DESCONOCIDA.
   * Es el patrón que este repo ya tiene escrito —"no pude preguntar" ≠ "no
   * pasó"— y que esta misma ruta respeta más abajo con el fee, que sí distingue
   * `unknown` de `not_charged`.
   *
   * POR QUÉ `failed` SIGUE SIENDO LO CORRECTO bajo esa incertidumbre: es el
   * lado seguro. `reopen` devolvería el run a `suspended` con el MISMO token,
   * o sea ofrecería un segundo intento sobre un débito que pudo haberse
   * aplicado ⇒ doble cobro. `failed` es terminal y no vuelve a cobrar. El costo
   * es que un rechazo legítimo por saldo tampoco se puede reintentar — que es
   * exactamente lo que `/compose` hace hoy con su step 0. Paridad, no invento.
   *
   * ⛔ DISCRIMINAR el fallo de saldo del de transporte NO se hace acá: pide un
   * tercer estado en `budgetService.debit` y toca el camino del dinero de
   * `/compose`, no sólo el de `/compose/resume`. Queda declarado como
   * `TD-225-02` (ver `auto-blindaje.md`), no implementado.
   */
  | { ok: false; reason: 'rejected'; error: string; capExceeded: boolean };

async function debitResumedFirstStep(
  request: FastifyRequest,
  step: ResolvedComposeStep | undefined,
  chainId: number | undefined,
  frozenFirstPriceUsd: unknown,
): Promise<ResumeStep0Debit> {
  const keyRow = request.a2aKeyRow;
  // Misma precondición que el guard del bucle (`scopingKeyRow && chainId !==
  // undefined`): sin key o sin cadena resuelta, el pipeline original tampoco
  // debitó ninguno de sus steps, y cobrar acá sería asimétrico.
  if (!keyRow || chainId === undefined || step === undefined) {
    return { ok: true, debitedUsd: 0 };
  }
  const slug = step.agent;
  if (typeof slug !== 'string' || slug.length === 0) {
    return { ok: true, debitedUsd: 0 };
  }

  let price: number | null;
  let resolved: { registry: string; slug: string; invokeUrl?: string } | null;
  let gasOverhead: number;
  try {
    price = await resolveAgentPriceUsdc(slug, step.registry);
    resolved = await resolveAgentDestination(slug, step.registry);
    // G-02 fail-closed: en mainnet sin overhead configurado esto LANZA, y
    // dejarlo propagar cobraría un step cuyo gas no se recupera.
    gasOverhead = await getStepGasOverheadUsd(chainId);
  } catch {
    return { ok: false, reason: 'unresolvable' };
  }

  // El agente no existe (o el catálogo lo da como fantasma): CERO débito. El
  // pipeline lo va a 404ear por su cuenta, sin haber cobrado nada — el mismo
  // desenlace que el guard `price === 0 && resolved === null` de `/compose`.
  // El chequeo es por FORMA y no `=== null`: un catálogo que devuelva
  // `undefined` es tan "no resuelve" como uno que devuelva `null`, y tratarlo
  // distinto sería debitar por un agente que nadie pudo cotizar.
  if (typeof price !== 'number' || !resolved)
    return { ok: true, debitedUsd: 0 };

  const destination = deriveComposeDestination(resolved);
  const frozen =
    typeof frozenFirstPriceUsd === 'number' &&
    Number.isFinite(frozenFirstPriceUsd) &&
    frozenFirstPriceUsd > 0
      ? frozenFirstPriceUsd
      : null;
  const invalidPrice = !Number.isFinite(price) || price <= 0;
  if (frozen === null && invalidPrice) {
    request.log.warn(
      { reason: 'registry-miss', slug, step: 0 },
      'compose-resume.price.fallback',
    );
  }
  const amountUsd =
    (frozen ?? (invalidPrice ? PLACEHOLDER_FEE_USD : price)) + gasOverhead;

  const debited = await budgetService.debit(
    keyRow.id,
    chainId,
    amountUsd,
    request.delegationContext,
    request.keySessionContext,
    destination,
    keyRow.owner_ref, // Ownership Guard: el owner_ref del caller AUTENTICADO.
  );
  if (!debited.success) {
    return {
      ok: false,
      reason: 'rejected',
      error: debited.error ?? 'insufficient budget',
      capExceeded: debited.error === 'DEST_CAP_EXCEEDED',
    };
  }

  // ⛔ RECIÉN ACÁ. Ver el docblock: estos tres campos son la ENTRADA de
  // `refundComposeStep0`, y ponerlos antes del débito haría que un fallo del
  // débito habilitara un refund de plata que nunca salió.
  request.resolvedChainId = chainId;
  request.composeEstimatedCostUsd = amountUsd;
  request.composeDestination = destination;
  return { ok: true, debitedUsd: amountUsd };
}

/**
 * WKH-225 — el mapeo del desenlace del claim a HTTP.
 *
 * Exemplar: `src/routes/agent-links.ts`, que ya traduce el mismo vocabulario
 * (`LINK_NOT_FOUND` → 404, `LINK_EXPIRED` → 410, `LINK_ALREADY_USED` → 409,
 * indisponible → 503) con bodies `{ error_code }` en snake.
 *
 * 🔴 AC-6: el body del `not_found` es BYTE-IDÉNTICO al de un run inexistente,
 * porque son EL MISMO body — el service ya colapsó los dos casos en el mismo
 * `reason`, y el service pudo hacerlo porque el RPC levanta el mismo literal.
 * Los tres eslabones tienen que decir lo mismo o el más hablador anula a los
 * otros dos.
 */
const RESUME_CLAIM_HTTP: Record<
  'not_found' | 'expired' | 'already_used' | 'unavailable',
  { status: number; code: string }
> = {
  not_found: { status: 404, code: 'RUN_NOT_FOUND' },
  expired: { status: 410, code: 'RUN_EXPIRED' },
  already_used: { status: 409, code: 'RUN_ALREADY_USED' },
  unavailable: { status: 503, code: 'RESUME_UNAVAILABLE' },
};

const composeRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: ComposeBody }>(
    '/',
    {
      config: { rateLimit: orchestrateRateLimit() },
      preHandler: [
        // WKH-360 (AC-5/AC-6): la CAPA 2 va PRIMERA de toda la cadena — antes de la
        // validación de forma, antes de la resolución de capacidades, antes del
        // preHandler de precio y, sobre todo, antes de `requirePaymentOrA2AKey`. Un
        // request cuya traza ya nos contiene, o que llegó al techo de profundidad, no
        // tiene por qué costar ni una consulta al catálogo, y mucho menos un débito.
        contractingGuardHandler,
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
        // HU-208: resolver las capacidades a agentes concretos ANTES del
        // preHandler de precio (y por lo tanto antes del débito / del 402). Ver
        // su docstring: es lo que hace que se cotice y se ejecute EL MISMO
        // pipeline. No-op cuando ningún step declara `capability`.
        resolveComposeCapabilitiesHandler,
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

      // HU-208: el pipeline que se EJECUTA es el resuelto (el mismo que se cotizó
      // y por el que se debitó el step-0). Sin capacidades es `body.steps`.
      const steps = readComposeSteps(request);

      // HU-208 defense-in-depth: ningún step sin resolver puede llegar al
      // ejecutor. Inalcanzable mientras el resolver siga en la cadena (y el tipo
      // `ResolvedComposeStep` lo hace un error de compilación), pero si alguien lo
      // reordena fuera, un step con `capability` llegaría con `agent: undefined` y
      // moriría a mitad del pipeline, DESPUÉS de settlear el prefijo 0..i-1.
      //
      // A diferencia del 400 de arriba, este SÍ reembolsa el step-0 antes de
      // responder: acá ya pasamos por el middleware de pago, así que el débito
      // está aplicado y no vamos a ejecutar nada por él. "Cobrado por nada" es
      // justo el modo de fallo contra el que este archivo viene endurecido
      // (HIGH-2 / AUDIT A1 / BLQ-MED-1); copiar la forma sin reembolso del guard
      // de arriba propagaría un patrón que ya sabemos malo. Es gratis porque la
      // rama es inalcanzable — y si algún día deja de serlo, ya está bien.
      const unresolvedIndex = findUnresolvedStepIndex(steps);
      if (unresolvedIndex !== -1) {
        await refundComposeStep0(request, 0);
        return reply.status(400).send({
          error: `Step ${unresolvedIndex} was not resolved to an agent`,
          code: 'VALIDATION_ERROR',
          step: unresolvedIndex,
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

      // La credencial CRUDA del caller, derivada con la MISMA extracción que usa
      // el middleware de auth (`extractRawKey`: `x-a2a-key` O
      // `Authorization: Bearer wasi_a2a_*`). `compose.invokeAgent` la usa para
      // reenviar el header `x-a2a-key` al agente cuando su registry es
      // system-trusted (C1, auditoría 2026-07-01).
      //
      // C2 (auditoría 2026-07-01): antes esto leía SÓLO `x-a2a-key`, así que un
      // caller autenticado por `Authorization: Bearer` (con budget YA debitado y
      // `scopingKeyRow` seteado) se veía SIN key desde compose → `invokeAgent`
      // tomaba la rama del EIP-3009 firmado por el operador (`!a2aKey`).
      //
      // ⚠️ HU-DOUBLE-PAY — ESTE COMENTARIO AFIRMABA DE MÁS Y ESO ESCONDIÓ EL BUG.
      // Decía que propagar la credencial servía "para saltear el inbound x402 de
      // Pieverse (roto upstream, WKH-45)". Eran dos afirmaciones falsas: (a) esa
      // rama NO era un leg inbound sino un SEGUNDO pago de salida al agente,
      // firmado con `OPERATOR_PRIVATE_KEY`; y (b) no estaba rota — con
      // `KITE_FACILITATOR_MODE=x402` el adapter se desvía a `settleX402()`
      // (`adapters/kite-ozone/payment.ts`) y nunca toca `/v2/settle` de Pieverse.
      // Mientras el comentario decía "camino muerto", el leg pagaba de verdad.
      // Ese leg se borró; lo que queda acá es la propagación de la credencial.
      const a2aKey = extractRawKey(request);
      // Array PRESTADO al pipeline para los motivos INTERNOS de skip. Es un
      // INPUT y no un campo del `ComposeResult` porque abajo se hace
      // `reply.send({ ..., ...result })` sin schema de respuesta: cualquier cosa
      // que viva en el resultado sale por HTTP, y estos códigos son los que
      // `toPublicSkipCode` genericiza para no filtrar flags, allow-list de
      // mainnet ni estado de la wallet del operador.
      const downstreamSkipCauses: DownstreamSkipCode[] = [];

      // ── WKH-225 · el TTL de la espera, validado ANTES de invocar nada ─────
      // Fuera de rango es un 400 y punto: acá todavía no se ejecutó ningún
      // step, así que rechazar no cuesta plata. Validarlo después habría
      // significado descubrirlo cuando el step de KYC ya cobró.
      const ttlPedido = request.body.suspendTtlSeconds;
      if (
        ttlPedido !== undefined &&
        resolveSuspendTtlSeconds(ttlPedido) === null
      ) {
        await refundComposeStep0(request, 0);
        return reply.status(400).send({
          error: `suspendTtlSeconds must be an integer between ${SUSPEND_MIN_TTL_SECONDS} and ${suspendMaxTtlSeconds()}`,
          error_code: 'INVALID_SUSPEND_TTL',
          requestId: request.id,
        });
      }
      const suspensionAuthz = buildSuspensionAuthz(request, ttlPedido);

      const result = await composeService.compose({
        downstreamSkipCauses,
        // HU-208: `steps` (resuelto), NO `body.steps`. `findUnresolvedStepIndex`
        // acaba de garantizar que todos traen un `agent` string, que es lo que
        // permite el narrowing a `ResolvedComposeStep[]` que exige el service.
        steps: steps as ResolvedComposeStep[],
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
        // WKH-360 (AC-7): la traza entrante YA VALIDADA por `contractingGuardHandler`
        // (primer preHandler de esta cadena). El service la usa para EMITIR la traza
        // saliente con nuestro eslabón y la profundidad incrementada. Ausente ⇒
        // cadena vacía y profundidad 0, que es el 100% del tráfico de hoy.
        //
        // `exactOptionalPropertyTypes` está activo, así que se spreadea condicional
        // en vez de asignar `undefined`.
        ...(request.contractingChain !== undefined && {
          contractingChain: request.contractingChain,
        }),
        ...(request.contractingDepth !== undefined && {
          contractingDepth: request.contractingDepth,
        }),
        // WKH-360 (fix-pack AR/CR BLQ-MED-1): el `Host` por el que entró ESTA
        // petición, para que los SITIOS 3 y 4 (dentro del service, donde no hay
        // `FastifyRequest`) tengan identidad propia sin configuración. Sin esto,
        // con `BASE_URL` y `A2A_SELF_HOSTS` ausentes el conjunto de identidad del
        // pipeline queda `[]` y el guard de los steps 1..N —donde vive el `5^k`—
        // queda inerte. Mismo valor que ya consume el SITIO 1 doce líneas más
        // arriba en este archivo; se pasa por el request y no se re-resuelve
        // adentro para que los cuatro sitios comparen contra el MISMO conjunto.
        selfHostHint: request.hostname,
        // ── WKH-225 (AC-9) · la autorización para SUSPENDER ─────────────────
        // Se construye SÓLO si la bandera es el string exacto `'true'` Y el
        // caller es bindeable. `resolveResumeCaller` devuelve `null` para un
        // caller x402 puro / anónimo: sin credencial exacta no hay a qué atar
        // el token, y un token que cualquiera puede redimir no es una
        // credencial. Fail-closed, y ese pipeline se comporta como hoy.
        //
        // ⛔ ESTE ES EL ÚNICO SITIO DEL REPO QUE CONSTRUYE ESTE CAMPO, y el
        // testigo `T-SUSP-CALLSITE` lo clava leyendo `services/orchestrate.ts`.
        ...(suspensionAuthz === null ? {} : { suspension: suspensionAuthz }),
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

      // ── WKH-225 · 202: el pipeline quedó ESPERANDO ────────────────────────
      //
      // 🔴 EL ORDEN DE ESTAS TRES RAMAS ES LOAD-BEARING, y de las tres esta es
      // la del medio:
      //
      //  · ARRIBA queda el `if (reply.sent)` — el 504 del timeout, que
      //    reembolsa. Un run que suspendió DESPUÉS de que la reply salió no
      //    puede responder 202: ya se le respondió al caller.
      //  · ABAJO queda `if (!result.success)`, que reembolsa el step-0. Un
      //    suspendido NO falló: reembolsarle el step-0 sería devolverle plata
      //    por un trabajo que sí se hizo y que se va a terminar.
      //  · Y MÁS ABAJO todavía queda el cobro del fee de protocolo. ⛔ CD-18:
      //    el fee NO se cobra acá. Ese bloque idempotiza por `request.id`, y el
      //    `POST /compose/resume` llega con OTRO `request.id` ⇒ se cobraría una
      //    vez sobre el pipeline PARCIAL y otra vez al reanudar. Doble cobro,
      //    plata real. El fee se cobra UNA vez, al completar, sobre el total
      //    acumulado, y con `compose_run_id` como clave.
      if (result.suspended) {
        // Los skips del prefijo ya ejecutado tienen que quedar en el evento
        // igual que en las otras dos ramas: un pipeline que suspende no es un
        // pipeline sin telemetría.
        noteDownstreamSkips(request, result.steps, downstreamSkipCauses);
        return reply.status(202).send({
          // 🔴 FIX-PACK AR/MNR-5 — `success` VIAJA. Las otras dos ramas hacen
          // `...result` y por eso lo llevan; ésta enumera los campos y se lo
          // había comido. Todo DT-A1 se justifica sobre que una suspensión es
          // `success: true` (si fuera `false`, `recordStrandedRunIfAny` haría
          // sonar la alerta de plata varada en cada KYC que funciona bien), y
          // ese `true` no salía por HTTP: un cliente que discrimine por
          // `body.success` leía `undefined`.
          //
          // ⛔ `output` sigue SIN viajar, y no es un olvido: lo que el caller
          // tiene que leer es `suspended.artifact`. `output` es la salida cruda
          // del step que suspendió, y el 202 no es el lugar para estrenarla.
          success: result.success,
          verificationStatus: result.verificationStatus,
          suspended: result.suspended,
          // ⛔ Viaja UNA sola vez, en el body de un POST. Nunca en una URL,
          // nunca en un log. No es recuperable después.
          resumeToken: result.resumeToken,
          steps: result.steps,
          totalCostUsdc: result.totalCostUsdc,
          totalLatencyMs: result.totalLatencyMs,
          requestId: request.id,
        });
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
        noteDownstreamSkips(request, result.steps, downstreamSkipCauses);
        return reply.status(status).send({
          ...result,
          requestId: request.id,
        });
      }

      // WKH-118: best-effort 1% protocol fee post-compose (espejo orchestrate.ts:437-482).
      // Idempotencia por request.id; base = result.totalCostUsdc. NUNCA rompe el 200
      // (CD-1): todo error queda en variables locales + console.
      //
      // ⚠️ CD-21 · DOS FRASES DE ACÁ QUEDARON FALSAS CON WKH-360, y se reescriben en
      // el mismo commit que las invalida:
      //  [FALSA] · que en compose ningun campo de fee se serializa en el response
      //  [FALSA] · que el response NO cambia (CD-4)
      // El 200 de `/compose` ahora declara `feeRatePercent`, `protocolFeeStatus` y
      // —cuando se cobró— `protocolFeeUsdc` (AC-10), así que el resultado de ESTE
      // bloque sí es visible para el caller: un fallo del cobro deja
      // `protocolFeeStatus: 'unknown'`. Lo que sigue en pie de CD-1 es que un fallo
      // acá **no rompe el 200 ni cambia el pipeline**.
      //
      // ⛔ CÓMO SE CITA UNA FRASE QUE SE VOLVIÓ FALSA (fix-pack CR/MNR-1). Cada línea
      // que contenga parte de la frase vieja lleva su propio marcador `[FALSA]`. La
      // versión anterior de este comentario reproducía la frase VERBATIM y lo único
      // que la distinguía de un claim vivo era dónde caía el salto de línea: un
      // `grep` del auditor devolvía el hit y el marcador quedaba en OTRA línea. Un
      // marcador por línea es lo que hace que `grep -n` no pueda mentir. Mismo
      // criterio aplicado en `services/orchestrate.ts` (la frase del "cache de 60 s").
      //
      // Lo que SIGUE siendo cierto y es la razón de que `feeChargeTxHash` no se
      // declare: **el txHash del fee NO se serializa**. Publicar el hash de la
      // transferencia del fee expone el movimiento de la wallet de plataforma, y el
      // caller necesita el MONTO, no el hash. La variable quedaría
      // asignada-pero-no-leída (biome `noUnusedVariables`); el txHash que necesita
      // el recibo se lee de `feeResult.txHash` directamente.
      let feeChargeError: string | undefined;
      // WKH-360 (AC-10): la disposición del fee de ESTE gateway, para el 200.
      // Arranca en `'unknown'` — el tercer valor de CD-5 — porque si el bloque de
      // abajo se va por el `catch`, la disposición es DESCONOCIDA, no "no se cobró".
      let protocolFeeStatus: 'charged' | 'not_charged' | 'unknown' = 'unknown';
      let protocolFeeUsdc: number | undefined;
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
          // CD-5: `failed` NO es `not_charged`. Un HTTP que falla no prueba que la
          // transferencia no se transmitió — este mismo camino importa
          // `hasBroadcastEvidence` justamente por eso. La disposición es
          // DESCONOCIDA y el monto se OMITE: "no pude preguntar" ≠ "no pasó".
          protocolFeeStatus = 'unknown';
          log.error({ detail: feeResult.error }, 'fee charge failed');
        } else if (feeResult.status === 'skipped') {
          // CD-5: el `feeUsdc` que trae un `skipped` (WALLET_UNSET) es el monto
          // CALCULADO y NO COBRADO. Reportarlo como cobrado sería una afirmación
          // falsa con formato de dato, así que el monto se OMITE.
          protocolFeeStatus = 'not_charged';
        } else if (
          feeResult.status === 'charged' ||
          feeResult.status === 'already-charged'
        ) {
          protocolFeeStatus = 'charged';
          protocolFeeUsdc = feeResult.feeUsdc;
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

      // HU-208: medir la deriva de precio cotizado-vs-cobrado (ver el docstring).
      // Después del fee y antes de responder; best-effort, no afecta el 200.
      reportComposePriceDrift(request, result);

      const kiteTxHash = request.paymentTxHash;
      // WKH-191x: retiene los skip-codes PÚBLICOS del pipeline para que el evento
      // los persista (`a2a_events.metadata.downstreamSkips`). Aditivo puro: NO lee
      // ni cambia nada del money-path, sólo copia lo que ya viaja en el response.
      noteDownstreamSkips(request, result.steps, downstreamSkipCauses);
      // ── WKH-360 (AC-10/AC-11/AC-12) · el fee, VISIBLE ────────────────────────
      // ADITIVO: todas las claves de antes salen con el mismo nombre y el mismo
      // valor, y ninguna se quita. Con precisión, porque acá decía
      // [FALSA] "la respuesta actual no se mueve un byte"
      // y eso es falso (fix-pack CR/MNR-4): el 200 gana **DOS claves
      // INCONDICIONALES**, `feeRatePercent` y `protocolFeeStatus`, así que ningún
      // response es byte-idéntico al de antes. Lo que sí es cierto, y es lo que AC-12
      // pide, es que el cambio sea **sólo por agregado**: un cliente que lee las
      // claves que le importan no ve ninguna diferencia.
      //
      // Las otras tres SÍ son condicionales: `protocolFeeUsdc` se OMITE salvo que se
      // haya cobrado de verdad (CD-5: nada de ceros fabricados), y los dos campos de
      // cascada quedan AUSENTES si ningún step fue un coordinador — que hoy es el
      // 100% del tráfico, porque ninguno de los 25 agentes de prod emite el sobre.
      //
      // ⚠️ `protocolFeeUsdc` es la pata de PLATAFORMA que este gateway cobró, NO el
      // total del pipeline (el costo ejecutado es `totalCostUsdc`) y NO el
      // `fee_usdc` de la tabla `a2a_protocol_fees`, que es post-split. Este número
      // sale de `FeeChargeResult`, nunca de la tabla.
      return reply.send({
        kiteTxHash,
        ...result,
        feeRatePercent: Number((getProtocolFeeRate() * 100).toFixed(6)),
        protocolFeeStatus,
        ...(protocolFeeUsdc !== undefined && { protocolFeeUsdc }),
        ...rollUpCascadedFee(result.steps.map((s) => s.coordinatorFee)),
      });
    },
  );

  // ══ WKH-225 · POST /compose/resume ════════════════════════════════════════
  //
  // 🔴 EL TOKEN VA EN EL BODY, y eso DIVERGE a propósito del exemplar
  // `src/routes/agent-links.ts`, que toma el suyo del PATH (`req.params.token`).
  // Un token en el path queda en el access log del hosting, en el Referer, y en
  // cualquier proxy del camino. Los logs de esta ruta son value-free: sólo
  // `runId`, el nombre del error y el status. Nunca el token, nunca el
  // artefacto.
  //
  // ── LA CADENA DE preHandlers, Y LA DIVERGENCIA QUE HAY QUE LEER ───────────
  //
  // Es la de `/compose` MENOS el preHandler de precio del step-0… y menos
  // `requirePaymentOrA2AKey`, que se reemplaza por `requireA2AKey`. NO es una
  // simplificación: es un bug de plata evitado. `resolveStep0DebitUsd` cae a
  // `PLACEHOLDER_FEE_USD` cuando nadie inyectó `composeEstimatedCostUsd`, así
  // que dejar el middleware de pago sin el preHandler de precio le habría
  // cobrado UN DÓLAR a cada reanudación — por un step-0 que ya se debitó en el
  // `/compose` original.
  //
  // `requireA2AKey` autentica exactamente igual (master / sesión / delegación),
  // puebla `a2aKeyRow`, `keySessionContext` y `delegationContext` —que es lo que
  // `resolveResumeCaller` necesita— y no debita nada. Y exigir credencial es
  // fail-closed en la dirección correcta: un caller x402 anónimo nunca pudo
  // haber suspendido, porque no es bindeable.
  //
  // ── LA BANDERA NO GATEA ESTA RUTA, Y ES DELIBERADO ────────────────────────
  //
  // Apagar `COMPOSE_SUSPEND_ENABLED` tiene que dejar de CREAR runs suspendidos,
  // no dejar varados a los que ya existen: esos ya gastaron plata del caller.
  // Con la bandera apagada esta ruta sigue siendo alcanzable y sigue sin poder
  // inventar nada — sin filas que reanudar, todo token da 404.
  fastify.post<{ Body: ResumeBody }>(
    '/resume',
    {
      config: { rateLimit: orchestrateRateLimit() },
      preHandler: [
        contractingGuardHandler,
        ...requireForwardKey(),
        createTimeoutHandler(
          parseInt(process.env.TIMEOUT_COMPOSE_MS ?? '180000', 10),
        ),
        ...requireA2AKey(),
      ],
    },
    async (request, reply: FastifyReply) => {
      const token = request.body?.token;
      if (typeof token !== 'string' || token.length === 0) {
        return reply
          .status(400)
          .send({ error_code: 'RESUME_INVALID', requestId: request.id });
      }

      const caller = resolveResumeCaller(request);
      const keyRow = request.a2aKeyRow;
      if (caller === null || !keyRow) {
        // Defensivo: `requireA2AKey` ya garantizó una de las tres credenciales.
        return reply
          .status(400)
          .send({ error_code: 'RESUME_INVALID', requestId: request.id });
      }

      // ── AC-4 · LA FIRMA ANTES QUE TODO, Y ANTES DE TOCAR LA BASE ──────────
      // `verifyResumeToken` valida forma, secreto, estructura y HMAC ANTES de
      // decodificar el payload, y este `return` es lo que hace que un token
      // forjado no produzca NI UNA consulta. El orden ES el criterio de
      // aceptación, no una optimización.
      //
      // ⚠️ `RESUME_EXPIRED` NO corta acá. El `exp` del token es un fast-fail;
      // la autoridad sobre el vencimiento es `expires_at` comparado contra
      // `NOW()` DENTRO del claim — y ese claim es además el único que puede
      // marcar la fila `expired` y dejar constancia del pago varado. Cortar
      // acá ahorraría una consulta y perdería el registro del residuo.
      const verified = verifyResumeToken(token, caller);
      if (!verified.ok && verified.code === 'RESUME_INVALID') {
        return reply
          .status(400)
          .send({ error_code: 'RESUME_INVALID', requestId: request.id });
      }

      const claimed = await suspendedRunService.claim(
        resumeTokenHash(token),
        keyRow.owner_ref,
      );
      if (!claimed.ok) {
        const mapped = RESUME_CLAIM_HTTP[claimed.reason];
        request.log.warn(
          { error_code: mapped.code },
          'compose-resume.rejected',
        );
        return reply
          .status(mapped.status)
          .send({ error_code: mapped.code, requestId: request.id });
      }

      const run = claimed.run;
      const remaining = Array.isArray(run.remaining_steps)
        ? (run.remaining_steps as ResolvedComposeStep[])
        : [];
      const priorSteps = Array.isArray(run.steps_json)
        ? (run.steps_json as StepResult[])
        : [];
      const priorCostUsd = Number(run.total_cost_usdc ?? 0);
      const priorLatencyMs = Number(run.total_latency_ms ?? 0);
      // 🔴 FIX-PACK AR/BLQ-MED-1 — EL TECHO DEL CALLER SOBREVIVE A LA ESPERA.
      // Sin la columna, el tramo reanudado corría con `maxBudget` ausente y
      // `totalCost` en 0: el techo del caller Y el del operador valían una vez
      // por MITAD, o sea el doble para un run suspendido. `null` ⇒ el caller no
      // declaró ninguno, que es el caso normal.
      const callerCeiling =
        run.max_budget_usdc === null ? undefined : Number(run.max_budget_usdc);
      // Fix-pack AR/BLQ-BAJO-1: llegan YA re-indexados contra `remaining_steps`
      // (los recortó `suspendIfEnvelope` con el mismo `slice`), así que el
      // índice 0 de acá es el precio del índice 0 de aquél.
      const frozenPrices = Array.isArray(run.frozen_step_prices)
        ? (run.frozen_step_prices as number[])
        : undefined;
      // Fix-pack AR/MNR-8: el array PRESTADO para los motivos internos de skip.
      // El tramo reanudado perdía la telemetría de skips que la primera mitad sí
      // anotaba, porque se le pasaba un `[]` fijo a `noteDownstreamSkips`.
      const downstreamSkipCauses: DownstreamSkipCode[] = [];

      // ── 🔴 EL DÉBITO DEL PRIMER STEP RESTANTE (fix-pack AR/BLQ-ALTO-2) ────
      // Va ANTES de `compose()` y espeja lo que el middleware de pago hace por
      // `/compose`: el bucle saltea el índice 0 (CD-7, guard intacto) porque da
      // por sentado que alguien lo cobró. Acá ese alguien es esta llamada.
      const step0 = await debitResumedFirstStep(
        request,
        remaining[0],
        run.chain_id ?? undefined,
        frozenPrices?.[0],
      );
      if (!step0.ok && step0.reason === 'unresolvable') {
        // Pre-débito: NADA se tocó. `reopen` (y no `failed`) es exactamente el
        // caso para el que existe — un guard que corre antes de cualquier
        // débito o invoke. El run vuelve a `suspended` con el MISMO token y el
        // MISMO `expires_at` (reabrir no compra tiempo), así que el caller puede
        // reintentar cuando el catálogo o el oráculo de gas vuelvan.
        await suspendedRunService.settle(run.id, run.owner_ref, 'reopen', null);
        return reply.status(503).send({
          error: 'Registry or gas oracle unavailable',
          error_code: 'REGISTRY_UNAVAILABLE',
          requestId: request.id,
        });
      }
      if (!step0.ok) {
        // El débito se PIDIÓ y la base NO lo confirmó (fix-pack AR/MNR-10:
        // acá decía "⇒ nada se aplicó", y el shape no lo garantiza — ver el
        // docblock de `ResumeStep0Debit`). Ya pasamos el punto en el que
        // `reopen` es seguro: la doctrina de este repo lo reserva para los
        // guards PRE-débito, y reabrir sobre un débito cuya disposición no
        // podemos probar es ofrecer un segundo cobro.
        // `failed` es terminal, igual que para cualquier otro fallo del tramo.
        await suspendedRunService.settle(
          run.id,
          run.owner_ref,
          'failed',
          `resumed step debit failed: ${step0.error}`,
        );
        return reply.status(step0.capExceeded ? 402 : 400).send({
          success: false,
          output: null,
          error: `Step 0 debit failed: ${step0.error}`,
          ...(step0.capExceeded
            ? { errorCode: 'DEST_CAP_EXCEEDED' as const }
            : {}),
          steps: priorSteps,
          totalCostUsdc: priorCostUsd,
          totalLatencyMs: priorLatencyMs,
          requestId: request.id,
        });
      }

      // ── AC-8 · SÓLO LOS STEPS QUE FALTAN ─────────────────────────────────
      // El pipeline arranca con `remaining_steps` y NADA MÁS. Los steps 0..i ya
      // se invocaron, ya se settlearon y ya se debitaron: re-ejecutarlos sería
      // cobrarlos dos veces. Lo que se re-agrega DESPUÉS es sólo su registro.
      //
      // 🔴 CD-17 · LOS TRES CAMPOS DE LA TRAZA SE RESTAURAN. Arrancar con
      // `depth: 0` reiniciaría el contador del guard anti-bucle a pedido de
      // quien reanuda, y sin `selfHostHint` el conjunto de identidad quedaría
      // vacío y los dos sitios del guard, INERTES. Sería un bypass ABIERTO por
      // esta HU.
      //
      // ⚠️ Y NO SE VUELVE A AUTORIZAR LA SUSPENSIÓN (no se pasa `suspension`).
      // Un run reanudado corre hasta el final o falla; no puede suspender otra
      // vez. Soportarlo exigiría fusionar los `StepResult` y los espacios de
      // índice de dos ejecuciones dentro de una sola fila, y hacerlo mal pierde
      // la evidencia on-chain de la primera mitad — que es justo lo que la
      // emisión del residuo lee. Queda anotado como límite conocido del corte A.
      const result = await composeService.compose({
        steps: remaining,
        scopingKeyRow: keyRow,
        chainId: run.chain_id ?? undefined,
        logger: request.log,
        // Fix-pack AR/MNR-8: el array prestado, igual que `/compose`.
        downstreamSkipCauses,
        // Fix-pack AR/MNR-2: la MISMA credencial cruda que la primera mitad
        // propagó a los registries system-trusted. Sin esto, un run que arrancó
        // mandando `x-a2a-key` terminaba sin mandarlo, y las dos mitades del
        // mismo pipeline se veían distintas desde el otro lado.
        ...(extractRawKey(request) === undefined
          ? {}
          : { a2aKey: extractRawKey(request) }),
        // 🔴 Fix-pack AR/BLQ-MED-1 — los DOS lados del guard de presupuesto: el
        // techo que declaró el caller y lo que ese mismo run YA gastó contra él.
        // Con `maxBudget` ausente y `preSpentUsd` en 0 (lo de antes), el techo
        // del caller no existía y el del operador se reiniciaba.
        ...(callerCeiling === undefined ? {} : { maxBudget: callerCeiling }),
        preSpentUsd: priorCostUsd,
        contractingChain: Array.isArray(run.contracting_chain)
          ? (run.contracting_chain as string[])
          : [],
        contractingDepth: run.contracting_depth,
        selfHostHint: run.self_host_hint ?? request.hostname,
        ...(frozenPrices === undefined
          ? {}
          : { frozenStepPricesUsd: frozenPrices }),
        ...(request.delegationContext === undefined
          ? {}
          : { delegationContext: request.delegationContext }),
        ...(request.keySessionContext === undefined
          ? {}
          : { keySessionContext: request.keySessionContext }),
      });

      if (reply.sent) {
        // El 504 salió mientras la cola corría. El run queda `resuming`: la fila
        // se cierra como fallida para que no la reclame nadie más.
        //
        // 🔴 Fix-pack AR/BLQ-ALTO-2: ahora esta ruta SÍ debita un step-0, así
        // que este camino también tiene que reembolsarlo. Misma fórmula que
        // `/compose`: `max(0, debitado - lo ya settleado)`, así que lo entregado
        // nunca se devuelve. Sólo corre si el débito se aplicó de verdad — los
        // tres campos que `refundComposeStep0` lee se setean únicamente ahí.
        if (step0.debitedUsd > 0) {
          await refundComposeStep0(request, result.totalCostUsdc);
        }
        await suspendedRunService.settle(
          run.id,
          run.owner_ref,
          'failed',
          'resume timed out',
        );
        return;
      }

      // ── El cierre exactly-once de la fila ────────────────────────────────
      // `failed` y no `reopen`: acá ya corrieron débitos e invocaciones de los
      // steps restantes. `reopen` está reservado para guards PRE-débito, y
      // reabrir después de un débito ambiguo es ofrecer un segundo cobro.
      await suspendedRunService.settle(
        run.id,
        run.owner_ref,
        result.success ? 'resumed' : 'failed',
        result.success ? null : (result.error ?? 'resume failed'),
      );

      // AC-8: el registro COMPLETO del pipeline, no sólo su cola.
      const allSteps = [...priorSteps, ...result.steps];
      const totalCostUsdc = priorCostUsd + result.totalCostUsdc;
      const totalLatencyMs = priorLatencyMs + result.totalLatencyMs;

      noteDownstreamSkips(request, result.steps, downstreamSkipCauses);

      if (!result.success) {
        // Fix-pack AR/BLQ-ALTO-2: el step-0 de ESTE tramo se debitó acá arriba,
        // así que la rama de fallo lo reembolsa igual que `/compose`. Sin esto,
        // un pipeline reanudado que falla dejaba al caller cobrado por un step
        // que no entregó nada.
        if (step0.debitedUsd > 0) {
          await refundComposeStep0(request, result.totalCostUsdc);
        }
        let status = 400;
        if (result.errorCode === 'SCOPE_DENIED') status = 403;
        else if (result.errorCode === 'DEST_CAP_EXCEEDED') status = 402;
        return reply.status(status).send({
          ...result,
          steps: allSteps,
          totalCostUsdc,
          totalLatencyMs,
          requestId: request.id,
        });
      }

      // ── 🔴 CD-18 · EL FEE, UNA SOLA VEZ EN TODA LA VIDA DEL RUN ───────────
      //
      // La clave de idempotencia es `compose_run_id` —el id del run ORIGINAL—,
      // NUNCA `request.id`. El `request.id` del `/compose` que suspendió y el de
      // este `POST /compose/resume` son distintos: con cualquiera de los dos, un
      // run que se suspende y se reanuda pagaría el fee DOS veces. El
      // `compose_run_id` es el único identificador estable a través de la
      // suspensión, y es el mismo con el que se correlaciona el residuo.
      //
      // Y la base es el total ACUMULADO (pre-suspensión + cola), no el de esta
      // mitad: el caller ejecutó un pipeline, no dos.
      //
      // Best-effort, igual que en `/compose`: un fallo del cobro deja
      // `protocolFeeStatus: 'unknown'` y NUNCA rompe la respuesta.
      //
      // 🔴 FIX-PACK CR/CR-2 — EL REPARTO Y EL RECIBO, QUE ESTE BLOQUE NO TENÍA.
      //
      // Este bloque era una copia SIMPLIFICADA del de `/compose`, y la
      // simplificación se había comido dos cosas: el gate `splitsActive()` +
      // `resolveAgentSplitContext(...)` que arma `creator`/`referral`, y el
      // recibo `protocol_fee`. Sin el contexto, `fee-charge.ts` re-rutea el bps
      // del creador y del referral a PLATAFORMA y deja filas `skipped` — lo dice
      // su propio comentario, y no es una inferencia sobre código ajeno.
      //
      // ⚠️ LA DIMENSIÓN, MEDIDA, PORQUE CAMBIA CÓMO SE LEE ESTO. Con la config por
      // defecto (`SPLIT_BPS_PLATFORM=10000`, CREATOR=0, REFERRAL=0) el gate
      // `splitsActive()` es `false`, no hay query extra, `feeParams` sale con las
      // mismas tres claves de antes y el resultado es BYTE-IDÉNTICO. O sea: hoy,
      // en prod, esto NO cambia un centavo de sitio. La divergencia era LATENTE y
      // se materializaba entera el día que alguien pusiera `SPLIT_BPS_CREATOR>0`
      // — y ese día el síntoma (un creador que cobra por los runs normales y no
      // por los reanudados) no lo iba a relacionar nadie con esta HU.
      //
      // Por eso el testigo (`T-RES-FEE-5`/`T-RES-FEE-6`) corre con una config
      // NO-default: con la default pasaría igual estando roto, que es la
      // definición de un test vacío.
      //
      // ⛔ LO QUE NO CAMBIA, y el AR ya aprobó (CD-18): el MONTO total
      // (`feeBaseUsdc` sigue siendo el acumulado), el ORDEN del bloque, y la
      // CLAVE de idempotencia (`compose_run_id`, nunca `request.id`).
      let protocolFeeStatus: 'charged' | 'not_charged' | 'unknown' = 'unknown';
      let protocolFeeUsdc: number | undefined;
      try {
        // WKH-143 (DT-2/DT-5/CD-9/CD-1b), espejado de `/compose`: el creator del
        // agente PRIMARIO, resuelto SOLO cuando `splitsActive()` (gate NO-throw).
        //
        // 🔴 `allSteps[0]`, NO `result.steps[0]`. El agente primario del run es el
        // del PRIMER step del pipeline entero, y en una reanudación ese step ya
        // corrió antes de la suspensión: vive en `priorSteps`, no en la cola.
        // Usar `result.steps[0]` le pagaría el cut del creador al primer agente
        // del TRAMO, que es otro agente. Misma razón por la que `feeBaseUsdc` es
        // el total acumulado: el caller ejecutó UN pipeline, no dos.
        let creator: SplitPartyRef | null = null;
        let referral: SplitPartyRef | null = null;
        if (splitsActive()) {
          const splitCtx = await resolveAgentSplitContext(allSteps[0]?.agent);
          creator = splitCtx.creator;
          referral = splitCtx.referral;
        }
        // CD-8: asignación condicional (exactOptionalPropertyTypes).
        const feeParams: FeeChargeParams = {
          orchestrationId: run.compose_run_id,
          feeBaseUsdc: totalCostUsdc,
          feeRate: getProtocolFeeRate(),
        };
        if (creator) feeParams.creator = creator;
        if (referral) feeParams.referral = referral;
        const feeResult = await chargeProtocolFee(feeParams);
        if (feeResult.status === 'failed') {
          // "No pude preguntar" ≠ "no pasó": la disposición es DESCONOCIDA y el
          // monto se omite.
          protocolFeeStatus = 'unknown';
          log.error({ detail: feeResult.error }, 'resume fee charge failed');
        } else if (feeResult.status === 'skipped') {
          protocolFeeStatus = 'not_charged';
        } else if (
          feeResult.status === 'charged' ||
          feeResult.status === 'already-charged'
        ) {
          protocolFeeStatus = 'charged';
          protocolFeeUsdc = feeResult.feeUsdc;
          // WKH-124: el recibo SOLO si `charged` de verdad (un `already-charged`
          // ya emitió el suyo en la pasada que cobró). Fire-and-forget
          // (CD-6/CD-7): su fallo o su latencia NUNCA afectan la respuesta.
          if (feeResult.status === 'charged') {
            receiptService
              .emit({
                ownerRef: keyRow.owner_ref,
                agentKeyId: keyRow.id,
                sessionId: null,
                delegationId: null,
                receiptType: 'protocol_fee',
                amountUsd: feeResult.feeUsdc,
                // ⚠️ LA ÚNICA DIVERGENCIA DELIBERADA con `/compose`, que usa
                // `request.resolvedChainId ?? 0` a secas. Acá ese campo lo puebla
                // `debitResumedFirstStep` y SÓLO si el débito se aplicó: un tramo
                // cuyo primer step no se cobró (agente sin resolver, o `chain_id`
                // nulo) dejaría el recibo en la cadena 0 teniendo la cadena real
                // guardada en la fila. `run.chain_id` es esa cadena, y es la
                // misma con la que se debitó la primera mitad.
                chainId: request.resolvedChainId ?? run.chain_id ?? 0,
                txHash: feeResult.txHash ?? null,
                counterparty: process.env.WASIAI_PROTOCOL_FEE_WALLET ?? null,
                orchestrationId: run.compose_run_id,
              })
              .catch((e) =>
                log.warn(
                  { detail: e instanceof Error ? e.message : e },
                  '[receipts] emit failed',
                ),
              );
          }
        }
      } catch (e) {
        log.error(
          { detail: e instanceof Error ? e.message : String(e) },
          'resume fee charge threw',
        );
      }

      return reply.send({
        ...result,
        steps: allSteps,
        totalCostUsdc,
        totalLatencyMs,
        runId: run.id,
        feeRatePercent: Number((getProtocolFeeRate() * 100).toFixed(6)),
        protocolFeeStatus,
        ...(protocolFeeUsdc !== undefined && { protocolFeeUsdc }),
        ...rollUpCascadedFee(result.steps.map((st) => st.coordinatorFee)),
      });
    },
  );
};

export default composeRoutes;
