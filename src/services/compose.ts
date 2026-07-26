/**
 * Compose Service -- Execute multi-agent pipelines
 */

import { randomUUID } from 'node:crypto';
import {
  getChainVmFamily,
  normalizeChainSlug,
} from '../adapters/chain-resolver.js';
import { getPaymentAdapter } from '../adapters/registry.js';
import { verifyDefaultChainSettle } from '../adapters/settle-verifier.js';
import { hashCallerRef } from '../lib/caller-hash.js';
import { selectFacilitatorUrl } from '../lib/cdp-selector.js';
// Fix-pack P1 AR BLQ-BAJO-1: el page size del pool de agentes que usa
// `resolveAgent` sale del MISMO módulo leaf que el over-fetch de discovery, para
// que no puedan desalinearse. Leaf (no `services/discovery.js`) porque las suites
// que mockean el service completo dejarían el export en `undefined`.
import { resolveComposeAgentPoolLimit } from '../lib/discovery-fetch-limit.js';
import {
  type DownstreamLogger,
  type DownstreamResult,
  signAndSettleDownstream,
} from '../lib/downstream-payment.js';
// Fix-pack P1 (hallazgo 4): los helpers de skip-code se importan del módulo LEAF,
// NO de downstream-payment.js. Media docena de suites mockean ese módulo completo
// con factories sin `importOriginal`, así que importarlos de ahí los deja
// `undefined` bajo test (rompió 84 tests; ver doc/sdd/189-.../auto-blindaje.md).
import {
  createSkipCapturingLogger,
  type DownstreamSkipCode,
  toPublicSkipCode,
} from '../lib/downstream-skip-code.js';
import { parseFieldErrors } from '../lib/field-error-parser.js';
import { getStepGasOverheadUsd } from '../lib/gas-overhead.js';
import { getLogger } from '../lib/logger.js';
import { PLACEHOLDER_FEE_USD } from '../lib/pricing-constants.js';
import { ssrfFetch } from '../lib/ssrf-dispatcher.js';
import {
  SSRFViolationError,
  validateRegistryUrl,
} from '../lib/url-validator.js';
import { isValidWallet } from '../lib/wallet-format.js';
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
import { usdToAtomic } from './payment-intent.js';
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
 * `all()` memoiza la MISMA Promise del discovery del pool — el resultado se
 * comparte entre todos los steps (datos idénticos), sin re-disparar el discovery
 * completo en cada step.
 */
interface DiscoverCache {
  all(): Promise<Agent[]>;
}

/**
 * Pool de agentes para resolver un step por slug e hidratar su `payment.chain`
 * real (WKH-113/BASE-08). ÚNICO productor del pool: `createDiscoverCache` y el
 * fallback de `resolveAgent` tienen que pedir EXACTAMENTE lo mismo (si divergen,
 * el hit de cache y el fallback resolverían sobre pools distintos).
 *
 * ⚠️ AR BLQ-BAJO-1: era `discover({ limit: 50 })`, o sea el TOP-50 RANKEADO. Un
 * pool para buscar por slug NO puede ser un ranking: cuando el over-fetch del
 * hallazgo 1 hizo que el ranking se calcule sobre 4× candidatos, la membresía del
 * top-50 cambió y un agente non-EVM que quedaba afuera perdía la hidratación de
 * `payment.chain` → el leg downstream se salteaba o apuntaba al rail equivocado,
 * en silencio. Ver la justificación completa en `lib/discovery-fetch-limit.ts`.
 */
function discoverAgentPool(): Promise<Agent[]> {
  return discoveryService
    .discover({ limit: resolveComposeAgentPoolLimit() })
    .then((r) => r.agents);
}

