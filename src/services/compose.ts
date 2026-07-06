/**
 * Compose Service -- Execute multi-agent pipelines
 */

import { normalizeChainSlug } from '../adapters/chain-resolver.js';
import { getPaymentAdapter } from '../adapters/registry.js';
import { verifyDefaultChainSettle } from '../adapters/settle-verifier.js';
import { hashCallerRef } from '../lib/caller-hash.js';
import { selectFacilitatorUrl } from '../lib/cdp-selector.js';
import {
  type DownstreamLogger,
  type DownstreamResult,
  signAndSettleDownstream,
} from '../lib/downstream-payment.js';
import { parseFieldErrors } from '../lib/field-error-parser.js';
import { getStepGasOverheadUsd } from '../lib/gas-overhead.js';
import { getLogger } from '../lib/logger.js';
import { PLACEHOLDER_FEE_USD } from '../lib/pricing-constants.js';
import { ssrfFetch } from '../lib/ssrf-dispatcher.js';
import {
  SSRFViolationError,
  validateRegistryUrl,
} from '../lib/url-validator.js';
import type {
  A2AMessage,
  Agent,
  AuthzTarget,
  ComposeRequest,
  ComposeResult,
  ComposeStep,
  LLMBridgeStats,
  RegistryConfig,
  StepResult,
  X402PaymentRequest,
} from '../types/index.js';
import { extractA2APayload, isA2AMessage } from './a2a-protocol.js';
import { authzService } from './authz.js';
import { budgetService } from './budget.js';
import { discoveryService } from './discovery.js';
import { eventService } from './event.js';
import { regenerateInputFromErrors } from './llm/input-retry.js';
import { maybeTransform } from './llm/transform.js';
import { refundOutbox } from './refund-outbox.js';
import { registryService, SYSTEM_OWNER_REF } from './registry.js';
import { normalizeDestination } from './spend-policy.js';
import {
  summarizePipelineVerification,
  verifyStepOutput,
} from './verification.js';

const log = getLogger('compose');

/**
 * B7 (audit 2026-06-24): cache de discover() acotado a un solo compose().
 * `all()` memoiza la MISMA Promise de `discover({limit:50})` — el resultado se
 * comparte entre todos los steps (datos idénticos), sin re-disparar el discovery
 * completo en cada step.
 */
interface DiscoverCache {
  all(): Promise<Agent[]>;
}

function createDiscoverCache(): DiscoverCache {
  let cached: Promise<Agent[]> | undefined;
  return {
    all() {
      if (!cached) {
        cached = discoveryService.discover({ limit: 50 }).then((r) => r.agents);
      }
      return cached;
    },
  };
}

function buildAuthHeaders(
  registry: RegistryConfig | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!registry?.auth?.value) return headers;
  switch (registry.auth.type) {
    case 'header':
      headers[registry.auth.key] = registry.auth.value;
      break;
    case 'bearer':
      headers.Authorization = `Bearer ${registry.auth.value}`;
      break;
  }
  return headers;
}

/**
 * WKH-61: lee category del Agent.metadata con type-guard.
 * Retorna `undefined` si metadata.category no es un string (registries que no
 * exponen category). NO usar `agent.capabilities[0]` como proxy (CD-8).
 */
function readCategory(agent: Agent): string | undefined {
  const meta = agent.metadata as Record<string, unknown> | undefined;
  const cat = meta?.category;
  return typeof cat === 'string' ? cat : undefined;
}