function createDiscoverCache(): DiscoverCache {
  let cached: Promise<Agent[]> | undefined;
  return {
    all() {
      if (!cached) {
        cached = discoverAgentPool();
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
    // WKH-234: id único por EJECUCIÓN de compose. Ancla el `intentId` del leg
    // Solana (AC-7): estable entre master + retry del MISMO step (no re-emite un
    // settle ya confirmado), distinto entre ejecuciones (no dedup cross-run). El
    // almacén real de idempotencia se cierra en W5 (ledger settle_signature).
    const composeRunId = randomUUID();
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
      // WKH-234 fix-pack AR-BLQ-1: cuando el settle downstream de ESTE step fue
      // en una familia no-EVM (`downstream.nonEvmSettle` presente) y hubo un
      // débito de budget del caller autenticado, registrar el CAIP-2 + firma
      // base58 en el ledger (AC-8), REUSANDO el `owner_ref` del caller
      // (CD-1/AC-9 — sin queries nuevas sobre a2a_agent_keys). Legs EVM
      // (`nonEvmSettle` undefined) → NO se invoca → columna NULL → byte-idéntico
      // (AC-4). Compartido entre el happy-path y el retry-ok. Best-effort (el
      // emit interno es fire-and-forget).
      //
      // Fix-pack CR-MNR-1: el CAIP-2 y el monto vienen del MISMO objeto, así que
      // la condición del `if` y el monto del recibo no pueden desalinearse. Antes
      // eran dos opcionales sueltos: se decidía por `ds.settleCaip2` y el monto
      // salía de `ds.settledAmountUsd ?? stepDebitedUsd` ⇒ un rail que poblara
      // sólo el primero escribía `amount_usd = 0` junto a una firma on-chain
      // real, en silencio. El `??` desapareció: ya no hay fallback posible.
      const recordSolanaLegIfAny = (ds: DownstreamResult | undefined): void => {
        const nonEvm = ds?.nonEvmSettle;
        if (nonEvm && scopingKeyRow && chainId !== undefined) {
          budgetService.recordSolanaSettleReceipt({
            keyId: scopingKeyRow.id,
            ownerRef: scopingKeyRow.owner_ref,
            chainId,
            // Fix-pack AR-profundo FIX 3: el monto del recibo es el REALMENTE
            // settleado on-chain al agente (derivado del atómico transferido +
            // decimals del adapter), NO `stepDebitedUsd`. Este recibo lleva la
            // `settle_signature` base58 de una transferencia real: la
            // reconciliación cruza ambos. `stepDebitedUsd` es el DÉBITO DEL CALLER
            // y vale 0 para `i === 0` (lo debita el middleware vía
            // composeEstimatedCostUsd, guard `i > 0` de :208) ⇒ un compose de UN
            // step con agente Solana emitía `amount_usd = 0` junto a una firma
            // real. Además incluye el gas overhead del gateway, que nunca se le
            // paga al agente.
            amountUsd: nonEvm.amountUsd,
            settleCaip2: nonEvm.caip2,
            settleSignature: ds.txHash,
          });
        }
      };
      try {
        const { output, txHash, downstream, downstreamSkipCode } =
          await this.invokeAgent(
            agent,
            input,
            a2aKey,
            undefined,
            `${composeRunId}:${i}`, // WKH-234 intentId (leg Solana, AC-7)
          );
        // WKH-234 (AC-8): si el settle downstream fue Solana, anota el ledger.
        recordSolanaLegIfAny(downstream);
        // CD-9: la cola de éxito (StepResult + agregados + bridge + evento)
        // está COMPARTIDA con el retry-ok vía finishSuccessfulStep. No copiar.
        const agg = await this.finishSuccessfulStep({
          agent,
          output,
          txHash,
          downstream,
          downstreamSkipCode,
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
                const { output, txHash, downstream, downstreamSkipCode } =
                  await this.invokeAgent(
                    agent,
                    newInput,
                    a2aKey,
                    undefined,
                    `${composeRunId}:${i}`, // WKH-234 intentId — MISMO que el master (AC-7 idempotente)
                  );
                // WKH-234 (AC-8): retry-ok — anota el ledger si fue Solana.
                recordSolanaLegIfAny(downstream);
                // ── PASO 6a: 2xx → éxito. El retry-debit SE QUEDA (caller
                //    pagó 1 vez). CD-9: cola de éxito COMPARTIDA con happy-path.
                const agg = await this.finishSuccessfulStep({
                  agent,
                  output,
                  txHash,
                  downstream,
                  downstreamSkipCode,
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
    /** Fix-pack P1 (hallazgo 4): motivo del skip del leg downstream, si hubo. */
    downstreamSkipCode?: DownstreamSkipCode | undefined;
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
      downstreamSkipCode,
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
      // Fix-pack P1 (hallazgo 4): señal del skip en la RESPUESTA, no sólo en el
      // log. `toPublicSkipCode` genericiza los códigos que revelarían config del
      // gateway / fondos / claves del operador (mapeo exhaustivo en
      // lib/downstream-skip-code.ts — AR MENOR-6: este puntero decía
      // downstream-payment.ts). Mutuamente excluyente con los tres campos de
      // arriba: `downstreamSkipCode` sólo llega cuando el leg NO settleó.
      ...(downstreamSkipCode && {
        downstreamSettle: `skipped:${toPublicSkipCode(downstreamSkipCode)}`,
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
    // B7 (audit 2026-06-24): cache del discovery del pool POR compose. Esta
    // llamada es idéntica en todos los steps (mismos args); sin cache, un
    // pipeline de N steps dispara hasta 4N discoveries completos. Memoizamos la
    // MISMA Promise → misma data, misma semántica de `.find` por slug. Sin
    // cache (caller no la pasa) cae al discover directo (backward-compat), por el
    // MISMO `discoverAgentPool` (AR BLQ-BAJO-1: dos page sizes distintos harían
    // que el fallback resolviera sobre un pool distinto al cacheado).
    const discoverAll = (): Promise<Agent[]> =>
      discoverCache ? discoverCache.all() : discoverAgentPool();

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
    // WKH-234: idempotency key para el leg Solana del downstream (AC-7). EVM lo
    // ignora. Canónico `contextId:stepIndex:payTo`; ausente → el downstream
    // deriva un fallback por leg.
    intentId?: string,
  ): Promise<{
    output: unknown;
    txHash?: string | undefined;
    downstream?: DownstreamResult;
    /**
     * Fix-pack P1 (hallazgo 4): motivo INTERNO del skip del leg downstream.
     * Presente sólo cuando `downstream` es undefined. `finishSuccessfulStep` lo
     * traduce al vocabulario PÚBLICO antes de ponerlo en la respuesta.
     */
    downstreamSkipCode?: DownstreamSkipCode;
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
    // Fix-pack AR-profundo FIX 4: guard de FAMILIA del payTo. El inbound x402 es
    // EVM-only y castea el payTo a `0x${string}` sin validar; un agente que
    // declara una chain no-EVM expone un payTo base58 (los agentes Solana
    // self-published lo hacen) que llegaba a `viem.signTypedData` y reventaba el
    // request con `InvalidAddressError: Address "So111…112" is invalid` — opaco
    // para el caller. El narrowing de `getPaymentAdapter()` (más abajo) cubre la
    // familia del ADAPTER default del gateway, NO la familia del payTo del
    // agente: son dos cosas distintas. Se decide con el resolver puro
    // (`normalizeChainSlug` + `getChainVmFamily`), sin duplicar validadores de
    // formato. Chain declarada ausente o no resoluble → comportamiento previo
    // intacto (los agentes EVM son byte-idénticos).
    //
    // Fix-pack it2 BLQ-BAJO-1: el guard de la CHAIN declarada no alcanzaba — es
    // un PROXY, no el valor. El payTo que se castea sale de OTRA fuente
    // (`agent.metadata.payTo` / `agent.metadata.payment.contract`, resueltos
    // abajo), y `discovery.mapAgent` setea `metadata: raw` (el agent card COMPLETO
    // del registry, y cualquier caller autenticado puede registrar un registry).
    // Repros del AR: (a) `metadata.payTo` base58 SIN `payment` → chain declarada
    // ausente → el guard no disparaba; (b) `payment.chain: 'avalanche-fuji'`
    // (pasa el guard) + `metadata.payTo` base58 → idem. En los dos casos el
    // base58 crudo llegaba a `viem.signTypedData`. Ahora se guardea EL VALOR con
    // el MISMO validador de formato EVM del money-path
    // (`isValidWallet` — la fuente única de `wallet-format.ts`, la misma que usa
    // por debajo el `validatePayTo` interno de `downstream-payment.ts`; sin
    // duplicar el regex).
    //
    // Fix-pack CR-MNR-4: lo COMPARTIDO es el criterio de FORMATO. El rechazo de
    // la zero-address NO se comparte — vive sólo en el leg downstream (donde el
    // gateway mueve fondos propios). El sign inbound de acá valida formato y una
    // zero-address pasa, igual que antes de este fix-pack: asimetría deliberada y
    // trackeada como `TD-INBOUND-ZERO-PAYTO` (`MULTI-CHAIN.md` §10), porque
    // cambiar qué payTos firma este gate es un cambio de comportamiento
    // observable del money-path.
    const declaredChainKey = agent.payment?.chain
      ? normalizeChainSlug(agent.payment.chain)
      : undefined;
    const declaredVmUnsupported =
      declaredChainKey !== undefined &&
      getChainVmFamily(declaredChainKey) !== 'evm';
    // WAS-V2-3-CLIENT-2: schema drift fallback for payTo (mirrors price_per_call
    // fallback in discovery). canonical: agent.metadata.payTo (kite registry);
    // fallback: agent.metadata.payment.contract (wasiai-v2 marketplace).
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
    // Fix-pack CR-MNR-4: el resultado del validador se conserva TIPADO
    // (`isValidWallet` narrowea a `` `0x${string}` ``) en vez de recalcularse con
    // un cast crudo `payTo as \`0x${string}\`` en el sign de abajo. El cast era
    // una aserción sin chequeo al lado de un chequeo que ya se había hecho: si
    // alguien tocaba este guard, el cast seguía compilando igual. Ahora el sign
    // sólo puede recibir lo que ESTE validador aprobó, por tipos.
    const payToEvm: `0x${string}` | undefined =
      payTo !== undefined && isValidWallet(payTo) ? payTo : undefined;
    // payTo ausente → NO es este guard: sigue cayendo en el throw explícito de
    // abajo (comportamiento previo intacto).
    const payToNotEvm = payTo !== undefined && payToEvm === undefined;
    const inboundVmUnsupported = declaredVmUnsupported || payToNotEvm;
    if (agent.priceUsdc > 0 && !a2aKey && inboundVmUnsupported) {
      const warn = logger?.warn?.bind(logger) ?? log.warn.bind(log);
      warn(
        {
          agent: agent.slug,
          chain: declaredChainKey,
          code: 'INBOUND_VM_UNSUPPORTED',
          // Fix-pack CR-MNR-5: el `reason` del formato usa el MISMO nombre que el
          // skip-code del leg downstream para la MISMA condición
          // (`INVALID_PAY_TO_FORMAT` de `DownstreamSkipCode`). Antes se llamaba
          // `PAY_TO_FORMAT` acá e `INVALID_PAY_TO_FORMAT` allá: dos nombres para
          // "el payTo no tiene formato EVM" obligaban a un dashboard a saber que
          // son lo mismo.
          reason: declaredVmUnsupported
            ? 'DECLARED_CHAIN'
            : 'INVALID_PAY_TO_FORMAT',
        },
        '[Compose] inbound x402 sign skipped — payTo is not an EVM address (non-EVM chain declared and/or non-EVM payTo format). The agent fee settles operator-side in the downstream leg.',
      );
    }
    if (agent.priceUsdc > 0 && !a2aKey && !inboundVmUnsupported) {
      // WKH-234: the inbound x402 (caller→gateway) is EVM-only — it signs an
      // EIP-3009 authorization on the gateway's DEFAULT chain, and the caller
      // has NO Solana wallet (§1). `getPaymentAdapter()` narrows to
      // `EvmPaymentAdapter` and fails-loud if the default chain were ever Solana
      // (an unsupported inbound config) — pero eso NO dice nada sobre la familia
      // del payTo del AGENTE, que se filtra en el guard `inboundVmUnsupported`
      // de arriba. The Solana agent fee is settled operator-side in the
      // DOWNSTREAM leg (signAndSettleDownstream), not here.
      // it2 BLQ-BAJO-1: `payTo` se resuelve ARRIBA (el guard necesita el VALOR,
      // no sólo la chain declarada). Acá sólo queda su fail-loud histórico.
      //
      // CR-MNR-4: se chequea `payToEvm` (la variante TIPADA) en vez de `payTo`.
      // Equivalente exacto: en esta rama `inboundVmUnsupported === false`, o sea
      // `payToNotEvm === false`, o sea `payTo` ausente O válido ⇒ `payToEvm`
      // undefined SÓLO cuando `payTo` está ausente, que es justo el caso de este
      // throw. El mensaje no cambia.
      if (!payToEvm)
        throw new Error(
          `No payTo address for agent ${agent.slug} — neither metadata.payTo nor metadata.payment.contract present`,
        );
      // WKH-195 MONEY-PATH: decimals-aware. Una sola resolución del
      // default-chain adapter reusada para derivar decimals + firmar (DT-2
      // WKH-192). El settle de :928 resuelve el MISMO singleton determinístico
      // (registry.ts:185-200) → byte-equivalente, por eso no se toca. Delega en
      // usdToAtomic (byte-idéntico al legado `× 1e12` en Kite 18d por
      // construcción, correcto en Base 6d). Fallback `?? 18` sin throw.
      const adapter = getPaymentAdapter();
      const decimals = adapter.supportedTokens?.[0]?.decimals ?? 18; // CD-4
      const valueWei = usdToAtomic(agent.priceUsdc, decimals); // CD-1
      const result = await adapter.sign({
        // CR-MNR-4: sin cast — `payToEvm` YA es `` `0x${string}` `` porque salió
        // del type-predicate de `isValidWallet`. El valor es el mismo `payTo` que
        // el guard aprobó.
        to: payToEvm,
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
          // WKH-150 AC-1b/1c: message reflects the outcome. TESTNET (fail-OPEN,
          // `ok:true`) preserves the historical text byte-for-byte; MAINNET
          // (fail-CLOSED, `ok:false`, WKH-144) says REJECTING — the settle is
          // thrown below in the `!reVerified.ok` block, so "trusting" would be
          // contradictory. No decision logic changes here.
          log.warn(
            reVerified.ok
              ? `[Compose] settle on-chain re-verify unavailable for ${agent.slug} (${reVerified.reason ?? 'unknown'}), trusting facilitator confirmation`
              : `[Compose] settle on-chain re-verify unavailable for ${agent.slug} (${reVerified.reason ?? 'unknown'}) — REJECTING facilitator confirmation (fail-closed mainnet)`,
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
    // Fix-pack P1 (hallazgo 4): se decora el logger para capturar el motivo del
    // skip, que antes moría en los logs. CERO cambios en la lógica de decisión
    // de dinero de `signAndSettleDownstream`: el decorador sólo observa los
    // `{ code }` que esa función YA emite en sus 25 caminos de `return null`.
    const capturingLogger = createSkipCapturingLogger(effectiveLogger);
    const downstream = await signAndSettleDownstream(
      agent,
      capturingLogger,
      intentId,
    );

    // Sólo se surfacea cuando el leg NO se settleó (`null`). Si settleó, el
    // caller usa downstreamTxHash/BlockNumber/SettledAmount como siempre.
    const skipCode = downstream ? undefined : capturingLogger.lastSkipCode();

    return {
      output,
      txHash,
      ...(downstream && { downstream }),
      ...(skipCode && { downstreamSkipCode: skipCode }),
    };
  },
};