export const composeService = {
  async compose(request: ComposeRequest): Promise<ComposeResult> {
    const { steps, maxBudget, a2aKey, scopingKeyRow, chainId, logger } =
      request;
    const results: StepResult[] = [];
    let totalCost = 0;
    let totalLatency = 0;
    let lastOutput: unknown = null;
    // B7 (audit 2026-06-24): un solo discover() compartido por todo el pipeline.
    const discoverCache = createDiscoverCache();
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      // i < steps.length garantiza step definido; guard explícito para el tipo.
      if (step === undefined) continue;
      const agent = await this.resolveAgent(step, discoverCache);
      if (!agent)
        return {
          success: false,
          output: null,
          steps: results,
          totalCostUsdc: totalCost,
          totalLatencyMs: totalLatency,
          error: `Agent not found: ${step.agent}`,
        };
      // WKH-61: scoping check post-resolve, pre-invoke. Skip si caller es x402
      // (sin keyRow). Aborta el pipeline antes del budget-check para evitar
      // evaluar costo de agentes que la key no puede invocar.
      if (scopingKeyRow) {
        const target: AuthzTarget = {
          registry: agent.registry,
          agent_slug: agent.slug,
          category: readCategory(agent),
        };
        const scope = authzService.checkScoping(scopingKeyRow, target);
        if (!scope.allowed) {
          return {
            success: false,
            output: null,
            steps: results,
            totalCostUsdc: totalCost,
            totalLatencyMs: totalLatency,
            error: `Step ${i} denied by scope: ${scope.reason ?? 'SCOPE_DENIED'}`,
            errorCode: 'SCOPE_DENIED',
            scopeDeniedTarget: {
              registry: agent.registry,
              agent_slug: agent.slug,
              ...(target.category !== undefined && {
                category: target.category,
              }),
            },
          };
        }
      }
      // Gas pass-through (audit 2026-06-25): per-step gateway gas overhead the
      // caller pays ON TOP of the agent price, to cover the downstream settle
      // gas. ALWAYS 0 on testnet / without env config → no behaviour change by
      // default. Gated on chainId being resolved (same precondition as the
      // per-step debit below). NOT settled to the agent (gateway margin).
      const stepGasOverhead =
        chainId !== undefined ? await getStepGasOverheadUsd(chainId) : 0;
      if (
        maxBudget &&
        totalCost + agent.priceUsdc + stepGasOverhead > maxBudget
      )
        return {
          success: false,
          output: null,
          steps: results,
          totalCostUsdc: totalCost,
          totalLatencyMs: totalLatency,
          error: `Budget exceeded: would need ${totalCost + agent.priceUsdc + stepGasOverhead}, max is ${maxBudget}`,
        };
      // WKH-59 (real-price-debit) AC-2: steps 2..N debit atómico via
      // budgetService.debit (PG function increment_a2a_key_spend — CD-2).
      //
      // CD-11: guard `i > 0` es la ÚNICA defensa contra double-debit del
      // step 0 (que ya fue debitado por el middleware via
      // request.composeEstimatedCostUsd). NO REMOVER. AR/CR debe verificar
      // que esta línea sobrevive en futuras HUs.
      //
      // Skip defensivo: si no hay scopingKeyRow (path x402) o chainId
      // (defensive), el debit per-step no aplica. Comportamiento de
      // "fee-on-attempt" consistente con gasless (debit antes de
      // invokeAgent).
      // WKH-128: monto efectivamente debitado en este step (0 si no se debitó).
      // Lo usa el catch de abajo para reembolsar si el step FALLA tras el débito
      // (fee-on-attempt → el caller no debe pagar un step que no entregó valor).
      let stepDebitedUsd = 0;
      // M3 (audit 2026-06-24): destino canónico del step resuelto UNA sola vez,
      // a partir del agente YA resuelto (`agent.registry`/`agent.slug`). Esta
      // ÚNICA fuente se propaga a TODOS los usos del step — el débito per-step,
      // su refund best-effort, y el re-débito del retry adaptativo — para que el
      // string del cap por destino coincida byte a byte entre débito y refund.
      // Sin esto, re-derivar en cada capa permitía que el refund se insertara en
      // otro destino y el cap del destino real nunca se liberara (cap leak).
      // `normalizeDestination` es el MISMO normalizador que usa la policy/ledger.
      const stepDestination = normalizeDestination(
        `${agent.registry}/${agent.slug}`,
      );
      if (i > 0 && scopingKeyRow && chainId !== undefined) {
        // WKH-59 BLQ-MED-1 fix (CD-4 / AC-4): fallback honesto si priceUsdc
        // del agente es 0, null, NaN, o no es un number (config error en el
        // registry). Mismo patrón que el preHandler de step 0 en
        // `src/routes/compose.ts:63-77`, replicado per-step.
        // NOTA OPERACIONAL: NO podemos setear el header
        // `x-debit-fallback: registry-miss` acá — la response ya está en
        // pipeline (los steps 0 corrieron). Esa señal queda exclusiva del
        // preHandler de step 0; en steps 2..N la observabilidad vive en el
        // warn log estructurado (reason='registry-miss', slug, step=i).
        const isInvalid =
          typeof agent.priceUsdc !== 'number' ||
          agent.priceUsdc === 0 ||
          agent.priceUsdc < 0 ||
          Number.isNaN(agent.priceUsdc);
        // Gas pass-through (audit 2026-06-25): the caller is debited the agent
        // price PLUS the per-step gas overhead. `stepGasOverhead` is 0 on
        // testnet / without env → identical to the previous amount. The agent
        // still receives EXACTLY `agent.priceUsdc` downstream (invokeAgent /
        // signAndSettleDownstream are unchanged) — the overhead is gateway
        // margin and never settled to the agent.
        const debitAmount =
          (isInvalid ? PLACEHOLDER_FEE_USD : agent.priceUsdc) + stepGasOverhead;

        if (isInvalid) {
          const warn = logger?.warn?.bind(logger) ?? log.warn.bind(log);
          warn(
            {
              reason: 'registry-miss',
              slug: agent.slug,
              step: i,
            },
            'compose-price.fallback per-step',
          );
        }

        const debitResult = await budgetService.debit(
          scopingKeyRow.id,
          chainId,
          debitAmount,
          request.delegationContext, // WKH-101 (DT-11): enruta al RPC atómico bajo delegación
          request.keySessionContext, // WKH-121 (BLQ-ALTO-1): enruta al RPC de sesión y respeta el cap per-step
          stepDestination, // M3 (audit): destino canónico único del step (WKH-125 cap por destino)
          scopingKeyRow.owner_ref, // F-04 (audit): owner_ref del caller autenticado (no re-derivar de la fila)
        );
        if (!debitResult.success) {
          // DT-H: mid-pipeline debit failure → ComposeResult.error.
          // NO setear errorCode='SCOPE_DENIED' (eso es 403). Route handler
          // mapea a 400 (default), no a 402/403.
          // WKH-125 (AC-2): salvo cap por destino → errorCode='DEST_CAP_EXCEEDED'
          // para que el route lo mapee a 402 (no 400).
          return {
            success: false,
            output: null,
            steps: results,
            totalCostUsdc: totalCost,
            totalLatencyMs: totalLatency,
            error: `Step ${i} debit failed: ${debitResult.error ?? 'insufficient budget'}`,
            ...(debitResult.error === 'DEST_CAP_EXCEEDED'
              ? { errorCode: 'DEST_CAP_EXCEEDED' as const }
              : {}),
          };
        }
        stepDebitedUsd = debitAmount;
      }
      const input =
        step.passOutput && lastOutput
          ? { ...step.input, previousOutput: lastOutput }
          : step.input;
      const startTime = Date.now();
      // WKH-104 (TD-SYBIL): hash HMAC del caller para anti-sybil sin exponer
      // el owner_ref crudo (CD-5/CD-6). null si caller anónimo (x402).
      const callerRefHash = hashCallerRef(scopingKeyRow?.owner_ref);
      try {
        const { output, txHash, downstream } = await this.invokeAgent(
          agent,
          input,
          a2aKey,
        );
        // CD-9: la cola de éxito (StepResult + agregados + bridge + evento)
        // está COMPARTIDA con el retry-ok vía finishSuccessfulStep. No copiar.
        const agg = await this.finishSuccessfulStep({
          agent,
          output,
          txHash,
          downstream,
          startTime,
          steps,
          i,
          results,
          totalCost,
          totalLatency,
          scopingKeyRow,
          callerRefHash,
          discoverCache,
        });
        totalCost = agg.totalCost;
        totalLatency = agg.totalLatency;
        lastOutput = agg.lastOutput;
      } catch (err) {
        const firstError = err instanceof Error ? err.message : String(err);

        // WKH-130: ¿este step es elegible para retry? path master = mismo
        // guard que el refund WKH-128 (sin delegación/sesión, con débito
        // per-step activo). CD-6: delegación/sesión NUNCA reintentan.
        const isMasterPath =
          stepDebitedUsd > 0 &&
          !!scopingKeyRow &&
          chainId !== undefined &&
          !request.delegationContext &&
          !request.keySessionContext;

        // Refund best-effort del débito per-step (WKH-129: con destination si
        // existe). Cerrado sobre las vars del step. Usado para el PASO 1
        // (refund#1) y el PASO 6b (refund del retry-debit) — ambos revierten
        // EXACTAMENTE `stepDebitedUsd` con el destination canónico del agente.
        // Devuelve `true` si no había nada que reembolsar (no-master) o el refund
        // tuvo éxito; `false` si el credit RPC falló. WKH-130 fix-pack (AR/CR
        // obs): el retry SOLO procede si el refund#1 fue exitoso — si falla, no
        // re-debitamos (queda 1 solo débito = peor caso pre-WKH-130, nunca 2x).
        const refundStepDebit = async (): Promise<boolean> => {
          if (!isMasterPath || !scopingKeyRow || chainId === undefined)
            return true;
          // M3 (audit 2026-06-24): el refund DEBE usar EXACTAMENTE el mismo
          // destino canónico que el débito de este step (`stepDestination`,
          // resuelto una sola vez arriba). Antes se re-derivaba acá — si el
          // string divergía del débito, el credit compensatorio del dest-cap se
          // insertaba en otro destino y el cap del destino real nunca se
          // liberaba. Reusar la única fuente garantiza el match byte a byte.
          const creditRes = await budgetService.creditWithDest(
            scopingKeyRow.id,
            chainId,
            stepDebitedUsd,
            scopingKeyRow.owner_ref,
            stepDestination,
          );
          // A2 (audit 2026-06-24): el re-debit del retry adaptativo SOLO procede
          // si el refund REVIRTIÓ DE VERDAD. `creditWithDest` ahora devuelve
          // `success:true` únicamente cuando la RPC afectó >=1 fila (reversión
          // real del dest-cap). Si afectó 0 filas (p. ej. mismatch de destino →
          // la fila compensatoria no se insertó), devuelve `success:false` /
          // `reverted:false` → NO re-debitamos (queda 1 solo débito = peor caso
          // pre-WKH-130, nunca doble consumo del dest-cap).
          const reverted = creditRes.reverted === true && creditRes.success;
          if (!reverted) {
            log.error(
              {
                keyId: scopingKeyRow.id,
                chainId,
                amountUsd: stepDebitedUsd,
                destination: stepDestination,
                step: i,
                reverted: creditRes.reverted ?? false,
                error: creditRes.error,
              },
              '[compose.refund-failed]',
            );
            // M6 (audit 2026-06-24): el refund NO revirtió (0 filas). Encolar para
            // reintento confiable. Invariante anti-doble-refund: solo se encola
            // cuando NADA se aplicó. Best-effort: no rompe el pipeline.
            await refundOutbox.enqueueRefund({
              keyId: scopingKeyRow.id,
              chainId,
              amountUsd: stepDebitedUsd,
              ownerRef: scopingKeyRow.owner_ref,
              destination: stepDestination,
              reason: 'compose.refund-failed',
            });
          }
          return reverted;
        };

        // ── PASO 2 (pre-evaluado): ¿hay field-errors parseables? Solo path
        //    master (CD-6) y solo 4xx-con-field-errors (CD-3). Determina si la
        //    telemetría del primer intento lleva metadata.retry_attempted.
        const missingFields = isMasterPath
          ? parseFieldErrors(firstError)
          : null;
        const willRetry = !!missingFields && missingFields.length > 0;

        // Telemetría del primer intento fallido (sin cambios respecto a hoy,
        // + DT-8 flag retry_attempted cuando vamos a reintentar).
        eventService
          .track({
            eventType: 'compose_step',
            agentId: agent?.slug,
            agentName: agent?.name,
            registry: agent?.registry,
            status: 'failed',
            latencyMs: Date.now() - startTime,
            costUsdc: 0,
            metadata: {
              caller_ref_hash: callerRefHash,
              ...(willRetry && { retry_attempted: true }),
            },
          })
          .catch((trackErr) =>
            log.error({ err: trackErr }, '[Compose] event tracking failed'),
          );

        // ── PASO 1 (DT-5.1 / CD-1): refund del PRIMER débito — IDÉNTICO a hoy
        //    (WKH-128/129). Incondicional para path master. Tras esto NO hay
        //    débito activo para este step → el re-debit nunca coexiste con él.
        const refund1ok = await refundStepDebit();

        // ── PASO 2..6 (DT-5): retry adaptativo. Solo si hay field-errors Y el
        //    refund#1 fue exitoso (CD-1 reforzado: si el refund falló, NO
        //    re-debitamos → nunca 2 débitos activos; queda 1, peor caso
        //    pre-WKH-130).
        if (
          refund1ok &&
          willRetry &&
          missingFields &&
          scopingKeyRow &&
          chainId !== undefined
        ) {
          // ── PASO 3 (DT-5.3 / CD-7): regenerar input via LLM (Haiku).
          //    null = no retry (sin API key / circuit open / no-JSON).
          const newInput = await regenerateInputFromErrors(
            input,
            missingFields,
            agent.slug,
            agent.description,
          );
          if (newInput) {
            // ── PASO 4 (DT-5.4 / CD-1 / CD-8): RE-DEBIT. MISMO monto
            //    stepDebitedUsd (NO recalcular priceUsdc), MISMA destination.
            //    El primer débito YA fue reembolsado → un solo débito activo.
            const retryDebit = await budgetService.debit(
              scopingKeyRow.id,
              chainId,
              stepDebitedUsd,
              request.delegationContext, // undefined en path master
              request.keySessionContext, // undefined en path master
              stepDestination, // M3 (audit): MISMO destino canónico que el débito original y su refund (CD-8)
              scopingKeyRow.owner_ref, // F-04 (audit): owner_ref del caller autenticado
            );
            if (retryDebit.success) {
              try {
                // ── PASO 5 (DT-5.5): RE-INVOKE reusando invokeAgent.
                const { output, txHash, downstream } = await this.invokeAgent(
                  agent,
                  newInput,
                  a2aKey,
                );
                // ── PASO 6a: 2xx → éxito. El retry-debit SE QUEDA (caller
                //    pagó 1 vez). CD-9: cola de éxito COMPARTIDA con happy-path.
                const agg = await this.finishSuccessfulStep({
                  agent,
                  output,
                  txHash,
                  downstream,
                  startTime,
                  steps,
                  i,
                  results,
                  totalCost,
                  totalLatency,
                  scopingKeyRow,
                  callerRefHash,
                  retried: true, // DT-8: metadata.retried
                  discoverCache,
                });
                totalCost = agg.totalCost;
                totalLatency = agg.totalLatency;
                lastOutput = agg.lastOutput;
                // CONTINÚA el pipeline (el loop sigue con i+1). NO return.
                continue;
              } catch (retryErr) {
                const retryError =
                  retryErr instanceof Error
                    ? retryErr.message
                    : String(retryErr);
                // ── PASO 6b (CD-5): retry falló → reembolsar el RETRY débito
                //    (best-effort). NO re-reintentar (CD-2).
                await refundStepDebit();
                eventService
                  .track({
                    eventType: 'compose_step',
                    agentId: agent?.slug,
                    agentName: agent?.name,
                    registry: agent?.registry,
                    status: 'failed',
                    latencyMs: Date.now() - startTime,
                    costUsdc: 0,
                    metadata: {
                      caller_ref_hash: callerRefHash,
                      retry_failed: true, // DT-8
                    },
                  })
                  .catch((trackErr) =>
                    log.error(
                      { err: trackErr },
                      '[Compose] event tracking failed',
                    ),
                  );
                log.error(
                  {
                    step: i,
                    agent: agent.slug,
                    status: 'failed',
                    firstError,
                    retryError,
                  },
                  '[compose.retry]',
                );
                return {
                  success: false,
                  output: null,
                  steps: results,
                  totalCostUsdc: totalCost,
                  totalLatencyMs: totalLatency,
                  error: `Step ${i} failed after retry: ${firstError} | retry: ${retryError}`,
                };
              }
            }
            // retryDebit.success === false → nada se invocó, no hay débito que
            // reembolsar (el debit falló) → caer al return de error normal.
          }
        }

        // ── PASO 0 (default): comportamiento actual (refund ya hecho en PASO 1)
        //    → return error.
        log.error(
          {
            step: i,
            agent: agent.slug,
            status: 'no-retry',
            firstError,
          },
          '[compose.retry]',
        );
        return {
          success: false,
          output: null,
          steps: results,
          totalCostUsdc: totalCost,
          totalLatencyMs: totalLatency,
          error: `Step ${i} failed: ${firstError}`,
        };
      }
    }
    return {
      success: true,
      output: lastOutput,
      steps: results,
      totalCostUsdc: totalCost,
      totalLatencyMs: totalLatency,
      // WKH-114 (AC-5): completitud a nivel pipeline, ADITIVA y distinta de success.
      verificationStatus: summarizePipelineVerification(results),
    };
  },
  /**
   * WKH-130 (CD-9): cola de éxito de un step COMPARTIDA entre el happy-path y
   * el retry-ok. Construye el StepResult, lo pushea, actualiza los agregados
   * (totalCost/totalLatency/lastOutput), resuelve el bridge hacia el siguiente
   * step (A2A passthrough / maybeTransform) y emite el evento `compose_step`
   * success. `retried` agrega `metadata.retried:true` (DT-8) en el path retry.
   *
   * Devuelve los agregados actualizados para que el caller los reasigne
   * (results se muta por referencia con el push).
   */
  async finishSuccessfulStep(ctx: {
    agent: Agent;
    output: unknown;
    txHash?: string | undefined;
    downstream?: DownstreamResult | undefined;
    startTime: number;
    steps: ComposeStep[];
    i: number;
    results: StepResult[];
    totalCost: number;
    totalLatency: number;
    scopingKeyRow?: ComposeRequest['scopingKeyRow'];
    callerRefHash: string | null;
    retried?: boolean | undefined;
    discoverCache?: DiscoverCache | undefined; // B7: cache compartido del pipeline
  }): Promise<{
    totalCost: number;
    totalLatency: number;
    lastOutput: unknown;
  }> {
    const {
      agent,
      output,
      txHash,
      downstream,
      startTime,
      steps,
      i,
      results,
      scopingKeyRow,
      callerRefHash,
      retried,
      discoverCache,
    } = ctx;
    let { totalCost, totalLatency } = ctx;
    let lastOutput: unknown = output;

    const latencyMs = Date.now() - startTime;
    const result: StepResult = {
      agent,
      output,
      costUsdc: agent.priceUsdc,
      latencyMs,
      txHash,
      ...(downstream && {
        downstreamTxHash: downstream.txHash,
        downstreamBlockNumber: downstream.blockNumber,
        downstreamSettledAmount: downstream.settledAmount,
      }),
    };
    // WKH-114 (AC-2/AC-3/AC-4): veredicto de completitud por step. Puro,
    // sync, never-throw (CD-8); NO re-invoca (CD-5) ni toca billing (CD-1/CD-4).
    result.acceptance = verifyStepOutput(output, steps[i]?.acceptanceCriteria);
    results.push(result);
    totalCost += agent.priceUsdc;
    totalLatency += latencyMs;
    if (i < steps.length - 1) {
      // safe: el guard `i < steps.length - 1` garantiza i+1 < steps.length,
      // por lo que steps[i + 1] nunca es undefined.
      // biome-ignore lint/style/noNonNullAssertion: el guard `i < steps.length - 1` garantiza que steps[i + 1] siempre existe.
      const nextStep = steps[i + 1]!;
      const nextAgent = await this.resolveAgent(nextStep, discoverCache);
      // (discoverCache reused from compose() — B7)
      const inputSchema = nextAgent?.metadata?.inputSchema as
        | Record<string, unknown>
        | undefined;
      // ── WKH-56: A2A fast-path bridge resolution ──
      // DT-4: target a2aCompliant requires strict literal `true`
      // (truthy values like 'yes' / 1 do NOT activate the fast-path).
      const targetA2A = nextAgent?.metadata?.a2aCompliant === true;
      const outputIsA2A = isA2AMessage(lastOutput);
      const bridgeStart = Date.now();
      try {
        if (outputIsA2A && targetA2A) {
          // AC-1: A2A → A2A passthrough. NO maybeTransform call.
          result.bridgeType = 'A2A_PASSTHROUGH';
          result.transformLatencyMs = Date.now() - bridgeStart;
          // lastOutput UNCHANGED (CD-15: anti-mutation)
        } else {
          // AC-3 unwrap: A2A output but target is non-A2A → use parts[0].
          // AC-2 fallback: non-A2A output → maybeTransform actual flow.
          const payloadForTransform =
            outputIsA2A && !targetA2A
              ? (extractA2APayload(lastOutput as A2AMessage)[0] ?? lastOutput)
              : lastOutput;
          if (inputSchema && nextAgent) {
            // WKH-60: propagate caller's owner_ref so the L2 cache is
            // scoped per-tenant (cross-tenant cache poisoning blocked).
            // When the caller is anonymous (x402, no scopingKeyRow),
            // ownerRef stays undefined and maybeTransform runs in
            // never-cache mode for L2 (L1 still works in-process).
            const ownerRef = scopingKeyRow?.owner_ref;
            const tr = await maybeTransform(
              agent.id,
              nextAgent.id,
              payloadForTransform,
              inputSchema,
              ownerRef,
            );
            result.cacheHit = tr.cacheHit; // legacy, DT-3
            result.bridgeType = tr.bridgeType; // nuevo, DT-3
            result.transformLatencyMs = tr.latencyMs;
            // WKH-57: telemetría LLM presente solo si bridgeType==='LLM'.
            // CD-17: omitir el campo en non-LLM (no setear como null).
            if (tr.llm) {
              result.transformLLM = tr.llm;
            }
            lastOutput = tr.transformedOutput;
          } else if (outputIsA2A && !targetA2A) {
            // Schema-less + A2A output unwrapped: surface unwrapped payload
            // to next step but mark bridge as SKIPPED (no transform ran).
            lastOutput = payloadForTransform;
            result.bridgeType = 'SKIPPED';
            result.transformLatencyMs = Date.now() - bridgeStart;
          }
        }
      } catch (transformErr) {
        log.error(
          { step: i, err: transformErr },
          '[Compose] Transform failed at step',
        );
      }
    }
    // ── WKH-56 (W3): emit compose_step event AFTER bridge resolved.
    // ── WKH-57 (W4): metadata extendida con 6 campos de telemetría
    //    (bridge + LLM). Constructor explícito (AB-WKH-55-5), todos los
    //    campos opcionales con `?? null` (AB-WKH-56-4 / CD-15).
    const llm: LLMBridgeStats | undefined = result.transformLLM;
    eventService
      .track({
        eventType: 'compose_step',
        agentId: agent.slug,
        agentName: agent.name,
        registry: agent.registry,
        status: 'success',
        latencyMs,
        costUsdc: agent.priceUsdc,
        txHash,
        metadata: {
          bridge_type: result.bridgeType ?? null,
          bridge_latency_ms: result.transformLatencyMs ?? null,
          bridge_cost_usd: llm?.costUsd ?? null,
          llm_model: llm?.model ?? null,
          llm_tokens_in: llm?.tokensIn ?? null,
          llm_tokens_out: llm?.tokensOut ?? null,
          caller_ref_hash: callerRefHash,
          ...(retried && { retried: true }), // DT-8
        },
      })
      .catch((err) => log.error({ err }, '[Compose] event tracking failed'));

    return { totalCost, totalLatency, lastOutput };
  },
  async resolveAgent(
    step: ComposeStep,
    discoverCache?: DiscoverCache,
  ): Promise<Agent | null> {
    // B7 (audit 2026-06-24): cache de discover({limit:50}) POR compose. Esta
    // llamada es idéntica en todos los steps (mismos args); sin cache, un
    // pipeline de N steps dispara hasta 4N discoveries completos. Memoizamos la
    // MISMA Promise → misma data, misma semántica de `.find` por slug. Sin
    // cache (caller no la pasa) cae al discover directo (backward-compat).
    const discoverAll = (): Promise<Agent[]> =>
      discoverCache
        ? discoverCache.all()
        : discoveryService.discover({ limit: 50 }).then((r) => r.agents);

    // Try with registry hint first, then without (LLM may pass wrong case)
    let agent = await discoveryService.getAgent(step.agent, step.registry);
    if (!agent) agent = await discoveryService.getAgent(step.agent);

    // WKH-113 (BASE-08): the real per-chain payment lives in the
    // capabilities/discover path (getAgent v2 hardcodes chain=avalanche, H14;
    // capabilities emits a.chain per-row, H15). Hydrate payment from discover
    // so the real ChainKey survives to signAndSettleDownstream (CD-5/CD-10).
    if (!agent) {
      // Fallback: fetch all agents and match by slug directly. Resolved via
      // discover → already carries the real chain. No re-query (anti latency).
      const agents = await discoverAll();
      return agents.find((a) => a.slug === step.agent) ?? null;
    }

    // Resolved via getAgent → hydrate payment.chain from the path with the
    // real chain (only when it differs — no-op for Avalanche/Kite, CD-8).
    // CD-10 fail-soft: if discover does not bring the agent, real?.payment is
    // falsy → keep getAgent's payment (no Base assumption, no cross-chain).
    const real = (await discoverAll()).find((a) => a.slug === agent.slug);
    if (real?.payment?.chain && real.payment.chain !== agent.payment?.chain) {
      agent.payment = real.payment; // adopt the full payment of the real-chain path
    }
    return agent;
  },
  async invokeAgent(
    agent: Agent,
    input: Record<string, unknown>,
    a2aKey?: string,
    logger?: DownstreamLogger,
  ): Promise<{
    output: unknown;
    txHash?: string | undefined;
    downstream?: DownstreamResult;
  }> {
    const registries = await registryService.getEnabled();
    const registry = registries.find(
      (r: RegistryConfig) => r.name === agent.registry,
    );
    const authHeaders = buildAuthHeaders(registry);
    let paymentRequest: X402PaymentRequest | undefined;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...authHeaders,
    };
    // C1 (audit 2026-07-01): NEVER forward the caller's raw, long-lived
    // `x-a2a-key` bearer to an `invokeUrl` of a THIRD-PARTY (auto-registered)
    // registry. `agent.invokeUrl` derives from `registry.invokeEndpoint`, a
    // value any authenticated caller can set via `POST /registries` (no vetting),
    // and the SSRF guard only blocks private IPs — an attacker's PUBLIC domain
    // passes. Forwarding the bearer there let the attacker harvest and replay
    // the victim's key (full budget drain / account takeover).
    //
    // Only registries with an explicit system-trust tier (`ownerRef ===
    // SYSTEM_OWNER_REF`) — whose invokeUrl is platform-controlled, not
    // caller-supplied — receive the bearer. This preserves the legitimate
    // path (the canonical `wasiai` / Pieverse system registry is owner_ref
    // 'system') while closing the forward to every auto-registered registry.
    const registryIsSystemTrusted = registry?.ownerRef === SYSTEM_OWNER_REF;
    if (a2aKey && registryIsSystemTrusted) {
      headers['x-a2a-key'] = a2aKey;
    }
    // WKH-58: only sign inbound x402 when caller paid via x402 (no a2aKey).
    // a2a-key path: middleware already debited per-call budget, no inbound
    // settle needed. Pieverse /v2/settle (HTTP 500 since 2026-04-13) is the
    // legacy path for x402 callers only. Downstream Fuji USDC settle (WKH-55)
    // still runs for both paths via signAndSettleDownstream below.
    if (agent.priceUsdc > 0 && !a2aKey) {
      // WAS-V2-3-CLIENT-2: schema drift fallback for payTo (mirrors price_per_call fallback in discovery)
      // canonical: agent.metadata.payTo  ←  preferred (kite registry)
      // fallback:  agent.metadata.payment.contract  ←  wasiai-v2 marketplace exposes payTo here
      const meta = agent.metadata as Record<string, unknown> | undefined;
      const canonicalPayTo =
        typeof meta?.payTo === 'string' ? meta.payTo : undefined;
      const fallbackPayment = meta?.payment as
        | Record<string, unknown>
        | undefined;
      const fallbackPayTo =
        typeof fallbackPayment?.contract === 'string'
          ? fallbackPayment.contract
          : undefined;
      const payTo = canonicalPayTo ?? fallbackPayTo;
      if (!payTo)
        throw new Error(
          `No payTo address for agent ${agent.slug} — neither metadata.payTo nor metadata.payment.contract present`,
        );
      // MONEY-PATH: scale priceUsdc (USDC, 6 decimals) up to an 18-decimal wei
      // value. Round-to-nearest onto the 6-decimal USDC grid, then scale by 1e12.
      // Matches fee-charge.ts:feeUsdcToWei (same Math.round convention).
      const valueWei = String(
        BigInt(Math.round(agent.priceUsdc * 1e6)) * BigInt(1e12),
      );
      const result = await getPaymentAdapter().sign({
        to: payTo as `0x${string}`,
        value: valueWei,
      });
      // C2 (audit 2026-07-01): DO NOT forward the freshly-signed EIP-3009
      // authorization to the downstream agent. An EIP-3009
      // `transferWithAuthorization` is redeemable permissionlessly by anyone who
      // holds it: emitting `PAYMENT-SIGNATURE` to `agent.invokeUrl` (a URL the
      // agent's registrant controls) let the agent redeem it directly against
      // the token contract and pull `priceUsdc` from the a2a OPERATOR wallet
      // BEFORE a2a's own settle() ran — then a2a's redundant settle on the same
      // (now-consumed) nonce reverted, throwing `x402 settle failed`, and the
      // per-step catch refunded the caller (operator-wallet drain, repeatable).
      // a2a still settles the authorization itself below (paying the agent's
      // payTo on-chain) — the agent simply never receives a redeemable copy, so
      // there is nothing to front-run. The legacy Pieverse inbound x402 path
      // (broken HTTP 500 since 2026-04-13) is the only thing that consumed this
      // header, so removing it breaks no working flow.
      paymentRequest = result.paymentRequest;
    }
    // WKH-SEC-04 (AC-3 / CD-2 / DT-2): runtime SSRF revalidation on
    // invokeUrl before the outbound fetch — mirrors discovery.ts:529. The
    // headers built above carry x-a2a-key / PAYMENT-SIGNATURE; we MUST NOT
    // emit them to a host that resolves to a private/loopback/link-local IP
    // (TOCTOU / DNS-rebinding). On SSRFViolationError, log and rethrow so the
    // pipeline aborts this step (caught in execute()'s per-step catch) without
    // leaking the invokeUrl to the client.
    try {
      await validateRegistryUrl(agent.invokeUrl);
    } catch (err) {
      if (err instanceof SSRFViolationError) {
        const warn = logger?.warn?.bind(logger) ?? log.warn.bind(log);
        warn(
          { agent: agent.slug, category: err.category },
          '[Compose] SSRF guard blocked invokeUrl before fetch',
        );
        throw new Error(
          `Agent ${agent.slug} invokeUrl blocked by SSRF guard (${err.category})`,
        );
      }
      throw err;
    }

    // M2 (audit 2026-06-24): connect-time SSRF guard on invokeUrl. The
    // validateRegistryUrl check above runs at resolution-time, but plain fetch
    // re-resolves DNS; `ssrfFetch` revalidates the SAME resolution the socket
    // connects to so x-a2a-key / PAYMENT-SIGNATURE headers can never be emitted
    // to a private/metadata IP (closes TOCTOU / DNS-rebinding).
    const response = await ssrfFetch(agent.invokeUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      // Surface the upstream agent's error body (truncated) for observability —
      // un 502/4xx del agente sin el body es opaco para debug. Robusto si el
      // body no se puede leer (ej. response sin .text()).
      let detail = '';
      try {
        detail = (await response.text())
          .slice(0, 300)
          .replace(/\s+/g, ' ')
          .trim();
      } catch {
        /* body ilegible — degradar al status solo */
      }
      throw new Error(
        `Agent ${agent.slug} returned ${response.status}${detail ? `: ${detail}` : ''}`,
      );
    }
    const data = (await response.json()) as Record<string, unknown>;
    const output = data.result ?? data;
    let txHash: string | undefined;
    if (paymentRequest) {
      // WKH-106 (BASE-03): emit selector decision telemetry when settle
      // is on Base chain. The Base adapter itself already honors
      // CDP_FACILITATOR_URL via its own env-var fallback chain (see
      // src/adapters/base/payment.ts:163-170), but logging the selector
      // result here gives observability for AC-2 / AC-5 / AC-7 and lets
      // compose-layer integration tests assert the decision was taken.
      //
      // Selector is invoked ONLY when the agent's manifest declares a
      // Base chain (CD-5 — Kite/Avalanche untouched). Pure function call:
      // no env mutation, no I/O.
      const manifestChain = agent.payment?.chain;
      const chainKey = manifestChain
        ? normalizeChainSlug(manifestChain)
        : undefined;
      if (chainKey?.startsWith('base-')) {
        const meta = agent.metadata as Record<string, unknown> | undefined;
        const manifestFacilitatorUrl =
          typeof meta?.facilitatorUrl === 'string'
            ? meta.facilitatorUrl
            : undefined;
        const selectedUrl = selectFacilitatorUrl({
          chainKey,
          cdpFacilitatorUrl: process.env.CDP_FACILITATOR_URL,
          agentManifestFacilitatorUrl: manifestFacilitatorUrl,
        });
        // Structured log — easy to grep in production + drives smoke tests.
        // Does NOT include the CDP key itself — only the URL host pattern.
        log.info(
          `[Compose] Base settle facilitator selector — chainKey=${chainKey} selected=${selectedUrl ?? '<adapter-default>'} cdpEnvSet=${typeof process.env.CDP_FACILITATOR_URL === 'string' && process.env.CDP_FACILITATOR_URL.length > 0}`,
        );
      }

      const settleResult = await getPaymentAdapter().settle({
        authorization: paymentRequest.authorization,
        signature: paymentRequest.signature,
        network: paymentRequest.network ?? '',
      });
      if (!settleResult.success)
        throw new Error(
          `x402 settle failed for ${agent.slug}: ${settleResult.error ?? 'unknown'}`,
        );
      // TB-01 (audit 2026-06-30): re-verify the settle on-chain BEFORE trusting
      // it. The facilitator just returned `{ success, txHash }`; we independently
      // re-read that tx and confirm it really moved `>= value` of the token to
      // the agent's payTo. A forged/replayed/insufficient settle is rejected here
      // → the step throws → the pipeline aborts (caller is refunded upstream).
      // Gated behind SETTLE_VERIFY_ONCHAIN (default ON); no-op when OFF.
      const settleAuth = paymentRequest.authorization as {
        to?: unknown;
        value?: unknown;
      };
      const settlePayTo =
        typeof settleAuth.to === 'string' ? settleAuth.to : undefined;
      let settleValueAtomic: bigint | undefined;
      try {
        settleValueAtomic =
          typeof settleAuth.value === 'string'
            ? BigInt(settleAuth.value)
            : undefined;
      } catch {
        settleValueAtomic = undefined;
      }
      if (settlePayTo && settleValueAtomic !== undefined) {
        const reVerified = await verifyDefaultChainSettle({
          txHash: settleResult.txHash,
          payTo: settlePayTo,
          requiredAmountAtomic: settleValueAtomic,
        });
        // MNR-1: RPC_UNAVAILABLE (a2a couldn't independently check) → ALLOW the
        // settle (facilitator already confirmed it) but log a clear warning.
        if (reVerified.warn) {
          log.warn(
            `[Compose] settle on-chain re-verify unavailable for ${agent.slug} (${reVerified.reason ?? 'unknown'}), trusting facilitator confirmation`,
          );
        }
        // A DEFINITIVE contradiction (forged/insufficient/wrong tx) → reject.
        if (!reVerified.ok) {
          throw new Error(
            `x402 settle on-chain re-verification failed for ${agent.slug}: ${reVerified.reason ?? 'unknown'}`,
          );
        }
      }
      txHash = settleResult.txHash;
      log.info(`[Compose] x402 settled for ${agent.slug} — txHash: ${txHash}`);
    }

    // ─── WKH-55: Downstream x402 hook (AC-1..AC-10) ──────────────────
    // Defensive logger fallback: si el caller no pasó uno, usamos el logger
    // estructurado (pino) en vez de console.
    const effectiveLogger: DownstreamLogger = logger ?? {
      warn: (obj: unknown, msg?: string) =>
        log.warn({ obj }, msg ?? '[Downstream]'),
      info: (obj: unknown, msg?: string) =>
        log.info({ obj }, msg ?? '[Downstream]'),
    };
    const downstream = await signAndSettleDownstream(agent, effectiveLogger);

    return { output, txHash, ...(downstream && { downstream }) };
  },
};
